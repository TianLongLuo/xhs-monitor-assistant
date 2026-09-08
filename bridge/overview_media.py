"""Exact-record, read-only overview media and comment-location projections.

Callers hold MonitorStore.pull_lock then MonitorStore.lock for the entire read.
No network client, CSV repair, folder discovery/creation or business writes live
here. Public indices are zero-based; only an index (never a caller file path)
can request bytes. Comments use ONLY their own payload_json.imageUrls.
"""
from __future__ import annotations

import base64
import hashlib
from contextlib import contextmanager
from dataclasses import dataclass
import json
import os
from pathlib import Path, PureWindowsPath
import re
import sqlite3
import stat
from typing import Any
from urllib.parse import unquote, urlsplit, urlunsplit


MAX_IMAGE_BYTES = 8 * 1024 * 1024
MAX_METADATA_BYTES = 2 * 1024 * 1024
MAX_ENTRIES = 256
IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".avif"}
_NOTE_ROUTE = re.compile(r"^/(?:explore|search_result|discovery/item|item|note)/([^/]+)(?:/|$)")
_OTHER_MEDIA = re.compile(r"comment|repl(?:y|ies)|avatar|profile|emoji|评论|回复|头像|表情", re.I)
_PREFIXED_COMMENT_ID = re.compile(r"comment-[0-9a-fA-F]{24}")


def _identifier(value: Any, field: str) -> str:
    # Reject, rather than truncate/normalize, so another ID can never be selected.
    if (not isinstance(value, str) or not value or len(value) > 256
            or value != value.strip() or any(ord(c) < 32 or ord(c) == 127 for c in value)):
        raise ValueError(f"{field} must be a non-empty exact record ID")
    return value


def _json_object(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, (str, bytes)) or len(raw) > MAX_METADATA_BYTES:
        return {}
    try:
        loaded = json.loads(raw)
        return loaded if isinstance(loaded, dict) else {}
    except (ValueError, UnicodeError, RecursionError):
        return {}


def _strings(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return list(dict.fromkeys(item for item in value[:MAX_ENTRIES]
                             if isinstance(item, str) and item and len(item) <= 4096))


def _remote_url(value: str) -> str:
    if value != value.strip() or "\\" in value or any(ord(c) <= 32 or ord(c) == 127 for c in value):
        return ""
    try:
        parsed = urlsplit(value)
        host = (parsed.hostname or "").lower()
        allowed = any(host == domain or host.endswith("." + domain)
                      for domain in ("xhscdn.com", "xiaohongshu.com"))
        # Older native comment markup stores HTTP CDN URLs. Upgrade only this
        # exact allowlist for display, preserving path/query and stored data.
        if (parsed.scheme == "http" and allowed and parsed.username is None
                and parsed.password is None and parsed.port in (None, 80)):
            return urlunsplit(("https", host, parsed.path, parsed.query, parsed.fragment))
        if (parsed.scheme == "https" and allowed and parsed.username is None
                and parsed.password is None and parsed.port in (None, 443)):
            return value
    except (ValueError, UnicodeError):
        pass
    return ""


def _comment_identity(value: Any) -> Any:
    # This is the one documented DOM/legacy DB alias, not a general cleanup.
    return value[8:] if isinstance(value, str) and _PREFIXED_COMMENT_ID.fullmatch(value) else value


def _owns(payload: dict[str, Any], note_id: str, comment_id: str = "") -> bool:
    for key in ("noteId", "note_id"):
        if key in payload and payload[key] not in (None, "", note_id):
            return False
    if comment_id:
        for key in ("commentId", "comment_id"):
            if (key in payload and payload[key] not in (None, "")
                    and _comment_identity(payload[key]) != _comment_identity(comment_id)):
                return False
    nested = payload.get("note")
    if isinstance(nested, dict):
        # Only ownership is inspected here; nested images are never a fallback.
        for key in ("noteId", "note_id"):
            if key in nested and nested[key] not in (None, "", note_id):
                return False
    for key in ("url", "noteUrl", "pageUrl", "commentUrl"):
        value = payload.get(key)
        if not isinstance(value, str):
            continue
        try:
            parsed = urlsplit(value)
            host = (parsed.hostname or "").lower()
            if host == "xiaohongshu.com" or host.endswith(".xiaohongshu.com"):
                route = _NOTE_ROUTE.match(parsed.path)
                if route and unquote(route[1]) != note_id:
                    return False
        except (ValueError, UnicodeError):
            continue
    return True


@contextmanager
def _database(db_path: Path):
    # mode=ro avoids creating a missing DB, and forbids persistent DB mutations.
    db = sqlite3.connect(Path(db_path).resolve().as_uri() + "?mode=ro", uri=True, timeout=10)
    db.row_factory = sqlite3.Row
    try:
        db.execute("PRAGMA query_only=ON")
        db.execute("BEGIN")
        yield db
    finally:
        db.close()  # End the read transaction without a commit or checkpoint.


def _record(db: sqlite3.Connection, dataset: str, record_id: str) -> tuple[dict[str, Any] | None, str]:
    if dataset == "notes":
        row = db.execute(
            "SELECT note_id,url,title,media_dir,payload_json AS note_payload "
            "FROM notes WHERE note_id=? COLLATE BINARY", (record_id,),
        ).fetchone()
    else:
        row = db.execute(
            "SELECT n.note_id,n.url,n.title,n.media_dir,n.payload_json AS note_payload,"
            "c.comment_id,c.parent_comment_id,c.content,c.author,c.published_at,c.is_deleted,"
            "c.payload_json AS comment_payload FROM comments c "
            "JOIN notes n ON n.note_id=c.note_id COLLATE BINARY "
            "WHERE c.comment_id=? COLLATE BINARY", (record_id,),
        ).fetchone()
    if row is None:
        return None, "record_not_found"
    record = dict(row)
    note_id = record["note_id"]
    record["note_payload"] = _json_object(record["note_payload"])
    if not _owns(record["note_payload"], note_id):
        return None, "record_identity_mismatch"
    if dataset == "comments":
        record["comment_payload"] = _json_object(record["comment_payload"])
        if not _owns(record["comment_payload"], note_id, record_id):
            return None, "record_identity_mismatch"
        parent_id = record["parent_comment_id"]
        if parent_id:
            canonical_parent = _comment_identity(parent_id)
            alias = ("comment-" + canonical_parent if re.fullmatch(r"[0-9a-fA-F]{24}", canonical_parent)
                     else parent_id)
            parents = db.execute(
                "SELECT note_id FROM comments WHERE comment_id IN (?,?) COLLATE BINARY",
                (canonical_parent, alias),
            ).fetchall()
            # An uncollected/deleted root does not erase a reply's own images.
            if any(parent["note_id"] != note_id for parent in parents):
                return None, "comment_parent_mismatch"
    return record, ""


def read_comment_target(db_path: Path, comment_id: str) -> dict[str, Any]:
    comment_id = _identifier(comment_id, "commentId")
    with _database(db_path) as db:
        record, reason = _record(db, "comments", comment_id)
    if record is None:
        raise ValueError(reason)
    raw_id = next((record["comment_payload"].get(key) for key in ("commentId", "comment_id")
                   if isinstance(record["comment_payload"].get(key), str)
                   and re.fullmatch(r"[0-9a-fA-F]{24}", record["comment_payload"][key])
                   and record["comment_payload"][key] != record["comment_id"]), "")
    return {
        "ok": True,
        # Retain the stored detail link/token. The worker validates HTTPS/XHS/ID
        # and falls back to /explore; this backend never opens the link.
        "note": {"noteId": record["note_id"], "url": record["url"], "title": record["title"]},
        "comment": {
            "commentId": record["comment_id"], "noteId": record["note_id"],
            "parentCommentId": record["parent_comment_id"], "content": record["content"],
            "author": record["author"], "publishedAt": record["published_at"],
            **({"rawCommentId": raw_id} if raw_id else {}),
            "imageUrls": [url for raw in _strings(record["comment_payload"].get("imageUrls"))
                          if (url := _remote_url(raw))],
        },
        "isDeleted": bool(record["is_deleted"]),
    }


def _no_link(path: Path) -> os.stat_result:
    info = path.lstat()
    if (stat.S_ISLNK(info.st_mode)
            or getattr(info, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)):
        raise ValueError("linked media paths are not previewable")
    return info


def _relative_parts(value: str) -> tuple[str, ...]:
    if not value or len(value) > 4096 or any(ord(c) < 32 for c in value):
        raise ValueError("invalid relative media path")
    win = PureWindowsPath(value)
    parts = tuple(value.replace("\\", "/").split("/"))
    if win.drive or win.root or any(
        part in ("", ".", "..") or ":" in part or part.endswith((" ", "."))
        or PureWindowsPath(part).is_reserved() for part in parts
    ):
        raise ValueError("invalid relative media path")
    return parts


@dataclass(frozen=True)
class _Scope:
    root: Path
    folder: Path

    def checked(self, name: str) -> Path:
        parts = _relative_parts(name)
        _no_link(self.root)
        _no_link(self.folder)
        if self.folder.resolve(strict=True).parent != self.root:
            raise ValueError("media folder left its managed root")
        current = self.folder
        for part in parts:
            current /= part
            _no_link(current)
        resolved = current.resolve(strict=True)
        if not resolved.is_relative_to(self.folder):
            raise ValueError("media path left its note folder")
        return current


def _scope(root: Path, raw_folder: Any, note_id: str) -> _Scope | None:
    if not isinstance(raw_folder, str) or not raw_folder:
        return None
    try:
        # DB media_dir is the one trusted absolute anchor, not a request path.
        # Do not resolve stale paths by title, suffix, glob or CSV heuristics.
        folder = Path(raw_folder)
        if not folder.is_absolute() or ".." in raw_folder.replace("\\", "/").split("/"):
            return None
        if "__" in folder.name and not folder.name.endswith("__" + note_id):
            return None  # A different modern note-ID suffix contradicts the DB anchor.
        _no_link(root)
        root = root.resolve(strict=True)
        _no_link(folder)
        if folder.parent.resolve(strict=True) != root or not folder.is_dir():
            return None
        return _Scope(root, folder.resolve(strict=True))
    except (OSError, ValueError, RuntimeError):
        return None


def _handle_path(fd: int, expected: Path) -> None:
    """Check the opened Windows handle before reading, not just its path string."""
    if os.name != "nt":
        return
    import ctypes
    from ctypes import wintypes
    import msvcrt

    function = ctypes.WinDLL("kernel32", use_last_error=True).GetFinalPathNameByHandleW
    function.argtypes = [wintypes.HANDLE, wintypes.LPWSTR, wintypes.DWORD, wintypes.DWORD]
    function.restype = wintypes.DWORD
    buffer = ctypes.create_unicode_buffer(32768)
    size = function(msvcrt.get_osfhandle(fd), buffer, len(buffer), 0)
    if not size or size >= len(buffer):
        raise ValueError("media handle path verification failed")
    final = buffer.value
    if final.startswith("\\\\?\\UNC\\"):
        final = "\\\\" + final[8:]
    elif final.startswith("\\\\?\\"):
        final = final[4:]
    if os.path.normcase(final) != os.path.normcase(str(expected)):
        raise ValueError("media handle does not match the verified path")


def _stamp(info: os.stat_result) -> tuple[int, ...]:
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def _read_local(scope: _Scope, name: str, limit: int, *, header_only: bool = False,
                expected: tuple[int, ...] | None = None) -> bytes:
    candidate = scope.checked(name)
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    fd = os.open(candidate, flags)
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or not 0 < info.st_size <= limit:
            raise ValueError("media must be a bounded, unlinked regular file")
        if expected is not None and _stamp(info) != expected:
            raise ValueError("media revision changed during open")
        current = scope.checked(name).lstat()
        if not os.path.samestat(info, current):
            raise ValueError("media changed during open")
        _handle_path(stream.fileno(), candidate)
        data = stream.read(64 if header_only else limit + 1)
        after = os.fstat(stream.fileno())
        if (len(data) > limit or _stamp(info) != _stamp(after)
                or not os.path.samestat(after, scope.checked(name).lstat())):
            raise ValueError("media changed during read")
        return data


def _raster_mime(header: bytes) -> str:
    # Never trust an extension alone, and never return SVG/HTML as image data.
    if header.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if header.startswith(b"\x89PNG\r\n\x1a\n") and header[12:16] == b"IHDR":
        return "image/png"
    if header[:6] in (b"GIF87a", b"GIF89a") and len(header) >= 13:
        return "image/gif"
    if header[:4] == b"RIFF" and header[8:12] == b"WEBP" and header[12:16] in (b"VP8 ", b"VP8L", b"VP8X"):
        return "image/webp"
    if header[:2] == b"BM" and len(header) >= 26:
        return "image/bmp"
    if len(header) >= 24 and header[4:8] == b"ftyp":
        box_size = int.from_bytes(header[:4], "big")
        brands = [header[8:12], *[header[i:i + 4] for i in range(16, min(box_size, len(header)), 4)]]
        if 24 <= box_size and any(brand in (b"avif", b"avis") for brand in brands):
            return "image/avif"
    return ""


def _image(scope: _Scope | None, name: str, *, full: bool = False,
           expected: tuple[int, ...] | None = None) -> tuple[str, bytes]:
    if scope is None or Path(name).suffix.lower() not in IMAGE_SUFFIXES:
        return "", b""
    try:
        data = _read_local(scope, name, MAX_IMAGE_BYTES, header_only=not full, expected=expected)
        mime = _raster_mime(data[:64])
        return (mime, data) if mime else ("", b"")
    except (OSError, ValueError, RuntimeError):
        return "", b""


def _post_index(name: str) -> int:
    if _OTHER_MEDIA.search(name):
        return 0
    stem = Path(name.replace("\\", "/")).stem
    match = re.fullmatch(r"image[-_](\d+)", stem, re.I) or re.fullmatch(r".+[-_]图(\d+)", stem)
    return int(match[1]) if match and len(match[1]) <= 6 else 0


def _items(record: dict[str, Any], dataset: str, scope: _Scope | None) -> list[dict[str, Any]]:
    payload = record["comment_payload"] if dataset == "comments" else record["note_payload"]
    manifest: dict[str, Any] = {}
    if scope is not None:
        try:
            manifest = _json_object(_read_local(scope, "note.json", MAX_METADATA_BYTES))
        except (OSError, ValueError, RuntimeError):
            pass
        if not _owns(manifest, record["note_id"]):
            scope = None
            manifest = {}

    names: list[str] = []
    mapping: dict[str, list[str]] = {}
    urls = _strings(payload.get("imageUrls"))
    if dataset == "notes":
        urls = list(dict.fromkeys([*urls, *_strings(manifest.get("imageUrls"))]))
        names = [name for doc in (manifest, payload) for name in _strings(doc.get("mediaFiles"))
                 if not _OTHER_MEDIA.search(name)]
        if scope is not None:
            try:
                # Only known post-image naming conventions, never every raster
                # in a mixed note/comment directory. Old 标题-图1.jpg is supported.
                for index, child in enumerate(scope.folder.iterdir()):
                    if index >= MAX_ENTRIES:
                        break
                    if _post_index(child.name):
                        names.append(child.name)
            except OSError:
                pass
        names = sorted(set(names))
        # The stored manifest describes the ON-DISK image-N numbering. Never
        # pair a newly reordered payload's URLs to that numbering by position.
        numbered = manifest if "imageUrls" in manifest else payload
        for index, url in enumerate(_strings(numbered.get("imageUrls")), 1):
            if _remote_url(url):
                mapping[url] = [name for name in names if _post_index(name) == index]

    items: list[dict[str, Any]] = []
    seen_local: set[str] = set()

    def local(name: str) -> bool:
        key = name.replace("\\", "/").casefold() if os.name == "nt" else name.replace("\\", "/")
        if key in seen_local:
            return True
        if not _image(scope, name)[0]:
            return False
        try:
            fingerprint = _stamp(scope.checked(name).stat())
        except (OSError, ValueError, RuntimeError):
            return False
        seen_local.add(key)
        items.append({"source": "local", "name": name, "stat": fingerprint})
        return True

    for raw in urls:
        # Comments never get mapping, directory enumeration or manifest URLs.
        if any(local(name) for name in mapping.get(raw, [])):
            continue
        remote = _remote_url(raw)
        if remote:
            items.append({"source": "remote", "url": remote})
        else:
            local(raw)  # Explicit relative imageUrls reference only; no guessing.
    for name in names:
        local(name)
    # Keep the scope decision local to each candidate; a mismatched manifest
    # yields no local item, so read_overview_media cannot return its bytes.
    return items


def read_overview_media(db_path: Path, media_root: Path, dataset: str, record_id: str,
                        index: str | int | None = None, revision: str | None = None) -> dict[str, Any]:
    if dataset not in {"notes", "comments"}:
        raise ValueError("dataset must be notes or comments")
    record_id = _identifier(record_id, "recordId")
    if index is not None and (isinstance(index, bool) or not isinstance(index, (str, int))
                              or not re.fullmatch(r"[0-9]{1,6}", str(index))):
        raise ValueError("index must be a zero-based non-negative integer")
    if index is not None and (not isinstance(revision, str) or not re.fullmatch(r"[0-9a-f]{64}", revision)):
        raise ValueError("index requires the current media revision; reload previews")
    response: dict[str, Any] = {"ok": True, "dataset": dataset, "recordId": record_id, "items": []}
    with _database(db_path) as db:
        record, reason = _record(db, dataset, record_id)
        if record is None:
            if index is not None:
                raise ValueError(reason)
            return {**response, "revision": "", "missingReason": reason}
        scope = _scope(media_root, record["media_dir"], record["note_id"])
        if scope is not None:
            # A legacy shared folder is not proof of either post's ownership.
            shared = db.execute(
                "SELECT 1 FROM notes WHERE media_dir=? COLLATE NOCASE AND note_id<>? COLLATE BINARY LIMIT 1",
                (record["media_dir"], record["note_id"]),
            ).fetchone()
            if shared:
                scope = None
        items = _items(record, dataset, scope)
        current_revision = hashlib.sha256(json.dumps({
            "dataset": dataset, "recordId": record_id, "noteId": record["note_id"],
            "folder": str(scope.folder) if scope else "", "items": items,
        }, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()
        response["revision"] = current_revision
        if index is not None:
            if revision != current_revision:
                raise ValueError("media revision changed; reload previews")
            number = int(index)
            if number >= len(items):
                raise ValueError("media index is not available")
            item = items[number]
            if item["source"] != "local":
                raise ValueError("remote images have no local dataUrl")
            mime, data = _image(scope, item["name"], full=True, expected=item["stat"])
            if not mime:
                raise ValueError("local image changed or unavailable; reload previews")
            return {"ok": True, "revision": current_revision,
                    "dataUrl": f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}"}
        if not items:
            return {**response, "missingReason": "no_previewable_images"}
        response["items"] = [
            {"index": i, "source": item["source"], "label": f"图片 {i + 1}",
             **({"url": item["url"]} if item["source"] == "remote" else {})}
            for i, item in enumerate(items)
        ]
        return response
