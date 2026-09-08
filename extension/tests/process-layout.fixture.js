"use strict";
const frame = document.querySelector("#frame"), output = document.querySelector("#results"), summary = document.querySelector("#summary");
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const rect = node => { const b = node.getBoundingClientRect(); return { left:b.left, top:b.top, right:b.right, bottom:b.bottom, width:b.width, height:b.height }; };
const check = (value, message) => { if (!value) throw new Error(message); };
const sameBox = (a, b) => ["left","top","width","height"].every(key=>Math.abs(a[key]-b[key])<1);
function verifyLayout() {
  const win=frame.contentWindow, doc=frame.contentDocument;
  const note=doc.querySelector("#noteContainer"), hud=doc.querySelector(".xhs-monitor-process");
  check(hud, "磁吸窗口未挂载");
  const a=rect(note),b=rect(hud);
  check(b.left>=0 && b.top>=0 && b.right<=win.innerWidth+1 && b.bottom<=win.innerHeight+1, "磁吸窗口越界");
  check(a.left>=0 && a.top>=0 && a.right<=win.innerWidth+1 && a.bottom<=win.innerHeight+1, "帖子越界");
  check(b.left>=a.right+9 || b.top>=a.bottom+9, `仍有重叠：${JSON.stringify({note:a,panel:b})}`);
  const editor=doc.querySelector("textarea"), e=rect(editor);
  check(e.left>=a.left && e.right<=a.right+1 && e.bottom<=a.bottom+1, "原生输入框越界");
  check(doc.querySelectorAll(".xhs-monitor-process").length===1,"出现重复窗口");
  return {note:a,panel:b,mode:hud.dataset.position};
}
async function resize(width,height) {
  frame.width=width;frame.height=height;
  await pause(140);
  frame.contentWindow.dispatchEvent(new Event("resize"));
  await pause(80);
}
document.querySelector("#view").addEventListener("change",async event=>{
  const [w,h]=event.target.value.split(",").map(Number);await resize(w,h);
  summary.textContent=JSON.stringify(verifyLayout());
});
document.querySelector("#run").addEventListener("click",async event=>{
  event.target.disabled=true;output.replaceChildren();summary.textContent="运行中…";
  let passed=0,failed=0;
  async function test(name, fn) {
    const li=document.createElement("li");
    try { await fn();passed++;li.dataset.status="passed";li.textContent=`PASS ${name}`; }
    catch(error){failed++;li.dataset.status="failed";li.textContent=`FAIL ${name}: ${error.message}`;}
    output.append(li);
  }
  await frame.contentWindow.fixtureReady;
  await test("侧栏开启时，帖子左移缩窄且两窗口不相交",async()=>{await resize(1480,940);verifyLayout();});
  await test("连续进度更新不累计挤窄或抖动",async()=>{const before=verifyLayout();await frame.contentWindow.runLayoutAction("progress");await pause(100);const after=verifyLayout();check(sameBox(before.note,after.note)&&sameBox(before.panel,after.panel),"进度更新改变了几何尺寸");});
  await test("折叠、展开使用相应占位宽度",async()=>{await frame.contentWindow.runLayoutAction("collapse");verifyLayout();await frame.contentWindow.runLayoutAction("collapse");verifyLayout();});
  await test("草稿、焦点和原生节点不因布局变化丢失",async()=>{const doc=frame.contentDocument,editor=doc.querySelector("textarea"),scroll=doc.querySelector(".note-scroller");editor.focus();editor.setSelectionRange(2,4);scroll.scrollTop=160;await resize(1200,820);check(doc.querySelector("textarea")===editor&&editor.value==="未发送的本地草稿","草稿或节点丢失");check(doc.activeElement===editor,"焦点丢失");check(editor.selectionStart===2&&editor.selectionEnd===4,"选择范围丢失");check(scroll.scrollTop===160,"滚动位置改变");verifyLayout();});
  for(const [w,h] of [[1920,1080],[1366,768],[1024,768],[916,720],[900,760],[600,700],[390,760],[320,568]]) {
    await test(`${w}×${h} 响应式无重叠/越界`,async()=>{await resize(w,h);verifyLayout();});
  }
  await test("切换帖子仍保持单窗口并正确占位",async()=>{await resize(1480,940);await frame.contentWindow.runLayoutAction("switch");verifyLayout();check(frame.contentDocument.querySelector(".xhs-monitor-process").dataset.noteId==="fixture-note-two","窗口串帖");});
  for (const [action,label] of [["flex-center","原生 flex 居中"],["left-anchor","原生左侧锚定"],["native-translate","原生独立 translate"],["parent-resize","父容器改变尺寸"]]) {
    await test(`${label}仍保持无重叠`,async()=>{await frame.contentWindow.runLayoutAction(action);await pause(100);verifyLayout();});
  }
  await test("平台内联宽度变化后重新计算",async()=>{await frame.contentWindow.runLayoutAction("native-resize");await pause(120);verifyLayout();});
  await test("关闭窗口恢复平台原布局和样式",async()=>{await frame.contentWindow.runLayoutAction("close");const doc=frame.contentDocument;check(!doc.querySelector(".xhs-monitor-process"),"窗口未关闭");check(!doc.querySelector("[data-xhs-monitor-reserved]"),"遗留占位样式");const note=doc.querySelector("#noteContainer");check(note.style.width==="1000px","覆盖了平台新内联样式");check(!note.style.cssText.includes("--xhs-monitor-note"),"遗留占位变量");});
  await frame.contentWindow.runLayoutAction("mount");
  summary.textContent=`完成：${passed}/${passed+failed} 通过，${failed} 失败`;
  event.target.disabled=false;
});
