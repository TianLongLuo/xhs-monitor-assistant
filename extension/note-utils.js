(function (root) {
  "use strict";

  function extractHashtags(content) {
    return [...new Set((String(content || "").match(/#[^#\s]{1,80}/g) || []).filter(Boolean))];
  }

  function detailBelongsToNote({
    candidateId = "", activeDetailId = "", noteId = "",
    hasNoteLink = false, title = "", visibleText = ""
  } = {}) {
    const exactId = String(candidateId || activeDetailId || "");
    if (exactId) return exactId === String(noteId || "");
    if (hasNoteLink) return true;
    return Boolean(title && String(visibleText || "").includes(String(title)));
  }

  function urlScore(value) {
    try {
      const url = new URL(String(value || ""), "https://www.xiaohongshu.com");
      let score = /^https?:$/.test(url.protocol) ? 1 : 0;
      if (url.hostname === "xhslink.com" || url.hostname.endsWith(".xhslink.com")) score += 100;
      if (url.searchParams.get("xsec_token")) score += 60;
      if (url.searchParams.get("xsec_source")) score += 4;
      if (url.searchParams.get("xhsshare")) score += 10;
      if (url.pathname.includes("/search_result/")) score += 8;
      else if (url.pathname.includes("/discovery/item/")) score += 6;
      else if (url.pathname.includes("/explore/")) score += 4;
      return score;
    } catch (_error) {
      return 0;
    }
  }

  function normalizeXhsUrl(value) {
    const raw = String(value || "");
    if (!raw) return "";
    try {
      const url = new URL(raw, "https://www.xiaohongshu.com");
      if (url.hostname === "www.xiaohongshu.com" && url.searchParams.get("xsec_token")
          && !url.searchParams.get("xsec_source")) {
        url.searchParams.set("xsec_source", url.pathname.includes("/user/profile/") ? "pc_note" : "pc_search");
      }
      return url.href;
    } catch (_error) {
      return raw;
    }
  }

  function preferredUrl(current, candidate) {
    const currentValue = normalizeXhsUrl(current);
    const candidateValue = normalizeXhsUrl(candidate);
    if (!candidateValue) return currentValue;
    return urlScore(candidateValue) >= urlScore(currentValue) ? candidateValue : currentValue;
  }

  root.XhsMonitorNoteUtils = Object.freeze({ extractHashtags, detailBelongsToNote, normalizeXhsUrl, urlScore, preferredUrl });
})(globalThis);
