"""Browser-source clears versus omitted fields, using only temporary local stores.

The shared contract runs through both public entrypoints. Import the helper
module, not its TestCase, so unittest discovery does not collect its tests twice.
"""

import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import server
import test_publication_times as time_cases


SOURCE_COLUMNS = {
    "authorUrl": "用户主页url", "authorId": "博主ID",
    "likeCount": "点赞量", "collectCount": "收藏量",
    "commentCount": "评论量", "shareCount": "分享量",
    "publishedAt": "发布时间", "updatedAt": "更新时间",
    "ipLocation": "IP地址", "imageCount": "图片数量",
}
METRIC_KEYS = ("likeCount", "collectCount", "commentCount", "shareCount", "imageCount")


class _CsvSourceFixture:
    """Fixture/mixin only: deliberately not a unittest.TestCase subclass."""

    rows = time_cases.TimeStoreTests.rows
    csv_rows = time_cases.TimeStoreTests.csv_rows

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="csv-source-updates-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        original_connect = server.sqlite3.connect

        def isolated_connect(database, *args, **kwargs):
            self.assertTrue(Path(database).resolve().is_relative_to(self.root), database)
            return original_connect(database, *args, **kwargs)

        for guard in (
            patch("server.sqlite3.connect", side_effect=isolated_connect),
            patch("server.urlopen", side_effect=AssertionError("Unexpected fixture network access")),
            patch("server.now_iso", return_value=time_cases.OBSERVED),
        ):
            guard.start()
            self.addCleanup(guard.stop)
        self.store = server.MonitorStore(self.root / "fixture.sqlite3", self.root / "exports")
        self.notes_path, self.comments_path = self.store.configure_data_files(self.root / "notes.csv")
        original_paths = self.store._csv_paths
        original_folder = self.store._resolve_media_folder

        def isolated_csv_paths():
            paths = original_paths()
            for path in paths:
                self.assertTrue(path.resolve().is_relative_to(self.root), path)
            return paths

        def isolated_media_folder(note):
            path = original_folder(note)
            self.assertTrue(path.resolve().is_relative_to(self.root), path)
            return path

        for guard in (
            patch.object(self.store, "_csv_paths", side_effect=isolated_csv_paths),
            patch.object(self.store, "_resolve_media_folder", side_effect=isolated_media_folder),
        ):
            guard.start()
            self.addCleanup(guard.stop)
        self.store._ensure_seed_workbook(self.notes_path)
        self.note = {
            "noteId": "csv-source-note", "url": "https://www.xiaohongshu.com/explore/csv-source-note",
            "title": "CSV源字段测试", "content": "隔离测试正文", "author": "帖主",
            "authorUrl": "https://example.invalid/profile/post-author", "authorId": "fixture-author",
            "likeCount": 12, "collectCount": 8, "commentCount": 2, "shareCount": 3, "imageCount": 4,
            "publishedAt": "2026-09-01", "updatedAt": "2026-09-02", "ipLocation": "未显示",
            "keyword": "测试来源词", "tags": ["#测试话题"], "detailRead": True,
            "timeObservedAt": time_cases.OBSERVED, "timeReferenceSource": "capture",
        }
        self.comments = [
            self.comment("csv-source-root", "一级历史内容"),
            self.comment("csv-source-reply", "二级历史内容", "csv-source-root"),
        ]

    @staticmethod
    def comment(comment_id, content, parent=""):
        return {
            "commentId": comment_id, "author": "评论者", "content": content,
            "authorUrl": "https://example.invalid/profile/comment-author", "likeCount": 1,
            "publishedAt": "2026-09-01", "ipLocation": "浙江",
            "commentLevel": 2 if parent else 1, "parentCommentId": parent,
            "timeObservedAt": time_cases.OBSERVED, "timeReferenceSource": "capture",
        }

    def apply(self, note=None, comments=None, *, mode=None, status="likely_complete", expected=None):
        note = copy.deepcopy(self.note if note is None else note)
        comments = copy.deepcopy(self.comments if comments is None else comments)
        mode = mode or self.mode
        payload = {
            "noteId": note["noteId"], "note": note, "comments": comments,
            "expectedCount": len(comments) if expected is None else expected,
            "collectionEvidence": dict(time_cases.COMPLETE),
            "explicitEmptyVerified": not comments and status == "likely_complete",
            "collectedAt": time_cases.OBSERVED,
        }
        if mode == "pull":
            return self.store.pull_to_excel({**payload, "commentStatus": status})
        return self.store.sync_comment_snapshot({**payload, "status": status})

    def seed(self, ip="未显示", comments=None):
        self.note["ipLocation"] = ip
        result = self.apply(comments=comments, mode="pull")
        self.assert_committed(result)
        self.assert_sources({key: self.note[key] for key in SOURCE_COLUMNS})
        return result

    @staticmethod
    def csv_value(value):
        return "" if value is None else str(value)

    def assert_sources(self, expected):
        notes, _ = self.rows()
        self.assertEqual(1, len(notes))
        payload = json.loads(notes[0]["payload_json"])
        csv_notes = self.csv_rows(self.notes_path)
        self.assertEqual(1, len(csv_notes))
        material = json.loads((Path(notes[0]["media_dir"]) / "note.json").read_text(encoding="utf-8"))
        for key, value in expected.items():
            with self.subTest(source=key):
                self.assertIn(key, payload)
                self.assertEqual(value, payload[key])
                self.assertIn(key, material)
                self.assertEqual(value, material[key])
                self.assertEqual(self.csv_value(value), csv_notes[0][SOURCE_COLUMNS[key]])
        if "publishedAt" in payload:
            self.assertEqual(self.csv_value(payload["publishedAt"])[:10], csv_notes[0]["发布日期"])
        self.assertEqual(payload["publishedTime"], material["publishedTime"])
        self.assertEqual(payload["updatedTime"], material["updatedTime"])
        self.assertEqual(payload["publishedTime"]["value"], csv_notes[0]["发布时间（标准）"])
        self.assertEqual(payload["updatedTime"]["value"], csv_notes[0]["更新时间（标准）"])
        self.assertEqual(payload["ipRegion"], csv_notes[0]["帖子IP属地"])
        self.assertEqual(payload["ipRegion"], material["ipRegion"])
        if "authorUrl" in payload:
            for row in self.csv_rows(self.comments_path):
                self.assertEqual(self.csv_value(payload["authorUrl"]), row["帖子用户主页url"])
        return payload, csv_notes[0]

    def assert_committed(self, result):
        self.assertTrue(result["ok"])
        self.assertTrue(result["consistencyVerified"])
        self.assertGreater(result["consistency"]["fieldChecks"], 0)
        self.assertTrue(result["consistency"]["stateHash"])
        note = self.rows()[0][0]
        verified = self.store._verify_note_store_consistency(note["note_id"], note["media_dir"], verify_fields=True)
        self.assertTrue(verified["ok"])
        self.assertFalse(list((self.root / "exports" / ".sync_checkpoints").glob("*/checkpoint.json")))

    def assert_comments(self, expected, deleted=()):
        expected = {item["commentId"]: item for item in expected}
        deleted = set(deleted)
        notes, comments = self.rows()
        csv_comments = self.csv_rows(self.comments_path)
        material = json.loads((Path(notes[0]["media_dir"]) / "comments.json").read_text(encoding="utf-8"))
        for rows, key in ((comments, "comment_id"), (csv_comments, "笔记评论ID"), (material, "commentId")):
            self.assertEqual(len(expected), len(rows))
            self.assertEqual(set(expected), {row[key] for row in rows})
        by_csv = {row["笔记评论ID"]: row for row in csv_comments}
        by_json = {row["commentId"]: row for row in material}
        for row in comments:
            key = row["comment_id"]
            self.assertEqual(expected[key]["content"], row["content"])
            self.assertEqual(expected[key]["parentCommentId"], row["parent_comment_id"])
            self.assertEqual(key in deleted, bool(row["is_deleted"]))
            self.assertEqual(key in deleted, by_json[key]["isDeleted"])
            self.assertEqual("已删除" if key in deleted else "存在", by_csv[key]["评论状态"])

    def snapshot(self):
        # Logical DB rows plus byte-for-byte CSV/material files; SQLite journal
        # bytes and AUTOINCREMENT counters are not business rollback state.
        state = time_cases.TimeStoreTests.snapshot(self)
        with self.store._session() as db:
            auxiliary = {
                table: [dict(row) for row in db.execute(f"SELECT * FROM {table} ORDER BY {key}")]
                for table, key in (("comment_collection_jobs", "id"), ("watchlist", "note_id"),
                                   ("change_events", "id"), ("sync_runs", "id"))
            }
        return state, auxiliary

    def reject_drift_and_assert_rollback(self, note, comments, *, material=False):
        before = self.snapshot()
        refresh = self.store._refresh_material_snapshot_for_note

        def corrupt_after_real_write(note_id):
            folder = refresh(note_id)
            self.assertEqual(note["ipLocation"], json.loads(self.rows()[0][0]["payload_json"])["ipLocation"])
            if material:
                path = Path(folder) / "note.json"
                value = json.loads(path.read_text(encoding="utf-8"))
                value["ipRegion"] = "海南"
                path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
            else:
                headers, rows = self.store._read_csv_table(self.notes_path, server.NOTE_CSV_HEADERS)
                rows[0]["IP地址"] = "海南"
                self.store._replace_csv_table(self.notes_path, headers, rows, "fixture-source-drift")
            return folder

        label = r"素材\.ipRegion" if material else r"帖子\.IP地址"
        # Leave the real verifier and rollback wrapper in place, corrupting only
        # an isolated artifact immediately before their normal verification.
        with patch.object(self.store, "_refresh_material_snapshot_for_note", side_effect=corrupt_after_real_write) as hook:
            with self.assertRaisesRegex(ValueError, "本地字段一致性校验失败.*" + label):
                self.apply(note, comments)
            hook.assert_called_once_with(self.note["noteId"])
        self.assertEqual(before, self.snapshot())
        self.assertIsNone(self.store._active_csv_checkpoint)
        self.assertFalse(list((self.root / "exports" / ".sync_checkpoints").glob("*/checkpoint.json")))


class _SourceUpdateContract(_CsvSourceFixture):
    def test_not_displayed_ip_is_explicitly_cleared(self):
        self.seed()
        self.assert_committed(self.apply({**self.note, "ipLocation": ""}))
        self.assert_sources({"ipLocation": ""})
        self.assert_comments(self.comments)

    def test_region_is_explicitly_cleared(self):
        self.seed(ip="上海")
        self.assert_committed(self.apply({**self.note, "ipLocation": ""}))
        payload, _ = self.assert_sources({"ipLocation": ""})
        self.assertEqual("", payload["ipRegion"])

    def test_region_is_replaced(self):
        self.seed(ip="上海")
        self.assert_committed(self.apply({**self.note, "ipLocation": "广东"}))
        payload, _ = self.assert_sources({"ipLocation": "广东"})
        self.assertEqual("广东", payload["ipRegion"])

    def test_omitted_ip_keeps_the_existing_region(self):
        self.seed(ip="上海")
        note = {key: value for key, value in self.note.items() if key != "ipLocation"}
        self.assertNotIn("ipLocation", note)
        self.assert_committed(self.apply(note))
        payload, _ = self.assert_sources({"ipLocation": "上海"})
        self.assertEqual("上海", payload["ipRegion"])

    def test_omitted_source_fields_keep_existing_csv_db_and_json_values(self):
        self.seed(ip="上海")
        note = {key: value for key, value in self.note.items() if key not in SOURCE_COLUMNS}
        self.assertFalse(set(note).intersection(SOURCE_COLUMNS))
        self.assert_committed(self.apply(note))
        self.assert_sources({key: self.note[key] for key in SOURCE_COLUMNS})

    def test_empty_author_identity_clears_note_and_comment_post_author_links(self):
        self.seed()
        blanks = {"authorUrl": "", "authorId": ""}
        self.assert_committed(self.apply({**self.note, **blanks}))
        self.assert_sources(blanks)
        for row in self.csv_rows(self.comments_path):
            self.assertEqual("", row["帖子用户主页url"])
            self.assertEqual(self.comments[0]["authorUrl"], row["评论用户主页url"])

    def test_empty_dates_clear_raw_standard_and_derived_publication_date(self):
        self.seed()
        blanks = {"publishedAt": "", "updatedAt": ""}
        self.assert_committed(self.apply({**self.note, **blanks}))
        payload, row = self.assert_sources(blanks)
        self.assertEqual("", row["发布日期"])
        self.assertEqual("", payload["publishedTime"]["value"])
        self.assertEqual("", payload["updatedTime"]["value"])

    def test_empty_metrics_match_csv_database_and_material_json(self):
        self.seed()
        blanks = dict.fromkeys(METRIC_KEYS, "")
        self.assert_committed(self.apply({**self.note, **blanks}))
        self.assert_sources(blanks)

    def test_explicit_null_source_values_are_blank_cells_not_missing_fields(self):
        self.seed(ip="上海")
        nulls = dict.fromkeys(SOURCE_COLUMNS, None)
        self.assert_committed(self.apply({**self.note, **nulls}))
        self.assert_sources(nulls)

    def test_numeric_zero_metrics_are_written_instead_of_preserving_old_values(self):
        self.seed()
        zeroes = dict.fromkeys(METRIC_KEYS, 0)
        self.assert_committed(self.apply({**self.note, **zeroes}))
        self.assert_sources(zeroes)

    def test_zero_comment_note_can_clear_ip_without_creating_comment_rows(self):
        self.seed(comments=[])
        result = self.apply({**self.note, "ipLocation": ""}, [])
        self.assert_committed(result)
        self.assertEqual("synced", result["pullStatus"])
        self.assertEqual("likely_complete", result["commentStatus"])
        self.assertEqual(0, result["currentCount"])
        self.assert_sources({"ipLocation": ""})
        self.assert_comments([])

    def test_partial_clear_preserves_unseen_history_and_clears_its_post_author_link(self):
        self.seed(ip="上海")
        blanks = {"ipLocation": "", "authorUrl": ""}
        result = self.apply({**self.note, **blanks}, self.comments[:1], status="partial", expected=2)
        self.assert_committed(result)
        self.assertEqual("partial", result["commentStatus"])
        self.assertEqual("partial", result["pullStatus"])
        self.assertFalse(result["canPrune"])
        self.assertEqual(0, result["commentsMarkedDeleted" if self.mode == "sync" else "commentMarkedDeleted"])
        self.assert_sources(blanks)
        self.assert_comments(self.comments)

    def test_verified_empty_snapshot_retains_soft_deleted_history_while_clearing_sources(self):
        self.seed(ip="上海")
        blanks = {"ipLocation": "", "authorUrl": ""}
        result = self.apply({**self.note, **blanks}, [])
        self.assert_committed(result)
        self.assertEqual("synced", result["pullStatus"])
        self.assertTrue(result["canPrune"])
        self.assert_sources(blanks)
        self.assert_comments(self.comments, deleted=[item["commentId"] for item in self.comments])

    def test_source_clears_preserve_dedicated_business_columns_and_manual_decisions(self):
        self.seed()
        columns = ("manual_negative", "review_status", "review_note", "semantic_analysis_count",
                   "analysis_is_negative", "negative_type", "negative_subtype")
        with self.store._session() as db:
            for table, sentiment in (("notes", "post_sentiment"), ("comments", "sentiment")):
                db.execute(f"""UPDATE {table} SET {sentiment}='positive', manual_negative=1,
                    review_status='resolved', review_note='保留人工结论', semantic_analysis_count=7,
                    analysis_is_negative='否', negative_type='人工类型', negative_subtype='人工子类型'""")
        self.store._normalize_csv_cross_store_fields()
        self.store._refresh_material_snapshot_for_note(self.note["noteId"])
        business_before = [[tuple(row[key] for key in columns) for row in rows] for rows in self.rows()]
        blanks = dict.fromkeys(SOURCE_COLUMNS, "")
        ignored_business_blanks = dict.fromkeys(
            ("postSentiment", "semanticAnalysisCount", "analysisIsNegative", "negativeType", "negativeSubtype"), "")
        self.assert_committed(self.apply({**self.note, **blanks, **ignored_business_blanks}))
        self.assert_sources(blanks)
        self.assertEqual(business_before, [[tuple(row[key] for key in columns) for row in rows] for rows in self.rows()])
        notes, comments = self.rows()
        self.assertEqual("positive", notes[0]["post_sentiment"])
        self.assertTrue(all(row["sentiment"] == "positive" for row in comments))
        for row in self.csv_rows(self.notes_path) + self.csv_rows(self.comments_path):
            self.assertEqual("7", row["语义分析次数"])
            self.assertEqual("人工类型", row["差评类型"])

    def test_real_csv_field_drift_fails_closed_and_rolls_back_all_stores(self):
        self.seed(ip="上海")
        fresh = self.comment("csv-source-new", "本次新增评论")
        self.reject_drift_and_assert_rollback({**self.note, "ipLocation": "广东"}, [self.comments[0], fresh])

    def test_real_material_field_drift_fails_closed_and_rolls_back_all_stores(self):
        self.seed(ip="上海")
        self.reject_drift_and_assert_rollback({**self.note, "ipLocation": "广东"}, self.comments[:1], material=True)

    def test_failed_then_successful_retries_never_duplicate_comments_or_csv_rows(self):
        self.seed()
        updated = {**self.note, "ipLocation": ""}
        comments = self.comments + [self.comment("csv-source-new", "重试新增评论")]
        for attempt in range(2):
            with self.subTest(failed_attempt=attempt):
                self.reject_drift_and_assert_rollback(updated, comments)
                self.assert_comments(self.comments)
        for attempt in range(3):
            with self.subTest(successful_attempt=attempt):
                result = self.apply(updated, comments)
                self.assert_committed(result)
                self.assert_sources({"ipLocation": ""})
                self.assert_comments(comments)
                self.assertEqual(1 if attempt == 0 else 0, result["excelAdded" if self.mode == "sync" else "commentAdded"])


class CsvSourcePullTests(_SourceUpdateContract, unittest.TestCase):
    mode = "pull"


class CsvSourceSyncTests(_SourceUpdateContract, unittest.TestCase):
    mode = "sync"


class CsvSourceWriterTests(_CsvSourceFixture, unittest.TestCase):
    def test_sparse_writer_input_does_not_clear_absent_source_columns(self):
        self.seed(ip="上海")
        before = self.csv_rows(self.notes_path)[0]
        note_row = self.rows()[0][0]
        # Public callers merge stored payloads. Exercise the writer directly as
        # well, so that blanket clearing of absent keys cannot hide behind that merge.
        note = self.store._material_note_from_db(note_row)
        for key in SOURCE_COLUMNS:
            note.pop(key)
        result = self.store._sync_pull_to_xlsx(note, [], {"folder": note_row["media_dir"]})
        self.assertFalse(result["postAdded"])
        after = self.csv_rows(self.notes_path)[0]
        for column in (*SOURCE_COLUMNS.values(), "发布日期"):
            self.assertEqual(before[column], after[column], column)
        self.assert_comments(self.comments)
        self.assert_sources({key: self.note[key] for key in SOURCE_COLUMNS})


if __name__ == "__main__":
    unittest.main()
