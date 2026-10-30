# 怎么跑 verify（含 Windows）

固定基线由 `tools/facts.mjs` 真跑统计；`ui` 使用 `--offline`，浏览器验收独立运行，不因本机是否安装浏览器而改变统计口径。真实 Web profile 的附加检查使用不带 `--offline` 的 `verify/ui.mjs`；浏览器与 UI 完整检查仍在 CI 的各自步骤执行。

<!-- facts:verify-table -->
| 套件 | 查什么 | 固定基线实测（合计 297 项） |
|---|---|---|
| `verify/smoke.mjs` | 70 项：存储不变量 + 唤醒策略 + 7 天 soak + 活动选择器（确定性）（需要真 dsh） | 70/70 通过 |
| `verify/day-report.mjs` | 28 项：当天报告工具（不需要真 dsh） | 28/28 通过 |
| `verify/demo-data.mjs` | 18 项：对外页面引用的那份数据产物与实现一致（含时区稳定性）（不需要真 dsh） | 18/18 通过 |
| `verify/life-week.mjs` | 16 项：连跑七天（不需要真 dsh） | 16/16 通过 |
| `verify/ui.mjs` | 38 项：界面包清单 / 页面与侧栏 / 状态投影 / 隐私 / 请求生命周期（--offline 基线；去掉参数另验真实 Web profile）（不需要真 dsh） | 38/38 通过 |
| `verify/publish.mjs` | 40 项：发布状态机 / 标识硬闸 / approval 四态 / TOCTOU / Telegram 脱敏（不联网）（不需要真 dsh） | 40/40 通过 |
| `verify/e2e-tools.mjs` | 17 项：真实 dsh 端到端（需要真 dsh） | 17/17 通过 |
| `verify/pack-install.mjs` | 9 项：打出来的包能不能装进 profile 并激活（需要真 dsh） | 9/9 通过 |
| `verify/landing.mjs` | 落地页与场景原型的像素级验证（真 Chromium；缺浏览器则跳过）；不计入固定基线 | 单独运行，以 CI/浏览器验收结果为准 |
| `verify/market.mjs` | 5 项：市场调研文档的结构与诚实性（离线口径：三态标注、证伪条件、不许删掉「未接真实平台」）（不需要真 dsh） | 5/5 通过 |
| `verify/scenarios.mjs` | 11 项：落地剧本的每个引用都真实存在，且「未实现」的标记与 STORY.md 口径一致（不需要真 dsh） | 11/11 通过 |
| `verify/framework.mjs` | 23 项：技术总图（docs/framework.html）上画的 import 边 / 挂载 API / 生成块里的数字全部对着源码核（离线口径；装了 dsh 时手动跑可多核 dsh 包规模 3 条）（不需要真 dsh） | 23/23 通过 |
| `verify/video.mjs` | 22 项：视频发布线：每帧烧标识 + 容器隐式标识 + 回读首帧像素证明真的烧进去了；批准绑定文件字节（换文件拦得住）（不需要真 dsh） | 22/22 通过 |
| `verify/claims.mjs` | 文档里的数字有没有过期（它数的就是上面这些项数，所以不计入合计） | 见 `node verify/claims.mjs` |
<!-- /facts:verify-table -->

唤醒部分的验证结论与**没验到什么**见 [`docs/wake-verification.md`](../docs/wake-verification.md)。
更慢、需要真实 web profile 的「真的醒一次」检查在 [`verify/live/`](live/README.md)（opt-in，不在 CI 里）。

## 前置条件

1. **一个 node 可执行的 dsh**（`lib/bin.js`），用 `DSH_BIN` 指过去：

```sh
pnpm add @deepseek-ai/dsh@0.2.1-rc.2   # 装到任意目录
export DSH_BIN=$(pwd)/node_modules/@deepseek-ai/dsh/lib/bin.js
```

   > 打包版（Electron 的 `dsh.cmd`）**不行**：它内部走 asar，node 读不到 `lib/bin.js`。

  > **不设 `DSH_BIN` 也行**：脚本会自己试 `<repo>/node_modules/@deepseek-ai/dsh/lib/bin.js`；
  > 两个位置都没有，就打印一段「装什么、装哪、指哪个文件」的提示后立刻退出，
  > 而不是留下十几条看不懂的 `FAIL`。

2. **`pnpm` 要在 PATH 上**。dsh 的 `plugin add` 会去调它；找不到就报
   `'pnpm' is not recognized ... dsh: plugin command failed`。

   Windows 上如果 pnpm 只是脚本（`pnpm.mjs`），加一个 shim：

```bat
@echo off
"C:\path\to\node.exe" "C:\path\to\pnpm.mjs" %*
```

   存成 `pnpm.cmd` 并把所在目录加进 PATH。

## 跑

```sh
export DSH_BIN=<dsh bin>   # e2e / pack 需要；smoke 与 day-report 不需要
npm run verify              # smoke + day-report + e2e 一起（跳过 pack）
node verify/smoke.mjs       # 68 项
node verify/day-report.mjs  # 22 项
node verify/life-week.mjs   # 16 项
node verify/e2e-tools.mjs   # 17 项
node verify/pack-install.mjs # 9 项
```

几个脚本都会把 `DSH_HOME` 指到临时目录（`VERIFY_DSH_HOME` / `E2E_DSH_HOME` 可覆盖），
所以不会碰你真实的 `~/.dsh`。

## Windows 上修过的四个坑（2026-10-26）

| 症状 | 原因 | 修法 |
|---|---|---|
| `ERR_UNSUPPORTED_ESM_URL_SCHEME` | `new URL(...).pathname` 给出 `/C:/...` 形式 | 用 `fileURLToPath` |
| 同上，第二次 | `import('C:\\...')` 不接受裸路径 | 用 `pathToFileURL(...).href` |
| `'pnpm' is not recognized` | 子进程 PATH 里没有 node/pnpm 目录 | 显式传 `PATH`；本机补 `pnpm.cmd` shim |
| `ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/dsh-app-boot'` | pnpm 把包链接成 Windows **junction**；node 按传入路径解析入口，不先跟随链接，于是去扁平根找 dsh 的依赖。`dsh --version` 照样能过（它不 import app-boot），所以看起来像 compose 的 bug | `verify/dsh-bin.mjs` 用 **`fs.realpathSync.native`** 把 `DSH_BIN` 解析进 pnpm 虚拟store 再 spawn |

  第四个坑的细节值得记一笔：JS 版 `fs.realpathSync` 在 Windows **不解析 junction**，
  `lstat().isSymbolicLink()` 对 junction 也返回 `false` —— 只有 `.native` 会返回真实路径。
  这不是 Windows 独有的问题：Linux 上 pnpm 用 symlink，同样需要先 realpath。

顺带修了一个**假绿**：`dsh plugin manager installs dsh-life` 原来只 grep 输出里有没有 `dsh-life`，
命令失败也会 PASS。现在要求 `exit code === 0` 且输出里没有 `failed`。

### 第二个坑又犯了一次（2026-10-27），所以改成机器检查

新写的 `verify/day-report.mjs` 里用了一句裸路径 `import()`，**macOS 全绿、CI 的 windows-latest 红**。
难得的是它没有被掩盖：`continue-on-error` 只让**步骤**显示 success，闸门读的是**真实 outcome**，
所以 `Report and gate` 正确地红了（见 [`docs/ci.md`](../docs/ci.md)）。

人记住一条坑，和机器保证不再犯，是两回事。现在 `verify/day-report.mjs` 会扫描 `tools/` 与 `verify/`
下每个 `.mjs`，任何**没有经过 `pathToFileURL` 的动态 `import`**（排除字符串字面量说明符）都会 FAIL。
这条断言先被验证过「临时恢复裸路径会 FAIL、并准确指出行号」，才留下。

## 第三套：打包产物能不能装（`verify/pack-install.mjs`）

```sh
node verify/pack-install.mjs   # 需要 pnpm 在 PATH；约 20-40s
```

它做三件 `link:` 覆盖不到的事：`pnpm pack` 出 tarball、断言 `files`/`exports`/`dsh.bundle` 承诺的文件
一个不少、把 tarball 装进全新 profile 再 boot 一次（无凭据只要求 `identity.json` 落盘，90s 超时算失败）。
`PACK_DSH_HOME` 可覆盖临时 HOME；失败会保留 tarball 与 HOME 并打印路径。
它**不在** `npm run verify` 里：根 `package.json` 不在本轮写范围，而且它比前两套慢（要真装 + 真 boot）。

## 第四套：发布线（`verify/publish.mjs`）

```sh
node verify/publish.mjs   # 约 1s；不启动 dsh、不联网、不需要凭据
```

假 approval（四种 outcome）+ 假 transport + 假 `fetch`：跑 outbox 状态机、标识硬闸、`life_publish`
接线与 Telegram 载荷/脱敏。进程内把 `globalThis.fetch` 换成会抛错的 stub，并断言全程 **0 次真实请求**。
`PUBLISH_DSH_HOME` 可覆盖临时 HOME；它也不在 `npm run verify` 里（理由同上）。
