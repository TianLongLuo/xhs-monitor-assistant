import json
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from server import MonitorStore, audit_reply_candidate, classify_reply_context


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
            "titleOnly": True, "returnAllStatuses": True, "keyword": "origani",
            "notes": [{"noteId": "existing123456", "url": "https://www.xiaohongshu.com/explore/existing123456",
                       "title": "小红书当前展示的新标题", "content": ""}]
        })
        self.assertTrue(result["ok"])
        self.assertEqual(1, len(result["statuses"]))
        self.assertTrue(result["statuses"][0]["inExcel"])
        self.assertEqual("known", result["statuses"][0]["status"])
        self.assertEqual("帖子ID", result["statuses"][0]["matchLabel"])

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

    def test_comment_sync_updates_sqlite_and_excel_without_blank_rows(self):
        from openpyxl import load_workbook
        note, old, kept = self._seed_pulled_note_with_comments()
        workbook_path = self.store.export_dir.parent / "comments-master.xlsx"
        self.store.seed_xlsx_path = workbook_path
        self.store._ensure_seed_workbook(workbook_path)
        self.store._sync_pull_to_xlsx(note, [old, kept], {"folder": "", "files": []})
        fresh = {"commentId": "comment-new", "author": "新用户", "content": "新增评论", "publishedAt": "08-24"}
        result = self.store.sync_comment_snapshot({
            "noteId": note["noteId"], "note": note, "comments": [kept, fresh],
            "expectedCount": 2, "status": "likely_complete"
        })
        self.assertEqual("latest", result["status"])
        self.assertEqual((1, 1), (result["newCount"], result["removedCount"]))
        ids = {row["comment_id"] for row in self.store.list_comments(note["noteId"])}
        self.assertEqual({"comment-kept", "comment-new"}, ids)
        workbook = load_workbook(workbook_path, read_only=True)
        sheet = workbook["sheet2_评论总表"]
        excel_ids = {sheet.cell(row, 3).value for row in range(2, sheet.max_row + 1)}
        workbook.close()
        self.assertEqual({"comment-kept", "comment-new"}, excel_ids)

    def test_note_status_repairs_legacy_excel_media_path(self):
        from openpyxl import load_workbook
        note_id = "legacy123456"
        workbook_path = self.store.export_dir.parent / "legacy-master.xlsx"
        self.store.seed_xlsx_path = workbook_path
        self.store._ensure_seed_workbook(workbook_path)
        actual_folder = workbook_path.parent / "posts_materials" / "旧标题"
        actual_folder.mkdir(parents=True)
        (actual_folder / "旧标题-图1.jpg").write_bytes(b"image")
        workbook = load_workbook(workbook_path)
        sheet = workbook["sheet1_笔记总表"]
        headers = {str(cell.value): cell.column for cell in sheet[1] if cell.value}
        row = sheet.max_row + 1
        sheet.cell(row, headers["笔记ID"]).value = note_id
        sheet.cell(row, headers["笔记标题"]).value = "旧标题"
        sheet.cell(row, headers["笔记url"]).value = f"https://www.xiaohongshu.com/explore/{note_id}"
        sheet.cell(row, headers["对应帖子文件夹地址"]).value = "C:/removed-root/posts_materials/旧标题"
        sheet.cell(row, headers["文件夹内清单"]).value = "旧标题-图1.jpg"
        workbook.save(workbook_path)
        workbook.close()
        self.store.seed_from_xlsx(workbook_path)
        result = self.store.note_status(note_id)
        self.assertTrue(result["inExcel"])
        self.assertEqual(str(actual_folder.resolve()), result["mediaDir"])
        self.assertEqual(["旧标题-图1.jpg"], result["mediaFiles"])
        self.assertGreater(result["excelRow"], 1)

    def test_excel_artifact_index_is_reused_until_workbook_changes(self):
        from openpyxl import load_workbook
        from unittest.mock import patch
        note_id = "cache123456"
        workbook_path = self.store.export_dir.parent / "cache-master.xlsx"
        self.store.seed_xlsx_path = workbook_path
        self.store._ensure_seed_workbook(workbook_path)
        workbook = load_workbook(workbook_path)
        sheet = workbook["sheet1_笔记总表"]
        headers = {str(cell.value): cell.column for cell in sheet[1] if cell.value}
        row = sheet.max_row + 1
        sheet.cell(row, headers["笔记ID"]).value = note_id
        sheet.cell(row, headers["对应帖子文件夹地址"]).value = "C:/materials/cache123456"
        sheet.cell(row, headers["文件夹内清单"]).value = "image-01.jpg"
        workbook.save(workbook_path)
        workbook.close()

        with patch("openpyxl.load_workbook", wraps=load_workbook) as mocked_load:
            first = self.store._excel_note_artifacts(note_id)
            second = self.store._excel_note_artifacts(note_id)
            self.assertEqual(first, second)
            self.assertEqual(1, mocked_load.call_count)

            workbook = load_workbook(workbook_path)
            sheet = workbook["sheet1_笔记总表"]
            sheet.cell(row, headers["文件夹内清单"]).value = "image-01.jpg\nimage-02.jpg"
            workbook.save(workbook_path)
            workbook.close()
            refreshed = self.store._excel_note_artifacts(note_id)
            self.assertEqual(["image-01.jpg", "image-02.jpg"], refreshed[1])
            self.assertEqual(2, mocked_load.call_count)

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


if __name__ == "__main__":
    unittest.main()
