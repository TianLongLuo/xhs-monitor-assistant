"""Publication-time, cross-store migration and chronological query regressions."""
import csv
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from data_overview import FieldSpec, compile_filter_group, datetime_sql
from server import MonitorStore, NOTE_CSV_HEADERS, COMMENT_CSV_HEADERS
from time_fields import (
    enrich_time_payload, csv_time_fields, NOTE_TIME_HEADERS, COMMENT_TIME_HEADERS,
)

OBSERVED = "2026-09-03T15:30:00+08:00"
COMPLETE = {"allCommentsRequested": True, "expandersExhausted": True,
            "scrollExhausted": True, "stableRounds": 2}
TIME_KEYS = {"publishedTime", "updatedTime", "timeObservedAt", "timeReferenceSource", "ipRegion", "ipRegionSource", "ipRegionVersion"}


class TimePayloadTests(unittest.TestCase):
    def test_capture_time_is_fixed_and_timezone_independent(self):
        note = enrich_time_payload({"publishedAt": "3小时前上海", "timeObservedAt": "2026-09-03T07:30:00Z"})
        self.assertEqual("2026-09-03 12:30:00", note["publishedTime"]["value"])
        self.assertEqual("2026-09-03T15:30:00+08:00", note["timeObservedAt"])
        self.assertEqual(note, enrich_time_payload(note, "2099-01-01T00:00:00Z"))
        self.assertEqual("3小时前上海", note["publishedAt"])

    def test_date_only_does_not_invent_a_clock_or_exact_year(self):
        value = enrich_time_payload({"publishedAt": "07-16浙江"}, OBSERVED, kind="comment")
        self.assertEqual("2026-07-16", value["publishedTime"]["value"])
        self.assertIsNone(value["publishedTime"]["timestamp"])
        self.assertEqual("day", value["publishedTime"]["precision"])
        self.assertEqual("estimated", value["publishedTime"]["status"])
        self.assertIn("年份", csv_time_fields(value, kind="comment")["评论时间说明"])

    def test_edited_time_fills_publication_column_with_explicit_provenance(self):
        value = enrich_time_payload({"publishedAt": "编辑于7天前 广东", "updatedAt": "未显示"}, OBSERVED)
        self.assertEqual("2026-08-27", value["publishedTime"]["value"])
        self.assertEqual("estimated_from_edit", value["publishedTime"]["status"])
        self.assertEqual("last_edit_time", value["publishedTime"]["basis"])
        self.assertEqual("day", value["publishedTime"]["precision"])
        self.assertEqual("2026-08-27", value["updatedTime"]["value"])
        self.assertEqual("2026-08-27", csv_time_fields(value)["更新时间（标准）"])
        self.assertEqual("2026-08-27", csv_time_fields(value)["发布时间（标准）"])
        self.assertIn("非首次发布时间", csv_time_fields(value)["发布时间说明"])

    def test_edited_hours_use_beijing_clock_and_do_not_change_on_a_reread(self):
        value = enrich_time_payload({"publishedAt": "编辑于3小时前 上海"}, "2026-09-03T07:30:00Z")
        self.assertEqual("2026-09-03 12:30:00", value["publishedTime"]["value"])
        self.assertEqual("estimated_from_edit", value["publishedTime"]["status"])
        self.assertEqual(value, enrich_time_payload(value, "2026-10-03T23:30:00Z"))

    def test_edited_label_without_a_clock_or_invalid_label_is_not_fabricated(self):
        value = enrich_time_payload({"publishedAt": "编辑于7天前"})
        self.assertEqual("needs_reference", value["publishedTime"]["status"])
        self.assertEqual("", value["publishedTime"]["value"])
        value = enrich_time_payload({"publishedAt": "编辑于几天前"}, OBSERVED)
        self.assertEqual("", value["publishedTime"]["value"])

    def test_missing_capture_reference_stays_unresolved(self):
        value = enrich_time_payload({"publishedAt": "昨天23:11上海"}, None, kind="comment")
        self.assertEqual("needs_reference", value["publishedTime"]["status"])
        self.assertEqual("", value["publishedTime"]["value"])
        self.assertNotIn("timeObservedAt", value)

    def test_new_observation_replaces_reference_but_reread_does_not(self):
        old = enrich_time_payload({"publishedAt": "3小时前"}, OBSERVED)
        new = enrich_time_payload({**old, "publishedAt": "昨天23:11上海"},
                                  "2026-09-04T08:00:00+08:00", previous=old)
        self.assertEqual("2026-09-03 23:11:00", new["publishedTime"]["value"])
        self.assertEqual(new, enrich_time_payload(new, "2026-09-10T00:00:00Z"))

    def test_explicit_absolute_and_update_dates_remain_separate(self):
        value = enrich_time_payload({"publishedAt": "2025-12-04四川", "updatedAt": "昨天23:11上海"}, OBSERVED)
        self.assertEqual("2025-12-04", value["publishedTime"]["value"])
        self.assertEqual("2026-09-02 23:11:00", value["updatedTime"]["value"])


class DateFilterTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.addCleanup(self.db.close)
        self.db.execute("CREATE TABLE events(id INTEGER, at TEXT)")
        self.db.executemany("INSERT INTO events VALUES (?,?)", [
            (1, "2026-09-02 23:59:59"), (2, "2026-09-03"),
            (3, "2026-09-03 00:00:01"), (4, "2026-09-03T15:59:59Z"),
            (5, "2026-09-04 00:00:00"), (6, ""),
            (7, "2026-09-03T01:00:00+08:00"),
        ])
        self.specs = {"at": FieldSpec("at", "时间", "datetime", "at", "test", False)}

    def ids(self, operator, value="", value2=""):
        sql, args, _ = compile_filter_group({"children": [
            {"field": "at", "operator": operator, "value": value, "value2": value2}
        ]}, self.specs)
        return [row[0] for row in self.db.execute(f"SELECT id FROM events WHERE {sql} ORDER BY id", args)]

    def test_date_equality_uses_the_entire_beijing_calendar_day(self):
        self.assertEqual([2, 3, 4, 7], self.ids("eq", "2026-09-03"))
        self.assertEqual([2, 3, 4, 7], self.ids("between", "2026-09-03", "2026-09-03"))
        self.assertEqual([1, 5], self.ids("neq", "2026-09-03"))

    def test_datetime_boundaries_and_explicit_zones(self):
        self.assertEqual([4], self.ids("eq", "2026-09-03T15:59:59Z"))
        self.assertEqual([5], self.ids("gt", "2026-09-03"))
        self.assertEqual([1, 2, 3, 4, 7], self.ids("lte", "2026-09-03"))
        self.assertEqual([2, 3, 7], self.ids("between", "2026-09-03 00:00:00", "2026-09-03 01:00:00"))

    def test_multiple_days_and_invalid_dates(self):
        self.assertEqual([1, 5], self.ids("in", ["2026-09-02", "2026-09-04"]))
        with self.assertRaises(ValueError):
            self.ids("gte", "3小时前")
        with self.assertRaises(ValueError):
            self.ids("eq", "2026-02-31")

    def test_chronological_keys_handle_mixed_explicit_timezones(self):
        order = [row[0] for row in self.db.execute(
            f"SELECT id FROM events WHERE id<>6 ORDER BY ({datetime_sql('at')}) ASC")]
        self.assertEqual([1, 2, 3, 7, 4, 5], order)


class TimeStoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.store = MonitorStore(self.root / "monitor.db", self.root / "exports")
        self.notes_path, self.comments_path = self.store.configure_data_files(self.root / "master_notes.csv")
        self.store._ensure_seed_workbook(self.notes_path)

    def pull(self, note_id="time-note-001", raw="3小时前", comments=None, observed=OBSERVED):
        comments = comments if comments is not None else [
            {"commentId": "time-root-001", "author": "用户甲", "content": "一级内容",
             "publishedAt": "昨天23:11上海", "commentLevel": 1},
            {"commentId": "time-reply-001", "parentCommentId": "time-root-001", "author": "用户乙",
             "content": "二级内容", "publishedAt": "07-16浙江", "commentLevel": 2},
        ]
        note = {"noteId": note_id, "url": f"https://www.xiaohongshu.com/explore/{note_id}",
                "title": f"时间测试{note_id}", "author": "作者", "content": "测试正文", "detailRead": True,
                "publishedAt": raw, "timeObservedAt": observed, "timeReferenceSource": "capture"}
        items = [{**row, "timeObservedAt": observed, "timeReferenceSource": "capture"} for row in comments]
        with patch("server.now_iso", return_value=observed):
            result = self.store.pull_to_excel({"note": note, "comments": items,
                "expectedCount": len(items), "commentStatus": "likely_complete",
                "collectionEvidence": COMPLETE, "explicitEmptyVerified": not items})
        self.assertTrue(result["consistencyVerified"])
        return note, items

    def rows(self):
        with self.store._session() as db:
            return ([dict(row) for row in db.execute("SELECT * FROM notes ORDER BY note_id")],
                    [dict(row) for row in db.execute("SELECT * FROM comments ORDER BY comment_id")])

    def csv_rows(self, path):
        with path.open(encoding="utf-8-sig", newline="") as f:
            return list(csv.DictReader(f))

    def remove_time_projections_to_simulate_legacy_store(self):
        notes, comments = self.rows()
        with self.store._session() as db:
            for table, id_key, rows in (("notes", "note_id", notes), ("comments", "comment_id", comments)):
                for row in rows:
                    payload = json.loads(row["payload_json"])
                    for key in TIME_KEYS:
                        payload.pop(key, None)
                    db.execute(f"UPDATE {table} SET payload_json=? WHERE {id_key}=?",
                               (json.dumps(payload, ensure_ascii=False), row[id_key]))
        for path, defaults, columns in ((self.notes_path, NOTE_CSV_HEADERS, NOTE_TIME_HEADERS),
                                       (self.comments_path, COMMENT_CSV_HEADERS, COMMENT_TIME_HEADERS)):
            headers, rows = self.store._read_csv_table(path, defaults)
            self.store._replace_csv_table(path, [h for h in headers if h not in columns], rows, "test-legacy")
        for note in notes:
            folder = Path(note["media_dir"])
            for name in ("note.json", "comments.json"):
                path = folder / name
                value = json.loads(path.read_text(encoding="utf-8"))
                for obj in value if isinstance(value, list) else [value]:
                    for key in TIME_KEYS:
                        obj.pop(key, None)
                path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")

    def snapshot(self):
        notes, comments = self.rows()
        files = {str(path.relative_to(self.root)): path.read_bytes()
                 for row in notes for path in Path(row["media_dir"]).iterdir() if path.is_file()}
        return notes, comments, self.notes_path.read_bytes(), self.comments_path.read_bytes(), files

    def query(self, **payload):
        schema = self.store.data_overview_schema()
        self.assertTrue(schema["queryReady"], schema["health"].get("issues"))
        return self.store.query_data_overview({"dataset": "comments", "snapshotToken": schema["snapshotToken"],
            "fields": ["comment_id", "published_at", "published_at_raw"], "pageSize": 100, **payload})

    def test_collect_writes_same_time_to_csv_database_and_materials(self):
        self.pull()
        notes, comments = self.rows()
        note_meta = json.loads(notes[0]["payload_json"])
        note_csv = self.csv_rows(self.notes_path)[0]
        self.assertEqual("2026-09-03 12:30:00", note_csv["发布时间（标准）"])
        self.assertEqual("3小时前", note_csv["发布时间"])
        self.assertEqual(note_meta["publishedTime"], json.loads(
            (Path(notes[0]["media_dir"]) / "note.json").read_text(encoding="utf-8"))["publishedTime"])
        csv_by_id = {row["笔记评论ID"]: row for row in self.csv_rows(self.comments_path)}
        material = {row["commentId"]: row for row in json.loads(
            (Path(notes[0]["media_dir"]) / "comments.json").read_text(encoding="utf-8"))}
        for row in comments:
            metadata = json.loads(row["payload_json"])["publishedTime"]
            self.assertEqual(metadata, material[row["comment_id"]]["publishedTime"])
            self.assertEqual(metadata["value"], csv_by_id[row["comment_id"]]["评论时间（标准）"])
            self.assertEqual(row["published_at"], csv_by_id[row["comment_id"]]["评论时间"])
        self.store._verify_note_store_consistency(notes[0]["note_id"], notes[0]["media_dir"], verify_fields=True)

    def test_historical_migration_uses_actual_collection_not_import_clock_and_is_idempotent(self):
        self.pull(observed="2026-01-01T01:00:00+08:00")
        self.remove_time_projections_to_simulate_legacy_store()
        with self.store._session() as db:
            db.execute("UPDATE notes SET last_seen_at='2026-09-03T15:30:00+08:00'")
        before_notes, before_comments = self.rows()
        result = self.store.normalize_publication_storage()
        self.assertTrue(result["consistencyVerified"])
        self.assertEqual(1, result["updatedNotes"])
        self.assertEqual("2025-12-31 22:00:00", self.csv_rows(self.notes_path)[0]["发布时间（标准）"])
        dates = {row["笔记评论ID"]: row["评论时间（标准）"] for row in self.csv_rows(self.comments_path)}
        self.assertEqual("2025-12-31 23:11:00", dates["time-root-001"])
        self.assertEqual("2025-07-16", dates["time-reply-001"])
        after_notes, after_comments = self.rows()
        for original, updated in zip(before_notes + before_comments, after_notes + after_comments):
            self.assertEqual({k: v for k, v in original.items() if k != "payload_json"},
                             {k: v for k, v in updated.items() if k != "payload_json"})
        first = self.snapshot()
        self.assertEqual(0, self.store.normalize_publication_storage()["updatedNotes"])
        self.assertEqual(first, self.snapshot())

    def test_import_and_schema_reload_keep_same_time_and_comment_id(self):
        self.pull()
        before = {row["comment_id"]: (row["published_at"], json.loads(row["payload_json"])["publishedTime"])
                  for row in self.rows()[1]}
        self.store.seed_from_xlsx(self.notes_path)
        self.query()
        after = {row["comment_id"]: (row["published_at"], json.loads(row["payload_json"])["publishedTime"])
                 for row in self.rows()[1]}
        self.assertEqual(before, after)

    def test_legacy_image_only_comment_is_never_dropped_by_time_backfill(self):
        self.pull()
        self.remove_time_projections_to_simulate_legacy_store()
        with self.store._session() as db:
            row = db.execute("SELECT payload_json FROM comments WHERE comment_id='time-reply-001'").fetchone()
            payload = json.loads(row[0])
            payload["content"] = ""
            payload["imageUrls"] = ["https://example.invalid/comment.jpg"]
            db.execute("UPDATE comments SET content='',payload_json=? WHERE comment_id='time-reply-001'",
                       (json.dumps(payload),))
        headers, rows = self.store._read_csv_table(self.comments_path, COMMENT_CSV_HEADERS)
        next(row for row in rows if row["笔记评论ID"] == "time-reply-001")["评论内容"] = ""
        self.store._replace_csv_table(self.comments_path, headers, rows, "image-only")
        notes, _ = self.rows()
        path = Path(notes[0]["media_dir"]) / "comments.json"
        items = json.loads(path.read_text(encoding="utf-8"))
        item = next(row for row in items if row["commentId"] == "time-reply-001")
        item["content"] = ""
        item["imageUrls"] = payload["imageUrls"]
        path.write_text(json.dumps(items), encoding="utf-8")
        self.store.normalize_publication_storage()
        material = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(2, len(material))
        image_only = next(row for row in material if row["commentId"] == "time-reply-001")
        self.assertEqual("", image_only["content"])
        self.assertEqual("2026-07-16", image_only["publishedTime"]["value"])
        self.assertFalse(image_only["isDeleted"])
        projected = self.store._enrich_comment_time_fields(notes[0]["note_id"], material)
        self.assertEqual([row["commentId"] for row in material], [row["commentId"] for row in projected])
        self.store._verify_note_store_consistency(notes[0]["note_id"], notes[0]["media_dir"], verify_fields=True)

    def test_sort_orders_actual_dates_and_unknowns_last_not_raw_text(self):
        rows = [
            {"commentId": "sort-old", "publishedAt": "2025-12-04四川"},
            {"commentId": "sort-mid", "publishedAt": "07-16浙江"},
            {"commentId": "sort-new", "publishedAt": "昨天23:11上海"},
            {"commentId": "sort-now", "publishedAt": "3小时之前"},
            {"commentId": "sort-unknown", "publishedAt": "未显示"},
        ]
        self.pull(comments=[{**r, "author": r["commentId"], "content": r["commentId"]} for r in rows])
        ascending = self.query(sort=[{"field": "published_at", "direction": "asc"}], groupThreads=False)
        descending = self.query(sort=[{"field": "published_at", "direction": "desc"}], groupThreads=False)
        self.assertEqual([r["commentId"] for r in rows], [r["comment_id"] for r in ascending["rows"]])
        self.assertEqual(["sort-now", "sort-new", "sort-mid", "sort-old", "sort-unknown"],
                         [r["comment_id"] for r in descending["rows"]])
        filtered = self.query(filter={"children": [{"field": "published_at", "operator": "eq", "value": "2026-09-02"}]})
        self.assertEqual(["sort-new"], [r["comment_id"] for r in filtered["rows"]])

    def test_time_sort_is_global_even_with_legacy_grouping_enabled(self):
        rows = [
            {"commentId": "thread-a", "publishedAt": "2025-01-01"},
            {"commentId": "thread-b", "publishedAt": "2026-01-01"},
            {"commentId": "reply-a", "parentCommentId": "thread-a", "commentLevel": 2, "publishedAt": "今天14:00"},
            {"commentId": "reply-b", "parentCommentId": "thread-b", "commentLevel": 2, "publishedAt": "07-16浙江"},
        ]
        self.pull(comments=[{**r, "author": r["commentId"], "content": r["commentId"]} for r in rows])
        sort = [{"field": "published_at", "direction": "desc"}]
        grouped = self.query(sort=sort, groupThreads=True)
        self.assertEqual(["reply-a", "reply-b", "thread-b", "thread-a"], [r["comment_id"] for r in grouped["rows"]])
        global_rows = self.query(sort=sort, groupThreads=False)
        self.assertEqual(["reply-a", "reply-b", "thread-b", "thread-a"], [r["comment_id"] for r in global_rows["rows"]])

    def test_default_comment_order_and_pagination_use_publication_not_capture(self):
        comments = [
            {"commentId": "date-c-old", "publishedAt": "2025-12-04"},
            {"commentId": "date-c-new", "publishedAt": "2026-09-03"},
            {"commentId": "date-c-mid", "publishedAt": "07-16浙江"},
            {"commentId": "date-c-same", "publishedAt": "2026-09-03"},
            {"commentId": "date-c-unknown", "publishedAt": "未显示"},
        ]
        self.pull(comments=[{**r, "author": r["commentId"], "content": r["commentId"]} for r in comments])
        expected = ["date-c-new", "date-c-same", "date-c-mid", "date-c-old", "date-c-unknown"]
        for sort in (None, [], [{"field": "published_at", "direction": "desc"}]):
            rows = [row["comment_id"] for page in (1, 2, 3)
                    for row in self.query(sort=sort, groupThreads=True, pageSize=2, page=page)["rows"]]
            self.assertEqual(expected, rows)
        self.assertEqual(["date-c-old", "date-c-mid", "date-c-new", "date-c-same", "date-c-unknown"],
            [row["comment_id"] for row in self.query(sort=[{"field":"published_at","direction":"asc"}], groupThreads=True)["rows"]])

    def test_default_note_order_uses_publication_and_places_unknown_last(self):
        for ident, raw in [("date-a-old", "2025-12-04"), ("date-b-new", "2026-09-03"),
                           ("date-c-mid", "07-16浙江"), ("date-d-unknown", "未显示")]:
            self.pull(note_id=ident, raw=raw, comments=[])
        for sort, expected in [(None, ["date-b-new", "date-c-mid", "date-a-old", "date-d-unknown"]),
             ([{"field":"source_published_at","direction":"asc"}], ["date-a-old", "date-c-mid", "date-b-new", "date-d-unknown"])]:
            rows = [row["note_id"] for page in (1, 2)
                    for row in self.query(dataset="notes", fields=["note_id", "source_published_at"],
                                          sort=sort, pageSize=2, page=page)["rows"]]
            self.assertEqual(expected, rows)

    def test_edited_post_can_filter_and_sort_both_publication_and_update_columns(self):
        self.pull(raw="编辑于7天前 广东", comments=[])
        rows = self.query(dataset="notes", fields=["note_id", "source_published_at", "source_updated_at", "source_published_at_status"],
                          filter={"children": [{"field": "source_updated_at", "operator": "eq", "value": "2026-08-27"}]})
        self.assertEqual(1, rows["total"])
        self.assertEqual("2026-08-27", rows["rows"][0]["source_published_at"])
        self.assertEqual("2026-08-27", rows["rows"][0]["source_updated_at"])
        self.assertEqual("estimated_from_edit", rows["rows"][0]["source_published_at_status"])
        self.pull(note_id="time-note-002", raw="2025-12-04", comments=[])
        result = self.query(dataset="notes", fields=["note_id", "source_published_at"],
                            sort=[{"field": "source_published_at", "direction": "desc"}])
        self.assertEqual(["time-note-001", "time-note-002"], [row["note_id"] for row in result["rows"]])

    def test_same_edited_label_is_recalculated_on_each_fresh_sync_including_older_clients(self):
        note, comments = self.pull(raw="编辑于7天前 广东")
        legacy_note = {k: v for k, v in note.items() if k not in TIME_KEYS}
        next_capture = "2026-09-04T08:20:00+08:00"
        with patch("server.now_iso", return_value=next_capture):
            result = self.store.sync_comment_snapshot({
                "noteId": note["noteId"], "note": legacy_note, "comments": comments,
                "status": "likely_complete", "expectedCount": len(comments),
                "collectionEvidence": COMPLETE, "collectedAt": next_capture,
            })
        self.assertTrue(result["consistencyVerified"])
        row = self.csv_rows(self.notes_path)[0]
        self.assertEqual("2026-08-28", row["发布时间（标准）"])
        self.assertEqual(next_capture, row["时间采集基准"])
        with patch("server.now_iso", return_value="2026-10-01T08:00:00+08:00"):
            self.query(dataset="notes")
        self.assertEqual("2026-08-28", self.csv_rows(self.notes_path)[0]["发布时间（标准）"])
        later_capture = "2026-09-05T09:00:00+08:00"
        with patch("server.now_iso", return_value=later_capture):
            result = self.store.pull_to_excel({"note": legacy_note, "comments": comments,
                "expectedCount": len(comments), "commentStatus": "likely_complete", "collectionEvidence": COMPLETE})
        self.assertTrue(result["consistencyVerified"])
        self.assertEqual("2026-08-29", self.csv_rows(self.notes_path)[0]["发布时间（标准）"])
        self.assertEqual(2, len(self.rows()[1]))

    def test_v1_edited_only_cache_migrates_using_its_recorded_capture_and_keeps_source(self):
        self.pull(raw="编辑于7天前 广东", comments=[])
        note = self.rows()[0][0]
        legacy = json.loads(note["payload_json"])
        legacy["publishedTime"].update({"value": "", "timestamp": None, "precision": "unknown",
                                        "status": "edited_only", "normalizationVersion": 1})
        legacy["publishedTime"].pop("basis", None)
        legacy["updatedTime"]["normalizationVersion"] = 1
        with self.store._session() as db:
            db.execute("UPDATE notes SET payload_json=? WHERE note_id=?", (json.dumps(legacy), note["note_id"]))
        headers, rows = self.store._read_csv_table(self.notes_path, NOTE_CSV_HEADERS)
        rows[0].update(csv_time_fields(legacy))
        self.store._replace_csv_table(self.notes_path, headers, rows, "legacy-edit-only")
        self.store._refresh_material_snapshot_for_note(note["note_id"])
        original = self.csv_rows(self.notes_path)[0]
        with patch("server.now_iso", return_value="2026-10-01T10:00:00+08:00"):
            migrated = self.store.normalize_publication_storage()
        updated = self.csv_rows(self.notes_path)[0]
        self.assertEqual(1, migrated["updatedNotes"])
        self.assertEqual("2026-08-27", updated["发布时间（标准）"])
        self.assertEqual(original["时间采集基准"], updated["时间采集基准"])
        self.assertEqual(original["发布时间"], updated["发布时间"])
        self.assertIn("编辑时间推算", updated["发布时间说明"])
        self.assertEqual(0, self.store.normalize_publication_storage()["updatedNotes"])
        self.store._verify_note_store_consistency(note["note_id"], note["media_dir"], verify_fields=True)

    def test_migration_does_not_conceal_material_drift(self):
        self.pull()
        self.remove_time_projections_to_simulate_legacy_store()
        notes, _ = self.rows()
        path = Path(notes[0]["media_dir"]) / "note.json"
        value = json.loads(path.read_text(encoding="utf-8"))
        value["content"] = "独立修改的素材，不允许被覆盖"
        path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
        before = self.snapshot()
        schema = self.store.data_overview_schema()
        self.assertFalse(schema["queryReady"])
        self.assertEqual(before, self.snapshot())

    def test_time_field_drift_blocks_query_even_without_a_material_folder(self):
        self.pull()
        with self.store._session() as db:
            db.execute("UPDATE notes SET media_dir='',media_file_count=0")
        for path, defaults, id_key, value_key in (
            (self.notes_path, NOTE_CSV_HEADERS, "笔记ID", "发布时间（标准）"),
            (self.comments_path, COMMENT_CSV_HEADERS, "笔记评论ID", "评论时间（标准）"),
        ):
            original = path.read_bytes()
            headers, rows = self.store._read_csv_table(path, defaults)
            rows[0][value_key] = "1999-01-01"
            self.store._replace_csv_table(path, headers, rows, "drift-test")
            before = path.read_bytes()
            schema = self.store.data_overview_schema()
            self.assertFalse(schema["queryReady"], id_key)
            self.assertEqual(before, path.read_bytes(), "Schema must not overwrite an inconsistent source")
            path.write_bytes(original)

    def test_failed_multi_note_backfill_rolls_back_every_store(self):
        self.pull(note_id="time-note-001")
        self.pull(note_id="time-note-002", comments=[])
        self.remove_time_projections_to_simulate_legacy_store()
        before = self.snapshot()
        original = self.store._refresh_material_snapshot_for_note
        calls = []
        def fail_second(note_id):
            calls.append(note_id)
            if len(calls) == 2:
                raise OSError("模拟第二个素材写入失败")
            return original(note_id)
        with patch.object(self.store, "_refresh_material_snapshot_for_note", side_effect=fail_second):
            with self.assertRaises(OSError):
                self.store.normalize_publication_storage()
        self.assertEqual(2, len(calls))
        self.assertEqual(before, self.snapshot())

    def test_resync_additions_and_deletions_preserve_historical_time(self):
        note, comments = self.pull()
        old_times = {r["comment_id"]: json.loads(r["payload_json"])["publishedTime"] for r in self.rows()[1]}
        self.pull(comments=[comments[0], {"commentId": "new-comment", "author": "新用户", "content": "新增内容", "publishedAt": "1小时前"}])
        rows = {r["comment_id"]: r for r in self.rows()[1]}
        self.assertEqual(3, len(rows))
        self.assertEqual(1, rows["time-reply-001"]["is_deleted"])
        self.assertEqual(old_times["time-reply-001"], json.loads(rows["time-reply-001"]["payload_json"])["publishedTime"])
        self.assertEqual("2026-09-03 14:30:00", json.loads(rows["new-comment"]["payload_json"])["publishedTime"]["value"])
        csv_by_id = {r["笔记评论ID"]: r for r in self.csv_rows(self.comments_path)}
        self.assertEqual("已删除", csv_by_id["time-reply-001"]["评论状态"])
        self.store._verify_note_store_consistency(note["noteId"], self.rows()[0][0]["media_dir"], verify_fields=True)


if __name__ == "__main__":
    unittest.main()
