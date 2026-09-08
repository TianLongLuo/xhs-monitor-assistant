"""Fresh normalized comparison regressions; SQLite/CSV/materials are temporary."""

import copy
from contextlib import closing
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from server import MonitorStore
from snapshot_validation import validate_snapshot_identity


OBSERVED = "2026-09-03T15:30:00+08:00"
NOTE_ID = "fixture-normalized"
COMPLETE = {
    "allCommentsRequested": True, "expandersExhausted": True,
    "scrollExhausted": True, "stableRounds": 2,
}


class NormalizedCommentCompareTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="normalized-comment-compare-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        connect = sqlite3.connect

        def isolated_connect(database, *args, **kwargs):
            self.assertTrue(Path(database).resolve().is_relative_to(self.root), database)
            return connect(database, *args, **kwargs)

        for guard in (
            patch("server.sqlite3.connect", side_effect=isolated_connect),
            patch("server.urlopen", side_effect=AssertionError("No network in this fixture")),
            patch("server.now_iso", return_value=OBSERVED),
        ):
            guard.start()
            self.addCleanup(guard.stop)
        self.note = {
            "noteId": NOTE_ID, "title": "标准化对照", "content": "临时数据",
            "author": "作者", "url": "https://www.xiaohongshu.com/explore/" + NOTE_ID,
            "publishedAt": "2026-09-01", "timeObservedAt": OBSERVED, "detailRead": True,
        }
        self.root_comment = self.comment("root-1", "主评论")
        self.reply = self.comment("reply-1", "子评论", "root-1")
        self.old = self.comment("old-1", "历史评论")
        self.store = self.make_store("primary")

    @staticmethod
    def comment(comment_id, content, parent="", **extra):
        return {
            "commentId": comment_id, "content": content, "author": "评论者",
            "parentCommentId": parent, "commentLevel": 2 if parent else 1,
            "publishedAt": "2026-09-01", "timeObservedAt": OBSERVED, **extra,
        }

    def payload(self, comments, **extra):
        return {
            "noteId": NOTE_ID, "note": copy.deepcopy(self.note),
            "comments": copy.deepcopy(comments), "status": "likely_complete",
            "expectedCount": len(comments), "collectionEvidence": dict(COMPLETE),
            "collectedAt": OBSERVED, **extra,
        }

    def make_store(self, name):
        root = self.root / name
        root.mkdir()
        store = MonitorStore(root / "fixture.sqlite3", root / "exports")
        notes_path, _ = store.configure_data_files(root / "notes.csv")
        store._ensure_seed_workbook(notes_path)
        payload = self.payload([self.root_comment, self.reply, self.old])
        payload["commentStatus"] = payload.pop("status")
        result = store.pull_to_excel(payload)
        self.assertTrue(result["consistencyVerified"])
        return store

    def snapshot(self, store=None):
        store = store or self.store
        with store._session() as db:
            # Rollback can reinsert the same primary-key records in a different
            # physical order. Retain every schema/row value, canonicalize order.
            database = tuple(sorted(db.iterdump()))
        # Ignore SQLite's WAL/page layout, not any logical records or artifacts.
        files = {str(path.relative_to(self.root)): path.read_bytes()
                 for path in self.root.rglob("*")
                 if path.is_file() and path.suffix in {".csv", ".json", ".txt"}}
        return database, files

    def assert_equivalent(self, payload):
        before = copy.deepcopy(payload)
        database_before = self.snapshot()
        with self.store.pull_lock:
            once = self.store._normalize_snapshot_comments(NOTE_ID, payload["comments"])
            untouched = copy.deepcopy(once)
            twice = self.store._normalize_snapshot_comments(NOTE_ID, once)
            # Full normalized dictionaries, including time metadata, not just IDs.
            self.assertEqual(once, twice, "normalization must be idempotent at the fixed clock")
            legacy = self.store.compare_comments({**payload, "comments": once})
            current = self.store._compare_normalized_comments({**payload, "comments": once}, NOTE_ID, once)
            self.assertEqual(legacy, current, "every old double-normalize comparison field is preserved")
            self.assertEqual(legacy, self.store.compare_comments(payload))
            self.assertEqual(untouched, once)
        self.assertEqual(before, payload)
        self.assertEqual(database_before, self.snapshot(), "comparison is read-only")
        return current

    def test_time_normalization_is_idempotent_and_comparison_equivalent(self):
        for raw in ("", "2026-09-01", "2026-09-01T12:13:14.123Z", "09-01",
                    "7天前 上海", "昨天 12:30", "刚刚", "编辑于 09-01", "未知", 1725375600):
            for observed in (None, OBSERVED, "2026-08-01T01:02:03+08:00"):
                with self.subTest(raw=raw, observed=observed):
                    row = dict(self.root_comment, publishedAt=raw, ipLocation="IP属地：广东")
                    row.pop("timeObservedAt")
                    if observed is not None:
                        row["timeObservedAt"] = observed
                    self.assert_equivalent(self.payload([row]))

    def test_clock_crossing_midnight_and_year_keeps_first_observation(self):
        boundaries = (
            ("2026-09-03T23:59:59+08:00", "2026-09-04T00:00:01+08:00"),
            ("2026-12-31T23:59:59+08:00", "2027-01-01T00:00:01+08:00"),
        )
        before = self.snapshot()
        for first_clock, later_clock in boundaries:
            for raw in ("刚刚", "昨天 12:30", "7天前 上海", "12-31", "编辑于 12-31"):
                for identity in ("stored", "new", "legacy"):
                    with self.subTest(first_clock=first_clock, raw=raw, identity=identity):
                        row = dict(self.root_comment, publishedAt=raw)
                        row.pop("timeObservedAt")
                        if identity == "new":
                            row["commentId"] = "clock-new"
                        elif identity == "legacy":
                            row.pop("commentId")
                        payload = self.payload([row])
                        original = copy.deepcopy(payload)
                        with self.store.pull_lock:
                            with patch("server.now_iso", side_effect=[first_clock, later_clock]) as clock:
                                once = self.store._normalize_snapshot_comments(NOTE_ID, payload["comments"])
                                preserved = copy.deepcopy(once)
                                twice = self.store._normalize_snapshot_comments(NOTE_ID, once)
                                self.assertEqual(2, clock.call_count)
                            self.assertEqual(first_clock, once[0]["timeObservedAt"])
                            self.assertEqual(first_clock, once[0]["publishedTime"]["referenceAt"])
                            self.assertEqual(raw, once[0]["publishedAt"])
                            self.assertEqual(preserved, twice, "later wall clock must not shift the first observation")
                            self.assertEqual(preserved, once, "second pass must not mutate its input")
                            if raw == "刚刚":
                                self.assertEqual(first_clock[:19].replace("T", " "), once[0]["publishedTime"]["value"])
                            context = {**payload, "comments": once}
                            with patch("server.now_iso", return_value=later_clock):
                                legacy = self.store.compare_comments(context)
                                current = self.store._compare_normalized_comments(context, NOTE_ID, once)
                            self.assertEqual(legacy, current)
                        self.assertEqual(original, payload)
        self.assertEqual(before, self.snapshot())

    def test_clock_collision_with_stored_observation_preserves_comparison_equivalence(self):
        # Existing time correction intentionally refreshes the observation when
        # it equals the stored clock but the source label changed. Therefore full
        # normalization is NOT universally idempotent when wall time advances.
        # The removed second pass only fed comparison, never the write payload;
        # assert the complete comparison still agrees, without masking metadata.
        for first_clock, later_clock in (
            ("2026-09-03T23:59:59+08:00", "2026-09-04T00:00:01+08:00"),
            ("2026-12-31T23:59:59+08:00", "2027-01-01T00:00:01+08:00"),
        ):
            with self.subTest(first_clock=first_clock):
                with self.store._session() as db:
                    stored = db.execute("SELECT payload_json FROM comments WHERE comment_id='root-1'").fetchone()
                    prior = json.loads(stored[0])
                    prior["timeObservedAt"] = first_clock
                    prior["publishedTime"]["referenceAt"] = first_clock
                    db.execute("UPDATE comments SET payload_json=? WHERE comment_id='root-1'",
                               (json.dumps(prior, ensure_ascii=False),))
                before = self.snapshot()
                row = dict(self.root_comment, publishedAt="刚刚")
                row.pop("timeObservedAt")
                payload = self.payload([row])
                with self.store.pull_lock:
                    with patch("server.now_iso", return_value=first_clock):
                        once = self.store._normalize_snapshot_comments(NOTE_ID, payload["comments"])
                    preserved = copy.deepcopy(once)
                    context = {**payload, "comments": once}
                    with patch("server.now_iso", return_value=later_clock):
                        twice = self.store._normalize_snapshot_comments(NOTE_ID, once)
                        legacy = self.store.compare_comments(context)
                        current = self.store._compare_normalized_comments(context, NOTE_ID, once)
                self.assertEqual(first_clock, once[0]["timeObservedAt"])
                self.assertEqual(later_clock, twice[0]["timeObservedAt"])
                self.assertEqual(first_clock, once[0]["publishedTime"]["referenceAt"])
                self.assertEqual(later_clock, twice[0]["publishedTime"]["referenceAt"])
                self.assertEqual(first_clock[:19].replace("T", " "), once[0]["publishedTime"]["value"])
                self.assertEqual(later_clock[:19].replace("T", " "), twice[0]["publishedTime"]["value"])
                differences = {key for key in once[0].keys() | twice[0].keys() if once[0].get(key) != twice[0].get(key)}
                self.assertEqual({"timeObservedAt", "publishedTime"}, differences)
                self.assertEqual(legacy, current, "full comparison remains equal even in the non-idempotent case")
                self.assertEqual(preserved, once, "the first-pass write payload remains untouched")
                self.assertEqual(before, self.snapshot())

    def test_alias_duplicate_legacy_and_root_reply_equivalence(self):
        legacy = {key: value for key, value in self.root_comment.items() if key != "commentId"}
        missing_time = {key: value for key, value in legacy.items() if key != "publishedAt"}
        other_id = dict(self.root_comment, commentId="different-stable-id")
        cases = [
            ([self.root_comment, self.root_comment], 1),
            ([legacy, self.root_comment], 1), ([self.root_comment, legacy], 1),
            ([legacy, self.root_comment, other_id], 2),
            ([other_id, legacy, self.root_comment], 2),
            ([legacy], 1), ([missing_time], 1),
            ([self.reply, legacy], 2),
            ([self.reply, self.root_comment, self.reply], 2),
            ([dict(self.reply, parentCommentId=" root-1 ", commentLevel=3), self.root_comment], 2),
            ([dict(self.root_comment, note_id=NOTE_ID, noteId=NOTE_ID)], 1),
            ([{"comment_id": "legacy-snake-id", "content": "旧别名", "note_id": NOTE_ID}], 1),
            ([None, False, "fragment", {}, {"content": "  "}, self.reply], 1),
            ([self.comment("deleted-input", "原页面状态", isDeleted=True, commentStatus="已删除")], 1),
        ]
        for rows, count in cases:
            with self.subTest(rows=rows):
                result = self.assert_equivalent(self.payload(rows))
                self.assertEqual(count, result["currentCount"])
                if len(rows) > count:
                    self.assertFalse(result["canPrune"], "duplicate fragments never satisfy the raw expected count")

    def test_partial_empty_and_completeness_gates_are_identical(self):
        cases = [
            ([], {"expectedCount": 0}, False),
            ([], {"expectedCount": 0, "explicitEmptyVerified": True}, True),
            ([], {"expectedCount": 0, "explicitEmptyVerified": True, "collectionEvidence": {}}, False),
            ([self.root_comment], {"expectedCount": 3}, False),
            ([self.root_comment], {"expectedCount": 1}, True),
            ([self.root_comment], {"expectedCount": 1, "status": "partial"}, False),
            ([self.root_comment], {"expectedCount": 1, "status": "failed"}, False),
            ([self.root_comment], {"expectedCount": 1, "status": "collecting"}, False),
            ([self.root_comment], {"expectedCount": 1, "collectionEvidence": {}}, False),
            ([self.root_comment], {"expectedCount": 1.5}, False),
        ]
        for rows, options, can_prune in cases:
            with self.subTest(options=options):
                result = self.assert_equivalent(self.payload(rows, **options))
                self.assertEqual(can_prune, result["canPrune"])
                self.assertEqual(3 - len(rows), result["removedCount"] if can_prune else result["pendingRemovedCount"])

    def test_deleted_history_and_note_changes_are_not_lost(self):
        with self.store._session() as db:
            db.execute("UPDATE comments SET is_deleted=1,comment_status='已删除' WHERE comment_id='old-1'")
        payload = self.payload([self.root_comment, dict(self.reply, content="回复内容变化")])
        payload["note"].update(title="更新标题", likeCount=12)
        result = self.assert_equivalent(payload)
        self.assertEqual(3, result["historicalCount"])
        self.assertEqual(1, result["deletedLocalCount"])
        self.assertEqual(1, result["changedCount"])
        self.assertTrue(result["noteChanged"])

    def test_public_boundary_never_trusts_client_normalized_or_preview_flags(self):
        flags = {"normalized": True, "commentsNormalized": True, "_normalized": True,
                 "alreadyNormalized": True, "comparison": {"canPrune": True, "currentCount": 999}}
        valid = self.payload([self.root_comment, self.root_comment], **flags)
        with patch.object(self.store, "_normalize_snapshot_comments", wraps=self.store._normalize_snapshot_comments) as normalize:
            self.assertEqual(1, self.store.compare_comments(valid)["currentCount"])
            self.assertEqual(1, normalize.call_count)
        invalid = [
            {**valid, "noteId": ""}, {**valid, "noteId": "../invalid"},
            {**valid, "note": {"noteId": "foreign-note"}},
            {**valid, "note_id": "foreign-note"},
            {**valid, "comments": {"pretend": "normalized"}},
            {**valid, "comments": ""}, {**valid, "comments": False},
            {**valid, "comments": [dict(self.root_comment, noteId="foreign-note")]},
            {**valid, "comments": [dict(self.root_comment, noteId=NOTE_ID, note_id="foreign-note")]},
            {**valid, "note": {"url": "https://www.xiaohongshu.com/explore/foreign-note"}},
        ]
        before = self.snapshot()
        for payload in invalid:
            for method in (self.store.compare_comments, self.store.sync_comment_snapshot):
                with self.subTest(payload=payload, method=method.__name__), patch.object(
                    self.store, "_normalize_snapshot_comments", side_effect=AssertionError("validation must run first")
                ):
                    with self.assertRaises(ValueError):
                        method(payload)
                    self.assertEqual(before, self.snapshot())

    def test_foreign_stable_id_retains_compare_and_sync_rejection_semantics(self):
        foreign_note = {**self.note, "noteId": "foreign-note", "url": "https://www.xiaohongshu.com/explore/foreign-note"}
        foreign = self.comment("foreign-comment", "别帖内容")
        self.store.pull_to_excel({"note": foreign_note, "comments": [foreign], "commentStatus": "partial"})
        payload = self.payload([foreign], status="partial")
        result = self.assert_equivalent(payload)
        self.assertEqual(1, result["newCount"])
        before = self.snapshot()
        with self.assertRaisesRegex(ValueError, "其他帖子|串帖"):
            self.store.sync_comment_snapshot(payload)
        self.assertEqual(before, self.snapshot())

    def test_comparison_stage_removes_exactly_one_normalization(self):
        payload = self.payload([self.reply, self.root_comment, self.root_comment])
        normalize = self.store._normalize_snapshot_comments
        with self.store.pull_lock, patch.object(self.store, "_normalize_snapshot_comments", wraps=normalize) as calls:
            rows = self.store._normalize_snapshot_comments(NOTE_ID, payload["comments"])
            legacy = self.store.compare_comments({**payload, "comments": rows})
            self.assertEqual(2, calls.call_count)
            calls.reset_mock()
            rows = self.store._normalize_snapshot_comments(NOTE_ID, payload["comments"])
            current = self.store._compare_normalized_comments({**payload, "comments": rows}, NOTE_ID, rows)
            self.assertEqual(1, calls.call_count)
            self.assertEqual(legacy, current)

    def test_sync_recompares_fresh_rows_under_pull_lock_not_cached_preview(self):
        payload = self.payload([self.root_comment], status="partial", expectedCount=3)
        preview = self.store.compare_comments(payload)
        self.assertEqual(0, preview["changedCount"])
        self.store.upsert_comments(self.payload([dict(self.root_comment, content="预览之后变化")], status="partial"))
        payload.update(comparison=preview, previewResult=preview, normalized=True)
        normalize = self.store._normalize_snapshot_comments
        compare = self.store._compare_normalized_comments
        latest = []
        comparisons = []

        def normalize_spy(note_id, rows):
            self.assertTrue(self.store.pull_lock._is_owned())
            result = normalize(note_id, rows)
            latest.append(result)
            return result

        def compare_spy(context, note_id, rows):
            self.assertTrue(self.store.pull_lock._is_owned())
            self.assertIs(latest[-1], rows, "reuse the immediately preceding normalization by identity")
            result = compare(context, note_id, rows)
            comparisons.append(result)
            return result

        with patch.object(self.store, "_normalize_snapshot_comments", side_effect=normalize_spy), patch.object(
            self.store, "_compare_normalized_comments", side_effect=compare_spy
        ), patch.object(self.store, "compare_comments", side_effect=AssertionError("sync must use the private fresh-row path")):
            result = self.store.sync_comment_snapshot(payload)
        self.assertEqual(1, len(comparisons))
        self.assertEqual(1, comparisons[0]["changedCount"])
        self.assertEqual(1, result["changedCount"])
        self.assertFalse(result["canPrune"])
        self.assertTrue(result["consistencyVerified"])

    def test_real_sync_matches_old_double_normalization_and_saves_one_call(self):
        # Restore an exact fixture backup at the SAME path between runs: material
        # paths participate in consistency hashes, which must also compare equal.
        cases = [
            ([dict(self.reply, content="更新回复"), self.root_comment], {}),
            ([self.root_comment, self.root_comment], {"expectedCount": 3}),
            ([], {"explicitEmptyVerified": True}),
            ([], {"status": "partial"}),
            ([{key: value for key, value in self.root_comment.items() if key != "commentId"}], {"status": "partial"}),
        ]
        for index, (rows, options) in enumerate(cases):
            outcomes, counts, snapshots = [], [], []
            store = self.make_store(f"sync-{index}")
            db_path, export_dir = store.db_path, store.export_dir
            notes_path = store.seed_xlsx_path
            backup_path = self.root / f"baseline-{index}.sqlite3"
            initial = self.snapshot(store)
            with store._session() as db, closing(sqlite3.connect(backup_path)) as backup:
                db.backup(backup)
            for legacy in (True, False):
                with self.subTest(case=index, legacy=legacy):
                    if not legacy:
                        with closing(sqlite3.connect(backup_path)) as backup, closing(sqlite3.connect(db_path)) as db:
                            backup.backup(db)
                        for relative, data in initial[1].items():
                            path = (self.root / relative).resolve()
                            self.assertTrue(path.is_relative_to(self.root))
                            path.write_bytes(data)
                        store = MonitorStore(db_path, export_dir)
                        store.configure_data_files(notes_path)
                        self.assertEqual(initial, self.snapshot(store), "exact initial fixture restored")
                    original = store._compare_normalized_comments

                    def compare(context, note_id, normalized):
                        if legacy:
                            # Exactly the removed public compare work: validate,
                            # then normalize again against the same current SQLite.
                            validate_snapshot_identity(context)
                            normalized = store._normalize_snapshot_comments(note_id, normalized)
                        return original(context, note_id, normalized)

                    with patch.object(store, "_compare_normalized_comments", side_effect=compare), patch.object(
                        store, "_normalize_snapshot_comments", wraps=store._normalize_snapshot_comments
                    ) as normalize:
                        outcomes.append(store.sync_comment_snapshot(self.payload(rows, **options)))
                        counts.append(normalize.call_count)
                    snapshots.append(self.snapshot(store))
            self.assertEqual(outcomes[0], outcomes[1], index)
            self.assertEqual(snapshots[0], snapshots[1], index)
            self.assertEqual(counts[0] - 1, counts[1], (index, counts))


if __name__ == "__main__":
    unittest.main()
