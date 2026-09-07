"use strict";
document.getElementById("runMediaTests").addEventListener("click", async () => {
  const output = document.getElementById("mediaTestResult"); const results = [];
  const check = (name, pass) => { results.push({ name, pass: Boolean(pass) }); output.textContent = `${results.filter(x=>x.pass).length}/${results.length} 通过`; };
  const wait = async predicate => { for (let n=0;n<120;n++) { if (predicate()) return; await new Promise(r=>setTimeout(r,20)); } throw new Error("UI等待超时"); };
  try {
    document.querySelector('[data-dataset="comments"]').click();
    await wait(()=>document.querySelectorAll('#tableBody tr').length===3 && document.querySelectorAll('.media-thumb img').length===3);
    check('评论各自展示附件，无图评论不借用原帖图片', document.querySelectorAll('.media-cell')[2].textContent.includes('无已记录图片'));
    check('一级评论与二级回复图片分别绑定', document.querySelectorAll('.media-cell')[0].querySelectorAll('img').length===2 && document.querySelectorAll('.media-cell')[1].querySelectorAll('img').length===1);
    const photos=[...document.querySelectorAll('.media-thumb img')]; await wait(()=>photos.every(img=>img.complete&&img.naturalWidth>0));
    check('缩略图成功解码', photos.every(img=>img.naturalWidth===500));
    document.querySelector('.media-thumb').click(); await wait(()=>document.querySelector('.media-viewer[open] img'));
    check('点击查看大图', document.querySelector('.media-viewer').open);
    document.querySelector('.media-viewer footer button:last-child').click(); await wait(()=>document.querySelector('.media-viewer footer span').textContent.includes('2 / 2'));
    check('多图顺序浏览', document.querySelector('.media-viewer footer button:last-child').disabled);
    document.querySelector('.media-viewer header button').click();
    check('关闭大图保持列表', !document.querySelector('.media-viewer').open && document.querySelectorAll('#tableBody tr').length===3);
    document.querySelectorAll('.comment-locate')[1].click(); await wait(()=>fixtureCalls.some(x=>x.type==='locateDataOverviewComment'));
    check('原文旁按钮传递当前二级评论ID', fixtureCalls.filter(x=>x.type==='locateDataOverviewComment').at(-1).commentId===c2);
    document.querySelector('[data-dataset="notes"]').click(); await wait(()=>document.querySelectorAll('#tableBody tr').length===1 && document.querySelector('.media-count')?.textContent==='4 张');
    check('帖子支持独立素材列且预览上限3张', document.querySelectorAll('.media-thumb').length===3);
    check('不产生写入同步删除调用', !fixtureCalls.some(x=>/delete|pull|syncComments|update/i.test(x.type)));
    document.querySelector('[data-dataset="comments"]').click();
    await wait(()=>document.querySelectorAll('#tableBody tr').length===3 && document.querySelectorAll('.media-thumb img').length===3);
    check('切表后旧请求不串到新记录', [...document.querySelectorAll('.media-cell')].map(x=>x.querySelectorAll('img').length).join(',')==='2,1,0');
  } catch(error) { check(error.message,false); }
  output.dataset.results=JSON.stringify(results); output.dataset.done='true';
});
