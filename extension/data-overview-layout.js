/* Layout-only behavior. Never reload schema, issue queries or replace rows. */
(() => {
  "use strict";
  const rail = document.getElementById("databaseRail");
  const peek = document.getElementById("railPeek");
  const viewport = document.getElementById("tableViewport");
  if (!rail || !peek || !viewport) return;

  let closeTimer = 0;
  let keyboardNavigation = false;
  const isOpen = () => document.body.classList.contains("rail-open");
  function setOpen(open, returnFocus = false) {
    if (open && viewport.matches(".is-column-dragging, .is-column-resizing")) return;
    window.clearTimeout(closeTimer);
    if (!open && returnFocus) peek.focus({ preventScroll: true });
    rail.inert = !open;
    document.body.classList.toggle("rail-open", open);
    peek.setAttribute("aria-expanded", String(open));
    peek.setAttribute("aria-label", open ? "收起导航" : "展开导航");
    peek.title = open ? "收起导航；移开鼠标后自动收起" : "靠近左侧展开导航";
  }
  function scheduleClose() {
    window.clearTimeout(closeTimer);
    closeTimer = window.setTimeout(() => {
      if (rail.matches(":hover") || peek.matches(":hover")) return;
      if (keyboardNavigation && rail.contains(document.activeElement)) return;
      setOpen(false, rail.contains(document.activeElement));
    }, 220);
  }
  for (const node of [rail, peek]) {
    node.addEventListener("pointerenter", event => {
      if (event.pointerType === "mouse" || event.pointerType === "pen") setOpen(true);
    });
    node.addEventListener("pointerleave", event => {
      if (event.pointerType !== "touch") scheduleClose();
    });
  }
  peek.addEventListener("click", event => {
    setOpen(!isOpen());
    if (isOpen() && event.detail === 0) {
      keyboardNavigation = true;
      requestAnimationFrame(() => {
        if (isOpen()) rail.querySelector("button:not(:disabled)")?.focus({ preventScroll: true });
      });
    }
  });
  rail.addEventListener("focusout", scheduleClose);
  document.addEventListener("keydown", event => {
    if (event.key === "Tab") keyboardNavigation = true;
    if (event.key === "Escape" && isOpen() && (rail.contains(event.target) || event.target === peek)) {
      event.preventDefault();
      setOpen(false, true);
    }
  });
  document.addEventListener("pointerdown", event => {
    keyboardNavigation = false;
    if (isOpen() && !rail.contains(event.target) && !peek.contains(event.target)) setOpen(false);
  });

  // The table retains its scroll owner (pagination, sticky headings, column drag
  // and horizontal scrolling depend on it). First scroll the page's introduction
  // out of view; then use the remaining motion inside the table. This prevents
  // the title/check ribbon from occupying the viewport throughout a long table.
  function handOffVertical(delta, horizontal = 0) {
    if (viewport.matches(".is-column-dragging, .is-column-resizing")
      || document.querySelector("#columnFilterPopover:not([hidden])")) return false;
    const top = viewport.getBoundingClientRect().top;
    if (delta > 0 && top > 12 && window.scrollY < document.documentElement.scrollHeight - window.innerHeight - 1) {
      const before = window.scrollY;
      window.scrollBy({ top: Math.min(delta, top - 12), behavior: "instant" });
      const consumed = window.scrollY - before;
      if (consumed <= 0) return false;
      viewport.scrollTop += Math.max(0, delta - consumed);
      viewport.scrollLeft += horizontal;
      return true;
    }
    if (delta < 0 && viewport.scrollTop <= 0 && window.scrollY > 0) {
      window.scrollBy({ top: delta, behavior: "instant" });
      viewport.scrollLeft += horizontal;
      return true;
    }
    return false;
  }
  viewport.addEventListener("wheel", event => {
    if (event.defaultPrevented || !event.cancelable || event.ctrlKey || event.metaKey || event.shiftKey
      || Math.abs(event.deltaX) > Math.abs(event.deltaY)
      || event.target.closest("input, select, textarea, [contenteditable='true']")) return;
    for (let node = event.target; node && node !== viewport; node = node.parentElement) {
      if (node.scrollHeight > node.clientHeight && /auto|scroll/.test(getComputedStyle(node).overflowY)) return;
    }
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerHeight : 1;
    if (handOffVertical(event.deltaY * unit, event.deltaX * unit)) event.preventDefault();
  }, { passive: false });
  viewport.addEventListener("keydown", event => {
    if (event.target !== viewport || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    const delta = { PageDown: viewport.clientHeight * .9, PageUp: -viewport.clientHeight * .9,
      ArrowDown: 40, ArrowUp: -40 }[event.key];
    if (delta && handOffVertical(delta)) event.preventDefault();
  });
})();
