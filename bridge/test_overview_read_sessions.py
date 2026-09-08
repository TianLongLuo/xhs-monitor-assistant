"""Immutable browsing pagination; all stores are synthetic temporary fixtures."""
import threading
import time
import unittest
from unittest.mock import patch

import test_ai_publication as fixtures
from overview_read_sessions import OverviewReadSessions


class BrowseSessionTests(unittest.TestCase):
    setUp = fixtures.AIPublicationTests.setUp
    new_store = fixtures.AIPublicationTests.new_store
    add_note = fixtures.AIPublicationTests.add_note
    rows = fixtures.AIPublicationTests.rows

    def payload(self):
        token = self.store.data_overview_schema()['snapshotToken']
        self.addCleanup(self.store._overview_read_sessions.close)
        return dict(dataset='comments', snapshotToken=token, fields=['comment_id', 'content'],
                    sort=[{'field': 'comment_id', 'direction': 'asc'}], page=1, pageSize=1, useReadSession=True)

    def next_page(self, p, result, **extra):
        return self.store.query_data_overview({**p, 'page': 2, 'readSessionId': result['readSessionId'], **extra})

    def test_pages_reuse_copy_without_hash_connect_count_or_field_catalogue(self):
        p = self.payload()
        with patch.object(self.store, '_data_overview_snapshot_token', wraps=self.store._data_overview_snapshot_token) as hashing:
            first = self.store.query_data_overview(p)
            self.assertEqual(hashing.call_count, 1)
            with patch.object(self.store, '_connect', side_effect=AssertionError('live connection on cached page')), \
                 patch('server.build_field_specs', side_effect=AssertionError('catalogue rebuilt')):
                second = self.next_page(p, first)
            self.assertEqual(hashing.call_count, 1)
        self.assertEqual(first['total'], second['total'])
        self.assertEqual(first['readSessionId'], second['readSessionId'])
        self.assertNotEqual(first['rows'][0]['comment_id'], second['rows'][0]['comment_id'])
        self.assertTrue(second['browsingSnapshot'])

    def test_live_change_cannot_mix_pages_and_strict_read_still_rejects(self):
        p = self.payload()
        first = self.store.query_data_overview(p)
        expected = self.next_page(p, first)['rows']
        with self.store._session() as db:
            db.execute("UPDATE comments SET content='changed outside view'")
        self.assertEqual(expected, self.next_page(p, first)['rows'])
        with self.assertRaisesRegex(ValueError, '数据已变化'):
            self.store.query_data_overview({**p, 'useReadSession': False})

    def test_same_size_external_csv_change_does_not_mutate_copy_but_strict_rejects(self):
        p = self.payload(); first = self.store.query_data_overview(p)
        data = self.comments_path.read_bytes()
        self.comments_path.write_bytes(data.replace(b'Fixture', b'Changed', 1))
        self.assertTrue(self.next_page(p, first)['ok'])
        with self.assertRaisesRegex(ValueError, '数据已变化'):
            self.store.query_data_overview({**p, 'useReadSession': False})

    def test_query_token_dataset_page_size_and_sort_binding(self):
        p = self.payload(); first = self.store.query_data_overview(p)
        for change in ({'snapshotToken':'other'}, {'dataset':'notes'}, {'pageSize':2}, {'search':'other'}, {'fields':['content']}, {'sort':[]}):
            with self.subTest(change=change), self.assertRaisesRegex(ValueError, '不匹配'):
                self.next_page(p, first, **change)

    def test_expired_unknown_and_evicted_ids_never_fall_back_to_live(self):
        p = self.payload(); first = self.store.query_data_overview(p)
        cache = self.store._overview_read_sessions
        cache.entries[first['readSessionId']]['used'] -= 601
        with self.assertRaisesRegex(ValueError, '过期'): self.next_page(p, first)
        with self.assertRaisesRegex(ValueError, '过期'): self.next_page(p, {'readSessionId':'unknown'})
        cache.max_entries = 1
        old = self.store.query_data_overview(p)
        self.store.query_data_overview(p)
        with self.assertRaisesRegex(ValueError, '过期'): self.next_page(p, old)

    def test_new_first_page_is_not_silently_reused(self):
        p = self.payload(); a = self.store.query_data_overview(p); b = self.store.query_data_overview(p)
        self.assertNotEqual(a['readSessionId'], b['readSessionId'])

    def test_cached_page_does_not_wait_for_live_writer_locks(self):
        p = self.payload(); first = self.store.query_data_overview(p)
        held, release = threading.Event(), threading.Event()
        def writer():
            with self.store.pull_lock, self.store.lock:
                held.set(); release.wait(5)
        worker = threading.Thread(target=writer); worker.start()
        self.assertTrue(held.wait(2))
        try:
            started = time.perf_counter(); result = self.next_page(p, first)
            self.assertLess(time.perf_counter() - started, 1)
            self.assertTrue(result['ok'])
        finally:
            release.set(); worker.join()

    def test_size_budget_falls_back_strictly_and_cleans_reservations(self):
        p = self.payload(); cache = self.store._overview_read_sessions; cache.max_bytes = 1
        result = self.store.query_data_overview(p)
        self.assertNotIn('readSessionId', result)
        self.assertEqual(cache.entries, {}); self.assertEqual(cache.building, 0); self.assertEqual(cache.reserved_bytes, 0)

    def test_creation_failure_releases_reservation(self):
        p = self.payload(); cache = self.store._overview_read_sessions
        with patch.object(self.store, '_validate_data_overview_read_snapshot', side_effect=ValueError('failure')):
            with self.assertRaisesRegex(ValueError, 'failure'): self.store.query_data_overview(p)
        self.assertEqual(cache.entries, {}); self.assertEqual(cache.building, 0); self.assertEqual(cache.reserved_bytes, 0)

    def test_snapshot_connection_is_read_only(self):
        p = self.payload(); first = self.store.query_data_overview(p)
        with self.store._overview_read_sessions.open(self.store, {**p, 'readSessionId':first['readSessionId']}, p['snapshotToken']) as (db, _):
            with self.assertRaisesRegex(Exception, 'readonly'): db.execute('DELETE FROM comments')

    def test_max_lifetime_is_not_extended_by_page_reads(self):
        p = self.payload(); first = self.store.query_data_overview(p)
        self.store._overview_read_sessions.entries[first['readSessionId']]['created'] -= 1801
        with self.assertRaisesRegex(ValueError, '过期'): self.next_page(p, first)

    def test_export_with_browsing_flags_still_validates_live_database(self):
        p = self.payload(); first = self.store.query_data_overview(p)
        with self.store._session() as db:
            db.execute("UPDATE comments SET content='changed after browse'")
        with self.assertRaisesRegex(ValueError, '数据已变化'):
            self.store.export_data_overview({**p, 'readSessionId':first['readSessionId'], 'expectedTotal':2})

    def test_global_byte_budget_evicts_and_expired_active_read_is_not_deleted(self):
        p = self.payload(); first = self.store.query_data_overview(p)
        cache = self.store._overview_read_sessions
        old = cache.entries[first['readSessionId']]
        old_path = old['path']
        cache.max_bytes = old['bytes'] + 1
        second = self.store.query_data_overview(p)
        self.assertFalse(old_path.exists()); self.assertEqual(len(cache.entries), 1)
        entry = cache.entries[second['readSessionId']]
        with cache.open(self.store, {**p, 'readSessionId':second['readSessionId']}, p['snapshotToken']) as (db, _):
            entry['created'] -= 1801
            with cache.lock: cache._prune()
            self.assertTrue(entry['path'].exists())
            self.assertEqual(2, db.execute('SELECT count(*) FROM comments').fetchone()[0])
        self.assertFalse(entry['path'].exists())
