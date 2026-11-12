/**
 * dsh-version-check 客户端模块。
 *
 * 位置：侧栏 logo 右边的品牌名区域（sidebar.brand.name），也就是现在显示
 * 「DSH 本地构建 / 0.2.1-rc.5」的地方。占用了这个槽位就自己画出同样两行，
 * 第二行换成「当前版本 → 官方最新」：
 *   - 有新版本：蓝字 + 箭头 + 蓝底新版本号；
 *   - 已最新：灰字「已最新」；
 *   - 检查中：灰字「检查中」；
 *   - 查不到：黄字「检查失败」，不冒充已最新；
 *   - 读不到本地版本：灰字「读不到本地版本」。
 * 点一下弹出小面板：当前版本、官方最新、发布时间、发布页链接、更新方式、重新检查。
 *
 * 官方构建（ui-brand-official）会先占住品牌名槽位，这时退回侧栏底部的列表槽位，
 * 内容一样，只是位置不同。
 *
 * dsh 客户端加载器用经典 <script> 拉取本文件，需 window.__ModuleLoader__.load 注册；
 * react / react-dom 是平台种子模块，可直接 require。
 */
window.__ModuleLoader__.load({
  id: 'dsh-version-check',
  factory: function (require) {
    var React = require('react')
    var ReactDOM = require('react-dom')
    var h = React.createElement
    var useState = React.useState
    var useEffect = React.useEffect
    var useCallback = React.useCallback
    var useRef = React.useRef

    var NS = 'versionCheck'
    var POLL_MS = 30 * 60 * 1000
    var STATUS_URL = '/plugins/dsh-version-check/status'

    var STRINGS = {
      zh: {
        localBuild: 'DSH 本地构建',
        checking: '检查中',
        upToDate: '已最新',
        newVersion: '有新版本',
        checkFailed: '检查失败',
        unknownCurrent: '读不到本地版本',
        prerelease: '预发布',
        title: 'DSH 版本',
        currentLabel: '当前版本',
        latestLabel: '官方最新',
        published: '发布时间',
        releasedAt: '发布于 {date}',
        dialogTitle: 'DSH 版本更新',
        howTo: '更新方式',
        sourceHint: '源码运行：git pull 之后重新 pnpm install',
        npmHint: '全局安装：npm i -g @deepseek-ai/dsh@latest',
        refresh: '重新检查',
        openRelease: '打开发布页',
        close: '关闭',
        noReleases: '官方仓库没有找到 dsh-v* 的 Release',
        errNetwork: '连不上 GitHub',
        errHttp: 'GitHub 接口请求失败',
        errRateLimit: 'GitHub 限流',
        errPayload: 'GitHub 返回的数据看不懂',
        errNoReleases: '官方仓库里没有 dsh-v* 的 Release',
        errUnknown: '检查失败',
        label: '版本',
        justNow: '刚刚',
        minutesAgo: '{n} 分钟前',
        hoursAgo: '{n} 小时前',
        daysAgo: '{n} 天前',
      },
      en: {
        localBuild: 'DSH Local Build',
        checking: 'checking',
        upToDate: 'up to date',
        newVersion: 'new version',
        checkFailed: 'check failed',
        unknownCurrent: 'unknown version',
        prerelease: 'pre-release',
        title: 'DSH version',
        currentLabel: 'Current',
        latestLabel: 'Latest',
        published: 'Published',
        releasedAt: 'released {date}',
        dialogTitle: 'DSH version update',
        howTo: 'How to update',
        sourceHint: 'From source: git pull, then pnpm install',
        npmHint: 'Global install: npm i -g @deepseek-ai/dsh@latest',
        refresh: 'Recheck',
        openRelease: 'Open release',
        close: 'Close',
        noReleases: 'No dsh-v* release found in the official repository',
        errNetwork: 'Cannot reach GitHub',
        errHttp: 'GitHub API request failed',
        errRateLimit: 'GitHub rate limit',
        errPayload: 'Unexpected payload from GitHub',
        errNoReleases: 'No dsh-v* release in the official repository',
        errUnknown: 'Check failed',
        label: 'Version',
        justNow: 'just now',
        minutesAgo: '{n} min ago',
        hoursAgo: '{n} h ago',
        daysAgo: '{n} d ago',
      },
    }

    /** 没有 locale 服务时的兜底翻译。 */
    function fallbackT(key, params) {
      var lang = typeof document !== 'undefined' && String(document.documentElement.lang || '').indexOf('zh') === 0 ? 'zh' : 'en'
      var dict = STRINGS[lang]
      var template = dict[key] !== undefined ? dict[key] : STRINGS.zh[key]
      if (typeof template !== 'string') return ''
      if (params === undefined) return template
      return template.replace(/\{(\w+)\}/g, function (_, name) {
        return params[name] !== undefined ? String(params[name]) : ''
      })
    }

    function relativeTime(timestamp, t) {
      if (typeof timestamp !== 'number') return '—'
      var seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000))
      if (seconds < 60) return t('justNow')
      var minutes = Math.round(seconds / 60)
      if (minutes < 60) return t('minutesAgo', { n: minutes })
      var hours = Math.round(minutes / 60)
      if (hours < 24) return t('hoursAgo', { n: hours })
      return t('daysAgo', { n: Math.round(hours / 24) })
    }

    var ICON_CLOSE = h('svg', {
      viewBox: '0 0 24 24', width: 16, height: 16, fill: 'none',
      stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', 'aria-hidden': 'true',
    }, h('path', { d: 'M18 6 6 18M6 6l12 12' }))

    var ICON_REFRESH = h('svg', {
      viewBox: '0 0 24 24', width: 14, height: 14, fill: 'none',
      stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true',
    },
      h('path', { d: 'M21 12a9 9 0 1 1-2.64-6.36' }),
      h('path', { d: 'M21 3v6h-6' }),
    )

    var ICON_EXTERNAL = h('svg', {
      viewBox: '0 0 24 24', width: 14, height: 14, fill: 'none',
      stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true',
    },
      h('path', { d: 'M14 4h6v6' }),
      h('path', { d: 'M20 4 11 13' }),
      h('path', { d: 'M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5' }),
    )

    /**
     * 弹窗挂到独立的 React 根，不放进品牌位那棵组件树里。
     *
     * 为什么：品牌名这一块本身在侧栏「新建会话」的 <button> 里，用 createPortal
     * 渲染的弹窗虽然 DOM 在 body 上，React 事件仍按组件树冒泡回那个 button——
     * 点弹窗里的任何东西（包括关闭）都会触发新建会话。独立根不存在这条边。
     */
    function useDialogRoot(open, render) {
      var root = useRef(null)
      var host = useRef(null)
      useEffect(function () {
        if (open !== true) {
          if (root.current !== null) { root.current.unmount(); root.current = null }
          if (host.current !== null) { host.current.remove(); host.current = null }
          return
        }
        if (root.current === null) {
          var element = document.createElement('div')
          element.className = 'dsvc-portal'
          document.body.appendChild(element)
          host.current = element
          root.current = ReactDOM.createRoot(element)
        }
        root.current.render(render())
      })
      useEffect(function () {
        return function () {
          if (root.current !== null) root.current.unmount()
          if (host.current !== null) host.current.remove()
          root.current = null
          host.current = null
        }
      }, [])
    }

    function useVersionStatus() {
      var pair = useState({ data: null, error: null, loading: true })
      var state = pair[0]
      var setState = pair[1]
      var refresh = useCallback(function (force) {
        setState(function (previous) { return { data: previous.data, error: previous.error, loading: true } })
        var url = STATUS_URL + (force === true ? '?refresh=1' : '')
        fetch(url, { cache: 'no-store' })
          .then(function (response) { return response.json() })
          .then(function (result) {
            if (result !== null && typeof result === 'object' && result.ok === true) {
              setState({ data: result, error: null, loading: false })
              return
            }
            // 查失败时宿主机也会给出当前版本；留着它，界面上版本号不至于消失。
            var failure = {
              code: (result !== null && typeof result === 'object' && typeof result.error === 'string') ? result.error : 'unknown',
              detail: (result !== null && typeof result === 'object' && typeof result.detail === 'string') ? result.detail : '',
            }
            var carriesVersion = result !== null && typeof result === 'object' && typeof result.current === 'string'
            setState(function (previous) {
              return { data: carriesVersion ? result : previous.data, error: failure, loading: false }
            })
          })
          .catch(function (error) {
            setState(function (previous) {
              return {
                data: previous.data,
                error: { code: 'network', detail: String((error && error.message) || error) },
                loading: false,
              }
            })
          })
      }, [])
      useEffect(function () {
        refresh(false)
        var timer = setInterval(function () { refresh(false) }, POLL_MS)
        return function () { clearInterval(timer) }
      }, [refresh])
      return { data: state.data, error: state.error, loading: state.loading, refresh: refresh }
    }

    /** 当前该显示哪个状态：查失败优先报失败，别让上一次的「可用」一直挂着。 */
    function stateOf(data, error) {
      if (error !== null && error !== undefined) return 'error'
      if (data !== null && typeof data === 'object' && typeof data.state === 'string') return data.state
      return 'checking'
    }

    function versionInfo(data, error) {
      var status = stateOf(data, error)
      var current = data !== null && typeof data.current === 'string' ? data.current : null
      var latest = data !== null && data.latest !== null && typeof data.latest === 'object' ? data.latest : null
      return { status: status, current: current, latest: latest }
    }

    /** 把宿主机给的错误码翻成当前语言，细节（如 HTTP 404）拼在后面。 */
    function errorText(t, error) {
      if (error === null || error === undefined) return ''
      var code = typeof error === 'object' ? error.code : String(error)
      var detail = typeof error === 'object' && typeof error.detail === 'string' ? error.detail : ''
      var labels = {
        network: 'errNetwork',
        http: 'errHttp',
        'rate-limit': 'errRateLimit',
        payload: 'errPayload',
        'no-releases': 'errNoReleases',
        unknown: 'errUnknown',
      }
      var key = labels[code]
      var text = key === undefined ? (detail || t('errUnknown')) : t(key)
      if (key !== undefined && detail !== '' && code !== 'network') text = text + ' · ' + detail
      return text
    }

    var STATE_COLOR = {
      available: 'dsvc-state-available',
      current: 'dsvc-state-muted',
      checking: 'dsvc-state-muted',
      unknown: 'dsvc-state-warn',
      error: 'dsvc-state-warn',
    }

    function stateText(t, info) {
      if (info.status === 'available' && info.latest !== null) return '→ ' + info.latest.version
      if (info.status === 'current') return t('upToDate')
      if (info.status === 'unknown') return t('unknownCurrent')
      if (info.status === 'error') return t('checkFailed')
      return t('checking')
    }

    function tooltipText(t, info) {
      if (info.status === 'available' && info.latest !== null) {
        return t('newVersion') + ' ' + info.latest.version + (info.latest.prerelease === true ? ' （' + t('prerelease') + '）' : '')
      }
      if (info.status === 'current') return t('upToDate') + (info.current !== null ? ' ' + info.current : '')
      if (info.status === 'unknown') return t('unknownCurrent')
      if (info.status === 'error') return t('checkFailed')
      return t('checking') + '…'
    }

    function VersionDialog(props) {
      var t = props.t
      var info = versionInfo(props.data, props.error)
      var latest = info.latest

      useEffect(function () {
        function onKeyDown(event) {
          if (event.key === 'Escape') props.onClose()
        }
        document.addEventListener('keydown', onKeyDown)
        return function () { document.removeEventListener('keydown', onKeyDown) }
      }, [props.onClose])

      var rows = [
        h('div', { key: 'current' }, h('span', { className: 'dsvc-dt' }, t('currentLabel')), h('span', { className: 'dsvc-dd' }, info.current !== null ? info.current : t('unknownCurrent'))),
      ]
      if (latest !== null) {
        rows.push(h('div', { key: 'latest' },
          h('span', { className: 'dsvc-dt' }, t('latestLabel')),
          h('span', { className: 'dsvc-dd' },
            h('span', { className: 'dsvc-pill dsvc-pill-accent' }, latest.version),
            latest.prerelease === true ? h('span', { className: 'dsvc-tag' }, t('prerelease')) : null)))
        if (typeof latest.publishedAt === 'string') {
          rows.push(h('div', { key: 'published' },
            h('span', { className: 'dsvc-dt' }, t('published')),
            h('span', { className: 'dsvc-dd' }, latest.publishedAt.slice(0, 10))))
        }
      }
      if (info.status === 'error') {
        rows.push(h('div', { key: 'error' }, h('span', { className: 'dsvc-dt' }, t('checkFailed')),
          h('span', { className: 'dsvc-dd dsvc-error' }, errorText(t, props.error))))
      }

      var foot = [
        h('button', {
          key: 'refresh',
          type: 'button',
          className: 'dsvc-btn',
          disabled: props.loading,
          onClick: function () { props.onRefresh() },
        }, ICON_REFRESH, h('span', null, t('refresh'))),
      ]
      if (latest !== null && typeof latest.url === 'string') {
        foot.push(h('a', {
          key: 'release',
          className: 'dsvc-btn dsvc-btn-end',
          href: latest.url,
          target: '_blank',
          rel: 'noopener noreferrer',
        }, ICON_EXTERNAL, h('span', null, t('openRelease'))))
      }

      // 弹窗挂在 portal 里，但 React 的事件仍按组件树冒泡：不拦住的话，
      // 点弹窗里的按钮会一路冒到品牌位外面那个「新建会话」button 上，
      // 关掉弹窗就顺手新建一个会话。四个事件都截住。
      function stopBubbling(event) { event.stopPropagation() }
      return h('div', {
        className: 'dsvc-overlay',
        onClick: stopBubbling,
        onMouseDown: function (event) {
          event.stopPropagation()
          if (event.target === event.currentTarget) props.onClose()
        },
        onPointerDown: stopBubbling,
        onKeyDown: stopBubbling,
      },
        h('div', { className: 'dsvc-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('dialogTitle') },
          h('div', { className: 'dsvc-head' },
            h('div', { className: 'dsvc-title' }, t('dialogTitle')),
            h('button', {
              type: 'button', className: 'dsvc-iconbtn', title: t('close'), 'aria-label': t('close'),
              onClick: function () { props.onClose() },
            }, ICON_CLOSE)),
          h('div', { className: 'dsvc-rows' }, rows),
          h('div', { className: 'dsvc-hint' },
            h('div', { className: 'dsvc-hint-title' }, t('howTo')),
            h('div', { className: 'dsvc-hint-line' }, t('sourceHint')),
            h('div', { className: 'dsvc-hint-line' }, t('npmHint'))),
          h('div', { className: 'dsvc-foot' }, foot),
        ),
      )
    }

    /** 品牌名槽位的占位者：两行，第二行是版本状态。 */
    function BrandVersion(props) {
      var t = typeof props.t === 'function' ? props.t : fallbackT
      var status = useVersionStatus()
      var openPair = useState(false)
      var open = openPair[0]
      var setOpen = openPair[1]
      var info = versionInfo(status.data, status.error)

      var close = useCallback(function () { setOpen(false) }, [])
      var openDialog = useCallback(function (event) {
        if (event !== undefined && typeof event.stopPropagation === 'function') {
          event.stopPropagation()
          event.preventDefault()
        }
        setOpen(true)
      }, [])

      var title = t('localBuild')
      if (title === '' || title === 'localBuild' || title === undefined) title = 'DSH Local Build'
      var tip = tooltipText(t, info)

      useDialogRoot(open, function () {
        return h(VersionDialog, {
          t: t,
          data: status.data,
          error: status.error,
          loading: status.loading,
          onClose: close,
          onRefresh: function () { status.refresh(true) },
        })
      })

      var line = []
      if (info.current !== null) {
        line.push(h('span', { key: 'current', className: 'dsvc-pill' }, info.current))
      }
      line.push(h('span', {
        key: 'state',
        className: 'dsvc-state ' + (STATE_COLOR[info.status] || 'dsvc-state-muted'),
      }, stateText(t, info)))

      return h('span', {
          className: 'dsvc-brand',
          onClick: openDialog,
          onKeyDown: function (event) {
            if (event.key === 'Enter' || event.key === ' ') openDialog(event)
          },
          role: 'button',
          tabIndex: 0,
          title: tip,
        },
          h('span', { className: 'dsvc-brand-title' }, title),
          h('span', { className: 'dsvc-brand-line' }, line),
        )
    }

    /** 品牌槽位被官方占用时的退路：侧栏底部一行。 */
    function FooterVersion(props) {
      var t = typeof props.t === 'function' ? props.t : fallbackT
      var wide = props.wide !== false
      var status = useVersionStatus()
      var openPair = useState(false)
      var open = openPair[0]
      var setOpen = openPair[1]
      var info = versionInfo(status.data, status.error)
      var close = useCallback(function () { setOpen(false) }, [])
      var openDialog = useCallback(function () { setOpen(true) }, [])

      useDialogRoot(open, function () {
        return h(VersionDialog, {
          t: t,
          data: status.data,
          error: status.error,
          loading: status.loading,
          onClose: close,
          onRefresh: function () { status.refresh(true) },
        })
      })

      var dot = info.status === 'available' ? h('span', { className: 'dsvc-dot' })
        : info.status === 'error' || info.status === 'unknown' ? h('span', { className: 'dsvc-dot dsvc-dot-warn' })
          : null

      var trigger = wide
        ? h('button', {
            type: 'button', className: 'dsvc-row', onClick: openDialog,
            title: tooltipText(t, info),
          },
            h('span', { className: 'dsvc-row-icon' }, ICON_REFRESH, dot),
            h('span', { className: 'dsvc-row-label' }, t('label')),
            h('span', { className: 'dsvc-row-state ' + (STATE_COLOR[info.status] || '') }, stateText(t, info)),
          )
        : h('button', {
            type: 'button', className: 'dsvc-rail', onClick: openDialog,
            title: tooltipText(t, info), 'aria-label': t('label') + ' ' + tooltipText(t, info),
          }, ICON_REFRESH, dot)

      return trigger
    }

    function ensureStyle() {
      var id = 'dsh-version-check/style'
      if (document.getElementById(id) !== null) return
      var style = document.createElement('style')
      style.id = id
      style.textContent = [
        // 品牌名占位：跟侧栏原本的两行排版对齐（标题 12px，第二行小字）。
        '.dsvc-brand { display: inline-flex; flex-direction: column; align-items: flex-start;',
        '  justify-content: center; gap: 0; height: 24px; min-width: 0; white-space: nowrap;',
        '  cursor: pointer; border-radius: 4px; outline: none; }',
        '.dsvc-brand:focus-visible { box-shadow: 0 0 0 2px var(--dsw-alias-state-business-primary, #4176e6); }',
        '.dsvc-brand-title { font-size: 12px; line-height: 13px; letter-spacing: 0; font-weight: 600; overflow: hidden; text-overflow: ellipsis; }',
        '.dsvc-brand-line { display: inline-flex; align-items: center; gap: 4px; min-width: 0; overflow: hidden; }',
        '.dsvc-pill { flex: none; display: inline-flex; align-items: center; height: 11px; padding: 0 4px;',
        '  border-radius: 2px; background: var(--dsw-alias-label-primary); color: var(--dsw-alias-label-primary-inverted);',
        '  font-family: var(--ds-font-family-code, ui-monospace, monospace); font-size: 8px; line-height: 11px; }',
        '.dsvc-pill-accent { height: 14px; font-size: 10px; line-height: 14px; border-radius: 3px;',
        '  background: var(--dsw-static-deepseek-500, #4176e6); color: #fff; }',
        '.dsvc-state { flex: none; font-size: 9px; line-height: 11px; letter-spacing: .01em; overflow: hidden; text-overflow: ellipsis; }',
        '.dsvc-state-muted { color: var(--dsw-alias-label-tertiary, #6b7280); }',
        '.dsvc-state-available { color: var(--dsw-static-deepseek-500, #4176e6); font-weight: 600; }',
        '.dsvc-state-warn { color: var(--dsw-alias-state-warn-label, #b45309); }',
        // 退路：底部一行。
        '.dsvc-row { display: flex; align-items: center; gap: 8px; width: 100%; box-sizing: border-box;',
        '  padding: 8px 10px; border: none; border-radius: 10px; background: none; cursor: pointer;',
        '  color: var(--dsw-alias-label-secondary, #4b5563); font-family: inherit; font-size: 13px; line-height: 1; text-align: left; }',
        '.dsvc-row:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.06)); color: var(--dsw-alias-label-primary, #1f2328); }',
        '.dsvc-row-icon { position: relative; display: inline-flex; flex: none; }',
        '.dsvc-row-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
        '.dsvc-row-state { flex: none; font-size: 11.5px; }',
        '.dsvc-rail { position: relative; display: inline-flex; align-items: center; justify-content: center;',
        '  width: 36px; height: 36px; border: none; border-radius: 10px; background: none; cursor: pointer;',
        '  color: var(--dsw-alias-label-secondary, #4b5563); }',
        '.dsvc-rail:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.06)); color: var(--dsw-alias-label-primary, #1f2328); }',
        '.dsvc-dot { position: absolute; top: -1px; right: -2px; width: 7px; height: 7px; border-radius: 50%;',
        '  background: var(--dsw-static-deepseek-500, #4176e6); box-shadow: 0 0 0 2px var(--dsw-alias-bg-layer-1, #fafafa); }',
        '.dsvc-dot-warn { background: var(--dsw-alias-state-warn-primary, #d97706); }',
        // 弹窗。
        '.dsvc-overlay { position: fixed; inset: 0; z-index: 2147482400; display: flex; align-items: center;',
        '  justify-content: center; background: rgba(0,0,0,.35); }',
        '.dsvc-panel { display: flex; flex-direction: column; width: min(520px, calc(100vw - 48px));',
        '  max-height: calc(100vh - 120px); overflow: hidden; border-radius: 14px;',
        '  background: var(--dsw-alias-bg-layer-2, #fff); color: var(--dsw-alias-label-primary, #1f2328);',
        '  border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1)); box-shadow: 0 16px 48px rgba(0,0,0,.22);',
        '  font-family: var(--dsw-font-family, system-ui); font-size: 14px; }',
        '.dsvc-head { display: flex; align-items: center; gap: 10px; padding: 12px 14px; flex: none;',
        '  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.06)); }',
        '.dsvc-title { flex: 1; font-size: 14px; font-weight: 600; }',
        '.dsvc-iconbtn { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px;',
        '  border: none; border-radius: 8px; background: none; cursor: pointer; color: var(--dsw-alias-label-secondary, #4b5563); }',
        '.dsvc-iconbtn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.06)); color: var(--dsw-alias-label-primary, #1f2328); }',
        '.dsvc-rows { flex: none; padding: 10px 14px; display: flex; flex-direction: column; gap: 8px; }',
        '.dsvc-rows > div { display: flex; align-items: center; gap: 10px; font-size: 13px; }',
        '.dsvc-dt { flex: none; width: 72px; color: var(--dsw-alias-label-tertiary, #6b7280); font-size: 12px; }',
        '.dsvc-dd { display: inline-flex; align-items: center; gap: 6px; min-width: 0; font-family: var(--ds-font-family-code, ui-monospace, monospace); }',
        '.dsvc-tag { flex: none; font-size: 10px; padding: 2px 5px; border-radius: 5px;',
        '  color: var(--dsw-alias-state-warn-label, #b45309); background: var(--dsw-alias-state-warn-tertiary, rgba(217,119,6,.14)); }',
        '.dsvc-error { color: var(--dsw-alias-state-error-primary, #dc2626); font-family: inherit; font-size: 12px; }',
        '.dsvc-hint { flex: none; padding: 10px 14px 12px; border-top: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.06));',
        '  font-size: 12px; line-height: 1.8; color: var(--dsw-alias-label-secondary, #4b5563); }',
        '.dsvc-hint-title { font-size: 11px; color: var(--dsw-alias-label-tertiary, #6b7280); margin-bottom: 2px; }',
        '.dsvc-foot { display: flex; align-items: center; gap: 8px; padding: 10px 14px; flex: none;',
        '  border-top: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.06)); }',
        '.dsvc-btn { display: inline-flex; align-items: center; gap: 5px; padding: 6px 10px; border-radius: 8px;',
        '  border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1)); background: none; cursor: pointer;',
        '  color: var(--dsw-alias-label-secondary, #4b5563); font-family: inherit; font-size: 13px; text-decoration: none; }',
        '.dsvc-btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.06)); color: var(--dsw-alias-label-primary, #1f2328); }',
        '.dsvc-btn:disabled { opacity: .55; cursor: default; }',
        '.dsvc-btn-end { margin-left: auto; }',
      ].join('\n')
      document.head.appendChild(style)
    }

    /**
     * 注册。优先占品牌名位置；那个槽位被官方占住（官方构建）时退回侧栏底部。
     * apply 整段和注入回调都包了 try/catch：客户端条目应用失败会让整个界面停在
     * 加载页，一个版本提示不该有这种权力。
     */
    function apply(ctx) {
      try {
        if (typeof document === 'undefined') return
        ensureStyle()
        var slots = ctx.get('slots')
        if (slots === undefined) return
        var locale = typeof ctx.get === 'function' ? ctx.get('locale') : undefined
        var hasLocale = locale !== undefined && locale !== null && typeof locale.register === 'function'
        if (hasLocale) {
          try { locale.register(NS, STRINGS) } catch { /* 已注册就沿用现有词典 */ }
        }
        var base = {}
        if (hasLocale) base.locale = NS

        slots.inject('sidebar.brand.name', function () {
          try {
            var occupied = false
            try {
              occupied = typeof slots.entries === 'function' && slots.entries('sidebar.brand.name').length > 0
            } catch { occupied = false }
            if (!occupied) {
              var brandOptions = { name: 'sidebar.brand.name' }
              if (hasLocale) brandOptions.locale = NS
              return slots.register(brandOptions, BrandVersion)
            }
          } catch (error) {
            if (typeof console !== 'undefined' && console.error) {
              console.error('[dsh-version-check] 品牌位注册失败，改放侧栏底部：', error)
            }
          }
          return slots.inject('sidebar.footer.action', function () {
            var footerOptions = { name: 'sidebar.footer.action', id: 'version-check', order: 0 }
            if (hasLocale) footerOptions.locale = NS
            return slots.register(footerOptions, FooterVersion)
          })
        })
      } catch (error) {
        if (typeof console !== 'undefined' && console.error) {
          console.error('[dsh-version-check] 注册失败，插件停用：', error)
        }
      }
    }

    return {
      name: 'dsh-version-check',
      inject: ['slots'],
      apply: apply,
    }
  },
})
