# CI：.github/workflows/verify.yml

三套 verify 在 `ubuntu-latest` 与 `windows-latest` 各跑一遍，`fail-fast: false`，一次能看到两个平台。
只跑 `node verify/smoke.mjs`、`node verify/e2e-tools.mjs`、`node verify/pack-install.mjs`；零额外依赖，不改断言。

## 固定项与理由

| 项 | 值 | 理由 |
| --- | --- | --- |
| Node | 24 | dsh 0.2.1-rc.2 自带运行时是 Node 24.21.0，本机三套 verify 在它上面通过；2026-10 的 Active LTS 是 24（22 已进维护期），依赖里最严的 engines 是 >=22.19。仓库无 lockfile，不开 setup-node cache。 |
| pnpm | 11.28.5 | dsh 的 plugin manager 用 execa 直接 spawn("pnpm")；corepack 的 shim 是 .cmd，Windows 上非 shell spawn 找不到，所以用 pnpm/action-setup 装独立可执行文件，并固定到 DSH 运行时同版本。 |
| dsh | 0.2.1-rc.2 | 与 verify/README.md 一致，装在 `$RUNNER_TEMP/dsh-install`，不碰仓库里的 package.json。 |
| 超时 | 45 min | e2e 子进程 300s、pack 的 boot 90s；job 要比各套自己的超时宽裕。 |
| 权限 | contents: read | verify 不需要写仓库、issue 或制品以外的东西。 |

## 第三套：pack（打出来的包还能不能装）

`verify/pack-install.mjs`：`pnpm pack` → 断言 `files`/`exports`/`dsh.bundle` 承诺的文件一个不少
→ 把 tarball 装进全新 profile → boot 一次（无凭据时只要求 `identity.json` 落盘；90s 超时算失败）。
约 20–40s。它覆盖 `link:` 安装掩盖不了的「包漏文件」「peer 依赖挡住安装」，不需要 npm 凭据。

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

- `Report and gate` 的 Step summary：dsh / node 版本、三套结果、各自输出尾部。
- artifact `verify-logs-<os>`：`verify-smoke.log`、`verify-e2e.log`、`verify-pack.log`、`verify-report.md`。
- `Verify — pack` 红 → 先看 `verify-pack.log` 的 FAIL 行：缺文件会列出具体文件名；安装被 peer/registry 挡住看 add 那段。
- `DSH_BIN does not exist` → 装 dsh 那步失败，看同平台日志里的 registry/网络错误。
- `'pnpm' is not recognized` 或 `pnpm-missing` → e2e/pack 里 dsh 找不到 pnpm，检查 action-setup 与 PATH。
- `ERR_MODULE_NOT_FOUND ... dsh-app-boot` → DSH_BIN 没经过 realpath（verify/dsh-bin.mjs 被改过）。

## 本机验证到哪一步（2026-10-27，Windows）

已验（按 workflow 里的原命令）：
- 临时目录 `pnpm add --ignore-scripts ...` → exit 0；`realpathSync.native` 后 `dsh --version` → 0.2.1-rc.2；
- `node verify/pack-install.mjs` → 9/9，约 20s（pack 0.5s；装 tarball 与 dump 4s；boot 19s 后以 transport 失败退出，identity 已落盘）；
- 故意从 `files` 去掉 `locale` → 红并列出 `locale/en.json, locale/zh.json`，退出 1；恢复后 `git diff` 干净；
- `ci-report.mjs` 在 success / failure / skipped（含新的 pack 列）下退出码与 summary 符合预期。

未验 / 还缺：
- 本机沙箱里 pipe spawn 被拦，`smoke`/`e2e` 没在 CI 等价环境重跑；
- GitHub Actions / act 没跑过：`pnpm/action-setup`、`upload-artifact` 的版本与 runner 上 Git Bash/PATH 要等第一次 push 后确认。
