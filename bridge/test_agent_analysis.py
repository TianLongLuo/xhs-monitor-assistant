"""Publication and recovery tests, temporary data only."""
import copy
import json
import unittest
from unittest.mock import patch

import agent_analysis as api
from server import MonitorStore
import test_ai_publication as fixtures


class AgentAnalysisTests(unittest.TestCase):
    setUp = fixtures.AIPublicationTests.setUp
    new_store = fixtures.AIPublicationTests.new_store
    add_note = fixtures.AIPublicationTests.add_note
    snapshot = fixtures.AIPublicationTests.snapshot
    rows = fixtures.AIPublicationTests.rows
    assert_ready = fixtures.AIPublicationTests.assert_ready
    assert_no_checkpoints = fixtures.AIPublicationTests.assert_no_checkpoints

    def request(self):
        batch = api.pending(self.store, {'limit': 25})
        return {'batchId': batch['batchId'], 'agent': 'fixture', 'model': 'fixture', 'items': [
            {k: v for k, v in item.items() if k not in ('source', 'noteContext', 'parentContext')} |
            {'analysisIsNegative': '否', 'negativeType': '', 'negativeSubtype': '',
             'reason': 'Fixture reason', 'evidence': [item['source']['content']]}
            for item in batch['items']]}

    def test_publish_idempotent_and_verify(self):
        request = self.request()
        result = api.submit(self.store, request)
        self.assertEqual(3, result['updatedCount'])
        self.assertEqual(result, api.submit(self.store, request))
        self.assertEqual(0, api.pending(self.store, {})['pendingCount'])
        self.assertTrue(api.verify(self.store, {'batchId': request['batchId']})['verified'])
        self.assertEqual(1, len(self.rows('external_analysis_batches')))
        self.assertEqual([1, 1], [r['semantic_analysis_count'] for r in self.rows('comments')])
        self.assert_no_checkpoints()
        self.assert_ready()

    def test_same_batch_different_payload_rejected(self):
        req = self.request()
        api.submit(self.store, req)
        req['model'] = 'other'
        with self.assertRaisesRegex(ValueError, '不同内容'):
            api.submit(self.store, req)

    def test_negative_fields_and_audit_preserved(self):
        req = self.request()
        req['items'][0].update(analysisIsNegative='是', negativeType='产品体验', negativeSubtype='临时测试分类')
        api.submit(self.store, req)
        row = self.rows('notes')[0]
        self.assertEqual('是', row['analysis_is_negative'])
        self.assertEqual('产品体验', row['negative_type'])
        audit = json.loads(self.rows('external_analysis_batches')[0]['audit_json'])
        self.assertEqual('fixture', audit['model'])
        self.assertEqual('', audit['items'][0]['before'][1])
        self.assertTrue(api.verify(self.store, {'batchId': req['batchId']})['verified'])

    def test_final_ledger_insert_failure_rolls_back(self):
        import sqlite3
        with self.store._session() as db:
            db.execute("CREATE TRIGGER fail_receipt BEFORE INSERT ON external_analysis_batches BEGIN SELECT RAISE(ABORT, 'fixture receipt failure'); END")
        req, before = self.request(), self.snapshot()
        with self.assertRaises(sqlite3.IntegrityError):
            api.submit(self.store, req)
        self.assertEqual(before, self.snapshot())
        self.assert_no_checkpoints()

    def test_verify_detects_subsequent_change(self):
        req = self.request()
        api.submit(self.store, req)
        with self.store._session() as db:
            db.execute("UPDATE notes SET content='changed after commit'")
        with self.assertRaisesRegex(ValueError, '已有变化'):
            api.verify(self.store, {'batchId': req['batchId']})

    def test_stale_source_and_semantics_rejected(self):
        for field, value in [('content', 'changed'), ('semantic_analysis_count', 5)]:
            self.new_store()
            req = self.request()
            with self.store._session() as db:
                db.execute(f'UPDATE notes SET {field}=?', (value,))
            before = self.snapshot()
            with self.assertRaisesRegex(ValueError, '已变化'):
                api.submit(self.store, req)
            self.assertEqual(before, self.snapshot())

    def test_invalid_evidence_and_duplicate(self):
        req = self.request()
        req['items'][0]['evidence'] = ['fabricated evidence']
        before = self.snapshot()
        with self.assertRaisesRegex(ValueError, 'evidence'):
            api.submit(self.store, req)
        self.assertEqual(before, self.snapshot())
        req = self.request()
        req['items'].append(copy.deepcopy(req['items'][0]))
        with self.assertRaisesRegex(ValueError, '重复'):
            api.submit(self.store, req)

    def test_failure_rolls_back_every_store(self):
        for hook in ('_replace_csv_pair', '_refresh_material_snapshot_for_note'):
            self.new_store()
            req, before = self.request(), self.snapshot()
            with patch.object(self.store, hook, side_effect=OSError('fixture failure')):
                with self.assertRaises(OSError):
                    api.submit(self.store, req)
            self.assertEqual(before, self.snapshot())
            self.assert_no_checkpoints()
            self.assert_ready()

    def test_post_write_verification_failure_rolls_back(self):
        req, before = self.request(), self.snapshot()
        real = self.store._verify_note_store_consistency
        calls = []
        def verify(*a, **kw):
            calls.append(1)
            if len(calls) == 2:
                raise ValueError('fixture verification failure')
            return real(*a, **kw)
        with patch.object(self.store, '_verify_note_store_consistency', side_effect=verify):
            with self.assertRaisesRegex(ValueError, 'fixture'):
                api.submit(self.store, req)
        self.assertEqual(before, self.snapshot())

    def reopen(self):
        store = MonitorStore(self.store.db_path, self.store.export_dir, ai_client=self.client)
        store.configure_data_files(self.notes_path)
        return store

    def test_committed_checkpoint_is_not_rolled_back_on_restart(self):
        req = self.request()
        with patch.object(self.store, '_discard_sync_checkpoint', side_effect=OSError('cleanup failure')):
            receipt = api.submit(self.store, req)
        self.assertTrue(list((self.store.export_dir / '.sync_checkpoints').glob('*/checkpoint.json')))
        # Subsequent external bytes must not trigger the obsolete checkpoint conflict check.
        self.notes_path.write_bytes(self.notes_path.read_bytes() + b'\r\n')
        self.store = self.reopen()
        self.assertEqual(receipt, api.status(self.store, {'batchId': req['batchId']}))
        self.assertEqual('否', self.rows('notes')[0]['analysis_is_negative'])
        self.assert_no_checkpoints()

    def test_uncommitted_crash_recovers(self):
        req, before = self.request(), self.snapshot()
        with patch.object(self.store, '_refresh_material_snapshot_for_note', side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                api.submit(self.store, req)
        self.store = self.reopen()
        self.assertEqual(before, self.snapshot())
        self.assert_no_checkpoints()

    def test_review_is_not_requeued(self):
        req = self.request()
        for item in req['items']:
            item.update(analysisIsNegative='待复核', evidence=[])
        api.submit(self.store, req)
        self.assertEqual(3, api.pending(self.store, {})['needsReviewCount'])
        self.assertEqual(0, api.pending(self.store, {})['pendingCount'])

    def test_different_notes_are_exported_separately(self):
        self.add_note('B')
        batch = api.pending(self.store, {})
        self.assertEqual(6, batch['pendingCount'])
        self.assertEqual(1, len({i['noteId'] for i in batch['items']}))

    def test_missing_snapshot_and_deleted_skipped(self):
        with self.store._session() as db:
            db.execute("UPDATE notes SET is_deleted=1")
        self.assertEqual(0, api.pending(self.store, {})['pendingCount'])
        self.assertEqual(3, api.pending(self.store, {})['excludedCount'])


if __name__ == '__main__':
    unittest.main()
