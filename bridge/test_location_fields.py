"""Region extraction and multi-store consistency, using generated local fixtures."""
import json
import unittest
from pathlib import Path
from unittest.mock import patch

from location_fields import extract_region, enrich_location_payload, REGION_KEYS
from server import NOTE_CSV_HEADERS, COMMENT_CSV_HEADERS
import test_publication_times as time_cases
from test_publication_times import COMPLETE, OBSERVED


class RegionRuleTests(unittest.TestCase):
    def test_displayed_native_formats(self):
        for raw, expected in [
            ("01-27 四川", "四川"), ("昨天23:11上海", "上海"), ("编辑于7天前 广东", "广东"),
            ("2025-12-04四川", "四川"), ("3小时之前 · 湖北", "湖北"), ("刚刚 北京", "北京"),
            ("02-09 IP属地：香港", "香港"), ("IP所在地：澳大利亚", "澳大利亚"),
            ("IP 属地: 内蒙古自治区", "内蒙古自治区"), ("来自美国", "美国"),
            ("编辑于 06-29 新疆", "新疆"), ("07-08 中国香港", "中国香港"),
        ]:
            with self.subTest(raw=raw): self.assertEqual(expected, extract_region(raw))

    def test_ambiguous_missing_and_prose_are_not_regions(self):
        for raw in [None, {}, "", "未显示", "192.168.1.1", "01-27", "产品来自四川", "我住在湖北", "2026-99-99 四川", "用户四川", "四川很好", "评论来自四川", "0个赞", "今天 回复 上海"]:
            with self.subTest(raw=raw): self.assertEqual("", extract_region(raw))

    def test_raw_fields_and_other_records_never_rewritten_or_inherited(self):
        raw={"publishedAt":"02-01 湖北", "ipLocation":"未显示", "author":"四川", "content":"来自北京", "parentIpLocation":"海南"}
        out=enrich_location_payload(raw,kind="comment")
        self.assertEqual("湖北",out["ipRegion"])
        for k,v in raw.items(): self.assertEqual(v,out[k])
        self.assertNotIn("ipRegion",raw)
        self.assertEqual(out,enrich_location_payload(out,kind="comment"))
        self.assertEqual("",enrich_location_payload({"publishedAt":"02-01","ipRegion":"湖北"},kind="comment")["ipRegion"])

    def test_explicit_native_region_precedes_date_suffix(self):
        out=enrich_location_payload({"ipLocation":"IP属地：浙江","publishedAt":"昨天 上海"})
        self.assertEqual("浙江",out["ipRegion"])
        self.assertEqual("page_metadata",out["ipRegionSource"])


class RegionStoreTests(unittest.TestCase):
    setUp=time_cases.TimeStoreTests.setUp
    pull=time_cases.TimeStoreTests.pull
    rows=time_cases.TimeStoreTests.rows
    csv_rows=time_cases.TimeStoreTests.csv_rows
    snapshot=time_cases.TimeStoreTests.snapshot
    query=time_cases.TimeStoreTests.query

    def test_new_pull_csv_db_json_and_query_use_same_regions(self):
        self.pull(raw="编辑于7天前 广东")
        notes,comments=self.rows()
        self.assertEqual("广东",json.loads(notes[0]["payload_json"])["ipRegion"])
        self.assertEqual("广东",self.csv_rows(self.notes_path)[0]["帖子IP属地"])
        by_id={row["笔记评论ID"]:row for row in self.csv_rows(self.comments_path)}
        material={row["commentId"]:row for row in json.loads((Path(notes[0]["media_dir"])/"comments.json").read_text(encoding="utf-8"))}
        for row in comments:
            expected="上海" if row["comment_level"]==1 else "浙江"
            self.assertEqual(expected,json.loads(row["payload_json"])["ipRegion"])
            self.assertEqual(expected,by_id[row["comment_id"]]["评论IP属地"])
            self.assertEqual(expected,material[row["comment_id"]]["ipRegion"])
        result=self.query(fields=["comment_id","ip_location","post__source_ip_location"], filter={"children":[{"field":"ip_location","operator":"eq","value":"浙江"}]})
        self.assertEqual(1,result["total"])
        self.assertEqual("浙江",result["rows"][0]["ip_location"])
        self.assertEqual("广东",result["rows"][0]["post__source_ip_location"])
        schema=self.store.data_overview_schema()
        for dataset,key in [("notes","source_ip_location"),("comments","ip_location")]:
            field=next(f for f in schema["datasets"][dataset]["fields"] if f["key"]==key)
            self.assertTrue(field["defaultVisible"] and field["filterable"] and field["sortable"] and field["suggestValues"])

    def legacy(self):
        notes,comments=self.rows()
        for table,key,rows in [("notes","note_id",notes),("comments","comment_id",comments)]:
            with self.store._session() as db:
                for row in rows:
                    payload=json.loads(row["payload_json"])
                    for name in REGION_KEYS: payload.pop(name,None)
                    db.execute(f"UPDATE {table} SET payload_json=? WHERE {key}=?",(json.dumps(payload,ensure_ascii=False),row[key]))
        for path,headers,column in [(self.notes_path,NOTE_CSV_HEADERS,"帖子IP属地"),(self.comments_path,COMMENT_CSV_HEADERS,"评论IP属地")]:
            cols,rows=self.store._read_csv_table(path,headers)
            self.store._replace_csv_table(path,[k for k in cols if k!=column],rows,"region-legacy")
        for note in notes:
            for file in ("note.json","comments.json"):
                path=Path(note["media_dir"])/file; payload=json.loads(path.read_text(encoding="utf-8"))
                for obj in payload if isinstance(payload,list) else [payload]:
                    for key in REGION_KEYS: obj.pop(key,None)
                path.write_text(json.dumps(payload,ensure_ascii=False),encoding="utf-8")

    def test_existing_store_backfill_preserves_ids_raw_dates_content_and_states(self):
        self.pull(raw="07-07 湖北")
        self.legacy(); before=self.rows()
        schema=self.store.data_overview_schema(); self.assertTrue(schema["queryReady"],schema["health"].get("issues"))
        after=self.rows()
        for old_rows,new_rows in zip(before,after):
            for old,new in zip(old_rows,new_rows):
                self.assertEqual({k:v for k,v in old.items() if k!="payload_json"},{k:v for k,v in new.items() if k!="payload_json"})
                original=json.loads(old["payload_json"]); projected=json.loads(new["payload_json"])
                for key in REGION_KEYS:projected.pop(key,None)
                self.assertEqual(original,projected)
        one=self.snapshot(); self.store.data_overview_schema(); self.assertEqual(one,self.snapshot())

    def test_backfill_is_atomic_on_material_write_failure(self):
        self.pull(); self.legacy(); before=self.snapshot()
        with patch.object(self.store,"_refresh_material_snapshot_for_note",side_effect=OSError("fixture failure")):
            with self.assertRaises(OSError): self.store.normalize_publication_storage()
        self.assertEqual(before,self.snapshot())

    def test_legacy_csv_reimport_on_bridge_startup_can_backfill(self):
        self.pull(raw="07-07 湖北"); self.legacy()
        before={row["comment_id"]:(row["content"],row["published_at"],row["is_deleted"]) for row in self.rows()[1]}
        self.store.seed_from_xlsx(self.notes_path)
        schema=self.store.data_overview_schema()
        self.assertTrue(schema["queryReady"],schema["health"].get("issues"))
        self.assertEqual(before,{row["comment_id"]:(row["content"],row["published_at"],row["is_deleted"]) for row in self.rows()[1]})
        self.assertEqual("湖北",self.csv_rows(self.notes_path)[0]["帖子IP属地"])

    def test_partial_sync_updates_region_without_deleting_missing_comments(self):
        note,comments=self.pull()
        result=self.store.sync_comment_snapshot({"noteId":note["noteId"],"note":note,
            "comments":[{**comments[0],"ipLocation":"四川"}],"status":"partial","expectedCount":2})
        self.assertTrue(result["consistencyVerified"])
        _,rows=self.rows(); self.assertEqual(2,len(rows)); self.assertTrue(all(not row["is_deleted"] for row in rows))
        by_id={row["comment_id"]:row for row in rows}
        self.assertEqual("四川",json.loads(by_id[comments[0]["commentId"]]["payload_json"])["ipRegion"])

    def test_region_field_drift_blocks_queries_instead_of_silently_repairing(self):
        self.pull()
        headers,rows=self.store._read_csv_table(self.comments_path,COMMENT_CSV_HEADERS)
        rows[0]["评论IP属地"]="海南"
        self.store._replace_csv_table(self.comments_path,headers,rows,"bad-location")
        before=self.snapshot();schema=self.store.data_overview_schema()
        self.assertFalse(schema["queryReady"])
        self.assertEqual(before,self.snapshot())
