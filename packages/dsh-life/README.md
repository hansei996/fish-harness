# dsh-life

数字生命层，给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 用。

dsh 给 Agent 一个会话。这个给它一段**跨会话活着**的生命。

## 补的是什么

dsh 已经自带会话持久化与崩溃恢复（`core/session`）、持久目标（`goal`）、Host 级定时（`schedule`）、后台作业（`jobs`）、逐次批准（`approval`）、进程隔离（`sandbox`）、浏览器所有权（`browser-use`）、技能、上下文压缩。它自己的架构文档写着 *there is no privileged core to patch*。

本包**不重写其中任何一项**。它只补 dsh 没有的那个概念：**活过一次会话的状态**。

| 关注点 | 谁负责 |
| --- | --- |
| 会话持久性 · 崩溃恢复 · 事件重放 | dsh |
| 目标 · 提醒 · 作业 · 批准 · 沙箱 | dsh |
| **身份 · 兴趣 · 技能 · 关系 · 承诺 · 活动 · 账本** | 本包 |

## 提供什么

**三档速度的状态** —— 一个像样的个体，变化速度不止一档：

- **慢** —— 身份、核心性格、表达风格。**主人确认才能改**：一条网页改不动它。
- **中** —— 兴趣、技能、关系。由多次真实经历累积，每条带置信度和来源。
- **快** —— 当前活动。**同时只允许一个**，并带原因。

**13 个模型可见工具**（`life_*`）：我是谁、活动生命周期、兴趣、技能、承诺、人物、账本、主人确认的身份修改、**自己决定何时再来**（`life_wake`），以及**问自己现在能做什么**（`life_candidates`）。

**自主唤醒** —— 每轮结束后向 dsh 的 Host 定时器补一个一次性闹钟；到点后 dsh 往原会话投一条 `source.kind === 'schedule'` 的消息并跑一个普通 turn。抖动、静默时段、每日预算由生命层自己实现（见下文）。

**醒来之后做什么** —— 按 §6.2 的公式把承诺、兴趣、未完成事项、技能和休息排成一份带理由的候选短名单，只在唤醒轮注入（有界，≤600 字符）；「休息」永远在名单里。见下文。

**每轮一段有界的上下文** —— 连续性花的是固定小额 token，不随生命长度增长。唤醒轮会多两句：开头声明「这一轮是你自己醒来的，没有人跟你说话」，结尾要求先读状态再决定继续或休息。

**一条证据规则** —— `life_finish_activity` 要证据，注入的上下文也告诉模型：没有证据就不许声称成功。产品要的是真做过事的鱼。

## 安装

这个包**还没有发布到 npm**，所以 `dsh plugin add dsh-life` 现在会 404。唯一能跑通的是从本地检出安装：

```sh
dsh plugin --profile <你的 profile> add link:/绝对路径/packages/dsh-life
```

> 等它真正发布后，上面这行才会变成 `dsh plugin --profile <你的 profile> add dsh-life`。在那之前 README 不写一条自己一跑就红的命令。

自带 `cordis.patch.yml` 完成挂载，**不需要手改 profile**。装完重启。

## 配置

经 Standard Schema 校验（见 `lib/config.js`）：

```yaml
- id: dsh-life
  name: dsh-life
  config:
    lifeId: default
    name: 大肥鱼
    species: whale
    seeds: ['聪明但懒', '傲娇', '爱吃白饭']
    injectContext: true
    autoCreate: true
    maxLedgerEntries: 20000
    wakeEnabled: true
    wakeEveryMinutes: 90
    wakeJitterMinutes: 20
    wakeQuietStart: '23:00'
    wakeQuietEnd: '08:00'
    wakeMaxPerDay: 6
    wakePrompt: '（自主唤醒）现在没有人跟你说话，是你自己醒的。……'
    chooserEnabled: true
    chooserTopN: 3
```

| 字段 | 含义 |
| --- | --- |
| `lifeId` | `$DSH_HOME/life/` 下的目录名。字母数字 `-` `_`，最长 64。 |
| `name` `species` | 初始身份。**只在生命尚不存在时使用**。 |
| `seeds` | 最多 8 个性格种子。是起点，不是完整人设。 |
| `injectContext` | 每轮注入有界生命快照。 |
| `autoCreate` | 首次加载时若不存在则创建。 |
| `maxLedgerEntries` | 账本上限；远超后折半收敛。 |
| `wakeEnabled` | 是否开启自主唤醒，默认 `true`。 |
| `wakeEveryMinutes` | **最小间隔意图**，15–1440，默认 `90`。它不承诺「每天一定醒一次」；真正承诺的是「不跳过整个日历日」（见下文）。 |
| `wakeJitterMinutes` | 间隔抖动，0–240，默认 `20`（实际间隔为 `every ± jitter`）。 |
| `wakeQuietStart` `wakeQuietEnd` | 静默时段 `HH:MM`，默认 `23:00`–`08:00`，可跨午夜，两端不能相同。 |
| `wakeMaxPerDay` | 每天最多醒来几次，1–48，默认 `6`。按本地日历日重置。 |
| `wakePrompt` | 到点时投进会话的正文，≤1000 字。 |
| `chooserEnabled` | 是否开启活动选择器，默认 `true`。关掉后唤醒轮不加短名单，`life_candidates` 明确报错。 |
| `chooserTopN` | 唤醒轮最多列几条**活动**候选（休息另算），1–5，默认 `3`。 |

## 自主唤醒

**为什么这层在我们这里。** dsh 的 `schedule` 提供一个持久的 Host 定时器，但它的 `ScheduleCreateRequest` 只有 `after_seconds` / `at` / `every_seconds` / 每日 / 每周 / cron 六种选择器，**没有** jitter、免打扰、每日预算，也没有 onFire 回调（源码证据见 `docs/dsh-schedule-api.md` §2、§7）。所以策略必须在生命层实现：

- **抖动**：每次布防取 `wakeEveryMinutes ± wakeJitterMinutes`，避免每天同一秒醒。
- **静默时段**：目标落进 `wakeQuietStart`–`wakeQuietEnd` 就推到静默结束后，再加 0–jitter 的小抖动。
- **每日预算**：`wake.json` 按 `messageId` 幂等记账；当天用满 `wakeMaxPerDay` 后，下一次只布「静默结束后的第一个早晨」，而不是永久停摆或 15 分钟重试。

**不会整天消失。** `wakeEveryMinutes` 是间隔意图，不是「每天醒一次」的承诺；但「一整天一次都不醒」是 bug，不是可接受行为。所以当静默推送会把目标推到**后天或更晚**、中间有整个本地日历日没有任何唤醒时，会把这个目标夹到第一个被跳过那天的最后一个允许时刻（`wakeQuietStart - 1 分钟`，默认 `22:59`），而不是直接跳到次日早晨。判断用本地日历日序号；目标本来就在明天时行为**完全不变**（夜间顺延不受影响）。`wakeQuietStart = '00:00'`（没有可用的前一分钟）或静默配置非法时不做夹取，退回原来的「推到静默结束后」。这段逻辑在 `lib/wake.js` 的 `clampToLastAllowedMoment()`，可单独测试。

**一轮怎么走。** 每个 `turn/end`（主人轮和唤醒轮一样）都会 `list` 一下当前会话的 Host 任务，已有我们自己那个（标题 `自主唤醒`，或 `wake.json` 里记的 id）就不重复建；没有就按上面的策略 `create` 一个一次性任务。做到点后，dsh 自己往原会话投一条 `source.kind === 'schedule'` 的 user 消息并跑普通 turn：

- 投递那一刻记 `wake` 账本（按 `messageId` 幂等——dsh 不保证 exactly-once）、`noteWake` 计数，并标记这一轮是唤醒轮；
- 这轮的系统提示词开头/结尾各多一句，提醒它「没有人跟你说话」和「不要为了显得活着而编造经历」；
- 每轮结束后再补下一个闹钟。

**一条命只在一个会话醒。** 第一次出现非子代理 `turn/end` 时把 `wake.json` 的 `sessionId` 固定下来，之后不再改。子代理会话（`header.delegationDepth > 0`）既不绑定也不布防；如果 dsh 以 `subagent_session` 拒绝，会清空绑定让下一个真实会话重新认领。

**模型自己调时间。** `life_wake` 接受 `afterMinutes`（≥1）或 `at`（ISO 8601），会替换当前那个闹钟而不是叠加；静默时段同样生效；当天预算用完就明确报错「今天已经醒够了」，不会偷偷加。没有 `schedule` 服务的 profile（如 headless）里这个工具会明确报错，而不是静默成功。

**降级。** 拿不到 `schedule` 服务时只用 `info` 说一次「这个 profile 没有 schedule 服务，自主唤醒不会开启」，不 warn、不影响身份、工具和账本；`apply()` 期间零警告是硬约束。

**关掉它会怎样。** `wakeEnabled: false` 或 `wake.json` 里 `paused: true` 只停止**继续布防**；之前已经排上的那个 Host 闹钟仍可能响一次，之后不再续。要立刻取消可以用 dsh 的 `schedule_delete`。

## 醒来之后做什么

§6.2 只给了一条公式，工具和状态都齐了，缺的是「把状态排成候选」。`lib/choose.js` 用纯函数做这件事：零 IO、`now` 可注入、没有随机量，所以同样的历史一定得到同样的顺序，每一分都能追到来源。

```
优先级 = 承诺紧迫度 + 兴趣匹配 + 未完成事项价值 + 适度探索
         - 成本 - 风险 - 切换损耗
```

| `parts` 分项 | 权重 | 来源 |
| --- | --- | --- |
| `commitment` 承诺紧迫度 | 0.55 | 未结承诺的 `dueAt`：逾期 = 1；越近越高；没写日期给 0.15 的底分（不能因为没写就永远排不上）。`YYYY-MM-DD` 按当天本地结束时刻算，所以「今天到期」上午不会算逾期。 |
| `interest` 兴趣匹配 | 0.55 | `confidence` × 新鲜度（`updatedAt` 越久越低，45 天后降到 0.45 的下限）。 |
| `unfinished` 未完成事项 | 0.55 | 上次 `failed` = 0.9、有 `next` = 0.75、上次 `done` = 0.15。 |
| `explore` 适度探索 | 0.12 | 只观察过 ≤2 次的兴趣 +0.15；正在 `learning` 的技能也算探索。 |
| `cost` 成本 | 0.40 | 按候选类型（继续做最便宜，开新活动最贵）；当天唤醒额度只剩 1–2 次时，新活动再额外加价。 |
| `risk` 风险 | 0.20 | 越是不确定/没有先例的候选越高；休息为 0。 |
| `switch` 切换损耗 | 0.25 | 有进行中的活动时，换一件新事扣满，同一件事继续不扣；休息不扣。 |

候选有六种来源：**继续当前活动**（`continue`）、**接着记下的下一步**（`next`）、**再试一次上次失败的事**（`retry`）、**未结承诺**（`commitment`）、**兴趣**（`interest`）、**练技能**（`skill`）。同一件事不会以两种身份重复出现；同一时间仍然只允许一个主要活动，所以有 `current` 时不会生成「再开一件」的候选。每个候选都带：

- `what`：要做什么（中文，能直接执行或拒绝）；
- `score` 与 `parts`：加权后的七项明细，活动候选的 `score` 就是它们相加减的结果；
- `reason`：一句能直接念给人听的中文，例如「「把打法写进技能经验」今天到期，先把它处理掉」；
- `evidence`：这条候选的依据（承诺 id、兴趣观察次数、上次活动的证据、技能记录……）。没有证据时会明确写「无证据，只是想法」，不假装成已发生的事。

**休息是一个候选，不是兜底。** §6.2 明确允许休息、不行动和主动结束，否则模型会为了显得活着而制造事件。所以「休息，什么都不做」永远出现在候选里，分数是**固定的 0.35**（不随历史变化），而且渲染短名单时永远保留、排在最后。当天额度只剩最后 1–2 次时，新活动的成本上调，休息和「继续手上的事」自然上浮——这是为了避免在尾巴上还开一个新大坑。

**只有唤醒轮付这份成本。** 唤醒轮的系统提示词在生命上下文之后追加一段有界短名单（`chooserTopN` 条活动 + 休息，硬上限 600 字符），格式例如：

```
你现在可以做的事（按你自己的历史排的，不是命令）：
1. 把打法写进技能经验 —— 「把打法写进技能经验」今天到期，先把它处理掉
2. 再试一次「练第 38 层」 —— 上一次「练第 38 层」失败了：还是没过，再试一次比开新坑有价值
3. 休息，什么都不做 —— 今天已经醒过 1/6 次；休息也是允许的选择，没必要时时制造活动
```

普通主人轮**一个字符都不加**：这段是给「自己醒来、没人说话」的那一轮用的。`life_candidates` 工具可以在任何一轮按需取完整明细（`topN` 可选，默认 `chooserTopN`），返回 `parts`、`weights`、`notes` 和休息候选，用来回答「为什么它排第一」。`chooserEnabled: false` 时唤醒轮不加短名单，工具会明确报 `life/chooser-disabled`，而不是静默返回空列表。

## 状态布局

`$DSH_HOME/life/<lifeId>/`：

```
identity.json      慢变量 · 带版本号；主人确认的修改才会 +1
traits.json        中变量：兴趣、技能
relations.json     人物，作用域分 keeper / friend / public
commitments.json   承诺及其结算
activity.json      唯一的当前活动 + 上一次已完成的
ledger.jsonl       追加式记录：真实发生了什么
wake.json          唤醒绑定、下一个闹钟、当天预算、已投递 messageId
```

写是原子的（tmp + rename）。读容忍文件缺失或损坏 —— **一个截断的 JSON 不该弄死一条命**。账本会跳过写了一半的尾行，而不是丢掉它周围的历史。

## 本包强制的设计规则

1. **身份不是 Agent 能改的。** `life_identity_update` 会拒绝任何身份字段，除非主人确认过。非身份字段（如展示名）可自由修改。
2. **同时只有一个主要活动。** 起第二个是错误，不是静默覆盖。
3. **要证据，不要声称。** 结束活动要记下结果和证据。
4. **快照有界。** 连续性不该每天多花 token。
5. **不自建定时器。** 唤醒走 dsh 的 `schedule`，插件不持有 `setInterval` —— 自己持有的定时器会随会话一起死掉，那正是 `schedule` 存在要修的问题。抖动 / 静默 / 预算是我们加的**策略**，不是第二套调度器。

## 验证

```sh
node ../../verify/smoke.mjs       # 61 项：存储不变量、持久性、损坏降级、唤醒策略与记账、7 天 soak、活动选择器（确定性，不 spawn dsh）
node ../../verify/e2e-tools.mjs   # 17 项：真实 dsh profile 启动并挂载
node ../../verify/pack-install.mjs # 9 项：打出来的 tarball 能不能装进 profile 并激活
```

`e2e` 那套不是 mock。它从 shipped 模板组合出一个真实的 dsh profile，用 `dsh plugin` 装上，真启动，然后断言运行系统实际产出了什么：磁盘上的身份、账本里的真实 `turn/end` 事件、**装配后**系统提示词里的生命层 section、以及 13 个工具 schema 全部对模型可见。

## 已知限制

- **选择器是规则，不是情绪。** §6.2 的权重仍是初始工程方案：它给的是可解释的短名单，不表示模型必须照做，也不替代长期规划；成本上限之外的判断仍靠模型自己。
- **账本记的是回合边界，不是结果。** 监听工具结果能让账本证明更多，尚未接。
- **没有 UI。** 生命只能通过工具看到。
- **默认每条命一个 profile。** 多个 `lifeId` 可用，但还没有机制阻止两个 profile 指向同一个。
- **连续多日唤醒可靠性未实测。** `docs/PLAN.md` §10.2 的决策门是无人干预 7 天；策略层已用确定性 soak（8 组参数、367 次唤醒）覆盖「不跳日、不落静默、不超预算、跨天重置」，但真实跑 7 天没做过。会话归档会掐断唤醒（dsh 的 `schedule` 语义），产品层还没有归档策略。
- **`every + jitter > 24h` 且目标本身不落静默段时，仍可能跨过一整个日历日**；当前只保证「被静默段推出整天」会被夹回该日最后一个允许时刻。
- **`paused` / `wakeEnabled: false` 不撤销已排的闹钟**，只停止继续布防；见上文的说明。
- **对着 dsh `0.2.1-rc.2` 写的。** dsh 处于 developer preview，官方明写会有破坏性兼容变更，所以这里的配置与工具名还不是稳定契约。
