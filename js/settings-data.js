// Data portability stays explicit: copying data and publishing the shared route are separate steps.
function renderPortabilitySettings() {
  const host = $('#portability-settings');
  if (!host) return;
  const source = {...connection};
  host.innerHTML = `<div class="section-heading"><div><p class="eyebrow">04 / KEEP YOUR DATA</p><h2>备份与迁移</h2></div>${Icons.database}</div>
    <p class="portability-copy">当前来源：${esc(source.url)}<br>完整备份包含此项目的全部空间、正文、原图、附件和回收站。请在服务可访问时留一份备份。</p>
    <p class="portability-copy">迁移前，在新 Supabase 项目运行 <a href="migration.sql" download>新版初始化 SQL</a>，再把新地址与公开 Key 填在上方。迁移保留短链接 ID，并核对文件完整性。</p>
    <div class="portability-actions"><button type="button" class="btn-sm" id="backup-all">${Icons.download} 下载完整备份</button><button type="button" class="btn-sm" id="restore-backup">${Icons.upload} 从备份恢复到上方连接</button><button type="button" class="btn-sm" id="migrate-all">${Icons.database} 迁移到上方连接</button><a class="btn-sm" href="docs/MIGRATION.md" target="_blank" rel="noopener">迁移说明 ↗</a></div>
    <input type="file" id="backup-file" accept=".slbackup" hidden>
    <div class="portability-status" id="portability-status" role="status"></div>
    <button type="button" class="btn-sm" id="cancel-portability" hidden>停止操作</button>
    <div class="portability-result" id="portability-result" hidden></div>
    <p class="dim spacer-sm">旧服务已停用时，可从完整备份恢复。仅有连接地址或 Key 不包含数据。迁移后的旧链接需再发布统一连接配置。</p>`;
  const status = $('#portability-status'), result = $('#portability-result');
  let running = false, controller;
  const progress = event => { status.textContent = event.message || `${event.phase} ${event.done || 0} / ${event.total || 0}`; };
  const setBusy = value => {
    running=value;
    host.querySelectorAll('.portability-actions button').forEach(button=>button.disabled=value);
    $('#cancel-portability').hidden=!value;
    const form=$('#connection-form'); if(form) form.inert=value;
  };
  $('#cancel-portability').onclick=()=>{controller?.abort();status.textContent='正在停止，已确认的迁移进度会保留…';};
  const showRoute = (target, report) => {
    result.hidden=false;
    result.innerHTML=`<p>数据已复制：${Number(report.rows || report.records || 0)} 条内容，${Number(report.assets || 0)} 个文件。来源项目保留。</p><p>下一步：下载统一连接配置，替换 GitHub 仓库根目录的 <code>backend-config.json</code> 并发布。发布完成后，其他设备和旧链接会自动使用新服务。</p><div class="flex"><button class="btn-sm" id="download-route">下载统一连接配置</button><button class="btn-sm" id="use-migrated">在本机使用新连接</button></div>`;
    $('#download-route').onclick=()=>ShortlinkPortability.downloadRegistry(report.registry || ShortlinkPortability.routeRegistry(target,source));
    $('#use-migrated').onclick=()=>{localStorage.setItem('sb_url',target.url);localStorage.setItem('sb_anon_key',target.key);localStorage.setItem('sb_namespace',target.ns || namespace);location.href=location.pathname+'?page=settings';};
  };
  async function run(kind, file) {
    if(running)return;
    let target;
    try {
      target=kind==='backup'?source:connectionValues();
      if(kind==='migrate' && target.url===source.url) throw new Error('请先在上方填写新的 Supabase 地址和公开 Key，再点击迁移');
      controller=new AbortController();setBusy(true);result.hidden=true;status.textContent='准备中…';
      const options={onProgress:progress,signal:controller.signal,registry:source.registry};
      if(kind==='backup') {
        const report=await ShortlinkPortability.exportBackup(source,options);
        status.textContent=`完整备份已生成：${report.rows} 条内容、${report.assets} 个文件。请妥善保存 .slbackup 文件。`;
      } else {
        const report=kind==='restore'?await ShortlinkPortability.importBackup(file,target,options):await ShortlinkPortability.migrate(source,target,options);
        if (report.verified) { status.textContent='数据复制与校验已完成；统一连接配置等待发布。'; showRoute(target,report); }
        else status.textContent='复制期间源数据有变化。请先保留原连接，暂停编辑后选择空的目标项目重新迁移，避免混入两个版本的数据。';
      }
    } catch(error) {status.textContent=error.name==='AbortError'?'已停止。原服务保留，迁移或恢复可重试。':`操作未完成：${error.message}`;}
    finally {setBusy(false);}
  }
  $('#backup-all').onclick=()=>run('backup');
  $('#migrate-all').onclick=()=>run('migrate');
  $('#restore-backup').onclick=()=>$('#backup-file').click();
  $('#backup-file').onchange=event=>{const file=event.target.files[0];event.target.value='';if(file)run('restore',file);};
  window.addEventListener('beforeunload',event=>{if(running){event.preventDefault();event.returnValue='';}});
}
