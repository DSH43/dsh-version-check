# dsh-version-check

在 dsh Web 侧栏的 logo 旁边（现在显示「DSH 本地构建 / 版本号」的位置）标出官方有没有发新版本。
只查版本，不下载、不安装、不动任何文件。

## 显示成什么样

品牌名那块还是两行：第一行「DSH 本地构建」，第二行是版本状态。

| 状态 | 显示 |
| --- | --- |
| 有新版本 | `0.2.1-rc.5 → 0.2.2-rc.2`，箭头和新版本号是品牌蓝 |
| 已最新 | `0.2.1-rc.5 已最新`，灰色 |
| 检查中 | `0.2.1-rc.5 检查中`，灰色 |
| 查不到 | `0.2.1-rc.5 检查失败`，琥珀色，不冒充已最新 |
| 读不到本机版本 | 只显示「读不到本地版本」 |

![侧栏品牌位：有新版本](assets/brand-available.png)

![更新详情](assets/dialog.png)

点这一块弹出小面板：当前版本、官方最新（带「预发布」标签）、发布时间、发布页链接、更新方式、重新检查。
点它不会触发旁边的「新建会话」按钮。

官方构建（`ui-brand-official`）会先占住品牌名槽位，这时插件自动退到侧栏底部的列表槽位，内容一样，只是位置不同。

## 判断依据

- 本机版本：从 dsh 启动入口读 `@deepseek-ai/dsh` 的 `package.json` 版本，源码运行和 npm 安装都能读到。
- 官方版本：读 GitHub Releases（`deepseek-ai/deepseek-harness`），只认 `dsh-v*` 的 tag，跳过草稿。
- 比大小按 semver：`0.2.2-rc.2 > 0.2.1-rc.5`，`0.2.1-rc.5 < 0.2.1`，`alpha < rc`，数字段按数值比。
- 官方最新是预发布版本时照样提示，但标出「预发布」，让你自己决定跟不跟。
- 网络失败、限流、没有 Release，都显示「检查失败」，不会显示「已最新」。

## 安装

```bash
dsh plugin --profile web add "file:/Users/leeo/Documents/workspace-ds/dsh-version-check"
```

装完重启 `dsh web`（或桌面端）。

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `DSH_RELEASE_REPO` | 换官方仓库，默认 `deepseek-ai/deepseek-harness` |
| `GITHUB_TOKEN` | 提高 GitHub API 配额（匿名每小时 60 次）。也会读 dsh 凭据服务里的 `GITHUB_TOKEN` |

## 开销

- 结果缓存 30 分钟，界面每 30 分钟查一次。
- 一次检查 1 个 GitHub 请求，匿名配额够用；设 `GITHUB_TOKEN` 更稳。

## 接口

`GET /plugins/dsh-version-check/status[?refresh=1]` 返回当前版本、最新版本、状态、错误。

## 开发

```bash
node test-host.mjs    # semver 比较、本机版本读取、真实 Release 查询（会访问 GitHub）
node test-client.mjs  # 品牌槽位注册、槽位被占时退回底部、样式注入
```

`index.js` 是启动壳：host.js 加载失败只停用插件，不会把 dsh 启动拖死。
改了源码之后跑 `bash scripts/sync.sh` 同步到本机 profile 的那份拷贝。

## License

MIT
