(function (root) {
  "use strict";

  const groups = Object.freeze({
    // 品牌词库：填写你要监控的品牌名/别名（用于标题、正文、话题匹配）
    brand: Object.freeze(["品牌词"]),
    // 产品词库：填写品牌旗下产品名（可为空）
    products: Object.freeze([]),
    // 官方账号/博主词库：只匹配作者用户名（可为空）
    accounts: Object.freeze([])
  });

  function matchKey(value) {
    return String(value || "")
      .normalize("NFKC")
      .toLocaleLowerCase()
      .replace(/[\u200b-\u200f\uFEFF]/g, "")
      .replace(/\s+/g, "");
  }

  function containsTerm(corpus, term) {
    const normalizedTerm = matchKey(term);
    if (!normalizedTerm) return false;
    if (/^[a-z0-9]+$/.test(normalizedTerm)) {
      // 纯英文/数字词按整词匹配，避免子串误命中（如 brand 误中 branding）
      return new RegExp(`(?<![a-z0-9])${normalizedTerm}(?![a-z0-9])`).test(corpus);
    }
    return corpus.includes(normalizedTerm);
  }

  function match(note = {}, customGroups = null) {
    const activeGroups = customGroups && typeof customGroups === "object" ? customGroups : groups;
    const tags = Array.isArray(note.tags) ? note.tags : [note.tags || ""];
    const corpus = matchKey([note.title, note.content, ...tags, note.mediaText || ""].join(" "));
    const authorCorpus = matchKey(note.author || "");
    const matches = [];
    for (const [group, terms] of Object.entries(activeGroups)) {
      for (const term of Array.isArray(terms) ? terms : []) {
        if (containsTerm(corpus, term)) matches.push(`${group}:${term}`);
      }
    }
    // Search cards often hide the caption and expose no OCR-friendly image
    // metadata. An official brand/account name is still a precise,
    // high-confidence relevance signal; product-like usernames are not.
    for (const group of ["brand", "accounts"]) {
      for (const term of Array.isArray(activeGroups[group]) ? activeGroups[group] : []) {
        if (containsTerm(authorCorpus, term)) matches.push(`author:${term}`);
      }
    }
    return { relevant: matches.length > 0, matches };
  }

  root.XhsMonitorRelevance = Object.freeze({ groups, matchKey, match });
})(globalThis);
