"""Validate browser snapshot ownership before normalization can erase evidence.

This module performs no I/O and never edits caller-owned payloads. Missing
comment ownership remains compatible with legacy snapshots; explicit conflicting
ownership is rejected instead of making every derived store agree on bad data.
"""
from __future__ import annotations

import re
from typing import Any
from urllib.parse import unquote, urlsplit

_NOTE_ID = re.compile(r"^[A-Za-z0-9_-]{6,128}$")
_RESERVED = {"undefined", "null", "none", "unknown", "nan"}
_NOTE_ROUTE = re.compile(r"^/(?:explore|search_result|discovery/item|item|note)/([^/]+)(?:/|$)")


def _checked_id(value: Any, field: str) -> str:
    if not isinstance(value, str):
        raise ValueError(f"{field}: noteId 必须为有效字符串")
    value = value.strip()
    if not _NOTE_ID.fullmatch(value) or value.casefold() in _RESERVED:
        raise ValueError(f"{field}: noteId 格式无效")
    return value


def _url_note_id(value: Any) -> str:
    if not isinstance(value, str) or not value.strip():
        return ""
    try:
        url = urlsplit(value.strip())
        host = (url.hostname or "").lower()
        if url.scheme not in {"https", "http"} or not (host == "xiaohongshu.com" or host.endswith(".xiaohongshu.com")):
            return ""
        match = _NOTE_ROUTE.match(url.path)
        if match:
            return _checked_id(unquote(match[1]), "url")
    except (ValueError, UnicodeError):
        # Unknown/legacy share links carry no independently recognized note ID.
        return ""
    return ""


def validate_snapshot_identity(payload: dict[str, Any], note_id: str = "") -> str:
    """Return the single agreed note ID or raise before any business write.

    Camel/snake ownership aliases are both checked if provided. Only native note
    routes identify a note; author profile IDs, search text, tokens and short-link
    IDs are not treated as post identity.
    """
    if not isinstance(payload, dict):
        raise ValueError("snapshot 必须为对象")
    nested = payload.get("note")
    if "note" in payload and not isinstance(nested, dict):
        raise ValueError("note 必须为对象")
    identities: list[tuple[str, str]] = []
    if note_id:
        identities.append(("target", _checked_id(note_id, "target")))
    note_objects = [("snapshot", payload)]
    if isinstance(nested, dict):
        note_objects.append(("note", nested))
    for label, item in note_objects:
        for key in ("noteId", "note_id"):
            if key in item:
                identities.append((f"{label}.{key}", _checked_id(item[key], f"{label}.{key}")))
    if not identities:
        raise ValueError("noteId is required")
    canonical = identities[0][1]
    comments = payload.get("comments")
    if comments is None:
        comments = []
    if not isinstance(comments, list):
        raise ValueError("comments must be an array")
    for index, comment in enumerate(comments):
        if not isinstance(comment, dict):
            continue  # Collection normalization handles malformed non-records.
        for key in ("noteId", "note_id"):
            if key in comment:
                field = f"comments[{index}].{key}"
                identities.append((field, _checked_id(comment[key], field)))
    for field, candidate in identities:
        if candidate != canonical:
            raise ValueError(f"{field}: 帖子 ID 冲突，已拒绝串帖写入")
    for label, item in note_objects:
        candidate = _url_note_id(item.get("url"))
        if candidate and candidate != canonical:
            raise ValueError(f"{label}.url: 链接指向其他帖子，已拒绝串帖写入")
    return canonical
