// Public synthetic regression: 17 checks, relative frontend root, no business data.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
class Element {
  constructor() { this.children=[]; this.dataset={}; this.listeners={}; this.value=''; this.hidden=false; this.classList={add(){},remove(){},toggle(){}}; }
  append(...x) { this.children.push(...x); }
  replaceChildren(...x) { this.children=x; }
  setAttribute() {}
  addEventListener(name,fn) { this.listeners[name]=fn; }
  querySelectorAll() { return []; }
  querySelector() { return new Element(); }
  focus() {}
}
const elements=new Map();
const shortcuts=['差评','强硬销售','价格差异','过敏'].map(x=>Object.assign(new Element(),{dataset:{semanticQuery:x}}));
const document={getElementById(id){if(!elements.has(id)) elements.set(id,new Element());return elements.get(id);},createElement(){return new Element();},querySelectorAll(s){return s==='[data-semantic-query]'?shortcuts:[];},addEventListener(){}};
const timers=[]; let stored='';
const ctx=vm.createContext({document,console,crypto:{randomUUID:()=> 'uuid'},localStorage:{setItem(k,v){stored=v;},getItem(){return stored;}},setTimeout(fn){timers.push(fn);return timers.length;},clearTimeout(){},window:{addEventListener(){}},XhsMonitorColumnOrder:{orderedKeys:a=>a,sanitize:a=>a||[]},Map,Set,queueMicrotask});
let src=fs.readFileSync(path.join(root,'data-overview.js'),'utf8');
src=src.replace(/loadPreferences\(\);\s*bindEvents\(\);\s*initializeInfiniteScroll\(\);\s*loadSchema\(\{ preserveQuery: true \}\);\s*$/, '');
vm.runInContext(src,ctx);
const run=s=>vm.runInContext(s,ctx);
const checks=[];
function test(name,fn){fn(); checks.push(name); console.log('PASS',name);}
run(`state.schema={datasets:{notes:{fields:[{key:'title',defaultVisible:true}]},comments:{fields:[{key:'comment_id',defaultVisible:true},{key:'thread_root_content',defaultVisible:true}]}}}; initializeColumnDragging=()=>{}; bindEvents();`);
test('默认普通搜索 / 严格 boolean',()=>{assert.equal(run('state.semanticSearch'),false);assert.equal(run('normalizeViewPreferences({semanticSearch:"true"}).semanticSearch'),false);assert.equal(run('queryPayload().semanticSearch'),false);});
test('语义 payload 保留原查询，暂停自定义排序和线程合并',()=>{run(`state.dataset='comments'; state.semanticSearch=true; state.search='  过敏 <tag>  ';state.sorts=[{id:'1',field:'comment_id',direction:'asc'}];state.groupThreads=true;`);const p=run('queryPayload()');assert.equal(p.search,'  过敏 <tag>  ');assert.equal(p.semanticSearch,true);assert.equal(p.groupThreads,false);assert.equal(p.sort.length,0);assert.equal(run('state.groupThreads'),true);});
test('输入和快捷词不发起定时检索',()=>{const before=timers.length;elements.get('globalSearch').value='过敏';elements.get('globalSearch').listeners.input();assert.equal(timers.length,before);assert.equal(run('state.semanticAwaitingSubmit'),true);for(const b of shortcuts)b.listeners.click();assert.equal(timers.length,before);assert.equal(run('state.search'),'过敏');});
test('输入法 Enter 不提交；普通 Enter 提交',()=>{const before=timers.length;elements.get('globalSearch').listeners.keydown({key:'Enter',isComposing:true});assert.equal(timers.length,before);elements.get('globalSearch').listeners.keydown({key:'Enter',isComposing:false,preventDefault(){}});assert.equal(timers.length,before+1);assert.equal(run('state.semanticAwaitingSubmit'),false);});
test('语义空查询拒绝提交',()=>{elements.get('globalSearch').value=' ';elements.get('searchSubmit').listeners.click();assert.equal(run('state.semanticAwaitingSubmit'),true);});
test('每表保存、恢复并保留楼层设置',()=>{run(`state.search='过敏';savePreferences();state.dataset='notes';restoreDatasetView();`);assert.equal(run('state.semanticSearch'),false);run(`state.dataset='comments';restoreDatasetView();`);assert.equal(run('state.semanticSearch'),true);assert.equal(run('state.groupThreads'),true);assert.equal(run('state.search'),'过敏');assert.equal(JSON.parse(stored).savedViews.comments.semanticSearch,true);});
test('语义模式 UI 暂停楼层合并，关闭恢复排序',()=>{run('renderSorts()');assert.equal(elements.get('groupThreads').checked,false);assert.equal(elements.get('groupThreads').disabled,true);run('state.semanticSearch=false;renderSorts()');assert.equal(elements.get('groupThreads').checked,true);assert.equal(run('queryPayload().sort.length'),1);});
test('证据、评论ID、模型使用文本；0 分有效',()=>{ctx.cell=new Element();run(`appendSemanticEvidence(cell,{_semantic_score:0,_semantic_evidence:'<img src=x onerror=alert(1)>',_semantic_comment_id:'<script>x</script>'});`);const box=ctx.cell.children[0];assert.match(box.children[0].textContent,/0.0 · 综合排序分/);assert.equal(box.children[1].textContent,'<img src=x onerror=alert(1)>');assert.equal(box.children[1].children.length,0);assert.match(box.children[2].textContent,/<script>/);run(`state.semanticSearch=true;state.semanticAwaitingSubmit=false;renderSemanticControls({semantic:{mode:'embedding',model:'<b>model</b>'}})`);assert.match(elements.get('semanticStatus').textContent,/<b>model<\/b>/);assert.equal(run('semanticScore({_semantic_score:null})'),-1);});
test('重置当前表清除语义模式，保留另一表',()=>{run(`state.savedViews.notes=normalizeViewPreferences({semanticSearch:true,search:'差评'});renderFieldOptions=()=>{};renderFilters=()=>{};clearSelection=()=>{};closePageFind=()=>{};closeColumnFilterPopover=()=>{};resetCurrentView();`);assert.equal(run('state.semanticSearch'),false);assert.equal(run('state.savedViews.comments.semanticSearch'),false);assert.equal(run('state.savedViews.notes.semanticSearch'),true);});
test('待提交语义模式阻止分页/刷新请求',()=>{run(`state.semanticAwaitingSubmit=true; state.queryReady=true; sendRuntime=()=>{throw Error('unexpected request')};runQuery({append:true});runQuery({append:false});`);});
test('渲染与导出契约静态防回归',()=>{assert.match(src,/state\.rows\.sort\(\(a, b\) => semanticScore\(b\) - semanticScore\(a\)\)/);assert.match(src,/!state\.semanticSearch && key === "thread_root_content"/);assert.match(src,/XhsMonitorDataExport\.toCsv\(result.rows, columns\)/);const helper=src.slice(src.indexOf('function appendSemanticEvidence'),src.indexOf('function renderTable'));assert.ok(!helper.includes('innerHTML'));assert.match(src,/if \(state.semanticAwaitingSubmit\) \{ showToast/);});
if (process.env.SEMANTIC_TEST_REPORT) fs.writeFileSync(path.resolve(process.env.SEMANTIC_TEST_REPORT),JSON.stringify({passed:checks.length,checks},null,2));
(async()=>{
  run(`state.semanticAwaitingSubmit=false;state.semanticSearch=true;state.loading=false;state.queryPending=false;state.resetScheduled=false;state.queryReady=true;state.rows=[];state.page=0;state.pageSize=2;resetLoadedRows=()=>{state.rows=[];};renderInfiniteState=()=>{};renderTable=(result,options)=>{globalThis.rendered=options;};sendRuntime=async()=>({semantic:{mode:'embedding'},rows:[{comment_id:'a',_semantic_score:0.2},{comment_id:'b',_semantic_score:0.8}],total:3,page:1,pageSize:2,pageCount:2});`);
  await run('runQuery()');
  assert.deepEqual(Array.from(run('state.rows'),x=>x.comment_id),['b','a']);
  run(`sendRuntime=async()=>({semantic:{mode:'embedding'},rows:[{comment_id:'c',_semantic_score:0.5}],total:3,page:2,pageSize:2,pageCount:2});`);
  await run('runQuery({append:true})');
  assert.deepEqual(Array.from(run('state.rows'),x=>x.comment_id),['b','c','a']);
  assert.equal(run('rendered.append'),false);
  assert.equal(run('state.hasMore'),false);
  checks.push('异步查询及分页：合并后相关度降序、完整行重绘、末页停止');
  console.log('PASS',checks.at(-1));
  // Editing a draft while a response is in flight must discard the old response.
  run(`state.loading=false;state.semanticAwaitingSubmit=false;sendRuntime=()=>new Promise(resolve=>{globalThis.release=resolve;});`);
  const pending=run('runQuery()');
  run(`state.semanticAwaitingSubmit=true;release({rows:[{comment_id:'stale'}],total:1});`);
  await pending;
  assert.equal(run("state.rows.some(row=>row.comment_id==='stale')"),false);
  assert.equal(run('state.loading'),false);
  checks.push('异步竞态：输入新草稿后丢弃旧响应并释放 loading');
  console.log('PASS',checks.at(-1));
  const errorText=new Element();
  elements.get('tableEmpty').querySelector=()=>errorText;
  for (const semantic of [undefined, {}, {mode:'keyword'}, {mode:'Embedding'}]) {
    ctx.response={rows:[{comment_id:'keyword-result'}],total:1,semantic};
    run(`state.semanticSearch=true;state.semanticAwaitingSubmit=false;state.hasMore=true;sendRuntime=async()=>response;`);
    await run('runQuery()');
    assert.equal(run('state.rows.length'),0);
    assert.equal(run('state.hasMore'),false);
    assert.match(errorText.textContent,/升级并重启后端 0\.34\.0/);
  }
  checks.push('旧后端/缺失或错误mode被拒绝，结果不写入并提示升级重启0.34.0');
  console.log('PASS',checks.at(-1));
  run(`state.semanticSearch=false;sendRuntime=async()=>({rows:[{comment_id:'ordinary'}],total:1});`);
  await run('runQuery()');
  assert.equal(run('state.rows[0].comment_id'),'ordinary');
  checks.push('普通搜索无需embedding标识，兼容旧后端');console.log('PASS',checks.at(-1));
  // The check uses the captured request, not mutable UI state at response time.
  run(`state.semanticSearch=true;sendRuntime=()=>new Promise(resolve=>{globalThis.release=resolve;});`);
  const oldRequest=run('runQuery()');
  run(`state.semanticSearch=false;release({rows:[{comment_id:'wrong-mode'}],total:1});`);
  await oldRequest;
  assert.equal(run('state.rows.length'),0);
  assert.match(errorText.textContent,/0\.34\.0/);
  checks.push('使用请求时semanticSearch，而非响应时UI模式');console.log('PASS',checks.at(-1));
  run(`state.semanticSearch=true;state.rows=[{comment_id:'valid',_semantic_score:.9}];state.hasMore=true;state.page=1;sendRuntime=async()=>({rows:[{comment_id:'keyword-page'}],total:2});showToast=message=>{globalThis.lastToast=message;};`);
  await run('runQuery({append:true})');
  assert.deepEqual(Array.from(run('state.rows'),x=>x.comment_id),['valid']);
  assert.match(run('lastToast'),/0\.34\.0/);
  checks.push('追加页协议失败保留已验证行，不混入关键词结果');console.log('PASS',checks.at(-1));
  if (process.env.SEMANTIC_TEST_REPORT) fs.writeFileSync(path.resolve(process.env.SEMANTIC_TEST_REPORT),JSON.stringify({passed:checks.length,checks},null,2));
})().catch(error=>{console.error(error);process.exitCode=1;});
