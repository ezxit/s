// --- config ---
const GIST_API = 'https://api.github.com/gists';
const DATA_FILE = 'shortlink.json';

// --- state ---
let token = localStorage.getItem('gh_token') || '';
let files = [];

// --- helpers ---
const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);
const esc = s => s.replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]);

// --- SVG icons (Lucide-style, stroke-based) ---
const Icons = {
  link: `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`,
  plus: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`,
  image: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`,
  check: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
  copy: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`,
  list: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>`,
  settings: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
  trash: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`,
  externalLink: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`,
  arrowLeft: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>`,
  folder: `<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`,
  file: `<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>`,
  shield: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`,
  key: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>`,
  alert: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`,
};

function toast(msg, icon) {
  let t = $('.toast');
  if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.appendChild(t); }
  const iconHtml = icon ? `<span style="display:inline-flex;vertical-align:middle;margin-right:6px">${icon}</span>` : '';
  t.innerHTML = iconHtml + esc(msg);
  t.classList.add('show');
  clearTimeout(t._tid);
  t._tid = setTimeout(() => t.classList.remove('show'), 3000);
}

async function api(method, url, body) {
  const headers = { 'Accept': 'application/vnd.github+json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const opts = { method, headers };
  if (body) {
    headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  if (!res.ok) {
    const text = await res.text();
    let msg;
    try {
      const j = JSON.parse(text);
      msg = j.message || `请求失败 (${res.status})`;
    } catch {
      msg = `请求失败 (${res.status})`;
    }
    throw new Error(msg);
  }
  return res.json();
}

// --- image compression ---
function compressImage(file) {
  return new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = e => {
      const img = new Image();
      img.onload = () => {
        const MAX = 1600;
        let { width, height } = img;
        if (width > MAX || height > MAX) {
          const ratio = Math.min(MAX / width, MAX / height);
          width = Math.round(width * ratio);
          height = Math.round(height * ratio);
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', 0.8));
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

// --- render ---
function render() {
  const params = new URLSearchParams(location.search);
  const sid = params.get('s');
  const user = params.get('user');

  if (sid) return renderView(sid);
  if (user) return renderList(user);
  if (!token) return renderSetup();
  return renderHome();
}

// -- setup page --
function renderSetup() {
  app.innerHTML = `
    <div class="card setup fade-in">
      <div class="logo">${Icons.link}<span>shortlink</span></div>
      <h2>设置 GitHub Token</h2>
      <p>需要一个 <code>gist</code> 权限的 token 来创建短链接。<br>
      去 <a class="link" href="https://github.com/settings/tokens/new?scopes=gist&description=shortlink" target="_blank" rel="noopener">GitHub Settings &rarr; Tokens ${Icons.externalLink}</a> 创建一个，粘贴到下面。</p>
      <label class="input-label" for="token-input">Personal Access Token</label>
      <input id="token-input" type="password" placeholder="github_pat_xxxxxxxxxxxxxxxxxxxx" autocomplete="off" aria-describedby="token-hint">
      <p class="dim spacer-sm" id="token-hint" style="display:flex;align-items:center;gap:6px">${Icons.shield} Token 只存在你浏览器里，不会上传到任何地方。</p>
      <button class="btn btn-primary spacer" id="save-token" style="width:100%">
        ${Icons.key} 保存 Token
      </button>
    </div>
  `;
  $('#save-token').onclick = () => {
    token = $('#token-input').value.trim();
    if (token.length < 10) {
      return toast('Token 太短了，检查一下是否粘贴完整', Icons.alert);
    }
    localStorage.setItem('gh_token', token);
    toast('保存成功', Icons.check);
    setTimeout(() => render(), 400);
  };
}

// -- home page --
function renderHome() {
  app.innerHTML = `
    <div class="logo">${Icons.link}<span>shortlink</span></div>
    <div class="card fade-in">
      <label class="input-label" for="text-input">内容</label>
      <textarea id="text-input" placeholder="写点什么..."></textarea>
      <div class="flex spacer-sm">
        <label class="file-label" for="file-input" tabindex="0" aria-label="添加图片">
          ${Icons.image} 添加图片
        </label>
        <input type="file" id="file-input" accept="image/*" multiple hidden>
        <span class="muted" id="img-count"></span>
      </div>
      <div class="previews" id="previews"></div>
      <button class="btn btn-primary spacer" id="create-btn" style="width:100%">
        ${Icons.link} 创建短链接
      </button>
      <div class="result spacer" id="result">
        <div class="success-text">${Icons.check} 创建成功</div>
        <a class="result-url" id="result-url" href="" target="_blank" rel="noopener"></a>
        <div class="flex spacer-sm">
          <button class="btn-sm" id="copy-btn" aria-label="复制链接">${Icons.copy} 复制</button>
          <button class="btn-sm" id="new-btn">${Icons.plus} 再创建一个</button>
        </div>
      </div>
    </div>
    <div class="bg-actions">
      <button class="btn btn-ghost" id="list-btn">
        ${Icons.list} 我的短链接
      </button>
      <button class="btn btn-ghost" id="reset-token-btn" aria-label="重置 Token">
        ${Icons.settings} 重置 Token
      </button>
    </div>
  `;
  files = [];
  renderPreviews();
  bindHomeEvents();
}

function bindHomeEvents() {
  const fi = $('#file-input');
  fi.onchange = () => {
    files.push(...fi.files);
    fi.value = '';
    renderPreviews();
  };

  $('#create-btn').onclick = createShortlink;
  $('#list-btn').onclick = () => {
    if (token) {
      fetch('https://api.github.com/user', { headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github+json' } })
        .then(r => r.json())
        .then(u => { location.search = '?user=' + u.login; })
        .catch(() => toast('获取用户信息失败', Icons.alert));
    }
  };
  $('#reset-token-btn').onclick = () => { localStorage.removeItem('gh_token'); token = ''; render(); };
}

function renderPreviews() {
  const container = $('#previews');
  if (!container) return;
  container.innerHTML = '';
  const imgCount = $('#img-count');
  if (imgCount) imgCount.textContent = files.length ? `${files.length} 张` : '';

  files.forEach((f, i) => {
    const r = new FileReader();
    r.onload = e => {
      const wrap = document.createElement('div');
      wrap.className = 'wrap';
      wrap.setAttribute('tabindex', '0');
      wrap.setAttribute('aria-label', `图片 ${i + 1}，点击删除`);
      wrap.innerHTML = `<img src="${e.target.result}" alt="预览图片 ${i + 1}"><button class="del" aria-label="删除图片">&times;</button>`;
      wrap.querySelector('.del').onclick = ev => {
        ev.stopPropagation();
        files.splice(i, 1);
        renderPreviews();
      };
      wrap.onclick = () => {
        files.splice(i, 1);
        renderPreviews();
      };
      container.appendChild(wrap);
    };
    r.readAsDataURL(f);
  });
}

async function createShortlink() {
  const btn = $('#create-btn');
  const origHTML = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span> 创建中...`;
  $('#result').style.display = 'none';

  try {
    const text = $('#text-input').value.trim();
    if (!text && !files.length) {
      btn.disabled = false;
      btn.innerHTML = origHTML;
      return toast('至少写点文字或传张图片', Icons.alert);
    }
    const images = await Promise.all(files.map(compressImage));

    const data = { text, images, created: new Date().toISOString() };
    const preview = text ? text.slice(0, 60).replace(/\n/g, ' ') : (images.length ? `[${images.length} images]` : '');

    const gist = await api('POST', GIST_API, {
      description: `[sl] ${preview}`,
      public: true,
      files: { [DATA_FILE]: { content: JSON.stringify(data) } }
    });

    const url = `${location.origin}${location.pathname}?s=${gist.id}`;
    $('#result-url').href = url;
    $('#result-url').textContent = url;
    $('#result').style.display = 'block';
    $('#text-input').value = '';
    files = [];
    renderPreviews();

    $('#copy-btn').onclick = () => { navigator.clipboard.writeText(url); toast('已复制', Icons.check); };
    $('#new-btn').onclick = () => { $('#result').style.display = 'none'; };
  } catch (err) {
    toast(err.message, Icons.alert);
    console.error(err);
  }
  btn.disabled = false;
  btn.innerHTML = origHTML;
}

// -- view page --
function skeletonView() {
  return `
    <div class="card fade-in">
      <div class="skeleton skeleton-text" style="width:50%;height:14px"></div>
      <div class="skeleton skeleton-text" style="width:30%;height:14px;margin-bottom:16px"></div>
      <div class="skeleton skeleton-block"></div>
    </div>
  `;
}

async function renderView(gistId) {
  app.innerHTML = skeletonView();

  try {
    const gist = await api('GET', `${GIST_API}/${gistId}`);
    const file = gist.files?.[DATA_FILE];
    if (!file) return (app.innerHTML = `
      <div class="card fade-in">
        <div class="empty-state">
          ${Icons.file}
          <p>内容不存在</p>
          <a class="btn btn-secondary" href=".">${Icons.arrowLeft} 返回</a>
        </div>
      </div>`);

    const data = JSON.parse(file.content);
    const date = data.created ? data.created.slice(0, 16).replace('T', ' ') : '';

    let html = `
      <div class="card fade-in">
      <div class="view-meta">
        ${Icons.link}
        <span>s/</span><span class="gist-id">${esc(gistId)}</span>
        <span>&middot;</span>
        <span>${esc(date)}</span>
      </div>
    `;

    if (data.text) {
      html += `<div class="view-text">${esc(data.text)}</div>`;
    }

    if (data.images?.length) {
      html += `<div class="view-images">`;
      data.images.forEach((img, i) => {
        html += `<a href="${img}" target="_blank" rel="noopener" aria-label="查看原图 ${i + 1}"><img src="${img}" alt="图片 ${i + 1}" loading="lazy"></a>`;
      });
      html += `</div>`;
    }

    if (!data.text && !data.images?.length) {
      html += `<div class="empty-state"><p class="muted">没有内容</p></div>`;
    }

    html += `<div class="spacer view-actions">`;
    html += `<a class="btn btn-secondary btn-sm" href=".">${Icons.arrowLeft} 创建新的</a>`;
    if (token) {
      html += `<button class="btn btn-danger btn-sm" id="delete-link" aria-label="删除此短链接">${Icons.trash} 删除</button>`;
    }
    html += `</div></div>`;

    app.innerHTML = html;

    const del = $('#delete-link');
    if (del) {
      del.onclick = async e => {
        e.preventDefault();
        if (!confirm('确定删除这个短链接？')) return;
        try {
          await api('DELETE', `${GIST_API}/${gistId}`);
          toast('已删除', Icons.check);
          setTimeout(() => { location.href = '.'; }, 500);
        } catch (err) { toast(err.message, Icons.alert); }
      };
    }
  } catch (err) {
    app.innerHTML = `
      <div class="card fade-in">
        <div class="empty-state">
          ${Icons.alert}
          <p>${esc(err.message)}</p>
          <a class="btn btn-secondary" href=".">${Icons.arrowLeft} 返回</a>
        </div>
      </div>`;
  }
}

// -- list page --
function skeletonList() {
  return `
    <div class="card fade-in" style="padding-top:20px">
      ${Array.from({length: 5}, () => `
        <div style="display:flex;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid var(--color-border)">
          <div class="skeleton" style="width:80px;height:12px;border-radius:4px"></div>
          <div class="skeleton" style="flex:1;height:12px;border-radius:4px"></div>
          <div class="skeleton" style="width:48px;height:12px;border-radius:4px"></div>
        </div>
      `).join('')}
    </div>
  `;
}

async function renderList(username) {
  app.innerHTML = `
    <div class="logo">${Icons.link}<span>${esc(username)} 的短链接</span></div>
    ${skeletonList()}
  `;

  try {
    const gists = await api('GET', `https://api.github.com/users/${username}/gists?per_page=100`);
    const items = gists.filter(g => g.files?.[DATA_FILE]);

    if (!items.length) {
      app.innerHTML = `
        <div class="logo">${Icons.link}<span>${esc(username)} 的短链接</span></div>
        <div class="card fade-in">
          <div class="empty-state">
            ${Icons.folder}
            <p>还没有创建过短链接</p>
            <a class="btn btn-secondary" href=".">${Icons.arrowLeft} 创建新的</a>
          </div>
        </div>`;
      return;
    }

    let html = `
      <div class="logo">${Icons.link}<span>${esc(username)} 的短链接</span></div>
      <div class="card fade-in">
      <ul class="shortlist">`;
    items.forEach(g => {
      const desc = (g.description || '').replace(/^\[sl\]\s*/, '');
      const preview = desc || '(空)';
      const date = g.created_at ? g.created_at.slice(0, 10) : '';
      html += `
        <li>
          <span class="code">${esc(g.id).slice(0, 8)}</span>
          <div class="shortlist-info">
            <span class="preview-text">${esc(preview)}</span>
            <span class="date">${esc(date)}</span>
          </div>
          <a class="btn-sm" href="?s=${esc(g.id)}" style="text-decoration:none;flex-shrink:0">查看 ${Icons.externalLink}</a>
        </li>`;
    });
    html += `</ul>`;
    html += `<div class="spacer"><a class="link" href=".">${Icons.arrowLeft} 创建新的</a></div></div>`;

    app.innerHTML = html;
  } catch (err) {
    app.innerHTML = `
      <div class="card fade-in">
        <div class="empty-state">
          ${Icons.alert}
          <p>${esc(err.message)}</p>
          <a class="btn btn-secondary" href=".">${Icons.arrowLeft} 返回</a>
        </div>
      </div>`;
  }
}

// --- init ---
render();
