"""Comment snapshot regressions; all databases and artifacts live in a temporary root."""

import copy
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from server import MonitorStore, collection_evidence_verified


OBSERVED = "2026-09-03T15:30:00+08:00"
COMPLETE = {
    "allCommentsRequested": True,
    "expandersExhausted": True,
    "scrollExhausted": True,
    "stableRounds": 2,
}


class CommentCompletenessTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="comment-completeness-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        original_connect = sqlite3.connect

        def isolated_connect(database, *args, **kwargs):
            self.assertTrue(Path(database).resolve().is_relative_to(self.root), database)
            return original_connect(database, *args, **kwargs)

        for guard in (
            patch("server.sqlite3.connect", side_effect=isolated_connect),
            patch("server.urlopen", side_effect=AssertionError("Network access is disabled in this test")),
            patch("server.now_iso", return_value=OBSERVED),
        ):
            guard.start()
            self.addCleanup(guard.stop)
        self.store = MonitorStore(self.root / "fixture.sqlite3", self.root / "exports")
        self.notes_path, self.comments_path = self.store.configure_data_files(self.root / "fixture_notes.csv")
        self.store._ensure_seed_workbook(self.notes_path)
        self.note = {
            "noteId": "fixture-completeness", "title": "完整性测试", "content": "测试正文",
            "author": "帖主", "url": "https://www.xiaohongshu.com/explore/fixture-completeness",
            "publishedAt": "2026-09-01", "timeObservedAt": OBSERVED, "detailRead": True,
        }
        self.kept = self.comment("fixture-kept", "保留内容")
        self.old = self.comment("fixture-old", "历史内容")

    @staticmethod
    def comment(comment_id, content, parent=""):
        return {
            "commentId": comment_id, "author": "评论者", "content": content,
            "publishedAt": "2026-09-01", "parentCommentId": parent,
            "commentLevel": 2 if parent else 1, "timeObservedAt": OBSERVED,
        }

    def payload(self, comments, expected=2, status="likely_complete", evidence=COMPLETE, **extra):
        value = {
            "noteId": self.note["noteId"], "note": copy.deepcopy(self.note),
            "comments": copy.deepcopy(comments), "expectedCount": expected,
            "status": status, "collectedAt": OBSERVED, **extra,
        }
        if evidence is not None:
            value["collectionEvidence"] = dict(evidence)
        return value

    def apply(self, mode, comments, **kwargs):
        payload = self.payload(comments, **kwargs)
        if mode == "pull":
            payload["commentStatus"] = payload.pop("status")
            return self.store.pull_to_excel(payload)
        if mode == "sync":
            return self.store.sync_comment_snapshot(payload)
        return self.store.upsert_comments(payload)

    def seed(self):
        result = self.apply("pull", [self.kept, self.old])
        self.assertEqual("synced", result["pullStatus"])
        self.assertTrue(result["consistencyVerified"])

    def rows(self):
        with self.store._session() as db:
            return {row["comment_id"]: dict(row) for row in db.execute("SELECT * FROM comments")}

    def note_row(self):
        with self.store._session() as db:
            return dict(db.execute("SELECT * FROM notes WHERE note_id=?", (self.note["noteId"],)).fetchone())

    def assert_consistent(self, active_ids):
        rows = self.rows()
        self.assertEqual(set(active_ids), {key for key, row in rows.items() if not row["is_deleted"]})
        media_dir = self.note_row()["media_dir"]
        if media_dir:
            self.assertTrue(Path(media_dir).resolve().is_relative_to(self.root))
        verified = self.store._verify_note_store_consistency(self.note["noteId"], media_dir)
        self.assertTrue(verified["ok"])
        return rows

    def assert_incomplete(self, mode, result, status="partial", expected=2):
        self.assertEqual(status, result["status"] if mode == "upsert" else result["commentStatus"])
        self.assertEqual(status, self.note_row()["comment_collection_status"])
        if mode == "sync":
            self.assertFalse(result["canPrune"])
            self.assertEqual(0, result["commentsMarkedDeleted"])
        if mode != "upsert":
            self.assertIn(result["pullStatus"], {"partial", "failed"})
            self.assertTrue(result["consistencyVerified"])
        with self.store._session() as db:
            job = db.execute("SELECT * FROM comment_collection_jobs ORDER BY id DESC LIMIT 1").fetchone()
            self.assertEqual(expected, job["expected_count"])
            self.assertEqual(status, job["status"])
        self.assert_consistent({self.kept["commentId"], self.old["commentId"]})

    def test_mixed_id_and_legacy_duplicate_cannot_enable_pruning(self):
        self.seed()
        legacy = {key: value for key, value in self.kept.items() if key != "commentId"}
        for mode in ("sync", "pull", "upsert"):
            for comments in ([self.kept, legacy], [legacy, self.kept]):
                with self.subTest(mode=mode, legacy_first="commentId" not in comments[0]):
                    compared = self.store.compare_comments(self.payload(comments))
                    self.assertEqual(1, compared["currentCount"])
                    self.assertFalse(compared["canPrune"])
                    self.assert_incomplete(mode, self.apply(mode, comments))

    def test_repeated_stable_id_does_not_count_history_as_current(self):
        self.seed()
        for mode in ("upsert", "sync", "pull"):
            with self.subTest(mode=mode):
                self.assert_incomplete(mode, self.apply(mode, [self.kept, self.kept]))

    def test_unstored_mixed_id_duplicate_uses_the_supplied_id_in_either_order(self):
        legacy = {key: value for key, value in self.kept.items() if key != "commentId"}
        for comments in ([legacy, self.kept], [self.kept, legacy]):
            normalized = self.store._normalize_snapshot_comments(self.note["noteId"], comments)
            self.assertEqual([self.kept["commentId"]], [row["commentId"] for row in normalized])
        result = self.apply("pull", [legacy, self.kept])
        self.assertEqual("partial", result["pullStatus"])
        self.assertEqual("partial", result["commentStatus"])
        self.assert_consistent({self.kept["commentId"]})

    def test_missing_evidence_is_additive_only_at_every_entrypoint(self):
        self.seed()
        for mode in ("upsert", "sync", "pull"):
            with self.subTest(mode=mode):
                self.assert_incomplete(mode, self.apply(mode, [self.kept], expected=1, evidence=None), expected=1)

    def test_unverified_snapshot_saves_new_comments_without_deleting_missing_history(self):
        fresh = self.comment("fixture-fresh", "新采集内容")
        for mode in ("sync", "pull"):
            with self.subTest(mode=mode):
                self.seed()
                result = self.apply(mode, [self.kept, fresh], expected=3, evidence=None)
                self.assertEqual("partial", result["commentStatus"])
                self.assertFalse(result["canPrune"])
                self.assert_consistent({self.kept["commentId"], self.old["commentId"], fresh["commentId"]})

    def test_normalized_count_shortfall_is_not_filled_from_stored_history(self):
        self.seed()
        for mode in ("upsert", "sync", "pull"):
            with self.subTest(mode=mode):
                self.assert_incomplete(mode, self.apply(mode, [self.kept]))

    def test_pending_loads_and_unreadable_comments_veto_completion(self):
        self.seed()
        for field, value in (("pendingLoads", True), ("unreadableCount", 1)):
            for mode in ("upsert", "sync", "pull"):
                with self.subTest(field=field, mode=mode):
                    result = self.apply(mode, [self.kept], expected=1, evidence={**COMPLETE, field: value})
                    self.assert_incomplete(mode, result, expected=1)

    def test_optional_veto_fields_are_backward_compatible_and_fail_closed(self):
        self.assertTrue(collection_evidence_verified({"collectionEvidence": COMPLETE}))
        self.assertTrue(collection_evidence_verified({"collectionEvidence": {
            **COMPLETE, "pendingLoads": False, "unreadableCount": 0,
        }}))
        for field, value in (("pendingLoads", "true"), ("pendingLoads", "unknown"),
                             ("unreadableCount", "1"), ("unreadableCount", "unknown")):
            with self.subTest(field=field, value=value):
                self.assertFalse(collection_evidence_verified({"collectionEvidence": {**COMPLETE, field: value}}))
        for field in ("allCommentsRequested", "expandersExhausted", "scrollExhausted"):
            self.assertFalse(collection_evidence_verified({"collectionEvidence": {**COMPLETE, field: False}}))
        self.assertFalse(collection_evidence_verified({"collectionEvidence": {**COMPLETE, "stableRounds": 1}}))

    def test_failed_or_partial_request_never_upgrades_or_prunes(self):
        self.seed()
        for status in ("failed", "partial"):
            for mode in ("upsert", "sync", "pull"):
                with self.subTest(status=status, mode=mode):
                    result = self.apply(mode, [self.kept], expected=1, status=status)
                    self.assert_incomplete(mode, result, status=status, expected=1)

    def test_unknown_total_and_unverified_empty_remain_partial(self):
        self.seed()
        for mode in ("sync", "pull", "upsert"):
            for comments in ([], [self.kept]):
                with self.subTest(mode=mode, count=len(comments)):
                    result = self.apply(mode, comments, expected=0)
                    self.assert_incomplete(mode, result, expected=0)

    def test_explicit_empty_still_requires_complete_collection_evidence(self):
        self.seed()
        for mode in ("sync", "pull"):
            result = self.apply(mode, [], expected=0, explicitEmptyVerified=True, evidence=None)
            self.assert_incomplete(mode, result, expected=0)

    def test_verified_empty_soft_deletes_without_losing_history(self):
        for mode in ("sync", "pull"):
            with self.subTest(mode=mode):
                self.seed()
                result = self.apply(mode, [], expected=0, explicitEmptyVerified=True)
                self.assertEqual("likely_complete", result["commentStatus"])
                self.assertEqual("synced", result["pullStatus"])
                rows = self.assert_consistent(set())
                self.assertEqual({self.kept["commentId"], self.old["commentId"]}, set(rows))

    def test_complete_snapshots_with_optional_zeroes_preserve_all_stores(self):
        for mode in ("sync", "pull"):
            with self.subTest(mode=mode):
                self.seed()
                result = self.apply(mode, [self.kept], expected=1,
                                    evidence={**COMPLETE, "pendingLoads": False, "unreadableCount": 0})
                self.assertEqual("likely_complete", result["commentStatus"])
                self.assertEqual("synced", result["pullStatus"])
                rows = self.assert_consistent({self.kept["commentId"]})
                self.assertTrue(rows[self.old["commentId"]]["is_deleted"])
                self.assertEqual(self.old["publishedAt"], rows[self.old["commentId"]]["published_at"])
                self.assertEqual(self.old["content"], rows[self.old["commentId"]]["content"])

    def test_image_placeholder_is_counted_and_metadata_survives_sync_and_pull(self):
        image = {**self.comment("fixture-image", "[图片]"),
                 "imageUrls": ["https://fixture.invalid/comment-image.jpg"]}
        for mode in ("sync", "pull"):
            with self.subTest(mode=mode):
                self.seed()
                result = self.apply(mode, [self.kept, image])
                self.assertEqual("likely_complete", result["commentStatus"])
                rows = self.assert_consistent({self.kept["commentId"], image["commentId"]})
                self.assertEqual("[图片]", rows[image["commentId"]]["content"])
                self.assertEqual(image["imageUrls"], json.loads(rows[image["commentId"]]["payload_json"])["imageUrls"])

    def thread_comments(self, legacy=False):
        parents = [self.comment("fixture-parent-a", "父评论甲"), self.comment("fixture-parent-b", "父评论乙")]
        replies = [self.comment("fixture-reply-a", "相同内容", parents[0]["commentId"]),
                   self.comment("fixture-reply-b", "相同内容", parents[1]["commentId"])]
        if legacy:
            for item in replies:
                item.pop("commentId")
        return parents + replies

    def test_parent_scoped_fallback_ids_agree_between_upsert_pull_and_compare(self):
        self.store.confirm(self.note)
        comments = self.thread_comments(legacy=True)
        result = self.apply("upsert", comments, expected=4)
        self.assertEqual("likely_complete", result["status"])
        initial = self.rows()
        self.assertEqual(4, len(initial))
        replies = [row for row in initial.values() if row["parent_comment_id"]]
        self.assertEqual(2, len({row["comment_id"] for row in replies}))
        self.assertEqual({"fixture-parent-a", "fixture-parent-b"}, {row["parent_comment_id"] for row in replies})
        self.apply("pull", comments, expected=4)
        self.assertEqual(set(initial), set(self.assert_consistent(initial)))
        compared = self.store.compare_comments(self.payload(comments, expected=4))
        self.assertEqual(0, compared["removedCount"])
        self.assertEqual(0, compared["newCount"])
        result = self.apply("sync", comments, expected=4)
        self.assertEqual(0, result["commentsMarkedDeleted"])
        self.assert_consistent(initial)

    def test_legacy_parent_matching_preserves_existing_ids_raw_dates_and_content(self):
        comments = self.thread_comments()
        self.apply("pull", comments, expected=4)
        before = {key: (row["parent_comment_id"], row["content"], row["published_at"])
                  for key, row in self.rows().items()}
        legacy = self.thread_comments(legacy=True)
        for mode in ("upsert", "sync", "pull"):
            with self.subTest(mode=mode):
                self.apply(mode, legacy, expected=4)
                rows = self.assert_consistent(before)
                self.assertEqual(before, {key: (row["parent_comment_id"], row["content"], row["published_at"])
                                          for key, row in rows.items()})

    def test_csv_legacy_fallback_is_parent_scoped_and_keeps_existing_ids(self):
        comments = self.thread_comments()
        self.apply("pull", comments, expected=4)
        original_ids = set(self.rows())
        media_dir = self.note_row()["media_dir"]
        result = self.store._sync_pull_to_xlsx(
            self.store._material_note_from_db(self.note_row()), self.thread_comments(legacy=True),
            {"folder": media_dir, "files": []},
        )
        self.assertEqual(0, result["commentAdded"])
        self.assertEqual(original_ids, set(self.assert_consistent(original_ids)))

    def test_distinct_supplied_ids_with_identical_text_are_preserved(self):
        first = self.comment("fixture-twin-a", "相同内容")
        second = {**first, "commentId": "fixture-twin-b"}
        legacy = {key: value for key, value in first.items() if key != "commentId"}
        result = self.apply("pull", [legacy, first, second], expected=3)
        self.assertEqual("partial", result["commentStatus"])
        self.assert_consistent({first["commentId"], second["commentId"]})

        result = self.apply("sync", [first, second])
        self.assertEqual("likely_complete", result["commentStatus"])
        self.assert_consistent({first["commentId"], second["commentId"]})

    def test_csv_reimport_never_upgrades_partial_collection_or_erases_its_error(self):
        self.seed()
        result = self.apply("pull", [self.kept], status="partial", commentError="还有回复未加载")
        self.assertEqual("partial", result["pullStatus"])
        before = self.note_row()
        self.store.seed_from_xlsx(self.notes_path)
        after = self.note_row()
        self.assertEqual("partial", after["pull_status"])
        self.assertEqual("partial", after["comment_collection_status"])
        self.assertEqual(before["pull_error"], after["pull_error"])
        self.assert_consistent({self.kept["commentId"], self.old["commentId"]})

    def test_csv_reimport_preserves_reply_count_and_image_metadata_absent_from_csv(self):
        first = {**self.kept, "replyCount": 2, "imageUrls": ["https://example.invalid/fixture.jpg"]}
        self.apply("pull", [first, self.old])
        before = self.rows()[first["commentId"]]
        self.store.seed_from_xlsx(self.notes_path)
        after = self.rows()[first["commentId"]]
        self.assertEqual(before["reply_count"], after["reply_count"])
        old_payload, new_payload = json.loads(before["payload_json"]), json.loads(after["payload_json"])
        self.assertEqual(old_payload["replyCount"], new_payload["replyCount"])
        self.assertEqual(old_payload["imageUrls"], new_payload["imageUrls"])
        self.assert_consistent({self.kept["commentId"], self.old["commentId"]})


if __name__ == "__main__":
    unittest.main()
