import re

with open('js/app.js', 'r', encoding='utf-8') as f:
    content = f.read()

# 1. renderView -> renderViewFromApi in render()
content = content.replace(
    'if (sid) return renderView(sid);',
    'if (sid) return renderViewFromApi(sid);'
)

# 2. createShortlink success block
old_create = '''    const url = `${location.origin}${location.pathname}?s=${gist.id}`;
    $('#result-url').href = url;
    $('#result-url').textContent = url;
    $('#result').style.display = 'block';
    $('#text-input').value = '';
    files = [];
    renderPreviews();

    $('#copy-btn').onclick = () => { navigator.clipboard.writeText(url); toast('已复制', Icons.check); };
    $('#new-btn').onclick = () => { $('#result').style.display = 'none'; };'''

new_create = '''    const url = `${location.origin}${location.pathname}?s=${gist.id}`;
    // 直接渲染，不经过 API
    window.history.pushState({}, '', url);
    document.title = `shortlink - s/${gist.id}`;
    const insFiles = {};
    insFiles[DATA_FILE] = { content: JSON.stringify({ text, images: imageNames, created: new Date().toISOString() }) };
    imageNames.forEach(n => { insFiles[n] = { raw_url: '' }; });
    renderViewContent({ id: gist.id, files: insFiles, owner: { login: '' } }, url);'''

assert old_create in content, 'old_create not found!'
content = content.replace(old_create, new_create)
print('Success: createShortlink block replaced')

# 3. Replace async function renderView with renderViewFromApi + renderViewContent
old_render = '''async function renderView(gistId) {
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

    const data = JSON.parse(file.content);'''

new_render = '''async function renderViewFromApi(gistId) {
  app.innerHTML = skeletonView();
  try {
    const gist = await api('GET', `${GIST_API}/${gistId}`);
    renderViewContent(gist, `${location.origin}${location.pathname}?s=${gistId}`);
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

function renderViewContent(gist, url) {
  const gistId = gist.id;
  const file = gist.files?.[DATA_FILE];
  if (!file) {
    app.innerHTML = `
      <div class="card fade-in">
        <div class="empty-state">
          ${Icons.file}
          <p>内容不存在</p>
          <a class="btn btn-secondary" href=".">${Icons.arrowLeft} 返回</a>
        </div>
      </div>`;
    return;
  }
  const data = JSON.parse(file.content);'''

assert old_render in content, 'old_render not found!'
content = content.replace(old_render, new_render)
print('Success: renderView split')

# 4. Fix the trailing try/catch + renderViewMode()
old_tail = '''    renderViewMode();
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

// -- list page --'''

new_tail = '''    renderViewMode();
  }
}

// -- list page --'''

assert old_tail in content, 'old_tail not found!'
content = content.replace(old_tail, new_tail)
print('Success: trailing try/catch removed')

with open('js/app.js', 'w', encoding='utf-8') as f:
    f.write(content)

print('All done!')
