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
