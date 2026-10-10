async (page) => {
  const assert = (value, message) => { if (!value) throw Error(message); };
  const errors = [];
  const metrics = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.reload();
  await page.locator('.side-navigation').waitFor();
  // Model maximize/restore without moving or closing the audit browser.
  await page.evaluate(() => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    let maximized = false;
    window.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
      if (cmd === 'plugin:window|is_maximized') return maximized;
      if (cmd === 'plugin:window|maximize') maximized = true;
      if (cmd === 'plugin:window|unmaximize') maximized = false;
      return invoke(cmd, args);
    };
  });

  async function checkOverlay(name, theme, width, height) {
    const geometry = await page.evaluate(() => {
      const titlebar = document.querySelector('.titlebar');
      const strip = titlebar.getBoundingClientRect();
      const overlays = [...document.querySelectorAll('.ant-modal-mask, .ant-modal-wrap, .ant-drawer-open')]
        .filter(el => el.getBoundingClientRect().height > 0)
        .map(el => ({className:el.className, top:el.getBoundingClientRect().top, bottom:el.getBoundingClientRect().bottom}));
      const buttons = [...document.querySelectorAll('.titlebar-btn')].map(button => {
        const r = button.getBoundingClientRect();
        return {label:button.ariaLabel, hit:button.contains(document.elementFromPoint(r.x+r.width/2, r.y+r.height/2))};
      });
      const drag = document.querySelector('.titlebar-brand').getBoundingClientRect();
      const dragHit = document.elementFromPoint(drag.x+drag.width/2, drag.y+drag.height/2);
      const modal = document.querySelector('.ant-modal');
      const rect = modal?.getBoundingClientRect();
      return {titlebarBottom:strip.bottom, overlays, buttons, dragAccessible:dragHit?.hasAttribute('data-tauri-drag-region'),
        modalCenter:rect ? rect.y+rect.height/2 : null, expectedCenter:(innerHeight+strip.bottom)/2};
    });
    assert(geometry.buttons.every(button => button.hit), `${name}: titlebar covered`);
    assert(geometry.dragAccessible, `${name}: drag region covered`);
    assert(geometry.overlays.every(overlay => overlay.top === geometry.titlebarBottom && overlay.bottom === height), `${name}: overlay bounds wrong`);
    if (geometry.modalCenter !== null) assert(Math.abs(geometry.modalCenter-geometry.expectedCenter) < 2, `${name}: modal not centered in content`);
    const before = await page.evaluate(() => window.__uiTest.calls.length);
    for (const label of ['最小化', '最大化', '还原', '关闭']) {
      await page.locator('.titlebar-controls').getByRole('button', {name:label, exact:true}).click();
    }
    const commands = await page.evaluate(before => window.__uiTest.calls.slice(before).map(call => call.cmd), before);
    for (const command of ['minimize','maximize','unmaximize','close']) {
      assert(commands.includes(`plugin:window|${command}`), `${name}: ${command} not invoked`);
    }
    await page.screenshot({path:`output/playwright/titlebar-${name}-${theme}-${width}.png`});
    metrics.push({name,theme,width,height,...geometry,commands});
  }

  for (const theme of ['light','dark']) {
    await page.emulateMedia({colorScheme:theme});
    for (const [width,height] of [[720,520],[1180,760]]) {
      await page.setViewportSize({width,height});
      await page.getByRole('button', {name:'插件',exact:true}).click();
      await page.getByRole('button', {name:/卸载.*MusicBrainz/}).click();
      await page.locator('.ant-modal-wrap').waitFor();
      await page.waitForTimeout(400);
      await checkOverlay('modal',theme,width,height);
      await page.locator('.ant-modal-wrap').getByRole('button', {name:/取\s*消/}).click();
      await page.locator('.ant-modal-wrap').waitFor({state:'hidden'});
      // A hook-created confirmation uses the same global overlay boundary.
      await page.getByRole('button', {name:'文件夹',exact:true}).click();
      await page.getByRole('button', {name:/移除/}).first().click();
      await page.locator('.ant-modal-wrap').waitFor();
      await page.waitForTimeout(400);
      await checkOverlay('confirm',theme,width,height);
      await page.locator('.ant-modal-wrap').getByRole('button', {name:/取\s*消/}).click();
      await page.locator('.ant-modal-wrap').waitFor({state:'hidden'});
      await page.getByRole('button', {name:'歌曲',exact:true}).click();
      await page.locator('.library-track-list .ant-table-tbody-virtual-holder-inner > div').first().click();
      await page.locator('.ant-drawer-open').waitFor();
      await page.waitForTimeout(400);
      await checkOverlay('drawer',theme,width,height);
      await page.keyboard.press('Escape');
      await page.locator('.ant-drawer-open').waitFor({state:'detached'});
    }
  }
  assert(errors.length === 0, JSON.stringify(errors));
  return {metrics,errors};
}
