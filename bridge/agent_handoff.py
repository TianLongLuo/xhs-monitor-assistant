"""Standard-library, loopback-only client for the agent-analysis protocol.

This module never imports the server or opens business SQLite/CSV/material files.
"""
from __future__ import annotations

import argparse
from http.client import HTTPException
import ipaddress
import json
import re
import socket
import sys
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener


DEFAULT_BASE_URL = "http://127.0.0.1:17881"
MAX_BYTES = 32 * 1024 * 1024
MAX_ERROR_BYTES = 8192


class HandoffError(Exception):
    pass


class UncertainSubmit(HandoffError):
    """Transport failed; the server may already have committed."""


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise HandoffError("拒绝 HTTP 重定向；请检查本机 Bridge 地址。")


def http_error_message(exc: HTTPError) -> str:
    message = f"API 返回 HTTP {exc.code}；未重试或绕过服务端门禁。"
    try:
        raw = exc.read(MAX_ERROR_BYTES + 1)
        if len(raw) > MAX_ERROR_BYTES:
            return message
        body = json.loads(raw)
        if not isinstance(body, dict):
            return message
        # Never serialize the response wholesale (it may contain config/secrets).
        details = {key: body[key][:limit] for key, limit in (("errorKind", 128), ("error", 1000))
                   if isinstance(body.get(key), str) and body[key]}
        if details:
            return message + " " + json.dumps(details, ensure_ascii=False)
    except (ValueError, UnicodeError, OSError, HTTPException, RecursionError):
        pass
    return message


def loopback_url(value: str) -> str:
    try:
        parsed = urlsplit(value)
        host, port = parsed.hostname, parsed.port
        if (parsed.scheme != "http" or not host or parsed.username is not None
                or parsed.password is not None or parsed.query or parsed.fragment
                or parsed.path not in ("", "/")):
            raise ValueError()
        if host.lower() == "localhost":
            host = "127.0.0.1"  # No DNS resolution or proxy routing.
        address = ipaddress.ip_address(host)
        if not address.is_loopback or (port is not None and not 1 <= port <= 65535):
            raise ValueError()
        rendered = f"[{host}]" if address.version == 6 else host
        return f"http://{rendered}:{port or 80}"
    except ValueError as exc:
        raise HandoffError("--base-url 必须是无凭据、无路径的本机 loopback HTTP 地址。") from exc


class Client:
    def __init__(self, base_url=DEFAULT_BASE_URL, timeout=60):
        self.base_url = loopback_url(base_url)
        self.timeout = timeout
        self.opener = build_opener(ProxyHandler({}), NoRedirect())

    def post(self, action: str, payload: dict) -> dict:
        if action not in {"pending", "submit", "status", "verify"}:
            raise HandoffError("未知 API 操作。")
        request = Request(self.base_url + "/api/agent-analysis/" + action,
                          data=json.dumps(payload, ensure_ascii=False, allow_nan=False).encode("utf-8"),
                          headers={"Content-Type": "application/json", "Accept": "application/json"},
                          method="POST")
        try:
            with self.opener.open(request, timeout=self.timeout) as response:
                raw = response.read(MAX_BYTES + 1)
                if len(raw) > MAX_BYTES:
                    raise HandoffError("API 响应过大。")
        except HTTPError as exc:
            if exc.code == 404:
                raise HandoffError("运行中的 Bridge 尚无 agent-analysis API；待主 agent 升级并重启。禁止退回直接写库。") from exc
            if action == "submit" and exc.code >= 500:
                raise UncertainSubmit(f"提交收到 HTTP {exc.code}，提交结果待查询。") from exc
            raise HandoffError(http_error_message(exc)) from exc
        except (URLError, TimeoutError, socket.timeout, OSError, HTTPException) as exc:
            if action == "submit":
                raise UncertainSubmit("提交连接中断或超时，提交结果待查询。") from exc
            raise HandoffError("本机 Bridge 请求失败；请检查服务及端口。") from exc
        try:
            result = json.loads(raw)
            if not isinstance(result, dict):
                raise ValueError()
        except (ValueError, UnicodeError) as exc:
            if action == "submit":
                raise UncertainSubmit("提交响应格式异常，提交结果待查询。") from exc
            raise HandoffError("API 未返回 JSON 对象。") from exc
        if result.get("ok") is False:
            raise HandoffError("服务端拒绝操作；请检查批次是否过期、输入版本或验证状态。")
        return result

    def submit(self, payload: dict) -> dict:
        validate_submission(payload)
        batch_id = payload["batchId"]
        try:
            receipt = self.post("submit", payload)
        except UncertainSubmit:
            try:
                receipt = self.post("status", {"batchId": batch_id})
            except HandoffError as exc:
                raise HandoffError(f"提交结果未知；保留原结果文件及 batchId={batch_id}，用 status 查询，勿生成新批次替代。") from exc
            if receipt.get("status") != "committed":
                raise HandoffError(f"提交结果未确认（status={receipt.get('status', 'unknown')}）；保留 batchId={batch_id}，稍后查询，勿自动重发。")
        if receipt.get("status") != "committed" or receipt.get("batchId") != batch_id or receipt.get("verified") is not True:
            raise HandoffError(f"未取得匹配的已验证提交回执；请查询原 batchId={batch_id}。")
        return receipt


def validate_submission(payload):
    if not isinstance(payload, dict) or set(payload) != {"batchId", "agent", "model", "items"}:
        raise HandoffError("结果 JSON 须且仅含 batchId、agent、model、items。")
    for key in ("batchId", "agent", "model"):
        if not isinstance(payload[key], str) or not payload[key].strip():
            raise HandoffError(f"{key} 须为非空字符串；未知身份填写 unknown。")
    items = payload["items"]
    if not isinstance(items, list) or not 1 <= len(items) <= 25:
        raise HandoffError("items 须含 1–25 项。")
    required = {"targetType", "targetId", "noteId", "sourceHash", "analysisRevision",
                "analysisIsNegative", "negativeType", "negativeSubtype", "reason", "evidence"}
    identities, notes = set(), set()
    for item in items:
        if not isinstance(item, dict) or set(item) != required:
            raise HandoffError("每项须含约定身份、版本和分析字段；不接受绝对 count 或其他额外字段。")
        for key in ("targetId", "noteId", "sourceHash", "reason"):
            if not isinstance(item[key], str) or not item[key].strip():
                raise HandoffError(f"{key} 须为非空字符串。")
        revision = item["analysisRevision"]
        if not isinstance(revision, str) or re.fullmatch(r"[0-9a-f]{64}", revision) is None:
            raise HandoffError("analysisRevision 须原样复制服务端的 SHA256 字符串。")
        if item["targetType"] not in ("note", "comment") or item["analysisIsNegative"] not in ("是", "否", "待复核"):
            raise HandoffError("目标类型或语义结论不合法。")
        for key in ("negativeType", "negativeSubtype"):
            if not isinstance(item[key], str):
                raise HandoffError(f"{key} 须为字符串。")
        if not isinstance(item["evidence"], list) or any(not isinstance(v, str) or not v for v in item["evidence"]):
            raise HandoffError("evidence 须为非空原文子串组成的数组；无证据时可为空数组并标待复核。")
        if item["analysisIsNegative"] == "是":
            if not item["negativeType"].strip():
                raise HandoffError("差评结论为是时 negativeType 必填。")
        elif item["negativeType"] != "" or item["negativeSubtype"] != "":
            raise HandoffError("否/待复核的 negativeType 和 negativeSubtype 必须为空字符串。")
        if item["analysisIsNegative"] != "待复核" and not item["evidence"]:
            raise HandoffError("是/否结论至少提供一条原文证据。")
        identity = (item["targetType"], item["targetId"])
        if identity in identities:
            raise HandoffError("批次包含重复目标。")
        identities.add(identity)
        notes.add(item["noteId"])
    if len(notes) != 1:
        raise HandoffError("一批仅允许同一帖子的目标。")


def absolute_path(value):
    path = Path(value).expanduser()
    if not path.is_absolute():
        raise HandoffError("输入/输出文件必须使用绝对路径。")
    return path


def pending(client, limit):
    result = client.post("pending", {"limit": limit})
    if result.get("protocolVersion") != 1 or not isinstance(result.get("items"), list):
        raise HandoffError("pending 协议版本不兼容；请升级配套 Bridge/CLI。")
    if result["items"] and not result.get("batchId"):
        raise HandoffError("pending 缺少 batchId。")
    for key in ("pendingCount", "excludedCount", "needsReviewCount"):
        if type(result.get(key)) is not int or result[key] < 0:
            raise HandoffError(f"pending 缺少有效 {key}；不据此宣告任务完成。")
    if len(result["items"]) > limit or any(not isinstance(item, dict) for item in result["items"]):
        raise HandoffError("pending 返回不合法批次。")
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL)
    parser.add_argument("--timeout", type=float, default=60)
    subs = parser.add_subparsers(dest="command", required=True)
    subs.add_parser("doctor")
    export = subs.add_parser("export")
    export.add_argument("--out", required=True)
    export.add_argument("--limit", type=int, default=25, choices=range(1, 26))
    submit = subs.add_parser("submit")
    submit.add_argument("--input", required=True)
    for name in ("status", "verify"):
        subs.add_parser(name).add_argument("--batch-id", required=True)
    args = parser.parse_args(argv)
    try:
        if not 0 < args.timeout <= 600:
            raise HandoffError("timeout 须在 0–600 秒范围内。")
        client = Client(args.base_url, args.timeout)
        if args.command == "doctor":
            result = pending(client, 1)
            result = {"ok": True, "protocolVersion": 1, "baseUrl": client.base_url,
                      "pendingCount": result.get("pendingCount"), "excludedCount": result.get("excludedCount"),
                      "needsReviewCount": result.get("needsReviewCount"), "probeBatchId": result.get("batchId")}
        elif args.command == "export":
            output = absolute_path(args.out)
            if output.exists():
                raise HandoffError("导出目标已存在；请使用独立新文件，禁止覆盖。")
            result = pending(client, args.limit)
            with output.open("x", encoding="utf-8") as stream:
                json.dump(result, stream, ensure_ascii=False, indent=2)
                stream.write("\n")
            result = {"ok": True, "out": str(output), "batchId": result.get("batchId"),
                      "itemCount": len(result["items"]), "pendingCount": result.get("pendingCount"),
                      "excludedCount": result.get("excludedCount"), "needsReviewCount": result.get("needsReviewCount")}
        elif args.command == "submit":
            path = absolute_path(args.input)
            if path.stat().st_size > MAX_BYTES:
                raise HandoffError("输入文件过大。")
            result = client.submit(json.loads(path.read_text(encoding="utf-8-sig")))
        else:
            result = client.post(args.command, {"batchId": args.batch_id})
            if args.command == "verify" and (result.get("ok") is not True or result.get("verified") is not True):
                raise HandoffError("服务端复核未通过。")
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except (HandoffError, OSError, ValueError) as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
