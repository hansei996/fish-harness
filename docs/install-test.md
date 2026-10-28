# 安装门槛实测：一个陌生人照 README 装，会卡在哪

> `docs/PRODUCT.md §9.3` 要求「找一个不写代码的人，从零装到『它开始生活』，全程只允许看文档，记录卡在哪一步」。
>
> 这一份是**代理版**：由熟悉内部的代理**只按 README 和它指向的文档**逐步执行（不许用内部知识跳过步骤），记录每一步的耗时、退出码和真实输出。
> **代理版和真人版的差别要记住**：我会自己补上「dsh 已经装好了」这类前提，真人不会。所以下面每一条都标注了「陌生人会不会卡」。
>
> 环境：Windows 11 / Node 24.21.0 / pnpm 11.28.5 / dsh `0.2.1-rc.2`（**预先装好**，模拟「已经在用 dsh 的人」）。核对日期 **2026-10-27**。

## 一、结论先说

| # | 卡点 | 陌生人会不会卡 | 严重度 |
| --- | --- | --- | --- |
| 1 | `dsh plugin add dsh-life` 是 404（包没发布到 npm） | **会**，第一分钟 | 🔴 已在 README 顶部写明，并把 `link:` 放在第一步 |
| 2 | **自己起一个 profile 名字 → 得到一个「裸 profile」，鱼装上了但跑不起来，而且不报错** | **会**，而且会以为是产品坏了 | 🔴 最严重 |
| 3 | README 只说「重启 profile」，没说**怎么启动**、要不要登录/配 key | **会**，卡在「装完然后呢」 | 🟠 |
| 4 | 装完提示 `The linked in dependency will not resolve the peer dependencies…` | 会慌一下（**这条警告不影响使用**） | 🟡 |
| 5 | `--dump-config \| findstr dsh-life` 只在 Windows 成立 | macOS/Linux 读者照抄会失败 | 🟡 |
| 6 | 用 `headless` 模板时**没有 `schedule` 服务**，自主唤醒不开启（只有一行 info） | 会以为「它永远不醒」 | 🟠 |

**一句话**：代码本身没崩；**卡点全在「装完怎么让它活起来」这一段**，而这一段恰好是 README 最薄的地方。

## 二、逐步实测

### 步骤 1：clone（3.2 秒，✅）

```sh
git clone https://github.com/hansei996/fish-harness
```

3.2 秒，exit 0，约 6 MB 工作区（含 showcase 视频）。

### 步骤 2：照 README 第一行装插件（exit 0，但**这是陷阱**）

一个有 dsh 的人会自然而然写：

```sh
dsh plugin --profile myfish add link:/abs/path/fish-harness/packages/dsh-life
```

**exit 0，`Done in 445ms`**，看起来成功了。但这是本次实测最严重的发现：

```json
// $DSH_HOME/profiles/myfish/package.json（dsh 自动建出来的）
{
  "dependencies": { "dsh-life": "link:…/packages/dsh-life" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "dsh-life"] } }
}
```

**bundle 只有 `dsh-base` + `dsh-life`。** `--dump-config` 里这些**全都没有**：

| 服务 | 裸 profile | web 模板 |
| --- | --- | --- |
| `agent` | ❌ | ✅ |
| `llm` | ❌ | ✅ |
| `system-prompt` | ❌ | ✅ |
| `tool-bash` | ❌ | ✅ |
| `schedule`（自主唤醒的底座） | ❌ | ✅ |

后果分两级：

- `dsh --profile myfish "say hi"` → **静默挂起**（实测 180 秒无任何输出，无报错，只能 Ctrl-C）。因为裸 profile 没有 runner。
- 即使它能跑，也没有 `schedule`，鱼**永远不会自己醒**。

> **为什么这条最危险**：它不报错。陌生人会得到「装是装上了、就是不动」的印象，然后把结论写成「这项目不行」。

### 步骤 3：正确顺序（先有 profile，再装插件）

```sh
# 1) 先拿一个真实的 profile 模板（web = 有界面、有 schedule）
dsh --profile myfish --from-default-profile web --dump-config
# 2) 再把插件装进去
dsh plugin --profile myfish add link:/abs/path/fish-harness/packages/dsh-life
# 3) 启动
dsh --profile myfish          # web 应用；或等价地 dsh web 用名为 web 的 profile
```

实测：`--from-default-profile web` 0.24 秒，1229 行配置；`agent` / `llm` / `system-prompt` / `tool-bash` / `schedule` **全部在**；再 `plugin add` 之后，`--dump-config` 里同时有 `- id: schedule` 和 `- id: dsh-life`。✅

> 验证 `--dump-config` 只是「组合配置并打印」，不会起服务，所以这步很快也很安全。

### 步骤 4：装的时候那句警告（不影响使用）

```
The linked in dependency will not resolve the peer dependencies from the target node_modules.
This might cause issues in your project. To resolve this, you may use the "file:" protocol…
```

dsh 自己的 e2e 也用 `link:` 装（CI 两个平台全绿），插件本体零自有依赖、只靠 Node 内建模块加载，所以这条警告**当前不成立**。但它写在 README 里会让人以为装错了 —— 应该明说「这条警告可以忽略，原因是我们的 peer 依赖由 dsh 提供」。

### 步骤 5：确认装上了（`findstr` 是 Windows-only）

README 现在写 `dsh --profile <profile> --dump-config | findstr dsh-life`。macOS / Linux 上应该用 `grep`。更好的写法是给一条**跨平台**的：

```sh
dsh --profile myfish --dump-config | grep -c "dsh-life"
```

（Windows PowerShell 里 `Select-String dsh-life`，或者干脆两行都给。）

### 步骤 6：装完之后「它开始生活」还差什么

README 目前到「装完重启 profile」就结束了。实测下来陌生人还需要知道：

1. **要不要登录 / 配模型**：web 界面起来后由 dsh 自己的账号流程处理（`dsh web` 会打印地址；按界面提示登录）。插件不碰凭据。
2. **状态落在哪**：`$DSH_HOME/life/<lifeId>/`，装坏了删掉这个目录就能从零开始（README 有写）。
3. **怎么知道它真的活了**：会话里问 `life_whoami`；或者看 `life/<lifeId>/ledger.jsonl` 有没有 `born`。
4. **headless 模板没有 `schedule`**：用 `dsh headless` 跑只有工具和账本，**不会有自主唤醒**（插件会 `info` 一句「这个 profile 没有 schedule 服务」）。想让它自己醒，必须用 `web`（或任何挂了 `dsh-web-app` 的 profile）。

## 三、按这个实测改了什么

- README「装法」：改成 **先 `--from-default-profile web`、再 `add link:`、再 `dsh --profile <name>`** 三步；把「自己起 profile 名字会得到裸 profile」这个坑写在步骤里；补跨平台验证命令与那句 peer 警告的解释。
- 这条实测同时解释了一个内部现象：`verify/e2e-tools.mjs` 为什么必须先 `--from-default-profile headless` —— 同一个理由（不指定模板就得到裸 profile）。

## 四、这份实测**没有**覆盖的

- **没用真人**：真人不会像我一样知道「dsh 版本要 `0.2.1-rc.2`」「要自己有 pnpm」。真人实测的结论可能更糟。
- **没测 macOS / Linux**：全部在 Windows 上做，`findstr` 这类平台差异只做了静态判断。
- **没测「从没装过 dsh」的人**：那一段的门槛（`npx @deepseek-ai/dsh`、Node 版本、网络）完全没测。
- **没测真账号登录后的首轮对话**：没有凭据，只验证到「profile 组合正确、插件挂载、状态目录结构存在」。
- **npm 发布后这段还要重做一遍**：发布之后 `add dsh-life` 能跑通，但「裸 profile」这个坑与发布无关，仍然在。

---

## 五、第二次实测：macOS，而且这一次走到了「它真的出生」

> 上面那份是 Windows 上的，且只验证到「profile 组合正确、目录结构存在」。原文在上一节里
> 明写了「**没测 macOS / Linux**」「**没测真账号登录后的首轮对话**」。下面这次补掉前一个缺口，
> 并把最后一步推到底：**真的启动一个 profile，看它有没有把一条命写进磁盘。**
>
> 核对日期 **2026-10-28** · macOS（Darwin）· Node v24.18.0 · dsh `0.2.1-rc.2` · 全新 `DSH_HOME`
> （`/tmp/stranger-home`，不碰真实 `~/.dsh`）。

### 逐步骤与真实输出

| # | 命令 | 结果 |
| --- | --- | --- |
| 1 | `node <dsh>/lib/bin.js --version` | `0.2.1-rc.2`，exit 0 |
| 2 | `dsh --profile stranger --from-default-profile web --dump-config` | 组合出配置，含 `schedule`，exit 0 |
| 3 | `dsh plugin --profile stranger add link:<repo>/packages/dsh-life` | `+ dsh-life link:…`，`Done in 200ms using pnpm v11.9.0`，exit 0 |
| 4 | `dsh --profile stranger --dump-config \| grep -c dsh-life` | `3`（≥1 即装上） |
| 5 | `dsh --profile stranger` | 真的起服务：`dsh web: http://127.0.0.1:3080/?token=…` |

**第 5 步之后，一条命真的诞生了** —— 落盘在 `$DSH_HOME/life/default/`：

```
identity.json  ledger.jsonl  outbox.json  traits.json  wake.json
```

`identity.json` 的内容（原文，未改）：

```json
{
  "schemaVersion": 1,
  "lifeId": "default",
  "name": "大肥鱼",
  "species": "whale",
  "bornAt": "2026-10-28T04:52:41.919Z",
  "revision": 1,
  "seeds": ["聪明但懒", "傲娇", "爱吃白饭"],
  "updatedAt": "2026-10-28T04:52:41.919Z"
}
```

`ledger.jsonl` 里第一条就是 `kind: "born"`。用仓库自己的工具读它（**不是手写**）：

```sh
DSH_HOME=/tmp/stranger-home node tools/day-report.mjs --life default
```

```text
  大肥鱼的一天 · 2026-10-28
  ──────────────────────────────────────────────

  12:52  ◦ 大肥鱼出生了

  ──────────────────────────────────────────────
  今天：没什么活动
```

三处一致性都能对上：墙上时间 04:52:41Z、本地显示 12:52（+08:00）、账本只有一条 `born`。
**「今天：没什么活动」是对的** —— 它出生才几十秒，还没到自己醒的时候。

### 这次实测新增的两个结论

1. **macOS 上 README 的路径可行。** 原文的「没测 macOS」这条缺口现在补上了：
   `--from-default-profile web` → `add link:` → 启动，三步都 exit 0，且插件确实生效。
2. **「装上了」和「它活了」可以分开看，而且都能被验证。** 第 4 步证明装上了
   （配置里有 3 处 `dsh-life`）；第 5 步证明它活了（磁盘上有 `born`）。
   README 里那句「怎么知道它真的活了」现在有一条**跑过的**答案，而不只是提示。

### 仍然没有覆盖的（诚实边界）

- **没测真人**，也**没测「从没装过 dsh」的人**：本次仍是「已经有 dsh 的人」的视角，
  Node / pnpm / 网络的首次安装门槛一概未测。
- **没测真账号登录后的首轮对话**：启动到了「web 服务起来、生命落盘」，
  但没有凭据，所以没验证模型真的回过话、`life_*` 工具真的被调用过。
- **`outbox.json` 只是被创建，没有真实发布**：发布线至今**一次真实 Telegram 都没发过**
  （见 `docs/publish-verification.md` 的边界）。
- **只在 macOS 上跑了一次**：Linux 仍然只是静态判断。
