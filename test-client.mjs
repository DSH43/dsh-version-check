/**
 * dsh-version-check 客户端注册验证（无浏览器）。
 *
 * 覆盖：
 *  1. 品牌名槽位空着时，注册进 sidebar.brand.name；
 *  2. 品牌名槽位被占（官方构建）时，退回 sidebar.footer.action；
 *  3. 登记 locale 词典，注册项带 locale；
 *  4. 样式只注入一次，缺 slots 不抛。
 */
let failed = 0
function check(name, condition, detail) {
  if (condition) console.log('  ✓ ' + name)
  else {
    failed += 1
    console.log('  ✗ ' + name + (detail === undefined ? '' : '  — ' + detail))
  }
}

const styleIds = new Set()
const headChildren = []
const fakeDocument = {
  documentElement: { lang: 'zh-CN' },
  head: { appendChild(node) { headChildren.push(node) } },
  body: {},
  getElementById(id) { return styleIds.has(id) ? { id } : null },
  createElement(tag) {
    const node = { tagName: tag.toUpperCase(), id: '', textContent: '' }
    Object.defineProperty(node, 'id', {
      get() { return this._id ?? '' },
      set(value) { this._id = value; styleIds.add(value) },
    })
    return node
  },
  addEventListener() {},
  removeEventListener() {},
}

const React = {
  createElement(type, props, ...children) { return { type, props, children } },
  Fragment: 'Fragment',
  useState(value) { return [value, () => {}] },
  useEffect() {},
  useCallback(fn) { return fn },
  useRef(value) { return { current: value ?? null } },
}
const ReactDOM = {
  createPortal(node) { return node },
  createRoot() { return { render() {}, unmount() {} } },
}

let factory = null
globalThis.window = { __ModuleLoader__: { load(spec) { factory = spec.factory } } }
globalThis.document = fakeDocument

await import('./client.js')
check('通过 __ModuleLoader__.load 注册', typeof factory === 'function')

const mod = factory((name) => {
  if (name === 'react') return React
  if (name === 'react-dom') return ReactDOM
  throw new Error('unexpected require: ' + name)
})
check('插件名正确', mod.name === 'dsh-version-check', String(mod.name))

/** 造一个槽位服务：entries 可配，记录注册进哪个槽。 */
function makeSlots({ brandOccupied = false } = {}) {
  const registrations = []
  const slots = {
    brandOccupied,
    inject(name, callback) {
      this.injected = this.injected ?? []
      this.injected.push(name)
      return callback()
    },
    entries(name) {
      if (name === 'sidebar.brand.name') return brandOccupied ? [{ id: 'official' }] : []
      return []
    },
    register(options, component) {
      registrations.push({ options, component })
      return () => {}
    },
  }
  return { slots, registrations }
}

const locale = { register() {} }
const ctxFor = (slots) => ({
  get(name) {
    if (name === 'slots') return slots
    if (name === 'locale') return locale
    return undefined
  },
})

console.log('品牌位空着')
const brand = makeSlots({ brandOccupied: false })
mod.apply(ctxFor(brand.slots))
check('注册进 sidebar.brand.name', brand.registrations.length === 1 && brand.registrations[0].options.name === 'sidebar.brand.name',
  JSON.stringify(brand.registrations.map((r) => r.options.name)))
check('品牌注册项带 locale', brand.registrations[0].options.locale === 'versionCheck', String(brand.registrations[0].options.locale))
check('品牌组件是函数', typeof brand.registrations[0].component === 'function')

console.log('品牌位被官方占着')
const footer = makeSlots({ brandOccupied: true })
mod.apply(ctxFor(footer.slots))
check('退回 sidebar.footer.action', footer.registrations.length === 1 && footer.registrations[0].options.name === 'sidebar.footer.action',
  JSON.stringify(footer.registrations.map((r) => r.options.name)))
check('底部注册项有 id', footer.registrations[0].options.id === 'version-check', String(footer.registrations[0].options.id))
check('底部组件是函数', typeof footer.registrations[0].component === 'function')

console.log('杂项')
check('样式只注入一次', headChildren.length === 1, String(headChildren.length))
mod.apply(ctxFor(makeSlots().slots))
check('重复 apply 不重复注入样式', headChildren.length === 1, String(headChildren.length))
mod.apply({ get() { return undefined } })
check('缺 slots 时不抛', true)

const bareMod = factory((name) => (name === 'react' ? React : ReactDOM))
check('缺 locale 也能注册', (() => {
  const bare = makeSlots()
  bareMod.apply({ get: (name) => (name === 'slots' ? bare.slots : undefined) })
  return bare.registrations.length === 1
})())

console.log('弹窗渲染')
const { createRequire } = await import('node:module')
const webRequire = createRequire('/Users/leeo/Code/deepseek-harness/apps/web/package.json')
const realReact = webRequire('react')
const realServer = webRequire('react-dom/server')
const realReactDOM = webRequire('react-dom')

/** 用真 React 再建一份模块实例：假的 React 只造对象，渲染验证必须用真的。 */
const realMod = factory((name) => {
  if (name === 'react') return realReact
  if (name === 'react-dom') return realReactDOM
  throw new Error('unexpected require: ' + name)
})
const { VersionDialog, UpdateBlock } = realMod.__components

const dict = {
  dialogTitle: 'DSH 版本更新',
  currentLabel: '当前版本',
  latestLabel: '官方最新',
  published: '发布时间',
  prerelease: '预发布',
  howTo: '更新方式',
  refresh: '重新检查',
  openRelease: '打开发布页',
  close: '关闭',
  copyCommand: '复制命令',
  copied: '已复制',
  copyFailed: '复制失败',
  upgradeTo: '升级到 {v}',
  confirmUpgrade: '确认升级到 {v}',
  cancel: '取消',
  confirmNote: '会跑 git checkout、pnpm install 和构建',
  upgradingTo: '正在升级到 {v}',
  phaseStart: '启动中',
  phaseFetch: '拉取新版本',
  phaseCheckout: '切换版本',
  phaseInstall: '安装依赖',
  phaseBuild: '重新构建',
  phaseVerify: '收尾',
  restartAfter: '构建完成后会提示重启。',
  restartHint: '重启让它生效：{cmd}',
  upgradeDone: '已升级到 {v}',
  versionMismatch: '装完读到的版本是 {v}',
  upgradeFailed: '升级失败（退出码 {code}）',
  rollbackHint: '退回原来的版本：{cmd}',
  startFailed: '升级没能启动：{code}',
  blockedDirty: '仓库有未提交的改动',
  blockedNoGit: '找不到可用的 git。',
  blockedNoPnpm: '找不到 pnpm。',
  blockedNoRemote: '这个仓库没配 git remote。',
  blockedNoNpm: '找不到 npm。',
  blockedUnknown: '认不出这台机器上的安装方式。',
  blockedNoVersion: '还没查到官方最新版本。',
  noCommand: '没有可用的升级命令。',
  unknownCurrent: '读不到本地版本',
  checkFailed: '检查失败',
  sourceHint: '源码运行：git pull 之后重新 pnpm install',
  npmHint: '全局安装：npm i -g @deepseek-ai/dsh@latest',
}
function t(key, params) {
  const template = dict[key] === undefined ? key : dict[key]
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (_, name) => (params[name] === undefined ? '' : String(params[name])))
}

const latest = { version: '0.2.2-rc.2', tag: 'dsh-v0.2.2-rc.2', prerelease: true, publishedAt: '2026-11-11T00:00:00Z', url: 'https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.2' }
const install = {
  kind: 'source', cwd: '/tmp/repo', command: 'cd /tmp/repo && git fetch --tags origin && git checkout dsh-v0.2.2-rc.2',
  canUpgrade: true, blocked: null, blockedDetail: null, remote: 'origin',
}
const statusData = { ok: true, state: 'available', current: '0.2.1-rc.5', latest, install }

function render(component, props) {
  return realServer.renderToStaticMarkup(realReact.createElement(component, props))
}

let dialogHtml = ''
try {
  dialogHtml = render(VersionDialog, {
    t, data: statusData, error: null, loading: false,
    onClose() {}, onRefresh() {},
  })
  check('弹窗能渲染', dialogHtml.length > 0)
} catch (error) {
  check('弹窗能渲染', false, error instanceof Error ? error.message : String(error))
}
check('显示升级按钮和版本', dialogHtml.includes('升级到 0.2.2-rc.2'), dialogHtml.slice(0, 200))
check('显示复制命令按钮', dialogHtml.includes('复制命令'))
check('显示升级命令', dialogHtml.includes('git checkout dsh-v0.2.2-rc.2'))

const runningHtml = render(UpdateBlock, {
  t, install, latest, current: '0.2.1-rc.5', available: true, copied: false, confirming: false, busy: false, error: null,
  job: { state: 'running', phase: 'build', version: '0.2.2-rc.2', log: ['adding 42 packages', 'building web'], exitCode: null, rollback: null, restart: null },
  onCopy() {}, onUpgrade() {}, onConfirm() {}, onCancel() {},
})
check('升级中显示阶段和目标版本', runningHtml.includes('正在升级到 0.2.2-rc.2') && runningHtml.includes('重新构建'), runningHtml.slice(0, 300))
check('升级中显示日志', runningHtml.includes('building web'))
check('升级中显示进度条', runningHtml.includes('dsvc-bar'))

const doneHtml = render(UpdateBlock, {
  t, install, latest, current: '0.2.1-rc.5', available: true, copied: false, confirming: false, busy: false, error: null,
  job: { state: 'done', phase: 'verify', version: '0.2.2-rc.2', installedVersion: '0.2.2-rc.2', log: ['done'], exitCode: 0, rollback: 'git checkout b830ec9', restart: 'cd /tmp/repo && ./start.sh' },
  onCopy() {}, onUpgrade() {}, onConfirm() {}, onCancel() {},
})
check('成功后给出重启命令', doneHtml.includes('已升级到 0.2.2-rc.2') && doneHtml.includes('重启让它生效'), doneHtml.slice(0, 300))

const failedHtml = render(UpdateBlock, {
  t, install, latest, current: '0.2.1-rc.5', available: true, copied: false, confirming: false, busy: false, error: null,
  job: { state: 'failed', phase: 'build', version: '0.2.2-rc.2', log: ['error TS1234'], exitCode: 1, rollback: 'git checkout b830ec9' },
  onCopy() {}, onUpgrade() {}, onConfirm() {}, onCancel() {},
})
check('失败时显示退出码', failedHtml.includes('升级失败（退出码 1）'), failedHtml.slice(0, 300))
check('失败时显示回退命令', failedHtml.includes('git checkout b830ec9'))
check('失败时保留日志', failedHtml.includes('error TS1234'))

const blockedHtml = render(UpdateBlock, {
  t, install: { ...install, canUpgrade: false, blocked: 'dirty', blockedDetail: 'M host.js' }, latest,
  current: '0.2.1-rc.5', available: true, copied: false, confirming: false, busy: false, error: null, job: null,
  onCopy() {}, onUpgrade() {}, onConfirm() {}, onCancel() {},
})
check('有未提交改动时说明原因', blockedHtml.includes('仓库有未提交的改动'), blockedHtml.slice(0, 300))
check('有未提交改动时升级按钮禁用', blockedHtml.includes('disabled'))

const legacyHtml = render(UpdateBlock, {
  t, install: null, latest: null, current: null, available: false, copied: false, confirming: false, busy: false, error: null, job: null,
  onCopy() {}, onUpgrade() {}, onConfirm() {}, onCancel() {},
})
check('老版本 host 退回两行说明', legacyHtml.includes('git pull') && legacyHtml.includes('npm i -g @deepseek-ai/dsh@latest'), legacyHtml.slice(0, 200))

const upToDateHtml = render(UpdateBlock, {
  t, install, latest, current: '0.2.2-rc.2', available: false, copied: false, confirming: false, busy: false, error: null, job: null,
  onCopy() {}, onUpgrade() {}, onConfirm() {}, onCancel() {},
})
check('已是最新时不显示升级按钮', !upToDateHtml.includes('dsvc-btn-primary') && upToDateHtml.includes('复制命令'), upToDateHtml.slice(0, 300))

const appliedHtml = render(UpdateBlock, {
  t, install, latest, current: '0.2.2-rc.2', available: false, copied: false, confirming: false, busy: false, error: null,
  job: { state: 'done', phase: 'verify', version: '0.2.2-rc.2', installedVersion: '0.2.2-rc.2', log: ['ok'], exitCode: 0, restart: 'cd /tmp/repo && ./start.sh', finishedAt: Date.now() },
  onCopy() {}, onUpgrade() {}, onConfirm() {}, onCancel() {},
})
check('装完又重启过就不显示那条完成记录', !appliedHtml.includes('已升级到') && !appliedHtml.includes('重启让它生效'), appliedHtml.slice(0, 300))

const staleHtml = render(UpdateBlock, {
  t, install, latest, current: '0.2.1-rc.5', available: true, copied: false, confirming: false, busy: false, error: null,
  job: { state: 'failed', phase: 'build', version: '0.2.2-rc.2', log: ['boom'], exitCode: 1, rollback: 'git checkout main', finishedAt: Date.now() - 5 * 60 * 60 * 1000 },
  onCopy() {}, onUpgrade() {}, onConfirm() {}, onCancel() {},
})
check('五小时前的失败记录收起来', !staleHtml.includes('升级失败'), staleHtml.slice(0, 200))

console.log(failed === 0 ? '\n全部通过' : '\n失败 ' + failed + ' 项')
process.exitCode = failed === 0 ? 0 : 1
