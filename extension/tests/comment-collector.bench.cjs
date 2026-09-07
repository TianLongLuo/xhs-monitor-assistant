#!/usr/bin/env node
"use strict";

// Synthetic / virtual-clock controller benchmark, not a network, browser, DOM
// parsing, or cache-throughput benchmark. Reads, clicks and scrolls cost zero
// virtual CPU time; only simulated waits advance time. No DB/browser is opened.
// The first CLI argument is the old, self-contained collector JS. The current
// collector is resolved relative to this file. Both sources are captured once,
// then each run gets a fresh VM, fixture, event queue and identical options.
// Default: correctness is mandatory; speedups are reported while mainline work
// is in progress. --strict-speed also requires both fast paths to improve.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createHash } = require("node:crypto");

const MEASUREMENT = "synthetic/virtual-clock";
const NOTE_ID = "comment-collector-bench-note";
const OPTIONS = Object.freeze({
  noteId: NOTE_ID,
  allComments: true,
  timeoutMs: 120000
});
const MAX_OPERATIONS = 100000;
const MAX_VIRTUAL_MS = OPTIONS.timeoutMs + 30000;

function duration(ms) {
  assert.ok(Number.isFinite(ms) && ms >= 0, "wait/delay must be finite and nonnegative");
  return ms;
}

class VirtualClock {
  constructor() {
    this.time = 0;
    this.jobs = [];
    this.sequence = 0;
    this.operations = 0;
  }

  touch() {
    assert.ok(++this.operations <= MAX_OPERATIONS,
      "virtual operation budget exhausted (possible zero-time busy loop)");
  }

  // Every queued job is a simulated DOM mutation, including same-timestamp
  // click/scroll paints. Sequence numbers make simultaneous mutations stable.
  later(ms, mutate) {
    this.touch();
    this.jobs.push({ at: this.time + duration(ms), order: ++this.sequence, mutate });
    this.jobs.sort((a, b) => a.at - b.at || a.order - b.order);
  }

  advanceTo(deadline) {
    this.touch();
    assert.ok(deadline >= this.time && deadline <= MAX_VIRTUAL_MS,
      "virtual time limit exceeded or clock moved backwards");
    while (this.jobs.length && this.jobs[0].at <= deadline) {
      this.touch();
      const job = this.jobs.shift();
      this.time = job.at;
      job.mutate();
    }
    this.time = deadline;
  }

  flush() {
    this.advanceTo(this.time);
  }

  wait(ms) {
    // Apply intermediate mutations AT their scheduled times, but never return
    // early. A reply due at 800ms stays due at 800ms even if a poll ends at 960ms.
    this.advanceTo(this.time + duration(ms));
  }

  waitForChange(ms) {
    const deadline = this.time + duration(ms);
    const next = this.jobs[0];
    if (next && next.at <= deadline) {
      // Coalesce every mutation at that timestamp before the next read.
      this.advanceTo(next.at);
      return true;
    }
    this.advanceTo(deadline);
    return false;
  }
}

function row(id, parent = "") {
  return { commentId: id, noteId: NOTE_ID, content: "fixture " + id, parentCommentId: parent };
}

const CASES = Object.freeze([
  { id: "loaded-dom-40-long-scroll", type: "long", fastPath: true,
    description: "40 rows already in DOM; 48 next-scroll steps or one end jump" },
  { id: "independent-threads-12x800ms", type: "threads", fastPath: true,
    threads: 12, replies: 2, latencyMs: 800, loadingIndicator: true,
    description: "12 independent hidden-on-click reply groups; each arrives 800ms after its own click" },
  { id: "hidden-button-reply-4100ms", type: "threads",
    threads: 1, replies: 1, latencyMs: 4100, loadingIndicator: false,
    description: "button hides immediately; no loading spinner; reply arrives after 4100ms" },
  { id: "lost-first-click-retry", type: "threads",
    threads: 1, replies: 1, latencyMs: 1100, loadingIndicator: true, loseFirstClick: true,
    description: "first dispatch returns true but has no effect; second dispatch loads the reply" },
  { id: "count-5-dom-4-no-controls", type: "mismatch",
    description: "reported total 5, actual 4; no controls; both collectors must remain partial" },
  { id: "virtual-list-8-pages", type: "virtual",
    description: "8 recycled pages of 5 rows, initially at bottom; end really skips intermediate pages" }
]);

function createFixture(spec, capabilities = {}) {
  const events = capabilities.events !== false;
  const threadStates = capabilities.threadStates !== false;
  const clock = new VirtualClock();
  const metrics = {
    readCount: 0, forceReadCount: 0, clickCount: 0, scrollCount: 0,
    waitCount: 0, changeWaitCount: 0, eventWakeCount: 0,
    requestedWaitMs: 0, waitedMs: 0, progressCount: 0,
    scrollDirections: { start: 0, next: 0, end: 0 }
  };
  const clicks = [];
  const arrivals = [];
  const pagesRead = new Set();
  let unsafeEndCount = 0;
  let snapshot = () => ({});
  let click = () => false;
  let scroll = () => false;
  let expectedRows;
  let expectedCount;
  let expectedClicks = 0;
  let pageCount = 0;

  if (spec.type === "long") {
    expectedRows = Array.from({ length: 40 }, (_, i) => row("dom-" + (i + 1)));
    expectedCount = expectedRows.length;
    const last = 48;
    let position = 0;
    snapshot = () => ({
      comments: expectedRows, expectedCount, atBottom: position === last,
      scrollHeight: (last + 1) * 800, scrollKey: "long:" + position
    });
    scroll = (direction) => {
      const next = direction === "start" ? 0
        : direction === "end" ? last : Math.min(last, position + 1);
      if (next === position) return false;
      clock.later(0, () => { position = next; });
      return true;
    };
  } else if (spec.type === "threads") {
    const threads = Array.from({ length: spec.threads }, (_, i) => {
      const key = "thread-" + (i + 1);
      return { key, revision: "replies-0", visible: true, pending: false,
        accepted: false, attempts: 0, root: row(key),
        replies: Array.from({ length: spec.replies }, (_, j) => row(key + "-reply-" + (j + 1), key)) };
    });
    const visibleRows = threads.map((thread) => thread.root);
    expectedRows = threads.flatMap((thread) => [thread.root, ...thread.replies]);
    expectedCount = expectedRows.length;
    expectedClicks = threads.length + (spec.loseFirstClick ? 1 : 0);
    snapshot = () => ({
      comments: visibleRows,
      expectedCount,
      controls: threads.filter((thread) => thread.visible).map((thread) => ({
        key: thread.key, revision: thread.revision, kind: "replies", disabled: false
      })),
      loading: spec.loadingIndicator && threads.some((thread) => thread.pending),
      atBottom: true,
      scrollHeight: 800 + visibleRows.length * 60,
      scrollKey: "threads",
      ...(threadStates ? { threadStates: Object.fromEntries(threads.map((thread) => [
        thread.key, { revision: thread.revision, pending: thread.pending }
      ])) } : {})
    });
    click = (control) => {
      const thread = threads.find((candidate) => candidate.key === control.key);
      if (!thread || !thread.visible || thread.accepted || control.disabled
          || control.revision !== thread.revision) return false;
      thread.attempts += 1;
      // Successful dispatch does NOT mean that the DOM/network accepted it.
      // Keep exactly the same key and revision so a real retry is necessary.
      if (spec.loseFirstClick && thread.attempts === 1) return true;
      thread.accepted = true;
      clock.later(0, () => { thread.visible = false; thread.pending = true; });
      clock.later(spec.latencyMs, () => {
        visibleRows.push(...thread.replies);
        thread.pending = false;
        thread.revision = "replies-1";
        arrivals.push({ key: thread.key, at: clock.time });
      });
      return true;
    };
  } else if (spec.type === "mismatch") {
    expectedRows = Array.from({ length: 4 }, (_, i) => row("mismatch-" + (i + 1)));
    expectedCount = 5;
    snapshot = () => ({
      comments: expectedRows, expectedCount, atBottom: true,
      scrollHeight: 640, scrollKey: "mismatch"
    });
  } else if (spec.type === "virtual") {
    pageCount = 8;
    const pages = Array.from({ length: pageCount }, (_, page) =>
      Array.from({ length: 5 }, (_, i) => row("virtual-" + (page * 5 + i + 1))));
    expectedRows = pages.flat();
    expectedCount = expectedRows.length;
    let page = pageCount - 1;
    snapshot = () => {
      pagesRead.add(page);
      return {
        comments: pages[page], expectedCount, atBottom: page === pageCount - 1,
        scrollHeight: pageCount * 800, scrollKey: "virtual:" + page
      };
    };
    scroll = (direction) => {
      const next = direction === "start" ? 0
        : direction === "end" ? pageCount - 1 : Math.min(pageCount - 1, page + 1);
      if (direction === "end") {
        for (let skipped = page + 1; skipped < next; skipped += 1) {
          if (!pagesRead.has(skipped)) { unsafeEndCount += 1; break; }
        }
      }
      if (next === page) return false;
      // Deliberately REPLACE visible rows. Never accumulate them in this fixture
      // or reinterpret end as next: doing so would hide a lossy collector.
      clock.later(0, () => { page = next; });
      return true;
    };
  } else {
    throw new Error("unknown fixture type: " + spec.type);
  }

  function measuredWait(ms, wakeOnChange) {
    clock.touch();
    metrics.requestedWaitMs += duration(ms);
    const before = clock.time;
    const changed = wakeOnChange ? clock.waitForChange(ms) : (clock.wait(ms), false);
    metrics.waitedMs += clock.time - before;
    if (changed) metrics.eventWakeCount += 1;
    return changed;
  }

  const adapter = {
    now() { clock.touch(); return clock.time; },
    async wait(ms) { metrics.waitCount += 1; measuredWait(ms, false); },
    async read(options) {
      clock.flush();
      metrics.readCount += 1;
      if (options?.force === true) metrics.forceReadCount += 1;
      // force is accepted without changing semantics: every read is a fresh
      // in-memory snapshot, not a production DOM-cache hit/miss measurement.
      return JSON.parse(JSON.stringify({
        ready: true, comments: [], expectedCount: 0, controls: [], loading: false,
        atBottom: true, explicitEmpty: false, unreadableCount: 0,
        scrollHeight: 800, scrollKey: spec.id,
        ...snapshot()
      }));
    },
    async click(control) {
      clock.flush();
      metrics.clickCount += 1;
      const action = { key: control?.key, revision: control?.revision, at: clock.time };
      clicks.push(action);
      action.accepted = Boolean(control && click(control));
      return action.accepted;
    },
    async scroll(direction) {
      clock.flush();
      assert.ok(Object.hasOwn(metrics.scrollDirections, direction), "unknown scroll direction: " + direction);
      metrics.scrollCount += 1;
      metrics.scrollDirections[direction] += 1;
      return scroll(direction);
    },
    interruption() { clock.touch(); return ""; },
    onProgress() { clock.touch(); metrics.progressCount += 1; }
  };
  if (events) {
    adapter.waitForChange = async (timeoutMs) => {
      metrics.changeWaitCount += 1;
      return measuredWait(timeoutMs, true);
    };
  }

  return {
    clock, adapter, metrics, clicks, arrivals,
    expectedIDs: expectedRows.map((item) => item.commentId).sort(),
    expectedCount,
    expectedStatus: spec.type === "mismatch" ? "partial" : "likely_complete",
    check(result, ids) {
      const issues = [];
      const check = (condition, message) => { if (!condition) issues.push(message); };
      check(result?.status === this.expectedStatus, "expected status " + this.expectedStatus);
      check(result?.expectedCount === expectedCount, "expected reported total " + expectedCount);
      check(sameIDs(ids, this.expectedIDs), "IDs differ from fixture oracle; missing=" +
        JSON.stringify(this.expectedIDs.filter((id) => !ids.includes(id))) +
        " extra=" + JSON.stringify(ids.filter((id) => !this.expectedIDs.includes(id))));
      check(Array.isArray(result?.comments), "comments must be an array");
      check(result?.comments?.length === ids.length, "duplicate or invalid comment IDs");
      check(Array.from(result?.comments || []).every((item) => item?.noteId === NOTE_ID),
        "foreign or missing noteId");
      check(result?.interrupted !== true, "unexpected interruption");
      check(metrics.readCount > 0, "collector performed no reads");
      check(metrics.clickCount === expectedClicks, "expected " + expectedClicks + " click attempts");
      if (spec.type === "threads") {
        check(arrivals.length === spec.threads, "returned before all reply groups arrived");
        check(clock.jobs.length === 0, "returned with scheduled DOM mutations still pending");
        if (spec.latencyMs === 4100) check(clock.time >= 4100, "returned before the 4100ms reply");
        if (spec.loseFirstClick) {
          check(clicks.length === 2 && clicks[1].at > clicks[0].at,
            "lost click must be retried after time advances");
        }
      }
      if (spec.type === "virtual") {
        check(pagesRead.size === pageCount, "every recycled page must actually be read");
        check(unsafeEndCount === 0, "end skipped unread virtual pages");
      }
      return issues;
    },
    diagnostics() {
      return { clicks, arrivals, pagesRead: [...pagesRead].sort((a, b) => a - b), unsafeEndCount };
    }
  };
}

function sameIDs(left, right) {
  return left.length === right.length && left.every((id, i) => id === right[i]);
}

function loadCollector(source, clock) {
  const moduleObject = { exports: {} };
  const noTimers = () => {
    throw new Error("Use adapter.wait/waitForChange in this virtual-clock benchmark; host timers are not available");
  };
  class VirtualDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock.time])); }
    static now() { clock.touch(); return clock.time; }
  }
  const context = vm.createContext({
    module: moduleObject, exports: moduleObject.exports,
    Date: VirtualDate, performance: { now: () => clock.time },
    setTimeout: noTimers, setInterval: noTimers, setImmediate: noTimers
    // No require, process, fetch, browser or database handles are supplied.
  });
  // This timeout only guards module initialization; it is not a timing metric.
  new vm.Script(source.code, { filename: source.path }).runInContext(context, { timeout: 1000 });
  const api = typeof moduleObject.exports.collect === "function"
    ? moduleObject.exports : context.XhsMonitorCommentCollector;
  assert.equal(typeof api?.collect, "function", "collector must export collect(adapter, options)");
  return api;
}

async function runOne(source, spec, capabilities) {
  const fixture = createFixture(spec, capabilities);
  let result;
  let error = "";
  let ids = [];
  let issues = [];
  try {
    result = await loadCollector(source, fixture.clock).collect(fixture.adapter, { ...OPTIONS });
    ids = [...new Set(Array.from(result?.comments || [], (item) => item?.commentId)
      .filter((id) => typeof id === "string" && id.length > 0))].sort();
    issues = fixture.check(result, ids);
  } catch (failure) {
    error = String(failure?.stack || failure);
    issues.push("collector/harness error: " + String(failure?.message || failure));
  }
  return {
    elapsedMs: fixture.clock.time,
    ...fixture.metrics,
    status: result?.status || "error",
    reason: result?.reason || "",
    expectedCount: result?.expectedCount ?? null,
    ids, issues,
    ...(error ? { error } : {}),
    ...fixture.diagnostics()
  };
}

function compare(spec, oldRun, currentRun) {
  const IDsEqual = sameIDs(oldRun.ids, currentRun.ids);
  const statusEqual = oldRun.status === currentRun.status;
  const issues = [
    ...oldRun.issues.map((issue) => "old: " + issue),
    ...currentRun.issues.map((issue) => "current: " + issue)
  ];
  if (!IDsEqual) issues.push("old/current ID sets differ");
  if (!statusEqual) issues.push("old/current statuses differ");
  const correct = issues.length === 0;
  const waitSavedMs = oldRun.waitedMs - currentRun.waitedMs;
  return {
    case: spec.id, description: spec.description, fastPath: Boolean(spec.fastPath),
    old: oldRun, current: currentRun, IDsEqual, statusEqual, correct, issues,
    elapsedSavedMs: oldRun.elapsedMs - currentRun.elapsedMs,
    waitSavedMs,
    speedup: currentRun.elapsedMs > 0 ? oldRun.elapsedMs / currentRun.elapsedMs : null,
    speedCheck: !spec.fastPath ? "not-required"
      : !correct ? "invalid-correctness" : waitSavedMs > 0 ? "pass" : "not-improved"
  };
}

function verifyClock() {
  const polled = new VirtualClock();
  const observed = [];
  polled.later(800, () => {
    observed.push(polled.time);
    polled.later(100, () => observed.push(polled.time));
  });
  polled.wait(960);
  assert.equal(polled.time, 960);
  assert.deepEqual(observed, [800, 900]);

  const evented = new VirtualClock();
  const changes = [];
  evented.later(0, () => changes.push("paint"));
  assert.equal(evented.waitForChange(240), true);
  assert.equal(evented.time, 0);
  evented.later(800, () => changes.push("a"));
  evented.later(800, () => changes.push("b"));
  assert.equal(evented.waitForChange(500), false);
  assert.equal(evented.time, 500);
  assert.equal(evented.waitForChange(500), true);
  assert.equal(evented.time, 800);
  assert.deepEqual(changes, ["paint", "a", "b"]);
  assert.equal(evented.waitForChange(240), false);
  assert.equal(evented.time, 1040);
  evented.later(50, () => changes.push("boundary"));
  assert.equal(evented.waitForChange(50), true);
  assert.equal(evented.time, 1090);
  assert.throws(() => evented.wait(-1), /finite and nonnegative/);
}

function readSource(filename) {
  const resolved = path.resolve(filename);
  const code = fs.readFileSync(resolved, "utf8");
  return { path: resolved, code, sha256: createHash("sha256").update(code).digest("hex") };
}

function help() {
  console.log([
    "Usage: node " + JSON.stringify(__filename) + " OLD_COLLECTOR_JS [options]",
    "",
    "synthetic/virtual-clock: no real network/browser performance is measured.",
    "OLD_COLLECTOR_JS is required as the first argument; no user path is embedded.",
    "Current collector: " + path.resolve(__dirname, "../comment-collector.js"),
    "",
    "  --json              Emit one JSON report, including ID sets and diagnostics.",
    "  --strict-speed      Also fail unless both designated fast paths save virtual wait time.",
    "  --no-events         Omit optional adapter.waitForChange on BOTH runs.",
    "  --no-thread-states  Omit optional snapshot.threadStates on BOTH runs.",
    "  --help              Show this usage.",
    "",
    "Default checks fixture-oracle IDs/status AND old/current parity. Speed-only",
    "non-improvements are reported without failing while production work is pending.",
    "Exit codes: 0 checks pass; 1 correctness/strict-speed failure; 2 setup/usage error.",
    "readCount includes force reads; scrollCount includes start and unsuccessful calls.",
    "CLI writes only stdout/stderr. Each run has an independent virtual clock."
  ].join("\n"));
}

function printReport(report) {
  console.log(report.measurement + " — 纯内存虚拟等待；不代表真实网络、浏览器或 DOM 缓存性能。");
  console.log("old: " + report.sources.old.path);
  console.log("current: " + report.sources.current.path);
  console.log("adapter: waitForChange=" + report.capabilities.events +
    ", threadStates=" + report.capabilities.threadStates);
  const rows = report.cases.flatMap((item) => ["old", "current"].map((version) => {
    const run = item[version];
    return { case: item.case, collector: version, elapsedMs: run.elapsedMs,
      readCount: run.readCount, clickCount: run.clickCount, scrollCount: run.scrollCount,
      status: run.status, IDsEqual: item.IDsEqual };
  }));
  console.table(rows);
  console.log("状态 / ID 集合 / 夹具预期: " + (report.correctnessPassed ? "PASS" : "FAIL"));
  console.table(report.cases.filter((item) => item.fastPath).map((item) => ({
    case: item.case, waitSavedMs: item.waitSavedMs,
    elapsedSavedMs: item.elapsedSavedMs,
    speedup: item.speedup === null ? "n/a" : item.speedup.toFixed(2) + "x",
    speedCheck: item.speedCheck
  })));
  for (const item of report.cases) {
    for (const issue of item.issues) console.error("FAIL " + item.case + ": " + issue);
  }
  if (!report.speedPassed) {
    console.log(report.identicalSources
      ? "当前源码与旧版相同；快路径暂未改善，主线完成后重跑 --strict-speed。"
      : "快路径等待减少检查尚未全部通过；生产代码完成后可用 --strict-speed 强制验证。");
  }
}

async function main(args) {
  if (args.length === 1 && args[0] === "--help") { help(); return 0; }
  if (!args.length || args[0].startsWith("--")) {
    help();
    return 2;
  }
  const supported = new Set(["--json", "--strict-speed", "--no-events", "--no-thread-states"]);
  for (const arg of args.slice(1)) {
    if (!supported.has(arg)) throw new Error("unknown option: " + arg);
  }
  const flags = new Set(args.slice(1));
  const capabilities = {
    events: !flags.has("--no-events"),
    threadStates: !flags.has("--no-thread-states")
  };
  verifyClock();
  const oldSource = readSource(args[0]);
  const currentSource = readSource(path.resolve(__dirname, "../comment-collector.js"));
  const comparisons = [];
  for (const spec of CASES) {
    // Deliberately sequential: isolation and identical inputs, not real-time
    // concurrency or order-sensitive shared module/fixture state.
    const oldRun = await runOne(oldSource, spec, capabilities);
    const currentRun = await runOne(currentSource, spec, capabilities);
    comparisons.push(compare(spec, oldRun, currentRun));
  }
  const correctnessPassed = comparisons.every((item) => item.correct);
  const speedPassed = comparisons.filter((item) => item.fastPath)
    .every((item) => item.speedCheck === "pass");
  const strictSpeed = flags.has("--strict-speed");
  const report = {
    measurement: MEASUREMENT,
    disclaimer: "Synthetic, virtual-clock fixture waits only; not real network/browser/DOM-cache performance.",
    options: OPTIONS, capabilities, strictSpeed,
    sources: {
      old: { path: oldSource.path, sha256: oldSource.sha256 },
      current: { path: currentSource.path, sha256: currentSource.sha256 }
    },
    identicalSources: oldSource.sha256 === currentSource.sha256,
    correctnessPassed, speedPassed,
    passed: correctnessPassed && (!strictSpeed || speedPassed),
    cases: comparisons
  };
  if (flags.has("--json")) console.log(JSON.stringify(report, null, 2));
  else printReport(report);
  return report.passed ? 0 : 1;
}

// Exports allow in-memory harness/oracle checks without extra test files or CLI I/O.
module.exports = { VirtualClock, CASES, createFixture, runOne, compare, verifyClock, main };

if (require.main === module) {
  process.exitCode = 2; // Do not silently pass an unresolved collector Promise.
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(MEASUREMENT + " setup error: " + String(error?.stack || error));
    process.exitCode = 2;
  });
}
