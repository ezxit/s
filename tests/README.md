# 验证方式

应用为静态站点，运行时无需 npm 依赖。以下测试只访问模拟后端或本地 PostgreSQL，不写线上数据。

从项目根目录运行模块测试：

```powershell
node --test tests/data.test.cjs tests/transfers.test.cjs tests/portability.test.cjs
```

SQL 使用 PGlite（PostgreSQL WASM）及真正的 pg_trgm 扩展执行。测试依赖放在被 Git 忽略的 output 中：

```powershell
npm.cmd install --prefix output/data-qa --no-save @electric-sql/pglite@0.5.10
node tests/sql-migration.cjs
```

浏览器测试使用 Playwright CLI。先在本项目启动静态服务：

```powershell
python -m http.server 4176 --bind 127.0.0.1
```

另一个终端运行：

```powershell
npx.cmd --yes --package @playwright/cli playwright-cli -s=shortlink-qa open http://127.0.0.1:4176/
npx.cmd --yes --package @playwright/cli playwright-cli -s=shortlink-qa run-code --filename=tests/drafts-browser.js
npx.cmd --yes --package @playwright/cli playwright-cli -s=shortlink-qa run-code --filename=tests/workspace-browser.js
npx.cmd --yes --package @playwright/cli playwright-cli -s=shortlink-qa eval "window.__workspaceQA"
npx.cmd --yes --package @playwright/cli playwright-cli -s=shortlink-qa run-code --filename=tests/workspace-edge-browser.js
npx.cmd --yes --package @playwright/cli playwright-cli -s=shortlink-qa eval "window.__workspaceEdgeQA"
npx.cmd --yes --package @playwright/cli playwright-cli -s=shortlink-qa run-code --filename=tests/workspace-segment-browser.js
npx.cmd --yes --package @playwright/cli playwright-cli -s=shortlink-qa eval "window.__workspaceSegmentQA"
npx.cmd --yes --package @playwright/cli playwright-cli -s=shortlink-qa close
```

workspace 测试截获所有 Supabase 请求，覆盖原图字节、草稿刷新、上传暂停与续传、编辑响应丢失、跨页搜索、回收站撤销和清理重试；截图写到 output/playwright。CLI 在对话框出现时可能提前返回，测试会自行确认模拟删除，随后读取 window.__workspaceQA 的完成结果。

SQL 测试使用单连接，覆盖两个客户端交错操作及清理回执；真实多连接事务的并发性能仍取决于部署环境。200 MiB 测试在模拟传输/本地 Blob 上验证边界与备份格式，实际对象分片为 32 MiB，适配 Supabase 免费套餐的 50 MB 单对象上限。
