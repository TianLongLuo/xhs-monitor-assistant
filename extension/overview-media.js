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

  // Available width is the strip's content width. Every thumbnail needs one
  // trailing gap because the count button is always retained, even at capacity 0.
  function thumbnailCapacity(width, total, countWidth = 48, thumbnailWidth = 54, gap = 6) {
    const available = Number(width), count = Number(total), reserved = Number(countWidth);
    const size = Number(thumbnailWidth), spacing = Number(gap);
    if (![available, count, reserved, size, spacing].every(Number.isFinite)
      || available <= 0 || count <= 0 || reserved < 0 || size <= 0 || spacing < 0) return 0;
    return Math.min(Math.floor(count), Math.max(0, Math.floor((available - reserved) / (size + spacing))));
  }

  function create({ request, onError = () => {} }) {
    let epoch = 0, active = 0, queue = [], dialog = null, viewerSerial = 0;
    const metadata = new Map();
    const mounts = new Map(), resizeTargets = new Map();
    const resizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver(entries => {
      for (const entry of entries) resizeTargets.get(entry.target)?.(entry);
    }) : null;
    const observer = typeof IntersectionObserver === "function" ? new IntersectionObserver(entries => {
      for (const entry of entries) {
        const state = mounts.get(entry.target);
        if (!state) continue;
        state.visible = entry.isIntersecting;
        if (state.visible) { state.load(); state.update?.(); }
      }
    }, { rootMargin: "0px" }) : null;

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
      epoch++; observer?.disconnect(); resizeObserver?.disconnect(); metadata.clear();
      for (const state of mounts.values()) state.dispose();
      mounts.clear(); resizeTargets.clear();
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
    async function imageSource(record, listing, item, shouldLoad = () => true) {
      if (item.source === "remote") {
        const url = safeImageUrl(item.url);
        if (!url) throw new Error("图片来源不受支持");
        return url;
      }
      if (item.source !== "local") throw new Error("素材来源不明确");
      const skipped = {};
      const result = await limited(() => shouldLoad() ? request({ dataset: record.dataset, recordId: record.recordId, index: item.index, revision: listing.revision }) : skipped);
      if (result === skipped) return null;
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
      if (opener?.hidden) opener = opener.parentElement?.querySelector(".media-count") || opener;
      const serial = ++viewerSerial, currentEpoch = epoch;
      if (!dialog) {
        dialog = document.createElement("dialog"); dialog.className = "media-viewer";
        dialog.setAttribute("aria-label", "素材图片预览"); document.body.append(dialog);
        dialog.addEventListener("click", event => { if (event.target === dialog) closeViewer(); });
        dialog.addEventListener("cancel", () => { viewerSerial++; });
        dialog.addEventListener("close", () => { if (dialog._opener?.isConnected) dialog._opener.focus({ preventScroll: true }); });
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
      mounts.get(cell)?.dispose();
      const currentEpoch = epoch;
      const state = { visible: eager || !observer, loading: false, loaded: false, targets: [] };
      mounts.set(cell, state);
      const valid = () => epoch === currentEpoch && mounts.get(cell) === state && cell.isConnected;
      state.dispose = () => {
        observer?.unobserve(cell);
        for (const target of state.targets) { resizeObserver?.unobserve(target); resizeTargets.delete(target); }
        if (cell._loadMedia === load) delete cell._loadMedia;
      };
      cell.classList.add("media-cell"); cell.textContent = "等待图片…";
      cell.classList.toggle("media-detail", layout === "detail");
      const limit = Math.max(1, Math.min(12, Number(previewLimit) || 3));
      async function load() {
        if (!valid() || state.loading || state.loaded) return;
        state.loading = true;
        try {
          const listing = await readMetadata(record);
          if (!valid() || !listing) return;
          state.loaded = true;
          cell.replaceChildren();
          if (!listing.items.length) {
            const label = document.createElement("span"); label.className = "media-empty";
            label.textContent = ({ record_not_found: "记录已变更，请刷新", record_identity_mismatch: "图片关联待核验", comment_parent_mismatch: "评论关联待核验" })[listing.missingReason] || "无已记录图片"; label.title = listing.missingReason || "旧记录未保留图片时，可重新同步补充";
            cell.append(label); return;
          }
          const strip = document.createElement("div"); strip.className = "media-strip";
          cell.append(strip);
          const thumbs = [];
          (layout === "detail" ? listing.items.slice(0, limit) : listing.items).forEach((item, position) => {
            const button = document.createElement("button"); button.type = "button"; button.className = "media-thumb";
            button.hidden = layout !== "detail";
            button.textContent = "加载中"; button.setAttribute("aria-label", `查看第 ${position + 1} 张图片，共 ${listing.items.length} 张`);
            button.addEventListener("click", event => { event.stopPropagation(); openViewer(record, listing, position, button); });
            button.addEventListener("dblclick", event => event.stopPropagation()); strip.append(button);
            let started = false;
            const shouldLoad = () => valid() && state.visible && !button.hidden;
            const ensureImage = () => {
              if (started || !shouldLoad()) return;
              started = true;
              imageSource(record, listing, item, shouldLoad).then(url => {
                if (!url) {
                  started = false;
                  // Visibility can change again between a queued task being
                  // skipped and its completion microtask; do not miss that reveal.
                  if (url === null && shouldLoad()) ensureImage();
                  return;
                }
                if (!valid()) return;
                const img = makeImage(`图片 ${position + 1}`); img.loading = "lazy";
                img.onerror = () => { if (valid()) { button.textContent = "图片失效"; button.title = "重新同步可补充最新图片地址"; } };
                img.src = url; button.replaceChildren(img);
              }).catch(error => { if (valid()) { button.textContent = "重试"; button.title = error.message; } });
            };
            thumbs.push({ button, ensureImage });
          });
          const count = document.createElement("button"); count.type = "button"; count.className = "media-count";
          count.textContent = `${listing.items.length} 张`; count.title = "打开大图，使用左右方向键切换";
          count.addEventListener("click", event => { event.stopPropagation(); openViewer(record, listing, 0, count); });
          strip.append(count);
          let observedWidth;
          state.update = entry => {
            if (!valid()) return;
            if (entry?.target === strip) observedWidth = entry.contentRect.width;
            const capacity = layout === "detail" ? thumbs.length : thumbnailCapacity(
              observedWidth ?? strip.clientWidth,
              thumbs.length,
              Math.max(count.getBoundingClientRect().width, count.scrollWidth) || 48
            );
            for (const [position, thumb] of thumbs.entries()) {
              const hidden = position >= capacity;
              if (hidden && !thumb.button.hidden) {
                if (thumb.button.contains(document.activeElement)) count.focus({ preventScroll: true });
                // A modal may still be open when its original thumbnail disappears.
                if (dialog?._opener === thumb.button) dialog._opener = count;
              }
              thumb.button.hidden = hidden;
              thumb.ensureImage();
            }
          };
          if (layout !== "detail" && resizeObserver) {
            for (const target of [strip, count]) {
              state.targets.push(target); resizeTargets.set(target, state.update); resizeObserver.observe(target);
            }
          }
          state.update();
        } catch (error) {
          if (!valid()) return;
          const retry = document.createElement("button"); retry.type = "button"; retry.className = "cell-action";
          retry.textContent = "重新读取图片"; retry.title = error.message;
          retry.addEventListener("click", event => { event.stopPropagation(); load(); }); cell.replaceChildren(retry);
        } finally { state.loading = false; }
      }
      state.load = load; cell._loadMedia = load;
      if (observer && !eager) observer.observe(cell); else load();
    }
    return { mount, reset, close: closeViewer };
  }
  return { create, safeImageUrl, thumbnailCapacity };
});
