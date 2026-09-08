"""Read-only, snapshot-checked full-result workbook delivery; no filesystem output."""
from __future__ import annotations

import base64
import copy
from typing import Any

try:
    from .data_overview import build_field_specs
    from .overview_export import build_overview_workbook
except ImportError:
    from data_overview import build_field_specs
    from overview_export import build_overview_workbook


def enrich_roots(db, rows):
    """Follow exact same-note parent IDs, including parents outside the filter."""
    cache = {}

    def read(key):
        if key not in cache:
            found = db.execute("SELECT comment_id,note_id,parent_comment_id,comment_level,author,content,is_deleted "
                               "FROM comments WHERE comment_id=?", (key,)).fetchone()
            cache[key] = dict(found) if found else None
        return cache[key]

    for row in rows:
        note_id, own_id = row.get("note_id"), row.get("comment_id")
        current, seen, status, target = read(own_id), set(), "resolved", own_id
        for _ in range(256):
            if not current:
                status = "missing"
                break
            if current["note_id"] != note_id:
                status = "cross_note"
                break
            key = current["comment_id"]
            if key in seen:
                status = "cycle"
                break
            seen.add(key)
            parent = current.get("parent_comment_id")
            try:
                level = int(current.get("comment_level") or 0)
            except (ValueError, TypeError):
                level = 0
            if not parent:
                if level >= 2:
                    status = "missing"
                break
            if level == 1:
                status = "ambiguous"
                break
            target = parent
            current = read(parent)
        else:
            status = "too_deep"
        row["thread_root_status"] = status
        if status == "resolved" and current:
            row.update(thread_root_id=current["comment_id"], thread_root_author=current.get("author") or "",
                       thread_root_content=current.get("content") or "", thread_root_is_deleted=current.get("is_deleted"))
        else:
            # Invalid chains must not merge unrelated rows by guessed identity.
            row.update(thread_root_id=own_id, thread_root_author="",
                       thread_root_content=(f"一级评论未入库（父评ID：{target}）" if status == "missing"
                                            else f"一级评论关联待复核（父评ID：{target}；{status}）"))


def export_filtered_workbook(store, source: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(source, dict):
        raise ValueError("导出条件格式无效")
    payload = copy.deepcopy(source)
    dataset = payload.get("dataset")
    token = payload.get("snapshotToken")
    expected = payload.pop("expectedTotal", None)
    if dataset not in {"notes", "comments"} or not isinstance(token, str) or not token:
        raise ValueError("请先完成筛选与一致性校验再导出")
    if type(expected) is not int or expected < 0:
        raise ValueError("缺少有效的筛选结果数量")
    primary = "note_id" if dataset == "notes" else "comment_id"
    rows, seen = [], set()
    # Reentrant store locks also protect each paginated query. All pages and
    # parent context are copied before releasing locks; workbook CPU is outside.
    with store.pull_lock, store.lock:
        store._validate_data_overview_read_snapshot(token, "导出")
        db = store._connect()
        try:
            specs = [f for f in build_field_specs(db, dataset) if not f.action]
        finally:
            db.close()
        columns = [dict(key=f.key, label=f.label, dataType=f.data_type) for f in specs]
        keys = [f.key for f in specs if f.key != primary]
        batches = [[primary, *keys[i:i+179]] for i in range(0, max(1, len(keys)), 179)]
        page = 1
        while True:
            page_rows, page_ids = [], None
            for fields in batches:
                result = store.query_data_overview({**payload, "fields": fields, "page": page, "pageSize": 200})
                if (result.get("ok") is not True or result.get("consistentSnapshot") is not True
                    or result.get("snapshotToken") != token or result.get("dataset") != dataset):
                    raise ValueError("导出期间数据快照发生变化，未生成文件")
                if (result.get("total") != expected or result.get("page") != page
                    or result.get("pageSize") != 200 or not isinstance(result.get("rows"), list)):
                    raise ValueError("筛选结果数量或分页已变化，未生成不完整文件")
                items = result["rows"]
                ids = [item.get(primary) for item in items]
                if any(not isinstance(key, str) or not key for key in ids) or len(set(ids)) != len(ids):
                    raise ValueError("导出发现缺失或重复记录 ID，已停止")
                if page_ids is None:
                    page_ids, page_rows = ids, [dict(item) for item in items]
                else:
                    if ids != page_ids:
                        raise ValueError("导出字段分页关联不一致，已停止")
                    for merged, item in zip(page_rows, items):
                        merged.update(item)
            if seen.intersection(page_ids):
                raise ValueError("导出发现跨页重复记录 ID，已停止")
            seen.update(page_ids)
            rows.extend(page_rows)
            if len(rows) > expected or (len(rows) < expected and len(page_rows) != 200):
                raise ValueError("导出分页数量不完整，已停止")
            if len(rows) == expected:
                break
            page += 1
        if dataset == "comments":
            db = store._connect()
            try:
                db.execute("PRAGMA query_only=ON")
                enrich_roots(db, rows)
            finally:
                db.close()
        store._validate_data_overview_read_snapshot(token, "导出完成校验")
    context = {"expectedTotal": expected, "total": expected, "filter": payload.get("filter") or {},
               "search": payload.get("search") or "", "semanticSearch": payload.get("semanticSearch") is True,
               "sort": payload.get("sort") or [],
               "field_mapping": {"main_category": "negative_type", "subcategory": "negative_subtype"}}
    content = build_overview_workbook(dataset, rows, columns, context)
    # Chrome extension runtime JSON messages have a finite transport size. Fail
    # explicitly, never silently truncate the workbook or return a partial set.
    if len(content) > 40 * 1024 * 1024:
        raise ValueError("Excel 文件超过浏览器传输上限，请缩小筛选范围或使用 CSV 导出")
    return {"ok": True, "dataset": dataset, "total": expected, "snapshotToken": token,
            "consistentSnapshot": True, "contentBase64": base64.b64encode(content).decode("ascii"),
            "mimeType": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}
