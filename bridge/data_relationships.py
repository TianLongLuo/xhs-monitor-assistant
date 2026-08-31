from __future__ import annotations

import hashlib
import re
from typing import Any
from urllib.parse import urlparse

NOTE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{6,128}$")
COMMENT_CORE_FIELDS = ("原笔记url", "笔记ID", "笔记评论ID", "用户昵称", "评论内容", "评论时间")


def value(item: Any) -> str:
    return "" if item is None else str(item).strip()


def valid_note_id(item: Any) -> str:
    candidate = value(item)
    return candidate if NOTE_ID_RE.fullmatch(candidate) else ""


def note_id_from_url(item: Any) -> str:
    raw = value(item)
    if not raw:
        return ""
    try:
        parts = [part for part in urlparse(raw).path.split("/") if part]
    except ValueError:
        return ""
    for marker in ("search_result", "explore", "item"):
        if marker not in parts:
            continue
        index = parts.index(marker) + 1
        if index < len(parts):
            return valid_note_id(parts[index])
    return ""


def comment_note_id(row: dict[str, Any]) -> str:
    return valid_note_id(row.get("笔记ID")) or note_id_from_url(row.get("原笔记url"))


def canonical_note_url(note_id: str) -> str:
    return f"https://www.xiaohongshu.com/explore/{note_id}" if valid_note_id(note_id) else ""


def stable_legacy_comment_id(row: dict[str, Any], note_id: str = "") -> str:
    identity = "\x1f".join((
        valid_note_id(note_id) or comment_note_id(row),
        value(row.get("用户昵称")),
        value(row.get("评论内容")),
        value(row.get("评论时间")),
        value(row.get("父评论ID")),
        value(row.get("评论层级")),
        value(row.get("帖子用户主页url")),
    ))
    return f"legacy-{hashlib.sha256(identity.encode('utf-8')).hexdigest()[:32]}"


def _archive(source: str, row_number: int, reason: str, row: dict[str, Any]) -> dict[str, Any]:
    return {
        "source": source,
        "rowNumber": int(row_number),
        "reason": reason,
        "row": {str(key): "" if item is None else str(item) for key, item in row.items()},
    }


def _malformed_runs(rows: list[dict[str, str]]) -> list[tuple[int, int]]:
    flags = [not (
        comment_note_id(row)
        and value(row.get("用户昵称"))
        and value(row.get("评论层级"))
    ) for row in rows]
    runs: list[tuple[int, int]] = []
    start: int | None = None
    for index, flagged in enumerate(flags):
        if flagged and start is None:
            start = index
        if not flagged and start is not None:
            runs.append((start, index - 1))
            start = None
    if start is not None:
        runs.append((start, len(rows) - 1))
    candidates = []
    for start, end in runs:
        block = rows[start:end + 1]
        note_rows = sum(bool(comment_note_id(row)) for row in block)
        if len(block) >= 20 and note_rows >= 2 and len(block) >= note_rows * 3:
            candidates.append((start, end))
    return candidates


def _recompose_fragment_run(
    rows: list[dict[str, str]],
    start: int,
    end: int,
    headers: list[str],
) -> list[dict[str, str]]:
    block = rows[start:end + 1]
    starts = [index for index, row in enumerate(block) if comment_note_id(row)]
    rebuilt: list[dict[str, str]] = []
    for position, group_start in enumerate(starts):
        group_end = starts[position + 1] if position + 1 < len(starts) else len(block)
        group = block[group_start:group_end]
        output = {name: "" for name in headers}
        for name in headers:
            candidates = [value(row.get(name)) for row in group if value(row.get(name))]
            if candidates:
                output[name] = candidates[0]
        rebuilt.append(output)
    return rebuilt


def repair_relationship_rows(
    note_rows: list[dict[str, Any]],
    comment_rows: list[dict[str, Any]],
    note_headers: list[str],
    comment_headers: list[str],
) -> dict[str, Any]:
    """Repair structural CSV relationships without silently dropping source rows.

    Every removed or rewritten abnormal source row is returned in ``archives``
    so callers can persist it in SQLite before committing the repaired files.
    """
    note_headers = list(dict.fromkeys([*note_headers, "笔记ID"]))
    comment_headers = list(dict.fromkeys([
        "笔记ID", *[name for name in comment_headers if name != "笔记ID"],
        "映射状态", "映射备注", "评论状态",
    ]))
    notes = [{name: "" if row.get(name) is None else str(row.get(name)) for name in note_headers}
             for row in note_rows]
    comments = [{name: "" if row.get(name) is None else str(row.get(name)) for name in comment_headers}
                for row in comment_rows]
    archives: list[dict[str, Any]] = []

    # First collect valid IDs so an empty-ID legacy duplicate can be identified
    # before any row is modified.
    original_valid_ids = {valid_note_id(row.get("笔记ID")) for row in notes}
    original_valid_ids.discard("")
    repaired_notes: list[dict[str, str]] = []
    note_by_id: dict[str, dict[str, str]] = {}
    fixed_note_urls = 0
    removed_note_rows = 0
    for index, row in enumerate(notes, 2):
        note_id = valid_note_id(row.get("笔记ID"))
        url_id = note_id_from_url(row.get("笔记url"))
        if not note_id and url_id and url_id in original_valid_ids:
            archives.append(_archive("note_csv", index, "duplicate_note_row_without_id", row))
            removed_note_rows += 1
            continue
        if not note_id and url_id:
            note_id = url_id
            row["笔记ID"] = note_id
        if not note_id:
            archives.append(_archive("note_csv", index, "invalid_note_row_without_id", row))
            removed_note_rows += 1
            continue
        if note_id in note_by_id:
            existing = note_by_id[note_id]
            for name in note_headers:
                if not value(existing.get(name)) and value(row.get(name)):
                    existing[name] = row[name]
            archives.append(_archive("note_csv", index, "duplicate_note_id", row))
            removed_note_rows += 1
            continue
        if url_id and url_id != note_id:
            archives.append(_archive("note_csv", index, "stored_note_url_id_mismatch", row))
            row["笔记url"] = canonical_note_url(note_id)
            fixed_note_urls += 1
        elif not value(row.get("笔记url")):
            row["笔记url"] = canonical_note_url(note_id)
            fixed_note_urls += 1
        row["笔记ID"] = note_id
        note_by_id[note_id] = row
        repaired_notes.append(row)

    fragmented_groups = 0
    fragmented_source_rows = 0
    for start, end in reversed(_malformed_runs(comments)):
        rebuilt = _recompose_fragment_run(comments, start, end, comment_headers)
        for offset, source_row in enumerate(comments[start:end + 1], start + 2):
            archives.append(_archive("comment_csv", offset, "fragmented_comment_source_row", source_row))
        comments[start:end + 1] = rebuilt
        fragmented_groups += len(rebuilt)
        fragmented_source_rows += end - start + 1

    cleaned_comments: list[dict[str, str]] = []
    removed_artifacts = 0
    generated_comment_ids = 0
    mapping_review_count = 0
    fixed_comment_urls = 0
    used_comment_ids: set[str] = set()
    for index, row in enumerate(comments, 2):
        if not any(value(row.get(name)) for name in COMMENT_CORE_FIELDS):
            archives.append(_archive("comment_csv", index, "non_comment_artifact_row", row))
            removed_artifacts += 1
            continue
        explicit_id = valid_note_id(row.get("笔记ID"))
        url_id = note_id_from_url(row.get("原笔记url"))
        note_id = explicit_id or url_id
        if explicit_id and url_id and explicit_id != url_id:
            archives.append(_archive("comment_csv", index, "comment_note_url_id_mismatch", row))
            row["原笔记url"] = canonical_note_url(explicit_id)
            fixed_comment_urls += 1
            note_id = explicit_id
        row["笔记ID"] = note_id
        if not value(row.get("评论状态")):
            row["评论状态"] = "存在"
        note_row = note_by_id.get(note_id)
        if note_row:
            note_url = value(note_row.get("笔记url"))
            if note_id_from_url(note_url) != note_id:
                note_url = canonical_note_url(note_id)
            if value(row.get("原笔记url")) != note_url:
                row["原笔记url"] = note_url
                fixed_comment_urls += 1
            note_folder = value(note_row.get("对应帖子文件夹地址"))
            note_files = value(note_row.get("文件夹内清单"))
            if note_folder:
                row["对应帖子文件夹地址"] = note_folder
            if note_files:
                row["文件夹内清单"] = note_files
            row["映射状态"] = "已映射"
            row["映射备注"] = ""
        else:
            row["映射状态"] = "待复核"
            row["映射备注"] = "所属笔记尚未进入笔记总表" if note_id else "无法解析所属笔记ID"
            mapping_review_count += 1
        comment_id = value(row.get("笔记评论ID"))
        if not comment_id:
            comment_id = stable_legacy_comment_id(row, note_id)
            row["笔记评论ID"] = comment_id
            generated_comment_ids += 1
        if comment_id in used_comment_ids:
            archives.append(_archive("comment_csv", index, "duplicate_comment_id", row))
            collision_identity = "\x1f".join(value(row.get(name)) for name in comment_headers)
            comment_id = f"legacy-duplicate-{hashlib.sha256(collision_identity.encode('utf-8')).hexdigest()[:22]}"
            row["笔记评论ID"] = comment_id
            row["映射状态"] = "待复核"
            row["映射备注"] = "原评论ID重复，已生成独立稳定ID"
            mapping_review_count += 1
        used_comment_ids.add(comment_id)
        cleaned_comments.append(row)

    return {
        "noteHeaders": note_headers,
        "commentHeaders": comment_headers,
        "noteRows": repaired_notes,
        "commentRows": cleaned_comments,
        "archives": archives,
        "summary": {
            "noteRowsBefore": len(note_rows),
            "noteRowsAfter": len(repaired_notes),
            "removedNoteRows": removed_note_rows,
            "fixedNoteUrls": fixed_note_urls,
            "commentRowsBefore": len(comment_rows),
            "commentRowsAfter": len(cleaned_comments),
            "fragmentedCommentsRebuilt": fragmented_groups,
            "fragmentedSourceRows": fragmented_source_rows,
            "artifactRowsRemoved": removed_artifacts,
            "generatedCommentIds": generated_comment_ids,
            "mappingReviewComments": mapping_review_count,
            "fixedCommentUrls": fixed_comment_urls,
            "archivedRows": len(archives),
        },
    }
