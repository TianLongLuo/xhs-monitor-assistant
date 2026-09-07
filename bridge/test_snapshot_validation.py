"""Ownership validation and no-mutation regression; all stores are temporary."""
import copy
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from snapshot_validation import validate_snapshot_identity
from server import MonitorStore


class SnapshotIdentityUnitTests(unittest.TestCase):
    def test_missing_legacy_comment_owner_is_supported_without_mutation(self):
        payload = {"note": {"noteId": "fixture-A"}, "comments": [{"content": "text"}]}
        before = copy.deepcopy(payload)
        self.assertEqual("fixture-A", validate_snapshot_identity(payload))
        self.assertEqual(before, payload)

    def test_every_explicit_owner_must_agree(self):
        for patcher in (
            lambda p: p.update(note_id="fixture-B"),
            lambda p: p.update(note={"noteId": "fixture-B"}),
            lambda p: p.update(comments=[{"noteId": "fixture-B"}]),
            lambda p: p.update(comments=[{"noteId": "fixture-A", "note_id": "fixture-B"}]),
        ):
            payload = {"noteId": "fixture-A"}
            patcher(payload)
            with self.subTest(payload=payload), self.assertRaisesRegex(ValueError, "冲突"):
                validate_snapshot_identity(payload)

    def test_invalid_explicit_ids_are_not_trimmed_truncated_or_coerced(self):
        for value in (None, "", "unknown", "../fixture", True, 123456, ["fixture-A"], "a" * 129):
            with self.subTest(value=value), self.assertRaises(ValueError):
                validate_snapshot_identity({"noteId": "fixture-A", "comments": [{"noteId": value}]})

    def test_all_native_note_routes_reject_conflicting_identity(self):
        for route in ("explore", "search_result", "discovery/item", "item", "note"):
            with self.subTest(route=route), self.assertRaisesRegex(ValueError, "其他帖子"):
                validate_snapshot_identity({"noteId": "fixture-A", "note": {
                    "url": f"https://www.xiaohongshu.com/{route}/fixture-B?xsec_token=fixture-A"}})

    def test_author_search_and_shortlinks_are_not_treated_as_note_identity(self):
        for url in ("https://www.xiaohongshu.com/user/profile/fixture-B", "https://xhslink.com/a/fixture-B",
                    "https://www.xiaohongshu.com/search_result?keyword=fixture-B", "https://example.test/explore/fixture-B"):
            self.assertEqual("fixture-A", validate_snapshot_identity({"noteId": "fixture-A", "url": url}))

    def test_same_identity_with_tokens_percent_encoding_and_owner_aliases_is_valid(self):
        value = {"noteId": "fixture-A", "note_id": "fixture-A", "note": {"noteId": "fixture-A",
                 "url": "https://www.xiaohongshu.com/explore/fixture%2DA?xsec_token=fixture"},
                 "comments": [{"noteId": "fixture-A", "note_id": "fixture-A"}]}
        self.assertEqual("fixture-A", validate_snapshot_identity(value))

    def test_malformed_payloads_fail_before_io(self):
        for payload in (None, [], {}, {"noteId": "fixture-A", "note": "fixture-B"},
                        {"noteId": "fixture-A", "comments": "not-an-array"}):
            with self.subTest(payload=payload), self.assertRaises(ValueError):
                validate_snapshot_identity(payload)


class SnapshotIdentityStorageTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="snapshot-identity-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        original = sqlite3.connect

        def connect(database, *args, **kwargs):
            self.assertTrue(Path(database).resolve().is_relative_to(self.root), database)
            return original(database, *args, **kwargs)

        for guard in (patch("server.sqlite3.connect", side_effect=connect),
                      patch("server.urlopen", side_effect=AssertionError("No external network in identity tests"))):
            guard.start(); self.addCleanup(guard.stop)
        self.store = MonitorStore(self.root / "fixture.sqlite3", self.root / "exports")
        self.notes_path, self.comments_path = self.store.configure_data_files(self.root / "notes.csv")
        self.store._ensure_seed_workbook(self.notes_path)
        self.note = {"noteId": "fixture-A", "title": "原始帖子", "content": "原始正文",
                     "url": "https://www.xiaohongshu.com/explore/fixture-A", "author": "测试作者"}
        self.comments = [{"commentId": "fixture-comment-A", "content": "原始评论", "noteId": "fixture-A"}]
        self.store.pull_to_excel({"note": self.note, "comments": self.comments, "commentStatus": "partial"})

    def snapshot(self):
        with self.store._session() as db:
            # SQL logical state avoids irrelevant WAL/checkpoint byte changes.
            database = "\n".join(db.iterdump())
        files = {str(p.relative_to(self.root)): p.read_bytes() for p in self.root.rglob("*")
                 if p.is_file() and p.suffix in {".csv", ".json", ".txt"}}
        return database, files

    def assert_rejected_without_mutation(self, mutate):
        methods = (self.store.pull_to_excel, self.store.sync_comment_snapshot,
                   self.store.upsert_comments, self.store.compare_comments)
        for method in methods:
            payload = {"noteId": "fixture-A", "note": copy.deepcopy(self.note),
                       "comments": copy.deepcopy(self.comments), "status": "partial", "commentStatus": "partial"}
            mutate(payload)
            before = self.snapshot()
            with self.subTest(method=method.__name__):
                with self.assertRaises(ValueError):
                    method(payload)
                self.assertEqual(before, self.snapshot(), "rejected request must not mutate ANY derived store")

    def test_conflicting_nested_note_is_rejected_at_all_public_boundaries(self):
        self.assert_rejected_without_mutation(lambda p: p["note"].update(noteId="fixture-B", content="别帖正文"))

    def test_new_foreign_comment_never_gets_reassigned(self):
        self.assert_rejected_without_mutation(lambda p: p["comments"].append({
            "noteId": "fixture-B", "commentId": "foreign-new-comment", "content": "别帖评论"}))

    def test_conflicting_comment_owner_alias_is_rejected(self):
        self.assert_rejected_without_mutation(lambda p: p["comments"][0].update(note_id="fixture-B"))

    def test_conflicting_native_url_is_rejected_before_canonicalization(self):
        self.assert_rejected_without_mutation(lambda p: p["note"].update(url="https://www.xiaohongshu.com/explore/fixture-B"))

    def test_invalid_id_cannot_be_truncated_to_valid_target(self):
        self.assert_rejected_without_mutation(lambda p: p.update(noteId="fixture-A" + "x" * 140))

    def test_legacy_missing_owners_still_syncs_and_preserves_historical_comments(self):
        result = self.store.sync_comment_snapshot({"noteId": "fixture-A", "note": self.note,
            "comments": [{"commentId": "fixture-new-comment", "content": "新增评论"}], "status": "partial"})
        self.assertTrue(result["consistencyVerified"])
        self.assertFalse(result["canPrune"])
        with self.store._session() as db:
            rows = db.execute("SELECT comment_id,note_id,is_deleted FROM comments ORDER BY comment_id").fetchall()
        self.assertEqual(2, len(rows))
        self.assertTrue(all(row["note_id"] == "fixture-A" and not row["is_deleted"] for row in rows))
        self.assertTrue(self.store._verify_note_store_consistency("fixture-A")["ok"])


if __name__ == "__main__":
    unittest.main()
