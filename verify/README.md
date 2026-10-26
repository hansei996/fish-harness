# 怎么跑 verify（含 Windows）

两套验证都需要**真的 dsh**，不是 mock：

| 套件 | 查什么 | 本机实测 |
|---|---|---|
| `verify/smoke.mjs` | 26 项存储不变量 + 插件能否装载 | 26/26 通过 |
| `verify/e2e-tools.mjs` | 15 项端到端：真 dsh 装载插件、11 个工具可见、身份/账本落盘 | 15/15 通过 |

## 前置条件

1. **一个 node 可执行的 dsh**（`lib/bin.js`），用 `DSH_BIN` 指过去：

```sh
pnpm add @deepseek-ai/dsh@0.2.1-rc.2   # 装到任意目录
export DSH_BIN=$(pwd)/node_modules/@deepseek-ai/dsh/lib/bin.js
```

   > 打包版（Electron 的 `dsh.cmd`）**不行**：它内部走 asar，node 读不到 `lib/bin.js`。

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
node verify/smoke.mjs     # 26 项
node verify/e2e-tools.mjs # 15 项
```

两个脚本都会把 `DSH_HOME` 指到临时目录（`VERIFY_DSH_HOME` / `E2E_DSH_HOME` 可覆盖），
所以不会碰你真实的 `~/.dsh`。

## Windows 上修过的三个坑（2026-10-26）

| 症状 | 原因 | 修法 |
|---|---|---|
| `ERR_UNSUPPORTED_ESM_URL_SCHEME` | `new URL(...).pathname` 给出 `/C:/...` 形式 | 用 `fileURLToPath` |
| 同上，第二次 | `import('C:\\...')` 不接受裸路径 | 用 `pathToFileURL(...).href` |
| `'pnpm' is not recognized` | 子进程 PATH 里没有 node/pnpm 目录 | 显式传 `PATH`；本机补 `pnpm.cmd` shim |

顺带修了一个**假绿**：`dsh plugin manager installs dsh-life` 原来只 grep 输出里有没有 `dsh-life`，
命令失败也会 PASS。现在要求 `exit code === 0` 且输出里没有 `failed`。
