"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");
const source = readFileSync(join(__dirname, "../data-overview.js"), "utf8").replace(/\r\n/g, "\n");
const start = source.indexOf("function renderCell(");
const render = source.slice(start, source.indexOf("\n}", start)+2);

test("both dataset region columns render native locations, never claim numeric network IPs", () => {
  const ctx=vm.createContext({ state: { dataset:"notes" } }); vm.runInContext(render,ctx);
  for(const key of ["source_ip_location","ip_location","post__source_ip_location"]){
    const td={};ctx.renderCell(td,"四川",key,"text");
    assert.equal(td.textContent,"四川");assert.match(td.title,/非网络 IP 地址/);
  }
});
test("unavailable regions are explicitly labelled without guessing", () => {
  const ctx=vm.createContext({ state: { dataset:"comments" } });vm.runInContext(render,ctx);
  for(const value of ["",null,undefined]){const td={};ctx.renderCell(td,value,"ip_location","text");assert.equal(td.textContent,"未显示");}
});
test("additive IP column migration does not reset saved filters or sort rules", () => {
  const from=source.indexOf('// Add the requested region columns once');
  const to=source.indexOf('// One-time additive migration;',from);
  const migration=source.slice(from,to);
  const saved=new Map();
  const state={visibleFields:{notes:["title","source_published_at"],comments:["content","published_at"]},columnOrder:{notes:["title","source_published_at"],comments:["content","published_at"]},filters:[{field:"author",value:"甲"}],sorts:[{field:"published_at",direction:"desc"}]};
  const ctx=vm.createContext({state,result:{datasets:{notes:{fields:[{key:"source_ip_location"}]},comments:{fields:[{key:"ip_location"}]}}},localStorage:{getItem:k=>saved.get(k),setItem:(k,v)=>saved.set(k,v)},savePreferences:()=>true});
  vm.runInContext(migration,ctx);
  assert.deepEqual(state.visibleFields.notes,["title","source_published_at","source_ip_location"]);
  assert.deepEqual(state.visibleFields.comments,["content","published_at","ip_location"]);
  assert.equal(state.filters[0].value,"甲");assert.equal(state.sorts[0].direction,"desc");
  state.visibleFields.comments.splice(2,1);vm.runInContext(migration,ctx);
  assert.deepEqual(state.visibleFields.comments,["content","published_at"],"user may hide the introduced column permanently");
});
test("location helper is injected before comment extraction on manifest and dynamic paths", () => {
  const manifest=JSON.parse(readFileSync(join(__dirname,"../manifest.json"),"utf8"));
  assert.ok(manifest.content_scripts[0].js.indexOf("location-utils.js")<manifest.content_scripts[0].js.indexOf("comment-utils.js"));
  const worker=readFileSync(join(__dirname,"../service-worker.js"),"utf8");assert.match(worker,/"location-utils.js", "comment-utils.js"/);
});
