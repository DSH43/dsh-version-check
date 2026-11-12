/**
 * dsh-version-check —— 看官方有没有发 DSH 的新版本。
 *
 * host 侧（本文件）：
 *  - 读出本机正在跑的 dsh 版本（@deepseek-ai/dsh 的 package.json version）；
 *  - 读官方 GitHub Releases（deepseek-ai/deepseek-harness，tag 形如 dsh-v0.2.2-rc.2），
 *    取其中版本号最高的一个，按 semver 比大小（含 rc/alpha 预发布规则）；
 *  - 结果缓存 30 分钟；网络失败时报错，绝不冒充「已是最新」；
 *  - 认出安装形态（源码仓库 / 全局 npm 包），给出对应的升级命令；
 *  - 可选的自动升级：后台跑一个由本文件生成的 shell 脚本，把进度写进状态文件，
 *    界面轮询读取。升级不改动正在运行的进程，重启 dsh 才生效；
 *  - 路由：
 *      GET  /plugins/dsh-version-check/status[?refresh=1]
 *      GET  /plugins/dsh-version-check/upgrade
 *      POST /plugins/dsh-version-check/upgrade   {"version":"...","tag":"...","confirm":true}
 *
 * 查版本本身不写文件；只有点了升级才会在 ~/.dsh/state/dsh-version-check 下写状态。
 *
 * 本文件由同目录的 index.js 启动壳在运行时动态加载（见 index.js 顶部注释）。
 * 这里抛错只让插件停用，dsh 照常启动。
 */

import { spawn, spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const name = 'dsh-version-check'

/** 硬依赖：路由注册的前提。 */
export const inject = ['webServer']

const ROUTE_STATUS = '/plugins/dsh-version-check/status'
const ROUTE_UPGRADE = '/plugins/dsh-version-check/upgrade'

const DEFAULT_REPO = 'deepseek-ai/deepseek-harness'
/** 官方 Release 的 tag 前缀：dsh-v0.2.2-rc.2。 */
const TAG_PREFIX = 'dsh-v'
/** 全局安装时装的包名。 */
const PACKAGE_NAME = '@deepseek-ai/dsh'
const CACHE_TTL_MS = 30 * 60 * 1000
const TIMEOUT_MS = 15_000
/** 往上找 dsh package.json 的最大层数。 */
const MAX_WALK_UP = 12
/** 认安装形态的缓存：git status / pnpm 探测不便宜。 */
const INSTALL_TTL_MS = 60 * 1000
/** 升级日志最多回传多少字节的尾巴。 */
const LOG_TAIL_BYTES = 64 * 1024
/** 超过这个时间还没写 done，当成进程没了。 */
const JOB_STALE_MS = 3 * 60 * 60 * 1000
/** 升级请求体上限：只该是一个小 JSON。 */
const MAX_BODY_BYTES = 4096

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const TAG_PATTERN = /^dsh-v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

/** 状态目录跟着 DSH_HOME 走；显式设了 DSH_VERSION_CHECK_STATE_DIR 就听它的。 */
function dshHome() {
  return process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
}

function upgradeDir() {
  return join(process.env.DSH_VERSION_CHECK_STATE_DIR?.trim() || join(dshHome(), 'state', 'dsh-version-check'), 'upgrade')
}

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

function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/**
 * 找本机 dsh 的 package.json。
 * 从 dsh 启动入口（<安装目录>/apps/cli/lib/bin.js）先试 Node 解析
 * @deepseek-ai/dsh/package.json，再逐层往上找 package.json 里 name 为
 * @deepseek-ai/dsh 或 @deepseek-ai/dsh-root 的那份。发布版和源码版都能命中。
 * @returns {{ version: string, file: string } | null}
 */
function localManifest() {
  let entry = null
  try {
    if (typeof process.argv[1] === 'string' && process.argv[1] !== '') entry = realpathSync(process.argv[1])
  } catch { /* 入口取不到就走目录往上找 */ }
  if (entry === null) return null
  try {
    const requireFromEntry = createRequire(entry)
    const file = requireFromEntry.resolve(PACKAGE_NAME + '/package.json')
    const manifest = readJsonFile(file)
    if (manifest !== null && typeof manifest.version === 'string' && parseVersion(manifest.version) !== null) {
      return { version: manifest.version, file }
    }
  } catch { /* 包导出表可能不给 package.json，继续往上找 */ }
  let dir = dirname(entry)
  for (let depth = 0; depth < MAX_WALK_UP; depth += 1) {
    const file = join(dir, 'package.json')
    const manifest = readJsonFile(file)
    if (manifest !== null && (manifest.name === PACKAGE_NAME || manifest.name === PACKAGE_NAME + '-root')
      && typeof manifest.version === 'string' && parseVersion(manifest.version) !== null) {
      return { version: manifest.version, file }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/** 读本机 dsh 版本号。 */
function resolveLocalVersion() {
  const manifest = localManifest()
  return manifest === null ? null : manifest.version
}

/** 从某个 package.json 往上找仓库根（含 .git 的那层）。 */
function repoRootOf(file) {
  let dir = dirname(file)
  for (let depth = 0; depth < MAX_WALK_UP; depth += 1) {
    if (existsSync(join(dir, '.git'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

const installCache = { at: 0, value: null }
const binaryCache = new Map()

function hasBinary(binary) {
  const cached = binaryCache.get(binary)
  if (cached !== undefined && Date.now() - cached.at < 5 * 60 * 1000) return cached.value
  let value = false
  try {
    const result = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 5000 })
    value = result.error === undefined || result.error === null ? result.status === 0 : false
  } catch { value = false }
  binaryCache.set(binary, { at: Date.now(), value })
  return value
}

/** 跑一条 git 命令，失败不抛。 */
function gitSync(cwd, args) {
  try {
    const result = spawnSync('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: 10_000,
      env: { ...process.env, GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0' },
    })
    if (result.error !== undefined && result.error !== null) return { ok: false, error: errorMessage(result.error), stdout: '' }
    const stdout = typeof result.stdout === 'string' ? result.stdout.trim() : ''
    const stderr = typeof result.stderr === 'string' ? result.stderr.trim() : ''
    return { ok: result.status === 0, stdout, stderr, status: result.status ?? 1 }
  } catch (error) {
    return { ok: false, error: errorMessage(error), stdout: '' }
  }
}

/**
 * 认出安装形态。
 * kind: 'source'（本机 git 仓库，改了要重新构建）/ 'global'（npm -g 装的）/ 'unknown'。
 * @returns {{ kind: 'source' | 'global' | 'unknown', cwd: string | null, version: string | null }}
 */
function detectInstall() {
  const manifest = localManifest()
  if (manifest === null) return { kind: 'unknown', cwd: null, version: null }
  const root = repoRootOf(manifest.file)
  if (root !== null) {
    const rootManifest = readJsonFile(join(root, 'package.json'))
    if (rootManifest !== null && rootManifest.name === PACKAGE_NAME + '-root') {
      return { kind: 'source', cwd: root, version: typeof rootManifest.version === 'string' ? rootManifest.version : manifest.version }
    }
  }
  return { kind: 'global', cwd: null, version: manifest.version }
}

function installFor() {
  if (installCache.value !== null && Date.now() - installCache.at < INSTALL_TTL_MS) return installCache.value
  const value = detectInstall()
  installCache.value = value
  installCache.at = Date.now()
  return value
}

/** 命令里出现的路径：能裸写就裸写，含空格才加引号。 */
function displayPath(path) {
  return /^[\w@%+=:,./-]+$/.test(path) ? path : "'" + path.replace(/'/g, "'\\''") + "'"
}

/** 挑一个用于拉取版本的 remote：origin 优先。 */
function pickRemote(cwd) {
  const listed = gitSync(cwd, ['remote']).stdout.split('\n').map((line) => line.trim()).filter((line) => line !== '')
  if (listed.length === 0) return null
  for (const preferred of ['origin', 'upstream']) {
    if (listed.includes(preferred)) return preferred
  }
  return listed[0]
}

/** 源码升级要按顺序跑的步骤（也用于生成给用户复制的命令）。 */
function sourceSteps(cwd, remote, tag) {
  return [
    ['fetch', ['git', 'fetch', '--tags', '--prune', remote]],
    ['checkout', ['git', '-c', 'advice.detachedHead=false', 'checkout', tag]],
    ['install', ['pnpm', 'install', '--frozen-lockfile']],
    ['build', ['pnpm', 'run', 'build']],
  ]
}

/**
 * 算升级计划：命令文本给界面复制/展示，blocked 说明为什么不能自动升级。
 * @param {{ kind: string, cwd: string | null, version: string | null }} install
 * @param {{ version: string, tag: string } | null} latest
 */
function planFor(install, latest) {
  const plan = {
    kind: install.kind,
    cwd: install.cwd,
    command: null,
    canUpgrade: latest !== null && latest.tag !== null && install.kind !== 'unknown',
    blocked: null,
    blockedDetail: null,
    remote: null,
  }
  if (install.kind === 'unknown') {
    plan.canUpgrade = false
    plan.blocked = 'unknown-install'
    return plan
  }
  if (install.kind === 'global') {
    plan.command = latest === null ? `npm i -g ${PACKAGE_NAME}@latest` : `npm i -g ${PACKAGE_NAME}@${latest.version}`
    if (latest === null) plan.blocked = 'no-version'
    else if (!hasBinary('npm')) plan.blocked = 'no-npm'
    plan.canUpgrade = plan.blocked === null
    return plan
  }
  // source
  if (latest === null) {
    plan.canUpgrade = false
    plan.blocked = 'no-version'
    plan.command = `cd ${displayPath(install.cwd ?? '.')} && git fetch --tags && pnpm install --frozen-lockfile && pnpm run build`
    return plan
  }
  const remote = pickRemote(install.cwd)
  plan.remote = remote
  const head = remote === null ? 'git fetch --tags' : `git fetch --tags ${remote}`
  plan.command = `cd ${displayPath(install.cwd)} && ${head} && git -c advice.detachedHead=false checkout ${latest.tag} && pnpm install --frozen-lockfile && pnpm run build`
  const dirty = remote === null ? { ok: false, stdout: '' } : gitSync(install.cwd, ['status', '--porcelain', '--untracked-files=no'])
  if (remote === null) plan.blocked = 'no-remote'
  else if (dirty.ok && dirty.stdout !== '') plan.blocked = 'dirty'
  else if (!hasBinary('git')) plan.blocked = 'no-git'
  else if (!hasBinary('pnpm')) plan.blocked = 'no-pnpm'
  else if (!dirty.ok) plan.blocked = 'no-git'
  if (plan.blocked === 'dirty') plan.blockedDetail = dirty.stdout.split('\n').slice(0, 3).join(' · ')
  plan.canUpgrade = plan.blocked === null
  return plan
}

/** 生成 shell 里安全的一整段单引号字面量。 */
function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'"
}

function jobPaths() {
  const dir = upgradeDir()
  return {
    dir,
    job: join(dir, 'job.json'),
    phase: join(dir, 'phase'),
    done: join(dir, 'done'),
    log: join(dir, 'output.log'),
    script: join(dir, 'run.sh'),
  }
}

/** 读文件尾巴，文件很大时只读最后一段。 */
function readTail(path, bytes) {
  let fd
  try {
    const size = statSync(path).size
    const length = Math.min(size, bytes)
    if (length === 0) return ''
    fd = openSync(path, 'r')
    const buffer = Buffer.alloc(length)
    readSync(fd, buffer, 0, length, size - length)
    return buffer.toString('utf8')
  } catch {
    return ''
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd) } catch { /* 已经关了 */ }
    }
  }
}

function tailLines(path, count) {
  const text = readTail(path, LOG_TAIL_BYTES)
  if (text === '') return []
  const lines = text.split('\n').map((line) => line.replace(/\s+$/, ''))
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  const tail = lines.slice(Math.max(0, lines.length - count))
  while (tail.length > 0 && tail[0] === '') tail.shift()
  return tail
}

/**
 * 读当前这一轮升级任务的状态。
 * state: 'running' | 'done' | 'failed' | 'lost'。
 */
function readJob() {
  const paths = jobPaths()
  const record = readJsonFile(paths.job)
  if (record === null || typeof record !== 'object') return null
  let phase = ''
  try { phase = readFileSync(paths.phase, 'utf8').trim() } catch { /* 还没写 */ }
  const done = readJsonFile(paths.done)
  const running = done === null
  let state = 'running'
  let exitCode = null
  if (done !== null) {
    exitCode = typeof done.exitCode === 'number' ? done.exitCode : 1
    state = exitCode === 0 ? 'done' : 'failed'
  } else if (typeof record.startedAt === 'number' && Date.now() - record.startedAt > JOB_STALE_MS) {
    state = 'lost'
  }
  let installedVersion = null
  if (record.kind === 'source' && typeof record.cwd === 'string' && state !== 'running') {
    const manifest = readJsonFile(join(record.cwd, 'package.json'))
    installedVersion = manifest !== null && typeof manifest.version === 'string' ? manifest.version : null
  }
  return {
    id: record.id,
    version: record.version,
    tag: record.tag,
    kind: record.kind,
    cwd: record.cwd,
    startedAt: record.startedAt,
    state,
    running,
    phase,
    exitCode,
    log: tailLines(paths.log, 12),
    auto: record.auto === true,
    rollback: typeof record.rollback === 'string' ? record.rollback : null,
    restart: typeof record.restart === 'string' ? record.restart : null,
    installedVersion,
    warning: state === 'done' && installedVersion !== null && installedVersion !== record.version ? 'version-mismatch' : null,
    finishedAt: done !== null && typeof done.finishedAt === 'number' ? done.finishedAt : null,
  }
}

/**
 * 生成升级脚本。
 *
 * 源码版并且检出目录里有 start.sh 时走全自动：先停掉当前 dsh，构建完自己起回来，
 * 再让 start.sh --refresh 刷新原来的浏览器窗口。构建期间 start.sh 会被
 * `building` 锁挡住，谁也别想插进来起第二个。
 *
 * 失败先回退到升级前的 ref 重新构建，再把 dsh 起回来；回退也失败才停在那里。
 */
function buildScript(kind, options) {
  const lines = [
    '#!/usr/bin/env bash',
    '# 由 dsh-version-check 生成，升级到 ' + options.version,
    'set -u',
    'export GIT_PAGER=cat PAGER=cat GIT_TERMINAL_PROMPT=0 HUSKY=0 CI=1',
    'DIR=' + shellQuote(options.dir),
    'LOG="$DIR/output.log"',
    'LOCK=' + shellQuote(options.lock),
    'REPO=' + shellQuote(options.cwd ?? options.dir),
    'PORT=' + shellQuote(String(options.port ?? 0)),
    'AUTO=' + (options.auto === true ? '1' : '0'),
    'PREVIOUS=' + shellQuote(typeof options.previous === 'string' ? options.previous : ''),
    'SERVER_PID=' + shellQuote(String(options.pid ?? 0)),
    'phase() { printf "%s\\n" "$1" >"$DIR/phase"; printf "\\n== %s ==\\n" "$1" >>"$LOG"; }',
    "finish() { rm -f \"$LOCK\"; printf '{\"exitCode\":%s,\"finishedAt\":%s}\\n' \"$1\" \"$(date +%s)\" >\"$DIR/done\"; exit \"$1\"; }",
    'step() { name="$1"; shift; phase "$name"; "$@" >>"$LOG" 2>&1 || onfail "$name" $?; }',
    'port_open() { lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; }',
    'stop_ui() {',
    '  [ "$AUTO" = "1" ] || return 0',
    '  phase stop',
    '  sleep 1',
    '  if [ "$SERVER_PID" -gt 1 ] && kill -0 "$SERVER_PID" 2>/dev/null; then',
    '    kill -TERM "$SERVER_PID" 2>/dev/null || true',
    '    n=0',
    '    while kill -0 "$SERVER_PID" 2>/dev/null && [ "$n" -lt 20 ]; do sleep 1; n=$((n+1)); done',
    '    if kill -0 "$SERVER_PID" 2>/dev/null; then kill -KILL "$SERVER_PID" 2>/dev/null || true; sleep 1; fi',
    '  fi',
    '  n=0',
    '  while port_open && [ "$n" -lt 20 ]; do sleep 1; n=$((n+1)); done',
    '}',
    'restart_ui() {',
    '  [ "$AUTO" = "1" ] || return 0',
    '  phase restart',
    '  rm -f "$LOCK"',
    '  ( cd "$REPO" && nohup ./start.sh --port "$PORT" --no-open >>"$DIR/restart.log" 2>&1 & )',
    '  n=0',
    '  while [ "$n" -lt 120 ]; do',
    '    http_code=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PORT/" 2>/dev/null || true)',
    '    case "$http_code" in 200|303|401) break ;; esac',
    '    sleep 1; n=$((n+1))',
    '  done',
    '  phase refresh',
    '  ( cd "$REPO" && ./start.sh --refresh --port "$PORT" >>"$LOG" 2>&1 )',
    '}',
    'onfail() {',
    '  failcode="$2"',
    '  printf "step %s failed: %s\\n" "$1" "$failcode" >>"$LOG"',
    '  if [ -n "$PREVIOUS" ]; then',
    '    phase rollback',
    '    git checkout "$PREVIOUS" >>"$LOG" 2>&1',
    '    pnpm install --frozen-lockfile >>"$LOG" 2>&1',
    '    if ! pnpm run build >>"$LOG" 2>&1; then phase dead; restart_ui; finish "$failcode"; fi',
    '  fi',
    '  restart_ui',
    '  finish "$failcode"',
    '}',
  ]
  if (kind === 'source') {
    lines.push('cd ' + shellQuote(options.cwd) + ' || finish 1')
    lines.push('stop_ui')
    for (const [phaseName, argv] of sourceSteps(options.cwd, options.remote, options.tag)) {
      lines.push('step ' + phaseName + ' ' + argv.map(shellQuote).join(' '))
    }
    lines.push('restart_ui')
    lines.push('phase verify')
  } else {
    lines.push('step install ' + ['npm', 'i', '-g', PACKAGE_NAME + '@' + options.version].map(shellQuote).join(' '))
    lines.push('phase verify')
  }
  lines.push('finish 0', '')
  return lines.join('\n')
}

let starting = false

/**
 * 起一轮升级。返回 { status, payload }，由路由层决定怎么回。
 * @param {unknown} body 解析过的请求体
 * @param {{ get?: (name: string) => unknown }} [ctx] dsh 上下文，用来取 Web 端口
 */
function startUpgrade(body, ctx) {
  const input = body !== null && typeof body === 'object' ? body : {}
  const version = typeof input.version === 'string' ? input.version.trim() : ''
  const tag = typeof input.tag === 'string' ? input.tag.trim() : ''
  if (!VERSION_PATTERN.test(version)) return { status: 400, payload: { ok: false, error: 'bad-version' } }
  if (!TAG_PATTERN.test(tag) || tag.slice(TAG_PREFIX.length) !== version) {
    return { status: 400, payload: { ok: false, error: 'bad-tag' } }
  }
  const current = readJob()
  if (current !== null && current.state === 'running') return { status: 409, payload: { ok: false, error: 'busy' } }
  if (starting) return { status: 409, payload: { ok: false, error: 'busy' } }
  starting = true
  try {
    installCache.at = 0
    installCache.value = null
    const install = detectInstall()
    const plan = planFor(install, { version, tag })
    if (install.kind === 'unknown') return { status: 400, payload: { ok: false, error: 'unknown-install' } }
    if (plan.blocked !== null) {
      return { status: 409, payload: { ok: false, error: plan.blocked, detail: plan.blockedDetail } }
    }
    const paths = jobPaths()
    mkdirSync(paths.dir, { recursive: true })
    // 回退用分支名（有分支时），这样用户升级失败后还在原来那条线上。
    const branch = install.kind === 'source' ? gitSync(install.cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout : ''
    const head = install.kind === 'source' ? gitSync(install.cwd, ['rev-parse', '--short', 'HEAD']).stdout : ''
    const previous = branch !== '' && branch !== 'HEAD' ? branch : head
    const restart = install.kind === 'source'
      ? `cd ${displayPath(install.cwd)} && ${existsSync(join(install.cwd, 'start.sh')) ? './start.sh' : 'node apps/cli/lib/bin.js web'}`
      : 'dsh web'
    const rollback = install.kind === 'source'
      ? `cd ${displayPath(install.cwd)} && git checkout ${previous} && pnpm install --frozen-lockfile && pnpm run build`
      : `npm i -g ${PACKAGE_NAME}@${install.version}`
    // 全自动的条件：源码版、目录里有 start.sh、知道 Web 端口。
    let port = null
    try {
      const webServer = ctx?.get?.('webServer')
      if (webServer !== undefined && webServer !== null && typeof webServer.port === 'number') port = webServer.port
    } catch { /* 取不到端口就退回手动重启 */ }
    const autoRestart = install.kind === 'source' && existsSync(join(install.cwd, 'start.sh'))
      && typeof port === 'number' && port > 0
    const record = {
      id: 'up-' + Date.now().toString(36),
      version,
      tag,
      kind: install.kind,
      cwd: install.cwd,
      remote: plan.remote,
      previous,
      rollback,
      restart,
      auto: autoRestart,
      port,
      pid: process.pid,
      lock: join(paths.dir, 'building'),
      startedAt: Date.now(),
    }
    // 旧任务的文件先清掉，界面不会把上一轮的结果当成这一轮的。
    for (const stale of [paths.phase, paths.done]) {
      try { writeFileSync(stale, '') } catch { /* 无所谓 */ }
    }
    try { writeFileSync(paths.log, '') } catch { /* 无所谓 */ }
    // 构建锁先立起来：脚本跑起来之前，start.sh 就不许启动了。
    if (autoRestart) writeFileSync(record.lock, String(Date.now()))
    writeFileSync(paths.script, buildScript(install.kind, { ...record, dir: paths.dir }), { mode: 0o755 })
    writeFileSync(paths.job, JSON.stringify(record, null, 2))
    // writeFileSync 的 mode 只在新建时生效；已存在的老脚本补一次 chmod。
    try {
      const scriptStat = statSync(paths.script)
      if ((scriptStat.mode & 0o100) === 0) writeFileSync(paths.script, readFileSync(paths.script, 'utf8'), { mode: 0o755 })
    } catch { /* 无所谓 */ }
    const child = spawn('/bin/bash', [paths.script], {
      cwd: install.cwd ?? paths.dir,
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, CI: '1', GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0' },
    })
    child.on('error', (error) => {
      try {
        writeFileSync(paths.done, JSON.stringify({ exitCode: 127, finishedAt: Date.now(), detail: errorMessage(error) }))
        rmSync(record.lock, { force: true })
      } catch { /* 无所谓 */ }
    })
    child.unref()
    return { status: 200, payload: { ok: true, job: readJob() } }
  } catch (error) {
    try { rmSync(jobPaths().dir + '/building', { force: true }) } catch { /* 无所谓 */ }
    return { status: 500, payload: { ok: false, error: 'unknown', detail: errorMessage(error) } }
  } finally {
    starting = false
  }
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
    install: null,
  }
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

/**
 * 算一次状态。
 * state: available（有新版本）/ current（已最新）/ unknown（读不到本地版本）/ error（查不到）。
 * @param {object} ctx dsh 上下文
 * @param {boolean} force 是否绕过缓存
 */
async function buildStatus(ctx, force) {
  const status = emptyStatus()
  status.current = resolveLocalVersion()
  // 「重新检查」也重认一遍安装形态：提交完改动，按钮该马上可用。
  if (force) {
    installCache.at = 0
    installCache.value = null
  }
  const install = installFor()
  let upstream
  try {
    upstream = await releasesCached(ctx, force)
  } catch (error) {
    status.install = planFor(install, null)
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
  status.install = planFor(install, status.latest)
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

function sendJson(res, value, status = 200) {
  try {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    })
    res.end(JSON.stringify(value))
  } catch { /* socket gone */ }
}

/** 有连接服务就先过它的信任/鉴权闸门（防 DNS rebinding 和跨站请求）。 */
function rejected(ctx, req, res) {
  let connection
  try { connection = ctx.get?.('connection') } catch { return false }
  if (connection === undefined || connection === null || typeof connection.requestRejection !== 'function') return false
  let verdict
  try { verdict = connection.requestRejection(req) } catch { return false }
  if (verdict === undefined || verdict === null) return false
  try {
    res.writeHead(verdict)
    res.end()
  } catch { /* socket gone */ }
  return true
}

/** 读一个不超过 limit 字节的请求体；超了就返回 null。 */
function readBoundedBody(req, limit) {
  return new Promise((resolvePromise) => {
    const chunks = []
    let size = 0
    let finished = false
    const settle = (value) => {
      if (finished) return
      finished = true
      resolvePromise(value)
    }
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        chunks.length = 0
        try { req.destroy() } catch { /* 已断开 */ }
        settle(null)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => settle(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => settle(null))
    req.on('close', () => settle(null))
  })
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

async function handleUpgrade(req, res, ctx) {
  if (rejected(ctx, req, res)) return
  if (req.method === 'GET') {
    sendJson(res, { ok: true, job: readJob() })
    return
  }
  if (req.method !== 'POST') {
    try {
      res.writeHead(405, { Allow: 'GET, POST' })
      res.end()
    } catch { /* socket gone */ }
    return
  }
  const essence = String(req.headers['content-type']).split(';', 1)[0]?.trim().toLowerCase()
  if (essence !== 'application/json') {
    sendJson(res, { ok: false, error: 'unsupported-media-type' }, 415)
    return
  }
  const text = await readBoundedBody(req, MAX_BODY_BYTES)
  if (text === null) {
    sendJson(res, { ok: false, error: 'body-too-large' }, 413)
    return
  }
  let body
  try {
    body = JSON.parse(text)
  } catch {
    sendJson(res, { ok: false, error: 'bad-json' }, 400)
    return
  }
  if (body === null || typeof body !== 'object' || body.confirm !== true) {
    sendJson(res, { ok: false, error: 'not-confirmed' }, 400)
    return
  }
  const result = startUpgrade(body, ctx)
  sendJson(res, result.payload, result.status)
}

export function apply(ctx) {
  const webServer = ctx.get('webServer')
  if (webServer === undefined) return
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: ROUTE_STATUS,
    handler: (req, res) => void handleStatus(req, res, ctx),
  }), 'dsh-version-check: status route')
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: ROUTE_UPGRADE,
    handler: (req, res) => void handleUpgrade(req, res, ctx),
  }), 'dsh-version-check: upgrade route')
}

/** 测试用内部函数，cordis 不读这个导出。 */
export const __internals = {
  parseVersion,
  compareVersions,
  resolveLocalVersion,
  localManifest,
  detectInstall,
  planFor,
  pickRemote,
  startUpgrade,
  readJob,
  buildScript,
  jobPaths,
  fetchReleases,
  buildStatus,
}
