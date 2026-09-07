(function (root, factory) {
  const api = factory();
  root.XhsMonitorCommentCollector = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // Collection remains read-only. Completion requires exact unique IDs/count,
  // no unresolved loaders/controls, the list end, and fresh DOM confirmations.
  async function collect(adapter, options = {}) {
    const allComments = options.allComments !== false;
    const now = adapter.now || Date.now;
    const sleep = adapter.wait || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const changed = adapter.waitForChange ? (ms) => adapter.waitForChange(ms) : sleep;
    const nextTurn = adapter.afterDomTurn ? () => adapter.afterDomTurn() : () => sleep(60);
    const renderedView = adapter.afterScroll ? () => adapter.afterScroll() : nextTurn;
    const timeoutMs = options.timeoutMs ?? (allComments ? 180000 : 7000); // emergency ceiling, not a delay
    const maxPasses = options.maxPasses ?? (allComments ? 2 : 1);
    const maxAttempts = options.maxAttempts ?? 3;
    const startedAt = now();
    const comments = new Map();
    const attempts = new Map();
    const inFlight = new Map();
    const responseTimes = [];
    let snapshot = {};
    let expectedCount = 0;
    let expectedCountKnown = false;
    let pass = 1;
    let expandedCount = 0;
    let retryCount = 0;
    let peakInFlight = 0;
    let lastChangeAt = startedAt;
    let lastActionAt = startedAt;
    let lastFingerprint = "";
    let proofFingerprint = "";
    let stableRounds = 0;
    let readCount = 0;
    let scrollCount = 0;
    let complete = false;
    let reason = "deadline";
    let interrupted = false;
    let initialized = false;
    let forceRead = false;
    let progressKey = "";
    let lastProgressAt = -Infinity;

    const budget = () => {
      const sorted = [...responseTimes].sort((a, b) => a - b);
      const observed = sorted.length ? sorted[Math.floor((sorted.length - 1) * .75)] : 600;
      return Math.min(6000, Math.max(1000, observed * 2.5));
    };
    const countMatches = () => !snapshot.countConflict && (expectedCount > 0
      ? comments.size === expectedCount && Number(snapshot.expectedCount) === expectedCount
      : comments.size === 0 && snapshot.explicitEmpty === true);
    function report(force = false) {
      const key = [comments.size, expectedCount, expectedCountKnown, pass, expandedCount, Boolean(snapshot.loading)].join(":");
      if (!force && ((key === progressKey && now() - lastProgressAt < 5000) || now() - lastProgressAt < 500)) return;
      progressKey = key; lastProgressAt = now();
      try { adapter.onProgress?.({ count: comments.size, expectedCount, expectedCountKnown, pass, expandedCount, retryCount,
        loading: Boolean(snapshot.loading), elapsedMs: now() - startedAt }); } catch (_error) {}
    }
    async function scroll(direction) {
      if (adapter.interruption?.()) return false;
      const moved = await adapter.scroll?.(direction);
      scrollCount += 1;
      if (moved) { lastActionAt = now(); stableRounds = 0; proofFingerprint = ""; }
      return moved;
    }

    while (now() - startedAt < timeoutMs) {
      const interruption = adapter.interruption?.();
      if (interruption) { reason = interruption; interrupted = true; break; }
      snapshot = await adapter.read({ force: forceRead });
      readCount += 1; forceRead = false;
      if (snapshot.interruption) { reason = snapshot.interruption; interrupted = true; break; }
      if (!snapshot.ready) {
        stableRounds = 0;
        if (now() - lastChangeAt > 8000) { reason = "not_ready"; break; }
        await changed(500);
        continue;
      }
      expectedCount = Math.max(expectedCount, Math.max(0, Number(snapshot.expectedCount) || 0));
      expectedCountKnown = expectedCount > 0 || snapshot.expectedCountKnown === true || snapshot.explicitEmpty === true;
      const visibleIds = new Set((snapshot.comments || []).filter((item) => item?.commentId
        && (!options.noteId || item.noteId === options.noteId)).map((item) => item.commentId));
      const domAlreadyFull = expectedCount > 0 && visibleIds.size === expectedCount
        && Number(snapshot.expectedCount) === expectedCount;
      if (!initialized) {
        initialized = true;
        // A fully materialized list needs no rewind or page-by-page tour.
        // Partial/virtualized lists must still be traversed from the start.
        if (allComments && !domAlreadyFull && !snapshot.explicitEmpty && snapshot.scrollTop !== 0) {
          if (await scroll("start")) { forceRead = true; await renderedView(); continue; }
        }
      }
      let newData = false;
      const addedIds = new Set();
      for (const item of snapshot.comments || []) {
        if (!item?.commentId || (options.noteId && item.noteId !== options.noteId)) continue;
        const previous = comments.get(item.commentId);
        const merged = { ...previous, ...item };
        if (!merged.parentCommentId && previous?.parentCommentId) merged.parentCommentId = previous.parentCommentId;
        if (!previous) addedIds.add(item.commentId);
        if (!previous || ["content", "parentCommentId", "publishedAt", "likeCount", "replyCount"]
          .some((field) => previous[field] !== merged[field])) newData = true;
        comments.set(item.commentId, merged);
      }
      const controls = snapshot.controls || [];
      const fingerprint = [comments.size, expectedCount, Number(snapshot.expectedCount) || 0,
        expectedCountKnown, Boolean(snapshot.explicitEmpty), Boolean(snapshot.countConflict),
        snapshot.scrollKey || "", snapshot.scrollHeight || 0, snapshot.scrollTop ?? "", snapshot.revision ?? "",
        Boolean(snapshot.loading), snapshot.unreadableCount || 0,
        ...controls.map((control) => `${control.key}:${control.revision || ""}:${Boolean(control.disabled)}`)].join("|");
      if (newData || fingerprint !== lastFingerprint) {
        lastChangeAt = now(); lastFingerprint = fingerprint;
        stableRounds = 0; proofFingerprint = "";
      }

      // Independent thread slots are released by observed response progress,
      // not by a global fixed delay or disappearance of a loading button.
      for (const [group, flight] of inFlight) {
        const control = controls.find((item) => (item.groupKey || item.key) === group);
        const thread = snapshot.threadStates?.[group] || snapshot.threadStates?.[flight.key];
        const delivered = thread ? thread.revision !== flight.threadRevision && !thread.pending
          : (control ? control.revision !== flight.revision && !control.disabled
            : addedIds.size > 0 && !snapshot.loading);
        if (delivered || (countMatches() && !controls.length && !snapshot.loading && !thread?.pending)) {
          responseTimes.push(Math.max(40, now() - flight.at));
          if (responseTimes.length > 12) responseTimes.shift();
          inFlight.delete(group);
        } else if (control && !control.disabled && !thread?.pending && now() - flight.at >= flight.budget) {
          // Only this unresponsive button becomes retryable. Other threads are
          // neither restarted nor slowed down by it.
          inFlight.delete(group);
        } else if (!control && !thread?.pending && !snapshot.loading
          && now() - flight.at >= Math.max(6000, flight.budget * 3)) {
          inFlight.delete(group);
        }
      }
      report();
      const exhausted = !controls.length && !snapshot.loading && !snapshot.unreadableCount
        && snapshot.atBottom === true && inFlight.size === 0;
      if (allComments && exhausted && countMatches()) {
        if (proofFingerprint === fingerprint) stableRounds += 1;
        else { proofFingerprint = fingerprint; stableRounds = 0; }
        const extraQuiet = options.settleMs ?? 0; // opt-in test/diagnostic override only
        if (stableRounds >= 2 && now() - Math.max(lastChangeAt, lastActionAt) >= extraQuiet) {
          complete = true; reason = "complete"; break;
        }
        forceRead = true;
        if (extraQuiet > 0 && stableRounds >= 2) await changed(Math.max(1, extraQuiet - (now() - Math.max(lastChangeAt, lastActionAt))));
        else await nextTurn();
        continue;
      }
      stableRounds = 0; proofFingerprint = "";
      if (!allComments && !controls.length && !snapshot.loading) { reason = "preview"; break; }

      let acted = false;
      const concurrency = options.maxConcurrent ?? (adapter.supportsThreadTracking || snapshot.threadStates ? 3 : 1);
      for (const control of controls) {
        if (inFlight.size >= concurrency) break;
        const group = control.groupKey || control.key;
        if (control.disabled || inFlight.has(group)) continue;
        const previous = attempts.get(control.key);
        const sameRevision = previous?.revision === control.revision;
        const count = sameRevision ? previous.count + 1 : 1;
        if (count > maxAttempts || (sameRevision && now() < previous.nextAt)) continue;
        const responseBudget = budget();
        if (await adapter.click(control) !== false) {
          attempts.set(control.key, { revision: control.revision, count, nextAt: now() + responseBudget });
          inFlight.set(group, { key: control.key, revision: control.revision,
            threadRevision: snapshot.threadStates?.[group]?.revision ?? snapshot.threadStates?.[control.key]?.revision,
            at: now(), budget: responseBudget });
          peakInFlight = Math.max(peakInFlight, inFlight.size);
          expandedCount += control.kind === "retry" ? 0 : 1;
          retryCount += control.kind === "retry" || count > 1 ? 1 : 0;
          lastActionAt = now(); acted = true;
        }
      }
      if (!acted && allComments && !snapshot.atBottom) {
        let fastJump = false;
        if (domAlreadyFull && !controls.length && !snapshot.loading && !inFlight.size) {
          fastJump = true;
          acted = await scroll("end");
        } else if (!inFlight.size && !snapshot.loading) {
          acted = await scroll("next");
        }
        if (acted) { await (fastJump ? nextTurn() : renderedView()); continue; }
      }

      const idleFor = now() - Math.max(lastChangeAt, lastActionAt);
      const hasPending = snapshot.loading || [...inFlight.keys()].some((group) => snapshot.threadStates?.[group]?.pending);
      const stallWindow = options.stallMs ?? (hasPending ? Math.max(12000, budget() * 4)
        : inFlight.size ? Math.max(6000, budget() * 3) : Math.max(1800, budget() * 1.5));
      if (!acted && idleFor >= stallWindow) {
        // An exhausted/stuck button cannot be fixed by scrolling every already
        // verified thread again. Only an unexplained count gap gets one sweep.
        if (controls.length || hasPending || pass >= maxPasses) { reason = "stalled"; break; }
        pass += 1; retryCount += 1; inFlight.clear(); report(true);
        await scroll("start");
        forceRead = true; lastChangeAt = now(); lastActionAt = now();
        await renderedView();
        continue;
      }
      // DOM mutations wake this immediately; this is a watchdog, not an added
      // wait per comment, per scroll step, or per completed post.
      const retryAt = Math.min(...[...inFlight.values()].map((flight) => flight.at + flight.budget).filter((time) => time > now()));
      const waitMs = Math.max(20, Math.min(500, Number.isFinite(retryAt) ? retryAt - now() : 500));
      await changed(waitMs);
    }
    const finalInterruption = adapter.interruption?.();
    if (finalInterruption) { interrupted = true; complete = false; reason = finalInterruption; }
    const evidence = {
      collectorVersion: 4, allCommentsRequested: allComments,
      expectedCountKnown, expectedCountSource: snapshot.expectedCountSource || (expectedCountKnown ? "legacy" : "unknown"),
      countConflict: Boolean(snapshot.countConflict),
      expandersExhausted: Boolean(snapshot.ready) && !(snapshot.controls || []).length,
      scrollExhausted: snapshot.atBottom === true,
      stableRounds: complete ? stableRounds : 0,
      pendingLoads: Boolean(snapshot.loading) || inFlight.size > 0,
      unreadableCount: Number(snapshot.unreadableCount) || 0,
      passes: pass, retryCount, readCount, scrollCount, peakInFlight,
      domReads: adapter.getDiagnostics?.() || null,
      elapsedMs: Math.max(0, now() - startedAt), reason
    };
    const explicitEmptyVerified = complete && comments.size === 0 && snapshot.explicitEmpty === true;
    const result = { comments: [...comments.values()], expectedCount, expectedCountKnown, expandedCount, explicitEmptyVerified,
      collectionEvidence: evidence, status: complete ? "likely_complete" : "partial", interrupted, reason };
    result.commentError = complete ? "" : describeIncomplete(result);
    report(true);
    return result;
  }

  function describeIncomplete(result) {
    const evidence = result.collectionEvidence || {};
    const count = result.comments?.length || 0;
    const known = result.expectedCountKnown === true || result.expectedCount > 0 || result.explicitEmptyVerified === true;
    const prefix = `已读取 ${count}/${known ? result.expectedCount : "未知"} 条评论`;
    if (result.reason === "cancelled") return `${prefix}，采集已停止，保留已有评论`;
    if (result.reason === "note_changed") return `${prefix}，当前帖子已切换，已停止本次采集`;
    if (evidence.unreadableCount) return `${prefix}，还有 ${evidence.unreadableCount} 条内容尚未加载`;
    if (evidence.pendingLoads) return `${prefix}，页面仍有未完成的加载任务，已保留已有评论`;
    if (evidence.countConflict) return `${prefix}，页面评论计数与空状态提示冲突，保留历史评论等待核验`;
    if (!evidence.expandersExhausted) return `${prefix}，部分回复展开失败，已定向重试并保留已有评论`;
    if (!known) return `${prefix}，页面未提供可核验的评论总数或原生空评论提示`;
    if (!result.expectedCount && !result.explicitEmptyVerified) return `${prefix}，尚未确认原生空评论状态，历史评论已保留`;
    return `${prefix}，补读后仍与页面总数不一致，未据此标记评论删除`;
  }

  return { collect, describeIncomplete };
});
