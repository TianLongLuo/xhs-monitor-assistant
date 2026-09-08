"use strict";
for (const type of ["error", "unhandledrejection"]) window.addEventListener(type, event => {
  const item = document.createElement("pre"); item.setAttribute("role", "alert");
  item.style.cssText = "position:fixed;left:20px;top:60px;z-index:2147483647;background:white;color:red;max-width:80vw;white-space:pre-wrap";
  item.textContent = String(event.error?.stack || event.reason?.stack || event.message || event.reason);
  document.body.append(item);
});
// The actual content script runs unchanged, with no real Chrome or Bridge I/O.
const runtimeListeners = [];
globalThis.chrome = {
  runtime: { lastError: null, onMessage: { addListener: listener => runtimeListeners.push(listener) },
    sendMessage(message, callback) { const result = { ok: false, error: "Synthetic fixture: no bridge" }; callback?.(result); return Promise.resolve(result); } },
  storage: { local: { get: async defaults => ({ ...defaults, enabled: false }) }, onChanged: { addListener() {} } }
};
globalThis.fixtureMessage = message => new Promise(resolve => {
  for (const listener of runtimeListeners) listener(message, {}, resolve);
});
for (let i = 0; i < 12; i++) {
  const row = document.createElement("article"); row.className = "comment-item"; row.id = `comment-fixture-${i}`;
  row.innerHTML = `<div class="name">用户 ${i + 1}</div><div class="content">第 ${i + 1} 条合成评论，测试滚动位置和稳定 ID。</div><div class="date">2026-09-04</div>`;
  document.querySelector("#fixture-comments").append(row);
}
