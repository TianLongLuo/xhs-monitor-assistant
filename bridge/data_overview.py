"""Read-only field catalogue and safe query compiler for the local data overview."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


MAX_FILTER_DEPTH = 4
MAX_FILTER_CONDITIONS = 60


FIELD_LABELS = {
    "note_id": "笔记 ID", "comment_id": "评论 ID", "parent_comment_id": "父评论 ID",
    "url": "链接", "page_url": "页面链接", "comment_url": "评论链接",
    "title": "标题", "author": "作者", "author_url": "作者主页",
    "content": "正文", "keyword": "来源词", "tags": "话题",
    "status": "工作流状态", "source": "数据来源", "pull_status": "拉取状态",
    "pull_error": "拉取错误", "post_status": "帖子状态", "comment_status": "评论状态",
    "is_deleted": "是否已删除", "deleted_at": "删除确认时间",
    "last_presence_checked_at": "最近存续核验", "access_status": "访问状态",
    "access_error": "访问错误", "access_check_result": "访问核验结果",
    "last_access_checked_at": "最近访问核验", "first_seen_at": "首次发现",
    "last_seen_at": "最近发现", "published_at": "发布时间", "updated_at": "更新时间",
    "like_count": "点赞量", "reply_count": "回复量", "comment_level": "评论层级",
    "comment_collection_status": "评论采集状态", "comment_count_collected": "已采评论数",
    "last_comment_collected_at": "最近采集评论", "negative_comment_count": "负面评论数",
    "media_status": "素材状态", "media_dir": "素材目录", "media_file_count": "素材文件数",
    "media_error": "素材错误", "ai_analysis_status": "AI 分析状态",
    "post_sentiment": "帖子情绪", "sentiment": "评论情绪", "is_negative": "是否负面",
    "manual_negative": "人工负面", "risk_level": "风险等级",
    "issue_categories": "问题分类", "ai_summary": "AI 摘要", "ai_reason": "AI 理由",
    "ai_confidence": "AI 置信度", "review_status": "复核状态", "review_note": "复核备注",
    "semantic_analysis_count": "语义分析次数", "analysis_is_negative": "语义差评结论",
    "negative_type": "差评类型", "negative_subtype": "差评子类型",
    "payload_json": "原始结构化数据", "content_hash": "内容指纹",
    "business_record": "是否业务总表记录", "active_comment_count": "当前评论数",
    "deleted_comment_count": "已删除评论数", "comment_type": "评论角色",
    "thread_root_id": "一级评论 ID", "thread_root_content": "一级评论",
    "thread_root_author": "一级评论作者",
    "is_post_author": "是否帖主评论", "source_author_url": "用户主页",
    "source_author_id": "用户 ID", "source_like_count": "页面点赞量",
    "source_collect_count": "页面收藏量", "source_comment_count": "页面评论量",
    "source_share_count": "页面分享量", "source_published_at": "页面发布时间",
    "source_updated_at": "页面更新时间", "source_ip_location": "IP 属地",
    "source_image_count": "图片数量", "source_video_count": "视频数量",
}


DEFAULT_VISIBLE = {
    "notes": [
        "note_id", "title", "author", "business_record", "post_status", "access_status",
        "pull_status", "source_like_count", "source_collect_count", "active_comment_count",
        "deleted_comment_count", "source_published_at", "last_seen_at", "url",
    ],
    "comments": [
        "comment_id", "note_id", "thread_root_content", "content", "author", "published_at",
        "like_count", "comment_level", "analysis_is_negative", "negative_type",
        "comment_status", "comment_type", "post__url", "post__title", "post__post_status",
    ],
}


NOTE_PRIMARY_ORDER = [
    "note_id", "url", "title", "content", "author", "published_at", "updated_at", "tags", "keyword",
    "source_like_count", "source_collect_count", "source_comment_count", "source_share_count",
    "post_status", "access_status", "pull_status", "business_record", "active_comment_count",
    "deleted_comment_count", "media_dir", "last_seen_at",
]
COMMENT_PRIMARY_ORDER = [
    "comment_id", "note_id", "thread_root_content", "content", "author", "published_at", "like_count",
    "comment_level", "analysis_is_negative", "negative_type", "comment_status", "comment_type",
    "post__url", "post__title", "post__post_status", "thread_root_id", "thread_root_author",
    "parent_comment_id", "author_url", "comment_url", "is_post_author", "sentiment", "negative_subtype",
    "review_status", "last_seen_at",
]
VALUE_OPTION_FIELDS = {
    "author", "keyword", "tags", "status", "source", "pull_status", "post_status", "comment_status",
    "access_status", "access_check_result", "media_status", "ai_analysis_status", "post_sentiment",
    "sentiment", "analysis_is_negative", "negative_type", "negative_subtype", "review_status",
    "comment_level", "comment_type", "is_post_author", "is_deleted", "is_relevant", "manual_negative",
    "risk_level", "source_ip_location", "post__author", "post__keyword", "post__tags", "post__source",
    "post__pull_status", "post__post_status", "post__access_status", "post__media_status",
    "post__analysis_is_negative", "post__negative_type", "post__negative_subtype",
}


OPERATORS = [
    {"id": "eq", "label": "等于", "types": ["text", "number", "boolean", "datetime"]},
    {"id": "neq", "label": "不等于", "types": ["text", "number", "boolean", "datetime"]},
    {"id": "contains", "label": "包含", "types": ["text", "number", "datetime"]},
    {"id": "not_contains", "label": "不包含", "types": ["text", "number", "datetime"]},
    {"id": "starts_with", "label": "开头是", "types": ["text"]},
    {"id": "ends_with", "label": "结尾是", "types": ["text"]},
    {"id": "gt", "label": "大于 / 晚于", "types": ["number", "datetime"]},
    {"id": "gte", "label": "大于等于", "types": ["number", "datetime"]},
    {"id": "lt", "label": "小于 / 早于", "types": ["number", "datetime"]},
    {"id": "lte", "label": "小于等于", "types": ["number", "datetime"]},
    {"id": "between", "label": "介于", "types": ["number", "datetime"]},
    {"id": "in", "label": "属于任一值", "types": ["text", "number", "datetime"]},
    {"id": "is_empty", "label": "为空", "types": ["text", "number", "boolean", "datetime"]},
    {"id": "not_empty", "label": "不为空", "types": ["text", "number", "boolean", "datetime"]},
    {"id": "is_true", "label": "为真", "types": ["boolean"]},
    {"id": "is_false", "label": "为假", "types": ["boolean"]},
]
OPERATOR_IDS = {item["id"] for item in OPERATORS}


@dataclass(frozen=True)
class FieldSpec:
    key: str
    label: str
    data_type: str
    expression: str
    source: str
    default_visible: bool = False
    display_order: int = 10000
    suggest_values: bool = False

    def public(self) -> dict[str, Any]:
        return {
            "key": self.key,
            "label": self.label,
            "dataType": self.data_type,
            "source": self.source,
            "defaultVisible": self.default_visible,
            "displayOrder": self.display_order,
            "suggestValues": self.suggest_values,
            "filterable": True,
            "sortable": True,
        }


def _quote(identifier: str) -> str:
    return '"' + identifier.replace('"', '""') + '"'


def _label(key: str) -> str:
    if key.startswith("post__"):
        raw = key.split("__", 1)[1]
        return "原帖 · " + FIELD_LABELS.get(raw, raw.replace("_", " "))
    return FIELD_LABELS.get(key, key.replace("_", " "))


def _data_type(name: str, declared_type: str) -> str:
    upper = (declared_type or "").upper()
    if name in {"is_deleted", "is_relevant", "is_negative", "manual_negative"}:
        return "boolean"
    if name.endswith("_at") or name in {"published_at", "updated_at"}:
        return "datetime"
    if any(marker in upper for marker in ("INT", "REAL", "FLOAT", "DOUBLE", "NUMERIC", "DECIMAL")):
        return "number"
    return "text"


def _columns(db: Any, table: str) -> list[tuple[str, str]]:
    return [(str(row[1]), str(row[2] or "")) for row in db.execute(f"PRAGMA table_info({_quote(table)})")]


def _json_expr(alias: str, path: str) -> str:
    payload = f"{alias}.{_quote('payload_json')}"
    return f"CASE WHEN json_valid({payload}) THEN json_extract({payload}, '$.{path}') ELSE NULL END"


def _display_order(dataset: str, key: str) -> int:
    order = COMMENT_PRIMARY_ORDER if dataset == "comments" else NOTE_PRIMARY_ORDER
    try:
        return order.index(key)
    except ValueError:
        if key.startswith("post__"):
            return 5000
        return 1000 + len(order)


def _source_group(dataset: str, key: str, fallback: str) -> str:
    primary = COMMENT_PRIMARY_ORDER if dataset == "comments" else NOTE_PRIMARY_ORDER
    if key in primary:
        return "常用字段（CSV 对齐）"
    if key.startswith("post__"):
        return "原帖 SQLite 字段"
    return fallback


def _field_spec(dataset: str, key: str, label: str, data_type: str, expression: str,
                source: str, default_visible: bool = False) -> FieldSpec:
    return FieldSpec(
        key, label, data_type, expression, _source_group(dataset, key, source), default_visible,
        _display_order(dataset, key), key in VALUE_OPTION_FIELDS,
    )


def build_field_specs(db: Any, dataset: str) -> list[FieldSpec]:
    if dataset not in {"notes", "comments"}:
        raise ValueError("dataset must be notes or comments")
    defaults = set(DEFAULT_VISIBLE[dataset])
    fields: list[FieldSpec] = []
    if dataset == "notes":
        for name, declared in _columns(db, "notes"):
            fields.append(_field_spec(dataset, name, _label(name), _data_type(name, declared),
                                      f"n.{_quote(name)}", "SQLite 扩展", name in defaults))
        fields.extend([
            _field_spec(dataset, "business_record", _label("business_record"), "boolean",
                        "CASE WHEN n.source='existing_xlsx' OR n.pull_status IN ('synced','partial') THEN 1 ELSE 0 END",
                        "衍生字段", "business_record" in defaults),
            _field_spec(dataset, "active_comment_count", _label("active_comment_count"), "number",
                        "(SELECT COUNT(*) FROM comments ac WHERE ac.note_id=n.note_id AND ac.is_deleted=0)",
                        "衍生字段", "active_comment_count" in defaults),
            _field_spec(dataset, "deleted_comment_count", _label("deleted_comment_count"), "number",
                        "(SELECT COUNT(*) FROM comments dc WHERE dc.note_id=n.note_id AND dc.is_deleted=1)",
                        "衍生字段", "deleted_comment_count" in defaults),
        ])
        json_fields = [
            ("source_author_url", "authorUrl", "text"), ("source_author_id", "authorId", "text"),
            ("source_like_count", "likeCount", "number"), ("source_collect_count", "collectCount", "number"),
            ("source_comment_count", "commentCount", "number"), ("source_share_count", "shareCount", "number"),
            ("source_published_at", "publishedAt", "datetime"), ("source_updated_at", "updatedAt", "datetime"),
            ("source_ip_location", "ipLocation", "text"), ("source_image_count", "imageCount", "number"),
            ("source_video_count", "videoCount", "number"),
        ]
        for key, path, kind in json_fields:
            fields.append(_field_spec(dataset, key, _label(key), kind, _json_expr("n", path),
                                      "页面快照", key in defaults))
    else:
        for name, declared in _columns(db, "comments"):
            fields.append(_field_spec(dataset, name, _label(name), _data_type(name, declared),
                                      f"c.{_quote(name)}", "SQLite 扩展", name in defaults))
        reply_predicate = "(c.comment_level>=2 OR TRIM(COALESCE(c.parent_comment_id,''))<>'')"
        root_id = (
            f"CASE WHEN {reply_predicate} THEN COALESCE(NULLIF(TRIM(c.parent_comment_id),''),c.comment_id) "
            "ELSE c.comment_id END"
        )
        fields.extend([
            _field_spec(dataset, "thread_root_id", _label("thread_root_id"), "text", root_id,
                        "评论线程", "thread_root_id" in defaults),
            _field_spec(
                dataset, "thread_root_content", _label("thread_root_content"), "text",
                f"CASE WHEN {reply_predicate} THEN COALESCE((SELECT pc.content FROM comments pc "
                "WHERE pc.note_id=c.note_id AND pc.comment_id=c.parent_comment_id LIMIT 1),'（一级评论未采集）') "
                "ELSE c.content END",
                "评论线程", "thread_root_content" in defaults,
            ),
            _field_spec(
                dataset, "thread_root_author", _label("thread_root_author"), "text",
                f"CASE WHEN {reply_predicate} THEN COALESCE((SELECT pc.author FROM comments pc "
                "WHERE pc.note_id=c.note_id AND pc.comment_id=c.parent_comment_id LIMIT 1),'') ELSE c.author END",
                "评论线程", "thread_root_author" in defaults,
            ),
            _field_spec(dataset, "comment_type", _label("comment_type"), "text",
                        "CASE WHEN c.comment_level>=2 OR c.parent_comment_id<>'' THEN '二级回复' ELSE '一级评论' END",
                        "衍生字段", "comment_type" in defaults),
            _field_spec(dataset, "is_post_author", _label("is_post_author"), "boolean",
                        "CASE WHEN json_valid(c.payload_json) AND json_extract(c.payload_json, '$.isAuthor') THEN 1 ELSE 0 END",
                        "衍生字段", "is_post_author" in defaults),
        ])
        for name, declared in _columns(db, "notes"):
            key = f"post__{name}"
            fields.append(_field_spec(dataset, key, _label(key), _data_type(name, declared),
                                      f"n.{_quote(name)}", "原帖 SQLite 字段", key in defaults))
        for key, path, kind in [
            ("source_like_count", "likeCount", "number"), ("source_collect_count", "collectCount", "number"),
            ("source_comment_count", "commentCount", "number"), ("source_share_count", "shareCount", "number"),
            ("source_published_at", "publishedAt", "datetime"), ("source_ip_location", "ipLocation", "text"),
        ]:
            full_key = f"post__{key}"
            fields.append(_field_spec(dataset, full_key, _label(full_key), kind, _json_expr("n", path),
                                      "原帖页面快照", full_key in defaults))
    return sorted(fields, key=lambda field: (field.display_order, field.label.casefold(), field.key))


def _escape_like(value: Any) -> str:
    return str(value if value is not None else "").replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _boolean(value: Any) -> int:
    if isinstance(value, bool):
        return int(value)
    return 1 if str(value or "").strip().lower() in {"1", "true", "yes", "是", "存在"} else 0


def _number(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError("数值筛选条件格式不正确") from exc


def _coerce(value: Any, data_type: str) -> Any:
    if data_type == "boolean":
        return _boolean(value)
    if data_type == "number":
        return _number(value)
    return str(value if value is not None else "")[:8000]


def compile_filter_group(group: dict[str, Any] | None, specs: dict[str, FieldSpec]) -> tuple[str, list[Any], int]:
    parameters: list[Any] = []
    condition_count = 0

    def condition_sql(condition: dict[str, Any]) -> str:
        nonlocal condition_count
        condition_count += 1
        if condition_count > MAX_FILTER_CONDITIONS:
            raise ValueError(f"筛选条件最多 {MAX_FILTER_CONDITIONS} 条")
        field = str(condition.get("field") or "")
        operator = str(condition.get("operator") or "eq")
        spec = specs.get(field)
        if not spec:
            raise ValueError(f"未知筛选字段：{field}")
        if operator not in OPERATOR_IDS:
            raise ValueError(f"未知筛选操作：{operator}")
        expr = spec.expression
        text_expr = f"COALESCE(CAST({expr} AS TEXT),'')"
        value = condition.get("value")
        value2 = condition.get("value2")
        if operator == "is_empty":
            return f"({expr} IS NULL OR TRIM({text_expr})='')"
        if operator == "not_empty":
            return f"({expr} IS NOT NULL AND TRIM({text_expr})<>'')"
        if operator in {"is_true", "is_false"}:
            parameters.append(1 if operator == "is_true" else 0)
            return f"CAST(COALESCE({expr},0) AS INTEGER)=?"
        if operator in {"contains", "not_contains", "starts_with", "ends_with"}:
            escaped = _escape_like(value)
            pattern = {
                "contains": f"%{escaped}%", "not_contains": f"%{escaped}%",
                "starts_with": f"{escaped}%", "ends_with": f"%{escaped}",
            }[operator]
            parameters.append(pattern)
            predicate = f"{text_expr} LIKE ? ESCAPE '\\' COLLATE NOCASE"
            return f"NOT ({predicate})" if operator == "not_contains" else predicate
        if operator == "in":
            raw_values = value if isinstance(value, list) else str(value or "").split(",")
            values = [_coerce(item.strip() if isinstance(item, str) else item, spec.data_type)
                      for item in raw_values if str(item).strip()]
            if not values:
                return "0=1"
            if len(values) > 100:
                raise ValueError("属于任一值最多填写 100 项")
            parameters.extend(values)
            cast_expr = f"CAST({expr} AS REAL)" if spec.data_type in {"number", "boolean"} else text_expr
            return f"{cast_expr} IN ({','.join('?' for _ in values)})"
        if operator == "between":
            parameters.extend((_coerce(value, spec.data_type), _coerce(value2, spec.data_type)))
            cast_expr = f"CAST({expr} AS REAL)" if spec.data_type in {"number", "boolean"} else text_expr
            return f"{cast_expr} BETWEEN ? AND ?"
        sql_operator = {"eq": "=", "neq": "<>", "gt": ">", "gte": ">=", "lt": "<", "lte": "<="}[operator]
        parameters.append(_coerce(value, spec.data_type))
        cast_expr = f"CAST({expr} AS REAL)" if spec.data_type in {"number", "boolean"} else text_expr
        collate = " COLLATE NOCASE" if spec.data_type in {"text", "datetime"} and operator in {"eq", "neq"} else ""
        return f"{cast_expr} {sql_operator} ?{collate}"

    def group_sql(node: dict[str, Any], depth: int) -> str:
        if depth > MAX_FILTER_DEPTH:
            raise ValueError(f"筛选分组最多嵌套 {MAX_FILTER_DEPTH} 层")
        logic = "OR" if str(node.get("logic") or "and").lower() == "or" else "AND"
        parts: list[str] = []
        for child in node.get("children") or []:
            if not isinstance(child, dict):
                continue
            if isinstance(child.get("children"), list):
                nested = group_sql(child, depth + 1)
                if nested:
                    parts.append(nested)
            elif child.get("field"):
                parts.append(condition_sql(child))
        return f"({' {} '.format(logic).join(parts)})" if parts else ""

    return group_sql(group or {"logic": "and", "children": []}, 0), parameters, condition_count


def compile_sort(sort_items: list[dict[str, Any]] | None, specs: dict[str, FieldSpec], dataset: str,
                 group_threads: bool = False) -> str:
    output = []
    for item in (sort_items or [])[:4]:
        field = str(item.get("field") or "")
        spec = specs.get(field)
        if not spec:
            continue
        direction = "ASC" if str(item.get("direction") or "desc").lower() == "asc" else "DESC"
        output.append(f"{spec.expression} {direction}")
    if dataset == "comments" and group_threads:
        reply_predicate = "(c.comment_level>=2 OR TRIM(COALESCE(c.parent_comment_id,''))<>'')"
        root_id = (
            f"CASE WHEN {reply_predicate} THEN COALESCE(NULLIF(TRIM(c.parent_comment_id),''),c.comment_id) "
            "ELSE c.comment_id END"
        )
        root_seen = (
            f"CASE WHEN {reply_predicate} THEN COALESCE("
            "(SELECT rc.first_seen_at FROM comments rc WHERE rc.note_id=c.note_id "
            "AND rc.comment_id=c.parent_comment_id LIMIT 1),"
            "(SELECT MIN(gc.first_seen_at) FROM comments gc WHERE gc.note_id=c.note_id "
            "AND gc.parent_comment_id=c.parent_comment_id),c.first_seen_at) ELSE c.first_seen_at END"
        )
        thread_order = [
            f"{root_seen} DESC", "c.note_id ASC", f"{root_id} ASC",
            f"CASE WHEN c.comment_id={root_id} THEN 0 ELSE 1 END ASC",
        ]
        return ", ".join([
            *thread_order, *output,
            "COALESCE(NULLIF(c.published_at,''),c.first_seen_at) ASC", "c.first_seen_at ASC", "c.comment_id ASC",
        ])
    if not output:
        default_key = "first_seen_at" if "first_seen_at" in specs else ("note_id" if dataset == "notes" else "comment_id")
        output.append(f"{specs[default_key].expression} DESC")
    primary = "n.note_id" if dataset == "notes" else "c.comment_id"
    output.append(f"{primary} ASC")
    return ", ".join(output)


def search_clause(search: str, dataset: str) -> tuple[str, list[Any]]:
    value = str(search or "").strip()
    if not value:
        return "", []
    pattern = f"%{_escape_like(value)}%"
    expressions = ["n.note_id", "n.title", "n.author", "n.content", "n.tags", "n.keyword"]
    if dataset == "comments":
        expressions = ["c.comment_id", "c.note_id", "c.author", "c.content", *expressions]
    clause = "(" + " OR ".join(f"COALESCE(CAST({expr} AS TEXT),'') LIKE ? ESCAPE '\\' COLLATE NOCASE" for expr in expressions) + ")"
    return clause, [pattern] * len(expressions)
