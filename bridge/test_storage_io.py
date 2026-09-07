"""Bounded material replacement retries; temporary files only, no Office or DB."""

import errno
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import call, patch

import server


class MaterialStorageIOTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="material-storage-io-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.real_replace = server.os.replace
        self.sleep = self.enterContext(patch("server.time.sleep"))
        self.office = self.enterContext(patch(
            "server._reopen_saved_office_workbook_read_only",
            side_effect=AssertionError("Material writes must not probe Office")))
        self.enterContext(patch("server.subprocess.run", side_effect=AssertionError("No fixture GUI process")))
        self.enterContext(patch("server.sqlite3.connect", side_effect=AssertionError("No fixture DB access")))
        self.enterContext(patch("server.urlopen", side_effect=AssertionError("No fixture network access")))

    def pair(self, name):
        folder = self.root / name
        folder.mkdir()
        source, target = folder / "new.tmp", folder / "existing.json"
        source.write_bytes(b'"new"')
        target.write_bytes(b'"old"')
        return source, target

    def locked_replace(self, failures):
        attempts = {}

        def replace(source, target):
            for path in (source, target):
                self.assertTrue(Path(path).resolve().is_relative_to(self.root), path)
            target = Path(target)
            attempts[target] = attempts.get(target, 0) + 1
            if attempts[target] <= failures:
                raise PermissionError("Fixture sharing lock")
            return self.real_replace(source, target)

        return replace, attempts

    def test_fast_path_and_two_transient_locks_never_launch_office(self):
        for failures in (0, 2):
            with self.subTest(locks=failures):
                source, target = self.pair(f"locks-{failures}")
                replacement, _ = self.locked_replace(failures)
                self.sleep.reset_mock()
                with patch("server.os.replace", side_effect=replacement) as replace:
                    self.assertEqual(failures + 1, server.replace_material_with_retry(source, target))
                self.assertEqual(failures + 1, replace.call_count)
                self.assertEqual(b'"new"', target.read_bytes())
                self.assertFalse(source.exists())
                self.assertEqual([call(0.025), call(0.05)] if failures else [], self.sleep.call_args_list)
                self.office.assert_not_called()

    def test_permanent_lock_preserves_old_file_and_other_errors_are_not_retried(self):
        for name, error, attempts in (
            ("locked", PermissionError("Permanent fixture lock"), 6),
            ("io-error", OSError(errno.EIO, "Fixture I/O error"), 1),
            ("missing", FileNotFoundError("Missing fixture input"), 1),
        ):
            with self.subTest(error=name):
                source, target = self.pair(name)
                self.sleep.reset_mock()
                with patch("server.os.replace", side_effect=error) as replace:
                    with self.assertRaises(type(error)) as raised:
                        server.replace_material_with_retry(source, target)
                self.assertIs(error, raised.exception)
                self.assertEqual(attempts, replace.call_count)
                self.assertEqual(b'"old"', target.read_bytes())
                self.assertEqual(b'"new"', source.read_bytes())
                delays = [item.args[0] for item in self.sleep.call_args_list]
                self.assertEqual([0.025, 0.05, 0.1, 0.2, 0.4] if attempts == 6 else [], delays)
                self.assertLessEqual(sum(delays), 0.775)
                self.office.assert_not_called()

    def test_json_atomic_uses_helper_and_cleans_temporary_files_after_success_or_failure(self):
        for failures in (2, 6):
            with self.subTest(locks=failures):
                folder = self.root / f"json-{failures}"
                folder.mkdir()
                target = folder / "note.json"
                target.write_bytes(b'{"state":"old"}')
                payload = {"state": "new", "ipLocation": ""}
                replacement, _ = self.locked_replace(failures)
                self.sleep.reset_mock()
                with patch("server.os.replace", side_effect=replacement), patch(
                    "server.replace_material_with_retry", wraps=server.replace_material_with_retry
                ) as helper:
                    if failures == 6:
                        with self.assertRaises(PermissionError):
                            server.MonitorStore._write_json_atomic(target, payload)
                        self.assertEqual(b'{"state":"old"}', target.read_bytes())
                    else:
                        server.MonitorStore._write_json_atomic(target, payload)
                        self.assertEqual(payload, json.loads(target.read_text(encoding="utf-8")))
                    helper.assert_called_once()
                    self.assertEqual(target, helper.call_args.args[1])
                self.assertEqual([target], list(folder.iterdir()))
                self.office.assert_not_called()

    def test_media_json_text_and_checkpoint_journal_all_use_bounded_material_retries(self):
        # These file helpers require only path attributes, not a running store.
        # Skipping __init__ is intentional: sqlite3.connect is forbidden above.
        store = object.__new__(server.MonitorStore)
        store.db_path = self.root / "unused.sqlite3"
        store.export_dir = self.root / "exports"
        folder = self.root / "materials"
        folder.mkdir()
        note = {"noteId": "storage-note", "title": "测试标题", "content": "测试正文",
                "url": "https://example.invalid/note/storage-note", "ipLocation": ""}
        comments = [{"commentId": "storage-comment", "content": "测试评论"}]
        replacement, attempts = self.locked_replace(2)
        with patch("server.os.replace", side_effect=replacement), patch(
            "server.replace_material_with_retry", wraps=server.replace_material_with_retry
        ) as helper:
            store._write_media_snapshot({"folder": str(folder), "files": []}, note, comments)
            checkpoint = store._persist_sync_checkpoint({"noteId": note["noteId"], "notesBytes": b"old CSV"})
        targets = [Path(item.args[1]) for item in helper.call_args_list]
        self.assertCountEqual(["comments.json", "note.json", "帖子正文.txt", "checkpoint.json"],
                              [target.name for target in targets])
        self.assertEqual({target: 3 for target in targets}, attempts)
        self.assertEqual([call(0.025), call(0.05)] * 4, self.sleep.call_args_list)
        self.office.assert_not_called()
        self.assertEqual(comments, json.loads((folder / "comments.json").read_text(encoding="utf-8")))
        self.assertEqual("", json.loads((folder / "note.json").read_text(encoding="utf-8"))["ipLocation"])
        self.assertEqual("测试标题\n\n测试正文\n\n来源链接：" + note["url"],
                         (folder / "帖子正文.txt").read_text(encoding="utf-8"))
        manifest = Path(checkpoint["checkpointDir"]) / "checkpoint.json"
        journal = store._checkpoint_json_value(json.loads(manifest.read_text(encoding="utf-8")), decode=True)
        self.assertEqual(note["noteId"], journal["noteId"])
        self.assertEqual(b"old CSV", journal["notesBytes"])
        self.assertFalse(list(self.root.rglob("*.tmp")))


if __name__ == "__main__":
    unittest.main()
