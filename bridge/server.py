#!/usr/bin/env python3
"""Local Bridge for the XHS-Monitor XHS DOM monitor.

The bridge intentionally exposes only a small localhost JSON API. It does not
read browser cookies and does not call Xiaohongshu endpoints.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import mimetypes
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import threading
import time
import unicodedata
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import contextmanager
from copy import copy
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, parse_qsl, urlencode, urlparse, urlunparse
from urllib.request import Request, urlopen

try:
    from .ai_support import AIServiceError, AISettingsStore, DeepSeekClient
except ImportError:  # Native Host runs this module as a top-level script.
    from ai_support import AIServiceError, AISettingsStore, DeepSeekClient


VERSION = "0.18.0"
NOTE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{6,128}$")
ZERO_WIDTH_RE = re.compile(r"[\u200b-\u200f\uFEFF]")
WHITESPACE_RE = re.compile(r"\s+")
RELEVANCE_GROUPS = {
    # 品牌词库：填写你要监控的品牌名/别名（用于标题、正文、话题匹配）
    "brand": (
        "品牌词",
    ),
    # 产品词库：填写品牌旗下产品名（可为空）
    "products": (),
    # 官方账号/博主词库：只匹配作者用户名（可为空）
    "accounts": (),
}

_RESOLVED_RELEVANCE_GROUPS: dict[str, tuple[str, ...]] | None = None


def _relevance_keywords_path() -> Path:
    candidates: list[Path] = []
    if getattr(sys, "frozen", False):
        exe_dir = Path(sys.executable).resolve().parent
        candidates.extend([exe_dir, exe_dir.parent])
    else:
        candidates.append(Path(__file__).resolve().parent)
    for base in candidates:
        if (base / "native_host_config.json").is_file():
            return base / "data" / "relevance_keywords.json"
    return candidates[0] / "data" / "relevance_keywords.json"


def resolved_relevance_groups() -> dict[str, tuple[str, ...]]:
    """合并 bridge/data/relevance_keywords.json 本地词库（私有配置，不入库）。

    新用户把自己的品牌词/产品词/账号词填进该文件即可，无需改代码。
    """
    global _RESOLVED_RELEVANCE_GROUPS
    if _RESOLVED_RELEVANCE_GROUPS is not None:
        return _RESOLVED_RELEVANCE_GROUPS
    merged = {key: tuple(terms) for key, terms in RELEVANCE_GROUPS.items()}
    try:
        payload = json.loads(_relevance_keywords_path().read_text(encoding="utf-8"))
        for key in ("brand", "products", "accounts"):
            values = payload.get(key)
            if isinstance(values, list):
                merged[key] = tuple(text(value, 200) for value in values if text(value, 200))
    except Exception:
        pass
    _RESOLVED_RELEVANCE_GROUPS = merged
    return merged
ISSUE_CATEGORIES = {
    "强行拉客", "过度推销", "购买压力", "服务态度", "未倾听客户需求", "产品知识不足", "产品效果不满意",
    "产品质量", "产品价格", "价格不透明", "退款问题", "售后问题", "门店体验", "护理体验", "预约问题",
    "误导宣传", "过敏或不适", "品牌质疑", "账号或销售人员争议", "其他",
}
SENTIMENTS = {"negative", "light_negative", "neutral", "positive", "irrelevant", "spam", "uncertain"}
SENTIMENT_LABELS = {
    "negative": "差评", "light_negative": "差评", "neutral": "中立", "positive": "好评",
    "irrelevant": "无关", "spam": "广告/垃圾信息", "uncertain": "待复核",
}
CHROME_EXTENSION_ORIGIN_RE = re.compile(r"^chrome-extension://[a-p]{32}$")


def allowed_extension_origins() -> set[str]:
    bases = [Path(__file__).resolve().parent]
    if getattr(sys, "frozen", False):
        exe_dir = Path(sys.executable).resolve().parent
        bases = [exe_dir, exe_dir.parent]
    for base in bases:
        manifest = base / "com.xhsmonitor.bridge.json"
        try:
            payload = json.loads(manifest.read_text(encoding="utf-8"))
            return {text(value, 200).rstrip("/") for value in payload.get("allowed_origins", []) if text(value, 200)}
        except Exception:
            continue
    return set()


def now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def text(value: Any, limit: int = 4000) -> str:
    if value is None:
        return ""
    return str(value).strip()[:limit]


def bool_value(value: Any) -> bool:
    """Coerce browser JSON booleans without treating the string 'false' as true."""
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    return text(value, 20).casefold() in {"1", "true", "yes", "y", "是"}


def sentiment_label(value: Any) -> str:
    return SENTIMENT_LABELS.get(text(value, 40).lower(), "待复核")


def url_score(value: Any) -> int:
    raw = text(value, 2000)
    if not raw:
        return 0
    try:
        parsed = urlparse(raw)
        query = parse_qs(parsed.query)
    except ValueError:
        return 0
    score = 1 if parsed.scheme in {"http", "https"} else 0
    hostname = (parsed.hostname or "").lower()
    if hostname == "xhslink.com" or hostname.endswith(".xhslink.com"):
        score += 100
    if any(query.get("xsec_token", [])):
        score += 60
    if any(query.get("xsec_source", [])):
        score += 4
    if any(query.get("xhsshare", [])):
        score += 10
    if "/search_result/" in parsed.path:
        score += 8
    elif "/discovery/item/" in parsed.path:
        score += 6
    elif "/explore/" in parsed.path:
        score += 4
    return score


def normalize_xhs_url(value: Any) -> str:
    raw = text(value, 2000)
    if not raw:
        return ""
    try:
        parsed = urlparse(raw)
        if (parsed.hostname or "").lower() != "www.xiaohongshu.com":
            return raw
        query = dict(parse_qsl(parsed.query, keep_blank_values=True))
        if query.get("xsec_token") and not query.get("xsec_source"):
            query["xsec_source"] = "pc_note" if "/user/profile/" in parsed.path else "pc_search"
        return urlunparse(parsed._replace(query=urlencode(query)))
    except ValueError:
        return raw


def preferred_url(current: Any, candidate: Any) -> str:
    current_value = normalize_xhs_url(current)
    candidate_value = normalize_xhs_url(candidate)
    if not candidate_value:
        return current_value
    return candidate_value if url_score(candidate_value) >= url_score(current_value) else current_value


def valid_note_id(value: Any) -> str:
    note_id = text(value, 128)
    if not NOTE_ID_RE.fullmatch(note_id):
        return ""
    return note_id


def note_url_identity(value: Any) -> str:
    """Return a token-insensitive note identity for Excel fallback matching."""
    raw = text(value, 2000)
    if not raw:
        return ""
    try:
        parsed = urlparse(raw)
        parts = [part for part in parsed.path.split("/") if part]
        for marker in ("search_result", "explore", "item"):
            if marker in parts:
                index = parts.index(marker) + 1
                if index < len(parts):
                    candidate = valid_note_id(parts[index])
                    if candidate:
                        return candidate
        return urlunparse(parsed._replace(query="", fragment="")).rstrip("/").casefold()
    except ValueError:
        return match_key(raw, 2000)


def match_key(value: Any, limit: int = 12000) -> str:
    """Normalize visible note text for title/caption comparison."""
    normalized = unicodedata.normalize("NFKC", text(value, limit)).casefold()
    normalized = ZERO_WIDTH_RE.sub("", normalized)
    normalized = WHITESPACE_RE.sub("", normalized)
    return normalized


def tag_text(value: Any) -> str:
    if isinstance(value, (list, tuple, set)):
        return " ".join(text(item, 300) for item in value if text(item, 300))
    return text(value, 6000)


def _contains_term(corpus: str, term: str) -> bool:
    normalized_term = match_key(term, 200)
    if not normalized_term:
        return False
    if re.fullmatch(r"[a-z0-9]+", normalized_term):
        # 纯英文/数字词按整词匹配，避免子串误命中（如 brand 误中 branding）
        return re.search(rf"(?<![a-z0-9]){normalized_term}(?![a-z0-9])", corpus) is not None
    return normalized_term in corpus


def relevance_match(
    title: Any,
    content: Any,
    tags: Any,
    media_text: Any = "",
    author: Any = "",
) -> tuple[bool, list[str]]:
    groups = resolved_relevance_groups()
    corpus = match_key(
        " ".join((text(title, 1000), text(content, 12000), tag_text(tags), text(media_text, 6000)))
    )
    author_corpus = match_key(author, 500)
    matched: list[str] = []
    for group, terms in groups.items():
        for term in terms:
            if _contains_term(corpus, term):
                matched.append(f"{group}:{term}")
    # The search result DOM frequently contains only title + author. Treat an
    # official brand/account name as relevant, but do not match generic
    # product-like usernames because those are too noisy.
    for group in ("brand", "accounts"):
        for term in groups.get(group, ()):
            if _contains_term(author_corpus, term):
                matched.append(f"author:{term}")
    return bool(matched), matched


def identity_keys(title: Any, content: Any) -> tuple[str, str, str]:
    title_text = text(title, 1000)
    if not title_text:
        content_text = text(content, 12000)
        title_text = next((line.strip()[:1000] for line in content_text.splitlines() if line.strip()), "")
    content_text = text(content, 12000)
    title_value = match_key(title_text, 1000)
    content_value = match_key(content_text, 12000)
    if not title_value or not content_value:
        return title_value, content_value, ""
    raw = f"{title_value}\x1f{content_value}".encode("utf-8")
    return title_value, content_value, hashlib.sha256(raw).hexdigest()


def canonical_note_title(title: Any, content: Any, limit: int = 80) -> str:
    """Return a real title, deriving one from the first body paragraphs when absent.

    Xiaohongshu's detail DOM may expose the search-suggestion label “猜你想搜”
    through a generic title class. That UI text is never a note title.
    """
    supplied = text(title, 1000).strip()
    normalized = match_key(supplied, 1000)
    invalid = (
        not normalized
        or normalized in {"未命名帖子", "当前打开帖子", "待读取", "无标题", "猜你想搜"}
        or normalized.startswith("猜你想搜")
    )
    if not invalid:
        return supplied[:limit].strip()

    paragraphs = [
        re.sub(r"\s+", " ", line).strip(" -—|｜")
        for line in text(content, 12000).splitlines()
        if re.sub(r"\s+", " ", line).strip(" -—|｜")
    ]
    derived_parts: list[str] = []
    for paragraph in paragraphs[:3]:
        if paragraph.startswith("#") and derived_parts:
            break
        derived_parts.append(paragraph)
        if len(" ".join(derived_parts)) >= limit:
            break
    derived = " ".join(derived_parts).strip()
    if len(derived) > limit:
        derived = derived[:limit].rstrip("，。！？；、,!?;:： ")
    return derived or "未命名帖子"


class MonitorStore:
    def __init__(self, db_path: Path, export_dir: Path, ai_client: Any | None = None):
        self.db_path = Path(db_path)
        self.export_dir = Path(export_dir)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.export_dir.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        # Serialize a complete pull transaction. Without this lock, two clicks
        # can both inspect the same workbook before either atomic replace and
        # append duplicate rows despite row-level dedupe.
        self.pull_lock = threading.Lock()
        self.seed_xlsx_path: Path | None = None
        self.ai_settings = AISettingsStore(self.db_path.parent / "ai_settings.json")
        self.ai_client = ai_client or DeepSeekClient()
        self.ai_wakeup = threading.Event()
        self.ai_stopping = threading.Event()
        self._init_db()
        self._recover_jobs()
        self.ai_workers: list[threading.Thread] = []

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.db_path, timeout=10)
        connection.row_factory = sqlite3.Row
        return connection

    @contextmanager
    def _session(self):
        connection = self._connect()
        try:
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def _init_db(self) -> None:
        with self._session() as db:
            db.execute(
                """
                CREATE TABLE IF NOT EXISTS notes (
                    note_id TEXT PRIMARY KEY,
                    url TEXT NOT NULL,
                    title TEXT NOT NULL DEFAULT '',
                    author TEXT NOT NULL DEFAULT '',
                    content TEXT NOT NULL DEFAULT '',
                    keyword TEXT NOT NULL DEFAULT '',
                    page_url TEXT NOT NULL DEFAULT '',
                    first_seen_at TEXT NOT NULL,
                    last_seen_at TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'new',
                    is_relevant INTEGER NOT NULL DEFAULT 0,
                    source TEXT NOT NULL DEFAULT 'dom',
                    post_sentiment TEXT NOT NULL DEFAULT '',
                    tags TEXT NOT NULL DEFAULT '',
                    title_key TEXT NOT NULL DEFAULT '',
                    content_key TEXT NOT NULL DEFAULT '',
                    title_content_key TEXT NOT NULL DEFAULT '',
                    payload_json TEXT NOT NULL DEFAULT '{}'
                )
                """
            )
            columns = {str(row[1]) for row in db.execute("PRAGMA table_info(notes)").fetchall()}
            for column in ("tags", "title_key", "content_key", "title_content_key"):
                if column not in columns:
                    db.execute(f"ALTER TABLE notes ADD COLUMN {column} TEXT NOT NULL DEFAULT ''")
            note_migrations = {
                "ai_analysis_status": "TEXT NOT NULL DEFAULT 'not_analyzed'",
                "is_negative": "INTEGER NOT NULL DEFAULT 0",
                "risk_level": "TEXT NOT NULL DEFAULT ''",
                "issue_categories": "TEXT NOT NULL DEFAULT '[]'",
                "ai_summary": "TEXT NOT NULL DEFAULT ''",
                "ai_reason": "TEXT NOT NULL DEFAULT ''",
                "ai_confidence": "REAL NOT NULL DEFAULT 0",
                "needs_attention": "INTEGER NOT NULL DEFAULT 0",
                "suggested_action": "TEXT NOT NULL DEFAULT ''",
                "review_status": "TEXT NOT NULL DEFAULT 'pending_review'",
                "review_note": "TEXT NOT NULL DEFAULT ''",
                "manual_negative": "INTEGER NOT NULL DEFAULT 0",
                "comment_collection_status": "TEXT NOT NULL DEFAULT 'not_started'",
                "comment_count_collected": "INTEGER NOT NULL DEFAULT 0",
                "negative_comment_count": "INTEGER NOT NULL DEFAULT 0",
                "last_comment_collected_at": "TEXT NOT NULL DEFAULT ''",
                "last_ai_analyzed_at": "TEXT NOT NULL DEFAULT ''",
                "content_hash": "TEXT NOT NULL DEFAULT ''",
                "pull_status": "TEXT NOT NULL DEFAULT 'not_started'",
                "pull_error": "TEXT NOT NULL DEFAULT ''",
                "last_pull_at": "TEXT NOT NULL DEFAULT ''",
                "excel_synced_at": "TEXT NOT NULL DEFAULT ''",
                "excel_sync_path": "TEXT NOT NULL DEFAULT ''",
                "media_status": "TEXT NOT NULL DEFAULT 'not_started'",
                "media_dir": "TEXT NOT NULL DEFAULT ''",
                "media_file_count": "INTEGER NOT NULL DEFAULT 0",
                "media_error": "TEXT NOT NULL DEFAULT ''",
                "relevance_status": "TEXT NOT NULL DEFAULT 'unknown'",
                "relevance_source": "TEXT NOT NULL DEFAULT ''",
                "relevance_reason": "TEXT NOT NULL DEFAULT ''",
                "relevance_confidence": "REAL NOT NULL DEFAULT 0",
                "relevance_analyzed_at": "TEXT NOT NULL DEFAULT ''",
            }
            columns = {str(row[1]) for row in db.execute("PRAGMA table_info(notes)").fetchall()}
            for column, definition in note_migrations.items():
                if column not in columns:
                    db.execute(f"ALTER TABLE notes ADD COLUMN {column} {definition}")
            db.execute("CREATE INDEX IF NOT EXISTS idx_notes_status ON notes(status)")
            db.execute("CREATE INDEX IF NOT EXISTS idx_notes_last_seen ON notes(last_seen_at)")
            db.execute("CREATE INDEX IF NOT EXISTS idx_notes_title_key ON notes(title_key)")
            db.execute("CREATE INDEX IF NOT EXISTS idx_notes_title_content_key ON notes(title_content_key)")
            db.execute("CREATE INDEX IF NOT EXISTS idx_notes_negative ON notes(is_negative, ai_confidence)")
            db.execute("CREATE INDEX IF NOT EXISTS idx_notes_review ON notes(review_status)")
            db.execute("CREATE INDEX IF NOT EXISTS idx_notes_relevance ON notes(relevance_status, source)")
            db.execute("""UPDATE notes SET relevance_status=CASE
                WHEN source='existing_xlsx' OR is_relevant=1 THEN 'relevant'
                ELSE 'unknown' END
                WHERE relevance_status='' OR relevance_status IS NULL OR (relevance_status='unknown' AND (source='existing_xlsx' OR is_relevant=1))""")

            db.executescript(
                """
                CREATE TABLE IF NOT EXISTS comments (
                    comment_id TEXT PRIMARY KEY,
                    note_id TEXT NOT NULL,
                    parent_comment_id TEXT NOT NULL DEFAULT '',
                    content TEXT NOT NULL DEFAULT '',
                    author TEXT NOT NULL DEFAULT '',
                    author_url TEXT NOT NULL DEFAULT '',
                    published_at TEXT NOT NULL DEFAULT '',
                    like_count INTEGER NOT NULL DEFAULT 0,
                    reply_count INTEGER NOT NULL DEFAULT 0,
                    comment_url TEXT NOT NULL DEFAULT '',
                    comment_level INTEGER NOT NULL DEFAULT 1,
                    first_seen_at TEXT NOT NULL,
                    last_seen_at TEXT NOT NULL,
                    payload_json TEXT NOT NULL DEFAULT '{}',
                    content_hash TEXT NOT NULL DEFAULT '',
                    ai_analysis_status TEXT NOT NULL DEFAULT 'not_analyzed',
                    sentiment TEXT NOT NULL DEFAULT '',
                    is_negative INTEGER NOT NULL DEFAULT 0,
                    risk_level TEXT NOT NULL DEFAULT '',
                    issue_categories TEXT NOT NULL DEFAULT '[]',
                    ai_summary TEXT NOT NULL DEFAULT '',
                    ai_reason TEXT NOT NULL DEFAULT '',
                    ai_confidence REAL NOT NULL DEFAULT 0,
                    needs_attention INTEGER NOT NULL DEFAULT 0,
                    suggested_action TEXT NOT NULL DEFAULT '',
                    review_status TEXT NOT NULL DEFAULT 'pending_review',
                    review_note TEXT NOT NULL DEFAULT '',
                    manual_negative INTEGER NOT NULL DEFAULT 0,
                    last_ai_analyzed_at TEXT NOT NULL DEFAULT '',
                    FOREIGN KEY(note_id) REFERENCES notes(note_id)
                );
                CREATE UNIQUE INDEX IF NOT EXISTS idx_comments_identity_full
                    ON comments(note_id, author, content, published_at);
                CREATE INDEX IF NOT EXISTS idx_comments_note ON comments(note_id, first_seen_at);
                CREATE INDEX IF NOT EXISTS idx_comments_negative ON comments(is_negative, ai_confidence);

                CREATE TABLE IF NOT EXISTS ai_analysis_records (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    target_type TEXT NOT NULL,
                    target_id TEXT NOT NULL,
                    model TEXT NOT NULL DEFAULT '',
                    request_json TEXT NOT NULL DEFAULT '{}',
                    response_json TEXT NOT NULL DEFAULT '{}',
                    status TEXT NOT NULL,
                    error_kind TEXT NOT NULL DEFAULT '',
                    error_message TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_ai_records_target
                    ON ai_analysis_records(target_type, target_id, created_at);

                CREATE TABLE IF NOT EXISTS ai_jobs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    target_type TEXT NOT NULL,
                    target_id TEXT NOT NULL,
                    priority INTEGER NOT NULL DEFAULT 50,
                    status TEXT NOT NULL DEFAULT 'queued',
                    attempts INTEGER NOT NULL DEFAULT 0,
                    available_at REAL NOT NULL DEFAULT 0,
                    last_error TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    UNIQUE(target_type, target_id)
                );
                CREATE INDEX IF NOT EXISTS idx_ai_jobs_queue
                    ON ai_jobs(status, available_at, priority, created_at);

                CREATE TABLE IF NOT EXISTS comment_collection_jobs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    note_id TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'collecting',
                    collected_count INTEGER NOT NULL DEFAULT 0,
                    new_count INTEGER NOT NULL DEFAULT 0,
                    expected_count INTEGER NOT NULL DEFAULT 0,
                    error_message TEXT NOT NULL DEFAULT '',
                    started_at TEXT NOT NULL,
                    finished_at TEXT NOT NULL DEFAULT ''
                );
                CREATE INDEX IF NOT EXISTS idx_comment_jobs_note
                    ON comment_collection_jobs(note_id, started_at);
                """
            )

            # Backfill identity keys for databases created before content-based
            # matching was introduced.
            rows = db.execute(
                """
                SELECT note_id, title, content, tags, title_key, content_key,
                       title_content_key, status, source, is_relevant, payload_json
                FROM notes
                """
            ).fetchall()
            for row in rows:
                title_value, content_value, combined_value = identity_keys(row["title"], row["content"])
                tags_value = text(row["tags"])
                seeded_payload: Any = {}
                if not tags_value and row["payload_json"]:
                    try:
                        seeded_payload = json.loads(row["payload_json"])
                    except (TypeError, ValueError):
                        seeded_payload = {}
                    tags_value = tag_text(seeded_payload.get("tags")) if isinstance(seeded_payload, dict) else ""
                media_value = ""
                if isinstance(seeded_payload, dict):
                    media_value = text(seeded_payload.get("mediaText"), 6000)
                # This startup pass repairs identity keys only. Reclassifying old
                # rows here is destructive when a user edits or temporarily omits
                # the private keyword file; fresh scans update relevance normally.
                next_relevant = int(row["is_relevant"])
                next_status = row["status"]
                if (
                    row["tags"] != tags_value
                    or row["title_key"] != title_value
                    or row["content_key"] != content_value
                    or row["title_content_key"] != combined_value
                    or int(row["is_relevant"]) != next_relevant
                    or row["status"] != next_status
                ):
                    db.execute(
                        """
                        UPDATE notes
                        SET tags = ?, title_key = ?, content_key = ?, title_content_key = ?,
                            is_relevant = ?, status = ?
                        WHERE note_id = ?
                        """,
                        (
                            tags_value,
                            title_value,
                            content_value,
                            combined_value,
                            next_relevant,
                            next_status,
                            row["note_id"],
                        ),
                    )

    def seed_from_xlsx(self, xlsx_path: Path) -> int:
        """Synchronize the Excel post index into the local comparison database."""
        from openpyxl import load_workbook

        workbook = load_workbook(xlsx_path, read_only=True, data_only=True)
        if "sheet1_笔记总表" not in workbook.sheetnames:
            raise ValueError("seed workbook is missing sheet1_笔记总表")
        worksheet = workbook["sheet1_笔记总表"]
        headers = [cell.value for cell in next(worksheet.iter_rows(min_row=1, max_row=1))]
        index = {str(value): position for position, value in enumerate(headers) if value}
        if "笔记ID" not in index:
            raise ValueError("seed workbook is missing 笔记ID")

        def value(row: tuple[Any, ...], name: str) -> str:
            position = index.get(name)
            return text(row[position]) if position is not None and position < len(row) else ""

        inserted = 0
        timestamp = now_iso()
        with self.lock, self._session() as db:
            for row in worksheet.iter_rows(min_row=2, values_only=True):
                note_id = valid_note_id(value(row, "笔记ID"))
                if not note_id:
                    continue
                row_title = value(row, "笔记标题")
                row_content = value(row, "笔记内容")
                row_tags = value(row, "笔记话题")
                row_title_key, row_content_key, row_combined_key = identity_keys(row_title, row_content)
                existing = db.execute("SELECT note_id,url,page_url FROM notes WHERE note_id = ?", (note_id,)).fetchone()
                if existing:
                    # A note may have been discovered by the browser before it
                    # was manually added to Excel. Promote it on every reload
                    # so the extension immediately reports "Excel 已有".
                    db.execute(
                        """
                        UPDATE notes SET
                            url=CASE WHEN ? <> '' THEN ? ELSE url END,
                            title=CASE WHEN ? <> '' THEN ? ELSE title END,
                            author=CASE WHEN ? <> '' THEN ? ELSE author END,
                            content=CASE WHEN ? <> '' THEN ? ELSE content END,
                            tags=CASE WHEN ? <> '' THEN ? ELSE tags END,
                            keyword=CASE WHEN ? <> '' THEN ? ELSE keyword END,
                            page_url=CASE WHEN ? <> '' THEN ? ELSE page_url END,
                            status='known', source='existing_xlsx', is_relevant=1, relevance_status='relevant', relevance_source='excel',
                            post_sentiment=CASE WHEN ? <> '' THEN ? ELSE post_sentiment END,
                            title_key=CASE WHEN ? <> '' THEN ? ELSE title_key END,
                            content_key=CASE WHEN ? <> '' THEN ? ELSE content_key END,
                            title_content_key=CASE WHEN ? <> '' THEN ? ELSE title_content_key END,
                            last_seen_at=?
                        WHERE note_id=?
                        """,
                        (
                            preferred_url(existing["url"], value(row, "笔记url")), preferred_url(existing["url"], value(row, "笔记url")),
                            row_title, row_title,
                            value(row, "用户昵称"), value(row, "用户昵称"),
                            row_content, row_content,
                            row_tags, row_tags,
                            value(row, "来源词"), value(row, "来源词"),
                            preferred_url(existing["page_url"], value(row, "笔记url")), preferred_url(existing["page_url"], value(row, "笔记url")),
                            value(row, "帖子好坏"), value(row, "帖子好坏"),
                            row_title_key, row_title_key,
                            row_content_key, row_content_key,
                            row_combined_key, row_combined_key,
                            timestamp, note_id,
                        ),
                    )
                    continue
                db.execute(
                    """
                    INSERT INTO notes (
                        note_id, url, title, author, content, tags, keyword, page_url,
                        first_seen_at, last_seen_at, status, is_relevant, source,
                        post_sentiment, title_key, content_key, title_content_key, payload_json
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'known', ?, 'existing_xlsx', ?, ?, ?, ?, ?)
                    """,
                    (
                        note_id,
                        value(row, "笔记url"),
                        row_title,
                        value(row, "用户昵称"),
                        row_content,
                        row_tags,
                        value(row, "来源词"),
                        value(row, "笔记url"),
                        timestamp,
                        timestamp,
                        1,
                        value(row, "帖子好坏"),
                        row_title_key,
                        row_content_key,
                        row_combined_key,
                        json.dumps({"seed": "xlsx", "tags": row_tags}, ensure_ascii=False),
                    ),
                )
                inserted += 1

            if 'sheet3_不相关帖子' in workbook.sheetnames:
                irrelevant_sheet = workbook['sheet3_不相关帖子']
                irrelevant_headers = [cell.value for cell in next(irrelevant_sheet.iter_rows(min_row=1, max_row=1))]
                irrelevant_index = {str(item): position for position, item in enumerate(irrelevant_headers) if item}
                def irrelevant_value(row: tuple[Any, ...], name: str) -> str:
                    position = irrelevant_index.get(name)
                    return text(row[position]) if position is not None and position < len(row) else ''
                for row in irrelevant_sheet.iter_rows(min_row=2, values_only=True):
                    note_id = valid_note_id(irrelevant_value(row, '笔记ID'))
                    if not note_id:
                        continue
                    row_title = irrelevant_value(row, '笔记标题')
                    row_content = irrelevant_value(row, '笔记内容')
                    row_tags = irrelevant_value(row, '笔记话题')
                    title_key, content_key, combined_key = identity_keys(row_title, row_content)
                    db.execute(
                        """INSERT INTO notes (note_id,url,title,author,content,tags,keyword,page_url,first_seen_at,last_seen_at,
                           status,is_relevant,source,title_key,content_key,title_content_key,payload_json,relevance_status,
                           relevance_source,relevance_reason,relevance_confidence,relevance_analyzed_at)
                           VALUES (?,?,?,?,?,?,?,?,?,?,'irrelevant',0,'irrelevant_xlsx',?,?,?,'{}','irrelevant',?,?,?,?)
                           ON CONFLICT(note_id) DO UPDATE SET status='irrelevant',is_relevant=0,
                           relevance_status='irrelevant',relevance_source='irrelevant_xlsx',
                           relevance_reason=excluded.relevance_reason,relevance_confidence=excluded.relevance_confidence,
                           relevance_analyzed_at=excluded.relevance_analyzed_at,last_seen_at=excluded.last_seen_at""",
                        (note_id, irrelevant_value(row,'笔记url'), row_title, irrelevant_value(row,'用户昵称'),
                         row_content, row_tags, irrelevant_value(row,'来源词'), irrelevant_value(row,'笔记url'), timestamp, timestamp,
                         title_key, content_key, combined_key, irrelevant_value(row,'AI判断来源') or 'excel',
                         irrelevant_value(row,'AI判断理由'), float(irrelevant_value(row,'AI置信度') or 0),
                         irrelevant_value(row,'分析时间') or timestamp),
                    )
            # Excel is the user-facing source of truth. Mark every row that
            # was successfully read from this workbook as synced so the
            # browser can distinguish an actual Excel row from a discovery
            # record that only lives in SQLite.
            db.execute(
                """UPDATE notes SET pull_status='synced', pull_error='', relevance_status='relevant', relevance_source='excel',
                   excel_synced_at=?, excel_sync_path=?
                   WHERE source='existing_xlsx'""",
                (timestamp, str(xlsx_path)),
            )
        workbook.close()
        return inserted

    def _find_match(
        self,
        db: sqlite3.Connection,
        note_id: str,
        title_value: str,
        content_value: str,
        combined_value: str,
        detail_read: bool = False,
    ) -> tuple[sqlite3.Row | None, str]:
        """Find a local note with Excel-safe fallbacks for truncated DOM text."""
        if note_id:
            row = db.execute("SELECT * FROM notes WHERE note_id = ?", (note_id,)).fetchone()
            if row is not None:
                return row, "note_id"
        if combined_value:
            row = db.execute(
                "SELECT * FROM notes WHERE title_content_key = ? ORDER BY first_seen_at DESC LIMIT 1",
                (combined_value,),
            ).fetchone()
            if row is not None:
                return row, "title_content"
        # Search cards often expose a partial caption. A unique exact title is
        # therefore still a valid identity even when some content was read.
        if title_value and (not content_value or not detail_read):
            excel_rows = db.execute(
                "SELECT * FROM notes WHERE source='existing_xlsx' AND title_key=? ORDER BY first_seen_at DESC LIMIT 2",
                (title_value,),
            ).fetchall()
            if len(excel_rows) == 1:
                return excel_rows[0], "excel_title"
            rows = db.execute(
                "SELECT * FROM notes WHERE title_key = ? ORDER BY first_seen_at DESC LIMIT 2",
                (title_value,),
            ).fetchall()
            if len(rows) == 1:
                return rows[0], "title"
        if content_value:
            excel_rows = db.execute(
                "SELECT * FROM notes WHERE source='existing_xlsx' AND content_key=? ORDER BY first_seen_at DESC LIMIT 2",
                (content_value,),
            ).fetchall()
            if len(excel_rows) == 1:
                return excel_rows[0], "excel_content"
            rows = db.execute(
                "SELECT * FROM notes WHERE content_key = ? ORDER BY first_seen_at DESC LIMIT 2",
                (content_value,),
            ).fetchall()
            if len(rows) == 1:
                return rows[0], "content"
        # Xiaohongshu truncates titles and captions with ellipses. Restrict
        # containment fallback to Excel rows and require enough characters to
        # avoid matching generic titles such as “护肤分享”.
        partial_title = title_value.rstrip(".…·•-_—~～")
        if len(partial_title) >= 8 and not detail_read:
            rows = db.execute(
                "SELECT * FROM notes WHERE source='existing_xlsx' AND length(title_key)>=8"
            ).fetchall()
            matches = [
                row for row in rows
                if partial_title in str(row["title_key"]).rstrip(".…·•-_—~～")
                or str(row["title_key"]).rstrip(".…·•-_—~～") in partial_title
            ]
            if len(matches) == 1:
                return matches[0], "excel_title_partial"
        if len(content_value) >= 24:
            rows = db.execute(
                "SELECT * FROM notes WHERE source='existing_xlsx' AND length(content_key)>=24"
            ).fetchall()
            matches = [row for row in rows if content_value in str(row["content_key"]) or str(row["content_key"]) in content_value]
            if len(matches) == 1:
                return matches[0], "excel_content_partial"
        return None, ""

    def scan(self, payload: dict[str, Any]) -> dict[str, Any]:
        keyword = text(payload.get("keyword"), 200)
        page_url = text(payload.get("pageUrl"), 2000)
        scanned_at = text(payload.get("scannedAt"), 80) or now_iso()
        reason = text(payload.get("reason"), 40) or "manual"
        title_only = bool(payload.get("titleOnly"))
        return_all_statuses = bool(payload.get("returnAllStatuses"))
        raw_notes = payload.get("notes") or []
        if not isinstance(raw_notes, list):
            raise ValueError("notes must be an array")

        statuses: list[dict[str, Any]] = []
        inserted_notes: list[dict[str, Any]] = []
        relevant_notes: list[dict[str, Any]] = []
        filtered_count = 0

        def status_record(
            note_id: str,
            matched_note_id: str,
            status: str,
            is_new: bool,
            matched_by: str,
            in_excel: bool,
            relevant: bool,
            first_seen_at: str,
            relevance_matches: list[str],
            existing: sqlite3.Row | None,
        ) -> dict[str, Any]:
            stored_relevance = (str(existing["relevance_status"] or "")
                                if existing is not None and "relevance_status" in existing.keys() else "")
            relevance_status = "relevant" if in_excel else (stored_relevance if stored_relevance in {"relevant", "irrelevant"} else ("relevant" if relevant else "unknown"))
            return {
                "noteId": note_id,
                "matchedNoteId": matched_note_id,
                "status": status,
                "isNew": is_new,
                "matchedBy": matched_by or "none",
                "matchLabel": {
                    "note_id": "帖子ID",
                    "title_content": "标题+文案",
                    "title": "标题",
                    "content": "文案",
                    "excel_title": "Excel标题",
                    "excel_content": "Excel文案",
                    "excel_title_partial": "Excel标题（截断容错）",
                    "excel_content_partial": "Excel文案（截断容错）",
                }.get(matched_by, ""),
                "inExcel": in_excel,
                "excelStatus": "existing" if in_excel else "missing",
                "isRelevant": relevance_status == "relevant",
                "relevanceStatus": relevance_status,
                "relevanceSource": (str(existing["relevance_source"] or "") if existing is not None and "relevance_source" in existing.keys() else ("excel" if in_excel else ("keyword" if relevant else ""))),
                "relevanceReason": (str(existing["relevance_reason"] or "") if existing is not None and "relevance_reason" in existing.keys() else ""),
                "relevanceConfidence": (float(existing["relevance_confidence"] or 0) if existing is not None and "relevance_confidence" in existing.keys() else (1.0 if in_excel else 0.0)),
                "firstSeenAt": first_seen_at,
                "relevanceMatches": relevance_matches,
                "pullStatus": str(existing["pull_status"]) if existing is not None and "pull_status" in existing.keys() else "not_started",
                "pullError": str(existing["pull_error"]) if existing is not None and "pull_error" in existing.keys() else "",
                "mediaStatus": str(existing["media_status"]) if existing is not None and "media_status" in existing.keys() else "not_started",
                "mediaDir": str(existing["media_dir"]) if existing is not None and "media_dir" in existing.keys() else "",
                "mediaFileCount": int(existing["media_file_count"] or 0) if existing is not None and "media_file_count" in existing.keys() else 0,
                "mediaError": str(existing["media_error"]) if existing is not None and "media_error" in existing.keys() else "",
            }

        with self.lock, self._session() as db:
            excel_rows: list[sqlite3.Row] = []
            excel_by_title: dict[str, list[sqlite3.Row]] = {}
            stored_by_id: dict[str, sqlite3.Row] = {}
            if title_only:
                excel_rows = db.execute("SELECT * FROM notes WHERE source='existing_xlsx'").fetchall()
                for row in excel_rows:
                    excel_by_title.setdefault(str(row["title_key"] or ""), []).append(row)
                stored_by_id = {
                    str(row["note_id"]): row
                    for row in db.execute("SELECT * FROM notes").fetchall()
                }
            for raw_note in raw_notes:
                if not isinstance(raw_note, dict):
                    continue
                note_id = valid_note_id(raw_note.get("noteId"))
                if not note_id:
                    continue
                note_url = text(raw_note.get("url"), 2000)
                title = text(raw_note.get("title"), 1000)
                author = text(raw_note.get("author"), 500)
                content = text(raw_note.get("content"), 12000)
                content_hash = self._content_hash(content)
                tags = tag_text(raw_note.get("tags"))
                media_text = text(raw_note.get("mediaText"), 6000)
                title_value, content_value, combined_value = identity_keys(title, content)
                payload_json = json.dumps(raw_note, ensure_ascii=False)
                if title_only:
                    exact_excel = excel_by_title.get(title_value, []) if title_value else []
                    excel_existing = exact_excel[0] if exact_excel else None
                    matched_by = "excel_title" if excel_existing is not None else ""
                    partial_title = title_value.rstrip(".…·•-_—~～")
                    if excel_existing is None and len(partial_title) >= 8:
                        partial_matches = [
                            row for row in excel_rows
                            if partial_title in str(row["title_key"] or "").rstrip(".…·•-_—~～")
                            or str(row["title_key"] or "").rstrip(".…·•-_—~～") in partial_title
                        ]
                        if len(partial_matches) == 1:
                            excel_existing = partial_matches[0]
                            matched_by = "excel_title_partial"
                    existing = excel_existing or stored_by_id.get(note_id)
                    if not matched_by and existing is not None:
                        matched_by = "note_id"
                else:
                    excel_existing = None
                    existing, matched_by = self._find_match(
                        db, note_id, title_value, content_value, combined_value, bool(raw_note.get("detailRead"))
                    )
                if existing is not None:
                    note_url = preferred_url(existing["url"], note_url)
                relevant, relevance_matches = relevance_match(title, content, tags, media_text, author)
                stored_relevance = (str(existing["relevance_status"] or "")
                                    if existing is not None and "relevance_status" in existing.keys() else "")
                if stored_relevance == "relevant":
                    relevant = True
                elif stored_relevance == "irrelevant":
                    relevant = False
                in_excel = bool(excel_existing is not None) if title_only else bool(
                    existing is not None and str(existing["source"]) == "existing_xlsx"
                )
                if not relevant and not in_excel:
                    filtered_count += 1
                    if return_all_statuses:
                        statuses.append(status_record(
                            note_id,
                            str(existing["note_id"]) if existing is not None else note_id,
                            "irrelevant" if stored_relevance == "irrelevant" else "new",
                            stored_relevance != "irrelevant",
                            matched_by,
                            False,
                            False,
                            str(existing["first_seen_at"]) if existing is not None else scanned_at,
                            relevance_matches,
                            existing,
                        ))
                    continue
                relevant_notes.append(raw_note)
                if existing is None:
                    db.execute(
                        """
                        INSERT INTO notes (
                            note_id, url, title, author, content, tags, keyword, page_url,
                            first_seen_at, last_seen_at, status, is_relevant, source,
                            title_key, content_key, title_content_key, payload_json, content_hash
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', 1, 'dom', ?, ?, ?, ?, ?)
                        """,
                        (
                            note_id,
                            note_url,
                            title,
                            author,
                            content,
                            tags,
                            keyword,
                            page_url,
                            scanned_at,
                            scanned_at,
                            title_value,
                            content_value,
                            combined_value,
                            payload_json,
                            content_hash,
                        ),
                    )
                    status = "new"
                    is_new = True
                    first_seen_at = scanned_at
                    matched_note_id = note_id
                    inserted_notes.append({"noteId": note_id, "title": title, "url": note_url})
                else:
                    matched_note_id = str(existing["note_id"])
                    # Keep Excel as the canonical comparison source. Search
                    # cards often contain truncated titles/captions and must
                    # not replace the fields imported from the workbook.
                    preserve_excel = str(existing["source"]) == "existing_xlsx"
                    update_title = "" if preserve_excel else title
                    update_author = "" if preserve_excel else author
                    update_content = "" if preserve_excel else content
                    update_tags = "" if preserve_excel else tags
                    update_keyword = "" if preserve_excel else keyword
                    update_page_url = "" if preserve_excel else page_url
                    update_title_value = "" if preserve_excel else title_value
                    update_content_value = "" if preserve_excel else content_value
                    update_combined_value = "" if preserve_excel else combined_value
                    update_content_hash = "" if preserve_excel else content_hash
                    db.execute(
                        """
                        UPDATE notes
                        SET url = CASE WHEN ? <> '' THEN ? ELSE url END,
                            title = CASE WHEN ? <> '' THEN ? ELSE title END,
                            author = CASE WHEN ? <> '' THEN ? ELSE author END,
                            content = CASE WHEN ? <> '' THEN ? ELSE content END,
                            tags = CASE WHEN ? <> '' THEN ? ELSE tags END,
                            keyword = CASE WHEN ? <> '' THEN ? ELSE keyword END,
                            page_url = CASE WHEN ? <> '' THEN ? ELSE page_url END,
                            is_relevant = 1, relevance_status='relevant',
                            title_key = CASE WHEN ? <> '' THEN ? ELSE title_key END,
                            content_key = CASE WHEN ? <> '' THEN ? ELSE content_key END,
                            title_content_key = CASE WHEN ? <> '' THEN ? ELSE title_content_key END,
                            last_seen_at = ?,
                            payload_json = ?,
                            ai_analysis_status = CASE WHEN ? <> '' AND ? <> content_hash THEN 'not_analyzed' ELSE ai_analysis_status END,
                            content_hash = CASE WHEN ? <> '' THEN ? ELSE content_hash END
                        WHERE note_id = ?
                        """,
                        (
                            note_url,
                            note_url,
                            update_title,
                            update_title,
                            update_author,
                            update_author,
                            update_content,
                            update_content,
                            update_tags,
                            update_tags,
                            update_keyword,
                            update_keyword,
                            update_page_url,
                            update_page_url,
                            update_title_value,
                            update_title_value,
                            update_content_value,
                            update_content_value,
                            update_combined_value,
                            update_combined_value,
                            scanned_at,
                            payload_json,
                            update_content_hash,
                            update_content_hash,
                            update_content_hash,
                            update_content_hash,
                            matched_note_id,
                        ),
                    )
                    status = "known" if title_only and in_excel else ("new" if title_only else str(existing["status"]))
                    is_new = not in_excel if title_only else False
                    first_seen_at = str(existing["first_seen_at"])

                statuses.append(status_record(
                    note_id, matched_note_id, status, is_new, matched_by, in_excel,
                    relevant, first_seen_at, relevance_matches, existing,
                ))

        export_record = {
            "keyword": keyword,
            "pageUrl": page_url,
            "scannedAt": scanned_at,
            "scannedCount": len(raw_notes),
            "relevantCount": len(relevant_notes),
            "filteredCount": filtered_count,
            "notes": relevant_notes,
            "statuses": statuses,
            "inserted": inserted_notes,
            "excelMatchedCount": sum(1 for item in statuses if item.get("inExcel")),
            "excelMissingCount": sum(1 for item in statuses if not item.get("inExcel")),
        }
        export_path: Path | None = None
        if inserted_notes or reason == "manual":
            export_path = self.export_dir / f"scan-{datetime.now().strftime('%Y%m%d-%H%M%S-%f')}.json"
            export_path.write_text(json.dumps(export_record, ensure_ascii=False, indent=2), encoding="utf-8")
        settings = self.ai_settings.get(False)
        if settings.get("configured") and settings.get("auto_analyze_posts"):
            for note in inserted_notes:
                self.enqueue_ai("note", note["noteId"], priority=50)
        return {
            "ok": True,
            "version": VERSION,
            "source": "bridge",
            "scannedCount": len(raw_notes),
            "relevantCount": len(relevant_notes),
            "filteredCount": filtered_count,
            "statuses": statuses,
            "inserted": inserted_notes,
            "excelMatchedCount": sum(1 for item in statuses if item.get("inExcel")),
            "excelMissingCount": sum(1 for item in statuses if not item.get("inExcel")),
            "export": str(export_path) if export_path else "",
        }

    def confirm(self, payload: dict[str, Any]) -> dict[str, Any]:
        note_id = valid_note_id(payload.get("noteId"))
        if not note_id:
            raise ValueError("noteId is required")
        timestamp = now_iso()
        note_url = text(payload.get("url"), 2000)
        title = text(payload.get("title"), 1000)
        author = text(payload.get("author"), 500)
        content = text(payload.get("content"), 12000)
        content_hash = self._content_hash(content)
        tags = tag_text(payload.get("tags"))
        keyword = text(payload.get("keyword"), 200)
        title_value, content_value, combined_value = identity_keys(title, content)
        payload_json = json.dumps(payload, ensure_ascii=False)
        with self.lock, self._session() as db:
            existing = db.execute("SELECT first_seen_at,url,source FROM notes WHERE note_id = ?", (note_id,)).fetchone()
            first_seen_at = str(existing["first_seen_at"]) if existing else timestamp
            if existing:
                note_url = preferred_url(existing["url"], note_url)
            db.execute(
                """
                INSERT INTO notes (
                    note_id, url, title, author, content, tags, keyword, page_url,
                    first_seen_at, last_seen_at, status, is_relevant, source,
                    title_key, content_key, title_content_key, payload_json, content_hash
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', 1, 'manual_confirm', ?, ?, ?, ?, ?)
                ON CONFLICT(note_id) DO UPDATE SET
                    url = CASE WHEN excluded.url <> '' THEN excluded.url ELSE notes.url END,
                    title = CASE WHEN excluded.title <> '' THEN excluded.title ELSE notes.title END,
                    author = CASE WHEN excluded.author <> '' THEN excluded.author ELSE notes.author END,
                    content = CASE WHEN excluded.content <> '' THEN excluded.content ELSE notes.content END,
                    tags = CASE WHEN excluded.tags <> '' THEN excluded.tags ELSE notes.tags END,
                    keyword = CASE WHEN excluded.keyword <> '' THEN excluded.keyword ELSE notes.keyword END,
                    last_seen_at = excluded.last_seen_at,
                    status = CASE WHEN notes.source='existing_xlsx' THEN 'known' ELSE 'confirmed' END,
                    is_relevant = 1,
                    source = CASE WHEN notes.source='existing_xlsx' THEN 'existing_xlsx' ELSE 'manual_confirm' END,
                    title_key = CASE WHEN excluded.title_key <> '' THEN excluded.title_key ELSE notes.title_key END,
                    content_key = CASE WHEN excluded.content_key <> '' THEN excluded.content_key ELSE notes.content_key END,
                    title_content_key = CASE WHEN excluded.title_content_key <> '' THEN excluded.title_content_key ELSE notes.title_content_key END,
                    ai_analysis_status = CASE WHEN excluded.content_hash <> '' AND excluded.content_hash <> notes.content_hash THEN 'not_analyzed' ELSE notes.ai_analysis_status END,
                    content_hash = CASE WHEN excluded.content_hash <> '' THEN excluded.content_hash ELSE notes.content_hash END,
                    pull_status = CASE WHEN notes.source='existing_xlsx' THEN 'synced' ELSE 'queued' END,
                    pull_error = '',
                    payload_json = excluded.payload_json
                """,
                (
                    note_id,
                    note_url,
                    title,
                    author,
                    content,
                    tags,
                    keyword,
                    text(payload.get("pageUrl"), 2000),
                    first_seen_at,
                    timestamp,
                    title_value,
                    content_value,
                    combined_value,
                    payload_json,
                    content_hash,
                ),
            )
        return {"ok": True, "noteId": note_id, "status": "known" if existing and existing["source"] == "existing_xlsx" else "confirmed"}

    def ignore(self, payload: dict[str, Any]) -> dict[str, Any]:
        note_id = valid_note_id(payload.get("noteId"))
        if not note_id:
            raise ValueError("noteId is required")
        with self.lock, self._session() as db:
            updated = db.execute("UPDATE notes SET status = 'ignored', last_seen_at = ? WHERE note_id = ?", (now_iso(), note_id)).rowcount
        if not updated:
            raise ValueError("帖子尚未写入本地数据库，请先重新扫描")
        return {"ok": True, "noteId": note_id, "status": "ignored", "updated": True}

    def restore(self, payload: dict[str, Any]) -> dict[str, Any]:
        note_id = valid_note_id(payload.get("noteId"))
        if not note_id:
            raise ValueError("noteId is required")
        with self.lock, self._session() as db:
            updated = db.execute(
                "UPDATE notes SET status = 'new', last_seen_at = ? WHERE note_id = ? AND status = 'ignored'",
                (now_iso(), note_id),
            ).rowcount
        if not updated:
            raise ValueError("帖子不存在或当前不是已忽略状态")
        return {"ok": True, "noteId": note_id, "status": "new"}

    def ai_settings_public(self) -> dict[str, Any]:
        return {"ok": True, **self.ai_settings.get(False)}

    def save_ai_settings(self, payload: dict[str, Any]) -> dict[str, Any]:
        return {"ok": True, **self.ai_settings.save(payload)}

    def test_ai_connection(self, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        if payload:
            self.ai_settings.save(payload)
        settings = self.ai_settings.get(True)
        result = self.ai_client.complete_json(settings, [
            {"role": "system", "content": "Return valid json only."},
            {"role": "user", "content": "Reply with this json object: {\"ok\":true}"},
        ])
        return {"ok": bool(result.get("ok", True)), "configured": True, "model": settings["model"]}

    @staticmethod
    def _content_hash(value: str) -> str:
        return hashlib.sha256(value.encode("utf-8")).hexdigest() if value else ""

    def upsert_comments(self, payload: dict[str, Any]) -> dict[str, Any]:
        note_id = valid_note_id(payload.get("noteId"))
        if not note_id:
            raise ValueError("noteId is required")
        raw_comments = payload.get("comments") or []
        if not isinstance(raw_comments, list):
            raise ValueError("comments must be an array")
        collection_status = text(payload.get("status"), 30) or "partial"
        if collection_status not in {"collecting", "partial", "likely_complete", "failed"}:
            collection_status = "partial"
        timestamp = text(payload.get("collectedAt"), 80) or now_iso()
        inserted_ids: list[str] = []
        changed_ids: list[str] = []
        with self.lock, self._session() as db:
            if not db.execute("SELECT 1 FROM notes WHERE note_id = ?", (note_id,)).fetchone():
                raise ValueError("帖子尚未写入本地数据库")
            ordered_comments = sorted(
                enumerate(raw_comments),
                key=lambda pair: (max(1, min(int((pair[1] or {}).get("commentLevel") or 1), 3))
                                  if isinstance(pair[1], dict) else 3, pair[0]),
            )
            comment_id_aliases: dict[str, str] = {}
            for index, item in ordered_comments:
                if not isinstance(item, dict):
                    continue
                content = text(item.get("content"), 8000)
                author = text(item.get("author"), 500)
                published_at = text(item.get("publishedAt"), 100)
                if not content:
                    continue
                supplied_id = text(item.get("commentId"), 256)
                supplied_parent_id = text(item.get("parentCommentId"), 256)
                parent_comment_id = comment_id_aliases.get(supplied_parent_id, supplied_parent_id)
                identity = f"{note_id}\x1f{author}\x1f{content}\x1f{published_at}"
                comment_id = supplied_id or f"dom-{hashlib.sha256(identity.encode('utf-8')).hexdigest()[:32]}"
                content_hash = self._content_hash(content)
                existing = db.execute(
                    "SELECT comment_id, content_hash FROM comments WHERE comment_id = ?",
                    (comment_id,),
                ).fetchone()
                if existing is None:
                    existing = db.execute(
                        "SELECT comment_id, content_hash FROM comments WHERE note_id=? AND author=? AND content=? AND published_at=? LIMIT 1",
                        (note_id, author, content, published_at),
                    ).fetchone()
                if existing is None and not published_at:
                    existing = db.execute(
                        "SELECT comment_id, content_hash FROM comments WHERE note_id=? AND author=? AND content=? LIMIT 1",
                        (note_id, author, content),
                    ).fetchone()
                if existing:
                    stored_id = str(existing["comment_id"])
                    if supplied_id:
                        comment_id_aliases[supplied_id] = stored_id
                    changed = str(existing["content_hash"]) != content_hash
                    db.execute(
                        """
                        UPDATE comments SET last_seen_at=?, like_count=?, reply_count=?,
                            parent_comment_id=?, content=?, author=?, author_url=?, published_at=?,
                            comment_url=?, comment_level=?, content_hash=?, payload_json=?,
                            ai_analysis_status=CASE WHEN ? THEN 'not_analyzed' ELSE ai_analysis_status END
                        WHERE comment_id=?
                        """,
                        (timestamp, int(item.get("likeCount") or 0), int(item.get("replyCount") or 0),
                         parent_comment_id, content, author,
                         text(item.get("authorUrl"), 2000), published_at,
                         text(item.get("commentUrl"), 2000),
                         max(1, min(int(item.get("commentLevel") or 1), 3)),
                         content_hash, json.dumps(item, ensure_ascii=False), int(changed), stored_id),
                    )
                    if changed:
                        changed_ids.append(stored_id)
                    continue
                db.execute(
                    """
                    INSERT INTO comments (
                        comment_id,note_id,parent_comment_id,content,author,author_url,published_at,
                        like_count,reply_count,comment_url,comment_level,first_seen_at,last_seen_at,
                        payload_json,content_hash
                    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                    """,
                    (comment_id, note_id, parent_comment_id, content, author,
                     text(item.get("authorUrl"), 2000), published_at, int(item.get("likeCount") or 0),
                     int(item.get("replyCount") or 0), text(item.get("commentUrl"), 2000),
                     max(1, min(int(item.get("commentLevel") or 1), 3)), timestamp, timestamp,
                     json.dumps(item, ensure_ascii=False), content_hash),
                )
                if supplied_id:
                    comment_id_aliases[supplied_id] = comment_id
                inserted_ids.append(comment_id)
            count = int(db.execute("SELECT COUNT(*) FROM comments WHERE note_id=?", (note_id,)).fetchone()[0])
            expected_count = int(payload.get("expectedCount") or 0)
            if collection_status == "likely_complete" and (expected_count <= 0 or count < expected_count):
                collection_status = "partial"
            negative = int(db.execute(
                "SELECT COUNT(*) FROM comments WHERE note_id=? AND is_negative=1 AND ai_confidence>=0.85",
                (note_id,),
            ).fetchone()[0])
            db.execute(
                """UPDATE notes SET comment_collection_status=?, comment_count_collected=?,
                   negative_comment_count=?, last_comment_collected_at=? WHERE note_id=?""",
                (collection_status, count, negative, timestamp, note_id),
            )
            active_job = db.execute(
                "SELECT id FROM comment_collection_jobs WHERE note_id=? AND status='collecting' ORDER BY id DESC LIMIT 1",
                (note_id,),
            ).fetchone()
            if active_job:
                db.execute(
                    """UPDATE comment_collection_jobs SET status=?,collected_count=?,new_count=?,expected_count=?,
                       error_message=?,finished_at=? WHERE id=?""",
                    (collection_status, count, len(inserted_ids), expected_count,
                     text(payload.get("error"), 1000), timestamp, active_job["id"]),
                )
            else:
                db.execute(
                    """INSERT INTO comment_collection_jobs
                       (note_id,status,collected_count,new_count,expected_count,error_message,started_at,finished_at)
                       VALUES (?,?,?,?,?,?,?,?)""",
                    (note_id, collection_status, count, len(inserted_ids), expected_count,
                     text(payload.get("error"), 1000), timestamp, timestamp),
                )
        settings = self.ai_settings.get(False)
        # 拉取流程强制自动分析新评论（不受设置页“自动分析新评论”开关限制）
        if settings.get("configured") and (settings.get("auto_analyze_comments") or payload.get("forceAutoAnalyze")):
            for comment_id in inserted_ids + changed_ids:
                self.enqueue_ai("comment", comment_id, priority=60)
        return {"ok": True, "noteId": note_id, "newCount": len(inserted_ids), "changedCount": len(changed_ids),
                "collectedCount": count, "status": collection_status}

    def start_comment_collection(self, payload: dict[str, Any]) -> dict[str, Any]:
        note_id = valid_note_id(payload.get("noteId"))
        if not note_id:
            raise ValueError("noteId is required")
        timestamp = now_iso()
        with self.lock, self._session() as db:
            if not db.execute("SELECT 1 FROM notes WHERE note_id=?", (note_id,)).fetchone():
                raise ValueError("帖子尚未写入本地数据库")
            db.execute("UPDATE notes SET comment_collection_status='collecting' WHERE note_id=?", (note_id,))
            cursor = db.execute(
                """INSERT INTO comment_collection_jobs(note_id,status,started_at)
                   VALUES(?,'collecting',?)""", (note_id, timestamp)
            )
        return {"ok": True, "jobId": cursor.lastrowid, "noteId": note_id, "status": "collecting"}

    def list_comments(self, note_id: str, limit: int = 500) -> list[dict[str, Any]]:
        note_id = valid_note_id(note_id)
        if not note_id:
            return []
        with self.lock, self._session() as db:
            rows = db.execute(
                "SELECT * FROM comments WHERE note_id=? ORDER BY first_seen_at LIMIT ?",
                (note_id, max(1, min(int(limit), 2000))),
            ).fetchall()
        return [dict(row) for row in rows]


    def note_status(self, note_id: str) -> dict[str, Any]:
        note_id = valid_note_id(note_id)
        if not note_id:
            raise ValueError("noteId is required")
        with self.lock, self._session() as db:
            row = db.execute("SELECT * FROM notes WHERE note_id=?", (note_id,)).fetchone()
        if row is None:
            return {"ok": True, "noteId": note_id, "found": False, "inExcel": False,
                    "pullStatus": "not_started", "relevanceStatus": "unknown"}
        item = dict(row)
        in_excel = item.get("source") == "existing_xlsx" or item.get("pull_status") in {"synced", "partial"}
        relevance_status = item.get("relevance_status") or ("relevant" if item.get("is_relevant") else "unknown")
        return {"ok": True, "noteId": note_id, "found": True, "status": item.get("status", "new"),
                "inExcel": bool(in_excel), "pullStatus": item.get("pull_status") or "not_started",
                "pullError": item.get("pull_error") or "", "relevanceStatus": relevance_status,
                "isRelevant": relevance_status == "relevant", "relevanceSource": item.get("relevance_source") or "",
                "relevanceReason": item.get("relevance_reason") or "",
                "relevanceConfidence": float(item.get("relevance_confidence") or 0)}

    def _sync_irrelevant_to_xlsx(self, note: dict[str, Any], comments: list[dict[str, Any]], decision: dict[str, Any]) -> dict[str, Any]:
        xlsx_path = Path(self.seed_xlsx_path) if self.seed_xlsx_path else None
        if not xlsx_path or not xlsx_path.exists():
            raise ValueError("未配置 Excel 总表路径")
        from openpyxl import load_workbook
        headers = ["笔记url", "用户主页url", "用户昵称", "笔记标题", "笔记内容", "笔记话题",
                   "发布时间", "来源词", "笔记ID", "博主ID", "评论数量", "相关性状态", "AI判断来源",
                   "AI置信度", "AI判断理由", "分析时间", "评论内容汇总"]
        temporary_path = xlsx_path.with_name(f".{xlsx_path.stem}.irrelevant-{os.getpid()}.tmp{xlsx_path.suffix}")
        with self.lock:
            workbook = load_workbook(xlsx_path)
            try:
                sheet = workbook["sheet3_不相关帖子"] if "sheet3_不相关帖子" in workbook.sheetnames else workbook.create_sheet("sheet3_不相关帖子")
                if sheet.max_row == 1 and all(cell.value is None for cell in sheet[1]):
                    sheet.delete_rows(1)
                if sheet.max_row == 0:
                    sheet.append(headers)
                existing_headers = self._excel_headers(sheet)
                for header in headers:
                    if header not in existing_headers:
                        sheet.cell(1, sheet.max_column + 1, header)
                        existing_headers = self._excel_headers(sheet)
                id_column = existing_headers["笔记ID"]
                note_id = valid_note_id(note.get("noteId"))
                target_row = next((row for row in range(2, sheet.max_row + 1)
                                   if valid_note_id(sheet.cell(row, id_column).value) == note_id), sheet.max_row + 1)
                comment_text = "\n".join(
                    f"[{text(item.get('author'), 100)}] {text(item.get('content'), 1000)}"
                    for item in comments if isinstance(item, dict) and text(item.get("content"), 1000)
                )[:30000]
                values = {
                    "笔记url": text(note.get("url"), 2000), "用户主页url": text(note.get("authorUrl"), 2000),
                    "用户昵称": text(note.get("author"), 500), "笔记标题": text(note.get("title"), 1000),
                    "笔记内容": text(note.get("content"), 12000), "笔记话题": tag_text(note.get("tags")),
                    "发布时间": text(note.get("publishedAt"), 100), "来源词": text(note.get("keyword"), 200),
                    "笔记ID": note_id, "博主ID": text(note.get("authorId"), 256), "评论数量": len(comments),
                    "相关性状态": "不相关", "AI判断来源": "DeepSeek", "AI置信度": decision["confidence"],
                    "AI判断理由": decision["reason"], "分析时间": decision["analyzedAt"], "评论内容汇总": comment_text,
                }
                for header, column in existing_headers.items():
                    if header in values:
                        sheet.cell(target_row, column, values[header])
                workbook.save(temporary_path)
            finally:
                workbook.close()
            os.replace(temporary_path, xlsx_path)
        return {"path": str(xlsx_path), "sheet": "sheet3_不相关帖子", "row": target_row}

    def analyze_relevance(self, payload: dict[str, Any]) -> dict[str, Any]:
        note = payload.get("note") or {}
        comments = payload.get("comments") or []
        if not isinstance(note, dict) or not isinstance(comments, list):
            raise ValueError("note and comments are required")
        note_id = valid_note_id(note.get("noteId"))
        if not note_id:
            raise ValueError("noteId is required")
        timestamp = now_iso()
        title = text(note.get("title"), 1000)
        content = text(note.get("content"), 12000)
        tags = tag_text(note.get("tags"))
        title_key, content_key, combined_key = identity_keys(title, content)
        with self.lock, self._session() as db:
            db.execute(
                """INSERT INTO notes (note_id,url,title,author,content,tags,keyword,page_url,first_seen_at,last_seen_at,
                   status,is_relevant,source,title_key,content_key,title_content_key,payload_json,relevance_status)
                   VALUES (?,?,?,?,?,?,?,?,?,?,'new',0,'dom',?,?,?,?,'unknown')
                   ON CONFLICT(note_id) DO UPDATE SET url=excluded.url,title=excluded.title,author=excluded.author,
                   content=excluded.content,tags=excluded.tags,keyword=excluded.keyword,page_url=excluded.page_url,
                   title_key=excluded.title_key,content_key=excluded.content_key,title_content_key=excluded.title_content_key,
                   payload_json=excluded.payload_json,last_seen_at=excluded.last_seen_at""",
                (note_id, text(note.get("url"), 2000), title, text(note.get("author"), 500), content, tags,
                 text(note.get("keyword"), 200), text(note.get("pageUrl"), 2000), timestamp, timestamp,
                 title_key, content_key, combined_key, json.dumps(note, ensure_ascii=False)),
            )
        self.upsert_comments({"noteId": note_id, "comments": comments,
                              "expectedCount": payload.get("expectedCount") or len(comments),
                              "status": payload.get("commentStatus") or "partial", "collectedAt": timestamp})
        settings = self.ai_settings.get(True)
        if not settings.get("configured"):
            raise AIServiceError("DeepSeek API Key 未配置", "not_configured", False)
        compact_comments = [{"author": text(item.get("author"), 200), "content": text(item.get("content"), 2000),
                             "level": int(item.get("commentLevel") or 1), "is_author": bool(item.get("isAuthor"))}
                            for item in comments if isinstance(item, dict) and text(item.get("content"), 2000)]
        schema = {"relevance_status": "relevant/irrelevant/uncertain", "confidence": 0.0,
                  "reason": "简短、可核验理由", "matched_topics": []}
        data = {"monitor_brand": "ORIGANI（含品牌、产品、门店、员工/账号 Talia 等品牌舆情）",
                "title": title, "content": content, "tags": tags, "author": text(note.get("author"), 500),
                "comments": compact_comments}
        messages = [
            {"role": "system", "content": "你是品牌舆情相关性审核员。综合帖子正文和全部评论判断是否与监控品牌直接相关。仅出现搜索联想、同名无关词、路人顺带提及且主题无关时判不相关；证据不足判 uncertain。严格输出一个有效 JSON 对象，不要 Markdown。"},
            {"role": "user", "content": "输出结构：%s。输入：%s" % (json.dumps(schema, ensure_ascii=False), json.dumps(data, ensure_ascii=False))},
        ]
        raw = self.ai_client.complete_json(settings, messages)
        raw_status = text(raw.get("relevance_status"), 30).lower()
        confidence = max(0.0, min(float(raw.get("confidence") or 0), 1.0))
        relevance_status = raw_status if raw_status in {"relevant", "irrelevant"} and confidence >= 0.65 else "unknown"
        reason = text(raw.get("reason"), 2000)
        decision = {"status": relevance_status, "confidence": confidence, "reason": reason, "analyzedAt": timestamp,
                    "matchedTopics": raw.get("matched_topics") if isinstance(raw.get("matched_topics"), list) else []}
        with self.lock, self._session() as db:
            db.execute("""UPDATE notes SET relevance_status=?,relevance_source='ai',relevance_reason=?,
                       relevance_confidence=?,relevance_analyzed_at=?,is_relevant=?,status=? WHERE note_id=?""",
                       (relevance_status, reason, confidence, timestamp, int(relevance_status == "relevant"),
                        "irrelevant" if relevance_status == "irrelevant" else "new", note_id))
            db.execute("""INSERT INTO ai_analysis_records(target_type,target_id,model,request_json,response_json,status,created_at)
                       VALUES('relevance',?,?,?,?, 'completed',?)""",
                       (note_id, settings["model"], json.dumps(messages, ensure_ascii=False), json.dumps(decision, ensure_ascii=False), timestamp))
        excel = None
        excel_warning = ""
        if relevance_status == "irrelevant":
            try:
                excel = self._sync_irrelevant_to_xlsx(note, comments, decision)
            except Exception as exc:
                excel_warning = text(exc, 1000)
        return {"ok": True, "noteId": note_id, "relevanceStatus": relevance_status,
                "isRelevant": relevance_status == "relevant", "relevanceSource": "ai",
                "relevanceReason": reason, "relevanceConfidence": confidence,
                "excel": excel, "excelWarning": excel_warning, "commentCount": len(compact_comments)}

    def enqueue_ai(self, target_type: str, target_id: str, priority: int = 50, force: bool = False) -> dict[str, Any]:
        if target_type not in {"note", "comment"}:
            raise ValueError("targetType must be note or comment")
        target_id = text(target_id, 256)
        table, key = ("notes", "note_id") if target_type == "note" else ("comments", "comment_id")
        timestamp = now_iso()
        with self.lock, self._session() as db:
            if not db.execute(f"SELECT 1 FROM {table} WHERE {key}=?", (target_id,)).fetchone():
                raise ValueError("分析对象不存在")
            if force:
                db.execute("DELETE FROM ai_jobs WHERE target_type=? AND target_id=?", (target_type, target_id))
            db.execute(
                """INSERT INTO ai_jobs(target_type,target_id,priority,status,attempts,available_at,created_at,updated_at)
                   VALUES(?,?,?,'queued',0,0,?,?)
                   ON CONFLICT(target_type,target_id) DO UPDATE SET
                     priority=excluded.priority,status='queued',attempts=CASE WHEN ? THEN 0 ELSE ai_jobs.attempts END,
                     available_at=0,last_error='',updated_at=excluded.updated_at""",
                (target_type, target_id, priority, timestamp, timestamp, int(force)),
            )
            db.execute(f"UPDATE {table} SET ai_analysis_status='queued' WHERE {key}=?", (target_id,))
        self._ensure_ai_worker()
        self.ai_wakeup.set()
        return {"ok": True, "targetType": target_type, "targetId": target_id, "status": "queued"}

    def _ensure_ai_worker(self) -> None:
        self.ai_workers = [worker for worker in self.ai_workers if worker.is_alive()]
        desired = max(1, min(int(self.ai_settings.get(False).get("max_concurrency") or 1), 3))
        while len(self.ai_workers) < desired:
            worker = threading.Thread(
                target=self._ai_worker_loop,
                name=f"xhs-ai-worker-{len(self.ai_workers) + 1}",
                daemon=True,
            )
            self.ai_workers.append(worker)
            worker.start()

    def _recover_jobs(self) -> None:
        with self.lock, self._session() as db:
            db.execute("UPDATE ai_jobs SET status='queued', available_at=0 WHERE status='analyzing'")
            db.execute("UPDATE notes SET ai_analysis_status='queued' WHERE ai_analysis_status='analyzing'")
            db.execute("UPDATE comments SET ai_analysis_status='queued' WHERE ai_analysis_status='analyzing'")

    def ai_status(self) -> dict[str, Any]:
        settings = self.ai_settings.get(False)
        with self.lock, self._session() as db:
            rows = db.execute("SELECT status,COUNT(*) count FROM ai_jobs GROUP BY status").fetchall()
            today = datetime.now().astimezone().date().isoformat()
            used = int(db.execute(
                "SELECT COUNT(*) FROM ai_analysis_records WHERE status='completed' AND substr(created_at,1,10)=?",
                (today,),
            ).fetchone()[0])
            comment_jobs = int(db.execute("SELECT COUNT(*) FROM comment_collection_jobs WHERE status='collecting'").fetchone()[0])
        queue = {str(row["status"]): int(row["count"]) for row in rows}
        if settings["configured"] and queue.get("queued"):
            self._ensure_ai_worker()
        return {"ok": True, "configured": settings["configured"], "model": settings["model"],
                "queue": queue,
                "dailyUsed": used, "dailyLimit": settings["daily_call_limit"], "commentJobs": comment_jobs}

    def note_analysis(self, note_id: str) -> dict[str, Any]:
        note_id = valid_note_id(note_id)
        if not note_id:
            raise ValueError("noteId is required")
        with self.lock, self._session() as db:
            row = db.execute(
                """SELECT note_id,ai_analysis_status,post_sentiment,ai_summary,ai_reason,
                          ai_confidence,risk_level,issue_categories,last_ai_analyzed_at
                   FROM notes WHERE note_id=?""",
                (note_id,),
            ).fetchone()
        if row is None:
            raise ValueError("帖子不存在")
        result = dict(row)
        result["sentimentLabel"] = sentiment_label(result.get("post_sentiment")) if result.get("post_sentiment") else ""
        return {"ok": True, **result}

    def list_ai_jobs(self, status: str = "", limit: int = 100) -> list[dict[str, Any]]:
        safe_status = status if status in {"queued", "analyzing", "completed", "failed"} else ""
        safe_limit = max(1, min(int(limit or 100), 500))
        where = "WHERE j.status=?" if safe_status else ""
        params: tuple[Any, ...] = (safe_status, safe_limit) if safe_status else (safe_limit,)
        with self.lock, self._session() as db:
            rows = db.execute(
                f"""
                SELECT j.*,
                       COALESCE(n.title, parent.title, substr(c.content,1,120), '未命名内容') AS title,
                       COALESCE(n.author, c.author, '') AS author,
                       COALESCE(n.url, c.comment_url, parent.url, '') AS url,
                       COALESCE(n.ai_summary, c.ai_summary, '') AS ai_summary,
                       COALESCE(n.ai_reason, c.ai_reason, '') AS ai_reason,
                       COALESCE(n.post_sentiment, c.sentiment, '') AS sentiment,
                       COALESCE(n.risk_level, c.risk_level, '') AS risk_level,
                       COALESCE(n.ai_confidence, c.ai_confidence, 0) AS ai_confidence
                FROM ai_jobs j
                LEFT JOIN notes n ON j.target_type='note' AND n.note_id=j.target_id
                LEFT JOIN comments c ON j.target_type='comment' AND c.comment_id=j.target_id
                LEFT JOIN notes parent ON c.note_id=parent.note_id
                {where}
                ORDER BY CASE j.status WHEN 'analyzing' THEN 0 WHEN 'queued' THEN 1 WHEN 'failed' THEN 2 ELSE 3 END,
                         j.updated_at DESC
                LIMIT ?
                """,
                params,
            ).fetchall()
        return [dict(row) for row in rows]

    def list_ai_history(self, target_type: str = "", target_id: str = "", limit: int = 100) -> list[dict[str, Any]]:
        safe_type = target_type if target_type in {"note", "comment"} else ""
        safe_limit = max(1, min(int(limit or 100), 500))
        clauses, params = [], []
        if safe_type:
            clauses.append("target_type=?")
            params.append(safe_type)
        if target_id:
            clauses.append("target_id=?")
            params.append(text(target_id, 256))
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        params.append(safe_limit)
        with self.lock, self._session() as db:
            rows = db.execute(
                f"""SELECT id,target_type,target_id,model,response_json,status,error_kind,error_message,created_at
                    FROM ai_analysis_records {where} ORDER BY id DESC LIMIT ?""",
                tuple(params),
            ).fetchall()
        return [dict(row) for row in rows]

    def _analysis_prompt(self, target_type: str, row: sqlite3.Row, context: dict[str, Any]) -> list[dict[str, str]]:
        categories = ["强行拉客","过度推销","购买压力","服务态度","未倾听客户需求","产品知识不足","产品效果不满意",
                      "产品质量","产品价格","价格不透明","退款问题","售后问题","门店体验","护理体验","预约问题",
                      "误导宣传","过敏或不适","品牌质疑","账号或销售人员争议","其他"]
        schema = {
            "sentiment": "negative/light_negative/neutral/positive/irrelevant/spam/uncertain",
            "is_negative": False, "risk_level": "P0/P1/P2/P3", "issue_categories": ["其他"],
            "summary": "", "reason": "", "confidence": 0.0, "needs_attention": False, "suggested_action": ""
        }
        source = dict(row)
        target_id = text(source.get("note_id") if target_type == "note" else source.get("comment_id"), 256)
        data = {
            "target_id": target_id,
            "title": text(source.get("title"), 1000),
            "content": text(source.get("content"), 12000),
            "tags": text(source.get("tags"), 2000),
            "author": text(source.get("author"), 500),
        }
        if target_type == "comment":
            data = {
                "target_id": target_id,
                "content": text(source.get("content"), 8000),
                "author": text(source.get("author"), 500),
                "parent_comment_id": text(source.get("parent_comment_id"), 256),
            }
            data["post_title"] = context.get("title", "")
            data["post_summary"] = context.get("ai_summary", "")
        return [
            {"role": "system", "content": "你是品牌舆情分析员。只依据输入文本，严格输出一个有效 json 对象，不要 Markdown。不要把无关或不确定内容强判为负面。"},
            {"role": "user", "content": "请分析以下小红书%s。允许的问题分类仅为：%s。输出 json 字段和示例：%s。输入：%s" %
             ("评论" if target_type == "comment" else "帖子", "、".join(categories),
              json.dumps(schema, ensure_ascii=False), json.dumps(data, ensure_ascii=False, default=str))},
        ]

    @staticmethod
    def _normalized_analysis(value: dict[str, Any]) -> dict[str, Any]:
        sentiment = text(value.get("sentiment"), 40).lower() or "uncertain"
        if sentiment not in SENTIMENTS:
            sentiment = "uncertain"
        confidence = max(0.0, min(float(value.get("confidence") or 0), 1.0))
        risk = text(value.get("risk_level"), 8).upper()
        if risk not in {"P0", "P1", "P2", "P3"}:
            risk = "P3"
        categories = value.get("issue_categories") or []
        if not isinstance(categories, list):
            categories = [text(categories, 100)]
        clean_categories = [text(item, 100) for item in categories if text(item, 100) in ISSUE_CATEGORIES]
        return {"sentiment": sentiment, "is_negative": int(bool(value.get("is_negative"))), "risk_level": risk,
                "issue_categories": json.dumps(clean_categories or (["其他"] if value.get("is_negative") else []), ensure_ascii=False),
                "ai_summary": text(value.get("summary"), 1000), "ai_reason": text(value.get("reason"), 2000),
                "ai_confidence": confidence, "needs_attention": int(bool(value.get("needs_attention"))),
                "suggested_action": text(value.get("suggested_action"), 1000)}

    def _run_ai_job(self, job: sqlite3.Row) -> None:
        target_type, target_id = str(job["target_type"]), str(job["target_id"])
        table, key = ("notes", "note_id") if target_type == "note" else ("comments", "comment_id")
        settings = self.ai_settings.get(True)
        if not settings.get("configured"):
            raise AIServiceError("DeepSeek API Key 未配置", "not_configured", False)
        with self.lock, self._session() as db:
            row = db.execute(f"SELECT * FROM {table} WHERE {key}=?", (target_id,)).fetchone()
            if row is None:
                raise AIServiceError("分析对象已不存在", "missing_target", False)
            context: dict[str, Any] = {}
            if target_type == "comment":
                note = db.execute("SELECT title,ai_summary FROM notes WHERE note_id=?", (row["note_id"],)).fetchone()
                context = dict(note) if note else {}
            db.execute(f"UPDATE {table} SET ai_analysis_status='analyzing' WHERE {key}=?", (target_id,))
        messages = self._analysis_prompt(target_type, row, context)
        result = self._normalized_analysis(self.ai_client.complete_json(settings, messages))
        timestamp = now_iso()
        with self.lock, self._session() as db:
            db.execute(
                f"""UPDATE {table} SET ai_analysis_status='completed', sentiment=sentiment WHERE 0"""
                if target_type == "comment" else "SELECT 1"
            )
            sentiment_column = "sentiment" if target_type == "comment" else "post_sentiment"
            db.execute(
                f"""UPDATE {table} SET ai_analysis_status='completed',{sentiment_column}=?,is_negative=?,risk_level=?,
                    issue_categories=?,ai_summary=?,ai_reason=?,ai_confidence=?,needs_attention=?,suggested_action=?,
                    last_ai_analyzed_at=? WHERE {key}=?""",
                (result["sentiment"], result["is_negative"], result["risk_level"], result["issue_categories"],
                 result["ai_summary"], result["ai_reason"], result["ai_confidence"], result["needs_attention"],
                 result["suggested_action"], timestamp, target_id),
            )
            db.execute(
                """INSERT INTO ai_analysis_records(target_type,target_id,model,request_json,response_json,status,created_at)
                   VALUES(?,?,?,?,?,'completed',?)""",
                (target_type, target_id, settings["model"], json.dumps(messages, ensure_ascii=False),
                 json.dumps(result, ensure_ascii=False), timestamp),
            )
            db.execute("UPDATE ai_jobs SET status='completed',updated_at=? WHERE id=?", (timestamp, job["id"]))
            if target_type == "comment":
                db.execute(
                    """UPDATE notes SET negative_comment_count=(SELECT COUNT(*) FROM comments
                       WHERE note_id=? AND is_negative=1 AND ai_confidence>=0.85) WHERE note_id=?""",
                    (row["note_id"], row["note_id"]),
                )
        try:
            self._sync_ai_result_to_xlsx(target_type, target_id, result)
        except Exception:
            # SQLite remains the source of truth. A later pull/open can reconcile
            # Excel when the workbook was temporarily locked by desktop Excel.
            pass

    def _run_comment_batch(self, jobs: list[sqlite3.Row]) -> None:
        settings = self.ai_settings.get(True)
        rows: dict[str, sqlite3.Row] = {}
        inputs: list[dict[str, Any]] = []
        with self.lock, self._session() as db:
            for job in jobs:
                target_id = str(job["target_id"])
                row = db.execute("SELECT * FROM comments WHERE comment_id=?", (target_id,)).fetchone()
                if row is None:
                    continue
                note = db.execute("SELECT title,ai_summary FROM notes WHERE note_id=?", (row["note_id"],)).fetchone()
                rows[target_id] = row
                inputs.append({"target_id": target_id, "content": row["content"], "author": row["author"],
                               "parent_comment_id": row["parent_comment_id"], "post_title": note["title"] if note else "",
                               "post_summary": note["ai_summary"] if note else ""})
                db.execute("UPDATE comments SET ai_analysis_status='analyzing' WHERE comment_id=?", (target_id,))
        if not inputs:
            raise AIServiceError("评论分析对象已不存在", "missing_target", False)
        schema = {"results": [{"target_id": "", "sentiment": "negative/light_negative/neutral/positive/irrelevant/spam/uncertain",
                  "is_negative": False, "risk_level": "P0/P1/P2/P3", "issue_categories": [], "summary": "",
                  "reason": "", "confidence": 0.0, "needs_attention": False, "suggested_action": ""}]}
        messages = [
            {"role": "system", "content": "你是品牌舆情分析员。必须为每个 target_id 独立判断，严格输出一个有效 json 对象，不要 Markdown。"},
            {"role": "user", "content": "批量分析这些小红书评论。只输出 json，结构示例：%s。输入：%s" %
             (json.dumps(schema, ensure_ascii=False), json.dumps(inputs, ensure_ascii=False))},
        ]
        # Batch JSON output grows with the number of comments; scale max_tokens
        # so a full batch is not truncated by the single-comment token budget.
        batch_settings = dict(settings)
        base_tokens = int(batch_settings.get("max_tokens") or 1800)
        batch_settings["max_tokens"] = min(8192, max(base_tokens, 1200 + 400 * len(inputs)))
        raw = self.ai_client.complete_json(batch_settings, messages)
        result_list = raw.get("results") if isinstance(raw, dict) else None
        if not isinstance(result_list, list):
            raise AIServiceError("批量评论分析缺少 results 数组", "invalid_response", True)
        by_id = {text(item.get("target_id"), 256): item for item in result_list if isinstance(item, dict)}
        timestamp = now_iso()
        with self.lock, self._session() as db:
            for job in jobs:
                target_id = str(job["target_id"])
                row = rows.get(target_id)
                item = by_id.get(target_id)
                if row is None or item is None:
                    raise AIServiceError(f"批量结果缺少 {target_id}", "invalid_response", True)
                result = self._normalized_analysis(item)
                db.execute(
                    """UPDATE comments SET ai_analysis_status='completed',sentiment=?,is_negative=?,risk_level=?,
                       issue_categories=?,ai_summary=?,ai_reason=?,ai_confidence=?,needs_attention=?,suggested_action=?,
                       last_ai_analyzed_at=? WHERE comment_id=?""",
                    (result["sentiment"], result["is_negative"], result["risk_level"], result["issue_categories"],
                     result["ai_summary"], result["ai_reason"], result["ai_confidence"], result["needs_attention"],
                     result["suggested_action"], timestamp, target_id),
                )
                db.execute(
                    """INSERT INTO ai_analysis_records(target_type,target_id,model,request_json,response_json,status,created_at)
                       VALUES('comment',?,?,?,?,'completed',?)""",
                    (target_id, settings["model"], json.dumps(inputs, ensure_ascii=False), json.dumps(result, ensure_ascii=False), timestamp),
                )
                db.execute("UPDATE ai_jobs SET status='completed',updated_at=? WHERE id=?", (timestamp, job["id"]))
                db.execute(
                    """UPDATE notes SET negative_comment_count=(SELECT COUNT(*) FROM comments
                       WHERE note_id=? AND is_negative=1 AND ai_confidence>=0.85) WHERE note_id=?""",
                    (row["note_id"], row["note_id"]),
                )

    def _ai_worker_loop(self) -> None:
        cooldowns = (5, 30, 120)
        while not self.ai_stopping.is_set():
            job = None
            has_pending = False
            with self.lock, self._session() as db:
                settings = self.ai_settings.get(False)
                today = datetime.now().astimezone().date().isoformat()
                used = int(db.execute(
                    "SELECT COUNT(*) FROM ai_analysis_records WHERE status='completed' AND substr(created_at,1,10)=?", (today,)
                ).fetchone()[0])
                if settings.get("configured") and used < int(settings["daily_call_limit"]):
                    has_pending = bool(db.execute("SELECT 1 FROM ai_jobs WHERE status='queued' LIMIT 1").fetchone())
                    job = db.execute(
                        "SELECT * FROM ai_jobs WHERE status='queued' AND available_at<=? ORDER BY priority,created_at LIMIT 1",
                        (time.time(),),
                    ).fetchone()
                    if job:
                        db.execute("UPDATE ai_jobs SET status='analyzing',updated_at=? WHERE id=?", (now_iso(), job["id"]))
            if not job:
                if not has_pending:
                    return
                self.ai_wakeup.wait(1.0)
                self.ai_wakeup.clear()
                continue
            jobs = [job]
            if str(job["target_type"]) == "comment":
                batch_size = max(10, min(int(settings.get("comment_batch_size") or 15), 20))
                with self.lock, self._session() as db:
                    extras = db.execute(
                        """SELECT * FROM ai_jobs WHERE status='queued' AND target_type='comment' AND available_at<=?
                           AND attempts=0 AND id<>? ORDER BY priority,created_at LIMIT ?""",
                        (time.time(), job["id"], batch_size - 1),
                    ).fetchall()
                    jobs.extend(extras)
                    for extra in extras:
                        db.execute("UPDATE ai_jobs SET status='analyzing',updated_at=? WHERE id=?", (now_iso(), extra["id"]))
            try:
                if len(jobs) > 1:
                    self._run_comment_batch(jobs)
                else:
                    self._run_ai_job(job)
            except Exception as exc:
                for failed_job in jobs:
                    attempts = int(failed_job["attempts"]) + 1
                    retryable = bool(getattr(exc, "retryable", False)) and attempts < 3
                    next_status = "queued" if retryable else "failed"
                    available = time.time() + cooldowns[min(attempts - 1, len(cooldowns) - 1)] if retryable else 0
                    timestamp = now_iso()
                    target_type, target_id = str(failed_job["target_type"]), str(failed_job["target_id"])
                    table, key = ("notes", "note_id") if target_type == "note" else ("comments", "comment_id")
                    with self.lock, self._session() as db:
                        db.execute(
                            "UPDATE ai_jobs SET status=?,attempts=?,available_at=?,last_error=?,updated_at=? WHERE id=?",
                            (next_status, attempts, available, text(exc, 1000), timestamp, failed_job["id"]),
                        )
                        db.execute(f"UPDATE {table} SET ai_analysis_status=? WHERE {key}=?", (next_status, target_id))
                        db.execute(
                            """INSERT INTO ai_analysis_records(target_type,target_id,status,error_kind,error_message,created_at)
                               VALUES(?,?,?,?,?,?)""",
                            (target_type, target_id, "failed", text(getattr(exc, "kind", "unknown"), 60), text(exc, 1000), timestamp),
                        )

    def negative_summary(self) -> dict[str, Any]:
        unresolved = ("pending_review", "pending_action", "in_progress")
        with self.lock, self._session() as db:
            notes = int(db.execute("SELECT COUNT(*) FROM notes WHERE manual_negative=1 OR (is_negative=1 AND ai_confidence>=0.85)").fetchone()[0])
            comments = int(db.execute("SELECT COUNT(*) FROM comments WHERE manual_negative=1 OR (is_negative=1 AND ai_confidence>=0.85)").fetchone()[0])
            suspected = int(db.execute("SELECT COUNT(*) FROM notes WHERE is_negative=1 AND ai_confidence>=0.6 AND ai_confidence<0.85").fetchone()[0]) + int(db.execute("SELECT COUNT(*) FROM comments WHERE is_negative=1 AND ai_confidence>=0.6 AND ai_confidence<0.85").fetchone()[0])
            critical = int(db.execute("SELECT COUNT(*) FROM notes WHERE is_negative=1 AND risk_level IN ('P0','P1')").fetchone()[0]) + int(db.execute("SELECT COUNT(*) FROM comments WHERE is_negative=1 AND risk_level IN ('P0','P1')").fetchone()[0])
            resolved = int(db.execute("SELECT COUNT(*) FROM notes WHERE review_status='resolved'").fetchone()[0]) + int(db.execute("SELECT COUNT(*) FROM comments WHERE review_status='resolved'").fetchone()[0])
            placeholders = ",".join("?" for _ in unresolved)
            open_count = int(db.execute(f"SELECT COUNT(*) FROM notes WHERE (manual_negative=1 OR (is_negative=1 AND ai_confidence>=0.85)) AND review_status IN ({placeholders})", unresolved).fetchone()[0]) + int(db.execute(f"SELECT COUNT(*) FROM comments WHERE (manual_negative=1 OR (is_negative=1 AND ai_confidence>=0.85)) AND review_status IN ({placeholders})", unresolved).fetchone()[0])
        return {"ok": True, "unresolved": open_count, "negativePosts": notes, "negativeComments": comments,
                "suspected": suspected, "critical": critical, "resolved": resolved}

    def list_negative(self, target_type: str = "", confidence: str = "high", limit: int = 200) -> list[dict[str, Any]]:
        minimum, maximum = (0.85, 1.01) if confidence == "high" else (0.6, 0.85)
        target_types = [target_type] if target_type in {"note", "comment"} else ["note", "comment"]
        results: list[dict[str, Any]] = []
        with self.lock, self._session() as db:
            if "note" in target_types:
                rows = db.execute("SELECT * FROM notes WHERE manual_negative=1 OR (is_negative=1 AND ai_confidence>=? AND ai_confidence<?) ORDER BY risk_level,first_seen_at DESC LIMIT ?", (minimum, maximum, limit)).fetchall()
                results.extend({**dict(row), "target_type": "note", "target_id": row["note_id"]} for row in rows)
            if "comment" in target_types:
                rows = db.execute("""SELECT c.*,n.title post_title,n.url post_url FROM comments c JOIN notes n ON n.note_id=c.note_id
                                   WHERE c.manual_negative=1 OR (c.is_negative=1 AND c.ai_confidence>=? AND c.ai_confidence<?) ORDER BY c.risk_level,c.first_seen_at DESC LIMIT ?""", (minimum, maximum, limit)).fetchall()
                results.extend({**dict(row), "target_type": "comment", "target_id": row["comment_id"]} for row in rows)
        return results[:limit]

    def update_review(self, payload: dict[str, Any]) -> dict[str, Any]:
        target_type = text(payload.get("targetType"), 20)
        target_id = text(payload.get("targetId"), 256)
        status = text(payload.get("reviewStatus"), 40)
        allowed = {"pending_review", "pending_action", "in_progress", "resolved", "false_positive", "no_action_needed"}
        if target_type not in {"note", "comment"} or status not in allowed:
            raise ValueError("无效的复核操作")
        table, key = ("notes", "note_id") if target_type == "note" else ("comments", "comment_id")
        with self.lock, self._session() as db:
            manual_negative = int(bool(payload.get("manualNegative")))
            updated = db.execute(
                f"UPDATE {table} SET review_status=?,review_note=?,manual_negative=CASE WHEN ? THEN 1 ELSE manual_negative END WHERE {key}=?",
                (status, text(payload.get("note"), 2000), manual_negative, target_id),
            ).rowcount
        if not updated:
            raise ValueError("复核对象不存在")
        return {"ok": True, "targetType": target_type, "targetId": target_id, "reviewStatus": status}

    def clear_ai_history(self) -> dict[str, Any]:
        with self.lock, self._session() as db:
            count = int(db.execute("SELECT COUNT(*) FROM ai_analysis_records").fetchone()[0])
            db.execute("DELETE FROM ai_analysis_records")
        return {"ok": True, "deleted": count}

    def stats(self) -> dict[str, Any]:
        with self.lock, self._session() as db:
            total = int(db.execute("SELECT COUNT(*) FROM notes").fetchone()[0])
            relevant = int(db.execute("SELECT COUNT(*) FROM notes WHERE is_relevant = 1").fetchone()[0])
            rows = db.execute("SELECT status, COUNT(*) AS count FROM notes GROUP BY status").fetchall()
            latest = db.execute("SELECT MAX(last_seen_at) FROM notes").fetchone()[0]
            excel_existing = int(db.execute("SELECT COUNT(*) FROM notes WHERE source='existing_xlsx'").fetchone()[0])
            excel_missing = int(db.execute(
                "SELECT COUNT(*) FROM notes WHERE source<>'existing_xlsx' AND relevance_status='relevant' AND status<>'ignored'"
            ).fetchone()[0])
            pull_rows = db.execute(
                "SELECT pull_status, COUNT(*) AS count FROM notes WHERE source<>'existing_xlsx' GROUP BY pull_status"
            ).fetchall()
        by_status = {str(row["status"]): int(row["count"]) for row in rows}
        inbox = by_status.get("new", 0)
        archive = by_status.get("known", 0)
        monitored = by_status.get("confirmed", 0)
        ignored = by_status.get("ignored", 0)
        pull_by_status = {str(row["pull_status"]): int(row["count"]) for row in pull_rows}
        return {
            "ok": True,
            "version": VERSION,
            "total": total,
            "relevant": relevant,
            "byStatus": by_status,
            # A browser discovery is persisted so that it can be deduplicated,
            # analyzed and restored after a restart. It is not part of the
            # formal monitoring library until the user confirms it.
            "scope": {
                "inbox": inbox,
                "archive": archive,
                "monitored": monitored,
                "ignored": ignored,
                "libraryTotal": archive + monitored,
                "discoveryTotal": inbox + ignored,
                "recordTotal": total,
                "excelExisting": excel_existing,
                "excelMissing": excel_missing,
                "pullByStatus": pull_by_status,
            },
            "lastSeenAt": str(latest or ""),
            "db": str(self.db_path),
        }

    def list_notes(self, status: str = "", limit: int = 100) -> list[dict[str, Any]]:
        limit = max(1, min(int(limit or 100), 1000))
        with self.lock, self._session() as db:
            if status:
                rows = db.execute("SELECT * FROM notes WHERE status = ? ORDER BY first_seen_at DESC LIMIT ?", (status, limit)).fetchall()
            else:
                rows = db.execute("SELECT * FROM notes ORDER BY first_seen_at DESC LIMIT ?", (limit,)).fetchall()
        return [dict(row) for row in rows]

    @staticmethod
    def _excel_headers(worksheet: Any) -> dict[str, int]:
        return {
            str(cell.value).strip(): int(cell.column)
            for cell in worksheet[1]
            if cell.value is not None and str(cell.value).strip()
        }

    @staticmethod
    def _copy_excel_row_style(worksheet: Any, source_row: int, target_row: int) -> None:
        """Copy the previous data row's visual style to an appended row."""
        if source_row < 1 or source_row > worksheet.max_row or target_row == source_row:
            return
        for column in range(1, worksheet.max_column + 1):
            source = worksheet.cell(source_row, column)
            target = worksheet.cell(target_row, column)
            if source.has_style:
                target._style = copy(source._style)
            if source.number_format:
                target.number_format = source.number_format
            if source.alignment:
                target.alignment = copy(source.alignment)
            if source.protection:
                target.protection = copy(source.protection)
        source_height = worksheet.row_dimensions[source_row].height
        if source_height is not None:
            worksheet.row_dimensions[target_row].height = source_height

    @staticmethod
    def _extend_excel_tables(worksheet: Any, target_row: int) -> None:
        """Keep Excel table filters/styles covering newly appended rows."""
        from openpyxl.utils.cell import get_column_letter, range_boundaries

        for table in worksheet.tables.values():
            min_col, min_row, max_col, max_row = range_boundaries(table.ref)
            if target_row > max_row:
                table.ref = (
                    f"{get_column_letter(min_col)}{min_row}:"
                    f"{get_column_letter(max_col)}{target_row}"
                )

    @staticmethod
    def _excel_comment_id(note_id: str, item: dict[str, Any]) -> str:
        supplied = text(item.get("commentId"), 256)
        if supplied:
            return supplied
        identity = "\x1f".join((
            note_id,
            text(item.get("author"), 500),
            text(item.get("content"), 8000),
            text(item.get("publishedAt"), 100),
        ))
        return f"dom-{hashlib.sha256(identity.encode('utf-8')).hexdigest()[:32]}"

    def _resolve_pull_identity(self, note: dict[str, Any]) -> tuple[str, str]:
        """Resolve a pull to one canonical local note before any file is written.

        Exact note ID wins. If the ID only belongs to a transient DOM record,
        an already-synced Excel row with the same complete title+content wins so
        retries cannot create a second material folder, SQLite note, or Excel row.
        """
        incoming_id = valid_note_id(note.get("noteId"))
        if not incoming_id:
            raise ValueError("noteId is required")
        title_value, content_value, combined_value = identity_keys(note.get("title"), note.get("content"))
        with self.lock, self._session() as db:
            exact = db.execute(
                "SELECT note_id,source,pull_status FROM notes WHERE note_id=?",
                (incoming_id,),
            ).fetchone()
            if exact and (str(exact["source"]) == "existing_xlsx" or str(exact["pull_status"]) in {"synced", "partial"}):
                return incoming_id, "note_id"
            if combined_value:
                canonical = db.execute(
                    """SELECT note_id FROM notes
                       WHERE title_content_key=?
                         AND (source='existing_xlsx' OR pull_status IN ('synced','partial'))
                       ORDER BY CASE WHEN source='existing_xlsx' THEN 0 ELSE 1 END, first_seen_at
                       LIMIT 1""",
                    (combined_value,),
                ).fetchone()
                if canonical:
                    return str(canonical["note_id"]), "title_content"
            if exact:
                return incoming_id, "note_id"
        return incoming_id, "new"

    def _media_root(self) -> Path:
        xlsx_path = getattr(self, "seed_xlsx_path", None)
        if xlsx_path:
            return Path(xlsx_path).expanduser().resolve().parent / "posts_materials"
        return self.export_dir / "posts_materials"

    @staticmethod
    def _safe_media_folder_name(note: dict[str, Any]) -> str:
        note_id = valid_note_id(note.get("noteId")) or "unknown-note"
        title = canonical_note_title(note.get("title"), note.get("content"), 80)
        title = re.sub(r'[<>:"/\\|?*\x00-\x1f]+', "_", title).strip(" .")
        title = re.sub(r"\s+", " ", title)[:80].strip(" .") or "未命名帖子"
        return f"{title}__{note_id}"

    def _resolve_media_folder(self, note: dict[str, Any]) -> Path:
        """Reuse or rename the folder already associated with this note ID.

        A title can be improved after a deep read. Resolving by note ID before
        creating the title-based folder prevents the corrected title from
        producing a second material directory for the same note.
        """
        root = self._media_root()
        root.mkdir(parents=True, exist_ok=True)
        target = root / self._safe_media_folder_name(note)
        if target.is_dir():
            return target

        note_id = valid_note_id(note.get("noteId"))
        if not note_id:
            return target
        suffix = f"__{note_id}"
        try:
            candidates = [path for path in root.iterdir() if path.is_dir() and path.name.endswith(suffix)]
        except OSError:
            return target
        if len(candidates) == 1:
            candidate = candidates[0]
            try:
                candidate.rename(target)
                return target
            except OSError:
                return target if target.is_dir() else candidate
        if candidates:
            def modified_at(path: Path) -> float:
                try:
                    return path.stat().st_mtime
                except OSError:
                    return 0.0
            return max(candidates, key=modified_at)
        return target

    @staticmethod
    def _media_extension(url: str, content_type: str = "") -> str:
        suffix = Path(urlparse(url).path).suffix.lower()
        if suffix in {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".avif"}:
            return ".jpg" if suffix == ".jpe" else suffix
        guessed = mimetypes.guess_extension((content_type or "").split(";", 1)[0].strip().lower()) or ".jpg"
        if guessed == ".jpe":
            guessed = ".jpg"
        return guessed if guessed in {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".avif"} else ".jpg"

    def _download_note_media(self, note: dict[str, Any]) -> dict[str, Any]:
        """Save DOM-exposed images and a local text snapshot beside the master Excel.

        SQLite stores the material directory and status; binary media stays on
        disk so the database remains small and can be backed up normally.
        """
        note_id = valid_note_id(note.get("noteId"))
        if not note_id:
            raise ValueError("noteId is required")
        folder = self._resolve_media_folder(note)
        folder.mkdir(parents=True, exist_ok=True)
        files: list[str] = []
        errors: list[str] = []
        image_urls = []
        for value in note.get("imageUrls") or []:
            raw = text(value, 4000)
            if not raw or raw in image_urls:
                continue
            image_urls.append(raw)
        image_urls = image_urls[:32]

        def download_one(index: int, image_url: str) -> tuple[int, str, str]:
            temporary: Path | None = None
            try:
                parsed = urlparse(image_url)
                if parsed.scheme not in {"http", "https"}:
                    raise ValueError("图片链接不是 http(s)")
                request = Request(
                    image_url,
                    headers={
                        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
                        "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
                        "Referer": "https://www.xiaohongshu.com/",
                        "Origin": "https://www.xiaohongshu.com",
                    },
                )
                target = folder / f"image-{index:02d}{self._media_extension(image_url)}"
                temporary = target.with_name(f".{target.name}.part")
                total = 0
                # A bad CDN URL must not block the complete pull workflow. Six
                # seconds is long enough for normal images while keeping a
                # six-worker batch bounded even when several URLs have expired.
                with urlopen(request, timeout=6) as response, temporary.open("wb") as output:
                    while True:
                        chunk = response.read(1024 * 256)
                        if not chunk:
                            break
                        total += len(chunk)
                        if total > 25 * 1024 * 1024:
                            raise ValueError("图片超过 25MB 限制")
                        output.write(chunk)
                    if total <= 0:
                        raise ValueError("图片响应为空")
                    extension = self._media_extension(image_url, response.headers.get("Content-Type", ""))
                if target.suffix.lower() != extension:
                    renamed = target.with_suffix(extension)
                    os.replace(temporary, renamed)
                    target = renamed
                else:
                    os.replace(temporary, target)
                return index, target.name, ""
            except Exception as exc:
                try:
                    if temporary is not None:
                        temporary.unlink(missing_ok=True)
                except OSError:
                    pass
                return index, "", f"图片{index}: {text(exc, 300)}"

        download_results: list[tuple[int, str, str]] = []
        if image_urls:
            worker_count = min(6, len(image_urls))
            with ThreadPoolExecutor(max_workers=worker_count, thread_name_prefix="xhs-media") as executor:
                futures = [
                    executor.submit(download_one, index, image_url)
                    for index, image_url in enumerate(image_urls, 1)
                ]
                for future in as_completed(futures):
                    download_results.append(future.result())

        for _index, filename, error in sorted(download_results, key=lambda item: item[0]):
            if filename:
                files.append(filename)
            if error:
                errors.append(error)

        metadata = {
            "noteId": note_id,
            "url": text(note.get("url"), 2000),
            "title": canonical_note_title(note.get("title"), note.get("content"), 80),
            "content": text(note.get("content"), 12000),
            "tags": note.get("tags") or [],
            "imageUrls": image_urls,
            "pulledAt": now_iso(),
        }
        (folder / "note.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
        files.append("note.json")
        text_snapshot = "\n".join((
            canonical_note_title(note.get("title"), note.get("content"), 80),
            "",
            text(note.get("content"), 12000),
            "",
            f"来源链接：{text(note.get('url'), 2000)}",
        ))
        (folder / "帖子正文.txt").write_text(text_snapshot, encoding="utf-8")
        files.append("帖子正文.txt")
        status = "complete" if not errors else "partial"
        return {
            "status": status,
            "folder": str(folder),
            "files": files,
            "imageCount": len([name for name in files if name.startswith("image-")]),
            "fileCount": len(files),
            "error": "；".join(errors),
        }

    @staticmethod
    def _write_media_comments(media_result: dict[str, Any], comments: list[dict[str, Any]]) -> None:
        folder = text(media_result.get("folder"), 4000)
        if not folder:
            return
        path = Path(folder) / "comments.json"
        path.write_text(json.dumps(comments, ensure_ascii=False, indent=2), encoding="utf-8")
        files = list(media_result.get("files") or [])
        if path.name not in files:
            files.append(path.name)
        media_result["files"] = files
        media_result["fileCount"] = len(files)

    def _sync_pull_to_xlsx(
        self,
        note: dict[str, Any],
        comments: list[dict[str, Any]],
        media_result: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Append one fully read note and its comments to the configured Excel.

        This operation is deliberately idempotent. A retry updates the same
        note row and ignores comments already present by comment ID or stable
        author/content/time identity. The original workbook is replaced only
        after a complete temporary save succeeds.
        """
        xlsx_path = getattr(self, "seed_xlsx_path", None)
        if not xlsx_path:
            raise ValueError("未配置 Excel 总表路径")
        xlsx_path = Path(xlsx_path)
        if not xlsx_path.exists():
            self._ensure_seed_workbook(xlsx_path)

        from openpyxl import load_workbook

        media_result = media_result or {}
        media_folder = text(media_result.get("folder"), 4000)
        media_files = "\n".join(text(item, 300) for item in (media_result.get("files") or []) if text(item, 300))

        workbook = None
        temporary_path: Path | None = None
        try:
            workbook = load_workbook(xlsx_path)
            if "sheet1_笔记总表" not in workbook.sheetnames:
                raise ValueError("Excel 总表缺少 sheet1_笔记总表")
            if "sheet2_评论总表" not in workbook.sheetnames:
                raise ValueError("Excel 总表缺少 sheet2_评论总表")

            note_sheet = workbook["sheet1_笔记总表"]
            comment_sheet = workbook["sheet2_评论总表"]
            note_headers = self._excel_headers(note_sheet)
            comment_headers = self._excel_headers(comment_sheet)
            if "笔记ID" not in note_headers:
                raise ValueError("Excel 总表缺少 sheet1 的笔记ID列")
            if "笔记评论ID" not in comment_headers:
                raise ValueError("Excel 总表缺少 sheet2 的笔记评论ID列")

            note_id = valid_note_id(note.get("noteId"))
            if not note_id:
                raise ValueError("noteId is required")
            note_id_column = note_headers["笔记ID"]
            existing_note_row = None
            matched_by = "new"
            for row_number in range(2, note_sheet.max_row + 1):
                if valid_note_id(note_sheet.cell(row_number, note_id_column).value) == note_id:
                    existing_note_row = row_number
                    matched_by = "note_id"
                    break
            # Defensive Excel-side fallback for legacy rows whose note ID was
            # missing or changed, but whose fully-read title and body are equal.
            if existing_note_row is None:
                incoming_title, incoming_content, incoming_combined = identity_keys(
                    note.get("title"), note.get("content")
                )
                if incoming_combined:
                    title_column = note_headers.get("笔记标题")
                    content_column = note_headers.get("笔记内容")
                    if title_column and content_column:
                        for row_number in range(2, note_sheet.max_row + 1):
                            _, _, row_combined = identity_keys(
                                note_sheet.cell(row_number, title_column).value,
                                note_sheet.cell(row_number, content_column).value,
                            )
                            if row_combined == incoming_combined:
                                existing_note_row = row_number
                                matched_by = "title_content"
                                stored_id = valid_note_id(note_sheet.cell(row_number, note_id_column).value)
                                if stored_id:
                                    note_id = stored_id
                                break
            is_new_note = existing_note_row is None
            note_row = existing_note_row or max(2, note_sheet.max_row + 1)
            if is_new_note:
                self._copy_excel_row_style(note_sheet, max(2, note_sheet.max_row), note_row)

            def current_note_value(name: str) -> str:
                column = note_headers.get(name)
                return text(note_sheet.cell(note_row, column).value) if column else ""

            def set_note_value(name: str, value: Any) -> None:
                column = note_headers.get(name)
                if not column:
                    return
                if value not in (None, "") or is_new_note:
                    note_sheet.cell(note_row, column).value = value

            note_url = preferred_url(current_note_value("笔记url"), note.get("url"))
            note_tags = tag_text(note.get("tags")) or ("无话题" if note.get("detailRead") else "")
            note_fields = {
                "笔记url": note_url,
                "用户主页url": text(note.get("authorUrl"), 2000),
                "用户昵称": text(note.get("author"), 500),
                "笔记标题": canonical_note_title(note.get("title"), note.get("content"), 80),
                "笔记内容": text(note.get("content"), 12000),
                "笔记话题": note_tags,
                "点赞量": note.get("likeCount", ""),
                "收藏量": note.get("collectCount", ""),
                "评论量": note.get("commentCount", ""),
                "分享量": note.get("shareCount", ""),
                "发布时间": text(note.get("publishedAt"), 100),
                "更新时间": text(note.get("updatedAt"), 100),
                "IP地址": text(note.get("ipLocation"), 100),
                "图片数量": note.get("imageCount", len(note.get("imageUrls") or [])),
                "发布日期": text(note.get("publishedAt"), 100)[:10],
                "来源词": text(note.get("keyword"), 200),
                "笔记ID": note_id,
                "博主ID": text(note.get("authorId"), 256),
                "对应帖子文件夹地址": media_folder,
                "文件夹内清单": media_files,
                "AI情绪判断": text(note.get("postSentiment"), 80),
                "帖子好坏": text(note.get("postSentiment"), 80),
            }
            for name, value in note_fields.items():
                set_note_value(name, value)
            self._extend_excel_tables(note_sheet, note_row)

            comment_id_column = comment_headers["笔记评论ID"]
            existing_comment_rows_by_id: dict[str, int] = {}
            existing_comment_rows_by_key: dict[tuple[str, str, str, str], int] = {}
            existing_comment_rows_by_loose_key: dict[tuple[str, str, str], int] = {}
            for row_number in range(2, comment_sheet.max_row + 1):
                row_id = text(comment_sheet.cell(row_number, comment_id_column).value, 256)
                if row_id:
                    existing_comment_rows_by_id[row_id] = row_number
                author_column = comment_headers.get("用户昵称")
                content_column = comment_headers.get("评论内容")
                time_column = comment_headers.get("评论时间")
                row_key = (
                    note_url_identity(comment_sheet.cell(row_number, comment_headers.get("原笔记url")).value)
                    if comment_headers.get("原笔记url") else "",
                    text(comment_sheet.cell(row_number, author_column).value, 500) if author_column else "",
                    text(comment_sheet.cell(row_number, content_column).value, 8000) if content_column else "",
                    text(comment_sheet.cell(row_number, time_column).value, 100) if time_column else "",
                )
                if any(row_key):
                    existing_comment_rows_by_key[row_key] = row_number
                    existing_comment_rows_by_loose_key[(row_key[0], row_key[1], row_key[2])] = row_number

            inserted_comments = 0
            duplicate_comments = 0
            for item in comments:
                if not isinstance(item, dict) or not text(item.get("content"), 8000):
                    continue
                generated_id = self._excel_comment_id(note_id, item)
                comment_key = (
                    note_url_identity(note_url) or note_id,
                    text(item.get("author"), 500),
                    text(item.get("content"), 8000),
                    text(item.get("publishedAt"), 100),
                )
                row_number = existing_comment_rows_by_id.get(generated_id)
                if row_number is None:
                    row_number = existing_comment_rows_by_key.get(comment_key)
                # Older workbooks often have blank comment IDs or omit a
                # timestamp. Note + author + exact content remains a stable,
                # scoped fallback and prevents a retry from duplicating them.
                if row_number is None:
                    row_number = existing_comment_rows_by_loose_key.get(comment_key[:3])
                is_new_comment = row_number is None
                if is_new_comment:
                    row_number = max(2, comment_sheet.max_row + 1)
                    self._copy_excel_row_style(comment_sheet, max(2, comment_sheet.max_row), row_number)
                level = max(1, min(int(item.get("commentLevel") or 1), 3))
                comment_fields = {
                    "原笔记url": note_url,
                    "帖子用户主页url": text(note.get("authorUrl"), 2000),
                    "笔记评论ID": generated_id,
                    "用户昵称": text(item.get("author"), 500),
                    "评论内容": text(item.get("content"), 8000),
                    "评论时间": text(item.get("publishedAt"), 100),
                    "是否帖主评论": "是" if bool_value(item.get("isAuthor")) else "否",
                    "点赞量": item.get("likeCount", 0),
                    "评论层级": f"{level}级评论",
                    "父评论ID": text(item.get("parentCommentId"), 256),
                    "对应帖子文件夹地址": media_folder,
                    "文件夹内清单": media_files,
                    "AI情绪判断": text(item.get("sentiment"), 80),
                }
                for name, value in comment_fields.items():
                    column = comment_headers.get(name)
                    if column:
                        comment_sheet.cell(row_number, column).value = value
                existing_comment_rows_by_id[generated_id] = row_number
                existing_comment_rows_by_key[comment_key] = row_number
                existing_comment_rows_by_loose_key[comment_key[:3]] = row_number
                if is_new_comment:
                    inserted_comments += 1
                else:
                    duplicate_comments += 1
                self._extend_excel_tables(comment_sheet, row_number)

            temporary_path = xlsx_path.with_name(
                f".{xlsx_path.stem}.xhs-sync-{datetime.now().strftime('%Y%m%d%H%M%S%f')}.tmp.xlsx"
            )
            workbook.save(temporary_path)
            workbook.close()
            workbook = None
            try:
                os.replace(temporary_path, xlsx_path)
            except PermissionError as exc:
                raise ValueError(
                    "Excel 总表正被占用（可能已在 Excel 中打开），写入被拒绝。"
                    "请关闭该文件后重试；数据已在本地保存，不会丢失。"
                ) from exc
            temporary_path = None
            return {
                "ok": True,
                "path": str(xlsx_path),
                "postAdded": int(is_new_note),
                "commentAdded": inserted_comments,
                "commentSkipped": duplicate_comments,
                "deduplicated": (not is_new_note) or duplicate_comments > 0,
                "matchedBy": matched_by,
                "noteRow": note_row,
            }
        finally:
            if workbook is not None:
                workbook.close()
            if temporary_path and temporary_path.exists():
                try:
                    temporary_path.unlink()
                except OSError:
                    pass

    def _ensure_seed_workbook(self, xlsx_path: Path) -> None:
        """Excel 总表不存在时，自动初始化含两张标准工作表的空表（新用户开箱即用）。"""
        if xlsx_path.exists():
            return
        from openpyxl import Workbook

        note_headers = [
            "笔记url", "用户主页url", "用户昵称", "笔记标题", "笔记内容", "笔记话题",
            "点赞量", "收藏量", "评论量", "分享量", "发布时间", "更新时间", "IP地址",
            "图片数量", "发布日期", "来源词", "笔记ID", "博主ID",
            "对应帖子文件夹地址", "文件夹内清单", "AI情绪判断", "帖子好坏",
        ]
        comment_headers = [
            "原笔记url", "帖子用户主页url", "笔记评论ID", "用户昵称", "评论内容",
            "评论时间", "是否帖主评论", "点赞量", "评论层级", "父评论ID",
            "对应帖子文件夹地址", "文件夹内清单", "AI情绪判断",
        ]
        xlsx_path.parent.mkdir(parents=True, exist_ok=True)
        workbook = Workbook()
        note_sheet = workbook.active
        note_sheet.title = "sheet1_笔记总表"
        note_sheet.append(note_headers)
        comment_sheet = workbook.create_sheet("sheet2_评论总表")
        comment_sheet.append(comment_headers)
        irrelevant_sheet = workbook.create_sheet("sheet3_不相关帖子")
        irrelevant_sheet.append(["笔记url", "用户主页url", "用户昵称", "笔记标题", "笔记内容", "笔记话题",
                                 "发布时间", "来源词", "笔记ID", "博主ID", "评论数量", "相关性状态",
                                 "AI判断来源", "AI置信度", "AI判断理由", "分析时间", "评论内容汇总"])
        workbook.save(xlsx_path)
        workbook.close()
        print(f"[bridge] 已自动创建 Excel 总表：{xlsx_path}")

    def delete_pulled_note(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Physically remove one pulled note from Excel, SQLite and its media folder."""
        note_id = valid_note_id(payload.get("noteId"))
        if not note_id:
            raise ValueError("noteId is required")
        xlsx_path = getattr(self, "seed_xlsx_path", None)
        if not xlsx_path:
            raise ValueError("未配置 Excel 总表路径")
        xlsx_path = Path(xlsx_path)
        if not xlsx_path.exists():
            raise ValueError("Excel 总表不存在")

        from openpyxl import load_workbook
        from openpyxl.utils.cell import get_column_letter, range_boundaries

        with self.pull_lock:
            with self.lock, self._session() as db:
                note_row = db.execute(
                    "SELECT note_id,media_dir FROM notes WHERE note_id=?", (note_id,)
                ).fetchone()
                comment_ids = [str(row[0]) for row in db.execute(
                    "SELECT comment_id FROM comments WHERE note_id=?", (note_id,)
                ).fetchall()]
            if note_row is None:
                raise ValueError("本地数据库中未找到该帖子")

            media_dir = Path(text(note_row["media_dir"], 4000)).expanduser() if text(note_row["media_dir"], 4000) else None
            media_root = self._media_root().resolve()
            managed_media_dirs: list[Path] = []
            if media_dir and media_dir.exists():
                resolved_media = media_dir.resolve()
                if resolved_media.parent != media_root:
                    raise ValueError("素材目录不在受管 posts_materials 目录内，已停止删除")
                managed_media_dirs.append(resolved_media)
            # Include stale title-based folders left by older releases. The
            # exact note-ID suffix keeps this scoped to the same logical note.
            if media_root.exists():
                suffix = f"__{note_id}"
                for candidate in media_root.iterdir():
                    if candidate.is_dir() and candidate.name.endswith(suffix):
                        resolved_candidate = candidate.resolve()
                        if resolved_candidate not in managed_media_dirs:
                            managed_media_dirs.append(resolved_candidate)

            tombstones: list[tuple[Path, Path]] = []
            for index, resolved_media in enumerate(managed_media_dirs, 1):
                tombstone = resolved_media.with_name(
                    f".{resolved_media.name}.deleting-{os.getpid()}-{time.time_ns()}-{index}"
                )
                resolved_media.rename(tombstone)
                tombstones.append((resolved_media, tombstone))
            workbook = None
            temporary_path: Path | None = None
            backup_path: Path | None = None
            deleted_note_rows = 0
            deleted_comment_rows = 0
            logical_delete_committed = False
            media_deleted = False
            media_cleanup_warning = ""
            try:
                workbook = load_workbook(xlsx_path)
                if "sheet1_笔记总表" not in workbook.sheetnames or "sheet2_评论总表" not in workbook.sheetnames:
                    raise ValueError("Excel 总表缺少笔记或评论工作表")
                note_sheet = workbook["sheet1_笔记总表"]
                comment_sheet = workbook["sheet2_评论总表"]
                note_headers = self._excel_headers(note_sheet)
                comment_headers = self._excel_headers(comment_sheet)
                note_id_column = note_headers.get("笔记ID")
                comment_id_column = comment_headers.get("笔记评论ID")
                comment_url_column = comment_headers.get("原笔记url")
                if not note_id_column or not comment_id_column:
                    raise ValueError("Excel 总表缺少帖子或评论 ID 列")

                for row_number in range(note_sheet.max_row, 1, -1):
                    if valid_note_id(note_sheet.cell(row_number, note_id_column).value) == note_id:
                        note_sheet.delete_rows(row_number, 1)
                        deleted_note_rows += 1

                comment_id_set = set(comment_ids)
                for row_number in range(comment_sheet.max_row, 1, -1):
                    row_comment_id = text(comment_sheet.cell(row_number, comment_id_column).value, 256)
                    url_identity = note_url_identity(comment_sheet.cell(row_number, comment_url_column).value) if comment_url_column else ""
                    if row_comment_id in comment_id_set or url_identity == note_id:
                        comment_sheet.delete_rows(row_number, 1)
                        deleted_comment_rows += 1

                for sheet in (note_sheet, comment_sheet):
                    for table in sheet.tables.values():
                        min_col, min_row, max_col, _max_row = range_boundaries(table.ref)
                        table.ref = f"{get_column_letter(min_col)}{min_row}:{get_column_letter(max_col)}{max(min_row, sheet.max_row)}"

                temporary_path = xlsx_path.with_name(
                    f".{xlsx_path.stem}.delete-{datetime.now().strftime('%Y%m%d%H%M%S%f')}.tmp.xlsx"
                )
                workbook.save(temporary_path)
                workbook.close()
                workbook = None
                try:
                    backup_path = xlsx_path.with_name(
                        f".{xlsx_path.stem}.delete-backup-{os.getpid()}-{time.time_ns()}.xlsx"
                    )
                    shutil.copy2(xlsx_path, backup_path)
                    os.replace(temporary_path, xlsx_path)
                except PermissionError as exc:
                    raise ValueError("Excel 总表正被占用，请关闭 Excel 后重试删除") from exc
                temporary_path = None

                with self.lock, self._session() as db:
                    if comment_ids:
                        placeholders = ",".join("?" for _ in comment_ids)
                        db.execute(f"DELETE FROM ai_jobs WHERE target_type='comment' AND target_id IN ({placeholders})", comment_ids)
                        db.execute(f"DELETE FROM ai_analysis_records WHERE target_type='comment' AND target_id IN ({placeholders})", comment_ids)
                    db.execute("DELETE FROM ai_jobs WHERE target_type='note' AND target_id=?", (note_id,))
                    db.execute("DELETE FROM ai_analysis_records WHERE target_type='note' AND target_id=?", (note_id,))
                    db.execute("DELETE FROM comment_collection_jobs WHERE note_id=?", (note_id,))
                    db.execute("DELETE FROM comments WHERE note_id=?", (note_id,))
                    db.execute("DELETE FROM notes WHERE note_id=?", (note_id,))

                logical_delete_committed = True
                cleanup_errors: list[str] = []
                for _original_media, tombstone in tombstones:
                    if not tombstone.exists():
                        continue
                    try:
                        shutil.rmtree(tombstone)
                    except OSError as exc:
                        cleanup_errors.append(f"{tombstone.name}: {text(exc, 220)}")
                media_deleted = bool(tombstones) and not cleanup_errors
                if cleanup_errors:
                    # Excel and SQLite have already committed. Restoring only
                    # Excel here would split the sources of truth; keep hidden
                    # tombstones for a later cleanup and report every failure.
                    media_cleanup_warning = "素材目录已移出但清理失败：" + "；".join(cleanup_errors)
                if backup_path and backup_path.exists():
                    backup_path.unlink()
                return {
                    "ok": True, "noteId": note_id, "excelPath": str(xlsx_path),
                    "deletedNoteRows": deleted_note_rows,
                    "deletedCommentRows": deleted_comment_rows,
                    "deletedDatabaseComments": len(comment_ids),
                    "mediaDeleted": media_deleted,
                    "mediaCleanupWarning": media_cleanup_warning,
                    "mediaTombstone": ";".join(str(path) for _original, path in tombstones if path.exists()),
                }
            except Exception:
                if not logical_delete_committed:
                    if backup_path and backup_path.exists():
                        os.replace(backup_path, xlsx_path)
                    for original_media, tombstone in reversed(tombstones):
                        if tombstone.exists() and not original_media.exists():
                            tombstone.rename(original_media)
                raise
            finally:
                if workbook is not None:
                    workbook.close()
                if temporary_path and temporary_path.exists():
                    temporary_path.unlink(missing_ok=True)
                if backup_path and backup_path.exists():
                    backup_path.unlink(missing_ok=True)

    def _sync_ai_result_to_xlsx(self, target_type: str, target_id: str, result: dict[str, Any]) -> None:
        """Write completed AI sentiment back to the matching Excel row."""
        xlsx_path = getattr(self, "seed_xlsx_path", None)
        if not xlsx_path or not Path(xlsx_path).is_file():
            return
        from openpyxl import load_workbook

        xlsx_path = Path(xlsx_path)
        sheet_name = "sheet1_笔记总表" if target_type == "note" else "sheet2_评论总表"
        id_header = "笔记ID" if target_type == "note" else "笔记评论ID"
        temporary_path: Path | None = None
        with self.lock:
            workbook = load_workbook(xlsx_path)
            try:
                if sheet_name not in workbook.sheetnames:
                    return
                sheet = workbook[sheet_name]
                headers = self._excel_headers(sheet)
                id_column = headers.get(id_header)
                sentiment_column = headers.get("AI情绪判断")
                post_quality_column = headers.get("帖子好坏") if target_type == "note" else None
                if not id_column or not sentiment_column:
                    return
                row_number = next(
                    (number for number in range(2, sheet.max_row + 1)
                     if text(sheet.cell(number, id_column).value, 256) == target_id),
                    0,
                )
                if not row_number:
                    return
                label = sentiment_label(result.get("sentiment"))
                sheet.cell(row_number, sentiment_column).value = label
                if post_quality_column:
                    sheet.cell(row_number, post_quality_column).value = label
                temporary_path = xlsx_path.with_name(
                    f".{xlsx_path.stem}.xhs-ai-{datetime.now().strftime('%Y%m%d%H%M%S%f')}.tmp.xlsx"
                )
                workbook.save(temporary_path)
            finally:
                workbook.close()
            if temporary_path and temporary_path.exists():
                try:
                    os.replace(temporary_path, xlsx_path)
                except PermissionError:
                    print(f"[bridge] Excel 总表被占用，AI 情绪回写跳过：{xlsx_path}", flush=True)

    def pull_to_excel(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Serialize and deduplicate one complete pull transaction."""
        with self.pull_lock:
            return self._pull_to_excel_locked(payload)

    def _pull_to_excel_locked(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Persist a completed browser read and make it visible in Excel."""
        raw_note = payload.get("note") if isinstance(payload.get("note"), dict) else payload
        note = dict(raw_note or {})
        incoming_note_id = valid_note_id(note.get("noteId"))
        if not incoming_note_id:
            raise ValueError("noteId is required")
        note["title"] = canonical_note_title(note.get("title"), note.get("content"), 80)
        note_id, prewrite_matched_by = self._resolve_pull_identity(note)
        note["noteId"] = note_id
        comments = payload.get("comments") or []
        if not isinstance(comments, list):
            raise ValueError("comments must be an array")
        comment_status = text(payload.get("commentStatus"), 30) or "partial"
        if comment_status not in {"partial", "likely_complete", "failed"}:
            comment_status = "partial"
        expected_count = int(payload.get("expectedCount") or 0)
        comment_error = text(payload.get("commentError"), 1000)
        media_result: dict[str, Any] = {
            "status": "failed",
            "folder": "",
            "files": [],
            "fileCount": 0,
            "imageCount": 0,
            "error": "素材尚未下载",
        }
        try:
            self.confirm(note)
            comment_result = self.upsert_comments({
                "noteId": note_id,
                "comments": comments,
                "expectedCount": expected_count,
                "status": "failed" if comment_status == "failed" else comment_status,
                "error": comment_error,
                "collectedAt": text(payload.get("collectedAt"), 80) or now_iso(),
                "forceAutoAnalyze": True,
            })
            try:
                media_result = self._download_note_media(note)
                self._write_media_comments(media_result, comments)
            except Exception as exc:
                media_result = {
                    "status": "failed",
                    "folder": "",
                    "files": [],
                    "fileCount": 0,
                    "imageCount": 0,
                    "error": text(exc, 1000),
                }
            settings = self.ai_settings.get(False)
            with self.lock, self._session() as db:
                existing_analysis = db.execute(
                    "SELECT ai_analysis_status,post_sentiment FROM notes WHERE note_id=?",
                    (note_id,),
                ).fetchone()
            if existing_analysis and existing_analysis["post_sentiment"]:
                note["postSentiment"] = sentiment_label(existing_analysis["post_sentiment"])
            elif settings.get("configured"):
                note["postSentiment"] = "AI排队中"
            else:
                note["postSentiment"] = "AI未配置"
            xlsx_result = self._sync_pull_to_xlsx(note, comments, media_result)
        except Exception as exc:
            with self.lock, self._session() as db:
                db.execute(
                    """UPDATE notes SET pull_status='failed', pull_error=?, last_pull_at=?,
                       media_status=?, media_dir=?, media_file_count=?, media_error=?
                       WHERE note_id=?""",
                    (
                        text(exc, 1000), now_iso(), media_result.get("status", "failed"),
                        media_result.get("folder", ""), int(media_result.get("fileCount", 0) or 0),
                        media_result.get("error", ""), note_id,
                    ),
                )
            raise

        timestamp = now_iso()
        partial = comment_status in {"partial", "failed"} or media_result.get("status") != "complete"
        final_status = "partial" if partial else "synced"
        errors = [item for item in (comment_error, text(media_result.get("error"), 1000)) if item]
        final_error = "；".join(errors) if partial else ""
        with self.lock, self._session() as db:
            db.execute(
                """UPDATE notes SET status='known', is_relevant=1, source='existing_xlsx', relevance_status='relevant', relevance_source='pull',
                   pull_status=?, pull_error=?, last_pull_at=?, excel_synced_at=?,
                   excel_sync_path=?, media_status=?, media_dir=?, media_file_count=?, media_error=?
                   WHERE note_id=?""",
                (
                    final_status, final_error, timestamp, timestamp, xlsx_result["path"],
                    media_result.get("status", "failed"), media_result.get("folder", ""),
                    int(media_result.get("fileCount", 0) or 0), text(media_result.get("error"), 1000), note_id,
                ),
            )
        ai_status = "not_configured"
        if settings.get("configured") and settings.get("auto_analyze_posts"):
            ai_result = self.enqueue_ai("note", note_id, priority=10, force=True)
            ai_status = text(ai_result.get("status"), 30) or "queued"
        elif settings.get("configured"):
            ai_status = "manual"
        return {
            "ok": True,
            "noteId": note_id,
            "incomingNoteId": incoming_note_id,
            "status": "known",
            "pullStatus": final_status,
            "commentStatus": comment_status,
            "commentError": comment_error,
            "postAdded": xlsx_result["postAdded"],
            "commentAdded": xlsx_result["commentAdded"],
            "commentSkipped": int(xlsx_result.get("commentSkipped", 0) or 0),
            "deduplicated": bool(
                prewrite_matched_by != "new" or xlsx_result.get("deduplicated")
            ),
            "matchedBy": (
                prewrite_matched_by if prewrite_matched_by != "new"
                else text(xlsx_result.get("matchedBy"), 40) or "new"
            ),
            "commentCount": comment_result["collectedCount"],
            "excelPath": xlsx_result["path"],
            "excelRow": int(xlsx_result.get("noteRow", 0) or 0),
            "mediaStatus": media_result.get("status", "failed"),
            "mediaCount": int(media_result.get("imageCount", 0) or 0),
            "mediaFileCount": int(media_result.get("fileCount", 0) or 0),
            "mediaDir": media_result.get("folder", ""),
            "mediaFiles": media_result.get("files", []) or [],
            "mediaError": media_result.get("error", ""),
            "pullError": final_error,
            "aiStatus": ai_status,
        }

    def open_local_artifact(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Open a verified local artifact without accepting arbitrary paths."""
        kind = text(payload.get("kind"), 20)
        note_id = valid_note_id(payload.get("noteId"))
        if not note_id:
            raise ValueError("noteId is required")

        if kind in {"folder", "image"}:
            with self.lock, self._session() as db:
                row = db.execute(
                    "SELECT media_dir FROM notes WHERE note_id=?",
                    (note_id,),
                ).fetchone()
            if row is None or not text(row["media_dir"], 4000):
                raise ValueError("该帖子的素材目录尚未生成")
            media_root = self._media_root().resolve()
            folder = Path(str(row["media_dir"])).resolve()
            if folder != media_root and media_root not in folder.parents:
                raise ValueError("素材目录不在允许范围内")
            if not folder.is_dir():
                raise ValueError("素材目录不存在")
            target = folder
            if kind == "image":
                requested_name = Path(text(payload.get("fileName"), 500)).name
                candidate = (folder / requested_name).resolve() if requested_name else None
                if candidate is None or candidate.parent != folder or not candidate.is_file():
                    candidate = next((item for item in sorted(folder.glob("image-*")) if item.is_file()), None)
                if candidate is None:
                    raise ValueError("素材目录中没有可打开的图片")
                target = candidate
            os.startfile(str(target))  # type: ignore[attr-defined]
            return {"ok": True, "kind": kind, "target": str(target)}

        if kind != "excel":
            raise ValueError("不支持的打开类型")
        xlsx_path = getattr(self, "seed_xlsx_path", None)
        if not xlsx_path:
            raise ValueError("尚未配置 Excel 总表")
        xlsx_path = Path(xlsx_path).resolve()
        if not xlsx_path.is_file():
            self._ensure_seed_workbook(xlsx_path)

        with self.lock, self._session() as db:
            analysis = db.execute(
                "SELECT ai_analysis_status,post_sentiment FROM notes WHERE note_id=?",
                (note_id,),
            ).fetchone()
        if analysis and analysis["ai_analysis_status"] == "completed" and analysis["post_sentiment"]:
            self._sync_ai_result_to_xlsx("note", note_id, {"sentiment": analysis["post_sentiment"]})

        from openpyxl import load_workbook

        workbook = load_workbook(xlsx_path, read_only=True, data_only=True)
        try:
            sheet_name = "sheet1_笔记总表" if "sheet1_笔记总表" in workbook.sheetnames else workbook.sheetnames[0]
            worksheet = workbook[sheet_name]
            headers = self._excel_headers(worksheet)
            note_column = headers.get("笔记ID")
            if not note_column:
                raise ValueError("Excel 帖子总表缺少笔记ID列")
            excel_row = 0
            requested_row = max(0, int(payload.get("excelRow") or 0))
            if requested_row >= 2 and text(worksheet.cell(requested_row, note_column).value, 128) == note_id:
                excel_row = requested_row
            if not excel_row:
                for row_number in range(2, worksheet.max_row + 1):
                    if text(worksheet.cell(row_number, note_column).value, 128) == note_id:
                        excel_row = row_number
                        break
            if not excel_row:
                raise ValueError("Excel 中尚未找到该帖子")
            field_name = text(payload.get("fieldName"), 100)
            excel_column = headers.get(field_name, note_column)
        finally:
            workbook.close()

        def ps_quote(value: str) -> str:
            return value.replace("'", "''")

        script = f"""
$ErrorActionPreference = 'Stop'
$path = [System.IO.Path]::GetFullPath('{ps_quote(str(xlsx_path))}')
try {{ $excel = [Runtime.InteropServices.Marshal]::GetActiveObject('Excel.Application') }}
catch {{ $excel = New-Object -ComObject Excel.Application }}
$book = $null
foreach ($candidate in $excel.Workbooks) {{
  if ([System.String]::Equals([System.IO.Path]::GetFullPath($candidate.FullName), $path, [System.StringComparison]::OrdinalIgnoreCase)) {{ $book = $candidate; break }}
}}
if ($null -eq $book) {{ $book = $excel.Workbooks.Open($path) }}
$excel.Visible = $true
$excel.WindowState = -4143
$book.Activate()
$sheet = $book.Worksheets.Item('{ps_quote(sheet_name)}')
$sheet.Activate()
$cell = $sheet.Cells.Item({excel_row}, {excel_column})
$cell.Select()
$excel.Goto($cell, $true)
$excel.UserControl = $true
Write-Output 'OK'
"""
        encoded = base64.b64encode(script.encode("utf-16le")).decode("ascii")
        try:
            completed = subprocess.run(
            ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-EncodedCommand", encoded],
            cwd=str(xlsx_path.parent),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            timeout=25,
            check=False,
            )
        except subprocess.TimeoutExpired as error:
            raise ValueError("Excel 启动超时，请关闭残留的 Excel 弹窗后重试") from error
        if completed.returncode != 0:
            raw_error = completed.stderr or completed.stdout or b""
            try:
                detail = raw_error.decode("utf-16le", errors="ignore").strip()
            except AttributeError:
                detail = str(raw_error).strip()
            detail = detail[-500:] if detail else "Excel COM 调用失败"
            raise ValueError(f"Excel 打开失败：{detail}")
        return {
            "ok": True,
            "kind": "excel",
            "target": str(xlsx_path),
            "sheet": sheet_name,
            "row": excel_row,
            "column": excel_column,
        }

    def export_pending(self) -> dict[str, Any]:
        notes = self.list_notes("new", 1000)
        path = self.export_dir / f"pending-{datetime.now().strftime('%Y%m%d-%H%M%S')}.json"
        path.write_text(json.dumps(notes, ensure_ascii=False, indent=2), encoding="utf-8")
        return {"ok": True, "count": len(notes), "path": str(path), "notes": notes}


class BridgeHandler(BaseHTTPRequestHandler):
    server_version = "XhsMonitorBridge/0.7"

    def _cors_origin(self) -> str:
        origin = self.headers.get("Origin", "")
        if not origin or origin.startswith("http://localhost") or origin.startswith("http://127.0.0.1"):
            return origin or "*"
        if CHROME_EXTENSION_ORIGIN_RE.fullmatch(origin) and origin in allowed_extension_origins():
            return origin
        return "null"

    def _send_json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", self._cors_origin())
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        if length > 2_000_000:
            raise ValueError("request body is too large")
        raw = self.rfile.read(length) if length else b"{}"
        data = json.loads(raw.decode("utf-8"))
        if not isinstance(data, dict):
            raise ValueError("JSON body must be an object")
        return data

    @property
    def store(self) -> MonitorStore:
        return self.server.store  # type: ignore[attr-defined]

    def do_OPTIONS(self) -> None:  # noqa: N802
        self._send_json(204, {})

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        try:
            if parsed.path == "/api/health":
                self._send_json(200, {"ok": True, "version": VERSION, "service": "xhs-monitor-bridge"})
            elif parsed.path == "/api/relevance":
                self._send_json(200, {
                    "ok": True,
                    "groups": {key: list(values) for key, values in resolved_relevance_groups().items()},
                })
            elif parsed.path == "/api/stats":
                self._send_json(200, self.store.stats())
            elif parsed.path == "/api/notes":
                query = parse_qs(parsed.query)
                status = text(query.get("status", [""])[0], 30)
                limit = int(query.get("limit", [100])[0])
                self._send_json(200, {"ok": True, "notes": self.store.list_notes(status, limit)})
            elif parsed.path == "/api/note/status":
                query = parse_qs(parsed.query)
                self._send_json(200, self.store.note_status(text(query.get("noteId", [""])[0], 128)))
            elif parsed.path == "/api/comments":
                query = parse_qs(parsed.query)
                note_id = text(query.get("noteId", [""])[0], 128)
                limit = int(query.get("limit", [500])[0])
                self._send_json(200, {"ok": True, "comments": self.store.list_comments(note_id, limit)})
            elif parsed.path == "/api/ai/settings":
                self._send_json(200, self.store.ai_settings_public())
            elif parsed.path == "/api/ai/status":
                self._send_json(200, self.store.ai_status())
            elif parsed.path == "/api/ai/note":
                query = parse_qs(parsed.query)
                note_id = text(query.get("noteId", [""])[0], 128)
                self._send_json(200, self.store.note_analysis(note_id))
            elif parsed.path == "/api/ai/jobs":
                query = parse_qs(parsed.query)
                status = text(query.get("status", [""])[0], 20)
                limit = int(query.get("limit", [100])[0])
                self._send_json(200, {"ok": True, "jobs": self.store.list_ai_jobs(status, limit)})
            elif parsed.path == "/api/ai/history":
                query = parse_qs(parsed.query)
                target_type = text(query.get("targetType", [""])[0], 20)
                target_id = text(query.get("targetId", [""])[0], 256)
                limit = int(query.get("limit", [100])[0])
                self._send_json(200, {"ok": True, "records": self.store.list_ai_history(target_type, target_id, limit)})
            elif parsed.path == "/api/negative/summary":
                self._send_json(200, self.store.negative_summary())
            elif parsed.path == "/api/negative/items":
                query = parse_qs(parsed.query)
                target_type = text(query.get("targetType", [""])[0], 20)
                confidence = text(query.get("confidence", ["high"])[0], 20)
                limit = int(query.get("limit", [200])[0])
                self._send_json(200, {"ok": True, "items": self.store.list_negative(target_type, confidence, limit)})
            else:
                self._send_json(404, {"ok": False, "error": "not found"})
        except Exception as exc:  # pragma: no cover - defensive HTTP boundary
            self._send_json(400, {"ok": False, "error": str(exc)})

    def do_POST(self) -> None:  # noqa: N802
        try:
            payload = self._read_json()
            if self.path == "/api/scan":
                result = self.store.scan(payload)
            elif self.path == "/api/pull":
                result = self.store.pull_to_excel(payload)
            elif self.path == "/api/note/delete":
                result = self.store.delete_pulled_note(payload)
            elif self.path == "/api/relevance/analyze":
                result = self.store.analyze_relevance(payload)
            elif self.path == "/api/open":
                result = self.store.open_local_artifact(payload)
            elif self.path == "/api/confirm":
                result = self.store.confirm(payload)
            elif self.path == "/api/ignore":
                result = self.store.ignore(payload)
            elif self.path == "/api/restore":
                result = self.store.restore(payload)
            elif self.path == "/api/export":
                result = self.store.export_pending()
            elif self.path == "/api/comments/upsert":
                result = self.store.upsert_comments(payload)
            elif self.path == "/api/comments/collection/start":
                result = self.store.start_comment_collection(payload)
            elif self.path == "/api/excel/reload":
                seed_path = getattr(self.store, "seed_xlsx_path", None)
                if not seed_path:
                    raise ValueError("未配置 Excel 总表路径")
                result = {"ok": True, "inserted": self.store.seed_from_xlsx(Path(seed_path)), "path": str(seed_path)}
            elif self.path == "/api/ai/settings":
                result = self.store.save_ai_settings(payload)
            elif self.path == "/api/ai/test":
                result = self.store.test_ai_connection(payload)
            elif self.path in {"/api/ai/analyze", "/api/ai/retry"}:
                result = self.store.enqueue_ai(
                    text(payload.get("targetType"), 20), text(payload.get("targetId"), 256),
                    priority=10, force=self.path.endswith("retry") or bool(payload.get("force")),
                )
            elif self.path == "/api/ai/history/clear":
                result = self.store.clear_ai_history()
            elif self.path == "/api/review":
                result = self.store.update_review(payload)
            else:
                self._send_json(404, {"ok": False, "error": "not found"})
                return
            self._send_json(200, result)
        except Exception as exc:  # pragma: no cover - defensive HTTP boundary
            self._send_json(400, {"ok": False, "error": str(exc), "errorKind": getattr(exc, "kind", "validation")})

    def log_message(self, format: str, *args: Any) -> None:
        print(f"[bridge] {self.address_string()} - {format % args}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="XHS-Monitor local DOM monitor bridge")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=17881)
    parser.add_argument("--db", type=Path, default=Path(__file__).parent / "data" / "xhs_monitor.db")
    parser.add_argument("--export-dir", type=Path, default=Path(__file__).parent / "exports")
    parser.add_argument("--seed-xlsx", type=Path, default=None)
    parser.add_argument("--seed-only", action="store_true", help="只初始化数据库，不启动 HTTP 服务")
    return parser.parse_args()


def _project_data_dir() -> Path:
    """项目级默认数据目录（bridge 所在目录的上一级 data 文件夹）。"""
    if getattr(sys, "frozen", False):
        # bridge/dist/xhs_monitor_native_host.exe -> 项目根 = dist/../..
        return Path(sys.executable).resolve().parent.parent.parent / "data"
    # bridge/server.py -> 项目根 = bridge/..
    return Path(__file__).resolve().parent.parent / "data"


def default_seed_xlsx() -> Path:
    """解析 Excel 总表路径：优先安装配置；未配置时用项目 data 目录默认值。

    新用户场景下文件允许不存在——首次拉取写入时会自动创建标准空表。
    """
    candidates: list[Path] = []
    if getattr(sys, "frozen", False):
        exe_dir = Path(sys.executable).resolve().parent
        candidates.extend([exe_dir / "native_host_config.json", exe_dir.parent / "native_host_config.json"])
    else:
        candidates.append(Path(__file__).resolve().parent / "native_host_config.json")
    for path in candidates:
        try:
            if not path.is_file():
                continue
            value = text(json.loads(path.read_text(encoding="utf-8")).get("seed_xlsx"), 500)
            if value:
                return Path(value).expanduser()
        except Exception:
            continue
    return _project_data_dir() / "小红书笔记评论总表.xlsx"


def create_server(host: str, port: int, db_path: Path, export_dir: Path, seed_xlsx: Path | None = None):
    store = MonitorStore(db_path, export_dir)
    store.seed_xlsx_path = seed_xlsx  # type: ignore[attr-defined]
    inserted = 0
    if seed_xlsx and Path(seed_xlsx).is_file():
        inserted = store.seed_from_xlsx(seed_xlsx)
    server = ThreadingHTTPServer((host, port), BridgeHandler)
    server.store = store  # type: ignore[attr-defined]
    return server, store, inserted


def _port_already_serves_bridge(host: str, port: int) -> bool:
    """Detect a Bridge already bound to host:port (prevents silent double-bind).

    On Windows, SO_REUSEADDR lets a second HTTPServer bind the same port,
    which scatters requests between two servers — a stale one then breaks
    features its launch flags did not configure (e.g. the Excel master table).
    """
    import urllib.request

    try:
        with urllib.request.urlopen(f"http://{host}:{port}/api/health", timeout=1.5) as response:
            payload = json.loads(response.read().decode("utf-8"))
            return bool(payload.get("ok") and payload.get("service") == "xhs-monitor-bridge")
    except Exception:
        return False


def main() -> None:
    args = parse_args()
    if args.seed_only:
        if not args.seed_xlsx:
            raise SystemExit("--seed-only requires --seed-xlsx")
        store = MonitorStore(args.db, args.export_dir)
        inserted = store.seed_from_xlsx(args.seed_xlsx)
        print(f"[bridge] seeded {inserted} existing note IDs from {args.seed_xlsx}")
        return

    if _port_already_serves_bridge(args.host, args.port):
        raise SystemExit(
            f"[bridge] 端口 {args.port} 上已有 Bridge 在运行，本次启动中止，避免双实例抢请求。"
        )
    seed_xlsx = Path(args.seed_xlsx) if args.seed_xlsx else default_seed_xlsx()
    server, store, inserted = create_server(args.host, args.port, args.db, args.export_dir, seed_xlsx)
    if Path(seed_xlsx).is_file():
        print(f"[bridge] seeded {inserted} existing note IDs from {seed_xlsx}")
    else:
        print(f"[bridge] Excel 总表暂不存在，首次拉取时将自动创建：{seed_xlsx}")
    print(f"[bridge] listening on http://{args.host}:{args.port}")
    print(f"[bridge] database: {store.db_path}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[bridge] stopping")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
