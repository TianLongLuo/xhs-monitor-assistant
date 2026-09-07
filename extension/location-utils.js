(function (root, factory) {
  const api = factory();
  root.XhsMonitorLocationUtils = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // Keep this vocabulary in sync with bridge/date_normalization.py:_REGIONS.
  // Preserve the displayed spelling (e.g. 四川省, 中国香港); do not geocode,
  // canonicalize aliases, or accept arbitrary text merely because it says IP.
  const provinces = ("河北 山西 辽宁 吉林 黑龙江 江苏 浙江 安徽 福建 江西 山东 河南 湖北 湖南 "
    + "广东 海南 四川 贵州 云南 陕西 甘肃 青海 台湾").split(" ");
  const municipalities = "北京 天津 上海 重庆".split(" ");
  const regions = new Set([
    ...provinces, ...provinces.map((name) => `${name}省`),
    ...municipalities, ...municipalities.map((name) => `${name}市`),
    ...("内蒙古 广西 西藏 宁夏 新疆 内蒙古自治区 广西壮族自治区 西藏自治区 "
      + "宁夏回族自治区 新疆维吾尔自治区 香港 澳门 香港特别行政区 澳门特别行政区 "
      + "中国香港 中国澳门 中国台湾 中国 中国大陆 中国内地 海外 "
      + "美国 英国 加拿大 澳大利亚 新西兰 日本 韩国 新加坡 马来西亚 泰国 越南 "
      + "印度尼西亚 菲律宾 柬埔寨 印度 法国 德国 意大利 西班牙 瑞士 瑞典 挪威 "
      + "芬兰 丹麦 荷兰 爱尔兰 葡萄牙 比利时 奥地利 俄罗斯 巴西 墨西哥 "
      + "阿根廷 智利 阿联酋 南非 沙特阿拉伯 土耳其 埃及 以色列 关岛").split(" ")
  ]);
  const regionPrefix = /^(?:IP\s*(?:属地|所在地)|来自)\s*[:：]?\s*/i;
  const month = "(?:1[0-2]|0?[1-9])";
  const day = "(?:3[01]|[12][0-9]|0?[1-9])";
  const fullDate = `(?:${["-", "/", "\\."].map((sep) => `[0-9]{4}${sep}${month}${sep}${day}`).join("|")}|[0-9]{4}年${month}月${day}日)`;
  const monthDay = `(?:${month}[-/]${day}|${month}月${day}日)`;
  const clock = "(?:[01]?[0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9](?:[.,][0-9]{1,9})?)?";
  const zone = "(?:[Zz]|[+-](?:[01][0-9]|2[0-3])(?::?[0-5][0-9])?)?";
  const count = "(?:[0-9]+|几|[一二三四五六七八九]?十[一二三四五六七八九]?|[零一二两三四五六七八九])\\s*";
  const dayLabel = `(?:${monthDay}|今天|昨天|前天|${count}天(?:之)?前)`;
  const relative = `(?:刚刚|${count}(?:秒|分钟|小时)(?:之)?前)`;
  // Recognize only the shape of a native time prefix, without parsing a date,
  // consulting a clock, or changing the original publishedAt/edited label.
  const timePrefix = new RegExp(`^(?:(?:编辑于|更新于|发布于)\\s*[:：]?\\s*)?`
    + `(?:${fullDate}(?:\\s*[Tt]?${clock}${zone})?|${dayLabel}(?:\\s*${clock})?|${relative})`);

  function validTimePrefix(value) {
    const time = value.replace(/^(?:编辑于|更新于|发布于)\s*[:：]?\s*/, "");
    const date = time.match(/^(?:([0-9]{4})[-/.年])?([0-9]{1,2})[-/.月]([0-9]{1,2})/);
    if (date) {
      // Like the backend's reference-free check, yearless Feb 29 is valid.
      // Validate the calendar, without constructing or normalizing a timestamp.
      const year = date[1] === undefined ? 2000 : Number(date[1]);
      if (!year) return false;
      const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
      const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
      if (Number(date[3]) > days[Number(date[2]) - 1]) return false;
    }
    const interval = time.match(/^([0-9]+)\s*(秒|分钟|小时|天)/);
    if (interval) {
      const scale = { 秒: 1, 分钟: 60, 小时: 3600, 天: 86400 }[interval[2]];
      if (Number(interval[1]) > Math.floor(315537897599 / scale)) return false;
    }
    return true;
  }

  function extractRegion(rawTimeOrRegion) {
    if (typeof rawTimeOrRegion !== "string") return "";
    const text = rawTimeOrRegion.trim();
    const direct = text.replace(regionPrefix, "");
    if (regions.has(direct)) return direct;
    const time = text.match(timePrefix);
    if (!time || !validTimePrefix(time[0])) return "";
    const suffix = text.slice(time[0].length).trim().replace(/^[·•]\s*/, "").replace(regionPrefix, "");
    // Full-suffix matching rejects prose, usernames, numeric IPs, a second
    // date/region, and trailing interaction labels. Unknown regions stay empty.
    return regions.has(suffix) ? suffix : "";
  }

  return { extractRegion };
});
