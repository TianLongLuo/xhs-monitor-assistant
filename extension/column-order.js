(function (root) {
  "use strict";

  function sanitize(keys) {
    if (!Array.isArray(keys)) return [];
    return [...new Set(keys.filter((key) => typeof key === "string" && key.length > 0 && key.length <= 160))].slice(0, 1000);
  }

  function orderedKeys(availableKeys, savedOrder = []) {
    const available = sanitize(availableKeys);
    const valid = new Set(available);
    const saved = sanitize(savedOrder).filter((key) => valid.has(key));
    const known = new Set(saved);
    return [...saved, ...available.filter((key) => !known.has(key))];
  }

  function move(availableKeys, savedOrder, sourceKey, targetKey, side = "before") {
    const current = orderedKeys(availableKeys, savedOrder);
    if (sourceKey === targetKey || !current.includes(sourceKey) || !current.includes(targetKey)
        || !["before", "after"].includes(side)) return current;
    const moved = current.filter((key) => key !== sourceKey);
    moved.splice(moved.indexOf(targetKey) + Number(side === "after"), 0, sourceKey);
    return moved;
  }

  const api = Object.freeze({ sanitize, orderedKeys, move });
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.XhsMonitorColumnOrder = api;
})(globalThis);
