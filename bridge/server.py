#!/usr/bin/env python3
"""Local Bridge for the XHS-Monitor XHS DOM monitor.

The bridge intentionally exposes only a small localhost JSON API. It does not
read browser cookies and does not call Xiaohongshu endpoints.
"""

from __future__ import annotations

import argparse
import base64
import csv
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
    from . import agent_analysis
    from .ai_support import AIServiceError, AISettingsStore, DeepSeekClient
    from .data_relationships import comment_note_id as csv_comment_note_id, repair_relationship_rows
    from .data_overview import OPERATORS as DATA_OVERVIEW_OPERATORS, build_field_specs, compile_filter_group, compile_sort, effective_thread_grouping, search_clause
    from .time_fields import NOTE_TIME_HEADERS, COMMENT_TIME_HEADERS, enrich_time_payload, csv_time_fields, latest_observation_reference
    from .snapshot_validation import validate_snapshot_identity
    from .overview_media import read_overview_media, read_comment_target
    from .overview_export_service import export_filtered_workbook
    from .semantic_search import LocalEncoder, retrieve as semantic_retrieve, MODEL as SEMANTIC_MODEL
except ImportError:  # Native Host runs this module as a top-level script.
    import agent_analysis
    from ai_support import AIServiceError, AISettingsStore, DeepSeekClient
    from data_relationships import comment_note_id as csv_comment_note_id, repair_relationship_rows
    from data_overview import OPERATORS as DATA_OVERVIEW_OPERATORS, build_field_specs, compile_filter_group, compile_sort, effective_thread_grouping, search_clause
    from time_fields import NOTE_TIME_HEADERS, COMMENT_TIME_HEADERS, enrich_time_payload, csv_time_fields, latest_observation_reference
    from snapshot_validation import validate_snapshot_identity
    from overview_media import read_overview_media, read_comment_target
    from overview_export_service import export_filtered_workbook
    from semantic_search import LocalEncoder, retrieve as semantic_retrieve, MODEL as SEMANTIC_MODEL


VERSION = "0.34.14"
DATA_OVERVIEW_NOTE_SCOPE = (
    "(n.source='existing_xlsx' OR n.pull_status IN ('synced','partial') OR n.status IN ('confirmed','ignored'))"
)
NOTE_CSV_HEADERS = [
    "笔记url", "用户主页url", "用户昵称", "笔记标题", "笔记内容", "笔记话题",
    "点赞量", "收藏量", "评论量", "分享量", "发布时间", "更新时间", "IP地址",
    "图片数量", "发布日期", "来源词", "笔记ID", "博主ID", "对应帖子文件夹地址",
    "文件夹内清单", "AI情绪判断", "帖子好坏", "访问状态",
    "语义分析次数", "分析结论是否差评", "差评类型", "差评子类型", "帖子状态", *NOTE_TIME_HEADERS,
]
COMMENT_CSV_HEADERS = [
    "笔记ID", "原笔记url", "帖子用户主页url", "笔记评论ID", "用户昵称", "评论用户主页url", "评论内容",
    "评论时间", "是否帖主评论", "点赞量", "评论层级", "父评论ID",
    "对应帖子文件夹地址", "文件夹内清单", "AI情绪判断", "映射状态", "映射备注",
    "语义分析次数", "分析结论是否差评", "差评类型", "差评子类型", "评论状态", *COMMENT_TIME_HEADERS,
]
# A supplied blank is an observed blank, not an omitted observation. Keep this
# map shared by the writer and verifier so CSV and payload use identical rules.
NOTE_CSV_SOURCE_FIELDS = {
    "用户主页url": "authorUrl", "博主ID": "authorId",
    "点赞量": "likeCount", "收藏量": "collectCount",
    "评论量": "commentCount", "分享量": "shareCount",
    "发布时间": "publishedAt", "更新时间": "updatedAt",
    "IP地址": "ipLocation", "图片数量": "imageCount",
}
COMMENT_STATUS_PRESENT = "存在"
COMMENT_STATUS_DELETED = "已删除"
POST_STATUS_PRESENT = "存在"
POST_STATUS_DELETED = "已删除"
CSV_ENCODING = "utf-8-sig"
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


def _decode_powershell_output(raw: bytes | None) -> str:
    value = raw or b""
    if not value:
        return ""
    if value.startswith((b"\xff\xfe", b"\xfe\xff")) or value.count(b"\x00") > max(2, len(value) // 8):
        return value.decode("utf-16le", errors="ignore").lstrip("\ufeff")
    return value.decode("utf-8", errors="replace").lstrip("\ufeff")


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
    output = _decode_powershell_output(completed.stdout)
    return completed.returncode == 0 and "REOPENED_READ_ONLY" in output


def _close_saved_office_workbook(target: Path) -> bool:
    """Close a saved workbook/CSV so a completed migration can retire it safely."""
    if os.name != "nt":
        return False
    escaped_path = str(Path(target).resolve()).replace("'", "''")
    script = f"""
$path = [System.IO.Path]::GetFullPath('{escaped_path}')
$result = 'NOT_OPEN'
foreach ($progId in @('ket.Application', 'Excel.Application')) {{
  try {{ $app = [Runtime.InteropServices.Marshal]::GetActiveObject($progId) }} catch {{ continue }}
  foreach ($book in @($app.Workbooks)) {{
    if (-not [System.String]::Equals([System.IO.Path]::GetFullPath($book.FullName), $path, [System.StringComparison]::OrdinalIgnoreCase)) {{ continue }}
    if (-not $book.Saved) {{ $result = 'UNSAVED'; break }}
    $book.Close($false)
    $result = 'CLOSED'
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
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0), timeout=8, check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    output = _decode_powershell_output(completed.stdout)
    return completed.returncode == 0 and "CLOSED" in output


def replace_with_retry(source: Path, target: Path, attempts: int = 20, initial_delay: float = 0.15,
                       *, office_recovery: bool = True) -> int:
    """Atomically replace a file, tolerating WPS, cloud sync and antivirus sharing locks."""
    total_attempts = max(1, int(attempts))
    office_recovery_attempted = False
    for attempt in range(total_attempts):
        try:
            os.replace(source, target)
            return attempt + 1
        except PermissionError:
            if office_recovery and not office_recovery_attempted:
                office_recovery_attempted = True
                if _reopen_saved_office_workbook_read_only(target):
                    continue
            if attempt + 1 >= total_attempts:
                raise
            time.sleep(min(initial_delay * (2 ** attempt), 1.5))
    return total_attempts


def replace_material_with_retry(source: Path, target: Path) -> int:
    """Retry only transient file-handle contention, not a whole DB transaction.

    No Office/GUI probing for JSON/TXT/journals. First success has no added wait;
    six failed attempts wait at most 0.775 seconds before normal rollback.
    """
    return replace_with_retry(source, target, attempts=6, initial_delay=0.025, office_recovery=False)


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


def collection_evidence_verified(payload: Any) -> bool:
    source = payload if isinstance(payload, dict) else {}
    evidence = source.get("collectionEvidence")
    if not isinstance(evidence, dict):
        return False
    # Older collectors omit these fields. When present, only an explicit zero
    # (or false for pendingLoads) proves that no unfinished work remains.
    for field in ("pendingLoads", "unreadableCount"):
        if field not in evidence:
            continue
        value = evidence[field]
        if field == "pendingLoads" and isinstance(value, str) and value.strip().casefold() == "false":
            value = 0
        try:
            if float(value) != 0:
                return False
        except (TypeError, ValueError, OverflowError):
            return False
    return bool_value(evidence.get("allCommentsRequested")) \
        and bool_value(evidence.get("expandersExhausted")) \
        and bool_value(evidence.get("scrollExhausted")) \
        and nonnegative_int(evidence.get("stableRounds")) >= 2


def comment_snapshot_status(payload: Any, current_count: int, status: Any = None) -> str:
    """Resolve completeness from this canonical snapshot, never accumulated history."""
    source = payload if isinstance(payload, dict) else {}
    requested = text(source.get("status") if status is None else status, 30) or "partial"
    if requested != "likely_complete":
        return requested if requested in {"collecting", "failed"} else "partial"
    expected_value = source.get("expectedCount") or 0
    try:
        expected_count = int(expected_value)
        if float(expected_value) != expected_count:
            return "partial"
    except (TypeError, ValueError, OverflowError):
        return "partial"
    count_verified = (expected_count > 0 and current_count >= expected_count) or (
        expected_count == 0 and current_count == 0 and bool_value(source.get("explicitEmptyVerified"))
    )
    return "likely_complete" if count_verified and collection_evidence_verified(source) else "partial"


def nonnegative_int(value: Any) -> int:
    try:
        return max(0, int(float(text(value, 40) or 0)))
    except (TypeError, ValueError):
        return 0


def _presence_status_label(value: Any, is_deleted: Any, present_label: str, deleted_label: str) -> str:
    raw = text(value, 40).strip().casefold()
    deleted_values = {"已删除", "被删", "删除", "不存在", "否", "deleted", "missing", "removed", "0", "false"}
    present_values = {"存在", "仍存在", "是", "present", "exists", "active", "1", "true"}
    if raw in deleted_values or (not raw and bool_value(is_deleted)):
        return deleted_label
    if raw in present_values:
        return present_label
    return present_label


def comment_status_label(value: Any, is_deleted: Any = None) -> str:
    return _presence_status_label(value, is_deleted, COMMENT_STATUS_PRESENT, COMMENT_STATUS_DELETED)


def post_status_label(value: Any, is_deleted: Any = None) -> str:
    return _presence_status_label(value, is_deleted, POST_STATUS_PRESENT, POST_STATUS_DELETED)


def imported_access_state(
    row_label: Any,
    existing: sqlite3.Row | dict[str, Any] | None = None,
    source_name: str = "CSV",
) -> tuple[str, str, str]:
    """Import a projected label without downgrading a live database verdict."""
    existing_status = text(existing["access_status"], 40) if existing else ""
    existing_error = text(existing["access_error"], 1000) if existing else ""
    existing_result = text(existing["access_check_result"], 80) if existing else ""
    if existing_status in {"ok", "check_failed", "unreachable"}:
        return existing_status, existing_error, existing_result

    label = text(row_label, 100).strip()
    if label == "可打开":
        return "ok", "", "opened"
    if label in {"打不开", "待复核", "检查失败"}:
        return "check_failed", f"{source_name} 中的旧状态等待重新同步核验", "legacy_excel_unverified"
    return "", "", ""


def sentiment_label(value: Any) -> str:
    raw = text(value, 40)
    if raw in set(SENTIMENT_LABELS.values()):
        return raw
    return SENTIMENT_LABELS.get(raw.lower(), "待复核")


def persisted_sentiment_label(value: Any) -> str:
    """Keep historical workflow labels while normalizing real sentiment codes."""
    raw = text(value, 40)
    if not raw:
        return ""
    if raw in set(SENTIMENT_LABELS.values()) or raw.lower() in SENTIMENTS:
        return sentiment_label(raw)
    return raw


def sentiment_code(value: Any) -> str:
    raw = text(value, 40)
    if not raw:
        return ""
    reverse = {label: code for code, label in SENTIMENT_LABELS.items()}
    return reverse.get(raw, raw.lower() if raw.lower() in SENTIMENTS else "uncertain")


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
    if note_id.casefold() in {"undefined", "null", "none", "unknown", "nan"}:
        return ""
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
                    return valid_note_id(parts[index])
                return ""
        return urlunparse(parsed._replace(query="", fragment="")).rstrip("/").casefold()
    except ValueError:
        return match_key(raw, 2000)


def match_key(value: Any, limit: int = 12000) -> str:
    """Normalize visible note text for title/caption comparison."""
    normalized = unicodedata.normalize("NFKC", text(value, limit)).casefold()
    normalized = ZERO_WIDTH_RE.sub("", normalized)
    normalized = WHITESPACE_RE.sub("", normalized)
    return normalized


HASHTAG_RE = re.compile(r"#[^\s#]+")


def canonical_tag_items(value: Any) -> list[str]:
    """Normalize DOM/legacy tags without dropping mixed plain/hashtag values."""
    values = list(value) if isinstance(value, (list, tuple, set)) else [value]
    cleaned = [text(item, 6000) for item in values if text(item, 6000)]
    if len(cleaned) >= 3 and sum(len(item) == 1 for item in cleaned) / len(cleaned) >= 0.6:
        return []
    output: list[str] = []
    for item in cleaned:
        hashtags = HASHTAG_RE.findall(item)
        output.extend(hashtags)
        remainder = HASHTAG_RE.sub(" ", item).strip()
        tokens = remainder.split()
        # Legacy browser code spread a tag string into individual characters,
        # producing values such as "# O r i g a n ...". If valid hashtags are
        # present beside that corruption, keep only the complete hashtag evidence.
        if len(tokens) >= 5 and sum(len(token) == 1 for token in tokens) / len(tokens) >= 0.6:
            if hashtags:
                continue
            reconstructed = WHITESPACE_RE.sub("", remainder)
            if reconstructed.endswith("作者"):
                reconstructed = reconstructed[:-2]
            if reconstructed.startswith("#") and len(reconstructed) > 1:
                output.append(reconstructed)
            continue
        for plain in tokens:
            collapsed = WHITESPACE_RE.sub("", plain)
            if collapsed in {"", "#", "无话题", "无话题作者", "作者"}:
                continue
            output.append(plain if plain.startswith("#") else f"#{plain}")
    return list(dict.fromkeys(output))


def tag_text(value: Any) -> str:
    items = canonical_tag_items(value)
    if items:
        return " ".join(items)
    values = list(value) if isinstance(value, (list, tuple, set)) else [value]
    return "无话题" if any(WHITESPACE_RE.sub("", text(item, 6000)) == "无话题" for item in values) else ""


def comment_level_value(value: Any) -> int:
    raw = text(value, 30)
    matched = re.search(r"([123一二三])", raw)
    if not matched:
        return 1
    token = matched.group(1)
    level = {"一": 1, "二": 2, "三": 3}[token] if token in {"一", "二", "三"} else int(token)
    return max(1, min(level, 3))


BROWSER_NOTE_FIELDS = {
    "noteId", "url", "title", "author", "authorUrl", "authorId", "publishedAt", "updatedAt",
    "content", "detailRead", "tags", "mediaText", "imageUrls", "imageCount", "videoUrls",
    "videoCount", "mediaType", "likeCount", "collectCount", "commentCount", "shareCount",
    "ipLocation", "ipRegion", "ipRegionSource", "ipRegionVersion", "keyword", "pageUrl", "timeObservedAt", "timeReferenceSource", "publishedTime", "updatedTime",
}


def browser_note_payload(value: Any) -> dict[str, Any]:
    """Keep only browser/source fields; discard nested local API/status objects."""
    source = value if isinstance(value, dict) else {}
    output = {key: source[key] for key in BROWSER_NOTE_FIELDS if key in source}
    note_id = valid_note_id(output.get("noteId"))
    if note_id:
        output["noteId"] = note_id
    if "tags" in output:
        raw_tags = output.get("tags")
        normalized_tags = canonical_tag_items(raw_tags)
        if normalized_tags:
            output["tags"] = normalized_tags
        elif tag_text(raw_tags) == "无话题":
            output["tags"] = ["无话题"]
        else:
            output.pop("tags", None)
    for field in ("imageUrls", "videoUrls"):
        if field not in output:
            continue
        values = output.get(field)
        normalized = list(dict.fromkeys(text(item, 4000) for item in values if text(item, 4000))) \
            if isinstance(values, list) else []
        if normalized:
            output[field] = normalized
        else:
            output.pop(field, None)
    if output.get("detailRead") is not True:
        output.pop("detailRead", None)
    for field in ("imageCount", "videoCount"):
        # Preserve a supplied empty/zero counter through the subsequent merge;
        # otherwise an older nonzero count silently wins over a fresh snapshot.
        if (field in output and output[field] not in (None, "")
                and nonnegative_int(output[field]) <= 0
                and not re.fullmatch(r"0+(?:\.0+)?", text(output[field], 80))):
            output.pop(field, None)
    return output


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
        self.pull_lock = threading.RLock()
        # The search page can ask for dozens of note statuses at once. Loading
        # the same workbook once per card creates a thundering herd, leaves the
        # Process panel in its skeleton state, and can exhaust the HTTP worker
        # threads. Keep one immutable index per workbook revision instead.
        self._excel_artifact_cache_lock = threading.Lock()
        self._excel_artifact_cache_key: tuple[str, int, int] | None = None
        self._excel_artifact_cache: dict[str, tuple[str, list[str], int]] = {}
        # Kept as a compatibility attribute for older extension/API fields.
        # Since v0.24 it always points to the UTF-8 notes CSV after startup.
        self.seed_xlsx_path: Path | None = None
        self.comments_csv_path: Path | None = None
        self._csv_managed_hashes: dict[str, str] = {}
        self._active_csv_checkpoint: dict[str, Any] | None = None
        self._persistent_checkpoints_recovered = False
        # Tokens are issued only after a full CSV/SQLite/material health pass.
        # Complex overview queries must present one of these short-lived tokens.
        self._data_overview_approved_tokens: dict[str, float] = {}
        self._data_overview_read_renewals: dict[str, float] = {}
        self.ai_settings = AISettingsStore(self.db_path.parent / "ai_settings.json")
        self.ai_client = ai_client or DeepSeekClient()
        self.ai_wakeup = threading.Event()
        self.ai_stopping = threading.Event()
        self._init_db()
        self._recover_jobs()
        self.ai_workers: list[threading.Thread] = []

    @staticmethod
    def _derived_csv_paths(master_path: Path) -> tuple[Path, Path]:
        path = Path(master_path).expanduser().resolve()
        stem = path.stem
        if "笔记评论总表" in stem:
            prefix = stem.split("笔记评论总表", 1)[0].rstrip("_- ") or "小红书"
            return path.parent / f"{prefix}_笔记总表.csv", path.parent / f"{prefix}_评论总表.csv"
        if "笔记总表" in stem:
            return path.with_suffix(".csv"), path.with_name(stem.replace("笔记总表", "评论总表") + ".csv")
        if path.suffix.lower() == ".csv":
            return path, path.with_name(f"{stem}_评论总表.csv")
        return path.parent / f"{stem}_笔记总表.csv", path.parent / f"{stem}_评论总表.csv"

    def configure_data_files(self, master_path: Path) -> tuple[Path, Path]:
        notes_path, comments_path = self._derived_csv_paths(Path(master_path))
        self.seed_xlsx_path = notes_path
        self.comments_csv_path = comments_path
        if not self._persistent_checkpoints_recovered:
            self._recover_persistent_sync_checkpoints()
            self._persistent_checkpoints_recovered = True
        return notes_path, comments_path

    def _csv_paths(self) -> tuple[Path, Path]:
        if not self.seed_xlsx_path:
            raise ValueError("尚未配置 CSV 总表")
        notes_path = Path(self.seed_xlsx_path).expanduser().resolve()
        if notes_path.suffix.lower() != ".csv":
            notes_path, derived_comments = self._derived_csv_paths(notes_path)
        else:
            _notes, derived_comments = self._derived_csv_paths(notes_path)
        comments_path = Path(self.comments_csv_path).expanduser().resolve() if self.comments_csv_path else derived_comments
        self.seed_xlsx_path, self.comments_csv_path = notes_path, comments_path
        return notes_path, comments_path

    @staticmethod
    def _csv_source_encoding(path: Path) -> str:
        """Accept WPS CSV encodings while keeping UTF-8 BOM as the canonical format."""
        path = Path(path)
        with path.open("rb") as stream:
            prefix = stream.read(3)
        if prefix.startswith(b"\xef\xbb\xbf"):
            return CSV_ENCODING
        if prefix.startswith((b"\xff\xfe", b"\xfe\xff")):
            return "utf-16"
        raw = path.read_bytes()
        try:
            raw.decode("utf-8")
            return "utf-8"
        except UnicodeDecodeError as utf8_error:
            try:
                raw.decode("gb18030")
                return "gb18030"
            except UnicodeDecodeError:
                raise utf8_error

    @classmethod
    def _read_csv_table(cls, path: Path, default_headers: list[str]) -> tuple[list[str], list[dict[str, str]]]:
        path = Path(path)
        if not path.is_file():
            return list(default_headers), []
        encoding = cls._csv_source_encoding(path)
        with path.open("r", encoding=encoding, newline="") as stream:
            reader = csv.DictReader(stream)
            headers = [str(item).strip() for item in (reader.fieldnames or []) if item is not None and str(item).strip()]
            if not headers:
                headers = list(default_headers)
            for name in default_headers:
                if name not in headers:
                    headers.append(name)
            rows = [
                {name: "" if row.get(name) is None else str(row.get(name)) for name in headers}
                for row in reader
                if row and any(value is not None and str(value) != "" for value in row.values())
            ]
        return headers, rows

    @staticmethod
    def _write_csv_temporary(path: Path, headers: list[str], rows: list[dict[str, Any]], purpose: str) -> Path:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(f".{path.stem}.{purpose}-{os.getpid()}-{time.time_ns()}.tmp.csv")
        with temporary.open("w", encoding=CSV_ENCODING, newline="") as stream:
            writer = csv.DictWriter(stream, fieldnames=headers, extrasaction="ignore", lineterminator="\r\n")
            writer.writeheader()
            for row in rows:
                writer.writerow({name: "" if row.get(name) is None else row.get(name) for name in headers})
            stream.flush()
            os.fsync(stream.fileno())
        return temporary

    @staticmethod
    def _file_sha256(path: Path) -> str:
        return hashlib.sha256(Path(path).read_bytes()).hexdigest() if Path(path).is_file() else ""

    def _remember_managed_csv(self, path: Path) -> None:
        resolved = str(Path(path).resolve()).casefold()
        self._csv_managed_hashes[resolved] = self._file_sha256(path)

    def _update_active_checkpoint_csv_hashes(self) -> None:
        checkpoint = self._active_csv_checkpoint
        if not checkpoint or not checkpoint.get("captureCsv"):
            return
        actual_hashes = {
            str(Path(checkpoint["notesPath"]).resolve()).casefold(): self._file_sha256(
                Path(checkpoint["notesPath"])
            ),
            str(Path(checkpoint["commentsPath"]).resolve()).casefold(): self._file_sha256(
                Path(checkpoint["commentsPath"])
            ),
        }
        allowed = checkpoint.get("managedCsvAllowedHashes") or {}
        if any(
            allowed.get(key) and value not in set(allowed[key])
            for key, value in actual_hashes.items()
        ):
            return
        checkpoint["managedCsvHashes"] = actual_hashes
        checkpoint.pop("managedCsvAllowedHashes", None)
        self._persist_sync_checkpoint(checkpoint)

    def _prepare_active_checkpoint_csv_replacement(self, replacements: dict[Path, Path]) -> None:
        """Persist both pre/post hashes before replacement so a crash is not mistaken for an external edit."""
        checkpoint = self._active_csv_checkpoint
        if not checkpoint or not checkpoint.get("captureCsv"):
            return
        allowed: dict[str, list[str]] = {}
        for key in ("notesPath", "commentsPath"):
            target = Path(checkpoint[key])
            resolved = str(target.resolve()).casefold()
            hashes = {self._file_sha256(target)}
            replacement = replacements.get(target)
            if replacement is not None:
                hashes.add(self._file_sha256(replacement))
            allowed[resolved] = sorted(hashes)
        checkpoint["managedCsvAllowedHashes"] = allowed
        self._persist_sync_checkpoint(checkpoint)

    def _replace_csv_table(self, path: Path, headers: list[str], rows: list[dict[str, Any]], purpose: str) -> None:
        temporary = self._write_csv_temporary(path, headers, rows, purpose)
        expected_hash = self._file_sha256(temporary)
        try:
            self._prepare_active_checkpoint_csv_replacement({Path(path): temporary})
            replace_with_retry(temporary, path)
            if self._file_sha256(path) != expected_hash:
                raise ValueError(f"CSV 原子替换后检测到外部修改：{path.name}")
            self._csv_managed_hashes[str(Path(path).resolve()).casefold()] = expected_hash
        except PermissionError as exc:
            raise ValueError(f"WPS/Excel 持续占用 CSV：{path.name}，请关闭该文件后重试") from exc
        finally:
            self._update_active_checkpoint_csv_hashes()
            temporary.unlink(missing_ok=True)

    def _replace_csv_pair(
        self,
        note_headers: list[str],
        note_rows: list[dict[str, Any]],
        comment_headers: list[str],
        comment_rows: list[dict[str, Any]],
        purpose: str,
    ) -> None:
        notes_path, comments_path = self._csv_paths()
        note_temp = self._write_csv_temporary(notes_path, note_headers, note_rows, purpose)
        comment_temp = self._write_csv_temporary(comments_path, comment_headers, comment_rows, purpose)
        expected_hashes = {
            notes_path: self._file_sha256(note_temp),
            comments_path: self._file_sha256(comment_temp),
        }
        backups: list[tuple[Path, Path]] = []
        replaced: list[Path] = []
        try:
            self._prepare_active_checkpoint_csv_replacement({
                notes_path: note_temp, comments_path: comment_temp,
            })
            for target in (notes_path, comments_path):
                if target.exists():
                    backup = target.with_name(f".{target.stem}.{purpose}-backup-{os.getpid()}-{time.time_ns()}.csv")
                    shutil.copy2(target, backup)
                    backups.append((target, backup))
            replace_with_retry(note_temp, notes_path)
            replaced.append(notes_path)
            if self._file_sha256(notes_path) != expected_hashes[notes_path]:
                raise ValueError(f"CSV 原子替换后检测到外部修改：{notes_path.name}")
            replace_with_retry(comment_temp, comments_path)
            replaced.append(comments_path)
            if self._file_sha256(comments_path) != expected_hashes[comments_path]:
                raise ValueError(f"CSV 原子替换后检测到外部修改：{comments_path.name}")
            for target, expected_hash in expected_hashes.items():
                self._csv_managed_hashes[str(target.resolve()).casefold()] = expected_hash
        except PermissionError as exc:
            backed_up = {target for target, _backup in backups}
            for target, backup in backups:
                if backup.exists():
                    os.replace(backup, target)
            for target in replaced:
                if target not in backed_up:
                    target.unlink(missing_ok=True)
            raise ValueError("WPS/Excel 持续占用 CSV 总表，请关闭笔记表和评论表后重试") from exc
        except Exception:
            backed_up = {target for target, _backup in backups}
            for target, backup in backups:
                if backup.exists():
                    os.replace(backup, target)
            for target in replaced:
                if target not in backed_up:
                    target.unlink(missing_ok=True)
            raise
        finally:
            self._update_active_checkpoint_csv_hashes()
            note_temp.unlink(missing_ok=True)
            comment_temp.unlink(missing_ok=True)
            for _target, backup in backups:
                backup.unlink(missing_ok=True)

    @staticmethod
    def _restore_file_bytes(path: Path, payload: bytes | None) -> None:
        path = Path(path)
        if payload is None:
            path.unlink(missing_ok=True)
            return
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(f".{path.name}.rollback-{os.getpid()}-{time.time_ns()}.tmp")
        try:
            temporary.write_bytes(payload)
            replace_with_retry(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)

    @staticmethod
    def _managed_binary_material(path: Path) -> bool:
        return bool(re.match(r"^(?:image|video)-\d+\..+", path.name, re.IGNORECASE)) \
            or path.name.endswith(".part")

    @classmethod
    def _checkpoint_json_value(cls, value: Any, *, decode: bool = False) -> Any:
        if decode:
            if isinstance(value, dict) and set(value) == {"__bytes__"}:
                return base64.b64decode(value["__bytes__"])
            if isinstance(value, dict):
                return {key: cls._checkpoint_json_value(item, decode=True) for key, item in value.items()}
            if isinstance(value, list):
                return [cls._checkpoint_json_value(item, decode=True) for item in value]
            return value
        if isinstance(value, bytes):
            return {"__bytes__": base64.b64encode(value).decode("ascii")}
        if isinstance(value, dict):
            return {str(key): cls._checkpoint_json_value(item) for key, item in value.items()}
        if isinstance(value, (list, tuple)):
            return [cls._checkpoint_json_value(item) for item in value]
        return value

    def _persist_sync_checkpoint(self, checkpoint: dict[str, Any]) -> dict[str, Any]:
        root = self.export_dir / ".sync_checkpoints"
        root.mkdir(parents=True, exist_ok=True)
        existing = text(
            checkpoint.get("checkpointDir") or checkpoint.get("binaryBackupDir"), 4000
        )
        folder = Path(existing) if existing else root / (
            f"{checkpoint['noteId']}-{os.getpid()}-{time.time_ns()}"
        )
        folder.mkdir(parents=True, exist_ok=True)
        checkpoint["checkpointDir"] = str(folder)
        checkpoint["dbPath"] = str(self.db_path.resolve())
        checkpoint["capturedAt"] = now_iso()
        manifest = folder / "checkpoint.json"
        temporary = folder / f".checkpoint-{time.time_ns()}.tmp"
        try:
            temporary.write_text(
                json.dumps(self._checkpoint_json_value(checkpoint), ensure_ascii=False), encoding="utf-8"
            )
            replace_material_with_retry(temporary, manifest)
        finally:
            temporary.unlink(missing_ok=True)
        return checkpoint

    def _recover_persistent_sync_checkpoints(self) -> None:
        root = self.export_dir / ".sync_checkpoints"
        if not root.is_dir():
            return
        manifests = sorted(
            root.glob("*/checkpoint.json"), key=lambda path: path.stat().st_mtime_ns, reverse=True
        )
        failures: list[str] = []
        loaded: list[tuple[Path, dict[str, Any]]] = []
        for manifest in manifests:
            try:
                raw = json.loads(manifest.read_text(encoding="utf-8"))
                checkpoint = self._checkpoint_json_value(raw, decode=True)
                if Path(checkpoint.get("dbPath", "")).resolve() != self.db_path.resolve():
                    raise ValueError("检查点数据库路径与当前配置不同")
                if checkpoint.get("externalAnalysisBatch") and agent_analysis.committed(self, checkpoint["externalAnalysisBatch"]):
                    self._discard_sync_checkpoint(checkpoint)
                    continue
                if checkpoint.get("captureCsv"):
                    expected_hashes = checkpoint.get("managedCsvHashes") or {}
                    allowed_hashes = checkpoint.get("managedCsvAllowedHashes") or {}
                    for key in ("notesPath", "commentsPath"):
                        path = Path(checkpoint[key])
                        resolved = str(path.resolve()).casefold()
                        expected = expected_hashes.get(resolved)
                        allowed = set(allowed_hashes.get(resolved) or [])
                        actual = self._file_sha256(path)
                        if expected is not None and actual != expected and actual not in allowed:
                            conflict = manifest.parent / f"external-conflict-{path.name}"
                            if path.is_file() and not conflict.exists():
                                shutil.copy2(path, conflict)
                            raise ValueError(f"崩溃后检测到外部 CSV 修改，已保留冲突副本：{path.name}")
                loaded.append((manifest, checkpoint))
            except Exception as exc:
                failures.append(f"{manifest.parent.name}: {text(exc, 500)}")
        if failures:
            raise RuntimeError(f"检测到未完成同步且自动恢复冲突：{'；'.join(failures)}")
        for manifest, checkpoint in loaded:
            try:
                self._restore_sync_checkpoint(checkpoint, recovering=True)
                self._discard_sync_checkpoint(checkpoint)
            except Exception as exc:
                failures.append(f"{manifest.parent.name}: {text(exc, 500)}")
        if failures:
            raise RuntimeError(f"检测到未完成同步且自动恢复失败：{'；'.join(failures)}")
        try:
            root.rmdir()
        except OSError:
            pass

    def _capture_sync_checkpoint(
        self, note_id: str, *, capture_csv: bool = True, capture_media_binaries: bool = False,
        capture_global_database: bool = False,
    ) -> dict[str, Any]:
        """Capture one note's mutable local state for all-or-nothing synchronization."""
        notes_path, comments_path = self._csv_paths()
        notes_bytes = notes_path.read_bytes() if capture_csv and notes_path.is_file() else None
        comments_bytes = comments_path.read_bytes() if capture_csv and comments_path.is_file() else None
        with self.lock, self._session() as db:
            note_row = db.execute("SELECT * FROM notes WHERE note_id=?", (note_id,)).fetchone()
            comments = [dict(row) for row in db.execute(
                "SELECT * FROM comments WHERE note_id=? ORDER BY comment_id", (note_id,)
            ).fetchall()]
            jobs = [dict(row) for row in db.execute(
                "SELECT * FROM comment_collection_jobs WHERE note_id=? ORDER BY id", (note_id,)
            ).fetchall()]
            watchlist_snapshot = [dict(row) for row in db.execute(
                "SELECT * FROM watchlist ORDER BY note_id"
            ).fetchall()] if capture_csv else None
            max_event_id = int(db.execute("SELECT COALESCE(MAX(id),0) FROM change_events").fetchone()[0])
        note = dict(note_row) if note_row else None
        media_dir = text((note or {}).get("media_dir"), 4000)
        tracked_files: dict[str, bytes | None] = {}
        binary_backup_dir = ""
        preexisting_media_backups: dict[str, str] = {}
        try:
            media_exists = bool(media_dir and Path(media_dir).is_dir())
        except OSError:
            media_exists = False
        preexisting_unlinked: list[Path] = []
        if not media_exists:
            root = self._media_root()
            suffix = f"__{note_id}"
            try:
                if root.is_dir():
                    preexisting_unlinked = [
                        path.resolve() for path in root.iterdir()
                        if path.is_dir() and path.name.endswith(suffix)
                    ]
            except OSError:
                preexisting_unlinked = []
        if media_exists:
            folder = Path(media_dir)
            for name in ("note.json", "comments.json", "帖子正文.txt"):
                path = folder / name
                tracked_files[str(path)] = path.read_bytes() if path.is_file() else None
        if capture_media_binaries and (media_exists or preexisting_unlinked):
            backup = self.export_dir / ".sync_checkpoints" / f"{note_id}-{os.getpid()}-{time.time_ns()}"
            backup.mkdir(parents=True, exist_ok=False)
            try:
                if media_exists:
                    for path in Path(media_dir).iterdir():
                        if not path.is_file() or not self._managed_binary_material(path):
                            continue
                        shutil.copy2(path, backup / path.name)
                for index, folder in enumerate(preexisting_unlinked):
                    relative = f"preexisting-{index}"
                    shutil.copytree(folder, backup / relative)
                    preexisting_media_backups[str(folder)] = relative
                binary_backup_dir = str(backup)
            except Exception:
                shutil.rmtree(backup, ignore_errors=True)
                raise
        checkpoint = {
            "noteId": note_id, "captureCsv": bool(capture_csv),
            "notesPath": str(notes_path), "commentsPath": str(comments_path),
            "notesBytes": notes_bytes, "commentsBytes": comments_bytes,
            "note": note, "comments": comments, "jobs": jobs,
            "watchlistSnapshot": watchlist_snapshot,
            "maxEventId": max_event_id, "mediaDir": media_dir, "materialFiles": tracked_files,
            "binaryBackupDir": binary_backup_dir,
            "preexistingMediaBackups": preexisting_media_backups,
        }
        if capture_csv:
            self._remember_managed_csv(notes_path)
            self._remember_managed_csv(comments_path)
            checkpoint["managedCsvHashes"] = {
                str(notes_path.resolve()).casefold(): self._file_sha256(notes_path),
                str(comments_path.resolve()).casefold(): self._file_sha256(comments_path),
            }
        try:
            persisted = self._persist_sync_checkpoint(checkpoint)
            if capture_global_database:
                backup_path = Path(persisted["checkpointDir"]) / "database-before.sqlite"
                with self.lock:
                    source = self._connect()
                    target = sqlite3.connect(backup_path)
                    try:
                        source.backup(target)
                    finally:
                        target.close()
                        source.close()
                persisted["globalDatabaseBackup"] = str(backup_path)
                persisted = self._persist_sync_checkpoint(persisted)
            if capture_csv:
                self._active_csv_checkpoint = persisted
            return persisted
        except Exception:
            cleanup = text(checkpoint.get("checkpointDir") or binary_backup_dir, 4000)
            if cleanup:
                shutil.rmtree(cleanup, ignore_errors=True)
            raise

    @staticmethod
    def _insert_snapshot_rows(db: sqlite3.Connection, table: str, rows: list[dict[str, Any]]) -> None:
        for row in rows:
            columns = list(row)
            placeholders = ",".join("?" for _ in columns)
            quoted = ",".join(f'"{column}"' for column in columns)
            db.execute(
                f'INSERT INTO "{table}" ({quoted}) VALUES ({placeholders})',
                tuple(row[column] for column in columns),
            )

    def _discard_sync_checkpoint(self, checkpoint: dict[str, Any]) -> None:
        backup_value = text(
            checkpoint.get("checkpointDir") or checkpoint.get("binaryBackupDir"), 4000
        )
        if backup_value:
            shutil.rmtree(backup_value, ignore_errors=True)
        if self._active_csv_checkpoint is checkpoint or (
            self._active_csv_checkpoint
            and self._active_csv_checkpoint.get("checkpointDir") == checkpoint.get("checkpointDir")
        ):
            self._active_csv_checkpoint = None
        root = self.export_dir / ".sync_checkpoints"
        try:
            root.rmdir()
        except OSError:
            pass

    def _rollback_sync_checkpoints(self, checkpoints: list[dict[str, Any]]) -> list[str]:
        errors: list[str] = []
        restored: list[dict[str, Any]] = []
        for checkpoint in reversed(checkpoints):
            try:
                self._restore_sync_checkpoint(checkpoint)
                restored.append(checkpoint)
            except Exception as exc:
                errors.append(f"{checkpoint.get('noteId')}: {text(exc, 500)}")
        for checkpoint in restored:
            self._discard_sync_checkpoint(checkpoint)
        return errors

    def _restore_sync_checkpoint(
        self, checkpoint: dict[str, Any], *, recovering: bool = False
    ) -> None:
        """Restore a failed note sync without touching unrelated notes or analysis jobs."""
        note_id = valid_note_id(checkpoint.get("noteId"))
        if not note_id:
            raise ValueError("同步回滚缺少帖子 ID")
        current_media_dir = ""
        with self.lock, self._session() as db:
            current = db.execute("SELECT media_dir FROM notes WHERE note_id=?", (note_id,)).fetchone()
            current_media_dir = text(current[0], 4000) if current else ""
        global_database_backup = text(checkpoint.get("globalDatabaseBackup"), 4000)
        # Automatic startup recovery must remain note-scoped. A whole-database
        # backup can predate a later successful delete, ignore, review or AI
        # write and would silently roll those unrelated operations back.
        # Synchronous in-process rollback still uses the global image because
        # it runs inside the operation that created the checkpoint.
        if global_database_backup and not recovering:
            backup_path = Path(global_database_backup)
            if not backup_path.is_file():
                raise FileNotFoundError(f"全库检查点不存在：{backup_path}")
            with self.lock:
                source = sqlite3.connect(backup_path)
                target = self._connect()
                try:
                    source.backup(target)
                finally:
                    target.close()
                    source.close()
        if checkpoint.get("captureCsv"):
            csv_paths = (Path(checkpoint["notesPath"]), Path(checkpoint["commentsPath"]))
            if not recovering:
                for path in csv_paths:
                    key = str(path.resolve()).casefold()
                    expected_hash = self._csv_managed_hashes.get(key)
                    if expected_hash is not None and self._file_sha256(path) != expected_hash:
                        raise ValueError(f"回滚前检测到外部修改，拒绝覆盖：{path.name}")
            self._restore_file_bytes(csv_paths[0], checkpoint.get("notesBytes"))
            self._restore_file_bytes(csv_paths[1], checkpoint.get("commentsBytes"))
            self._remember_managed_csv(csv_paths[0])
            self._remember_managed_csv(csv_paths[1])
        with self.lock, self._session() as db:
            db.execute("DELETE FROM comments WHERE note_id=?", (note_id,))
            db.execute("DELETE FROM comment_collection_jobs WHERE note_id=?", (note_id,))
            previous_note = checkpoint.get("note")
            if previous_note:
                existing = db.execute("SELECT 1 FROM notes WHERE note_id=?", (note_id,)).fetchone()
                columns = [column for column in previous_note if column != "note_id"]
                if existing:
                    assignments = ",".join(f'"{column}"=?' for column in columns)
                    db.execute(
                        f'UPDATE notes SET {assignments} WHERE note_id=?',
                        tuple(previous_note[column] for column in columns) + (note_id,),
                    )
                else:
                    self._insert_snapshot_rows(db, "notes", [previous_note])
                self._insert_snapshot_rows(db, "comments", checkpoint.get("comments") or [])
                self._insert_snapshot_rows(db, "comment_collection_jobs", checkpoint.get("jobs") or [])
            else:
                db.execute("DELETE FROM watchlist WHERE note_id=?", (note_id,))
                db.execute("DELETE FROM notes WHERE note_id=?", (note_id,))
            db.execute(
                "DELETE FROM change_events WHERE note_id=? AND id>?",
                (note_id, int(checkpoint.get("maxEventId") or 0)),
            )
            if checkpoint.get("watchlistSnapshot") is not None:
                watchlist_snapshot = checkpoint.get("watchlistSnapshot") or []
                if recovering:
                    db.execute("DELETE FROM watchlist WHERE note_id=?", (note_id,))
                    self._insert_snapshot_rows(
                        db, "watchlist",
                        [row for row in watchlist_snapshot if text(row.get("note_id"), 256) == note_id],
                    )
                else:
                    db.execute("DELETE FROM watchlist")
                    self._insert_snapshot_rows(db, "watchlist", watchlist_snapshot)
        previous_media_dir = text(checkpoint.get("mediaDir"), 4000)
        if previous_media_dir:
            folder = Path(previous_media_dir)
            folder.mkdir(parents=True, exist_ok=True)
            backup_value = text(checkpoint.get("binaryBackupDir"), 4000)
            if backup_value and Path(backup_value).is_dir():
                for path in folder.iterdir():
                    if path.is_file() and self._managed_binary_material(path):
                        path.unlink(missing_ok=True)
                for source in Path(backup_value).iterdir():
                    if not source.is_file() or not self._managed_binary_material(source):
                        continue
                    target = folder / source.name
                    shutil.copy2(source, target)
        for path_value, payload in (checkpoint.get("materialFiles") or {}).items():
            self._restore_file_bytes(Path(path_value), payload)
        preexisting_backups = checkpoint.get("preexistingMediaBackups") or {}
        backup_root = Path(text(checkpoint.get("binaryBackupDir"), 4000)) \
            if text(checkpoint.get("binaryBackupDir"), 4000) else None
        for folder_value, relative in preexisting_backups.items():
            folder = Path(folder_value)
            source = backup_root / relative if backup_root else None
            if not source or not source.is_dir():
                continue
            original_files = {
                str(path.relative_to(source)).casefold() for path in source.rglob("*") if path.is_file()
            }
            if folder.is_dir():
                for path in folder.rglob("*"):
                    if not path.is_file():
                        continue
                    relative_name = str(path.relative_to(folder)).casefold()
                    if relative_name not in original_files and (
                        self._managed_binary_material(path)
                        or path.name in {"note.json", "comments.json", "帖子正文.txt"}
                    ):
                        path.unlink(missing_ok=True)
            folder.mkdir(parents=True, exist_ok=True)
            shutil.copytree(source, folder, dirs_exist_ok=True)
        if current_media_dir:
            try:
                current_folder = Path(current_media_dir).resolve()
                previous_folder = Path(previous_media_dir).resolve() if previous_media_dir else None
                preexisting_folders = {Path(value).resolve() for value in preexisting_backups}
                root = self._media_root().resolve()
                if current_folder != previous_folder and current_folder not in preexisting_folders \
                        and current_folder.parent == root and current_folder.name.endswith(f"__{note_id}"):
                    shutil.rmtree(current_folder, ignore_errors=True)
            except OSError:
                pass
        self._invalidate_excel_artifact_cache()

    def _invalidate_excel_artifact_cache(self) -> None:
        with self._excel_artifact_cache_lock:
            self._excel_artifact_cache_key = None
            self._excel_artifact_cache = {}

    def _ensure_seed_workbook(self, _path: Path | None = None) -> None:
        """Create both CSVs and normalize WPS/Excel legacy encodings to UTF-8 BOM."""
        notes_path, comments_path = self._csv_paths()
        for path, defaults in ((notes_path, NOTE_CSV_HEADERS), (comments_path, COMMENT_CSV_HEADERS)):
            if not path.exists():
                self._replace_csv_table(path, defaults, [], "initialize")
                continue
            encoding = self._csv_source_encoding(path)
            with path.open("r", encoding=encoding, newline="") as stream:
                actual_headers = [str(item).strip() for item in next(csv.reader(stream), []) if str(item).strip()]
            missing_headers = [name for name in defaults if name not in actual_headers]
            if encoding == CSV_ENCODING and not missing_headers:
                continue
            headers, rows = self._read_csv_table(path, defaults)
            if path == notes_path:
                with self.lock, self._session() as db:
                    stored_presence = {
                        str(item["note_id"]): post_status_label(item["post_status"], item["is_deleted"])
                        for item in db.execute("SELECT note_id,post_status,is_deleted FROM notes").fetchall()
                    }
                for row in rows:
                    note_id = valid_note_id(row.get("笔记ID"))
                    raw_status = text(row.get("帖子状态"), 40)
                    row["帖子状态"] = raw_status if raw_status in {
                        POST_STATUS_PRESENT, POST_STATUS_DELETED
                    } else stored_presence.get(note_id, POST_STATUS_PRESENT)
            elif path == comments_path:
                comment_author_url_missing = "评论用户主页url" not in actual_headers
                presence_missing = "评论状态" not in actual_headers
                with self.lock, self._session() as db:
                    stored_comments = {
                        str(item["comment_id"]): {
                            "authorUrl": text(item["author_url"], 2000),
                            "status": comment_status_label(item["comment_status"], item["is_deleted"]),
                        }
                        for item in db.execute(
                            "SELECT comment_id,author_url,comment_status,is_deleted FROM comments"
                        ).fetchall()
                    }
                    stored_note_author_urls = {}
                    for item in db.execute("SELECT note_id,payload_json FROM notes").fetchall():
                        try:
                            payload = json.loads(item["payload_json"] or "{}")
                            if not isinstance(payload, dict):
                                payload = {}
                        except (TypeError, ValueError):
                            payload = {}
                        stored_note_author_urls[str(item["note_id"])] = text(payload.get("authorUrl"), 2000)
                try:
                    _, current_note_rows = self._read_csv_table(notes_path, NOTE_CSV_HEADERS)
                    for note_row in current_note_rows:
                        note_id = valid_note_id(note_row.get("笔记ID"))
                        if note_id and text(note_row.get("用户主页url"), 2000):
                            stored_note_author_urls[note_id] = text(note_row.get("用户主页url"), 2000)
                except Exception:
                    pass
                for row in rows:
                    comment_id = text(row.get("笔记评论ID"), 256)
                    stored = stored_comments.get(comment_id) or {}
                    if comment_author_url_missing:
                        legacy_comment_author_url = text(row.get("帖子用户主页url"), 2000)
                        row["评论用户主页url"] = legacy_comment_author_url or stored.get("authorUrl", "")
                        row["帖子用户主页url"] = stored_note_author_urls.get(csv_comment_note_id(row), "")
                    elif not text(row.get("评论用户主页url"), 2000) and stored.get("authorUrl"):
                        row["评论用户主页url"] = stored["authorUrl"]
                    raw_status = text(row.get("评论状态"), 40)
                    if presence_missing or raw_status not in {COMMENT_STATUS_PRESENT, COMMENT_STATUS_DELETED}:
                        row["评论状态"] = stored.get("status", COMMENT_STATUS_PRESENT)
            purpose = "normalize-schema" if missing_headers else "normalize-encoding"
            try:
                self._replace_csv_table(path, headers, rows, purpose)
            except ValueError as exc:
                # Keep the Bridge usable when WPS is still editing the file;
                # reads continue and the next write/restart retries the schema/encoding normalization.
                print(f"[bridge] CSV 结构或编码等待规范化：{path} ({exc})", flush=True)

    def migrate_legacy_workbook(self, xlsx_path: Path) -> dict[str, Any]:
        """Losslessly split the legacy workbook into notes/comments UTF-8 CSV files."""
        from openpyxl import load_workbook

        source = Path(xlsx_path).expanduser().resolve()
        if source.suffix.lower() not in {".xlsx", ".xlsm"} or not source.is_file():
            raise ValueError("旧版 XLSX 总表不存在")
        notes_path, comments_path = self._derived_csv_paths(source)
        workbook = load_workbook(source, read_only=True, data_only=False)
        try:
            if "sheet1_笔记总表" not in workbook.sheetnames or "sheet2_评论总表" not in workbook.sheetnames:
                raise ValueError("旧版 XLSX 缺少笔记总表或评论总表")

            def extract(sheet_name: str, required: list[str]) -> tuple[list[str], list[dict[str, Any]]]:
                sheet = workbook[sheet_name]
                values = list(sheet.iter_rows(values_only=True))
                raw_headers = [text(value, 200) for value in (values[0] if values else ())]
                while raw_headers and not raw_headers[-1]:
                    raw_headers.pop()
                headers = [name or f"未命名列{index + 1}" for index, name in enumerate(raw_headers)]
                for name in required:
                    if name not in headers:
                        headers.append(name)
                rows: list[dict[str, Any]] = []
                for values_row in values[1:]:
                    row = {headers[index]: values_row[index] if index < len(values_row) else "" for index in range(len(raw_headers))}
                    for name in required:
                        row.setdefault(name, "")
                    if any(value not in (None, "") for value in row.values()):
                        rows.append(row)
                return headers, rows

            note_headers, note_rows = extract("sheet1_笔记总表", NOTE_CSV_HEADERS)
            comment_headers, comment_rows = extract("sheet2_评论总表", COMMENT_CSV_HEADERS)
            relationship_repair = repair_relationship_rows(
                note_rows, comment_rows, note_headers, comment_headers
            )
            note_headers = relationship_repair["noteHeaders"]
            comment_headers = relationship_repair["commentHeaders"]
            note_rows = relationship_repair["noteRows"]
            comment_rows = relationship_repair["commentRows"]
            legacy_archive: list[tuple[str, int, str]] = []
            for sheet in workbook.worksheets:
                if sheet.title in {"sheet1_笔记总表", "sheet2_评论总表"}:
                    continue
                for row_number, values_row in enumerate(sheet.iter_rows(values_only=True), 1):
                    values = list(values_row)
                    while values and values[-1] in (None, ""):
                        values.pop()
                    if not values:
                        continue
                    legacy_archive.append((sheet.title, row_number, json.dumps(values, ensure_ascii=False, default=str)))
        finally:
            workbook.close()

        migrated_at = now_iso()
        migration_repair_id = f"xlsx-migration:{source}:{migrated_at}"
        with self.lock, self._session() as db:
            db.execute("DELETE FROM legacy_sheet_archive WHERE source_path=?", (str(source),))
            db.executemany(
                """INSERT INTO legacy_sheet_archive(source_path,sheet_name,row_number,row_json,migrated_at)
                   VALUES(?,?,?,?,?)""",
                [(str(source), sheet_name, row_number, row_json, migrated_at)
                 for sheet_name, row_number, row_json in legacy_archive],
            )
            archived_count = int(db.execute(
                "SELECT COUNT(*) FROM legacy_sheet_archive WHERE source_path=?", (str(source),)
            ).fetchone()[0])
            for archived in relationship_repair.get("archives") or []:
                db.execute(
                    """INSERT OR REPLACE INTO data_repair_archive
                       (repair_id,source_name,row_number,reason,row_json,archived_at) VALUES(?,?,?,?,?,?)""",
                    (migration_repair_id, archived["source"], int(archived["rowNumber"]),
                     archived["reason"], json.dumps(archived["row"], ensure_ascii=False), migrated_at),
                )
        if archived_count != len(legacy_archive):
            raise ValueError("旧版附加 Sheet 归档校验失败，XLSX 已保留")

        self.seed_xlsx_path, self.comments_csv_path = notes_path, comments_path
        self._replace_csv_pair(note_headers, note_rows, comment_headers, comment_rows, "migrate")
        verify_note_headers, verified_notes = self._read_csv_table(notes_path, NOTE_CSV_HEADERS)
        verify_comment_headers, verified_comments = self._read_csv_table(comments_path, COMMENT_CSV_HEADERS)
        source_note_ids = [valid_note_id(row.get("笔记ID")) for row in note_rows if valid_note_id(row.get("笔记ID"))]
        csv_note_ids = [valid_note_id(row.get("笔记ID")) for row in verified_notes if valid_note_id(row.get("笔记ID"))]
        source_comment_ids = [text(row.get("笔记评论ID"), 256) for row in comment_rows]
        csv_comment_ids = [text(row.get("笔记评论ID"), 256) for row in verified_comments]
        def logical_rows(headers: list[str], rows: list[dict[str, Any]]) -> list[list[str]]:
            return [["" if row.get(name) is None else str(row.get(name)) for name in headers] for row in rows]
        note_content_matches = logical_rows(note_headers, note_rows) == logical_rows(note_headers, verified_notes)
        comment_content_matches = logical_rows(comment_headers, comment_rows) == logical_rows(comment_headers, verified_comments)
        if (len(note_rows) != len(verified_notes) or len(comment_rows) != len(verified_comments)
                or source_note_ids != csv_note_ids or source_comment_ids != csv_comment_ids
                or not note_content_matches or not comment_content_matches):
            raise ValueError("CSV 迁移校验失败，旧版 XLSX 已保留")
        return {
            "ok": True, "notesPath": str(notes_path), "commentsPath": str(comments_path),
            "noteRows": len(verified_notes), "commentRows": len(verified_comments),
            "noteColumns": len(verify_note_headers), "commentColumns": len(verify_comment_headers),
            "archivedSheetRows": archived_count,
        }

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
            agent_analysis.init_schema(db)
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
                "semantic_analysis_count": "INTEGER NOT NULL DEFAULT 0",
                "analysis_is_negative": "TEXT NOT NULL DEFAULT ''",
                "negative_type": "TEXT NOT NULL DEFAULT ''",
                "negative_subtype": "TEXT NOT NULL DEFAULT ''",
                "post_status": "TEXT NOT NULL DEFAULT '存在'",
                "is_deleted": "INTEGER NOT NULL DEFAULT 0",
                "deleted_at": "TEXT NOT NULL DEFAULT ''",
                "last_presence_checked_at": "TEXT NOT NULL DEFAULT ''",
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
            db.execute("CREATE INDEX IF NOT EXISTS idx_notes_presence ON notes(is_deleted, pull_status)")
            db.execute("""UPDATE notes SET is_deleted=1,post_status=?,
                       deleted_at=CASE WHEN deleted_at='' THEN last_access_checked_at ELSE deleted_at END,
                       last_presence_checked_at=CASE WHEN last_presence_checked_at='' THEN last_access_checked_at ELSE last_presence_checked_at END
                       WHERE access_status='unreachable' AND access_check_result='confirmed_v2'""", (POST_STATUS_DELETED,))
            db.execute("""UPDATE notes SET is_deleted=1
                       WHERE post_status IN ('已删除','被删','删除','不存在','deleted','missing','removed')""")
            db.execute("UPDATE notes SET post_status=CASE WHEN is_deleted=1 THEN ? ELSE ? END",
                       (POST_STATUS_DELETED, POST_STATUS_PRESENT))
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
                    semantic_analysis_count INTEGER NOT NULL DEFAULT 0,
                    analysis_is_negative TEXT NOT NULL DEFAULT '',
                    negative_type TEXT NOT NULL DEFAULT '',
                    negative_subtype TEXT NOT NULL DEFAULT '',
                    comment_status TEXT NOT NULL DEFAULT '存在',
                    is_deleted INTEGER NOT NULL DEFAULT 0,
                    deleted_at TEXT NOT NULL DEFAULT '',
                    last_presence_checked_at TEXT NOT NULL DEFAULT '',
                    FOREIGN KEY(note_id) REFERENCES notes(note_id)
                );
                CREATE INDEX IF NOT EXISTS idx_comments_identity_full
                    ON comments(note_id, author, content, published_at, parent_comment_id);
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

                CREATE TABLE IF NOT EXISTS legacy_sheet_archive (
                    source_path TEXT NOT NULL,
                    sheet_name TEXT NOT NULL,
                    row_number INTEGER NOT NULL,
                    row_json TEXT NOT NULL,
                    migrated_at TEXT NOT NULL,
                    PRIMARY KEY(source_path, sheet_name, row_number)
                );
                CREATE INDEX IF NOT EXISTS idx_legacy_sheet_archive_sheet
                    ON legacy_sheet_archive(sheet_name, row_number);

                CREATE TABLE IF NOT EXISTS data_repair_archive (
                    repair_id TEXT NOT NULL,
                    source_name TEXT NOT NULL,
                    row_number INTEGER NOT NULL,
                    reason TEXT NOT NULL,
                    row_json TEXT NOT NULL,
                    archived_at TEXT NOT NULL,
                    PRIMARY KEY(repair_id, source_name, row_number, reason)
                );
                CREATE INDEX IF NOT EXISTS idx_data_repair_archive_repair
                    ON data_repair_archive(repair_id, source_name, row_number);
                """
            )
            # Older builds used an identity-only UNIQUE index and could merge
            # distinct comments that happened to share author/text/time.
            db.execute("DROP INDEX IF EXISTS idx_comments_identity_full")
            db.execute("CREATE INDEX idx_comments_identity_full ON comments(note_id,author,content,published_at,parent_comment_id)")
            comment_migrations = {
                "semantic_analysis_count": "INTEGER NOT NULL DEFAULT 0",
                "analysis_is_negative": "TEXT NOT NULL DEFAULT ''",
                "negative_type": "TEXT NOT NULL DEFAULT ''",
                "negative_subtype": "TEXT NOT NULL DEFAULT ''",
                "comment_status": "TEXT NOT NULL DEFAULT '存在'",
                "is_deleted": "INTEGER NOT NULL DEFAULT 0",
                "deleted_at": "TEXT NOT NULL DEFAULT ''",
                "last_presence_checked_at": "TEXT NOT NULL DEFAULT ''",
            }
            comment_columns = {str(row[1]) for row in db.execute("PRAGMA table_info(comments)").fetchall()}
            for column, definition in comment_migrations.items():
                if column not in comment_columns:
                    db.execute(f"ALTER TABLE comments ADD COLUMN {column} {definition}")
            db.execute("CREATE INDEX IF NOT EXISTS idx_comments_semantic_negative ON comments(analysis_is_negative, negative_type)")
            db.execute("CREATE INDEX IF NOT EXISTS idx_comments_presence ON comments(is_deleted, note_id)")
            db.execute("CREATE INDEX IF NOT EXISTS idx_notes_semantic_negative ON notes(analysis_is_negative, negative_type)")
            db.execute("""UPDATE comments SET is_deleted=1
                WHERE comment_status IN ('已删除','删除','不存在','deleted','missing','removed')""")
            db.execute("UPDATE comments SET comment_status=CASE WHEN is_deleted=1 THEN ? ELSE ? END",
                       (COMMENT_STATUS_DELETED, COMMENT_STATUS_PRESENT))

            # Backfill identity keys for databases created before content-based
            # matching was introduced.
            rows = db.execute(
                """
                SELECT note_id, url, title, author, content, tags, title_key, content_key,
                       title_content_key, status, source, is_relevant, payload_json
                FROM notes ORDER BY note_id
                """
            ).fetchall()
            payload_repaired_at = now_iso()
            for row_number, row in enumerate(rows, 1):
                note_id = str(row["note_id"])
                title_value, content_value, combined_value = identity_keys(row["title"], row["content"])
                raw_payload = str(row["payload_json"] or "")
                try:
                    seeded_payload = json.loads(raw_payload or "{}")
                    if not isinstance(seeded_payload, dict):
                        seeded_payload = {}
                except (TypeError, ValueError):
                    seeded_payload = {}
                tags_value = text(row["tags"]) or tag_text(seeded_payload.get("tags"))
                payload_id = text(seeded_payload.get("noteId"), 128)
                payload_url_id = note_url_identity(seeded_payload.get("url"))
                payload_identity_mismatch = (
                    payload_id != note_id
                    or bool(payload_url_id and payload_url_id != note_id)
                )
                next_payload_json = raw_payload
                if payload_identity_mismatch:
                    db.execute(
                        """INSERT OR IGNORE INTO data_repair_archive
                           (repair_id,source_name,row_number,reason,row_json,archived_at)
                           VALUES(?,'notes.payload_json',?,
                                  'payload_note_id_mismatch',?,?)""",
                        (f"v0.25.1-note-payload-identity:{note_id}", row_number,
                         json.dumps({"noteId": note_id, "payload": raw_payload}, ensure_ascii=False),
                         payload_repaired_at),
                    )
                    seeded_payload["noteId"] = note_id
                    seeded_payload["url"] = text(row["url"], 4000) or f"https://www.xiaohongshu.com/explore/{note_id}"
                    for payload_name, column_name, limit in (
                        ("title", "title", 1000), ("author", "author", 500), ("content", "content", 12000)
                    ):
                        canonical_value = text(row[column_name], limit)
                        if canonical_value:
                            seeded_payload[payload_name] = canonical_value
                    next_payload_json = json.dumps(seeded_payload, ensure_ascii=False)
                # Reclassifying old rows here would be destructive when a user
                # edits the private keyword file; fresh scans update relevance.
                next_relevant = int(row["is_relevant"])
                next_status = row["status"]
                if (
                    row["tags"] != tags_value
                    or row["title_key"] != title_value
                    or row["content_key"] != content_value
                    or row["title_content_key"] != combined_value
                    or int(row["is_relevant"]) != next_relevant
                    or row["status"] != next_status
                    or next_payload_json != raw_payload
                ):
                    db.execute(
                        """
                        UPDATE notes
                        SET tags = ?, title_key = ?, content_key = ?, title_content_key = ?,
                            is_relevant = ?, status = ?, payload_json = ?
                        WHERE note_id = ?
                        """,
                        (
                            tags_value,
                            title_value,
                            content_value,
                            combined_value,
                            next_relevant,
                            next_status,
                            next_payload_json,
                            note_id,
                        ),
                    )

    def _legacy_ensure_access_status_column(self, xlsx_path: Path) -> bool:
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

    def _seed_from_legacy_xlsx(self, xlsx_path: Path) -> int:
        """Import notes and legacy irrelevant-sheet records before XLSX retirement."""
        from openpyxl import load_workbook

        self._legacy_ensure_access_status_column(Path(xlsx_path))
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
                    "SELECT note_id,url,page_url,access_status,access_error,access_check_result FROM notes WHERE note_id = ?",
                    (note_id,),
                ).fetchone()
                row_access_status, row_access_error, row_access_result = imported_access_state(
                    row_access_label, existing, "Excel"
                )
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
                            status=CASE WHEN status='ignored' THEN status ELSE 'known' END,
                            source='existing_xlsx', is_relevant=1, relevance_status='relevant', relevance_source='excel',
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

    def _seed_from_csv(self, notes_path: Path) -> int:
        """Synchronize the UTF-8 notes CSV index into SQLite."""
        headers, rows = self._read_csv_table(notes_path, NOTE_CSV_HEADERS)
        if "笔记ID" not in headers:
            raise ValueError("笔记 CSV 缺少笔记ID列")
        source_encoding = self._csv_source_encoding(notes_path)
        with notes_path.open("r", encoding=source_encoding, newline="") as stream:
            actual_headers = {str(item).strip() for item in next(csv.reader(stream), []) if str(item).strip()}
        semantic_headers_present = all(name in actual_headers for name in (
            "语义分析次数", "分析结论是否差评", "差评类型", "差评子类型"
        ))
        presence_header_present = "帖子状态" in actual_headers
        inserted = 0
        repaired_access_labels = 0
        timestamp = now_iso()
        with self.lock, self._session() as db:
            for row in rows:
                note_id = valid_note_id(row.get("笔记ID"))
                if not note_id:
                    continue
                row_title = text(row.get("笔记标题"), 1000)
                row_content = text(row.get("笔记内容"), 20000)
                row_tags = tag_text(row.get("笔记话题"))
                row_access_label = text(row.get("访问状态"), 100).strip()
                row_post_status = post_status_label(row.get("帖子状态"))
                row_is_deleted = int(row_post_status == POST_STATUS_DELETED)
                row_title_key, row_content_key, row_combined_key = identity_keys(row_title, row_content)
                row_files = [line.strip() for line in text(row.get("文件夹内清单"), 50000).splitlines() if line.strip()]
                row_media_dir = self._resolve_legacy_media_dir(row.get("对应帖子文件夹地址"), row_files, note_id)
                existing = db.execute(
                    """SELECT note_id,url,page_url,payload_json,tags,access_status,access_error,access_check_result,
                               post_status,is_deleted,deleted_at,last_presence_checked_at
                       FROM notes WHERE note_id=?""", (note_id,)
                ).fetchone()
                if existing and not presence_header_present:
                    row_post_status = post_status_label(existing["post_status"], existing["is_deleted"])
                    row_is_deleted = int(row_post_status == POST_STATUS_DELETED)
                access_status, access_error, access_result = imported_access_state(
                    row_access_label, existing, "CSV"
                )
                canonical_access_label = {
                    "ok": "可打开", "check_failed": "待复核", "unreachable": "打不开", "": ""
                }[access_status]
                if row_access_label != canonical_access_label:
                    row["访问状态"] = canonical_access_label
                    repaired_access_labels += 1
                row_url = text(row.get("笔记url"), 4000)
                if existing:
                    preferred = preferred_url(existing["url"], row_url)
                    preferred_page = preferred_url(existing["page_url"], row_url)
                    db.execute(
                        """UPDATE notes SET url=CASE WHEN ?<>'' THEN ? ELSE url END,
                           title=CASE WHEN ?<>'' THEN ? ELSE title END,
                           author=CASE WHEN ?<>'' THEN ? ELSE author END,
                           content=CASE WHEN ?<>'' THEN ? ELSE content END,
                           tags=CASE WHEN ?<>'' THEN ? ELSE tags END,
                           keyword=CASE WHEN ?<>'' THEN ? ELSE keyword END,
                           page_url=CASE WHEN ?<>'' THEN ? ELSE page_url END,
                           status=CASE WHEN status='ignored' THEN status ELSE 'known' END,
                           source='existing_xlsx',is_relevant=1,relevance_status='relevant',relevance_source='csv',
                           post_sentiment=CASE WHEN ?<>'' THEN ? ELSE post_sentiment END,
                           title_key=CASE WHEN ?<>'' THEN ? ELSE title_key END,
                           content_key=CASE WHEN ?<>'' THEN ? ELSE content_key END,
                           title_content_key=CASE WHEN ?<>'' THEN ? ELSE title_content_key END,
                           last_seen_at=?,access_status=?,access_error=?,access_check_result=?,
                           post_status=CASE WHEN ? THEN ? ELSE post_status END,
                           is_deleted=CASE WHEN ? THEN ? ELSE is_deleted END,
                           deleted_at=CASE WHEN ? AND ?=1 AND deleted_at='' THEN ?
                                           WHEN ? AND ?=0 THEN '' ELSE deleted_at END,
                           last_presence_checked_at=CASE WHEN ? THEN ? ELSE last_presence_checked_at END,
                           pull_status=CASE WHEN pull_status IN ('partial','failed') THEN pull_status ELSE 'synced' END,
                           pull_error=CASE WHEN pull_status IN ('partial','failed') THEN pull_error ELSE '' END,
                           excel_synced_at=?,excel_sync_path=? WHERE note_id=?""",
                        (preferred, preferred, row_title, row_title, text(row.get("用户昵称"), 500), text(row.get("用户昵称"), 500),
                         row_content, row_content, row_tags, row_tags, text(row.get("来源词"), 200), text(row.get("来源词"), 200),
                         preferred_page, preferred_page, text(row.get("帖子好坏"), 80), text(row.get("帖子好坏"), 80),
                         row_title_key, row_title_key, row_content_key, row_content_key, row_combined_key, row_combined_key,
                         timestamp, access_status, access_error, access_result,
                         int(presence_header_present), row_post_status,
                         int(presence_header_present), row_is_deleted,
                         int(presence_header_present), row_is_deleted, timestamp,
                         int(presence_header_present), row_is_deleted,
                         int(presence_header_present), timestamp,
                         timestamp, str(notes_path), note_id),
                    )
                else:
                    db.execute(
                        """INSERT INTO notes (note_id,url,title,author,content,tags,keyword,page_url,first_seen_at,last_seen_at,
                           status,is_relevant,source,post_sentiment,title_key,content_key,title_content_key,payload_json,
                           access_status,access_error,access_check_result,post_status,is_deleted,deleted_at,
                           last_presence_checked_at,pull_status,excel_synced_at,excel_sync_path,relevance_status,relevance_source)
                           VALUES (?,?,?,?,?,?,?,?,?,?,'known',1,'existing_xlsx',?,?,?,?,?, ?,?,?,?,?,?,?,'synced',?,?, 'relevant','csv')""",
                        (note_id, row_url, row_title, text(row.get("用户昵称"), 500), row_content, row_tags,
                         text(row.get("来源词"), 200), row_url, timestamp, timestamp, text(row.get("帖子好坏"), 80),
                         row_title_key, row_content_key, row_combined_key,
                         json.dumps({"seed": "csv", "tags": row_tags}, ensure_ascii=False), access_status, access_error,
                         access_result, row_post_status, row_is_deleted, timestamp if row_is_deleted else "",
                         timestamp if presence_header_present else "", timestamp, str(notes_path)),
                    )
                    inserted += 1
                if semantic_headers_present:
                    db.execute(
                        """UPDATE notes SET semantic_analysis_count=?,analysis_is_negative=?,
                           negative_type=?,negative_subtype=? WHERE note_id=?""",
                        (nonnegative_int(row.get("语义分析次数")), text(row.get("分析结论是否差评"), 40),
                         text(row.get("差评类型"), 1000), text(row.get("差评子类型"), 2000), note_id),
                    )
                try:
                    previous_payload = json.loads(existing["payload_json"] or "{}") if existing else {}
                    if not isinstance(previous_payload, dict):
                        previous_payload = {}
                except (TypeError, ValueError):
                    previous_payload = {}
                row_payload = browser_note_payload(previous_payload)
                csv_payload = {
                    "noteId": note_id, "url": preferred if existing else row_url,
                    "authorUrl": text(row.get("用户主页url"), 2000),
                    "author": text(row.get("用户昵称"), 500), "title": row_title, "content": row_content,
                    "likeCount": row.get("点赞量", ""), "collectCount": row.get("收藏量", ""),
                    "commentCount": row.get("评论量", ""), "shareCount": row.get("分享量", ""),
                    "publishedAt": text(row.get("发布时间"), 100), "updatedAt": text(row.get("更新时间"), 100),
                    "ipLocation": text(row.get("IP地址"), 100),
                    "keyword": text(row.get("来源词"), 200), "authorId": text(row.get("博主ID"), 256),
                    "postSentiment": text(row.get("帖子好坏"), 80),
                }
                if text(row.get("时间采集基准"), 80):
                    csv_payload["timeObservedAt"] = text(row.get("时间采集基准"), 80)
                if row_tags:
                    csv_payload["tags"] = canonical_tag_items(row_tags) or ["无话题"]
                if text(row.get("图片数量"), 30):
                    csv_payload["imageCount"] = nonnegative_int(row.get("图片数量"))
                if row_content:
                    csv_payload["detailRead"] = True
                if semantic_headers_present:
                    csv_payload.update({
                        "semanticAnalysisCount": nonnegative_int(row.get("语义分析次数")),
                        "analysisIsNegative": text(row.get("分析结论是否差评"), 40),
                        "negativeType": text(row.get("差评类型"), 1000),
                        "negativeSubtype": text(row.get("差评子类型"), 2000),
                    })
                for key, value in csv_payload.items():
                    if value not in (None, "") or key in {"noteId", "semanticAnalysisCount"}:
                        row_payload[key] = value
                effective_tags = (row_tags or text(existing["tags"], 6000)) if existing else row_tags
                db.execute(
                    "UPDATE notes SET payload_json=?,tags=? WHERE note_id=?",
                    (json.dumps(row_payload, ensure_ascii=False), effective_tags, note_id),
                )
                if row_media_dir:
                    db.execute(
                        "UPDATE notes SET media_dir=?,media_status='complete',media_file_count=? WHERE note_id=?",
                        (row_media_dir, len(row_files), note_id),
                    )
        if repaired_access_labels:
            try:
                self._replace_csv_table(notes_path, headers, rows, "access-seed-reconcile")
            except OSError as exc:
                # Keep the native host available while Excel/WPS owns the CSV.
                # SQLite remains authoritative and the next successful status
                # mutation will heal the user-facing projection.
                print(f"[bridge] 访问状态已按数据库保留；CSV 标签暂时无法修复：{exc}", flush=True)
        return inserted

    def _seed_comments_from_csv(self, comments_path: Path) -> dict[str, int]:
        """Import user-maintained comment metadata without deleting SQLite-only rows."""
        headers, rows = self._read_csv_table(comments_path, COMMENT_CSV_HEADERS)
        source_encoding = self._csv_source_encoding(comments_path)
        with comments_path.open("r", encoding=source_encoding, newline="") as stream:
            actual_headers = {str(item).strip() for item in next(csv.reader(stream), []) if str(item).strip()}
        semantic_headers_present = all(name in actual_headers for name in (
            "语义分析次数", "分析结论是否差评", "差评类型", "差评子类型"
        ))
        presence_header_present = "评论状态" in actual_headers
        comment_author_header_present = "评论用户主页url" in actual_headers
        timestamp = now_iso()
        inserted = 0
        updated = 0
        with self.lock, self._session() as db:
            note_ids = {str(row[0]) for row in db.execute("SELECT note_id FROM notes").fetchall()}
            for row in rows:
                note_id = csv_comment_note_id(row)
                comment_id = text(row.get("笔记评论ID"), 256)
                content_value = text(row.get("评论内容"), 8000)
                substantive = bool(
                    content_value or text(row.get("用户昵称"), 500) or text(row.get("评论时间"), 100)
                )
                if not note_id or note_id not in note_ids or not comment_id or not substantive:
                    continue
                api = self._csv_comment_to_api(row)
                if not comment_author_header_present:
                    api["authorUrl"] = text(row.get("帖子用户主页url"), 2000)
                raw_presence = text(row.get("评论状态"), 40)
                status_supplied = presence_header_present and raw_presence in {
                    COMMENT_STATUS_PRESENT, COMMENT_STATUS_DELETED
                }
                existing = db.execute(
                    """SELECT payload_json,content,author_url,parent_comment_id,published_at,comment_level,
                              comment_status,is_deleted
                       FROM comments WHERE comment_id=?""", (comment_id,)
                ).fetchone()
                status_label = raw_presence if status_supplied else (
                    comment_status_label(existing["comment_status"], existing["is_deleted"])
                    if existing else COMMENT_STATUS_PRESENT
                )
                is_deleted = int(status_label == COMMENT_STATUS_DELETED)
                if existing:
                    content_value = content_value or text(existing["content"], 8000)
                    api["content"] = content_value
                    api["authorUrl"] = api["authorUrl"] or text(existing["author_url"], 2000)
                    api["parentCommentId"] = api["parentCommentId"] or text(existing["parent_comment_id"], 256)
                    api["publishedAt"] = api["publishedAt"] or text(existing["published_at"], 100)
                    if api["parentCommentId"]:
                        api["commentLevel"] = max(2, comment_level_value(api["commentLevel"]))
                    elif not text(row.get("评论层级"), 30):
                        api["commentLevel"] = int(existing["comment_level"] or 1)
                try:
                    payload = json.loads(existing["payload_json"] or "{}") if existing else {}
                    if not isinstance(payload, dict):
                        payload = {}
                except (TypeError, ValueError):
                    payload = {}
                if existing:
                    # The CSV has no reply-count column. Its API default zero
                    # must not overwrite the last actual DOM observation.
                    api.pop("replyCount", None)
                payload.update(api)
                if text(row.get("时间采集基准"), 80):
                    payload["timeObservedAt"] = text(row.get("时间采集基准"), 80)
                payload.update({"commentStatus": status_label, "isDeleted": bool(is_deleted)})
                if semantic_headers_present:
                    payload.update({
                        "semanticAnalysisCount": nonnegative_int(row.get("语义分析次数")),
                        "analysisIsNegative": text(row.get("分析结论是否差评"), 40),
                        "negativeType": text(row.get("差评类型"), 1000),
                        "negativeSubtype": text(row.get("差评子类型"), 2000),
                    })
                if existing:
                    db.execute(
                        """UPDATE comments SET note_id=?,parent_comment_id=?,content=?,author=?,author_url=?,
                           published_at=?,like_count=?,comment_level=?,payload_json=?,content_hash=?,
                           sentiment=CASE WHEN ?<>'' THEN ? ELSE sentiment END,
                           semantic_analysis_count=CASE WHEN ? THEN ? ELSE semantic_analysis_count END,
                           analysis_is_negative=CASE WHEN ? THEN ? ELSE analysis_is_negative END,
                           negative_type=CASE WHEN ? THEN ? ELSE negative_type END,
                           negative_subtype=CASE WHEN ? THEN ? ELSE negative_subtype END,
                           comment_status=CASE WHEN ? THEN ? ELSE comment_status END,
                           is_deleted=CASE WHEN ? THEN ? ELSE is_deleted END,
                           deleted_at=CASE WHEN ? AND ?=1 AND deleted_at='' THEN ?
                                           WHEN ? AND ?=0 THEN '' ELSE deleted_at END,
                           last_presence_checked_at=CASE WHEN ? THEN ? ELSE last_presence_checked_at END
                           WHERE comment_id=?""",
                        (note_id, api["parentCommentId"], content_value, api["author"], api["authorUrl"],
                         api["publishedAt"], api["likeCount"], api["commentLevel"],
                         json.dumps(payload, ensure_ascii=False), self._content_hash(content_value),
                         sentiment_code(row.get("AI情绪判断")), sentiment_code(row.get("AI情绪判断")),
                         int(semantic_headers_present), nonnegative_int(row.get("语义分析次数")),
                         int(semantic_headers_present), text(row.get("分析结论是否差评"), 40),
                         int(semantic_headers_present), text(row.get("差评类型"), 1000),
                         int(semantic_headers_present), text(row.get("差评子类型"), 2000),
                         int(status_supplied), status_label,
                         int(status_supplied), is_deleted,
                         int(status_supplied), is_deleted, timestamp,
                         int(status_supplied), is_deleted,
                         int(status_supplied), timestamp, comment_id),
                    )
                    updated += 1
                else:
                    db.execute(
                        """INSERT INTO comments(comment_id,note_id,parent_comment_id,content,author,author_url,
                           published_at,like_count,reply_count,comment_url,comment_level,first_seen_at,last_seen_at,
                           payload_json,content_hash,sentiment,semantic_analysis_count,analysis_is_negative,
                           negative_type,negative_subtype,comment_status,is_deleted,deleted_at,last_presence_checked_at)
                           VALUES(?,?,?,?,?,?,?,?,0,'',?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                        (comment_id, note_id, api["parentCommentId"], content_value, api["author"], api["authorUrl"],
                         api["publishedAt"], api["likeCount"], api["commentLevel"], timestamp, timestamp,
                         json.dumps(payload, ensure_ascii=False), self._content_hash(content_value),
                         sentiment_code(row.get("AI情绪判断")),
                         nonnegative_int(row.get("语义分析次数")) if semantic_headers_present else 0,
                         text(row.get("分析结论是否差评"), 40) if semantic_headers_present else "",
                         text(row.get("差评类型"), 1000) if semantic_headers_present else "",
                         text(row.get("差评子类型"), 2000) if semantic_headers_present else "",
                         status_label, is_deleted, timestamp if is_deleted else "",
                         timestamp if status_supplied else ""),
                    )
                    inserted += 1
            db.execute(
                """UPDATE notes SET comment_count_collected=(
                   SELECT COUNT(*) FROM comments c WHERE c.note_id=notes.note_id AND c.is_deleted=0)"""
            )
        return {"inserted": inserted, "updated": updated}

    def seed_from_xlsx(self, master_path: Path) -> int:
        """Compatibility entry point: migrate XLSX once, then use two CSV files."""
        source = Path(master_path).expanduser().resolve()
        if source.suffix.lower() in {".xlsx", ".xlsm"} and source.is_file():
            inserted = self._seed_from_legacy_xlsx(source)
            migration = self.migrate_legacy_workbook(source)
            notes_path = Path(migration["notesPath"])
            self.seed_xlsx_path = notes_path
            self.comments_csv_path = Path(migration["commentsPath"])
            # Only retire the workbook after CSV content verification and SQLite import both succeed.
            retired = False
            for attempt in range(8):
                try:
                    source.unlink(missing_ok=True)
                    retired = not source.exists()
                    break
                except PermissionError:
                    if attempt == 0:
                        _close_saved_office_workbook(source)
                    time.sleep(0.2 * (attempt + 1))
            if not retired:
                print(f"[bridge] CSV 迁移已完成；旧 XLSX 尚有未保存内容或仍被占用，暂不强制删除：{source}", flush=True)
            self._seed_from_csv(notes_path)
            self.repair_csv_relationships({"source": "legacy_xlsx_migration"})
            self._seed_comments_from_csv(self.comments_csv_path)
            return inserted
        notes_path, comments_path = self.configure_data_files(source)
        self._ensure_seed_workbook(notes_path)
        self.comments_csv_path = comments_path
        inserted = self._seed_from_csv(notes_path)
        self._seed_comments_from_csv(comments_path)
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
            # A valid XHS note ID is the canonical identity. Never let a title
            # or body fallback map one card to a different already-pulled post.
            return (row, "note_id") if row is not None else (None, "")
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
                "postStatus": post_status_label(existing["post_status"], existing["is_deleted"])
                    if existing is not None and "post_status" in existing.keys() else POST_STATUS_PRESENT,
                "isDeleted": bool(existing["is_deleted"])
                    if existing is not None and "is_deleted" in existing.keys() else False,
            }

        with self.pull_lock, self.lock, self._session() as db:
            stored_by_id: dict[str, sqlite3.Row] = {}
            if title_only:
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
                    # Lightweight cards still expose a canonical URL ID. Exact
                    # ID matching is mandatory; equal titles are not identity.
                    existing = stored_by_id.get(note_id)
                    matched_by = "note_id" if existing is not None else ""
                else:
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
                    # Every successfully/partially pulled note already has a
                    # canonical row in the business CSV, even when it was first
                    # discovered from DOM and therefore keeps source='dom'.
                    # Search-card text is often truncated and must never drift
                    # SQLite away from that CSV/material snapshot.
                    preserve_excel = in_excel
                    update_note_url = "" if preserve_excel else note_url
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
                    # A card scan is discovery metadata, not a replacement for
                    # the rich payload captured during an actual pull.
                    update_payload_json = str(existing["payload_json"] or "{}") if preserve_excel else payload_json
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
                            update_note_url,
                            update_note_url,
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
                            update_payload_json,
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
        with self.pull_lock, self.lock, self._session() as db:
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
                    post_status = '存在',
                    is_deleted = 0,
                    deleted_at = '',
                    last_presence_checked_at = excluded.last_seen_at,
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
        """Ignore a note and soft-delete its retained post/comment presence as one transaction."""
        note_id = valid_note_id(payload.get("noteId"))
        if not note_id:
            raise ValueError("noteId is required")
        with self.pull_lock, self.lock, self._session() as db:
            stored = db.execute(
                "SELECT source,pull_status,status FROM notes WHERE note_id=?", (note_id,)
            ).fetchone()
        if not stored:
            raise ValueError("帖子尚未写入本地数据库，请先重新扫描")
        pulled = stored["source"] == "existing_xlsx" or stored["pull_status"] in {"synced", "partial"}
        if pulled:
            reconciled = self.set_note_access_statuses({"items": [{
                "noteId": note_id,
                "preserveAccess": True,
                "forcePostStatus": POST_STATUS_DELETED,
                "workflowStatus": "ignored",
                "cascadeComments": True,
                "commentDeletionReason": "parent_ignored",
            }]})
            item = reconciled["items"][0]
            return {
                "ok": True, "noteId": note_id, "status": "ignored", "updated": True,
                "pulled": True, "postStatus": item["postStatus"],
                "commentsMarkedDeleted": int(item.get("commentsMarkedDeleted") or 0),
                "consistencyVerified": reconciled.get("consistencyVerified") is True,
                "verified": reconciled.get("verified", []),
            }
        with self.pull_lock, self.lock, self._session() as db:
            db.execute("UPDATE notes SET status='ignored',last_seen_at=? WHERE note_id=?", (now_iso(), note_id))
        return {"ok": True, "noteId": note_id, "status": "ignored", "updated": True,
                "pulled": False, "consistencyVerified": True}

    def restore(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Restore workflow participation without reviving comments deleted before the ignore."""
        note_id = valid_note_id(payload.get("noteId"))
        if not note_id:
            raise ValueError("noteId is required")
        with self.pull_lock, self.lock, self._session() as db:
            stored = db.execute(
                "SELECT source,pull_status,status FROM notes WHERE note_id=?", (note_id,)
            ).fetchone()
        if not stored or stored["status"] != "ignored":
            raise ValueError("帖子不存在或当前不是已忽略状态")
        pulled = stored["source"] == "existing_xlsx" or stored["pull_status"] in {"synced", "partial"}
        workflow_status = "known" if pulled else "new"
        if pulled:
            reconciled = self.set_note_access_statuses({"items": [{
                "noteId": note_id,
                "preserveAccess": True,
                "forcePostStatus": POST_STATUS_PRESENT,
                "workflowStatus": workflow_status,
                "restoreIgnoredComments": True,
            }]})
            item = reconciled["items"][0]
            return {
                "ok": True, "noteId": note_id, "status": workflow_status, "pulled": True,
                "postStatus": item["postStatus"],
                "commentsRestored": int(item.get("commentsRestored") or 0),
                "consistencyVerified": reconciled.get("consistencyVerified") is True,
                "verified": reconciled.get("verified", []),
            }
        with self.pull_lock, self.lock, self._session() as db:
            db.execute("UPDATE notes SET status=?,last_seen_at=? WHERE note_id=?",
                       (workflow_status, now_iso(), note_id))
        return {"ok": True, "noteId": note_id, "status": workflow_status,
                "pulled": False, "consistencyVerified": True}

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
        validate_snapshot_identity(payload)
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
        with self.pull_lock, self.lock, self._session() as db:
            if not db.execute("SELECT 1 FROM notes WHERE note_id = ?", (note_id,)).fetchone():
                raise ValueError("帖子尚未写入本地数据库")
            raw_comments = self._normalize_snapshot_comments(note_id, raw_comments)
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
                comment_id = self._excel_comment_id(note_id, {**item, "parentCommentId": parent_comment_id})
                content_hash = self._content_hash(content)
                existing = db.execute(
                    """SELECT comment_id,note_id,parent_comment_id,published_at,author_url,comment_level,
                              content_hash,payload_json,semantic_analysis_count,
                              analysis_is_negative,negative_type,negative_subtype,is_deleted
                       FROM comments WHERE comment_id=?""",
                    (comment_id,),
                ).fetchone()
                if existing is None and not supplied_id:
                    existing = db.execute(
                        """SELECT comment_id,note_id,parent_comment_id,published_at,author_url,comment_level,
                                  content_hash,payload_json,semantic_analysis_count,
                                  analysis_is_negative,negative_type,negative_subtype,is_deleted
                           FROM comments WHERE note_id=? AND author=? AND content=? AND published_at=?
                             AND parent_comment_id=? LIMIT 1""",
                        (note_id, author, content, published_at, parent_comment_id),
                    ).fetchone()
                if existing is None and not supplied_id and not published_at:
                    existing = db.execute(
                        """SELECT comment_id,note_id,parent_comment_id,published_at,author_url,comment_level,
                                  content_hash,payload_json,semantic_analysis_count,
                                  analysis_is_negative,negative_type,negative_subtype,is_deleted
                           FROM comments WHERE note_id=? AND author=? AND content=? AND parent_comment_id=? LIMIT 1""",
                        (note_id, author, content, parent_comment_id),
                    ).fetchone()
                if existing:
                    stored_id = str(existing["comment_id"])
                    if text(existing["note_id"], 128) != note_id:
                        raise ValueError(f"评论 ID 已属于其他帖子，已停止串帖写入：{stored_id}")
                    if supplied_id:
                        comment_id_aliases[supplied_id] = stored_id
                    parent_comment_id = parent_comment_id or text(existing["parent_comment_id"], 256)
                    published_at = published_at or text(existing["published_at"], 100)
                    author_url = text(item.get("authorUrl"), 2000) or text(existing["author_url"], 2000)
                    incoming_level = max(1, min(int(item.get("commentLevel") or 1), 3))
                    comment_level = max(2, incoming_level) if parent_comment_id else (
                        int(existing["comment_level"] or 1) if not item.get("commentLevel") else incoming_level
                    )
                    changed = str(existing["content_hash"]) != content_hash
                    try:
                        stored_payload = json.loads(existing["payload_json"] or "{}")
                        if not isinstance(stored_payload, dict):
                            stored_payload = {}
                    except (TypeError, ValueError):
                        stored_payload = {}
                    current_payload = {
                        **stored_payload, **item, "commentId": stored_id, "noteId": note_id,
                        "parentCommentId": parent_comment_id, "publishedAt": published_at,
                        "authorUrl": author_url, "commentLevel": comment_level,
                        "commentType": "子评论" if comment_level >= 2 else "主评论",
                        "commentStatus": COMMENT_STATUS_PRESENT, "isDeleted": False,
                        "semanticAnalysisCount": int(existing["semantic_analysis_count"] or 0),
                        "analysisIsNegative": text(existing["analysis_is_negative"], 40),
                        "negativeType": text(existing["negative_type"], 1000),
                        "negativeSubtype": text(existing["negative_subtype"], 2000),
                    }
                    current_payload = enrich_time_payload(current_payload, timestamp, kind="comment", previous=stored_payload)
                    current_payload.pop("presenceReason", None)
                    current_payload.pop("presenceReasonAt", None)
                    current_payload.pop("presenceReason", None)
                    current_payload.pop("presenceReasonAt", None)
                    db.execute(
                        """
                        UPDATE comments SET last_seen_at=?, like_count=?, reply_count=?,
                            parent_comment_id=?, content=?, author=?, author_url=?, published_at=?,
                            comment_url=?, comment_level=?, content_hash=?, payload_json=?,
                            ai_analysis_status=CASE WHEN ? THEN 'not_analyzed' ELSE ai_analysis_status END,
                            comment_status=?,is_deleted=0,deleted_at='',last_presence_checked_at=?
                        WHERE comment_id=?
                        """,
                        (timestamp, int(item.get("likeCount") or 0), int(item.get("replyCount") or 0),
                         parent_comment_id, content, author,
                         author_url, published_at,
                         text(item.get("commentUrl"), 2000),
                         comment_level,
                         content_hash, json.dumps(current_payload, ensure_ascii=False), int(changed),
                         COMMENT_STATUS_PRESENT, timestamp, stored_id),
                    )
                    if changed:
                        changed_ids.append(stored_id)
                    continue
                comment_level = max(1, min(int(item.get("commentLevel") or 1), 3))
                if parent_comment_id:
                    comment_level = max(2, comment_level)
                current_payload = {
                    **item, "commentId": comment_id, "noteId": note_id,
                    "parentCommentId": parent_comment_id, "publishedAt": published_at,
                    "authorUrl": text(item.get("authorUrl"), 2000),
                    "commentLevel": comment_level,
                    "commentType": "子评论" if comment_level >= 2 else "主评论",
                    "commentStatus": COMMENT_STATUS_PRESENT, "isDeleted": False,
                }
                current_payload = enrich_time_payload(current_payload, timestamp, kind="comment")
                db.execute(
                    """
                    INSERT INTO comments (
                        comment_id,note_id,parent_comment_id,content,author,author_url,published_at,
                        like_count,reply_count,comment_url,comment_level,first_seen_at,last_seen_at,
                        payload_json,content_hash,comment_status,is_deleted,deleted_at,last_presence_checked_at
                    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,'',?)
                    """,
                    (comment_id, note_id, parent_comment_id, content, author,
                     text(item.get("authorUrl"), 2000), published_at, int(item.get("likeCount") or 0),
                     int(item.get("replyCount") or 0), text(item.get("commentUrl"), 2000),
                     comment_level, timestamp, timestamp,
                     json.dumps(current_payload, ensure_ascii=False), content_hash, COMMENT_STATUS_PRESENT, timestamp),
                )
                if supplied_id:
                    comment_id_aliases[supplied_id] = comment_id
                inserted_ids.append(comment_id)
            count = int(db.execute(
                "SELECT COUNT(*) FROM comments WHERE note_id=? AND is_deleted=0", (note_id,)
            ).fetchone()[0])
            expected_count = int(payload.get("expectedCount") or 0)
            collection_status = comment_snapshot_status(payload, len(raw_comments), collection_status)
            negative = int(db.execute(
                "SELECT COUNT(*) FROM comments WHERE note_id=? AND is_deleted=0 AND is_negative=1 AND ai_confidence>=0.85",
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
                "collectedCount": count, "currentCount": len(raw_comments), "status": collection_status}

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
            "commentStatus": comment_status_label(
                item.get("commentStatus") or item.get("comment_status"), item.get("isDeleted") or item.get("is_deleted")
            ),
            "isDeleted": bool_value(item.get("isDeleted") or item.get("is_deleted")),
        }

    def compare_comments(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Compare a fully expanded browser snapshot with local comments.

        Missing rows are only confirmed as removed when collection is likely
        complete, so a collapsed or slow reply thread is never deleted.
        """
        validate_snapshot_identity(payload)
        note_id = valid_note_id(payload.get("noteId"))
        if not note_id:
            raise ValueError("noteId is required")
        raw_comments = payload.get("comments") or []
        if not isinstance(raw_comments, list):
            raise ValueError("comments must be an array")
        raw_comments = self._normalize_snapshot_comments(note_id, raw_comments)
        return self._compare_normalized_comments(payload, note_id, raw_comments)

    def _compare_normalized_comments(
        self, payload: dict[str, Any], note_id: str, raw_comments: list[dict[str, Any]],
    ) -> dict[str, Any]:
        """Compare freshly normalized rows, never a cached browser preview.

        Only validated in-process callers supply these rows. The public preview
        still validates and normalizes; sync reuses its write-stage normalization
        while holding pull_lock, before any snapshot writes. No payload flag can
        opt a client out of validation or normalization.
        """
        current_by_identity: dict[tuple[str, ...], dict[str, Any]] = {}
        for item in raw_comments:
            if not isinstance(item, dict) or not text(item.get("content"), 8000):
                continue
            row = self._comment_api_row(item)
            identity = ("id", row["commentId"]) if row["commentId"] else (
                "legacy", row["parentCommentId"], row["author"], row["content"], row["publishedAt"]
            )
            current_by_identity[identity] = row
        current = list(current_by_identity.values())
        all_local = [self._comment_api_row(item) for item in self.list_comments(note_id, 10000)]
        local = [item for item in all_local if not item["isDeleted"] and item["commentStatus"] != COMMENT_STATUS_DELETED]
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
        by_exact = {(row["parentCommentId"], row["author"], row["content"], row["publishedAt"]): index
                    for index, row in enumerate(local)}
        by_loose = {(row["parentCommentId"], row["author"], row["content"]): index for index, row in enumerate(local)}
        matched: set[int] = set()
        new_comments: list[dict[str, Any]] = []
        changed_comments: list[dict[str, Any]] = []
        for row in current:
            supplied_id = row["commentId"]
            index = by_id.get(supplied_id) if supplied_id else None
            # A supplied comment ID is an opaque stable primary key. Never
            # merge two different IDs merely because author/text/time match.
            # Text fallbacks are reserved for legacy snapshots with no ID.
            if index is None and not supplied_id:
                index = by_exact.get((row["parentCommentId"], row["author"], row["content"], row["publishedAt"]))
            if index is None and not supplied_id:
                index = by_loose.get((row["parentCommentId"], row["author"], row["content"]))
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
        status = comment_snapshot_status(payload, len(current))
        expected_count = max(0, int(payload.get("expectedCount") or 0))
        explicit_empty_verified = bool_value(payload.get("explicitEmptyVerified"))
        collection_verified = collection_evidence_verified(payload)
        can_prune = status == "likely_complete"
        removed = missing if can_prune else []
        pending_removed = [] if can_prune else missing
        return {
            "ok": True, "noteId": note_id, "status": status,
            "expectedCount": expected_count, "currentCount": len(current),
            "explicitEmptyVerified": explicit_empty_verified,
            "collectionEvidenceVerified": collection_verified, "localCount": len(local),
            "historicalCount": len(all_local), "deletedLocalCount": len(all_local) - len(local),
            "canPrune": can_prune, "newCount": len(new_comments), "removedCount": len(removed),
            "changedCount": len(changed_comments), "pendingRemovedCount": len(pending_removed),
            "hasChanges": bool(new_comments or removed or changed_comments or note_changes),
            "commentHasChanges": bool(new_comments or removed or changed_comments),
            "noteChanged": bool(note_changes), "noteChanges": note_changes,
            "newComments": new_comments, "removedComments": removed,
            "changedComments": changed_comments, "pendingRemovedComments": pending_removed,
        }

    def _legacy_delete_comment_rows_from_xlsx(self, note_id: str, removed: list[dict[str, Any]]) -> int:
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

    def _delete_comment_rows_from_xlsx(self, note_id: str, removed: list[dict[str, Any]]) -> int:
        """Compatibility helper: mark missing CSV comments deleted; never remove rows."""
        if not removed:
            return 0
        _notes_path, comments_path = self._csv_paths()
        headers, rows = self._read_csv_table(comments_path, COMMENT_CSV_HEADERS)
        if "评论状态" not in headers:
            headers.append("评论状态")
        removed_ids = {text(item.get("commentId"), 256) for item in removed if text(item.get("commentId"), 256)}
        removed_exact = {(text(item.get("author"), 500), text(item.get("content"), 8000),
                          text(item.get("publishedAt"), 100)) for item in removed}
        marked = 0
        for row in rows:
            belongs = csv_comment_note_id(row) == note_id
            row_id = text(row.get("笔记评论ID"), 256)
            row_key = (text(row.get("用户昵称"), 500), text(row.get("评论内容"), 8000),
                       text(row.get("评论时间"), 100))
            if belongs and (row_id in removed_ids or row_key in removed_exact):
                if comment_status_label(row.get("评论状态")) != COMMENT_STATUS_DELETED:
                    marked += 1
                row["评论状态"] = COMMENT_STATUS_DELETED
        if marked:
            self._replace_csv_table(comments_path, headers, rows, "comment-mark-deleted")
        return marked

    def _mark_missing_comments_deleted(
        self, note_id: str, current_ids: list[str], checked_at: str
    ) -> int:
        """Soft-delete IDs absent from one trusted complete snapshot and update their payloads."""
        with self.lock, self._session() as db:
            if current_ids:
                placeholders = ",".join("?" for _ in current_ids)
                marked = db.execute(
                    f"""UPDATE comments SET comment_status=?,is_deleted=1,
                        deleted_at=CASE WHEN deleted_at='' THEN ? ELSE deleted_at END,
                        last_presence_checked_at=?
                        WHERE note_id=? AND is_deleted=0 AND comment_id NOT IN ({placeholders})""",
                    (COMMENT_STATUS_DELETED, checked_at, checked_at, note_id, *current_ids),
                ).rowcount
            else:
                marked = db.execute(
                    """UPDATE comments SET comment_status=?,is_deleted=1,
                       deleted_at=CASE WHEN deleted_at='' THEN ? ELSE deleted_at END,
                       last_presence_checked_at=? WHERE note_id=? AND is_deleted=0""",
                    (COMMENT_STATUS_DELETED, checked_at, checked_at, note_id),
                ).rowcount
            if marked:
                rows = db.execute(
                    """SELECT comment_id,payload_json,deleted_at,last_presence_checked_at FROM comments
                       WHERE note_id=? AND is_deleted=1 AND last_presence_checked_at=?""",
                    (note_id, checked_at),
                ).fetchall()
                for row in rows:
                    try:
                        deleted_payload = json.loads(row["payload_json"] or "{}")
                        if not isinstance(deleted_payload, dict):
                            deleted_payload = {}
                    except (TypeError, ValueError):
                        deleted_payload = {}
                    deleted_payload.update({
                        "commentId": str(row["comment_id"]), "noteId": note_id,
                        "commentStatus": COMMENT_STATUS_DELETED, "isDeleted": True,
                        "deletedAt": str(row["deleted_at"] or checked_at),
                        "lastPresenceCheckedAt": str(row["last_presence_checked_at"] or checked_at),
                        "presenceReason": "snapshot_missing", "presenceReasonAt": checked_at,
                    })
                    db.execute(
                        "UPDATE comments SET payload_json=? WHERE comment_id=?",
                        (json.dumps(deleted_payload, ensure_ascii=False), row["comment_id"]),
                    )
        return int(marked)

    def sync_comment_snapshot(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Apply one all-or-nothing note/comment snapshot across every local store."""
        validate_snapshot_identity(payload)
        note_id = valid_note_id(payload.get("noteId"))
        if not note_id:
            raise ValueError("noteId is required")
        with self.pull_lock:
            checkpoint = self._capture_sync_checkpoint(note_id)
            try:
                result = self._sync_comment_snapshot_unchecked(payload)
            except Exception as exc:
                rollback_errors = self._rollback_sync_checkpoints([checkpoint])
                if rollback_errors:
                    raise RuntimeError(
                        f"同步失败且回滚未完全成功：{'；'.join(rollback_errors)}"
                    ) from exc
                raise
            self._discard_sync_checkpoint(checkpoint)
            return result

    def _sync_comment_snapshot_unchecked(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Unchecked implementation; public callers use the rollback wrapper above."""
        note_id = valid_note_id(payload.get("noteId"))
        if not note_id:
            raise ValueError("noteId is required")
        comments = payload.get("comments") or []
        if not isinstance(comments, list):
            raise ValueError("comments must be an array")
        with self.pull_lock:
            self._normalize_csv_cross_store_fields()
            comments = self._normalize_snapshot_comments(note_id, comments)
            comparison = self._compare_normalized_comments({**payload, "comments": comments}, note_id, comments)
            with self.lock, self._session() as db:
                stored = db.execute("SELECT * FROM notes WHERE note_id=?", (note_id,)).fetchone()
            if stored is None:
                raise ValueError("帖子尚未写入本地数据库")
            stored_row = dict(stored)
            pull_status = text(stored_row.get("pull_status"), 30) or "not_started"
            if pull_status in {"synced", "partial", "failed"}:
                pull_status = "synced" if comparison["canPrune"] and stored_row.get("media_status") == "complete" else "partial"
            try:
                stored_payload = json.loads(stored_row.get("payload_json") or "{}")
                if not isinstance(stored_payload, dict):
                    stored_payload = {}
            except (TypeError, ValueError):
                stored_payload = {}
            incoming_note = browser_note_payload(payload.get("note"))
            note = {**browser_note_payload(stored_payload), **incoming_note, "noteId": note_id}
            if text(incoming_note.get("publishedAt"), 100):
                # A live sync is a new observation even when the rounded label
                # is still "7 days ago". Older clients may omit the clock.
                note["timeObservedAt"] = text(incoming_note.get("timeObservedAt"), 80) or text(payload.get("collectedAt"), 80) or now_iso()
                note["timeReferenceSource"] = "capture"
            note = enrich_time_payload(note, now_iso(), previous=stored_payload)
            if "tags" in incoming_note:
                note["tags"] = canonical_tag_items(incoming_note.get("tags")) or (
                    ["无话题"] if tag_text(incoming_note.get("tags")) == "无话题" else note.get("tags", [])
                )
            for field, column in (("url", "url"), ("title", "title"), ("content", "content"), ("author", "author")):
                if not note.get(field):
                    note[field] = stored_row.get(column) or ""
            note["title"] = canonical_note_title(note.get("title"), note.get("content"), 80)
            media_dir = text(stored_row.get("media_dir"), 4000)
            media_files = sorted(item.name for item in Path(media_dir).iterdir() if item.is_file()) if media_dir and Path(media_dir).is_dir() else []
            media_result = {"folder": media_dir, "files": media_files}
            upserted = self.upsert_comments({
                "noteId": note_id, "comments": comments,
                "expectedCount": comparison["expectedCount"],
                "status": comparison["status"],
                "collectionEvidence": payload.get("collectionEvidence"),
                "explicitEmptyVerified": payload.get("explicitEmptyVerified"),
                "collectedAt": now_iso(),
            })
            xlsx_result = self._sync_pull_to_xlsx(
                note, comments, media_result, replace_comments=bool(comparison["canPrune"])
            )
            removed = comparison["removedComments"] if comparison["canPrune"] else []
            excel_removed = int(xlsx_result.get("commentMarkedDeleted", 0) or 0)
            current_ids = [text(item.get("commentId"), 256) for item in comments if text(item.get("commentId"), 256)]
            checked_at = now_iso()
            deleted_marked = 0
            with self.lock, self._session() as db:
                if comparison["canPrune"]:
                    if current_ids:
                        placeholders = ",".join("?" for _ in current_ids)
                        deleted_marked = db.execute(
                            f"""UPDATE comments SET comment_status=?,is_deleted=1,
                                deleted_at=CASE WHEN deleted_at='' THEN ? ELSE deleted_at END,
                                last_presence_checked_at=?
                                WHERE note_id=? AND is_deleted=0 AND comment_id NOT IN ({placeholders})""",
                            (COMMENT_STATUS_DELETED, checked_at, checked_at, note_id, *current_ids),
                        ).rowcount
                    else:
                        deleted_marked = db.execute(
                            """UPDATE comments SET comment_status=?,is_deleted=1,
                               deleted_at=CASE WHEN deleted_at='' THEN ? ELSE deleted_at END,
                               last_presence_checked_at=? WHERE note_id=? AND is_deleted=0""",
                            (COMMENT_STATUS_DELETED, checked_at, checked_at, note_id),
                        ).rowcount
                if comparison["canPrune"] and deleted_marked:
                    newly_deleted_rows = db.execute(
                        """SELECT comment_id,payload_json,deleted_at,last_presence_checked_at FROM comments
                           WHERE note_id=? AND is_deleted=1 AND last_presence_checked_at=?""",
                        (note_id, checked_at),
                    ).fetchall()
                    for deleted_row in newly_deleted_rows:
                        try:
                            deleted_payload = json.loads(deleted_row["payload_json"] or "{}")
                            if not isinstance(deleted_payload, dict):
                                deleted_payload = {}
                        except (TypeError, ValueError):
                            deleted_payload = {}
                        deleted_payload.update({
                            "commentId": str(deleted_row["comment_id"]), "noteId": note_id,
                            "commentStatus": COMMENT_STATUS_DELETED, "isDeleted": True,
                            "deletedAt": str(deleted_row["deleted_at"] or checked_at),
                            "lastPresenceCheckedAt": str(deleted_row["last_presence_checked_at"] or checked_at),
                            "presenceReason": "snapshot_missing", "presenceReasonAt": checked_at,
                        })
                        db.execute("UPDATE comments SET payload_json=? WHERE comment_id=?",
                                   (json.dumps(deleted_payload, ensure_ascii=False), deleted_row["comment_id"]))
                count = int(db.execute(
                    "SELECT COUNT(*) FROM comments WHERE note_id=? AND is_deleted=0", (note_id,)
                ).fetchone()[0])
                db.execute(
                    """UPDATE notes SET comment_count_collected=?,comment_collection_status=?,pull_status=?,last_comment_collected_at=?,
                       access_status='ok',access_error='',last_access_checked_at=?,access_check_result='opened',
                       post_status=?,is_deleted=0,deleted_at='',last_presence_checked_at=?,
                       title=CASE WHEN ?<>'' THEN ? ELSE title END,
                       content=CASE WHEN ?<>'' THEN ? ELSE content END,
                       author=CASE WHEN ?<>'' THEN ? ELSE author END,
                       url=CASE WHEN ?<>'' THEN ? ELSE url END,
                       keyword=CASE WHEN ?<>'' THEN ? ELSE keyword END,
                       tags=CASE WHEN ?<>'' THEN ? ELSE tags END,
                       post_sentiment=CASE WHEN ?<>'' THEN ? ELSE post_sentiment END,
                       payload_json=?,last_seen_at=?
                       WHERE note_id=?""",
                    (count, comparison["status"], pull_status,
                     checked_at, checked_at, POST_STATUS_PRESENT, checked_at,
                     text(note.get("title"), 1000), text(note.get("title"), 1000),
                     text(note.get("content"), 20000), text(note.get("content"), 20000),
                     text(note.get("author"), 500), text(note.get("author"), 500),
                     text(note.get("url"), 4000), text(note.get("url"), 4000),
                     text(note.get("keyword"), 200), text(note.get("keyword"), 200),
                     tag_text(note.get("tags")), tag_text(note.get("tags")),
                     text(note.get("postSentiment"), 80), text(note.get("postSentiment"), 80),
                     json.dumps(note, ensure_ascii=False), checked_at, note_id),
                )
            if media_dir:
                self._refresh_material_snapshot_for_note(note_id)
            consistency = self._verify_note_store_consistency(note_id, media_dir)
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
                "pullStatus": pull_status, "commentStatus": comparison["status"],
                "postStatus": POST_STATUS_PRESENT, "isDeleted": False,
                "newCount": comparison["newCount"], "removedCount": len(removed),
                "changedCount": comparison["changedCount"], "collectedCount": count,
                "excelAdded": int(xlsx_result.get("commentAdded", 0) or 0),
                "excelRemoved": excel_removed, "commentsMarkedDeleted": deleted_marked,
                "canPrune": comparison["canPrune"],
                "currentCount": comparison["currentCount"], "pendingRemovedCount": comparison["pendingRemovedCount"],
                "storesSynced": ["notes_csv", "comments_csv", "sqlite"] + (["materials"] if media_dir else []),
                "consistencyVerified": True, "consistency": consistency,
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
        with self.pull_lock, self.lock, self._session() as db:
            if not db.execute("SELECT 1 FROM notes WHERE note_id=?", (note_id,)).fetchone():
                raise ValueError("帖子尚未写入本地数据库")
            db.execute("UPDATE notes SET comment_collection_status='collecting' WHERE note_id=?", (note_id,))
            cursor = db.execute(
                """INSERT INTO comment_collection_jobs(note_id,status,started_at)
                   VALUES(?,'collecting',?)""", (note_id, timestamp)
            )
        return {"ok": True, "jobId": cursor.lastrowid, "noteId": note_id, "status": "collecting"}

    def list_comments(self, note_id: str, limit: int = 500, include_deleted: bool = True) -> list[dict[str, Any]]:
        note_id = valid_note_id(note_id)
        if not note_id:
            return []
        where = "note_id=?" if include_deleted else "note_id=? AND is_deleted=0"
        with self.lock, self._session() as db:
            rows = db.execute(
                f"SELECT * FROM comments WHERE {where} ORDER BY first_seen_at LIMIT ?",
                (note_id, max(1, min(int(limit), 10000))),
            ).fetchall()
        return [dict(row) for row in rows]


    def _legacy_excel_note_artifacts(self, note_id: str) -> tuple[str, list[str], int]:
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

    def _excel_note_artifacts(self, note_id: str) -> tuple[str, list[str], int]:
        if not self.seed_xlsx_path:
            return "", [], 0
        notes_path, _comments_path = self._csv_paths()
        if not notes_path.is_file():
            return "", [], 0
        try:
            stat = notes_path.stat()
            cache_key = (str(notes_path).casefold(), int(stat.st_mtime_ns), int(stat.st_size))
        except OSError:
            return "", [], 0
        with self._excel_artifact_cache_lock:
            if self._excel_artifact_cache_key != cache_key:
                _headers, rows = self._read_csv_table(notes_path, NOTE_CSV_HEADERS)
                artifact_index: dict[str, tuple[str, list[str], int]] = {}
                for row_number, row in enumerate(rows, 2):
                    row_id = valid_note_id(row.get("笔记ID"))
                    if not row_id:
                        continue
                    folder = text(row.get("对应帖子文件夹地址"), 4000)
                    files = [line.strip() for line in text(row.get("文件夹内清单"), 50000).splitlines() if line.strip()]
                    artifact_index[row_id] = (folder, files, row_number)
                self._excel_artifact_cache = artifact_index
                self._excel_artifact_cache_key = cache_key
            raw_folder, files, row_number = self._excel_artifact_cache.get(note_id, ("", [], 0))
        return raw_folder, list(files), row_number

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
                "SELECT * FROM comments WHERE note_id=? AND is_deleted=0 ORDER BY first_seen_at LIMIT 12", (note_id,)
            ).fetchall() if row is not None else []
            comment_count = int(db.execute(
                "SELECT COUNT(*) FROM comments WHERE note_id=? AND is_deleted=0", (note_id,)
            ).fetchone()[0]) if row is not None else 0
            deleted_comment_count = int(db.execute(
                "SELECT COUNT(*) FROM comments WHERE note_id=? AND is_deleted=1", (note_id,)
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
            "postStatus": post_status_label(item.get("post_status"), item.get("is_deleted")),
            "isDeleted": bool(item.get("is_deleted")),
            "deletedAt": item.get("deleted_at") or "",
            "lastPresenceCheckedAt": item.get("last_presence_checked_at") or "",
            "semanticAnalysisCount": int(item.get("semantic_analysis_count") or 0),
            "analysisIsNegative": item.get("analysis_is_negative") or "",
            "negativeType": item.get("negative_type") or "",
            "negativeSubtype": item.get("negative_subtype") or "",
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
                "commentStatus": comment_status_label(stored.get("comment_status"), stored.get("is_deleted")),
                "isDeleted": bool(stored.get("is_deleted")),
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
            "excelRow": excel_row, "commentCount": comment_count,
            "deletedCommentCount": deleted_comment_count,
            "totalHistoricalCommentCount": comment_count + deleted_comment_count,
            "commentRows": comments,
            "aiStatus": item.get("ai_analysis_status") or "",
            "accessStatus": item.get("access_status") or "",
            "accessError": item.get("access_error") or "",
            "lastAccessCheckedAt": item.get("last_access_checked_at") or "",
            "postStatus": post_status_label(item.get("post_status"), item.get("is_deleted")),
            "isDeleted": bool(item.get("is_deleted")),
            "deletedAt": item.get("deleted_at") or "",
            "lastPresenceCheckedAt": item.get("last_presence_checked_at") or "",
            "watched": bool(watch_row),
            "watchPriority": watch_row["priority"] if watch_row else "",
            "watchReason": watch_row["reason"] if watch_row else "",
        }

    def _legacy_sync_irrelevant_to_xlsx(self, note: dict[str, Any], comments: list[dict[str, Any]], decision: dict[str, Any]) -> dict[str, Any]:
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

    def _sync_irrelevant_to_xlsx(self, note: dict[str, Any], comments: list[dict[str, Any]], decision: dict[str, Any]) -> dict[str, Any]:
        # CSV mode deliberately has exactly two business tables. Irrelevant
        # candidates remain fully queryable in SQLite instead of creating a third file.
        return {"path": "", "sheet": "sqlite:irrelevant", "row": 0, "storedIn": "sqlite"}

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
        with self.pull_lock, self.lock, self._session() as db:
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
        data = {"monitor_brand": "请在本地词库中配置要监控的品牌、产品、门店和账号",
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
        with self.pull_lock, self.lock, self._session() as db:
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
        with self.pull_lock, self.lock, self._session() as db:
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
            "你代表当前监控品牌的官方账号。只回应用户当前问题，不把评论写成广告。"
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

    def _publish_ai_results(self, entries: list[dict[str, Any]], model: str, request: Any) -> None:
        """Publish one model response under the existing cross-store rollback contract."""
        with self.pull_lock, self.lock:
            prepared: list[dict[str, Any]] = []
            media_by_note: dict[str, str] = {}
            comment_note_ids: set[str] = set()
            with self._session() as db:
                for entry in entries:
                    job, before = entry["job"], entry["row"]
                    target_type, target_id = str(job["target_type"]), str(job["target_id"])
                    table, key, sentiment_column = ("notes", "note_id", "post_sentiment") \
                        if target_type == "note" else ("comments", "comment_id", "sentiment")
                    current = db.execute(f"SELECT * FROM {table} WHERE {key}=?", (target_id,)).fetchone()
                    note = current if target_type == "note" else db.execute(
                        "SELECT * FROM notes WHERE note_id=?", (before["note_id"],)
                    ).fetchone()
                    if current is None or note is None or current["is_deleted"] or note["is_deleted"] or post_status_label(
                        note["post_status"], note["is_deleted"]
                    ) == POST_STATUS_DELETED or (target_type == "comment" and comment_status_label(
                        current["comment_status"], current["is_deleted"]
                    ) == COMMENT_STATUS_DELETED):
                        raise AIServiceError("分析对象已不存在或已删除", "missing_target", False)
                    fields = ("note_id", "first_seen_at", "content_hash", "content", "author", "deleted_at") + (
                        ("title", "tags") if target_type == "note" else ("parent_comment_id",)
                    )
                    if any(current[field] != before[field] for field in fields) or (
                        target_type == "comment" and any(
                            note[field] != entry["context"][field]
                            for field in ("first_seen_at", "title", "ai_summary", "deleted_at")
                        )
                    ):
                        raise AIServiceError("分析期间对象或帖子上下文已变化，请重新分析", "stale_target", True)
                    active_job = db.execute("SELECT * FROM ai_jobs WHERE id=?", (job["id"],)).fetchone()
                    if active_job is None or active_job["target_type"] != target_type \
                            or active_job["target_id"] != target_id \
                            or active_job["status"] not in {"queued", "analyzing"}:
                        raise AIServiceError("分析任务已取消或被替换", "stale_job", False)
                    # Imported labels without AI provenance, reviewed labels and
                    # edits made during the request remain authoritative. Review,
                    # manual-negative, semantic and presence fields are not written.
                    preserve_sentiment = bool(current["manual_negative"]) \
                        or current["review_status"] != "pending_review" \
                        or current[sentiment_column] != before[sentiment_column] \
                        or bool(current[sentiment_column] and not current["last_ai_analyzed_at"])
                    prepared.append({
                        **entry, "table": table, "key": key, "sentiment_column": sentiment_column,
                        "sentiment": current[sentiment_column] if preserve_sentiment else entry["result"]["sentiment"],
                    })
                    media_by_note[str(note["note_id"])] = text(note["media_dir"], 4000)
                    if target_type == "comment":
                        comment_note_ids.add(str(note["note_id"]))

            checkpoints: list[dict[str, Any]] = []
            mutation_started = False
            try:
                for index, note_id in enumerate(sorted(media_by_note)):
                    checkpoints.append(self._capture_sync_checkpoint(note_id, capture_csv=index == 0))
                mutation_started = True
                timestamp = now_iso()
                with self._session() as db:
                    for entry in prepared:
                        result, job = entry["result"], entry["job"]
                        db.execute(
                            f"""UPDATE {entry['table']} SET {entry['sentiment_column']}=?,is_negative=?,risk_level=?,
                               issue_categories=?,ai_summary=?,ai_reason=?,ai_confidence=?,needs_attention=?,suggested_action=?,
                               last_ai_analyzed_at=? WHERE {entry['key']}=?""",
                            (entry["sentiment"], result["is_negative"], result["risk_level"], result["issue_categories"],
                             result["ai_summary"], result["ai_reason"], result["ai_confidence"], result["needs_attention"],
                             result["suggested_action"], timestamp, job["target_id"]),
                        )
                    for note_id in comment_note_ids:
                        db.execute(
                            """UPDATE notes SET negative_comment_count=(SELECT COUNT(*) FROM comments
                               WHERE note_id=? AND is_deleted=0 AND is_negative=1 AND ai_confidence>=0.85)
                               WHERE note_id=?""", (note_id, note_id),
                        )
                notes_path, comments_path = self._csv_paths()
                note_headers, note_rows = self._read_csv_table(notes_path, NOTE_CSV_HEADERS)
                comment_headers, comment_rows = self._read_csv_table(comments_path, COMMENT_CSV_HEADERS)
                labels = {(str(entry["job"]["target_type"]), str(entry["job"]["target_id"])):
                          persisted_sentiment_label(entry["sentiment"]) for entry in prepared}
                for target_type, rows, id_header in (
                    ("note", note_rows, "笔记ID"), ("comment", comment_rows, "笔记评论ID")
                ):
                    for row in rows:
                        identity = (target_type, text(row.get(id_header), 256))
                        if identity in labels:
                            row["AI情绪判断"] = labels[identity]
                            if target_type == "note":
                                row["帖子好坏"] = labels[identity]
                # Do not use the legacy best-effort AI CSV writer: it swallows
                # replacement failures. These existing primitives propagate them.
                self._replace_csv_pair(note_headers, note_rows, comment_headers, comment_rows, "ai-publication")
                for note_id in sorted(media_by_note):
                    self._refresh_material_snapshot_for_note(note_id)
                for note_id, media_dir in sorted(media_by_note.items()):
                    self._verify_note_store_consistency(note_id, media_dir, verify_fields=True)
                # Checkpoints cover note/comment data, not AI history/jobs. Keep
                # every terminal write in this final transaction after verification.
                with self._session() as db:
                    for entry in prepared:
                        job = entry["job"]
                        db.execute(
                            f"UPDATE {entry['table']} SET ai_analysis_status='completed' WHERE {entry['key']}=?",
                            (job["target_id"],),
                        )
                        db.execute(
                            """INSERT INTO ai_analysis_records(target_type,target_id,model,request_json,response_json,status,created_at)
                               VALUES(?,?,?,?,?,'completed',?)""",
                            (job["target_type"], job["target_id"], model, json.dumps(request, ensure_ascii=False),
                             json.dumps(entry["result"], ensure_ascii=False), timestamp),
                        )
                        db.execute("UPDATE ai_jobs SET status='completed',last_error='',updated_at=? WHERE id=?",
                                   (timestamp, job["id"]))
            except Exception as exc:
                if mutation_started:
                    failures = self._rollback_sync_checkpoints(checkpoints)
                    if failures:
                        raise AIServiceError("AI 结果发布回滚未完成：" + "；".join(failures),
                                             "publication_rollback_failed", False) from exc
                else:
                    for checkpoint in reversed(checkpoints):
                        self._discard_sync_checkpoint(checkpoint)
                raise AIServiceError("AI 结果发布失败，已保留原数据，请重试：" + text(exc, 1000),
                                     "publication_failed", True) from exc
            for checkpoint in reversed(checkpoints):
                self._discard_sync_checkpoint(checkpoint)

    def _run_ai_job(self, job: sqlite3.Row) -> None:
        target_type, target_id = str(job["target_type"]), str(job["target_id"])
        table, key = ("notes", "note_id") if target_type == "note" else ("comments", "comment_id")
        settings = self.ai_settings.get(True)
        if not settings.get("configured"):
            raise AIServiceError("DeepSeek API Key 未配置", "not_configured", False)
        with self.pull_lock, self.lock, self._session() as db:
            row = db.execute(f"SELECT * FROM {table} WHERE {key}=?", (target_id,)).fetchone()
            if row is None or row["is_deleted"] or (target_type == "note" and post_status_label(
                row["post_status"], row["is_deleted"]
            ) == POST_STATUS_DELETED) or (target_type == "comment" and comment_status_label(
                row["comment_status"], row["is_deleted"]
            ) == COMMENT_STATUS_DELETED):
                raise AIServiceError("分析对象已不存在或已删除", "missing_target", False)
            context: dict[str, Any] = {}
            if target_type == "comment":
                note = db.execute("SELECT * FROM notes WHERE note_id=?", (row["note_id"],)).fetchone()
                if note is None or note["is_deleted"] or post_status_label(note["post_status"], note["is_deleted"]) == POST_STATUS_DELETED:
                    raise AIServiceError("评论所属帖子已不存在或已删除", "missing_target", False)
                context = dict(note)
            db.execute(f"UPDATE {table} SET ai_analysis_status='analyzing' WHERE {key}=?", (target_id,))
        messages = self._analysis_prompt(target_type, row, context)
        result = self._normalized_analysis(self.ai_client.complete_json(settings, messages))
        self._publish_ai_results([
            {"job": job, "row": row, "context": context, "result": result}
        ], settings["model"], messages)

    def _run_comment_batch(self, jobs: list[sqlite3.Row]) -> None:
        settings = self.ai_settings.get(True)
        if not settings.get("configured"):
            raise AIServiceError("DeepSeek API Key 未配置", "not_configured", False)
        rows: dict[str, sqlite3.Row] = {}
        contexts: dict[str, dict[str, Any]] = {}
        inputs: list[dict[str, Any]] = []
        with self.pull_lock, self.lock, self._session() as db:
            for job in jobs:
                target_id = str(job["target_id"])
                row = db.execute("SELECT * FROM comments WHERE comment_id=?", (target_id,)).fetchone()
                if row is None or row["is_deleted"] or comment_status_label(row["comment_status"], row["is_deleted"]) == COMMENT_STATUS_DELETED:
                    raise AIServiceError("评论分析对象已不存在或已删除", "missing_target", False)
                note = db.execute("SELECT * FROM notes WHERE note_id=?", (row["note_id"],)).fetchone()
                if note is None or note["is_deleted"] or post_status_label(note["post_status"], note["is_deleted"]) == POST_STATUS_DELETED:
                    raise AIServiceError("评论所属帖子已不存在或已删除", "missing_target", False)
                rows[target_id] = row
                contexts[target_id] = dict(note)
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
        entries: list[dict[str, Any]] = []
        for job in jobs:
            target_id = str(job["target_id"])
            item = by_id.get(target_id)
            if item is None:
                raise AIServiceError(f"批量结果缺少 {target_id}", "invalid_response", True)
            entries.append({"job": job, "row": rows[target_id], "context": contexts[target_id],
                            "result": self._normalized_analysis(item)})
        self._publish_ai_results(entries, settings["model"], inputs)

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
        with self.pull_lock, self.lock, self._session() as db:
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
            deleted_posts = int(db.execute("SELECT COUNT(*) FROM notes WHERE is_deleted=1").fetchone()[0])
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
                "activePosts": total - deleted_posts,
                "deletedPosts": deleted_posts,
                "excelExisting": excel_existing,
                "excelMissing": excel_missing,
                "pullByStatus": pull_by_status,
            },
            "lastSeenAt": str(latest or ""),
            "db": str(self.db_path),
        }

    def list_notes(self, status: str = "", limit: int = 100, include_deleted: bool = True) -> list[dict[str, Any]]:
        limit = max(1, min(int(limit or 100), 1000))
        clauses: list[str] = []
        params: list[Any] = []
        if status:
            clauses.append("status=?")
            params.append(status)
        if not include_deleted:
            clauses.append("is_deleted=0")
        where = f" WHERE {' AND '.join(clauses)}" if clauses else ""
        with self.lock, self._session() as db:
            rows = db.execute(
                f"SELECT * FROM notes{where} ORDER BY first_seen_at DESC LIMIT ?", (*params, limit)
            ).fetchall()
        return [dict(row) for row in rows]

    def _data_overview_snapshot_token(self) -> str:
        """Fingerprint query data, not SQLite/WAL bookkeeping or file mtimes.

        All notes/comments columns are included: the dynamic field catalogue can
        expose fields that are not currently visible. Other tables (jobs, logs,
        receipts and caches) cannot change these SELECT results. CSV/material
        bytes remain in the fingerprint so external edits still invalidate it.
        """
        with self.lock:
            notes_path, comments_path = self._csv_paths()
            paths = [notes_path, comments_path]
            fingerprint = hashlib.sha256()

            def add(value: Any) -> None:
                fingerprint.update(json.dumps(
                    self._checkpoint_json_value(value), ensure_ascii=False,
                    sort_keys=True, separators=(",", ":"),
                ).encode("utf-8"))
                fingerprint.update(b"\n")

            add({"snapshotFormat": 2, "dbPath": str(self.db_path.resolve()).casefold()})
            db = self._connect()
            try:
                db.execute("PRAGMA query_only=ON")
                db.execute("BEGIN")
                for table, key in (("notes", "note_id"), ("comments", "comment_id")):
                    add({"table": table, "schema": [tuple(row) for row in db.execute(
                        f"PRAGMA table_info({table})"
                    )]})
                    for row in db.execute(f"SELECT * FROM {table} ORDER BY {key}"):
                        add(dict(row))
                material_dirs = [
                    text(row[0], 4000) for row in db.execute(
                        "SELECT DISTINCT media_dir FROM notes WHERE TRIM(COALESCE(media_dir,''))<>'' ORDER BY media_dir"
                    ).fetchall() if text(row[0], 4000)
                ]
            finally:
                db.close()
            for folder in material_dirs:
                material_root = Path(folder)
                add({"materialDir": str(material_root.resolve()).casefold(),
                     "files": sorted(item.name for item in material_root.iterdir() if item.is_file())
                     if material_root.is_dir() else None})
                paths.extend(material_root / name for name in ("note.json", "comments.json", "帖子正文.txt"))
            for path in paths:
                # Deliberately no stat/mtime cache: same-size edits with a restored
                # timestamp must still be detected. Missing files have a distinct hash.
                add({"path": str(path.resolve()).casefold(), "sha256": self._file_sha256(path)})
            return fingerprint.hexdigest()

    def _validate_data_overview_read_snapshot(self, supplied_token: str, action: str) -> str:
        """Renew only an already-approved read snapshot after full verification.

        An independent read lease never extends the 30-minute deletion/purge
        lease. Unknown/revoked tokens still require an explicit schema refresh.
        """
        with self.pull_lock, self.lock:
            issued_at = self._data_overview_approved_tokens.get(supplied_token, 0)
            if not issued_at:
                raise ValueError("一致性快照已过期，请重新校验数据总览")
            current_token = self._data_overview_snapshot_token()
            if current_token != supplied_token:
                self._data_overview_approved_tokens.pop(supplied_token, None)
                self._data_overview_read_renewals.pop(supplied_token, None)
                raise ValueError(f"本地数据已变化，请重新校验后再{action}")
            read_issued_at = self._data_overview_read_renewals.get(supplied_token, issued_at)
            if time.time() - read_issued_at >= 1800:
                health = self.data_health()
                if health.get("summary", {}).get("relationshipsConsistent") is not True or any(
                    item.get("severity") == "critical" for item in health.get("issues", [])
                ):
                    self._data_overview_approved_tokens.pop(supplied_token, None)
                    self._data_overview_read_renewals.pop(supplied_token, None)
                    raise ValueError("一致性快照自动复核未通过，请更新数据并检查数据体检")
                if self._data_overview_snapshot_token() != supplied_token:
                    self._data_overview_approved_tokens.pop(supplied_token, None)
                    self._data_overview_read_renewals.pop(supplied_token, None)
                    raise ValueError(f"本地数据已变化，请重新校验后再{action}")
                self._data_overview_read_renewals[supplied_token] = time.time()
            return current_token

    def normalize_publication_storage(self) -> dict[str, Any]:
        """Backfill time projections without modifying raw dates, identities or presence.

        Only real collection timestamps are used for historical relative labels.
        Repeated schema refreshes reuse the persisted observation instant. The
        existing per-note journal protects CSV, SQLite and material JSON together.
        """
        with self.pull_lock, self.lock:
            notes_path, comments_path = self._csv_paths()
            note_headers, note_rows = self._read_csv_table(notes_path, NOTE_CSV_HEADERS)
            comment_headers, comment_rows = self._read_csv_table(comments_path, COMMENT_CSV_HEADERS)
            csv_ids = {valid_note_id(row.get("笔记ID")) for row in note_rows}
            with self._session() as db:
                notes = [dict(row) for row in db.execute("SELECT * FROM notes")]
                comments = [dict(row) for row in db.execute("SELECT * FROM comments")]

            def payload_of(row: dict[str, Any]) -> dict[str, Any]:
                try:
                    value = json.loads(row.get("payload_json") or "{}")
                    return value if isinstance(value, dict) else {}
                except (TypeError, ValueError):
                    return {}

            normalized_notes: dict[str, dict[str, Any]] = {}
            normalized_comments: dict[str, tuple[str, dict[str, Any]]] = {}
            changed_ids: set[str] = set()
            note_updates: dict[str, dict[str, Any]] = {}
            comment_updates: dict[str, dict[str, Any]] = {}
            for row in notes:
                note_id = str(row["note_id"])
                if note_id not in csv_ids:
                    continue
                old = payload_of(row)
                reference = latest_observation_reference(
                    row.get("last_comment_collected_at"), row.get("last_pull_at")
                ) or text(row.get("first_seen_at"), 80)
                normalized = enrich_time_payload(old, reference, reference_source="historical_collection")
                normalized_notes[note_id] = normalized
                if old != normalized:
                    note_updates[note_id] = normalized
                    changed_ids.add(note_id)
            for row in comments:
                note_id, comment_id = str(row["note_id"]), str(row["comment_id"])
                if note_id not in normalized_notes:
                    continue
                old = payload_of(row)
                source = {**old, "publishedAt": text(row.get("published_at"), 100)}
                normalized = enrich_time_payload(
                    source, row.get("last_seen_at") or row.get("first_seen_at"),
                    kind="comment", reference_source="historical_collection",
                )
                normalized_comments[comment_id] = (note_id, normalized)
                if old != normalized:
                    comment_updates[comment_id] = normalized
                    changed_ids.add(note_id)
            for row in note_rows:
                note_id = valid_note_id(row.get("笔记ID"))
                if note_id not in normalized_notes:
                    continue
                for key, value in csv_time_fields(normalized_notes[note_id]).items():
                    if text(row.get(key), 1000) != value:
                        changed_ids.add(note_id)
                    row[key] = value
            for row in comment_rows:
                comment_id = text(row.get("笔记评论ID"), 256)
                linked = normalized_comments.get(comment_id)
                if not linked or csv_comment_note_id(row) != linked[0]:
                    continue
                for key, value in csv_time_fields(linked[1], kind="comment").items():
                    if text(row.get(key), 1000) != value:
                        changed_ids.add(linked[0])
                    row[key] = value
            if not changed_ids:
                return {"ok": True, "updatedNotes": 0, "updatedComments": 0, "consistencyVerified": True}

            # A time projection must not silently repair or conceal unrelated
            # drift by overwriting a material snapshot with the SQLite copy.
            media_dirs = {str(row["note_id"]): text(row.get("media_dir"), 4000) for row in notes}
            for note_id in sorted(changed_ids):
                self._verify_note_store_consistency(note_id, media_dirs[note_id], verify_fields=True)

            checkpoints: list[dict[str, Any]] = []
            mutation_started = False
            try:
                for index, note_id in enumerate(sorted(changed_ids)):
                    checkpoints.append(self._capture_sync_checkpoint(note_id, capture_csv=index == 0))
                mutation_started = True
                with self._session() as db:
                    for note_id, normalized in note_updates.items():
                        db.execute("UPDATE notes SET payload_json=? WHERE note_id=?",
                                   (json.dumps(normalized, ensure_ascii=False), note_id))
                    for comment_id, normalized in comment_updates.items():
                        db.execute("UPDATE comments SET payload_json=? WHERE comment_id=?",
                                   (json.dumps(normalized, ensure_ascii=False), comment_id))
                self._replace_csv_pair(note_headers, note_rows, comment_headers, comment_rows, "publication-times")
                for note_id in sorted(changed_ids):
                    media_dir = self._refresh_material_snapshot_for_note(note_id)
                    self._verify_note_store_consistency(note_id, media_dir, verify_fields=True)
            except Exception as exc:
                if not mutation_started:
                    for checkpoint in reversed(checkpoints):
                        self._discard_sync_checkpoint(checkpoint)
                    raise
                failures = self._rollback_sync_checkpoints(checkpoints)
                if failures:
                    raise RuntimeError("时间字段迁移回滚未完成：" + "；".join(failures)) from exc
                raise
            for checkpoint in reversed(checkpoints):
                self._discard_sync_checkpoint(checkpoint)
            return {"ok": True, "updatedNotes": len(note_updates), "updatedComments": len(comment_updates),
                    "consistencyVerified": True}

    def data_overview_media(self, dataset: str, record_id: str, index: str | int | None = None,
                            revision: str | None = None) -> dict[str, Any]:
        """Read one record's media without CSV repair, downloads or status writes."""
        with self.pull_lock, self.lock:
            return read_overview_media(self.db_path, self._media_root(), dataset, record_id, index, revision)

    def data_overview_comment_target(self, comment_id: str) -> dict[str, Any]:
        """Resolve exact stored comment text and its parent note for the worker."""
        with self.pull_lock, self.lock:
            return read_comment_target(self.db_path, comment_id)

    def data_overview_schema(self) -> dict[str, Any]:
        """Return every filterable field only after full cross-store verification."""
        # Use the same lock order as write transactions. This makes the health
        # verdict, the field catalogue and the issued token one atomic view.
        with self.pull_lock, self.lock:
            health = self.data_health()
            if health.get("summary", {}).get("relationshipsConsistent") is True and not any(
                item.get("severity") == "critical" for item in health.get("issues", [])
            ):
                try:
                    migration = self.normalize_publication_storage()
                    if migration.get("updatedNotes") or migration.get("updatedComments"):
                        health = self.data_health()
                except Exception as exc:
                    health.setdefault("issues", []).append({
                        "id": "publication_time_migration", "severity": "critical",
                        "title": "时间字段校验未通过", "detail": text(exc, 1200),
                        "count": 1, "repairable": False, "samples": [],
                    })
            relationships_ok = health.get("summary", {}).get("relationshipsConsistent") is True
            critical = [item for item in health.get("issues", []) if item.get("severity") == "critical"]
            query_ready = relationships_ok and not critical
            db = self._connect()
            try:
                db.execute("PRAGMA query_only=ON")
                note_fields = build_field_specs(db, "notes")
                comment_fields = build_field_specs(db, "comments")
                record_total = int(db.execute("SELECT COUNT(*) FROM notes").fetchone()[0])
                note_total = int(db.execute(
                    f"SELECT COUNT(*) FROM notes n WHERE {DATA_OVERVIEW_NOTE_SCOPE}"
                ).fetchone()[0])
                comment_total = int(db.execute(
                    f"SELECT COUNT(*) FROM comments c JOIN notes n ON n.note_id=c.note_id "
                    f"WHERE {DATA_OVERVIEW_NOTE_SCOPE}"
                ).fetchone()[0])
                business_notes = int(db.execute(
                    "SELECT COUNT(*) FROM notes WHERE source='existing_xlsx' OR pull_status IN ('synced','partial')"
                ).fetchone()[0])
                synchronized_notes = int(db.execute(
                    f"SELECT COUNT(*) FROM notes n WHERE {DATA_OVERVIEW_NOTE_SCOPE} AND n.status<>'ignored'"
                ).fetchone()[0])
                ignored_notes = int(db.execute("SELECT COUNT(*) FROM notes WHERE status='ignored'").fetchone()[0])
                active_comments = int(db.execute(
                    f"SELECT COUNT(*) FROM comments c JOIN notes n ON n.note_id=c.note_id "
                    f"WHERE {DATA_OVERVIEW_NOTE_SCOPE} AND c.is_deleted=0"
                ).fetchone()[0])
            finally:
                db.close()
            token = self._data_overview_snapshot_token()
            now = time.time()
            self._data_overview_approved_tokens = {
                key: issued for key, issued in self._data_overview_approved_tokens.items() if now - issued < 1800
            }
            self._data_overview_read_renewals = {
                key: issued for key, issued in self._data_overview_read_renewals.items()
                if key in self._data_overview_approved_tokens
            }
            if query_ready:
                self._data_overview_approved_tokens[token] = now
                self._data_overview_read_renewals[token] = now
            return {
                "ok": True, "version": VERSION, "queryReady": query_ready,
                "snapshotToken": token if query_ready else "", "health": health,
                "operators": DATA_OVERVIEW_OPERATORS,
                "datasets": {
                    "notes": {
                        "label": "帖子数据库", "total": note_total, "businessTotal": business_notes,
                        "synchronizedTotal": synchronized_notes, "ignoredTotal": ignored_notes,
                        "recordTotal": record_total, "excludedDiscoveryTotal": max(0, record_total - note_total),
                        "fields": [field.public() for field in note_fields],
                    },
                    "comments": {
                        "label": "评论数据库", "total": comment_total, "activeTotal": active_comments,
                        "fields": [field.public() for field in comment_fields],
                    },
                },
            }

    def query_data_overview(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Run one parameterized, read-only query against an approved consistent snapshot."""
        dataset = text(payload.get("dataset"), 30).lower() or "notes"
        if dataset not in {"notes", "comments"}:
            raise ValueError("dataset must be notes or comments")
        supplied_token = text(payload.get("snapshotToken"), 128)
        if not supplied_token:
            raise ValueError("缺少一致性快照，请重新校验数据总览")
        # Hold both write locks from token validation through SELECT completion;
        # no sync or background AI write can move the underlying snapshot.
        with self.pull_lock, self.lock:
            current_token = self._validate_data_overview_read_snapshot(supplied_token, "查询")

            db = self._connect()
            try:
                db.execute("PRAGMA query_only=ON")
                db.execute("BEGIN")
                field_specs = build_field_specs(db, dataset)
                by_key = {field.key: field for field in field_specs}
                requested_fields = list(dict.fromkeys(
                    text(item, 160) for item in (payload.get("fields") or []) if text(item, 160) in by_key
                ))
                if not requested_fields:
                    requested_fields = [field.key for field in field_specs if field.default_visible]
                if not requested_fields:
                    requested_fields = [field_specs[0].key]
                if len(requested_fields) > 180:
                    raise ValueError("单次最多显示 180 个字段")

                filter_sql, filter_params, condition_count = compile_filter_group(
                    payload.get("filter") if isinstance(payload.get("filter"), dict) else None, by_key
                )
                semantic = payload.get("semanticSearch") is True
                query_text = str(payload.get("search") or "").strip()
                search_sql, search_params = ("", []) if semantic else search_clause(text(query_text, 500), dataset)
                clauses = [DATA_OVERVIEW_NOTE_SCOPE, *[item for item in (filter_sql, search_sql) if item]]
                where = " WHERE " + " AND ".join(clauses) if clauses else ""
                parameters = [*filter_params, *search_params]
                base = "notes n" if dataset == "notes" else "comments c JOIN notes n ON n.note_id=c.note_id"
                select_sql = ", ".join(
                    f"{by_key[key].expression} AS {json.dumps(key)}" for key in requested_fields
                )
                page_size = max(1, min(int(payload.get("pageSize") or 50), 200))
                group_threads = not semantic and effective_thread_grouping(
                    payload.get("sort") if isinstance(payload.get("sort"), list) else [],
                    by_key, dataset, payload.get("groupThreads"), payload.get("threadSortMode", "comment"))
                if semantic:
                    if not hasattr(self, "_semantic_encoder"):
                        self._semantic_encoder = LocalEncoder(self.db_path.with_name(self.db_path.name + ".semantic.sqlite3"))
                    ids, evidence = semantic_retrieve(
                        db, self._semantic_encoder, dataset, base, where, parameters, query_text,
                        minimum=payload.get("semanticMinScore", 0.5), limit=payload.get("semanticLimit", 200),
                    )
                    total = len(ids)
                    page_count = max(1, (total + page_size - 1) // page_size)
                    page = max(1, min(int(payload.get("page") or 1), page_count))
                    page_ids = ids[(page - 1) * page_size:page * page_size]
                    rows = []
                    if page_ids:
                        key_expr = "n.note_id" if dataset == "notes" else "c.comment_id"
                        marks = ",".join("?" for _ in page_ids)
                        selected = {row["__semantic_id"]: dict(row) for row in db.execute(
                            f"SELECT {select_sql}, {key_expr} AS __semantic_id FROM {base} "
                            f"WHERE {key_expr} IN ({marks})", page_ids,
                        )}
                        for record_id in page_ids:
                            record = selected[record_id]
                            record.pop("__semantic_id", None)
                            record.update(evidence[record_id])
                            rows.append(record)
                else:
                    total = int(db.execute(f"SELECT COUNT(*) FROM {base}{where}", parameters).fetchone()[0])
                    page_count = max(1, (total + page_size - 1) // page_size)
                    page = max(1, min(int(payload.get("page") or 1), page_count))
                    order_by = compile_sort(
                        payload.get("sort") if isinstance(payload.get("sort"), list) else [],
                        by_key, dataset, group_threads=group_threads, thread_sort_mode=payload.get("threadSortMode", "comment"),
                    )
                    rows = [dict(row) for row in db.execute(
                        f"SELECT {select_sql} FROM {base}{where} ORDER BY {order_by} LIMIT ? OFFSET ?",
                        (*parameters, page_size, (page - 1) * page_size),
                    ).fetchall()]
                db.rollback()
            finally:
                db.close()
            query_hash = hashlib.sha256(json.dumps({
                "dataset": dataset, "fields": requested_fields, "search": payload.get("search") or "",
                "filter": payload.get("filter") or {}, "sort": payload.get("sort") or [],
                "groupThreads": group_threads, "threadSortMode": payload.get("threadSortMode", "comment"),
                "semanticSearch": semantic, "semanticMinScore": payload.get("semanticMinScore", 0.5),
                "semanticLimit": payload.get("semanticLimit", 200),
                "page": page, "pageSize": page_size,
            }, ensure_ascii=False, sort_keys=True, default=str).encode("utf-8")).hexdigest()
            return {
                "ok": True, "dataset": dataset, "rows": rows, "fields": requested_fields,
                "total": total, "page": page, "pageSize": page_size, "pageCount": page_count,
                "filterConditionCount": condition_count, "snapshotToken": current_token,
                "queryHash": query_hash, "consistentSnapshot": True,
                "semantic": {"mode": "embedding", "model": SEMANTIC_MODEL,
                             "limit": max(1, min(int(payload.get("semanticLimit", 200)), 2000)),
                             "minimumScore": float(payload.get("semanticMinScore", 0.5)),
                             "note": "向量相关度不是情绪分类或事实置信度；返回阈值以上最相关记录"} if semantic else None,
            }

    def export_data_overview(self, payload: dict[str, Any]) -> dict[str, Any]:
        return export_filtered_workbook(self, payload)

    def data_overview_values(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Return distinct canonical values for one whitelisted field and approved snapshot."""
        dataset = text(payload.get("dataset"), 30).lower() or "notes"
        if dataset not in {"notes", "comments"}:
            raise ValueError("dataset must be notes or comments")
        supplied_token = text(payload.get("snapshotToken"), 128)
        if not supplied_token:
            raise ValueError("缺少一致性快照，请重新校验数据总览")
        field_key = text(payload.get("field"), 160)
        search = text(payload.get("search"), 500)
        limit = max(1, min(int(payload.get("limit") or 120), 200))
        with self.pull_lock, self.lock:
            current_token = self._validate_data_overview_read_snapshot(supplied_token, "读取筛选选项")
            db = self._connect()
            try:
                db.execute("PRAGMA query_only=ON")
                db.execute("BEGIN")
                specs = {field.key: field for field in build_field_specs(db, dataset)}
                spec = specs.get(field_key)
                if not spec:
                    raise ValueError(f"未知筛选字段：{field_key}")
                if not spec.filterable:
                    raise ValueError(f"该字段仅用于操作，不能读取筛选选项：{field_key}")
                base = "notes n" if dataset == "notes" else "comments c JOIN notes n ON n.note_id=c.note_id"
                value_text = f"TRIM(COALESCE(CAST({spec.expression} AS TEXT),''))"
                clauses = [DATA_OVERVIEW_NOTE_SCOPE, f"{value_text}<>''"]
                parameters: list[Any] = []
                if search:
                    clauses.append(f"{value_text} LIKE ? ESCAPE '\\' COLLATE NOCASE")
                    escaped_search = search.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
                    parameters.append(f"%{escaped_search}%")
                where = " WHERE " + " AND ".join(clauses)
                distinct_count = int(db.execute(
                    f"SELECT COUNT(DISTINCT {value_text}) FROM {base}{where}", parameters
                ).fetchone()[0])
                rows = db.execute(
                    f"SELECT {spec.expression} value,COUNT(*) count FROM {base}{where} "
                    f"GROUP BY {spec.expression} ORDER BY count DESC,{value_text} ASC LIMIT ?",
                    (*parameters, limit),
                ).fetchall()
                db.rollback()
            finally:
                db.close()
            values = []
            for row in rows:
                value = row["value"]
                label = ("是" if bool(value) else "否") if spec.data_type == "boolean" else str(value)
                values.append({"value": value, "label": label, "count": int(row["count"] or 0)})
            return {
                "ok": True, "dataset": dataset, "field": field_key, "values": values,
                "distinctCount": distinct_count, "truncated": distinct_count > len(values),
                "snapshotToken": current_token, "consistentSnapshot": True,
            }

    def _delete_data_overview_comments(self, requested_ids: list[str]) -> dict[str, Any]:
        """Permanently remove comments and descendants from every canonical local store."""
        _notes_path, comments_path = self._csv_paths()
        comment_headers, comment_rows = self._read_csv_table(comments_path, COMMENT_CSV_HEADERS)
        original_csv = comments_path.read_bytes() if comments_path.is_file() else None
        material_backups: dict[Path, bytes] = {}
        db = self._connect()
        try:
            db.execute("BEGIN IMMEDIATE")
            requested = set(requested_ids)
            placeholders = ",".join("?" for _ in requested)
            initial_rows = db.execute(
                f"SELECT comment_id,note_id,parent_comment_id FROM comments "
                f"WHERE comment_id IN ({placeholders})", tuple(requested)
            ).fetchall()
            found = {str(row["comment_id"]) for row in initial_rows}
            missing = sorted(requested - found)
            if missing:
                raise ValueError("部分评论已不存在，请刷新后重试：" + "、".join(missing[:5]))

            delete_ids = set(found)
            frontier = set(found)
            while frontier:
                child_placeholders = ",".join("?" for _ in frontier)
                children = {
                    str(row[0]) for row in db.execute(
                        f"SELECT comment_id FROM comments WHERE parent_comment_id IN ({child_placeholders})",
                        tuple(frontier),
                    ).fetchall()
                } - delete_ids
                if not children:
                    break
                delete_ids.update(children)
                frontier = children

            delete_placeholders = ",".join("?" for _ in delete_ids)
            selected_rows = [dict(row) for row in db.execute(
                f"SELECT comment_id,note_id,parent_comment_id FROM comments "
                f"WHERE comment_id IN ({delete_placeholders})", tuple(delete_ids)
            ).fetchall()]
            note_ids = sorted({str(row["note_id"]) for row in selected_rows})
            delete_by_note = {
                note_id: {str(row["comment_id"]) for row in selected_rows if str(row["note_id"]) == note_id}
                for note_id in note_ids
            }

            kept_comments = [
                row for row in comment_rows if text(row.get("笔记评论ID"), 256) not in delete_ids
            ]
            removed_csv_ids = {
                text(row.get("笔记评论ID"), 256) for row in comment_rows
                if text(row.get("笔记评论ID"), 256) in delete_ids
            }
            if removed_csv_ids != delete_ids:
                raise ValueError(
                    f"评论 CSV 删除前校验失败：SQLite={len(delete_ids)}，CSV={len(removed_csv_ids)}"
                )

            media_root = self._media_root().resolve()
            material_payloads: dict[str, tuple[Path, list[dict[str, Any]]]] = {}
            if note_ids:
                note_placeholders = ",".join("?" for _ in note_ids)
                note_rows = db.execute(
                    f"SELECT note_id,media_dir FROM notes WHERE note_id IN ({note_placeholders})",
                    tuple(note_ids),
                ).fetchall()
                if len(note_rows) != len(note_ids):
                    raise ValueError("评论关联帖子不完整，已停止删除")
                for note_row in note_rows:
                    note_id = str(note_row["note_id"])
                    media_value = text(note_row["media_dir"], 4000)
                    if not media_value:
                        continue
                    folder = Path(media_value).expanduser()
                    if not folder.is_dir():
                        raise ValueError(f"素材目录不存在，已停止删除：{note_id}")
                    folder = folder.resolve()
                    if folder.parent != media_root:
                        raise ValueError("素材目录不在受管 posts_materials 目录内，已停止删除")
                    material_path = folder / "comments.json"
                    if not material_path.is_file():
                        raise ValueError(f"素材 comments.json 缺失，已停止删除：{note_id}")
                    loaded = json.loads(material_path.read_text(encoding="utf-8-sig"))
                    if not isinstance(loaded, list):
                        raise ValueError(f"素材 comments.json 格式错误：{note_id}")
                    material_ids = {
                        text(item.get("commentId"), 256) for item in loaded
                        if isinstance(item, dict) and text(item.get("commentId"), 256)
                    }
                    if not delete_by_note[note_id].issubset(material_ids):
                        raise ValueError(f"素材评论与 SQLite 不一致，已停止删除：{note_id}")
                    filtered = [
                        dict(item) for item in loaded
                        if isinstance(item, dict) and text(item.get("commentId"), 256) not in delete_ids
                    ]
                    child_counts: dict[str, int] = {}
                    for item in filtered:
                        parent_id = text(item.get("parentCommentId"), 256)
                        if parent_id:
                            child_counts[parent_id] = child_counts.get(parent_id, 0) + 1
                    for item in filtered:
                        comment_id = text(item.get("commentId"), 256)
                        if comment_id and not text(item.get("parentCommentId"), 256):
                            item["replyCount"] = child_counts.get(comment_id, 0)
                    material_backups[material_path] = material_path.read_bytes()
                    material_payloads[note_id] = (material_path, filtered)

            self._replace_csv_table(comments_path, comment_headers, kept_comments, "overview-comment-delete")
            for material_path, filtered in material_payloads.values():
                self._write_json_atomic(material_path, filtered)

            linked_records = 0
            linked_records += db.execute(
                f"DELETE FROM ai_jobs WHERE target_type='comment' AND target_id IN ({delete_placeholders})",
                tuple(delete_ids),
            ).rowcount
            linked_records += db.execute(
                f"DELETE FROM ai_analysis_records WHERE target_type='comment' AND target_id IN ({delete_placeholders})",
                tuple(delete_ids),
            ).rowcount
            linked_records += db.execute(
                f"DELETE FROM reply_generation_history WHERE comment_id IN ({delete_placeholders})",
                tuple(delete_ids),
            ).rowcount
            linked_records += db.execute(
                f"DELETE FROM change_events WHERE target_id IN ({delete_placeholders})",
                tuple(delete_ids),
            ).rowcount
            deleted_database_comments = db.execute(
                f"DELETE FROM comments WHERE comment_id IN ({delete_placeholders})", tuple(delete_ids)
            ).rowcount
            if deleted_database_comments != len(delete_ids):
                raise ValueError("SQLite 评论删除数量校验失败")

            for note_id in note_ids:
                db.execute(
                    """UPDATE comments SET reply_count=(
                           SELECT COUNT(*) FROM comments child
                           WHERE child.note_id=comments.note_id
                             AND child.parent_comment_id=comments.comment_id
                             AND child.is_deleted=0
                       ) WHERE note_id=?""",
                    (note_id,),
                )
                counts = db.execute(
                    """SELECT COUNT(*) active_count,
                              SUM(CASE WHEN is_deleted=0 AND analysis_is_negative='是' THEN 1 ELSE 0 END) negative_count
                       FROM comments WHERE note_id=? AND is_deleted=0""",
                    (note_id,),
                ).fetchone()
                db.execute(
                    "UPDATE notes SET comment_count_collected=?,negative_comment_count=? WHERE note_id=?",
                    (int(counts["active_count"] or 0), int(counts["negative_count"] or 0), note_id),
                )
                linked_records += db.execute("DELETE FROM note_summaries WHERE note_id=?", (note_id,)).rowcount

            if db.execute(
                f"SELECT COUNT(*) FROM comments WHERE comment_id IN ({delete_placeholders})", tuple(delete_ids)
            ).fetchone()[0]:
                raise ValueError("SQLite 评论删除后仍存在残留")
            if any(text(row.get("笔记评论ID"), 256) in delete_ids for row in kept_comments):
                raise ValueError("评论 CSV 删除后仍存在残留")

            for note_id in note_ids:
                database_status = {
                    str(row["comment_id"]): comment_status_label(row["comment_status"], row["is_deleted"])
                    for row in db.execute(
                        "SELECT comment_id,comment_status,is_deleted FROM comments WHERE note_id=?", (note_id,)
                    ).fetchall()
                }
                csv_status = {
                    text(row.get("笔记评论ID"), 256): comment_status_label(row.get("评论状态"))
                    for row in kept_comments if csv_comment_note_id(row) == note_id
                }
                if database_status != csv_status:
                    raise ValueError(f"删除后评论 CSV 与 SQLite 不一致：{note_id}")
                if note_id in material_payloads:
                    material_status = {
                        text(item.get("commentId"), 256): comment_status_label(
                            item.get("commentStatus"), item.get("isDeleted")
                        ) for item in material_payloads[note_id][1]
                        if text(item.get("commentId"), 256)
                    }
                    if database_status != material_status:
                        raise ValueError(f"删除后素材评论与 SQLite 不一致：{note_id}")

            db.commit()
            return {
                "ok": True, "dataset": "comments", "requestedCount": len(requested_ids),
                "deletedCount": len(delete_ids), "deletedCommentIds": sorted(delete_ids),
                "cascadeDeletedCount": max(0, len(delete_ids) - len(requested_ids)),
                "affectedNoteIds": note_ids, "deletedCsvRows": len(removed_csv_ids),
                "deletedDatabaseComments": deleted_database_comments,
                "deletedLinkedDatabaseRecords": linked_records,
                "materialSnapshotsUpdated": len(material_payloads),
                "csvVerified": True, "databaseVerified": True, "materialsVerified": True,
            }
        except Exception:
            db.rollback()
            self._restore_file_bytes(comments_path, original_csv)
            if comments_path.is_file():
                self._remember_managed_csv(comments_path)
            for material_path, original in material_backups.items():
                self._restore_file_bytes(material_path, original)
            raise
        finally:
            db.close()

    def delete_data_overview_records(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Delete selected overview records only after snapshot and explicit confirmation checks."""
        dataset = text(payload.get("dataset"), 30).lower()
        if dataset not in {"notes", "comments"}:
            raise ValueError("dataset must be notes or comments")
        raw_ids = payload.get("ids") if isinstance(payload.get("ids"), list) else []
        ids = list(dict.fromkeys(text(item, 256) for item in raw_ids if text(item, 256)))
        if not ids:
            raise ValueError("请至少选择一条要删除的数据")
        if len(ids) > 100:
            raise ValueError("单次最多永久删除 100 条记录")
        if dataset == "notes" and any(not valid_note_id(item) for item in ids):
            raise ValueError("选择中包含无效的笔记 ID")
        confirmation = f"DELETE:{dataset}:{len(ids)}"
        if not bool(payload.get("hardDeleteConfirmed")) or text(payload.get("confirmation"), 128) != confirmation:
            raise ValueError("永久删除确认不完整")
        supplied_token = text(payload.get("snapshotToken"), 128)
        if not supplied_token:
            raise ValueError("缺少一致性快照，请刷新后重试")

        with self.pull_lock, self.lock:
            issued_at = self._data_overview_approved_tokens.get(supplied_token, 0)
            if not issued_at or time.time() - issued_at >= 1800:
                raise ValueError("一致性快照已过期，请重新校验后再删除")
            current_token = self._data_overview_snapshot_token()
            if current_token != supplied_token:
                self._data_overview_approved_tokens.pop(supplied_token, None)
                raise ValueError("本地数据已变化，请重新校验后再删除")

            if dataset == "comments":
                return self._delete_data_overview_comments(ids)

            deleted: list[dict[str, Any]] = []
            failures: list[dict[str, str]] = []
            for note_id in ids:
                try:
                    deleted.append(self.delete_pulled_note({"noteId": note_id}))
                except Exception as exc:
                    failures.append({"noteId": note_id, "error": text(exc, 1000)})
            if not deleted:
                detail = "；".join(f"{item['noteId']}：{item['error']}" for item in failures[:3])
                raise ValueError("帖子删除失败：" + detail)
            return {
                "ok": True, "dataset": "notes", "requestedCount": len(ids),
                "deletedCount": len(deleted), "deletedNoteIds": [item["noteId"] for item in deleted],
                "deletedCommentCount": sum(int(item.get("deletedDatabaseComments") or 0) for item in deleted),
                "deletedCsvNoteRows": sum(int(item.get("deletedNoteRows") or 0) for item in deleted),
                "deletedCsvCommentRows": sum(int(item.get("deletedCommentRows") or 0) for item in deleted),
                "deletedMaterialDirectoryCount": sum(bool(item.get("mediaDeleted")) for item in deleted),
                "failureCount": len(failures), "failures": failures,
                "partial": bool(failures), "csvVerified": True, "databaseVerified": True,
            }

    def purge_untracked_discoveries(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Remove discovery-only rows without touching synchronized, confirmed or ignored records."""
        supplied_token = text(payload.get("snapshotToken"), 128)
        if not supplied_token:
            raise ValueError("缺少一致性快照，请刷新后重试")
        dry_run = bool(payload.get("dryRun"))
        with self.pull_lock, self.lock:
            issued_at = self._data_overview_approved_tokens.get(supplied_token, 0)
            if not issued_at or time.time() - issued_at >= 1800:
                raise ValueError("一致性快照已过期，请重新校验后再清理")
            current_token = self._data_overview_snapshot_token()
            if current_token != supplied_token:
                self._data_overview_approved_tokens.pop(supplied_token, None)
                raise ValueError("本地数据已变化，请重新校验后再清理")

            db = self._connect()
            tombstones: list[tuple[Path, Path]] = []
            committed = False
            try:
                candidates = [dict(row) for row in db.execute(
                    f"SELECT n.note_id,n.status,n.source,n.pull_status,n.media_dir FROM notes n "
                    f"WHERE NOT {DATA_OVERVIEW_NOTE_SCOPE} ORDER BY n.note_id"
                ).fetchall()]
                candidate_ids = [str(row["note_id"]) for row in candidates]
                by_status = dict(Counter(str(row["status"] or "") for row in candidates))
                if dry_run:
                    return {
                        "ok": True, "dryRun": True, "candidateCount": len(candidate_ids),
                        "candidateIds": candidate_ids, "byStatus": by_status,
                        "confirmation": f"PURGE_UNTRACKED_DISCOVERIES:{len(candidate_ids)}",
                    }
                confirmation = f"PURGE_UNTRACKED_DISCOVERIES:{len(candidate_ids)}"
                if not bool(payload.get("hardDeleteConfirmed")) or text(
                    payload.get("confirmation"), 128
                ) != confirmation:
                    raise ValueError("仅发现未入库记录的永久清理确认不完整")
                if not candidate_ids:
                    return {
                        "ok": True, "dryRun": False, "deletedCount": 0,
                        "deletedCommentCount": 0, "deletedLinkedDatabaseRecords": 0,
                        "deletedMaterialDirectoryCount": 0, "byStatus": {},
                    }

                notes_path, comments_path = self._csv_paths()
                _note_headers, note_rows = self._read_csv_table(notes_path, NOTE_CSV_HEADERS)
                _comment_headers, comment_rows = self._read_csv_table(comments_path, COMMENT_CSV_HEADERS)
                candidate_set = set(candidate_ids)
                csv_note_overlap = sorted(
                    valid_note_id(row.get("笔记ID")) for row in note_rows
                    if valid_note_id(row.get("笔记ID")) in candidate_set
                )
                csv_comment_overlap = sorted(
                    text(row.get("笔记评论ID"), 256) for row in comment_rows
                    if csv_comment_note_id(row) in candidate_set
                )
                if csv_note_overlap or csv_comment_overlap:
                    raise ValueError("候选记录已进入业务 CSV，已停止清理以保护正式数据")

                placeholders = ",".join("?" for _ in candidate_ids)
                comment_rows_db = db.execute(
                    f"SELECT comment_id FROM comments WHERE note_id IN ({placeholders})", tuple(candidate_ids)
                ).fetchall()
                comment_ids = [str(row[0]) for row in comment_rows_db]

                media_root = self._media_root().resolve()
                managed_dirs: list[Path] = []
                for row in candidates:
                    media_value = text(row.get("media_dir"), 4000)
                    if not media_value:
                        continue
                    folder = Path(media_value).expanduser()
                    if not folder.exists():
                        continue
                    folder = folder.resolve()
                    if folder.parent != media_root:
                        raise ValueError("仅发现记录的素材目录不在受管目录内，已停止清理")
                    if folder not in managed_dirs:
                        managed_dirs.append(folder)
                if media_root.exists():
                    candidate_suffixes = {f"__{note_id}" for note_id in candidate_ids}
                    for folder in media_root.iterdir():
                        if not folder.is_dir() or not any(folder.name.endswith(suffix) for suffix in candidate_suffixes):
                            continue
                        resolved = folder.resolve()
                        if resolved not in managed_dirs:
                            managed_dirs.append(resolved)
                for index, folder in enumerate(managed_dirs, 1):
                    tombstone = folder.with_name(
                        f".{folder.name}.purging-{os.getpid()}-{time.time_ns()}-{index}"
                    )
                    folder.rename(tombstone)
                    tombstones.append((folder, tombstone))

                db.execute("BEGIN IMMEDIATE")
                linked_records = 0
                if comment_ids:
                    comment_placeholders = ",".join("?" for _ in comment_ids)
                    linked_records += db.execute(
                        f"DELETE FROM ai_jobs WHERE target_type='comment' AND target_id IN ({comment_placeholders})",
                        tuple(comment_ids),
                    ).rowcount
                    linked_records += db.execute(
                        f"DELETE FROM ai_analysis_records WHERE target_type='comment' AND target_id IN ({comment_placeholders})",
                        tuple(comment_ids),
                    ).rowcount
                linked_records += db.execute(
                    f"DELETE FROM ai_jobs WHERE target_id IN ({placeholders})", tuple(candidate_ids)
                ).rowcount
                linked_records += db.execute(
                    f"DELETE FROM ai_analysis_records WHERE target_id IN ({placeholders})", tuple(candidate_ids)
                ).rowcount
                for table in ("note_summaries", "reply_generation_history", "comment_collection_jobs", "change_events", "watchlist"):
                    linked_records += db.execute(
                        f"DELETE FROM {table} WHERE note_id IN ({placeholders})", tuple(candidate_ids)
                    ).rowcount
                deleted_comments = db.execute(
                    f"DELETE FROM comments WHERE note_id IN ({placeholders})", tuple(candidate_ids)
                ).rowcount
                deleted_notes = db.execute(
                    f"DELETE FROM notes WHERE note_id IN ({placeholders})", tuple(candidate_ids)
                ).rowcount
                if deleted_notes != len(candidate_ids):
                    raise ValueError("仅发现记录的 SQLite 删除数量校验失败")
                if db.execute(
                    f"SELECT COUNT(*) FROM notes WHERE note_id IN ({placeholders})", tuple(candidate_ids)
                ).fetchone()[0]:
                    raise ValueError("仅发现记录清理后仍存在 SQLite 残留")
                db.commit()
                committed = True

                cleanup_errors: list[str] = []
                for _original, tombstone in tombstones:
                    try:
                        if tombstone.exists():
                            shutil.rmtree(tombstone)
                    except OSError as exc:
                        cleanup_errors.append(f"{tombstone.name}: {text(exc, 220)}")
                return {
                    "ok": True, "dryRun": False, "deletedCount": deleted_notes,
                    "deletedCommentCount": deleted_comments,
                    "deletedLinkedDatabaseRecords": linked_records,
                    "deletedMaterialDirectoryCount": len(tombstones) - len(cleanup_errors),
                    "byStatus": by_status, "databaseVerified": True, "csvProtected": True,
                    "materialCleanupWarning": "；".join(cleanup_errors),
                }
            except Exception:
                if not committed:
                    db.rollback()
                    for original, tombstone in reversed(tombstones):
                        if tombstone.exists() and not original.exists():
                            tombstone.rename(original)
                raise
            finally:
                db.close()

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
        with self.pull_lock, self.lock, self._session() as db:
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
                """SELECT note_id,title,url,author,content,keyword,tags,source,pull_status,media_status,media_dir,media_file_count,
                   comment_count_collected,post_sentiment,access_status,access_error,payload_json,semantic_analysis_count,
                   analysis_is_negative,negative_type,negative_subtype,
                   post_status,is_deleted,deleted_at,last_presence_checked_at FROM notes"""
            ).fetchall()]
            db_note_ids = {row["note_id"] for row in note_rows}
            db_note_status = {
                row["note_id"]: post_status_label(row.get("post_status"), row.get("is_deleted"))
                for row in note_rows
            }
            db_deleted_note_count = sum(bool(row.get("is_deleted")) for row in note_rows)
            db_note_flag_mismatches = [
                row["note_id"] for row in note_rows
                if bool(row.get("is_deleted")) != (post_status_label(row.get("post_status"), row.get("is_deleted")) == POST_STATUS_DELETED)
            ]
            pulled_ids = {
                row["note_id"] for row in note_rows
                if row["source"] == "existing_xlsx" or row["pull_status"] in {"synced", "partial"}
            }
            db_comment_rows = [dict(row) for row in db.execute(
                """SELECT comment_id,note_id,parent_comment_id,content,author,author_url,published_at,like_count,
                          comment_level,payload_json,sentiment,review_status,comment_status,is_deleted,
                          semantic_analysis_count,analysis_is_negative,negative_type,negative_subtype
                   FROM comments"""
            ).fetchall()]
            db_comment_count = len(db_comment_rows)
            db_comment_ids = {text(row.get("comment_id"), 256) for row in db_comment_rows}
            db_comment_status = {
                text(row.get("comment_id"), 256): comment_status_label(row.get("comment_status"), row.get("is_deleted"))
                for row in db_comment_rows if text(row.get("comment_id"), 256)
            }
            db_comment_semantic = {
                text(row.get("comment_id"), 256): (
                    int(row.get("semantic_analysis_count") or 0), text(row.get("analysis_is_negative"), 40),
                    text(row.get("negative_type"), 1000), text(row.get("negative_subtype"), 2000)
                ) for row in db_comment_rows if text(row.get("comment_id"), 256)
            }
            db_deleted_comment_count = sum(bool(row.get("is_deleted")) for row in db_comment_rows)
            alias_groups: dict[tuple[str, str], list[dict[str, Any]]] = {}
            logical_groups: dict[tuple[str, str, str], list[dict[str, Any]]] = {}
            for row in db_comment_rows:
                comment_id = text(row.get("comment_id"), 256)
                note_id = text(row.get("note_id"), 128)
                if not comment_id or not note_id:
                    continue
                alias_key = comment_id.removeprefix("comment-")
                if not comment_id.startswith("legacy-"):
                    alias_groups.setdefault((note_id, alias_key), []).append(row)
                normalized_author = re.sub(r"\s+", "", text(row.get("author"), 500)).casefold()
                normalized_content = re.sub(r"\s+", "", text(row.get("content"), 8000)).casefold()
                if normalized_content:
                    logical_groups.setdefault((note_id, normalized_author, normalized_content), []).append(row)
            comment_alias_candidates = [
                rows for rows in alias_groups.values()
                if len(rows) > 1 and len({text(row.get("comment_id"), 256) for row in rows}) > 1
            ]
            logical_duplicate_candidates = []
            for rows in logical_groups.values():
                ids = {text(row.get("comment_id"), 256) for row in rows}
                if len(ids) <= 1:
                    continue
                normalized_ids = {comment_id.removeprefix("comment-") for comment_id in ids}
                if len(normalized_ids) > 1:
                    logical_duplicate_candidates.append(rows)
            actual_comment_counts = {
                str(row["note_id"]): int(row["count"])
                for row in db.execute(
                    "SELECT note_id,COUNT(*) count FROM comments WHERE is_deleted=0 GROUP BY note_id"
                ).fetchall()
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
        material_post_status_mismatches: list[str] = []
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
                continue
            note_snapshot = Path(folder) / "note.json"
            if note_snapshot.is_file():
                try:
                    snapshot = json.loads(note_snapshot.read_text(encoding="utf-8-sig"))
                    snapshot_status = post_status_label(
                        snapshot.get("postStatus") if isinstance(snapshot, dict) else "",
                        snapshot.get("isDeleted") if isinstance(snapshot, dict) else None,
                    )
                    if snapshot_status != db_note_status.get(row["note_id"]):
                        material_post_status_mismatches.append(row["note_id"])
                except (OSError, ValueError):
                    material_post_status_mismatches.append(row["note_id"])
        review_access = [row["note_id"] for row in note_rows if row.get("access_status") == "check_failed"]
        payload_cross_ids: list[str] = []
        payload_invalid_ids: list[str] = []
        for row in note_rows:
            try:
                payload = json.loads(row.get("payload_json") or "{}")
                if not isinstance(payload, dict):
                    payload = {}
            except (TypeError, ValueError):
                payload = {}
            raw_payload_id = text(payload.get("noteId"), 128)
            payload_url_id = note_url_identity(payload.get("url"))
            valid_payload_id = valid_note_id(raw_payload_id)
            if valid_payload_id and valid_payload_id != row["note_id"]:
                payload_cross_ids.append(row["note_id"])
            elif raw_payload_id != row["note_id"]:
                payload_invalid_ids.append(row["note_id"])
            elif payload_url_id and payload_url_id != row["note_id"]:
                payload_cross_ids.append(row["note_id"])
        media_dir_owners: dict[str, list[str]] = {}
        for row in note_rows:
            folder = text(row.get("media_dir"), 4000)
            if not folder:
                continue
            try:
                key = str(Path(folder).resolve()).casefold()
            except OSError:
                key = folder.casefold()
            media_dir_owners.setdefault(key, []).append(row["note_id"])
        shared_media_ids = [note_id for owners in media_dir_owners.values() if len(owners) > 1 for note_id in owners]

        add_issue("orphan_comments", "critical", "存在孤立评论", "评论在 SQLite 中找不到所属帖子。", orphan_comments, False)
        add_issue(
            "comment_id_alias_candidates", "info", "评论 ID 存在显式别名迁移候选",
            "同帖同时存在裸 ID 与 comment- 前缀 ID；不得自动按文本合并，需先导出证据并执行可审计迁移。",
            len(comment_alias_candidates), False,
            [" / ".join(text(row.get("comment_id"), 256) for row in rows[:3]) for rows in comment_alias_candidates],
        )
        add_issue(
            "comment_logical_duplicate_candidates", "info", "评论存在跨 ID 逻辑重复候选",
            "同帖、同作者、同正文出现不同稳定 ID；仅供人工核验，不影响外键一致性，也不会自动合并。",
            len(logical_duplicate_candidates), False,
            [" / ".join(text(row.get("comment_id"), 256) for row in rows[:3]) for rows in logical_duplicate_candidates],
        )
        add_issue("comment_count_mismatch", "warning", "评论计数不一致", "帖子计数与实际 SQLite 评论数量不同。",
                  len(mismatched_counts), True, mismatched_counts)
        add_issue("missing_core", "warning", "帖子核心字段缺失", "已拉取帖子缺少标题或可用链接。",
                  len(missing_core), False, missing_core)
        add_issue("missing_media", "warning", "素材目录缺失", "数据库记录了素材，但对应目录已经不存在。",
                  len(missing_media), True, missing_media)
        add_issue("media_pending_repair", "info", "素材等待补采", "数据体检已标记素材缺失；下次打开帖子时可补采。",
                  len(pending_media), False, pending_media)
        add_issue("shared_media_directory", "critical", "多个帖子共用同一素材目录",
                  "comments.json 会互相覆盖，必须拆分为带笔记ID的独立目录。",
                  len(shared_media_ids), False, shared_media_ids)
        add_issue("material_post_status_mismatch", "critical", "素材快照与 SQLite 帖子状态不一致",
                  "note.json 的存在/已删除状态必须与 SQLite 一致。",
                  len(material_post_status_mismatches), False, material_post_status_mismatches)
        add_issue("access_review", "info", "帖子等待访问复核", "这些帖子上次未完成访问核验，不等于打不开。",
                  len(review_access), False, review_access)
        add_issue("sqlite_payload_cross_note_id", "critical", "SQLite 帖子快照发生串帖",
                  "payload_json 中的笔记 ID/URL 与数据库主键不同，会导致页面卡片误判为已拉取。",
                  len(payload_cross_ids), True, payload_cross_ids)
        add_issue("sqlite_payload_invalid_note_id", "warning", "SQLite 帖子快照缺少有效 ID",
                  "历史快照含空值或 undefined；安全修复会按数据库主键补齐。",
                  len(payload_invalid_ids), True, payload_invalid_ids)
        add_issue("orphan_watchlist", "warning", "观察名单存在失效引用", "观察名单关联的帖子已经不在数据库中。",
                  orphan_watch, True)

        try:
            notes_path, comments_path = self._csv_paths()
        except ValueError:
            notes_path = comments_path = None
        excel_note_ids: list[str] = []
        excel_comment_rows = 0
        csv_note_rows: list[dict[str, str]] = []
        csv_comment_rows: list[dict[str, str]] = []
        invalid_note_rows: list[str] = []
        note_url_mismatches: list[str] = []
        media_path_mismatches: list[str] = []
        csv_comment_ids: list[str] = []
        missing_comment_note_ids: list[str] = []
        abnormal_comment_rows: list[str] = []
        comment_url_mismatches: list[str] = []
        mapping_review_ids: list[str] = []
        unreviewed_orphan_ids: list[str] = []
        missing_parent_ids: list[str] = []
        invalid_comment_status_ids: list[str] = []
        csv_comment_status_by_id: dict[str, str] = {}
        csv_comment_semantic_by_id: dict[str, tuple[int, str, str, str]] = {}
        note_semantic_mismatches: list[str] = []
        note_field_mismatches: list[str] = []
        comment_field_mismatches: list[str] = []
        material_field_mismatches: list[str] = []
        invalid_post_status_ids: list[str] = []
        csv_post_status_by_id: dict[str, str] = {}
        if not notes_path or not comments_path or not notes_path.exists() or not comments_path.exists():
            add_issue("csv_missing", "critical", "CSV 总表不存在", "当前配置路径下缺少笔记总表或评论总表。", 1, False)
        else:
            try:
                note_headers, csv_note_rows = self._read_csv_table(notes_path, NOTE_CSV_HEADERS)
                comment_headers, csv_comment_rows = self._read_csv_table(comments_path, COMMENT_CSV_HEADERS)
                if ("笔记ID" not in note_headers or "笔记ID" not in comment_headers
                        or "笔记评论ID" not in comment_headers or "评论状态" not in comment_headers
                        or "帖子状态" not in note_headers):
                    add_issue("csv_schema", "critical", "CSV 表头结构不完整",
                              "笔记或评论表缺少笔记ID、评论ID、帖子状态或评论状态列。", 1, False)
                excel_note_ids = [valid_note_id(row.get("笔记ID")) for row in csv_note_rows]
                invalid_note_rows = [str(index) for index, note_id in enumerate(excel_note_ids, 2) if not note_id]
                excel_note_ids = [value for value in excel_note_ids if value]
                excel_comment_rows = len(csv_comment_rows)
                db_note_by_id = {row["note_id"]: row for row in note_rows}
                for index, row in enumerate(csv_note_rows, 2):
                    note_id = valid_note_id(row.get("笔记ID"))
                    url_id = note_url_identity(row.get("笔记url"))
                    if note_id and url_id and note_id != url_id:
                        note_url_mismatches.append(note_id)
                    csv_media = text(row.get("对应帖子文件夹地址"), 4000)
                    db_media = text((db_note_by_id.get(note_id) or {}).get("media_dir"), 4000)
                    if csv_media and db_media:
                        try:
                            media_differs = Path(csv_media).resolve() != Path(db_media).resolve()
                        except OSError:
                            media_differs = csv_media.casefold() != db_media.casefold()
                        if media_differs:
                            media_path_mismatches.append(note_id)
                    stored_note = db_note_by_id.get(note_id) or {}
                    csv_semantic = (
                        nonnegative_int(row.get("语义分析次数")), text(row.get("分析结论是否差评"), 40),
                        text(row.get("差评类型"), 1000), text(row.get("差评子类型"), 2000)
                    )
                    db_semantic = (
                        int(stored_note.get("semantic_analysis_count") or 0),
                        text(stored_note.get("analysis_is_negative"), 40),
                        text(stored_note.get("negative_type"), 1000), text(stored_note.get("negative_subtype"), 2000)
                    )
                    if note_id and stored_note and csv_semantic != db_semantic:
                        note_semantic_mismatches.append(note_id)
                    if note_id and stored_note:
                        core_pairs = (
                            (row.get("笔记标题"), stored_note.get("title"), 1000),
                            (row.get("用户昵称"), stored_note.get("author"), 500),
                            (row.get("笔记内容"), stored_note.get("content"), 20000),
                            (row.get("来源词"), stored_note.get("keyword"), 200),
                        )
                        differs = any(
                            self._consistent_text(left, limit) != self._consistent_text(right, limit)
                            for left, right, limit in core_pairs
                        ) or tag_text(row.get("笔记话题")) != tag_text(stored_note.get("tags")) \
                            or normalize_xhs_url(row.get("笔记url")) != normalize_xhs_url(stored_note.get("url"))
                        try:
                            time_payload = json.loads(stored_note.get("payload_json") or "{}")
                        except (TypeError, ValueError):
                            time_payload = {}
                        if isinstance(time_payload, dict) and isinstance(time_payload.get("publishedTime"), dict):
                            differs = differs or any(
                                self._consistent_text(row.get(key), 1000) != value
                                for key, value in csv_time_fields(time_payload).items()
                            )
                        if differs:
                            note_field_mismatches.append(note_id)
                    raw_post_status = text(row.get("帖子状态"), 40)
                    if note_id:
                        if raw_post_status not in {POST_STATUS_PRESENT, POST_STATUS_DELETED}:
                            invalid_post_status_ids.append(note_id)
                        csv_post_status_by_id[note_id] = post_status_label(raw_post_status)
                for index, row in enumerate(csv_comment_rows, 2):
                    explicit_note_id = valid_note_id(row.get("笔记ID"))
                    url_id = note_url_identity(row.get("原笔记url"))
                    comment_id = text(row.get("笔记评论ID"), 256)
                    if comment_id:
                        csv_comment_ids.append(comment_id)
                        raw_status = text(row.get("评论状态"), 40)
                        if raw_status not in {COMMENT_STATUS_PRESENT, COMMENT_STATUS_DELETED}:
                            invalid_comment_status_ids.append(comment_id)
                        csv_comment_status_by_id[comment_id] = comment_status_label(raw_status)
                        csv_comment_semantic_by_id[comment_id] = (
                            nonnegative_int(row.get("语义分析次数")), text(row.get("分析结论是否差评"), 40),
                            text(row.get("差评类型"), 1000), text(row.get("差评子类型"), 2000)
                        )
                    if not explicit_note_id:
                        missing_comment_note_ids.append(comment_id or f"row:{index}")
                    if explicit_note_id and url_id and explicit_note_id != url_id:
                        comment_url_mismatches.append(comment_id or f"row:{index}")
                    substantive = bool(text(row.get("用户昵称"), 500) or text(row.get("评论内容"), 8000)
                                       or text(row.get("评论时间"), 100))
                    if not explicit_note_id or not comment_id or not substantive:
                        abnormal_comment_rows.append(comment_id or f"row:{index}")
            except Exception as exc:
                add_issue("csv_read", "critical", "CSV 总表读取失败", text(exc, 500), 1, False)

        excel_note_set = set(excel_note_ids)
        duplicate_excel = len(excel_note_ids) - len(excel_note_set)
        missing_excel = sorted(pulled_ids - excel_note_set)
        excel_only = sorted(excel_note_set - db_note_ids)
        csv_comment_id_set = set(csv_comment_ids)
        duplicate_comment_ids = len(csv_comment_ids) - len(csv_comment_id_set)
        if csv_comment_rows:
            ids_by_note: dict[str, set[str]] = {}
            for row in csv_comment_rows:
                note_id = csv_comment_note_id(row)
                comment_id = text(row.get("笔记评论ID"), 256)
                if note_id and comment_id:
                    ids_by_note.setdefault(note_id, set()).add(comment_id)
            for row in csv_comment_rows:
                note_id = csv_comment_note_id(row)
                comment_id = text(row.get("笔记评论ID"), 256)
                if note_id and note_id not in excel_note_set:
                    if text(row.get("映射状态"), 40) == "待复核":
                        mapping_review_ids.append(comment_id or note_id)
                    else:
                        unreviewed_orphan_ids.append(comment_id or note_id)
                parent_id = text(row.get("父评论ID"), 256)
                if note_id and parent_id and parent_id not in ids_by_note.get(note_id, set()):
                    missing_parent_ids.append(comment_id or parent_id)
        csv_missing_db = sorted(csv_comment_id_set - db_comment_ids)
        db_missing_csv = sorted(db_comment_ids - csv_comment_id_set)
        post_presence_status_mismatches = sorted(
            note_id for note_id in excel_note_set.intersection(db_note_ids)
            if csv_post_status_by_id.get(note_id) != db_note_status.get(note_id)
        )
        presence_status_mismatches = sorted(
            comment_id for comment_id in csv_comment_id_set.intersection(db_comment_ids)
            if csv_comment_status_by_id.get(comment_id) != db_comment_status.get(comment_id)
        )
        comment_semantic_mismatches = sorted(
            comment_id for comment_id in csv_comment_id_set.intersection(db_comment_ids)
            if csv_comment_semantic_by_id.get(comment_id) != db_comment_semantic.get(comment_id)
        )
        db_comment_by_id = {
            text(row.get("comment_id"), 256): row for row in db_comment_rows if text(row.get("comment_id"), 256)
        }
        for row in csv_comment_rows:
            comment_id = text(row.get("笔记评论ID"), 256)
            stored = db_comment_by_id.get(comment_id)
            if not stored:
                continue
            core_differs = any((
                self._consistent_text(csv_comment_note_id(row), 128) != self._consistent_text(stored.get("note_id"), 128),
                self._consistent_text(row.get("用户昵称"), 500) != self._consistent_text(stored.get("author"), 500),
                self._consistent_text(row.get("评论用户主页url"), 2000) != self._consistent_text(stored.get("author_url"), 2000),
                self._consistent_text(row.get("评论内容"), 8000) != self._consistent_text(stored.get("content"), 8000),
                self._consistent_text(row.get("评论时间"), 100) != self._consistent_text(stored.get("published_at"), 100),
                self._consistent_text(row.get("父评论ID"), 256) != self._consistent_text(stored.get("parent_comment_id"), 256),
                nonnegative_int(row.get("点赞量")) != int(stored.get("like_count") or 0),
                comment_level_value(row.get("评论层级")) != int(stored.get("comment_level") or 1),
            ))
            try:
                time_payload = json.loads(stored.get("payload_json") or "{}")
            except (TypeError, ValueError):
                time_payload = {}
            if isinstance(time_payload, dict) and isinstance(time_payload.get("publishedTime"), dict):
                core_differs = core_differs or any(
                    self._consistent_text(row.get(key), 1000) != value
                    for key, value in csv_time_fields(time_payload, kind="comment").items()
                )
            if core_differs:
                comment_field_mismatches.append(comment_id)
        csv_note_by_id = {
            valid_note_id(row.get("笔记ID")): row for row in csv_note_rows if valid_note_id(row.get("笔记ID"))
        }
        csv_comments_by_note: dict[str, list[dict[str, Any]]] = {}
        db_comments_by_note: dict[str, list[dict[str, Any]]] = {}
        for row in csv_comment_rows:
            csv_comments_by_note.setdefault(csv_comment_note_id(row), []).append(row)
        for row in db_comment_rows:
            db_comments_by_note.setdefault(text(row.get("note_id"), 128), []).append(row)
        db_note_by_id = {text(row.get("note_id"), 128): row for row in note_rows}
        for note_id in sorted(pulled_ids.intersection(csv_note_by_id)):
            stored_note = db_note_by_id.get(note_id) or {}
            media_dir = text(stored_note.get("media_dir"), 4000)
            try:
                has_material = bool(media_dir and Path(media_dir).is_dir())
            except OSError:
                has_material = False
            if not has_material:
                continue
            try:
                self._verify_note_field_consistency(
                    note_id, csv_note_by_id[note_id], csv_comments_by_note.get(note_id, []),
                    stored_note, db_comments_by_note.get(note_id, []), media_dir,
                )
            except Exception:
                material_field_mismatches.append(note_id)
        add_issue("csv_invalid_note_rows", "critical", "笔记 CSV 存在无有效 ID 的行",
                  "无法建立稳定外键；重复空 ID 行也会造成界面状态误判。",
                  len(invalid_note_rows), False, invalid_note_rows)
        add_issue("csv_note_url_mismatch", "critical", "笔记 ID 与保存 URL 串帖",
                  "笔记行 URL 中的 ID 与笔记ID不同。", len(note_url_mismatches), False, note_url_mismatches)
        add_issue("csv_sqlite_media_path_mismatch", "warning", "CSV 与 SQLite 素材路径不一致",
                  "同一帖子必须指向同一个受管素材目录。", len(media_path_mismatches), False, media_path_mismatches)
        add_issue("csv_duplicate_notes", "critical", "CSV 存在重复帖子行", "同一笔记 ID 在笔记总表重复出现。",
                  duplicate_excel, False)
        add_issue("sqlite_post_status_flag_mismatch", "critical", "SQLite 帖子状态标记不一致",
                  "post_status 与 is_deleted 必须表达同一存续状态。", len(db_note_flag_mismatches), False,
                  db_note_flag_mismatches)
        add_issue("csv_post_status_invalid", "critical", "帖子状态字段存在空值或非法值",
                  "帖子状态只能是“存在”或“已删除”。", len(invalid_post_status_ids), False,
                  invalid_post_status_ids)
        add_issue("csv_sqlite_post_status_mismatch", "critical", "CSV 与 SQLite 帖子状态不一致",
                  "同一帖子在两个数据源中的存在/已删除状态不同。", len(post_presence_status_mismatches), False,
                  post_presence_status_mismatches)
        add_issue("csv_comment_missing_note_id", "critical", "评论缺少明确笔记ID",
                  "评论不能只依赖 URL 推断所属帖子。", len(missing_comment_note_ids), False, missing_comment_note_ids)
        add_issue("csv_abnormal_comment_rows", "critical", "评论 CSV 存在拆行或异常行",
                  "评论必须同时具备笔记ID、稳定评论ID及至少一个正文/作者/时间字段。",
                  len(abnormal_comment_rows), False, abnormal_comment_rows)
        add_issue("csv_duplicate_comment_ids", "critical", "评论 ID 重复",
                  "同一个评论ID对应多行，无法保证幂等同步。", duplicate_comment_ids, False)
        add_issue("csv_comment_status_invalid", "critical", "评论状态字段存在空值或非法值",
                  "评论状态只能是“存在”或“已删除”。", len(invalid_comment_status_ids), False,
                  invalid_comment_status_ids)
        add_issue("csv_sqlite_comment_status_mismatch", "critical", "CSV 与 SQLite 评论状态不一致",
                  "同一评论在两个数据源中的存在/已删除状态不同。", len(presence_status_mismatches), False,
                  presence_status_mismatches)
        add_issue("csv_sqlite_note_field_mismatch", "critical", "笔记 CSV 与 SQLite 字段不一致",
                  "标题、作者、正文、话题、来源词或链接未同步为同一快照。",
                  len(set(note_field_mismatches)), True, sorted(set(note_field_mismatches)))
        add_issue("csv_sqlite_comment_field_mismatch", "critical", "评论 CSV 与 SQLite 字段不一致",
                  "评论正文、作者、时间、点赞量、层级或父评论字段不一致。",
                  len(set(comment_field_mismatches)), True, sorted(set(comment_field_mismatches)))
        add_issue("material_snapshot_field_mismatch", "critical", "素材快照与总表字段不一致",
                  "note.json、comments.json 或正文快照未与 CSV/SQLite 保持同一字段和状态。",
                  len(set(material_field_mismatches)), True, sorted(set(material_field_mismatches)))
        add_issue("csv_sqlite_note_semantic_mismatch", "critical", "笔记语义字段与 SQLite 不一致",
                  "语义分析次数、差评结论或分类字段未同步。", len(note_semantic_mismatches), False,
                  note_semantic_mismatches)
        add_issue("csv_sqlite_comment_semantic_mismatch", "critical", "评论语义字段与 SQLite 不一致",
                  "语义分析次数、差评结论或分类字段未同步。", len(comment_semantic_mismatches), False,
                  comment_semantic_mismatches)
        add_issue("csv_comment_url_mismatch", "warning", "评论笔记ID与原笔记 URL 不一致",
                  "同步时可能写入错误帖子。", len(comment_url_mismatches), False, comment_url_mismatches)
        add_issue("csv_orphan_comments", "critical", "评论指向笔记总表之外的帖子",
                  "未标记待复核的评论外键找不到笔记 CSV 行。",
                  len(unreviewed_orphan_ids), False, unreviewed_orphan_ids)
        add_issue("comment_mapping_review", "info", "评论映射等待人工复核",
                  "评论已完整保留，但所属帖子尚未进入笔记总表，不会自动删除。",
                  len(mapping_review_ids), False, mapping_review_ids)
        add_issue("csv_sqlite_comment_gap", "critical", "评论 CSV 与 SQLite ID 集合不一致",
                  f"CSV 独有 {len(csv_missing_db)} 条，SQLite 独有 {len(db_missing_csv)} 条。",
                  len(csv_missing_db) + len(db_missing_csv), False, [*csv_missing_db, *db_missing_csv])
        add_issue("comment_parent_missing", "info", "部分二级评论缺少本地主评论",
                  "父评论可能未在页面加载；保留二级评论并等待后续同步补全。",
                  len(missing_parent_ids), False, missing_parent_ids)
        add_issue("pulled_missing_csv", "critical", "已拉取帖子未写入 CSV", "SQLite 标记已拉取，但笔记 CSV 找不到对应帖子行。",
                  len(missing_excel), False, missing_excel)
        add_issue("csv_missing_sqlite", "warning", "CSV 帖子未进入 SQLite", "重新载入 CSV 可修复本地索引。",
                  len(excel_only), True, excel_only)

        weights = {"critical": 24, "warning": 7, "info": 1}
        score = max(0, 100 - sum(weights.get(item["severity"], 1) for item in issues))
        status = "critical" if any(item["severity"] == "critical" for item in issues) \
            else "warning" if any(item["severity"] == "warning" for item in issues) else "healthy"
        return {
            "ok": True, "status": status, "score": score, "checkedAt": now_iso(), "issues": issues,
            "summary": {
                "databaseNotes": len(note_rows), "databaseComments": db_comment_count,
                "activePosts": len(note_rows) - db_deleted_note_count,
                "deletedPosts": db_deleted_note_count,
                "activeComments": db_comment_count - db_deleted_comment_count,
                "deletedComments": db_deleted_comment_count,
                "csvNotes": len(excel_note_ids), "csvComments": excel_comment_rows,
                "excelNotes": len(excel_note_ids), "excelComments": excel_comment_rows,
                "pulledNotes": len(pulled_ids),
                "mappingReviewComments": len(mapping_review_ids),
                "commentIdAliasCandidates": len(comment_alias_candidates),
                "logicalDuplicateCommentCandidates": len(logical_duplicate_candidates),
                "abnormalCommentRows": len(abnormal_comment_rows),
                "csvOnlyCommentIds": len(csv_missing_db), "sqliteOnlyCommentIds": len(db_missing_csv),
                "relationshipsConsistent": not any(item["id"] in {
                    "csv_invalid_note_rows", "csv_note_url_mismatch", "csv_sqlite_media_path_mismatch", "csv_comment_missing_note_id",
                    "csv_abnormal_comment_rows", "csv_duplicate_comment_ids", "csv_comment_status_invalid",
                    "sqlite_post_status_flag_mismatch", "csv_post_status_invalid", "csv_sqlite_post_status_mismatch",
                    "csv_sqlite_comment_status_mismatch", "csv_sqlite_note_field_mismatch",
                    "csv_sqlite_comment_field_mismatch", "material_snapshot_field_mismatch",
                    "csv_sqlite_note_semantic_mismatch",
                    "csv_sqlite_comment_semantic_mismatch", "csv_comment_url_mismatch",
                    "csv_orphan_comments", "csv_sqlite_comment_gap", "shared_media_directory",
                    "material_post_status_mismatch", "sqlite_payload_cross_note_id", "sqlite_payload_invalid_note_id"
                } for item in issues),
                "issueCount": len(issues),
                "repairableCount": sum(1 for item in issues if item["repairable"]),
            },
        }

    def _normalize_csv_cross_store_fields(self) -> dict[str, int]:
        """Canonicalize fields whose display variants otherwise hide real cross-store drift."""
        notes_path, comments_path = self._csv_paths()
        with self.pull_lock:
            note_headers, note_rows = self._read_csv_table(notes_path, NOTE_CSV_HEADERS)
            comment_headers, comment_rows = self._read_csv_table(comments_path, COMMENT_CSV_HEADERS)
            with self.lock, self._session() as db:
                stored_rows = db.execute(
                    """SELECT comment_id,author_url,parent_comment_id,payload_json,sentiment,
                              semantic_analysis_count,analysis_is_negative,negative_type,negative_subtype,
                              comment_status,is_deleted
                       FROM comments"""
                ).fetchall()
                stored_note_rows = db.execute(
                    """SELECT note_id,url,post_sentiment,payload_json,media_dir,
                              semantic_analysis_count,analysis_is_negative,negative_type,negative_subtype,
                              post_status,is_deleted
                       FROM notes"""
                ).fetchall()
            stored_note_author_urls: dict[str, str] = {}
            stored_note_urls: dict[str, str] = {}
            stored_note_sentiments: dict[str, str] = {}
            stored_note_materials: dict[str, tuple[str, str]] = {}
            stored_note_semantics: dict[str, tuple[int, str, str, str]] = {}
            for item in stored_note_rows:
                try:
                    note_payload = json.loads(item["payload_json"] or "{}")
                    if not isinstance(note_payload, dict):
                        note_payload = {}
                except (TypeError, ValueError):
                    note_payload = {}
                stored_note_author_urls[str(item["note_id"])] = text(note_payload.get("authorUrl"), 2000)
                stored_note_urls[str(item["note_id"])] = text(item["url"], 4000)
                stored_note_sentiments[str(item["note_id"])] = persisted_sentiment_label(item["post_sentiment"])
                stored_note_semantics[str(item["note_id"])] = (
                    int(item["semantic_analysis_count"] or 0), text(item["analysis_is_negative"], 40),
                    text(item["negative_type"], 1000), text(item["negative_subtype"], 2000),
                )
                media_dir = text(item["media_dir"], 4000)
                try:
                    material_files = "\n".join(sorted(
                        path.name for path in Path(media_dir).iterdir() if path.is_file()
                    )) if media_dir and Path(media_dir).is_dir() else ""
                except OSError:
                    material_files = ""
                stored_note_materials[str(item["note_id"])] = (media_dir, material_files)
            stored_comments: dict[str, dict[str, str]] = {}
            for item in stored_rows:
                try:
                    payload = json.loads(item["payload_json"] or "{}")
                    if not isinstance(payload, dict):
                        payload = {}
                except (TypeError, ValueError):
                    payload = {}
                stored_comments[str(item["comment_id"])] = {
                    "authorUrl": text(item["author_url"], 2000),
                    "parentId": text(item["parent_comment_id"], 256),
                    "isAuthor": ("是" if bool_value(payload.get("isAuthor")) else "否")
                    if "isAuthor" in payload else "",
                    "sentiment": persisted_sentiment_label(item["sentiment"]),
                    "semantic": (
                        int(item["semantic_analysis_count"] or 0), text(item["analysis_is_negative"], 40),
                        text(item["negative_type"], 1000), text(item["negative_subtype"], 2000),
                    ),
                    "status": comment_status_label(item["comment_status"], item["is_deleted"]),
                }
            tags_changed = 0
            levels_changed = 0
            author_urls_filled = 0
            parent_ids_filled = 0
            author_flags_filled = 0
            post_author_urls_aligned = 0
            note_urls_aligned = 0
            comment_note_urls_aligned = 0
            note_sentiments_aligned = 0
            semantic_fields_aligned = 0
            comment_sentiments_aligned = 0
            presence_statuses_aligned = 0
            material_links_aligned = 0
            note_statuses = {
                str(item["note_id"]): post_status_label(item["post_status"], item["is_deleted"])
                for item in stored_note_rows
            }
            for row in note_rows:
                note_id = valid_note_id(row.get("笔记ID"))
                stored_url = stored_note_urls.get(note_id, "")
                raw_post_status = text(row.get("帖子状态"), 40)
                if note_id in note_statuses and raw_post_status not in {POST_STATUS_PRESENT, POST_STATUS_DELETED}:
                    row["帖子状态"] = note_statuses[note_id]
                    presence_statuses_aligned += 1
                if stored_url and text(row.get("笔记url"), 4000) != stored_url:
                    row["笔记url"] = stored_url
                    note_urls_aligned += 1
                material_dir, material_files = stored_note_materials.get(note_id, ("", ""))
                if material_dir and (
                    text(row.get("对应帖子文件夹地址"), 4000) != material_dir
                    or self._consistent_text(row.get("文件夹内清单"), 50000) != material_files
                ):
                    row["对应帖子文件夹地址"] = material_dir
                    row["文件夹内清单"] = material_files
                    material_links_aligned += 1
                stored_sentiment = stored_note_sentiments.get(note_id, "")
                if stored_sentiment and (
                    text(row.get("AI情绪判断"), 80) != stored_sentiment
                    or text(row.get("帖子好坏"), 80) != stored_sentiment
                ):
                    row["AI情绪判断"] = stored_sentiment
                    row["帖子好坏"] = stored_sentiment
                    note_sentiments_aligned += 1
                semantic = stored_note_semantics.get(note_id, (0, "", "", ""))
                if semantic[0] > 0 or any(semantic[1:]):
                    current_semantic = (
                        nonnegative_int(row.get("语义分析次数")), text(row.get("分析结论是否差评"), 40),
                        text(row.get("差评类型"), 1000), text(row.get("差评子类型"), 2000),
                    )
                    if current_semantic != semantic:
                        row["语义分析次数"], row["分析结论是否差评"], row["差评类型"], row["差评子类型"] = semantic
                        semantic_fields_aligned += 1
                current = text(row.get("笔记话题"), 6000)
                normalized = tag_text(current) or ("无话题" if WHITESPACE_RE.sub("", current) == "无话题" else "")
                if normalized != current:
                    row["笔记话题"] = normalized
                    tags_changed += 1
            for row in comment_rows:
                stored = stored_comments.get(text(row.get("笔记评论ID"), 256)) or {}
                raw_comment_status = text(row.get("评论状态"), 40)
                if stored.get("status") and raw_comment_status not in {COMMENT_STATUS_PRESENT, COMMENT_STATUS_DELETED}:
                    row["评论状态"] = stored["status"]
                    presence_statuses_aligned += 1
                note_id = csv_comment_note_id(row)
                stored_note_url = stored_note_urls.get(note_id, "")
                if stored_note_url and text(row.get("原笔记url"), 4000) != stored_note_url:
                    row["原笔记url"] = stored_note_url
                    comment_note_urls_aligned += 1
                material_dir, material_files = stored_note_materials.get(note_id, ("", ""))
                if material_dir and (
                    text(row.get("对应帖子文件夹地址"), 4000) != material_dir
                    or self._consistent_text(row.get("文件夹内清单"), 50000) != material_files
                ):
                    row["对应帖子文件夹地址"] = material_dir
                    row["文件夹内清单"] = material_files
                    material_links_aligned += 1
                post_author_url = stored_note_author_urls.get(note_id, "")
                if post_author_url and text(row.get("帖子用户主页url"), 2000) != post_author_url:
                    row["帖子用户主页url"] = post_author_url
                    post_author_urls_aligned += 1
                if not text(row.get("评论用户主页url"), 2000) and stored.get("authorUrl"):
                    row["评论用户主页url"] = stored["authorUrl"]
                    author_urls_filled += 1
                stored_sentiment = stored.get("sentiment", "")
                if stored_sentiment and text(row.get("AI情绪判断"), 80) != stored_sentiment:
                    row["AI情绪判断"] = stored_sentiment
                    comment_sentiments_aligned += 1
                semantic = stored.get("semantic", (0, "", "", ""))
                if semantic[0] > 0 or any(semantic[1:]):
                    current_semantic = (
                        nonnegative_int(row.get("语义分析次数")), text(row.get("分析结论是否差评"), 40),
                        text(row.get("差评类型"), 1000), text(row.get("差评子类型"), 2000),
                    )
                    if current_semantic != semantic:
                        row["语义分析次数"], row["分析结论是否差评"], row["差评类型"], row["差评子类型"] = semantic
                        semantic_fields_aligned += 1
                if not text(row.get("父评论ID"), 256) and stored.get("parentId"):
                    row["父评论ID"] = stored["parentId"]
                    parent_ids_filled += 1
                if not text(row.get("是否帖主评论"), 20) and stored.get("isAuthor"):
                    row["是否帖主评论"] = stored["isAuthor"]
                    author_flags_filled += 1
                level = comment_level_value(row.get("评论层级"))
                if text(row.get("父评论ID"), 256):
                    level = max(2, level)
                normalized = f"{level}级评论"
                if text(row.get("评论层级"), 30) != normalized:
                    row["评论层级"] = normalized
                    levels_changed += 1
            if any((tags_changed, levels_changed, author_urls_filled, parent_ids_filled,
                    author_flags_filled, post_author_urls_aligned, note_urls_aligned,
                    comment_note_urls_aligned, note_sentiments_aligned, semantic_fields_aligned,
                    comment_sentiments_aligned, presence_statuses_aligned, material_links_aligned)):
                self._replace_csv_pair(
                    note_headers, note_rows, comment_headers, comment_rows, "field-normalize"
                )
            return {
                "tags": tags_changed, "commentLevels": levels_changed,
                "commentAuthorUrls": author_urls_filled, "parentCommentIds": parent_ids_filled,
                "authorFlags": author_flags_filled, "postAuthorUrls": post_author_urls_aligned,
                "noteUrls": note_urls_aligned, "commentNoteUrls": comment_note_urls_aligned,
                "noteSentiments": note_sentiments_aligned,
                "commentSentiments": comment_sentiments_aligned,
                "semanticFields": semantic_fields_aligned,
                "presenceStatuses": presence_statuses_aligned,
                "materialLinks": material_links_aligned,
            }

    @staticmethod
    def _material_note_from_db(row: dict[str, Any]) -> dict[str, Any]:
        try:
            payload = json.loads(row.get("payload_json") or "{}")
            if not isinstance(payload, dict):
                payload = {}
        except (TypeError, ValueError):
            payload = {}
        tags = canonical_tag_items(row.get("tags"))
        if not tags and text(row.get("tags"), 6000) == "无话题":
            tags = ["无话题"]
        return {
            **browser_note_payload(payload),
            "noteId": row.get("note_id") or "", "url": row.get("url") or "",
            "title": row.get("title") or "", "author": row.get("author") or "",
            "content": row.get("content") or "", "keyword": row.get("keyword") or "",
            "tags": tags,
            "postSentiment": persisted_sentiment_label(row.get("post_sentiment")),
            "accessStatus": row.get("access_status") or "",
            "accessError": row.get("access_error") or "",
            "postStatus": post_status_label(row.get("post_status"), row.get("is_deleted")),
            "isDeleted": bool(row.get("is_deleted")), "deletedAt": row.get("deleted_at") or "",
            "lastPresenceCheckedAt": row.get("last_presence_checked_at") or "",
            "semanticAnalysisCount": int(row.get("semantic_analysis_count") or 0),
            "analysisIsNegative": row.get("analysis_is_negative") or "",
            "negativeType": row.get("negative_type") or "",
            "negativeSubtype": row.get("negative_subtype") or "",
        }

    def _refresh_material_snapshot_for_note(self, note_id: str) -> str:
        with self.lock, self._session() as db:
            stored = db.execute("SELECT * FROM notes WHERE note_id=?", (note_id,)).fetchone()
        if stored is None:
            return ""
        row = dict(stored)
        media_dir = text(row.get("media_dir"), 4000)
        try:
            folder_exists = bool(media_dir and Path(media_dir).is_dir())
        except OSError:
            folder_exists = False
        if not folder_exists:
            return ""
        files = sorted(item.name for item in Path(media_dir).iterdir() if item.is_file())
        self._write_media_snapshot(
            {"folder": media_dir, "files": files}, self._material_note_from_db(row),
            self._comments_as_api(note_id),
        )
        actual_count = sum(1 for item in Path(media_dir).iterdir() if item.is_file())
        with self.lock, self._session() as db:
            db.execute("UPDATE notes SET media_file_count=? WHERE note_id=?", (actual_count, note_id))
        return media_dir

    def _refresh_all_material_snapshots(self) -> int:
        with self.lock, self._session() as db:
            note_ids = [str(row[0]) for row in db.execute(
                "SELECT note_id FROM notes WHERE media_dir<>'' AND source='existing_xlsx'"
            ).fetchall()]
        return sum(bool(self._refresh_material_snapshot_for_note(note_id)) for note_id in note_ids)

    def repair_data_health(self, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        with self.pull_lock:
            with self.lock, self._session() as db:
                note_ids = {
                    valid_note_id(row[0]) for row in db.execute(
                        "SELECT note_id FROM notes UNION SELECT note_id FROM comments"
                    ).fetchall()
                }
            note_ids.discard("")
            if not note_ids:
                note_ids.add("checkpoint-empty")
            checkpoints: list[dict[str, Any]] = []
            mutation_started = False
            try:
                for index, note_id in enumerate(sorted(note_ids)):
                    checkpoints.append(self._capture_sync_checkpoint(
                        note_id, capture_csv=index == 0, capture_media_binaries=True,
                        capture_global_database=index == 0,
                    ))
                mutation_started = True
                result = self._repair_data_health_unchecked(payload)
            except Exception as exc:
                if not mutation_started:
                    for checkpoint in reversed(checkpoints):
                        self._discard_sync_checkpoint(checkpoint)
                    raise
                rollback_errors = self._rollback_sync_checkpoints(checkpoints)
                if rollback_errors:
                    raise RuntimeError(
                        f"数据安全修复失败且回滚未完全成功：{'；'.join(rollback_errors)}"
                    ) from exc
                raise
            if not result.get("ok"):
                rollback_errors = self._rollback_sync_checkpoints(checkpoints)
                if rollback_errors:
                    raise RuntimeError(
                        f"数据安全修复未通过且回滚未完全成功：{'；'.join(rollback_errors)}"
                    )
                return {
                    **result, "rolledBack": True, "health": self.data_health(),
                    "error": "数据安全修复未通过，已恢复修复前检查点",
                    "warnings": [*result.get("warnings", []), "修复未通过，已恢复修复前检查点"],
                }
            for checkpoint in reversed(checkpoints):
                self._discard_sync_checkpoint(checkpoint)
            return result

    def _repair_data_health_unchecked(self, _payload: dict[str, Any] | None = None) -> dict[str, Any]:
        actions: list[str] = []
        warnings: list[str] = []
        try:
            normalized = self._normalize_csv_cross_store_fields()
            if any(normalized.values()):
                actions.append(
                    f"规范 {normalized['tags']} 个话题、{normalized['commentLevels']} 个评论层级，"
                    f"补齐 {normalized['commentAuthorUrls']} 个评论主页、"
                    f"{normalized['parentCommentIds']} 个父评论 ID、"
                    f"{normalized['authorFlags']} 个帖主标记，并校准 "
                    f"{normalized['postAuthorUrls']} 个帖子主页链接、"
                    f"{normalized['noteUrls']} 个帖子链接、"
                    f"{normalized['commentNoteUrls']} 个评论关联链接、"
                    f"{normalized['noteSentiments']} 个帖子情绪字段和 "
                    f"{normalized['materialLinks']} 个素材索引"
                )
        except Exception as exc:
            warnings.append(f"CSV 字段规范化失败：{text(exc, 500)}")
        notes_path = Path(self.seed_xlsx_path) if self.seed_xlsx_path else None
        if notes_path and notes_path.exists():
            try:
                inserted = self.seed_from_xlsx(notes_path)
                actions.append(f"重新载入 CSV，补充 {inserted} 条本地索引")
            except Exception as exc:
                warnings.append(f"CSV 重载失败：{text(exc, 500)}")
        with self.lock, self._session() as db:
            db.execute(
                """UPDATE notes SET comment_count_collected=(
                   SELECT COUNT(*) FROM comments c WHERE c.note_id=notes.note_id AND c.is_deleted=0)"""
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
            warnings.append(f"访问状态 CSV 回写失败：{text(exc, 500)}")
        try:
            refreshed = self._refresh_all_material_snapshots()
            if refreshed:
                actions.append(f"校准 {refreshed} 个素材快照")
            final_normalized = self._normalize_csv_cross_store_fields()
            if any(final_normalized.values()) and notes_path:
                self.seed_from_xlsx(notes_path)
                actions.append("按最终素材目录再次校准 CSV 索引与 SQLite")
                refreshed_again = self._refresh_all_material_snapshots()
                if refreshed_again:
                    actions.append(f"按最终 CSV/SQLite 状态再次校准 {refreshed_again} 个素材快照")
        except Exception as exc:
            warnings.append(f"素材快照校准失败：{text(exc, 500)}")
        health = self.data_health()
        if health.get("status") == "critical":
            warnings.append("安全修复后仍存在 critical 数据问题，未宣告修复成功")
        return {"ok": not warnings, "actions": actions, "warnings": warnings, "health": health}

    @staticmethod
    def _csv_comment_to_api(row: dict[str, Any]) -> dict[str, Any]:
        level = comment_level_value(row.get("评论层级"))
        return {
            "commentId": text(row.get("笔记评论ID"), 256),
            "noteId": csv_comment_note_id(row),
            "parentCommentId": text(row.get("父评论ID"), 256),
            "content": text(row.get("评论内容"), 8000),
            "author": text(row.get("用户昵称"), 500),
            "authorUrl": text(row.get("评论用户主页url"), 2000),
            "publishedAt": text(row.get("评论时间"), 100),
            "likeCount": int(float(text(row.get("点赞量"), 30) or 0)) if re.fullmatch(r"\d+(?:\.\d+)?", text(row.get("点赞量"), 30)) else 0,
            "replyCount": 0,
            "commentLevel": level,
            "commentType": "子评论" if level >= 2 else "主评论",
            "isAuthor": text(row.get("是否帖主评论"), 20) == "是",
            "sentiment": text(row.get("AI情绪判断"), 80),
            "commentStatus": comment_status_label(row.get("评论状态")),
            "isDeleted": comment_status_label(row.get("评论状态")) == COMMENT_STATUS_DELETED,
            "semanticAnalysisCount": nonnegative_int(row.get("语义分析次数")),
            "analysisIsNegative": text(row.get("分析结论是否差评"), 40),
            "negativeType": text(row.get("差评类型"), 1000),
            "negativeSubtype": text(row.get("差评子类型"), 2000),
        }

    @staticmethod
    def _api_comment_to_csv(
        item: dict[str, Any], note_id: str, note_row: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        note_row = note_row or {}
        level = max(1, min(int(item.get("commentLevel") or item.get("comment_level") or 1), 3))
        return {
            "笔记ID": note_id,
            "原笔记url": text(note_row.get("笔记url"), 4000) or f"https://www.xiaohongshu.com/explore/{note_id}",
            "帖子用户主页url": text(note_row.get("用户主页url"), 2000),
            "笔记评论ID": text(item.get("commentId") or item.get("comment_id"), 256),
            "用户昵称": text(item.get("author"), 500),
            "评论用户主页url": text(item.get("authorUrl") or item.get("author_url"), 2000),
            "评论内容": text(item.get("content"), 8000),
            "评论时间": text(item.get("publishedAt") or item.get("published_at"), 100),
            "是否帖主评论": "是" if bool_value(item.get("isAuthor")) else "否",
            "点赞量": int(item.get("likeCount") or item.get("like_count") or 0),
            "评论层级": f"{level}级评论",
            "父评论ID": text(item.get("parentCommentId") or item.get("parent_comment_id"), 256),
            "对应帖子文件夹地址": text(note_row.get("对应帖子文件夹地址"), 4000),
            "文件夹内清单": text(note_row.get("文件夹内清单"), 50000),
            "AI情绪判断": text(item.get("sentiment"), 80),
            "映射状态": "已映射",
            "映射备注": "",
            **csv_time_fields(item, kind="comment"),
            "语义分析次数": nonnegative_int(item.get("semanticAnalysisCount") or item.get("semantic_analysis_count")),
            "分析结论是否差评": text(item.get("analysisIsNegative") or item.get("analysis_is_negative"), 40),
            "差评类型": text(item.get("negativeType") or item.get("negative_type"), 1000),
            "差评子类型": text(item.get("negativeSubtype") or item.get("negative_subtype"), 2000),
            "评论状态": comment_status_label(
                item.get("commentStatus") or item.get("comment_status"), item.get("isDeleted") or item.get("is_deleted")
            ),
        }

    def repair_csv_relationships(self, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        """Repair every store under persistent per-note checkpoints."""
        with self.pull_lock:
            with self.lock, self._session() as db:
                note_ids = {
                    valid_note_id(row[0]) for row in db.execute(
                        "SELECT note_id FROM notes UNION SELECT note_id FROM comments"
                    ).fetchall()
                }
            note_ids.discard("")
            try:
                notes_path, comments_path = self._csv_paths()
                note_ids.update(
                    valid_note_id(row.get("笔记ID"))
                    for row in self._read_csv_table(notes_path, NOTE_CSV_HEADERS)[1]
                )
                note_ids.update(
                    csv_comment_note_id(row)
                    for row in self._read_csv_table(comments_path, COMMENT_CSV_HEADERS)[1]
                )
                note_ids.discard("")
            except Exception:
                pass
            if not note_ids:
                note_ids.add("checkpoint-empty")
            checkpoints: list[dict[str, Any]] = []
            mutation_started = False
            try:
                for index, note_id in enumerate(sorted(note_ids)):
                    checkpoints.append(self._capture_sync_checkpoint(
                        note_id, capture_csv=index == 0, capture_media_binaries=True,
                        capture_global_database=index == 0,
                    ))
                mutation_started = True
                result = self._repair_csv_relationships_unchecked(payload)
                if result.get("warnings") or result.get("health", {}).get("status") == "critical":
                    raise ValueError("关系修复未通过最终全存储健康检查")
            except Exception as exc:
                if not mutation_started:
                    for checkpoint in reversed(checkpoints):
                        self._discard_sync_checkpoint(checkpoint)
                    raise
                rollback_errors = self._rollback_sync_checkpoints(checkpoints)
                if rollback_errors:
                    raise RuntimeError(
                        f"关系修复失败且回滚未完全成功：{'；'.join(rollback_errors)}"
                    ) from exc
                raise
            for checkpoint in reversed(checkpoints):
                self._discard_sync_checkpoint(checkpoint)
            return result

    def _repair_csv_relationships_unchecked(self, _payload: dict[str, Any] | None = None) -> dict[str, Any]:
        """Unchecked relationship repair; public callers provide persistent rollback."""
        notes_path, comments_path = self._csv_paths()
        repair_id = f"csv-relations-{datetime.now().strftime('%Y%m%d%H%M%S%f')}"
        timestamp = now_iso()
        warnings: list[str] = []
        with self.pull_lock:
            note_headers, raw_notes = self._read_csv_table(notes_path, NOTE_CSV_HEADERS)
            comment_headers, raw_comments = self._read_csv_table(comments_path, COMMENT_CSV_HEADERS)
            repaired = repair_relationship_rows(
                raw_notes, raw_comments, note_headers, comment_headers
            )
            note_headers = repaired["noteHeaders"]
            comment_headers = repaired["commentHeaders"]
            note_rows = repaired["noteRows"]
            comment_rows = repaired["commentRows"]
            note_by_id = {valid_note_id(row.get("笔记ID")): row for row in note_rows
                          if valid_note_id(row.get("笔记ID"))}

            with self.lock, self._session() as db:
                db_notes = {str(row["note_id"]): dict(row) for row in db.execute("SELECT * FROM notes").fetchall()}
                db_comments = [dict(row) for row in db.execute("SELECT * FROM comments").fetchall()]
            for note_id, note_row in note_by_id.items():
                stored_media = text((db_notes.get(note_id) or {}).get("media_dir"), 4000)
                if stored_media and Path(stored_media).is_dir():
                    note_row["对应帖子文件夹地址"] = stored_media
                    note_row["文件夹内清单"] = "\n".join(
                        sorted(item.name for item in Path(stored_media).iterdir() if item.is_file())
                    )
            material_comments: list[dict[str, Any]] = []
            media_root = self._media_root()
            if media_root.is_dir():
                for material_path in media_root.rglob("comments.json"):
                    try:
                        loaded = json.loads(material_path.read_text(encoding="utf-8-sig"))
                        if isinstance(loaded, list):
                            material_comments.extend(item for item in loaded if isinstance(item, dict))
                    except (OSError, ValueError) as exc:
                        warnings.append(f"素材评论读取失败：{material_path.name} ({text(exc, 200)})")

            ordered_ids: list[str] = []
            by_id: dict[str, dict[str, Any]] = {}
            for row in comment_rows:
                comment_id = text(row.get("笔记评论ID"), 256)
                if comment_id and comment_id not in by_id:
                    by_id[comment_id] = row
                    ordered_ids.append(comment_id)

            def note_row_for(note_id: str) -> dict[str, Any]:
                if note_id in note_by_id:
                    return note_by_id[note_id]
                stored = db_notes.get(note_id) or {}
                return {
                    "笔记ID": note_id,
                    "笔记url": text(stored.get("url"), 4000) or f"https://www.xiaohongshu.com/explore/{note_id}",
                    "对应帖子文件夹地址": text(stored.get("media_dir"), 4000),
                    "文件夹内清单": "",
                }

            def merge_source(item: dict[str, Any], source: str) -> None:
                note_id = valid_note_id(item.get("noteId") or item.get("note_id"))
                comment_id = text(item.get("commentId") or item.get("comment_id"), 256)
                if not note_id or not comment_id:
                    return
                incoming = self._api_comment_to_csv(item, note_id, note_row_for(note_id))
                if source == "sqlite":
                    try:
                        payload = json.loads(item.get("payload_json") or "{}")
                        if isinstance(payload, dict):
                            payload.update({key: val for key, val in item.items() if key != "payload_json"})
                            incoming = self._api_comment_to_csv(payload, note_id, note_row_for(note_id))
                            incoming["笔记评论ID"] = comment_id
                    except (TypeError, ValueError):
                        pass
                    if text(item.get("sentiment"), 80):
                        incoming["AI情绪判断"] = sentiment_label(item.get("sentiment"))
                existing = by_id.get(comment_id)
                if existing is None:
                    by_id[comment_id] = incoming
                    ordered_ids.append(comment_id)
                    return
                for name, incoming_value in incoming.items():
                    if not text(existing.get(name), 50000) and text(incoming_value, 50000):
                        existing[name] = incoming_value

            for row in db_comments:
                merge_source(row, "sqlite")
            for item in material_comments:
                merge_source(item, "material")

            merged_rows = [by_id[comment_id] for comment_id in ordered_ids]
            merged = repair_relationship_rows(
                note_rows, merged_rows, note_headers, comment_headers
            )
            note_headers = merged["noteHeaders"]
            comment_headers = merged["commentHeaders"]
            note_rows = merged["noteRows"]
            comment_rows = merged["commentRows"]
            note_by_id = {valid_note_id(row.get("笔记ID")): row for row in note_rows
                          if valid_note_id(row.get("笔记ID"))}

            csv_backups: list[tuple[Path, Path]] = []
            try:
                for target in (notes_path, comments_path):
                    backup = target.with_name(f".{target.stem}.{repair_id}.backup.csv")
                    shutil.copy2(target, backup)
                    csv_backups.append((target, backup))
                self._replace_csv_pair(note_headers, note_rows, comment_headers, comment_rows, repair_id)
                with self.lock, self._session() as db:
                    for archived in repaired.get("archives") or []:
                        db.execute(
                            """INSERT OR REPLACE INTO data_repair_archive
                               (repair_id,source_name,row_number,reason,row_json,archived_at)
                               VALUES(?,?,?,?,?,?)""",
                            (repair_id, archived["source"], int(archived["rowNumber"]),
                             archived["reason"], json.dumps(archived["row"], ensure_ascii=False), timestamp),
                        )
                    db_note_ids = {str(row[0]) for row in db.execute("SELECT note_id FROM notes").fetchall()}
                    for note_id in sorted({csv_comment_note_id(row) for row in comment_rows if csv_comment_note_id(row)}):
                        if note_id in db_note_ids:
                            continue
                        source_note = note_by_id.get(note_id) or {}
                        url = text(source_note.get("笔记url"), 4000) or f"https://www.xiaohongshu.com/explore/{note_id}"
                        db.execute(
                            """INSERT INTO notes(note_id,url,title,author,content,keyword,page_url,first_seen_at,last_seen_at,
                               status,is_relevant,source,payload_json,review_status,review_note)
                               VALUES(?,?,?,?,?,?,?,?,?,'new',0,'relationship_repair','{}','pending_review',?)""",
                            (note_id, url, text(source_note.get("笔记标题"), 1000),
                             text(source_note.get("用户昵称"), 500), text(source_note.get("笔记内容"), 20000),
                             "", url, timestamp, timestamp, "评论存在但笔记尚未进入笔记总表"),
                        )
                        db_note_ids.add(note_id)
                    final_ids: list[str] = []
                    for row in comment_rows:
                        note_id = csv_comment_note_id(row)
                        comment_id = text(row.get("笔记评论ID"), 256)
                        if not note_id or not comment_id:
                            raise ValueError("修复结果仍存在缺少笔记ID或评论ID的行")
                        final_ids.append(comment_id)
                        api = self._csv_comment_to_api(row)
                        mapping_review = text(row.get("映射状态"), 40) == "待复核"
                        payload_json = json.dumps(api, ensure_ascii=False)
                        content_value = text(row.get("评论内容"), 8000)
                        existing = db.execute("SELECT 1 FROM comments WHERE comment_id=?", (comment_id,)).fetchone()
                        if existing:
                            db.execute(
                                """UPDATE comments SET note_id=?,parent_comment_id=?,content=?,author=?,author_url=?,
                                   published_at=?,like_count=?,comment_level=?,last_seen_at=?,payload_json=?,content_hash=?,
                                   sentiment=CASE WHEN ?<>'' THEN ? ELSE sentiment END,
                                   semantic_analysis_count=?,analysis_is_negative=?,negative_type=?,negative_subtype=?,
                                   comment_status=?,is_deleted=?,
                                   deleted_at=CASE WHEN ?=1 AND deleted_at='' THEN ?
                                                   WHEN ?=0 THEN '' ELSE deleted_at END,
                                   last_presence_checked_at=?,
                                   review_status=CASE WHEN ? THEN 'mapping_review'
                                      WHEN review_status='mapping_review' THEN 'pending_review' ELSE review_status END,
                                   review_note=CASE WHEN ? THEN ?
                                      WHEN review_status='mapping_review' THEN '' ELSE review_note END WHERE comment_id=?""",
                                (note_id, api["parentCommentId"], content_value, api["author"], api["authorUrl"],
                                 api["publishedAt"], api["likeCount"], api["commentLevel"], timestamp, payload_json,
                                 self._content_hash(content_value), sentiment_code(row.get("AI情绪判断")),
                                 sentiment_code(row.get("AI情绪判断")),
                                 nonnegative_int(row.get("语义分析次数")), text(row.get("分析结论是否差评"), 40),
                                 text(row.get("差评类型"), 1000), text(row.get("差评子类型"), 2000),
                                 comment_status_label(row.get("评论状态")),
                                 int(comment_status_label(row.get("评论状态")) == COMMENT_STATUS_DELETED),
                                 int(comment_status_label(row.get("评论状态")) == COMMENT_STATUS_DELETED), timestamp,
                                 int(comment_status_label(row.get("评论状态")) == COMMENT_STATUS_DELETED), timestamp,
                                 int(mapping_review), int(mapping_review),
                                 text(row.get("映射备注"), 1000), comment_id),
                            )
                        else:
                            db.execute(
                                """INSERT INTO comments(comment_id,note_id,parent_comment_id,content,author,author_url,
                                   published_at,like_count,reply_count,comment_url,comment_level,first_seen_at,last_seen_at,
                                   payload_json,content_hash,review_status,review_note,sentiment,semantic_analysis_count,
                                   analysis_is_negative,negative_type,negative_subtype,comment_status,is_deleted,
                                   deleted_at,last_presence_checked_at)
                                   VALUES(?,?,?,?,?,?,?,?,0,'',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                                (comment_id, note_id, api["parentCommentId"], content_value, api["author"], api["authorUrl"],
                                 api["publishedAt"], api["likeCount"], api["commentLevel"], timestamp, timestamp,
                                 payload_json, self._content_hash(content_value),
                                 "mapping_review" if mapping_review else "pending_review",
                                 text(row.get("映射备注"), 1000), sentiment_code(row.get("AI情绪判断")),
                                 nonnegative_int(row.get("语义分析次数")), text(row.get("分析结论是否差评"), 40),
                                 text(row.get("差评类型"), 1000), text(row.get("差评子类型"), 2000),
                                 comment_status_label(row.get("评论状态")),
                                 int(comment_status_label(row.get("评论状态")) == COMMENT_STATUS_DELETED),
                                 timestamp if comment_status_label(row.get("评论状态")) == COMMENT_STATUS_DELETED else "",
                                 timestamp),
                            )
                    db.execute("CREATE TEMP TABLE IF NOT EXISTS repair_comment_ids(comment_id TEXT PRIMARY KEY)")
                    db.execute("DELETE FROM repair_comment_ids")
                    db.executemany("INSERT INTO repair_comment_ids(comment_id) VALUES(?)", ((item,) for item in final_ids))
                    db.execute("DELETE FROM comments WHERE comment_id NOT IN (SELECT comment_id FROM repair_comment_ids)")
                    db.execute(
                        """UPDATE notes SET comment_count_collected=(
                           SELECT COUNT(*) FROM comments c WHERE c.note_id=notes.note_id AND c.is_deleted=0)"""
                    )
            except Exception:
                for target, backup in csv_backups:
                    if backup.exists():
                        os.replace(backup, target)
                raise
            finally:
                for _target, backup in csv_backups:
                    backup.unlink(missing_ok=True)

            # Re-import the final note rows as the canonical business snapshot
            # before field-level health checks and material regeneration.
            self._seed_from_csv(notes_path)

            # A historical folder name could be shared by several note IDs.
            # Split it before writing comments.json; otherwise syncing one note
            # silently overwrites the other note's material snapshot.
            shared_media_splits = 0
            shared_sources_to_remove: list[Path] = []
            with self.lock, self._session() as db:
                media_rows_for_split = [dict(row) for row in db.execute(
                    "SELECT note_id,title,content,media_dir FROM notes WHERE media_dir<>''"
                ).fetchall()]
            grouped_media: dict[str, list[dict[str, Any]]] = {}
            for stored in media_rows_for_split:
                try:
                    key = str(Path(text(stored.get("media_dir"), 4000)).resolve()).casefold()
                except OSError:
                    continue
                grouped_media.setdefault(key, []).append(stored)
            for shared_group in grouped_media.values():
                if len(shared_group) < 2:
                    continue
                source_folder = Path(text(shared_group[0].get("media_dir"), 4000))
                if not source_folder.is_dir():
                    continue
                targets: list[tuple[str, Path]] = []
                for stored in shared_group:
                    note_id = valid_note_id(stored.get("note_id"))
                    target = self._media_root() / self._safe_media_folder_name({
                        "noteId": note_id, "title": stored.get("title"), "content": stored.get("content"),
                    })
                    if target.resolve() != source_folder.resolve():
                        shutil.copytree(source_folder, target, dirs_exist_ok=True)
                    targets.append((note_id, target.resolve()))
                for source_file in source_folder.rglob("*"):
                    if not source_file.is_file():
                        continue
                    relative = source_file.relative_to(source_folder)
                    for _note_id, target in targets:
                        copied = target / relative
                        if not copied.is_file() or copied.stat().st_size != source_file.stat().st_size:
                            raise ValueError(f"共享素材目录拆分校验失败：{source_file.name}")
                with self.lock, self._session() as db:
                    for note_id, target in targets:
                        db.execute("UPDATE notes SET media_dir=? WHERE note_id=?", (str(target), note_id))
                target_by_id = dict(targets)
                for row in note_rows:
                    note_id = valid_note_id(row.get("笔记ID"))
                    if note_id in target_by_id:
                        row["对应帖子文件夹地址"] = str(target_by_id[note_id])
                for row in comment_rows:
                    note_id = csv_comment_note_id(row)
                    if note_id in target_by_id:
                        row["对应帖子文件夹地址"] = str(target_by_id[note_id])
                shared_media_splits += len(targets)
                shared_sources_to_remove.append(source_folder.resolve())
            if shared_media_splits:
                self._replace_csv_pair(note_headers, note_rows, comment_headers, comment_rows, f"{repair_id}-media-split")

            # Fill source fields that only SQLite/material snapshots retained,
            # then re-import the canonical rows before regenerating snapshots.
            self._normalize_csv_cross_store_fields()
            self._seed_comments_from_csv(comments_path)

            material_synced = 0
            with self.lock, self._session() as db:
                media_rows = [dict(row) for row in db.execute(
                    "SELECT note_id,media_dir FROM notes WHERE media_dir<>''"
                ).fetchall()]
            for stored in media_rows:
                media_dir = text(stored.get("media_dir"), 4000)
                if not media_dir or not Path(media_dir).is_dir():
                    continue
                self._refresh_material_snapshot_for_note(stored["note_id"])
                self._verify_note_store_consistency(stored["note_id"], media_dir, verify_fields=False)
                material_synced += 1
            final_normalized = self._normalize_csv_cross_store_fields()
            if any(final_normalized.values()):
                self._seed_from_csv(notes_path)
                self._seed_comments_from_csv(comments_path)
                material_synced += self._refresh_all_material_snapshots()
            for source_folder in shared_sources_to_remove:
                with self.lock, self._session() as db:
                    still_referenced = int(db.execute(
                        "SELECT COUNT(*) FROM notes WHERE lower(media_dir)=lower(?)", (str(source_folder),)
                    ).fetchone()[0])
                if not still_referenced and source_folder.is_dir():
                    shutil.rmtree(source_folder)

            health = self.data_health()
            result_summary = {
                **repaired["summary"],
                "commentsAfterUnion": len(comment_rows),
                "sqliteCommentsAfter": sum(1 for _item in comment_rows),
                "materialDirectoriesSynced": material_synced,
                "sharedMediaRecordsSplit": shared_media_splits,
                "sourceSqliteComments": len(db_comments),
                "sourceMaterialComments": len(material_comments),
            }
            return {
                "ok": True, "repairId": repair_id, "summary": result_summary,
                "warnings": warnings, "health": health,
                "notesPath": str(notes_path), "commentsPath": str(comments_path),
            }

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

    def weekly_report_dir(self) -> Path:
        """Keep business-facing reports beside the master workbook, not among Bridge internals."""
        xlsx_path = Path(self.seed_xlsx_path) if self.seed_xlsx_path else None
        return (xlsx_path.parent / "weekly_reports") if xlsx_path else (self.export_dir / "weekly_reports")

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
        report_dir = self.weekly_report_dir()
        report_dir.mkdir(parents=True, exist_ok=True)
        base_name = f"小红书舆情周报_{period_start.replace('-', '')}_{period_end.replace('-', '')}"
        xlsx_path = report_dir / f"{base_name}.xlsx"
        html_path = report_dir / f"{base_name}.html"

        from openpyxl import Workbook
        from openpyxl.styles import Alignment, Font, PatternFill
        from openpyxl.utils import get_column_letter

        workbook = Workbook()
        overview = workbook.active
        overview.title = "周报总览"
        overview.append(["小红书舆情周报", f"{period_start} 至 {period_end}"])
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
</style></head><body><main><header><div class='meta'>XHS MONITOR · WEEKLY BRIEF</div><h1>小红书舆情周报</h1><p>{period_start} 至 {period_end}</p></header>
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
        report_root = self.weekly_report_dir().resolve()
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
            text(item.get("parentCommentId"), 256),
        ))
        return f"dom-{hashlib.sha256(identity.encode('utf-8')).hexdigest()[:32]}"

    def _normalize_snapshot_comments(self, note_id: str, comments: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Give one browser snapshot canonical IDs before writing every local store."""
        observation_time = now_iso()
        with self.lock, self._session() as db:
            stored = [dict(row) for row in db.execute(
                """SELECT comment_id,parent_comment_id,author,content,published_at,payload_json,sentiment
                   FROM comments WHERE note_id=?""", (note_id,)
            ).fetchall()]
        by_id = {text(row.get("comment_id"), 256): row for row in stored}
        by_exact = {
            (text(row.get("author"), 500), text(row.get("content"), 8000),
             text(row.get("published_at"), 100), text(row.get("parent_comment_id"), 256)): row
            for row in stored
        }
        by_loose: dict[tuple[str, str, str], list[dict[str, Any]]] = {}
        for row in stored:
            key = (text(row.get("author"), 500), text(row.get("content"), 8000),
                   text(row.get("parent_comment_id"), 256))
            by_loose.setdefault(key, []).append(row)
        supplied_by_exact: dict[tuple[str, str, str, str], set[str]] = {}
        supplied_by_loose: dict[tuple[str, str, str], set[str]] = {}
        for raw in comments:
            if not isinstance(raw, dict) or not text(raw.get("content"), 8000):
                continue
            supplied_id = text(raw.get("commentId"), 256)
            if supplied_id:
                author, content = text(raw.get("author"), 500), text(raw.get("content"), 8000)
                published_at, parent_id = text(raw.get("publishedAt"), 100), text(raw.get("parentCommentId"), 256)
                supplied_by_exact.setdefault((author, content, published_at, parent_id), set()).add(supplied_id)
                supplied_by_loose.setdefault((author, content, parent_id), set()).add(supplied_id)
        aliases: dict[str, str] = {}
        normalized: list[dict[str, Any]] = []
        used: set[str] = set()
        ordered = sorted(
            enumerate(comments),
            key=lambda pair: (max(1, min(int((pair[1] or {}).get("commentLevel") or 1), 3))
                              if isinstance(pair[1], dict) else 3,
                              not bool(text(pair[1].get("commentId"), 256)) if isinstance(pair[1], dict) else True,
                              pair[0]),
        )
        for _index, raw in ordered:
            if not isinstance(raw, dict) or not text(raw.get("content"), 8000):
                continue
            item = dict(raw)
            supplied_id = text(item.get("commentId"), 256)
            supplied_parent = text(item.get("parentCommentId"), 256)
            parent_id = aliases.get(supplied_parent, supplied_parent)
            if supplied_id:
                canonical_id = supplied_id
            else:
                author, content = text(item.get("author"), 500), text(item.get("content"), 8000)
                published_at = text(item.get("publishedAt"), 100)
                key = (author, content, published_at, parent_id)
                snapshot_ids = supplied_by_exact.get(key, set())
                if not snapshot_ids and not published_at:
                    snapshot_ids = supplied_by_loose.get((author, content, parent_id), set())
                if snapshot_ids:
                    # A legacy fragment beside stable-ID rows is not another
                    # uniquely observed comment. Never merge those stable IDs.
                    if len(snapshot_ids) > 1:
                        continue
                    canonical_id = next(iter(snapshot_ids))
                else:
                    existing = by_exact.get(key)
                    if existing is None and not published_at:
                        candidates = by_loose.get((author, content, parent_id), [])
                        existing = candidates[0] if len(candidates) == 1 else None
                    canonical_id = text(existing.get("comment_id"), 256) if existing else self._excel_comment_id(
                        note_id, {**item, "parentCommentId": parent_id}
                    )
            if supplied_id:
                aliases[supplied_id] = canonical_id
            if canonical_id in used:
                continue
            existing_row = by_id.get(canonical_id) or {}
            try:
                existing_payload = json.loads(existing_row.get("payload_json") or "{}")
                if not isinstance(existing_payload, dict):
                    existing_payload = {}
            except (TypeError, ValueError):
                existing_payload = {}
            for name in ("authorUrl", "commentUrl", "isAuthor", "replyCount"):
                if item.get(name) in (None, "") and existing_payload.get(name) not in (None, ""):
                    item[name] = existing_payload[name]
            if not text(item.get("sentiment"), 80) and text(existing_row.get("sentiment"), 80):
                stored_sentiment = text(existing_row.get("sentiment"), 80)
                item["sentiment"] = stored_sentiment if stored_sentiment in set(SENTIMENT_LABELS.values()) else sentiment_label(stored_sentiment)
            used.add(canonical_id)
            item["commentId"] = canonical_id
            item["parentCommentId"] = parent_id
            item["noteId"] = note_id
            item = enrich_time_payload(item, observation_time, kind="comment", previous=existing_payload)
            normalized.append(item)
        return normalized

    def _enrich_comment_time_fields(self, note_id: str, comments: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Time-only projection: keep image-only comments and every stable ID.

        Collection normalization can intentionally reject incomplete browser
        fragments. A CSV/material writer must never apply that policy to stored
        history, where a real comment can have images and no text.
        """
        with self.lock, self._session() as db:
            stored = {str(row[0]): row[1] for row in db.execute(
                "SELECT comment_id,payload_json FROM comments WHERE note_id=?", (note_id,)
            )}
        observed = now_iso()
        result = []
        for raw in comments:
            if not isinstance(raw, dict):
                continue
            comment_id = text(raw.get("commentId"), 256) or self._excel_comment_id(note_id, raw)
            try:
                previous = json.loads(stored.get(comment_id) or "{}")
                if not isinstance(previous, dict):
                    previous = {}
            except (TypeError, ValueError):
                previous = {}
            result.append(enrich_time_payload(raw, observed, kind="comment", previous=previous))
        return result

    def _resolve_pull_identity(self, note: dict[str, Any]) -> tuple[str, str]:
        """Resolve a pull strictly by its canonical XHS note ID."""
        incoming_id = valid_note_id(note.get("noteId"))
        if not incoming_id:
            raise ValueError("noteId is required")
        with self.lock, self._session() as db:
            exact = db.execute("SELECT 1 FROM notes WHERE note_id=?", (incoming_id,)).fetchone()
        return incoming_id, "note_id" if exact else "new"

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
        # Keep enough headroom for atomic temporary filenames under long
        # Windows project paths (legacy 80-char names can exceed MAX_PATH).
        title = re.sub(r"\s+", " ", title)[:40].strip(" .") or "未命名帖子"
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
            text(note.get("content"), 20000),
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
    def _write_json_atomic(path: Path, payload: Any) -> None:
        temporary = path.with_name(f".{path.name}.{os.getpid()}-{time.time_ns()}.tmp")
        try:
            temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
            replace_material_with_retry(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)

    @classmethod
    def _write_media_comments(cls, media_result: dict[str, Any], comments: list[dict[str, Any]]) -> None:
        folder = text(media_result.get("folder"), 4000)
        if not folder:
            return
        path = Path(folder) / "comments.json"
        cls._write_json_atomic(path, comments)
        files = list(media_result.get("files") or [])
        if path.name not in files:
            files.append(path.name)
        media_result["files"] = files
        media_result["fileCount"] = len(files)

    def _comments_as_api(self, note_id: str) -> list[dict[str, Any]]:
        rows = self.list_comments(note_id, 10000)
        output = []
        for row in rows:
            try:
                payload = json.loads(row.get("payload_json") or "{}")
                if not isinstance(payload, dict):
                    payload = {}
            except (TypeError, ValueError):
                payload = {}
            output.append({
                **payload,
                "commentId": text(row.get("comment_id"), 256),
                "noteId": note_id,
                "parentCommentId": text(row.get("parent_comment_id"), 256),
                "content": text(row.get("content"), 8000),
                "author": text(row.get("author"), 500),
                "authorUrl": text(row.get("author_url"), 2000),
                "publishedAt": text(row.get("published_at"), 100),
                "likeCount": int(row.get("like_count") or 0),
                "replyCount": int(row.get("reply_count") or 0),
                "commentUrl": text(row.get("comment_url"), 2000),
                "commentLevel": int(row.get("comment_level") or 1),
                "commentType": "子评论" if int(row.get("comment_level") or 1) >= 2 else "主评论",
                "sentiment": persisted_sentiment_label(row.get("sentiment")),
                "commentStatus": comment_status_label(row.get("comment_status"), row.get("is_deleted")),
                "isDeleted": bool(row.get("is_deleted")),
                "deletedAt": text(row.get("deleted_at"), 80),
                "lastPresenceCheckedAt": text(row.get("last_presence_checked_at"), 80),
                "semanticAnalysisCount": int(row.get("semantic_analysis_count") or 0),
                "analysisIsNegative": text(row.get("analysis_is_negative"), 40),
                "negativeType": text(row.get("negative_type"), 1000),
                "negativeSubtype": text(row.get("negative_subtype"), 2000),
            })
        return output

    def _write_media_snapshot(
        self, media_result: dict[str, Any], note: dict[str, Any], comments: list[dict[str, Any]]
    ) -> None:
        folder_value = text(media_result.get("folder"), 4000)
        if not folder_value:
            return
        folder = Path(folder_value)
        if not folder.is_dir():
            return
        self._write_media_comments(media_result, comments)
        metadata_path = folder / "note.json"
        previous: dict[str, Any] = {}
        if metadata_path.is_file():
            try:
                loaded = json.loads(metadata_path.read_text(encoding="utf-8-sig"))
                if isinstance(loaded, dict):
                    previous = loaded
            except (OSError, ValueError):
                previous = {}
        presence = post_status_label(note.get("postStatus"), note.get("isDeleted"))
        tag_source = note.get("tags") if "tags" in note else previous.get("tags") or []
        metadata = {
            **previous,
            **browser_note_payload(note),
            "noteId": valid_note_id(note.get("noteId")),
            "url": text(note.get("url"), 2000) or text(previous.get("url"), 2000),
            "title": text(note.get("title"), 1000) or canonical_note_title("", note.get("content"), 80),
            "author": text(note.get("author"), 500),
            "content": text(note.get("content"), 20000),
            "keyword": text(note.get("keyword"), 200),
            "tags": canonical_tag_items(tag_source) or (
                ["无话题"] if tag_text(tag_source) == "无话题" else []
            ),
            "postSentiment": text(note.get("postSentiment"), 80),
            "accessStatus": text(note.get("accessStatus"), 40),
            "accessError": text(note.get("accessError"), 1000),
            "semanticAnalysisCount": nonnegative_int(note.get("semanticAnalysisCount")),
            "analysisIsNegative": text(note.get("analysisIsNegative"), 40),
            "negativeType": text(note.get("negativeType"), 1000),
            "negativeSubtype": text(note.get("negativeSubtype"), 2000),
            "postStatus": presence,
            "isDeleted": presence == POST_STATUS_DELETED,
            "deletedAt": text(note.get("deletedAt"), 80) if presence == POST_STATUS_DELETED else "",
            "lastPresenceCheckedAt": text(note.get("lastPresenceCheckedAt"), 80) or now_iso(),
            "syncedAt": now_iso(),
        }
        self._write_json_atomic(metadata_path, metadata)
        text_snapshot = "\n".join((
            metadata["title"], "", metadata["content"], "", f"来源链接：{metadata['url']}",
        ))
        text_path = folder / "帖子正文.txt"
        temporary = text_path.with_name(f".{text_path.name}.{os.getpid()}-{time.time_ns()}.tmp")
        try:
            temporary.write_text(text_snapshot, encoding="utf-8")
            replace_material_with_retry(temporary, text_path)
        finally:
            temporary.unlink(missing_ok=True)

    def _write_material_note_presence(
        self, note_id: str, media_dir: str, status: str, checked_at: str, deleted_at: str = ""
    ) -> bool:
        folder = Path(text(media_dir, 4000)) if text(media_dir, 4000) else None
        if not folder or not folder.is_dir():
            return False
        path = folder / "note.json"
        previous: dict[str, Any] = {}
        if path.is_file():
            try:
                loaded = json.loads(path.read_text(encoding="utf-8-sig"))
                if isinstance(loaded, dict):
                    previous = loaded
            except (OSError, ValueError):
                previous = {}
        previous.update({
            "noteId": note_id,
            "postStatus": post_status_label(status),
            "isDeleted": post_status_label(status) == POST_STATUS_DELETED,
            "deletedAt": deleted_at if post_status_label(status) == POST_STATUS_DELETED else "",
            "lastPresenceCheckedAt": checked_at,
        })
        self._write_json_atomic(path, previous)
        return True

    @staticmethod
    def _consistent_text(value: Any, limit: int = 20000) -> str:
        return text(value, limit).replace("\r\n", "\n").replace("\r", "\n").strip()

    def _verify_note_field_consistency(
        self,
        note_id: str,
        csv_note: dict[str, Any],
        csv_comments: list[dict[str, Any]],
        db_note: dict[str, Any],
        db_comments: list[dict[str, Any]],
        media_dir: str,
    ) -> dict[str, Any]:
        """Verify source, semantic and presence fields—not only ID sets."""
        mismatches: list[str] = []

        def same(label: str, left: Any, right: Any, limit: int = 20000) -> None:
            if self._consistent_text(left, limit) != self._consistent_text(right, limit):
                mismatches.append(label)

        try:
            note_payload = json.loads(db_note.get("payload_json") or "{}")
            if not isinstance(note_payload, dict):
                note_payload = {}
        except (TypeError, ValueError):
            note_payload = {}
        same("帖子.标题", csv_note.get("笔记标题"), db_note.get("title"), 1000)
        same("帖子.作者", csv_note.get("用户昵称"), db_note.get("author"), 500)
        same("帖子.正文", csv_note.get("笔记内容"), db_note.get("content"))
        same("帖子.来源词", csv_note.get("来源词"), db_note.get("keyword"), 200)
        if tag_text(csv_note.get("笔记话题")) != tag_text(db_note.get("tags")):
            mismatches.append("帖子.话题")
        if normalize_xhs_url(csv_note.get("笔记url")) != normalize_xhs_url(db_note.get("url")):
            mismatches.append("帖子.URL")
        for csv_name, payload_name in NOTE_CSV_SOURCE_FIELDS.items():
            if payload_name in note_payload:
                same(f"帖子.{csv_name}", csv_note.get(csv_name), note_payload.get(payload_name), 4000)
        if "publishedAt" in note_payload:
            same("帖子.发布日期", csv_note.get("发布日期"), text(note_payload.get("publishedAt"), 100)[:10], 20)
        if isinstance(note_payload.get("publishedTime"), dict):
            for name, value in csv_time_fields(note_payload).items():
                same(f"帖子.{name}", csv_note.get(name), value, 1000)
        same("帖子.素材目录", csv_note.get("对应帖子文件夹地址"), db_note.get("media_dir"), 4000)
        actual_material_files: list[str] = []
        try:
            if media_dir and Path(media_dir).is_dir():
                actual_material_files = sorted(path.name for path in Path(media_dir).iterdir() if path.is_file())
        except OSError:
            actual_material_files = []
        csv_note_files = sorted(
            line.strip() for line in self._consistent_text(csv_note.get("文件夹内清单"), 50000).splitlines()
            if line.strip()
        )
        if actual_material_files and csv_note_files != actual_material_files:
            mismatches.append("帖子.素材文件清单")
        if actual_material_files and int(db_note.get("media_file_count") or 0) != len(actual_material_files):
            mismatches.append("帖子.素材文件计数")
        expected_sentiment = persisted_sentiment_label(db_note.get("post_sentiment"))
        same("帖子.AI情绪", csv_note.get("AI情绪判断"), expected_sentiment, 80)
        same("帖子.好坏", csv_note.get("帖子好坏"), expected_sentiment, 80)
        expected_access = {
            "ok": "可打开", "check_failed": "待复核", "unreachable": "打不开", "": ""
        }.get(text(db_note.get("access_status"), 40), text(db_note.get("access_status"), 40))
        same("帖子.访问状态", csv_note.get("访问状态"), expected_access, 100)
        csv_note_semantic = (
            nonnegative_int(csv_note.get("语义分析次数")), text(csv_note.get("分析结论是否差评"), 40),
            text(csv_note.get("差评类型"), 1000), text(csv_note.get("差评子类型"), 2000),
        )
        db_note_semantic = (
            int(db_note.get("semantic_analysis_count") or 0), text(db_note.get("analysis_is_negative"), 40),
            text(db_note.get("negative_type"), 1000), text(db_note.get("negative_subtype"), 2000),
        )
        if csv_note_semantic != db_note_semantic:
            mismatches.append("帖子.语义字段")

        csv_by_id = {
            text(row.get("笔记评论ID"), 256): row for row in csv_comments if text(row.get("笔记评论ID"), 256)
        }
        db_by_id = {text(row.get("comment_id"), 256): row for row in db_comments}
        for comment_id in sorted(set(csv_by_id).intersection(db_by_id)):
            csv_row, db_row = csv_by_id[comment_id], db_by_id[comment_id]
            prefix = f"评论[{comment_id}]"
            same(f"{prefix}.笔记ID", csv_comment_note_id(csv_row), db_row.get("note_id"), 128)
            same(f"{prefix}.作者", csv_row.get("用户昵称"), db_row.get("author"), 500)
            same(f"{prefix}.作者主页", csv_row.get("评论用户主页url"), db_row.get("author_url"), 2000)
            same(f"{prefix}.正文", csv_row.get("评论内容"), db_row.get("content"), 8000)
            same(f"{prefix}.时间", csv_row.get("评论时间"), db_row.get("published_at"), 100)
            same(f"{prefix}.父评论", csv_row.get("父评论ID"), db_row.get("parent_comment_id"), 256)
            same(f"{prefix}.素材目录", csv_row.get("对应帖子文件夹地址"), db_note.get("media_dir"), 4000)
            csv_comment_files = sorted(
                line.strip() for line in self._consistent_text(csv_row.get("文件夹内清单"), 50000).splitlines()
                if line.strip()
            )
            if actual_material_files and csv_comment_files != actual_material_files:
                mismatches.append(f"{prefix}.素材文件清单")
            if normalize_xhs_url(csv_row.get("原笔记url")) != normalize_xhs_url(db_note.get("url")):
                mismatches.append(f"{prefix}.原笔记URL")
            if "authorUrl" in note_payload:
                same(f"{prefix}.帖子作者主页", csv_row.get("帖子用户主页url"), note_payload.get("authorUrl"), 2000)
            if nonnegative_int(csv_row.get("点赞量")) != int(db_row.get("like_count") or 0):
                mismatches.append(f"{prefix}.点赞量")
            if comment_level_value(csv_row.get("评论层级")) != int(db_row.get("comment_level") or 1):
                mismatches.append(f"{prefix}.评论层级")
            csv_semantic = (
                nonnegative_int(csv_row.get("语义分析次数")), text(csv_row.get("分析结论是否差评"), 40),
                text(csv_row.get("差评类型"), 1000), text(csv_row.get("差评子类型"), 2000),
            )
            db_semantic = (
                int(db_row.get("semantic_analysis_count") or 0), text(db_row.get("analysis_is_negative"), 40),
                text(db_row.get("negative_type"), 1000), text(db_row.get("negative_subtype"), 2000),
            )
            if csv_semantic != db_semantic:
                mismatches.append(f"{prefix}.语义字段")
            try:
                comment_payload = json.loads(db_row.get("payload_json") or "{}")
                if not isinstance(comment_payload, dict):
                    comment_payload = {}
            except (TypeError, ValueError):
                comment_payload = {}
            if isinstance(comment_payload.get("publishedTime"), dict):
                for name, value in csv_time_fields(comment_payload, kind="comment").items():
                    same(f"{prefix}.{name}", csv_row.get(name), value, 1000)
            expected_comment_sentiment = persisted_sentiment_label(db_row.get("sentiment"))
            same(f"{prefix}.AI情绪", csv_row.get("AI情绪判断"), expected_comment_sentiment, 80)
            if "isAuthor" in comment_payload:
                expected_author = "是" if bool_value(comment_payload.get("isAuthor")) else "否"
                if text(csv_row.get("是否帖主评论"), 20) != expected_author:
                    mismatches.append(f"{prefix}.是否帖主评论")

        material_note: dict[str, Any] | None = None
        material_comments: list[dict[str, Any]] | None = None
        if media_dir and Path(media_dir).is_dir():
            note_path, comments_path = Path(media_dir) / "note.json", Path(media_dir) / "comments.json"
            if not note_path.is_file():
                mismatches.append("素材.note.json缺失")
            if note_path.is_file():
                loaded_note = json.loads(note_path.read_text(encoding="utf-8-sig"))
                material_note = loaded_note if isinstance(loaded_note, dict) else {}
                same("素材.标题", material_note.get("title"), db_note.get("title"), 1000)
                same("素材.作者", material_note.get("author"), db_note.get("author"), 500)
                same("素材.正文", material_note.get("content"), db_note.get("content"))
                same("素材.来源词", material_note.get("keyword"), db_note.get("keyword"), 200)
                if normalize_xhs_url(material_note.get("url")) != normalize_xhs_url(db_note.get("url")):
                    mismatches.append("素材.URL")
                if tag_text(material_note.get("tags")) != tag_text(db_note.get("tags")):
                    mismatches.append("素材.话题")
                for payload_name in (
                    "authorUrl", "authorId", "likeCount", "collectCount", "commentCount", "shareCount",
                    "publishedAt", "updatedAt", "ipLocation", "ipRegion", "ipRegionSource", "ipRegionVersion", "imageCount", "timeObservedAt",
                ):
                    if payload_name in note_payload:
                        same(f"素材.{payload_name}", material_note.get(payload_name), note_payload.get(payload_name), 4000)
                for key in ("publishedTime", "updatedTime"):
                    if key in note_payload and material_note.get(key) != note_payload.get(key):
                        mismatches.append(f"素材.{key}")
                same("素材.AI情绪", material_note.get("postSentiment"), expected_sentiment, 80)
                same("素材.访问状态", material_note.get("accessStatus"), db_note.get("access_status"), 40)
                material_semantic = (
                    nonnegative_int(material_note.get("semanticAnalysisCount")),
                    text(material_note.get("analysisIsNegative"), 40),
                    text(material_note.get("negativeType"), 1000),
                    text(material_note.get("negativeSubtype"), 2000),
                )
                if material_semantic != db_note_semantic:
                    mismatches.append("素材.语义字段")
                body_path = Path(media_dir) / "帖子正文.txt"
                if not body_path.is_file():
                    mismatches.append("素材.正文快照缺失")
                else:
                    expected_body = "\n".join((
                        text(db_note.get("title"), 1000), "", text(db_note.get("content"), 20000), "",
                        f"来源链接：{text(db_note.get('url'), 2000)}",
                    ))
                    same("素材.正文快照", body_path.read_text(encoding="utf-8-sig"), expected_body, 25000)
            if not comments_path.is_file():
                mismatches.append("素材.comments.json缺失")
            if comments_path.is_file():
                loaded_comments = json.loads(comments_path.read_text(encoding="utf-8-sig"))
                material_comments = loaded_comments if isinstance(loaded_comments, list) else []
                material_by_id = {
                    text(row.get("commentId"), 256): row for row in material_comments
                    if isinstance(row, dict) and text(row.get("commentId"), 256)
                }
                for comment_id in sorted(set(material_by_id).intersection(db_by_id)):
                    material_row, db_row = material_by_id[comment_id], db_by_id[comment_id]
                    prefix = f"素材评论[{comment_id}]"
                    same(f"{prefix}.正文", material_row.get("content"), db_row.get("content"), 8000)
                    same(f"{prefix}.作者", material_row.get("author"), db_row.get("author"), 500)
                    same(f"{prefix}.作者主页", material_row.get("authorUrl"), db_row.get("author_url"), 2000)
                    same(f"{prefix}.时间", material_row.get("publishedAt"), db_row.get("published_at"), 100)
                    stored_time_payload = json.loads(db_row.get("payload_json") or "{}")
                    for location_key in ("ipRegion", "ipRegionSource", "ipRegionVersion"):
                        if location_key in stored_time_payload and material_row.get(location_key) != stored_time_payload.get(location_key):
                            mismatches.append(f"{prefix}.{location_key}")
                    if isinstance(stored_time_payload.get("publishedTime"), dict):
                        if material_row.get("publishedTime") != stored_time_payload.get("publishedTime"):
                            mismatches.append(f"{prefix}.标准时间")
                    same(f"{prefix}.父评论", material_row.get("parentCommentId"), db_row.get("parent_comment_id"), 256)
                    if nonnegative_int(material_row.get("likeCount")) != int(db_row.get("like_count") or 0):
                        mismatches.append(f"{prefix}.点赞量")
                    if int(material_row.get("commentLevel") or 1) != int(db_row.get("comment_level") or 1):
                        mismatches.append(f"{prefix}.评论层级")
                    expected_comment_type = "子评论" if int(db_row.get("comment_level") or 1) >= 2 else "主评论"
                    same(f"{prefix}.评论类型", material_row.get("commentType"), expected_comment_type, 20)
                    expected_material_sentiment = persisted_sentiment_label(db_row.get("sentiment"))
                    same(f"{prefix}.AI情绪", material_row.get("sentiment"), expected_material_sentiment, 80)
                    material_comment_semantic = (
                        nonnegative_int(material_row.get("semanticAnalysisCount")),
                        text(material_row.get("analysisIsNegative"), 40),
                        text(material_row.get("negativeType"), 1000),
                        text(material_row.get("negativeSubtype"), 2000),
                    )
                    db_comment_semantic = (
                        int(db_row.get("semantic_analysis_count") or 0),
                        text(db_row.get("analysis_is_negative"), 40),
                        text(db_row.get("negative_type"), 1000),
                        text(db_row.get("negative_subtype"), 2000),
                    )
                    if material_comment_semantic != db_comment_semantic:
                        mismatches.append(f"{prefix}.语义字段")
        if mismatches:
            sample = "、".join(mismatches[:6])
            raise ValueError(f"本地字段一致性校验失败：{len(mismatches)} 项（{sample}）")
        canonical = {
            "noteId": note_id,
            "postStatus": post_status_label(db_note.get("post_status"), db_note.get("is_deleted")),
            "note": {
                **{key: db_note.get(key) for key in (
                    "url", "title", "author", "content", "keyword", "tags", "post_sentiment",
                    "access_status", "semantic_analysis_count", "analysis_is_negative",
                    "negative_type", "negative_subtype", "post_status", "is_deleted",
                )},
                "source": browser_note_payload(note_payload),
            },
            "comments": [{key: row.get(key) for key in (
                "comment_id", "note_id", "parent_comment_id", "content", "author", "author_url",
                "published_at", "like_count", "comment_level", "sentiment", "semantic_analysis_count",
                "analysis_is_negative", "negative_type", "negative_subtype", "comment_status", "is_deleted",
            )} for row in sorted(db_comments, key=lambda item: text(item.get("comment_id"), 256))],
        }
        def digest(value: Any) -> str:
            return hashlib.sha256(
                json.dumps(value, ensure_ascii=False, sort_keys=True, default=str).encode("utf-8")
            ).hexdigest()

        store_hashes = {
            "sqlite": digest(canonical),
            "notesCsv": digest(csv_note),
            "commentsCsv": digest(sorted(
                csv_comments, key=lambda row: text(row.get("笔记评论ID"), 256)
            )),
            "materialNote": digest(material_note) if material_note is not None else "",
            "materialComments": digest(sorted(
                material_comments or [], key=lambda row: text(row.get("commentId"), 256)
            )) if material_comments is not None else "",
        }
        state_hash = digest(store_hashes)
        return {
            "fieldChecks": 32 + len(db_comments) * 20,
            "stateHash": state_hash, "storeHashes": store_hashes,
        }

    def _batch_csv_verification_context(self):
        """Internal-only scope, entered after every batch write/material refresh."""
        if __package__:
            from .csv_verification_context import verification_batch
        else:
            from csv_verification_context import verification_batch
        return verification_batch(
            self, self._csv_paths(), (NOTE_CSV_HEADERS, COMMENT_CSV_HEADERS),
            lambda row: valid_note_id(row.get("笔记ID")), csv_comment_note_id,
            lambda row: text(row.get("笔记评论ID"), 256),
        )

    def _verify_note_store_consistency(
        self, note_id: str, media_dir: str = "", verify_fields: bool = True
    ) -> dict[str, Any]:
        if __package__:
            from .csv_verification_context import active_for
        else:
            from csv_verification_context import active_for
        notes_path, comments_path = self._csv_paths()
        csv_context = active_for(self, (notes_path, comments_path))
        if csv_context is None:
            _note_headers, note_rows = self._read_csv_table(notes_path, NOTE_CSV_HEADERS)
            _comment_headers, comment_rows = self._read_csv_table(comments_path, COMMENT_CSV_HEADERS)
            matching_note_rows = [row for row in note_rows if valid_note_id(row.get("笔记ID")) == note_id]
            target_comment_rows = [row for row in comment_rows if csv_comment_note_id(row) == note_id]
        else:
            matching_note_rows = [dict(row) for row in csv_context.notes.get(note_id, ())]
            target_comment_rows = [dict(row) for row in csv_context.comments.get(note_id, ())]
        note_matches = len(matching_note_rows)
        csv_post_status = post_status_label(matching_note_rows[0].get("帖子状态")) if note_matches == 1 else ""
        csv_access_status = {
            "可打开": "ok", "待复核": "check_failed", "打不开": "unreachable", "": ""
        }.get(text(matching_note_rows[0].get("访问状态"), 100), "__invalid__") if note_matches == 1 else ""
        target_comment_ids = [
            text(row.get("笔记评论ID"), 256) for row in target_comment_rows
            if text(row.get("笔记评论ID"), 256)
        ]
        if len(target_comment_ids) != len(target_comment_rows):
            raise ValueError("本地一致性校验失败：评论 CSV 存在空评论 ID 行")
        if len(target_comment_ids) != len(set(target_comment_ids)):
            raise ValueError("本地一致性校验失败：评论 CSV 存在重复评论 ID 行")
        csv_status = {
            text(row.get("笔记评论ID"), 256): comment_status_label(row.get("评论状态"))
            for row in target_comment_rows if text(row.get("笔记评论ID"), 256)
        }
        csv_ids = set(csv_status)
        with self.lock, self._session() as db:
            db_comment_rows = [dict(row) for row in db.execute(
                "SELECT * FROM comments WHERE note_id=?", (note_id,)
            ).fetchall()]
            db_status = {
                text(row.get("comment_id"), 256): comment_status_label(
                    row.get("comment_status"), row.get("is_deleted")
                ) for row in db_comment_rows
            }
            db_note_row = db.execute("SELECT * FROM notes WHERE note_id=?", (note_id,)).fetchone()
            db_note = dict(db_note_row) if db_note_row else {}
            db_post_status = post_status_label(
                db_note.get("post_status"), db_note.get("is_deleted")
            ) if db_note else ""
        db_ids = set(db_status)
        if note_matches != 1:
            raise ValueError(f"本地一致性校验失败：笔记 CSV 中该帖子有 {note_matches} 行")
        if csv_post_status != db_post_status:
            raise ValueError("本地一致性校验失败：笔记 CSV 与 SQLite 的存在/已删除状态不一致")
        if csv_access_status != text(db_note.get("access_status"), 40):
            raise ValueError("本地一致性校验失败：笔记 CSV 与 SQLite 的访问状态不一致")
        if csv_ids != db_ids:
            raise ValueError(
                f"本地一致性校验失败：评论 CSV={len(csv_ids)}，SQLite={len(db_ids)}，ID 集合不一致"
            )
        if csv_status != db_status:
            raise ValueError("本地一致性校验失败：评论 CSV 与 SQLite 的存在/已删除状态不一致")
        cross_note_ids = ({
            text(row.get("笔记评论ID"), 256) for row in comment_rows
            if text(row.get("笔记评论ID"), 256) in db_ids and csv_comment_note_id(row) != note_id
        } if csv_context is None else {
            comment_id for comment_id in db_ids
            if csv_context.owners.get(comment_id, frozenset()) - {note_id}
        })
        if cross_note_ids:
            raise ValueError("本地一致性校验失败：评论 ID 同时出现在其他帖子")
        material_ids: set[str] | None = None
        if media_dir and not Path(media_dir).is_dir():
            raise ValueError("本地一致性校验失败：SQLite 素材目录不存在")
        if media_dir and Path(media_dir).is_dir():
            note_snapshot_path = Path(media_dir) / "note.json"
            if not note_snapshot_path.is_file():
                raise ValueError("本地一致性校验失败：素材目录缺少 note.json")
            note_snapshot = json.loads(note_snapshot_path.read_text(encoding="utf-8-sig"))
            material_post_status = post_status_label(
                note_snapshot.get("postStatus") if isinstance(note_snapshot, dict) else "",
                note_snapshot.get("isDeleted") if isinstance(note_snapshot, dict) else None,
            )
            if material_post_status != db_post_status:
                raise ValueError("本地一致性校验失败：素材快照与 SQLite 的帖子状态不一致")
            if text(note_snapshot.get("accessStatus"), 40) != text(db_note.get("access_status"), 40):
                raise ValueError("本地一致性校验失败：素材快照与 SQLite 的访问状态不一致")
            material_path = Path(media_dir) / "comments.json"
            if not material_path.is_file():
                raise ValueError("本地一致性校验失败：素材目录缺少 comments.json")
            loaded = json.loads(material_path.read_text(encoding="utf-8-sig"))
            if not isinstance(loaded, list):
                raise ValueError("本地一致性校验失败：comments.json 不是数组")
            material_id_rows = [
                text(item.get("commentId"), 256) for item in loaded
                if isinstance(item, dict) and text(item.get("commentId"), 256)
            ]
            if len(material_id_rows) != len(set(material_id_rows)):
                raise ValueError("本地一致性校验失败：comments.json 存在重复评论 ID")
            material_status = {
                text(item.get("commentId"), 256): comment_status_label(
                    item.get("commentStatus"), item.get("isDeleted")
                )
                for item in loaded if isinstance(item, dict) and text(item.get("commentId"), 256)
            }
            material_ids = set(material_status)
            if material_ids != db_ids:
                raise ValueError(
                    f"本地一致性校验失败：素材评论={len(material_ids)}，SQLite={len(db_ids)}，ID 集合不一致"
                )
            if material_status != db_status:
                raise ValueError("本地一致性校验失败：素材快照与 SQLite 的评论状态不一致")
        field_result = self._verify_note_field_consistency(
            note_id, matching_note_rows[0],
            target_comment_rows, db_note, db_comment_rows, media_dir,
        ) if verify_fields else {"fieldChecks": 0, "stateHash": "", "storeHashes": {}}
        deleted_count = sum(status == COMMENT_STATUS_DELETED for status in db_status.values())
        return {
            "ok": True, "noteId": note_id, "noteRows": note_matches,
            "postStatus": db_post_status,
            "commentIds": len(db_ids), "activeComments": len(db_ids) - deleted_count,
            "deletedComments": deleted_count,
            "materialIds": len(material_ids) if material_ids is not None else None,
            **field_result,
        }

    def _legacy_sync_pull_to_xlsx(
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
            self._ensure_excel_header(comment_sheet, "评论状态")
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
                    "评论状态": COMMENT_STATUS_PRESENT,
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

    def _sync_pull_to_xlsx(
        self,
        note: dict[str, Any],
        comments: list[dict[str, Any]],
        media_result: dict[str, Any] | None = None,
        replace_comments: bool = False,
    ) -> dict[str, Any]:
        """Idempotently update the two UTF-8 CSV master tables."""
        notes_path, comments_path = self._csv_paths()
        self._ensure_seed_workbook(notes_path)
        media_result = media_result or {}
        media_folder = text(media_result.get("folder"), 4000)
        media_file_names = [
            text(item, 300) for item in (media_result.get("files") or []) if text(item, 300)
        ]
        try:
            if media_folder and Path(media_folder).is_dir():
                media_file_names.extend(path.name for path in Path(media_folder).iterdir() if path.is_file())
        except OSError:
            pass
        if media_folder:
            media_file_names.extend(("note.json", "comments.json", "帖子正文.txt"))
        media_files = "\n".join(sorted(dict.fromkeys(media_file_names)))
        note_id = valid_note_id(note.get("noteId"))
        if not note_id:
            raise ValueError("noteId is required")
        comments = self._enrich_comment_time_fields(note_id, comments)
        note_headers, note_rows = self._read_csv_table(notes_path, NOTE_CSV_HEADERS)
        comment_headers, comment_rows = self._read_csv_table(comments_path, COMMENT_CSV_HEADERS)
        existing_comment_ids = [
            text(row.get("笔记评论ID"), 256) for row in comment_rows
            if text(row.get("笔记评论ID"), 256)
        ]
        duplicate_existing_ids = [
            comment_id for comment_id, count in Counter(existing_comment_ids).items() if count > 1
        ]
        if duplicate_existing_ids:
            raise ValueError(
                f"评论 CSV 已存在重复评论 ID，已停止同步：{'、'.join(duplicate_existing_ids[:8])}"
            )
        incoming_comment_ids = {
            text(item.get("commentId"), 256) for item in comments
            if isinstance(item, dict) and text(item.get("commentId"), 256)
        }
        cross_note_ids = {
            text(row.get("笔记评论ID"), 256) for row in comment_rows
            if text(row.get("笔记评论ID"), 256) in incoming_comment_ids
            and csv_comment_note_id(row) not in {"", note_id}
        }
        if cross_note_ids:
            raise ValueError(
                f"评论 ID 已属于其他帖子，已停止串帖写入：{'、'.join(sorted(cross_note_ids)[:8])}"
            )

        existing_index = next((index for index, row in enumerate(note_rows)
                               if valid_note_id(row.get("笔记ID")) == note_id), None)
        matched_by = "note_id" if existing_index is not None else "new"
        is_new_note = existing_index is None
        if is_new_note:
            note_row_data: dict[str, Any] = {name: "" for name in note_headers}
            note_rows.append(note_row_data)
            existing_index = len(note_rows) - 1
        else:
            note_row_data = note_rows[existing_index]

        def set_note_value(name: str, value: Any) -> None:
            if name not in note_headers:
                note_headers.append(name)
                for row in note_rows:
                    row.setdefault(name, "")
            if value not in (None, "") or is_new_note:
                note_row_data[name] = "" if value is None else value

        note_url = preferred_url(note_row_data.get("笔记url"), note.get("url"))
        stored_url_id = note_url_identity(note_url)
        if stored_url_id and stored_url_id != note_id:
            note_url = normalize_xhs_url(f"https://www.xiaohongshu.com/explore/{note_id}")
        note_tags = tag_text(note.get("tags")) if "tags" in note else text(
            note_row_data.get("笔记话题"), 6000
        )
        note["url"] = note_url
        if note_tags:
            note["tags"] = canonical_tag_items(note_tags) or (["无话题"] if note_tags == "无话题" else [])
        note_fields = {
            "笔记url": note_url, "用户主页url": text(note.get("authorUrl"), 2000),
            "用户昵称": text(note.get("author"), 500),
            "笔记标题": canonical_note_title(note.get("title"), note.get("content"), 80),
            "笔记内容": text(note.get("content"), 20000), "笔记话题": note_tags,
            "点赞量": note.get("likeCount", ""), "收藏量": note.get("collectCount", ""),
            "评论量": note.get("commentCount", ""), "分享量": note.get("shareCount", ""),
            "发布时间": text(note.get("publishedAt"), 100), "更新时间": text(note.get("updatedAt"), 100),
            "IP地址": text(note.get("ipLocation"), 100),
            "图片数量": note.get("imageCount") if "imageCount" in note else (
                len(note.get("imageUrls") or []) if "imageUrls" in note else ""
            ),
            "发布日期": text(note.get("publishedAt"), 100)[:10], "来源词": text(note.get("keyword"), 200),
            "笔记ID": note_id, "博主ID": text(note.get("authorId"), 256),
            "对应帖子文件夹地址": media_folder, "文件夹内清单": media_files,
            "AI情绪判断": text(note.get("postSentiment"), 80), "帖子好坏": text(note.get("postSentiment"), 80),
            "访问状态": "可打开",
            "帖子状态": POST_STATUS_PRESENT,
            **csv_time_fields(note),
        }
        for name, value in note_fields.items():
            source_key = NOTE_CSV_SOURCE_FIELDS.get(name)
            supplied_source = source_key is not None and source_key in note
            supplied_date = name == "发布日期" and "publishedAt" in note
            if name in NOTE_TIME_HEADERS or supplied_source or supplied_date:
                # The final merged payload already preserves omitted source
                # keys. Do not retain an old CSV value over an explicit blank.
                note_row_data[name] = value
            else:
                set_note_value(name, value)

        removed_comments = 0
        previously_present_ids: set[str] = set()
        for row in comment_rows:
            if csv_comment_note_id(row) != note_id:
                continue
            row["笔记ID"] = note_id
            row["原笔记url"] = note_url
            if "authorUrl" in note:
                row["帖子用户主页url"] = text(note.get("authorUrl"), 2000)
            if media_folder:
                row["对应帖子文件夹地址"] = media_folder
                row["文件夹内清单"] = media_files
            row["映射状态"] = "已映射"
            row["映射备注"] = ""
            previous_status = comment_status_label(row.get("评论状态"))
            if not text(row.get("评论状态"), 40):
                row["评论状态"] = COMMENT_STATUS_PRESENT
            if replace_comments:
                if previous_status != COMMENT_STATUS_DELETED and text(row.get("笔记评论ID"), 256):
                    previously_present_ids.add(text(row.get("笔记评论ID"), 256))
                row["评论状态"] = COMMENT_STATUS_DELETED

        by_id: dict[str, int] = {}
        by_key: dict[tuple[str, str, str, str, str], int] = {}
        by_loose: dict[tuple[str, str, str, str], int] = {}
        for index, row in enumerate(comment_rows):
            row_id = text(row.get("笔记评论ID"), 256)
            if row_id:
                by_id[row_id] = index
            key = (csv_comment_note_id(row), text(row.get("父评论ID"), 256), text(row.get("用户昵称"), 500),
                   text(row.get("评论内容"), 8000), text(row.get("评论时间"), 100))
            if any(key):
                by_key[key] = index
                by_loose[key[:4]] = index
        inserted_comments = 0
        duplicate_comments = 0
        for item in comments:
            if not isinstance(item, dict) or not text(item.get("content"), 8000):
                continue
            supplied_id = text(item.get("commentId"), 256)
            generated_id = self._excel_comment_id(note_id, item)
            key = (note_url_identity(note_url) or note_id, text(item.get("parentCommentId"), 256), text(item.get("author"), 500),
                   text(item.get("content"), 8000), text(item.get("publishedAt"), 100))
            row_index = by_id.get(generated_id)
            if row_index is None and not supplied_id:
                row_index = by_key.get(key)
            if row_index is None and not supplied_id:
                row_index = by_loose.get(key[:4])
            is_new_comment = row_index is None
            if is_new_comment:
                comment_row: dict[str, Any] = {name: "" for name in comment_headers}
                comment_rows.append(comment_row)
                row_index = len(comment_rows) - 1
                inserted_comments += 1
            else:
                comment_row = comment_rows[row_index]
                duplicate_comments += 1
                if not supplied_id:
                    generated_id = text(comment_row.get("笔记评论ID"), 256) or generated_id
            incoming_parent_id = text(item.get("parentCommentId"), 256)
            effective_parent_id = incoming_parent_id or text(comment_row.get("父评论ID"), 256)
            incoming_level = item.get("commentLevel")
            level = comment_level_value(incoming_level) if incoming_level not in (None, "") else (
                comment_level_value(comment_row.get("评论层级")) if not is_new_comment else 1
            )
            if effective_parent_id:
                level = max(2, level)
            author_url = text(item.get("authorUrl"), 2000) or text(comment_row.get("评论用户主页url"), 2000)
            is_author = (
                "是" if bool_value(item.get("isAuthor")) else "否"
            ) if "isAuthor" in item else (text(comment_row.get("是否帖主评论"), 20) or "否")
            like_count = item.get("likeCount") if "likeCount" in item else (
                comment_row.get("点赞量", 0) if not is_new_comment else 0
            )
            fields = {
                "笔记ID": note_id, "原笔记url": note_url,
                "帖子用户主页url": text(note.get("authorUrl"), 2000),
                "笔记评论ID": generated_id, "用户昵称": text(item.get("author"), 500),
                "评论用户主页url": author_url,
                "评论内容": text(item.get("content"), 8000), "评论时间": text(item.get("publishedAt"), 100),
                "是否帖主评论": is_author,
                "点赞量": like_count, "评论层级": f"{level}级评论",
                "父评论ID": effective_parent_id,
                "对应帖子文件夹地址": media_folder, "文件夹内清单": media_files,
                "AI情绪判断": text(item.get("sentiment"), 80),
                "映射状态": "已映射", "映射备注": "",
                "评论状态": COMMENT_STATUS_PRESENT,
                **csv_time_fields(item, kind="comment"),
            }
            preserve_when_blank = {
                "帖子用户主页url", "评论用户主页url", "评论时间", "父评论ID", "AI情绪判断"
            }
            if "authorUrl" in note:
                preserve_when_blank.discard("帖子用户主页url")
            for name, value in fields.items():
                if name not in comment_headers:
                    comment_headers.append(name)
                    for row in comment_rows:
                        row.setdefault(name, "")
                if not is_new_comment and name in preserve_when_blank and value in (None, ""):
                    continue
                comment_row[name] = "" if value is None else value
            by_id[generated_id] = row_index
            by_key[key] = row_index
            by_loose[key[:4]] = row_index

        if replace_comments:
            removed_comments = sum(
                text(row.get("笔记评论ID"), 256) in previously_present_ids
                and comment_status_label(row.get("评论状态")) == COMMENT_STATUS_DELETED
                for row in comment_rows if csv_comment_note_id(row) == note_id
            )
        self._replace_csv_pair(note_headers, note_rows, comment_headers, comment_rows, "sync")
        return {
            "ok": True, "path": str(notes_path), "commentsPath": str(comments_path),
            "postAdded": int(is_new_note), "commentAdded": inserted_comments,
            "commentRemoved": removed_comments, "commentMarkedDeleted": removed_comments,
            "commentSkipped": duplicate_comments, "deduplicated": (not is_new_note) or duplicate_comments > 0,
            "matchedBy": matched_by, "noteRow": int(existing_index) + 2,
        }

    def _legacy_create_seed_workbook(self, xlsx_path: Path) -> None:
        """Retained only for tests/tools that explicitly request a legacy workbook."""
        if xlsx_path.exists():
            return
        from openpyxl import Workbook

        note_headers = [
            "笔记url", "用户主页url", "用户昵称", "笔记标题", "笔记内容", "笔记话题",
            "点赞量", "收藏量", "评论量", "分享量", "发布时间", "更新时间", "IP地址",
            "图片数量", "发布日期", "来源词", "笔记ID", "博主ID",
            "对应帖子文件夹地址", "文件夹内清单", "AI情绪判断", "帖子好坏",
            "访问状态", "语义分析次数", "分析结论是否差评", "差评类型", "差评子类型", "帖子状态",
        ]
        comment_headers = [
            "笔记ID", "原笔记url", "帖子用户主页url", "笔记评论ID", "用户昵称", "评论内容",
            "评论时间", "是否帖主评论", "点赞量", "评论层级", "父评论ID",
            "对应帖子文件夹地址", "文件夹内清单", "AI情绪判断", "映射状态", "映射备注",
            "语义分析次数", "分析结论是否差评", "差评类型", "差评子类型", "评论状态",
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

    def _legacy_set_note_access_statuses(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Legacy XLSX implementation retained for migration reference only."""
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

    def set_note_access_statuses(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Persist access/presence atomically and verify every retained business row."""
        note_ids = list(dict.fromkeys(
            valid_note_id(item.get("noteId")) for item in (payload.get("items") or []) if isinstance(item, dict)
        ))
        note_ids = [note_id for note_id in note_ids if note_id]
        if not note_ids:
            raise ValueError("items must contain at least one noteId")
        with self.pull_lock:
            checkpoints: list[dict[str, Any]] = []
            mutation_started = False
            try:
                for index, note_id in enumerate(note_ids):
                    checkpoints.append(self._capture_sync_checkpoint(
                        note_id, capture_csv=index == 0
                    ))
                mutation_started = True
                result = self._set_note_access_statuses_unchecked(payload)
                result_items = result.get("items", [])
                result_ids = [valid_note_id(item.get("noteId")) for item in result_items]
                if len(result_items) != len(note_ids) or set(result_ids) != set(note_ids):
                    raise ValueError("批量状态同步结果与请求帖子集合不一致")
                invalid_rows = [
                    item["noteId"] for item in result_items if int(item.get("excelRows") or 0) != 1
                ]
                if invalid_rows:
                    raise ValueError(
                        f"批量状态同步要求每个帖子在笔记 CSV 中恰有一行：{'、'.join(invalid_rows[:8])}"
                    )
                verified: list[dict[str, Any]] = []
                for item in result_items:
                    self._refresh_material_snapshot_for_note(item["noteId"])
                with self.lock, self._session() as db:
                    placeholders = ",".join("?" for _ in note_ids)
                    media_by_id = {
                        str(row["note_id"]): text(row["media_dir"], 4000)
                        for row in db.execute(
                            f"SELECT note_id,media_dir FROM notes WHERE note_id IN ({placeholders})", note_ids
                        ).fetchall()
                    }
                with self._batch_csv_verification_context():
                    for item in result_items:
                        verified.append(self._verify_note_store_consistency(
                            item["noteId"], media_by_id.get(item["noteId"], ""), verify_fields=True
                        ))
                    if len(verified) != len(note_ids):
                        raise ValueError("批量状态同步未完成全部帖子的一致性校验")
                output = {**result, "consistencyVerified": True, "verified": verified}
            except Exception as exc:
                if not mutation_started:
                    for checkpoint in reversed(checkpoints):
                        self._discard_sync_checkpoint(checkpoint)
                    raise
                rollback_errors = self._rollback_sync_checkpoints(checkpoints)
                if rollback_errors:
                    raise RuntimeError(
                        f"批量状态同步失败且回滚未完全成功：{'；'.join(rollback_errors)}"
                    ) from exc
                raise
            for checkpoint in reversed(checkpoints):
                self._discard_sync_checkpoint(checkpoint)
            return output

    def _set_note_access_statuses_unchecked(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Update access, post presence and dependent comment presence in one retained-row transaction."""
        raw_items = payload.get("items") if isinstance(payload.get("items"), list) else []
        labels = {"ok": "可打开", "check_failed": "待复核", "unreachable": "打不开", "": ""}
        workflows = {"", "new", "known", "confirmed", "ignored"}
        deduplicated: dict[str, dict[str, Any]] = {}
        for raw in raw_items:
            if isinstance(raw, dict):
                note_id = valid_note_id(raw.get("noteId"))
                if note_id:
                    deduplicated[note_id] = raw
        if not deduplicated:
            raise ValueError("items must contain at least one noteId")

        normalized: list[dict[str, Any]] = []
        for note_id, raw in deduplicated.items():
            requested = text(raw.get("status"), 40).strip().lower()
            if requested == "suspected":
                requested = "check_failed"
            if requested not in labels:
                raise ValueError("status must be ok, check_failed, unreachable or empty")
            forced_post_status = text(raw.get("forcePostStatus"), 40)
            if forced_post_status and forced_post_status not in {POST_STATUS_PRESENT, POST_STATUS_DELETED}:
                raise ValueError("forcePostStatus must be 存在 or 已删除")
            workflow_status = text(raw.get("workflowStatus"), 40).strip().lower()
            if workflow_status not in workflows:
                raise ValueError("workflowStatus is invalid")
            preserve_access = bool_value(raw.get("preserveAccess"))
            cascade_comments = (
                bool_value(raw.get("cascadeComments"))
                or requested == "unreachable"
                or forced_post_status == POST_STATUS_DELETED
            )
            restore_ignored = bool_value(raw.get("restoreIgnoredComments"))
            deletion_reason = text(raw.get("commentDeletionReason"), 80) or (
                "parent_ignored" if workflow_status == "ignored" else "parent_deleted"
            )
            normalized.append({
                "noteId": note_id, "status": requested, "excelStatus": labels[requested],
                "error": "" if requested == "ok" else text(raw.get("error"), 1000),
                "result": text(raw.get("result"), 80) or {
                    "ok": "opened", "check_failed": "inconclusive", "unreachable": "confirmed_v2", "": ""
                }[requested],
                "checkedAt": text(raw.get("checkedAt"), 80) or now_iso(),
                "preserveAccess": preserve_access, "forcePostStatus": forced_post_status,
                "workflowStatus": workflow_status, "cascadeComments": cascade_comments,
                "restoreIgnoredComments": restore_ignored, "commentDeletionReason": deletion_reason,
            })

        notes_path, comments_path = self._csv_paths()
        note_headers, note_rows = self._read_csv_table(notes_path, NOTE_CSV_HEADERS)
        comment_headers, comment_rows = self._read_csv_table(comments_path, COMMENT_CSV_HEADERS)
        for required, default in (("访问状态", ""), ("帖子状态", POST_STATUS_PRESENT)):
            if required not in note_headers:
                note_headers.append(required)
                for row in note_rows:
                    row[required] = default
        if "评论状态" not in comment_headers:
            comment_headers.append("评论状态")
            for row in comment_rows:
                row["评论状态"] = COMMENT_STATUS_PRESENT
        rows_by_id: dict[str, list[dict[str, Any]]] = {}
        for row in note_rows:
            row_id = valid_note_id(row.get("笔记ID"))
            if row_id:
                rows_by_id.setdefault(row_id, []).append(row)

        with self.lock, self._session() as db:
            for item in normalized:
                stored = db.execute(
                    """SELECT title,status,source,pull_status,access_status,access_error,
                              last_access_checked_at,access_check_result,post_status,is_deleted,
                              deleted_at,media_dir FROM notes WHERE note_id=?""",
                    (item["noteId"],),
                ).fetchone()
                if not stored:
                    raise ValueError(f"本地数据库中未找到帖子：{item['noteId']}")
                item["previousStatus"] = text(stored["access_status"], 40)
                item["previousWorkflowStatus"] = text(stored["status"], 40)
                item["previousPostStatus"] = post_status_label(stored["post_status"], stored["is_deleted"])
                previous_result = text(stored["access_check_result"], 80)
                previous_is_conclusive = (
                    item["previousStatus"] == "ok"
                    or (
                        item["previousStatus"] == "unreachable"
                        and previous_result in {"confirmed_v2", "manual_confirmed_deleted"}
                    )
                )
                if item["status"] == "check_failed" and previous_is_conclusive and not item["preserveAccess"]:
                    # A timeout, login gate or DOM extraction failure is an
                    # inconclusive attempt, not evidence that a previously
                    # verified page changed reachability. Preserve the durable
                    # verdict while returning diagnostics for this attempt.
                    item["attemptedStatus"] = item["status"]
                    item["attemptedResult"] = item["result"]
                    item["attemptedError"] = item["error"]
                    item["inconclusivePreserved"] = True
                    item["preserveAccess"] = True
                if item["preserveAccess"]:
                    item["status"] = item["previousStatus"] if item["previousStatus"] in labels else ""
                    item["excelStatus"] = labels[item["status"]]
                    item["error"] = text(stored["access_error"], 1000)
                    item["result"] = previous_result
                    item["checkedAt"] = text(stored["last_access_checked_at"], 80) or item["checkedAt"]
                item["postStatus"] = item["forcePostStatus"] or (
                    POST_STATUS_DELETED if item["status"] == "unreachable"
                    else POST_STATUS_PRESENT if item["status"] == "ok"
                    else item["previousPostStatus"]
                )
                item["isDeleted"] = item["postStatus"] == POST_STATUS_DELETED
                item["deletedAt"] = (
                    text(stored["deleted_at"], 80) or item["checkedAt"]
                ) if item["isDeleted"] else ""
                item["mediaDir"] = text(stored["media_dir"], 4000)
                item["title"] = text(stored["title"], 1000)
                item["workflowStatus"] = item["workflowStatus"] or item["previousWorkflowStatus"]
                item["commentMutations"] = []
                for comment in db.execute(
                    """SELECT comment_id,payload_json,comment_status,is_deleted,deleted_at
                       FROM comments WHERE note_id=?""", (item["noteId"],)
                ).fetchall():
                    try:
                        comment_payload = json.loads(comment["payload_json"] or "{}")
                        if not isinstance(comment_payload, dict):
                            comment_payload = {}
                    except (TypeError, ValueError):
                        comment_payload = {}
                    comment_id = text(comment["comment_id"], 256)
                    if item["cascadeComments"] and not bool(comment["is_deleted"]):
                        comment_payload.update({
                            "commentId": comment_id, "noteId": item["noteId"],
                            "commentStatus": COMMENT_STATUS_DELETED, "isDeleted": True,
                            "deletedAt": text(comment["deleted_at"], 80) or item["checkedAt"],
                            "lastPresenceCheckedAt": item["checkedAt"],
                            "presenceReason": item["commentDeletionReason"],
                            "presenceReasonAt": item["checkedAt"],
                        })
                        item["commentMutations"].append({
                            "commentId": comment_id, "status": COMMENT_STATUS_DELETED,
                            "isDeleted": True, "deletedAt": text(comment["deleted_at"], 80) or item["checkedAt"],
                            "payload": comment_payload,
                        })
                    elif (
                        item["restoreIgnoredComments"]
                        and bool(comment["is_deleted"])
                        and text(comment_payload.get("presenceReason"), 80) == "parent_ignored"
                    ):
                        comment_payload.update({
                            "commentId": comment_id, "noteId": item["noteId"],
                            "commentStatus": COMMENT_STATUS_PRESENT, "isDeleted": False,
                            "deletedAt": "", "lastPresenceCheckedAt": item["checkedAt"],
                        })
                        comment_payload.pop("presenceReason", None)
                        comment_payload.pop("presenceReasonAt", None)
                        item["commentMutations"].append({
                            "commentId": comment_id, "status": COMMENT_STATUS_PRESENT,
                            "isDeleted": False, "deletedAt": "", "payload": comment_payload,
                        })

                matched = rows_by_id.get(item["noteId"], [])
                for row in matched:
                    row["访问状态"] = item["excelStatus"]
                    row["帖子状态"] = item["postStatus"]
                item["excelRows"] = len(matched)
                mutation_by_id = {entry["commentId"]: entry for entry in item["commentMutations"]}
                item["commentsMarkedDeleted"] = sum(entry["isDeleted"] for entry in item["commentMutations"])
                item["commentsRestored"] = sum(not entry["isDeleted"] for entry in item["commentMutations"])
                for row in comment_rows:
                    if csv_comment_note_id(row) != item["noteId"]:
                        continue
                    mutation = mutation_by_id.get(text(row.get("笔记评论ID"), 256))
                    if mutation:
                        row["评论状态"] = mutation["status"]
                    elif item["cascadeComments"]:
                        row["评论状态"] = COMMENT_STATUS_DELETED

        self._replace_csv_pair(note_headers, note_rows, comment_headers, comment_rows, "access-presence")
        with self.lock, self._session() as db:
            for item in normalized:
                presence_changed = item["previousPostStatus"] != item["postStatus"]
                presence_confirmed = presence_changed or item["status"] in {"ok", "unreachable"}
                db.execute(
                    """UPDATE notes SET
                       access_status=CASE WHEN ? THEN access_status ELSE ? END,
                       access_error=CASE WHEN ? THEN access_error ELSE ? END,
                       last_access_checked_at=CASE WHEN ? THEN last_access_checked_at ELSE ? END,
                       access_check_result=CASE WHEN ? THEN access_check_result ELSE ? END,
                       status=?,last_seen_at=?,post_status=?,is_deleted=?,
                       deleted_at=CASE WHEN ?=1 AND deleted_at='' THEN ? WHEN ?=0 THEN '' ELSE deleted_at END,
                       last_presence_checked_at=CASE WHEN ? THEN ? ELSE last_presence_checked_at END
                       WHERE note_id=?""",
                    (int(item["preserveAccess"]), item["status"], int(item["preserveAccess"]), item["error"],
                     int(item["preserveAccess"]), item["checkedAt"], int(item["preserveAccess"]), item["result"],
                     item["workflowStatus"], item["checkedAt"], item["postStatus"], int(item["isDeleted"]),
                     int(item["isDeleted"]), item["checkedAt"], int(item["isDeleted"]),
                     int(presence_confirmed), item["checkedAt"], item["noteId"]),
                )
                for mutation in item["commentMutations"]:
                    db.execute(
                        """UPDATE comments SET comment_status=?,is_deleted=?,deleted_at=?,
                           last_presence_checked_at=?,payload_json=? WHERE note_id=? AND comment_id=?""",
                        (mutation["status"], int(mutation["isDeleted"]), mutation["deletedAt"],
                         item["checkedAt"], json.dumps(mutation["payload"], ensure_ascii=False),
                         item["noteId"], mutation["commentId"]),
                    )
                active_count = int(db.execute(
                    "SELECT COUNT(*) FROM comments WHERE note_id=? AND is_deleted=0", (item["noteId"],)
                ).fetchone()[0])
                negative_count = int(db.execute(
                    """SELECT COUNT(*) FROM comments WHERE note_id=? AND is_deleted=0
                       AND is_negative=1 AND ai_confidence>=0.85""", (item["noteId"],)
                ).fetchone()[0])
                db.execute(
                    "UPDATE notes SET comment_count_collected=?,negative_comment_count=? WHERE note_id=?",
                    (active_count, negative_count, item["noteId"]),
                )
                previous, current = item.get("previousStatus") or "", item["status"]
                previous_post, current_post = item["previousPostStatus"], item["postStatus"]
                previous_workflow, current_workflow = item["previousWorkflowStatus"], item["workflowStatus"]
                if (
                    previous != current
                    or previous_post != current_post
                    or previous_workflow != current_workflow
                    or item["commentMutations"]
                ):
                    human = {"": "未核验", "ok": "可打开", "check_failed": "待复核", "unreachable": "打不开"}
                    summary = f"访问状态：{human.get(previous, previous)} → {human.get(current, current)}"
                    if previous_post != current_post:
                        summary += f"；帖子状态：{previous_post} → {current_post}（本地记录保留）"
                    if item["commentsMarkedDeleted"]:
                        summary += f"；关联评论标记已删除 {item['commentsMarkedDeleted']} 条"
                    if item["commentsRestored"]:
                        summary += f"；恢复忽略关联评论 {item['commentsRestored']} 条"
                    db.execute(
                        """INSERT INTO change_events
                           (run_id,note_id,event_type,title,summary,before_json,after_json,created_at)
                           VALUES (?,?,?,?,?,?,?,?)""",
                        (max(0, int(payload.get("runId") or 0)), item["noteId"], "presence_status_changed",
                         item.get("title") or "", summary,
                         json.dumps({"status": previous, "postStatus": previous_post,
                                     "workflowStatus": previous_workflow}, ensure_ascii=False),
                         json.dumps({"status": current, "postStatus": current_post,
                                     "workflowStatus": current_workflow, "error": item["error"],
                                     "commentsMarkedDeleted": item["commentsMarkedDeleted"],
                                     "commentsRestored": item["commentsRestored"]}, ensure_ascii=False),
                         item["checkedAt"]),
                    )

        by_status = dict(Counter(item["status"] for item in normalized))
        for item in normalized:
            item.pop("commentMutations", None)
        return {
            "ok": True, "updated": len(normalized),
            "excelRows": sum(item["excelRows"] for item in normalized),
            "markedDeleted": sum(bool(item["isDeleted"]) for item in normalized),
            "commentsMarkedDeleted": sum(int(item["commentsMarkedDeleted"]) for item in normalized),
            "commentsRestored": sum(int(item["commentsRestored"]) for item in normalized),
            "byStatus": by_status, "items": normalized, "path": str(notes_path),
        }

    def set_note_access_status(self, payload: dict[str, Any]) -> dict[str, Any]:
        result = self.set_note_access_statuses({"items": [payload], "runId": payload.get("runId")})
        item = result["items"][0]
        return {"ok": True, "noteId": item["noteId"], "accessStatus": item["status"],
                "excelStatus": item["excelStatus"], "excelRows": item["excelRows"],
                "postStatus": item["postStatus"], "isDeleted": item["isDeleted"],
                "commentsMarkedDeleted": int(item.get("commentsMarkedDeleted") or 0),
                "commentsRestored": int(item.get("commentsRestored") or 0),
                "checkedAt": item["checkedAt"],
                "consistencyVerified": result.get("consistencyVerified") is True,
                "verified": result.get("verified", [])}

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
                """SELECT note_id,title,url,access_error,last_access_checked_at,
                          post_status,is_deleted,deleted_at,last_presence_checked_at
                   FROM notes WHERE access_status='unreachable' AND status<>'ignored'
                   ORDER BY last_access_checked_at DESC, first_seen_at DESC"""
            ).fetchall()
        return [dict(row) for row in rows]

    def delete_unreachable_notes(self, _payload: dict[str, Any] | None = None) -> dict[str, Any]:
        """Legacy endpoint: retain unreachable posts and mark them deleted instead of purging rows."""
        targets = self.list_unreachable_notes()
        if not targets:
            return {"ok": True, "targetCount": 0, "markedDeletedCount": 0, "deletedCount": 0,
                    "failedCount": 0, "marked": [], "deleted": [], "failures": [],
                    "excelVerified": True, "databaseVerified": True,
                    "consistencyVerified": True, "verified": []}
        result = self.set_note_access_statuses({"items": [
            {"noteId": item["note_id"], "status": "unreachable", "result": "confirmed_v2",
             "error": item.get("access_error") or "双重证据确认帖子已删除或下架"}
            for item in targets
        ]})
        marked = [{"noteId": item["noteId"], "title": item.get("title") or "",
                   "postStatus": item["postStatus"], "isDeleted": item["isDeleted"]}
                  for item in result.get("items", [])]
        return {
            "ok": True, "targetCount": len(targets), "markedDeletedCount": len(marked),
            # Keep the legacy counter populated so an older loaded extension
            # treats this non-destructive operation as successful.
            "deletedCount": len(marked), "failedCount": 0,
            "deletedCommentRows": 0, "deletedDatabaseComments": 0,
            "deletedLinkedDatabaseRecords": 0,
            "excelVerified": True, "databaseVerified": True,
            "marked": marked, "deleted": marked, "failures": [],
            "nonDestructive": True,
            "consistencyVerified": result.get("consistencyVerified") is True,
            "verified": result.get("verified", []),
        }

    def _legacy_delete_pulled_note(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Legacy XLSX deletion implementation retained for reference."""
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

    def delete_pulled_note(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Atomically remove one note from both CSV files, SQLite and managed media."""
        note_id = valid_note_id(payload.get("noteId"))
        if not note_id:
            raise ValueError("noteId is required")
        notes_path, comments_path = self._csv_paths()
        self._ensure_seed_workbook(notes_path)
        with self.pull_lock:
            with self.lock, self._session() as db:
                note_row = db.execute("SELECT note_id,media_dir FROM notes WHERE note_id=?", (note_id,)).fetchone()
                comment_ids = [str(row[0]) for row in db.execute(
                    "SELECT comment_id FROM comments WHERE note_id=?", (note_id,)
                ).fetchall()]
            if note_row is None:
                raise ValueError("本地数据库中未找到该帖子")
            note_headers, note_rows = self._read_csv_table(notes_path, NOTE_CSV_HEADERS)
            comment_headers, comment_rows = self._read_csv_table(comments_path, COMMENT_CSV_HEADERS)
            kept_notes = [row for row in note_rows if valid_note_id(row.get("笔记ID")) != note_id]
            comment_id_set = set(comment_ids)
            kept_comments = [row for row in comment_rows if not (
                text(row.get("笔记评论ID"), 256) in comment_id_set
                or csv_comment_note_id(row) == note_id
            )]
            deleted_note_rows = len(note_rows) - len(kept_notes)
            deleted_comment_rows = len(comment_rows) - len(kept_comments)
            if any(valid_note_id(row.get("笔记ID")) == note_id for row in kept_notes):
                raise ValueError("CSV 帖子清理校验失败")
            if any(text(row.get("笔记评论ID"), 256) in comment_id_set
                   or csv_comment_note_id(row) == note_id for row in kept_comments):
                raise ValueError("CSV 评论清理校验失败")

            media_root = self._media_root().resolve()
            media_value = text(note_row["media_dir"], 4000)
            managed_media_dirs: list[Path] = []
            if media_value:
                candidate = Path(media_value).expanduser()
                if candidate.exists():
                    candidate = candidate.resolve()
                    if candidate.parent != media_root:
                        raise ValueError("素材目录不在受管 posts_materials 目录内，已停止删除")
                    managed_media_dirs.append(candidate)
            if media_root.exists():
                suffix = f"__{note_id}"
                for candidate in media_root.iterdir():
                    if candidate.is_dir() and candidate.name.endswith(suffix) and candidate.resolve() not in managed_media_dirs:
                        managed_media_dirs.append(candidate.resolve())
            tombstones: list[tuple[Path, Path]] = []
            csv_backups: list[tuple[Path, Path]] = []
            logical_committed = False
            try:
                for index, folder in enumerate(managed_media_dirs, 1):
                    tombstone = folder.with_name(f".{folder.name}.deleting-{os.getpid()}-{time.time_ns()}-{index}")
                    folder.rename(tombstone)
                    tombstones.append((folder, tombstone))
                for target in (notes_path, comments_path):
                    backup = target.with_name(f".{target.stem}.delete-backup-{os.getpid()}-{time.time_ns()}.csv")
                    shutil.copy2(target, backup)
                    csv_backups.append((target, backup))
                self._replace_csv_pair(note_headers, kept_notes, comment_headers, kept_comments, "delete")

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
                    for table in ("note_summaries", "reply_generation_history", "comment_collection_jobs", "change_events", "watchlist"):
                        linked_database_records += db.execute(f"DELETE FROM {table} WHERE note_id=?", (note_id,)).rowcount
                    deleted_database_comments = db.execute("DELETE FROM comments WHERE note_id=?", (note_id,)).rowcount
                    deleted_database_notes = db.execute("DELETE FROM notes WHERE note_id=?", (note_id,)).rowcount
                    if deleted_database_notes != 1:
                        raise ValueError("SQLite 帖子清理校验失败")
                logical_committed = True
                cleanup_errors = []
                for _original, tombstone in tombstones:
                    try:
                        if tombstone.exists():
                            shutil.rmtree(tombstone)
                    except OSError as exc:
                        cleanup_errors.append(f"{tombstone.name}: {text(exc, 220)}")
                return {
                    "ok": True, "noteId": note_id, "excelPath": str(notes_path),
                    "commentsPath": str(comments_path), "deletedNoteRows": deleted_note_rows,
                    "deletedCommentRows": deleted_comment_rows, "deletedDatabaseComments": deleted_database_comments,
                    "deletedLinkedDatabaseRecords": linked_database_records, "excelVerified": True,
                    "csvVerified": True, "databaseVerified": True,
                    "mediaDeleted": bool(tombstones) and not cleanup_errors,
                    "mediaCleanupWarning": ("素材目录已移出但清理失败：" + "；".join(cleanup_errors)) if cleanup_errors else "",
                }
            except Exception:
                if not logical_committed:
                    for target, backup in csv_backups:
                        if backup.exists():
                            os.replace(backup, target)
                    for original, tombstone in reversed(tombstones):
                        if tombstone.exists() and not original.exists():
                            tombstone.rename(original)
                raise
            finally:
                for _target, backup in csv_backups:
                    backup.unlink(missing_ok=True)

    def _legacy_sync_ai_result_to_xlsx(self, target_type: str, target_id: str, result: dict[str, Any]) -> None:
        """Legacy XLSX AI write-back retained for reference."""
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

    def _sync_ai_result_to_xlsx(self, target_type: str, target_id: str, result: dict[str, Any]) -> None:
        try:
            notes_path, comments_path = self._csv_paths()
        except ValueError:
            return
        path = notes_path if target_type == "note" else comments_path
        defaults = NOTE_CSV_HEADERS if target_type == "note" else COMMENT_CSV_HEADERS
        id_header = "笔记ID" if target_type == "note" else "笔记评论ID"
        if not path.is_file():
            return
        with self.pull_lock:
            headers, rows = self._read_csv_table(path, defaults)
            if "AI情绪判断" not in headers:
                headers.append("AI情绪判断")
                for row in rows:
                    row["AI情绪判断"] = ""
            if target_type == "note" and "帖子好坏" not in headers:
                headers.append("帖子好坏")
                for row in rows:
                    row["帖子好坏"] = ""
            matched = False
            label = sentiment_label(result.get("sentiment"))
            for row in rows:
                if text(row.get(id_header), 256) != target_id:
                    continue
                row["AI情绪判断"] = label
                if target_type == "note":
                    row["帖子好坏"] = label
                matched = True
                break
            if matched:
                try:
                    self._replace_csv_table(path, headers, rows, "ai")
                except ValueError:
                    print(f"[bridge] CSV 被占用，AI 情绪回写跳过：{path}", flush=True)

    def pull_to_excel(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Serialize one complete pull and roll every store back if verification fails."""
        validate_snapshot_identity(payload)
        raw_note = payload.get("note") if isinstance(payload.get("note"), dict) else payload
        note_id = valid_note_id((raw_note or {}).get("noteId"))
        if not note_id:
            raise ValueError("noteId is required")
        with self.pull_lock:
            checkpoint = self._capture_sync_checkpoint(note_id, capture_media_binaries=True)
            try:
                result = self._pull_to_excel_locked(payload)
            except Exception as exc:
                rollback_errors = self._rollback_sync_checkpoints([checkpoint])
                if rollback_errors:
                    raise RuntimeError(
                        f"拉取失败且回滚未完全成功：{'；'.join(rollback_errors)}"
                    ) from exc
                raise
            self._discard_sync_checkpoint(checkpoint)
            return result

    def _pull_to_excel_locked(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Persist a completed browser read and make it visible in Excel."""
        raw_note = payload.get("note") if isinstance(payload.get("note"), dict) else payload
        note = browser_note_payload(raw_note)
        if "tags" in note and tag_text(note.get("tags")) == "无话题":
            note["tags"] = ["无话题"]
        incoming_note_id = valid_note_id(note.get("noteId"))
        if not incoming_note_id:
            raise ValueError("noteId is required")
        note["title"] = canonical_note_title(note.get("title"), note.get("content"), 80)
        note_id, prewrite_matched_by = self._resolve_pull_identity(note)
        self._normalize_csv_cross_store_fields()
        with self.lock, self._session() as db:
            previous = db.execute("SELECT payload_json FROM notes WHERE note_id=?", (note_id,)).fetchone()
        try:
            previous_payload = json.loads(previous[0] or "{}") if previous else {}
            if not isinstance(previous_payload, dict):
                previous_payload = {}
        except (TypeError, ValueError):
            previous_payload = {}
        incoming_publication = text(note.get("publishedAt"), 100)
        incoming_observed_at = text(note.get("timeObservedAt"), 80)
        note = {**browser_note_payload(previous_payload), **note, "noteId": note_id}
        if incoming_publication:
            note["timeObservedAt"] = incoming_observed_at or text(payload.get("collectedAt"), 80) or now_iso()
            note["timeReferenceSource"] = "capture"
        note = enrich_time_payload(note, text(payload.get("collectedAt"), 80) or now_iso(), previous=previous_payload)
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
            comments = self._normalize_snapshot_comments(note_id, comments)
            comment_status = comment_snapshot_status(payload, len(comments), comment_status)
            comment_result = self.upsert_comments({
                "noteId": note_id,
                "comments": comments,
                "expectedCount": expected_count,
                "status": "failed" if comment_status == "failed" else comment_status,
                "collectionEvidence": payload.get("collectionEvidence"),
                "explicitEmptyVerified": payload.get("explicitEmptyVerified"),
                "error": comment_error,
                "collectedAt": text(payload.get("collectedAt"), 80) or now_iso(),
            })
            comment_status = comment_result["status"]
            try:
                media_result = self._download_note_media(note)
                if media_result.get("status") != "complete":
                    raise ValueError(
                        f"素材下载未完整，已停止本次同步：{text(media_result.get('error'), 1000) or '存在下载失败'}"
                    )
                self._write_media_comments(media_result, comments)
            except Exception as exc:
                try:
                    failed_folder = self._resolve_media_folder(note)
                    if failed_folder.is_dir():
                        media_result["folder"] = str(failed_folder)
                except Exception:
                    pass
                raise ValueError(f"素材快照写入失败，已停止本次同步：{text(exc, 1000)}") from exc
            trusted_complete = comment_status == "likely_complete"
            xlsx_result = self._sync_pull_to_xlsx(
                note, comments, media_result, replace_comments=trusted_complete
            )
            presence_checked_at = now_iso()
            deleted_marked = self._mark_missing_comments_deleted(
                note_id,
                [text(item.get("commentId"), 256) for item in comments if text(item.get("commentId"), 256)],
                presence_checked_at,
            ) if trusted_complete else 0
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
            active_comment_count = int(db.execute(
                "SELECT COUNT(*) FROM comments WHERE note_id=? AND is_deleted=0", (note_id,)
            ).fetchone()[0])
            db.execute(
                """UPDATE notes SET status='known', is_relevant=1, source='existing_xlsx', relevance_status='relevant', relevance_source='pull',
                   pull_status=?, pull_error=?, last_pull_at=?, excel_synced_at=?,
                   comment_count_collected=?,comment_collection_status=?,
                   excel_sync_path=?, media_status=?, media_dir=?, media_file_count=?, media_error=?,
                   access_status='ok', access_error='', last_access_checked_at=?, access_check_result='opened',
                   post_status=?,is_deleted=0,deleted_at='',last_presence_checked_at=?,
                   url=?,title=?,author=?,content=?,keyword=?,tags=?,payload_json=?
                   WHERE note_id=?""",
                (
                    final_status, final_error, timestamp, timestamp,
                    active_comment_count, comment_status,
                    xlsx_result["path"], media_result.get("status", "failed"), media_result.get("folder", ""),
                    int(media_result.get("fileCount", 0) or 0), text(media_result.get("error"), 1000), timestamp,
                    POST_STATUS_PRESENT, timestamp,
                    text(note.get("url"), 4000), text(note.get("title"), 1000),
                    text(note.get("author"), 500), text(note.get("content"), 20000),
                    text(note.get("keyword"), 200), tag_text(note.get("tags")),
                    json.dumps(note, ensure_ascii=False), note_id,
                ),
            )
        if media_result.get("folder"):
            self._refresh_material_snapshot_for_note(note_id)
        consistency = self._verify_note_store_consistency(note_id, text(media_result.get("folder"), 4000))
        return {
            "ok": True,
            "noteId": note_id,
            "incomingNoteId": incoming_note_id,
            "status": "known",
            "postStatus": POST_STATUS_PRESENT,
            "isDeleted": False,
            "pullStatus": final_status,
            "commentStatus": comment_status,
            "currentCount": len(comments), "canPrune": trusted_complete,
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
            "commentCount": active_comment_count,
            "commentMarkedDeleted": deleted_marked,
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
            "storesSynced": ["notes_csv", "comments_csv", "sqlite"] + (["materials"] if media_result.get("folder") else []),
            "consistencyVerified": True,
            "consistency": consistency,
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
        notes_path, _comments_path = self._csv_paths()
        if not notes_path.is_file():
            self._ensure_seed_workbook(notes_path)
        xlsx_path = notes_path.resolve()

        with self.lock, self._session() as db:
            analysis = db.execute(
                "SELECT ai_analysis_status,post_sentiment FROM notes WHERE note_id=?",
                (note_id,),
            ).fetchone()
        if analysis and analysis["ai_analysis_status"] == "completed" and analysis["post_sentiment"]:
            self._sync_ai_result_to_xlsx("note", note_id, {"sentiment": analysis["post_sentiment"]})

        headers, rows = self._read_csv_table(xlsx_path, NOTE_CSV_HEADERS)
        if "笔记ID" not in headers:
            raise ValueError("笔记 CSV 缺少笔记ID列")
        note_column = headers.index("笔记ID") + 1
        excel_row = 0
        requested_row = max(0, int(payload.get("excelRow") or 0))
        if requested_row >= 2 and requested_row - 2 < len(rows) and valid_note_id(rows[requested_row - 2].get("笔记ID")) == note_id:
            excel_row = requested_row
        if not excel_row:
            excel_row = next((index + 2 for index, row in enumerate(rows)
                              if valid_note_id(row.get("笔记ID")) == note_id), 0)
        if not excel_row:
            raise ValueError("笔记 CSV 中尚未找到该帖子")
        field_name = text(payload.get("fieldName"), 100)
        excel_column = headers.index(field_name) + 1 if field_name in headers else note_column
        sheet_name = "笔记总表"

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
    $sheet = $book.Worksheets.Item(1)
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
                detail = _decode_powershell_output(raw_error).strip()
            except (AttributeError, TypeError):
                detail = str(raw_error).strip()
            detail = detail[-500:] if detail else "WPS/Excel COM 调用失败"
            raise ValueError(f"WPS/Excel 打开失败：{detail}")
        output = _decode_powershell_output(completed.stdout).strip()
        open_state = next((line.strip() for line in reversed(output.splitlines()) if line.strip().startswith(("WPS|", "Excel|"))), "WPS|True")
        opened_with, _, read_only_text = open_state.partition("|")
        return {
            "ok": True,
            "kind": "csv",
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
    _overview_read_paths = frozenset({"/api/data-overview/media", "/api/data-overview/comment-target", "/api/data-overview/export"})

    def _overview_origin_allowed(self) -> bool:
        origins = self.headers.get_all("Origin", [])
        if not origins:
            return True  # Local CLI/tests do not send an Origin header.
        if len(origins) != 1:
            return False
        origin = origins[0]
        if CHROME_EXTENSION_ORIGIN_RE.fullmatch(origin):
            return True
        # Network pages require an exact, explicitly configured origin. In
        # particular, neither opaque "null" nor localhost-prefix matches pass.
        try:
            parsed = urlparse(origin)
            valid_origin = (parsed.scheme in {"http", "https"} and bool(parsed.hostname)
                            and parsed.username is None and parsed.password is None
                            and not (parsed.path or parsed.params or parsed.query or parsed.fragment))
            return bool(valid_origin and origin in allowed_extension_origins())
        except ValueError:
            return False

    def _cors_origin(self) -> str:
        origin = self.headers.get("Origin", "")
        if urlparse(self.path).path in self._overview_read_paths:
            return origin if origin and self._overview_origin_allowed() else "null"
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
        if urlparse(self.path).path in self._overview_read_paths:
            self.send_header("Cache-Control", "no-store")
            self.send_header("Vary", "Origin")
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
        if urlparse(self.path).path in self._overview_read_paths and not self._overview_origin_allowed():
            self._send_json(403, {"ok": False, "error": "untrusted overview Origin"})
            return
        self._send_json(204, {})

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path in self._overview_read_paths and not self._overview_origin_allowed():
            self._send_json(403, {"ok": False, "error": "untrusted overview Origin"})
            return
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
                include_deleted = text(query.get("includeDeleted", ["true"])[0], 10).lower() not in {"0", "false", "no"}
                self._send_json(200, {"ok": True, "includeDeleted": include_deleted,
                                      "notes": self.store.list_notes(status, limit, include_deleted)})
            elif parsed.path == "/api/notes/unreachable":
                notes = self.store.list_unreachable_notes()
                self._send_json(200, {"ok": True, "count": len(notes), "notes": notes})
            elif parsed.path == "/api/data-health":
                self._send_json(200, self.store.data_health())
            elif parsed.path == "/api/data-overview/schema":
                self._send_json(200, self.store.data_overview_schema())
            elif parsed.path == "/api/data-overview/media":
                query = parse_qs(parsed.query, keep_blank_values=True, max_num_fields=4)
                if set(query) - {"dataset", "recordId", "index", "revision"} or any(len(values) != 1 for values in query.values()):
                    raise ValueError("invalid media query parameters")
                self._send_json(200, self.store.data_overview_media(
                    query.get("dataset", [""])[0], query.get("recordId", [""])[0],
                    query.get("index", [None])[0],
                    query.get("revision", [None])[0],
                ))
            elif parsed.path == "/api/data-overview/comment-target":
                query = parse_qs(parsed.query, keep_blank_values=True, max_num_fields=1)
                if set(query) - {"commentId"}:
                    raise ValueError("invalid comment-target query parameters")
                self._send_json(200, self.store.data_overview_comment_target(query.get("commentId", [""])[0]))
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
                include_deleted = text(query.get("includeDeleted", ["true"])[0], 10).lower() not in {"0", "false", "no"}
                comments = self.store.list_comments(note_id, limit, include_deleted)
                self._send_json(200, {"ok": True, "includeDeleted": include_deleted, "comments": comments})
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
        if self.path == "/api/data-overview/export" and not self._overview_origin_allowed():
            self._send_json(403, {"ok": False, "error": "untrusted overview Origin"})
            return
        try:
            payload = self._read_json()
            if self.path.startswith("/api/agent-analysis/"):
                result = agent_analysis.handle(self.store, self.path.rsplit("/", 1)[-1], payload)
            elif self.path == "/api/scan":
                result = self.store.scan(payload)
            elif self.path == "/api/pull":
                result = self.store.pull_to_excel(payload)
            elif self.path == "/api/note/delete":
                note_id = valid_note_id(payload.get("noteId"))
                hard_confirmed = bool(payload.get("hardDeleteConfirmed")) and text(
                    payload.get("confirmation"), 128
                ) == note_id
                if hard_confirmed:
                    result = self.store.delete_pulled_note(payload)
                else:
                    marked = self.store.set_note_access_status({
                        "noteId": note_id, "status": "unreachable",
                        "result": "manual_confirmed_deleted",
                        "error": "用户确认帖子已删除或下架；本地记录保留",
                    })
                    result = {**marked, "nonDestructive": True, "markedDeletedCount": 1}
            elif self.path == "/api/note/access-status":
                result = self.store.set_note_access_status(payload)
            elif self.path == "/api/notes/access-status/batch":
                result = self.store.set_note_access_statuses(payload)
            elif self.path in {"/api/notes/unreachable/delete", "/api/notes/unreachable/mark-deleted"}:
                result = self.store.delete_unreachable_notes(payload)
            elif self.path == "/api/data-health/repair":
                result = self.store.repair_data_health(payload)
            elif self.path == "/api/data-health/repair-relations":
                result = self.store.repair_csv_relationships(payload)
            elif self.path == "/api/data-overview/query":
                result = self.store.query_data_overview(payload)
            elif self.path == "/api/data-overview/export":
                result = self.store.export_data_overview(payload)
            elif self.path == "/api/data-overview/values":
                result = self.store.data_overview_values(payload)
            elif self.path == "/api/data-overview/delete":
                result = self.store.delete_data_overview_records(payload)
            elif self.path == "/api/data-overview/discoveries/purge":
                result = self.store.purge_untracked_discoveries(payload)
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
                    raise ValueError("未配置 CSV 总表路径")
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
    parser.add_argument("--seed-xlsx", "--seed-csv", dest="seed_xlsx", type=Path, default=None)
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
    """Resolve the notes CSV path, accepting the legacy XLSX config for one-time migration."""
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
            config = json.loads(path.read_text(encoding="utf-8"))
            value = text(config.get("seed_csv") or config.get("seed_xlsx"), 500)
            if value:
                candidate = Path(value).expanduser()
                if candidate.suffix.lower() in {".xlsx", ".xlsm"} and not candidate.exists():
                    notes_csv, _comments_csv = MonitorStore._derived_csv_paths(candidate)
                    if notes_csv.exists():
                        return notes_csv
                return candidate
        except Exception:
            continue
    return _project_data_dir() / "小红书_笔记总表.csv"


def create_server(host: str, port: int, db_path: Path, export_dir: Path, seed_xlsx: Path | None = None):
    store = MonitorStore(db_path, export_dir)
    configured = Path(seed_xlsx) if seed_xlsx else default_seed_xlsx()
    inserted = store.seed_from_xlsx(configured)
    try:
        store.reconcile_legacy_access_statuses()
    except Exception as exc:
        print(f"[bridge] 旧版访问状态已在数据库降级；CSV 标签稍后重试：{exc}")
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
            raise SystemExit("--seed-only requires --seed-csv or --seed-xlsx")
        store = MonitorStore(args.db, args.export_dir)
        inserted = store.seed_from_xlsx(args.seed_xlsx)
        migration = store.reconcile_legacy_access_statuses()
        print(
            f"[bridge] seeded {inserted} existing note IDs from {store.seed_xlsx_path}; "
            f"downgraded {migration.get('updated', 0)} legacy access statuses"
        )
        return

    if _port_already_serves_bridge(args.host, args.port):
        raise SystemExit(
            f"[bridge] 端口 {args.port} 上已有 Bridge 在运行，本次启动中止，避免双实例抢请求。"
        )
    seed_xlsx = Path(args.seed_xlsx) if args.seed_xlsx else default_seed_xlsx()
    server, store, inserted = create_server(args.host, args.port, args.db, args.export_dir, seed_xlsx)
    print(f"[bridge] seeded {inserted} existing note IDs from CSV: {store.seed_xlsx_path}")
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
