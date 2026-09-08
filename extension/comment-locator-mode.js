// Run before site SPA routing removes the dedicated locator marker.
(() => {
  try {
    if (new URL(location.href).searchParams.get("xhs_monitor_locate") === "1")
      globalThis.__XHS_MONITOR_COMMENT_LOCATOR_SURFACE__ = true;
  } catch (_) { /* Ordinary pages retain their existing behavior. */ }
})();
