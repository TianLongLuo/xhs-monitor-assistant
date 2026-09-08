"""Deterministic offline regressions; no production data/model/network required."""
import math
from pathlib import Path
import tempfile
import time
import unittest

from server import MonitorStore
from semantic_search import retrieve


class FakeEncoder:
    def __init__(self):
        self.calls = []

    def scores(self, texts, query):
        self.calls.append((texts, query))
        return [0.9 if '红痒' in t else 0.7 if '强迫' in t else 0.1 for t in texts]


class SemanticTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = MonitorStore(Path(self.tmp.name) / 'fixture.db', Path(self.tmp.name) / 'exports')
        self.store.configure_data_files(Path(self.tmp.name) / 'fixture.csv')
        self.encoder = FakeEncoder()
        self.store._semantic_encoder = self.encoder
        with self.store._session() as db:
            for ident, status in [('n1', 'confirmed'), ('n2', 'confirmed'), ('outside', 'new')]:
                db.execute("INSERT INTO notes(note_id,url,title,content,status,first_seen_at,last_seen_at) VALUES(?,?,?,?,?,?,?)",
                           (ident, 'https://example.test/'+ident, '日常分享', '普通正文', status, '', ''))
            for ident, note, content in [('c1','n1','涂完皮肤红痒'), ('c2','n2','店员强迫我购买'), ('c3','n1','很好用'), ('c4','outside','红痒')]:
                db.execute('INSERT INTO comments(comment_id,note_id,content,first_seen_at,last_seen_at) VALUES(?,?,?,?,?)',
                           (ident,note,content,'',''))
        self.token = self.store._data_overview_snapshot_token()
        self.store._data_overview_approved_tokens[self.token] = time.time()

    def query(self, **options):
        payload = {'dataset':'comments','snapshotToken': self.token, 'fields':['comment_id','content'],
                   'search':'过敏', 'semanticSearch':True}
        payload.update(options)
        return self.store.query_data_overview(payload)

    def test_rank_without_literal_match_and_scope(self):
        result = self.query()
        self.assertEqual(['c1','c2'], [r['comment_id'] for r in result['rows']])
        self.assertEqual('涂完皮肤红痒', result['rows'][0]['_semantic_evidence'])
        self.assertEqual('embedding',result['semantic']['mode'])
        self.assertNotIn('c4',[r['comment_id'] for r in result['rows']])

    def test_notes_retrieve_child_comments(self):
        result = self.query(dataset='notes',fields=['note_id','title'])
        self.assertEqual(['n1','n2'], [r['note_id'] for r in result['rows']])
        self.assertEqual('c1',result['rows'][0]['_semantic_comment_id'])

    def test_filters_before_ranking(self):
        result = self.query(filter={'logic':'and','children':[{'field':'note_id','operator':'eq','value':'n2'}]})
        self.assertEqual(['c2'],[r['comment_id'] for r in result['rows']])
        self.assertEqual(['店员强迫我购买'],self.encoder.calls[0][0])

    def test_notes_filters_apply_to_child_evidence(self):
        result=self.query(dataset='notes',fields=['note_id'],filter={'logic':'and','children':[{'field':'note_id','operator':'eq','value':'n2'}]})
        self.assertEqual('n2',result['rows'][0]['note_id'])
        self.assertNotIn('涂完皮肤红痒',self.encoder.calls[0][0])

    def test_pagination_stable_and_sort_override(self):
        a=self.query(pageSize=1,sort=[{'field':'comment_id','direction':'desc'}],groupThreads=True)
        b=self.query(pageSize=1,page=2)
        self.assertEqual(2,a['total'])
        self.assertEqual('c1',a['rows'][0]['comment_id'])
        self.assertEqual('c2',b['rows'][0]['comment_id'])

    def test_no_match(self):
        self.assertEqual([],self.query(semanticMinScore=.99)['rows'])

    def test_top_limit(self):
        self.assertEqual(1,self.query(semanticLimit=1)['total'])

    def test_existing_sentiment_reranks_without_changing_cosine(self):
        with self.store._session() as db:
            db.execute("UPDATE comments SET sentiment='positive' WHERE comment_id='c1'")
            db.execute("UPDATE comments SET is_negative=1 WHERE comment_id='c2'")
        self.token=self.store._data_overview_snapshot_token()
        self.store._data_overview_approved_tokens[self.token]=time.time()
        result=self.query(search='差评')
        self.assertEqual('c2',result['rows'][0]['comment_id'])
        self.assertEqual(.7,result['rows'][0]['_semantic_cosine'])
        self.assertEqual(.8,result['rows'][0]['_semantic_score'])

    def test_deleted_evidence_is_labelled(self):
        with self.store._session() as db:
            db.execute("UPDATE comments SET is_deleted=1 WHERE comment_id='c1'")
        self.token=self.store._data_overview_snapshot_token()
        self.store._data_overview_approved_tokens[self.token]=time.time()
        self.assertEqual('已删除评论',self.query(dataset='notes',fields=['note_id'])['rows'][0]['_semantic_evidence_status'])

    def test_denial_only_does_not_become_complaint(self):
        with self.store._session() as db:
            db.execute("UPDATE comments SET content='我没有过敏，挺舒服' WHERE comment_id='c1'")
        self.token=self.store._data_overview_snapshot_token()
        self.store._data_overview_approved_tokens[self.token]=time.time()
        self.encoder.scores=lambda texts,query:[.9]*len(texts)
        self.assertNotIn('c1',[r['comment_id'] for r in self.query()['rows']])

    def test_other_product_contrast_is_demoted(self):
        with self.store._session() as db:
            db.execute("UPDATE comments SET content='之前用了某大牌过敏，现在这款很舒服没翻车' WHERE comment_id='c1'")
        self.token=self.store._data_overview_snapshot_token()
        self.store._data_overview_approved_tokens[self.token]=time.time()
        self.encoder.scores=lambda texts,query:[.7]*len(texts)
        result=self.query(semanticMinScore=.4)
        contrasted=next(r for r in result['rows'] if r['comment_id']=='c1')
        self.assertEqual(.5,contrasted['_semantic_score'])
        self.assertEqual(.7,contrasted['_semantic_cosine'])

    def test_normal_search_unchanged(self):
        self.assertEqual(0,self.query(semanticSearch=False)['total'])
        self.assertFalse(self.encoder.calls)
        self.assertEqual(1,self.query(semanticSearch=False,search='红痒')['total'])

    def test_bad_inputs(self):
        for options in [{'search':''},{'search':'x'*501},{'semanticMinScore':math.nan},{'semanticMinScore':2},{'snapshotToken':'bad'}]:
            with self.subTest(options=options),self.assertRaises(ValueError):
                self.query(**options)

    def test_read_only(self):
        before=self.store.db_path.read_bytes()
        self.query()
        self.assertEqual(before,self.store.db_path.read_bytes())

    def test_content_change_invalidates_snapshot(self):
        with self.store._session() as db:
            db.execute("UPDATE comments SET content='已更正' WHERE comment_id='c1'")
        with self.assertRaises(ValueError):
            self.query()

    def test_long_text_chunk_and_empty_candidates(self):
        with self.store._session() as db:
            db.execute("UPDATE comments SET content=? WHERE comment_id='c1'",('普通'*400+'红痒',))
        self.token=self.store._data_overview_snapshot_token()
        self.store._data_overview_approved_tokens[self.token]=time.time()
        self.assertIn('红痒',self.query()['rows'][0]['_semantic_evidence'])
        self.assertEqual(0,self.query(filter={'logic':'and','children':[{'field':'comment_id','operator':'eq','value':"' OR 1=1 --"}]})['total'])


if __name__ == '__main__':
    unittest.main()
