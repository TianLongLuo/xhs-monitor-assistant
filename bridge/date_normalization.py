"""Deterministic, standard-library-only normalization of XHS date labels.

No clock, local timezone, filesystem, database, or network is consulted. Edited
labels describe the edit time; ``isEdited`` does not establish a publication time.
"""

import json
import math
import re
from datetime import date, datetime, time, timedelta, timezone

__all__ = ["normalize_xhs_datetime"]

_BEIJING_OFFSET = timedelta(hours=8)
_BEIJING = timezone(_BEIJING_OFFSET)
_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)
_MAX_SECONDS = (date.max - date.min).days * 86400 + 86399

# XHS normally appends an IP region, not arbitrary prose. Deliberately do not
# discard arbitrary trailing text: that could hide a second date or a bad clock.
_PROVINCES = frozenset(
    "河北 山西 辽宁 吉林 黑龙江 江苏 浙江 安徽 福建 江西 山东 河南 湖北 湖南 "
    "广东 海南 四川 贵州 云南 陕西 甘肃 青海 台湾".split()
)
_MUNICIPALITIES = frozenset("北京 天津 上海 重庆".split())
_REGIONS = (
    _PROVINCES
    | {name + "省" for name in _PROVINCES}
    | _MUNICIPALITIES
    | {name + "市" for name in _MUNICIPALITIES}
    | frozenset(
        "内蒙古 广西 西藏 宁夏 新疆 内蒙古自治区 广西壮族自治区 西藏自治区 "
        "宁夏回族自治区 新疆维吾尔自治区 香港 澳门 香港特别行政区 澳门特别行政区 "
        "中国香港 中国澳门 中国台湾 中国 中国大陆 中国内地 海外 "
        "美国 英国 加拿大 澳大利亚 新西兰 日本 韩国 新加坡 马来西亚 泰国 越南 "
        "印度尼西亚 菲律宾 柬埔寨 印度 法国 德国 意大利 西班牙 瑞士 瑞典 挪威 "
        "芬兰 丹麦 荷兰 爱尔兰 葡萄牙 比利时 奥地利 俄罗斯 巴西 墨西哥 "
        "阿根廷 智利 阿联酋 南非 沙特阿拉伯 土耳其 埃及 以色列 关岛".split()
    )
)
_REGION_PREFIX = re.compile(r"^(?:IP\s*属地\s*[:：]?\s*|来自\s*)", re.I)
_PREFIX = re.compile(r"^(编辑于|更新于|发布于)\s*[:：]?\s*")
_FULL_DATE = re.compile(
    r"(?P<year>[0-9]{4})(?:"
    r"(?P<sep>[-/.])(?P<month>[0-9]{1,2})(?P=sep)(?P<day>[0-9]{1,2})"
    r"|年(?P<zh_month>[0-9]{1,2})月(?P<zh_day>[0-9]{1,2})日)"
    r"(?P<tail>.*)",
    re.S,
)
_MONTH_DAY = re.compile(
    r"(?P<month>[0-9]{1,2})(?:[-/](?P<day>[0-9]{1,2})"
    r"|月(?P<zh_day>[0-9]{1,2})日)(?P<tail>.*)",
    re.S,
)
_REFERENCE_DATE = re.compile(
    r"(?P<year>[0-9]{4})-(?P<month>[0-9]{2})-(?P<day>[0-9]{2})"
    r"(?P<tail>(?:[Tt ].*)?)",
    re.S,
)
_CLOCK = re.compile(
    r"(?P<iso>[Tt])?(?P<hour>[0-9]{1,2}):(?P<minute>[0-9]{2})"
    r"(?::(?P<second>[0-9]{2})(?:[.,](?P<fraction>[0-9]{1,9}))?)?"
    r"(?P<zone>[Zz]|[+-][0-9]{2}(?::?[0-9]{2})?)?"
)
_INTERVAL = re.compile(r"(?P<count>[0-9]+|几|[零一二两三四五六七八九十]+)\s*(?P<unit>秒|分钟|小时|天)(?:之)?前(?P<tail>.*)", re.S)
_CHINESE_DIGITS = dict(zip("零一二三四五六七八九", range(10)))
_CHINESE_DIGITS["两"] = 2


def _duration_digits(value):
    """Only unambiguous Chinese 0-99; do not guess malformed/rounded phrases."""
    if value.isascii() and value.isdigit():
        return value.lstrip("0") or "0"
    if value in _CHINESE_DIGITS:
        return str(_CHINESE_DIGITS[value])
    if re.fullmatch(r"[一二三四五六七八九]?十[一二三四五六七八九]?", value):
        tens, units = value.split("十")
        return str((_CHINESE_DIGITS[tens] if tens else 1) * 10 + (_CHINESE_DIGITS[units] if units else 0))
    return None


_DAY_WORD = re.compile(r"(?P<word>今天|昨天|前天)(?P<tail>.*)", re.S)
_TIMESTAMP = re.compile(r"(?:[0-9]{10}|[0-9]{13})")
_UNITS = {
    "秒": ("seconds", "second", 1),
    "分钟": ("minutes", "minute", 60),
    "小时": ("hours", "hour", 3600),
    "天": ("days", "day", 86400),
}


def _json_raw(raw):
    """Keep text verbatim and JSON data by value; never use object repr/str."""
    try:
        return json.loads(json.dumps(raw, ensure_ascii=True, allow_nan=False))
    except Exception:
        # Cycles, non-finite numbers and arbitrary objects have no JSON value.
        # A stable type label avoids memory addresses and hostile __str__ hooks.
        try:
            return "<unsupported:{}>".format(type(raw).__name__)
        except Exception:
            return "<unsupported>"


def _region_suffix(text):
    text = text.strip()
    if not text:
        return True
    if text[0] in "·•":
        text = text[1:].strip()
    text = _REGION_PREFIX.sub("", text, count=1)
    return text in _REGIONS


def _zone(text):
    if not text:
        return _BEIJING
    if text.upper() == "Z":
        return timezone.utc
    digits = text[1:].replace(":", "")
    hours = int(digits[:2])
    minutes = int(digits[2:] or "0")
    if hours > 23 or minutes > 59:
        raise ValueError("invalid UTC offset")
    sign = 1 if text[0] == "+" else -1
    return timezone(sign * timedelta(hours=hours, minutes=minutes))


def _tail(text, *, allow_zone=False, allow_region=True):
    """Return (optional clock, precision), or reject the entire suffix."""
    text = text.strip()
    match = _CLOCK.match(text)
    if match is None:
        if not text or (allow_region and _region_suffix(text)):
            return None, "day"
        raise ValueError("invalid date suffix")
    if not allow_zone and (match["iso"] or match["zone"]):
        raise ValueError("relative labels use Beijing calendar days")
    remainder = text[match.end():].strip()
    if remainder and (not allow_region or not _region_suffix(remainder)):
        raise ValueError("invalid clock suffix")
    fraction = (match["fraction"] or "")[:6].ljust(6, "0")
    clock = time(
        int(match["hour"]), int(match["minute"]), int(match["second"] or "0"),
        int(fraction), tzinfo=_zone(match["zone"]),
    )
    return clock, "second" if match["second"] is not None else "minute"


def _in_beijing(value):
    # astimezone can overflow via its intermediate UTC value near year 1/9999,
    # even when the final Beijing time fits. Offset arithmetic avoids that and
    # never asks the host OS to interpret a naive datetime.
    offset = value.utcoffset()
    if offset is None:
        offset = _BEIJING_OFFSET
    local = value.replace(tzinfo=None) + (_BEIJING_OFFSET - offset)
    return local.replace(tzinfo=_BEIJING)


def _reference(observed_at):
    """Invalid references act like absent ones, including broken tzinfo hooks."""
    try:
        if isinstance(observed_at, datetime):
            value = observed_at
        elif isinstance(observed_at, str):
            match = _REFERENCE_DATE.fullmatch(observed_at.strip())
            if match is None:
                return None
            day = date(int(match["year"]), int(match["month"]), int(match["day"]))
            clock, _ = _tail(match["tail"], allow_zone=True, allow_region=False)
            value = datetime.combine(day, clock or time(tzinfo=_BEIJING))
        else:
            return None
        value = _in_beijing(value)
        # Canonical builtin datetime, even when a caller supplied a subclass.
        return datetime(
            value.year, value.month, value.day, value.hour, value.minute,
            value.second, value.microsecond, tzinfo=_BEIJING,
        )
    except Exception:
        return None


def _needs_reference(result, precision, source):
    result.update(precision=precision, status="needs_reference", source=source)
    return result


def _day_result(result, value, reference, status, source):
    if reference is not None and value > reference.date():
        return result
    result.update(value=value.isoformat(), precision="day", status=status, source=source)
    # Do not manufacture a midnight timestamp for a day-only label.
    return result


def _instant_result(result, value, reference, precision, status, source):
    value = _in_beijing(value)
    if reference is not None and value > reference:
        return result
    value = value.replace(microsecond=0)
    elapsed = value - _EPOCH
    result.update(
        value=value.replace(tzinfo=None).isoformat(sep=" ", timespec="seconds"),
        timestamp=elapsed.days * 86400 + elapsed.seconds,
        precision=precision, status=status, source=source,
    )
    return result


def _timestamp_result(result, text, reference):
    number = int(text)
    delta = timedelta(milliseconds=number) if len(text) == 13 else timedelta(seconds=number)
    return _instant_result(result, _EPOCH + delta, reference, "second", "exact", "absolute")


def _normalize(raw, reference, result):
    if raw is None:
        result["status"] = "missing"
        return result
    raw_type = type(raw)
    if raw_type is int or raw_type is float:
        # bool is intentionally excluded, as are fractional numeric timestamps.
        if raw_type is float and (not math.isfinite(raw) or not raw.is_integer()):
            return result
        if not (10**9 <= raw < 10**10 or 10**12 <= raw < 10**13):
            return result
        return _timestamp_result(result, str(int(raw)), reference)
    # isinstance can consult an arbitrary object's hostile __class__ property.
    if not issubclass(raw_type, str):
        return result
    text = str.strip(raw)
    if not text or text in {"未显示", "未知", "待读取", "暂无", "—", "-", "--"}:
        result["status"] = "missing"
        return result
    prefix = _PREFIX.match(text)
    if prefix:
        result["isEdited"] = prefix[1] in {"编辑于", "更新于"}
        text = text[prefix.end():].strip()
    if _TIMESTAMP.fullmatch(text):
        return _timestamp_result(result, text, reference)

    match = _FULL_DATE.fullmatch(text)
    if match:
        day = date(
            int(match["year"]), int(match["month"] or match["zh_month"]),
            int(match["day"] or match["zh_day"]),
        )
        clock, precision = _tail(match["tail"], allow_zone=True)
        if clock is None:
            return _day_result(result, day, reference, "exact", "absolute")
        return _instant_result(
            result, datetime.combine(day, clock), reference, precision, "exact", "absolute",
        )

    match = _MONTH_DAY.fullmatch(text)
    if match:
        month, day_number = int(match["month"]), int(match["day"] or match["zh_day"])
        # A leap year validates the month/day without rejecting February 29.
        date(2000, month, day_number)
        clock, precision = _tail(match["tail"])
        if reference is None:
            return _needs_reference(result, precision, "inferred_year")
        for year in range(reference.year, 0, -1):
            try:
                day = date(year, month, day_number)
            except ValueError:
                continue
            if clock is None and day <= reference.date():
                return _day_result(result, day, reference, "estimated", "inferred_year")
            if clock is not None:
                instant = datetime.combine(day, clock)
                if instant <= reference:
                    return _instant_result(
                        result, instant, reference, precision, "estimated", "inferred_year",
                    )
        return result

    if text.startswith("刚刚") and _region_suffix(text[2:]):
        if reference is None:
            return _needs_reference(result, "second", "relative")
        return _instant_result(result, reference, reference, "second", "estimated", "relative")

    match = _DAY_WORD.fullmatch(text)
    if match:
        clock, precision = _tail(match["tail"])
        if reference is None:
            return _needs_reference(result, precision, "relative")
        day = reference.date() - timedelta(days={"今天": 0, "昨天": 1, "前天": 2}[match["word"]])
        if clock is None:
            return _day_result(result, day, reference, "estimated", "relative")
        return _instant_result(
            result, datetime.combine(day, clock), reference, precision, "estimated", "relative",
        )

    match = _INTERVAL.fullmatch(text)
    if match:
        unit, precision, scale = _UNITS[match["unit"]]
        clock = None
        if unit == "days":
            clock, precision = _tail(match["tail"])
        elif not _region_suffix(match["tail"]):
            return result
        if match["count"] == "几":
            # A reference is necessary but not sufficient for an unknown count.
            # Do not invent a numerical meaning for the literal word "几".
            return _needs_reference(result, precision, "relative") if reference is None else result
        digits = _duration_digits(match["count"])
        if digits is None or len(digits) > 12 or int(digits) > _MAX_SECONDS // scale:
            return result
        count = int(digits)
        if reference is None:
            return _needs_reference(result, precision, "relative")
        delta = timedelta(**{unit: count})
        if unit == "days":
            day = reference.date() - delta
            if clock is None:
                return _day_result(result, day, reference, "estimated", "relative")
            return _instant_result(
                result, datetime.combine(day, clock), reference, precision, "estimated", "relative",
            )
        # Keep reference minutes/seconds for N hours ago; precision records the
        # source granularity, not an instruction to round to the start of an hour.
        return _instant_result(
            result, reference - delta, reference, precision, "estimated", "relative",
        )
    return result


def normalize_xhs_datetime(raw, observed_at=None) -> dict:
    """Return a JSON-serializable normalization record without reading "now".

    ``raw`` accepts date-label strings or 10/13-digit timestamps (integers,
    integral floats, or digit strings). Strings are preserved verbatim in the
    output, including whitespace, prefixes, and region suffixes. JSON-native
    non-text inputs are copied; non-JSON inputs use a stable unsupported-type
    label and are not parsed.

    ``observed_at`` accepts an ISO calendar-date/datetime string or datetime.
    Z and numeric UTC offsets are converted to fixed UTC+08:00; naive references
    use Beijing time. Date-only references explicitly mean local midnight.
    Invalid references act like None. ``referenceAt`` preserves microseconds.

    Absolute inputs are ``exact``; relative and inferred-year inputs are
    ``estimated``. Valid reference-dependent labels without a reference are
    ``needs_reference``. An unquantified literal "几" stays empty even with a
    reference. Invalid, unsupported, or reference-future values are
    ``unrecognized``; None/blank raw inputs are ``missing``. Without a reference,
    absolute values can be decoded but cannot be checked against a future limit.

    ``value`` is a Beijing YYYY-MM-DD HH:mm:ss or YYYY-MM-DD string. Minute
    clocks use :00 seconds with precision=minute. N hours/minutes/seconds ago
    subtract from the supplied reference without rounding away its clock.
    Day-only inputs always have timestamp=None. Other timestamps are integer
    Unix seconds, flooring subsecond input; precision describes the source.
    Unresolved values are ''/None, never a fabricated date or timestamp.
    Yearless dates search backwards for the most recent non-future valid year,
    including leap years and any explicit clock. Known region suffixes are
    accepted; unknown trailing text is rejected in its entirety.

    ``isEdited`` marks the 编辑于/更新于 prefixes. Callers must not promote an edit
    time to an original publication time. This module performs no I/O.
    """
    reference = _reference(observed_at)
    result = {
        "raw": _json_raw(raw),
        "value": "",
        "timestamp": None,
        "precision": "unknown",
        "status": "unrecognized",
        "source": "",
        "referenceAt": reference.isoformat() if reference is not None else "",
        "isEdited": False,
    }
    try:
        return _normalize(raw, reference, result)
    except (ValueError, OverflowError, TypeError):
        # Invalid calendars, clocks, out-of-range arithmetic, and malformed
        # offsets never escape to a storage/export caller.
        return result
