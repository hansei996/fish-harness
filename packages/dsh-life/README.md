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

**12 个模型可见工具**（`life_*`）：我是谁、活动生命周期、兴趣、技能、承诺、人物、账本、主人确认的身份修改，以及**自己决定何时再来**（`life_wake`）。

**自主唤醒** —— 每轮结束后向 dsh 的 Host 定时器补一个一次性闹钟；到点后 dsh 往原会话投一条 `source.kind === 'schedule'` 的消息并跑一个普通 turn。抖动、静默时段、每日预算由生命层自己实现（见下文）。

**每轮一段有界的上下文** —— 连续性花的是固定小额 token，不随生命长度增长。唤醒轮会多两句：开头声明「这一轮是你自己醒来的，没有人跟你说话」，结尾要求先读状态再决定继续或休息。

**一条证据规则** —— `life_finish_activity` 要证据，注入的上下文也告诉模型：没有证据就不许声称成功。产品要的是真做过事的鱼。

## 安装

```sh
dsh plugin --profile <你的 profile> add dsh-life
# 或从本地检出：
dsh plugin --profile <你的 profile> add link:/绝对路径/packages/dsh-life
```

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
| `wakeEveryMinutes` | 基础唤醒间隔，15–1440，默认 `90`。 |
| `wakeJitterMinutes` | 间隔抖动，0–240，默认 `20`（实际间隔为 `every ± jitter`）。 |
| `wakeQuietStart` `wakeQuietEnd` | 静默时段 `HH:MM`，默认 `23:00`–`08:00`，可跨午夜，两端不能相同。 |
| `wakeMaxPerDay` | 每天最多醒来几次，1–48，默认 `6`。按本地日历日重置。 |
| `wakePrompt` | 到点时投进会话的正文，≤1000 字。 |

## 自主唤醒

**为什么这层在我们这里。** dsh 的 `schedule` 提供一个持久的 Host 定时器，但它的 `ScheduleCreateRequest` 只有 `after_seconds` / `at` / `every_seconds` / 每日 / 每周 / cron 六种选择器，**没有** jitter、免打扰、每日预算，也没有 onFire 回调（源码证据见 `docs/dsh-schedule-api.md` §2、§7）。所以策略必须在生命层实现：

- **抖动**：每次布防取 `wakeEveryMinutes ± wakeJitterMinutes`，避免每天同一秒醒。
- **静默时段**：目标落进 `wakeQuietStart`–`wakeQuietEnd` 就推到静默结束后，再加 0–jitter 的小抖动。
- **每日预算**：`wake.json` 按 `messageId` 幂等记账；当天用满 `wakeMaxPerDay` 后，下一次只布「静默结束后的第一个早晨」，而不是永久停摆或 15 分钟重试。

**一轮怎么走。** 每个 `turn/end`（主人轮和唤醒轮一样）都会 `list` 一下当前会话的 Host 任务，已有我们自己那个（标题 `自主唤醒`，或 `wake.json` 里记的 id）就不重复建；没有就按上面的策略 `create` 一个一次性任务。做到点后，dsh 自己往原会话投一条 `source.kind === 'schedule'` 的 user 消息并跑普通 turn：

- 投递那一刻记 `wake` 账本（按 `messageId` 幂等——dsh 不保证 exactly-once）、`noteWake` 计数，并标记这一轮是唤醒轮；
- 这轮的系统提示词开头/结尾各多一句，提醒它「没有人跟你说话」和「不要为了显得活着而编造经历」；
- 每轮结束后再补下一个闹钟。

**一条命只在一个会话醒。** 第一次出现非子代理 `turn/end` 时把 `wake.json` 的 `sessionId` 固定下来，之后不再改。子代理会话（`header.delegationDepth > 0`）既不绑定也不布防；如果 dsh 以 `subagent_session` 拒绝，会清空绑定让下一个真实会话重新认领。

**模型自己调时间。** `life_wake` 接受 `afterMinutes`（≥1）或 `at`（ISO 8601），会替换当前那个闹钟而不是叠加；静默时段同样生效；当天预算用完就明确报错「今天已经醒够了」，不会偷偷加。没有 `schedule` 服务的 profile（如 headless）里这个工具会明确报错，而不是静默成功。

**降级。** 拿不到 `schedule` 服务时只用 `info` 说一次「这个 profile 没有 schedule 服务，自主唤醒不会开启」，不 warn、不影响身份、工具和账本；`apply()` 期间零警告是硬约束。

**关掉它会怎样。** `wakeEnabled: false` 或 `wake.json` 里 `paused: true` 只停止**继续布防**；之前已经排上的那个 Host 闹钟仍可能响一次，之后不再续。要立刻取消可以用 dsh 的 `schedule_delete`。

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
node ../../verify/smoke.mjs       # 26 项：存储不变量、持久性、损坏降级
node ../../verify/e2e-tools.mjs   # 15 项：真实 dsh profile 启动并挂载
```

`e2e` 那套不是 mock。它从 shipped 模板组合出一个真实的 dsh profile，用 `dsh plugin` 装上，真启动，然后断言运行系统实际产出了什么：磁盘上的身份、账本里的真实 `turn/end` 事件、**装配后**系统提示词里的生命层 section、以及 12 个工具 schema 全部对模型可见。

## 已知限制

- **唤醒后的活动选择仍是手动的。** 醒是醒了，读状态、挑活动、收尾都靠模型自己；没有候选排序，也没有「醒来后不知道要干什么」的兜底流程。
- **账本记的是回合边界，不是结果。** 监听工具结果能让账本证明更多，尚未接。
- **没有 UI。** 生命只能通过工具看到。
- **默认每条命一个 profile。** 多个 `lifeId` 可用，但还没有机制阻止两个 profile 指向同一个。
- **连续多日唤醒可靠性未实测。** `docs/PLAN.md` §10.2 的决策门是无人干预 7 天；接口可用只证明能接上，不证明长跑不漂移。会话归档会掐断唤醒（dsh 的 `schedule` 语义），产品层还没有归档策略。
- **`paused` / `wakeEnabled: false` 不撤销已排的闹钟**，只停止继续布防；见上文的说明。
- **对着 dsh `0.2.1-rc.2` 写的。** dsh 处于 developer preview，官方明写会有破坏性兼容变更，所以这里的配置与工具名还不是稳定契约。
