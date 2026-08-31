import csv
import json
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from data_relationships import repair_relationship_rows
from server import COMMENT_CSV_HEADERS, NOTE_CSV_HEADERS, MonitorStore, _decode_powershell_output, audit_reply_candidate, classify_reply_context, replace_with_retry, valid_note_id


class MediaHandler(BaseHTTPRequestHandler):
    counts = {"image": 0, "video": 0}

    def do_GET(self):
        if self.path.startswith("/post.jpg"):
            self.counts["image"] += 1
            body, content_type = b"post-image", "image/jpeg"
        elif self.path.startswith("/post.mp4"):
            self.counts["video"] += 1
            body, content_type = b"video-data" * 128, "video/mp4"
        else:
            self.send_response(404); self.end_headers(); return
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        return


class FakeAI:
    def complete_json(self, _settings, _messages):
        return {
            "overview": "帖子介绍产品使用体验，评论整体中性。", "sentiment": "neutral",
            "key_points": ["正文核心"], "comment_consensus": ["评论共识"],
            "disagreements": [], "risks": ["暂无明显风险"], "actions": ["持续观察"],
            "representative_comments": ["代表评论"],
        }


class FakeReplyAI:
    def complete_json(self, _settings, _messages):
        return {"need": "想确认价格", "candidates": [
            {"reply": "理解你对价格的顾虑。你发下产品全名，我们按门店公示价帮你核对。", "style": "直答", "why": "接住价格疑问"},
            {"reply": "确实要先把价格问清楚。方便的话发张包装图，我们帮你确认具体款式。", "style": "共情", "why": "先确认产品"},
            {"reply": "价格会跟系列和容量有关。告诉我们产品名和门店，我们再核对当日标价。", "style": "稳妥", "why": "避免编价"}
        ], "risk_notes": []}


class V0183Tests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.store = MonitorStore(root / "monitor.sqlite3", root / "exports", ai_client=FakeAI())
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), MediaHandler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        MediaHandler.counts = {"image": 0, "video": 0}
        self.base = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.tmp.cleanup()

    def _configure_csv(self, name: str = "master"):
        notes_path, comments_path = self.store.configure_data_files(Path(self.tmp.name) / f"{name}_笔记总表.csv")
        self.store._ensure_seed_workbook(notes_path)
        return notes_path, comments_path

    def _csv_rows(self, path: Path, headers: list[str]):
        return self.store._read_csv_table(path, headers)[1]

    def test_media_is_idempotent_and_only_repairs_missing_video(self):
        note = {"noteId": "abcdef123456", "title": "视频帖子", "content": "正文",
                "imageUrls": [self.base + "/post.jpg"], "videoUrls": [self.base + "/post.mp4"]}
        first = self.store._download_note_media(note)
        self.assertEqual((1, 1), (first["imageCount"], first["videoCount"]))
        self.store._download_note_media(note)
        self.assertEqual({"image": 1, "video": 1}, MediaHandler.counts)
        Path(first["folder"], "video-01.mp4").unlink()
        repaired = self.store._download_note_media(note)
        self.assertEqual({"image": 1, "video": 2}, MediaHandler.counts)
        self.assertEqual(1, repaired["downloadedCount"])
        self.assertEqual(1, repaired["skippedCount"])

    def test_title_only_scan_prefers_existing_note_id_over_changed_title(self):
        timestamp = "2026-08-21T12:00:00+08:00"
        with self.store._session() as db:
            db.execute("""
                INSERT INTO notes
                (note_id, url, title, first_seen_at, last_seen_at, status, is_relevant, source,
                 title_key, content_key, title_content_key, pull_status)
                VALUES (?, ?, ?, ?, ?, 'known', 1, 'existing_xlsx', ?, '', '', 'synced')
            """, ("existing123456", "https://www.xiaohongshu.com/explore/existing123456",
                  "Excel保存的旧标题", timestamp, timestamp, "excel保存的旧标题"))
        result = self.store.scan({
            "titleOnly": True, "returnAllStatuses": True, "keyword": "samplebrand",
            "notes": [{"noteId": "existing123456", "url": "https://www.xiaohongshu.com/explore/existing123456",
                       "title": "小红书当前展示的新标题", "content": ""}]
        })
        self.assertTrue(result["ok"])
        self.assertEqual(1, len(result["statuses"]))
        self.assertTrue(result["statuses"][0]["inExcel"])
        self.assertEqual("known", result["statuses"][0]["status"])
        self.assertEqual("帖子ID", result["statuses"][0]["matchLabel"])

    def test_same_title_different_note_id_is_never_marked_as_pulled(self):
        timestamp = "2026-08-27T15:00:00+08:00"
        original_payload = {
            "noteId": "pulledtitle123", "url": "https://www.xiaohongshu.com/explore/pulledtitle123",
            "title": "samplebrand", "author": "已拉取作者", "content": "已拉取正文",
        }
        with self.store._session() as db:
            db.execute("""
                INSERT INTO notes
                (note_id,url,title,author,content,first_seen_at,last_seen_at,status,is_relevant,source,
                 title_key,content_key,title_content_key,pull_status,payload_json)
                VALUES(?,?,?,?,?,?,?,'known',1,'existing_xlsx','samplebrand','已拉取正文','samplebrand已拉取正文','synced',?)
            """, ("pulledtitle123", original_payload["url"], "samplebrand", "已拉取作者", "已拉取正文",
                  timestamp, timestamp, json.dumps(original_payload, ensure_ascii=False)))

        result = self.store.scan({
            "titleOnly": True, "returnAllStatuses": True, "keyword": "samplebrand",
            "notes": [{"noteId": "deletedtitle456", "url": "https://www.xiaohongshu.com/explore/deletedtitle456",
                       "title": "samplebrand", "author": "另一位作者", "content": ""}]
        })

        status = result["statuses"][0]
        self.assertEqual("deletedtitle456", status["noteId"])
        self.assertEqual("deletedtitle456", status["matchedNoteId"])
        self.assertFalse(status["inExcel"])
        self.assertEqual("not_started", status["pullStatus"])
        self.assertEqual("none", status["matchedBy"])
        with self.store._session() as db:
            stored = json.loads(db.execute(
                "SELECT payload_json FROM notes WHERE note_id='pulledtitle123'"
            ).fetchone()[0])
        self.assertEqual("pulledtitle123", stored["noteId"])
        self.assertEqual("已拉取作者", stored["author"])

    def test_pull_and_csv_sync_never_deduplicate_different_note_ids_by_text(self):
        notes_path, _comments_path = self._configure_csv("strict-identity")
        first = {"noteId": "strictnote123", "url": "https://www.xiaohongshu.com/explore/strictnote123",
                 "title": "完全相同标题", "content": "完全相同正文", "detailRead": True}
        second = {**first, "noteId": "strictnote456",
                  "url": "https://www.xiaohongshu.com/explore/strictnote456"}
        self.store._sync_pull_to_xlsx(first, [], {})
        self.store._sync_pull_to_xlsx(second, [], {})
        rows = self._csv_rows(notes_path, NOTE_CSV_HEADERS)
        self.assertEqual({"strictnote123", "strictnote456"}, {row["笔记ID"] for row in rows})
        self.store.confirm(first)
        resolved, matched_by = self.store._resolve_pull_identity(second)
        self.assertEqual("strictnote456", resolved)
        self.assertEqual("new", matched_by)

    def test_placeholder_note_ids_are_rejected(self):
        for value in ("undefined", "null", "None", "UNKNOWN", "nan"):
            self.assertEqual("", valid_note_id(value))

    def test_startup_repairs_and_archives_cross_note_payload_identity(self):
        timestamp = "2026-08-27T15:00:00+08:00"
        with self.store._session() as db:
            db.execute("""
                INSERT INTO notes(note_id,url,title,author,content,first_seen_at,last_seen_at,payload_json)
                VALUES(?,?,?,?,?,?,?,?)
            """, ("payloadnote123", "https://www.xiaohongshu.com/explore/payloadnote123",
                  "正确标题", "正确作者", "正确正文", timestamp, timestamp,
                  json.dumps({"noteId": "othernote456", "url": "https://www.xiaohongshu.com/explore/othernote456",
                              "title": "错误标题"}, ensure_ascii=False)))
        repaired_store = MonitorStore(self.store.db_path, self.store.export_dir, ai_client=FakeAI())
        with repaired_store._session() as db:
            payload = json.loads(db.execute(
                "SELECT payload_json FROM notes WHERE note_id='payloadnote123'"
            ).fetchone()[0])
            archived = db.execute(
                "SELECT COUNT(*) FROM data_repair_archive WHERE repair_id LIKE 'v0.25.1-note-payload-identity%'"
            ).fetchone()[0]
        self.assertEqual("payloadnote123", payload["noteId"])
        self.assertIn("/payloadnote123", payload["url"])
        self.assertEqual("正确标题", payload["title"])
        self.assertGreaterEqual(archived, 1)

    def test_pulled_note_status_hydrates_artifacts_and_comments(self):
        root = self.store.export_dir.parent
        media_dir = root / "materials" / "pulled123456"
        media_dir.mkdir(parents=True)
        (media_dir / "image-01.jpg").write_bytes(b"image")
        excel_path = root / "master.xlsx"
        timestamp = "2026-08-24T12:00:00+08:00"
        with self.store._session() as db:
            db.execute("""
                INSERT INTO notes
                (note_id, url, title, author, content, first_seen_at, last_seen_at, status,
                 is_relevant, source, title_key, content_key, title_content_key, pull_status,
                 media_dir, excel_sync_path, payload_json)
                VALUES (?, ?, ?, ?, ?, ?, ?, 'known', 1, 'existing_xlsx', ?, ?, '', 'synced', ?, ?, ?)
            """, ("pulled123456", "https://www.xiaohongshu.com/explore/pulled123456",
                  "已拉取帖子", "作者", "正文", timestamp, timestamp, "已拉取帖子", "正文",
                  str(media_dir), str(excel_path), json.dumps({"likeCount": 8}, ensure_ascii=False)))
            db.execute("""
                INSERT INTO comments
                (comment_id, note_id, content, author, first_seen_at, last_seen_at, payload_json)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            """, ("comment-pulled-1", "pulled123456", "本地评论", "用户", timestamp, timestamp,
                  json.dumps({"commentId": "comment-pulled-1", "content": "本地评论"}, ensure_ascii=False)))
        result = self.store.note_status("pulled123456")
        self.assertTrue(result["inExcel"])
        self.assertEqual(str(media_dir), result["mediaDir"])
        self.assertEqual(["image-01.jpg"], result["mediaFiles"])
        self.assertEqual(str(excel_path), result["excelPath"])
        self.assertEqual("pulled123456", result["note"]["noteId"])
        self.assertEqual(1, result["commentCount"])
        self.assertEqual("comment-pulled-1", result["commentRows"][0]["commentId"])

    def _seed_pulled_note_with_comments(self):
        note = {
            "noteId": "audit123456", "url": "https://www.xiaohongshu.com/explore/audit123456",
            "title": "评论变化测试", "content": "正文", "author": "博主", "detailRead": True,
        }
        self.store.confirm(note)
        old = {"commentId": "comment-old", "author": "旧用户", "content": "已经消失", "publishedAt": "08-20"}
        kept = {"commentId": "comment-kept", "author": "保留用户", "content": "仍然存在", "publishedAt": "08-21"}
        self.store.upsert_comments({
            "noteId": note["noteId"], "comments": [old, kept],
            "expectedCount": 2, "status": "likely_complete"
        })
        return note, old, kept

    def test_comment_compare_reports_new_and_confirmed_removed(self):
        note, old, kept = self._seed_pulled_note_with_comments()
        fresh = {"commentId": "comment-new", "author": "新用户", "content": "新增评论", "publishedAt": "08-24"}
        result = self.store.compare_comments({
            "noteId": note["noteId"], "comments": [kept, fresh],
            "expectedCount": 2, "status": "likely_complete"
        })
        self.assertTrue(result["hasChanges"])
        self.assertTrue(result["canPrune"])
        self.assertEqual(1, result["newCount"])
        self.assertEqual(1, result["removedCount"])
        self.assertEqual("comment-old", result["removedComments"][0]["commentId"])

    def test_different_comment_ids_never_merge_even_when_text_matches(self):
        note, old, kept = self._seed_pulled_note_with_comments()
        _notes_path, comments_path = self._configure_csv("strict-comment-id")
        self.store._sync_pull_to_xlsx(note, [old, kept], {"folder": "", "files": []})
        replacement = {**old, "commentId": "comment-new-identity"}
        compared = self.store.compare_comments({
            "noteId": note["noteId"], "comments": [replacement, kept],
            "expectedCount": 2, "status": "likely_complete",
        })
        self.assertEqual((1, 1), (compared["newCount"], compared["removedCount"]))
        self.assertEqual("comment-old", compared["removedComments"][0]["commentId"])
        self.store.sync_comment_snapshot({
            "noteId": note["noteId"], "note": note, "comments": [replacement, kept],
            "expectedCount": 2, "status": "likely_complete",
        })
        rows = {row["笔记评论ID"]: row for row in self._csv_rows(comments_path, COMMENT_CSV_HEADERS)}
        self.assertEqual({"comment-old", "comment-kept", "comment-new-identity"}, set(rows))
        self.assertEqual("已删除", rows["comment-old"]["评论状态"])
        self.assertEqual("存在", rows["comment-new-identity"]["评论状态"])

    def test_partial_comment_compare_never_confirms_deletion(self):
        note, _old, kept = self._seed_pulled_note_with_comments()
        result = self.store.compare_comments({
            "noteId": note["noteId"], "comments": [kept],
            "expectedCount": 2, "status": "partial"
        })
        self.assertFalse(result["canPrune"])
        self.assertEqual(0, result["removedCount"])
        self.assertEqual(1, result["pendingRemovedCount"])
        self.assertFalse(result["hasChanges"])

    def test_post_metadata_change_does_not_mark_comments_changed(self):
        note, old, kept = self._seed_pulled_note_with_comments()
        with self.store._session() as db:
            db.execute("UPDATE notes SET payload_json=? WHERE note_id=?", (
                json.dumps({**note, "likeCount": 1}, ensure_ascii=False), note["noteId"]
            ))
        result = self.store.compare_comments({
            "noteId": note["noteId"], "note": {**note, "likeCount": 2},
            "comments": [old, kept], "expectedCount": 2, "status": "likely_complete"
        })
        self.assertTrue(result["noteChanged"])
        self.assertTrue(result["hasChanges"])
        self.assertFalse(result["commentHasChanges"])
        self.assertEqual((0, 0, 0), (result["newCount"], result["removedCount"], result["changedCount"]))

    def test_ignored_pulled_note_restores_to_known(self):
        note, _old, _kept = self._seed_pulled_note_with_comments()
        with self.store._session() as db:
            db.execute("UPDATE notes SET source='existing_xlsx',pull_status='synced',access_status='unreachable' WHERE note_id=?", (note["noteId"],))
        self.store.ignore({"noteId": note["noteId"]})
        self.assertEqual([], self.store.list_unreachable_notes())
        restored = self.store.restore({"noteId": note["noteId"]})
        self.assertTrue(restored["ok"])
        with self.store._session() as db:
            status = db.execute("SELECT status FROM notes WHERE note_id=?", (note["noteId"],)).fetchone()[0]
        self.assertEqual("known", status)
        self.assertEqual(note["noteId"], self.store.list_unreachable_notes()[0]["note_id"])

    def test_comment_sync_marks_deleted_without_losing_history_or_semantic_fields(self):
        note, old, kept = self._seed_pulled_note_with_comments()
        _notes_path, comments_path = self._configure_csv("comments")
        media_dir = Path(self.tmp.name) / "posts_materials" / "评论状态"
        media_dir.mkdir(parents=True)
        with self.store._session() as db:
            db.execute("UPDATE notes SET media_dir=? WHERE note_id=?", (str(media_dir), note["noteId"]))
        self.store._sync_pull_to_xlsx(note, [old, kept], {"folder": str(media_dir), "files": []})
        headers, rows = self.store._read_csv_table(comments_path, COMMENT_CSV_HEADERS)
        old_row = next(row for row in rows if row["笔记评论ID"] == "comment-old")
        old_row.update({"语义分析次数": "2", "分析结论是否差评": "是",
                        "差评类型": "Sales pitch", "差评子类型": "Aggressive pull-in"})
        self.store._replace_csv_table(comments_path, headers, rows, "semantic-test")
        with self.store._session() as db:
            db.execute("""UPDATE comments SET semantic_analysis_count=2,analysis_is_negative='是',
                       negative_type='Sales pitch',negative_subtype='Aggressive pull-in'
                       WHERE comment_id='comment-old'""")
        fresh = {"commentId": "comment-new", "author": "新用户", "content": "新增评论", "publishedAt": "08-24"}
        result = self.store.sync_comment_snapshot({
            "noteId": note["noteId"], "note": note, "comments": [kept, fresh],
            "expectedCount": 2, "status": "likely_complete"
        })
        self.assertEqual("latest", result["status"])
        self.assertEqual((1, 1), (result["newCount"], result["removedCount"]))
        db_rows = {row["comment_id"]: row for row in self.store.list_comments(note["noteId"])}
        self.assertEqual({"comment-old", "comment-kept", "comment-new"}, set(db_rows))
        self.assertEqual(1, db_rows["comment-old"]["is_deleted"])
        self.assertEqual("已删除", db_rows["comment-old"]["comment_status"])
        self.assertEqual(2, db_rows["comment-old"]["semantic_analysis_count"])
        csv_rows = {row["笔记评论ID"]: row for row in self._csv_rows(comments_path, COMMENT_CSV_HEADERS)}
        self.assertEqual(set(db_rows), set(csv_rows))
        self.assertEqual("已删除", csv_rows["comment-old"]["评论状态"])
        self.assertEqual("存在", csv_rows["comment-kept"]["评论状态"])
        self.assertEqual("Sales pitch", csv_rows["comment-old"]["差评类型"])
        material_rows = {row["commentId"]: row for row in json.loads(
            (media_dir / "comments.json").read_text(encoding="utf-8")
        )}
        self.assertTrue(material_rows["comment-old"]["isDeleted"])
        self.assertEqual("已删除", material_rows["comment-old"]["commentStatus"])
        self.assertEqual("Sales pitch", material_rows["comment-old"]["negativeType"])
        repeat = self.store.compare_comments({
            "noteId": note["noteId"], "comments": [kept, fresh],
            "expectedCount": 2, "status": "likely_complete"
        })
        self.assertEqual(0, repeat["removedCount"])

        restored = self.store.sync_comment_snapshot({
            "noteId": note["noteId"], "note": note, "comments": [old, kept, fresh],
            "expectedCount": 3, "status": "likely_complete"
        })
        self.assertEqual(1, restored["newCount"])
        restored_row = next(row for row in self._csv_rows(comments_path, COMMENT_CSV_HEADERS)
                            if row["笔记评论ID"] == "comment-old")
        self.assertEqual("存在", restored_row["评论状态"])
        self.assertEqual("Sales pitch", restored_row["差评类型"])
        restored_material = {row["commentId"]: row for row in json.loads(
            (media_dir / "comments.json").read_text(encoding="utf-8")
        )}
        self.assertFalse(restored_material["comment-old"]["isDeleted"])

    def test_partial_sync_never_marks_unloaded_comments_deleted(self):
        note, old, kept = self._seed_pulled_note_with_comments()
        _notes_path, comments_path = self._configure_csv("partial-presence")
        self.store._sync_pull_to_xlsx(note, [old, kept], {"folder": "", "files": []})
        result = self.store.sync_comment_snapshot({
            "noteId": note["noteId"], "note": note, "comments": [kept],
            "expectedCount": 2, "status": "partial"
        })
        self.assertFalse(result["canPrune"])
        csv_rows = {row["笔记评论ID"]: row for row in self._csv_rows(comments_path, COMMENT_CSV_HEADERS)}
        self.assertEqual("存在", csv_rows["comment-old"]["评论状态"])
        with self.store._session() as db:
            deleted = db.execute(
                "SELECT is_deleted FROM comments WHERE comment_id='comment-old'"
            ).fetchone()[0]
        self.assertEqual(0, deleted)

    def test_csv_semantic_and_presence_fields_import_to_sqlite(self):
        notes_path, comments_path = self._configure_csv("semantic-import")
        note_headers, note_rows = self.store._read_csv_table(notes_path, NOTE_CSV_HEADERS)
        note_rows.append({**{name: "" for name in note_headers},
                          "笔记ID": "semanticnote123", "笔记url": "https://www.xiaohongshu.com/explore/semanticnote123",
                          "笔记标题": "语义字段帖子", "语义分析次数": "3", "分析结论是否差评": "是",
                          "差评类型": "Price discrepancy", "差评子类型": "Felt overcharged"})
        self.store._replace_csv_table(notes_path, note_headers, note_rows, "semantic-note")
        comment_headers, comment_rows = self.store._read_csv_table(comments_path, COMMENT_CSV_HEADERS)
        comment_rows.append({**{name: "" for name in comment_headers},
                             "笔记ID": "semanticnote123", "原笔记url": "https://www.xiaohongshu.com/explore/semanticnote123",
                             "笔记评论ID": "semantic-comment-1", "用户昵称": "用户", "评论内容": "历史评论",
                             "评论层级": "1级评论", "语义分析次数": "2", "分析结论是否差评": "是",
                             "差评类型": "Sales pitch", "差评子类型": "Aggressive pull-in", "评论状态": "已删除"})
        self.store._replace_csv_table(comments_path, comment_headers, comment_rows, "semantic-comment")

        self.store.seed_from_xlsx(notes_path)

        with self.store._session() as db:
            note_row = db.execute("""SELECT semantic_analysis_count,analysis_is_negative,negative_type,negative_subtype
                                      FROM notes WHERE note_id='semanticnote123'""").fetchone()
            comment_row = db.execute("""SELECT semantic_analysis_count,analysis_is_negative,negative_type,
                                         negative_subtype,comment_status,is_deleted
                                         FROM comments WHERE comment_id='semantic-comment-1'""").fetchone()
        self.assertEqual((3, "是", "Price discrepancy", "Felt overcharged"), tuple(note_row))
        self.assertEqual((2, "是", "Sales pitch", "Aggressive pull-in", "已删除", 1), tuple(comment_row))

    def test_note_status_repairs_legacy_csv_media_path(self):
        note_id = "legacy123456"
        notes_path, _comments_path = self._configure_csv("legacy")
        actual_folder = notes_path.parent / "posts_materials" / "旧标题"
        actual_folder.mkdir(parents=True)
        (actual_folder / "旧标题-图1.jpg").write_bytes(b"image")
        headers, rows = self.store._read_csv_table(notes_path, NOTE_CSV_HEADERS)
        row = {name: "" for name in headers}
        row.update({"笔记ID": note_id, "笔记标题": "旧标题",
                    "笔记url": f"https://www.xiaohongshu.com/explore/{note_id}",
                    "对应帖子文件夹地址": "C:/removed-root/posts_materials/旧标题",
                    "文件夹内清单": "旧标题-图1.jpg"})
        rows.append(row)
        self.store._replace_csv_table(notes_path, headers, rows, "test")
        self.store.seed_from_xlsx(notes_path)
        result = self.store.note_status(note_id)
        self.assertTrue(result["inExcel"])
        self.assertEqual(str(actual_folder.resolve()), result["mediaDir"])
        self.assertEqual(["旧标题-图1.jpg"], result["mediaFiles"])
        self.assertGreater(result["excelRow"], 1)

    def test_csv_artifact_index_is_reused_until_file_changes(self):
        from unittest.mock import patch
        note_id = "cache123456"
        notes_path, _comments_path = self._configure_csv("cache")
        headers, rows = self.store._read_csv_table(notes_path, NOTE_CSV_HEADERS)
        row = {name: "" for name in headers}
        row.update({"笔记ID": note_id, "对应帖子文件夹地址": "C:/materials/cache123456",
                    "文件夹内清单": "image-01.jpg"})
        rows.append(row)
        self.store._replace_csv_table(notes_path, headers, rows, "test")

        with patch.object(self.store, "_read_csv_table", wraps=self.store._read_csv_table) as mocked_read:
            first = self.store._excel_note_artifacts(note_id)
            second = self.store._excel_note_artifacts(note_id)
            self.assertEqual(first, second)
            self.assertEqual(1, mocked_read.call_count)

            with notes_path.open("r", encoding="utf-8-sig", newline="") as stream:
                raw_rows = list(csv.DictReader(stream))
            raw_rows[0]["文件夹内清单"] = "image-01.jpg\nimage-02.jpg"
            with notes_path.open("w", encoding="utf-8-sig", newline="") as stream:
                writer = csv.DictWriter(stream, fieldnames=headers, lineterminator="\r\n")
                writer.writeheader(); writer.writerows(raw_rows)
            refreshed = self.store._excel_note_artifacts(note_id)
            self.assertEqual(["image-01.jpg", "image-02.jpg"], refreshed[1])
            self.assertEqual(2, mocked_read.call_count)

    def test_extension_broadcasts_delete_state_and_reconciles_unchanged_syncs(self):
        extension = Path(__file__).resolve().parent.parent / "extension"
        worker = (extension / "service-worker.js").read_text(encoding="utf-8")
        content = (extension / "content.js").read_text(encoding="utf-8")
        panel = (extension / "sidepanel.js").read_text(encoding="utf-8")
        self.assertIn("deletePulledNoteAndBroadcast", worker)
        self.assertIn('type: "localNoteStateChanged"', worker)
        self.assertIn("评论无变化，正在校准 CSV、SQLite 与素材快照", worker)
        self.assertIn("enforceExactNoteIdentity", worker)
        self.assertIn("identityConflictBlocked", content)
        self.assertIn('message.type === "localNoteStateChanged"', content)
        self.assertIn('message.type === "localNoteStateChanged"', panel)

    def test_powershell_output_decoder_accepts_utf8_and_utf16(self):
        self.assertEqual("WPS|True\r\n", _decode_powershell_output(b"WPS|True\r\n"))
        self.assertEqual("WPS|True\r\n", _decode_powershell_output("WPS|True\r\n".encode("utf-16le")))

    def test_atomic_replace_retries_transient_wps_lock(self):
        from unittest.mock import patch
        source = Path(self.tmp.name) / "source.xlsx"
        target = Path(self.tmp.name) / "target.xlsx"
        source.write_bytes(b"new")
        target.write_bytes(b"old")
        with patch("server.os.replace", side_effect=[PermissionError("busy"), PermissionError("busy"), None]) as replace, \
             patch("server._reopen_saved_office_workbook_read_only", return_value=False), \
             patch("server.time.sleep") as sleep:
            attempts = replace_with_retry(source, target, attempts=4, initial_delay=0.01)
        self.assertEqual(3, attempts)
        self.assertEqual(3, replace.call_count)
        self.assertEqual(2, sleep.call_count)

    def test_atomic_replace_converts_saved_wps_lock_then_retries(self):
        from unittest.mock import patch
        source = Path(self.tmp.name) / "source-wps.xlsx"
        target = Path(self.tmp.name) / "target-wps.xlsx"
        source.write_bytes(b"new")
        target.write_bytes(b"old")
        with patch("server.os.replace", side_effect=[PermissionError("wps busy"), None]) as replace, \
             patch("server._reopen_saved_office_workbook_read_only", return_value=True) as recover, \
             patch("server.time.sleep") as sleep:
            attempts = replace_with_retry(source, target, attempts=3)
        self.assertEqual(2, attempts)
        recover.assert_called_once_with(target)
        self.assertEqual(2, replace.call_count)
        sleep.assert_not_called()

    def test_open_excel_prefers_wps_and_locates_note(self):
        import base64
        import subprocess
        from unittest.mock import patch

        note_id = "openexcel123456"
        workbook_path = self.store.export_dir.parent / "wps-master.xlsx"
        self.store.seed_xlsx_path = workbook_path
        self.store._ensure_seed_workbook(workbook_path)
        pulled = self.store.pull_to_excel({
            "note": {"noteId": note_id, "title": "WPS 定位测试", "content": "正文", "detailRead": True},
            "comments": [],
        })
        completed = subprocess.CompletedProcess([], 0, stdout="WPS|True\r\n".encode("utf-16le"), stderr=b"")
        with patch("server.subprocess.run", return_value=completed) as run:
            result = self.store.open_local_artifact({
                "kind": "excel", "noteId": note_id, "excelRow": pulled["excelRow"], "fieldName": "笔记标题"
            })
        encoded_script = run.call_args.args[0][-1]
        script = base64.b64decode(encoded_script).decode("utf-16le")
        self.assertLess(script.index("ket.Application"), script.index("Excel.Application"))
        self.assertIn("$app.Workbooks.Open($path, 0, $true)", script)
        self.assertIn("$app.Goto($cell, $true)", script)
        self.assertEqual("WPS", result["application"])
        self.assertEqual("csv", result["kind"])
        self.assertTrue(result["target"].endswith(".csv"))
        self.assertIn("$book.Worksheets.Item(1)", script)
        self.assertTrue(result["readOnly"])
        self.assertEqual(pulled["excelRow"], result["row"])

    def test_open_local_artifact_uses_hydrated_media_folder(self):
        from unittest.mock import patch
        note_id = "openmedia123456"
        workbook_path = self.store.export_dir.parent / "open-master.xlsx"
        self.store.seed_xlsx_path = workbook_path
        folder = workbook_path.parent / "posts_materials" / f"素材__{note_id}"
        folder.mkdir(parents=True)
        (folder / "image-01.jpg").write_bytes(b"image")
        timestamp = "2026-08-24T15:00:00+08:00"
        with self.store._session() as db:
            db.execute("""
                INSERT INTO notes
                (note_id,url,title,first_seen_at,last_seen_at,status,is_relevant,source,
                 title_key,content_key,title_content_key,pull_status,media_dir)
                VALUES (?,?,?,?,?,'known',1,'existing_xlsx',?,'','','synced',?)
            """, (note_id, f"https://www.xiaohongshu.com/explore/{note_id}", "素材帖子",
                  timestamp, timestamp, "素材帖子", str(folder)))
        with patch("server.os.startfile") as startfile:
            result = self.store.open_local_artifact({"kind": "folder", "noteId": note_id})
        self.assertTrue(result["ok"])
        self.assertEqual(str(folder.resolve()), result["target"])
        startfile.assert_called_once_with(str(folder.resolve()))

    def test_unreachable_status_round_trip_and_bulk_mark_keeps_all_history(self):
        note_id = "unreachable123456"
        notes_path, comments_path = self._configure_csv("unreachable")
        media_dir = Path(self.tmp.name) / "posts_materials" / note_id
        media_dir.mkdir(parents=True)
        (media_dir / "image-01.jpg").write_bytes(b"image")
        note = {
            "noteId": note_id,
            "url": f"https://www.xiaohongshu.com/explore/{note_id}",
            "title": "无法打开的帖子",
            "content": "用于访问状态测试",
            "author": "测试用户",
            "detailRead": True,
        }
        comment = {
            "commentId": "comment-unreachable-1",
            "author": "评论用户",
            "content": "需要保留的历史评论",
            "publishedAt": "08-25",
        }
        self.store.confirm(note)
        self.store.upsert_comments({
            "noteId": note_id, "comments": [comment], "expectedCount": 1, "status": "likely_complete",
        })
        with self.store._session() as db:
            db.execute("""UPDATE notes SET media_dir=?,media_status='complete',media_file_count=1
                       WHERE note_id=?""", (str(media_dir), note_id))
        self.store._sync_pull_to_xlsx(note, [comment], {"folder": str(media_dir), "files": ["image-01.jpg"]})
        self.store._write_media_snapshot(
            {"folder": str(media_dir), "files": ["image-01.jpg"]}, note,
            self.store._comments_as_api(note_id),
        )
        note_headers, note_rows = self.store._read_csv_table(notes_path, NOTE_CSV_HEADERS)
        before_row = next(row for row in note_rows if row["笔记ID"] == note_id)
        before_row.update({"语义分析次数": "3", "分析结论是否差评": "是",
                           "差评类型": "Price discrepancy", "差评子类型": "Felt overcharged"})
        self.store._replace_csv_table(notes_path, note_headers, note_rows, "semantic-post")
        with self.store._session() as db:
            db.execute("""UPDATE notes SET semantic_analysis_count=3,analysis_is_negative='是',
                       negative_type='Price discrepancy',negative_subtype='Felt overcharged' WHERE note_id=?""", (note_id,))

        marked = self.store.set_note_access_status({
            "noteId": note_id, "status": "unreachable", "error": "详情页无法加载",
        })
        self.assertEqual(("unreachable", "已删除", True),
                         (marked["accessStatus"], marked["postStatus"], marked["isDeleted"]))
        note_rows = self._csv_rows(notes_path, NOTE_CSV_HEADERS)
        matching_row = next(row for row in note_rows if row["笔记ID"] == note_id)
        self.assertEqual(("打不开", "已删除"), (matching_row["访问状态"], matching_row["帖子状态"]))
        self.assertEqual(("3", "是", "Price discrepancy", "Felt overcharged"),
                         tuple(matching_row[name] for name in
                               ("语义分析次数", "分析结论是否差评", "差评类型", "差评子类型")))
        self.assertEqual(note_id, self.store.list_unreachable_notes()[0]["note_id"])
        material_note = json.loads((media_dir / "note.json").read_text(encoding="utf-8"))
        self.assertTrue(material_note["isDeleted"])
        self.assertEqual("已删除", material_note["postStatus"])

        cleared = self.store.set_note_access_status({"noteId": note_id, "status": "ok"})
        self.assertEqual(("ok", "存在", False),
                         (cleared["accessStatus"], cleared["postStatus"], cleared["isDeleted"]))
        self.assertEqual([], self.store.list_unreachable_notes())
        headers, note_rows = self.store._read_csv_table(notes_path, NOTE_CSV_HEADERS)
        row = next(row for row in note_rows if row["笔记ID"] == note_id)
        row["访问状态"] = "打不开"
        row["帖子状态"] = "存在"
        self.store._replace_csv_table(notes_path, headers, note_rows, "manual")
        self.store.seed_from_xlsx(notes_path)
        self.assertEqual([], self.store.list_unreachable_notes())
        with self.store._session() as db:
            self.assertEqual(("check_failed", "存在", 0), tuple(db.execute(
                "SELECT access_status,post_status,is_deleted FROM notes WHERE note_id=?", (note_id,)
            ).fetchone()))
        migrated = self.store.reconcile_legacy_access_statuses()
        self.assertEqual(1, migrated["updated"])

        self.store.set_note_access_status({
            "noteId": note_id, "status": "unreachable", "error": "两条独立证据确认内容已删除",
        })
        with self.store._session() as db:
            db.execute(
                "INSERT INTO note_summaries(note_id,model,result_json,comment_count,created_at,updated_at) VALUES(?,?,?,?,?,?)",
                (note_id, "test", "{}", 1, "2026-08-26T16:00:00+08:00", "2026-08-26T16:00:00+08:00"),
            )
            db.execute(
                "INSERT INTO reply_generation_history(note_id,comment_id,generated_reply,created_at) VALUES(?,?,?,?)",
                (note_id, comment["commentId"], "测试回复", "2026-08-26T16:00:00+08:00"),
            )
            db.execute(
                "INSERT INTO ai_analysis_records(target_type,target_id,status,created_at) VALUES('relevance',?,'completed',?)",
                (note_id, "2026-08-26T16:00:00+08:00"),
            )
            db.execute(
                "INSERT INTO watchlist(note_id,created_at,updated_at) VALUES(?,?,?)",
                (note_id, "2026-08-26T16:00:00+08:00", "2026-08-26T16:00:00+08:00"),
            )

        result = self.store.delete_unreachable_notes({})
        self.assertTrue(result["ok"])
        self.assertTrue(result["nonDestructive"])
        self.assertEqual((1, 0), (result["markedDeletedCount"], result["deletedDatabaseComments"]))
        with self.store._session() as db:
            self.assertEqual(("已删除", 1), tuple(db.execute(
                "SELECT post_status,is_deleted FROM notes WHERE note_id=?", (note_id,)
            ).fetchone()))
            self.assertEqual(1, db.execute(
                "SELECT COUNT(*) FROM comments WHERE note_id=?", (note_id,)
            ).fetchone()[0])
            for table in ("note_summaries", "reply_generation_history", "watchlist"):
                self.assertEqual(1, db.execute(f"SELECT COUNT(*) FROM {table} WHERE note_id=?", (note_id,)).fetchone()[0])
            self.assertEqual(1, db.execute(
                "SELECT COUNT(*) FROM ai_analysis_records WHERE target_id=?", (note_id,)
            ).fetchone()[0])
        note_ids = {row["笔记ID"] for row in self._csv_rows(notes_path, NOTE_CSV_HEADERS)}
        comment_ids = {row["笔记评论ID"] for row in self._csv_rows(comments_path, COMMENT_CSV_HEADERS)}
        self.assertIn(note_id, note_ids)
        self.assertIn(comment["commentId"], comment_ids)
        self.assertTrue(media_dir.is_dir())
        health = self.store.data_health()
        self.assertTrue(health["summary"]["relationshipsConsistent"])
        self.assertEqual(1, health["summary"]["deletedPosts"])

    def test_relationship_repair_rebuilds_fragments_and_marks_orphans(self):
        known_id = "knownnote123"
        orphan_id = "orphannote123"
        notes = [
            {"笔记ID": known_id, "笔记url": f"https://www.xiaohongshu.com/explore/{known_id}", "笔记标题": "有效帖子"},
            {"笔记ID": "", "笔记url": f"https://www.xiaohongshu.com/explore/{known_id}", "笔记标题": ""},
        ]
        logical = [
            {"原笔记url": f"https://www.xiaohongshu.com/explore/{known_id}", "用户昵称": "甲",
             "评论内容": "完整保留一", "评论时间": "08-27", "评论层级": "1级评论", "点赞量": "1",
             "是否帖主评论": "否", "帖子用户主页url": "https://example.com/a", "文件夹内清单": "a.jpg"},
            {"原笔记url": f"https://www.xiaohongshu.com/explore/{orphan_id}", "用户昵称": "乙",
             "评论内容": "完整保留二", "评论时间": "08-27", "评论层级": "2级评论", "点赞量": "0",
             "是否帖主评论": "否", "帖子用户主页url": "https://example.com/b", "文件夹内清单": "b.jpg"},
        ]
        fragmented = []
        for source in logical:
            for name in ("原笔记url", "帖子用户主页url", "用户昵称", "评论内容", "评论时间",
                         "是否帖主评论", "点赞量", "评论层级", "对应帖子文件夹地址", "文件夹内清单", "AI情绪判断"):
                fragmented.append({name: source.get(name) or ("中立" if name == "AI情绪判断" else "素材" if name == "对应帖子文件夹地址" else "")})
        result = repair_relationship_rows(notes, fragmented, NOTE_CSV_HEADERS, COMMENT_CSV_HEADERS)
        self.assertEqual(1, len(result["noteRows"]))
        self.assertEqual(2, len(result["commentRows"]))
        self.assertEqual(2, result["summary"]["fragmentedCommentsRebuilt"])
        self.assertEqual(2, result["summary"]["generatedCommentIds"])
        self.assertEqual(1, result["summary"]["mappingReviewComments"])
        self.assertEqual({"完整保留一", "完整保留二"}, {row["评论内容"] for row in result["commentRows"]})
        self.assertEqual(2, len({row["笔记评论ID"] for row in result["commentRows"]}))
        orphan = next(row for row in result["commentRows"] if row["笔记ID"] == orphan_id)
        self.assertEqual("待复核", orphan["映射状态"])

    def test_relationship_repair_unions_csv_sqlite_and_material_comments(self):
        notes_path, comments_path = self._configure_csv("repair-union")
        note = {"noteId": "repairunion123", "title": "关系修复", "content": "正文",
                "url": "https://www.xiaohongshu.com/explore/repairunion123", "detailRead": True}
        self.store.confirm(note)
        folder = Path(self.tmp.name) / "posts_materials" / "repairunion123"
        folder.mkdir(parents=True)
        with self.store._session() as db:
            db.execute("UPDATE notes SET media_dir=?,source='existing_xlsx',pull_status='synced' WHERE note_id=?",
                       (str(folder), note["noteId"]))
        self.store._sync_pull_to_xlsx(note, [], {"folder": str(folder), "files": []})
        self.store.upsert_comments({
            "noteId": note["noteId"], "status": "partial",
            "comments": [{"commentId": "db-only-comment", "author": "数据库", "content": "数据库独有"}],
        })
        (folder / "comments.json").write_text(json.dumps([
            {"commentId": "material-only-comment", "noteId": note["noteId"],
             "author": "素材", "content": "素材独有", "commentLevel": 1}
        ], ensure_ascii=False), encoding="utf-8")
        legacy = {"原笔记url": note["url"], "用户昵称": "历史", "评论内容": "CSV 独有",
                  "评论时间": "08-27", "评论层级": "1级评论"}
        self.store._replace_csv_table(comments_path, COMMENT_CSV_HEADERS, [legacy], "legacy")

        result = self.store.repair_csv_relationships({})

        self.assertTrue(result["ok"])
        self.assertEqual(3, result["summary"]["commentsAfterUnion"])
        rows = self._csv_rows(comments_path, COMMENT_CSV_HEADERS)
        self.assertEqual(3, len(rows))
        self.assertTrue(all(row["笔记ID"] == note["noteId"] for row in rows))
        self.assertTrue(all(row["笔记评论ID"] for row in rows))
        with self.store._session() as db:
            self.assertEqual(3, db.execute("SELECT COUNT(*) FROM comments WHERE note_id=?", (note["noteId"],)).fetchone()[0])
        material = json.loads((folder / "comments.json").read_text(encoding="utf-8"))
        self.assertEqual({row["笔记评论ID"] for row in rows}, {item["commentId"] for item in material})
        self.assertTrue(result["health"]["summary"]["relationshipsConsistent"])

    def test_relationship_repair_splits_shared_material_directories(self):
        self._configure_csv("shared-material")
        shared = Path(self.tmp.name) / "posts_materials" / "共享目录"
        shared.mkdir(parents=True)
        (shared / "image-01.jpg").write_bytes(b"shared-image")
        notes = [
            {"noteId": "sharednote123", "title": "共享甲", "content": "甲正文",
             "url": "https://www.xiaohongshu.com/explore/sharednote123", "detailRead": True},
            {"noteId": "sharednote456", "title": "共享乙", "content": "乙正文",
             "url": "https://www.xiaohongshu.com/explore/sharednote456", "detailRead": True},
        ]
        for index, note in enumerate(notes, 1):
            comment = {"commentId": f"shared-comment-{index}", "author": f"用户{index}",
                       "content": f"评论{index}", "commentLevel": 1}
            self.store.confirm(note)
            with self.store._session() as db:
                db.execute("UPDATE notes SET media_dir=?,source='existing_xlsx',pull_status='synced' WHERE note_id=?",
                           (str(shared), note["noteId"]))
            self.store.upsert_comments({"noteId": note["noteId"], "comments": [comment], "status": "partial"})
            self.store._sync_pull_to_xlsx(note, [comment], {"folder": str(shared), "files": ["image-01.jpg"]})

        result = self.store.repair_csv_relationships({})

        self.assertEqual(2, result["summary"]["sharedMediaRecordsSplit"])
        with self.store._session() as db:
            paths = [Path(row[0]) for row in db.execute(
                "SELECT media_dir FROM notes WHERE note_id IN ('sharednote123','sharednote456') ORDER BY note_id"
            ).fetchall()]
        self.assertEqual(2, len({str(path) for path in paths}))
        self.assertFalse(shared.exists())
        for index, path in enumerate(paths, 1):
            self.assertTrue((path / "image-01.jpg").is_file())
            comments = json.loads((path / "comments.json").read_text(encoding="utf-8"))
            self.assertEqual(1, len(comments))
        self.assertTrue(result["health"]["summary"]["relationshipsConsistent"])

    def test_no_change_sync_reconciles_csv_sqlite_and_material_snapshot(self):
        notes_path, comments_path = self._configure_csv("all-stores")
        note = {"noteId": "allstores123", "title": "全部本地同步", "content": "正文",
                "url": "https://www.xiaohongshu.com/explore/allstores123", "detailRead": True}
        comment = {"commentId": "allstores-comment", "author": "用户", "content": "没有变化",
                   "publishedAt": "08-27", "commentLevel": 1, "likeCount": 1}
        self.store.confirm(note)
        folder = Path(self.tmp.name) / "posts_materials" / "allstores123"
        folder.mkdir(parents=True)
        with self.store._session() as db:
            db.execute("UPDATE notes SET media_dir=?,source='existing_xlsx',pull_status='synced' WHERE note_id=?",
                       (str(folder), note["noteId"]))
        self.store.upsert_comments({"noteId": note["noteId"], "comments": [comment],
                                    "expectedCount": 1, "status": "likely_complete"})
        self.store._sync_pull_to_xlsx(note, [comment], {"folder": str(folder), "files": []})
        headers, _rows = self.store._read_csv_table(comments_path, COMMENT_CSV_HEADERS)
        self.store._replace_csv_table(comments_path, headers, [], "simulate-drift")

        result = self.store.sync_comment_snapshot({
            "noteId": note["noteId"], "note": note, "comments": [comment],
            "expectedCount": 1, "status": "likely_complete",
        })

        self.assertTrue(result["consistencyVerified"])
        self.assertEqual(0, result["newCount"])
        csv_rows = self._csv_rows(comments_path, COMMENT_CSV_HEADERS)
        self.assertEqual(["allstores-comment"], [row["笔记评论ID"] for row in csv_rows])
        self.assertEqual("allstores123", csv_rows[0]["笔记ID"])
        material = json.loads((folder / "comments.json").read_text(encoding="utf-8"))
        self.assertEqual(["allstores-comment"], [row["commentId"] for row in material])
        health = self.store.data_health()
        self.assertTrue(health["summary"]["relationshipsConsistent"])

    def test_wps_gb18030_csv_is_normalized_without_row_loss(self):
        notes_path = Path(self.tmp.name) / "品牌_笔记总表.csv"
        self.store.configure_data_files(notes_path)
        self.store._replace_csv_table(notes_path, NOTE_CSV_HEADERS, [], "test")
        comments_path = Path(self.tmp.name) / "品牌_评论总表.csv"
        with comments_path.open("w", encoding="gb18030", newline="") as stream:
            writer = csv.DictWriter(stream, fieldnames=COMMENT_CSV_HEADERS, lineterminator="\r\n")
            writer.writeheader()
            writer.writerow({"笔记评论ID": "gb18030-comment", "用户昵称": "测试用户", "评论内容": "中文评论保持完整"})

        self.store.seed_from_xlsx(notes_path)

        self.assertEqual(b"\xef\xbb\xbf", comments_path.read_bytes()[:3])
        _headers, rows = self.store._read_csv_table(comments_path, COMMENT_CSV_HEADERS)
        self.assertEqual("中文评论保持完整", rows[0]["评论内容"])
        self.assertEqual("测试用户", rows[0]["用户昵称"])

    def test_seed_migrates_existing_workbook_to_two_utf8_csv_files(self):
        from openpyxl import Workbook

        workbook_path = self.store.export_dir.parent / "legacy-no-access-column.xlsx"
        workbook = Workbook()
        sheet = workbook.active
        sheet.title = "sheet1_笔记总表"
        sheet.append(["笔记url", "笔记标题", "笔记ID"])
        sheet.append([
            "https://www.xiaohongshu.com/explore/schema123456",
            "旧版表格帖子",
            "schema123456",
        ])
        workbook.create_sheet("sheet2_评论总表").append(["笔记评论ID"])
        audit = workbook.create_sheet("旧版审核记录")
        audit.append(["笔记ID", "处理结果"])
        audit.append(["schema123456", "保留"])
        workbook.save(workbook_path)
        workbook.close()

        self.store.seed_from_xlsx(workbook_path)
        notes_path, comments_path = self.store._csv_paths()
        headers, rows = self.store._read_csv_table(notes_path, NOTE_CSV_HEADERS)
        self.assertFalse(workbook_path.exists())
        self.assertTrue(comments_path.exists())
        self.assertIn("访问状态", headers)
        self.assertEqual("schema123456", rows[0]["笔记ID"])
        self.assertEqual(b"\xef\xbb\xbf", notes_path.read_bytes()[:3])
        with self.store._session() as db:
            archived = db.execute("SELECT COUNT(*) FROM legacy_sheet_archive WHERE sheet_name='旧版审核记录'").fetchone()[0]
        self.assertEqual(2, archived)

    def test_batch_access_status_writes_open_review_and_unreachable(self):
        notes_path, _comments_path = self._configure_csv("access-batch")
        notes = [
            {"noteId": "accessopen123", "title": "可打开帖子", "content": "正文"},
            {"noteId": "accessreview123", "title": "待复核帖子", "content": "正文"},
            {"noteId": "accessgone123", "title": "确认删除帖子", "content": "正文"},
        ]
        for note in notes:
            self.store.confirm(note)
            self.store._sync_pull_to_xlsx(note, [], {"folder": "", "files": []})

        result = self.store.set_note_access_statuses({"items": [
            {"noteId": "accessopen123", "status": "ok"},
            {"noteId": "accessreview123", "status": "check_failed", "error": "token 过期"},
            {"noteId": "accessgone123", "status": "unreachable", "error": "两条明确删除证据"},
        ]})
        self.assertTrue(result["ok"])
        self.assertEqual({"ok": 1, "check_failed": 1, "unreachable": 1}, result["byStatus"])

        excel_states = {row["笔记ID"]: row["访问状态"]
                        for row in self._csv_rows(notes_path, NOTE_CSV_HEADERS)}
        self.assertEqual("可打开", excel_states["accessopen123"])
        self.assertEqual("待复核", excel_states["accessreview123"])
        self.assertEqual("打不开", excel_states["accessgone123"])
        with self.store._session() as db:
            db_states = {
                row["note_id"]: row["access_status"]
                for row in db.execute(
                    "SELECT note_id,access_status FROM notes WHERE note_id LIKE 'access%'"
                ).fetchall()
            }
        self.assertEqual("ok", db_states["accessopen123"])
        self.assertEqual("check_failed", db_states["accessreview123"])
        self.assertEqual("unreachable", db_states["accessgone123"])

    def test_summary_combines_note_and_comments(self):
        settings = self.store.ai_settings._raw()
        settings["api_key_dpapi"] = "test"
        self.store.ai_settings.get = lambda include_secret=False: {
            "configured": True, "model": "deepseek-v4-flash", "max_tokens": 1800,
            "api_key": "test", "base_url": "https://api.deepseek.com", "timeout_seconds": 45,
            "temperature": 0.1, "thinking_mode": "disabled"
        }
        result = self.store.summarize_note({"note": {"noteId": "abcdef123456", "title": "标题", "content": "正文内容"},
                                            "comments": [{"content": "代表评论", "author": "用户"}]})
        self.assertTrue(result["ok"])
        self.assertEqual(1, result["commentCount"])
        cached = self.store.note_summary("abcdef123456")
        self.assertTrue(cached["found"])

    def test_reply_suggestion_uses_manual_send_workflow(self):
        self.store.ai_client = FakeReplyAI()
        self.store.ai_settings.get = lambda include_secret=False: {
            "configured": True, "model": "deepseek-v4-flash", "max_tokens": 1800,
            "api_key": "test", "base_url": "https://api.deepseek.com", "timeout_seconds": 45,
            "temperature": 0.1, "thinking_mode": "disabled"
        }
        result = self.store.suggest_comment_reply({
            "note": {"noteId": "abcdef123456", "title": "标题", "content": "正文"},
            "comments": [{"commentId": "comment-1", "content": "价格是多少", "author": "用户"}],
            "targetComment": {"commentId": "comment-1", "content": "价格是多少", "author": "用户"},
            "persona": "brand"
        })
        self.assertTrue(result["ok"])
        self.assertEqual(3, len(result["suggestion"]["candidates"]))
        self.assertIn("价格", result["suggestion"]["reply"])
        self.assertEqual("价格疑问", result["suggestion"]["intent"])
        self.assertTrue(all(item["riskLevel"] != "high" for item in result["suggestion"]["candidates"]))
        with self.store._session() as db:
            self.assertEqual(3, db.execute("SELECT COUNT(*) FROM reply_generation_history").fetchone()[0])

    def test_reply_policy_flags_template_marketing_and_mismatch(self):
        intent, sentiment = classify_reply_context("我今天被拉着推销，感觉很不舒服")
        self.assertEqual(("推销投诉", "负面"), (intent, sentiment))
        audit = audit_reply_candidate(
            "感谢宝宝认可与喜爱，未来2-3个月会有更多优惠活动，欢迎来店体验。",
            "我今天被拉着推销，感觉很不舒服", "brand", []
        )
        self.assertEqual("high", audit["riskLevel"])
        self.assertTrue(any("语义不匹配" in item for item in audit["riskNotes"]))

    def test_reply_policy_flags_high_similarity(self):
        reply = "理解你对价格的顾虑。你发下产品全名，我们按门店公示价帮你核对。"
        audit = audit_reply_candidate(reply, "这个多少钱", "brand", [reply])
        self.assertEqual("high", audit["riskLevel"])
        self.assertGreaterEqual(audit["similarityScore"], 0.99)

    def test_operations_center_health_changes_watchlist_and_weekly_report(self):
        from datetime import datetime
        from openpyxl import load_workbook

        workbook_path = self.store.export_dir.parent / "operations-master.xlsx"
        self.store.seed_xlsx_path = workbook_path
        self.store._ensure_seed_workbook(workbook_path)
        note = {
            "noteId": "operations123456", "title": "重点观察测试帖", "author": "测试作者",
            "content": "有人反馈价格和推销问题", "url": "https://www.xiaohongshu.com/explore/operations123456",
            "keyword": "samplebrand", "detailRead": True, "likeCount": 1,
        }
        self.store.confirm(note)
        original = {"commentId": "operations-comment-1", "author": "用户甲", "content": "价格多少", "publishedAt": "08-26"}
        self.store.upsert_comments({
            "noteId": note["noteId"], "comments": [original], "expectedCount": 1, "status": "likely_complete"
        })
        self.store._sync_pull_to_xlsx(note, [original], {"folder": "", "files": []})

        watched = self.store.set_watchlist({
            "noteId": note["noteId"], "watched": True, "priority": "high", "reason": "价格投诉"
        })
        self.assertTrue(watched["watched"])
        self.assertEqual(1, self.store.list_watchlist()["count"])
        self.assertTrue(self.store.note_status(note["noteId"])["watched"])

        run = self.store.start_sync_run({"runType": "batch", "totalNotes": 1})
        added = {"commentId": "operations-comment-2", "author": "用户乙", "content": "被拉着推销", "publishedAt": "08-26"}
        updated_note = {**note, "likeCount": 2}
        synced = self.store.sync_comment_snapshot({
            "noteId": note["noteId"], "note": updated_note, "comments": [original, added],
            "expectedCount": 2, "status": "likely_complete", "runId": run["runId"],
        })
        self.assertEqual(1, synced["newCount"])
        self.assertEqual(2, synced["changeEventCount"])
        self.store.finish_sync_run({
            "runId": run["runId"], "status": "completed", "processedNotes": 1,
            "changedNotes": 1, "newComments": 1,
        })
        changes = self.store.list_change_events()
        self.assertEqual(2, changes["unread"])
        self.assertEqual({"comment_added", "note_fields_changed"}, {item["event_type"] for item in changes["events"]})
        self.assertEqual(2, self.store.acknowledge_change_events({"all": True})["updated"])
        self.assertEqual(0, self.store.list_change_events()["unread"])

        with self.store._session() as db:
            db.execute("UPDATE notes SET comment_count_collected=99 WHERE note_id=?", (note["noteId"],))
        health = self.store.data_health()
        mismatch = next(item for item in health["issues"] if item["id"] == "comment_count_mismatch")
        self.assertTrue(mismatch["repairable"])
        repaired = self.store.repair_data_health({})
        self.assertTrue(repaired["ok"])
        self.assertFalse(any(item["id"] == "comment_count_mismatch" for item in repaired["health"]["issues"]))

        today = datetime.now().astimezone().date().isoformat()
        report = self.store.generate_weekly_report({"startDate": today, "endDate": today})
        self.assertTrue(Path(report["xlsxPath"]).is_file())
        self.assertTrue(Path(report["htmlPath"]).is_file())
        self.assertEqual(1, report["summary"]["newComments"])
        workbook = load_workbook(report["xlsxPath"], read_only=True, data_only=True)
        self.assertEqual({"周报总览", "新增帖子", "同步变化", "重点观察"}, set(workbook.sheetnames))
        workbook.close()
        self.assertTrue(self.store.latest_weekly_report()["found"])

    def test_restart_cancels_legacy_sentiment_queue_and_disables_auto_flags(self):
        note = {"noteId": "sentiment123456", "title": "旧情绪任务", "content": "正文"}
        self.store.confirm(note)
        self.store.upsert_comments({
            "noteId": note["noteId"],
            "comments": [{"commentId": "sentiment-comment-1", "author": "用户", "content": "评论"}],
            "expectedCount": 1,
            "status": "likely_complete",
        })
        self.store.ai_settings.save({"auto_analyze_posts": True, "auto_analyze_comments": True})
        with self.store._session() as db:
            db.execute("UPDATE notes SET ai_analysis_status='queued' WHERE note_id=?", (note["noteId"],))
            db.execute("UPDATE comments SET ai_analysis_status='analyzing' WHERE comment_id='sentiment-comment-1'")
            db.execute("""INSERT INTO ai_jobs
                       (target_type,target_id,priority,status,attempts,available_at,created_at,updated_at)
                       VALUES ('note',?,10,'queued',0,0,'2026-08-25','2026-08-25')""", (note["noteId"],))
            db.execute("""INSERT INTO ai_jobs
                       (target_type,target_id,priority,status,attempts,available_at,created_at,updated_at)
                       VALUES ('comment','sentiment-comment-1',10,'analyzing',0,0,'2026-08-25','2026-08-25')""")

        reopened = MonitorStore(self.store.db_path, self.store.export_dir, ai_client=FakeAI())
        settings = reopened.ai_settings.get(False)
        self.assertFalse(settings["auto_analyze_posts"])
        self.assertFalse(settings["auto_analyze_comments"])
        with reopened._session() as db:
            self.assertEqual(0, db.execute(
                "SELECT COUNT(*) FROM ai_jobs WHERE status IN ('queued','analyzing')"
            ).fetchone()[0])
            self.assertEqual("not_analyzed", db.execute(
                "SELECT ai_analysis_status FROM notes WHERE note_id=?", (note["noteId"],)
            ).fetchone()[0])
            self.assertEqual("not_analyzed", db.execute(
                "SELECT ai_analysis_status FROM comments WHERE comment_id='sentiment-comment-1'"
            ).fetchone()[0])


if __name__ == "__main__":
    unittest.main()
