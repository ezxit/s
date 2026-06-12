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

function toast(msg) {
  let t = $('.toast');
  if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.appendChild(t); }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._tid);
  t._tid = setTimeout(() => t.classList.remove('show'), 2000);
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
    <div class="card setup">
      <div class="logo">🔗 shortlink</div>
      <h2>设置 GitHub Token</h2>
      <p>需要一个 <code>gist</code> 权限的 token 来创建短链接。<br>
      去 <a class="link" href="https://github.com/settings/tokens/new?scopes=gist&description=shortlink" target="_blank">GitHub &rarr; Settings &rarr; Tokens</a> 创建一个，粘贴到下面。</p>
      <input id="token-input" type="password" placeholder="github_pat_xxxxxxxxxxxxxxxxxxxx" style="margin-bottom:12px">
      <button class="btn btn-primary" id="save-token" style="width:100%">保存</button>
      <p class="muted spacer-sm" style="font-size:0.8rem">Token 只存在你浏览器里，不会上传到任何地方。</p>
    </div>
  `;
  $('#save-token').onclick = () => {
    token = $('#token-input').value.trim();
    if (token.length < 10) {
      return toast('Token 太短了，检查一下是否粘贴完整');
    }
    localStorage.setItem('gh_token', token);
    toast('保存成功 ✨');
    render();
  };
}

// -- home page --
const homeHTML = `
  <div class="logo">🔗 shortlink</div>
  <div class="card">
    <textarea id="text-input" placeholder="写点什么..."></textarea>
    <div class="flex spacer-sm">
      <label class="file-label" for="file-input">+ 图片</label>
      <input type="file" id="file-input" accept="image/*" multiple hidden>
      <span class="muted" id="img-count"></span>
    </div>
    <div class="previews" id="previews"></div>
    <button class="btn btn-primary spacer" id="create-btn" style="width:100%">创建短链接</button>
    <div class="result spacer" id="result">
      <span class="muted">创建成功 ✨</span><br>
      <a class="result-url" id="result-url" href="" target="_blank"></a>
      <div class="flex spacer-sm">
        <button class="btn-sm" id="copy-btn">复制</button>
        <button class="btn-sm" id="new-btn">再创建一个</button>
      </div>
    </div>
  </div>
  <div class="flex spacer" style="justify-content:space-between">
    <button class="btn-sm" id="list-btn">📋 我的短链接</button>
    <button class="btn-sm" id="reset-token-btn">⚙️ 重置 Token</button>
  </div>
`;

function renderHome() {
  app.innerHTML = homeHTML;
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
        .catch(() => toast('获取用户信息失败'));
    }
  };
  $('#reset-token-btn').onclick = () => { localStorage.removeItem('gh_token'); token = ''; render(); };
}

function renderPreviews() {
  const container = $('#previews');
  if (!container) return;
  container.innerHTML = '';
  $('#img-count').textContent = files.length ? `${files.length} 张` : '';

  files.forEach((f, i) => {
    const r = new FileReader();
    r.onload = e => {
      const wrap = document.createElement('div');
      wrap.className = 'wrap';
      wrap.innerHTML = `<img src="${e.target.result}"><div class="del">&times;</div>`;
      wrap.querySelector('.del').onclick = ev => { ev.stopPropagation(); files.splice(i, 1); renderPreviews(); };
      container.appendChild(wrap);
    };
    r.readAsDataURL(f);
  });
}

async function createShortlink() {
  const btn = $('#create-btn');
  btn.disabled = true;
  btn.textContent = '创建中...';
  $('#result').style.display = 'none';

  try {
    const text = $('#text-input').value.trim();
    if (!text && !files.length) {
      btn.disabled = false;
      btn.textContent = '创建短链接';
      return toast('至少写点文字或传张图片');
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

    $('#copy-btn').onclick = () => { navigator.clipboard.writeText(url); toast('已复制 📋'); };
    $('#new-btn').onclick = () => { $('#result').style.display = 'none'; };
  } catch (err) {
    toast(err.message);
    console.error(err);
  }
  btn.disabled = false;
  btn.textContent = '创建短链接';
}

// -- view page --
async function renderView(gistId) {
  app.innerHTML = `<div class="card"><div class="muted">加载中...</div></div>`;

  try {
    const gist = await api('GET', `${GIST_API}/${gistId}`);
    const file = gist.files?.[DATA_FILE];
    if (!file) return (app.innerHTML = `<div class="card"><p>内容不存在</p><a class="link" href=".">&larr; 返回</a></div>`);

    const data = JSON.parse(file.content);
    const date = data.created ? data.created.slice(0, 16) : '';

    let html = `
      <div class="card">
      <div class="view-meta">🔗 s/<strong>${esc(gistId)}</strong> &middot; ${esc(date)}</div>
    `;

    if (data.text) {
      html += `<div class="view-text">${esc(data.text)}</div>`;
    }

    if (data.images?.length) {
      html += `<div class="view-images">`;
      data.images.forEach(img => {
        html += `<a href="${img}" target="_blank"><img src="${img}"></a>`;
      });
      html += `</div>`;
    }

    if (!data.text && !data.images?.length) {
      html += `<p class="muted">没有内容</p>`;
    }

    html += `<div class="spacer"><a class="link" href=".">&larr; 创建新的</a>`;
    if (token) {
      html += ` &middot; <a class="link" href="#" id="delete-link" style="color:var(--danger)">删除</a>`;
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
          toast('已删除');
          location.href = '.';
        } catch (err) { toast(err.message); }
      };
    }
  } catch (err) {
    app.innerHTML = `<div class="card"><p>${esc(err.message)}</p><a class="link spacer" href=".">&larr; 返回</a></div>`;
  }
}

// -- list page --
async function renderList(username) {
  app.innerHTML = `<div class="card"><div class="muted">加载中...</div></div>`;

  try {
    const gists = await api('GET', `https://api.github.com/users/${username}/gists?per_page=100`);
    const items = gists.filter(g => g.files?.[DATA_FILE]);

    let html = `<div class="logo">🔗 ${esc(username)} 的短链接</div><div class="card">`;

    if (!items.length) {
      html += `<p class="muted">还没有创建过短链接</p>`;
    } else {
      html += `<ul class="shortlist">`;
      items.forEach(g => {
        const desc = (g.description || '').replace(/^\[sl\]\s*/, '');
        const preview = desc || '(空)';
        const date = g.created_at ? g.created_at.slice(0, 10) : '';
        html += `
          <li>
            <span class="code">${esc(g.id).slice(0, 8)}</span>
            <span class="preview-text">${esc(preview)} &middot; ${esc(date)}</span>
            <a class="btn-sm" href="?s=${esc(g.id)}" style="text-decoration:none;flex-shrink:0">查看</a>
          </li>`;
      });
      html += `</ul>`;
    }

    html += `<div class="spacer"><a class="link" href=".">&larr; 创建新的</a></div></div>`;

    app.innerHTML = html;
  } catch (err) {
    app.innerHTML = `<div class="card"><p>${esc(err.message)}</p><a class="link spacer" href=".">&larr; 返回</a></div>`;
  }
}

// --- init ---
render();
