"""Isolated tests: no server imports, business files, or clock-dependent data."""

import json
import unittest
from datetime import datetime, timedelta, timezone, tzinfo
from unittest.mock import patch

if __package__:
    from . import date_normalization as normalization
else:
    import date_normalization as normalization

normalize_xhs_datetime = normalization.normalize_xhs_datetime
BEIJING = timezone(timedelta(hours=8))
REFERENCE = "2026-01-02T00:30:45+08:00"


class DateNormalizationTests(unittest.TestCase):
    def assert_record(
        self, raw, value, precision, status="exact", source="absolute",
        observed_at=REFERENCE, edited=False,
    ):
        result = normalize_xhs_datetime(raw, observed_at)
        self.assertEqual(result["raw"], raw)
        self.assertEqual(result["value"], value)
        self.assertEqual(result["precision"], precision)
        self.assertEqual(result["status"], status)
        self.assertEqual(result["source"], source)
        self.assertIs(result["isEdited"], edited)
        expected_timestamp = None
        if value and precision != "day":
            expected_timestamp = int(datetime.fromisoformat(value).replace(tzinfo=BEIJING).timestamp())
        self.assertEqual(result["timestamp"], expected_timestamp)
        self.assertEqual(json.loads(json.dumps(result, allow_nan=False)), result)
        return result

    def assert_empty(self, raw, observed_at=REFERENCE, status="unrecognized"):
        result = normalize_xhs_datetime(raw, observed_at)
        self.assertEqual(result["value"], "")
        self.assertIsNone(result["timestamp"])
        self.assertEqual(result["status"], status)
        if status == "unrecognized":
            self.assertEqual(result["precision"], "unknown")
            self.assertEqual(result["source"], "")
        self.assertEqual(json.loads(json.dumps(result, allow_nan=False)), result)
        return result

    def test_exact_output_contract(self):
        self.assertEqual(normalize_xhs_datetime("2025-12-04四川", REFERENCE), {
            "raw": "2025-12-04四川", "value": "2025-12-04", "timestamp": None,
            "precision": "day", "status": "exact", "source": "absolute",
            "referenceAt": REFERENCE, "isEdited": False,
        })

    def test_absolute_calendar_formats(self):
        for raw in (
            "2025-12-04", "2025/12/04", "2025年12月04日", "2025年12月4日",
            "2025-12-4", "2025/12/4广东", "2025年12月4日四川",
        ):
            with self.subTest(raw=raw):
                self.assert_record(raw, "2025-12-04", "day")

    def test_absolute_minute_clocks_and_regions(self):
        for raw in (
            "2025-12-04 23:11", "2025/12/04 23:11 广东", "2025年12月4日23:11上海",
            "2025-12-04T23:11", "2025-12-04 23:11四川省",
            "2025-12-04 23:11 · 上海", "2025-12-04 23:11 IP属地：广东",
        ):
            with self.subTest(raw=raw):
                self.assert_record(raw, "2025-12-04 23:11:00", "minute")

    def test_absolute_second_clocks(self):
        for raw in ("2025-12-04 09:02:03四川", "2025/12/04 9:02:03", "2025年12月4日09:02:03"):
            with self.subTest(raw=raw):
                self.assert_record(raw, "2025-12-04 09:02:03", "second")

    def test_full_raw_text_preserved(self):
        raw = " \t编辑于 2025年12月4日 23:11:09 广东\r\n"
        self.assert_record(raw, "2025-12-04 23:11:09", "second", edited=True)

    def test_region_labels(self):
        for region in (
            "北京", "上海市", "四川", "广东省", "内蒙古", "广西壮族自治区",
            "西藏自治区", "宁夏回族自治区", "新疆维吾尔自治区", "中国香港",
            "澳门特别行政区", "台湾", "英国", "新加坡", "美国", "海外",
            "·广东", "• 上海", "IP属地: 北京", "来自四川",
        ):
            with self.subTest(region=region):
                self.assert_record("2025-12-04 " + region, "2025-12-04", "day")

    def test_unknown_or_malformed_suffix_is_not_discarded(self):
        for raw in (
            "2025-12-04乱码内容", "2025-12-04 foo", "2025-12-04 编辑于昨天",
            "2025-12-04 2025-12-05", "2025-12-04四川25:00", "2025-12-04 23:11:00x",
            "2025-12-04·", "2025-12-04 IP属地：", "日期是2025-12-04", "昨天上海23:11",
        ):
            with self.subTest(raw=raw):
                self.assert_empty(raw)

    def test_iso_utc_and_offset_cross_year(self):
        cases = (
            ("2025-12-31T16:30:45Z", "2026-01-01 00:30:45", "second"),
            ("2025-12-31T16:30:45z", "2026-01-01 00:30:45", "second"),
            ("2026-01-01T00:30:45+08:00", "2026-01-01 00:30:45", "second"),
            ("2025-12-31T11:30:45-05:00", "2026-01-01 00:30:45", "second"),
            ("2026-01-01T00:30:45+0800", "2026-01-01 00:30:45", "second"),
            ("2026-01-01T00:30:45+08", "2026-01-01 00:30:45", "second"),
            ("2025-12-31T23:30+05:30", "2026-01-01 02:00:00", "minute"),
            ("2026-01-01T00:30:45+09:00", "2025-12-31 23:30:45", "second"),
            ("2025-12-31T16:30Z上海", "2026-01-01 00:30:00", "minute"),
        )
        for raw, value, precision in cases:
            with self.subTest(raw=raw):
                self.assert_record(raw, value, precision)

    def test_iso_fraction_is_floored_to_seconds(self):
        for fraction in (".123", ".999999", ",123456", ".123456789"):
            with self.subTest(fraction=fraction):
                self.assert_record("2025-12-31T16:30:45" + fraction + "Z", "2026-01-01 00:30:45", "second")

    def test_seconds_and_milliseconds_as_numbers_and_strings(self):
        for raw in (
            1700000000, "1700000000", 1700000000.0,
            1700000000123, "1700000000123", 1700000000123.0, " 1700000000123 ",
            "发布于 1700000000",
        ):
            with self.subTest(raw=raw):
                result = self.assert_record(raw, "2023-11-15 06:13:20", "second")
                self.assertEqual(result["timestamp"], 1700000000)

    def test_digit_string_epoch_retains_zero_timestamp(self):
        for raw in ("0000000000", "0000000000000"):
            with self.subTest(raw=raw):
                result = self.assert_record(raw, "1970-01-01 08:00:00", "second")
                self.assertEqual(result["timestamp"], 0)

    def test_invalid_timestamp_widths_and_types(self):
        for raw in (
            True, False, 0, 123, 999999999, 10000000000, 100000000000,
            10000000000000, -1700000000, 1700000000.5,
            "1700000000.0", "1.7e9", "+1700000000", "-1700000000", "17000000000",
            "１７００００００００", "1700000000广东",
        ):
            with self.subTest(raw=raw):
                self.assert_empty(raw)

    def test_equivalent_reference_forms(self):
        references = (
            REFERENCE, "2026-01-01T16:30:45Z", "2026-01-01T16:30:45z",
            "2026-01-01T11:30:45-05:00", "2026-01-02T00:30:45+0800",
            "2026-01-02T00:30:45", "2026-01-02 00:30:45",
            datetime(2026, 1, 2, 0, 30, 45),
            datetime(2026, 1, 2, 0, 30, 45, tzinfo=BEIJING),
            datetime(2026, 1, 1, 16, 30, 45, tzinfo=timezone.utc),
            datetime(2026, 1, 1, 11, 30, 45, tzinfo=timezone(timedelta(hours=-5))),
        )
        expected = normalize_xhs_datetime("昨天23:11上海", REFERENCE)
        for reference in references:
            with self.subTest(reference=reference):
                self.assertEqual(normalize_xhs_datetime("昨天23:11上海", reference), expected)

    def test_date_only_reference_is_explicit_midnight(self):
        result = self.assert_record(
            "刚刚", "2026-01-02 00:00:00", "second", "estimated", "relative",
            observed_at="2026-01-02",
        )
        self.assertEqual(result["referenceAt"], "2026-01-02T00:00:00+08:00")

    def test_reference_microseconds_preserved_but_output_is_second_precision(self):
        result = self.assert_record(
            "1小时前", "2026-01-01 23:30:45", "hour", "estimated", "relative",
            observed_at="2026-01-01T16:30:45.123456Z",
        )
        self.assertEqual(result["referenceAt"], "2026-01-02T00:30:45.123456+08:00")

    def test_invalid_references_do_not_break_absolute_parsing(self):
        for reference in (
            "", "not-a-date", "2025-02-29T00:00:00Z", "2026-01-02T24:00:00+08:00",
            "2026-01-02T00:30:45+08:60", "2026-01-02T00:30:45+24:00",
            "2026-01-02 上海", 1700000000, [], {}, True, object(),
        ):
            with self.subTest(reference=reference):
                absolute = self.assert_record("2025-12-04", "2025-12-04", "day", observed_at=reference)
                self.assertEqual(absolute["referenceAt"], "")
                relative = self.assert_empty("昨天23:11上海", reference, "needs_reference")
                self.assertEqual(relative["referenceAt"], "")

    def test_broken_reference_timezone_does_not_raise(self):
        class BrokenZone(tzinfo):
            def utcoffset(self, dt):
                raise RuntimeError("bad caller timezone")

        self.assert_empty("昨天", datetime(2026, 1, 2, tzinfo=BrokenZone()), "needs_reference")

    def test_reference_dependent_inputs_need_a_reference(self):
        cases = (
            ("刚刚", "second", "relative"), ("15秒前", "second", "relative"),
            ("5分钟前广东", "minute", "relative"), ("2小时前", "hour", "relative"),
            ("3天前", "day", "relative"), ("今天", "day", "relative"),
            ("昨天23:11上海", "minute", "relative"), ("前天", "day", "relative"),
            ("12-31", "day", "inferred_year"), ("02月29日", "day", "inferred_year"),
            ("12-31 23:11", "minute", "inferred_year"),
        )
        for raw, precision, source in cases:
            with self.subTest(raw=raw):
                result = self.assert_empty(raw, None, "needs_reference")
                self.assertEqual(result["precision"], precision)
                self.assertEqual(result["source"], source)
                self.assertEqual(result["referenceAt"], "")

    def test_absolute_inputs_do_not_require_or_invent_reference(self):
        for raw, value, precision in (
            ("2025-12-04四川", "2025-12-04", "day"),
            ("2025-12-04 23:11", "2025-12-04 23:11:00", "minute"),
            ("2099-12-31", "2099-12-31", "day"),
            (1700000000123, "2023-11-15 06:13:20", "second"),
        ):
            with self.subTest(raw=raw):
                result = self.assert_record(raw, value, precision, observed_at=None)
                self.assertEqual(result["referenceAt"], "")

    def test_relative_seconds_minutes_and_hours_retain_reference_clock(self):
        cases = (
            ("刚刚广东", "2026-01-02 00:30:45", "second"),
            ("15秒前", "2026-01-02 00:30:30", "second"),
            ("60秒前 上海", "2026-01-02 00:29:45", "second"),
            ("5分钟前四川", "2026-01-02 00:25:45", "minute"),
            ("31分钟前", "2026-01-01 23:59:45", "minute"),
            ("2小时前", "2026-01-01 22:30:45", "hour"),
            ("25小时前 上海", "2025-12-31 23:30:45", "hour"),
            ("0小时前", "2026-01-02 00:30:45", "hour"),
            ("0002小时前", "2026-01-01 22:30:45", "hour"),
        )
        for raw, value, precision in cases:
            with self.subTest(raw=raw):
                self.assert_record(raw, value, precision, "estimated", "relative")

    def test_calendar_relative_dates_never_manufacture_midnight(self):
        for raw, value in (
            ("3天前", "2025-12-30"), ("7天前 广东", "2025-12-26"),
            ("0天前", "2026-01-02"), ("今天上海", "2026-01-02"),
            ("昨天", "2026-01-01"), ("前天四川", "2025-12-31"),
        ):
            with self.subTest(raw=raw):
                self.assert_record(raw, value, "day", "estimated", "relative")

    def test_adjacent_calendar_word_clock_and_region(self):
        for raw, value, precision in (
            ("昨天23:11上海", "2026-01-01 23:11:00", "minute"),
            ("前天23:11:09四川", "2025-12-31 23:11:09", "second"),
            ("今天00:15广东", "2026-01-02 00:15:00", "minute"),
            ("3天前23:11上海", "2025-12-30 23:11:00", "minute"),
        ):
            with self.subTest(raw=raw):
                self.assert_record(raw, value, precision, "estimated", "relative")

    def test_relative_crosses_leap_day_and_year(self):
        cases = (
            ("昨天23:11上海", "2024-03-01T00:30:45+08:00", "2024-02-29 23:11:00", "minute"),
            ("3天前", "2024-03-02T12:00:00+08:00", "2024-02-28", "day"),
            ("前天", "2026-01-01T00:30:45+08:00", "2025-12-30", "day"),
            ("2小时前", "2026-01-01T00:30:45+08:00", "2025-12-31 22:30:45", "hour"),
        )
        for raw, reference, value, precision in cases:
            with self.subTest(raw=raw, reference=reference):
                self.assert_record(raw, value, precision, "estimated", "relative", reference)

    def test_edit_and_publish_prefixes(self):
        self.assert_record("编辑于 7天前 广东", "2025-12-26", "day", "estimated", "relative", edited=True)
        self.assert_record("发布于2025-12-04四川", "2025-12-04", "day")
        self.assert_record("编辑于：2025-12-04 23:11", "2025-12-04 23:11:00", "minute", edited=True)
        self.assert_record("编辑于1700000000123", "2023-11-15 06:13:20", "second", edited=True)

    def test_edit_flag_survives_unresolved_or_invalid_date(self):
        self.assertIs(self.assert_empty("编辑于 7天前 广东", None, "needs_reference")["isEdited"], True)
        for raw in ("编辑于2025-02-30", "编辑于 ???", "编辑于"):
            with self.subTest(raw=raw):
                self.assertIs(self.assert_empty(raw)["isEdited"], True)

    def test_edit_time_is_not_synthesized_into_publication_fields(self):
        edited = normalize_xhs_datetime("编辑于 7天前 广东", REFERENCE)
        ordinary = normalize_xhs_datetime("7天前 广东", REFERENCE)
        self.assertEqual(set(edited), set(ordinary))
        self.assertNotIn("publishedAt", edited)
        self.assertNotIn("createdAt", edited)
        for key in edited.keys() - {"raw", "isEdited"}:
            self.assertEqual(edited[key], ordinary[key])
        self.assert_empty("发布于2025-12-01 编辑于2025-12-04")

    def test_yearless_dates_choose_latest_nonfuture_year(self):
        for raw, value in (
            ("12-31", "2025-12-31"), ("12月31日四川", "2025-12-31"),
            ("01-02", "2026-01-02"), ("1月1日", "2026-01-01"),
            ("01-03", "2025-01-03"), ("12/31", "2025-12-31"),
        ):
            with self.subTest(raw=raw):
                self.assert_record(raw, value, "day", "estimated", "inferred_year")

    def test_yearless_clocks_participate_in_nonfuture_check(self):
        for raw, value, precision in (
            ("01-02 00:31", "2025-01-02 00:31:00", "minute"),
            ("01月02日00:30:45上海", "2026-01-02 00:30:45", "second"),
            ("12-31 23:11", "2025-12-31 23:11:00", "minute"),
        ):
            with self.subTest(raw=raw):
                self.assert_record(raw, value, precision, "estimated", "inferred_year")

    def test_yearless_leap_day_searches_past_nonleap_years(self):
        cases = (
            ("2025-03-01T12:00:00+08:00", "2024-02-29"),
            ("2024-02-28T12:00:00+08:00", "2020-02-29"),
            ("2024-02-29T12:00:00+08:00", "2024-02-29"),
            ("2100-03-01T12:00:00+08:00", "2096-02-29"),
            ("2000-02-28T12:00:00+08:00", "1996-02-29"),
            ("1900-03-01T12:00:00+08:00", "1896-02-29"),
        )
        for reference, value in cases:
            with self.subTest(reference=reference):
                self.assert_record("02月29日四川", value, "day", "estimated", "inferred_year", reference)

    def test_missing_raw(self):
        for raw in (None, "", " ", "\t\r\n\u3000"):
            with self.subTest(raw=raw):
                result = self.assert_empty(raw, status="missing")
                self.assertEqual(result["raw"], raw)
                self.assertEqual(result["referenceAt"], REFERENCE)

    def test_invalid_calendar_dates(self):
        for raw in (
            "2025-02-29", "2024-02-30", "1900-02-29", "2025/04/31",
            "2025年13月01日", "2025-00-01", "2025-01-00", "2025-01-32",
            "0000-01-01", "10000-01-01", "2025/12-04", "2025-12/04",
            "02-30", "13-01", "00月01日", "01月00日", "02月30日",
        ):
            for reference in (REFERENCE, None):
                with self.subTest(raw=raw, reference=reference):
                    self.assert_empty(raw, reference)

    def test_valid_leap_dates_and_small_year_padding(self):
        for raw in ("2000-02-29", "2024-02-29", "0001-01-01", "0999-12-31"):
            with self.subTest(raw=raw):
                self.assert_record(raw, raw, "day")
        self.assert_record("0001-01-01 00:00:00", "0001-01-01 00:00:00", "second", observed_at=None)

    def test_timezone_conversion_at_calendar_limits_avoids_intermediate_overflow(self):
        for raw, value in (
            ("0001-01-01T00:00:00+08:00", "0001-01-01 00:00:00"),
            ("0001-01-01T01:00:00+09:00", "0001-01-01 00:00:00"),
            ("9999-12-31T00:00:00-01:00", "9999-12-31 09:00:00"),
        ):
            with self.subTest(raw=raw):
                result = self.assert_record("刚刚", value, "second", "estimated", "relative", raw)
                self.assertEqual(result["referenceAt"], value.replace(" ", "T") + "+08:00")
                self.assert_record(raw, value, "second", observed_at=None)

    def test_invalid_clocks_and_offsets(self):
        for raw in (
            "2025-12-04 24:00", "2025-12-04 23:60", "2025-12-04 23:59:60",
            "2025-12-04 9:1", "2025-12-04 12:30.5", "2025-12-04T",
            "2025-12-04Z", "2025-12-04 12:00+24:00", "2025-12-04 12:00+08:60",
            "2025-12-04 12:00-07:99", "2025-12-04 12:00+8:00",
            "昨天25:00上海", "昨天23:61", "今天23:11Z", "02-29 24:00",
            "2小时前23:11", "3天前25:00", "刚刚23:11",
        ):
            for reference in (REFERENCE, None):
                with self.subTest(raw=raw, reference=reference):
                    self.assert_empty(raw, reference)

    def test_future_dates_and_instants_rejected_with_reference(self):
        for raw in (
            "2026-01-03", "2026-01-02 00:30:46", "2026-01-02T00:30:46+08:00",
            "2026-01-01T16:30:46Z", "今天00:31上海", "0天前23:11",
        ):
            with self.subTest(raw=raw):
                self.assert_empty(raw)
        self.assert_record("2026-01-02", "2026-01-02", "day")
        self.assert_record("2026-01-02 00:30:45", "2026-01-02 00:30:45", "second")

    def test_future_timestamp_checked_before_subsecond_floor(self):
        reference = "2023-11-15T06:13:20.123+08:00"
        self.assert_record(1700000000123, "2023-11-15 06:13:20", "second", observed_at=reference)
        self.assert_empty(1700000000124, reference)
        self.assert_empty(1700000001, reference)
        self.assert_empty("2023-11-14T22:13:20.124Z", reference)

    def test_future_language_negative_or_fractional_intervals_are_not_guessed(self):
        for raw in (
            "明天", "后天", "1小时后", "-1天前", "+1小时前", "1.5小时前",
            "半小时前", "上周", "刚才", "3天前发布", "null",
            "2025-12-04/05", "2025-12-04<script>",
        ):
            with self.subTest(raw=raw):
                self.assert_empty(raw)

    def test_page_placeholders_are_missing_not_dates(self):
        for raw in ("未显示", "未知", "待读取", "暂无", "—", "-", "--"):
            with self.subTest(raw=raw):
                self.assert_empty(raw, status="missing")

    def test_explicit_before_word_and_date_prefixes(self):
        reference = "2026-09-03T15:30:00+08:00"
        for raw in ("3小时之前", "3 小时前 上海", "发布于3小时前"):
            result = normalize_xhs_datetime(raw, reference)
            self.assertEqual("2026-09-03 12:30:00", result["value"])
            self.assertEqual("estimated", result["status"])
            self.assertFalse(result["isEdited"])
        result = normalize_xhs_datetime("更新于2026.08.30 浙江", reference)
        self.assertEqual("2026-08-30", result["value"])
        self.assertTrue(result["isEdited"])
        result = normalize_xhs_datetime("04-08关岛", reference)
        self.assertEqual("2026-04-08", result["value"])
        self.assertEqual("inferred_year", result["source"])

    def test_chinese_relative_numbers_preserve_source_and_match_arabic_equivalents(self):
        reference = "2026-09-03T15:30:00+08:00"
        for chinese, arabic, unit in (
            ("零", 0, "天"), ("一", 1, "秒"), ("三", 3, "小时"), ("两", 2, "天"),
            ("七", 7, "天"), ("十", 10, "分钟"), ("一十", 10, "分钟"),
            ("二十一", 21, "分钟"), ("九十九", 99, "天"),
        ):
            raw = f"编辑于{chinese}{unit}前 广东"
            actual = normalize_xhs_datetime(raw, reference)
            expected = normalize_xhs_datetime(f"编辑于{arabic}{unit}前 广东", reference)
            self.assertEqual(raw, actual["raw"])
            self.assertEqual({k: v for k, v in expected.items() if k != "raw"},
                             {k: v for k, v in actual.items() if k != "raw"}, raw)
        self.assertEqual("2026-08-27", normalize_xhs_datetime("编辑于七天前", reference)["value"])

    def test_chinese_relative_dates_cross_year_and_day_boundaries(self):
        self.assertEqual("2025-12-27", normalize_xhs_datetime("七天前", "2026-01-03T00:30:00+08:00")["value"])
        self.assertEqual("2025-12-31 22:00:00", normalize_xhs_datetime("三小时前", "2026-01-01T01:00:00+08:00")["value"])
        self.assertEqual("2025-12-31 23:53:00", normalize_xhs_datetime("十分钟前", "2026-01-01T00:03:00+08:00")["value"])

    def test_chinese_duration_requires_reference_and_rejects_ambiguous_words(self):
        self.assert_empty("编辑于七天前", None, "needs_reference")
        for raw in ("两十天前", "十零天前", "一二天前", "一百天前", "二十几天前", "半天前", "2十天前"):
            with self.subTest(raw=raw):
                self.assert_empty(raw)

    def test_unquantified_few_does_not_fabricate_a_duration(self):
        for raw in ("几秒前", "几分钟前上海", "几小时前", "几天前 广东"):
            with self.subTest(raw=raw):
                self.assert_empty(raw, None, "needs_reference")
                self.assert_empty(raw)

    def test_calendar_arithmetic_overflow_is_empty(self):
        for raw in ("1秒前", "1分钟前", "1小时前", "1天前", "昨天", "前天23:11", "02-29", "12-31"):
            with self.subTest(raw=raw):
                self.assert_empty(raw, "0001-01-01T00:00:00+08:00")
        self.assert_empty("9999-12-31T23:59:59Z", None)
        self.assert_empty("0001-01-01T00:00:00+23:00", None)
        self.assert_record("9999-12-31", "9999-12-31", "day", observed_at=None)

    def test_impossibly_large_intervals_do_not_raise_or_need_reference(self):
        for unit in ("秒", "分钟", "小时", "天"):
            for count in ("9" * 5000, "999999999999"):
                for reference in (None, REFERENCE):
                    with self.subTest(unit=unit, count_length=len(count), reference=reference):
                        self.assert_empty(count + unit + "前", reference)
        self.assert_record("0" * 5000 + "2小时前", "2026-01-01 22:30:45", "hour", "estimated", "relative")

    def test_json_native_weird_inputs_are_preserved_without_parsing(self):
        for raw in ([], {}, {"date": "2025-12-04", "n": [1, True, None]}, ["2025-12-04"], 1.25):
            with self.subTest(raw=raw):
                self.assertEqual(self.assert_empty(raw)["raw"], raw)
        raw = {"value": [1, 2, 3]}
        result = normalize_xhs_datetime(raw)
        self.assertIsNot(result["raw"], raw)
        self.assertEqual(raw, {"value": [1, 2, 3]})

    def test_non_json_inputs_always_produce_strict_json(self):
        class Hostile:
            def __str__(self):
                raise RuntimeError("do not stringify me")

            def __repr__(self):
                raise RuntimeError("do not repr me")

        class BrokenClassAttribute:
            @property
            def __class__(self):
                raise RuntimeError("hostile __class__")

        class BrokenTypeName(type):
            @property
            def __name__(cls):
                raise RuntimeError("hostile type name")

            def __eq__(cls, other):
                raise RuntimeError("hostile type comparison")

        class BrokenType(metaclass=BrokenTypeName):
            pass

        cycle = []
        cycle.append(cycle)
        inputs = [
            float("nan"), float("inf"), float("-inf"), b"2025-12-04", object(),
            datetime(2025, 12, 4), complex(1, 2), {1, 2}, cycle, Hostile(), 10**5000,
            BrokenClassAttribute(), BrokenType(),
        ]
        for index, raw in enumerate(inputs):
            with self.subTest(index=index):
                first = self.assert_empty(raw)
                self.assertEqual(first, normalize_xhs_datetime(raw, REFERENCE))
                self.assertIsInstance(first["raw"], str)

    def test_fixed_reference_replays_do_not_drift(self):
        inputs = (
            "刚刚", "5秒前", "7分钟前", "2小时前", "3天前", "昨天23:11上海",
            "12-31", "02月29日", "编辑于 7天前 广东", "2025-12-04四川", 1700000000123,
        )
        expected = [normalize_xhs_datetime(raw, REFERENCE) for raw in inputs]
        for _ in range(100):
            self.assertEqual([normalize_xhs_datetime(raw, REFERENCE) for raw in inputs], expected)

    def test_no_wall_clock_or_file_io_even_without_reference(self):
        class NoClockDatetime(datetime):
            @classmethod
            def now(cls, tz=None):
                raise AssertionError("wall clock read")

            @classmethod
            def utcnow(cls):
                raise AssertionError("wall clock read")

            @classmethod
            def today(cls):
                raise AssertionError("wall clock read")

        inputs = ("2小时前", "昨天23:11上海", "12-31", "2025-12-04四川", 1700000000123, None)
        expected = [normalize_xhs_datetime(raw, REFERENCE) for raw in inputs]
        no_reference = [normalize_xhs_datetime(raw) for raw in inputs]
        with patch.object(normalization, "datetime", NoClockDatetime), \
                patch("time.time", side_effect=AssertionError("wall clock read")), \
                patch("builtins.open", side_effect=AssertionError("filesystem access")):
            self.assertEqual([normalize_xhs_datetime(raw, REFERENCE) for raw in inputs], expected)
            self.assertEqual([normalize_xhs_datetime(raw) for raw in inputs], no_reference)


if __name__ == "__main__":
    unittest.main()
