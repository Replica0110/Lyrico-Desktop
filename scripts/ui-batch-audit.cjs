async (page) => {
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  const metrics = [];
  const assert = (condition, message) => { if (!condition) throw Error(message); };
  await page.reload();
  await page.locator('.side-navigation').waitFor();
  await page.getByRole('checkbox', {name:'全选', exact:true}).check();
  await page.getByRole('button', {name:'批处理', exact:true}).click();
  await page.locator('.tasks-view').waitFor();
  async function operation(label) {
    await page.locator('.batch-operation-select').click();
    await page.locator('.ant-select-dropdown:visible').getByTitle(label, {exact:true}).click();
  }
  const operations=['标签匹配','匹配歌词','匹配封面','编辑标签','重命名文件','歌词格式化','导出歌词','导出封面','计算回放增益','删除歌曲'];
  for (const theme of ['light','dark']) {
    await page.emulateMedia({colorScheme:theme});
    for (const [width,height] of [[720,520],[1180,760]]) {
      await page.setViewportSize({width,height});
      for (const name of operations) {
        await operation(name);
        await page.waitForTimeout(350);
        const geometry = await page.locator('.tasks-view').evaluate(el => {
          const body=el.querySelector('.batch-edit-config:not(.is-hidden)')?.getBoundingClientRect() ?? el.querySelector('.batch-workspace .batch-table-host').getBoundingClientRect();
          const footer=el.querySelector('.batch-workspace .batch-panel-footer').getBoundingClientRect();
          const view=el.parentElement.getBoundingClientRect();
          return {pageOverflow:el.scrollWidth-el.clientWidth,documentOverflow:document.documentElement.scrollWidth-innerWidth,bodyHeight:body.height,footerBottom:footer.bottom,viewBottom:view.bottom,pagination:el.querySelectorAll('.ant-pagination').length,headerHeight:el.querySelector('.page-header-row').getBoundingClientRect().height};
        });
        assert(geometry.pageOverflow===0 && geometry.documentOverflow===0, `Overflow: ${name} ${width}`);
        assert(geometry.bodyHeight>=80, `List too short: ${name} ${width}: ${geometry.bodyHeight}`);
        assert(geometry.footerBottom<=geometry.viewBottom+1, `Footer clipped: ${name} ${width}`);
        assert(geometry.pagination===0, `Pagination remains: ${name}`);
        assert(geometry.headerHeight===44, `Header mismatch: ${name}`);
        metrics.push({name,theme,width,height,...geometry});
        await page.screenshot({path:`output/playwright/batch-${theme}-${width}-${operations.indexOf(name)}.png`});
      }
      await page.getByText('任务历史',{exact:true}).click();
      await page.locator('.task-history').waitFor();
      assert(!await page.locator('.task-history').innerText().then(text=>/exportLyrics|succeeded|179159|common\.delete|tasks\./.test(text)), 'Raw history values');
      await page.screenshot({path:`output/playwright/batch-${theme}-${width}-history.png`});
      await page.locator('.task-history').getByRole('button',{name:'查看详情',exact:true}).first().click();
      await page.locator('.batch-details-modal').waitFor();
      await page.waitForTimeout(350);
      await page.screenshot({path:`output/playwright/batch-${theme}-${width}-details.png`});
      await page.locator('.batch-details-modal').getByRole('button',{name:/关\s*闭/}).click();
      await page.getByText('处理歌曲',{exact:true}).click();
    }
  }
  await page.setViewportSize({width:720,height:520});
  await operation('计算回放增益');
  const footerBefore=await page.locator('.batch-panel-footer').evaluate(el=>el.getBoundingClientRect().top);
  await page.locator('.batch-panel-footer').getByRole('button').click();
  await page.waitForTimeout(1300);
  assert(await page.locator('.batch-result-button').first().innerText()==='处理中', 'Per-file progress absent');
  const footerAfter=await page.locator('.batch-panel-footer').evaluate(el=>el.getBoundingClientRect().top);
  assert(Math.abs(footerBefore-footerAfter)<1,'Progress shifted layout');
  await page.screenshot({path:'output/playwright/batch-running-720.png'});
  const id=await page.evaluate(()=>window.__uiTest.tasks[0].taskId);
  await page.evaluate(id => { const item=window.__uiTest.items.get(id)[1]; Object.assign(item,{status:'failed',progress:1,errorMessage:'Early failure'}); },id);
  await page.waitForTimeout(1300);
  await page.locator('.batch-result-button').nth(1).click();
  assert(await page.getByRole('dialog').getByRole('button',{name:'重试此项',exact:true}).count()===0,'Running task can be retried');
  await page.getByRole('dialog').getByRole('button',{name:/关\s*闭/}).click();
  await page.evaluate(id=>window.__uiTest.update(id,'succeeded'),id);
  await page.waitForTimeout(500);
  await page.locator('.batch-result-filter .ant-select').click();
  await page.locator('.ant-select-dropdown:visible').getByTitle('失败',{exact:true}).click();
  assert(await page.locator('.batch-result-button').count()===1,'Failed filter incorrect');
  await page.locator('.batch-result-button').click();
  await page.getByRole('dialog').waitFor();
  assert(await page.getByRole('dialog').innerText().then(text=>text.includes('Write permission denied')), 'Error reason absent');
  await page.getByRole('dialog').getByRole('button',{name:'重试此项',exact:true}).click();
  await page.waitForTimeout(500);
  const retry=await page.evaluate(()=>window.__uiTest.calls.find(call=>call.cmd==='retry_failed_batch_items'));
  assert(retry.args.taskId===id && retry.args.itemIds.length===1 && retry.args.itemIds[0]===id+':1','Individual retry did not isolate failed item');
  const retried=await page.evaluate(()=>window.__uiTest.tasks[0]);
  assert(retried.total===1 && retried.taskType==='replayGain','Retry did not preserve task or isolate file');
  await page.evaluate(id=>window.__uiTest.update(id,'succeeded'),retried.taskId);
  for (const button of await page.locator('.ant-notification').getByRole('button',{name:'Close',exact:true}).all()) await button.click();
  await page.evaluate(()=>window.__uiTest.failItems=true);
  await page.getByText('任务历史',{exact:true}).click();
  await page.locator('.task-history').getByRole('button',{name:'查看详情',exact:true}).first().click();
  await page.waitForTimeout(350);
  assert(await page.locator('.batch-details-modal').innerText().then(text=>text.includes('无法读取处理结果')), 'Load error absent');
  await page.evaluate(()=>window.__uiTest.failItems=false);
  await page.locator('.batch-details-modal').getByRole('button',{name:/刷\s*新/}).click();
  await page.waitForTimeout(350);
  assert(!await page.locator('.batch-details-modal').innerText().then(text=>text.includes('无法读取处理结果')), 'Refresh did not recover');
  await page.locator('.batch-details-modal').getByRole('button',{name:/关\s*闭/}).click();
  assert(errors.length===0, errors.join('\n'));
  return {cases:metrics.length, minListHeight:Math.min(...metrics.map(m=>m.bodyHeight)), pageOverflow:Math.max(...metrics.map(m=>m.pageOverflow)), documentOverflow:Math.max(...metrics.map(m=>m.documentOverflow)), errors,footerShift:footerAfter-footerBefore,resultFiltering:true,loadErrorRecovery:true};
}
