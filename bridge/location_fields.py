"""IP-region projections from displayed metadata, never real network IPs.

The unmodified ipLocation/publishedAt source remains available for auditing.
No geolocation, author inference, network access or wall clock is used.
"""
from __future__ import annotations

import re
from typing import Any

try:
    from .date_normalization import _REGIONS, normalize_xhs_datetime
except ImportError:
    from date_normalization import _REGIONS, normalize_xhs_datetime

LOCATION_VERSION = 1
REGION_KEYS = ("ipRegion", "ipRegionSource", "ipRegionVersion")
REGION_HEADERS = {"note": "帖子IP属地", "comment": "评论IP属地"}
PREFIX = re.compile(r"^(?:IP\s*(?:属地|所在地)|来自)\s*[:：]?\s*", re.I)


def extract_region(value: Any) -> str:
    if not isinstance(value, str) or len(value) > 200:
        return ""
    raw = re.sub(r"\s+", " ", value).strip()
    plain = PREFIX.sub("", raw)
    if plain in _REGIONS:
        return plain
    for region in sorted(_REGIONS, key=len, reverse=True):
        if not raw.endswith(region):
            continue
        before = raw[:-len(region)].strip().rstrip("·• ")
        before = re.sub(r"(?:IP\s*(?:属地|所在地)|来自)\s*[:：]?\s*$", "", before, flags=re.I).strip().rstrip("·• ")
        # A complete supported time label must precede a suffix. Prose such as
        # '我来自四川' and content that merely mentions a region are not evidence.
        parsed = normalize_xhs_datetime(before)
        if parsed.get("status") not in {"missing", "unrecognized"}:
            return region
    return ""


def enrich_location_payload(payload: dict[str, Any], *, kind: str = "note") -> dict[str, Any]:
    result = dict(payload)
    explicit = extract_region(payload.get("ipLocation"))
    region = explicit or extract_region(payload.get("publishedAt"))
    if not region and kind == "note":
        region = extract_region(payload.get("updatedAt"))
    result.update(ipRegion=region, ipRegionSource="page_metadata" if explicit else "time_label" if region else "not_displayed",
                  ipRegionVersion=LOCATION_VERSION)
    return result


def csv_region_fields(payload: dict[str, Any], *, kind: str = "note") -> dict[str, str]:
    # Older payloads must still pass pre-migration consistency checks. Only the
    # journalled enrichment publishes these new fields into all stores together.
    if payload.get("ipRegionVersion") != LOCATION_VERSION:
        return {}
    return {REGION_HEADERS[kind]: str(payload.get("ipRegion") or "")}
