# 发布：从「能跑」到「别人能装」

> 这份文档记录**发布路径的真实状态**，包括一个必须先解决的名字冲突。
>
> 上一次更新：2026-10-28。所有结论都是在真实 registry 上跑出来的，不是推测。

---

## 0. 先说最要命的一条：`dsh-life` 这个名字在公开 npm 上已经被占了

```sh
$ curl -sS https://registry.npmjs.org/dsh-life
存在！  最新版本: 1.0.0   维护者: ['mofashi']
首次发布: 2026-10-27T09:12:24.702Z
描述: DSH 插件「AI生命」：按《数字生命》v1.1 实现。记忆分两条轴——L1–L6 记忆层（存什么）
      与 R1–R8 想起通道（怎么被想起）；含召回打分、遗忘曲线、再巩固、身份档案、
      能力边界、反思与目标
keywords: ['dsh', 'dsh-plugin', 'ai-life', 'memory', 'recall', 'forgetting-curve']
```

**这不是重名巧合。** 那是另一个（或同一批人）在**同一天**发布的、**同一个方向**的 dsh 插件：
按《数字生命》实现、有记忆分层与召回。也就是说 ——

- 我们**现在发不出去**：`npm publish` 会失败（版本号 0.1.0 低于已存在的 1.0.0，
  而且包名不属于我们）；
- 更重要的是：**这个位置有人比我们先站上去了。** `PRODUCT.md §1` 假设的
  「dsh 生态里没人做生命层」已经不成立。

### 可以做名字的候选（实测可用）

| 名字 | 状态 |
| --- | --- |
| `dsh-life` | ✕ 已被 `mofashi` 占用（1.0.0） |
| `dsh-fish` | ✕ 已被占用（0.0.1） |
| **`dsh-living`** | ✓ 可用 |
| **`dsh-digital-life`** | ✓ 可用 |
| **`fish-harness`** | ✓ 可用 |

> **建议**：包名改成 `dsh-living`（贴近 dsh-* 命名习惯、语义是「活着的」而不是「一条命」），
> 仓库名保持 `fish-harness`。但这个决定应该先看过 `mofashi` 那个包再定 ——
> 见下面「先做的事」。

---

## 1. 现在的真实状态（2026-10-28 实测）

```
$ dsh plugin --profile <p> add dsh-life
[ERR_PNPM_FETCH_404] GET https://registry.npmjs.org/dsh-life: Not Found - 404
```

`link:` 本地路径是当前**唯一**能装上的方式（已写进 README，并明确标了「还没发布」）。

**另一个必须先知道的坑**：这台机器的 npm 指向内网镜像，不是公网：

```sh
$ npm config get registry
https://bnpm.byted.org/          # 不是 registry.npmjs.org
```

所以在**这台机器上**直接 `npm publish` 会发到内网去。要么显式指定
`--registry https://registry.npmjs.org/`，要么换一台有公网凭据的机器。

---

## 2. 发布前必须过的两关（都已自动化，不需要凭据）

### 第 1 关：打包产物对不对 —— 已自动化

```sh
node verify/pack-install.mjs      # 9 项，进 CI（ubuntu + windows 各一遍）
```

它做的事（比手工严）：

- `pnpm pack` 出 tarball，**从 `package.json` 的 `files` 推导**该有哪些文件，漏了就报文件名；
- 断言 `cordis.patch.yml` 在包根（dsh bundle patch 的路径要求）；
- 装进**全新 profile** 再 boot 一次，断言生命真的被创建。

实测（2026-10-28）：**15 files, 15 promised → 9/9 通过**。

### 第 2 关：装进去能激活 —— 同一套里

`link:` 安装**不会**解析 `peerDependencies`，只有真装一次 tarball 才暴露问题。
`pack-install.mjs` 覆盖了这一点。

---

## 3. 发布本身（需要公网凭据，且要先解决名字）

```sh
# 1) 先改 name（见 §0 的建议）
#    packages/dsh-life/package.json 的 "name" 与 README 里两处安装命令

# 2) 用公网 registry 登录
npm login --registry https://registry.npmjs.org/

# 3) 发布
cd packages/dsh-life
npm publish --registry https://registry.npmjs.org/
```

发布后立刻回头改两处：

- 根 `README.md`「装法」：把 `link:` 换回 `dsh plugin add <新包名>`，删掉「还没发布」的提示；
- `packages/dsh-life/README.md` 同样一处。

然后验证陌生人路径：

```sh
dsh plugin --profile <全新 profile> add <新包名>    # 必须 exit 0
```

---

## 4. 版本与兼容

- 包版本现在是 `0.1.0`。**注意**：如果最终仍要用 `dsh-life` 这个名字，
  0.1.0 会低于已存在的 1.0.0 而被 npm 拒绝（需 `--tag` 且不可用 latest）。
  换名字就没有这个问题。
- `peerDependencies.@deepseek-ai/cordis: ^4.0.1` 是**唯一**依赖声明，
  `dependencies` 保持空 —— 这是「零自有依赖」的落地：插件只靠 Node 内置模块就能加载。
- dsh 侧兼容范围目前靠 README 声明（对着 `0.2.1-rc.2` 写的）。dsh 是 developer preview，
  官方明写会有破坏性变更；升级 dsh 时要重跑两套 verify。

---

## 5. 还没做的

- **没有 changelog / release notes。**
- **没有在干净的机器上做过一次「clone → 装 → 跑」的陌生人演练。**
  `PRODUCT.md §9.3` 要的「找一个不写代码的人全程只看文档」还没做 ——
  已有的是两台机器（Windows / macOS）上的自测，那不是陌生人。
- **没有自动化「发布后验证」**：发布之后应该自动跑一次真装，确认不是发了个坏包。
- **没有确认 `mofashi` 那个包与我们是什么关系**（见下）。

---

## 6. 发布前第一件该做的事

**先看 `mofashi/dsh-life` 是什么。** 它比我们先站上这个位置，而描述里写着
《数字生命》v1.1 与记忆分层 —— 与我们高度重合。三种可能，处理方式完全不同：

1. **巧合的同名项目** → 换名字，继续做。我们比它多了「活着」的机制
   （唤醒、活动选择、账本、发布线），可以并存。
2. **同一批人**（比如我们自己另一个账号）→ 那就是发布记录，只需认领与续发。
3. **真正在做同一件事的竞争者** → 需要读它的实现，重新定位差异
   （就像 `PRODUCT.md §8` 对 OpenClaw 那样），而不是假装没有。

> **在做完这一步之前，不要改包名、不要发布。** 先搞清楚对手/同伴是谁，
> 再决定叫什么、站在哪 —— 否则可能白改名，或者错过一次合作。
