"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");
const source = readFileSync(join(__dirname, "../service-worker.js"), "utf8").replace(/\r\n/g, "\n");
function declaration(name) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, "m"));
  const end = source.indexOf("\n}", start);
  assert.ok(start >= 0 && end > start, name);
  return source.slice(start, end + 2);
}
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};
const tick = () => new Promise(resolve => setImmediate(resolve));
function harness() {
  const h = { calls: [], recoveries: 0, url: "http://127.0.0.1:17881" };
  const context = vm.createContext({
    URL, Map, Promise, REQUEST_TIMEOUT_MS: 6500,
    bridgeReadTasks: new Map(), bridgeReadGeneration: 0, bridgeWritesInFlight: 0,
    bridgeState: { status: "online" },
    getConfig: async () => ({ bridgeUrl: h.url }),
    bridgeEndpoint: (base, path) => base + path,
    fetchJson: async (...args) => {
      h.calls.push(args);
      return h.fetch ? h.fetch(...args) : { ok: true, items: [{ id: "a" }] };
    },
    ensureBridge: async () => {
      h.recoveries++;
      return h.recover ? h.recover() : { ok: true };
    }
  });
  vm.runInContext(["isBridgeConnectivityError", "isReadOnlyBridgeRequest", "bridgeApi"].map(declaration).join("\n"), context);
  h.context = context;
  h.run = (path = "/api/stats", options = {}) => context.bridgeApi(path, options);
  return h;
}

test("50 simultaneous identical reads issue one request and receive independent JSON objects", async () => {
  const h = harness(), gate = deferred(); h.fetch = () => gate.promise;
  const pending = Array.from({ length: 50 }, () => h.run());
  await tick(); assert.equal(h.calls.length, 1);
  gate.resolve({ ok: true, items: [{ id: "a" }] });
  const results = await Promise.all(pending);
  results[0].items[0].id = "mutated";
  assert.equal(results[1].items[0].id, "a");
  assert.equal(h.context.bridgeReadTasks.size, 0);
  await h.run(); assert.equal(h.calls.length, 2, "resolved data is never cached");
});

test("query POSTs are read-only but differing filters, limits and endpoints never share", async () => {
  const h = harness(), gate = deferred(); h.fetch = () => gate.promise;
  const paths = [
    ["/api/data-overview/query", { method: "POST", body: '{"filter":"a"}' }],
    ["/api/data-overview/query", { method: "POST", body: '{"filter":"a"}' }],
    ["/api/data-overview/query", { method: "POST", body: '{"filter":"b"}' }],
    ["/api/data-overview/values", { method: "POST", body: '{"filter":"a"}' }],
    ["/api/stats", { timeoutMs: 100 }], ["/api/stats", { timeoutMs: 200 }]
  ];
  const pending = paths.map(([path, options]) => h.run(path, options));
  await tick(); assert.equal(h.calls.length, 5);
  gate.resolve({ ok: true }); await Promise.all(pending);
});

test("write barrier isolates reads before, during and after a mutation", async () => {
  const h = harness(), gates = [];
  h.fetch = () => { const gate = deferred(); gates.push(gate); return gate.promise; };
  const before = h.run(); await tick();
  const write = h.run("/api/comments/sync", { method: "POST", body: "{}" }); await tick();
  const during = h.run(); await tick();
  assert.equal(h.calls.length, 3);
  gates[1].resolve({ ok: true }); await write;
  const after = h.run(); await tick(); assert.equal(h.calls.length, 4);
  gates[0].resolve({ ok: true, revision: 1 }); await before;
  const joinAfter = h.run(); await tick(); assert.equal(h.calls.length, 4, "old cleanup must not remove new task");
  gates[2].resolve({ ok: true, revision: 2 });
  gates[3].resolve({ ok: true, revision: 3 });
  assert.equal((await during).revision, 2);
  assert.equal((await after).revision, 3); assert.equal((await joinAfter).revision, 3);
  assert.equal(h.context.bridgeWritesInFlight, 0);
});

test("concurrent explicit writes are never deduplicated", async () => {
  const h = harness(), gate = deferred(); h.fetch = () => gate.promise;
  const writes = [1, 2].map(() => h.run("/api/watchlist", { method: "POST", body: "{}" }));
  await tick(); assert.equal(h.calls.length, 2);
  gate.resolve({ ok: true }); await Promise.all(writes);
  assert.equal(h.context.bridgeWritesInFlight, 0);
});

for (const path of ["/api/pull", "/api/comments/sync", "/api/data-overview/delete", "/api/open", "/api/ai/analyze", "/api/reports/weekly"]) {
  test(`lost acknowledgement of ${path} is not automatically submitted again`, async () => {
    const h = harness(); let commits = 0;
    h.fetch = () => { commits++; throw new Error("Bridge 响应超时"); };
    await assert.rejects(h.run(path, { method: "POST", body: "{}" }), error =>
      error.code === "BRIDGE_WRITE_OUTCOME_UNKNOWN" && error.outcomeUnknown && /未自动重复提交/.test(error.message));
    assert.equal(commits, 1); assert.equal(h.recoveries, 1);
    assert.equal(h.context.bridgeWritesInFlight, 0);
  });
}

test("GET and allowlisted compare POST recover and retry once", async () => {
  for (const [path, options] of [["/api/stats", {}], ["/api/comments/compare", { method: "POST", body: "{}" }]]) {
    const h = harness(); h.fetch = () => {
      if (h.calls.length === 1) throw new Error("Failed to fetch");
      return { ok: true };
    };
    assert.equal((await h.run(path, options)).ok, true);
    assert.equal(h.calls.length, 2); assert.equal(h.recoveries, 1);
  }
});

test("failed read recovery is bounded, clears its task, and next user query can retry", async () => {
  const h = harness(); h.fetch = () => { throw new Error("Failed to fetch"); };
  const results = await Promise.allSettled([h.run(), h.run()]);
  assert.ok(results.every(x => x.status === "rejected"));
  assert.equal(h.calls.length, 2); assert.equal(h.recoveries, 1);
  assert.equal(h.context.bridgeReadTasks.size, 0);
  h.fetch = () => ({ ok: true }); assert.equal((await h.run()).ok, true);
});

test("business validation errors and noRecovery requests are never automatically retried", async () => {
  const h = harness(); h.fetch = () => { throw new Error("一致性校验失败"); };
  await assert.rejects(h.run("/api/pull", { method: "POST" }), /一致性校验失败/);
  assert.equal(h.calls.length, 1); assert.equal(h.recoveries, 0);
  h.fetch = () => { throw new Error("Failed to fetch"); };
  await assert.rejects(h.run("/api/stats", { noRecovery: true }), /Failed to fetch/);
  assert.equal(h.calls.length, 2); assert.equal(h.recoveries, 0);
});

test("offline write connects before first submission; startup failure submits nothing", async () => {
  const h = harness(); h.context.bridgeState.status = "offline";
  h.recover = () => { assert.equal(h.calls.length, 0); return { ok: true }; };
  assert.equal((await h.run("/api/pull", { method: "POST" })).ok, true);
  assert.equal(h.calls.length, 1);
  const failed = harness(); failed.context.bridgeState.status = "idle";
  failed.recover = () => ({ ok: false, error: "启动失败" });
  await assert.rejects(failed.run("/api/pull", { method: "POST" }), /启动失败/);
  assert.equal(failed.calls.length, 0); assert.equal(failed.context.bridgeWritesInFlight, 0);
});

test("configuration change during startup or recovery never sends to the previous database", async () => {
  const cold = harness(); cold.context.bridgeState.status = "idle";
  cold.recover = () => { cold.url = "http://127.0.0.1:17882"; return { ok: true }; };
  await assert.rejects(cold.run("/api/pull", { method: "POST" }), /配置已变更/);
  assert.equal(cold.calls.length, 0);
  const read = harness(); read.fetch = () => { throw new Error("Failed to fetch"); };
  read.recover = () => { read.url = "http://127.0.0.1:17882"; return { ok: true }; };
  await assert.rejects(read.run(), /配置已变更/);
  assert.equal(read.calls.length, 1);
});

test("recovery exception preserves unknown-write outcome instead of replaying it", async () => {
  const h = harness(); h.fetch = () => { throw new Error("Failed to fetch"); };
  h.recover = () => { throw new Error("native disconnected"); };
  await assert.rejects(h.run("/api/pull", { method: "POST" }), error => error.outcomeUnknown === true);
  assert.equal(h.calls.length, 1);
});

test("passive broadcasts send one notification per XHS tab and never reload or inject", async () => {
  const sent = [], events = [];
  const context = vm.createContext({ URL,
    chrome: {
      runtime: { sendMessage: async message => events.push(message) },
      tabs: { query: async () => [{ id: 1, url: "https://www.xiaohongshu.com/explore/a" },
        { id: 2, url: "https://www.xiaohongshu.com/search_result" }, { id: 3, url: "https://example.test/" }],
        sendMessage: async (id, message) => { sent.push({ id, message }); if (id === 2) throw new Error("old tab unavailable"); } }
    }, ensureContentInjected: () => assert.fail("passive notification must not inject/reload")
  });
  vm.runInContext(["isXhsPageUrl", "broadcastLocalNoteState"].map(declaration).join("\n"), context);
  await context.broadcastLocalNoteState("n1", { inExcel: true });
  assert.equal(events.length, 0, "unverified writes never announce success");
  await context.broadcastLocalNoteState("n1", { inExcel: true, consistencyVerified: true });
  assert.equal(events.length, 1); assert.equal(sent.length, 2);
  assert.ok(sent.every(x => x.message.type === "localNoteStateChanged"));
});

test("workbook export is a read-only POST and routes through the new endpoint", async () => {
  const h=harness();
  assert.equal(h.context.isReadOnlyBridgeRequest("/api/data-overview/export",{method:"POST"}),true);
  assert.match(source,/message\.type === "exportDataOverview"[\s\S]*?bridgeApi\("\/api\/data-overview\/export"/);
  await h.run("/api/data-overview/export",{method:"POST",body:'{"expectedTotal":401}'});
  assert.equal(h.calls.length,1);assert.equal(h.context.bridgeWritesInFlight,0);
});

test('batch endpoint binding rejects changed configuration before submitting a request', async () => {
  const h = harness();
  await assert.rejects(h.run('/api/comments/sync', {method:'POST',expectedBridgeUrl:'http://127.0.0.1:17882'}), /配置已变更/);
  assert.equal(h.calls.length,0);assert.equal(h.context.bridgeWritesInFlight,0);
  await h.run('/api/comments/sync',{method:'POST',expectedBridgeUrl:h.url});
  assert.equal(h.calls.length,1);assert.equal('expectedBridgeUrl' in h.calls[0][1],false);
});

test('cancel while configuration is pending blocks the actual POST send',async()=>{
  const h=harness(),gate=deferred();let cancelled=false;
  h.context.getConfig=()=>gate.promise;
  const pending=h.run('/api/comments/sync',{method:'POST',shouldCancel:()=>cancelled});
  cancelled=true;gate.resolve({bridgeUrl:h.url});
  await assert.rejects(pending,e=>e.code==='BATCH_SYNC_CANCELLED');assert.equal(h.calls.length,0);
  assert.equal(h.context.bridgeWritesInFlight,0);
});
test('cancel during offline bridge startup sends nothing; started writes drain unchanged',async()=>{
  const h=harness(),gate=deferred();let cancelled=false;
  h.context.bridgeState.status='offline';h.recover=()=>gate.promise;
  const pending=h.run('/api/comments/sync',{method:'POST',shouldCancel:()=>cancelled});await tick();
  cancelled=true;gate.resolve({ok:true});await assert.rejects(pending,e=>e.code==='BATCH_SYNC_CANCELLED');assert.equal(h.calls.length,0);
  const live=harness(),write=deferred();cancelled=false;live.fetch=()=>write.promise;
  const sent=live.run('/api/comments/sync',{method:'POST',shouldCancel:()=>cancelled});await tick();assert.equal(live.calls.length,1);
  cancelled=true;write.resolve({ok:true,consistencyVerified:true});assert.equal((await sent).ok,true);assert.equal(live.calls.length,1);
  assert.equal('shouldCancel' in live.calls[0][1],false);
});
