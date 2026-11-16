# CF-Ghproxy · GitHub 文件加速代理

基于 Cloudflare Workers 的 GitHub 加速代理：把 GitHub 的仓库包、release 附件、raw 文件、API 请求套一层 Worker 域名，国内可直连。

单文件 module 语法 Worker（`worker.js`），无构建、无依赖。

## 用法

把原始地址放在 Worker 域名之后即可：

```bash
# 仓库源码包
https://gh.example.com/https://github.com/KuwiNet/CF-Ghproxy/archive/refs/heads/main.zip

# release 附件
https://gh.example.com/https://github.com/KuwiNet/ZWRT/releases/download/<tag>/<file>

# raw 文件（/blob/ 会自动转 /raw/）
https://gh.example.com/https://github.com/KuwiNet/CF-Ghproxy/blob/main/readme.md
https://gh.example.com/https://raw.githubusercontent.com/KuwiNet/CF-Ghproxy/main/readme.md

# API（Authorization 会透传，分页 Link 头会被改写回本代理）
https://gh.example.com/https://api.github.com/repos/KuwiNet/CF-Ghproxy

# 也支持短写法（自动补 github.com 前缀）
https://gh.example.com/KuwiNet/CF-Ghproxy/archive/refs/heads/main.zip

# 一次性跳转写法
https://gh.example.com/?q=https://github.com/KuwiNet/CF-Ghproxy/archive/refs/heads/main.zip

# 命令行
git clone https://gh.example.com/https://github.com/KuwiNet/ZWRT.git
curl -LO https://gh.example.com/https://github.com/KuwiNet/ZWRT/releases/download/<tag>/<file>
```

## 支持的目标

| 路径 | 处理方式 |
| --- | --- |
| `github.com/*/*/archive/*`、`github.com/*/*/releases/*` | Worker 内部跟随 302 到 codeload / release-assets 并流式回传 |
| `github.com/*/*/raw/*`、`github.com/*/*/blob/*` | blob 自动转 raw；可切换 jsDelivr |
| `raw.githubusercontent.com`、`gist.githubusercontent.com` | 流式回传 |
| `codeload.github.com`、`objects.githubusercontent.com`、`release-assets.githubusercontent.com` | 流式回传 |
| `api.github.com` | 透传，`Link` 分页头改写回本代理 |
| `github.com/*/*` 其他页面 | 原样转发（含 302） |
| 其他路径 | 回退到 `ASSET_URL` 静态站点（首页） |

`Range` / `If-Range` / `If-None-Match` 会被透传，断点续传与浏览器缓存都能正常工作。

## 部署

```bash
npm i -g wrangler
wrangler login
wrangler deploy          # 读取仓库里的 wrangler.toml
```

绑定自定义域名：`Workers & Pages → 你的 Worker → Settings → Domains & Routes → Add Custom Domain`，
或用 `wrangler.toml` 里的 `routes`。

控制台方式：新建 Worker，把 `worker.js` 全文粘贴进去，Deploy。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PREFIX` | `/` | 路由前缀。挂在 `example.com/gh/*` 时设为 `/gh/` |
| `PUBLIC_HOST` | 空 | 对外域名（如 `arelay.cn`）。前面挂 EdgeOne / 其它 CDN 时填，`301` 跳转与 API `Link` 分页头都会改写成它，不再把回源域名暴露给客户端；留空则用回源 Host |
| `ASSET_URL` | `https://kuwinet.github.io/CF-Ghproxy/` | 未匹配路径回退的静态站点 |
| `WHITELIST` | 空 | 白名单，逗号分隔；非空时路径必须命中其中片段 |
| `JSDELIVR` | `0` | `1` 时 `/blob/` 请求改为跳转 jsDelivr CDN |
| `MAX_REDIRECT` | `5` | 内部跟随重定向的最大跳数 |

## 自检

```bash
python3 test/smoke.py https://gh.example.com
```

覆盖：源码包下载（zip 完整性 + content-length）、raw 文件、`/blob/` 转 raw、API 对象响应、API 分页 Link 改写、
`Range 206`、`HEAD`、release 附件下载（校验字节数与 `content-disposition`）、首页回退、`?q=` 跳转、OPTIONS 预检。

## 常见问题

- **`Error 526: Invalid SSL certificate`**：域名没有由 Worker 提供，Cloudflare 回源到了证书无效的源站。
  在 `Domains & Routes` 里绑 Custom Domain，并确认没有冲突的 DNS 记录。
- **下载大文件中断**：`wrangler.toml` 里已开启 `observability`，可在 `Workers Logs` 里看 CPU/时长；
  免费版单请求有 CPU 限制，持续大流量建议把 `ASSET_URL` 静态托管与 Worker 分开或升级套餐。
- **`api.github.com` 403**：GitHub API 未认证时限额很低。请求里带 `Authorization: Bearer <token>` 会被透传，
  也可以用 `wrangler secret put` 注入固定 token（需要自行在代码里读取环境变量）。
- **私有仓库**：`Authorization` 头会透传，`git clone` 走 401 后由客户端带凭据重试即可。

## 版本

- `2.1.0` — 新增 `PUBLIC_HOST`：前置 EdgeOne / CDN 时 `301` 与 API `Link` 头改写为对外域名，`/_health` 回显 `base`。
- `2.0.0` — module 语法；下载类请求内部跟随重定向；修复 API 分页导致 502；路径解析重写；统一错误与 CORS。
- `1.0` — 初版（gh-proxy 模板）。

## 许可

MIT，见 [LICENSE](LICENSE)。
