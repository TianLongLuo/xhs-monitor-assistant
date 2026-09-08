"""Bounded immutable browsing snapshots, separate from all live-write leases.

Only explicit ordinary table reads use this cache. Each session is bound to one
query and one approved token. A pinned source read transaction is fingerprinted
before backup, so concurrent external SQLite writes cannot change its rows.
"""
from contextlib import contextmanager
import hashlib
import json
from pathlib import Path
import secrets
import sqlite3
import tempfile
import threading
import time


class OverviewReadSessions:
    def __init__(self, max_entries=3, max_bytes=256 * 1024 * 1024, idle_seconds=600, lifetime_seconds=1800):
        self.max_entries, self.max_bytes = max_entries, max_bytes
        self.idle_seconds, self.lifetime_seconds = idle_seconds, lifetime_seconds
        self.entries = {}
        self.lock = threading.RLock()
        self.building = 0
        self.reserved_bytes = 0

    @staticmethod
    def key(payload):
        shape = {k: v for k, v in payload.items() if k not in ('page', 'useReadSession', 'readSessionId')}
        return hashlib.sha256(json.dumps(shape, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()

    def _expired(self, entry, now):
        return entry.get('retired', False) or now - entry['used'] >= self.idle_seconds or now - entry['created'] >= self.lifetime_seconds

    def _remove(self, entry):
        try:
            entry['directory'].cleanup()
        except OSError:
            # Antivirus/open-file races must not leak budget or fail unrelated
            # active reads. Keep the bytes registered and retry on later access.
            entry['retired'] = True
            return False
        self.entries.pop(entry['id'], None)
        return True

    def _prune(self):
        now = time.monotonic()
        for entry in list(self.entries.values()):
            if not entry['refs'] and self._expired(entry, now):
                self._remove(entry)

    def close(self):
        with self.lock:
            for entry in list(self.entries.values()):
                if not entry['refs']:
                    self._remove(entry)

    def _create(self, store, payload, token, key):
        directory, reserved, slot_reserved = None, 0, False
        try:
            # No cache mutex while waiting for live locks: existing sessions
            # must remain responsive even during slow first-screen validation.
            with store.pull_lock, store.lock:
                source = store._connect()
                try:
                    source.execute('PRAGMA query_only=ON')
                    source.execute('BEGIN')
                    source.execute('SELECT count(*) FROM sqlite_master').fetchone()
                    size = source.execute('PRAGMA page_count').fetchone()[0] * source.execute('PRAGMA page_size').fetchone()[0]
                    if size > self.max_bytes:
                        return None
                    store._validate_data_overview_read_snapshot(token, '查询', snapshot_db=source)
                    # Validate AND execute the first page before evicting any
                    # valid session. Its exact pinned version is copied below.
                    cache = {}
                    first = store._query_data_overview_db(source, payload, token, cache)
                    cache['first_result'] = first
                    with self.lock:
                        self._prune()
                        while (len(self.entries) + self.building >= self.max_entries
                               or sum(e['bytes'] for e in self.entries.values()) + self.reserved_bytes + size > self.max_bytes):
                            victims = [e for e in self.entries.values() if not e['refs'] and not e.get('retired')]
                            if not victims:
                                return None
                            self._remove(min(victims, key=lambda e: e['used']))
                        self.building += 1
                        self.reserved_bytes += size
                        reserved, slot_reserved = size, True
                    directory = tempfile.TemporaryDirectory(prefix='xhs-overview-read-')
                    path = Path(directory.name) / 'snapshot.sqlite3'
                    target = sqlite3.connect(path)
                    try:
                        source.backup(target)
                        target.execute('PRAGMA journal_mode=DELETE')
                    finally:
                        target.close()
                finally:
                    source.close()
            now = time.monotonic()
            entry = dict(id=secrets.token_urlsafe(24), key=key, token=token, path=path, directory=directory,
                         created=now, used=now, refs=1, bytes=size, mutex=threading.RLock(), cache=cache)
            with self.lock:
                self.entries[entry['id']] = entry
            directory = None
            return entry
        finally:
            try:
                if directory is not None:
                    # Register failed-build leftovers too; failed cleanup stays
                    # accounted against both the disk budget and the slot cap.
                    now = time.monotonic()
                    orphan = dict(id=secrets.token_urlsafe(24), directory=directory, refs=0,
                                  bytes=reserved, created=now, used=now, retired=True)
                    with self.lock:
                        self.entries[orphan['id']] = orphan
                        self._remove(orphan)
            finally:
                if slot_reserved:
                    with self.lock:
                        self.building -= 1
                        self.reserved_bytes -= reserved

    @contextmanager
    def open(self, store, payload, token):
        key, session_id = self.key(payload), payload.get('readSessionId')
        entry, created, failed = None, False, False
        if session_id:
            with self.lock:
                self._prune()
                entry = self.entries.get(str(session_id))
                if entry is None or self._expired(entry, time.monotonic()):
                    raise ValueError('浏览快照已过期，请重新校验后继续浏览')
                if entry['key'] != key or entry['token'] != token:
                    raise ValueError('浏览快照条件不匹配，请重新校验后查询')
                entry['refs'] += 1
                entry['used'] = time.monotonic()
        elif int(payload.get('page') or 1) == 1:
            entry = self._create(store, payload, token, key)
            created = entry is not None
        if entry is None:
            yield None
            return
        try:
            with entry['mutex']:
                # Immutable copy has no live WAL, writers, or business locks.
                db = sqlite3.connect(entry['path'].as_uri() + '?mode=ro&immutable=1', uri=True)
                db.row_factory = sqlite3.Row
                try:
                    db.execute('PRAGMA query_only=ON')
                    yield db, entry
                finally:
                    db.close()
        except BaseException:
            failed = True
            raise
        finally:
            with self.lock:
                entry['refs'] -= 1
                if created and failed and not entry['refs']:
                    self._remove(entry)
                else:
                    self._prune()
