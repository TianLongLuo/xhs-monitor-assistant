"use strict";
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const vm = require('node:vm');
const source = readFileSync(join(__dirname, '../service-worker.js'), 'utf8').replace(/\r\n/g,'\n');
const alerts = require('../sync-alerts.js');
function declaration(name) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`,'m'));
  const end = source.indexOf('\n}', start);
  assert.ok(start>=0 && end>start, name);
  return source.slice(start,end+2);
}
const deferred = () => {let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const tick = () => new Promise(resolve=>setImmediate(resolve));
const plain = x => JSON.parse(JSON.stringify(x));
function harness(count=3) {
  const h={reads:[],writes:[],messages:[],events:[],activeReads:0,maxReads:0,activeWrites:0,maxWrites:0,
    url:'http://127.0.0.1:17881',snapshots:[],access:[],released:false};
  const notes=Array.from({length:count},(_,i)=>({noteId:`n${i}`,title:`Note ${i}`,source:'existing_xlsx',pullStatus:'synced'}));
  const ctx=vm.createContext({
    batchCommentSyncState:{}, batchCommentSyncCancelled:false, syncAlerts:alerts,
    getConfig:async()=>({bridgeUrl:h.url}), getNotes:async()=>({ok:true,notes}),
    acquireReaderTab:async()=>({id:7}), releaseReaderTabSoon:()=>{h.released=true;h.events.push('release');},
    delay:async ms=>{assert.equal(ms,420);if(h.delay)await h.delay();},
    publishBatchCommentSync:async state=>Object.assign(ctx.batchCommentSyncState,state),
    readPulledNoteInReader:async (_,note)=>{
      h.reads.push(note.noteId);h.events.push('read:'+note.noteId);
      h.maxReads=Math.max(h.maxReads,++h.activeReads);
      try {
        if(h.read)await h.read(note);
        const result={note:{...note},comments:[{noteId:note.noteId,commentId:'c'+note.noteId,content:'original'}],
          expectedCount:1,status:'likely_complete',collectionEvidence:{verified:true}};
        h.snapshots.push(result);return result;
      }finally{h.activeReads--;}
    },
    sendTabMessage:async (_,message)=>{h.messages.push(plain(message));return {ok:true};},
    getSyncAlertPreferences:async()=>null, getNoteStatus:async()=>({found:true,inExcel:true}),
    accessFailureDiagnosis:error=>({code:'fixture',label:'fixture',summary:'fixture',mediaCount:0,commentCount:0}),
    noteIdFromXhsUrl:()=>'', broadcastLocalNoteState:async()=>{},
    setNoteAccessStatuses:async(items,runId,url)=>{h.access.push(...plain(items));h.events.push('access');assert.equal(url,h.url);return {ok:true,items};},
    bridgeApi:async(path,options={})=>{
      if(options.expectedBridgeUrl)assert.equal(options.expectedBridgeUrl,h.url);
      if(path==='/api/sync-runs/start')return {ok:true,runId:1};
      if(path==='/api/sync-runs/finish'){h.finish=JSON.parse(options.body);return {ok:true};}
      if(path==='/api/reports/weekly'){h.report=true;return {ok:true};}
      assert.equal(path,'/api/comments/compare');
      const body=JSON.parse(options.body);h.events.push('compare:'+body.noteId);
      if(h.compare)await h.compare(body);
      return {ok:true,commentHasChanges:false,newCount:0};
    },
    syncCurrentNoteComments:async(payload,url)=>{
      assert.equal(url,h.url);h.writes.push(plain(payload));h.events.push('write:'+payload.noteId);
      h.maxWrites=Math.max(h.maxWrites,++h.activeWrites);
      try {if(h.write)await h.write(payload);return {ok:true,consistencyVerified:true,canPrune:true,commentStatus:'likely_complete'};}
      finally{h.activeWrites--;h.events.push('saved:'+payload.noteId);}
    }
  });
  vm.runInContext(['syncPulledNoteInReader','runPulledCommentSync'].map(declaration).join('\n'),ctx);
  h.ctx=ctx;h.run=()=>ctx.runPulledCommentSync(null,'all');return h;
}
test('bounded prefetch overlaps write; reads and writes each serial, snapshots detached',async()=>{
  const h=harness(4), gate=deferred();h.write=async p=>{if(p.noteId==='n0')await gate.promise;};
  const task=h.run();await tick();await tick();
  assert.deepEqual(h.reads,['n0','n1']);assert.deepEqual(h.writes.map(x=>x.noteId),['n0']);
  assert.equal(h.activeWrites,1);assert.equal(h.snapshots.length,2);
  h.snapshots[1].comments[0].content='mutated after read';
  gate.resolve();const result=await task;
  assert.equal(result.current,4);assert.equal(result.unchangedPosts,4);
  assert.equal(h.maxReads,1);assert.equal(h.maxWrites,1);
  assert.deepEqual(h.writes.map(x=>x.noteId),['n0','n1','n2','n3']);
  assert.equal(h.writes[1].snapshot.comments[0].content,'original');
  assert.equal(h.access.length,4);assert.equal(h.finish.processedNotes,4);
  assert.ok(h.events.indexOf('read:n1')<h.events.indexOf('saved:n0'));
});
test('cancel during active commit drains commit and reader, discards next capture',async()=>{
  const h=harness(), write=deferred(),read=deferred();
  h.write=async p=>{if(p.noteId==='n0')await write.promise;};
  h.read=async n=>{if(n.noteId==='n1')await read.promise;};
  const task=h.run();await tick();h.ctx.batchCommentSyncCancelled=true;
  write.resolve();await tick();assert.equal(h.released,false);assert.equal(h.access.length,0);
  read.resolve();const result=await task;
  assert.equal(result.cancelled,true);assert.equal(result.current,1);assert.equal(h.writes.length,1);
  assert.equal(h.access.length,1);assert.equal(h.report,undefined);assert.equal(h.finish.status,'cancelled');
  assert.equal(h.released,true);
});
test('cancel while compare pending sends no later commit',async()=>{
  const h=harness(),gate=deferred();h.compare=()=>gate.promise;
  const task=h.run();await tick();h.ctx.batchCommentSyncCancelled=true;gate.resolve();
  const result=await task;assert.equal(h.writes.length,0);assert.equal(result.current,0);assert.equal(h.access.length,0);
});
test('prefetch rejection is handled while writer waits and records exact failed post',async()=>{
  const h=harness(),gate=deferred();h.write=async p=>{if(p.noteId==='n0')await gate.promise;};
  h.read=async n=>{if(n.noteId==='n1')throw new Error('reader unavailable');};
  const task=h.run();await tick();await tick();gate.resolve();const result=await task;
  assert.equal(result.failedPosts,1);assert.equal(result.failures[0].noteId,'n1');assert.equal(result.failures[0].stage,'open');
  assert.deepEqual(h.writes.map(x=>x.noteId),['n0','n2']);assert.equal(result.current,3);
});
test('late previous-note progress is suppressed after reader moves forward',async()=>{
  const h=harness(2),gate=deferred();h.write=async p=>{if(p.noteId==='n0')await gate.promise;};
  const task=h.run();await tick();const before=h.messages.length;gate.resolve();await task;
  assert.equal(h.messages.slice(before).some(x=>x.noteId==='n0'),false);
  assert.ok(h.messages.every(x=>x.onlyIfCurrent===true));assert.ok(h.messages.some(x=>x.noteId==='n1'&&x.done));
});
test('write failure does not discard next read or misattribute late error panel',async()=>{
  const h=harness(2),gate=deferred();h.write=async p=>{if(p.noteId==='n0'){await gate.promise;throw new Error('CSV locked');}};
  const task=h.run();await tick();const before=h.messages.length;gate.resolve();const result=await task;
  assert.equal(result.failedPosts,1);assert.equal(result.failures[0].noteId,'n0');assert.equal(result.failures[0].stage,'sync');
  assert.equal(result.unchangedPosts,1);assert.equal(h.messages.slice(before).some(x=>x.noteId==='n0'),false);
});
test('snapshot identity mismatch never reaches comparison or commit',async()=>{
  const h=harness(1);h.ctx.readPulledNoteInReader=async()=>({note:{noteId:'wrong'},comments:[]});
  const result=await h.run();assert.equal(result.failedPosts,1);assert.equal(h.writes.length,0);
  assert.equal(h.events.some(x=>x.startsWith('compare:')),false);
});
test('partial completeness is preserved as failure with saved comparison',async()=>{
  const h=harness(1);h.ctx.syncCurrentNoteComments=async()=>({ok:true,consistencyVerified:true,canPrune:false,commentStatus:'partial',currentCount:1});
  const result=await h.run();assert.equal(result.failedPosts,1);assert.equal(result.failures[0].stage,'comments');assert.equal(result.accessiblePosts,1);
});
test('unchanged snapshots still pass through write and consistency check',async()=>{
  const h=harness(1);h.ctx.syncCurrentNoteComments=async()=>({ok:true,consistencyVerified:false,canPrune:true,commentStatus:'likely_complete'});
  const result=await h.run();assert.equal(result.failedPosts,1);assert.equal(result.unchangedPosts,0);assert.equal(result.failures[0].stage,'sync');
});
test('empty batch creates no reader or writes',async()=>{
  const h=harness(0);const result=await h.run();assert.equal(result.done,true);assert.deepEqual(h.events,[]);
});

test('content-side stale progress guard catches messages already in transit',()=>{
  const content=readFileSync(join(__dirname,'../content.js'),'utf8');
  const a=content.indexOf('    if (message.type === "batchSyncNoteProgress") {');
  const b=content.indexOf('    if (message.type === "expandVisibleComments")',a);
  let response;
  const ctx=vm.createContext({message:{type:'batchSyncNoteProgress',noteId:'n0',onlyIfCurrent:true},
    processPanel:{dataset:{noteId:'n1'}},clean:x=>x,sendResponse:x=>{response=x;},
    prepareBatchProcessPanel:()=>assert.fail('stale writer must not recreate old panel')});
  vm.runInContext('(function(){'+content.slice(a,b)+'})()',ctx);
  assert.equal(response.skipped,true);
});

test('cancellation during next-read pacing starts no extra navigation',async()=>{
  const h=harness(2),gate=deferred();h.delay=()=>gate.promise;
  const task=h.run();await tick();h.ctx.batchCommentSyncCancelled=true;gate.resolve();
  const result=await task;assert.deepEqual(h.reads,['n0']);assert.equal(h.writes.length,1);assert.equal(result.cancelled,true);
});

test('cancel after partial commit still records committed post and preserves partial',async()=>{
  const h=harness(2),gate=deferred();
  h.ctx.syncCurrentNoteComments=async()=>{await gate.promise;return {ok:true,consistencyVerified:true,canPrune:false,commentStatus:'partial',currentCount:1};};
  const task=h.run();await tick();h.ctx.batchCommentSyncCancelled=true;gate.resolve();const result=await task;
  assert.equal(result.cancelled,true);assert.equal(result.current,1);assert.equal(result.failedPosts,1);
  assert.equal(result.failures[0].stage,'comments');assert.equal(h.access.length,1);assert.equal(h.access[0].status,'ok');
  assert.equal(h.finish.processedNotes,1);assert.equal(h.finish.failedNotes,1);
});
test('cancel with lost acknowledgement retains the uncertain-write failure',async()=>{
  const h=harness(2),gate=deferred();h.write=async()=>{await gate.promise;const e=new Error('write acknowledgement lost');e.outcomeUnknown=true;throw e;};
  const task=h.run();await tick();h.ctx.batchCommentSyncCancelled=true;gate.resolve();const result=await task;
  assert.equal(result.current,1);assert.equal(result.failedPosts,1);assert.equal(result.failures[0].stage,'sync');assert.equal(h.writes.length,1);
});
