/**
 * CF-Ghproxy — GitHub 文件加速代理（Cloudflare Workers，module 语法）
 *
 * 用法：把原始地址放在本 Worker 域名之后即可，例如
 *   https://gh.example.com/KuwiNet/ZWRT/archive/refs/heads/main.zip
 *   https://gh.example.com/https://github.com/KuwiNet/ZWRT/releases/download/v1/x.ipk
 *   https://gh.example.com/https://raw.githubusercontent.com/KuwiNet/ZWRT/main/README.md
 *   https://gh.example.com/https://api.github.com/repos/KuwiNet/ZWRT
 *
 * 相对 v1 的改动：
 *   1. 改为 module 语法（export default fetch），与 wrangler / Workers 新编辑器一致。
 *   2. 下载类请求（archive / releases / raw / codeload / objects）在 Worker 内部跟随重定向，
 *      直接把文件流回客户端，不再让客户端自己去访问 codeload（国内经常连不上）。
 *   3. 去掉错误的 API 分页“合并”逻辑（原实现对返回对象会抛 TypeError 直接 502），
 *      改为透传分页并重写 Link 头，客户端可自行翻页。
 *   4. 修正路径解析：查询串、// 折叠、PREFIX 前缀、https:// 前缀都能正确还原。
 *   5. 统一错误响应（502 JSON + CORS），补全 OPTIONS 预检、HEAD 支持。
 *   6. 配置全部走环境变量：PREFIX / ASSET_URL / WHITELIST / JSDELIVR / PUBLIC_HOST / MAX_REDIRECT。
 *   7. 首页 HTML 内置在 Worker 里（HOME_HTML），不再从 github.io 中转。
 *      静态资源（css / js / 字体 / logo）走 jsDelivr；commit 号集中在 ASSET_COMMIT 一个常量，
 *      以后换版本只改这一行。首页响应头 no-cache，避免浏览器/边缘缓存旧页面。
 *      设 BUILTIN_HOME=0 可回退到原来的 ASSET_URL 拉取行为。
 *   8. 导航高亮块改为纯 CSS（见 css/navbar.css 的 li.active>a 规则），不再靠 JS 测量定位，
 *      JS 没加载、字体没就绪、换分辨率都不会再错位。
 *
 * 环境变量：
 *   PREFIX       路由前缀，默认 "/"。若自定义路由为 example.com/gh/* 则设为 "/gh/"
 *   PUBLIC_HOST  对外域名（前置 EdgeOne 等 CDN 时填，例如 oproxy.cc）。填写后 301 跳转与
 *                API 的 Link 头都改写为对外域名，不再把回源域名暴露给客户端；留空则用回源 Host。
 *   GH_TOKEN     GitHub Personal Access Token（可选，建议只读权限）。客户端未自带 Authorization
 *                时，转发 api.github.com 用它认证，把 60 次/小时的匿名 API 限流提到 5000 次/小时。
 *                只对 api.github.com 注入，下载类请求绝不带它（避免与签名 URL 冲突）。
 *   ASSET_URL    未匹配路径时回退的静态站点地址
 *   BUILTIN_HOME 默认 1；设 0 回退到 ASSET_URL 拉首页
 *   WHITELIST    白名单，逗号分隔；非空时只有路径命中其中片段才放行
 *   JSDELIVR     设为 1 时，/blob/ 请求改为跳转 jsDelivr CDN
 *   MAX_REDIRECT 内部跟随重定向的最大跳数，默认 5
 */

const DEFAULT_PREFIX = '/'
const DEFAULT_ASSET_URL = 'https://kuwinet.github.io/CF-Ghproxy/'

/** 静态资源版本：jsDelivr 固定 commit（换版本只改这一行） */
const ASSET_COMMIT = '2429ac95e6f0379e2d99abfadab658bd82596392'
const ASSET_CDN = 'https://cdn.jsdelivr.net/gh/KuwiNet/kuwinet.github.io@' + ASSET_COMMIT

/** 内置首页（原 git-proxy/index.html），资源引用统一走 ASSET_CDN */
const HOME_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <title>GitHub 文件加速</title>
    <meta charset="UTF-8">
    <link rel="shortcut icon" href="${ASSET_CDN}/favicon.ico">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <!-- Bootstrap CSS -->
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@4.6.1/dist/css/bootstrap.min.css">
    <!-- Custom CSS -->
    <link rel="stylesheet" href="${ASSET_CDN}/git-proxy/style.css">
    <link href="${ASSET_CDN}/css/navbar.css" rel="stylesheet">
    <link href="${ASSET_CDN}/css/basic.css" rel="stylesheet">
<link href="//at.alicdn.com/t/c/font_4892763_skkvi1iofje.css" rel="stylesheet">
</head>
<body>
        <nav class="navbar navbar-expand-custom navbar-mainbg">
            <div class="navbar-content">
                <a class="navbar-brand navbar-logo" href="https://oproxy.cc/"><svg t="1745304037880" class="icon" viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg" p-id="5857" width="50" height="50"><path d="M339.793 1016.03c-46.16-15.87-98.994-44.87-142.51-78.225-18.053-13.838-51.386-45.977-70.906-68.367C68.884 803.493 28.653 715.93 11.08 618.492c-6.546-36.3-8.392-85.44-5.215-138.893 2.386-40.15 9.822-78.348 23.605-121.252 26.773-83.335 65.633-146.52 129.103-209.911 25.66-25.629 40.291-38.062 64.963-55.203C297.894 41.57 384.107 10.914 471.844 4.939c29.365-2 96.737 0.19 122.676 3.988 70.125 10.267 143.666 39.439 204.02 80.928 20.125 13.834 36.147 26.89 58.735 47.863 24.347 22.606 59.561 61.786 57.463 63.933-0.433 0.444-8.4-5.892-17.706-14.08-57.19-50.32-123.372-82.02-192.92-92.405-22.682-3.387-93.133-3.87-110.333-0.756-64.104 11.605-120.225 36.204-170.737 74.837-17.565 13.435-52.85 47.849-68.661 66.968l-7.416 8.968-19.137-8.499c-50.672-22.505-76.641-26.114-85.816-11.925-5.24 8.103-9.418 21.161-11.265 35.209-2.326 17.685-0.918 70.73 2.219 83.629 2.931 12.05 3.988 9.227-14.186 37.899-14.749 23.267-20.88 35.964-24.14 49.99-5.574 23.986-6.453 114.83-1.397 144.496 9.694 56.891 45.05 112.42 88.397 138.835 13.227 8.06 38.05 19.247 58.153 26.208 23.887 8.271 64.422 31.029 64.422 36.168 0 1.163-2.232 7.145-4.959 13.292-2.727 6.148-6.15 14.929-7.608 19.513-6.658 20.95-10.027 23.611-36.722 29.011-20.764 4.2-42.077 3.357-56.275-2.226-19.823-7.796-33.97-19.886-63.288-54.09-23.477-27.389-33.18-36.441-46.24-43.137-21.201-10.868-40.109-10.891-53.616-0.065-2.739 2.195-1.657 3.569 23.014 29.206 26.674 27.72 28.066 29.602 50.185 67.825 27.348 47.26 40.698 59.08 75.55 66.895 10.73 2.406 19.001 2.814 56.012 2.762l43.424-0.06-0.476 49.318c-0.513 53.188-0.613 53.891-9.052 63.336-4.589 5.136-13.525 4.423-34.371-2.744z" fill="currentColor" p-id="5858"></path><path d="M649.11 1017.688l-5.974-4.496-0.983-68.502c-0.54-37.676-0.983-82.782-0.983-100.235v-31.733l-8.145-15.54c-4.48-8.548-8.133-16.492-8.117-17.655 0.032-2.406 30.263-23.06 43.66-29.83 4.887-2.469 15.884-7.036 24.436-10.15 57.902-21.076 97.682-55.272 121.944-104.825 18.188-37.148 29.411-95.574 26.886-139.97-2.66-46.77-11.642-76.357-35.686-117.547-13.913-23.834-13.885-23.707-9.954-45.38 6.237-34.394 0.014-94.547-11.368-109.882-2.66-3.585-3.555-3.782-16.587-3.65-9.328 0.094-17.599 1.225-25.622 3.506-21.472 6.102-58.961 22.782-76.87 34.202-5.779 3.686-13.727 8.158-17.661 9.938-6.999 3.167-7.401 3.183-18.513 0.73-6.247-1.38-22.687-5.489-36.534-9.133-41.793-10.998-48.253-11.94-81.454-11.876-31.904 0.062-47.969 2.039-73.065 8.992-7.604 2.107-14.51 3.598-15.347 3.312-3.24-1.105 33.856-33.266 55.195-47.851 42.338-28.938 97.405-50.042 147.252-56.435 19.404-2.488 69.261-2.094 89.599 0.709 116.293 16.026 218.834 94.388 271.852 207.75 14.503 31.01 25.338 65.448 30.936 98.334 9.534 56 3.04 139.488-16.32 209.804-41.234 149.756-145.846 271.573-285.059 331.941-19.326 8.381-52.737 19.967-57.577 19.967-2.183 0-6.657-2.023-9.942-4.495z" fill="currentColor" p-id="5859"></path><path d="M338.558 624.084c-1.9-1.946-0.865-7.477 15.384-82.144 9.004-41.374 16.415-77.916 16.469-81.203 0.073-4.456-0.753-6.682-3.252-8.753-1.842-1.527-2.867-3.27-2.277-3.875 1.444-1.478 115.787-1.414 117.234 0.066 0.626 0.64-1.317 10.295-4.32 21.454-5.961 22.166-6.527 26.639-3.366 26.639 3.017 0 30.254-12.186 72.416-32.4l36.741-17.615 49.896 0.112c27.442 0.062 52.894 0.631 56.56 1.265l6.664 1.153-84.045 42.655c-65.889 33.44-84.046 43.263-84.046 45.467 0 3.203 8.645 8.377 74.049 44.314 50.372 27.678 71.28 39.866 71.595 41.736 0.135 0.807-24.03 1.547-58.083 1.778l-58.316 0.397-40.91-24.075c-44.217-26.022-58.053-33.554-61.637-33.554-2.807 0-3.616 2.124-11.451 30.045-3.414 12.167-7.4 23.343-8.859 24.835-2.434 2.492-6.44 2.713-49.054 2.713-25.523 0-46.849-0.454-47.392-1.01z" fill="currentColor" p-id="5860"></path></svg><span class="text">oproxy.cc</span></a>
                <button class="navbar-toggler" type="button" data-toggle="collapse" data-target="#navbarSupportedContent" aria-controls="navbarSupportedContent" aria-expanded="false" aria-label="Toggle navigation">
                    <span class="iconfont">&#xe63c;</span>
                </button>
                <div class="collapse navbar-collapse" id="navbarSupportedContent">
                    <ul class="navbar-nav ml-auto">
                        <div class="hori-selector">
                            <div class="left"></div>
                            <div class="right"></div>
                        </div>
                        <li class="nav-item active">
                            <a class="nav-link" href="https://oproxy.cc/"><span class="iconfont icon-github"></span> Github 加速</a>
                        </li>
                        <li class="nav-item">
                            <a class="nav-link" href="https://docker.oproxy.cc/"><span class="iconfont icon-docker"></span> Docker 搜索</a>
                        </li>
                        <li class="nav-item">
                            <a class="nav-link" href="https://kuwi.net/" target="_blank"><span class="iconfont icon-KuWi"></span> KuWi</a>
                        </li>
                        <li class="nav-item">
                            <a class="nav-link" href="https://www.afrp.net/" target="_blank"><span class="iconfont icon-a"></span> AFRP内网穿透</a>
                        </li>
                    </ul>
                </div>
            </div>
        </nav>

<div class="container">

    <form onsubmit="toSubmit(event)" class="search-container">
        <input 
            type="text" 
            class="search-input"
            name="q" 
            placeholder="请输入 GitHub 链接"
            required
        >
        <button type="submit" class="search-button">
            <span class="iconfont">&#xe664;</span>
        </button>
    </form>

    <div id="result" class="result" style="display: none;">
        <div id="cb-note" style="display: none; margin: 0 0 12px; padding: 0 2px; font-size: 14px; line-height: 1.6; opacity: 0.85;"></div>
        <div class="cb">
            <div class="cb-head">
                <span class="cb-title">加速链接</span>
                <button type="button" class="cb-copy" onclick="openBlock('url')" title="在浏览器打开" style="margin-right: 4px;"><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M14 3h7v7h-3V7.6L10.6 14.9l-1.4-1.4L16.4 6H14V3zM5 5h6v3H8v9h9v-3h3v6H5V5z" fill="currentColor"></path></svg></button>
                <button type="button" class="cb-copy" onclick="copyBlock('url', this)" title="复制链接">
                    <span class="iconfont">&#xe60f;</span>
                </button>
            </div>
            <code class="cb-code" id="code-url"></code>
        </div>
        <div class="cb">
            <div class="cb-head">
                <span class="cb-title" id="cb-title-wget">wget 下载</span>
                <button type="button" class="cb-copy" onclick="copyBlock('wget', this)" title="复制 wget 命令">
                    <span class="iconfont">&#xe60f;</span>
                </button>
            </div>
            <code class="cb-code" id="code-wget"></code>
        </div>
        <div class="cb">
            <div class="cb-head">
                <span class="cb-title" id="cb-title-curl">curl 下载</span>
                <button type="button" class="cb-copy" onclick="copyBlock('curl', this)" title="复制 curl 命令">
                    <span class="iconfont">&#xe60f;</span>
                </button>
            </div>
            <code class="cb-code" id="code-curl"></code>
        </div>
    </div>

    <div class="tips">
        <p><span class="iconfont">&#xe763;</span> 链接支持带协议头（https://）或不带；也支持 owner/repo、owner/repo/issues、owner/repo/actions 等任意子页面简写。仓库地址第一条是浏览用页面（不带 .git），clone 命令自带 .git</p>
        <p><span class="iconfont">&#xe610;</span> 支持的域名：</p>
        <ul class="domain-list">
            <li><span class="iconfont">&#xe6af;</span> github.com &nbsp;&nbsp;<span class="iconfont">&#xe6af;</span> raw.githubusercontent.com</li>
            <li><span class="iconfont">&#xe6af;</span> gist.githubusercontent.com &nbsp;&nbsp;<span class="iconfont">&#xe6af;</span> api.github.com</li>
            <li><span class="iconfont">&#xe6af;</span> codeload.github.com &nbsp;&nbsp;<span class="iconfont">&#xe6af;</span> objects.githubusercontent.com</li>
            <li><span class="iconfont">&#xe6af;</span> release-assets.githubusercontent.com &nbsp;&nbsp;<span class="iconfont">&#xe6af;</span> media.githubusercontent.com（LFS 直链）</li>
        </ul>
        <p><span class="iconfont">&#xe6ca;</span> Git 克隆：git clone https://oproxy.cc/github.com/user/project.git（仅 HTTPS 克隆/拉取）</p>
        <p><span class="iconfont">&#xe618;</span> 大文件可断点续传：同一地址加 wget -c 或 curl -C -</p>
        <p><span class="iconfont">&#xe67c;</span> Release、Archive 使用 CF 加速，文件会跳转至 JsDelivr</p>
        <p><span class="iconfont">&#xed1a;</span> 不支持：SSH 克隆、git push、私有仓库、文件夹直下；LFS 文件仅直链可下</p>
    </div>

    <div class="example">
        <div class="example-title"><span class="iconfont">&#xe72a;</span>️️ 输入示例：</div>
        <p><span class="iconfont">&#xe655;</span>️️️ 分支源码：https://github.com/user/repo/archive/main.zip</p>
        <p><span class="iconfont">&#xe616;</span>️️️ 版本发布：https://github.com/user/repo/releases/download/v1.0.0/app.zip</p>
        <p><span class="iconfont">&#xe600;</span>️️ 原始文件：https://raw.githubusercontent.com/user/repo/main/file.txt</p>
        <p><span class="iconfont">&#xe6ca;</span>️️ Git克隆：https://github.com/user/project.git</p>
        <p><span class="iconfont">&#xe617;</span>️️️ Gist文件：https://gist.githubusercontent.com/user/gist_id/raw/file.txt</p>
        <p><span class="iconfont">&#xe71c;</span>️️ Api：https://api.github.com/repos/fatedier/frp/releases/latest</p>
    </div>

    <div class="example">
        <div class="example-title"><span class="iconfont">&#xe824;</span>️️️ 基本使用示例：</div>
        <p><span class="iconfont">&#xe6ca;</span>️️ Git克隆：git clone https://oproxy.cc/github.com/user/project.git</p>
        <p><span class="iconfont">&#xe618;</span>️️ 文件下载：wget https://oproxy.cc/raw.githubusercontent.com/user/repo/main/file.txt</p>
        <p><span class="iconfont">&#xe616;</span>️️️ 版本发布：curl -LO https://oproxy.cc/github.com/user/project/project.sh</p>
        <p><span class="iconfont">&#xe618;</span>️️ 断点续传：wget -c https://oproxy.cc/github.com/user/project/archive/refs/heads/main.zip</p>
    </div>
    
    <p style="position: sticky;top: calc(100% - 2.5em);">
        <br><br>
        Support by <a href="https://kuwi.net/" target="_blank"><span class="iconfont icon-KuWi"></span> KuWi</a> ,  Run on <a href="https://workers.cloudflare.com/" target="_blank"><span class="iconfont">&#xebf2;</span> Cloudflare Workers</a> . Fonts made from <a href="http://www.onlinewebfonts.com" target="_blank">Web Fonts</a> is licensed by CC BY 4.0
    </p>
</div>
    <div id="notification" class="notification">
    </div>
<!-- jQuery -->
<script src="https://cdn.jsdelivr.net/npm/jquery@3.4.1/dist/jquery.min.js"></script>
<!-- Popper.js -->
<script src="https://cdn.jsdelivr.net/npm/popper.js@1.16.1/dist/umd/popper.min.js"></script>
<!-- Bootstrap JS -->
<script src="https://cdn.jsdelivr.net/npm/bootstrap@4.5.2/dist/js/bootstrap.min.js"></script>
<!-- Custom JS -->
<script src="${ASSET_CDN}/git-proxy/script.js"></script>
<script src="${ASSET_CDN}/js/navbar.js"></script>
</html>`

/** 逐跳头，转发前剔除 */
const HOP_BY_HOP = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
])

const PASSTHROUGH_HEADERS = [
    'accept',
    'accept-language',
    'authorization',
    'user-agent',
    'range',
    'if-range',
    'if-none-match',
    'if-modified-since',
    'cache-control',
]

/** 路径 -> 处理策略
 *  follow: 在 Worker 内跟随重定向并把内容流回客户端（适合二进制下载）
 *  api:    GitHub API，透传并重写 Link 头
 *  html:   普通仓库页面，原样转发（含 302）
 */
const RULES = [
    { name: 'repo-archive', re: /^github\.com\/([^/]+)\/([^/]+)\/(?:releases\/(?:download|assets|expanded_assets)|archive)\//i, follow: true },
    { name: 'repo-raw', re: /^github\.com\/([^/]+)\/([^/]+)\/(blob|raw)\//i, follow: true, blobToRaw: true },
    { name: 'repo-git', re: /^github\.com\/([^/]+)\/([^/]+)\/(info|git-)/i, follow: true },
    { name: 'repo-tags', re: /^github\.com\/([^/]+)\/([^/]+)\/tags/i, follow: true },
    { name: 'raw', re: /^raw\.(?:githubusercontent|github)\.com\//i, follow: true },
    { name: 'gist-raw', re: /^gist\.(?:githubusercontent|github)\.com\//i, follow: true },
    { name: 'codeload', re: /^codeload\.github\.com\//i, follow: true },
    { name: 'objects', re: /^objects\.githubusercontent\.com\//i, follow: true },
    { name: 'release-asset', re: /^release-assets\.githubusercontent\.com\//i, follow: true },
    { name: 'lfs-media', re: /^media\.githubusercontent\.com\//i, follow: true },
    { name: 'lfs-cloud', re: /^github-cloud\.githubusercontent\.com\//i, follow: true },
    { name: 'web-assets', re: /^(?:github\.githubassets\.com|avatars\.githubusercontent\.com|user-images\.githubusercontent\.com|private-user-images\.githubusercontent\.com|camo\.githubusercontent\.com)\//i, follow: true },
    { name: 'api', re: /^api\.github\.com\//i, api: true },
    { name: 'repo-page', re: /^github\.com\/([^/]+)\/([^/]+)(\/.*)?$/i, page: true },
]

function loadConfig(env) {
    const e = env || {}
    return {
        publicHost: (e.PUBLIC_HOST || '').trim(),
        ghToken: (e.GH_TOKEN || '').trim(),
        prefix: e.PREFIX || DEFAULT_PREFIX,
        assetUrl: e.ASSET_URL || DEFAULT_ASSET_URL,
        builtinHome: String(e.BUILTIN_HOME === undefined ? '1' : e.BUILTIN_HOME) !== '0',
        whiteList: (e.WHITELIST || '').split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean),
        jsdelivr: String(e.JSDELIVR || '0') === '1',
        maxRedirect: Number(e.MAX_REDIRECT) > 0 ? Number(e.MAX_REDIRECT) : 5,
    }
}

/** 对外基地址：PUBLIC_HOST 有值时固定用它（前置 CDN 时不暴露回源域名），否则用回源 Host */
function selfBase(url, cfg) {
    const prefix = cfg.prefix.replace(/\/$/, '')
    if (cfg.publicHost) {
        const raw = cfg.publicHost.replace(/\/$/, '')
        const origin = /^https?:\/\//i.test(raw) ? raw : 'https://' + raw
        return origin + prefix
    }
    return url.origin + prefix
}

function corsHeaders(extra) {
    const h = new Headers(extra || {})
    h.set('access-control-allow-origin', '*')
    h.set('access-control-expose-headers', '*')
    return h
}

function makeRes(body, status = 200, headers = {}) {
    return new Response(body, { status, headers: corsHeaders(headers) })
}

function jsonRes(obj, status = 200, headers = {}) {
    return makeRes(JSON.stringify(obj), status, Object.assign({ 'content-type': 'application/json; charset=utf-8' }, headers))
}

function preflight() {
    return new Response(null, {
        status: 204,
        headers: {
            'access-control-allow-origin': '*',
            'access-control-allow-methods': 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS',
            'access-control-allow-headers': '*',
            'access-control-max-age': '1728000',
        },
    })
}

/** 把请求路径还原成待访问的原始地址（含查询串） */
function resolveTarget(pathname, search, prefix) {
    let p = pathname || '/'
    if (prefix && prefix !== '/' && p.startsWith(prefix)) p = p.slice(prefix.length)
    else if (p.startsWith('/')) p = p.slice(1)
    // CF 会把路径里的 // 折叠成 /，这里补回来
    p = p.replace(/^(https?):\/+/, '$1://')
    if (search) p += search
    // 短写法：/owner/repo/... 自动补成 github.com/owner/repo/...
    if (!/^(?:https?:\/\/)?(github\.com|raw\.|gist\.|api\.|codeload\.|objects\.|release-assets\.|github\.githubassets\.com|avatars\.githubusercontent\.com|user-images\.githubusercontent\.com|private-user-images\.githubusercontent\.com|camo\.githubusercontent\.com)/i.test(p)) {
        const segs = p.split('#')[0].split('?')[0].split('/').filter(Boolean)
        const SITE_ROOTS = /^(login|logout|signup|join|site|features|about|pricing|search|settings|sponsors|topics|marketplace|orgs|organizations|users|notifications|dashboard|codespaces|collections|events|enterprise|team|trending|explore|readme|home|account|apps|contact|new|site)$/i
        // 两段及以上且首段符合 GitHub 用户名（不含点）时视为 owner/repo 简写，
        // 这样仓库页里的 /o/r/issues、/o/r/graphs/contributors 等站内链接也不会 404
        if (
            segs.length >= 2 &&
            /^[A-Za-z0-9-]+$/.test(segs[0]) &&
            /^[A-Za-z0-9._-]+$/.test(segs[1]) &&
            !SITE_ROOTS.test(segs[0])
        ) {
            p = 'github.com/' + p
        }
    }
    return p
}

/** 匹配处理规则 */
function matchRule(target) {
    for (const rule of RULES) {
        const m = rule.re.exec(target)
        if (m) return { rule, match: m }
    }
    return null
}

function buildUpstreamHeaders(request) {
    const headers = new Headers()
    for (const name of PASSTHROUGH_HEADERS) {
        const v = request.headers.get(name)
        if (v) headers.set(name, v)
    }
    // 强制 identity，避免 CF 自动解压导致 content-length 与实际字节数不一致
    headers.set('accept-encoding', 'identity')
    return headers
}

/** 组装响应：剔除逐跳头，补 CORS，去掉碍事的 CSP */
function finalize(res, opts = {}) {
    const headers = new Headers()
    for (const [k, v] of res.headers) {
        if (HOP_BY_HOP.has(k.toLowerCase())) continue
        headers.set(k, v)
    }
    headers.delete('content-security-policy')
    headers.delete('content-security-policy-report-only')
    headers.delete('clear-site-data')
    headers.delete('set-cookie')
    headers.set('access-control-allow-origin', '*')
    headers.set('access-control-expose-headers', '*')
    if (opts.extra) for (const [k, v] of Object.entries(opts.extra)) headers.set(k, v)
    return new Response(res.body, { status: res.status, headers })
}

/** 内部跟随重定向；跳主机时保留 Range，丢弃 Authorization */
async function proxyFollow(target, init, maxRedirect) {
    let url = target
    let headers = init.headers
    let res = null
    for (let hop = 0; hop <= maxRedirect; hop++) {
        res = await fetch(url.href, {
            method: init.method,
            headers,
            body: init.body,
            redirect: 'manual',
        })
        const loc = res.headers.get('location')
        if (!loc || res.status < 300 || res.status > 399) return res
        const next = new URL(loc, url.href)
        if (next.protocol !== 'https:') return res
        if (next.hostname.toLowerCase() !== url.hostname.toLowerCase()) {
            const h = new Headers(headers)
            h.delete('authorization')
            headers = h
        }
        url = next
    }
    return res
}

/** API 响应把 Link 头里的绝对地址改写为经过本代理的地址 */
function rewriteLinkHeader(value, base) {
    return value.replace(/<([^>]+)>/g, (m, u) => {
        try {
            const parsed = new URL(u)
            return '<' + base + '/' + parsed.host + parsed.pathname + parsed.search + '>'
        } catch (err) {
            return m
        }
    })
}

/**
 * 把 HTML 页面里会绕过代理的资产链接改写到本代理。
 * 不改写的话，浏览器会直接去 github.com 请求资产片段/下载，release 的 Assets 就会一直转圈。
 */
async function rewriteHtmlLinks(res, url, cfg, method) {
    const ct = res.headers.get('content-type') || ''
    if (method !== 'GET' || res.status !== 200 || !/text\/html/i.test(ct)) return res

    const base = selfBase(url, cfg)
    let text = await res.text()

    // 1) 绝对地址：https://github.com/{o}/{r}/releases|archive|raw|blob/...
    text = text.replace(
        /https:\/\/github\.com\/([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/(?:releases\/(?:expanded_assets|download)|archive|raw|blob)\/[^"'\s<>)]*)/g,
        (m, p1) => base + '/github.com/' + p1
    )

    // 2) 站内相对片段：src|href="/{o}/{r}/refs?...."、"…/releases/expanded_assets/…" 等
    text = text.replace(
        /(src|href)="\/([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/(?:refs[/?]|releases\/(?:expanded_assets|download)\/|archive\/|raw\/|blob\/)[^"]*)"/g,
        (m, attr, p1) => attr + '="' + base + '/github.com/' + p1 + '"'
    )

    // 3) 页面静态资源域（JS / CSS / 头像 / README 图片）也走代理，
    //    否则浏览器要直连 githubassets，弱网下脚本挂掉后 React 区块（仓库导航栏、
    //    文件大小、侧栏）就一直停在骨架，标签栏也不渲染
    text = text.replace(
        /https:\/\/(github\.githubassets\.com|avatars\.githubusercontent\.com|user-images\.githubusercontent\.com|private-user-images\.githubusercontent\.com|camo\.githubusercontent\.com)\//g,
        (m, host) => base + '/' + host + '/'
    )
    // 协议相对写法 //github.githubassets.com/...（只匹配紧跟属性的，避免误伤）
    text = text.replace(
        /((?:src|href|content)=")\/\/(github\.githubassets\.com|avatars\.githubusercontent\.com|camo\.githubusercontent\.com)\//g,
        (m, prefix, host) => prefix + base + '/' + host + '/'
    )

    const headers = new Headers(res.headers)
    headers.delete('content-length')
    headers.delete('content-encoding')
    return new Response(text, { status: 200, statusText: res.statusText, headers })
}

/** 未匹配路径：回退到静态站点（仅当 BUILTIN_HOME=0 或非首页时） */
async function handleAsset(request, target, url, cfg) {
    const assetUrl = cfg.assetUrl.replace(/\/$/, '') + (target && target !== '/' ? '/' + target.replace(/^\//, '') : '/')
    try {
        const res = await fetch(assetUrl, {
            headers: { 'user-agent': request.headers.get('user-agent') || 'cf-ghproxy' },
            cf: { cacheTtl: 300, cacheEverything: true },
        })
        const headers = new Headers(res.headers)
        headers.delete('content-security-policy')
        headers.delete('set-cookie')
        headers.set('access-control-allow-origin', '*')
        return new Response(res.body, { status: res.status, headers })
    } catch (err) {
        return jsonRes({ error: '无法加载静态资源: ' + (err && err.message) }, 502)
    }
}

export default {
    async fetch(request, env, ctx) {
        const cfg = loadConfig(env)
        const url = new URL(request.url)
        const method = request.method

        if (method === 'OPTIONS' && request.headers.has('access-control-request-headers')) {
            return preflight()
        }

        if (url.pathname === '/_health' || url.pathname === '/healthz') {
            return jsonRes({ status: 'ok', proxy: 'cf-ghproxy', builtinHome: cfg.builtinHome, assetCommit: ASSET_COMMIT, base: selfBase(url, cfg), time: new Date().toISOString() })
        }

        // ?q=https://github.com/... 形式，301 到标准路径
        const q = url.searchParams.get('q')
        if (q && (url.pathname === '/' || url.pathname === cfg.prefix || url.pathname === cfg.prefix.replace(/\/$/, ''))) {
            const target = q.replace(/^https?:\/\//, '')
            return Response.redirect(selfBase(url, cfg) + '/' + target, 301)
        }

        // 首页直接返回内置 HTML：不再从 github.io 中转，断网也不会把导航抽掉
        if (cfg.builtinHome && (url.pathname === '/' || url.pathname === '/index.html') && (method === 'GET' || method === 'HEAD')) {
            return makeRes(method === 'HEAD' ? null : HOME_HTML, 200, {
                'content-type': 'text/html; charset=utf-8',
                'cache-control': 'no-cache',
            })
        }

        const target = resolveTarget(url.pathname, url.search, cfg.prefix)
        const hit = matchRule(target.replace(/^https?:\/\//i, ''))

        // 白名单：命中任一片段才放行
        if (cfg.whiteList.length && !cfg.whiteList.some((w) => target.includes(w))) {
            return makeRes('blocked', 403, { 'content-type': 'text/plain; charset=utf-8' })
        }

        if (!hit) {
            return handleAsset(request, target, url, cfg)
        }

        const { rule } = hit

        // 浏览器地址栏直接打开 /github.com/{o}/{r}/... 时，统一落到简写 /{o}/{r}/...
        // 这样页面基地址与简写一致，页面内相对地址不会被解析成 /github.com/github.com/...
        // （脚本类请求 wget / curl / git 不带 sec-fetch-mode=navigate，不受影响，仍可用长路径）
        if (
            rule.page &&
            method === 'GET' &&
            /^\/github\.com\//i.test(url.pathname) &&
            request.headers.get('sec-fetch-mode') === 'navigate'
        ) {
            // 注意：必须用对外域名（PUBLIC_HOST），不能用 request.url —— EO 回源时 Host 是 gh.oproxy.cc
            // 且要把 github.com/ 前缀去掉，否则会重定向回自身
            const shortTarget = target.replace(/^github\.com\//i, '')
            const shortHref = selfBase(url, cfg) + '/' + shortTarget + (url.search || '')
            return Response.redirect(shortHref, 302)
        }

        let upstream = target
        if (!/^https?:\/\//i.test(upstream)) upstream = 'https://' + upstream

        // /blob/ -> /raw/（或跳转 jsDelivr）
        if (rule.blobToRaw && upstream.includes('/blob/')) {
            if (cfg.jsdelivr) {
                const jd = upstream.replace('/blob/', '@').replace(/^https:\/\/github\.com/, 'https://cdn.jsdelivr.net/gh')
                return Response.redirect(jd, 302)
            }
            upstream = upstream.replace('/blob/', '/raw/')
        }

        let urlObj
        try {
            urlObj = new URL(upstream)
        } catch (err) {
            return jsonRes({ error: '无法解析目标地址: ' + upstream }, 400)
        }

        const init = {
            method,
            headers: buildUpstreamHeaders(request),
            body: method === 'GET' || method === 'HEAD' ? undefined : request.body,
        }

        try {
            if (rule.api) {
                // 客户端自己带了 Authorization 就尊重它；否则用 GH_TOKEN 认证，绕开 60 次/小时的匿名限流
                let apiHeaders = init.headers
                if (cfg.ghToken && !apiHeaders.has('authorization')) {
                    apiHeaders = new Headers(apiHeaders)
                    apiHeaders.set('authorization', 'Bearer ' + cfg.ghToken)
                }
                const res = await fetch(urlObj.href, { method, headers: apiHeaders, body: init.body, redirect: 'manual' })
                const extra = {}
                const link = res.headers.get('link')
                if (link) extra['link'] = rewriteLinkHeader(link, selfBase(url, cfg))
                return finalize(res, { extra })
            }

            if (rule.page) {
                let res = await fetch(urlObj.href, { method, headers: init.headers, body: init.body, redirect: 'manual' })
                // GitHub 网页类也会时不时 429，重试两次避免刷新一次就白屏
                if (method === 'GET' || method === 'HEAD') {
                    for (let i = 0; i < 3 && (res.status === 429 || res.status === 503); i++) {
                        await new Promise((r) => setTimeout(r, 700 * (i + 1)))
                        res = await fetch(urlObj.href, { method, headers: init.headers, redirect: 'manual' })
                    }
                }
                return finalize(await rewriteHtmlLinks(res, url, cfg, method))
            }

            // release 资产片段：内容基本不变，但并发请求容易被 GitHub 限流（429）导致页面一直转圈
            // 这里先查 Worker 缓存，未命中才回源，并对 429 重试一次
            if (/\/releases\/expanded_assets\//i.test(urlObj.pathname) && method === 'GET') {
                const cacheKey = new Request(new URL(urlObj.pathname + '?__frag=1', request.url).href)
                try {
                    const hit = await caches.default.match(cacheKey)
                    if (hit) {
                        const h = new Headers(hit.headers)
                        h.set('x-fragment-cache', 'hit')
                        return finalize(new Response(hit.body, { status: hit.status, headers: h }))
                    }
                } catch (e) {}

                let res = await proxyFollow(urlObj, init, cfg.maxRedirect)
                for (let i = 0; i < 2 && (res.status === 429 || res.status === 403 || res.status === 503); i++) {
                    await new Promise((r) => setTimeout(r, 500 * (i + 1)))
                    res = await proxyFollow(urlObj, init, cfg.maxRedirect)
                }
                if (res.status === 200) {
                    try {
                        const copy = res.clone()
                        const h = new Headers(copy.headers)
                        h.set('cache-control', 'public, max-age=604800')
                        await caches.default.put(cacheKey, new Response(copy.body, { status: 200, headers: h }))
                    } catch (e) {}
                }
                const frag = await rewriteHtmlLinks(res, url, cfg, method)
                return finalize(frag, {
                    extra: { 'cache-control': 'public, max-age=604800', 'x-fragment-cache': 'miss' },
                })
            }

            let res = await proxyFollow(urlObj, init, cfg.maxRedirect)
            if (method === 'GET' || method === 'HEAD') {
                for (let i = 0; i < 3 && (res.status === 429 || res.status === 503); i++) {
                    await new Promise((r) => setTimeout(r, 700 * (i + 1)))
                    res = await proxyFollow(urlObj, init, cfg.maxRedirect)
                }
            }
            if (res.status >= 300 && res.status <= 399) {
                // 仍是重定向（例如跳域校验失败），原样交给客户端
                return finalize(res)
            }
            const out = await rewriteHtmlLinks(res, url, cfg, method)
            return finalize(out, {
                extra: {
                    // 下载类响应允许长缓存，命中 CDN 后不再回源
                    'cache-control': out.headers.get('cache-control') || 'public, max-age=600',
                },
            })
        } catch (err) {
            console.error('代理失败:', err && err.stack)
            return jsonRes({ error: '上游请求失败: ' + (err && err.message) }, 502)
        }
    },
}
