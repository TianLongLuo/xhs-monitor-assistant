"use strict";
document.getElementById("run").addEventListener("click", async()=>{
  const root=document.getElementById('root'),scope=root.querySelector('.comments-el'),output=document.getElementById('results');
  const n='a'.repeat(24),p='b'.repeat(24),r='c'.repeat(24),other='d'.repeat(24),results=[];
  const check=(name,pass)=>{results.push({name,pass:Boolean(pass)});output.textContent=results.filter(x=>x.pass).length+'/'+results.length+' 通过';};
  const run=(comment,options={})=>XhsMonitorCommentLocator.locate({root,noteId:n,comment:{noteId:n,...comment},utils:XhsMonitorCommentUtils,isCurrent:()=>true,timeoutMs:700,...options});
  const row=(id,body,sub=false)=>{const item=document.createElement('div');item.className='comment-item'+(sub?' comment-item-sub':'');item.id='comment-'+id;item.innerHTML='<span class="name">用户</span><div class="content"></div>';item.querySelector('.content').textContent=body;return item;};
  try{
    scope.replaceChildren(row(p,'一级评论'),row(other,'相同文案'));let t=performance.now();
    let result=await run({commentId:'comment-'+p});check('已加载评论立即定位',result.ok&&performance.now()-t<150);
    check('准确高亮指定ID',scope.querySelector('.xhs-monitor-comment-highlight')?.id==='comment-'+p);
    const group=document.createElement('div');group.className='parent-comment';group.append(row(p,'一级评论'));
    const expand=document.createElement('div');expand.className='show-more reply-control';expand.textContent='展开 1 条回复';
    let clicked=0;expand.onclick=()=>{clicked++;setTimeout(()=>{group.append(row(r,'带图片的二级回复',true));expand.remove();},40);};
    group.append(expand);scope.replaceChildren(group,row(other,'带图片的二级回复'));t=performance.now();
    result=await run({commentId:'comment-'+r,parentCommentId:'comment-'+p,content:'带图片的二级回复',author:'用户'});
    check('先展开所属线程再定位二级评论',result.ok&&clicked===1&&group.querySelector('.xhs-monitor-comment-highlight')?.id==='comment-'+r);
    check('目标出现即停，不扫描全帖',performance.now()-t<500);
    check('不高亮同文的其他评论',!scope.querySelector('#comment-'+other).classList.contains('xhs-monitor-comment-highlight'));
    result=await run({commentId:'comment-'+ 'e'.repeat(24),content:'带图片的二级回复',author:'用户'},{timeoutMs:120});
    check('明确ID缺失不冒充同文评论',!result.ok);
    const controller=new AbortController();setTimeout(()=>controller.abort(),35);t=performance.now();
    result=await run({commentId:'comment-'+ 'f'.repeat(24)},{signal:controller.signal});
    check('用户取消快速停止',!result.ok&&performance.now()-t<200);
    await run({commentId:'comment-'+r,parentCommentId:'comment-'+p});
  }catch(error){check(error.message,false);}
  output.dataset.results=JSON.stringify(results);output.dataset.done='true';
});
