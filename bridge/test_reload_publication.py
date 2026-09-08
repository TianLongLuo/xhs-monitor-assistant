"""Reload publication regression tests: temporary stores only, no network/native IO.

Run from bridge: python -B -m unittest test_reload_publication -v
The fixture class is referenced through its module, not imported or subclassed,
so unittest does not also discover the AI publication suite in this module.
"""

import csv
import json
from pathlib import Path
import unittest
from unittest.mock import patch

import test_ai_publication as ai_fixture


CSV_FIELDS = ("语义分析次数", "分析结论是否差评", "差评类型", "差评子类型")
DB_FIELDS = ("semantic_analysis_count", "analysis_is_negative", "negative_type", "negative_subtype")
API_FIELDS = ("semanticAnalysisCount", "analysisIsNegative", "negativeType", "negativeSubtype")


class ReloadPublicationTests(unittest.TestCase):
    setUp = ai_fixture.AIPublicationTests.setUp
    new_store = ai_fixture.AIPublicationTests.new_store
    add_note = ai_fixture.AIPublicationTests.add_note
    rows = ai_fixture.AIPublicationTests.rows
    snapshot = ai_fixture.AIPublicationTests.snapshot
    assert_no_checkpoints = ai_fixture.AIPublicationTests.assert_no_checkpoints

    def edit_semantics(self, conclusion="待复核"):
        """Simulate an external CSV editor, without DB/material synchronization."""
        expected = {}
        for kind, path, id_header in (
            ("note", self.notes_path, "笔记ID"),
            ("comment", self.comments_path, "笔记评论ID"),
        ):
            headers, rows = self.store._read_csv_table(path, [])
            self.assertTrue(set(CSV_FIELDS).issubset(headers))
            for index, row in enumerate(rows):
                values = (7 + index if kind == "note" else 17 + index,
                          conclusion, "人工类型-" + kind, "人工子类型-" + str(index))
                row.update(dict(zip(CSV_FIELDS, values)))
                expected[kind, row[id_header]] = values
            # Do not use managed publication helpers: these are user edits that
            # must survive rollback to the state at reload entry.
            with path.open("w", encoding="utf-8-sig", newline="") as stream:
                writer = csv.DictWriter(stream, fieldnames=headers, lineterminator="\r\n")
                writer.writeheader()
                writer.writerows(rows)
        return expected

    def assert_semantics(self, expected):
        actual = {}
        for kind, table, key in (("note", "notes", "note_id"),
                                 ("comment", "comments", "comment_id")):
            for row in self.rows(table):
                actual[kind, row[key]] = tuple(row[field] for field in DB_FIELDS)
        self.assertEqual(expected, actual, "DB values/counts must equal the user's edits exactly")

        actual = {}
        for kind, path, key in (("note", self.notes_path, "笔记ID"),
                                ("comment", self.comments_path, "笔记评论ID")):
            for row in self.store._read_csv_table(path, [])[1]:
                actual[kind, row[key]] = (int(row[CSV_FIELDS[0]]),
                                         *(row[field] for field in CSV_FIELDS[1:]))
        self.assertEqual(expected, actual)

        actual = {}
        for note_id, folder in self.media.items():
            note = json.loads((folder / "note.json").read_text(encoding="utf-8-sig"))
            self.assertEqual(note_id, note["noteId"])
            actual["note", note_id] = tuple(note[field] for field in API_FIELDS)
            comments = json.loads((folder / "comments.json").read_text(encoding="utf-8-sig"))
            for comment in comments:
                actual["comment", comment["commentId"]] = tuple(comment[field] for field in API_FIELDS)
            self.assertTrue(self.store._verify_note_store_consistency(
                note_id, str(folder), verify_fields=True)["ok"])
        self.assertEqual(expected, actual)

    def semantic_state(self):
        """Exclude reload timestamps; compare persisted business fields/counts."""
        return {
            table: {row[key]: tuple(row[field] for field in DB_FIELDS) for row in self.rows(table)}
            for table, key in (("notes", "note_id"), ("comments", "comment_id"))
        }

    def test_csv_note_comment_edits_publish_all_stores_without_increment(self):
        for conclusion in ("是", "否", "待复核"):
            with self.subTest(conclusion=conclusion):
                self.new_store()
                self.add_note("B")
                expected = self.edit_semantics(conclusion)
                real_refresh = self.store._refresh_material_snapshot_for_note
                refreshed = []

                def refresh(note_id):
                    self.assertTrue(self.store.pull_lock._is_owned())
                    self.assertTrue(self.store.lock._is_owned())
                    self.assertTrue(list((self.store.export_dir / ".sync_checkpoints").glob(
                        "*/checkpoint.json")), "Backups must be persistent before publication")
                    refreshed.append(note_id)
                    return real_refresh(note_id)

                with patch.object(self.store, "_refresh_material_snapshot_for_note", side_effect=refresh):
                    result = self.store.reload_data_files()
                self.assertTrue(result["ok"])
                self.assertEqual(0, result["inserted"])
                self.assertEqual(str(self.notes_path), result["path"])
                self.assertEqual(len(self.media), result["materialSnapshotsRefreshed"])
                self.assertTrue(result["consistencyVerified"])
                self.assertCountEqual(self.media, refreshed)
                self.assert_semantics(expected)
                self.assert_no_checkpoints()
                self.client.complete_json.assert_not_called()

    def test_second_reload_is_semantically_idempotent(self):
        self.add_note("B")
        expected = self.edit_semantics()
        self.store.reload_data_files()
        self.assert_semantics(expected)
        first = self.semantic_state()
        csv_before = (self.notes_path.read_bytes(), self.comments_path.read_bytes())
        result = self.store.reload_data_files()
        self.assertTrue(result["ok"])
        self.assertTrue(result["consistencyVerified"])
        self.assertEqual(0, result["inserted"])
        self.assertEqual(len(self.media), result["materialSnapshotsRefreshed"])
        self.assertEqual(first, self.semantic_state())
        self.assertEqual(csv_before, (self.notes_path.read_bytes(), self.comments_path.read_bytes()))
        self.assert_semantics(expected)
        self.assert_no_checkpoints()
        self.client.complete_json.assert_not_called()

    def test_mid_refresh_failure_restores_all_tables_materials_and_edited_csv(self):
        self.add_note("B")
        with self.store._session() as db:
            db.execute("""INSERT INTO ai_jobs(target_type,target_id,status,created_at,updated_at)
                          VALUES('note','ai-note-A','pending',?,?)""",
                       (ai_fixture.OBSERVED, ai_fixture.OBSERVED))
        before_edit = self.snapshot()
        expected = self.edit_semantics()
        before_reload = self.snapshot()
        self.assertEqual(before_edit[0], before_reload[0], "External CSV edits must not mutate DB")
        self.assertNotEqual(before_edit[1], before_reload[1])
        real_refresh = self.store._refresh_material_snapshot_for_note
        refreshed = []

        def refresh(note_id):
            result = real_refresh(note_id)
            refreshed.append(note_id)
            if len(refreshed) == 2:
                # Exercise the global-table backup, including sqlite_sequence,
                # rather than only the per-note notes/comments restoration.
                with self.store._session() as db:
                    db.execute("UPDATE ai_jobs SET status='fixture-mutated'")
                    db.execute("""INSERT INTO ai_jobs(target_type,target_id,status,created_at,updated_at)
                                  VALUES('note',?,'pending',?,?)""",
                               (note_id, ai_fixture.OBSERVED, ai_fixture.OBSERVED))
                raise OSError("Injected second material refresh failure")
            return result

        with patch.object(self.store, "_refresh_material_snapshot_for_note", side_effect=refresh):
            with self.assertRaisesRegex(Exception, "Injected second material refresh failure"):
                self.store.reload_data_files()
        self.assertEqual(2, len(refreshed), "Failure must follow real multi-note publication")
        self.assertEqual(before_reload, self.snapshot(),
                         "Restore every DB table and exact file bytes, retaining pre-call CSV edits")
        self.assert_no_checkpoints()
        # A retry consumes the retained user edits, not the old material values.
        self.assertTrue(self.store.reload_data_files()["ok"])
        self.assert_semantics(expected)
        self.assert_no_checkpoints()

    def test_silent_material_refresh_noop_is_an_error_and_rolls_back(self):
        self.edit_semantics()
        before = self.snapshot()
        with patch.object(self.store, "_refresh_material_snapshot_for_note", return_value="") as refresh:
            with self.assertRaises(Exception):
                self.store.reload_data_files()
        refresh.assert_called()
        self.assertEqual(before, self.snapshot())
        self.assert_no_checkpoints()

    def test_missing_material_directory_is_an_error_not_success(self):
        self.edit_semantics()
        missing = self.media["ai-note-A"]
        saved = self.root / "temporarily-missing-material"
        missing.rename(saved)
        saved_bytes = {path.name: path.read_bytes() for path in saved.iterdir() if path.is_file()}
        before = self.snapshot()
        with patch.object(self.store, "_capture_sync_checkpoint",
                          wraps=self.store._capture_sync_checkpoint) as capture, \
                patch.object(self.store, "seed_from_xlsx", wraps=self.store.seed_from_xlsx) as seed:
            with self.assertRaisesRegex(ValueError, "素材目录缺失"):
                self.store.reload_data_files()
        capture.assert_not_called()
        seed.assert_not_called()
        self.assertEqual(before, self.snapshot())
        self.assertFalse(missing.exists(), "Reload must not invent an absent material directory")
        self.assertEqual(saved_bytes, {
            path.name: path.read_bytes() for path in saved.iterdir() if path.is_file()})
        self.assert_no_checkpoints()

    def test_csv_material_directory_change_is_rejected_before_any_write(self):
        self.edit_semantics()
        destination = self.root / "unbacked-material-destination"
        destination.mkdir()
        sentinel = destination / "note.json"
        sentinel.write_bytes(b'{"sentinel":"must not overwrite"}')
        headers, rows = self.store._read_csv_table(self.notes_path, [])
        rows[0]["对应帖子文件夹地址"] = str(destination)
        with self.notes_path.open("w", encoding="utf-8-sig", newline="") as stream:
            writer = csv.DictWriter(stream, fieldnames=headers, lineterminator="\r\n")
            writer.writeheader()
            writer.writerows(rows)
        before = self.snapshot()
        destination_before = {path.name: path.read_bytes() for path in destination.iterdir()}
        with patch.object(self.store, "_capture_sync_checkpoint",
                          wraps=self.store._capture_sync_checkpoint) as capture, \
                patch.object(self.store, "seed_from_xlsx", wraps=self.store.seed_from_xlsx) as seed, \
                patch.object(self.store, "_refresh_material_snapshot_for_note",
                             wraps=self.store._refresh_material_snapshot_for_note) as refresh:
            with self.assertRaisesRegex(ValueError, "素材目录已变化"):
                self.store.reload_data_files()
        capture.assert_not_called()
        seed.assert_not_called()
        refresh.assert_not_called()
        self.assertEqual(before, self.snapshot())
        self.assertEqual(destination_before, {
            path.name: path.read_bytes() for path in destination.iterdir()})
        self.assert_no_checkpoints()

    def test_global_health_failure_rolls_back_even_after_material_verification(self):
        for health in (
            {"status": "critical", "summary": {"relationshipsConsistent": True}},
            {"status": "warning", "summary": {"relationshipsConsistent": False}},
        ):
            with self.subTest(health=health):
                self.new_store()
                self.edit_semantics()
                before = self.snapshot()
                with patch.object(self.store, "data_health", return_value=health) as check, \
                        patch.object(self.store, "_verify_note_store_consistency",
                                     wraps=self.store._verify_note_store_consistency) as verify:
                    with self.assertRaisesRegex(ValueError, "全局字段/关联校验未通过"):
                        self.store.reload_data_files()
                check.assert_called()
                verify.assert_called()
                self.assertTrue(all(call.kwargs.get("verify_fields") is True
                                    for call in verify.call_args_list))
                self.assertEqual(before, self.snapshot())
                self.assert_no_checkpoints()

    def test_pending_checkpoint_rejects_reload_without_mutation_or_cleanup(self):
        self.edit_semantics()
        checkpoint = self.store._capture_sync_checkpoint("ai-note-A", capture_global_database=True)
        manifests = list((self.store.export_dir / ".sync_checkpoints").glob("*/checkpoint.json"))
        self.assertEqual(1, len(manifests))
        checkpoint_bytes = manifests[0].read_bytes()
        before = self.snapshot()
        try:
            with patch.object(self.store, "seed_from_xlsx", wraps=self.store.seed_from_xlsx) as seed:
                with self.assertRaisesRegex(ValueError, "未恢复的同步检查点"):
                    self.store.reload_data_files()
            seed.assert_not_called()
            self.assertEqual(before, self.snapshot())
            self.assertEqual(checkpoint_bytes, manifests[0].read_bytes())
        finally:
            self.store._discard_sync_checkpoint(checkpoint)
        self.assert_no_checkpoints()

    def test_committed_partial_cleanup_recovery_preserves_published_state(self):
        self.add_note("B")
        expected = self.edit_semantics()
        real_discard = self.store._discard_sync_checkpoint
        discarded = []
        published = []

        def discard(checkpoint):
            # The commit marker must exist before even the first deletion.
            batch_id = checkpoint["reloadBatchId"]
            marker = self.store.export_dir / ".reload_commits" / (batch_id + ".json")
            self.assertEqual({"batchId": batch_id, "dbPath": str(self.store.db_path.resolve())},
                             json.loads(marker.read_text(encoding="utf-8")))
            if discarded:
                self.assert_semantics(expected)
                published.append(self.snapshot())
                raise OSError("Injected interruption after first checkpoint cleanup")
            real_discard(checkpoint)
            discarded.append(checkpoint["noteId"])

        with patch.object(self.store, "_discard_sync_checkpoint", side_effect=discard):
            with self.assertRaisesRegex(OSError, "Injected interruption after first checkpoint cleanup"):
                self.store.reload_data_files()
        self.assertEqual(1, len(discarded))
        self.assertEqual(1, len(published))
        manifests = list((self.store.export_dir / ".sync_checkpoints").glob("*/checkpoint.json"))
        self.assertEqual(1, len(manifests), "Simulate partial cleanup, not a pre-publication failure")
        self.assertEqual(published[0], self.snapshot())
        with patch.object(self.store, "_restore_sync_checkpoint",
                          wraps=self.store._restore_sync_checkpoint) as restore:
            self.store._recover_persistent_sync_checkpoints()
            restore.assert_not_called()
        self.assertEqual(published[0], self.snapshot(),
                         "Committed recovery must preserve all DB tables and exact CSV/material bytes")
        self.assert_semantics(expected)
        self.assert_no_checkpoints()
        self.store._recover_persistent_sync_checkpoints()
        self.assertEqual(published[0], self.snapshot(), "Repeated recovery must also be a no-op")

    def test_commit_marker_replace_failure_rolls_back_entire_publication(self):
        self.add_note("B")
        expected = self.edit_semantics()
        before = self.snapshot()
        commit_root = self.store.export_dir / ".reload_commits"
        real_replace = ai_fixture.server.os.replace
        failed = []

        def replace(source, destination):
            target = Path(destination)
            if target.parent == commit_root and target.suffix == ".json":
                failed.append(target)
                self.assertTrue(Path(source).is_file())
                self.assert_semantics(expected)  # All stores already published before commit.
                raise OSError("Injected reload commit marker replacement failure")
            return real_replace(source, destination)

        with patch.object(ai_fixture.server.os, "replace", side_effect=replace):
            with self.assertRaisesRegex(ValueError, "已恢复重载前状态.*Injected reload commit marker"):
                self.store.reload_data_files()
        self.assertEqual(1, len(failed))
        self.assertEqual(before, self.snapshot())
        self.assertFalse(list(commit_root.glob("*.json")), "Failed publication must not have a commit marker")
        self.assertFalse(list(commit_root.glob("*.tmp")))
        self.assert_no_checkpoints()
        self.store._recover_persistent_sync_checkpoints()
        self.assertEqual(before, self.snapshot())
        self.assertTrue(self.store.reload_data_files()["ok"])
        self.assert_semantics(expected)
        self.assert_no_checkpoints()


if __name__ == "__main__":
    unittest.main(verbosity=2)
