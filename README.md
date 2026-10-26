# Fish Harness

**在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 之上，给一个 Agent 一条能长期活下去的命。**

dsh 给 Agent 一个会话。这个东西给它一段**跨会话活着**的生命：有身份、有兴趣、有承诺、有账本。

> **Harness 是产品，鱼是它在运行时的样子。**
>
> 「养鱼」是抽象说法 —— 让 Agent 在 Harness 上长期稳定运行。鱼是运行态，不是产品本身。

---

## 目录

| 路径 | 是什么 |
| --- | --- |
| [`packages/dsh-life/`](packages/dsh-life/) | **要做的产品**：dsh 插件，生命层 |
| [`verify/`](verify/) | 两套验证：26 项存储不变量 + 15 项真实 dsh 端到端 |
| [`design/`](design/) | 界面原型与技术架构图（单文件 HTML，直接打开） |
| [`docs/PLAN.md`](docs/PLAN.md) | 规划 v0.3（当前）· `v0.1` / `v0.2` 保留在旁，可对照错在哪 |

---

## 一句话说清它补的是什么

dsh 已经开源并且自带：会话持久化与崩溃恢复、持久目标（`goal`）、Host 级定时（`schedule`）、后台作业（`jobs`）、逐次批准（`approval`）、进程隔离（`sandbox`）、提示词装配（`system-prompt`）、工具注册表（`tools`）。

它自己的架构文档写着：**there is no privileged core to patch**。

所以这个仓库**不重写任何一项**。它只补 dsh 没有的那个概念：**活过一次会话的状态**。

| 关注点 | 谁负责 |
| --- | --- |
| 会话不丢 · 崩溃恢复 · 事件可重放 | **dsh** |
| 进程隔离 · 工具权限 · 失败关闭 | **dsh** |
| 用户批准 · 审计事件 | **dsh** |
| 定时唤醒 | **dsh `schedule`** |
| 上下文压缩 · 模型切换适配 | **dsh** |
| **生命状态一致性**（身份不许被一次网页注入改写） | 我们 |
| **活动选择**（此刻做什么） | 我们 |
| **外部副作用幂等**（发帖不重复） | 我们 |
| **预算硬上限与休眠** | 我们 |
| **长期行为回归**（养 30 天后还是同一个它） | 我们 |

左列每一行，都是我们**明确决定不写的代码**。规划 v0.2 曾经把这些设计成自己的护城河 —— 那等于把别人的基础设施重写一遍。

---

## Showcase

![demo](showcase/demo.gif)

> 15 秒、30fps，**由 PAGX 逐帧烘焙生成**（不是录屏）。三幕连续：它现在在做什么 → 一条动态发到八个平台 → 桌宠形态。
> 高画质版本：[`showcase/demo.mp4`](showcase/demo.mp4)（365 KB）

| | |
| --- | --- |
| ![](showcase/scene-activity.png) | ![](showcase/scene-publish.png) |
| **它现在在做什么** — 有界的当前活动：为什么是这件事、存档证据、进度与上限、下一步想做什么 | **一条动态发到八个平台** — 逐渠道开关（这里关掉 QQ 与 OnlyFans）、同步发布、逐条回执 |
| ![](showcase/scene-pet.png) | |
| **桌宠形态** — 浮在桌面一角，气泡说话；「回它 / 别烦我」 | |

### 动画是怎么做的

用的是腾讯 [libpag](https://github.com/Tencent/libpag) 的 **PAGX** —— 一种 XML 矢量动画格式，官方定位是 *human-readable, diff-friendly, designed for AI-assisted generation*。它正好适合这个场景：动画可以由代码生成、可读、可 diff。

```sh
cd showcase
npm install @libpag/pagx
node bake-showcase.mjs                    # 生成 450 帧到 frames/
ffmpeg -framerate 30 -i frames/f%04d.png -c:v libx264 \
  -pix_fmt yuv420p -crf 19 -movflags +faststart demo.mp4
```

`pagx render` 没有时间参数，所以动画是**逐帧烘焙**的：`bake-showcase.mjs` 自己算插值（缓入缓出、呼吸浮动、进度推进、脉冲圆点、计数器），每一帧生成一份独立 PAGX 文档并渲染。PAGX 负责矢量/文字/图片合成，脚本负责运动。

`frames/` 不入库（见 `.gitignore`），只提交成品视频。

---

## 装法

```sh
dsh plugin --profile <你的 profile> add dsh-life
# 或从本地检出安装：
dsh plugin --profile <你的 profile> add link:/绝对路径/packages/dsh-life
```

插件自带 `cordis.patch.yml`，**不需要手改 profile 配置**。装完重启 profile。

配置项（经 Standard Schema 校验，非法值会拒绝而不是静默忽略）：

```yaml
- id: dsh-life
  name: dsh-life
  config:
    lifeId: default                 # 状态目录名，字母数字 - _ ，最长 64
    name: 大肥鱼
    species: whale
    seeds: ['聪明但懒', '傲娇', '爱吃白饭']   # 最多 8 个性格种子
    injectContext: true             # 每轮注入有界生命快照
    autoCreate: true
    maxLedgerEntries: 20000         # 账本上限，超过后折半收敛
```

---

## 它提供什么

### 三档速度的状态

一个像样的个体，变化速度不止一档：

- **慢** —— 身份、核心性格、表达风格。**主人确认才能改**，一条网页改不动它。
- **中** —— 兴趣、技能、关系。由多次真实经历累积，每条带置信度与来源。
- **快** —— 当前活动。**同时只允许一个**，并且必须说明为什么是这件事。

安全策略与预算独立于这三档，**不随「成长」自动解除**。

### 11 个模型可见工具

`life_whoami` · `life_start_activity` · `life_finish_activity` · `life_note_interest` · `life_note_skill` · `life_promise` · `life_settle_commitment` · `life_remember_person` · `life_ledger` · `life_identity_update` · `life_snapshot_for_keeper`

### 一条证据规则

`life_finish_activity` 要交证据，注入的上下文里也写着：**没有证据就如实说没做成**。

产品要的是一条真做过事的鱼，不是一条说自己做过的鱼。

### 每轮一段有界的上下文

通过注册 `systemPrompt` 的 section 注入，**不替换** profile 已有的人格设定。成本是固定的小额 token，不随生命长度增长。

---

## 代码构成

| 文件 | 行数 | 做什么 |
| --- | --- | --- |
| `lib/index.js` | 386 | 插件入口：注册工具、注入上下文、监听会话事件 |
| `lib/store.js` | 409 | 生命状态机：三档变量、承诺、关系、账本；原子落盘 |
| `lib/config.js` | 114 | 零依赖 Standard Schema 校验器 |

**为什么零自有依赖**：插件会被装进 npm CLI 或内置 Electron 运行时，两者依赖解析根不同。只用 Node 内置模块，才能保证在两种环境下都加载得起来。

**四个挂载点**（全部是公开扩展点）：

```
inject(['tools'])        → ctx.tools.register()      注册 11 个工具
inject(['systemPrompt']) → ctx.systemPrompt.section() 注入每轮上下文
on('session/event')      → 记 turn/end 进账本
effect()                 → 卸载时全部反注册
```

### 状态落在哪

`$DSH_HOME/life/<lifeId>/`

```
identity.json      慢变量 · 带版本号
traits.json        兴趣 · 技能（带置信度与来源）
relations.json     主人 / 公开分开存
commitments.json   承诺
activity.json      当前 + 上一次
ledger.jsonl       追加式账本 · 半行跳过 · 有上限
```

每次写都是**原子**的（tmp + rename）。读的时候容忍文件缺失或损坏 —— 一个截断的 JSON 不该弄死一条命。

---

## 验证

```sh
node verify/smoke.mjs       # 26 项：存储不变量、持久性、损坏降级
DSH_BIN=<dsh bin> node verify/e2e-tools.mjs   # 15 项：真实 dsh 端到端
```

`e2e` 那套**不是 mock**：它用 shipped 模板组合出一个真实的 dsh profile，用 `dsh plugin` 装进去，真启动，然后断言运行系统的实际产出 —— 磁盘上的身份、账本里的真实 `turn/end`、**装配后**的系统提示词里的生命层 section、以及 11 个工具 schema 全部对模型可见。

一路上它抓出两个只有真跑才会暴露的 bug：

1. 输出 schema 用了 `{ type: 'json' }` —— 这在 dsh 的 author DSL 里合法，但被注册表的 JSON-Schema 断言拒绝，**11 个工具静默全部注册失败**。
2. 会话事件字段名猜成 `{ kind: 'turn/end' }`，真实结构是 `{ type, seq, time, data }` —— 字段名错了就静默失效，账本一条 `turn` 都没记上。

两个都是 mock 测不出来的。这就是为什么 e2e 必须真启动。

---

## 界面原型（可交互）

`design/` 下都是单文件 HTML，浏览器直接打开，含交互：

| 文件 | 内容 |
| --- | --- |
| `ui-complete.html` | **完整界面**：七个页面 + 桌宠形态 |
| `sns-channels.html` | 渠道接入：八平台同步发布 |
| `render-view.html` | 渲染区 + 状态 + 桌宠（三形态） |
| `arch-diagram.html` | 技术架构图（按实际代码画的） |
| `draft-*.html` | 早期草稿，保留用于对照 |

配色取自形象素材本身（蓝发鲸鱼娘 → `#5068a8` / `#7088c0` / `#1b2c61`）。

> ⚠️ **素材是占位的。** `design/placeholder-whalegirl.png` 来自本机已安装的社区二创形象，**可能牵涉第三方作者与商标/著作权**。上线前必须替换为原创或已授权形象。产品默认形象应自行设计（气质贴近即可，形象与命名独立）。

---

## 明确不承诺

- 不宣称有真实意识、生理需求或痛苦。精力、心情是行为模拟变量。
- 不承诺无限自治、全网可用、账号永不封禁、平台永不改版。
- 不靠模拟点击绕过平台风控。能自动发的走平台正规接口；**没有正规接口的就老实出草稿**，不让你承担封号风险。
- 不因欠费、离线或用户几天没来看就「死亡」，也不编造还在忙。
- **不假装已经全自动。**

---

## 已知限制

- **还没有自主唤醒。** 存储和工具是完整的，但还没有东西能让它自己醒来。这属于 dsh `schedule` 的活，是下一步 —— 插件自建 `setInterval` 恰恰是那个 bug，不是那个 feature。
- **账本只记了回合边界，还没记结果。** 监听工具结果能让账本证明更多，尚未接。
- **没有 UI 实体。** 界面目前是原型，生命只能通过工具看到。
- **默认单条命。** 多个 `lifeId` 可用，但还没有机制阻止两个 profile 指向同一个。
- **活动选择是手动的。** 模型自己挑，还没有候选排序与预算感知的调度器。
- **对着 dsh `0.2.1-rc.2` 写的。** dsh 处于 developer preview，官方明写会有破坏性兼容变更，所以这里的配置与工具名还不是稳定契约。

---

## 参考

- [`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness) —— dsh 底座（MIT，developer preview）
- `john-walks-slow/dsh-proactive` —— 生态里的 Host 级主动唤醒，唤醒那步应当复用它或 `schedule`
- `john-walks-slow/dsh-simulated-life` —— 生态里的生活上下文注入

后两项来自公开搜索，未逐一动手验证。

---

## 许可

MIT
