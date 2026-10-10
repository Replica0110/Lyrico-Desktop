async (page) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const metrics = [];
  await page.reload();
  await page.getByRole('button', {name:'设置', exact:true}).click();
  await page.locator('.settings-tabs').waitFor();
  await page.waitForTimeout(1600);
  for (const theme of ['light','dark']) {
    await page.emulateMedia({colorScheme:theme});
    for (const [width,height] of [[720,520],[1180,760]]) {
      await page.setViewportSize({width,height});
      await page.waitForTimeout(1600);
      for (const name of ['日志','关于']) {
        await page.getByRole('tab',{name:name==='日志'?'file-text 日志':'info-circle 关于',exact:true}).click();
        await page.getByRole('tab',{name:name==='日志'?'file-text 日志':'info-circle 关于',exact:true}).click();
        await page.locator(name==='日志'?'.settings-tabs .ant-tabs-content-active .settings-section':'.contributor-row').first().waitFor();
        if (name==='日志') await page.getByRole('button',{name:/打开日志目录/}).click();
        metrics.push(await page.evaluate(({name,theme,width}) => {
          const panel = document.querySelector('.settings-tabs .ant-tabs-content-active');
          return {name,theme,width,overflow:panel.scrollWidth-panel.clientWidth,bodyOverflow:document.documentElement.scrollWidth-innerWidth};
        },{name,theme,width}));
        await page.screenshot({path:`output/playwright/review-${theme}-${width}-${name}.png`});
      }
    }
  }
  const folderCalls = await page.evaluate(() => window.__uiTest.calls.filter(call => call.cmd==='open_logs_directory').length);
  if (folderCalls !== 4) throw Error('Open log directory did not call the backend');
  await page.getByRole('button',{name:'歌曲',exact:true}).click();
  await page.locator('.ant-table-tbody .ant-table-row, .ant-table-tbody-virtual .ant-table-row').first().click();
  await page.getByRole('tab',{name:'在线匹配',exact:true}).click();
  await page.waitForTimeout(300);
  await page.getByRole('button',{name:/搜\s*索/}).click();
  await page.waitForTimeout(300);
  await page.getByRole('button',{name:/搜\s*索/}).click();
  await page.getByRole('button',{name:'查看详情',exact:true}).click();
  await page.locator('.song-result-review').waitFor();
  const requests = () => page.evaluate(() => window.__uiTest.calls.filter(c => c.cmd==='invoke_source_plugin' && c.args.functionName==='getLyrics').length);
  if (await requests() !== 0) throw Error('Lyrics requested before visiting tab');
  for (const theme of ['light','dark']) {
    await page.emulateMedia({colorScheme:theme});
    for (const [width,height] of [[720,520],[1180,760]]) {
      await page.setViewportSize({width,height});
      await page.waitForTimeout(1600);
      await page.screenshot({path:`output/playwright/review-${theme}-${width}-匹配.png`});
      metrics.push(await page.locator('.song-result-review .ant-modal-body').evaluate(el => ({name:'匹配',width:innerWidth,overflow:el.scrollWidth-el.clientWidth,columns:getComputedStyle(el.querySelector('.song-result-fields .match-review-form')).gridTemplateColumns})));
    }
  }
  await page.locator('.song-result-review').getByRole('tab',{name:'歌词',exact:true}).click();
  await page.locator('.song-result-lyrics textarea').waitFor();
  if (await requests() !== 1) throw Error('Lyrics not requested once');
  await page.locator('.song-result-review').getByRole('tab',{name:'元数据',exact:true}).click();
  await page.locator('.song-result-review').getByRole('tab',{name:'歌词',exact:true}).click();
  if (await requests() !== 1) throw Error('Lyrics re-requested on tab switch');
  await page.locator('.song-result-lyrics textarea').fill('[00:01.00]修改后的歌词');
  await page.getByRole('button',{name:'应用到本地标签',exact:true}).click();
  await page.locator('.song-result-review').waitFor({state:'hidden'});
  await page.getByRole('tab',{name:'本地标签',exact:true}).click();
  if (await page.locator('input[value="麻雀"]').count() === 0) throw Error('Metadata not applied');
  return {metrics,errors,lyricsRequests:await requests()};
}
