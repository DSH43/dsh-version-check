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

console.log(failed === 0 ? '\n全部通过' : '\n失败 ' + failed + ' 项')
process.exitCode = failed === 0 ? 0 : 1
