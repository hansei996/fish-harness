# 发布：从「能跑」到「别人能装」

> 这份文档存在的理由：`dsh-life` **还没有发布到 npm**，而根 README 曾经第一行就写着
> `dsh plugin --profile <p> add dsh-life`。任何人照着一跑就是 `ERR_PNPM_FETCH_404`。
> 这正是这个项目反复栽的那个坑——陌生人第二分钟就卡住。

## 现在的真实状态（2026-10-27 实测）

```
$ dsh plugin --profile <p> add dsh-life
[ERR_PNPM_FETCH_404] GET https://registry.npmjs.org/dsh-life: Not Found - 404
dsh-life: plugin command failed
```

`registry.npmjs.org/dsh-life` 与 `@deepseek-ai/dsh-life` 都是 404。本机也没有 npm 凭据
（`~/.npmrc` 不存在，`pnpm whoami` → `ERR_PNPM_WHOAMI_UNAUTHORIZED`）。

所以：**当前唯一能装上的方式是 `link:` 本地路径**（已写进 README），发布之后那行才成立。

## 发布前必须过的三关

### 1. 打包产物对不对（不需要凭据）

```sh
cd packages/dsh-life
pnpm pack --dry-run
```

必须包含：`cordis.patch.yml`、`lib/*.js`（含新增的 `choose.js`、`wake.js`）、`locale/*.json`、
`package.json`、`README.md`。`files` 字段在 `package.json` 里，漏了就是装了但加载不起来。

### 2. 打出来的 tarball 真的能装进 profile 并激活（不需要凭据）

这一关是 npm 发布最接近的替身：`link:` 安装**不会**解析依赖与 `peerDependencies`，
只有真装一次 tarball 才能暴露问题。

```sh
cd packages/dsh-life
pnpm pack --pack-destination /tmp/pack

# 独立 DSH_HOME，别碰真实 ~/.dsh
dsh --profile packed --from-default-profile headless --dump-config   # 先建 profile
dsh plugin --profile packed add "file:/tmp/pack/dsh-life-0.1.0.tgz"
dsh --profile packed --dump-config | grep dsh-life                   # 应该看到 - id: dsh-life
```

已实测通过（2026-10-27）：`+ dsh-life 0.1.0`，`--dump-config` 里有 `- id: dsh-life`，
boot 之后 `$DSH_HOME/life/default/` 下出现 `identity.json` / `ledger.jsonl` / `traits.json` /
`wake.json`。`peerDependencies: @deepseek-ai/cordis` 没有挡住安装。

### 3. 发布本身（需要用户的 npm 凭据）

```sh
npm login                      # 或配 NPM_TOKEN
cd packages/dsh-life
npm publish --access public    # 包名 dsh-life，无 scope，不需要 --access
```

发布后立刻回头改两处：

- 根 `README.md` 的「装法」：把 `link:` 那段换回 `dsh plugin add dsh-life`，并删掉「还没发布」的提示；
- `packages/dsh-life/README.md` 同样一处。

然后验证陌生人路径：

```sh
dsh plugin --profile <全新 profile> add dsh-life    # 必须 exit 0
```

## 版本与兼容

- 包版本现在是 `0.1.0`；第一次发布用它就行。
- `peerDependencies.@deepseek-ai/cordis: ^4.0.1` 是**唯一**的依赖声明，`dependencies` 保持空——
  这是「零自有依赖」原则的落地：插件必须只靠 Node 内置模块就能加载。
- dsh 侧兼容范围目前靠 README 声明（对着 `0.2.1-rc.2` 写的）。dsh 是 developer preview，
  官方明写会有破坏性变更；升级 dsh 时要重跑两套 verify。

## 还没做的

- **没有自动化**：pack、装 tarball、断言激活，目前是手工三步。应该变成 `verify/pack-install.mjs`
  并进 CI——这样「包漏了文件」「peer 依赖挡住安装」在推之前就会红。
- **没有 changelog / release notes**。
- 没有在干净的机器上做过一次「clone → 装 → 跑」的陌生人演练。
