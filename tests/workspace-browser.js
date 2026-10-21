// Run using playwright-cli run-code --filename=tests/workspace-browser.js.
// Every backend request is intercepted; no production records are read or changed.
async page => {
  const checks = [];
  const errors = [];
  const requests = [];
  const source = 'https://qa.supabase.co';
  const uuid = i => `00000000-0000-4000-8000-${String(i).padStart(12,'0')}`;
  let rows = Array.from({length:47},(_,i)=>({id:uuid(i+1),namespace:'default',text:`正文 ${i} `+(i===46?'末页中文长正文关键字':''),description:`记录 ${i}`,images:[],files:i===45?[{name:'中文报告.pdf',key:'test/report.pdf',url:source+'/storage/v1/object/public/files/test/report.pdf',size:12}]:[],retired_assets:[],created_at:new Date(Date.UTC(2026,0,1,0,i)).toISOString(),updated_at:new Date(Date.UTC(2026,0,1,0,i)).toISOString(),deleted_at:null,cleanup_started_at:null}));
  const objects=new Map(); const sessions=new Map();let nextSession=0,holdPatch=false,deleteFails=false,losePatch=false;
  page.on('pageerror',error=>errors.push(error.message));
  page.on('dialog',dialog=>dialog.accept());
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.route('**/backend-config.json',route=>route.fulfill({json:{version:1,default:'main',routes:{main:{url:source,key:'sb_publishable_mock'}}}}));
  await page.route('**/rest/v1/**',async route=>{
    const req=route.request(),url=new URL(req.url()),method=req.method();
    if(url.origin!==source)throw new Error('Unexpected backend '+url.origin);
    const body=req.postDataJSON(); requests.push({path:url.pathname,method,body,query:url.search});
    if(url.pathname.endsWith('/shortlink_capabilities'))return route.fulfill({json:{schema:2}});
    if(url.pathname.endsWith('/search_shortlinks')){
      const q=body.p_query.toLowerCase();
      const matches=rows.filter(r=>r.namespace===body.p_namespace&&!!r.deleted_at===body.p_trash&&`${r.text} ${r.description} ${r.files.map(f=>f.name).join(' ')} ${r.images.map(f=>f.name).join(' ')}`.toLowerCase().includes(q)).sort((a,b)=>b.created_at.localeCompare(a.created_at));
      return route.fulfill({json:{items:matches.slice(body.p_offset,body.p_offset+body.p_limit).map(r=>({...r,images:undefined,files:undefined,preview:r.text.slice(0,180),image_count:r.images.length,file_count:r.files.length})),total:matches.length}});
    }
    if(url.pathname.endsWith('/soft_delete_shortlinks')||url.pathname.endsWith('/restore_shortlinks')){
      const restoring=url.pathname.endsWith('/restore_shortlinks');
      for(const id of body.p_ids){const r=rows.find(r=>r.id===id&&r.namespace===body.p_namespace);if(r){r.deleted_at=restoring?null:new Date().toISOString();r.updated_at=new Date().toISOString();}}
      return route.fulfill({json:{ids:body.p_ids,count:body.p_ids.length}});
    }
    if(url.pathname.endsWith('/begin_purge')){
      const row=rows.find(r=>r.id===body.p_id);row.cleanup_started_at=new Date().toISOString();
      row.cleanup_keys=[...row.images,...row.files,...row.retired_assets].filter(x=>x.key).map(x=>({bucket:'files',key:x.key}));
      return route.fulfill({json:{id:row.id,keys:row.cleanup_keys}});
    }
    if(url.pathname.endsWith('/finish_purge')){rows=rows.filter(r=>r.id!==body.p_id);return route.fulfill({json:{id:body.p_id}});}
    if(url.pathname.endsWith('/shortlinks')){
      const id=url.searchParams.get('id')?.replace(/^eq\./,'');
      if(method==='GET')return route.fulfill({json:id?rows.filter(r=>r.id===id):rows});
      if(method==='POST'){const row={...body,updated_at:new Date().toISOString(),deleted_at:null};rows.push(row);return route.fulfill({json:[row]});}
      if(method==='PATCH'){
        const row=rows.find(r=>r.id===id),version=url.searchParams.get('updated_at')?.replace(/^eq\./,'');
        if(version&&version!==row.updated_at)return route.fulfill({json:[]});
        Object.assign(row,body,{updated_at:new Date().toISOString()});
        if(losePatch){losePatch=false;return route.abort('failed');}
        return route.fulfill({json:[row]});
      }
    }
    return route.fulfill({status:500,json:{message:'unhandled '+url.pathname}});
  });
  await page.route('https://qa.storage.supabase.co/**',async route=>{
    const req=route.request(),url=new URL(req.url()),h=req.headers();
    const cors={'Access-Control-Allow-Origin':'*','Access-Control-Expose-Headers':'Location,Upload-Offset,Upload-Length'};
    if(req.method()==='POST'){
      const metadata=Object.fromEntries(h['upload-metadata'].split(',').map(pair=>{const [k,v]=pair.split(' ');return [k,Buffer.from(v,'base64').toString()];}));
      const id=String(++nextSession);sessions.set(id,{key:metadata.objectName,size:Number(h['upload-length']),offset:0,parts:[],type:metadata.contentType});
      return route.fulfill({status:201,headers:{...cors,Location:`https://qa.storage.supabase.co/storage/v1/upload/resumable/${id}`}});
    }
    const session=sessions.get(url.pathname.split('/').pop());
    if(req.method()==='HEAD')return route.fulfill({status:200,headers:{...cors,'Upload-Offset':String(session.offset),'Upload-Length':String(session.size)}});
    if(req.method()==='PATCH'){
      if(holdPatch){await new Promise(r=>setTimeout(r,350));if(holdPatch)return route.abort('failed');}
      const part=req.postDataBuffer();session.parts.push(part);session.offset+=part.length;
      if(session.offset===session.size)objects.set(session.key,{bytes:Buffer.concat(session.parts),type:session.type});
      return route.fulfill({status:204,headers:{...cors,'Upload-Offset':String(session.offset)}});
    }
  });
  await page.route(source+'/storage/**',async route=>{
    const req=route.request(),url=new URL(req.url());
    if(req.method()==='DELETE'){
      if(deleteFails)return route.fulfill({status:503,json:{message:'simulated cleanup failure'}});
      for(const key of req.postDataJSON().prefixes)objects.delete(key);
      return route.fulfill({json:[]});
    }
    const key=decodeURIComponent(url.pathname.split('/public/files/')[1]||'');const item=objects.get(key);
    if(!item)return route.fulfill({status:404,json:{message:'Object not found'}});
    return route.fulfill({status:200,body:req.method()==='HEAD'?'':item.bytes,headers:{'Content-Type':item.type,'Content-Length':String(item.bytes.length)}});
  });
  const check=(value,name)=>{if(!value)throw new Error(name);checks.push(name);};
  await page.goto('http://127.0.0.1:4176/');
  await page.evaluate(async()=>{localStorage.clear();for(const {key} of await ShortlinkDrafts.list())await ShortlinkDrafts.remove(key);});
  await page.reload();await page.locator('#text-input').waitFor();
  await page.locator('#text-input').fill('不会丢失的中文草稿');
  await page.locator('#upload-file-input').setInputFiles({name:'草稿附件.txt',mimeType:'text/plain',buffer:Buffer.from('附件原始字节')});
  await page.waitForFunction(()=>document.querySelector('#draft-status').textContent.includes('草稿已保存'));
  await page.reload();await page.locator('#text-input').waitFor();
  check(await page.locator('#text-input').inputValue()==='不会丢失的中文草稿','text draft survives reload');
  check((await page.locator('#upload-previews').innerText()).includes('草稿附件.txt'),'File draft survives reload');
  const imageData=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=40;c.height=10000;const ctx=c.getContext('2d');ctx.fillStyle='#369';ctx.fillRect(0,0,40,10000);return c.toDataURL('image/png').split(',')[1];});
  const original=Buffer.from(imageData,'base64');
  await page.locator('#file-input').setInputFiles({name:'中文长截图.png',mimeType:'image/png',buffer:original});
  await page.waitForFunction(()=>document.querySelector('#draft-status').textContent.includes('草稿已保存'));
  await page.locator('.preview-open').click();await page.locator('dialog[open]').waitFor();await page.locator('[data-close]').click();
  check(await page.locator('.preview-open').count()===1,'preview click keeps image in editor');
  await page.locator('#create-btn').click();await page.locator('#result').waitFor({state:'visible'});
  const created=rows.find(r=>r.text==='不会丢失的中文草稿');
  check(created.images[0].height===10000&&created.images[0].type==='image/png','long image dimensions and original type retained');
  check(objects.get(created.images[0].key).bytes.equals(original),'stored image bytes equal original');
  check(created.images[0].thumbnail.startsWith('data:image/'),'lightweight thumbnail stored separately from original');
  check(created.files[0].name==='草稿附件.txt','Chinese filename retained');
  check((await page.evaluate(()=>ShortlinkDrafts.list('draft:'))).length===0,'draft cleared only after publish');
  const link=await page.locator('#result-url').getAttribute('href');check(link.includes('store=main'),'shared link carries stable route');
  await page.goto(link);await page.locator('[data-image-index]').click();
  await page.waitForFunction(()=>document.querySelector('.image-viewer-full')?.naturalHeight===10000);
  check(true,'viewer loads original long screenshot');
  await page.locator('[data-actual]').click();await page.locator('[data-close]').click();
  await page.locator('#edit-btn').click();await page.locator('#text-input').fill('编辑中的草稿');
  await page.locator('#cancel-edit-btn').click();await page.locator('#edit-btn').click();
  check(await page.locator('#text-input').inputValue()==='编辑中的草稿','cancel edit preserves draft');
  losePatch=true;await page.locator('#create-btn').click();await page.locator('#edit-btn').waitFor();
  check(rows.find(r=>r.id===created.id).text==='编辑中的草稿','lost PATCH response recognized by semantic comparison');
  await page.goto('http://127.0.0.1:4176/?user=default');await page.locator('#search-input').waitFor();
  await page.locator('#search-input').fill('末页中文长正文关键字');
  await page.waitForFunction(()=>document.querySelector('#search-status')?.textContent.includes('1 条'));
  check(await page.locator('.library-row').count()===1,'full text search across all library records');
  await page.locator('#search-input').fill('中文报告');await page.waitForFunction(()=>document.querySelector('.library-title')?.textContent==='记录 45');
  check(true,'search matches attachment name');
  await page.locator('#search-input').fill('记录');await page.waitForFunction(()=>document.querySelector('#search-status')?.textContent.includes('47 条'));
  await page.locator('#next-page').click();await page.waitForFunction(()=>document.querySelector('#page-status')?.textContent==='2 / 3');
  check(await page.locator('#search-input').inputValue()==='记录','pagination preserves search query');
  await page.goto(link);await page.locator('#delete-link').click();await page.locator('#restore-link').waitFor();
  check(!!created.deleted_at&&objects.has(created.images[0].key),'soft delete keeps storage objects');
  await page.getByRole('button',{name:'撤销',exact:true}).click();await page.locator('#edit-btn').waitFor();
  check(!created.deleted_at,'undo restores published content');
  await page.locator('#delete-link').click();await page.goto('http://127.0.0.1:4176/?user=default&trash=1');await page.locator('[data-select]').first().check();
  deleteFails=true;await page.locator('#batch-purge').click();await page.waitForFunction(()=>document.querySelector('.action-notice')?.textContent.includes('待重试'));
  check(rows.some(r=>r.id===created.id&&r.cleanup_started_at),'failed storage cleanup retains frozen record');
  deleteFails=false;await page.getByRole('button',{name:'继续清理',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#search-status')?.textContent.includes('0 条'));
  check(!rows.some(r=>r.id===created.id)&&!objects.has(created.images[0].key),'purge retry removes objects before row');
  await page.goto('http://127.0.0.1:4176/');await page.locator('#upload-file-input').setInputFiles({name:'断点续传.bin',mimeType:'application/octet-stream',buffer:Buffer.alloc(7*1024*1024,11)});
  await page.waitForFunction(()=>document.querySelector('#draft-status').textContent.includes('草稿已保存'));holdPatch=true;
  await page.locator('#create-btn').click();await page.waitForFunction(()=>document.querySelector('#transfer-status')?.textContent.includes('上传'));
  await page.locator('#pause-upload').click();await page.waitForFunction(()=>document.querySelector('#editor-error')?.textContent.includes('已暂停。'));
  check(!rows.some(r=>r.files.some(f=>f.name==='断点续传.bin')),'pause prevents publishing');
  holdPatch=false;await page.locator('#create-btn').click();await page.locator('#result').waitFor({state:'visible'});
  check(rows.some(r=>r.files.some(f=>f.name==='断点续传.bin')),'paused upload can resume and publish');
  await page.goto('http://127.0.0.1:4176/?page=settings');await page.locator('#backup-all').waitFor();
  check(await page.locator('.theme-card').count()===11,'all existing themes retained');
  check(await page.locator('#portability-settings').isVisible(),'backup and migration controls visible');
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:'output/playwright/upgrade-mobile-settings.png',fullPage:true});
  check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'mobile settings has no horizontal overflow');
  await page.goto('http://127.0.0.1:4176/');await page.locator('#text-input').waitFor();await page.screenshot({path:'output/playwright/upgrade-mobile-home.png',fullPage:true});
  check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'mobile editor has no horizontal overflow');
  await page.setViewportSize({width:1440,height:1000});await page.screenshot({path:'output/playwright/upgrade-desktop.png',fullPage:true});
  check(!errors.length,'no uncaught browser errors');
  await page.evaluate(result=>{window.__workspaceQA=result;},{checks,errors,searchRequests:requests.filter(r=>r.path.endsWith('/search_shortlinks')).length});
}
