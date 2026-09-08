"""DL-02 fixtures: temporary stores, deterministic AI, no network/native process."""

from copy import deepcopy
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch

import server
from server import AIServiceError, COMMENT_CSV_HEADERS, MonitorStore, NOTE_CSV_HEADERS


OBSERVED = "2026-09-03T15:30:00+08:00"
EVIDENCE = {"allCommentsRequested": True, "expandersExhausted": True,
            "scrollExhausted": True, "stableRounds": 2, "pendingLoads": 0, "unreadableCount": 0}
RESULT = {"sentiment": "negative", "is_negative": True, "risk_level": "P2",
          "summary": "Fixture analysis", "reason": "Fixture only", "confidence": 0.99}


class AIPublicationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="ai-publication-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.store_number = 0
        for name in ("socket.socket", "socket.getaddrinfo", "server.urlopen", "subprocess.Popen"):
            guard = patch(name, side_effect=AssertionError("Unexpected network/native operation"))
            guard.start()
            self.addCleanup(guard.stop)
        if hasattr(server.os, "startfile"):
            guard = patch.object(server.os, "startfile", side_effect=AssertionError("Unexpected native operation"))
            guard.start()
            self.addCleanup(guard.stop)
        self.new_store()

    def new_store(self):
        self.store_number += 1
        root = self.root / str(self.store_number)
        self.client = Mock(spec=["complete_json"])
        self.store = MonitorStore(root / "fixture.sqlite3", root / "exports", ai_client=self.client)
        self.notes_path, self.comments_path = self.store.configure_data_files(root / "fixture_notes.csv")
        self.store._ensure_seed_workbook(self.notes_path)
        self.store.ai_settings.get = Mock(return_value={"configured": True, "model": "fixture", "max_tokens": 1800})
        self.notes, self.media = {}, {}
        self.add_note("A")

    def add_note(self, suffix):
        note_id = "ai-note-" + suffix
        note = {"noteId": note_id, "title": "Fixture " + suffix, "content": "Fixture content " + suffix,
                "author": "Fixture author", "url": "https://www.xiaohongshu.com/explore/" + note_id,
                "publishedAt": "2026-09-01", "timeObservedAt": OBSERVED, "detailRead": True}
        comments = [{"commentId": note_id + "-c" + str(i), "content": "Fixture comment " + str(i),
                     "author": "Fixture commenter", "publishedAt": "2026-09-01", "commentLevel": 1,
                     "timeObservedAt": OBSERVED} for i in (1, 2)]
        self.notes[note_id] = (note, comments)
        result = self.store.pull_to_excel({"noteId": note_id, "note": deepcopy(note), "comments": comments,
                                          "commentStatus": "likely_complete", "expectedCount": 2,
                                          "collectionEvidence": EVIDENCE, "collectedAt": OBSERVED})
        self.assertTrue(result["consistencyVerified"])
        self.media[note_id] = Path(result["mediaDir"])
        self.assertTrue(self.media[note_id].resolve().is_relative_to(self.root))
        return note_id

    def rows(self, table):
        with self.store._session() as db:
            return [dict(row) for row in db.execute("SELECT * FROM " + table)]

    def snapshot(self):
        with self.store._session() as db:
            tables = [row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")]
            database = {table: sorted([tuple(row) for row in db.execute('SELECT * FROM "' + table + '"')], key=repr)
                        for table in tables}
        paths = [self.notes_path, self.comments_path]
        paths.extend(path for folder in self.media.values() if folder.is_dir() for path in folder.iterdir() if path.is_file())
        return database, {str(path): path.read_bytes() for path in paths if path.is_file()}

    def jobs(self, mode="single", cross_note=False):
        targets = [("note", "ai-note-A")] if mode == "note" else [("comment", "ai-note-A-c1")]
        if mode == "batch":
            if cross_note:
                self.add_note("B")
            targets.append(("comment", "ai-note-B-c1" if cross_note else "ai-note-A-c2"))
        with self.store._session() as db:
            for target_type, target_id in targets:
                db.execute("""INSERT INTO ai_jobs(target_type,target_id,status,created_at,updated_at)
                              VALUES(?,?,'analyzing',?,?)""", (target_type, target_id, OBSERVED, OBSERVED))
                table, key = ("notes", "note_id") if target_type == "note" else ("comments", "comment_id")
                db.execute(f"UPDATE {table} SET ai_analysis_status='analyzing' WHERE {key}=?", (target_id,))
        with self.store._session() as db:
            return db.execute("SELECT * FROM ai_jobs ORDER BY id").fetchall()

    def assert_model_unlocked(self):
        acquired = []

        def probe():
            for lock in (self.store.pull_lock, self.store.lock):
                ok = lock.acquire(timeout=0.3)
                acquired.append(ok)
                if ok:
                    lock.release()

        thread = threading.Thread(target=probe, daemon=True)
        thread.start()
        thread.join(2)
        self.assertFalse(thread.is_alive())
        self.assertEqual([True, True], acquired, "External model call must release both locks")

    def run_jobs(self, jobs, during_model=None, output=None, batch=False):
        def complete(_settings, _messages):
            self.assert_model_unlocked()
            if during_model:
                during_model()
            if output is not None:
                return deepcopy(output)
            return {"results": [{"target_id": job["target_id"], **RESULT} for job in jobs]} if batch else dict(RESULT)

        self.client.complete_json.side_effect = complete
        if batch:
            self.store._run_comment_batch(jobs)
        else:
            self.store._run_ai_job(jobs[0])

    def assert_ready(self):
        for note_id, folder in self.media.items():
            self.assertTrue(self.store._verify_note_store_consistency(note_id, str(folder), verify_fields=True)["ok"])
        schema = self.store.data_overview_schema()
        self.assertTrue(schema["queryReady"], schema["health"].get("issues"))

    def assert_no_checkpoints(self):
        self.assertIsNone(self.store._active_csv_checkpoint)
        self.assertFalse(list((self.store.export_dir / ".sync_checkpoints").glob("*/checkpoint.json")))

    def test_single_note_and_comment_publish_before_terminal_success(self):
        for mode in ("single", "note", "batch"):
            with self.subTest(mode=mode):
                self.new_store()
                jobs = self.jobs(mode)
                self.assert_ready()
                verified = []
                real_verify = self.store._verify_note_store_consistency

                def verify(note_id, *args, **kwargs):
                    self.assertTrue(self.store.pull_lock._is_owned())
                    self.assertTrue(self.store.lock._is_owned())
                    self.assertEqual([], self.rows("ai_analysis_records"))
                    self.assertEqual({"analyzing"}, {row["status"] for row in self.rows("ai_jobs")})
                    for job in jobs:
                        table, key = ("notes", "note_id") if job["target_type"] == "note" else ("comments", "comment_id")
                        target = next(row for row in self.rows(table) if row[key] == job["target_id"])
                        self.assertEqual("analyzing", target["ai_analysis_status"])
                    verified.append(note_id)
                    return real_verify(note_id, *args, **kwargs)

                with patch.object(self.store, "_verify_note_store_consistency", side_effect=verify):
                    self.run_jobs(jobs, batch=mode == "batch")
                self.assertEqual(["ai-note-A"], verified)
                self.assertEqual({"completed"}, {row["status"] for row in self.rows("ai_jobs")})
                self.assertEqual(len(jobs), len(self.rows("ai_analysis_records")))
                table = "notes" if mode == "note" else "comments"
                key, sentiment = ("note_id", "post_sentiment") if mode == "note" else ("comment_id", "sentiment")
                for job in jobs:
                    row = next(row for row in self.rows(table) if row[key] == job["target_id"])
                    self.assertEqual("negative", row[sentiment])
                    self.assertEqual("completed", row["ai_analysis_status"])
                note = self.rows("notes")[0]
                self.assertEqual(0 if mode == "note" else len(jobs), note["negative_comment_count"])
                csv_path, headers = (self.notes_path, NOTE_CSV_HEADERS) if mode == "note" else (self.comments_path, COMMENT_CSV_HEADERS)
                self.assertEqual("差评", self.store._read_csv_table(csv_path, headers)[1][0]["AI情绪判断"])
                material = json.loads((self.media["ai-note-A"] / ("note.json" if mode == "note" else "comments.json")).read_text(encoding="utf-8"))
                self.assertEqual("差评", material["postSentiment"] if mode == "note" else material[0]["sentiment"])
                self.assert_no_checkpoints()
                self.assert_ready()

    def test_batch_across_notes_publishes_every_note(self):
        jobs = self.jobs("batch", cross_note=True)
        self.run_jobs(jobs, batch=True)
        self.assertEqual([1, 1], [row["negative_comment_count"] for row in self.rows("notes")])
        self.assertEqual(2, len(self.rows("ai_analysis_records")))
        self.assertEqual({"completed"}, {row["status"] for row in self.rows("ai_jobs")})
        self.assert_ready()

    def test_projection_failures_restore_all_stores_and_allow_retry(self):
        for mode in ("single", "note", "batch"):
            for failure in ("notes_csv", "comments_csv", "material", "verification"):
                with self.subTest(mode=mode, failure=failure):
                    self.new_store()
                    jobs = self.jobs(mode, cross_note=mode == "batch")
                    before = self.snapshot()
                    last_note = "ai-note-B" if mode == "batch" else "ai-note-A"
                    target = {"notes_csv": self.notes_path, "comments_csv": self.comments_path,
                              "material": self.media[last_note] / "note.json"}.get(failure)
                    fired = []
                    material_failures = 0
                    real_replace = server.os.replace
                    real_csv_replace = server.replace_with_retry
                    real_verify = self.store._verify_note_store_consistency

                    def replace(source, destination):
                        nonlocal material_failures
                        if failure == "material" and material_failures < 6 and Path(destination) == target:
                            material_failures += 1
                            if not fired:
                                fired.append(True)
                            # A one-shot sharing lock is now recovered locally.
                            # Exhaust all short retries to exercise rollback;
                            # release the lock for the rollback itself.
                            raise PermissionError("Injected exhausted material replacement retries")
                        return real_replace(source, destination)

                    def csv_replace(source, destination, *args, **kwargs):
                        if failure in {"notes_csv", "comments_csv"} and not fired and Path(destination) == target:
                            fired.append(True)
                            raise PermissionError("Injected exhausted CSV replacement retries")
                        return real_csv_replace(source, destination, *args, **kwargs)

                    def verify(note_id, *args, **kwargs):
                        result = real_verify(note_id, *args, **kwargs)
                        if failure == "verification" and note_id == last_note and not fired:
                            fired.append(True)
                            raise ValueError("Injected verification failure")
                        return result

                    with patch.object(server.os, "replace", side_effect=replace), \
                            patch.object(server, "replace_with_retry", side_effect=csv_replace), \
                            patch.object(self.store, "_verify_note_store_consistency", side_effect=verify):
                        with self.assertRaises(AIServiceError) as error:
                            self.run_jobs(jobs, batch=mode == "batch")
                    self.assertEqual([True], fired)
                    self.assertEqual("publication_failed", error.exception.kind)
                    self.assertTrue(error.exception.retryable)
                    self.assertEqual(before, self.snapshot())
                    self.assert_no_checkpoints()
                    self.assert_ready()
                    self.run_jobs(jobs, batch=mode == "batch")
                    self.assertEqual(len(jobs), len(self.rows("ai_analysis_records")))
                    self.assertEqual({"completed"}, {row["status"] for row in self.rows("ai_jobs")})
                    self.assert_ready()

    def test_checkpoint_capture_failure_cleans_up_without_mutation(self):
        jobs = self.jobs("batch", cross_note=True)
        before = self.snapshot()
        real_capture = self.store._capture_sync_checkpoint

        def capture(note_id, **kwargs):
            if note_id == "ai-note-B":
                raise OSError("Injected checkpoint capture failure")
            return real_capture(note_id, **kwargs)

        with patch.object(self.store, "_capture_sync_checkpoint", side_effect=capture):
            with self.assertRaises(AIServiceError) as error:
                self.run_jobs(jobs, batch=True)
        self.assertTrue(error.exception.retryable)
        self.assertEqual(before, self.snapshot())
        self.assert_no_checkpoints()

    def test_final_history_transaction_failure_rolls_back_first_job_too(self):
        jobs = self.jobs("batch", cross_note=True)
        with self.store._session() as db:
            db.execute("""CREATE TRIGGER fail_second_history BEFORE INSERT ON ai_analysis_records
                          WHEN NEW.target_id='ai-note-B-c1' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END""")
        before = self.snapshot()
        with self.assertRaises(AIServiceError) as error:
            self.run_jobs(jobs, batch=True)
        self.assertTrue(error.exception.retryable)
        self.assertEqual(before, self.snapshot())
        self.assert_no_checkpoints()
        self.assert_ready()

    def test_missing_batch_result_never_partially_publishes(self):
        jobs = self.jobs("batch")
        before = self.snapshot()
        with self.assertRaises(AIServiceError) as error:
            self.run_jobs(jobs, output={"results": [{"target_id": jobs[0]["target_id"], **RESULT}]}, batch=True)
        self.assertEqual("invalid_response", error.exception.kind)
        self.assertTrue(error.exception.retryable)
        self.assertEqual(before, self.snapshot())
        self.assert_no_checkpoints()

    def test_silent_material_noop_is_detected_and_rolled_back(self):
        jobs = self.jobs("batch", cross_note=True)
        before = self.snapshot()
        with patch.object(self.store, "_refresh_material_snapshot_for_note", return_value=""):
            with self.assertRaises(AIServiceError) as error:
                self.run_jobs(jobs, batch=True)
        self.assertEqual("publication_failed", error.exception.kind)
        self.assertTrue(error.exception.retryable)
        self.assertEqual(before, self.snapshot())
        self.assert_no_checkpoints()
        self.assert_ready()

    def test_projection_rollback_preserves_review_edited_during_model_call(self):
        jobs = self.jobs("batch", cross_note=True)
        after_edit = []

        def edit():
            self.store.update_review({"targetType": "comment", "targetId": "ai-note-A-c1",
                                      "reviewStatus": "resolved", "manualNegative": True,
                                      "note": "Written while model was running"})
            after_edit.append(self.snapshot())

        real_refresh = self.store._refresh_material_snapshot_for_note

        def refresh(note_id):
            if note_id == "ai-note-B":
                raise OSError("Injected second-note material failure")
            return real_refresh(note_id)

        with patch.object(self.store, "_refresh_material_snapshot_for_note", side_effect=refresh):
            with self.assertRaises(AIServiceError) as error:
                self.run_jobs(jobs, during_model=edit, batch=True)
        self.assertTrue(error.exception.retryable)
        self.assertEqual(after_edit[0], self.snapshot())
        self.assert_no_checkpoints()
        self.assert_ready()

    def test_inflight_comment_deletion_and_content_changes_are_not_published(self):
        mutations = {
            "hard_delete": ("DELETE FROM comments WHERE comment_id='ai-note-A-c1'", "missing_target"),
            "soft_delete": ("UPDATE comments SET is_deleted=1,comment_status='已删除',deleted_at='fixture' WHERE comment_id='ai-note-A-c1'", "missing_target"),
            "deleted_flag": ("UPDATE comments SET is_deleted=1 WHERE comment_id='ai-note-A-c1'", "missing_target"),
            "content": ("UPDATE comments SET content='New content, deliberately unchanged hash' WHERE comment_id='ai-note-A-c1'", "stale_target"),
            "author": ("UPDATE comments SET author='New author' WHERE comment_id='ai-note-A-c1'", "stale_target"),
            "parent": ("UPDATE comments SET parent_comment_id='new-parent' WHERE comment_id='ai-note-A-c1'", "stale_target"),
            "owner": ("UPDATE comments SET note_id='ai-note-B' WHERE comment_id='ai-note-A-c1'", "stale_target"),
            "recreated": ("UPDATE comments SET first_seen_at='later incarnation' WHERE comment_id='ai-note-A-c1'", "stale_target"),
            "parent_deleted": ("DELETE FROM notes WHERE note_id='ai-note-A'", "missing_target"),
            "parent_soft_deleted": ("UPDATE notes SET is_deleted=1,post_status='已删除' WHERE note_id='ai-note-A'", "missing_target"),
            "parent_deleted_flag": ("UPDATE notes SET is_deleted=1 WHERE note_id='ai-note-A'", "missing_target"),
            "context": ("UPDATE notes SET title='Changed prompt context' WHERE note_id='ai-note-A'", "stale_target"),
            "job_cancelled": ("DELETE FROM ai_jobs WHERE target_id='ai-note-A-c1'", "stale_job"),
        }
        for batch in (False, True):
            for name, (sql, kind) in mutations.items():
                with self.subTest(batch=batch, mutation=name):
                    self.new_store()
                    jobs = self.jobs("batch" if batch else "single", cross_note=batch)
                    after_mutation = []

                    def mutate():
                        with self.store.pull_lock, self.store.lock, self.store._session() as db:
                            db.execute(sql)
                        after_mutation.append(self.snapshot())

                    with patch.object(self.store, "_capture_sync_checkpoint", wraps=self.store._capture_sync_checkpoint) as capture:
                        with self.assertRaises(AIServiceError) as error:
                            self.run_jobs(jobs, during_model=mutate, batch=batch)
                        capture.assert_not_called()
                    self.assertEqual(kind, error.exception.kind)
                    self.assertEqual(kind == "stale_target", error.exception.retryable)
                    self.assertEqual(after_mutation[0], self.snapshot())
                    self.assert_no_checkpoints()

    def test_inflight_note_deletion_and_prompt_changes_are_not_published(self):
        for change, kind in (("DELETE FROM notes WHERE note_id='ai-note-A'", "missing_target"),
                             ("UPDATE notes SET is_deleted=1,post_status='已删除' WHERE note_id='ai-note-A'", "missing_target"),
                             ("UPDATE notes SET content='Changed' WHERE note_id='ai-note-A'", "stale_target"),
                             ("UPDATE notes SET tags='Changed' WHERE note_id='ai-note-A'", "stale_target")):
            with self.subTest(change=change):
                self.new_store()
                jobs = self.jobs("note")
                after_mutation = []

                def mutate():
                    with self.store.pull_lock, self.store.lock, self.store._session() as db:
                        db.execute(change)
                    after_mutation.append(self.snapshot())

                with self.assertRaises(AIServiceError) as error:
                    self.run_jobs(jobs, during_model=mutate)
                self.assertEqual(kind, error.exception.kind)
                self.assertEqual(after_mutation[0], self.snapshot())

    def test_deleted_targets_are_rejected_before_model_call(self):
        for mode in ("note", "single", "batch"):
            with self.subTest(mode=mode):
                self.new_store()
                jobs = self.jobs(mode)
                table = "notes" if mode == "note" else "comments"
                with self.store._session() as db:
                    db.execute("UPDATE " + table + " SET is_deleted=1")
                before = self.snapshot()
                with self.assertRaises(AIServiceError) as error:
                    self.run_jobs(jobs, batch=mode == "batch")
                self.assertEqual("missing_target", error.exception.kind)
                self.client.complete_json.assert_not_called()
                self.assertEqual(before, self.snapshot())

    def test_manual_sentiment_review_and_semantic_fields_survive(self):
        for mode in ("note", "single", "batch"):
            for during in (False, True):
                with self.subTest(mode=mode, during_model=during):
                    self.new_store()
                    jobs = self.jobs(mode)
                    table, sentiment = ("notes", "post_sentiment") if mode == "note" else ("comments", "sentiment")

                    def manual_edit():
                        with self.store.pull_lock, self.store.lock, self.store._session() as db:
                            db.execute(f"""UPDATE {table} SET {sentiment}='positive',manual_negative=1,
                                           review_status='resolved',review_note='Keep manual decision',
                                           semantic_analysis_count=7,analysis_is_negative='否',
                                           negative_type='manual type',negative_subtype='manual subtype'""")
                        self.store._normalize_csv_cross_store_fields()
                        self.store._refresh_material_snapshot_for_note("ai-note-A")

                    if not during:
                        manual_edit()
                    self.run_jobs(jobs, during_model=manual_edit if during else None, batch=mode == "batch")
                    for row in self.rows(table):
                        self.assertEqual(("positive", 1, "resolved", "Keep manual decision", 7, "否", "manual type", "manual subtype"),
                                         tuple(row[key] for key in (sentiment, "manual_negative", "review_status", "review_note",
                                                                   "semantic_analysis_count", "analysis_is_negative", "negative_type", "negative_subtype")))
                    self.assert_ready()

    def test_unreviewed_imported_sentiment_and_inflight_label_edit_survive(self):
        for during in (False, True):
            with self.subTest(during_model=during):
                self.new_store()
                jobs = self.jobs()

                def edit():
                    with self.store._session() as db:
                        db.execute("UPDATE comments SET sentiment='positive' WHERE comment_id='ai-note-A-c1'")

                if during:
                    with self.store._session() as db:
                        db.execute("UPDATE comments SET last_ai_analyzed_at=?", (OBSERVED,))
                else:
                    edit()
                self.run_jobs(jobs, during_model=edit if during else None)
                self.assertEqual("positive", self.rows("comments")[0]["sentiment"])
                self.assert_ready()

    def test_deleted_sibling_stays_deleted_and_is_excluded_from_count(self):
        jobs = self.jobs()
        with self.store._session() as db:
            db.execute("""UPDATE comments SET is_deleted=1,comment_status='已删除',deleted_at='fixture',
                          sentiment='negative',is_negative=1,ai_confidence=0.99 WHERE comment_id='ai-note-A-c2'""")
        headers, rows = self.store._read_csv_table(self.comments_path, COMMENT_CSV_HEADERS)
        rows[1]["评论状态"], rows[1]["AI情绪判断"] = "已删除", "差评"
        self.store._replace_csv_table(self.comments_path, headers, rows, "fixture-deleted-sibling")
        self.store._refresh_material_snapshot_for_note("ai-note-A")
        before = self.rows("comments")[1]
        self.run_jobs(jobs)
        self.assertEqual(before, self.rows("comments")[1])
        self.assertEqual(1, self.rows("notes")[0]["negative_comment_count"])
        self.assert_ready()


if __name__ == "__main__":
    unittest.main(verbosity=2)
