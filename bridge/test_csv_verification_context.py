"""Real temporary CSV/SQLite/material fixtures; no network, deployment or GUI.

Run from bridge: python -B -m unittest -v test_csv_verification_context
The synthetic benchmark reports CSV parses and byte passes, NOT sync latency.
"""
import csv
import io
import json
import os
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

import csv_verification_context as contexts
import server
import test_ai_publication as fixtures


class CsvParsingTests(unittest.TestCase):
    def test_parser_matches_existing_reader_for_encodings_and_edge_rows(self):
        with tempfile.TemporaryDirectory(prefix="csv-verification-parser-") as root:
            path = Path(root) / "synthetic.csv"
            for encoding in ("utf-8-sig", "utf-8", "utf-16", "gb18030"):
                for value in ('名称,值\r\n测试,"行一\r\n行二"\r\n,\r\n',
                              ' 名称 ,值,值\n测试,a,b\n多列,1,2,3\n', '', '\n'):
                    with self.subTest(encoding=encoding, value=value):
                        raw = value.encode(encoding)
                        path.write_bytes(raw)
                        expected = server.MonitorStore._read_csv_table(path, ["名称", "值", "缺列"])
                        self.assertEqual(expected, contexts._parse_csv(raw, ["名称", "值", "缺列"]))


class CsvVerificationTests(unittest.TestCase):
    # Helpers create a real SQLite database and real synthetic media snapshots
    # under TemporaryDirectory. Network/process APIs are guarded by the fixture.
    setUp = fixtures.AIPublicationTests.setUp
    new_store = fixtures.AIPublicationTests.new_store
    add_note = fixtures.AIPublicationTests.add_note
    snapshot = fixtures.AIPublicationTests.snapshot
    rows = fixtures.AIPublicationTests.rows

    def verify(self, note_id="ai-note-A", verify_fields=True):
        return self.store._verify_note_store_consistency(note_id, str(self.media[note_id]), verify_fields)

    def batch(self):
        return self.store._batch_csv_verification_context()

    def rewrite_csv(self, path, mutate):
        headers, rows = self.store._read_csv_table(path, [])
        mutate(rows)
        stream = io.StringIO(newline="")
        writer = csv.DictWriter(stream, fieldnames=headers)
        writer.writeheader(); writer.writerows(rows)
        path.write_bytes(stream.getvalue().encode("utf-8-sig"))

    def test_indexed_result_exactly_matches_legacy_including_field_hashes_and_media(self):
        self.add_note("B")
        expected = {key: self.verify(key) for key in self.media}
        for result in expected.values():
            self.assertGreater(result["fieldChecks"], 0)
            self.assertEqual(2, result["materialIds"])
        with self.batch() as context:
            with patch.object(self.store, "_read_csv_table", side_effect=AssertionError("Repeated CSV parse")):
                self.assertEqual(expected, {key: self.verify(key) for key in self.media})
                self.assertEqual(0, self.verify(verify_fields=False)["fieldChecks"])
            with self.assertRaises(TypeError):
                context.notes["ai-note-A"][0]["笔记标题"] = "mutated"
        self.assertIsNone(contexts.active_for(self.store, self.store._csv_paths()))
        with self.assertRaises(contexts.CsvVerificationChanged):
            context.check_metadata()
        with patch.object(self.store, "_read_csv_table", wraps=self.store._read_csv_table) as read:
            self.verify()
            self.assertEqual(2, read.call_count)  # Public old signature has no lasting cache.

    def test_all_existing_failure_checks_remain_equivalent(self):
        self.add_note("B")
        note_path = self.media["ai-note-A"] / "note.json"
        material_path = self.media["ai-note-A"] / "comments.json"
        csv_cases = [
            (self.notes_path, lambda r: r.append(dict(r[0])), "笔记 CSV"),
            (self.comments_path, lambda r: r.append(dict(r[0])), "重复评论 ID"),
            (self.comments_path, lambda r: r[0].update({"笔记评论ID": ""}), "空评论 ID"),
            (self.comments_path, lambda r: r.pop(0), "ID 集合不一致"),
            (self.comments_path, lambda r: r[0].update({"评论状态": "已删除"}), "状态不一致"),
            (self.notes_path, lambda r: r[0].update({"访问状态": "待复核"}), "访问状态不一致"),
            (self.notes_path, lambda r: r[0].update({"笔记标题": "bad field"}), "字段一致性"),
            (self.comments_path, lambda r: r[0].update({"评论内容": "bad field"}), "字段一致性"),
            (self.comments_path, lambda r: r.append({**r[0], "笔记ID": "ai-note-B"}), "其他帖子"),
        ]
        for path, mutate, error in csv_cases:
            with self.subTest(error=error, path=path.name):
                before = path.read_bytes()
                try:
                    self.rewrite_csv(path, mutate)
                    with self.assertRaisesRegex(ValueError, error) as old:
                        self.verify()
                    with self.batch():
                        with self.assertRaises(ValueError) as indexed:
                            self.verify()
                    self.assertEqual(str(old.exception), str(indexed.exception))
                finally:
                    path.write_bytes(before)
        for path, change in (
            (material_path, lambda rows: rows + [rows[0]]),
            (material_path, lambda rows: rows[1:]),
            (material_path, lambda rows: [{**rows[0], "content": "bad field"}, *rows[1:]]),
            (note_path, lambda row: {**row, "postStatus": "已删除", "isDeleted": True}),
        ):
            with self.subTest(material=path.name, change=change):
                before = path.read_bytes()
                try:
                    path.write_text(json.dumps(change(json.loads(before.decode("utf-8-sig")))) , encoding="utf-8")
                    with self.assertRaises(ValueError) as old:
                        self.verify()
                    with self.batch():
                        with self.assertRaises(ValueError) as indexed:
                            self.verify()
                    self.assertEqual(str(old.exception), str(indexed.exception))
                finally:
                    path.write_bytes(before)

    def test_metadata_replacement_missing_and_same_size_mtime_fail_closed(self):
        for mode in ("replace", "delete", "mtime", "same-size-mtime"):
            with self.subTest(mode=mode):
                before = self.notes_path.read_bytes()
                stamp = self.notes_path.stat()
                try:
                    with self.assertRaises((contexts.CsvVerificationChanged, OSError)):
                        with self.batch():
                            if mode == "replace":
                                replacement = self.notes_path.with_suffix(".replacement")
                                replacement.write_bytes(before)
                                os.utime(replacement, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))
                                os.replace(replacement, self.notes_path)
                            elif mode == "delete":
                                self.notes_path.unlink()
                            elif mode == "mtime":
                                os.utime(self.notes_path, ns=(stamp.st_atime_ns, stamp.st_mtime_ns + 1000000000))
                            else:
                                changed = before.replace(b"Fixture", b"Changed", 1)
                                self.assertNotEqual(before, changed)
                                self.assertEqual(len(before), len(changed))
                                self.notes_path.write_bytes(changed)
                                os.utime(self.notes_path, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))
                finally:
                    self.notes_path.write_bytes(before)
                self.assertIsNone(contexts.active_for(self.store, self.store._csv_paths()))

    def test_digest_detects_content_edit_even_if_all_stat_fields_are_identical(self):
        before = self.comments_path.read_bytes()
        # Models filesystems/tools that preserve every observed metadata field.
        with patch.object(contexts, "_stamp", return_value=(1, 2, 3, 4, 5, 6)):
            try:
                with self.assertRaisesRegex(contexts.CsvVerificationChanged, "摘要"):
                    with self.batch():
                        self.verify()
                        changed = before.replace(b"Fixture", b"Changed", 1)
                        self.assertNotEqual(before, changed)
                        self.comments_path.write_bytes(changed)
            finally:
                self.comments_path.write_bytes(before)

    def test_change_between_two_initial_reads_is_rejected(self):
        before = self.notes_path.read_bytes()
        read = contexts._read_stable
        def racing_read(path, stamp, *, capture):
            value = read(path, stamp, capture=capture)
            if path == self.comments_path and capture:
                self.notes_path.write_bytes(before + b"\r\n")
            return value
        try:
            with patch.object(contexts, "_read_stable", side_effect=racing_read):
                with self.assertRaises(contexts.CsvVerificationChanged):
                    with self.batch():
                        self.fail("Unstable context was exposed")
        finally:
            self.notes_path.write_bytes(before)

    def test_changed_context_never_falls_back_to_a_fresh_or_stale_table(self):
        before = self.comments_path.read_bytes()
        try:
            with self.assertRaises(contexts.CsvVerificationChanged):
                with self.batch():
                    self.comments_path.write_bytes(before + b"\r\n")
                    with patch.object(self.store, "_read_csv_table", side_effect=AssertionError("Silent fallback")):
                        with self.assertRaises(contexts.CsvVerificationChanged):
                            self.verify()
                    # Restoring bytes does not revive a context already failed.
                    self.comments_path.write_bytes(before)
        finally:
            self.comments_path.write_bytes(before)

    def test_initial_read_error_is_inside_the_original_batch_rollback(self):
        before = self.snapshot()
        with patch.object(contexts, "_read_stable", side_effect=OSError("fixture initial read failure")), \
                patch.object(self.store, "_rollback_sync_checkpoints", wraps=self.store._rollback_sync_checkpoints) as rollback:
            with self.assertRaisesRegex(OSError, "fixture initial read failure"):
                self.store.set_note_access_statuses({"items": [{"noteId": "ai-note-A", "status": "check_failed"}]})
            rollback.assert_called_once()
        self.assertEqual(before, self.snapshot())
        self.assertIsNone(contexts.active_for(self.store, self.store._csv_paths()))

    def test_owner_thread_scope_and_poisoned_context(self):
        with self.batch() as context:
            self.assertIsNone(contexts.active_for(object(), self.store._csv_paths()))
            errors = []
            def unrelated_thread():
                try:
                    self.assertIsNone(contexts.active_for(self.store, self.store._csv_paths()))
                except BaseException as exc:
                    errors.append(exc)
            thread = threading.Thread(target=unrelated_thread)
            thread.start(); thread.join()
            self.assertEqual([], errors)
        self.assertTrue(context.closed)
        with self.assertRaises(contexts.CsvVerificationChanged):
            with self.batch():
                with self.assertRaises(contexts.CsvVerificationChanged):
                    contexts.active_for(self.store, (self.comments_path, self.notes_path))
                # Even if a caller catches the initial failure, exit still fails.

    def test_batch_builds_only_after_all_refreshes_and_ignores_request_context(self):
        self.add_note("B")
        events = []
        refresh = self.store._refresh_material_snapshot_for_note
        parse = contexts._parse_csv
        def tracked_refresh(note_id):
            result = refresh(note_id)
            events.append("refresh:" + note_id)
            return result
        def tracked_parse(*args):
            self.assertTrue(self.store.pull_lock._is_owned())
            events.append("parse")
            return parse(*args)
        payload = {"items": [{"noteId": note_id, "status": "ok", "result": "opened"} for note_id in self.media],
                   "validatedcontext": {"ok": True}, "csv_context": {"fake": True}}
        with patch.object(self.store, "_refresh_material_snapshot_for_note", side_effect=tracked_refresh), \
                patch.object(contexts, "_parse_csv", side_effect=tracked_parse):
            result = self.store.set_note_access_statuses(payload)
        self.assertTrue(result["consistencyVerified"])
        self.assertEqual(["refresh:ai-note-A", "refresh:ai-note-B", "parse", "parse"], events)
        self.assertEqual([self.verify(key) for key in self.media], result["verified"])

    def test_batch_digest_failure_rolls_back_real_csv_sqlite_and_materials(self):
        self.add_note("B")
        before = self.snapshot()
        verify = self.store._verify_note_store_consistency
        def change_after_verify(note_id, *args, **kwargs):
            result = verify(note_id, *args, **kwargs)
            if note_id == "ai-note-B":
                raw = self.notes_path.read_bytes()
                self.notes_path.write_bytes(raw.replace(b"Fixture", b"Changed", 1))
                # Simulate an erroneous managed write, not an outside editor:
                # original rollback correctly restores only managed CSV bytes.
                self.store._remember_managed_csv(self.notes_path)
            return result
        with patch.object(contexts, "_stamp", return_value=(1, 2, 3, 4, 5, 6)), \
                patch.object(self.store, "_verify_note_store_consistency", side_effect=change_after_verify), \
                patch.object(self.store, "_rollback_sync_checkpoints", wraps=self.store._rollback_sync_checkpoints) as rollback:
            with self.assertRaisesRegex(contexts.CsvVerificationChanged, "摘要"):
                self.store.set_note_access_statuses({"items": [
                    {"noteId": key, "status": "check_failed", "error": "synthetic", "result": "fixture"}
                    for key in self.media]})
            rollback.assert_called_once()
        self.assertEqual(before, self.snapshot())
        self.assertIsNone(contexts.active_for(self.store, self.store._csv_paths()))
        self.assertIsNone(self.store._active_csv_checkpoint)

    def test_external_digest_edit_invokes_rollback_but_retains_original_conflict_guard(self):
        verify = self.store._verify_note_store_consistency
        external_bytes = []
        def external_edit(note_id, *args, **kwargs):
            result = verify(note_id, *args, **kwargs)
            raw = self.notes_path.read_bytes().replace(b"Fixture", b"Changed", 1)
            external_bytes.append(raw)
            self.notes_path.write_bytes(raw)
            return result
        with patch.object(contexts, "_stamp", return_value=(1, 2, 3, 4, 5, 6)), \
                patch.object(self.store, "_verify_note_store_consistency", side_effect=external_edit), \
                patch.object(self.store, "_rollback_sync_checkpoints", wraps=self.store._rollback_sync_checkpoints) as rollback:
            with self.assertRaisesRegex(RuntimeError, "回滚未完全成功.*外部修改") as raised:
                self.store.set_note_access_statuses({"items": [{"noteId": "ai-note-A", "status": "ok"}]})
            rollback.assert_called_once()
        self.assertIsInstance(raised.exception.__cause__, contexts.CsvVerificationChanged)
        self.assertIn("摘要", str(raised.exception.__cause__))
        self.assertEqual(external_bytes[0], self.notes_path.read_bytes())
        self.assertIsNone(contexts.active_for(self.store, self.store._csv_paths()))
        self.assertTrue(list((self.store.export_dir / ".sync_checkpoints").glob("*/checkpoint.json")))

    def test_digest_read_io_error_rolls_back_without_reusing_context(self):
        before = self.snapshot()
        read = contexts._read_stable
        def failing_read(path, stamp, *, capture):
            if not capture:
                raise OSError("fixture digest read failure")
            return read(path, stamp, capture=capture)
        with patch.object(contexts, "_read_stable", side_effect=failing_read), \
                patch.object(self.store, "_rollback_sync_checkpoints", wraps=self.store._rollback_sync_checkpoints) as rollback:
            with self.assertRaisesRegex(OSError, "fixture digest read failure"):
                self.store.set_note_access_statuses({"items": [{"noteId": "ai-note-A", "status": "check_failed"}]})
            rollback.assert_called_once()
        self.assertEqual(before, self.snapshot())
        self.assertIsNone(contexts.active_for(self.store, self.store._csv_paths()))

    def test_live_sqlite_and_material_checks_are_not_cached(self):
        with self.batch():
            self.verify()
            with self.store._session() as db:
                db.execute("UPDATE comments SET content='synthetic changed field' WHERE comment_id='ai-note-A-c1'")
            with self.assertRaisesRegex(ValueError, "字段一致性"):
                self.verify()

    def test_verifier_failure_still_uses_original_rollback(self):
        before = self.snapshot()
        with patch.object(self.store, "_verify_note_field_consistency", side_effect=ValueError("fixture field failure")), \
                patch.object(self.store, "_rollback_sync_checkpoints", wraps=self.store._rollback_sync_checkpoints) as rollback:
            with self.assertRaisesRegex(ValueError, "fixture field failure"):
                self.store.set_note_access_statuses({"items": [{"noteId": "ai-note-A", "status": "check_failed"}]})
            rollback.assert_called_once()
        self.assertEqual(before, self.snapshot())

    def test_synthetic_benchmark_2n_to_2_parses_and_exact_results(self):
        # Eight distinct notes, each with two comments and real material files.
        for suffix in "BCDEFGH":
            self.add_note(suffix)
        N = len(self.media)
        with patch.object(self.store, "_read_csv_table", wraps=self.store._read_csv_table) as legacy:
            expected = [self.verify(key) for key in self.media]
        with patch.object(contexts, "_parse_csv", wraps=contexts._parse_csv) as parse, \
                patch.object(contexts, "_read_stable", wraps=contexts._read_stable) as read, \
                patch.object(self.store, "_read_csv_table", wraps=self.store._read_csv_table) as fallback:
            with self.batch():
                actual = [self.verify(key) for key in self.media]
        self.assertEqual(expected, actual)
        self.assertEqual(2 * N, legacy.call_count)
        self.assertEqual(2, parse.call_count)
        self.assertEqual(0, fallback.call_count)
        self.assertEqual([True, True, False, False], [call.kwargs["capture"] for call in read.call_args_list])
        print(json.dumps({"N": N, "legacyCsvParses": legacy.call_count, "batchCsvParses": parse.call_count,
                          "initialByteReads": 2, "finalDigestReads": 2, "equalResults": True,
                          "wallClockClaim": False}))


if __name__ == "__main__":
    unittest.main()
