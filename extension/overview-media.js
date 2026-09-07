(function (root, factory) {
  const api = factory(); root.XhsMonitorOverviewMedia = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function safeImageUrl(value, local = false) {
    const raw = String(value || "");
    if (local) return /^data:image\/(?:png|jpeg|webp|gif|bmp|avif);base64,[a-z0-9+/=]+$/i.test(raw) ? raw : "";
    try {
      const url = new URL(raw);
      return url.protocol === "https:" && !url.username && !url.password && !url.port
        && ["xhscdn.com", "xiaohongshu.com"].some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))
        ? url.href : "";
    } catch (_error) { return ""; }
  }

  function create({ request, onError = () => {} }) {
    let epoch = 0, active = 0, queue = [], dialog = null, viewerSerial = 0;
    const metadata = new Map();
    const observer = typeof IntersectionObserver === "function" ? new IntersectionObserver(entries => {
      for (const entry of entries) if (entry.isIntersecting) {
        observer.unobserve(entry.target); entry.target._loadMedia?.();
      }
    }, { rootMargin: "160px" }) : null;

    function drain() {
      while (active < 3 && queue.length) {
        const task = queue.shift();
        if (task.epoch !== epoch) { task.resolve(null); continue; }
        active++;
        Promise.resolve().then(task.run).then(task.resolve, task.reject).finally(() => { active--; drain(); });
      }
    }
    function limited(run) {
      return new Promise((resolve, reject) => { queue.push({ run, resolve, reject, epoch }); drain(); });
    }
    function reset() {
      epoch++; observer?.disconnect(); metadata.clear();
      for (const task of queue.splice(0)) task.resolve(null);
      closeViewer();
    }
    function closeViewer() { viewerSerial++; if (dialog?.open) dialog.close(); }
    function readMetadata(record) {
      const key = `${record.dataset}:${record.recordId}`;
      if (!metadata.has(key)) {
        const pending = limited(() => request({ dataset: record.dataset, recordId: record.recordId })).then(result => {
          if (!result) return null;
          if (!result.ok || !Array.isArray(result.items)) throw new Error(result.error || "图片清单读取失败");
          return result;
        }).catch(error => { if (metadata.get(key) === pending) metadata.delete(key); throw error; });
        metadata.set(key, pending);
        if (metadata.size > 200) metadata.delete(metadata.keys().next().value);
      }
      return metadata.get(key);
    }
    async function imageSource(record, listing, item) {
      if (item.source === "remote") {
        const url = safeImageUrl(item.url);
        if (!url) throw new Error("图片来源不受支持");
        return url;
      }
      if (item.source !== "local") throw new Error("素材来源不明确");
      const result = await limited(() => request({ dataset: record.dataset, recordId: record.recordId, index: item.index, revision: listing.revision }));
      if (!result) return "";
      const url = safeImageUrl(result.dataUrl, true);
      if (!result.ok || !url) throw new Error(result.error || "本地图片读取失败");
      return url;
    }
    function makeImage(alt) {
      const img = document.createElement("img"); img.alt = alt; img.decoding = "async";
      img.referrerPolicy = "no-referrer"; img.draggable = false;
      return img;
    }
    async function openViewer(record, listing, position, opener) {
      const serial = ++viewerSerial, currentEpoch = epoch;
      if (!dialog) {
        dialog = document.createElement("dialog"); dialog.className = "media-viewer";
        dialog.setAttribute("aria-label", "素材图片预览"); document.body.append(dialog);
        dialog.addEventListener("click", event => { if (event.target === dialog) closeViewer(); });
        dialog.addEventListener("cancel", () => { viewerSerial++; });
        dialog.addEventListener("close", () => { if (dialog._opener?.isConnected) dialog._opener.focus(); });
      }
      dialog._opener = opener; dialog.replaceChildren();
      const header = document.createElement("header"), title = document.createElement("strong");
      title.textContent = String(record.title || "素材图片").slice(0, 80);
      const close = document.createElement("button"); close.type = "button"; close.textContent = "关闭";
      close.addEventListener("click", closeViewer); header.append(title, close);
      const stage = document.createElement("div"); stage.className = "media-viewer__stage"; stage.textContent = "图片加载中…";
      const footer = document.createElement("footer"), prev = document.createElement("button"), next = document.createElement("button"), status = document.createElement("span");
      prev.type = next.type = "button"; prev.textContent = "上一张"; next.textContent = "下一张";
      prev.disabled = position <= 0; next.disabled = position >= listing.items.length - 1;
      const item = listing.items[position];
      status.textContent = `${position + 1} / ${listing.items.length} · ${item.source === "local" ? "本地素材" : "平台图片（需联网）"}`;
      prev.addEventListener("click", () => openViewer(record, listing, position - 1, opener));
      next.addEventListener("click", () => openViewer(record, listing, position + 1, opener));
      footer.append(prev, status, next); dialog.append(header, stage, footer);
      if (!dialog.open) dialog.showModal();
      dialog.onkeydown = event => {
        if (event.key === "ArrowLeft" && !prev.disabled) { event.preventDefault(); prev.click(); }
        if (event.key === "ArrowRight" && !next.disabled) { event.preventDefault(); next.click(); }
      };
      const valid = () => currentEpoch === epoch && serial === viewerSerial && dialog.open;
      try {
        const url = await imageSource(record, listing, item);
        if (!valid() || !url) return;
        const img = makeImage(`素材图片 ${position + 1}`);
        img.onerror = () => { if (valid()) stage.textContent = "图片已失效或暂时不可用。可重新同步原帖后再查看。"; };
        img.src = url; stage.replaceChildren(img);
      } catch (error) { if (valid()) stage.textContent = `${error.message}；请刷新数据后重试。`; }
    }
    function mount(cell, record, { layout = "table", previewLimit = 3, eager = false } = {}) {
      const currentEpoch = epoch;
      const valid = () => epoch === currentEpoch && cell.isConnected;
      cell.classList.add("media-cell"); cell.textContent = "等待图片…";
      if (layout === "detail") cell.classList.add("media-detail");
      const limit = Math.max(1, Math.min(12, Number(previewLimit) || 3));
      async function load() {
        if (!valid()) return;
        try {
          const listing = await readMetadata(record);
          if (!valid() || !listing) return;
          cell.replaceChildren();
          if (!listing.items.length) {
            const label = document.createElement("span"); label.className = "media-empty";
            label.textContent = ({ record_not_found: "记录已变更，请刷新", record_identity_mismatch: "图片关联待核验", comment_parent_mismatch: "评论关联待核验" })[listing.missingReason] || "无已记录图片"; label.title = listing.missingReason || "旧记录未保留图片时，可重新同步补充";
            cell.append(label); return;
          }
          const strip = document.createElement("div"); strip.className = "media-strip";
          cell.append(strip);
          listing.items.slice(0, limit).forEach((item, position) => {
            const button = document.createElement("button"); button.type = "button"; button.className = "media-thumb";
            button.textContent = "加载中"; button.setAttribute("aria-label", `查看第 ${position + 1} 张图片，共 ${listing.items.length} 张`);
            button.addEventListener("click", event => { event.stopPropagation(); openViewer(record, listing, position, button); });
            button.addEventListener("dblclick", event => event.stopPropagation()); strip.append(button);
            imageSource(record, listing, item).then(url => {
              if (!valid() || !url) return;
              const img = makeImage(`图片 ${position + 1}`); img.loading = "lazy";
              img.onerror = () => { if (valid()) { button.textContent = "图片失效"; button.title = "重新同步可补充最新图片地址"; } };
              img.src = url; button.replaceChildren(img);
            }).catch(error => { if (valid()) { button.textContent = "重试"; button.title = error.message; } });
          });
          const count = document.createElement("button"); count.type = "button"; count.className = "media-count";
          count.textContent = `${listing.items.length} 张`; count.title = "打开大图，使用左右方向键切换";
          count.addEventListener("click", event => { event.stopPropagation(); openViewer(record, listing, 0, count); });
          strip.append(count);
        } catch (error) {
          if (!valid()) return;
          const retry = document.createElement("button"); retry.type = "button"; retry.className = "cell-action";
          retry.textContent = "重新读取图片"; retry.title = error.message;
          retry.addEventListener("click", event => { event.stopPropagation(); load(); }); cell.replaceChildren(retry);
        }
      }
      cell._loadMedia = load;
      if (observer && !eager) observer.observe(cell); else load();
    }
    return { mount, reset, close: closeViewer };
  }
  return { create, safeImageUrl };
});
