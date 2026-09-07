"""Read-only overview regressions. Every DB, CSV and image is a temp fixture.

Run: python -B -m unittest discover -s bridge -p test_overview_media.py -v
No live bridge, production config/data, downloads or browser is required.
"""
import base64
from contextlib import contextmanager
import hashlib
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
import json
import os
from pathlib import Path
import sqlite3
import stat
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from urllib.parse import urlencode

import overview_media as media
import server as bridge_server
from data_overview import build_field_specs, compile_filter_group, compile_sort
from server import BridgeHandler, MonitorStore


PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1sAAAAASUVORK5CYII=")
GIF = base64.b64decode("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7")
POST_URL = "https://sns-webpic-qc.xhscdn.com/post.png"
COMMENT_URL = "https://ci.xiaohongshu.com/comment.png"
REPLY_URL = "https://sns-img-qc.xhscdn.com/reply.png"
NOTE_ID = "overview-note-alpha"
COMMENT_ID = "overview-comment-alpha"
EXTENSION_ORIGIN = "chrome-extension://" + "a" * 32


class OverviewMediaTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="overview-media-fixture-")
        self.root = Path(self.temporary.name)
        self.store = MonitorStore(self.root / "fixture.sqlite3", self.root / "exports")
        # Keep origin tests independent of any locally installed native host.
        self.origins = patch.object(bridge_server, "allowed_extension_origins", return_value=set())
        self.origins.start()
        self.addCleanup(self.origins.stop)
        self.addCleanup(self.temporary.cleanup)

    def note(self, note_id=NOTE_ID, payload=None, *, folder=True, url=None):
        directory = self.store._media_root() / f"旧标题__{note_id}"
        if folder:
            directory.mkdir(parents=True, exist_ok=True)
        with self.store._session() as db:
            db.execute(
                "INSERT INTO notes(note_id,url,title,first_seen_at,last_seen_at,status,source,pull_status,"
                "media_dir,payload_json) VALUES(?,?,?,?,?,?,?,?,?,?)",
                (note_id, url if url is not None else f"https://www.xiaohongshu.com/explore/{note_id}?xsec_token=stored",
                 "数据库帖子标题", "2026-08-01", "2026-08-02", "confirmed", "dom", "synced",
                 str(directory) if folder else "", json.dumps(payload or {}, ensure_ascii=False)),
            )
        return directory

    def comment(self, comment_id=COMMENT_ID, note_id=NOTE_ID, payload=None, *, parent="", deleted=False):
        with self.store._session() as db:
            db.execute(
                "INSERT INTO comments(comment_id,note_id,parent_comment_id,content,author,published_at,"
                "comment_level,first_seen_at,last_seen_at,is_deleted,comment_status,payload_json) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                (comment_id, note_id, parent, "数据库评论正文", "数据库评论作者", "昨天 13:20",
                 2 if parent else 1, "2026-08-01", "2026-08-02", int(deleted),
                 "已删除" if deleted else "存在", json.dumps(payload or {}, ensure_ascii=False)),
            )

    def manifest(self, folder, **fields):
        (folder / "note.json").write_text(json.dumps(fields, ensure_ascii=False), encoding="utf-8")

    def preview(self, dataset="notes", record_id=NOTE_ID):
        return self.store.data_overview_media(dataset, record_id)

    def image_bytes(self, listing, index=0):
        result = self.store.data_overview_media(listing["dataset"], listing["recordId"], index, listing["revision"])
        self.assertEqual(listing["revision"], result["revision"])
        return base64.b64decode(result["dataUrl"].split(",", 1)[1])

    def empty(self, dataset="notes", record_id=NOTE_ID):
        result = self.preview(dataset, record_id)
        self.assertTrue(result["ok"])
        self.assertEqual([], result["items"])
        self.assertTrue(result["missingReason"])
        self.assertIn("revision", result)
        return result

    def snapshot(self):
        return {str(path.relative_to(self.root)): (path.stat().st_size, path.stat().st_mtime_ns,
                                                  hashlib.sha256(path.read_bytes()).hexdigest())
                for path in self.root.rglob("*") if path.is_file()}

    @contextmanager
    def http(self):
        class QuietHandler(BridgeHandler):
            def log_message(self, *_args):
                pass
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), QuietHandler)
        httpd.store = self.store
        thread = threading.Thread(target=httpd.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        thread.start()

        def request(path, *, origin=None, method="GET"):
            connection = HTTPConnection("127.0.0.1", httpd.server_port, timeout=5)
            try:
                connection.request(method, path, headers={"Origin": origin} if origin is not None else {})
                response = connection.getresponse()
                raw = response.read()
                return response.status, dict(response.getheaders()), json.loads(raw) if raw else {}
            finally:
                connection.close()
        try:
            yield request
        finally:
            httpd.shutdown()
            httpd.server_close()
            thread.join(timeout=5)

    def test_catalogue_action_and_exact_primary_id_projection(self):
        self.note()
        self.comment(parent="uncollected-root")
        with self.store._session() as db:
            for dataset, expected, table in (("notes", NOTE_ID, "notes n"),
                                             ("comments", COMMENT_ID, "comments c JOIN notes n ON n.note_id=c.note_id")):
                specs = {field.key: field for field in build_field_specs(db, dataset)}
                spec = specs["media_preview"]
                self.assertEqual("text", spec.data_type)
                self.assertTrue(spec.default_visible)
                self.assertEqual("preview_media", spec.action)
                self.assertFalse(spec.filterable)
                self.assertFalse(spec.sortable)
                self.assertFalse(spec.suggest_values)
                self.assertEqual(expected, db.execute(f"SELECT {spec.expression} FROM {table}").fetchone()[0])
                with self.assertRaises(ValueError):
                    compile_filter_group({"children": [{"field": "media_preview", "operator": "eq", "value": "x"}]}, specs)
                self.assertEqual(compile_sort([], specs, dataset),
                                 compile_sort([{"field": "media_preview", "direction": "asc"}], specs, dataset))

    def test_existing_query_gate_still_required_and_preview_does_not_issue_tokens(self):
        self.note(payload={"imageUrls": [POST_URL]})
        self.comment(payload={"imageUrls": [COMMENT_URL]})
        self.preview()
        self.store.data_overview_comment_target(COMMENT_ID)
        self.assertEqual({}, self.store._data_overview_approved_tokens)
        with self.assertRaises(ValueError):
            self.store.query_data_overview({"dataset": "notes"})
        self.store._data_overview_approved_tokens["stale"] = time.time() - 1801
        with self.assertRaises(ValueError):
            self.store.query_data_overview({"dataset": "notes", "snapshotToken": "stale"})
        self.store._data_overview_approved_tokens["approved"] = time.time()
        with patch.object(self.store, "_data_overview_snapshot_token", return_value="changed"):
            with self.assertRaises(ValueError):
                self.store.query_data_overview({"dataset": "notes", "snapshotToken": "approved"})
        self.store._data_overview_approved_tokens["approved"] = time.time()
        with patch.object(self.store, "_data_overview_snapshot_token", return_value="approved"):
            for dataset, expected in (("notes", NOTE_ID), ("comments", COMMENT_ID)):
                result = self.store.query_data_overview({"dataset": dataset, "snapshotToken": "approved"})
                self.assertTrue(result["consistentSnapshot"])
                self.assertEqual(expected, result["rows"][0]["media_preview"])
                with self.assertRaises(ValueError):
                    self.store.data_overview_values({"dataset": dataset, "snapshotToken": "approved", "field": "media_preview"})

    def test_comment_and_reply_images_never_fall_back_to_post_or_parent(self):
        folder = self.note(payload={"imageUrls": [POST_URL]})
        (folder / "image-01.png").write_bytes(PNG)
        self.manifest(folder, noteId=NOTE_ID, imageUrls=[POST_URL], mediaFiles=["image-01.png"])
        self.comment(payload={"imageUrls": [COMMENT_URL]})
        self.comment("reply-empty", parent=COMMENT_ID)
        self.comment("reply-image", parent=COMMENT_ID, payload={"imageUrls": [REPLY_URL]})
        self.assertEqual([COMMENT_URL], [item["url"] for item in self.preview("comments", COMMENT_ID)["items"]])
        self.empty("comments", "reply-empty")
        self.assertEqual([REPLY_URL], [item["url"] for item in self.preview("comments", "reply-image")["items"]])

    def test_comment_uses_only_own_image_urls_not_avatar_or_media_files(self):
        folder = self.note()
        (folder / "comment.png").write_bytes(PNG)
        self.comment(payload={"avatar": COMMENT_URL, "avatarUrl": COMMENT_URL,
                              "mediaFiles": ["comment.png"], "images": [COMMENT_URL],
                              "note": {"imageUrls": [POST_URL]}})
        self.empty("comments", COMMENT_ID)

    def test_comment_explicit_local_reference_is_scoped_to_own_note(self):
        folder = self.note()
        other = self.note("another-note")
        (folder / "comment-attachment.png").write_bytes(PNG)
        (other / "comment-attachment.png").write_bytes(GIF)
        self.comment(payload={"imageUrls": ["comment-attachment.png"]})
        listing = self.preview("comments", COMMENT_ID)
        self.assertEqual(PNG, self.image_bytes(listing))
        self.empty("notes", NOTE_ID)

    def test_post_mapping_uses_manifest_numbering_not_reordered_payload(self):
        folder = self.note(payload={"imageUrls": [REPLY_URL, POST_URL]})
        (folder / "image-01.png").write_bytes(PNG)
        (folder / "image-02.gif").write_bytes(GIF)
        self.manifest(folder, noteId=NOTE_ID, imageUrls=[POST_URL, REPLY_URL],
                      mediaFiles=["image-01.png", "image-02.gif"])
        listing = self.preview()
        self.assertEqual(["local", "local"], [item["source"] for item in listing["items"]])
        self.assertEqual(GIF, self.image_bytes(listing, 0))
        self.assertEqual(PNG, self.image_bytes(listing, 1))
        self.assertEqual([0, 1], [item["index"] for item in listing["items"]])
        for item in listing["items"]:
            self.assertEqual({"source", "index", "label"}, set(item))

    def test_legacy_names_and_manifest_images_exclude_comment_attachments(self):
        folder = self.note(payload={"mediaFiles": ["存档照片.png", "comment-private.png", "视频.mp4"]})
        for name in ("旧标题-图1.jpg", "存档照片.png", "评论-图1.png", "reply-image.png",
                     "comment-private.png", "avatar.png", "unknown.png", "视频.mp4"):
            (folder / name).write_bytes(PNG)
        listing = self.preview()
        self.assertEqual(2, len(listing["items"]))
        self.assertEqual(PNG, self.image_bytes(listing))

    def test_mismatched_manifest_does_not_supply_foreign_images(self):
        folder = self.note(payload={"imageUrls": [POST_URL]})
        (folder / "image-01.png").write_bytes(PNG)
        self.manifest(folder, noteId="another-note", imageUrls=[REPLY_URL], mediaFiles=["image-01.png"])
        listing = self.preview()
        self.assertEqual([POST_URL], [item["url"] for item in listing["items"]])
        self.assertEqual("remote", listing["items"][0]["source"])

    def test_shared_legacy_directory_has_no_local_preview(self):
        folder = self.note()
        self.note("another-note", folder=False)
        (folder / "旧标题-图1.jpg").write_bytes(PNG)
        with self.store._session() as db:
            db.execute("UPDATE notes SET media_dir=? WHERE note_id='another-note'", (str(folder),))
        self.empty()
        self.empty("notes", "another-note")

    def test_legacy_http_platform_cdn_is_upgraded_without_rewriting_record(self):
        from overview_media import _remote_url
        old = "http://sns-webpic-qc.xhscdn.com/fixture.png?signature=keep"
        self.assertEqual("https://sns-webpic-qc.xhscdn.com/fixture.png?signature=keep", _remote_url(old))
        self.assertEqual("", _remote_url("http://sns-webpic-qc.xhscdn.com.evil.test/a.png"))
        self.assertEqual("", _remote_url("http://user@xhscdn.com/a.png"))
        self.assertEqual("https://xhscdn.com/a.png", _remote_url("http://xhscdn.com:80/a.png"))

    def test_remote_whitelist_and_no_remote_byte_loading(self):
        allowed = [POST_URL, COMMENT_URL, "https://xhscdn.com/a.jpg", "https://xiaohongshu.com:443/b.png"]
        rejected = ["http://xhscdn.com:8000/a.png", "https://xhscdn.com.evil.test/a.png",
                    "https://evilxhscdn.com/a.png", "https://xhscdn.com@evil.test/a.png",
                    "https://user:secret@xhscdn.com/a.png", "https://xhscdn.com:444/a.png",
                    "//xhscdn.com/a.png", "https://127.0.0.1/a.png", "https://xhscdn.com\\@evil/a.png",
                    "https://xhscdn.com/\na.png", " https://xhscdn.com/a.png", "javascript:alert(1)",
                    "data:image/png;base64,abc", "https://xhscdn.com.:443/a.png"]
        self.note(payload={"imageUrls": allowed + rejected + [POST_URL]}, folder=False)
        with patch("urllib.request.urlopen", side_effect=AssertionError("network forbidden")), \
                patch.object(bridge_server, "urlopen", side_effect=AssertionError("network forbidden")):
            listing = self.preview()
            self.assertEqual(allowed, [item["url"] for item in listing["items"]])
            with self.assertRaisesRegex(ValueError, "remote"):
                self.image_bytes(listing)

    def test_empty_malformed_and_deleted_history(self):
        self.note(folder=False)
        self.empty()
        self.empty("notes", "uncollected-note")
        self.comment(payload={"imageUrls": [COMMENT_URL]}, deleted=True)
        listing = self.preview("comments", COMMENT_ID)
        self.assertEqual(COMMENT_URL, listing["items"][0]["url"])
        with self.store._session() as db:
            db.execute("UPDATE notes SET is_deleted=1 WHERE note_id=?", (NOTE_ID,))
            db.execute("UPDATE comments SET payload_json='[null]' WHERE comment_id=?", (COMMENT_ID,))
        self.empty("comments", COMMENT_ID)
        with self.store._session() as db:
            db.execute("UPDATE comments SET payload_json='{broken' WHERE comment_id=?", (COMMENT_ID,))
        self.empty("comments", COMMENT_ID)

    def test_stale_folder_is_not_searched_or_repaired(self):
        self.note()
        with self.store._session() as db:
            db.execute("UPDATE notes SET media_dir=? WHERE note_id=?", (str(self.root / "gone"), NOTE_ID))
        with patch.object(self.store, "_resolve_legacy_media_dir", side_effect=AssertionError("repair forbidden")):
            self.empty()

    def test_exact_ids_and_orphan_comments(self):
        self.note(payload={"imageUrls": [POST_URL]})
        self.comment()
        self.comment("orphan-comment", note_id="missing-note", payload={"imageUrls": [COMMENT_URL]})
        for record_id in (NOTE_ID[:8], NOTE_ID.upper(), NOTE_ID + "' OR 1=1 --"):
            self.empty("notes", record_id)
        self.empty("comments", "orphan-comment")
        with self.assertRaisesRegex(ValueError, "record_not_found"):
            self.store.data_overview_comment_target("orphan-comment")

    def test_conflicting_note_comment_and_url_identities_are_rejected(self):
        self.note()
        self.comment()
        conflicts = [{"noteId": "other-note"}, {"note_id": "other-note"},
                     {"commentId": "other-comment"}, {"comment_id": "other-comment"},
                     {"url": "https://www.xiaohongshu.com/explore/other-note"},
                     {"note": {"noteId": "other-note"}}]
        for conflict in conflicts:
            with self.subTest(conflict=conflict):
                with self.store._session() as db:
                    db.execute("UPDATE comments SET payload_json=? WHERE comment_id=?",
                               (json.dumps({**conflict, "imageUrls": [COMMENT_URL]}), COMMENT_ID))
                self.empty("comments", COMMENT_ID)
                with self.assertRaisesRegex(ValueError, "identity"):
                    self.store.data_overview_comment_target(COMMENT_ID)
        with self.store._session() as db:
            db.execute("UPDATE notes SET payload_json=? WHERE note_id=?",
                       (json.dumps({"noteId": "wrong-note", "imageUrls": [POST_URL]}), NOTE_ID))
        self.empty()

    def test_cross_post_parent_is_rejected_but_missing_parent_is_allowed(self):
        self.note()
        self.note("another-note")
        self.comment("foreign-parent", "another-note")
        self.comment(parent="foreign-parent", payload={"imageUrls": [COMMENT_URL]})
        self.empty("comments", COMMENT_ID)
        with self.assertRaisesRegex(ValueError, "parent"):
            self.store.data_overview_comment_target(COMMENT_ID)
        with self.store._session() as db:
            db.execute("UPDATE comments SET parent_comment_id='uncollected' WHERE comment_id=?", (COMMENT_ID,))
        self.assertEqual(COMMENT_URL, self.preview("comments", COMMENT_ID)["items"][0]["url"])
        self.assertEqual("uncollected", self.store.data_overview_comment_target(COMMENT_ID)["comment"]["parentCommentId"])

    def test_absolute_traversal_ads_and_non_image_paths_are_rejected(self):
        folder = self.note()
        outside = self.root / "secret.png"
        outside.write_bytes(PNG)
        (folder / "secret.png").write_bytes(PNG)
        (folder / "fake.png").write_text("<svg><script>alert(1)</script></svg>", encoding="utf-8")
        (folder / "secret.svg").write_bytes(PNG)
        (folder / "secret.txt").write_bytes(PNG)
        attacks = [str(outside), str(folder / "secret.png"), "../secret.png", "..\\secret.png",
                   "sub/../../secret.png", "sub/../secret.png", "./secret.png", "sub//secret.png",
                   "/secret.png", "C:\\secret.png", "C:secret.png", "\\\\HOST\\share\\secret.png",
                   "file:///secret.png", "secret.png:stream", "NUL.png", "secret.svg", "secret.txt", "fake.png"]
        for path in attacks:
            with self.subTest(path=path):
                with self.store._session() as db:
                    db.execute("UPDATE notes SET payload_json=? WHERE note_id=?",
                               (json.dumps({"mediaFiles": [path], "imageUrls": [path]}), NOTE_ID))
                self.empty()

    def test_directory_anchor_rejects_external_root_and_parent_traversal(self):
        folder = self.note()
        external = self.root / "external"
        external.mkdir()
        (external / "image-01.png").write_bytes(PNG)
        (self.store._media_root() / "image-01.png").write_bytes(PNG)
        for value in (str(external), str(self.store._media_root()), str(folder / ".." / folder.name)):
            with self.subTest(folder=value):
                with self.store._session() as db:
                    db.execute("UPDATE notes SET media_dir=? WHERE note_id=?", (value, NOTE_ID))
                self.empty()

    def test_different_note_suffix_rejects_stale_directory_even_without_manifest(self):
        self.note()
        foreign = self.store._media_root() / "历史标题__deleted-other-note"
        foreign.mkdir()
        (foreign / "image-01.png").write_bytes(PNG)
        with self.store._session() as db:
            db.execute("UPDATE notes SET media_dir=? WHERE note_id=?", (str(foreign), NOTE_ID))
        self.empty()

    def test_symlink_or_windows_junction_escape_is_rejected(self):
        folder = self.note()
        external = self.root / "outside"
        external.mkdir()
        (external / "image-01.png").write_bytes(PNG)
        link = folder / "image-01.png"
        try:
            link.symlink_to(external / "image-01.png")
        except OSError as exc:
            if os.name != "nt" or getattr(exc, "winerror", None) != 1314:
                raise
            # Windows often denies unprivileged file symlinks. A real directory
            # junction exercises the same escape/reparse boundary without an
            # elevation, subprocess, or a skipped security test.
            import _winapi
            nested = folder / "nested"
            _winapi.CreateJunction(str(external), str(nested))
            with self.store._session() as db:
                db.execute("UPDATE notes SET payload_json=? WHERE note_id=?",
                           (json.dumps({"mediaFiles": ["nested/image-01.png"]}), NOTE_ID))
            self.empty()
            with self.store._session() as db:
                db.execute("UPDATE notes SET media_dir=? WHERE note_id=?", (str(nested), NOTE_ID))
            self.empty()
            return
        self.empty()
        directory_link = self.store._media_root() / "linked-note"
        directory_link.symlink_to(external, target_is_directory=True)
        with self.store._session() as db:
            db.execute("UPDATE notes SET media_dir=? WHERE note_id=?", (str(directory_link), NOTE_ID))
        self.empty()

    def test_reparse_points_and_hardlinks_are_rejected(self):
        folder = self.note()
        external = self.root / "outside.png"
        external.write_bytes(PNG)
        os.link(external, folder / "image-01.png")
        self.empty()
        class ReparseStat:
            st_mode = stat.S_IFREG
            st_file_attributes = 0x400
        with patch.object(Path, "lstat", return_value=ReparseStat()):
            with self.assertRaises(ValueError):
                media._no_link(folder / "image-01.png")
        class SymlinkStat:
            st_mode = stat.S_IFLNK
            st_file_attributes = 0
        with patch.object(Path, "lstat", return_value=SymlinkStat()):
            with self.assertRaises(ValueError):
                media._no_link(folder / "image-01.png")

    def test_empty_oversized_and_exact_8_mib_images(self):
        folder = self.note()
        (folder / "image-01.png").write_bytes(b"")
        self.empty()
        big = PNG + b"\0" * (media.MAX_IMAGE_BYTES + 1 - len(PNG))
        (folder / "image-01.png").write_bytes(big)
        self.empty()
        (folder / "image-01.png").write_bytes(big[:-1])
        listing = self.preview()
        self.assertEqual(media.MAX_IMAGE_BYTES, len(self.image_bytes(listing)))

    def test_all_supported_raster_headers_and_mime_not_extension(self):
        samples = [(PNG, "image/png"), (GIF, "image/gif"), (b"\xff\xd8\xff\xe0" + b"\0" * 24, "image/jpeg"),
                   (b"RIFF" + b"\0" * 4 + b"WEBPVP8L" + b"\0" * 16, "image/webp"),
                   (b"BM" + b"\0" * 24, "image/bmp"),
                   (b"\0\0\0\x18ftypavif\0\0\0\0avifmif1", "image/avif")]
        for header, expected in samples:
            self.assertEqual(expected, media._raster_mime(header))
        for header in (b"<svg>...</svg>", b"<html>hello", b"not-image", b"RIFF0000WAVE0000"):
            self.assertEqual("", media._raster_mime(header))
        folder = self.note()
        (folder / "image-01.jpg").write_bytes(PNG)
        listing = self.preview()
        result = self.store.data_overview_media("notes", NOTE_ID, 0, listing["revision"])
        self.assertTrue(result["dataUrl"].startswith("data:image/png;base64,"))

    def test_metadata_is_lazy_and_stable_revision(self):
        folder = self.note()
        (folder / "image-01.png").write_bytes(PNG)
        with patch.object(media.base64, "b64encode", side_effect=AssertionError("metadata must not encode image bytes")), \
                patch.object(media, "_read_local", wraps=media._read_local) as reads:
            first = self.preview()
            second = self.preview()
        self.assertEqual(first, second)
        self.assertRegex(first["revision"], r"^[0-9a-f]{64}$")
        image_reads = [call for call in reads.call_args_list if call.args[1].endswith(".png")]
        self.assertTrue(image_reads)
        self.assertTrue(all(call.kwargs.get("header_only") for call in image_reads))

    def test_index_requires_revision_and_rejects_invalid_query_values(self):
        folder = self.note()
        (folder / "image-01.png").write_bytes(PNG)
        listing = self.preview()
        for index in (-1, "-1", "0.0", "", "1e0", " 0", "0000000", True, 0.2, "../secret", "０"):
            with self.subTest(index=index), self.assertRaises(ValueError):
                self.store.data_overview_media("notes", NOTE_ID, index, listing["revision"])
        for revision in (None, "", "wrong", "A" * 64, "0" * 64):
            with self.subTest(revision=revision), self.assertRaises(ValueError):
                self.store.data_overview_media("notes", NOTE_ID, 0, revision)
        with self.assertRaises(ValueError):
            self.image_bytes(listing, 1)
        for dataset, record_id in (("all", NOTE_ID), ("notes", ""), ("notes", NOTE_ID + " "), ("notes", "a" * 257)):
            with self.assertRaises(ValueError):
                self.preview(dataset, record_id)

    def test_revision_rejects_reorder_and_file_replacement(self):
        folder = self.note(payload={"imageUrls": ["image-01.png", "image-02.gif"]})
        (folder / "image-01.png").write_bytes(PNG)
        (folder / "image-02.gif").write_bytes(GIF)
        listing = self.preview()
        with self.store._session() as db:
            db.execute("UPDATE notes SET payload_json=? WHERE note_id=?",
                       (json.dumps({"imageUrls": ["image-02.gif", "image-01.png"]}), NOTE_ID))
        with self.assertRaisesRegex(ValueError, "revision"):
            self.image_bytes(listing)
        fresh = self.preview()
        self.assertEqual(GIF, self.image_bytes(fresh))
        (folder / "image-02.gif").write_bytes(PNG)
        with self.assertRaisesRegex(ValueError, "revision"):
            self.image_bytes(fresh)

    def test_revision_rejects_mtime_change_disappearance_and_record_deletion(self):
        folder = self.note()
        image = folder / "image-01.png"
        image.write_bytes(PNG)
        listing = self.preview()
        info = image.stat()
        os.utime(image, ns=(info.st_atime_ns, info.st_mtime_ns + 1_000_000_000))
        with self.assertRaisesRegex(ValueError, "revision"):
            self.image_bytes(listing)
        fresh = self.preview()
        image.unlink()
        with self.assertRaisesRegex(ValueError, "revision"):
            self.image_bytes(fresh)
        with self.store._session() as db:
            db.execute("DELETE FROM notes WHERE note_id=?", (NOTE_ID,))
        with self.assertRaisesRegex(ValueError, "record_not_found"):
            self.image_bytes(fresh)
        self.empty()

    def test_revision_is_bound_to_dataset_record_and_note_relationship(self):
        folder = self.note()
        self.note("another-note")
        (folder / "comment.png").write_bytes(PNG)
        self.comment(payload={"imageUrls": ["comment.png"]})
        listing = self.preview("comments", COMMENT_ID)
        self.comment("other-comment", payload={"imageUrls": ["comment.png"]})
        with self.assertRaisesRegex(ValueError, "revision"):
            self.store.data_overview_media("comments", "other-comment", 0, listing["revision"])
        with self.store._session() as db:
            db.execute("UPDATE comments SET note_id='another-note' WHERE comment_id=?", (COMMENT_ID,))
        with self.assertRaisesRegex(ValueError, "revision"):
            self.image_bytes(listing)

    def test_revision_is_rechecked_on_open_after_metadata_validation(self):
        folder = self.note()
        target = folder / "image-01.png"
        target.write_bytes(PNG)
        listing = self.preview()
        original = media._image

        def replaced(scope, name, **kwargs):
            if kwargs.get("full"):
                target.write_bytes(GIF)
            return original(scope, name, **kwargs)

        with patch.object(media, "_image", side_effect=replaced):
            with self.assertRaisesRegex(ValueError, "changed|unavailable"):
                self.image_bytes(listing)

    def test_read_only_files_database_network_and_tokens(self):
        folder = self.note(payload={"imageUrls": [POST_URL]})
        (folder / "image-01.png").write_bytes(PNG)
        self.manifest(folder, noteId=NOTE_ID, imageUrls=[POST_URL], mediaFiles=["image-01.png"])
        self.comment(payload={"imageUrls": [COMMENT_URL]})
        (self.root / "sentinel.csv").write_text("untouched,业务内容\n", encoding="utf-8")
        before = self.snapshot()
        statements = []
        connect = sqlite3.connect

        def read_connection(*args, **kwargs):
            self.assertIn("?mode=ro", args[0])
            self.assertTrue(kwargs["uri"])
            db = connect(*args, **kwargs)
            db.set_trace_callback(statements.append)
            return db

        with patch.object(media.sqlite3, "connect", side_effect=read_connection), \
                patch.object(self.store, "_connect", side_effect=AssertionError("no writable connection")), \
                patch.object(self.store, "_session", side_effect=AssertionError("no writable session")), \
                patch.object(self.store, "data_health", side_effect=AssertionError("no consistency repair")), \
                patch.object(self.store, "_csv_paths", side_effect=AssertionError("no CSV reads/repair")), \
                patch.object(self.store, "_download_note_media", side_effect=AssertionError("no download")), \
                patch.object(bridge_server, "urlopen", side_effect=AssertionError("no network")):
            self.image_bytes(self.preview())
            self.preview("comments", COMMENT_ID)
            self.store.data_overview_comment_target(COMMENT_ID)
        self.assertEqual(before, self.snapshot())
        self.assertEqual({}, self.store._data_overview_approved_tokens)
        self.assertTrue(statements)
        self.assertTrue(all(sql.startswith(("SELECT", "PRAGMA query_only=ON", "BEGIN")) for sql in statements))
        self.assertTrue(all("WHERE" in sql for sql in statements if sql.startswith("SELECT")))

    def test_missing_database_is_not_created(self):
        missing = self.root / "missing.sqlite3"
        with self.assertRaises(sqlite3.OperationalError):
            media.read_overview_media(missing, self.root, "notes", NOTE_ID)
        self.assertFalse(missing.exists())

    def test_existing_locks_cover_database_and_local_image_read(self):
        folder = self.note()
        (folder / "image-01.png").write_bytes(PNG)
        self.comment()
        database = media._database
        local = media._read_local

        def locked(fn):
            def run(*args, **kwargs):
                self.assertTrue(self.store.pull_lock._is_owned())
                self.assertTrue(self.store.lock._is_owned())
                return fn(*args, **kwargs)
            return run
        with patch.object(media, "_database", side_effect=locked(database)), \
                patch.object(media, "_read_local", side_effect=locked(local)):
            self.image_bytes(self.preview())
            self.store.data_overview_comment_target(COMMENT_ID)

    def test_comment_target_returns_exact_database_fields_and_deleted_history(self):
        self.note(payload={"imageUrls": [POST_URL]})
        self.comment(parent="absent-root", deleted=True,
                     payload={"commentId": COMMENT_ID, "noteId": NOTE_ID, "content": "payload非权威正文",
                              "author": "payload非权威作者", "imageUrls": [COMMENT_URL]})
        before = self.snapshot()
        result = self.store.data_overview_comment_target(COMMENT_ID)
        self.assertEqual({"ok", "note", "comment", "isDeleted"}, set(result))
        self.assertTrue(result["isDeleted"])
        self.assertEqual({"noteId": NOTE_ID, "title": "数据库帖子标题",
                          "url": f"https://www.xiaohongshu.com/explore/{NOTE_ID}?xsec_token=stored"}, result["note"])
        self.assertEqual({"commentId": COMMENT_ID, "noteId": NOTE_ID, "parentCommentId": "absent-root",
                          "content": "数据库评论正文", "author": "数据库评论作者", "publishedAt": "昨天 13:20",
                          "imageUrls": [COMMENT_URL]}, result["comment"])
        self.assertEqual(before, self.snapshot())

    def test_comment_target_empty_images_and_missing_or_inexact_id(self):
        self.note(payload={"imageUrls": [POST_URL]})
        self.comment()
        self.assertEqual([], self.store.data_overview_comment_target(COMMENT_ID)["comment"]["imageUrls"])
        for comment_id in (COMMENT_ID[:8], COMMENT_ID.upper(), COMMENT_ID + "' OR 1=1 --", "missing", ""):
            with self.assertRaises(ValueError):
                self.store.data_overview_comment_target(comment_id)

    def test_only_documented_24hex_comment_prefix_alias_is_accepted(self):
        self.note()
        raw = "abcdef0123456789abcdef01"
        prefixed = "comment-" + raw
        for stored, payload_id in ((raw, raw), (prefixed, raw), (raw, prefixed), (prefixed, prefixed)):
            with self.subTest(stored=stored, payload_id=payload_id):
                with self.store._session() as db:
                    db.execute("DELETE FROM comments")
                self.comment(stored, payload={"commentId": payload_id, "comment_id": payload_id,
                                               "noteId": NOTE_ID, "imageUrls": [COMMENT_URL]})
                target = self.store.data_overview_comment_target(stored)
                self.assertEqual(stored, target["comment"]["commentId"])
                self.assertEqual(COMMENT_URL, self.preview("comments", stored)["items"][0]["url"])
                if stored == prefixed and payload_id == raw:
                    self.assertEqual(raw, target["comment"]["rawCommentId"])
                    # Alias acceptance validates payload ownership, not SQL lookup.
                    with self.assertRaisesRegex(ValueError, "record_not_found"):
                        self.store.data_overview_comment_target(raw)

    def test_comment_alias_does_not_casefold_truncate_or_strip_other_prefixes(self):
        self.note()
        raw = "abcdef0123456789abcdef01"
        prefixed = "comment-" + raw
        self.comment(prefixed)
        rejected = [raw.upper(), raw[:-1] + "2", raw[:-1], raw + "0", "comment-" + prefixed,
                    "Comment-" + raw, "dom-" + raw, " " + raw, raw + " "]
        for payload_id in rejected:
            with self.subTest(payload_id=payload_id):
                with self.store._session() as db:
                    db.execute("UPDATE comments SET payload_json=? WHERE comment_id=?",
                               (json.dumps({"commentId": payload_id, "imageUrls": [COMMENT_URL]}), prefixed))
                self.empty("comments", prefixed)
                with self.assertRaisesRegex(ValueError, "identity"):
                    self.store.data_overview_comment_target(prefixed)
        self.comment("comment-short", payload={"commentId": "short", "imageUrls": [COMMENT_URL]})
        self.empty("comments", "comment-short")

    def test_parent_prefix_alias_still_checks_cross_note_relationship(self):
        self.note()
        self.note("another-note")
        raw = "abcdef0123456789abcdef01"
        self.comment("comment-" + raw, "another-note")
        self.comment(parent=raw, payload={"imageUrls": [COMMENT_URL]})
        self.empty("comments", COMMENT_ID)
        with self.assertRaisesRegex(ValueError, "parent"):
            self.store.data_overview_comment_target(COMMENT_ID)

    def test_http_contract_revision_and_strict_parameters(self):
        folder = self.note()
        (folder / "image-01.png").write_bytes(PNG)
        self.comment()
        with self.http() as request:
            base = "/api/data-overview/media?" + urlencode({"dataset": "notes", "recordId": NOTE_ID})
            status, headers, listing = request(base)
            self.assertEqual(200, status)
            self.assertEqual("no-store", headers["Cache-Control"])
            self.assertNotEqual("*", headers["Access-Control-Allow-Origin"])
            status, _, result = request(base + "&index=0&revision=" + listing["revision"])
            self.assertEqual(200, status)
            self.assertEqual(PNG, base64.b64decode(result["dataUrl"].split(",", 1)[1]))
            status, _, result = request("/api/data-overview/comment-target?" + urlencode({"commentId": COMMENT_ID}))
            self.assertEqual(200, status)
            self.assertEqual(COMMENT_ID, result["comment"]["commentId"])
            for suffix in ("&index=0", "&index=", "&recordId=other", "&dataset=comments", "&path=C:/secret.png"):
                self.assertEqual(400, request(base + suffix)[0])
            for query in ("commentId=" + COMMENT_ID + "&content=spoof", "commentId=" + COMMENT_ID + "&commentId=other"):
                self.assertEqual(400, request("/api/data-overview/comment-target?" + query)[0])

    def test_new_endpoints_reject_untrusted_origins_before_any_store_read(self):
        endpoints = ["/api/data-overview/media?dataset=notes&recordId=" + NOTE_ID,
                     "/api/data-overview/comment-target?commentId=" + COMMENT_ID]
        hostile = ["https://evil.test", "http://localhost.evil.test", "http://127.0.0.1.evil.test", "null",
                   "chrome-extension://" + "q" * 32, EXTENSION_ORIGIN + ".evil.test", "http://localhost:1234"]
        with self.http() as request, \
                patch.object(self.store, "data_overview_media", side_effect=AssertionError("origin must be checked first")), \
                patch.object(self.store, "data_overview_comment_target", side_effect=AssertionError("origin must be checked first")):
            for endpoint in endpoints:
                for origin in hostile:
                    with self.subTest(endpoint=endpoint, origin=origin):
                        status, headers, result = request(endpoint, origin=origin)
                        self.assertEqual(403, status)
                        self.assertFalse(result["ok"])
                        self.assertNotIn("dataUrl", result)
                        self.assertNotEqual("*", headers["Access-Control-Allow-Origin"])
                self.assertEqual(403, request(endpoint, origin="https://evil.test", method="OPTIONS")[0])

    def test_extension_configured_origin_and_legacy_cors_compatibility(self):
        self.note()
        self.comment()
        endpoints = ["/api/data-overview/media?dataset=notes&recordId=" + NOTE_ID,
                     "/api/data-overview/comment-target?commentId=" + COMMENT_ID]
        with self.http() as request, patch.object(bridge_server, "allowed_extension_origins", return_value={"https://trusted.test"}):
            for endpoint in endpoints:
                for origin in (EXTENSION_ORIGIN, "https://trusted.test"):
                    status, headers, _ = request(endpoint, origin=origin)
                    self.assertEqual(200, status)
                    self.assertEqual(origin, headers["Access-Control-Allow-Origin"])
                    self.assertEqual("Origin", headers["Vary"])
                    self.assertEqual(204, request(endpoint, origin=origin, method="OPTIONS")[0])
                self.assertEqual(403, request(endpoint, origin="https://trusted.test.evil.test")[0])
            self.assertEqual(200, request("/api/health", origin="https://evil.test")[0])
            self.assertEqual("*", request("/api/health")[1]["Access-Control-Allow-Origin"])


if __name__ == "__main__":
    unittest.main()
