/**
 * dsh-version-check host 逻辑验证（会真实访问 GitHub Releases，只读）。
 *
 * 覆盖：
 *  1. semver 解析与比较（含 rc / alpha 预发布规则）；
 *  2. 从 dsh 启动入口读出本机版本；
 *  3. 真实查询官方 Release，并按当前版本算出 available / current；
 *  4. 路由注册与返回字段；
 *  5. 安装形态识别、升级命令、升级路由的拒绝路径（不会真的启动升级）。
 */
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 状态目录指到临时目录，测试不碰真实的 ~/.dsh。 */
process.env.DSH_VERSION_CHECK_STATE_DIR = mkdtempSync(join(tmpdir(), 'dsvc-test-'))

let failed = 0
function check(name, condition, detail) {
  if (condition) console.log('  ✓ ' + name)
  else {
    failed += 1
    console.log('  ✗ ' + name + (detail === undefined ? '' : '  — ' + detail))
  }
}

const CLI_ENTRY = '/Users/leeo/Code/deepseek-harness/apps/cli/lib/bin.js'
process.argv[1] = CLI_ENTRY

const mod = await import('./host.js')
const internals = mod.__internals
const { parseVersion, compareVersions } = internals

console.log('semver 解析')
check('普通版本', parseVersion('0.2.1') !== null)
check('预发布版本', parseVersion('v0.2.2-rc.2') !== null)
check('乱写的版本不接受', parseVersion('latest') === null, String(parseVersion('latest')))
check('缺段落不接受', parseVersion('0.2') === null)

console.log('semver 比较')
const cmp = (a, b) => compareVersions(parseVersion(a), parseVersion(b))
check('0.2.2 > 0.2.1', cmp('0.2.2', '0.2.1') === 1)
check('0.2.1-rc.5 < 0.2.1', cmp('0.2.1-rc.5', '0.2.1') === -1)
check('0.2.1-rc.12 > 0.2.1-rc.5', cmp('0.2.1-rc.12', '0.2.1-rc.5') === 1)
check('0.2.2-rc.2 > 0.2.1-rc.5', cmp('0.2.2-rc.2', '0.2.1-rc.5') === 1)
check('alpha < rc', cmp('0.2.2-alpha.3', '0.2.2-rc.1') === -1)
check('相同版本相等', cmp('0.2.1-rc.5', '0.2.1-rc.5') === 0)

console.log('本机版本')
const expected = JSON.parse(readFileSync('/Users/leeo/Code/deepseek-harness/apps/cli/package.json', 'utf8')).version
const localVersion = internals.resolveLocalVersion()
check('从入口读出 @deepseek-ai/dsh 版本', localVersion === expected, String(localVersion) + ' vs ' + expected)

console.log('路由与线上状态')
const handlers = {}
const cleanups = []
const webServer = {
  register(entry) {
    handlers[entry.path] = entry.handler
    return () => { delete handlers[entry.path] }
  },
}
const ctx = {
  get(name) { return name === 'webServer' ? webServer : undefined },
  effect(fn) { const result = fn(); if (typeof result === 'function') cleanups.push(result); return cleanups.length },
}
mod.apply(ctx)
check('status 路由已注册', typeof handlers['/plugins/dsh-version-check/status'] === 'function')

function makeRes() {
  let body = ''
  let status = 200
  let resolveDone
  const done = new Promise((resolve) => { resolveDone = resolve })
  const res = {
    get status() { return status },
    writeHead(code) { status = code; return res },
    end(chunk) { body = typeof chunk === 'string' ? chunk : String(chunk); resolveDone() },
  }
  return { res, done, get body() { return body }, get status() { return status } }
}

const out = makeRes()
await handlers['/plugins/dsh-version-check/status']({ url: '/plugins/dsh-version-check/status?refresh=1', method: 'GET' }, out.res)
await out.done
const status = JSON.parse(out.body)
if (status.ok !== true) {
  console.log('  ! GitHub 不可达或配额用完，跳过线上检查：' + status.error)
} else {
  check('状态字段齐全', ['state', 'current', 'latest', 'checkedAt'].every((key) => key in status), JSON.stringify(Object.keys(status)))
  check('本机版本一致', status.current === expected, String(status.current))
  check('拿到最新 Release', status.latest !== null && typeof status.latest.version === 'string', JSON.stringify(status.latest))
  const latestParsed = parseVersion(status.latest.version)
  const currentParsed = parseVersion(status.current)
  const expectedState = compareVersions(latestParsed, currentParsed) > 0 ? 'available' : 'current'
  check('state 与比较结果一致', status.state === expectedState, status.state + ' vs ' + expectedState)
  const newer = compareVersions(latestParsed, currentParsed) > 0
  check('latest 比本机新时 state 为 available', !newer || status.state === 'available', status.state)
  check('latest 带发布页链接', typeof status.latest.url === 'string' && status.latest.url.startsWith('https://github.com/'), String(status.latest.url))
  check('latest 带发布时间', typeof status.latest.publishedAt === 'string', String(status.latest.publishedAt))
  check('预发布标记是布尔', typeof status.latest.prerelease === 'boolean')
}

console.log('安装形态与升级计划')
const install = internals.detectInstall()
check('认出源码仓库', install.kind === 'source', JSON.stringify(install))
check('仓库根就是 dsh 检出目录', install.cwd === '/Users/leeo/Code/deepseek-harness', String(install.cwd))
const plan = internals.planFor(install, { version: '9.9.9-rc.1', tag: 'dsh-v9.9.9-rc.1' })
check('升级命令带目标 tag', typeof plan.command === 'string' && plan.command.includes('dsh-v9.9.9-rc.1'), String(plan.command))
check('命令含 fetch / checkout / install / build',
  ['git fetch', 'checkout', 'pnpm install', 'pnpm run build'].every((part) => plan.command.includes(part)), String(plan.command))
check('命令从仓库根开始', typeof plan.command === 'string' && plan.command.startsWith('cd ' + install.cwd), String(plan.command))
check('没有未提交改动时可以升级', plan.canUpgrade === true, String(plan.blocked) + ' ' + String(plan.blockedDetail))
check('远程优先 origin', plan.remote === 'origin', String(plan.remote))
check('没有最新版本时不能升级', internals.planFor(install, null).canUpgrade === false)
const scriptDir = join(process.env.DSH_VERSION_CHECK_STATE_DIR, 'upgrade')
const scriptOptions = {
  dir: scriptDir, cwd: install.cwd, remote: 'origin', tag: 'dsh-v9.9.9-rc.1', version: '9.9.9-rc.1',
  lock: join(scriptDir, 'building'), previous: 'upgrade/v0.2.1-rc.5', port: 3080, pid: 4242, auto: true,
}
const script = internals.buildScript('source', scriptOptions)
check('脚本逐个 phase 推进', ['step fetch', 'step checkout', 'step install', 'step build', 'finish 0'].every((part) => script.includes(part)))
check('脚本对失败留痕', script.includes('>"$DIR/done"'))
check('先停旧的再动手', script.indexOf('stop_ui\n') > 0 && script.indexOf('stop_ui') < script.indexOf('step fetch'), String(script.indexOf('stop_ui')))
check('构建完自己起回来并刷新', script.includes('restart_ui') && script.includes('./start.sh --refresh'))
check('停的时候按 pid 发 TERM', script.includes('kill -TERM "$SERVER_PID"'))
check('失败先回退再重启', script.includes('phase rollback') && script.includes('git checkout "$PREVIOUS"'))
check('结束时清掉构建锁', script.includes('rm -f "$LOCK"'))
const manualScript = internals.buildScript('source', { ...scriptOptions, auto: false })
check('没有 start.sh 时不自动重启', manualScript.includes('AUTO=0') && manualScript.includes('[ "$AUTO" = "1" ] || return 0'))

console.log('升级路由')
const upgradeRoute = handlers['/plugins/dsh-version-check/upgrade']
check('upgrade 路由已注册', typeof upgradeRoute === 'function')

function makeReq(options) {
  const req = new EventEmitter()
  req.method = options.method
  req.url = options.url
  req.headers = options.headers ?? {}
  setImmediate(() => {
    if (typeof options.body === 'string' && options.body !== '') req.emit('data', Buffer.from(options.body))
    req.emit('end')
  })
  return req
}

async function callUpgrade(options) {
  const out2 = makeRes()
  await upgradeRoute(makeReq(options), out2.res)
  await out2.done
  return out2
}

const getJob = await callUpgrade({ method: 'GET', url: '/plugins/dsh-version-check/upgrade' })
const getJobBody = JSON.parse(getJob.body)
check('GET 返回当前没有任务', getJob.status === 200 && getJobBody.ok === true && getJobBody.job === null, getJob.body)

const wrongType = await callUpgrade({
  method: 'POST', url: '/plugins/dsh-version-check/upgrade',
  headers: { 'content-type': 'text/plain' }, body: '{}',
})
check('非 JSON 请求体被拒', wrongType.status === 415, String(wrongType.status))

const unconfirmed = await callUpgrade({
  method: 'POST', url: '/plugins/dsh-version-check/upgrade',
  headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version: '9.9.9-rc.1', tag: 'dsh-v9.9.9-rc.1' }),
})
check('没带 confirm 不启动', unconfirmed.status === 400 && JSON.parse(unconfirmed.body).error === 'not-confirmed', unconfirmed.body)

const badVersion = await callUpgrade({
  method: 'POST', url: '/plugins/dsh-version-check/upgrade',
  headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version: 'latest', tag: 'dsh-v9.9.9-rc.1', confirm: true }),
})
check('版本号不合法就不启动', badVersion.status === 400 && JSON.parse(badVersion.body).error === 'bad-version', badVersion.body)

const tagMismatch = await callUpgrade({
  method: 'POST', url: '/plugins/dsh-version-check/upgrade',
  headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version: '9.9.9-rc.1', tag: 'dsh-v0.2.1-rc.5', confirm: true }),
})
check('tag 与版本对不上就不启动', tagMismatch.status === 400 && JSON.parse(tagMismatch.body).error === 'bad-tag', tagMismatch.body)

check('被拒绝的请求没有留下任务', internals.readJob() === null)

for (const cleanup of cleanups) cleanup()

console.log(failed === 0 ? '\n全部通过' : '\n失败 ' + failed + ' 项')
process.exitCode = failed === 0 ? 0 : 1
