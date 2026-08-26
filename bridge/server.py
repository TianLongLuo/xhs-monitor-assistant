#!/usr/bin/env python3
"""Local Bridge for the XHS-Monitor XHS DOM monitor.

The bridge intentionally exposes only a small localhost JSON API. It does not
read browser cookies and does not call Xiaohongshu endpoints.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import html
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
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import contextmanager
from copy import copy
from datetime import datetime, timedelta
from difflib import SequenceMatcher
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, parse_qsl, urlencode, urlparse, urlunparse
from urllib.request import Request, urlopen

try:
    from .ai_support import AIServiceError, AISettingsStore, DeepSeekClient
except ImportError:  # Native Host runs this module as a top-level script.
    from ai_support import AIServiceError, AISettingsStore, DeepSeekClient


VERSION = "0.23.7"
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


def _reopen_saved_office_workbook_read_only(target: Path) -> bool:
    """Release a saved editable WPS/Excel handle without discarding user changes."""
    if os.name != "nt":
        return False
    escaped_path = str(Path(target).resolve()).replace("'", "''")
    script = f"""
$ErrorActionPreference = 'Stop'
$path = [System.IO.Path]::GetFullPath('{escaped_path}')
$result = 'NOT_OPEN'
foreach ($progId in @('ket.Application', 'Excel.Application')) {{
  try {{ $app = [Runtime.InteropServices.Marshal]::GetActiveObject($progId) }} catch {{ continue }}
  foreach ($candidate in @($app.Workbooks)) {{
    if (-not [System.String]::Equals([System.IO.Path]::GetFullPath($candidate.FullName), $path, [System.StringComparison]::OrdinalIgnoreCase)) {{ continue }}
    if ($candidate.ReadOnly) {{ $result = 'READ_ONLY'; break }}
    if (-not $candidate.Saved) {{ $result = 'UNSAVED'; break }}
    $sheetName = $candidate.ActiveSheet.Name
    $rowNumber = 1
    $columnNumber = 1
    try {{ $rowNumber = $app.ActiveCell.Row; $columnNumber = $app.ActiveCell.Column }} catch {{}}
    $candidate.Close($false)
    $book = $app.Workbooks.Open($path, 0, $true)
    $sheet = $book.Worksheets.Item($sheetName)
    $sheet.Activate()
    $cell = $sheet.Cells.Item($rowNumber, $columnNumber)
    $cell.Select()
    $app.Goto($cell, $true)
    $result = 'REOPENED_READ_ONLY'
    break
  }}
  if ($result -ne 'NOT_OPEN') {{ break }}
}}
Write-Output $result
"""
    encoded = base64.b64encode(script.encode("utf-16le")).decode("ascii")
    try:
        completed = subprocess.run(
            ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-EncodedCommand", encoded],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            timeout=8,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    output = (completed.stdout or b"").decode("utf-16le", errors="ignore")
    return completed.returncode == 0 and "REOPENED_READ_ONLY" in output


def replace_with_retry(source: Path, target: Path, attempts: int = 20, initial_delay: float = 0.15) -> int:
    """Atomically replace a file, tolerating WPS, cloud sync and antivirus sharing locks."""
    total_attempts = max(1, int(attempts))
    office_recovery_attempted = False
    for attempt in range(total_attempts):
        try:
            os.replace(source, target)
            return attempt + 1
        except PermissionError:
            if not office_recovery_attempted:
                office_recovery_attempted = True
                if _reopen_saved_office_workbook_read_only(target):
                    continue
            if attempt + 1 >= total_attempts:
                raise
            time.sleep(min(initial_delay * (2 ** attempt), 1.5))
    return total_attempts


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


def classify_reply_context(value: Any) -> tuple[str, str]:
    body = text(value, 3000)
    intent_patterns = (
        ("推销投诉", r"推销|拉着|强推|硬推|销售|压力|围着|拦着"),
        ("价格疑问", r"价格|多少钱|太贵|巨贵|价差|便宜|贵了|\d+元"),
        ("成分疑问", r"成分|水杨酸|配方|全成分|含有"),
        ("使用问题", r"怎么用|用法|颗粒|刺痛|过敏|不舒服|不适|泛红|干燥"),
        ("门店问题", r"门店|哪里买|在哪买|地址|杭州|深圳|商场"),
        ("赠品售后", r"赠品|小票|退款|售后|少了|漏发"),
        ("正向体验", r"好用|不错|喜欢|顺滑|不刺激|有效果"),
    )
    intent = next((label for label, pattern in intent_patterns if re.search(pattern, body, re.I)), "普通交流")
    negative = bool(re.search(r"推销|强推|压力|贵|不舒服|不适|过敏|失望|骗人|退|投诉|抗拒|烦|差", body, re.I))
    positive = bool(re.search(r"好用|不错|喜欢|顺滑|舒服|满意|有效果", body, re.I))
    sentiment = "负面" if negative else "正面" if positive else "中立"
    return intent, sentiment


def audit_reply_candidate(reply: Any, target_content: Any, persona: str, recent_replies: list[str] | None = None) -> dict[str, Any]:
    body = text(reply, 1000)
    target = text(target_content, 3000)
    compact = re.sub(r"\s+", "", body)
    char_count = len(compact)
    notes: list[str] = []
    score = 0
    minimum, maximum = (20, 60) if persona == "brand" else (12, 70)
    if char_count < minimum or char_count > maximum:
        notes.append(f"长度应为{minimum}—{maximum}字")
        score += 45
    sentence_count = len([item for item in re.split(r"[。！？!?]+", body) if item.strip()])
    if sentence_count > 2:
        notes.append("超过2句话")
        score += 30
    external_terms = [term for term in ("淘宝", "微信", "手机号", "二维码", "私信", "加V", "链接") if term in body]
    if external_terms:
        notes.append("含站外导流或联系方式：" + "、".join(external_terms))
        score += 55
    claim_terms = [term for term in ("有效抗衰老", "促进代谢", "绝对安全", "保证有效", "保证效果", "最好", "顶级", "百分百", "治愈") if term in body]
    if claim_terms:
        notes.append("含功效保证或绝对化表述：" + "、".join(claim_terms))
        score += 55
    marketing_terms = [term for term in ("优惠", "活动", "线上渠道", "到店体验", "欢迎围观", "欢迎体验", "品牌介绍") if term in body and term not in target]
    if marketing_terms:
        notes.append("主动追加营销信息：" + "、".join(marketing_terms))
        score += 35
    intent, sentiment = classify_reply_context(target)
    if sentiment == "负面" and re.search(r"感谢.{0,5}(认可|喜爱)|感谢宝宝|欢迎.{0,4}(围观|体验)", body):
        notes.append("与负面评论语义不匹配")
        score += 60
    if persona == "brand" and "宝宝" in body:
        notes.append("品牌回复默认不使用“宝宝”")
        score += 25
    if sentiment == "负面" and re.search(r"[\U0001F300-\U0001FAFF]", body):
        notes.append("投诉类回复不使用emoji")
        score += 25
    target_numbers = set(re.findall(r"\d+(?:\.\d+)?", target))
    reply_numbers = set(re.findall(r"\d+(?:\.\d+)?", body))
    invented_numbers = sorted(reply_numbers - target_numbers)
    if invented_numbers:
        notes.append("包含评论中未提供的数字：" + "、".join(invented_numbers))
        score += 35
    normalized = re.sub(r"[^\w\u4e00-\u9fff]+", "", body.lower())
    max_similarity = 0.0
    for previous in recent_replies or []:
        previous_normalized = re.sub(r"[^\w\u4e00-\u9fff]+", "", text(previous, 1000).lower())
        if normalized and previous_normalized:
            max_similarity = max(max_similarity, SequenceMatcher(None, normalized, previous_normalized).ratio())
    if max_similarity >= 0.72:
        notes.append(f"与近期回复相似度{max_similarity:.0%}")
        score += 50
    elif max_similarity >= 0.60:
        notes.append(f"与近期回复相似度{max_similarity:.0%}")
        score += 18
    score = min(100, score)
    level = "high" if score >= 45 else "medium" if score >= 20 else "low"
    return {
        "intent": intent, "sentiment": sentiment, "charCount": char_count,
        "sentenceCount": sentence_count, "similarityScore": round(max_similarity, 4),
        "riskScore": score, "riskLevel": level, "riskNotes": notes,
    }


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
        # The search page can ask for dozens of note statuses at once. Loading
        # the same workbook once per card creates a thundering herd, leaves the
        # Process panel in its skeleton state, and can exhaust the HTTP worker
        # threads. Keep one immutable index per workbook revision instead.
        self._excel_artifact_cache_lock = threading.Lock()
        self._excel_artifact_cache_key: tuple[str, int, int] | None = None
        self._excel_artifact_cache: dict[str, tuple[str, list[str], int]] = {}
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
                "access_status": "TEXT NOT NULL DEFAULT ''",
                "access_error": "TEXT NOT NULL DEFAULT ''",
                "last_access_checked_at": "TEXT NOT NULL DEFAULT ''",
                "access_check_result": "TEXT NOT NULL DEFAULT ''",
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
            db.execute("CREATE INDEX IF NOT EXISTS idx_notes_access_status ON notes(access_status)")
            db.execute("""UPDATE notes SET access_status='check_failed',
                       access_error='旧版打不开判定已降级，等待重新同步核验',
                       access_check_result='legacy_untrusted'
                       WHERE access_status='unreachable' AND (access_check_result='' OR access_check_result IS NULL)""")
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

                CREATE TABLE IF NOT EXISTS note_summaries (
                    note_id TEXT PRIMARY KEY,
                    model TEXT NOT NULL DEFAULT '',
                    result_json TEXT NOT NULL DEFAULT '{}',
                    comment_count INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

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

                CREATE TABLE IF NOT EXISTS reply_generation_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    note_id TEXT NOT NULL,
                    comment_id TEXT NOT NULL,
                    persona TEXT NOT NULL DEFAULT 'brand',
                    intent TEXT NOT NULL DEFAULT '',
                    generated_reply TEXT NOT NULL,
                    risk_level TEXT NOT NULL DEFAULT 'low',
                    risk_score INTEGER NOT NULL DEFAULT 0,
                    similarity_score REAL NOT NULL DEFAULT 0,
                    risk_notes TEXT NOT NULL DEFAULT '[]',
                    created_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_reply_history_recent
                    ON reply_generation_history(persona, created_at DESC);

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

                CREATE TABLE IF NOT EXISTS sync_runs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    run_type TEXT NOT NULL DEFAULT 'single',
                    status TEXT NOT NULL DEFAULT 'running',
                    total_notes INTEGER NOT NULL DEFAULT 0,
                    processed_notes INTEGER NOT NULL DEFAULT 0,
                    changed_notes INTEGER NOT NULL DEFAULT 0,
                    unchanged_notes INTEGER NOT NULL DEFAULT 0,
                    failed_notes INTEGER NOT NULL DEFAULT 0,
                    new_comments INTEGER NOT NULL DEFAULT 0,
                    removed_comments INTEGER NOT NULL DEFAULT 0,
                    changed_comments INTEGER NOT NULL DEFAULT 0,
                    detail_json TEXT NOT NULL DEFAULT '{}',
                    started_at TEXT NOT NULL,
                    finished_at TEXT NOT NULL DEFAULT ''
                );
                CREATE INDEX IF NOT EXISTS idx_sync_runs_started
                    ON sync_runs(started_at DESC);

                CREATE TABLE IF NOT EXISTS change_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    run_id INTEGER NOT NULL DEFAULT 0,
                    note_id TEXT NOT NULL DEFAULT '',
                    event_type TEXT NOT NULL,
                    target_id TEXT NOT NULL DEFAULT '',
                    title TEXT NOT NULL DEFAULT '',
                    summary TEXT NOT NULL DEFAULT '',
                    before_json TEXT NOT NULL DEFAULT '{}',
                    after_json TEXT NOT NULL DEFAULT '{}',
                    acknowledged INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_change_events_created
                    ON change_events(created_at DESC);
                CREATE INDEX IF NOT EXISTS idx_change_events_note
                    ON change_events(note_id, created_at DESC);
                CREATE INDEX IF NOT EXISTS idx_change_events_unread
                    ON change_events(acknowledged, created_at DESC);

                CREATE TABLE IF NOT EXISTS watchlist (
                    note_id TEXT PRIMARY KEY,
                    priority TEXT NOT NULL DEFAULT 'normal',
                    reason TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_watchlist_priority
                    ON watchlist(priority, updated_at DESC);

                CREATE TABLE IF NOT EXISTS weekly_reports (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    period_start TEXT NOT NULL,
                    period_end TEXT NOT NULL,
                    xlsx_path TEXT NOT NULL DEFAULT '',
                    html_path TEXT NOT NULL DEFAULT '',
                    summary_json TEXT NOT NULL DEFAULT '{}',
                    generated_at TEXT NOT NULL,
                    UNIQUE(period_start, period_end)
                );
                CREATE INDEX IF NOT EXISTS idx_weekly_reports_generated
                    ON weekly_reports(generated_at DESC);
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

    def _ensure_access_status_column(self, xlsx_path: Path) -> bool:
        """Migrate an existing workbook so the access status is visible immediately."""
        from openpyxl import load_workbook

        xlsx_path = Path(xlsx_path)
        workbook = None
        temporary_path: Path | None = None
        with self.pull_lock:
            try:
                workbook = load_workbook(xlsx_path)
                if "sheet1_笔记总表" not in workbook.sheetnames:
                    return False
                sheet = workbook["sheet1_笔记总表"]
                if "访问状态" in self._excel_headers(sheet):
                    return False
                self._ensure_excel_header(sheet, "访问状态")
                temporary_path = xlsx_path.with_name(
                    f".{xlsx_path.stem}.schema-{os.getpid()}-{time.time_ns()}.tmp{xlsx_path.suffix}"
                )
                workbook.save(temporary_path)
                workbook.close()
                workbook = None
                try:
                    replace_with_retry(temporary_path, xlsx_path)
                except PermissionError as exc:
                    raise ValueError("WPS/Excel 持续占用总表，请关闭表格窗口后重试") from exc
                temporary_path = None
                return True
            finally:
                if workbook is not None:
                    workbook.close()
                if temporary_path and temporary_path.exists():
                    try:
                        temporary_path.unlink()
                    except OSError:
                        pass

    def seed_from_xlsx(self, xlsx_path: Path) -> int:
        """Synchronize the Excel post index into the local comparison database."""
        from openpyxl import load_workbook

        self._ensure_access_status_column(Path(xlsx_path))
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
                row_access_label = value(row, "访问状态").strip()
                row_title_key, row_content_key, row_combined_key = identity_keys(row_title, row_content)
                row_media_dir = self._resolve_legacy_media_dir(
                    value(row, "对应帖子文件夹地址"),
                    [line.strip() for line in value(row, "文件夹内清单").splitlines() if line.strip()],
                    note_id,
                )
                row_media_count = len([line for line in value(row, "文件夹内清单").splitlines() if line.strip()])
                existing = db.execute(
                    "SELECT note_id,url,page_url,access_status,access_check_result FROM notes WHERE note_id = ?",
                    (note_id,),
                ).fetchone()
                confirmed_unreachable = bool(existing and existing["access_check_result"] == "confirmed_v2")
                if row_access_label == "可打开":
                    row_access_status, row_access_error, row_access_result = "ok", "", "opened"
                elif row_access_label == "打不开" and confirmed_unreachable:
                    row_access_status, row_access_error, row_access_result = "unreachable", "", "confirmed_v2"
                elif row_access_label in {"打不开", "待复核", "检查失败"}:
                    row_access_status, row_access_error, row_access_result = (
                        "check_failed", "Excel 中的旧状态等待重新同步核验", "legacy_excel_unverified"
                    )
                else:
                    row_access_status, row_access_error, row_access_result = "", "", ""
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
                            last_seen_at=?, access_status=?, access_error=?, access_check_result=?
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
                            timestamp, row_access_status, row_access_error, row_access_result, note_id,
                        ),
                    )
                    if row_media_dir:
                        db.execute(
                            "UPDATE notes SET media_dir=?,media_status='complete',media_file_count=? WHERE note_id=?",
                            (row_media_dir, row_media_count, note_id),
                        )
                    continue
                db.execute(
                    """
                    INSERT INTO notes (
                        note_id, url, title, author, content, tags, keyword, page_url,
                        first_seen_at, last_seen_at, status, is_relevant, source,
                        post_sentiment, title_key, content_key, title_content_key, payload_json,
                        access_status, access_error, access_check_result
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'known', ?, 'existing_xlsx', ?, ?, ?, ?, ?, ?, ?, ?)
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
                        row_access_status,
                        row_access_error,
                        row_access_result,
                    ),
                )
                if row_media_dir:
                    db.execute(
                        "UPDATE notes SET media_dir=?,media_status='complete',media_file_count=? WHERE note_id=?",
                        (row_media_dir, row_media_count, note_id),
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
                # The lightweight card scan may see a shortened/current XHS
                # title while Excel retains the title captured during the pull.
                # A canonical note-ID hit is stronger evidence than title text
                # and must keep the card aligned with the detail status endpoint.
                in_excel = bool(
                    existing is not None and (
                        str(existing["source"]) == "existing_xlsx"
                        or str(existing["pull_status"] or "") in {"synced", "partial"}
                    )
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
        sanitized = {**payload, "auto_analyze_posts": False, "auto_analyze_comments": False}
        return {"ok": True, **self.ai_settings.save(sanitized)}

    def test_ai_connection(self, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        if payload:
            self.ai_settings.save({**payload, "auto_analyze_posts": False, "auto_analyze_comments": False})
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
        return {"ok": True, "noteId": note_id, "newCount": len(inserted_ids), "changedCount": len(changed_ids),
                "collectedCount": count, "status": collection_status}

    @staticmethod
    def _comment_api_row(item: dict[str, Any]) -> dict[str, Any]:
        return {
            "commentId": text(item.get("commentId") or item.get("comment_id"), 256),
            "parentCommentId": text(item.get("parentCommentId") or item.get("parent_comment_id"), 256),
            "author": text(item.get("author"), 500),
            "content": text(item.get("content"), 8000),
            "publishedAt": text(item.get("publishedAt") or item.get("published_at"), 100),
            "commentLevel": max(1, min(int(item.get("commentLevel") or item.get("comment_level") or 1), 3)),
            "likeCount": int(item.get("likeCount") or item.get("like_count") or 0),
            "replyCount": int(item.get("replyCount") or item.get("reply_count") or 0),
        }

    def compare_comments(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Compare a fully expanded browser snapshot with local comments.

        Missing rows are only confirmed as removed when collection is likely
        complete, so a collapsed or slow reply thread is never deleted.
        """
        note_id = valid_note_id(payload.get("noteId"))
        if not note_id:
            raise ValueError("noteId is required")
        raw_comments = payload.get("comments") or []
        if not isinstance(raw_comments, list):
            raise ValueError("comments must be an array")
        current = [self._comment_api_row(item) for item in raw_comments
                   if isinstance(item, dict) and text(item.get("content"), 8000)]
        local = [self._comment_api_row(item) for item in self.list_comments(note_id, 2000)]
        incoming_note = payload.get("note") if isinstance(payload.get("note"), dict) else {}
        with self.lock, self._session() as db:
            stored_note_row = db.execute(
                "SELECT title,content,author,url,payload_json FROM notes WHERE note_id=?", (note_id,)
            ).fetchone()
        stored_note = dict(stored_note_row) if stored_note_row else {}
        try:
            stored_payload = json.loads(stored_note.get("payload_json") or "{}")
            if not isinstance(stored_payload, dict):
                stored_payload = {}
        except (TypeError, ValueError):
            stored_payload = {}
        previous_note = {**stored_payload, **{key: value for key, value in stored_note.items() if key != "payload_json" and value}}
        note_fields = (
            ("title", "标题"), ("content", "正文"), ("likeCount", "点赞量"),
            ("collectCount", "收藏量"), ("commentCount", "评论量"), ("shareCount", "分享量"),
            ("publishedAt", "发布时间"), ("updatedAt", "更新时间"),
        )
        note_changes: list[dict[str, Any]] = []
        missing_markers = {"", "待读取", "未显示", "未知", "none", "null"}
        for field, label in note_fields:
            if field not in incoming_note:
                continue
            after = incoming_note.get(field)
            if text(after, 2000).lower() in missing_markers:
                continue
            before = previous_note.get(field)
            if str(before if before is not None else "") != str(after if after is not None else ""):
                note_changes.append({"field": field, "label": label, "before": before, "after": after})
        by_id = {row["commentId"]: index for index, row in enumerate(local) if row["commentId"]}
        by_exact = {(row["author"], row["content"], row["publishedAt"]): index
                    for index, row in enumerate(local)}
        by_loose = {(row["author"], row["content"]): index for index, row in enumerate(local)}
        matched: set[int] = set()
        new_comments: list[dict[str, Any]] = []
        changed_comments: list[dict[str, Any]] = []
        for row in current:
            index = by_id.get(row["commentId"]) if row["commentId"] else None
            if index is None:
                index = by_exact.get((row["author"], row["content"], row["publishedAt"]))
            if index is None:
                index = by_loose.get((row["author"], row["content"]))
            if index is None:
                new_comments.append(row)
                continue
            matched.add(index)
            previous = local[index]
            if (previous["content"] != row["content"] or
                    previous["parentCommentId"] != row["parentCommentId"] or
                    previous["commentLevel"] != row["commentLevel"]):
                changed_comments.append({"before": previous, "after": row})
        missing = [row for index, row in enumerate(local) if index not in matched]
        status = text(payload.get("status"), 30) or "partial"
        expected_count = max(0, int(payload.get("expectedCount") or 0))
        can_prune = status == "likely_complete" and (expected_count <= 0 or len(current) >= expected_count)
        removed = missing if can_prune else []
        pending_removed = [] if can_prune else missing
        return {
            "ok": True, "noteId": note_id, "status": status,
            "expectedCount": expected_count, "currentCount": len(current), "localCount": len(local),
            "canPrune": can_prune, "newCount": len(new_comments), "removedCount": len(removed),
            "changedCount": len(changed_comments), "pendingRemovedCount": len(pending_removed),
            "hasChanges": bool(new_comments or removed or changed_comments or note_changes),
            "noteChanged": bool(note_changes), "noteChanges": note_changes,
            "newComments": new_comments, "removedComments": removed,
            "changedComments": changed_comments, "pendingRemovedComments": pending_removed,
        }

    def _delete_comment_rows_from_xlsx(self, note_id: str, removed: list[dict[str, Any]]) -> int:
        if not removed:
            return 0
        xlsx_path = Path(getattr(self, "seed_xlsx_path", "") or "")
        if not xlsx_path.exists():
            return 0
        from openpyxl import load_workbook
        from openpyxl.utils.cell import get_column_letter, range_boundaries
        removed_ids = {text(item.get("commentId"), 256) for item in removed if text(item.get("commentId"), 256)}
        removed_exact = {(text(item.get("author"), 500), text(item.get("content"), 8000),
                          text(item.get("publishedAt"), 100)) for item in removed}
        workbook = None
        temporary_path: Path | None = None
        try:
            workbook = load_workbook(xlsx_path)
            if "sheet2_评论总表" not in workbook.sheetnames:
                return 0
            sheet = workbook["sheet2_评论总表"]
            headers = self._excel_headers(sheet)
            id_col, url_col = headers.get("笔记评论ID"), headers.get("原笔记url")
            author_col, content_col, time_col = (
                headers.get("用户昵称"), headers.get("评论内容"), headers.get("评论时间")
            )
            deleted = 0
            for row_number in range(sheet.max_row, 1, -1):
                row_note_id = note_url_identity(sheet.cell(row_number, url_col).value) if url_col else ""
                if row_note_id != note_id:
                    continue
                row_id = text(sheet.cell(row_number, id_col).value, 256) if id_col else ""
                row_key = (
                    text(sheet.cell(row_number, author_col).value, 500) if author_col else "",
                    text(sheet.cell(row_number, content_col).value, 8000) if content_col else "",
                    text(sheet.cell(row_number, time_col).value, 100) if time_col else "",
                )
                if row_id in removed_ids or row_key in removed_exact:
                    sheet.delete_rows(row_number, 1)
                    deleted += 1
            if not deleted:
                return 0
            for table in sheet.tables.values():
                min_col, min_row, max_col, _max_row = range_boundaries(table.ref)
                table.ref = f"{get_column_letter(min_col)}{min_row}:{get_column_letter(max_col)}{max(min_row, sheet.max_row)}"
            temporary_path = xlsx_path.with_name(
                f".{xlsx_path.stem}.comment-sync-{datetime.now().strftime('%Y%m%d%H%M%S%f')}.tmp.xlsx"
            )
            workbook.save(temporary_path)
            workbook.close()
            workbook = None
            try:
                replace_with_retry(temporary_path, xlsx_path)
            except PermissionError as exc:
                raise ValueError("WPS/Excel 持续占用总表，请关闭表格窗口后重试更新评论") from exc
            temporary_path = None
            return deleted
        finally:
            if workbook is not None:
                workbook.close()
            if temporary_path and temporary_path.exists():
                temporary_path.unlink(missing_ok=True)

    def sync_comment_snapshot(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Apply a reviewed comment delta to SQLite, Excel and comments.json."""
        note_id = valid_note_id(payload.get("noteId"))
        if not note_id:
            raise ValueError("noteId is required")
        comments = payload.get("comments") or []
        if not isinstance(comments, list):
            raise ValueError("comments must be an array")
        with self.pull_lock:
            comparison = self.compare_comments(payload)
            with self.lock, self._session() as db:
                stored = db.execute("SELECT * FROM notes WHERE note_id=?", (note_id,)).fetchone()
            if stored is None:
                raise ValueError("帖子尚未写入本地数据库")
            stored_row = dict(stored)
            try:
                stored_payload = json.loads(stored_row.get("payload_json") or "{}")
                if not isinstance(stored_payload, dict):
                    stored_payload = {}
            except (TypeError, ValueError):
                stored_payload = {}
            incoming_note = payload.get("note") if isinstance(payload.get("note"), dict) else {}
            note = {**stored_payload, **incoming_note, "noteId": note_id}
            for field, column in (("url", "url"), ("title", "title"), ("content", "content"), ("author", "author")):
                if not note.get(field):
                    note[field] = stored_row.get(column) or ""
            media_dir = text(stored_row.get("media_dir"), 4000)
            media_files = sorted(item.name for item in Path(media_dir).iterdir() if item.is_file()) if media_dir and Path(media_dir).is_dir() else []
            media_result = {"folder": media_dir, "files": media_files}
            upserted = self.upsert_comments({
                "noteId": note_id, "comments": comments,
                "expectedCount": comparison["expectedCount"],
                "status": text(payload.get("status"), 30) or "partial",
                "collectedAt": now_iso(),
            })
            xlsx_result = self._sync_pull_to_xlsx(note, comments, media_result)
            removed = comparison["removedComments"] if comparison["canPrune"] else []
            excel_removed = self._delete_comment_rows_from_xlsx(note_id, removed)
            removed_ids = [text(item.get("commentId"), 256) for item in removed if text(item.get("commentId"), 256)]
            with self.lock, self._session() as db:
                if removed_ids:
                    placeholders = ",".join("?" for _ in removed_ids)
                    db.execute(f"DELETE FROM comments WHERE note_id=? AND comment_id IN ({placeholders})",
                               (note_id, *removed_ids))
                count = int(db.execute("SELECT COUNT(*) FROM comments WHERE note_id=?", (note_id,)).fetchone()[0])
                checked_at = now_iso()
                db.execute(
                    """UPDATE notes SET comment_count_collected=?,comment_collection_status=?,last_comment_collected_at=?,
                       access_status='ok',access_error='',last_access_checked_at=?,access_check_result='opened',
                       title=CASE WHEN ?<>'' THEN ? ELSE title END,
                       content=CASE WHEN ?<>'' THEN ? ELSE content END,
                       author=CASE WHEN ?<>'' THEN ? ELSE author END,
                       url=CASE WHEN ?<>'' THEN ? ELSE url END,
                       payload_json=?,last_seen_at=?
                       WHERE note_id=?""",
                    (count, "likely_complete" if comparison["canPrune"] else text(payload.get("status"), 30) or "partial",
                     checked_at, checked_at,
                     text(note.get("title"), 1000), text(note.get("title"), 1000),
                     text(note.get("content"), 20000), text(note.get("content"), 20000),
                     text(note.get("author"), 500), text(note.get("author"), 500),
                     text(note.get("url"), 4000), text(note.get("url"), 4000),
                     json.dumps(note, ensure_ascii=False), checked_at, note_id),
                )
            if media_dir:
                self._write_media_comments(media_result, comments)
            change_result = self._record_comment_change_events(
                note_id,
                comparison,
                text(note.get("title"), 1000) or text(stored_row.get("title"), 1000),
                max(0, int(payload.get("runId") or 0)),
            )
            note_change_result = self._record_note_change_event(
                note_id,
                comparison.get("noteChanges") or [],
                text(note.get("title"), 1000) or text(stored_row.get("title"), 1000),
                int(change_result.get("runId") or payload.get("runId") or 0),
            )
            return {
                "ok": True, "noteId": note_id, "status": "latest",
                "newCount": comparison["newCount"], "removedCount": len(removed),
                "changedCount": comparison["changedCount"], "collectedCount": count,
                "excelAdded": int(xlsx_result.get("commentAdded", 0) or 0),
                "excelRemoved": excel_removed, "canPrune": comparison["canPrune"],
                "runId": note_change_result.get("runId") or change_result.get("runId", 0),
                "changeEventCount": int(change_result.get("eventCount", 0)) + int(note_change_result.get("eventCount", 0)),
                "noteChanged": bool(comparison.get("noteChanged")),
                "updatedAt": now_iso(),
            }

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


    def _excel_note_artifacts(self, note_id: str) -> tuple[str, list[str], int]:
        """Return workbook artifacts from a revision-aware, process-local index."""
        xlsx_path = Path(self.seed_xlsx_path) if self.seed_xlsx_path else None
        if not xlsx_path or not xlsx_path.exists():
            return "", [], 0
        try:
            stat = xlsx_path.stat()
            cache_key = (str(xlsx_path.resolve()).casefold(), int(stat.st_mtime_ns), int(stat.st_size))
        except OSError:
            return "", [], 0

        with self._excel_artifact_cache_lock:
            if self._excel_artifact_cache_key != cache_key:
                from openpyxl import load_workbook
                workbook = load_workbook(xlsx_path, read_only=True, data_only=True)
                artifact_index: dict[str, tuple[str, list[str], int]] = {}
                try:
                    if "sheet1_笔记总表" in workbook.sheetnames:
                        sheet = workbook["sheet1_笔记总表"]
                        headers = self._excel_headers(sheet)
                        id_column = headers.get("笔记ID")
                        folder_column = headers.get("对应帖子文件夹地址")
                        files_column = headers.get("文件夹内清单")
                        if id_column:
                            for row_number in range(2, sheet.max_row + 1):
                                indexed_note_id = valid_note_id(sheet.cell(row_number, id_column).value)
                                if not indexed_note_id:
                                    continue
                                raw_folder = text(sheet.cell(row_number, folder_column).value, 4000) if folder_column else ""
                                raw_files = text(sheet.cell(row_number, files_column).value, 30000) if files_column else ""
                                files = [line.strip() for line in raw_files.splitlines() if line.strip()]
                                artifact_index[indexed_note_id] = (raw_folder, files, row_number)
                finally:
                    workbook.close()
                self._excel_artifact_cache = artifact_index
                self._excel_artifact_cache_key = cache_key
            raw_folder, files, row_number = self._excel_artifact_cache.get(note_id, ("", [], 0))
            # Return a fresh list so callers cannot mutate the shared cache.
            return raw_folder, list(files), row_number

    def _resolve_legacy_media_dir(self, raw_folder: str, expected_files: list[str], note_id: str) -> str:
        """Resolve stale pre-migration paths against the active posts_materials root."""
        candidates: list[Path] = []
        raw_path = Path(raw_folder).expanduser() if raw_folder else None
        if raw_path:
            candidates.append(raw_path)
        media_root = self._media_root()
        if raw_path:
            candidates.append(media_root / raw_path.name)
        if media_root.is_dir():
            candidates.extend(path for path in media_root.iterdir()
                              if path.is_dir() and (path.name.endswith(f"__{note_id}") or note_id in path.name))
            if raw_path:
                candidates.extend(path for path in media_root.glob(f"{raw_path.name}*") if path.is_dir())
        expected = {Path(name).name for name in expected_files if name}
        unique: list[Path] = []
        seen: set[str] = set()
        for candidate in candidates:
            key = str(candidate).casefold()
            if key in seen:
                continue
            seen.add(key)
            unique.append(candidate)
        scored: list[tuple[int, Path]] = []
        for candidate in unique:
            try:
                if not candidate.is_dir():
                    continue
                actual = {path.name for path in candidate.iterdir() if path.is_file()}
                overlap = len(expected.intersection(actual))
                score = overlap * 100 + (40 if candidate.name.endswith(f"__{note_id}") else 0)
                if raw_path and candidate.name == raw_path.name:
                    score += 20
                scored.append((score, candidate.resolve()))
            except OSError:
                continue
        if not scored:
            return ""
        scored.sort(key=lambda item: item[0], reverse=True)
        return str(scored[0][1])

    def note_status(self, note_id: str) -> dict[str, Any]:
        note_id = valid_note_id(note_id)
        if not note_id:
            raise ValueError("noteId is required")
        with self.lock, self._session() as db:
            row = db.execute("SELECT * FROM notes WHERE note_id=?", (note_id,)).fetchone()
            watch_row = db.execute(
                "SELECT priority,reason,created_at,updated_at FROM watchlist WHERE note_id=?", (note_id,)
            ).fetchone() if row is not None else None
            comment_rows = db.execute(
                "SELECT * FROM comments WHERE note_id=? ORDER BY first_seen_at LIMIT 12", (note_id,)
            ).fetchall() if row is not None else []
            comment_count = int(db.execute(
                "SELECT COUNT(*) FROM comments WHERE note_id=?", (note_id,)
            ).fetchone()[0]) if row is not None else 0
        if row is None:
            return {"ok": True, "noteId": note_id, "found": False, "inExcel": False,
                    "pullStatus": "not_started", "relevanceStatus": "unknown"}
        item = dict(row)
        in_excel = item.get("source") == "existing_xlsx" or item.get("pull_status") in {"synced", "partial"}
        relevance_status = item.get("relevance_status") or ("relevant" if item.get("is_relevant") else "unknown")
        try:
            note_payload = json.loads(item.get("payload_json") or "{}")
            if not isinstance(note_payload, dict):
                note_payload = {}
        except (TypeError, ValueError):
            note_payload = {}
        media_dir = text(item.get("media_dir"), 4000)
        excel_media_dir, excel_media_files, excel_row = self._excel_note_artifacts(note_id)
        current_folder_ok = False
        if media_dir:
            try:
                current_folder_ok = Path(media_dir).is_dir()
            except OSError:
                current_folder_ok = False
        if not current_folder_ok:
            resolved_media_dir = self._resolve_legacy_media_dir(excel_media_dir or media_dir, excel_media_files, note_id)
            if resolved_media_dir:
                media_dir = resolved_media_dir
                with self.lock, self._session() as db:
                    db.execute(
                        "UPDATE notes SET media_dir=?,media_status='complete',media_file_count=? WHERE note_id=?",
                        (media_dir, len(excel_media_files), note_id),
                    )
        media_files: list[str] = []
        if media_dir:
            try:
                folder = Path(media_dir)
                if folder.is_dir():
                    media_files = sorted(path.name for path in folder.iterdir() if path.is_file())[:200]
            except OSError:
                media_files = []
        stored_note = {
            **note_payload,
            "noteId": note_id,
            "url": item.get("url") or note_payload.get("url") or "",
            "title": item.get("title") or note_payload.get("title") or "",
            "author": item.get("author") or note_payload.get("author") or "",
            "content": item.get("content") or note_payload.get("content") or "",
            "tags": note_payload.get("tags") or ([item.get("tags")] if item.get("tags") else []),
            "keyword": item.get("keyword") or note_payload.get("keyword") or "",
            "mediaDir": media_dir,
            "mediaFiles": media_files,
            "commentCount": comment_count or note_payload.get("commentCount") or 0,
            "aiStatus": item.get("ai_analysis_status") or "",
            "postSentiment": sentiment_label(item.get("post_sentiment")) if item.get("post_sentiment") else "",
            "accessStatus": item.get("access_status") or "",
            "accessError": item.get("access_error") or "",
        }
        comments: list[dict[str, Any]] = []
        for comment_row in comment_rows:
            stored = dict(comment_row)
            try:
                payload = json.loads(stored.get("payload_json") or "{}")
                if not isinstance(payload, dict): payload = {}
            except (TypeError, ValueError):
                payload = {}
            comments.append({
                **payload,
                "commentId": stored.get("comment_id") or payload.get("commentId") or "",
                "parentCommentId": stored.get("parent_comment_id") or payload.get("parentCommentId") or "",
                "author": stored.get("author") or payload.get("author") or "",
                "content": stored.get("content") or payload.get("content") or "",
                "publishedAt": stored.get("published_at") or payload.get("publishedAt") or "",
            })
        return {
            "ok": True, "noteId": note_id, "found": True, "status": item.get("status", "new"),
            "inExcel": bool(in_excel), "pullStatus": item.get("pull_status") or "not_started",
            "pullError": item.get("pull_error") or "", "relevanceStatus": relevance_status,
            "isRelevant": relevance_status == "relevant", "relevanceSource": item.get("relevance_source") or "",
            "relevanceReason": item.get("relevance_reason") or "",
            "relevanceConfidence": float(item.get("relevance_confidence") or 0),
            "note": stored_note, "mediaDir": media_dir, "mediaFiles": media_files,
            "excelPath": item.get("excel_sync_path") or (str(self.seed_xlsx_path) if self.seed_xlsx_path else ""),
            "excelRow": excel_row, "commentCount": comment_count, "commentRows": comments,
            "aiStatus": item.get("ai_analysis_status") or "",
            "accessStatus": item.get("access_status") or "",
            "accessError": item.get("access_error") or "",
            "lastAccessCheckedAt": item.get("last_access_checked_at") or "",
            "watched": bool(watch_row),
            "watchPriority": watch_row["priority"] if watch_row else "",
            "watchReason": watch_row["reason"] if watch_row else "",
        }

    def _sync_irrelevant_to_xlsx(self, note: dict[str, Any], comments: list[dict[str, Any]], decision: dict[str, Any]) -> dict[str, Any]:
        xlsx_path = Path(self.seed_xlsx_path) if self.seed_xlsx_path else None
        if not xlsx_path or not xlsx_path.exists():
            raise ValueError("未配置 Excel 总表路径")
        from openpyxl import load_workbook
        headers = ["笔记url", "用户主页url", "用户昵称", "笔记标题", "笔记内容", "笔记话题",
                   "发布时间", "来源词", "笔记ID", "博主ID", "评论数量", "相关性状态", "AI判断来源",
                   "AI置信度", "AI判断理由", "分析时间", "评论内容汇总"]
        temporary_path = xlsx_path.with_name(f".{xlsx_path.stem}.irrelevant-{os.getpid()}.tmp{xlsx_path.suffix}")
        with self.pull_lock:
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
            replace_with_retry(temporary_path, xlsx_path)
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
        # Generic post/comment sentiment analysis was removed in v0.22.3.
        # Preserve completed labels and history for audit, while cancelling
        # unfinished work so a Bridge restart cannot revive the old queue.
        self.ai_settings.save({"auto_analyze_posts": False, "auto_analyze_comments": False})
        with self.lock, self._session() as db:
            db.execute("DELETE FROM ai_jobs WHERE status IN ('queued','analyzing')")
            db.execute("UPDATE notes SET ai_analysis_status='not_analyzed' WHERE ai_analysis_status IN ('queued','analyzing')")
            db.execute("UPDATE comments SET ai_analysis_status='not_analyzed' WHERE ai_analysis_status IN ('queued','analyzing')")

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

    def note_summary(self, note_id: str) -> dict[str, Any]:
        note_id = valid_note_id(note_id)
        if not note_id:
            raise ValueError("noteId is required")
        with self.lock, self._session() as db:
            row = db.execute("SELECT * FROM note_summaries WHERE note_id=?", (note_id,)).fetchone()
        if row is None:
            return {"ok": True, "found": False, "noteId": note_id}
        item = dict(row)
        try:
            result = json.loads(item.get("result_json") or "{}")
        except (TypeError, ValueError, json.JSONDecodeError):
            result = {}
        return {"ok": True, "found": True, "noteId": note_id, "model": item.get("model", ""),
                "commentCount": int(item.get("comment_count") or 0), "updatedAt": item.get("updated_at", ""),
                "summary": result}

    @staticmethod
    def _normalized_note_summary(value: dict[str, Any]) -> dict[str, Any]:
        def string_list(key: str, limit: int = 8) -> list[str]:
            raw = value.get(key) or []
            if not isinstance(raw, list):
                raw = [raw]
            return [text(item, 500) for item in raw if text(item, 500)][:limit]
        sentiment = text(value.get("sentiment"), 40).lower() or "uncertain"
        if sentiment not in {"negative", "light_negative", "neutral", "positive", "mixed", "uncertain"}:
            sentiment = "uncertain"
        return {
            "overview": text(value.get("overview") or value.get("summary"), 2000),
            "sentiment": sentiment,
            "keyPoints": string_list("key_points"),
            "commentConsensus": string_list("comment_consensus"),
            "disagreements": string_list("disagreements"),
            "risks": string_list("risks"),
            "actions": string_list("actions"),
            "representativeComments": string_list("representative_comments", 10),
        }

    def summarize_note(self, payload: dict[str, Any]) -> dict[str, Any]:
        incoming = payload.get("note") if isinstance(payload.get("note"), dict) else {}
        note_id = valid_note_id(incoming.get("noteId") or payload.get("noteId"))
        if not note_id:
            raise ValueError("noteId is required")
        comments = payload.get("comments") if isinstance(payload.get("comments"), list) else []
        with self.lock, self._session() as db:
            row = db.execute("SELECT * FROM notes WHERE note_id=?", (note_id,)).fetchone()
            if not comments:
                comments = [dict(item) for item in db.execute(
                    "SELECT comment_id,parent_comment_id,author,content,like_count,reply_count FROM comments WHERE note_id=? ORDER BY first_seen_at LIMIT 300",
                    (note_id,),
                ).fetchall()]
        stored = dict(row) if row else {}
        note = {**stored, **incoming}
        title = canonical_note_title(note.get("title"), note.get("content"), 100)
        content = text(note.get("content"), 16000)
        if not content:
            raise ValueError("帖子正文尚未读取")
        compact_comments = []
        total_chars = 0
        for item in comments[:300]:
            if not isinstance(item, dict):
                continue
            body = text(item.get("content"), 800)
            if not body:
                continue
            total_chars += len(body)
            if total_chars > 45000:
                break
            compact_comments.append({
                "author": text(item.get("author"), 120), "content": body,
                "parent_comment_id": text(item.get("parentCommentId") or item.get("parent_comment_id"), 128),
                "like_count": int(item.get("likeCount") or item.get("like_count") or 0),
            })
        settings = self.ai_settings.get(True)
        if not settings.get("configured"):
            raise AIServiceError("DeepSeek API Key 未配置", "not_configured", False)
        schema = {
            "overview": "200字内总览", "sentiment": "negative/light_negative/neutral/positive/mixed/uncertain",
            "key_points": ["正文核心观点"], "comment_consensus": ["评论区共识"],
            "disagreements": ["争议或分歧"], "risks": ["品牌风险"], "actions": ["建议动作"],
            "representative_comments": ["有代表性的评论原文"]
        }
        messages = [
            {"role": "system", "content": "你是中文品牌舆情分析员。必须综合帖子正文和评论区，只依据输入内容，严格输出一个有效 JSON 对象，不要 Markdown，不要编造。"},
            {"role": "user", "content": "总结这篇小红书帖子正文与评论区。输出结构：%s。输入：%s" % (
                json.dumps(schema, ensure_ascii=False),
                json.dumps({"note_id": note_id, "title": title, "content": content,
                            "tags": note.get("tags") or [], "comments": compact_comments}, ensure_ascii=False)
            )},
        ]
        summary_settings = dict(settings)
        summary_settings["max_tokens"] = min(8192, max(2600, int(settings.get("max_tokens") or 1800)))
        result = self._normalized_note_summary(self.ai_client.complete_json(summary_settings, messages))
        timestamp = now_iso()
        with self.lock, self._session() as db:
            db.execute(
                """INSERT INTO note_summaries(note_id,model,result_json,comment_count,created_at,updated_at)
                   VALUES(?,?,?,?,?,?) ON CONFLICT(note_id) DO UPDATE SET model=excluded.model,
                   result_json=excluded.result_json,comment_count=excluded.comment_count,updated_at=excluded.updated_at""",
                (note_id, settings["model"], json.dumps(result, ensure_ascii=False), len(compact_comments), timestamp, timestamp),
            )
        return {"ok": True, "found": True, "noteId": note_id, "model": settings["model"],
                "commentCount": len(compact_comments), "updatedAt": timestamp, "summary": result}

    def suggest_comment_reply(self, payload: dict[str, Any]) -> dict[str, Any]:
        note = payload.get("note") if isinstance(payload.get("note"), dict) else {}
        target = payload.get("targetComment") if isinstance(payload.get("targetComment"), dict) else {}
        comments = payload.get("comments") if isinstance(payload.get("comments"), list) else []
        note_id = valid_note_id(note.get("noteId") or payload.get("noteId"))
        if not note_id:
            raise ValueError("noteId is required")
        target_id = text(target.get("commentId") or target.get("comment_id"), 256)
        target_content = text(target.get("content"), 2000)
        if not target_id or not target_content:
            raise ValueError("目标评论不完整")
        persona = text(payload.get("persona"), 30).lower()
        if persona not in {"brand", "community"}:
            persona = "brand"
        compact_comments: list[dict[str, Any]] = []
        total_chars = 0
        for item in comments[:300]:
            if not isinstance(item, dict):
                continue
            body = text(item.get("content"), 600)
            if not body:
                continue
            total_chars += len(body)
            if total_chars > 42000:
                break
            compact_comments.append({
                "comment_id": text(item.get("commentId") or item.get("comment_id"), 256),
                "parent_comment_id": text(item.get("parentCommentId") or item.get("parent_comment_id"), 256),
                "author": text(item.get("author"), 120), "content": body,
                "is_author": bool(item.get("isAuthor") or item.get("is_author")),
            })
        settings = self.ai_settings.get(True)
        if not settings.get("configured"):
            raise AIServiceError("DeepSeek API Key 未配置", "not_configured", False)
        parent_id = text(target.get("parentCommentId") or target.get("parent_comment_id"), 256)
        parent_comment = next((item for item in compact_comments if item["comment_id"] == parent_id), None)
        intent, sentiment = classify_reply_context(target_content)
        with self.lock, self._session() as db:
            recent_replies = [row["generated_reply"] for row in db.execute(
                "SELECT generated_reply FROM reply_generation_history WHERE persona=? ORDER BY id DESC LIMIT 50",
                (persona,),
            ).fetchall()]
        persona_instruction = (
            "你代表ORIGANI品牌官方账号。只回应用户当前问题，不把评论写成广告。"
            if persona == "brand" else
            "你是普通社区用户。自然接话，但不冒充消费者，不虚构购买、使用、门店经历或品牌内幕。"
        )
        brand_rules = """
品牌方硬规则：
1. 每条20—60个汉字，最多2句话；第一句回应具体问题或感受，第二句只给一个可核实信息、核实动作或处理路径。
2. 每条单独创作，不复用固定开头结尾。用户说贵、被推销、不舒服、失望时，禁止写“感谢认可与喜爱”。
3. 不主动追加优惠、活动、渠道预告、到店邀请或品牌介绍；不提淘宝、微信、手机号、二维码和站外联系方式。
4. 禁止“有效抗衰老、促进代谢、绝对安全、保证有效、最好、顶级”等功效保证或绝对化表述。
5. 成分、价格、门店、赠品不确定时，请用户补充产品名、门店和日期，或明确说明需要核对。
6. 默认不用“宝宝”；emoji最多1个，投诉和负面评论不用emoji。
7. 不争辩、不教育用户、不为销售行为辩解，不生成统一营销尾巴。
""" if persona == "brand" else """
社区身份硬规则：每条12—70字、最多2句话；不冒充购买或使用经历，不虚构价格、成分、门店和功效，不导流，不替品牌保证，不生成统一种草尾巴。
"""
        schema = {
            "need": "目标评论真正想获得什么，20字内", "intent": intent, "sentiment": sentiment,
            "candidates": [{"reply": "候选回复", "style": "直答/共情/轻松", "why": "回复策略", "risk_notes": []}],
            "risk_notes": ["需要人工核实的事实"]
        }
        context = {
            "post": {"title": text(note.get("title"), 1000), "content": text(note.get("content"), 16000), "tags": note.get("tags") or []},
            "target_comment": target, "parent_comment": parent_comment, "all_comments": compact_comments,
            "detected_intent": intent, "detected_sentiment": sentiment,
        }
        system = "你是小红书官方评论编辑。准确接话，克制具体，降低重复营销导致的折叠风险。只输出有效JSON对象，不要Markdown。"
        base_user = "%s\n\n%s\n生成3条措辞和句式明显不同的候选。输出结构：%s。输入：%s" % (
            persona_instruction, brand_rules.strip(), json.dumps(schema, ensure_ascii=False), json.dumps(context, ensure_ascii=False)
        )
        reply_settings = dict(settings)
        reply_settings["max_tokens"] = min(4096, max(1400, int(settings.get("max_tokens") or 1800)))

        def normalize(raw: dict[str, Any], comparison_pool: list[str]) -> tuple[list[dict[str, Any]], list[str]]:
            raw_notes = raw.get("risk_notes") or []
            if not isinstance(raw_notes, list):
                raw_notes = [raw_notes]
            raw_candidates = raw.get("candidates") or []
            if not isinstance(raw_candidates, list):
                raw_candidates = []
            if not raw_candidates and text(raw.get("reply"), 600):
                raw_candidates = [{"reply": raw.get("reply"), "style": raw.get("tone"), "why": raw.get("rationale")}]
            normalized: list[dict[str, Any]] = []
            local_pool = list(comparison_pool)
            for item in raw_candidates[:5]:
                if isinstance(item, str): item = {"reply": item}
                if not isinstance(item, dict): continue
                reply = text(item.get("reply"), 600)
                if not reply: continue
                audit = audit_reply_candidate(reply, target_content, persona, local_pool)
                candidate_notes = item.get("risk_notes") or []
                if not isinstance(candidate_notes, list): candidate_notes = [candidate_notes]
                audit["riskNotes"] = list(dict.fromkeys(audit["riskNotes"] + [text(value, 200) for value in candidate_notes if text(value, 200)]))
                normalized.append({
                    "reply": reply, "style": text(item.get("style"), 60), "why": text(item.get("why"), 500), **audit
                })
                local_pool.append(reply)
            return normalized, [text(value, 300) for value in raw_notes if text(value, 300)][:6]

        first_raw = self.ai_client.complete_json(reply_settings, [{"role": "system", "content": system}, {"role": "user", "content": base_user}])
        first_candidates, global_notes = normalize(first_raw, recent_replies)
        accepted = [item for item in first_candidates if item["riskLevel"] != "high"]
        rejected = [item for item in first_candidates if item["riskLevel"] == "high"]
        if len(accepted) < 3:
            problems = [f"{item['reply']} -> {'；'.join(item['riskNotes'])}" for item in rejected]
            rewrite_user = base_user + "\n\n以下候选未通过本地审查，请避开相同问题并全部重写：\n" + "\n".join(problems or ["候选数量不足或相似度过高"])
            try:
                second_raw = self.ai_client.complete_json(reply_settings, [{"role": "system", "content": system}, {"role": "user", "content": rewrite_user}])
                second_candidates, second_notes = normalize(second_raw, recent_replies + [item["reply"] for item in accepted])
                global_notes.extend(second_notes)
                for item in second_candidates:
                    if item["riskLevel"] != "high" and all(item["reply"] != existing["reply"] for existing in accepted):
                        accepted.append(item)
                    if len(accepted) >= 3: break
            except Exception:
                pass
        final_candidates = accepted[:3]
        if not final_candidates:
            final_candidates = sorted(first_candidates, key=lambda item: item["riskScore"])[:1]
        if not final_candidates:
            raise AIServiceError("DeepSeek 未返回回复文本", "invalid_response", True)
        timestamp = now_iso()
        with self.lock, self._session() as db:
            for item in final_candidates:
                db.execute("""
                    INSERT INTO reply_generation_history
                    (note_id, comment_id, persona, intent, generated_reply, risk_level, risk_score, similarity_score, risk_notes, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (note_id, target_id, persona, intent, item["reply"], item["riskLevel"], item["riskScore"],
                      item["similarityScore"], json.dumps(item["riskNotes"], ensure_ascii=False), timestamp))
        first = final_candidates[0]
        result = {
            "need": text(first_raw.get("need"), 300), "intent": intent, "sentiment": sentiment,
            "candidates": final_candidates, "reply": first["reply"], "rationale": first.get("why", ""),
            "tone": first.get("style", ""), "riskNotes": list(dict.fromkeys(global_notes + first["riskNotes"]))[:8],
        }
        return {"ok": True, "noteId": note_id, "commentId": target_id, "persona": persona,
                "model": settings["model"], "suggestion": result}

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

    def start_sync_run(self, payload: dict[str, Any]) -> dict[str, Any]:
        run_type = text(payload.get("runType"), 40) or "single"
        if run_type not in {"single", "batch", "repair"}:
            raise ValueError("runType must be single, batch or repair")
        timestamp = now_iso()
        with self.lock, self._session() as db:
            cursor = db.execute(
                """INSERT INTO sync_runs(run_type,status,total_notes,detail_json,started_at)
                   VALUES (?,'running',?,?,?)""",
                (
                    run_type,
                    max(0, int(payload.get("totalNotes") or 0)),
                    json.dumps(payload.get("detail") or {}, ensure_ascii=False),
                    timestamp,
                ),
            )
            run_id = int(cursor.lastrowid)
        return {"ok": True, "runId": run_id, "startedAt": timestamp}

    def finish_sync_run(self, payload: dict[str, Any]) -> dict[str, Any]:
        run_id = max(0, int(payload.get("runId") or 0))
        if not run_id:
            raise ValueError("runId is required")
        status = text(payload.get("status"), 30) or "completed"
        if status not in {"completed", "cancelled", "failed", "partial"}:
            raise ValueError("无效的同步状态")
        finished_at = now_iso()
        values = {
            "processed_notes": max(0, int(payload.get("processedNotes") or 0)),
            "changed_notes": max(0, int(payload.get("changedNotes") or 0)),
            "unchanged_notes": max(0, int(payload.get("unchangedNotes") or 0)),
            "failed_notes": max(0, int(payload.get("failedNotes") or 0)),
            "new_comments": max(0, int(payload.get("newComments") or 0)),
            "removed_comments": max(0, int(payload.get("removedComments") or 0)),
            "changed_comments": max(0, int(payload.get("changedComments") or 0)),
        }
        with self.lock, self._session() as db:
            updated = db.execute(
                """UPDATE sync_runs SET status=?,processed_notes=?,changed_notes=?,unchanged_notes=?,
                   failed_notes=?,new_comments=?,removed_comments=?,changed_comments=?,detail_json=?,finished_at=?
                   WHERE id=?""",
                (
                    status, values["processed_notes"], values["changed_notes"], values["unchanged_notes"],
                    values["failed_notes"], values["new_comments"], values["removed_comments"],
                    values["changed_comments"], json.dumps(payload.get("detail") or {}, ensure_ascii=False),
                    finished_at, run_id,
                ),
            ).rowcount
        if not updated:
            raise ValueError("同步批次不存在")
        return {"ok": True, "runId": run_id, "status": status, "finishedAt": finished_at, **values}

    def _record_comment_change_events(
        self,
        note_id: str,
        comparison: dict[str, Any],
        note_title: str = "",
        run_id: int = 0,
    ) -> dict[str, Any]:
        total = int(comparison.get("newCount") or 0) + int(comparison.get("removedCount") or 0) + int(comparison.get("changedCount") or 0)
        if not total:
            return {"runId": run_id, "eventCount": 0}
        timestamp = now_iso()
        with self.lock, self._session() as db:
            if run_id:
                exists = db.execute("SELECT 1 FROM sync_runs WHERE id=?", (run_id,)).fetchone()
                if not exists:
                    run_id = 0
            if not run_id:
                cursor = db.execute(
                    """INSERT INTO sync_runs(run_type,status,total_notes,processed_notes,changed_notes,
                       new_comments,removed_comments,changed_comments,started_at,finished_at)
                       VALUES ('single','completed',1,1,1,?,?,?,?,?)""",
                    (
                        int(comparison.get("newCount") or 0),
                        int(comparison.get("removedCount") or 0),
                        int(comparison.get("changedCount") or 0),
                        timestamp, timestamp,
                    ),
                )
                run_id = int(cursor.lastrowid)

            def add_event(event_type: str, target: dict[str, Any], before: Any, after: Any, verb: str) -> None:
                target_id = text(target.get("commentId"), 256)
                author = text(target.get("author"), 120) or "匿名用户"
                content = text(target.get("content"), 180)
                summary = f"{verb} · {author}：{content or '无文本'}"
                db.execute(
                    """INSERT INTO change_events
                       (run_id,note_id,event_type,target_id,title,summary,before_json,after_json,created_at)
                       VALUES (?,?,?,?,?,?,?,?,?)""",
                    (
                        run_id, note_id, event_type, target_id, text(note_title, 1000), text(summary, 1000),
                        json.dumps(before or {}, ensure_ascii=False),
                        json.dumps(after or {}, ensure_ascii=False), timestamp,
                    ),
                )

            for item in comparison.get("newComments") or []:
                if isinstance(item, dict):
                    add_event("comment_added", item, {}, item, "新增评论")
            for item in comparison.get("removedComments") or []:
                if isinstance(item, dict):
                    add_event("comment_removed", item, item, {}, "评论已删除")
            for item in comparison.get("changedComments") or []:
                if not isinstance(item, dict):
                    continue
                before = item.get("before") if isinstance(item.get("before"), dict) else {}
                after = item.get("after") if isinstance(item.get("after"), dict) else {}
                add_event("comment_changed", after or before, before, after, "评论已修改")
        return {"runId": run_id, "eventCount": total}

    def _record_note_change_event(
        self,
        note_id: str,
        changes: list[dict[str, Any]],
        note_title: str = "",
        run_id: int = 0,
    ) -> dict[str, Any]:
        if not changes:
            return {"runId": run_id, "eventCount": 0}
        timestamp = now_iso()
        with self.lock, self._session() as db:
            if run_id and not db.execute("SELECT 1 FROM sync_runs WHERE id=?", (run_id,)).fetchone():
                run_id = 0
            if not run_id:
                cursor = db.execute(
                    """INSERT INTO sync_runs(run_type,status,total_notes,processed_notes,changed_notes,
                       started_at,finished_at) VALUES ('single','completed',1,1,1,?,?)""",
                    (timestamp, timestamp),
                )
                run_id = int(cursor.lastrowid)
            labels = [text(item.get("label"), 40) for item in changes if text(item.get("label"), 40)]
            before = {text(item.get("field"), 60): item.get("before") for item in changes}
            after = {text(item.get("field"), 60): item.get("after") for item in changes}
            db.execute(
                """INSERT INTO change_events
                   (run_id,note_id,event_type,title,summary,before_json,after_json,created_at)
                   VALUES (?,?,?,?,?,?,?,?)""",
                (
                    run_id, note_id, "note_fields_changed", text(note_title, 1000),
                    text("帖子字段变化：" + "、".join(labels), 1000),
                    json.dumps(before, ensure_ascii=False), json.dumps(after, ensure_ascii=False), timestamp,
                ),
            )
        return {"runId": run_id, "eventCount": 1}

    def list_change_events(self, limit: int = 100, unread_only: bool = False) -> dict[str, Any]:
        limit = max(1, min(int(limit or 100), 500))
        where = "WHERE e.acknowledged=0" if unread_only else ""
        with self.lock, self._session() as db:
            rows = db.execute(
                f"""SELECT e.*,n.url,n.author,w.priority AS watch_priority
                    FROM change_events e
                    LEFT JOIN notes n ON n.note_id=e.note_id
                    LEFT JOIN watchlist w ON w.note_id=e.note_id
                    {where}
                    ORDER BY e.created_at DESC,e.id DESC LIMIT ?""",
                (limit,),
            ).fetchall()
            unread = int(db.execute("SELECT COUNT(*) FROM change_events WHERE acknowledged=0").fetchone()[0])
            total = int(db.execute("SELECT COUNT(*) FROM change_events").fetchone()[0])
            counts = db.execute(
                "SELECT event_type,COUNT(*) count FROM change_events GROUP BY event_type"
            ).fetchall()
        events: list[dict[str, Any]] = []
        for row in rows:
            item = dict(row)
            for key in ("before_json", "after_json"):
                try:
                    item[key.removesuffix("_json")] = json.loads(item.get(key) or "{}")
                except (TypeError, ValueError):
                    item[key.removesuffix("_json")] = {}
            events.append(item)
        return {
            "ok": True,
            "events": events,
            "unread": unread,
            "total": total,
            "byType": {str(row["event_type"]): int(row["count"]) for row in counts},
        }

    def acknowledge_change_events(self, payload: dict[str, Any]) -> dict[str, Any]:
        raw_ids = payload.get("ids") if isinstance(payload.get("ids"), list) else []
        ids = sorted({int(value) for value in raw_ids if str(value).isdigit() and int(value) > 0})
        with self.lock, self._session() as db:
            if payload.get("all"):
                updated = db.execute("UPDATE change_events SET acknowledged=1 WHERE acknowledged=0").rowcount
            elif ids:
                placeholders = ",".join("?" for _ in ids)
                updated = db.execute(
                    f"UPDATE change_events SET acknowledged=1 WHERE id IN ({placeholders})", ids
                ).rowcount
            else:
                updated = 0
        return {"ok": True, "updated": int(updated or 0)}

    def set_watchlist(self, payload: dict[str, Any]) -> dict[str, Any]:
        note_id = valid_note_id(payload.get("noteId"))
        if not note_id:
            raise ValueError("noteId is required")
        watched = payload.get("watched") is not False
        priority = text(payload.get("priority"), 20) or "normal"
        if priority not in {"high", "normal", "low"}:
            raise ValueError("priority must be high, normal or low")
        timestamp = now_iso()
        with self.lock, self._session() as db:
            if not db.execute("SELECT 1 FROM notes WHERE note_id=?", (note_id,)).fetchone():
                raise ValueError("请先扫描或拉取该帖子，再加入观察名单")
            if watched:
                db.execute(
                    """INSERT INTO watchlist(note_id,priority,reason,created_at,updated_at)
                       VALUES (?,?,?,?,?)
                       ON CONFLICT(note_id) DO UPDATE SET priority=excluded.priority,
                       reason=excluded.reason,updated_at=excluded.updated_at""",
                    (note_id, priority, text(payload.get("reason"), 1000), timestamp, timestamp),
                )
            else:
                db.execute("DELETE FROM watchlist WHERE note_id=?", (note_id,))
        return {"ok": True, "noteId": note_id, "watched": watched, "priority": priority, "updatedAt": timestamp}

    def list_watchlist(self, limit: int = 200) -> dict[str, Any]:
        limit = max(1, min(int(limit or 200), 500))
        with self.lock, self._session() as db:
            rows = db.execute(
                """SELECT w.*,n.title,n.author,n.url,n.status,n.pull_status,n.access_status,
                   n.comment_count_collected,n.last_comment_collected_at,
                   (SELECT MAX(created_at) FROM change_events e WHERE e.note_id=w.note_id) AS last_change_at,
                   (SELECT COUNT(*) FROM change_events e WHERE e.note_id=w.note_id AND e.acknowledged=0) AS unread_changes
                   FROM watchlist w JOIN notes n ON n.note_id=w.note_id
                   ORDER BY CASE w.priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
                   COALESCE(last_change_at,w.updated_at) DESC LIMIT ?""",
                (limit,),
            ).fetchall()
        return {"ok": True, "count": len(rows), "items": [dict(row) for row in rows]}

    def data_health(self) -> dict[str, Any]:
        issues: list[dict[str, Any]] = []

        def add_issue(issue_id: str, severity: str, title: str, detail: str, count: int = 1,
                      repairable: bool = False, samples: list[str] | None = None) -> None:
            if count <= 0:
                return
            issues.append({
                "id": issue_id, "severity": severity, "title": title, "detail": detail,
                "count": int(count), "repairable": bool(repairable), "samples": (samples or [])[:8],
            })

        with self.lock, self._session() as db:
            note_rows = [dict(row) for row in db.execute(
                """SELECT note_id,title,url,source,pull_status,media_status,media_dir,media_file_count,
                   comment_count_collected,access_status FROM notes"""
            ).fetchall()]
            db_note_ids = {row["note_id"] for row in note_rows}
            pulled_ids = {
                row["note_id"] for row in note_rows
                if row["source"] == "existing_xlsx" or row["pull_status"] in {"synced", "partial"}
            }
            db_comment_count = int(db.execute("SELECT COUNT(*) FROM comments").fetchone()[0])
            actual_comment_counts = {
                str(row["note_id"]): int(row["count"])
                for row in db.execute("SELECT note_id,COUNT(*) count FROM comments GROUP BY note_id").fetchall()
            }
            orphan_comments = int(db.execute(
                "SELECT COUNT(*) FROM comments c LEFT JOIN notes n ON n.note_id=c.note_id WHERE n.note_id IS NULL"
            ).fetchone()[0])
            orphan_watch = int(db.execute(
                "SELECT COUNT(*) FROM watchlist w LEFT JOIN notes n ON n.note_id=w.note_id WHERE n.note_id IS NULL"
            ).fetchone()[0])

        mismatched_counts = [
            row["note_id"] for row in note_rows
            if int(row.get("comment_count_collected") or 0) != actual_comment_counts.get(row["note_id"], 0)
        ]
        missing_core = [
            row["note_id"] for row in note_rows
            if row["note_id"] in pulled_ids and (not text(row.get("title"), 1000) or not text(row.get("url"), 4000))
        ]
        missing_media = []
        pending_media = []
        for row in note_rows:
            if int(row.get("media_file_count") or 0) <= 0:
                continue
            folder = text(row.get("media_dir"), 4000)
            try:
                exists = bool(folder and Path(folder).is_dir())
            except OSError:
                exists = False
            if not exists:
                (pending_media if row.get("media_status") == "partial" else missing_media).append(row["note_id"])
        review_access = [row["note_id"] for row in note_rows if row.get("access_status") == "check_failed"]

        add_issue("orphan_comments", "critical", "存在孤立评论", "评论在 SQLite 中找不到所属帖子。", orphan_comments, False)
        add_issue("comment_count_mismatch", "warning", "评论计数不一致", "帖子计数与实际 SQLite 评论数量不同。",
                  len(mismatched_counts), True, mismatched_counts)
        add_issue("missing_core", "warning", "帖子核心字段缺失", "已拉取帖子缺少标题或可用链接。",
                  len(missing_core), False, missing_core)
        add_issue("missing_media", "warning", "素材目录缺失", "数据库记录了素材，但对应目录已经不存在。",
                  len(missing_media), True, missing_media)
        add_issue("media_pending_repair", "info", "素材等待补采", "数据体检已标记素材缺失；下次打开帖子时可补采。",
                  len(pending_media), False, pending_media)
        add_issue("access_review", "info", "帖子等待访问复核", "这些帖子上次未完成访问核验，不等于打不开。",
                  len(review_access), False, review_access)
        add_issue("orphan_watchlist", "warning", "观察名单存在失效引用", "观察名单关联的帖子已经不在数据库中。",
                  orphan_watch, True)

        xlsx_path = Path(self.seed_xlsx_path) if self.seed_xlsx_path else None
        excel_note_ids: list[str] = []
        excel_comment_rows = 0
        if not xlsx_path or not xlsx_path.exists():
            add_issue("excel_missing", "critical", "Excel 总表不存在", "当前配置路径下没有找到 Excel 总表。", 1, False)
        else:
            try:
                from openpyxl import load_workbook
                workbook = load_workbook(xlsx_path, read_only=True, data_only=True)
                try:
                    if "sheet1_笔记总表" not in workbook.sheetnames or "sheet2_评论总表" not in workbook.sheetnames:
                        add_issue("excel_schema", "critical", "Excel 工作表结构不完整", "缺少帖子总表或评论总表。", 1, False)
                    else:
                        note_sheet = workbook["sheet1_笔记总表"]
                        note_headers = self._excel_headers(note_sheet)
                        note_col = note_headers.get("笔记ID")
                        if not note_col:
                            add_issue("excel_note_id_column", "critical", "Excel 缺少笔记ID列", "无法可靠对齐帖子。", 1, False)
                        else:
                            excel_note_ids = [
                                valid_note_id(note_sheet.cell(row, note_col).value)
                                for row in range(2, note_sheet.max_row + 1)
                            ]
                            excel_note_ids = [value for value in excel_note_ids if value]
                        comment_sheet = workbook["sheet2_评论总表"]
                        excel_comment_rows = max(0, comment_sheet.max_row - 1)
                finally:
                    workbook.close()
            except Exception as exc:
                add_issue("excel_read", "critical", "Excel 总表读取失败", text(exc, 500), 1, False)

        excel_note_set = set(excel_note_ids)
        duplicate_excel = len(excel_note_ids) - len(excel_note_set)
        missing_excel = sorted(pulled_ids - excel_note_set)
        excel_only = sorted(excel_note_set - db_note_ids)
        add_issue("excel_duplicate_notes", "critical", "Excel 存在重复帖子行", "同一笔记 ID 在帖子总表重复出现。",
                  duplicate_excel, False)
        add_issue("pulled_missing_excel", "critical", "已拉取帖子未写入 Excel", "SQLite 标记已拉取，但 Excel 找不到对应帖子行。",
                  len(missing_excel), False, missing_excel)
        add_issue("excel_missing_sqlite", "warning", "Excel 帖子未进入 SQLite", "重新载入 Excel 可修复本地索引。",
                  len(excel_only), True, excel_only)

        weights = {"critical": 24, "warning": 7, "info": 1}
        score = max(0, 100 - sum(weights.get(item["severity"], 1) for item in issues))
        status = "critical" if any(item["severity"] == "critical" for item in issues) \
            else "warning" if any(item["severity"] == "warning" for item in issues) else "healthy"
        return {
            "ok": True, "status": status, "score": score, "checkedAt": now_iso(), "issues": issues,
            "summary": {
                "databaseNotes": len(note_rows), "databaseComments": db_comment_count,
                "excelNotes": len(excel_note_ids), "excelComments": excel_comment_rows,
                "pulledNotes": len(pulled_ids), "issueCount": len(issues),
                "repairableCount": sum(1 for item in issues if item["repairable"]),
            },
        }

    def repair_data_health(self, _payload: dict[str, Any] | None = None) -> dict[str, Any]:
        actions: list[str] = []
        warnings: list[str] = []
        xlsx_path = Path(self.seed_xlsx_path) if self.seed_xlsx_path else None
        if xlsx_path and xlsx_path.exists():
            try:
                inserted = self.seed_from_xlsx(xlsx_path)
                actions.append(f"重新载入 Excel，补充 {inserted} 条本地索引")
            except Exception as exc:
                warnings.append(f"Excel 重载失败：{text(exc, 500)}")
        with self.lock, self._session() as db:
            db.execute(
                """UPDATE notes SET comment_count_collected=(
                   SELECT COUNT(*) FROM comments c WHERE c.note_id=notes.note_id)"""
            )
            actions.append("重算全部帖子评论计数")
            media_rows = db.execute(
                "SELECT note_id,media_dir,media_file_count FROM notes WHERE media_file_count>0"
            ).fetchall()
            media_fixed = 0
            for row in media_rows:
                folder = text(row["media_dir"], 4000)
                try:
                    exists = bool(folder and Path(folder).is_dir())
                except OSError:
                    exists = False
                if not exists:
                    db.execute(
                        "UPDATE notes SET media_status='partial',media_error='数据体检：素材目录缺失' WHERE note_id=?",
                        (row["note_id"],),
                    )
                    media_fixed += 1
            if media_fixed:
                actions.append(f"标记 {media_fixed} 篇素材缺失帖子，等待补采")
            orphan_watch = db.execute(
                "DELETE FROM watchlist WHERE note_id NOT IN (SELECT note_id FROM notes)"
            ).rowcount
            if orphan_watch:
                actions.append(f"清理 {orphan_watch} 条观察名单失效引用")
        try:
            migrated = self.reconcile_legacy_access_statuses()
            if migrated.get("updated"):
                actions.append(f"迁移 {migrated['updated']} 条旧访问状态")
        except Exception as exc:
            warnings.append(f"访问状态 Excel 回写失败：{text(exc, 500)}")
        return {"ok": True, "actions": actions, "warnings": warnings, "health": self.data_health()}

    @staticmethod
    def _report_period(payload: dict[str, Any]) -> tuple[str, str]:
        today = datetime.now().astimezone().date()
        default_start = today - timedelta(days=6)
        start_raw = text(payload.get("startDate"), 10)
        end_raw = text(payload.get("endDate"), 10)
        try:
            start = datetime.strptime(start_raw, "%Y-%m-%d").date() if start_raw else default_start
            end = datetime.strptime(end_raw, "%Y-%m-%d").date() if end_raw else today
        except ValueError as exc:
            raise ValueError("周报日期格式应为 YYYY-MM-DD") from exc
        if end < start:
            raise ValueError("周报结束日期不得早于开始日期")
        if (end - start).days > 31:
            raise ValueError("单次周报范围最多 31 天")
        return start.isoformat(), end.isoformat()

    @staticmethod
    def _safe_report_cell(value: Any) -> Any:
        if not isinstance(value, str):
            return value
        return f"'{value}" if value.startswith(("=", "+", "-", "@")) else value

    def generate_weekly_report(self, payload: dict[str, Any]) -> dict[str, Any]:
        period_start, period_end = self._report_period(payload)
        with self.lock, self._session() as db:
            notes = [dict(row) for row in db.execute(
                """SELECT note_id,title,author,url,keyword,status,pull_status,access_status,
                   comment_count_collected,first_seen_at,last_seen_at
                   FROM notes WHERE is_relevant=1 AND status<>'ignored'
                   AND substr(first_seen_at,1,10) BETWEEN ? AND ?
                   ORDER BY first_seen_at DESC""",
                (period_start, period_end),
            ).fetchall()]
            changes = [dict(row) for row in db.execute(
                """SELECT e.*,n.url FROM change_events e LEFT JOIN notes n ON n.note_id=e.note_id
                   WHERE substr(e.created_at,1,10) BETWEEN ? AND ?
                   ORDER BY e.created_at DESC,e.id DESC""",
                (period_start, period_end),
            ).fetchall()]
            watch_items = [dict(row) for row in db.execute(
                """SELECT w.*,n.title,n.author,n.url,n.access_status,n.comment_count_collected
                   FROM watchlist w JOIN notes n ON n.note_id=w.note_id
                   ORDER BY CASE w.priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,w.updated_at DESC"""
            ).fetchall()]
        event_counts = Counter(item.get("event_type") or "unknown" for item in changes)
        issue_counts: Counter[str] = Counter()
        for item in changes:
            if item.get("event_type") != "comment_added":
                continue
            try:
                after = json.loads(item.get("after_json") or "{}")
                if not isinstance(after, dict):
                    after = {}
            except (TypeError, ValueError):
                after = {}
            content = text(after.get("content"), 8000)
            if content:
                issue_counts[classify_reply_context(content)[0]] += 1
        summary = {
            "periodStart": period_start,
            "periodEnd": period_end,
            "newNotes": len(notes),
            "changedNotes": len({item.get("note_id") for item in changes if item.get("note_id")}),
            "newComments": int(event_counts.get("comment_added", 0)),
            "removedComments": int(event_counts.get("comment_removed", 0)),
            "changedComments": int(event_counts.get("comment_changed", 0)),
            "watchlistCount": len(watch_items),
            "issueCategories": dict(issue_counts.most_common()),
        }
        report_dir = self.export_dir / "weekly_reports"
        report_dir.mkdir(parents=True, exist_ok=True)
        base_name = f"ORIGANI舆情周报_{period_start.replace('-', '')}_{period_end.replace('-', '')}"
        xlsx_path = report_dir / f"{base_name}.xlsx"
        html_path = report_dir / f"{base_name}.html"

        from openpyxl import Workbook
        from openpyxl.styles import Alignment, Font, PatternFill
        from openpyxl.utils import get_column_letter

        workbook = Workbook()
        overview = workbook.active
        overview.title = "周报总览"
        overview.append(["ORIGANI 小红书舆情周报", f"{period_start} 至 {period_end}"])
        overview.append(["指标", "数量"])
        for label, value in (
            ("新增帖子", summary["newNotes"]), ("发生变化帖子", summary["changedNotes"]),
            ("新增评论", summary["newComments"]), ("删除评论", summary["removedComments"]),
            ("修改评论", summary["changedComments"]), ("重点观察", summary["watchlistCount"]),
        ):
            overview.append([label, value])
        overview.append([])
        overview.append(["评论问题分类", "数量"])
        for label, value in issue_counts.most_common():
            overview.append([label, value])

        def add_sheet(name: str, headers: list[str], rows: list[list[Any]]) -> None:
            sheet = workbook.create_sheet(name)
            sheet.append(headers)
            for row in rows:
                sheet.append([self._safe_report_cell(value) for value in row])
            for cell in sheet[1]:
                cell.font = Font(bold=True, color="FFFFFF")
                cell.fill = PatternFill("solid", fgColor="176B56")
            sheet.freeze_panes = "A2"
            for index, header in enumerate(headers, 1):
                values = [len(str(sheet.cell(row, index).value or "")) for row in range(1, min(sheet.max_row, 100) + 1)]
                sheet.column_dimensions[get_column_letter(index)].width = min(60, max(len(header) + 2, max(values, default=8) + 2))
                for row in range(2, sheet.max_row + 1):
                    sheet.cell(row, index).alignment = Alignment(vertical="top", wrap_text=True)

        add_sheet("新增帖子", ["首次发现", "标题", "作者", "来源词", "评论数", "访问状态", "链接", "笔记ID"], [
            [item.get("first_seen_at"), item.get("title"), item.get("author"), item.get("keyword"),
             item.get("comment_count_collected"), item.get("access_status"), item.get("url"), item.get("note_id")]
            for item in notes
        ])
        add_sheet("同步变化", ["时间", "类型", "帖子", "变化内容", "链接", "笔记ID"], [
            [item.get("created_at"), item.get("event_type"), item.get("title"), item.get("summary"),
             item.get("url"), item.get("note_id")]
            for item in changes
        ])
        add_sheet("重点观察", ["优先级", "帖子", "作者", "观察原因", "评论数", "访问状态", "链接", "笔记ID"], [
            [item.get("priority"), item.get("title"), item.get("author"), item.get("reason"),
             item.get("comment_count_collected"), item.get("access_status"), item.get("url"), item.get("note_id")]
            for item in watch_items
        ])
        overview["A1"].font = Font(size=16, bold=True, color="176B56")
        overview.column_dimensions["A"].width = 24
        overview.column_dimensions["B"].width = 24
        temporary_xlsx = xlsx_path.with_name(f".{xlsx_path.stem}.{os.getpid()}.tmp.xlsx")
        workbook.save(temporary_xlsx)
        workbook.close()
        os.replace(temporary_xlsx, xlsx_path)

        def table_rows(items: list[dict[str, Any]], columns: list[tuple[str, str]]) -> str:
            rendered = []
            for item in items:
                cells = "".join(f"<td>{html.escape(str(item.get(key) or ''))}</td>" for key, _label in columns)
                rendered.append(f"<tr>{cells}</tr>")
            return "".join(rendered) or f"<tr><td colspan='{len(columns)}'>本周期暂无记录</td></tr>"

        change_columns = [("created_at", "时间"), ("title", "帖子"), ("summary", "变化")]
        watch_columns = [("priority", "级别"), ("title", "帖子"), ("reason", "原因")]
        issue_html = "".join(
            f"<li><span>{html.escape(label)}</span><strong>{count}</strong></li>" for label, count in issue_counts.most_common()
        ) or "<li><span>暂无分类评论</span><strong>0</strong></li>"
        html_text = f"""<!doctype html><html lang='zh-CN'><head><meta charset='utf-8'>
<title>{html.escape(base_name)}</title><style>
body{{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif;margin:0;background:#f5f5f7;color:#1d1d1f}}
main{{max-width:1080px;margin:32px auto;padding:0 20px}}header{{background:#173f35;color:white;padding:32px;border-radius:22px}}
h1{{margin:6px 0 0;font-size:30px}}.meta{{opacity:.72}}.grid{{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:18px 0}}
.metric,section{{background:white;border:1px solid #e5e5e7;border-radius:18px;padding:18px}}.metric strong{{display:block;font-size:28px;color:#176b56}}
section{{margin-top:14px}}table{{width:100%;border-collapse:collapse}}th,td{{text-align:left;padding:10px;border-bottom:1px solid #eee;vertical-align:top}}
th{{font-size:12px;color:#6e6e73}}ul{{padding:0;list-style:none}}li{{display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid #eee}}
@media(max-width:720px){{.grid{{grid-template-columns:repeat(2,1fr)}}}}
</style></head><body><main><header><div class='meta'>ORIGANI RADAR · WEEKLY BRIEF</div><h1>小红书舆情周报</h1><p>{period_start} 至 {period_end}</p></header>
<div class='grid'>
<div class='metric'><span>新增帖子</span><strong>{summary['newNotes']}</strong></div>
<div class='metric'><span>发生变化帖子</span><strong>{summary['changedNotes']}</strong></div>
<div class='metric'><span>新增评论</span><strong>{summary['newComments']}</strong></div>
<div class='metric'><span>删除评论</span><strong>{summary['removedComments']}</strong></div>
<div class='metric'><span>修改评论</span><strong>{summary['changedComments']}</strong></div>
<div class='metric'><span>重点观察</span><strong>{summary['watchlistCount']}</strong></div></div>
<section><h2>评论问题分类</h2><ul>{issue_html}</ul></section>
<section><h2>同步变化</h2><table><thead><tr>{''.join(f'<th>{label}</th>' for _key,label in change_columns)}</tr></thead><tbody>{table_rows(changes[:80], change_columns)}</tbody></table></section>
<section><h2>重点观察</h2><table><thead><tr>{''.join(f'<th>{label}</th>' for _key,label in watch_columns)}</tr></thead><tbody>{table_rows(watch_items, watch_columns)}</tbody></table></section>
</main></body></html>"""
        temporary_html = html_path.with_name(f".{html_path.stem}.{os.getpid()}.tmp.html")
        temporary_html.write_text(html_text, encoding="utf-8")
        os.replace(temporary_html, html_path)

        generated_at = now_iso()
        with self.lock, self._session() as db:
            db.execute(
                """INSERT INTO weekly_reports(period_start,period_end,xlsx_path,html_path,summary_json,generated_at)
                   VALUES (?,?,?,?,?,?) ON CONFLICT(period_start,period_end) DO UPDATE SET
                   xlsx_path=excluded.xlsx_path,html_path=excluded.html_path,
                   summary_json=excluded.summary_json,generated_at=excluded.generated_at""",
                (period_start, period_end, str(xlsx_path), str(html_path), json.dumps(summary, ensure_ascii=False), generated_at),
            )
        return {"ok": True, "summary": summary, "xlsxPath": str(xlsx_path), "htmlPath": str(html_path), "generatedAt": generated_at}

    def latest_weekly_report(self) -> dict[str, Any]:
        with self.lock, self._session() as db:
            row = db.execute("SELECT * FROM weekly_reports ORDER BY generated_at DESC,id DESC LIMIT 1").fetchone()
        if not row:
            return {"ok": True, "found": False}
        item = dict(row)
        try:
            summary = json.loads(item.get("summary_json") or "{}")
        except (TypeError, ValueError):
            summary = {}
        return {"ok": True, "found": True, "report": {**item, "summary": summary}}

    def open_weekly_report(self, payload: dict[str, Any]) -> dict[str, Any]:
        latest = self.latest_weekly_report()
        if not latest.get("found"):
            raise ValueError("尚未生成周报")
        report = latest["report"]
        target_type = text(payload.get("target"), 20) or "html"
        report_root = (self.export_dir / "weekly_reports").resolve()
        if target_type == "folder":
            target = report_root
        elif target_type == "excel":
            target = Path(report.get("xlsx_path") or "").resolve()
        else:
            target = Path(report.get("html_path") or "").resolve()
        if target != report_root and report_root not in target.parents:
            raise ValueError("周报路径不在允许范围内")
        if not target.exists():
            raise ValueError("周报文件不存在，请重新生成")
        os.startfile(str(target))  # type: ignore[attr-defined]
        return {"ok": True, "target": str(target), "kind": target_type}

    @staticmethod
    def _excel_headers(worksheet: Any) -> dict[str, int]:
        return {
            str(cell.value).strip(): int(cell.column)
            for cell in worksheet[1]
            if cell.value is not None and str(cell.value).strip()
        }

    @staticmethod
    def _ensure_excel_header(worksheet: Any, name: str) -> int:
        """Add one styled header and keep existing Excel tables covering it."""
        from openpyxl.utils.cell import get_column_letter, range_boundaries

        headers = MonitorStore._excel_headers(worksheet)
        if name in headers:
            return headers[name]
        column = worksheet.max_column + 1
        source = worksheet.cell(1, max(1, column - 1))
        target = worksheet.cell(1, column)
        target.value = name
        if source.has_style:
            target._style = copy(source._style)
        if source.alignment:
            target.alignment = copy(source.alignment)
        previous_letter = get_column_letter(max(1, column - 1))
        target_letter = get_column_letter(column)
        previous_width = worksheet.column_dimensions[previous_letter].width
        worksheet.column_dimensions[target_letter].width = previous_width or 14
        for table in worksheet.tables.values():
            min_col, min_row, max_col, max_row = range_boundaries(table.ref)
            if column > max_col:
                table.ref = (
                    f"{get_column_letter(min_col)}{min_row}:"
                    f"{get_column_letter(column)}{max_row}"
                )
        return column

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
    def _video_extension(url: str, content_type: str = "") -> str:
        suffix = Path(urlparse(url).path).suffix.lower()
        if suffix in {".mp4", ".m4v", ".mov", ".webm", ".ts"}:
            return suffix
        mime = (content_type or "").split(";", 1)[0].strip().lower()
        guessed = mimetypes.guess_extension(mime) or ".mp4"
        return guessed if guessed in {".mp4", ".m4v", ".mov", ".webm", ".ts"} else ".mp4"

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
        skipped_files: list[str] = []
        metadata_path = folder / "note.json"
        previous: dict[str, Any] = {}
        if metadata_path.is_file():
            try:
                loaded = json.loads(metadata_path.read_text(encoding="utf-8"))
                previous = loaded if isinstance(loaded, dict) else {}
            except (OSError, ValueError, json.JSONDecodeError):
                previous = {}
        image_urls = []
        for value in note.get("imageUrls") or []:
            raw = text(value, 4000)
            if not raw or raw in image_urls:
                continue
            image_urls.append(raw)
        image_urls = image_urls[:32]
        video_urls = []
        for value in note.get("videoUrls") or []:
            raw = text(value, 8000)
            if not raw or raw in video_urls or raw.startswith("blob:"):
                continue
            video_urls.append(raw)
        video_urls = video_urls[:8]

        def existing_for(kind: str, url: str, previous_urls: list[str], current_index: int) -> str:
            try:
                old_index = previous_urls.index(url) + 1
            except ValueError:
                return ""
            candidates = sorted(folder.glob(f"{kind}-{old_index:02d}.*"))
            for candidate in candidates:
                try:
                    if candidate.is_file() and candidate.stat().st_size > 0 and not candidate.name.endswith(".part"):
                        desired = folder / f"{kind}-{current_index:02d}{candidate.suffix.lower()}"
                        if desired != candidate:
                            os.replace(candidate, desired)
                            candidate = desired
                        return candidate.name
                except OSError:
                    continue
            return ""

        previous_image_urls = [text(value, 4000) for value in previous.get("imageUrls") or [] if text(value, 4000)]
        previous_video_urls = [text(value, 8000) for value in previous.get("videoUrls") or [] if text(value, 8000)]
        # Remove only files managed by an earlier manifest and no longer
        # belonging to this post. This cleans the old avatar-as-material bug
        # without touching user-created files in the material directory.
        for kind, old_urls, current_urls in (
            ("image", previous_image_urls, image_urls), ("video", previous_video_urls, video_urls)
        ):
            if not current_urls:
                continue
            for old_index, old_url in enumerate(old_urls, 1):
                if old_url in current_urls:
                    continue
                for stale in folder.glob(f"{kind}-{old_index:02d}.*"):
                    try:
                        stale.unlink(missing_ok=True)
                    except OSError:
                        pass

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
                for sibling in folder.glob(f"image-{index:02d}.*"):
                    if sibling != target and not sibling.name.endswith(".part"):
                        sibling.unlink(missing_ok=True)
                return index, target.name, ""
            except Exception as exc:
                try:
                    if temporary is not None:
                        temporary.unlink(missing_ok=True)
                except OSError:
                    pass
                return index, "", f"图片{index}: {text(exc, 300)}"

        download_results: list[tuple[int, str, str]] = []
        image_tasks = []
        for index, image_url in enumerate(image_urls, 1):
            existing = existing_for("image", image_url, previous_image_urls, index)
            if existing:
                files.append(existing)
                skipped_files.append(existing)
            else:
                image_tasks.append((index, image_url))
        if image_tasks:
            worker_count = min(6, len(image_tasks))
            with ThreadPoolExecutor(max_workers=worker_count, thread_name_prefix="xhs-media") as executor:
                futures = [
                    executor.submit(download_one, index, image_url)
                    for index, image_url in image_tasks
                ]
                for future in as_completed(futures):
                    download_results.append(future.result())

        for _index, filename, error in sorted(download_results, key=lambda item: item[0]):
            if filename:
                files.append(filename)
            if error:
                errors.append(error)

        def download_video(index: int, video_url: str) -> tuple[int, str, str]:
            temporary: Path | None = None
            try:
                parsed = urlparse(video_url)
                if parsed.scheme not in {"http", "https"}:
                    raise ValueError("视频链接不是 http(s)")
                request = Request(
                    video_url,
                    headers={
                        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
                        "Accept": "video/mp4,video/webm,video/*;q=0.9,application/octet-stream;q=0.8,*/*;q=0.5",
                        "Referer": "https://www.xiaohongshu.com/",
                        "Origin": "https://www.xiaohongshu.com",
                    },
                )
                target = folder / f"video-{index:02d}{self._video_extension(video_url)}"
                temporary = target.with_name(f".{target.name}.part")
                total = 0
                with urlopen(request, timeout=30) as response, temporary.open("wb") as output:
                    content_type = response.headers.get("Content-Type", "")
                    if content_type.lower().startswith("text/") or "json" in content_type.lower():
                        raise ValueError(f"视频响应类型异常: {content_type}")
                    while True:
                        chunk = response.read(1024 * 1024)
                        if not chunk:
                            break
                        total += len(chunk)
                        if total > 1024 * 1024 * 1024:
                            raise ValueError("视频超过 1GB 限制")
                        output.write(chunk)
                    if total <= 0:
                        raise ValueError("视频响应为空")
                    extension = self._video_extension(video_url, content_type)
                if target.suffix.lower() != extension:
                    target = target.with_suffix(extension)
                os.replace(temporary, target)
                for sibling in folder.glob(f"video-{index:02d}.*"):
                    if sibling != target and not sibling.name.endswith(".part"):
                        sibling.unlink(missing_ok=True)
                return index, target.name, ""
            except Exception as exc:
                try:
                    if temporary is not None:
                        temporary.unlink(missing_ok=True)
                except OSError:
                    pass
                return index, "", f"视频{index}: {text(exc, 300)}"

        video_results: list[tuple[int, str, str]] = []
        video_tasks = []
        for index, video_url in enumerate(video_urls, 1):
            existing = existing_for("video", video_url, previous_video_urls, index)
            if existing:
                files.append(existing)
                skipped_files.append(existing)
            else:
                video_tasks.append((index, video_url))
        if video_tasks:
            worker_count = min(2, len(video_tasks))
            with ThreadPoolExecutor(max_workers=worker_count, thread_name_prefix="xhs-video") as executor:
                futures = [
                    executor.submit(download_video, index, video_url)
                    for index, video_url in video_tasks
                ]
                for future in as_completed(futures):
                    video_results.append(future.result())
        for _index, filename, error in sorted(video_results, key=lambda item: item[0]):
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
            "videoUrls": video_urls,
            "mediaFiles": sorted(set(files)),
            "mediaType": "video" if video_urls else "image",
            "pulledAt": now_iso(),
        }
        metadata_path.write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
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
            "videoCount": len([name for name in files if name.startswith("video-")]),
            "fileCount": len(files),
            "downloadedCount": len(download_results) + len(video_results),
            "skippedCount": len(skipped_files),
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
            self._ensure_excel_header(note_sheet, "访问状态")
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
            # A successful DOM read proves the note is reachable again.
            note_sheet.cell(note_row, note_headers["访问状态"]).value = "可打开"
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
                replace_with_retry(temporary_path, xlsx_path)
            except PermissionError as exc:
                raise ValueError(
                    "WPS/Excel 持续占用总表，写入被拒绝。"
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
            "访问状态",
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

    def set_note_access_statuses(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Persist one sync run's reachability results in one Excel transaction."""
        raw_items = payload.get("items") if isinstance(payload.get("items"), list) else []
        deduplicated: dict[str, dict[str, Any]] = {}
        for raw in raw_items:
            if not isinstance(raw, dict):
                continue
            note_id = valid_note_id(raw.get("noteId"))
            if note_id:
                deduplicated[note_id] = raw
        if not deduplicated:
            raise ValueError("items must contain at least one noteId")

        labels = {"ok": "可打开", "check_failed": "待复核", "unreachable": "打不开", "": ""}
        normalized: list[dict[str, Any]] = []
        for note_id, raw in deduplicated.items():
            requested = text(raw.get("status"), 40).strip().lower()
            if requested == "suspected":
                requested = "check_failed"
            if requested not in labels:
                raise ValueError("status must be ok, check_failed, unreachable or empty")
            check_result = text(raw.get("result"), 80) or {
                "ok": "opened",
                "check_failed": "inconclusive",
                "unreachable": "confirmed_v2",
                "": "",
            }[requested]
            normalized.append({
                "noteId": note_id,
                "status": requested,
                "excelStatus": labels[requested],
                "error": "" if requested == "ok" else text(raw.get("error"), 1000),
                "result": check_result,
                "checkedAt": text(raw.get("checkedAt"), 80) or now_iso(),
            })

        xlsx_path = Path(self.seed_xlsx_path) if self.seed_xlsx_path else None
        if not xlsx_path or not xlsx_path.exists():
            raise ValueError("Excel 总表不存在")

        from openpyxl import load_workbook

        workbook = None
        temporary_path: Path | None = None
        total_rows = 0
        with self.pull_lock:
            try:
                workbook = load_workbook(xlsx_path)
                if "sheet1_笔记总表" not in workbook.sheetnames:
                    raise ValueError("Excel 总表缺少 sheet1_笔记总表")
                sheet = workbook["sheet1_笔记总表"]
                status_column = self._ensure_excel_header(sheet, "访问状态")
                headers = self._excel_headers(sheet)
                note_id_column = headers.get("笔记ID")
                if not note_id_column:
                    raise ValueError("Excel 总表缺少笔记ID列")
                rows_by_id: dict[str, list[int]] = {}
                for row_number in range(2, sheet.max_row + 1):
                    row_id = valid_note_id(sheet.cell(row_number, note_id_column).value)
                    if row_id:
                        rows_by_id.setdefault(row_id, []).append(row_number)
                with self.lock, self._session() as db:
                    for item in normalized:
                        stored = db.execute(
                            "SELECT title,access_status FROM notes WHERE note_id=?", (item["noteId"],)
                        ).fetchone()
                        if not stored:
                            raise ValueError(f"本地数据库中未找到帖子：{item['noteId']}")
                        item["previousStatus"] = text(stored["access_status"], 40)
                        item["title"] = text(stored["title"], 1000)
                        rows = rows_by_id.get(item["noteId"], [])
                        for row_number in rows:
                            sheet.cell(row_number, status_column).value = item["excelStatus"]
                        item["excelRows"] = len(rows)
                        total_rows += len(rows)
                temporary_path = xlsx_path.with_name(
                    f".{xlsx_path.stem}.access-{os.getpid()}-{time.time_ns()}.tmp{xlsx_path.suffix}"
                )
                workbook.save(temporary_path)
                workbook.close()
                workbook = None
                try:
                    replace_with_retry(temporary_path, xlsx_path)
                except PermissionError as exc:
                    raise ValueError("WPS/Excel 持续占用总表，请关闭表格窗口后重试") from exc
                temporary_path = None
                with self.lock, self._session() as db:
                    for item in normalized:
                        db.execute(
                            """UPDATE notes SET access_status=?,access_error=?,last_access_checked_at=?,access_check_result=?
                               WHERE note_id=?""",
                            (item["status"], item["error"], item["checkedAt"], item["result"], item["noteId"]),
                        )
                        previous = item.get("previousStatus") or ""
                        current = item["status"]
                        meaningful = previous != current and bool(
                            previous or current in {"check_failed", "unreachable"}
                        )
                        if meaningful:
                            human = {"": "未核验", "ok": "可打开", "check_failed": "待复核", "unreachable": "打不开"}
                            db.execute(
                                """INSERT INTO change_events
                                   (run_id,note_id,event_type,title,summary,before_json,after_json,created_at)
                                   VALUES (?,?,?,?,?,?,?,?)""",
                                (
                                    max(0, int(payload.get("runId") or 0)), item["noteId"], "access_status_changed",
                                    item.get("title") or "", f"访问状态：{human.get(previous, previous)} → {human.get(current, current)}",
                                    json.dumps({"status": previous}, ensure_ascii=False),
                                    json.dumps({"status": current, "error": item["error"]}, ensure_ascii=False),
                                    item["checkedAt"],
                                ),
                            )
            finally:
                if workbook is not None:
                    workbook.close()
                if temporary_path and temporary_path.exists():
                    try:
                        temporary_path.unlink()
                    except OSError:
                        pass
        by_status: dict[str, int] = {}
        for item in normalized:
            by_status[item["status"]] = by_status.get(item["status"], 0) + 1
        return {"ok": True, "updated": len(normalized), "excelRows": total_rows,
                "byStatus": by_status, "items": normalized}

    def set_note_access_status(self, payload: dict[str, Any]) -> dict[str, Any]:
        result = self.set_note_access_statuses({"items": [payload], "runId": payload.get("runId")})
        item = result["items"][0]
        return {"ok": True, "noteId": item["noteId"], "accessStatus": item["status"],
                "excelStatus": item["excelStatus"], "excelRows": item["excelRows"],
                "checkedAt": item["checkedAt"]}

    def reconcile_legacy_access_statuses(self) -> dict[str, Any]:
        """Downgrade statuses produced by the pre-v0.22.4 loose detector."""
        with self.lock, self._session() as db:
            rows = db.execute(
                """SELECT note_id,access_error FROM notes
                   WHERE access_status='check_failed'
                     AND access_check_result IN ('legacy_untrusted','legacy_excel_unverified')"""
            ).fetchall()
        if not rows:
            return {"ok": True, "updated": 0, "items": []}
        return self.set_note_access_statuses({"items": [
            {"noteId": row["note_id"], "status": "check_failed",
             "result": "legacy_recheck", "error": row["access_error"] or "旧版判定等待重新核验"}
            for row in rows
        ]})

    def list_unreachable_notes(self) -> list[dict[str, Any]]:
        with self.lock, self._session() as db:
            rows = db.execute(
                """SELECT note_id,title,url,access_error,last_access_checked_at
                   FROM notes WHERE access_status='unreachable'
                   ORDER BY last_access_checked_at DESC, first_seen_at DESC"""
            ).fetchall()
        return [dict(row) for row in rows]

    def delete_unreachable_notes(self, _payload: dict[str, Any] | None = None) -> dict[str, Any]:
        """Delete every note marked unreachable, including comments and managed media."""
        targets = self.list_unreachable_notes()
        deleted: list[dict[str, Any]] = []
        failures: list[dict[str, Any]] = []
        for item in targets:
            try:
                result = self.delete_pulled_note({"noteId": item["note_id"]})
                deleted.append({"noteId": item["note_id"], "title": item.get("title") or "", **result})
            except Exception as exc:
                failures.append({
                    "noteId": item["note_id"],
                    "title": item.get("title") or "",
                    "error": text(exc, 1000),
                })
        return {
            "ok": not failures,
            "targetCount": len(targets),
            "deletedCount": len(deleted),
            "failedCount": len(failures),
            "deletedCommentRows": sum(int(item.get("deletedCommentRows", 0) or 0) for item in deleted),
            "deletedDatabaseComments": sum(int(item.get("deletedDatabaseComments", 0) or 0) for item in deleted),
            "deletedLinkedDatabaseRecords": sum(int(item.get("deletedLinkedDatabaseRecords", 0) or 0) for item in deleted),
            "excelVerified": all(bool(item.get("excelVerified")) for item in deleted),
            "databaseVerified": all(bool(item.get("databaseVerified")) for item in deleted),
            "deleted": deleted,
            "failures": failures,
            "error": "；".join(item["error"] for item in failures[:3]),
        }

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
            try:
                for index, resolved_media in enumerate(managed_media_dirs, 1):
                    tombstone = resolved_media.with_name(
                        f".{resolved_media.name}.deleting-{os.getpid()}-{time.time_ns()}-{index}"
                    )
                    resolved_media.rename(tombstone)
                    tombstones.append((resolved_media, tombstone))
            except OSError:
                # If a later sibling is locked, put every directory already
                # moved in this preparation phase back before aborting.
                for original_media, tombstone in reversed(tombstones):
                    if tombstone.exists() and not original_media.exists():
                        tombstone.rename(original_media)
                raise
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

                remaining_note_rows = [
                    row_number for row_number in range(2, note_sheet.max_row + 1)
                    if valid_note_id(note_sheet.cell(row_number, note_id_column).value) == note_id
                ]
                remaining_comment_rows = [
                    row_number for row_number in range(2, comment_sheet.max_row + 1)
                    if (
                        (text(comment_sheet.cell(row_number, comment_id_column).value, 256) in comment_id_set)
                        or (comment_url_column and note_url_identity(comment_sheet.cell(row_number, comment_url_column).value) == note_id)
                    )
                ]
                if remaining_note_rows or remaining_comment_rows:
                    raise ValueError("Excel 清理校验失败，已停止提交以防数据不一致")

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
                    replace_with_retry(temporary_path, xlsx_path)
                except PermissionError as exc:
                    raise ValueError("WPS/Excel 持续占用总表，请关闭表格窗口后重试删除") from exc
                temporary_path = None

                linked_database_records = 0
                with self.lock, self._session() as db:
                    if comment_ids:
                        placeholders = ",".join("?" for _ in comment_ids)
                        linked_database_records += db.execute(
                            f"DELETE FROM ai_jobs WHERE target_type='comment' AND target_id IN ({placeholders})", comment_ids
                        ).rowcount
                        linked_database_records += db.execute(
                            f"DELETE FROM ai_analysis_records WHERE target_type='comment' AND target_id IN ({placeholders})", comment_ids
                        ).rowcount
                    linked_database_records += db.execute(
                        "DELETE FROM ai_jobs WHERE target_type IN ('note','relevance') AND target_id=?", (note_id,)
                    ).rowcount
                    linked_database_records += db.execute(
                        "DELETE FROM ai_analysis_records WHERE target_type IN ('note','relevance') AND target_id=?", (note_id,)
                    ).rowcount
                    linked_database_records += db.execute("DELETE FROM note_summaries WHERE note_id=?", (note_id,)).rowcount
                    linked_database_records += db.execute("DELETE FROM reply_generation_history WHERE note_id=?", (note_id,)).rowcount
                    linked_database_records += db.execute("DELETE FROM comment_collection_jobs WHERE note_id=?", (note_id,)).rowcount
                    linked_database_records += db.execute("DELETE FROM change_events WHERE note_id=?", (note_id,)).rowcount
                    linked_database_records += db.execute("DELETE FROM watchlist WHERE note_id=?", (note_id,)).rowcount
                    deleted_database_comments = db.execute("DELETE FROM comments WHERE note_id=?", (note_id,)).rowcount
                    deleted_database_notes = db.execute("DELETE FROM notes WHERE note_id=?", (note_id,)).rowcount
                    if deleted_database_notes != 1:
                        raise ValueError("SQLite 帖子清理校验失败，已停止提交")
                    remaining_database_rows = sum([
                        db.execute("SELECT COUNT(*) FROM comments WHERE note_id=?", (note_id,)).fetchone()[0],
                        db.execute("SELECT COUNT(*) FROM note_summaries WHERE note_id=?", (note_id,)).fetchone()[0],
                        db.execute("SELECT COUNT(*) FROM reply_generation_history WHERE note_id=?", (note_id,)).fetchone()[0],
                        db.execute("SELECT COUNT(*) FROM comment_collection_jobs WHERE note_id=?", (note_id,)).fetchone()[0],
                        db.execute("SELECT COUNT(*) FROM change_events WHERE note_id=?", (note_id,)).fetchone()[0],
                        db.execute("SELECT COUNT(*) FROM watchlist WHERE note_id=?", (note_id,)).fetchone()[0],
                    ])
                    if remaining_database_rows:
                        raise ValueError("SQLite 关联数据清理校验失败，已停止提交")

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
                    "deletedDatabaseComments": deleted_database_comments,
                    "deletedLinkedDatabaseRecords": linked_database_records,
                    "excelVerified": True,
                    "databaseVerified": True,
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
        with self.pull_lock:
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
                    replace_with_retry(temporary_path, xlsx_path)
                except PermissionError:
                    print(f"[bridge] WPS/Excel 持续占用总表，AI 情绪回写跳过：{xlsx_path}", flush=True)

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
            "videoCount": 0,
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
                    "videoCount": 0,
                    "error": text(exc, 1000),
                }
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
                   excel_sync_path=?, media_status=?, media_dir=?, media_file_count=?, media_error=?,
                   access_status='ok', access_error='', last_access_checked_at=?, access_check_result='opened'
                   WHERE note_id=?""",
                (
                    final_status, final_error, timestamp, timestamp, xlsx_result["path"],
                    media_result.get("status", "failed"), media_result.get("folder", ""),
                    int(media_result.get("fileCount", 0) or 0), text(media_result.get("error"), 1000), timestamp, note_id,
                ),
            )
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
            "imageCount": int(media_result.get("imageCount", 0) or 0),
            "videoCount": int(media_result.get("videoCount", 0) or 0),
            "downloadedMediaCount": int(media_result.get("imageCount", 0) or 0) + int(media_result.get("videoCount", 0) or 0),
            "mediaFileCount": int(media_result.get("fileCount", 0) or 0),
            "mediaDir": media_result.get("folder", ""),
            "mediaFiles": media_result.get("files", []) or [],
            "mediaError": media_result.get("error", ""),
            "pullError": final_error,
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
$sheetName = '{ps_quote(sheet_name)}'
$rowNumber = {excel_row}
$columnNumber = {excel_column}
$openedWith = $null
$errors = @()
foreach ($candidateApp in @(
  @{{ ProgId = 'ket.Application'; Name = 'WPS' }},
  @{{ ProgId = 'Excel.Application'; Name = 'Excel' }}
)) {{
  try {{
    try {{ $app = [Runtime.InteropServices.Marshal]::GetActiveObject($candidateApp.ProgId) }}
    catch {{ $app = New-Object -ComObject $candidateApp.ProgId }}
    $book = $null
    foreach ($candidate in $app.Workbooks) {{
      if ([System.String]::Equals([System.IO.Path]::GetFullPath($candidate.FullName), $path, [System.StringComparison]::OrdinalIgnoreCase)) {{ $book = $candidate; break }}
    }}
    if ($null -ne $book -and -not $book.ReadOnly -and $book.Saved) {{
      $book.Close($false)
      $book = $null
    }}
    if ($null -eq $book) {{ $book = $app.Workbooks.Open($path, 0, $true) }}
    $app.Visible = $true
    $app.WindowState = -4137
    $book.Activate()
    $sheet = $book.Worksheets.Item($sheetName)
    $sheet.Activate()
    $cell = $sheet.Cells.Item($rowNumber, $columnNumber)
    $cell.Select()
    $app.Goto($cell, $true)
    $app.UserControl = $true
    $openedWith = $candidateApp.Name + '|' + [string]$book.ReadOnly
    break
  }} catch {{
    $errors += ($candidateApp.Name + ': ' + $_.Exception.Message)
  }}
}}
if ($null -eq $openedWith) {{ throw ($errors -join ' | ') }}
Write-Output $openedWith
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
            raise ValueError("WPS/Excel 启动超时，请关闭残留的表格弹窗后重试") from error
        if completed.returncode != 0:
            raw_error = completed.stderr or completed.stdout or b""
            try:
                detail = raw_error.decode("utf-16le", errors="ignore").strip()
            except AttributeError:
                detail = str(raw_error).strip()
            detail = detail[-500:] if detail else "WPS/Excel COM 调用失败"
            raise ValueError(f"WPS/Excel 打开失败：{detail}")
        output = (completed.stdout or b"").decode("utf-16le", errors="ignore").strip()
        open_state = next((line.strip() for line in reversed(output.splitlines()) if line.strip().startswith(("WPS|", "Excel|"))), "WPS|True")
        opened_with, _, read_only_text = open_state.partition("|")
        return {
            "ok": True,
            "kind": "excel",
            "application": opened_with,
            "readOnly": read_only_text.casefold() == "true",
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
            elif parsed.path == "/api/notes/unreachable":
                notes = self.store.list_unreachable_notes()
                self._send_json(200, {"ok": True, "count": len(notes), "notes": notes})
            elif parsed.path == "/api/data-health":
                self._send_json(200, self.store.data_health())
            elif parsed.path == "/api/changes":
                query = parse_qs(parsed.query)
                limit = int(query.get("limit", [100])[0])
                unread_only = text(query.get("unreadOnly", [""])[0], 10).lower() in {"1", "true", "yes"}
                self._send_json(200, self.store.list_change_events(limit, unread_only))
            elif parsed.path == "/api/watchlist":
                query = parse_qs(parsed.query)
                limit = int(query.get("limit", [200])[0])
                self._send_json(200, self.store.list_watchlist(limit))
            elif parsed.path == "/api/reports/weekly/latest":
                self._send_json(200, self.store.latest_weekly_report())
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
            elif parsed.path == "/api/ai/summary":
                query = parse_qs(parsed.query)
                note_id = text(query.get("noteId", [""])[0], 128)
                self._send_json(200, self.store.note_summary(note_id))
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
            elif self.path == "/api/note/access-status":
                result = self.store.set_note_access_status(payload)
            elif self.path == "/api/notes/access-status/batch":
                result = self.store.set_note_access_statuses(payload)
            elif self.path == "/api/notes/unreachable/delete":
                result = self.store.delete_unreachable_notes(payload)
            elif self.path == "/api/data-health/repair":
                result = self.store.repair_data_health(payload)
            elif self.path == "/api/changes/ack":
                result = self.store.acknowledge_change_events(payload)
            elif self.path == "/api/watchlist":
                result = self.store.set_watchlist(payload)
            elif self.path == "/api/sync-runs/start":
                result = self.store.start_sync_run(payload)
            elif self.path == "/api/sync-runs/finish":
                result = self.store.finish_sync_run(payload)
            elif self.path == "/api/reports/weekly":
                result = self.store.generate_weekly_report(payload)
            elif self.path == "/api/reports/weekly/open":
                result = self.store.open_weekly_report(payload)
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
            elif self.path == "/api/comments/compare":
                result = self.store.compare_comments(payload)
            elif self.path == "/api/comments/sync":
                result = self.store.sync_comment_snapshot(payload)
            elif self.path == "/api/comments/collection/start":
                result = self.store.start_comment_collection(payload)
            elif self.path == "/api/excel/reload":
                seed_path = getattr(self.store, "seed_xlsx_path", None)
                if not seed_path:
                    raise ValueError("未配置 Excel 总表路径")
                inserted = self.store.seed_from_xlsx(Path(seed_path))
                access_migration: dict[str, Any] = {"updated": 0}
                migration_error = ""
                try:
                    access_migration = self.store.reconcile_legacy_access_statuses()
                except Exception as exc:
                    # Database statuses were already made conservative by the
                    # schema migration. Keep reload usable when Excel happens
                    # to be open; the next sync/reload will retry the label.
                    migration_error = text(exc, 1000)
                result = {"ok": True, "inserted": inserted, "path": str(seed_path),
                          "accessMigration": access_migration.get("updated", 0),
                          "accessMigrationError": migration_error}
            elif self.path == "/api/ai/settings":
                result = self.store.save_ai_settings(payload)
            elif self.path == "/api/ai/test":
                result = self.store.test_ai_connection(payload)
            elif self.path == "/api/ai/summary":
                result = self.store.summarize_note(payload)
            elif self.path == "/api/ai/reply-suggestion":
                result = self.store.suggest_comment_reply(payload)
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
        try:
            store.reconcile_legacy_access_statuses()
        except Exception as exc:
            print(f"[bridge] 旧版访问状态已在数据库降级；Excel 标签稍后重试：{exc}")
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
        store.seed_xlsx_path = args.seed_xlsx  # type: ignore[attr-defined]
        inserted = store.seed_from_xlsx(args.seed_xlsx)
        migration = store.reconcile_legacy_access_statuses()
        print(
            f"[bridge] seeded {inserted} existing note IDs from {args.seed_xlsx}; "
            f"downgraded {migration.get('updated', 0)} legacy access statuses"
        )
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
