import json
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from server import MonitorStore


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
        return {"reply": "感谢反馈，我们会进一步核实并跟进。", "rationale": "先承接反馈", "tone": "克制", "risk_notes": []}


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
        self.assertIn("感谢反馈", result["suggestion"]["reply"])


if __name__ == "__main__":
    unittest.main()
