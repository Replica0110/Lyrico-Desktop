async (page) => {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const results = [];
  const pages = ['歌曲', '专辑', '艺术家', '文件夹', '插件', '批处理', '设置'];
  const headerMetrics = [];

  // Reset any overlay left open by an earlier run in the same browser session.
  await page.keyboard.press('Escape');
  await page.reload();
  await page.locator('.side-navigation').waitFor({ state: 'visible' });

  for (const mode of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: mode });
    for (const [width, height] of [[720, 520], [1180, 760]]) {
      await page.setViewportSize({ width, height });
      for (const name of pages) {
        await page.getByRole('button', { name, exact: true }).click();
        await page.locator('.page-viewport:not(.is-hidden) .page-header h2').waitFor({ state: 'visible' });
        await page.waitForTimeout(250);
        const metrics = await page.evaluate(() => {
          const visible = e => e.getClientRects().length > 0;
          const vp = [...document.querySelectorAll('.page-viewport')].find(visible);
          const nav = document.querySelector('.side-panel');
          const headerRow = vp.querySelector('.page-header-row');
          const h = vp.querySelector('.page-header h2');
          const actions = vp.querySelector('.page-header-actions');
          const statusbar = document.querySelector('.app-statusbar');
          const vpRect = vp.getBoundingClientRect();
          const clipped = [...vp.querySelectorAll('button, input, [role="button"]')]
            .filter(visible)
            .filter(el => {
              const r = el.getBoundingClientRect();
              return r.width > 0 && (r.right > vpRect.right + 1 || r.left < vpRect.left - 1);
            })
            .map(el => (el.getAttribute('aria-label') || el.textContent || el.tagName).slice(0, 32));
          return {
            docX: document.documentElement.scrollWidth - innerWidth,
            docY: document.documentElement.scrollHeight - innerHeight,
            pageX: vp.scrollWidth - vp.clientWidth,
            navWidth: nav.getBoundingClientRect().width,
            titleSize: h ? getComputedStyle(h).fontSize : null,
            headerMinHeight: headerRow ? getComputedStyle(headerRow).minHeight : null,
            headerHeight: headerRow ? Math.round(headerRow.getBoundingClientRect().height) : null,
            actionsGap: actions ? getComputedStyle(actions).gap : null,
            statusbarPadding: statusbar ? getComputedStyle(statusbar).paddingLeft : null,
            clipped,
          };
        });
        const path = `output/playwright/${mode}-${width}-${name}.png`;
        await page.screenshot({ path });
        if (width === 1180) {
          headerMetrics.push({ mode, name, ...metrics });
        }
        results.push({ mode, width, name, ...metrics });
      }
    }
  }

  // Second-level bars must also stay on one row at both supported window sizes.
  const measureBar = () => page.locator('.subpage-bar').evaluate(bar => {
    const row = bar.querySelector('.subpage-bar-row');
    const vp = [...document.querySelectorAll('.page-viewport')].find(e => e.getClientRects().length > 0);
    return {
      rowHeight: Math.round(row.getBoundingClientRect().height),
      barHeight: Math.round(bar.getBoundingClientRect().height),
      pageOverflowX: vp.scrollWidth - vp.clientWidth,
      docOverflowX: document.documentElement.scrollWidth - innerWidth,
      docOverflowY: document.documentElement.scrollHeight - innerHeight,
      back: bar.querySelector('.subpage-back')?.getAttribute('aria-label'),
      path: [...bar.querySelectorAll('.subpage-path-button, .subpage-path-current')].map(n => n.textContent.trim()),
    };
  });
  const subpageBars = [];
  for (const mode of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: mode });
    for (const [width, height] of [[720, 520], [1180, 760]]) {
      await page.setViewportSize({ width, height });
      await page.getByRole('button', { name: '文件夹', exact: true }).click();
      await page.locator('.folder-row-open').first().click();
      await page.locator('.subpage-bar').waitFor({ state: 'visible' });
      await page.waitForTimeout(200);
      subpageBars.push({ mode, width, kind: 'folder', ...(await measureBar()) });
      await page.screenshot({ path: `output/playwright/${mode}-${width}-文件夹-二级.png` });
      await page.locator('.subpage-back').click();
      await page.locator('.folder-row-open').first().waitFor();

      await page.getByRole('button', { name: '专辑', exact: true }).click();
      await page.locator('.collection-tile').first().click();
      await page.locator('.subpage-bar').waitFor({ state: 'visible' });
      await page.waitForTimeout(200);
      subpageBars.push({ mode, width, kind: 'album', ...(await measureBar()) });
      await page.screenshot({ path: `output/playwright/${mode}-${width}-专辑-二级.png` });
      await page.locator('.subpage-back').click();
      await page.locator('.collection-tile').first().waitFor();
    }
  }
  const badSubpageBars = subpageBars.filter(bar =>
    bar.rowHeight !== 40 || bar.pageOverflowX || bar.docOverflowX || bar.docOverflowY || bar.path.length < 2);

  const baseline = headerMetrics[0];
  const mismatches = headerMetrics.filter(r =>
    r.titleSize !== '20px'
    || r.headerMinHeight !== baseline.headerMinHeight
    || r.headerHeight !== baseline.headerHeight
    || (r.actionsGap !== null && r.actionsGap !== baseline.actionsGap)
    || r.statusbarPadding !== baseline.statusbarPadding
  );
  // Rendered geometry, not just the CSS constant: the header must stay one row everywhere.
  const failed = results.filter(r => r.docX || r.docY || r.pageX || r.navWidth !== 176 || r.titleSize !== '20px'
    || r.statusbarPadding !== '16px' || r.headerMinHeight !== '44px' || r.headerHeight !== 44 || r.clipped.length);
  const failures = results.filter(r => r.docX || r.docY || r.pageX || r.navWidth !== 176 || r.titleSize !== '20px' || r.clipped.length);
  if (errors.length || failures.length || mismatches.length || failed.length || badSubpageBars.length) {
    throw Error(JSON.stringify({
      failures,
      mismatches,
      failed: failed.slice(0, 6),
      badSubpageBars,
      errors,
      baseline,
    }, null, 1));
  }
  return { baselineHeader: baseline, pages: results.length, subpageBars, errors };
}
