/**
 * dsh-version-check host 逻辑验证（会真实访问 GitHub Releases，只读）。
 *
 * 覆盖：
 *  1. semver 解析与比较（含 rc / alpha 预发布规则）；
 *  2. 从 dsh 启动入口读出本机版本；
 *  3. 真实查询官方 Release，并按当前版本算出 available / current；
 *  4. 路由注册与返回字段。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

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
  let resolveDone
  const done = new Promise((resolve) => { resolveDone = resolve })
  const res = {
    writeHead() { return res },
    end(chunk) { body = typeof chunk === 'string' ? chunk : String(chunk); resolveDone() },
  }
  return { res, done, get body() { return body } }
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
  check('最新版本高于 0.2.1-rc.5 时 state 为 available', status.latest.version === '0.2.1-rc.5' || status.state === 'available', status.latest.version)
  check('latest 带发布页链接', typeof status.latest.url === 'string' && status.latest.url.startsWith('https://github.com/'), String(status.latest.url))
  check('latest 带发布时间', typeof status.latest.publishedAt === 'string', String(status.latest.publishedAt))
  check('预发布标记是布尔', typeof status.latest.prerelease === 'boolean')
}

for (const cleanup of cleanups) cleanup()

console.log(failed === 0 ? '\n全部通过' : '\n失败 ' + failed + ' 项')
process.exitCode = failed === 0 ? 0 : 1
