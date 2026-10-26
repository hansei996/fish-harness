# CI：.github/workflows/verify.yml

两套 verify 在 `ubuntu-latest` 与 `windows-latest` 各跑一遍，`fail-fast: false`，一次能看到两个平台。
只跑 `node verify/smoke.mjs` 和 `node verify/e2e-tools.mjs`，不引入任何额外依赖，不改 verify 断言。

## 固定项与理由

| 项 | 值 | 理由 |
| --- | --- | --- |
| Node | 24 | dsh 0.2.1-rc.2 自带运行时是 Node 24.21.0，本机两套 verify 在它上面通过；2026-10 的 Active LTS 是 24（22 已进维护期），依赖里最严的 engines 是 >=22.19。仓库无 lockfile，不开 setup-node cache。 |
| pnpm | 11.28.5 | dsh 的 plugin manager 用 execa 直接 spawn("pnpm")；corepack 的 shim 是 .cmd，Windows 上非 shell spawn 找不到，所以用 pnpm/action-setup 装独立可执行文件，并固定到 DSH 运行时同版本。 |
| dsh | 0.2.1-rc.2 | 与 verify/README.md 一致，装在 `$RUNNER_TEMP/dsh-install`，不碰仓库里的 package.json。 |
| 超时 | 45 min | e2e 给每个 dsh 子进程 300s，job 要比 e2e 自己的超时宽裕。 |
| 权限 | contents: read | verify 不需要写仓库、issue 或制品以外的东西。 |

## 为什么用 --ignore-scripts

pnpm 会拦下 koffi / node-pty / protobufjs 的 build script，并以 `ERR_PNPM_IGNORED_BUILDS` 结束
（Windows 实测 exit 1，但包其实已装好）。dsh 发布包的 `lib/` 是预构建的，verify 只需要
`lib/bin.js`，所以用 `--ignore-scripts` 让退出码确定；下一步仍会断言 `lib/bin.js` 存在，
装没装成不会被掩盖。

## DSH_BIN

`DSH_BIN=$RUNNER_TEMP/dsh-install/node_modules/@deepseek-ai/dsh/lib/bin.js`（pnpm 的 junction 路径）。
`verify/dsh-bin.mjs` 会先 `fs.realpathSync.native` 解析到 `.pnpm/...` 再 spawn；直接 spawn junction
会让 dsh 找不到 `@deepseek-ai/dsh-app-boot`（`--version` 可能照过，容易误判）。不要改成 hoisted 安装。

## 失败诊断

- `Report and gate` 的 Step summary：dsh / node 版本、两套结果、输出尾部。
- artifact `verify-logs-<os>`：完整 `verify-smoke.log`、`verify-e2e.log`、`verify-report.md`。
- `DSH_BIN does not exist` → 装 dsh 那步失败，看同平台日志里的 registry/网络错误。
- `'pnpm' is not recognized` 或 `pnpm-missing` → e2e 里 dsh 找不到 pnpm，检查 action-setup 与 PATH。
- `ERR_MODULE_NOT_FOUND ... dsh-app-boot` → DSH_BIN 没经过 realpath（verify/dsh-bin.mjs 被改过）。

## 本机验证到哪一步（2026-10-26，Windows）

已验（按 workflow 里的原命令）：
- 临时目录建 package.json → `pnpm add --ignore-scripts @deepseek-ai/dsh@0.2.1-rc.2` → exit 0，`lib/bin.js` 存在；
- 导出 `DSH_BIN` → `realpathSync.native` → `dsh --version` → `0.2.1-rc.2`（exit 0）；
- `resolveDshBin()`（junction 路径 / 包目录两种输入）→ `.pnpm` 真实路径；
- `dsh --profile e2e --from-default-profile headless --dump-config` → exit 0；
- `dsh plugin add link:packages/dsh-life`（pnpm 在 PATH）→ exit 0；
- `.github/scripts/ci-report.mjs` 对 success / failure / skipped 三种 outcome 的退出码与 summary 符合预期。

未验 / 还缺：
- 本机沙箱里 `node verify/*.mjs` 的 pipe spawn 直接 `EPERM`，两套 verify 没在本机 CI 等价环境重跑
  （另一次 full-access 环境里是 26/26、15/15，但那不是这次 CI 步骤本身）；
- GitHub Actions / act 没跑过：`pnpm/action-setup@v4`、`upload-artifact@v4` 的版本与 runner 上
  Git Bash / PATH 行为要等第一次 push 后的两个平台结果确认。若 Windows 上 e2e 的 pnpm 解析异常，
  优先看 artifact 里的 `verify-e2e.log`。
