// Focused regressions with mocked storage: downloaded bytes, filenames and recycle navigation.
async page => {
  const origin = 'http://127.0.0.1:4176/';
  const source = 'https://imageqa.supabase.co';
  const fixture = await page.evaluate(() => {
    const image = (width, height, color) => {
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      const context = canvas.getContext('2d'); context.fillStyle = color; context.fillRect(0,0,width,height);
      context.fillStyle = '#ffffff'; context.font = '18px sans-serif'; context.fillText(`${width} x ${height}`,16,32);
      return canvas.toDataURL('image/png');
    };
    return { original:image(720,480,'#397663'), thumbnail:image(180,120,'#557b91') };
  });
  const dataUrl = fixture.original;
  const bytes = Buffer.from(dataUrl.split(',')[1], 'base64');
  const checks = [], errors = [];
  let unloadPrompts = 0;
  const check = (value, label) => { if (!value) throw new Error(label); checks.push(label); };
  const row = { id:'12345678-1234-4234-8234-123456789abc', namespace:'图片空间', text:'原图下载测试', created_at:'2026-10-23T12:00:00Z', deleted_at:null, files:[], images:[
    { name:'中文原图.png', key:'original.png', url:source+'/storage/v1/object/public/files/original.png', thumbnail:fixture.thumbnail, type:'image/png', size:bytes.length },
    dataUrl,
    { name:'长截图原件.png', key:'segmented.png', url:'', segmented:true, size:bytes.length, type:'image/png', parts:[{ key:'segmented.png.part-0000', size:bytes.length, sha256:'' }] }
  ] };
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => { if (dialog.type() === 'beforeunload') unloadPrompts++; return dialog.accept(); });
  await page.emulateMedia({ reducedMotion:'reduce' });
  await page.addInitScript(() => { window.showSaveFilePicker = undefined; });
  await page.route('**/backend-config.json', route => route.fulfill({ json:{ version:1, default:'main', routes:{ main:{ url:source, key:'sb_publishable_test' } } } }));
  await page.route('**/rest/v1/**', route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/shortlink_capabilities')) return route.fulfill({ json:{ schema:2 } });
    if (url.pathname.endsWith('/soft_delete_shortlinks')) {
      row.deleted_at = new Date().toISOString();
      return route.fulfill({ json:{ ids:[row.id] } });
    }
    if (url.pathname.endsWith('/restore_shortlinks')) {
      row.deleted_at = null;
      return route.fulfill({ json:{ ids:[row.id] } });
    }
    if (url.pathname.endsWith('/shortlinks')) return route.fulfill({ json:[row] });
    return route.fulfill({ json:null });
  });
  await page.route(source+'/storage/**', route => {
    const headers = { 'Content-Type':'image/png', 'Content-Length':String(bytes.length), 'Access-Control-Allow-Origin':'*' };
    if (new URL(route.request().url()).searchParams.has('download')) headers['Content-Disposition'] = "attachment; filename*=UTF-8''"+encodeURIComponent('中文原图.png');
    return route.fulfill({ body:bytes, headers });
  });
  const link = origin+'?s='+row.id;
  await page.goto(link);
  await page.locator('#edit-btn').waitFor();
  row.images[2].parts[0].sha256 = await page.evaluate(async data => {
    const buffer = await (await fetch(data)).arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2,'0')).join('');
  }, dataUrl);
  await page.reload();
  await page.locator('[data-image-download="2"]').waitFor();
  check(await page.locator('[data-image-download]').count() === 3, 'download available for storage, legacy and segmented originals');
  async function downloadAndCheck(selector, filename) {
    const pending = page.waitForEvent('download');
    await page.locator(selector).click();
    const download = await pending;
    check(download.suggestedFilename() === filename, 'preserves filename: '+filename);
    const chunks = [];
    for await (const chunk of await download.createReadStream()) chunks.push(chunk);
    check(Buffer.concat(chunks).equals(bytes), 'downloads original bytes: '+filename);
    check(await page.locator('dialog[open]').count() === 0, 'direct download does not open image viewer');
  }
  await downloadAndCheck('[data-image-download="0"]', '中文原图.png');
  await downloadAndCheck('[data-image-download="1"]', '图片-2.png');
  await downloadAndCheck('[data-image-download="2"]', '长截图原件.png');
  check(unloadPrompts === 0, 'one-click downloads do not prompt to leave page');
  await page.getByRole('button', { name:'完成', exact:true }).click();
  await page.locator('[data-image-index="0"]').click();
  check(await page.locator('dialog[open] [data-download]').getAttribute('aria-label') === '下载原图', 'viewer retains original download action');
  await page.locator('[data-close]').click();
  await page.setViewportSize({ width:1440, height:1000 });
  await page.screenshot({ path:'output/playwright/image-download-desktop.png', fullPage:true });
  await page.setViewportSize({ width:390, height:844 });
  await page.screenshot({ path:'output/playwright/image-download-mobile.png', fullPage:true });
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'image actions fit mobile width');
  await page.locator('#delete-link').click();
  await page.getByRole('button', { name:'撤销', exact:true }).waitFor();
  check(await page.locator('#app button').count() === 1, 'deleted view has one undo and no duplicate restore');
  const back = page.locator('#app').getByRole('link', { name:'返回我的短链接' });
  const create = page.locator('#app').getByRole('link', { name:'创建短链接' });
  const trash = page.locator('#app').getByRole('link', { name:'打开回收站' });
  check(new URL(await back.getAttribute('href')).searchParams.get('user') === row.namespace, 'return link preserves record namespace');
  check(new URL(await trash.getAttribute('href')).searchParams.get('trash') === '1', 'recycle bin remains accessible');
  check(!new URL(await create.getAttribute('href')).searchParams.has('s'), 'create link leaves deleted record');
  await page.screenshot({ path:'output/playwright/recycle-navigation-mobile.png', fullPage:true });
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'deleted actions fit mobile width');
  await page.getByRole('button', { name:'撤销', exact:true }).click();
  await page.locator('#edit-btn').waitFor();
  check(!row.deleted_at, 'undo restores content');
  await page.locator('#delete-link').click();
  await page.getByRole('button', { name:'撤销', exact:true }).waitFor();
  await page.reload();
  await page.locator('#app').getByRole('link', { name:'创建短链接' }).click();
  await page.locator('#create-btn').waitFor();
  check(true, 'create entry works after reload of deleted link');
  check(!errors.length, 'no uncaught browser errors');
  await page.evaluate(result => { window.__imageDownloadQA = result; }, { checks, errors });
  console.log(JSON.stringify({ checks, errors }));
}
