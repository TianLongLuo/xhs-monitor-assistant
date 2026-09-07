"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { collect } = require("../comment-collector.js");
const row = (id, parent = "") => ({ commentId: id, noteId: "note-fixture", content: `正文 ${id}`, parentCommentId: parent });

function fixture(overrides = {}) {
  let clock = 0;
  const jobs = [];
  const actions = [];
  const progress = [];
  const state = { ready: true, comments: [row("c1")], expectedCount: 1, controls: [], loading: false,
    atBottom: true, explicitEmpty: false, scrollHeight: 200, scrollKey: "scroller", unreadableCount: 0, ...overrides };
  const reads = [];
  const h = { state, actions, progress, reads, now: () => clock,
    later(ms, fn) { jobs.push({ at: clock + ms, fn }); },
    adapter: {
      now: () => clock,
      async wait(ms) {
        const end = clock + ms;
        while (true) {
          jobs.sort((a, b) => a.at - b.at);
          if (!jobs.length || jobs[0].at > end) break;
          const job = jobs.shift(); clock = job.at; job.fn();
        }
        clock = end;
      },
      read: (options) => { reads.push(options); return { ...state, comments: [...state.comments], controls: [...state.controls] }; },
      click(control) { actions.push({ action: "click", key: control.key, at: clock }); return h.onClick?.(control); },
      scroll(direction) { actions.push({ action: direction, at: clock }); return h.onScroll?.(direction) || false; },
      interruption: () => h.interrupted || "",
      onProgress: (value) => progress.push(value)
    },
    eventDriven() {
      h.adapter.waitForChange = async (ms) => {
        const next = Math.min(...jobs.map((job) => job.at).filter((at) => at >= clock));
        await h.adapter.wait(Math.max(0, Math.min(ms, next - clock)));
      };
      return h;
    },
    run(options = {}) { return collect(h.adapter, { noteId: "note-fixture", ...options }); }
  };
  return h;
}

test("already-complete data finishes after two forced DOM confirmations, without a fixed 2.4s delay", async () => {
  const h = fixture();
  const result = await h.run();
  assert.equal(result.status, "likely_complete");
  assert.ok(h.now() > 0 && h.now() <= 200);
  assert.ok(h.reads.filter((read) => read?.force).length >= 2);
  assert.equal(h.actions.length, 0, "an already-complete list needs no rewind");
  assert.ok(result.collectionEvidence.stableRounds >= 2);
  assert.equal(result.collectionEvidence.allCommentsRequested, true);
});

test("hidden expand button with delayed reply still waits for count to catch up", async () => {
  const h = fixture({ expectedCount: 2, controls: [{ key: "c1", revision: "1" }] });
  h.onClick = () => {
    h.state.controls = [];
    h.later(4100, () => h.state.comments.push(row("c2", "c1")));
  };
  const result = await h.run();
  assert.equal(result.status, "likely_complete");
  assert.equal(result.comments.length, 2);
  assert.equal(h.actions.filter((a) => a.action === "click").length, 1);
});

test("loading placeholder blocks premature completion even when count already matches", async () => {
  const h = fixture({ loading: true });
  h.later(4300, () => { h.state.loading = false; });
  const result = await h.run();
  assert.equal(result.status, "likely_complete");
  assert.ok(h.now() >= 4300 && h.now() < 5000, "wait for the actual loader, not an extra global quiet period");
});

test("a missed first click retries with cooldown instead of hammering the thread", async () => {
  const h = fixture({ expectedCount: 2, controls: [{ key: "c1", revision: "1" }] });
  let clicks = 0;
  h.onClick = () => {
    if (++clicks === 2) {
      h.state.controls = [];
      h.later(1100, () => h.state.comments.push(row("c2", "c1")));
    }
  };
  const result = await h.run();
  assert.equal(result.status, "likely_complete");
  const times = h.actions.filter((a) => a.action === "click").map((a) => a.at);
  assert.equal(times.length, 2);
  assert.ok(times[1] - times[0] >= 1000 && times[1] - times[0] < 2600);
  assert.ok(result.collectionEvidence.retryCount >= 1);
});

test("adapters without per-thread response evidence retain conservative serial behavior", async () => {
  const h = fixture({ expectedCount: 9,
    controls: Array.from({ length: 8 }, (_, n) => ({ key: `t${n}`, revision: "1" })) });
  h.onClick = (control) => {
    h.state.controls = h.state.controls.filter((item) => item.key !== control.key);
    h.later(800, () => h.state.comments.push(row(control.key, "c1")));
  };
  const result = await h.run();
  assert.equal(result.status, "likely_complete");
  const clicks = h.actions.filter((a) => a.action === "click");
  assert.equal(clicks.length, 8);
  assert.ok(clicks.slice(1).every((item, i) => item.at - clicks[i].at >= 480));
});

test("a reused load-more node may load successive pages after its revision changes", async () => {
  const h = fixture({ expectedCount: 7, controls: [{ key: "more", revision: "1" }] });
  let n = 1;
  h.onClick = () => {
    h.state.controls[0].disabled = true;
    h.later(600, () => {
      h.state.comments.push(row(`c${++n}`));
      h.state.controls = n === 7 ? [] : [{ key: "more", revision: String(n) }];
    });
  };
  const result = await h.run();
  assert.equal(result.status, "likely_complete");
  assert.equal(result.comments.length, 7);
});

test("virtualized pages retain already-read rows and start from the top", async () => {
  const pages = [[row("c1"), row("c2")], [row("c3"), row("c4")], [row("c5")]];
  const h = fixture({ comments: pages[2], expectedCount: 5 });
  let page = 2;
  h.onScroll = (direction) => {
    const before = page;
    page = direction === "start" ? 0 : Math.min(2, page + 1);
    h.state.comments = pages[page];
    h.state.atBottom = page === 2;
    return page !== before;
  };
  const result = await h.run();
  assert.equal(result.status, "likely_complete");
  assert.deepEqual(result.comments.map((item) => item.commentId), ["c1", "c2", "c3", "c4", "c5"]);
  assert.equal(h.actions[0].action, "start");
});

test("a lazy bottom grows after scroll and is traversed again", async () => {
  const h = fixture({ expectedCount: 3, atBottom: false });
  let advances = 0;
  h.onScroll = (direction) => {
    if (direction === "start" || h.state.atBottom) return false;
    h.state.atBottom = true;
    if (++advances === 1) h.later(1900, () => {
      h.state.comments.push(row("c2")); h.state.scrollHeight += 300; h.state.atBottom = false;
    });
    else h.later(1700, () => h.state.comments.push(row("c3")));
    return true;
  };
  const result = await h.run();
  assert.equal(result.status, "likely_complete");
  assert.equal(advances, 2);
});

test("a second full sweep recovers a thread omitted by the first lazy pass", async () => {
  const h = fixture({ expectedCount: 2 });
  let sweeps = 0;
  h.onScroll = (direction) => {
    if (direction === "start" && ++sweeps === 2) h.state.comments.push(row("c2"));
  };
  const result = await h.run();
  assert.equal(result.status, "likely_complete");
  assert.equal(result.collectionEvidence.passes, 2);
});

test("permanent count mismatch gets one recovery sweep, remains partial and never lowers the expected total", async () => {
  const h = fixture({ expectedCount: 5 });
  h.later(1000, () => { h.state.expectedCount = 1; });
  const result = await h.run();
  assert.equal(result.status, "partial");
  assert.equal(result.expectedCount, 5);
  assert.equal(result.collectionEvidence.passes, 2);
  assert.ok(h.now() < 7000, "do not spend three long waits on an unchanged count gap");
  assert.equal(result.collectionEvidence.stableRounds, 0);
  assert.match(result.commentError, /未据此标记评论删除/);
});

test("permanently disabled expander is not counted as exhausted", async () => {
  const h = fixture({ controls: [{ key: "c1", revision: "1", disabled: true }] });
  const result = await h.run();
  assert.equal(result.status, "partial");
  assert.equal(result.collectionEvidence.expandersExhausted, false);
  assert.equal(h.actions.some((a) => a.action === "click"), false);
});

test("failed load uses its retry control and succeeds", async () => {
  const h = fixture({ expectedCount: 2, controls: [{ key: "retry", kind: "retry", revision: "failed" }] });
  h.onClick = () => { h.state.controls = []; h.later(2300, () => h.state.comments.push(row("c2"))); };
  const result = await h.run();
  assert.equal(result.status, "likely_complete");
  assert.equal(result.expandedCount, 0);
  assert.equal(result.collectionEvidence.retryCount, 1);
});

test("image-only placeholder is a valid, separately identified comment", async () => {
  const h = fixture({ expectedCount: 2, comments: [row("c1"), { ...row("photo"), content: "[图片]", imageUrls: ["https://example.invalid/comment.jpg"] }] });
  const result = await h.run();
  assert.equal(result.status, "likely_complete");
  assert.deepEqual(result.comments[1].imageUrls, ["https://example.invalid/comment.jpg"]);
});

test("unparsed comment nodes veto completeness rather than silently dropping a row", async () => {
  const result = await fixture({ unreadableCount: 1 }).run();
  assert.equal(result.status, "partial");
  assert.match(result.commentError, /1 条内容尚未加载/);
});

test("zero comments require a stable explicit empty state", async () => {
  const known = await fixture({ comments: [], expectedCount: 0, explicitEmpty: true }).run();
  assert.equal(known.status, "likely_complete");
  assert.equal(known.explicitEmptyVerified, true);
  const unknown = await fixture({ comments: [], expectedCount: 0 }).run();
  assert.equal(unknown.status, "partial");
  assert.equal(unknown.explicitEmptyVerified, false);
});

test("verified zero is a known count in progress/evidence and has no recovery sweep", async () => {
  const h = fixture({ comments: [], expectedCount: 0, expectedCountKnown: true,
    expectedCountSource: "native_empty_state", explicitEmpty: true });
  const result = await h.run();
  assert.equal(result.status, "likely_complete");
  assert.equal(result.expectedCountKnown, true);
  assert.equal(result.collectionEvidence.expectedCountSource, "native_empty_state");
  assert.equal(result.collectionEvidence.passes, 1);
  assert.equal(result.collectionEvidence.retryCount, 0);
  assert.equal(h.progress.at(-1).expectedCount, 0);
  assert.equal(h.progress.at(-1).expectedCountKnown, true);
  assert.ok(h.now() <= 200); assert.equal(h.actions.length, 0);
});

test("a numeric zero without native empty evidence remains non-authoritative", async () => {
  const result = await fixture({ comments: [], expectedCount: 0, expectedCountKnown: true }).run();
  assert.equal(result.status, "partial"); assert.equal(result.explicitEmptyVerified, false);
  assert.match(result.commentError, /0\/0.*尚未确认原生空评论状态/);
});

test("native empty cue appearing after loading completes finishes on the first pass", async () => {
  const h = fixture({ comments: [], expectedCount: 0, loading: true }).eventDriven();
  h.later(360, () => { h.state.loading = false; h.state.explicitEmpty = true; h.state.expectedCountKnown = true; });
  const result = await h.run();
  assert.equal(result.status, "likely_complete"); assert.equal(result.explicitEmptyVerified, true);
  assert.ok(h.now() >= 360 && h.now() < 700); assert.equal(result.collectionEvidence.passes, 1);
});

test("a stale empty cue with a loader never ends collection ahead of arriving comments", async () => {
  const h = fixture({ comments: [], expectedCount: 0, explicitEmpty: true, loading: true }).eventDriven();
  h.later(400, () => { h.state.loading = false; h.state.explicitEmpty = false; h.state.expectedCount = 1; h.state.comments = [row("arrived")]; });
  const result = await h.run();
  assert.equal(result.status, "likely_complete"); assert.equal(result.explicitEmptyVerified, false);
  assert.deepEqual(result.comments.map(c => c.commentId), ["arrived"]);
});

test("conflicting native counters veto success even when the collected count matches", async () => {
  const result = await fixture({ countConflict: true }).run();
  assert.equal(result.status, "partial"); assert.equal(result.explicitEmptyVerified, false);
  assert.equal(result.collectionEvidence.countConflict, true);
  assert.match(result.commentError, /冲突/);
});

test("an empty cue that vanishes during fresh verification cannot authorize pruning", async () => {
  const h = fixture({ comments: [], expectedCount: 0, explicitEmpty: true });
  h.later(30, () => { h.state.explicitEmpty = false; });
  const result = await h.run();
  assert.equal(result.status, "partial"); assert.equal(result.explicitEmptyVerified, false);
});

test("comments without a total remain non-authoritative", async () => {
  const result = await fixture({ expectedCount: 0 }).run();
  assert.equal(result.status, "partial");
  assert.match(result.commentError, /页面未提供可核验/);
});

test("duplicate IDs never pad the unique count", async () => {
  const result = await fixture({ expectedCount: 2, comments: [row("c1"), row("c1")] }).run();
  assert.equal(result.status, "partial");
  assert.equal(result.comments.length, 1);
});

test("recycled reply fragment does not erase a previously resolved parent ID", async () => {
  const h = fixture({ comments: [row("c2", "c1")] });
  h.later(1000, () => { h.state.comments = [row("c2")]; });
  const result = await h.run();
  assert.equal(result.comments[0].parentCommentId, "c1");
});

for (const reason of ["cancelled", "note_changed"]) {
  test(`${reason} aborts without a trusted snapshot`, async () => {
    const h = fixture({ expectedCount: 2 });
    h.later(1200, () => { h.interrupted = reason; });
    const result = await h.run();
    assert.equal(result.interrupted, true);
    assert.equal(result.status, "partial");
    assert.equal(result.collectionEvidence.stableRounds, 0);
    assert.ok(h.now() < 1600);
  });
}

test("bounded timeout remains partial even during a permanently active loader", async () => {
  const h = fixture({ loading: true });
  const result = await h.run({ timeoutMs: 2500 });
  assert.equal(result.status, "partial");
  assert.equal(result.reason, "deadline");
  assert.equal(result.collectionEvidence.pendingLoads, true);
});

test("preview cannot authorize removal and a broken progress UI cannot interrupt data", async () => {
  const h = fixture();
  h.adapter.onProgress = () => { throw new Error("panel removed"); };
  const result = await h.run({ allComments: false });
  assert.equal(result.status, "partial");
  assert.equal(result.collectionEvidence.allCommentsRequested, false);
});

test("unsupported or foreign-note rows do not contribute to completeness", async () => {
  const h = fixture({ expectedCount: 2, comments: [row("c1"), { ...row("c2"), noteId: "another-note" }, { content: "no ID" }] });
  const result = await h.run();
  assert.equal(result.status, "partial");
  assert.deepEqual(result.comments.map((item) => item.commentId), ["c1"]);
});

test("fully materialized long list jumps to the end instead of touring every screenful", async () => {
  const h = fixture({ expectedCount: 40, comments: Array.from({ length: 40 }, (_, n) => row(`c${n}`)), atBottom: false });
  h.onScroll = (direction) => {
    assert.equal(direction, "end", "all native comment IDs are already observed");
    h.state.atBottom = true; return true;
  };
  const result = await h.run();
  assert.equal(result.status, "likely_complete");
  assert.equal(h.actions.length, 1);
  assert.ok(h.now() <= 250);
});

test("independent reply groups overlap up to three at a time and release slots on real responses", async () => {
  const controls = Array.from({ length: 12 }, (_, n) => ({ key: `t${n}`, groupKey: `t${n}`, revision: "before" }));
  const threadStates = Object.fromEntries(controls.map((control) => [control.key, { revision: "before", pending: false }]));
  const h = fixture({ expectedCount: 13, controls, threadStates }).eventDriven();
  h.adapter.supportsThreadTracking = true;
  let active = 0, maximum = 0;
  h.onClick = (control) => {
    assert.equal(threadStates[control.key].pending, false, "never overlap requests within a thread");
    threadStates[control.key].pending = true;
    maximum = Math.max(maximum, ++active);
    h.state.controls = h.state.controls.filter((item) => item !== control);
    h.later(800, () => {
      active -= 1;
      h.state.comments.push(row(control.key, "c1"));
      threadStates[control.key] = { revision: "after", pending: false };
    });
  };
  const result = await h.run();
  assert.equal(result.status, "likely_complete");
  assert.equal(result.comments.length, 13);
  assert.equal(maximum, 3);
  assert.equal(result.collectionEvidence.peakInFlight, 3);
  assert.ok(h.now() < 3600, `event-driven collection took ${h.now()}ms`);
});

test("a slow thread is awaited while independent fast threads continue", async () => {
  const controls = Array.from({ length: 7 }, (_, n) => ({ key: `t${n}`, groupKey: `t${n}`, revision: "before" }));
  const threadStates = Object.fromEntries(controls.map((control) => [control.key, { revision: "before", pending: false }]));
  const h = fixture({ expectedCount: 8, controls, threadStates }).eventDriven();
  h.onClick = (control) => {
    threadStates[control.key].pending = true;
    h.state.controls = h.state.controls.filter((item) => item !== control);
    h.later(control.key === "t0" ? 4100 : 400, () => {
      h.state.comments.push(row(control.key, "c1"));
      threadStates[control.key] = { revision: "after", pending: false };
    });
  };
  const result = await h.run();
  assert.equal(result.status, "likely_complete");
  assert.equal(result.comments.length, 8);
  assert.ok(h.actions.filter((a) => a.action === "click").every((a) => a.at < 1500));
  assert.ok(h.now() >= 4100 && h.now() < 4500);
});

test("a mutation during final DOM confirmation restarts proof and includes the new comment", async () => {
  const h = fixture();
  h.later(30, () => { h.state.comments.push(row("c2")); h.state.expectedCount = 2; });
  const result = await h.run();
  assert.equal(result.status, "likely_complete");
  assert.deepEqual(result.comments.map((item) => item.commentId), ["c1", "c2"]);
  assert.ok(h.reads.filter((read) => read?.force).length >= 3);
});

test("native pending-thread evidence vetoes a fast finish even if the displayed total is already matched", async () => {
  const h = fixture({ controls: [{ key: "t1:expand", groupKey: "t1", revision: "before" }],
    threadStates: { t1: { revision: "before", pending: false } } }).eventDriven();
  h.onClick = () => {
    h.state.controls = [];
    h.state.threadStates.t1.pending = true;
    h.later(2100, () => { h.state.threadStates.t1.pending = false; h.state.threadStates.t1.revision = "after"; });
  };
  const result = await h.run();
  assert.equal(result.status, "likely_complete");
  assert.ok(h.now() >= 2100);
});
