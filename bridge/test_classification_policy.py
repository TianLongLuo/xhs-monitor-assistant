"""Classification policy v2: no blank columns, explicit non-overwriting repair."""
import copy
import unittest
from unittest.mock import patch
import agent_analysis as api
import test_agent_analysis as fixtures


class ClassificationPolicyTests(unittest.TestCase):
    setUp = fixtures.AgentAnalysisTests.setUp
    new_store = fixtures.AgentAnalysisTests.new_store
    add_note = fixtures.AgentAnalysisTests.add_note
    rows = fixtures.AgentAnalysisTests.rows
    snapshot = fixtures.AgentAnalysisTests.snapshot
    request = fixtures.AgentAnalysisTests.request
    assert_ready = fixtures.AgentAnalysisTests.assert_ready
    assert_no_checkpoints = fixtures.AgentAnalysisTests.assert_no_checkpoints

    def legacy(self, kind='Neutral', subtype=''):
        api.submit(self.store, self.request())
        # Construct a consistent legacy fixture, never a production database.
        with self.store._session() as db:
            for table in ('notes','comments'):
                db.execute(f'UPDATE {table} SET negative_type=?,negative_subtype=?',(kind,subtype))
        np,cp=self.store._csv_paths();nh,nr=self.store._read_csv_table(np,[]);ch,cr=self.store._read_csv_table(cp,[])
        for row in nr+cr:row.update({'差评类型':kind,'差评子类型':subtype})
        self.store._replace_csv_pair(nh,nr,ch,cr,'classification-fixture')
        for note in self.rows('notes'):self.store._refresh_material_snapshot_for_note(note['note_id'])
        self.assert_ready()

    def repair_request(self):
        batch=api.pending(self.store,{'mode':'fillMissingCategories'})
        items=[]
        for item in batch['items']:
            prior=item['currentAnalysis']
            items.append({k:v for k,v in item.items() if k not in ('source','noteContext','parentContext','currentAnalysis')} | {
                'analysisIsNegative':prior['analysisIsNegative'], 'negativeType':prior['negativeType'] or 'Neutral',
                'negativeSubtype':prior['negativeSubtype'] or '中性陈述', 'reason':'Fixture contextual classification',
                'evidence':[item['source']['content']]})
        return {'batchId':batch['batchId'],'agent':'fixture','model':'fixture','mode':batch['mode'],'items':items}

    def test_all_conclusions_publish_all_categories(self):
        req=self.request()
        for item,value in zip(req['items'],('是','否','待复核')):
            item.update(analysisIsNegative=value,negativeType='分类样本',negativeSubtype='具体语义样本')
        result=api.submit(self.store,req)
        self.assertEqual(result['classificationPolicyVersion'],2)
        self.assertTrue(api.verify(self.store,{'batchId':req['batchId']})['verified'])
        self.assert_ready()
        for row in self.rows('notes')+self.rows('comments'):
            self.assertEqual(row['negative_type'],'分类样本');self.assertEqual(row['negative_subtype'],'具体语义样本')

    def test_blank_categories_rejected_for_every_conclusion_without_writes(self):
        before=self.snapshot()
        for value in ('是','否','待复核'):
            for field in ('negativeType','negativeSubtype'):
                req=self.request();req['items'][0].update(analysisIsNegative=value);req['items'][0][field]='   '
                with self.assertRaisesRegex(ValueError,'类型'):api.submit(self.store,req)
                self.assertEqual(before,self.snapshot())

    def test_explicit_repair_fills_only_missing_and_is_idempotent(self):
        self.legacy()
        self.assertEqual(api.pending(self.store,{})['pendingCount'],0)
        batch=api.pending(self.store,{'mode':'fillMissingCategories'})
        self.assertEqual(batch['pendingCount'],3);self.assertEqual(batch['items'][0]['currentAnalysis']['negativeType'],'Neutral')
        req=self.repair_request();result=api.submit(self.store,req)
        self.assertEqual(result,api.submit(self.store,req))
        self.assertTrue(api.verify(self.store,{'batchId':req['batchId']})['verified'])
        for row in self.rows('notes')+self.rows('comments'):
            self.assertEqual(row['analysis_is_negative'],'否');self.assertEqual(row['negative_type'],'Neutral')
            self.assertEqual(row['negative_subtype'],'中性陈述');self.assertEqual(row['semantic_analysis_count'],2)
        self.assertEqual(api.pending(self.store,{'mode':'fillMissingCategories'})['pendingCount'],0)
        self.assert_ready()

    def test_repair_preserves_existing_subtype_too(self):
        self.legacy(kind='',subtype='原有子类型')
        req=self.repair_request();api.submit(self.store,req)
        for row in self.rows('notes')+self.rows('comments'):self.assertEqual(row['negative_subtype'],'原有子类型')

    def test_repair_cannot_change_conclusion_or_populated_category(self):
        self.legacy();before=self.snapshot()
        for changes in ({'analysisIsNegative':'是'},{'negativeType':'changed'}):
            req=self.repair_request();req['items'][0].update(changes)
            with self.assertRaisesRegex(ValueError,'不得'):api.submit(self.store,req)
            self.assertEqual(before,self.snapshot())
        req=self.repair_request();req.pop('mode')
        with self.assertRaisesRegex(ValueError,'已有结论'):api.submit(self.store,req)

    def test_repair_stale_revision_and_projection_failure_keep_old_data(self):
        self.legacy();req=self.repair_request();bad=copy.deepcopy(req);bad['items'][0]['analysisRevision']='stale'
        before=self.snapshot()
        with self.assertRaisesRegex(ValueError,'已变化'):api.submit(self.store,bad)
        with patch.object(self.store,'_replace_csv_pair',side_effect=OSError('fixture projection')):
            with self.assertRaisesRegex(OSError,'fixture projection'):api.submit(self.store,req)
        self.assertEqual(before,self.snapshot());self.assert_no_checkpoints();self.assert_ready()

    def test_repair_cannot_target_unanalyzed_or_complete_rows_or_invalid_mode(self):
        req=self.request();req['mode']='fillMissingCategories'
        with self.assertRaisesRegex(ValueError,'只处理'):api.submit(self.store,req)
        for mode in ('all',True,None):
            with self.assertRaises(ValueError):api.pending(self.store,{'mode':mode})
        api.submit(self.store,self.request());req=self.request();req['mode']='fillMissingCategories'
        self.assertEqual(api.pending(self.store,{'mode':'fillMissingCategories'})['items'],[])

    def test_malformed_old_conclusion_is_reported_not_exported(self):
        self.legacy()
        with self.store._session() as db:db.execute("UPDATE notes SET analysis_is_negative=' 否 '")
        batch=api.pending(self.store,{'mode':'fillMissingCategories'})
        self.assertEqual(batch['invalidConclusionCount'],1)
        self.assertTrue(all(item['targetType']=='comment' for item in batch['items']))
        self.assertEqual(batch['pendingCount'],2)

    def test_foreign_prewrite_change_is_not_overwritten_or_rolled_back(self):
        self.legacy();req=self.repair_request();real=self.store._verify_note_store_consistency
        changed=False
        def foreign(*args,**kwargs):
            nonlocal changed
            result=real(*args,**kwargs)
            if not changed:
                with self.store._session() as db:db.execute("UPDATE notes SET negative_type='external writer classification'")
                changed=True
            return result
        with patch.object(self.store,'_verify_note_store_consistency',side_effect=foreign), \
             patch.object(self.store,'_capture_sync_checkpoint',wraps=self.store._capture_sync_checkpoint) as capture:
            with self.assertRaisesRegex(ValueError,'提交前数据已变化'):api.submit(self.store,req)
            capture.assert_not_called()
        self.assertEqual(self.rows('notes')[0]['negative_type'],'external writer classification')
        self.assertEqual(len(self.rows('external_analysis_batches')),1)
        self.assertEqual(self.rows('notes')[0]['semantic_analysis_count'],1)
        self.assert_no_checkpoints()
