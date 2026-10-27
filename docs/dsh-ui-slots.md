# dsh 界面线可行性：插件怎么加一屏（实测）

> 基线 dsh `0.2.1-rc.2`，2026-10-27 实跑，临时 `DSH_HOME`，未碰 `~/.dsh`、未发外部网络请求。
> 探针与证据：`_scratch/ui-probe/`（`pkg/`、`run-probe.mjs`、`harness.mjs`、`artifacts/`）。

## 结论

**能加，而且不需要客户端构建链。** 一个包同时声明 `dsh.bundle`（让我被挂成 Host 插件行）和 `dsh.client`（让 shell 扫描我的浏览器半身），客户端文件**手写**成 shell 的 lazy-CJS 包装即可被服务、被加载。

实测 10/10（`node run-probe.mjs`，真 `dsh web`，非 mock）：探针模块进了页面 boot manifest、bundle 由 shell 按 URL 取到、插件自加的 HTTP 路由返回**真实状态文件**（`pid` 与运行中的 Host 一致），另在 Node 里以桩 loader 执行客户端模块，确认它注册进 `shell.overlay` 并产出探针元素。

**没验证的只有像素**：本机没有可驱动的浏览器，所以「它真的画在屏幕上」仍是推断（见「未知项」）。但「一屏加不上去」这个风险已经被排除。

## 最小可跑路径（四步，全部实测）

1. **包结构**（`_scratch/ui-probe/pkg/`）：`package.json` 同时写
   - `"dsh": { "bundle": { "patch": "./cordis.patch.yml" }, "client": { "platform": "web", "inject": [] } }`
   - `"exports": { ".": "./lib/index.js", "./client": "./lib/client.js" }`
   - `cordis.patch.yml`：`- insert: [{ id: dsh-life-ui-probe, name: dsh-life-ui-probe }]`
2. **Host 半身** `lib/index.js`：`apply(root)` 里 `root.inject(['webServer'], ctx => ctx.webServer.register({ kind:'exact', path:'/life/state.json', handler }))`；同时在 boot 时写一份真实状态文件（探针写 `{bootedAt, pid, profile, home}`）。
3. **Client 半身** `lib/client.js`：手写
   ```js
   window.__ModuleLoader__.load({ id: '<包名>', factory: (require) => {
     var module = { exports: {} }; var exports = module.exports
     const React = require('react')
     const inject = ['slots']
     function apply (ctx) { ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'life-overview', order: 1000 }, LifeOverview)) }
     exports.name = '<包名>'; exports.inject = inject; exports.apply = apply
     return module.exports
   } })
   ```
   `LifeOverview` 用 `React.createElement`（无 JSX），`useEffect` 里 `fetch('/life/state.json')`。
4. **安装与验证**：`dsh --profile X --from-default-profile web --dump-config` → `dsh plugin --profile X add link:<pkg>` → `dsh --profile X --no-open --port 0`；抓首页 HTML、bundle、路由。

## 确切代码与证据（`包名:文件:行号`）

- **客户端模块不是普通 ESM**：`@deepseek-ai/dsh-client-ui-goal/lib/client.js:1` 就是 `window.__ModuleLoader__.load({ id, factory: (require) => … })`，文件尾部 `exports.apply/inject; return module.exports`。所以第三方可以手写同构文件。
- **模块声明**：`dsh-client-ui-goal/package.json` 的 `dsh.client = { platform: 'web', inject: [<跨包模块>] }` 与 `exports["./client"]`；`dsh-client-modules/lib/index.js:169-180` 只接受 string 或 `{default: string}` 形式的 `exports["./client"]`。
- **扫描与投送**：`dsh-client-modules/lib/index.js:105-120`（扫描 `ctx.loader.entries()` 里声明 `dsh.client` 的包、组 `__DSH_BOOT__`、提供 bundle 路由），`:558` 遍历 loader 行，`:200` `PLUGIN_ROUTE = '/plugins'`，页面里形如 `plugins/??<id>/client.js,…&rev=<hash>`（combo）。
- **可 require 的共享模块**：`dsh-web-frontend/dist/assets/index-CN7NIWNw.js` 的模块表函数给出 `react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、`zod`、`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`、`…-primitives`、`…-dockkit`。我们只用到 `react`。
- **slot API**：`ctx.slots.inject(name, () => ctx.slots.register(options, Component))`；options 见 `dsh-client-ui-goal/lib/client.js:577-583`（`{name,id,order,locale,inject(sessionId)}`，第四个参数是组件，见 `:604`）。
- **slot 名字**：在 `dsh-client-ui-*/lib/client.js` 里共收集到 **89 个**；与「运行总览」相关的会话无关 slot 是 `shell.overlay`、`shell.leading`、`sidebar.panellist`、`sidebar.right.pane.tab`、`settings.section`；会话内的是 `conversation.input.dock`、`conversation.chat.node`、`main.conversation` 等。探针用 `shell.overlay`。
- **Host HTTP 路由（C2）**：官方入口就是 `ctx.webServer`，签名 `WebRoute { kind: 'exact'|'prefix', path: string, handler(req: IncomingMessage, res: ServerResponse) }`（`@deepseek-ai/dsh-host-webserver/lib/types/index.d.ts`，`Context.webServer` 声明在同文件）。**实测插件注册的 `/life/state.json` 直接可访问**，无需改 dsh。
- **关键坑（实测）**：只写 `dsh.client` 时，`dsh plugin add link:` 会打印 `declares no dsh.bundle — installed as a plain dependency, not a profile layer`，**不会挂插件行**，于是客户端半身永远不会被扫描。必须同时有 `dsh.bundle.patch`。
- **真实状态**：探针的 `/life/state.json` 返回 `{"source":"…host half","bootedAt":"2026-10-27T15:57:54.329Z","pid":43156,…}`，与本次 Host 进程 pid 一致 —— 页面上的数字来自 host 写入、客户端 fetch 回来的文件，不是 bundle 里的常量。

## headless 与「优雅不存在」（A5）

界面半身只在**声明并挂载了 `dsh.client` 的包**存在于该 profile 时才会被扫到。`headless`/`sdk` profile 不含 web shell，`dsh-client-modules` 缺席，`dsh.client` 无人读取；so 宿主半身必须写成 `export const inject = []` + `apply` 内 `root.inject(['webServer'], …)`，这样没有 `webServer` 的 profile 里它只是不注册路由、不报错。探针正是这个写法（`pkg/lib/index.js`）。**代价为零**：本次所有文件都在 `_scratch/`，`packages/dsh-life` 没有一个字节改动，CI 的 132 项不受影响。

## 约束与代价（C1/C3）

- **零自有依赖成立**：客户端文件 2.6 KB，只 `require('react')`（shell 已提供）；host 半身只用 `node:fs`。不需要 npm 依赖、不需要 tsdown。
- **代价 1**：不能写 JSX/TS，组件要用 `React.createElement`；样式只能内联或注入 `<style>`（官方包用的是构建期 CSS-module 类名）。
- **代价 2**：手写包装必须与 shell 的 lazy-CJS 约定一致（`load({id, factory})` + `return module.exports`），且 `require` 只能用上表列出的名字——写错只会在浏览器控制台炸，Node 侧靠 `harness.mjs` 这种桩测试兜。
- **代价 3**：安装仍走 `dsh plugin add`（会 spawn `pnpm`，PATH 里必须有 pnpm）；不需要构建，但需要一次安装动作。

## 未知项与替代方案

**未知（未验证，别当结论用）**：
1. **像素未验**：没有可驱动浏览器。已证明「模块在 manifest 里、bundle 被请求、`apply` 注册成功、组件产出元素」，未证明它被 layout 真的画出来。
2. `shell.overlay` 的定位/尺寸/层级未验（GoalBar 用的是 `conversation.input.dock`，语义更明确）；若要「一屏」而非角落浮层，可能该用 `main.conversation` 或 `settings.section`。
3. 实时刷新未验：probe 只在挂载时 fetch 一次；事件推送（`ctx.remote.$on`／`connection/reset`）没试。
4. 未定位到独立的 `@deepseek-ai/dsh-client-ui-slots` 包（`node_modules` 里没找到该目录），它在浏览器侧由 shell 模块表提供；服务端类型只能靠 `dsh-client-ui-goal` 的用法反推。

**替代方案排序（按代价）**：
1. **dsh slot + 手写 client（本文路径）**：零构建、真实状态可读；适合「运行总览」这类只读一屏。
2. **只读本地 HTML**（由 `life_day` 类命令生成、浏览器直接打开）：零 UI 集成、零 slot 风险，但离开 dsh 界面，且要自己管刷新。
3. **引入客户端构建链**（tsdown/JSX/CSS-module，与官方包同构）：只有当我们真的要做 Live2D/复杂交互时才值得；那时也该先按 1 做通数据链路。
