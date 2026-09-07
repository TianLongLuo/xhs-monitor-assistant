(function (root) {
  "use strict";

  async function collectFilteredRows(fetchPage, sourcePayload, options = {}) {
    const payload = JSON.parse(JSON.stringify(sourcePayload));
    if (!payload.snapshotToken || !["notes", "comments"].includes(payload.dataset)) {
      throw new Error("请先完成筛选与一致性校验再导出");
    }
    const primary = payload.dataset === "notes" ? "note_id" : "comment_id";
    payload.fields = [...new Set([...(payload.fields || []), primary])];
    payload.pageSize = 200;
    const rows = [];
    const ids = new Set();
    let expectedTotal = null;
    for (let page = 1; ; page += 1) {
      const result = await fetchPage({ ...payload, page });
      if (result?.ok === false || result?.consistentSnapshot !== true
          || result.snapshotToken !== payload.snapshotToken || result.dataset !== payload.dataset) {
        throw new Error("导出期间数据快照发生变化；请重新校验后重试，未生成不完整文件");
      }
      const total = Number(result.total);
      if (!Number.isSafeInteger(total) || total < 0 || Number(result.page) !== page
          || Number(result.pageSize) !== payload.pageSize || !Array.isArray(result.rows)) {
        throw new Error("导出分页校验失败，未生成文件");
      }
      if (expectedTotal === null) {
        expectedTotal = total;
        if (options.expectedTotal !== undefined && Number(options.expectedTotal) !== total) {
          throw new Error("筛选结果已变化，请等待页面刷新完成后重新导出");
        }
      } else if (expectedTotal !== total) {
        throw new Error("导出结果数量发生变化，未生成不完整文件");
      }
      for (const row of result.rows) {
        const id = String(row[primary] || "");
        if (!id || ids.has(id)) throw new Error("导出发现缺失或重复记录 ID，已停止");
        ids.add(id);
        rows.push(row);
      }
      if (rows.length > total || (rows.length < total && result.rows.length !== payload.pageSize)) {
        throw new Error("导出分页数量不完整，已停止");
      }
      options.onProgress?.(rows.length, total);
      if (rows.length === total) return { rows, total, snapshotToken: payload.snapshotToken };
    }
  }

  function toCsv(rows, columns) {
    const quote = (value, dataType = "text") => {
      let result = value && typeof value === "object" ? JSON.stringify(value) : String(value ?? "");
      // Spreadsheet programs must not execute comment text as a formula.
      if (dataType !== "number" && /^[\s]*[=+@-]/.test(result)) result = "'" + result;
      return `"${result.replace(/"/g, '""')}"`;
    };
    const lines = [columns.map((column) => quote(column.label || column.key)).join(",")];
    for (const row of rows) lines.push(columns.map((column) => quote(row[column.key], column.dataType)).join(","));
    return "\ufeff" + lines.join("\r\n");
  }

  const api = Object.freeze({ collectFilteredRows, toCsv });
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.XhsMonitorDataExport = api;
})(globalThis);
