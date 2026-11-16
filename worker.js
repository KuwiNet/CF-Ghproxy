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
 *
 * 环境变量：
 *   PREFIX       路由前缀，默认 "/"。若自定义路由为 example.com/gh/* 则设为 "/gh/"
 *   PUBLIC_HOST  对外域名（前置 EdgeOne 等 CDN 时填，例如 arelay.cn）。填写后 301 跳转与
 *                API 的 Link 头都改写为对外域名，不再把回源域名暴露给客户端；留空则用回源 Host。
 *   ASSET_URL    未匹配路径时回退的静态站点地址
 *   WHITELIST    白名单，逗号分隔；非空时只有路径命中其中片段才放行
 *   JSDELIVR     设为 1 时，/blob/ 请求改为跳转 jsDelivr CDN
 *   MAX_REDIRECT 内部跟随重定向的最大跳数，默认 5
 */

const DEFAULT_PREFIX = '/'
const DEFAULT_ASSET_URL = 'https://kuwinet.github.io/CF-Ghproxy/'

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
	{ name: 'repo-archive', re: /^github\.com\/([^/]+)\/([^/]+)\/(releases|archive)\//i, follow: true },
	{ name: 'repo-raw', re: /^github\.com\/([^/]+)\/([^/]+)\/(blob|raw)\//i, follow: true, blobToRaw: true },
	{ name: 'repo-git', re: /^github\.com\/([^/]+)\/([^/]+)\/(info|git-)/i, follow: true },
	{ name: 'repo-tags', re: /^github\.com\/([^/]+)\/([^/]+)\/tags/i, follow: true },
	{ name: 'raw', re: /^raw\.(?:githubusercontent|github)\.com\//i, follow: true },
	{ name: 'gist-raw', re: /^gist\.(?:githubusercontent|github)\.com\//i, follow: true },
	{ name: 'codeload', re: /^codeload\.github\.com\//i, follow: true },
	{ name: 'objects', re: /^objects\.githubusercontent\.com\//i, follow: true },
	{ name: 'release-asset', re: /^release-assets\.githubusercontent\.com\//i, follow: true },
	{ name: 'api', re: /^api\.github\.com\//i, api: true },
	{ name: 'repo-page', re: /^github\.com\/([^/]+)\/([^/]+)(\/.*)?$/i, page: true },
]

function loadConfig(env) {
	const e = env || {}
	return {
		publicHost: (e.PUBLIC_HOST || '').trim(),
		prefix: e.PREFIX || DEFAULT_PREFIX,
		assetUrl: e.ASSET_URL || DEFAULT_ASSET_URL,
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
	// 短写法：/owner/repo/archive/... 自动补成 github.com/owner/repo/archive/...
	if (!/^(?:https?:\/\/)?(github\.com|raw\.|gist\.|api\.|codeload\.|objects\.|release-assets\.)/i.test(p)) {
		if (/^[^/?#]+\/[^/?#]+\/(archive|releases|blob|raw|tags|tree|info|git-)/i.test(p)) {
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

/** 内部跟随重定向；跨主机时保留 Range，丢弃 Authorization 以外的敏感头 */
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

/** API 响应把 Link 头里的绝对地址改写成经过本代理的地址 */
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

/** 首页 / 未匹配路径：回退到静态站点 */
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
			return jsonRes({ status: 'ok', proxy: 'cf-ghproxy', base: selfBase(url, cfg), time: new Date().toISOString() })
		}

		// ?q=https://github.com/... 形式，301 到标准路径
		const q = url.searchParams.get('q')
		if (q && (url.pathname === '/' || url.pathname === cfg.prefix || url.pathname === cfg.prefix.replace(/\/$/, ''))) {
			const target = q.replace(/^https?:\/\//, '')
			return Response.redirect(selfBase(url, cfg) + '/' + target, 301)
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
				const res = await fetch(urlObj.href, { method, headers: init.headers, body: init.body, redirect: 'manual' })
				const extra = {}
				const link = res.headers.get('link')
				if (link) extra['link'] = rewriteLinkHeader(link, selfBase(url, cfg))
				return finalize(res, { extra })
			}

			if (rule.page) {
				const res = await fetch(urlObj.href, { method, headers: init.headers, body: init.body, redirect: 'manual' })
				return finalize(res)
			}

			const res = await proxyFollow(urlObj, init, cfg.maxRedirect)
			if (res.status >= 300 && res.status <= 399) {
				// 仍是重定向（例如跨域校验失败），原样交给客户端
				return finalize(res)
			}
			return finalize(res, {
				extra: {
					// 下载类响应允许长缓存，命中 CDN 后不再回源
					'cache-control': res.headers.get('cache-control') || 'public, max-age=600',
				},
			})
		} catch (err) {
			console.error('代理失败:', err && err.stack)
			return jsonRes({ error: '上游请求失败: ' + (err && err.message) }, 502)
		}
	},
}
