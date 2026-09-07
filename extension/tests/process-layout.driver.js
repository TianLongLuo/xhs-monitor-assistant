"use strict";
const rootNote = document.querySelector("#noteContainer");
const fixtureNote = () => ({ noteId: rootNote.getAttribute("note-id"), title: "素材与评论，并排查看", content: document.querySelector("#detail-desc").textContent, author: "示例作者", mediaDir: "fixture-material", excelPath: "fixture.csv" });
const frameTurn = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
async function mountFixture() {
  await fixtureMessage({ type: "prepareBatchProcess", note: fixtureNote() });
  await fixtureMessage({ type: "batchSyncNoteProgress", note: fixtureNote(), noteId: fixtureNote().noteId,
    done: true, phase: "excel", title: "合成数据已就绪", commentCount: 12, pullStatus: "synced", commentRows: [] });
  await frameTurn();
}
globalThis.fixtureReady = mountFixture();
globalThis.runLayoutAction = async action => {
  if (action === "mount") await mountFixture();
  if (action === "collapse") document.querySelector(".xhs-monitor-process__collapse").click();
  if (action === "close") document.querySelector(".xhs-monitor-process__close").click();
  if (action === "switch") {
    rootNote.setAttribute("note-id", "fixture-note-two");
    await mountFixture();
  }
  if (action === "native-resize") {
    rootNote.style.width = "1000px";
    window.dispatchEvent(new Event("resize"));
  }
  if (action === "flex-center") {
    rootNote.className = "note-container";
    window.dispatchEvent(new Event("resize"));
  }
  if (action === "left-anchor") {
    rootNote.className = "note-container left-transform";
    window.dispatchEvent(new Event("resize"));
  }
  if (action === "native-translate") {
    rootNote.style.translate = "12px 8px";
    window.dispatchEvent(new Event("resize"));
  }
  if (action === "parent-resize") {
    rootNote.parentElement.style.width = "calc(100% - 80px)";
  }
  if (action === "progress") {
    for (let i = 0; i < 12; i++) await fixtureMessage({ type: "batchSyncNoteProgress", note: fixtureNote(), noteId: fixtureNote().noteId,
      done: true, phase: "excel", title: `已读取 ${i} 条合成评论`, commentCount: i, commentRows: [] });
  }
  await frameTurn();
};
