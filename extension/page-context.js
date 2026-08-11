(function (root) {
  "use strict";

  function isSearchSurface({ href = "", hasSearchLayout = false } = {}) {
    try {
      const url = new URL(String(href || ""), "https://www.xiaohongshu.com/");
      const path = url.pathname.toLocaleLowerCase();
      if (path.includes("search_result") || url.searchParams.has("keyword")) return true;
    } catch (_error) {
      // Fall through to DOM-surface detection.
    }
    // Xiaohongshu changes the URL to /explore/<id> while a detail modal is
    // layered over the original search grid. The grid is the durable signal.
    return Boolean(hasSearchLayout);
  }

  function resolveKeyword({ href = "", inputValue = "", remembered = "" } = {}) {
    try {
      const params = new URL(String(href || ""), "https://www.xiaohongshu.com/").searchParams;
      const fromUrl = params.get("keyword") || params.get("q") || params.get("search");
      if (String(fromUrl || "").trim()) return String(fromUrl).trim();
    } catch (_error) {
      // Fall through to visible or remembered values.
    }
    return String(inputValue || remembered || "").trim();
  }

  root.XhsMonitorPageContext = Object.freeze({ isSearchSurface, resolveKeyword });
})(globalThis);
