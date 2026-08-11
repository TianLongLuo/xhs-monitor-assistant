"""DeepSeek configuration, secure local secret storage, and JSON client."""

from __future__ import annotations

import base64
import ctypes
import json
import os
import socket
import urllib.error
import urllib.request
from ctypes import wintypes
from pathlib import Path
from typing import Any


DEFAULT_AI_SETTINGS: dict[str, Any] = {
    "base_url": "https://api.deepseek.com",
    "model": "deepseek-v4-flash",
    "thinking_mode": "disabled",
    "temperature": 0.1,
    "timeout_seconds": 45,
    "max_tokens": 1800,
    "auto_analyze_posts": False,
    "auto_analyze_comments": False,
    "comment_batch_size": 15,
    "max_concurrency": 1,
    "daily_call_limit": 300,
}

MODEL_ALIASES = {
    "deepseek-chat": "deepseek-v4-flash",
    "deepseek-reasoner": "deepseek-v4-pro",
}


def canonical_model(value: Any) -> str:
    model = str(value or "").strip()[:120]
    return MODEL_ALIASES.get(model, model or "deepseek-v4-flash")


class AIServiceError(RuntimeError):
    def __init__(self, message: str, kind: str = "unknown", retryable: bool = False):
        super().__init__(message)
        self.kind = kind
        self.retryable = retryable


class _DataBlob(ctypes.Structure):
    _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_byte))]


def _blob(data: bytes) -> tuple[_DataBlob, Any]:
    buffer = ctypes.create_string_buffer(data)
    return _DataBlob(len(data), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_byte))), buffer


def protect_secret(secret: str) -> str:
    """Encrypt a secret with Windows DPAPI for the current user."""
    if not secret:
        return ""
    if os.name != "nt":
        raise RuntimeError("API Key 仅支持在 Windows 上使用 DPAPI 安全保存")
    source, source_buffer = _blob(secret.encode("utf-8"))
    output = _DataBlob()
    if not ctypes.windll.crypt32.CryptProtectData(
        ctypes.byref(source), "XHS-Monitor DeepSeek API Key", None, None, None, 0,
        ctypes.byref(output),
    ):
        raise ctypes.WinError()
    try:
        encrypted = ctypes.string_at(output.pbData, output.cbData)
        return base64.b64encode(encrypted).decode("ascii")
    finally:
        ctypes.windll.kernel32.LocalFree(output.pbData)
        del source_buffer


def unprotect_secret(ciphertext: str) -> str:
    if not ciphertext:
        return ""
    if os.name != "nt":
        raise RuntimeError("无法在非 Windows 环境解密 API Key")
    source, source_buffer = _blob(base64.b64decode(ciphertext))
    output = _DataBlob()
    if not ctypes.windll.crypt32.CryptUnprotectData(
        ctypes.byref(source), None, None, None, None, 0, ctypes.byref(output)
    ):
        raise ctypes.WinError()
    try:
        return ctypes.string_at(output.pbData, output.cbData).decode("utf-8")
    finally:
        ctypes.windll.kernel32.LocalFree(output.pbData)
        del source_buffer


class AISettingsStore:
    def __init__(self, path: Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def _raw(self) -> dict[str, Any]:
        if not self.path.exists():
            return {}
        try:
            value = json.loads(self.path.read_text(encoding="utf-8"))
            return value if isinstance(value, dict) else {}
        except (OSError, ValueError):
            return {}

    def get(self, include_secret: bool = False) -> dict[str, Any]:
        raw = self._raw()
        settings = {**DEFAULT_AI_SETTINGS}
        settings.update({key: raw[key] for key in DEFAULT_AI_SETTINGS if key in raw})
        settings["model"] = canonical_model(settings["model"])
        settings["configured"] = bool(raw.get("api_key_dpapi"))
        if include_secret and settings["configured"]:
            settings["api_key"] = unprotect_secret(str(raw["api_key_dpapi"]))
        return settings

    def save(self, values: dict[str, Any]) -> dict[str, Any]:
        current = self._raw()
        next_values = {**DEFAULT_AI_SETTINGS}
        for key in DEFAULT_AI_SETTINGS:
            if key in values:
                next_values[key] = values[key]
            elif key in current:
                next_values[key] = current[key]
        base_url = str(next_values["base_url"]).strip().rstrip("/")
        if not base_url.startswith("https://"):
            raise ValueError("DeepSeek API Base URL 必须使用 https://")
        next_values["base_url"] = base_url
        next_values["model"] = canonical_model(next_values["model"])
        next_values["thinking_mode"] = (
            "enabled" if str(next_values.get("thinking_mode") or "").strip().lower() == "enabled" else "disabled"
        )
        next_values["temperature"] = max(0.0, min(float(next_values["temperature"]), 2.0))
        next_values["timeout_seconds"] = max(5, min(int(next_values["timeout_seconds"]), 180))
        next_values["max_tokens"] = max(256, min(int(next_values["max_tokens"]), 8192))
        next_values["comment_batch_size"] = max(10, min(int(next_values["comment_batch_size"]), 20))
        next_values["max_concurrency"] = max(1, min(int(next_values["max_concurrency"]), 3))
        next_values["daily_call_limit"] = max(1, min(int(next_values["daily_call_limit"]), 10000))
        for key in ("auto_analyze_posts", "auto_analyze_comments"):
            next_values[key] = bool(next_values[key])
        if "api_key" in values:
            secret = str(values.get("api_key") or "").strip()
            if secret:
                current["api_key_dpapi"] = protect_secret(secret)
            elif values.get("clear_api_key"):
                current.pop("api_key_dpapi", None)
        payload = {**next_values}
        if current.get("api_key_dpapi"):
            payload["api_key_dpapi"] = current["api_key_dpapi"]
        self.path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        return self.get(False)


class DeepSeekClient:
    def complete_json(self, settings: dict[str, Any], messages: list[dict[str, str]]) -> dict[str, Any]:
        api_key = str(settings.get("api_key") or "")
        if not api_key:
            raise AIServiceError("DeepSeek API Key 未配置", "not_configured", False)
        request_messages = [dict(item) for item in messages]
        prompt_text = " ".join(str(item.get("content") or "") for item in request_messages).lower()
        if "json" not in prompt_text:
            request_messages.insert(0, {"role": "system", "content": "Return one valid JSON object only."})
        thinking_mode = "enabled" if str(settings.get("thinking_mode") or "").lower() == "enabled" else "disabled"

        for attempt in range(2):
            body_data: dict[str, Any] = {
                "model": canonical_model(settings.get("model")),
                "messages": request_messages,
                "max_tokens": int(settings["max_tokens"]),
                "response_format": {"type": "json_object"},
                "thinking": {"type": thinking_mode},
                "stream": False,
                "user_id": "xhs-monitor",
            }
            if thinking_mode == "disabled":
                body_data["temperature"] = float(settings["temperature"])
            request = urllib.request.Request(
                f"{settings['base_url'].rstrip('/')}/chat/completions",
                data=json.dumps(body_data, ensure_ascii=False).encode("utf-8"),
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                    "User-Agent": "xhs-monitor/0.14",
                },
                method="POST",
            )
            try:
                with urllib.request.urlopen(request, timeout=settings["timeout_seconds"]) as response:
                    payload = json.loads(response.read().decode("utf-8"))
            except urllib.error.HTTPError as exc:
                detail = exc.read().decode("utf-8", errors="replace")[:1000]
                kinds = {401: "authentication", 402: "insufficient_balance", 422: "invalid_parameters", 429: "rate_limit"}
                kind = kinds.get(exc.code, "http")
                retryable = exc.code in (408, 429) or exc.code >= 500
                raise AIServiceError(f"DeepSeek HTTP {exc.code}：{detail}", kind, retryable) from exc
            except (urllib.error.URLError, ConnectionError) as exc:
                reason = getattr(exc, "reason", exc)
                raise AIServiceError(f"无法连接 DeepSeek：{reason}", "network", True) from exc
            except (TimeoutError, socket.timeout) as exc:
                raise AIServiceError("DeepSeek 请求超时", "timeout", True) from exc

            try:
                choice = payload["choices"][0]
                finish_reason = str(choice.get("finish_reason") or "")
                if finish_reason == "length":
                    raise AIServiceError("DeepSeek JSON 输出被 max_tokens 截断，请提高 Max Tokens", "truncated_response", False)
                if finish_reason in {"content_filter", "insufficient_system_resource"}:
                    raise AIServiceError(f"DeepSeek 未完成输出：{finish_reason}", finish_reason, finish_reason == "insufficient_system_resource")
                content = choice["message"]["content"]
                if not str(content or "").strip():
                    raise ValueError("模型返回空内容")
                result = json.loads(content)
                if not isinstance(result, dict):
                    raise ValueError("模型 JSON 不是对象")
                return result
            except AIServiceError:
                raise
            except (KeyError, IndexError, TypeError, ValueError, json.JSONDecodeError) as exc:
                if attempt == 0:
                    request_messages.append({
                        "role": "user",
                        "content": "The previous response was empty or invalid. Return exactly one complete valid JSON object now.",
                    })
                    continue
                raise AIServiceError(f"DeepSeek 返回格式无效：{exc}", "invalid_response", True) from exc

        raise AIServiceError("DeepSeek 未返回有效 JSON", "invalid_response", True)
