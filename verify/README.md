# 怎么跑 verify（含 Windows）

两套验证都需要**真的 dsh**，不是 mock：

| 套件 | 查什么 | 本机实测 |
|---|---|---|
| `verify/smoke.mjs` | 26 项存储不变量/装载 + 16 项自主唤醒 + 10 项 7 天模拟 soak + 9 项活动选择器（固定时钟与随机数，不需要真 dsh） | 61/61 通过 |
| `verify/e2e-tools.mjs` | 17 项端到端：真 dsh 装载插件、13 个工具可见、身份/账本落盘、无 schedule 时降级、web 模板确实带 schedule | 17/17 通过 |

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
npm run verify            # 两套一起
node verify/smoke.mjs     # 61 项
node verify/e2e-tools.mjs # 17 项
```

两个脚本都会把 `DSH_HOME` 指到临时目录（`VERIFY_DSH_HOME` / `E2E_DSH_HOME` 可覆盖），
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

## 第三套：打包产物能不能装（`verify/pack-install.mjs`）

```sh
node verify/pack-install.mjs   # 需要 pnpm 在 PATH；约 20-40s
```

它做三件 `link:` 覆盖不到的事：`pnpm pack` 出 tarball、断言 `files`/`exports`/`dsh.bundle` 承诺的文件
一个不少、把 tarball 装进全新 profile 再 boot 一次（无凭据只要求 `identity.json` 落盘，90s 超时算失败）。
`PACK_DSH_HOME` 可覆盖临时 HOME；失败会保留 tarball 与 HOME 并打印路径。
它**不在** `npm run verify` 里：根 `package.json` 不在本轮写范围，而且它比前两套慢（要真装 + 真 boot）。
