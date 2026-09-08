"""Short-lived, disk-derived CSV verification indexes; never a request cache.

Two CSV parses per batch, plus two streaming SHA-256 reads at successful exit.
Identity/mtime_ns/ctime_ns/size checks bracket opens and reads, and are checked
before each use. Hashing uses the exact bytes parsed, not a separate initial
read. Digest revalidation catches persistent same-size/mtime (even unchanged
stat) edits. These are bounded observations, NOT an OS filesystem transaction:
an external writer that changes then perfectly restores bytes/metadata between
observations, or writes after the final check, is outside this guarantee.
The caller's existing rollback policy applies on any detected change/read error.
"""
from __future__ import annotations

import csv
import hashlib
import io
import os
import threading
from collections import defaultdict
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path
from types import MappingProxyType


class CsvVerificationChanged(ValueError):
    pass


def _stamp(stat):
    return (stat.st_dev, stat.st_ino, stat.st_mode, stat.st_mtime_ns,
            stat.st_ctime_ns, stat.st_size)


def _path_stamp(path):
    # Include the directory entry as well as the opened target (symlink case).
    return (_stamp(path.lstat()), _stamp(path.stat()))


def _read_stable(path, expected, *, capture):
    if _path_stamp(path) != expected:
        raise CsvVerificationChanged("CSV 校验期间文件身份或元数据已变化")
    digest = hashlib.sha256()
    chunks = [] if capture else None
    with path.open("rb") as stream:
        if _stamp(os.fstat(stream.fileno())) != expected[1]:
            raise CsvVerificationChanged("CSV 校验打开了不同的文件")
        while True:
            chunk = stream.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
            if capture:
                chunks.append(chunk)
        if _stamp(os.fstat(stream.fileno())) != expected[1]:
            raise CsvVerificationChanged("CSV 校验读取期间文件已变化")
    if _path_stamp(path) != expected:
        raise CsvVerificationChanged("CSV 校验读取后文件已变化")
    return (b"".join(chunks) if capture else None), digest.hexdigest()


def _parse_csv(raw, default_headers):
    """Match MonitorStore._read_csv_table's encoding/header/blank-row semantics."""
    if raw.startswith(b"\xef\xbb\xbf"):
        encoding = "utf-8-sig"
    elif raw.startswith((b"\xff\xfe", b"\xfe\xff")):
        encoding = "utf-16"
    else:
        try:
            raw.decode("utf-8")
            encoding = "utf-8"
        except UnicodeDecodeError as utf8_error:
            try:
                raw.decode("gb18030")
                encoding = "gb18030"
            except UnicodeDecodeError:
                raise utf8_error
    with io.StringIO(raw.decode(encoding), newline="") as stream:
        reader = csv.DictReader(stream)
        headers = [str(item).strip() for item in (reader.fieldnames or [])
                   if item is not None and str(item).strip()]
        if not headers:
            headers = list(default_headers)
        for name in default_headers:
            if name not in headers:
                headers.append(name)
        rows = [{name: "" if row.get(name) is None else str(row.get(name)) for name in headers}
                for row in reader
                if row and any(value is not None and str(value) != "" for value in row.values())]
    return headers, rows


class _VerificationContext:
    def __init__(self, paths, headers, note_key, comment_key, comment_id):
        self.paths = tuple(Path(path).absolute() for path in paths)
        self.closed = False
        self.failed = False
        self.stamps = tuple(_path_stamp(path) for path in self.paths)
        self.digests = []
        tables = []
        for path, stamp, defaults in zip(self.paths, self.stamps, headers):
            raw, digest = _read_stable(path, stamp, capture=True)
            self.digests.append(digest)
            tables.append(_parse_csv(raw, defaults)[1])
        self.check_metadata()
        notes, comments, owners = defaultdict(list), defaultdict(list), defaultdict(set)
        for row in tables[0]:
            notes[note_key(row)].append(MappingProxyType(row))
        for row in tables[1]:
            key = comment_key(row)
            comments[key].append(MappingProxyType(row))
            owners[comment_id(row)].add(key)
        # Keep duplicates and blank IDs as rows: the verifier must reject them.
        self.notes = MappingProxyType({key: tuple(rows) for key, rows in notes.items()})
        self.comments = MappingProxyType({key: tuple(rows) for key, rows in comments.items()})
        self.owners = MappingProxyType({key: frozenset(value) for key, value in owners.items()})

    def check_metadata(self):
        if self.closed or self.failed:
            raise CsvVerificationChanged("CSV 批内校验上下文已失效")
        try:
            if tuple(_path_stamp(path) for path in self.paths) != self.stamps:
                raise CsvVerificationChanged("CSV 校验期间文件身份或元数据已变化")
        except Exception:
            self.failed = True
            raise

    def finish(self):
        try:
            self.check_metadata()
            for path, stamp, expected in zip(self.paths, self.stamps, self.digests):
                _, digest = _read_stable(path, stamp, capture=False)
                if digest != expected:
                    raise CsvVerificationChanged("CSV 校验期间文件内容摘要已变化")
            self.check_metadata()
        except Exception:
            self.failed = True
            raise


_active = ContextVar("csv_verification_batch", default=None)


def active_for(owner, paths):
    value = _active.get()
    if value is None or value[0] is not owner:
        return None
    _, thread_id, context = value
    if thread_id != threading.get_ident() or context.paths != tuple(Path(p).absolute() for p in paths):
        context.failed = True
        raise CsvVerificationChanged("CSV 批内校验范围已变化")
    context.check_metadata()
    return context


@contextmanager
def verification_batch(owner, paths, headers, note_key, comment_key, comment_id):
    # Acquired again deliberately: the production wrapper holds this RLock
    # across checkpoints, all writes, refreshes, verification and rollback.
    with owner.pull_lock:
        if _active.get() is not None:
            raise CsvVerificationChanged("CSV 批内校验上下文不支持嵌套")
        context = _VerificationContext(paths, headers, note_key, comment_key, comment_id)
        token = _active.set((owner, threading.get_ident(), context))
        try:
            yield context
            context.finish()  # Exception exits into the original rollback wrapper.
        finally:
            context.closed = True
            _active.reset(token)
