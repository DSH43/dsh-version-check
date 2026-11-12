/**
 * dsh-version-check —— 看官方有没有发 DSH 的新版本。
 *
 * host 侧（本文件）：
 *  - 读出本机正在跑的 dsh 版本（@deepseek-ai/dsh 的 package.json version）；
 *  - 读官方 GitHub Releases（deepseek-ai/deepseek-harness，tag 形如 dsh-v0.2.2-rc.2），
 *    取其中版本号最高的一个，按 semver 比大小（含 rc/alpha 预发布规则）；
 *  - 结果缓存 30 分钟；网络失败时报错，绝不冒充「已是最新」；
 *  - 注册路由 GET /plugins/dsh-version-check/status[?refresh=1]。
 *
 * 只查版本，不下载、不安装、不改任何东西。
 *
 * 本文件由同目录的 index.js 启动壳在运行时动态加载（见 index.js 顶部注释）。
 * 这里抛错只让插件停用，dsh 照常启动。
 */

import { createRequire } from 'node:module'
import { readFileSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export const name = 'dsh-version-check'

/** 硬依赖：路由注册的前提。 */
export const inject = ['webServer']

const ROUTE_STATUS = '/plugins/dsh-version-check/status'

const DEFAULT_REPO = 'deepseek-ai/deepseek-harness'
/** 官方 Release 的 tag 前缀：dsh-v0.2.2-rc.2。 */
const TAG_PREFIX = 'dsh-v'
const CACHE_TTL_MS = 30 * 60 * 1000
const TIMEOUT_MS = 15_000
/** 往上找 dsh package.json 的最大层数。 */
const MAX_WALK_UP = 12

function releaseRepo() {
  return process.env.DSH_RELEASE_REPO?.trim() || DEFAULT_REPO
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/** 带错误码的失败：界面按码翻译，不直接显示中文句子。 */
function fail(code, detail) {
  const error = new Error(detail === undefined ? code : detail)
  error.code = code
  if (detail !== undefined) error.detail = detail
  return error
}

/** 解析 semver：1.2.3 / 1.2.3-rc.4，前缀 v 可有可无。 */
function parseVersion(text) {
  if (typeof text !== 'string') return null
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(text.trim())
  if (match === null) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  }
}

/** semver 预发布标识比较：数字段按数值，字母段按字典序，数字段低于字母段。 */
function comparePrerelease(left, right) {
  if (left.length === 0 && right.length === 0) return 0
  if (left.length === 0) return 1
  if (right.length === 0) return -1
  const length = Math.min(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const a = left[index]
    const b = right[index]
    if (a === b) continue
    const aNumeric = /^\d+$/.test(a)
    const bNumeric = /^\d+$/.test(b)
    if (aNumeric && bNumeric) return Number(a) < Number(b) ? -1 : 1
    if (aNumeric) return -1
    if (bNumeric) return 1
    return a < b ? -1 : 1
  }
  return left.length < right.length ? -1 : left.length > right.length ? 1 : 0
}

/** 比版本大小：left 大返回 1，小返回 -1，相等返回 0。 */
function compareVersions(left, right) {
  for (const field of ['major', 'minor', 'patch']) {
    if (left[field] !== right[field]) return left[field] < right[field] ? -1 : 1
  }
  return comparePrerelease(left.prerelease, right.prerelease)
}

/**
 * 读本机 dsh 版本。
 * 从 dsh 启动入口（<安装目录>/apps/cli/lib/bin.js）先试 Node 解析
 * @deepseek-ai/dsh/package.json，再逐层往上找 package.json 里 name 为
 * @deepseek-ai/dsh 或 @deepseek-ai/dsh-root 的版本。发布版和源码版都能命中。
 */
function resolveLocalVersion() {
  let entry = null
  try {
    if (typeof process.argv[1] === 'string' && process.argv[1] !== '') entry = realpathSync(process.argv[1])
  } catch { /* 入口取不到就走目录往上找 */ }
  if (entry !== null) {
    try {
      const requireFromEntry = createRequire(entry)
      const manifest = JSON.parse(readFileSync(requireFromEntry.resolve('@deepseek-ai/dsh/package.json'), 'utf8'))
      if (typeof manifest.version === 'string' && parseVersion(manifest.version) !== null) return manifest.version
    } catch { /* 包导出表可能不给 package.json，继续往上找 */ }
    let dir = dirname(entry)
    for (let depth = 0; depth < MAX_WALK_UP; depth += 1) {
      try {
        const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
        const named = manifest.name === '@deepseek-ai/dsh' || manifest.name === '@deepseek-ai/dsh-root'
        if (named && typeof manifest.version === 'string' && parseVersion(manifest.version) !== null) {
          return manifest.version
        }
      } catch { /* 这一层没有 package.json，继续往上 */ }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  return null
}

/** 读 GitHub token：环境变量优先，其次 dsh 的凭据服务。 */
async function gitHubToken(ctx) {
  const fromEnv = process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim()
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  try {
    const credentials = ctx.get?.('credentials')
    if (credentials !== undefined && typeof credentials.resolve === 'function') {
      const hit = await credentials.resolve('GITHUB_TOKEN')
      if (hit !== undefined && typeof hit.value === 'string' && hit.value !== '') return hit.value
    }
  } catch { /* 匿名访问也能用，只是配额低 */ }
  return undefined
}

async function fetchJson(ctx, url) {
  const token = await gitHubToken(ctx)
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'dsh-version-check',
    'X-GitHub-Api-Version': '2022-11-28',
  }
  if (token !== undefined) headers.Authorization = 'Bearer ' + token
  let response
  try {
    response = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) })
  } catch (error) {
    throw fail('network', errorMessage(error))
  }
  if (!response.ok) {
    const code = response.status === 403 || response.status === 429 ? 'rate-limit' : 'http'
    throw fail(code, 'HTTP ' + response.status)
  }
  return response.json()
}

/** 拉官方 Release 列表，只留 dsh-v* 且未草稿的。 */
async function fetchReleases(ctx) {
  const repository = releaseRepo()
  const data = await fetchJson(ctx, `https://api.github.com/repos/${repository}/releases?per_page=40`)
  if (!Array.isArray(data)) throw fail('payload', 'releases payload is not an array')
  const releases = []
  for (const item of data) {
    if (item === null || typeof item !== 'object' || item.draft === true) continue
    const tag = typeof item.tag_name === 'string' ? item.tag_name : ''
    if (!tag.startsWith(TAG_PREFIX)) continue
    const version = tag.slice(TAG_PREFIX.length)
    const parsed = parseVersion(version)
    if (parsed === null) continue
    releases.push({
      version,
      parsed,
      tag,
      prerelease: item.prerelease === true || parsed.prerelease.length > 0,
      publishedAt: typeof item.published_at === 'string' ? item.published_at : null,
      url: typeof item.html_url === 'string' ? item.html_url : null,
    })
  }
  let latest = null
  let stable = null
  for (const release of releases) {
    if (latest === null || compareVersions(release.parsed, latest.parsed) > 0) latest = release
    if (!release.prerelease && (stable === null || compareVersions(release.parsed, stable.parsed) > 0)) stable = release
  }
  return { repository, latest, stable, count: releases.length }
}

/** 只缓存网络结果，本地版本每次重读（很便宜）。 */
const cache = { key: null, at: 0, value: null }

async function releasesCached(ctx, force) {
  const key = releaseRepo()
  if (!force && cache.value !== null && cache.key === key && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.value
  }
  const value = await fetchReleases(ctx)
  cache.key = key
  cache.at = Date.now()
  cache.value = value
  return value
}

/** 把 Release 行裁成界面要的字段。 */
function brief(release) {
  if (release === null || release === undefined) return null
  return {
    version: release.version,
    tag: release.tag,
    prerelease: release.prerelease,
    publishedAt: release.publishedAt,
    url: release.url,
  }
}

function emptyStatus() {
  return {
    ok: true,
    state: 'checking',
    current: null,
    latest: null,
    stable: null,
    offers: 0,
    repo: releaseRepo(),
    checkedAt: Date.now(),
    error: null,
    detail: null,
  }
}

/**
 * 算一次状态。
 * state: available（有新版本）/ current（已最新）/ unknown（读不到本地版本）/ error（查不到）。
 * @param {object} ctx dsh 上下文
 * @param {boolean} force 是否绕过缓存
 */
async function buildStatus(ctx, force) {
  const status = emptyStatus()
  status.current = resolveLocalVersion()
  let upstream
  try {
    upstream = await releasesCached(ctx, force)
  } catch (error) {
    return {
      ...status,
      ok: false,
      state: 'error',
      error: typeof error?.code === 'string' ? error.code : 'unknown',
      detail: typeof error?.detail === 'string' ? error.detail : errorMessage(error),
    }
  }
  status.latest = brief(upstream.latest)
  status.stable = brief(upstream.stable)
  status.offers = upstream.count
  if (upstream.latest === null) {
    return { ...status, ok: false, state: 'error', error: 'no-releases', detail: null }
  }
  const current = status.current === null ? null : parseVersion(status.current)
  if (current === null) {
    status.state = 'unknown'
    return status
  }
  status.state = compareVersions(upstream.latest.parsed, current) > 0 ? 'available' : 'current'
  return status
}

function sendJson(res, value) {
  try {
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    })
    res.end(JSON.stringify(value))
  } catch { /* socket gone */ }
}

async function handleStatus(req, res, ctx) {
  let force = false
  try {
    const url = new URL(req.url ?? ROUTE_STATUS, 'http://dsh.local')
    force = url.searchParams.get('refresh') === '1'
  } catch { /* 解析不了就当不强制刷新 */ }
  let status
  try {
    status = await buildStatus(ctx, force)
  } catch (error) {
    status = { ...emptyStatus(), ok: false, state: 'error', error: 'unknown', detail: errorMessage(error) }
  }
  sendJson(res, status)
}

export function apply(ctx) {
  const webServer = ctx.get('webServer')
  if (webServer === undefined) return
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: ROUTE_STATUS,
    handler: (req, res) => void handleStatus(req, res, ctx),
  }), 'dsh-version-check: status route')
}

/** 测试用内部函数，cordis 不读这个导出。 */
export const __internals = {
  parseVersion,
  compareVersions,
  resolveLocalVersion,
  fetchReleases,
  buildStatus,
}
