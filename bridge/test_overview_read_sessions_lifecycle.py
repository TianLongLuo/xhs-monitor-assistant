"""Read-session lifecycle regressions; synthetic temporary stores only.

Reuse the network/native-operation guards from the publication fixtures.
This module never opens production data and never modifies implementation files.
"""
from pathlib import Path
import sqlite3
import unittest
from unittest.mock import patch

import overview_read_sessions as sessions
import test_overview_read_sessions as fixtures


class BrowseSessionLifecycleTests(unittest.TestCase):
    setUp = fixtures.BrowseSessionTests.setUp
    new_store = fixtures.BrowseSessionTests.new_store
    add_note = fixtures.BrowseSessionTests.add_note
    rows = fixtures.BrowseSessionTests.rows
    payload = fixtures.BrowseSessionTests.payload
    next_page = fixtures.BrowseSessionTests.next_page

    def test_cleanup_failures_keep_budget_and_retry_without_leaking_reservations(self):
        p = self.payload()
        cache = self.store._overview_read_sessions
        first = self.store.query_data_overview(p)
        entry = cache.entries[first['readSessionId']]
        folder = Path(entry['directory'].name)
        expected_bytes = entry['bytes']
        with self.subTest(stage='existing_session_cleanup'):
            with patch.object(entry['directory'], 'cleanup', side_effect=PermissionError('injected cleanup denial')):
                cache.close()
                self.assertIn(entry['id'], cache.entries)
                self.assertTrue(entry['retired'])
                self.assertTrue(folder.is_dir())
                self.assertEqual(sum(e['bytes'] for e in cache.entries.values()), expected_bytes)
                with self.assertRaisesRegex(ValueError, '过期'):
                    self.next_page(p, first)
                self.assertEqual((cache.building, cache.reserved_bytes), (0, 0))
            with cache.lock:
                cache._prune()
            self.assertFalse(folder.exists())
            self.assertEqual(cache.entries, {})

        with self.subTest(stage='failed_build_cleanup'):
            real_directory = sessions.tempfile.TemporaryDirectory
            real_connect = sqlite3.connect
            cleanup_patches = []
            directories = []

            def make_directory(**kwargs):
                directory = real_directory(**kwargs)
                directories.append(directory)
                # A real leftover file ensures this tests disk ownership too.
                (Path(directory.name) / 'leftover.bin').write_bytes(b'fixture')
                guard = patch.object(directory, 'cleanup', side_effect=PermissionError('injected cleanup denial'))
                guard.start()
                cleanup_patches.append(guard)
                return directory

            def connect(database, *args, **kwargs):
                if Path(str(database)).name == 'snapshot.sqlite3':
                    raise sqlite3.OperationalError('injected destination open failure')
                return real_connect(database, *args, **kwargs)

            try:
                with patch.object(sessions.tempfile, 'TemporaryDirectory', side_effect=make_directory), \
                     patch.object(sessions.sqlite3, 'connect', side_effect=connect):
                    with self.assertRaisesRegex(sqlite3.OperationalError, 'destination open failure'):
                        self.store.query_data_overview(p)
                self.assertEqual((cache.building, cache.reserved_bytes), (0, 0))
                self.assertEqual(len(cache.entries), 1)
                orphan = next(iter(cache.entries.values()))
                self.assertTrue(orphan['retired'])
                self.assertEqual(orphan['refs'], 0)
                self.assertEqual(orphan['bytes'], expected_bytes)
                self.assertTrue(Path(orphan['directory'].name).is_dir())
            finally:
                for guard in reversed(cleanup_patches):
                    guard.stop()
                with cache.lock:
                    cache._prune()
                # Also clean up if an assertion exposed a registration bug.
                for directory in directories:
                    directory.cleanup()
            self.assertEqual(cache.entries, {})

    def test_invalid_token_does_not_evict_valid_session(self):
        p = self.payload()
        cache = self.store._overview_read_sessions
        cache.max_entries = 1
        first = self.store.query_data_overview(p)
        before = set(cache.entries)
        with self.assertRaisesRegex(ValueError, '过期'):
            self.store.query_data_overview({**p, 'snapshotToken': 'invalid-token'})
        self.assertEqual(set(cache.entries), before)
        self.assertEqual((cache.building, cache.reserved_bytes), (0, 0))
        self.assertEqual(self.next_page(p, first)['readSessionId'], first['readSessionId'])

    def test_invalid_filter_does_not_evict_and_wal_backup_keeps_pinned_first_page(self):
        p = self.payload()
        cache = self.store._overview_read_sessions
        cache.max_entries = 1
        first = self.store.query_data_overview(p)
        before = set(cache.entries)
        with self.assertRaisesRegex(ValueError, '未知筛选字段'):
            self.store.query_data_overview({**p, 'filter': {
                'logic': 'and', 'children': [{'field': 'missing', 'operator': 'eq', 'value': 1}],
            }})
        self.assertEqual(set(cache.entries), before)
        self.assertEqual((cache.building, cache.reserved_bytes), (0, 0))
        self.assertTrue(self.next_page(p, first)['ok'])
        cache.close()

        with self.store._session() as db:
            self.assertEqual(db.execute('PRAGMA journal_mode=WAL').fetchone()[0].lower(), 'wal')
        originals = {r['comment_id']: r['content'] for r in self.rows('comments')}
        validate = self.store._validate_data_overview_read_snapshot

        def external_commit(*args, **kwargs):
            token = validate(*args, **kwargs)
            # Independent connection commits between hash and first-page SQL/backup.
            with self.store._session() as db:
                db.execute("UPDATE comments SET content='external-after-validation'")
            return token

        with patch.object(self.store, '_validate_data_overview_read_snapshot', side_effect=external_commit), \
             patch.object(self.store, '_query_data_overview_db', wraps=self.store._query_data_overview_db) as execute:
            pinned = self.store.query_data_overview(p)
            self.assertEqual(execute.call_count, 1, 'first_result must avoid a duplicate first-page SELECT')
        self.assertNotIn('first_result', cache.entries[pinned['readSessionId']]['cache'])
        with patch.object(self.store, '_connect', side_effect=AssertionError('cached page touched live DB')):
            second = self.next_page(p, pinned)
        for page in (pinned, second):
            for row in page['rows']:
                self.assertEqual(row['content'], originals[row['comment_id']])
        self.assertTrue(all(r['content'] == 'external-after-validation' for r in self.rows('comments')))
        with self.assertRaisesRegex(ValueError, '数据已变化'):
            self.store.query_data_overview({**p, 'useReadSession': False})


if __name__ == '__main__':
    unittest.main()
