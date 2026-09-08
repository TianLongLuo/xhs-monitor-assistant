"""Logical snapshot and silent read-lease renewal, isolated temporary stores."""
import os
import time
import unittest
from unittest.mock import patch

import test_ai_publication as fixtures


class SnapshotStabilityTests(unittest.TestCase):
    setUp = fixtures.AIPublicationTests.setUp
    new_store = fixtures.AIPublicationTests.new_store
    add_note = fixtures.AIPublicationTests.add_note
    rows = fixtures.AIPublicationTests.rows

    def approve(self):
        schema = self.store.data_overview_schema()
        self.assertTrue(schema['queryReady'], schema['health'].get('issues'))
        return schema['snapshotToken']

    def query(self, token, **extra):
        return self.store.query_data_overview({'dataset': 'comments', 'snapshotToken': token,
                                              'fields': ['comment_id', 'content'], **extra})

    def values(self, token):
        return self.store.data_overview_values({'dataset': 'comments', 'snapshotToken': token, 'field': 'author'})

    def expire(self, token):
        self.store._data_overview_approved_tokens[token] = time.time() - 1801
        self.store._data_overview_read_renewals[token] = time.time() - 1801

    def test_unrelated_table_write_and_wal_checkpoint_keep_token(self):
        token = self.approve()
        keeper = self.store._connect()
        self.addCleanup(keeper.close)
        with self.store._session() as db:
            db.execute("INSERT INTO external_analysis_batches VALUES('fixture-a','hash','{}','{}','now')")
        self.assertEqual(token, self.store._data_overview_snapshot_token())
        keeper.execute('PRAGMA wal_checkpoint(TRUNCATE)')
        self.assertEqual(token, self.store._data_overview_snapshot_token())
        self.assertEqual(2, self.query(token)['total'])
        self.assertTrue(self.values(token)['ok'])

    def test_mtime_only_changes_do_not_invalidate(self):
        token = self.approve()
        paths = [self.notes_path, self.comments_path, self.store.db_path]
        paths.extend(self.media['ai-note-A'] / name for name in ('note.json', 'comments.json', '帖子正文.txt'))
        for path in paths:
            stat = path.stat()
            os.utime(path, ns=(stat.st_atime_ns, stat.st_mtime_ns + 10_000_000))
        self.assertEqual(token, self.store._data_overview_snapshot_token())
        self.assertEqual(2, self.query(token)['total'])

    def test_same_size_same_mtime_external_changes_are_detected(self):
        paths = [self.notes_path, self.comments_path]
        paths.extend(self.media['ai-note-A'] / n for n in ('note.json', 'comments.json', '帖子正文.txt'))
        for path in paths:
            with self.subTest(path=path.name):
                token = self.approve()
                data, stat = path.read_bytes(), path.stat()
                changed = data.replace(b'Fixture', b'Changed', 1)
                self.assertNotEqual(data, changed)
                self.assertEqual(len(data), len(changed))
                try:
                    path.write_bytes(changed)
                    os.utime(path, ns=(stat.st_atime_ns, stat.st_mtime_ns))
                    with self.assertRaisesRegex(ValueError, '数据已变化'):
                        self.query(token)
                finally:
                    path.write_bytes(data)
                    os.utime(path, ns=(stat.st_atime_ns, stat.st_mtime_ns))

    def test_expired_query_silently_rechecks_without_changing_result_or_token(self):
        token = self.approve()
        before = self.query(token)
        self.expire(token)
        real = self.store.data_health
        def health():
            self.assertTrue(self.store.pull_lock._is_owned())
            self.assertTrue(self.store.lock._is_owned())
            return real()
        with patch.object(self.store, 'data_health', side_effect=health) as check:
            result = self.query(token)
            check.assert_called_once()
        self.assertEqual(before, result)
        self.assertEqual(token, result['snapshotToken'])
        self.assertLess(time.time() - self.store._data_overview_read_renewals[token], 5)

    def test_expired_values_silently_recheck(self):
        token = self.approve()
        before = self.values(token)
        self.expire(token)
        with patch.object(self.store, 'data_health', wraps=self.store.data_health) as check:
            self.assertEqual(before, self.values(token))
            check.assert_called_once()

    def test_fresh_lease_does_not_repeat_full_health_check(self):
        token = self.approve()
        with patch.object(self.store, 'data_health', side_effect=AssertionError('unexpected expensive health')):
            self.query(token)
            self.values(token)

    def test_lost_matching_lease_is_not_blindly_trusted(self):
        token = self.approve()
        self.store._data_overview_approved_tokens.clear()
        with patch.object(self.store, 'data_health', side_effect=AssertionError('unissued token')):
            with self.assertRaisesRegex(ValueError, '快照已过期'):
                self.query(token)

    def test_health_failure_blocks_automatic_renewal(self):
        for result in ({'summary': {'relationshipsConsistent': False}, 'issues': []},
                       {'summary': {'relationshipsConsistent': True}, 'issues': [{'severity': 'critical'}]}):
            token = self.approve()
            self.expire(token)
            with patch.object(self.store, 'data_health', return_value=result):
                with self.assertRaisesRegex(ValueError, '自动复核未通过'):
                    self.query(token)
            self.assertNotIn(token, self.store._data_overview_approved_tokens)

    def test_change_during_renewal_is_not_auto_adopted(self):
        token = self.approve()
        self.expire(token)
        def health():
            with self.store._session() as db:
                db.execute("UPDATE notes SET title='fixture change'")
            return {'summary': {'relationshipsConsistent': True}, 'issues': []}
        with patch.object(self.store, 'data_health', side_effect=health):
            with self.assertRaisesRegex(ValueError, '数据已变化'):
                self.query(token)
        self.assertNotIn(token, self.store._data_overview_approved_tokens)

    def test_actual_field_changes_invalidate_fresh_and_expired_reads(self):
        edits = [('notes', 'title', 'changed'), ('notes', 'last_seen_at', '2099-01-01'),
                 ('comments', 'content', 'changed'), ('comments', 'parent_comment_id', 'different-parent'),
                 ('comments', 'analysis_is_negative', '是'), ('comments', 'is_deleted', 1),
                 ('comments', 'like_count', 9)]
        for table, field, value in edits:
            for expired in (False, True):
                with self.subTest(table=table, field=field, expired=expired):
                    self.new_store()
                    token = self.approve()
                    if expired:
                        self.expire(token)
                    with self.store._session() as db:
                        db.execute(f'UPDATE {table} SET {field}=?', (value,))
                    with self.assertRaisesRegex(ValueError, '数据已变化'):
                        self.query(token)
                    with self.assertRaises(ValueError):
                        self.values(token)

    def test_missing_and_random_tokens_do_not_bypass_gate(self):
        self.approve()
        for token in ('', 'bad-token'):
            with self.assertRaises(ValueError):
                self.query(token)

    def test_expired_delete_keeps_explicit_fresh_token_requirement(self):
        token = self.approve()
        self.expire(token)
        with patch.object(self.store, 'data_health', side_effect=AssertionError('delete must not auto-renew')):
            with self.assertRaisesRegex(ValueError, '快照已过期'):
                self.store.delete_data_overview_records({'dataset': 'comments', 'ids': ['ai-note-A-c1'],
                    'snapshotToken': token, 'hardDeleteConfirmed': True, 'confirmation': 'DELETE:comments:1'})
        self.assertEqual(2, len(self.rows('comments')))

    def test_read_renewal_does_not_extend_delete_or_purge_lease(self):
        token = self.approve()
        self.expire(token)
        original = self.store._data_overview_approved_tokens[token]
        self.query(token)
        self.assertEqual(original, self.store._data_overview_approved_tokens[token])
        with self.assertRaisesRegex(ValueError, '快照已过期'):
            self.store.delete_data_overview_records({'dataset': 'comments', 'ids': ['ai-note-A-c1'],
                'snapshotToken': token, 'hardDeleteConfirmed': True, 'confirmation': 'DELETE:comments:1'})
        with self.assertRaisesRegex(ValueError, '快照已过期'):
            self.store.purge_untracked_discoveries({'snapshotToken': token, 'dryRun': True})

    def test_exact_expiry_boundary(self):
        token = self.approve()
        now = time.time()
        with patch('server.time.time', return_value=now):
            for age, checks in ((1799, 0), (1800, 1), (1801, 1)):
                self.store._data_overview_read_renewals[token] = now - age
                with patch.object(self.store, 'data_health', wraps=self.store.data_health) as health:
                    self.query(token)
                    self.assertEqual(checks, health.call_count)

    def test_schema_and_same_count_row_replacement_are_detected(self):
        token = self.approve()
        with self.store._session() as db:
            db.execute("ALTER TABLE comments ADD COLUMN fixture_extra TEXT DEFAULT ''")
        self.assertNotEqual(token, self.store._data_overview_snapshot_token())
        token = self.store._data_overview_snapshot_token()
        with self.store._session() as db:
            db.execute("UPDATE comments SET fixture_extra='new'")
        self.assertNotEqual(token, self.store._data_overview_snapshot_token())
        token = self.store._data_overview_snapshot_token()
        with self.store._session() as db:
            db.execute("UPDATE comments SET comment_id='replacement' WHERE comment_id='ai-note-A-c1'")
        self.assertNotEqual(token, self.store._data_overview_snapshot_token())

    def test_missing_material_and_inventory_changes_are_detected(self):
        token = self.approve()
        path = self.media['ai-note-A'] / 'comments.json'
        data = path.read_bytes()
        path.unlink()
        self.assertNotEqual(token, self.store._data_overview_snapshot_token())
        path.write_bytes(data)
        self.assertEqual(token, self.store._data_overview_snapshot_token())
        extra = path.with_name('fixture-extra.txt')
        extra.write_text('fixture only')
        self.assertNotEqual(token, self.store._data_overview_snapshot_token())

    def test_expired_pagination_and_filters_are_preserved(self):
        token = self.approve()
        payload = {'page': 2, 'pageSize': 1,
                   'sort': [{'field': 'comment_id', 'direction': 'desc'}],
                   'filter': {'logic': 'and', 'conditions': [
                       {'field': 'content', 'operator': 'contains', 'value': 'Fixture'}]}}
        before = self.query(token, **payload)
        self.expire(token)
        self.assertEqual(before, self.query(token, **payload))


if __name__ == '__main__':
    unittest.main()
