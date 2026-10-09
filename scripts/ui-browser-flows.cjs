async (page) => {
  const steps = [];
  const errors = [];
  // Registered before the first interaction so a crash in any flow above cannot hide as `errors: []`.
  page.on('pageerror', e => errors.push(e.message));
  const fail = message => { throw Error(`${message} :: ${JSON.stringify(steps)}`); };
  await page.setViewportSize({ width: 1180, height: 760 });
  // Reset any overlay left open by an earlier run in the same browser session.
  await page.reload();
  await page.locator('.side-navigation').waitFor({ state: 'visible' });
  await page.waitForTimeout(400);

  // 1. Song row click opens the editor drawer (one click, no selection mode).
  await page.getByRole('button', { name: '歌曲', exact: true }).click();
  await page.locator('.library-track-list .ant-table-tbody-virtual-holder-inner > div').first().click();
  await page.locator('.ant-drawer-open').waitFor({ state: 'visible', timeout: 5000 });
  const drawerTitle = await page.locator('.ant-drawer-title').first().innerText();
  steps.push({ step: 'songRowOpensEditor', clicks: 1, drawerTitle });
  await page.keyboard.press('Escape');
  await page.locator('.ant-drawer-open').waitFor({ state: 'detached', timeout: 5000 });

  // 1b. Edit one field and save: the drawer and the page must both survive the round trip.
  // A concurrent Vite full reload (another editor saving a source file) can tear the DOM down
  // mid-step, so the round trip is retried; a real crash stays broken on every attempt.
  const savedTitle = '已保存标题-验证';
  let saveAttempt = 0;
  let editAndSave;
  while (!editAndSave && saveAttempt < 3) {
    saveAttempt += 1;
    try {
      await page.reload();
      await page.locator('.side-navigation').waitFor({ state: 'visible', timeout: 15000 });
      await page.waitForTimeout(300);
      await page.locator('.library-track-list .ant-table-tbody-virtual-holder-inner > div').first().click();
      await page.locator('.ant-drawer-open').waitFor({ state: 'visible', timeout: 5000 });
      const titleInput = page.locator('.ant-drawer-open .tag-field')
        .filter({ has: page.locator('.ant-form-item-label label', { hasText: '标题' }) })
        .locator('input')
        .first();
      await titleInput.waitFor({ state: 'visible', timeout: 5000 });
      await titleInput.fill(savedTitle);
      // Not `exact`: the save icon contributes "save" to the button's accessible name.
      await page.locator('.ant-drawer-open').getByRole('button', { name: '保存' }).click({ timeout: 10000 });
      await page.waitForFunction(
        () => (window.__uiTest?.calls ?? []).some(call => call.cmd === 'save_audio_tags'),
        undefined,
        { timeout: 10000 },
      );
      await page.locator('.side-navigation').waitFor({ state: 'visible', timeout: 10000 });
      const drawerAfterSave = await page.locator('.ant-drawer-open').count();
      const headerAfterSave = await page.locator('.page-viewport:not(.is-hidden) .page-header h2').count();
      const headerTextAfterSave = headerAfterSave ? await page.locator('.page-viewport:not(.is-hidden) .page-header h2').first().innerText() : '';
      const rowCountAfterSave = await page.locator('.library-track-list .ant-table-tbody-virtual-holder-inner > div').count();
      if (drawerAfterSave === 0 || headerAfterSave === 0 || rowCountAfterSave === 0) {
        fail(`saving blanked the page: ${JSON.stringify({ drawerAfterSave, headerAfterSave, headerTextAfterSave, rowCountAfterSave })}`);
      }
      await page.keyboard.press('Escape');
      await page.locator('.ant-drawer-open').waitFor({ state: 'detached', timeout: 5000 });
      const persistedTitle = await page.evaluate(() => window.__uiTest?.tracks?.[0]?.title);
      const firstRowText = await page.locator('.library-track-list .ant-table-tbody-virtual-holder-inner > div').first().innerText();
      if (persistedTitle !== savedTitle || !firstRowText.includes(savedTitle)) {
        fail(`saved title not reflected: ${JSON.stringify({ persistedTitle, firstRowText })}`);
      }
      editAndSave = { step: 'editAndSave', clicks: 2, savedTitle, headerTextAfterSave, rowCountAfterSave, persistedTitle };
    } catch (error) {
      if (saveAttempt >= 3) throw error;
      await page.locator('.side-navigation').waitFor({ state: 'visible', timeout: 15000 }).catch(() => undefined);
    }
  }
  steps.push({ ...editAndSave, attempts: saveAttempt });

  // 2. Checkbox selection shows the selection bar, and 批量处理 reaches the batch page.
  const boxes = page.locator('.library-track-list input[type="checkbox"]');
  await boxes.nth(1).check();
  await boxes.nth(2).check();
  await page.locator('.selection-bar').waitFor({ state: 'visible' });
  const selectionText = await page.locator('.selection-bar').innerText();
  await page.locator('.selection-bar').getByRole('button', { name: '批量处理' }).click();
  await page.locator('.page-viewport:not(.is-hidden)').getByRole('heading', { name: '批处理' }).waitFor();
  steps.push({ step: 'checkboxSelection', clicks: 3, selectionText });
  const tasksMeta = await page.locator('.page-header-meta').first().innerText();
  steps.push({ step: 'batchPageKeepsSelection', tasksMeta });
  await page.locator('.page-header-meta').first().getByRole('button').count().catch(() => 0);

  // 3. Folder second-level page: back target + real path + level actions on one bar.
  await page.getByRole('button', { name: '文件夹', exact: true }).click();
  await page.locator('.folder-row-open').first().click();
  await page.locator('.subpage-bar').waitFor({ state: 'visible' });
  // The 2 songs selected on the songs page still show here as a selection bar inside the sub page bar.
  const folderSelectionBar = await page.locator('.subpage-bar .selection-bar').innerText();
  await page.locator('.subpage-bar .selection-bar').getByRole('button', { name: '清空选择' }).click();
  await page.locator('.selection-bar').waitFor({ state: 'detached' });
  const subpage = await page.locator('.subpage-bar').evaluate(bar => ({
    rowHeight: Math.round(bar.querySelector('.subpage-bar-row').getBoundingClientRect().height),
    back: bar.querySelector('.subpage-back')?.getAttribute('aria-label'),
    path: [...bar.querySelectorAll('.subpage-path-button, .subpage-path-current')].map(n => n.textContent.trim()),
    actionLabels: [...bar.querySelectorAll('.subpage-bar-actions button[aria-label]')].map(n => n.getAttribute('aria-label')),
    titleRows: document.querySelectorAll('.page-header').length,
  }));
  if (!subpage.back || subpage.path.length < 2 || subpage.titleRows !== 0 || subpage.rowHeight !== 40) {
    fail(`folder sub page bar incomplete: ${JSON.stringify(subpage)}`);
  }
  steps.push({ step: 'folderSubPage', ...subpage, folderSelectionBar });
  await page.screenshot({ path: 'output/playwright/flow-folder-subpage.png' });
  await page.locator('.subpage-back').click();
  await page.locator('.folder-row-open').first().waitFor();

  // 4. Albums / artists detail pages use the same second-level bar.
  await page.getByRole('button', { name: '专辑', exact: true }).click();
  await page.locator('.collection-tile').first().click();
  await page.locator('.subpage-bar').waitFor({ state: 'visible' });
  const albumDetail = await page.locator('.subpage-bar').evaluate(bar => ({
    path: [...bar.querySelectorAll('.subpage-path-button, .subpage-path-current')].map(n => n.textContent.trim()),
    hasHeading: Boolean(document.querySelector('.detail-heading')),
  }));
  steps.push({ step: 'albumDetail', ...albumDetail });
  await page.screenshot({ path: 'output/playwright/flow-album-detail.png' });
  await page.locator('.subpage-back').click();

  // 5. Plugins: one framed two-pane surface, rail order, and a save button gated on dirty.
  await page.getByRole('button', { name: '插件', exact: true }).click();
  await page.locator('.plugin-item').first().waitFor({ state: 'visible' });
  const pluginLayout = await page.locator('.plugin-layout').evaluate(layout => ({
    railWidth: Math.round(layout.querySelector('.plugin-list-panel').getBoundingClientRect().width),
    items: [...layout.querySelectorAll('.plugin-item')].map(n => n.querySelector('.plugin-item-name')?.textContent),
    panelTitle: layout.querySelector('.panel-title')?.textContent,
    detailName: layout.querySelector('.plugin-detail-name')?.textContent,
    handles: layout.querySelectorAll('.reorder-handle').length,
  }));
  if (pluginLayout.items.length < 2 || pluginLayout.handles !== pluginLayout.items.length) fail('plugin rail not reorderable');
  const saveButton = page.locator('.plugin-config-footer').getByRole('button', { name: '保存' });
  const saveDisabledBefore = await saveButton.isDisabled();
  await page.getByLabel('服务地址').fill('https://example.test');
  const saveEnabledAfter = await saveButton.isEnabled();
  if (!saveDisabledBefore || !saveEnabledAfter) fail(`config save gate wrong: ${saveDisabledBefore}/${saveEnabledAfter}`);
  steps.push({ step: 'pluginsLayout', ...pluginLayout, saveDisabledBefore, saveEnabledAfter });
  await page.screenshot({ path: 'output/playwright/flow-plugins.png' });

  // 6. dnd-kit reordering: keyboard moves a lyric line and announces the position.
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.locator('.ant-tabs-tab').filter({ hasText: '歌词' }).click();
  const handles = page.locator('.reorder-handle');
  await handles.first().waitFor({ state: 'visible' });
  const before = await page.locator('.reorder-list .reorder-content').allInnerTexts();
  await handles.first().focus();
  // dnd-kit KeyboardSensor: Space picks the row up, arrows move it, Space drops it.
  await page.keyboard.press('Space');
  await page.waitForTimeout(200);
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(200);
  await page.keyboard.press('Space');
  await page.waitForTimeout(500);
  const after = await page.locator('.reorder-list .reorder-content').allInnerTexts();
  const announcements = await page.evaluate(() => [...document.querySelectorAll('[role="status"], [aria-live]')]
    .map(node => (node.textContent || '').trim())
    .filter(Boolean));
  if (before.length < 2 || before[0] === after[0]) fail(`keyboard reorder did not move: ${JSON.stringify({ before, after })}`);
  if (!announcements.some(text => /第 \d+ 项/.test(text))) fail(`reorder not announced: ${JSON.stringify(announcements)}`);
  steps.push({ step: 'keyboardReorder', before, after, announcements });

  // 7. Sidebar collapse keeps a single source of width.
  await page.getByRole('button', { name: '收起侧栏', exact: true }).click();
  await page.waitForFunction(() => Math.abs(document.querySelector('.side-panel').getBoundingClientRect().width - 56) < 1);
  await page.getByRole('button', { name: '展开侧栏', exact: true }).click();

  return { steps, errors };
}
