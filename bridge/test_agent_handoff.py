"""Isolated CLI tests: mocked HTTP and temporary artifacts, no business data."""
import copy
import io
import json
from pathlib import Path
import tempfile
import unittest
from contextlib import redirect_stdout, redirect_stderr
from unittest.mock import Mock, patch
from urllib.error import HTTPError
import agent_handoff as cli


def submission():
    return {"batchId": "fixture-batch", "agent": "unknown", "model": "unknown", "items": [{
        "targetType": "comment", "targetId": "comment-fixture", "noteId": "fixture-note",
        "sourceHash": "fixture-hash", "analysisRevision": "a" * 64, "analysisIsNegative": "否",
        "negativeType": "信息咨询", "negativeSubtype": "价格询问", "reason": "中性询问", "evidence": ["多少钱？"]}]}


def exported():
    return {"protocolVersion": 1, "classificationPolicyVersion": 2, "batchId": "fixture-batch", "items": [],
            "pendingCount": 0, "excludedCount": 2, "needsReviewCount": 1}


def receipt():
    return {"ok": True, "status": "committed", "batchId": "fixture-batch", "verified": True}


class NetworkTests(unittest.TestCase):
    def test_loopback_allowlist(self):
        self.assertEqual(cli.DEFAULT_BASE_URL, cli.loopback_url(cli.DEFAULT_BASE_URL))
        self.assertEqual(cli.DEFAULT_BASE_URL, cli.loopback_url("http://localhost:17881"))
        self.assertEqual("http://[::1]:17881", cli.loopback_url("http://[::1]:17881"))
        for url in ("https://127.0.0.1", "http://example.com", "http://192.168.0.1", "http://127.0.0.1/path",
                    "http://user:secret@127.0.0.1", "http://127.0.0.1?token=x", "http://127.0.0.1:0", "file:///tmp/x"):
            with self.subTest(url=url), self.assertRaises(cli.HandoffError): cli.loopback_url(url)

    def test_proxy_disabled_and_redirect_blocked(self):
        with patch.object(cli, "build_opener") as opener:
            cli.Client()
            self.assertEqual({}, opener.call_args.args[0].proxies)
            with self.assertRaises(cli.HandoffError):
                opener.call_args.args[1].redirect_request(None, None, 302, "", {}, "http://example.com")

    def test_json_post_contract(self):
        client = cli.Client()
        response = Mock()
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        response.read.return_value = json.dumps(exported()).encode()
        client.opener = Mock()
        client.opener.open.return_value = response
        self.assertEqual(exported(), client.post("pending", {"limit": 1}))
        req = client.opener.open.call_args.args[0]
        self.assertEqual("POST", req.method)
        self.assertEqual(cli.DEFAULT_BASE_URL + "/api/agent-analysis/pending", req.full_url)
        self.assertEqual({"limit": 1}, json.loads(req.data))

    def test_404_requires_upgrade(self):
        client = cli.Client()
        client.opener = Mock()
        client.opener.open.side_effect = HTTPError(cli.DEFAULT_BASE_URL, 404, "missing", {}, None)
        with self.assertRaisesRegex(cli.HandoffError, "升级"): client.post("pending", {"limit": 1})
        self.assertEqual(1, client.opener.open.call_count)

    def test_timeout_queries_same_batch_without_resubmit(self):
        client = cli.Client()
        client.post = Mock(side_effect=[cli.UncertainSubmit("timeout"), receipt()])
        self.assertEqual(receipt(), client.submit(submission()))
        self.assertEqual(["submit", "status"], [call.args[0] for call in client.post.call_args_list])
        self.assertEqual({"batchId": "fixture-batch"}, client.post.call_args.args[1])

    def test_unresolved_timeout_stops(self):
        for state in ("not_found", "preparing", "recovery_required"):
            client = cli.Client()
            client.post = Mock(side_effect=[cli.UncertainSubmit("timeout"), {"status": state}])
            with self.subTest(state=state), self.assertRaisesRegex(cli.HandoffError, "fixture-batch"):
                client.submit(submission())
            self.assertEqual(2, client.post.call_count)

    def test_bad_receipt_rejected(self):
        for change in ({"batchId": "other"}, {"verified": False}, {"status": "preparing"}):
            client = cli.Client()
            client.post = Mock(return_value={**receipt(), **change})
            with self.subTest(change=change), self.assertRaises(cli.HandoffError): client.submit(submission())

    def test_submit_transport_timeout_and_500_are_uncertain(self):
        for failure in (TimeoutError(), HTTPError(cli.DEFAULT_BASE_URL, 500, "failed", {}, None)):
            client = cli.Client()
            client.opener = Mock()
            client.opener.open.side_effect = failure
            with self.subTest(failure=type(failure).__name__), self.assertRaises(cli.UncertainSubmit):
                client.post("submit", submission())

    def test_400_is_not_automatically_retried(self):
        client = cli.Client()
        client.opener = Mock()
        client.opener.open.side_effect = HTTPError(cli.DEFAULT_BASE_URL, 400, "stale", {}, None)
        with self.assertRaisesRegex(cli.HandoffError, "400"): client.submit(submission())
        self.assertEqual(1, client.opener.open.call_count)

    def test_400_preserves_only_bounded_error_fields(self):
        body = {"errorKind": "stale_target", "error": "原文已变化，请重新导出。" + "长" * 1200,
                "config": {"apiKey": "DO_NOT_PRINT"}, "apiKey": "ALSO_PRIVATE"}
        client = cli.Client()
        client.opener = Mock()
        client.opener.open.side_effect = HTTPError(cli.DEFAULT_BASE_URL, 400, "bad", {},
                                                  io.BytesIO(json.dumps(body, ensure_ascii=False).encode()))
        with self.assertRaises(cli.HandoffError) as caught:
            client.submit(submission())
        message = str(caught.exception)
        self.assertIn("HTTP 400", message)
        details = json.loads(message[message.index("{"):])
        self.assertEqual({"errorKind": "stale_target", "error": body["error"][:1000]}, details)
        self.assertNotIn("DO_NOT_PRINT", message)
        self.assertNotIn("ALSO_PRIVATE", message)
        self.assertEqual(1, client.opener.open.call_count)

    def test_invalid_or_oversized_http_error_has_only_generic_status(self):
        for raw in (b'<html>private</html>', b'[]', b'null', b'{"error":{"config":"private"}}',
                    b'x' * (cli.MAX_ERROR_BYTES + 1)):
            exc = HTTPError(cli.DEFAULT_BASE_URL, 400, "private", {}, io.BytesIO(raw))
            with self.subTest(raw=raw[:30]):
                message = cli.http_error_message(exc)
                self.assertIn("HTTP 400", message)
                self.assertNotIn("private", message)
                self.assertNotIn("{", message)

    def test_error_kind_is_bounded(self):
        exc = HTTPError(cli.DEFAULT_BASE_URL, 400, "bad", {},
                        io.BytesIO(json.dumps({"errorKind": "k" * 300}).encode()))
        message = cli.http_error_message(exc)
        self.assertEqual({"errorKind": "k" * 128}, json.loads(message[message.index("{"):]))

    def test_status_failure_after_timeout_preserves_batch(self):
        client = cli.Client()
        client.post = Mock(side_effect=[cli.UncertainSubmit("timeout"), cli.HandoffError("offline")])
        with self.assertRaisesRegex(cli.HandoffError, "fixture-batch"): client.submit(submission())
        self.assertEqual(2, client.post.call_count)


class PayloadTests(unittest.TestCase):
    def test_valid_payload_not_mutated(self):
        value = submission()
        before = copy.deepcopy(value)
        cli.validate_submission(value)
        self.assertEqual(before, value)

    def test_revision_must_be_canonical_sha256_string(self):
        for revision in (0, None, [], {}, "abc", "A" * 64, "g" * 64, "a" * 63):
            value = submission()
            value["items"][0]["analysisRevision"] = revision
            with self.subTest(revision=revision), self.assertRaisesRegex(cli.HandoffError, "SHA256"):
                cli.validate_submission(value)

    def test_absolute_count_rejected(self):
        value = submission()
        value["items"][0]["semanticAnalysisCount"] = 10
        with self.assertRaises(cli.HandoffError): cli.validate_submission(value)

    def test_duplicate_cross_note_and_large_batches_rejected(self):
        for mode in ("duplicate", "cross-note", "oversize"):
            value = submission()
            value["items"].append(copy.deepcopy(value["items"][0]))
            if mode == "cross-note": value["items"][1].update(targetId="other", noteId="other-note")
            elif mode == "oversize": value["items"] *= 13
            with self.subTest(mode=mode), self.assertRaises(cli.HandoffError): cli.validate_submission(value)

    def test_classification_constraints(self):
        for changes in ({"analysisIsNegative": ""}, {"evidence": []}, {"negativeType": ""},
                        {"analysisIsNegative": "待复核", "negativeSubtype": " "}, {"reason": "  "}):
            value = submission()
            value["items"][0].update(changes)
            with self.subTest(changes=changes), self.assertRaises(cli.HandoffError): cli.validate_submission(value)
        value = submission()
        value["items"][0].update(analysisIsNegative="待复核", evidence=[])
        cli.validate_submission(value)
        value["items"][0].update(analysisIsNegative="是", negativeType="服务体验", negativeSubtype="服务态度", evidence=["态度差"])
        cli.validate_submission(value)

    def test_all_three_conclusions_require_both_nonblank_categories(self):
        for conclusion in ("是", "否", "待复核"):
            for field in ("negativeType", "negativeSubtype"):
                for invalid in ("", " \t\n", None, 1, [], {}):
                    value = submission()
                    value["items"][0].update(analysisIsNegative=conclusion)
                    value["items"][0][field] = invalid
                    with self.subTest(conclusion=conclusion, field=field, invalid=invalid), self.assertRaises(cli.HandoffError):
                        cli.validate_submission(value)
        value = submission()
        value["items"][0].update(analysisIsNegative="待复核", negativeType="待复核",
                                negativeSubtype="上下文缺失", reason="缺少所指对象的上下文", evidence=[])
        cli.validate_submission(value)

    def test_modes_are_optional_default_analyze_and_payload_is_unchanged(self):
        for mode in (None, "analyze", "fillMissingCategories"):
            value = submission()
            if mode is not None: value["mode"] = mode
            before = copy.deepcopy(value)
            cli.validate_submission(value)
            self.assertEqual(before, value)
        for invalid in ("", "repair", False, None, [], {}):
            value = {**submission(), "mode": invalid}
            with self.subTest(mode=invalid), self.assertRaises(cli.HandoffError): cli.validate_submission(value)

    def test_current_analysis_is_read_only_and_never_accepted_in_submission(self):
        value = {**submission(), "mode": "fillMissingCategories"}
        value["items"][0]["currentAnalysis"] = {"analysisIsNegative": "否", "negativeType": "", "negativeSubtype": ""}
        with self.assertRaises(cli.HandoffError): cli.validate_submission(value)

    def test_legacy_category_vocabulary_is_not_normalized(self):
        for category in ("Neutral", "Positive", "seeding", " Neutral "):
            value = {**submission(), "mode": "fillMissingCategories"}
            value["items"][0].update(negativeType=category, negativeSubtype="seeding")
            before = copy.deepcopy(value)
            cli.validate_submission(value)
            self.assertEqual(before, value)

    def test_pending_backfill_requires_matching_mode_and_current_analysis(self):
        current = {"analysisIsNegative": "否", "negativeType": "历史非空类型", "negativeSubtype": ""}
        result = {**exported(), "mode": "fillMissingCategories", "pendingCount": 1,
                  "items": [{"currentAnalysis": current}]}
        client = Mock(); client.post.return_value = result
        before = copy.deepcopy(result)
        self.assertEqual(result, cli.pending(client, 25, "fillMissingCategories"))
        self.assertEqual(before, result)
        client.post.assert_called_once_with("pending", {"limit": 25, "mode": "fillMissingCategories"})
        for invalid in (None, {}, {**current, "analysisIsNegative": ""},
                        {**current, "negativeSubtype": "已有子类型"}, {**current, "negativeType": None}):
            client.post.return_value = {**result, "items": [{"currentAnalysis": invalid}]}
            with self.subTest(current=invalid), self.assertRaises(cli.HandoffError): cli.pending(client, 25, "fillMissingCategories")
        client.post.return_value = exported()
        with self.assertRaises(cli.HandoffError): cli.pending(client, 25, "fillMissingCategories")
        client.post.return_value = result
        with self.assertRaises(cli.HandoffError): cli.pending(client, 25)

    def test_policy_version_gate_rejects_legacy_and_malformed_values(self):
        for policy in (None, 0, 1, True, "2", 2.0):
            client = Mock(); client.post.return_value = {**exported(), "classificationPolicyVersion": policy}
            with self.subTest(policy=policy), self.assertRaisesRegex(cli.HandoffError, "classificationPolicyVersion"):
                cli.pending(client, 1)
        client.post.return_value = {**exported(), "classificationPolicyVersion": 3}
        self.assertEqual(3, cli.pending(client, 1)["classificationPolicyVersion"])

    def test_pending_protocol_and_counts_required(self):
        for changes in ({"protocolVersion": 2}, {"pendingCount": None}, {"pendingCount": False}, {"items": [None]}):
            client = Mock()
            client.post.return_value = {**exported(), **changes}
            with self.subTest(changes=changes), self.assertRaises(cli.HandoffError): cli.pending(client, 25)


class CommandTests(unittest.TestCase):
    def invoke(self, args, client):
        out, err = io.StringIO(), io.StringIO()
        with patch.object(cli, "Client", return_value=client), redirect_stdout(out), redirect_stderr(err):
            code = cli.main(args)
        return code, out.getvalue(), err.getvalue()

    def test_doctor_limit_one(self):
        client = Mock(base_url=cli.DEFAULT_BASE_URL)
        client.post.return_value = exported()
        code, output, _ = self.invoke(["doctor"], client)
        self.assertEqual(0, code)
        self.assertEqual(0, json.loads(output)["pendingCount"])
        self.assertEqual(2, json.loads(output)["classificationPolicyVersion"])
        client.post.assert_called_once_with("pending", {"limit": 1})

    def test_export_new_absolute_file_only(self):
        client = Mock()
        client.post.return_value = exported()
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder).resolve() / "export.json"
            self.assertEqual(0, self.invoke(["export", "--out", str(target)], client)[0])
            self.assertEqual(exported(), json.loads(target.read_text(encoding="utf-8")))
            self.assertEqual(2, self.invoke(["export", "--out", str(target)], client)[0])
            self.assertEqual(1, client.post.call_count)
        self.assertEqual(2, self.invoke(["export", "--out", "relative.json"], client)[0])

    def test_explicit_backfill_export_keeps_read_only_context_and_mode(self):
        client = Mock()
        result = {**exported(), "mode": "fillMissingCategories", "pendingCount": 1,
                  "items": [{"currentAnalysis": {"analysisIsNegative": "否", "negativeType": "信息咨询", "negativeSubtype": ""}}]}
        client.post.return_value = result
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder).resolve() / "fill.json"
            code, output, _ = self.invoke(["export", "--fill-missing-categories", "--out", str(target)], client)
            self.assertEqual(0, code)
            self.assertEqual(result, json.loads(target.read_text(encoding="utf-8")))
            self.assertEqual("fillMissingCategories", json.loads(output)["mode"])
            client.post.assert_called_once_with("pending", {"limit": 25, "mode": "fillMissingCategories"})

    def test_doctor_stops_on_old_policy(self):
        client = Mock(); client.post.return_value = {**exported(), "classificationPolicyVersion": 1}
        code, output, error = self.invoke(["doctor"], client)
        self.assertEqual(2, code); self.assertEqual("", output)
        self.assertIn("classificationPolicyVersion", error)

    def test_doctor_accepts_explicit_analyze_policy_two_protocol_one(self):
        client = Mock(base_url=cli.DEFAULT_BASE_URL)
        client.post.return_value = {**exported(), "mode": "analyze", "classificationPolicyVersion": 2}
        code, output, error = self.invoke(["doctor"], client)
        self.assertEqual(0, code)
        self.assertEqual("", error)
        self.assertEqual(1, json.loads(output)["protocolVersion"])
        self.assertEqual(2, json.loads(output)["classificationPolicyVersion"])
        client.post.assert_called_once_with("pending", {"limit": 1})

    def test_submit_reads_independent_json(self):
        client = Mock()
        client.submit.return_value = receipt()
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder).resolve() / "result.json"
            path.write_text(json.dumps(submission()), encoding="utf-8")
            self.assertEqual(0, self.invoke(["submit", "--input", str(path)], client)[0])
            client.submit.assert_called_once_with(submission())

    def test_verify_requires_current_server_verification(self):
        client = Mock()
        client.post.return_value = {"ok": True, "verified": True}
        self.assertEqual(0, self.invoke(["verify", "--batch-id", "fixture-batch"], client)[0])
        client.post.assert_called_with("verify", {"batchId": "fixture-batch"})
        client.post.return_value = {"ok": True, "verified": False}
        self.assertEqual(2, self.invoke(["verify", "--batch-id", "fixture-batch"], client)[0])

    def test_status_is_not_current_verification(self):
        client = Mock()
        client.post.return_value = {"status": "not_found"}
        code, output, _ = self.invoke(["status", "--batch-id", "fixture-batch"], client)
        self.assertEqual(0, code)
        self.assertEqual({"status": "not_found"}, json.loads(output))
        client.post.assert_called_once_with("status", {"batchId": "fixture-batch"})


if __name__ == "__main__": unittest.main()
