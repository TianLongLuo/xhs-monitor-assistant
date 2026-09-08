"""Date ordering, thread modes and composed-filter regressions; temporary stores only."""
import sqlite3
import unittest
from data_overview import FieldSpec, compile_sort, compile_filter_group
import test_publication_times as publication

class QueryModeTests(unittest.TestCase):
    setUp = publication.TimeStoreTests.setUp
    pull = publication.TimeStoreTests.pull
    query = publication.TimeStoreTests.query

    def seed_threads(self):
        items = [
            {"commentId":"root-older", "publishedAt":"2025-12-04"},
            {"commentId":"root-newer", "publishedAt":"2026-07-16"},
            {"commentId":"reply-newest", "parentCommentId":"root-older", "commentLevel":2, "publishedAt":"2026-09-03"},
            {"commentId":"reply-middle", "parentCommentId":"root-newer", "commentLevel":2, "publishedAt":"2026-08-03"},
            {"commentId":"reply-orphan", "parentCommentId":"missing-root", "commentLevel":2, "publishedAt":"2026-09-02"},
        ]
        self.pull(comments=[{**x,"content":x["commentId"],"author":"上海" if "new" in x["commentId"] else "北京"} for x in items])

    def ids(self,**kwargs):
        return [row["comment_id"] for row in self.query(**kwargs)["rows"]]

    def test_root_time_orders_groups_by_parent_not_newest_reply(self):
        self.seed_threads()
        for direction,expected in [("desc",["root-newer","reply-middle","root-older","reply-newest","reply-orphan"]),
                                   ("asc",["root-older","reply-newest","root-newer","reply-middle","reply-orphan"])]:
            args=dict(groupThreads=True,threadSortMode="root",sort=[{"field":"published_at","direction":direction}])
            self.assertEqual(expected,self.ids(**args))
            pages=[item for page in (1,2,3) for item in self.ids(page=page,pageSize=2,**args)]
            self.assertEqual(expected,pages)

    def test_individual_time_can_interleave_threads_with_merge_requested(self):
        self.seed_threads()
        self.assertEqual(["reply-newest","reply-orphan","reply-middle","root-newer","root-older"],
            self.ids(groupThreads=True,threadSortMode="comment",sort=[{"field":"published_at","direction":"desc"}]))

    def test_original_date_column_sorts_by_normalized_calendar_not_label(self):
        items=[{"commentId":"date-root-old","publishedAt":"2025-12-04"},
               {"commentId":"date-root-mid","publishedAt":"07-16浙江"},
               {"commentId":"date-root-new","publishedAt":"昨天23:11上海"},
               {"commentId":"date-root-null","publishedAt":"未显示"}]
        self.pull(comments=[{**x,"content":x["commentId"],"author":"test"} for x in items])
        for field in ["published_at","published_at_raw"]:
            self.assertEqual([x["commentId"] for x in items],self.ids(sort=[{"field":field,"direction":"asc"}]))

    def test_multi_filters_accept_chinese_comma_and_keep_and_or_grouping(self):
        self.seed_threads()
        date={"field":"published_at","operator":"between","value":"2026-08-01","value2":"2026-09-03"}
        region={"field":"author","operator":"in","value":"上海，北京"}
        self.assertEqual(["reply-newest","reply-orphan","reply-middle"],
            self.ids(filter={"logic":"and","children":[date,region]}))
        same={"logic":"or","children":[{"field":"author","operator":"eq","value":"上海"},
                                         {"field":"author","operator":"eq","value":"北京"}]}
        self.assertEqual(self.ids(filter={"logic":"and","children":[date,region]}),
                         self.ids(filter={"logic":"and","children":[date,same]}))

    def test_reversed_range_reports_error_instead_of_empty_results(self):
        self.seed_threads()
        with self.assertRaisesRegex(ValueError,"开始时间晚于"):
            self.ids(filter={"children":[{"field":"published_at","operator":"between","value":"2026-09-03","value2":"2026-08-01"}]})
        self.assertEqual(["reply-newest"],self.ids(filter={"children":[
            {"field":"published_at","operator":"between","value":"2026-09-03 00:00:00","value2":"2026-09-03"}]}))

class ScalarSortTests(unittest.TestCase):
    def test_numeric_sort_uses_numbers_not_text_and_multivalue_keeps_zero(self):
        db=sqlite3.connect(":memory:");self.addCleanup(db.close)
        db.execute("CREATE TABLE notes(note_id TEXT, score TEXT)")
        db.executemany("INSERT INTO notes VALUES(?,?)",[("a","10"),("b","2"),("c","0")])
        spec=FieldSpec("score","score","number","n.score","fixture",True,0)
        specs={"score":spec}
        order=compile_sort([{"field":"score","direction":"asc"}],specs,"notes")
        self.assertEqual(["c","b","a"],[r[0] for r in db.execute("SELECT note_id FROM notes n ORDER BY "+order)])
        sql,params,_=compile_filter_group({"children":[{"field":"score","operator":"in","value":"0，2"}]},specs)
        self.assertEqual(["b","c"],[r[0] for r in db.execute("SELECT note_id FROM notes n WHERE "+sql,params)])

if __name__ == "__main__":
    unittest.main()
