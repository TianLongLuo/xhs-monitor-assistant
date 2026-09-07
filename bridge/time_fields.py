"""Additive publication-time projections; source strings and record IDs stay intact."""
from __future__ import annotations

from typing import Any

try:
    from .date_normalization import normalize_xhs_datetime
    from .location_fields import enrich_location_payload, csv_region_fields
except ImportError:
    from date_normalization import normalize_xhs_datetime
    from location_fields import enrich_location_payload, csv_region_fields


TIME_NORMALIZATION_VERSION = 2
NOTE_TIME_HEADERS = [
    "发布时间（标准）", "更新时间（标准）", "时间采集基准",
    "发布时间精度", "发布时间说明", "更新时间精度", "更新时间说明", "帖子IP属地",
]
COMMENT_TIME_HEADERS = ["评论时间（标准）", "时间采集基准", "评论时间精度", "评论时间说明", "评论IP属地"]


def _text(value: Any) -> str:
    return "" if value is None else str(value).strip()


def _time(raw: Any, reference: Any, reference_source: str) -> dict[str, Any]:
    result = normalize_xhs_datetime(raw, reference)
    result["normalizationVersion"] = TIME_NORMALIZATION_VERSION
    result["referenceSource"] = reference_source if result.get("referenceAt") else ""
    return result


def latest_observation_reference(*values: Any) -> str:
    candidates = []
    for value in values:
        parsed = normalize_xhs_datetime(value)
        if parsed.get("timestamp") is not None:
            candidates.append((parsed["timestamp"], _text(value)))
    return max(candidates)[1] if candidates else ""


def enrich_time_payload(
    payload: dict[str, Any], reference: Any = None, *, kind: str = "note",
    previous: dict[str, Any] | None = None, reference_source: str = "capture",
) -> dict[str, Any]:
    """Normalize against the observation instant, never the time of viewing/exporting.

    The caller supplies a capture timestamp for new observations. For historical
    rows it supplies the last real collection timestamp, not a CSV import date.
    A persisted observation instant wins over such a fallback on later reloads.
    """
    result = dict(payload)
    prior = previous or {}
    observed = _text(payload.get("timeObservedAt"))
    if (observed and prior and reference
            and observed == _text(prior.get("timeObservedAt"))
            and any(_text(payload.get(key)) != _text(prior.get(key)) for key in ("publishedAt", "updatedAt"))):
        # A pre-upgrade content script may omit the observation field. A newly
        # changed source string must not inherit an older row's capture clock.
        observed = _text(reference)
    if not observed:
        prior_time = payload.get("publishedTime") or prior.get("publishedTime") or {}
        if isinstance(prior_time, dict) and _text(prior_time.get("raw")) == _text(payload.get("publishedAt")):
            observed = _text(prior_time.get("referenceAt"))
            reference_source = _text(prior_time.get("referenceSource")) or reference_source
    reference = observed or reference
    if observed:
        reference_source = _text(payload.get("timeReferenceSource")) or reference_source

    published = _time(payload.get("publishedAt"), reference, reference_source)
    if kind == "note":
        updated_raw = payload.get("updatedAt")
        updated = _time(updated_raw, reference, reference_source)
        if published.get("isEdited"):
            if not updated.get("value"):
                updated = dict(published)
            # User-selected timeline convention: display the last edit time in
            # the publication column when that is all the page exposes. Keep an
            # explicit provenance status rather than claim it is first publish.
            if published.get("value"):
                published = {**published, "status": "estimated_from_edit", "basis": "last_edit_time"}
        result["updatedTime"] = updated
    result["publishedTime"] = published
    reference_at = published.get("referenceAt") or result.get("updatedTime", {}).get("referenceAt") or ""
    if reference_at:
        result["timeObservedAt"] = reference_at
        result["timeReferenceSource"] = reference_source
    return enrich_location_payload(result, kind=kind)


def time_description(metadata: dict[str, Any] | None) -> str:
    meta = metadata or {}
    status = meta.get("status")
    source = meta.get("source")
    if status == "edited_only":
        return "页面仅显示编辑时间；见标准更新时间"
    if status == "needs_reference":
        return "缺少原始采集时点，待重新拉取"
    if status == "unrecognized":
        return "原始时间待核验"
    if status == "missing":
        return "页面未显示"
    if source == "inferred_year":
        description = "年份按采集时点推定"
    elif source == "relative":
        description = "按采集时点倒推" + ("（约）" if status in {"estimated", "estimated_from_edit"} else "")
    else:
        description = "原始绝对日期" if meta.get("precision") == "day" else "原始绝对时间"
    if meta.get("referenceSource") == "historical_collection" and source in {"relative", "inferred_year"}:
        description += "；基于历史采集记录"
    if status == "estimated_from_edit":
        description = "编辑时间推算（非首次发布时间）；" + description
    return description


def csv_time_fields(payload: dict[str, Any], *, kind: str = "note") -> dict[str, str]:
    published = payload.get("publishedTime") if isinstance(payload.get("publishedTime"), dict) else {}
    precision = {"second": "秒", "minute": "分钟", "hour": "小时（约）", "day": "日", "unknown": "未知"}
    if kind == "comment":
        return {
            **csv_region_fields(payload, kind=kind),
            "评论时间（标准）": _text(published.get("value")),
            "时间采集基准": _text(payload.get("timeObservedAt")),
            "评论时间精度": precision.get(published.get("precision"), ""),
            "评论时间说明": time_description(published) if published else "",
        }
    updated = payload.get("updatedTime") if isinstance(payload.get("updatedTime"), dict) else {}
    return {
        **csv_region_fields(payload, kind=kind),
        "发布时间（标准）": _text(published.get("value")),
        "更新时间（标准）": _text(updated.get("value")),
        "时间采集基准": _text(payload.get("timeObservedAt")),
        "发布时间精度": precision.get(published.get("precision"), ""),
        "发布时间说明": time_description(published) if published else "",
        "更新时间精度": precision.get(updated.get("precision"), ""),
        "更新时间说明": time_description(updated) if updated else "",
    }
