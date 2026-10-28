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

**18 个模型可见工具**（`life_*`）：我是谁、活动生命周期、兴趣、技能、承诺、人物、账本、主人确认的身份修改、**自己决定何时再来**（`life_wake`）、**问自己现在能做什么**（`life_candidates`），以及发布线的**起草 / 入队检查 / 状态与对账 / 经主人批准后发布**（`life_draft_post`、`life_publish_queue`、`life_publish_status`、`life_publish`），以及**视频标注**（`life_attach_video`）。发布必须过 dsh `approval`，只有 `allowed-once` 才算同意；没有批准通道（headless）一律不发。

**自主唤醒** —— 每轮结束后向 dsh 的 Host 定时器补一个一次性闹钟；到点后 dsh 往原会话投一条 `source.kind === 'schedule'` 的消息并跑一个普通 turn。抖动、静默时段、每日预算由生命层自己实现（见下文）。

**醒来之后做什么** —— 按 §6.2 的公式把承诺、兴趣、未完成事项、技能和休息排成一份带理由的候选短名单，只在唤醒轮注入（有界，≤600 字符）；「休息」永远在名单里。见下文。

**每轮一段有界的上下文** —— 连续性花的是固定小额 token，不随生命长度增长。唤醒轮会多两句：开头声明「这一轮是你自己醒来的，没有人跟你说话」，结尾要求先读状态再决定继续或休息。

**一条证据规则** —— `life_finish_activity` 要证据，注入的上下文也告诉模型：没有证据就不许声称成功。产品要的是真做过事的鱼。

**一屏只读的「运行总览」** —— 在 dsh 的 web 界面里显示它现在在做什么、为什么、今天醒了几次 / 做完几件事 / 失败几次、欠着的事、下次醒来的时间；数据来自 Host 现读状态文件的 `/life/state.json`，客户端零构建。见「界面」一节（含**像素级未验证**的说明）。

**发出去这件事（本轮只做记录与状态机）** —— `draft → checked → approved → sending → confirmed | unconfirmed | failed`；内容标识是硬闸，`sending` 之后拿不到回执一律 `unconfirmed` 且绝不自动重发。见下文。

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
    publisherEnabled: false
    publisherChannels: []
    publisherProviderCode: dsh-life
    publisherMaxOutbox: 200
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
| `publisherEnabled` | 是否开启发布线，**默认 `false`**：没有明确配置渠道就不该有任何对外动作。 |
| `publisherChannels` | 白名单渠道数组，默认 `[]`，每项 `{ id, kind, account, tokenEnv? }`；`kind` 只能是 `telegram` 或 `file`。`tokenEnv` 是**环境变量名**（如 `TELEGRAM_BOT_TOKEN`），不是 token 值；任何 token/secret 类**值字段**都会被拒绝。 |
| `publisherProviderCode` | 写进隐式标识元数据的服务提供者编码，默认 `dsh-life`。 |
| `publisherMaxOutbox` | **草案 + 已结算**的保留预算，10–2000，默认 `200`。`approved`/`sending`/`unconfirmed` 永不修剪、也不占这份预算，所以文件可能超过这个数；超出时先丢最老的草案、再用余量丢最老的已结算记录。 |

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

## 发出去这件事

视频发布线多一步且不可省：原始片段必须先过 `life_attach_video` —— 每帧烧显式标识、容器写隐式标识，然后**回读首帧像素**证明标识真的烧进去了。核验不过就不产出 mediaId，于是草稿无法引用它。批准绑定的是**文件字节**：发布前重新哈希磁盘文件、上传时再核一次，换掉视频不能复用旧批准；没有 ffmpeg 就明确拒绝，绝不发原片。

发布线分两层：**记录与状态机**（起草 / 标识 / outbox / 对账）和**批准与渠道**（`life_publish` 走 dsh `approval`，Telegram 适配器从环境变量读 token）。测试始终不联网、不真的发帖；真实发送只有在用户配置了带 `tokenEnv` 的渠道、且主人对**这一版内容**点了同意之后才会发生。

状态流照 `docs/PLAN.md` §7.3，一字不改：

```
draft → checked → approved → sending → confirmed | unconfirmed | failed
```

- `life_draft_post`：从**真实经历**起草。`evidence` 必须引用账本里已存在的东西（`activity-end` 的 id/证据，或某条账本的时间）；引用不存在就拒绝——没做过的事不许写成做过。它只写一条 `outbox.json` 记录，不批准、不发送。
- `life_publish_queue`：给正文加**显式标识**（含内容编号）、算出 `contentVersion`，把 `draft` 推到 `checked`，然后返回「等待主人确认」。**它不能把自己变成 `approved`**：只有 `life_publish` 在拿到 `allowed-once` 之后才会。
- `life_publish_status`：看 outbox；`reconcile: true` 时对注入的 transport 做一次**显式**对账（没有注入就明确说「未配置渠道」，不会假装查过）。
- `life_publish`：唯一的发送入口。先向 dsh 的 `approval` 服务请求批准，**只认 `allowed-once`**；`rejected` / `cancelled` / `unavailable` 一律不发送（headless 没有 UI，结果是 `unavailable`，fail closed）。批准之后会**重新从存储读记录并重算 `contentVersion`**，对不上就回到 `checked`（TOCTOU）。成功后保存 `platformId`；拿不到回执一律 `unconfirmed`，不自动重试。账本只记 `publish` 的摘要与长度，不记正文。
- **保留策略**：`approved` / `sending` / `unconfirmed` 描述的是「可能已经发生的外部动作」，**永不删除**，也不占 `publisherMaxOutbox` 预算。只有最老的草案（`draft`/`checked`）与最老的已结算记录（`confirmed`/`failed`）会被清；`life_draft_post` 的返回和 `outbox.json` 的 `lastPruned` 会写明丢了几条，避免「我的草稿怎么没了」无从查起。

**改一个字就失效。** `approved` 绑定 `contentVersion`（正文 sha256 前 16 位）+ `channel` + `account`（状态机也支持可选有效期；dsh 的 `approval` 本身不带 TTL）。发送前会从**当前正文**重新推导标识与版本；对不上就把旧批准作废、退回 `checked`。主人同意的是那一版字节，不是「这个想法」。

**`sending` 之后一律先怀疑。** 进入 `sending` 之前先把状态**原子落盘**；之后 transport 抛错、超时、返回没有 `platformId`，一律记 `unconfirmed`，`platformId` 留空，**绝不自动重发**。同一幂等键同时只允许一次发送在进行：并发进来的第二次会明确返回 `send-in-flight`，不会也调用 transport。`unconfirmed` 只有两条出路：

- 显式 `reconcile`：查到平台对象 → `confirmed`（保存 `platformId`）；平台明确说「没有」→ 才允许回到 `approved`（并记录这次对账结论）；查不了/没结论 → 保持 `unconfirmed`，等人确认。
- `confirmManually({ platformId })`：人工确认。

进程重启时，磁盘上的 `sending` 在读入时按 `unconfirmed` 处理（时间线记 `recovered-after-reload`），不会因为重启就再发一次。这也是产品决策门的核心用例：**故意制造「发送成功但回执丢失」，系统必须停下来对账，不能重复发帖。**

**谁可以说发。** dsh 的 `approval.request({ agent, toolName, callId?, reason?, signal? })` 只有四种结果，**只有 `allowed-once` 是授权**：`rejected`（主人/策略拒绝）、`cancelled`、`unavailable`（没有批准通道——headless/无 UI 就是它）。`unavailable` **不是「没人反对」**，一律不发送。批准请求里没有摘要/账号/TTL 字段，所以 `reason` 里写 `contentId`+`contentVersion`+`channel`+`account`+正文首行（≤200 字符），并在批准后重算版本再校验一次——否则批准后被改写内容就是 TOCTOU。dsh 没有 request 级 TTL，所以本包**不新增** `publisherApprovalTimeoutSeconds` 之类的假配置。

**token 从哪来。** 配置里只存环境变量名 `tokenEnv`，值只在发送那一刻从 `process.env[tokenEnv]` 读；token 不会进 outbox、账本、工具返回值或日志（Telegram 适配器的错误信息会先擦掉 token）。**但加密钥不是安全边界**：dsh 官方明说 agent 工具进程与用户是同一个 OS 用户，读得到凭据存储；挡住「模型自己发帖」的是 approval + 工具边界，不是密钥藏得好。

**标识不能关。** 按 `docs/PLAN.md` §6.8 与 `docs/compliance-cn.md` 第 4/5 条：显式标识写在正文里、必须带内容编号；`metadata` 带生成合成属性、服务提供者编码与内容编号，纯文本渠道明确记 `implicit: 'not-applicable'`，不假装写了文件元数据。`lib/compliance.js` **没有 `strip` 之类的函数**，也不导出；`assertLabeled()` 是进入 `confirmed` 之前的硬闸——transport 说成功也不能绕过。文案可换模板，但模板必须含 `{contentId}`，否则直接报错。

**为什么 `publisherEnabled` 默认 `false`。** 没配渠道的一条命不应该有对外动作。开启后 `publisherChannels` 是白名单（每项 `{ id, kind, account, tokenEnv? }`）；配置里不允许出现 token/secret 一类的**值**字段，校验会直接拒绝，只接受环境变量名。transport 注入优先级：`apply()` 的 `config.transport`（测试/宿主）> context 的 `lifeTransport` 服务 > 测试上下文 `root.lifeTransport`；没有注入时，`telegram` 渠道会用 `tokenEnv` 构建内置适配器（`lib/telegram.js`）。transport 契约是 `send(candidate) -> { platformId }`（抛错=结果未知）与可选的 `query(candidate) -> { platformId } | { found: false } | null`；Telegram Bot API 没有按幂等键反查的能力，所以它的 `query()` 明确返回 `null`（= 查不了，保持 `unconfirmed`）。

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
outbox.json        发布线：每条内容的稳定编号、版本、批准、状态时间线、平台回执
```

写是原子的（tmp + rename）。读容忍文件缺失或损坏 —— **一个截断的 JSON 不该弄死一条命**。账本会跳过写了一半的尾行，而不是丢掉它周围的历史。

## 界面

插件在 dsh 的 web 界面里挂一屏只读的**运行总览**：它现在在做什么、为什么（`activity.why`）、今天醒了几次 / 做完几件事 / 失败几次、欠着的事（最多 3 条，带到期时间）、下次醒来的时间。界面只读，不能改任何状态。

**数据从哪来。** Host 半身 `lib/ui.js` 在 profile 有 `webServer` 时注册一个精确路由 `/life/state.json`；handler 每次请求都**现读 `LifeStore`**（不缓存、不预先组装），所以屏幕上不可能出现昨天的故事被当成今天。返回的字段只有 `generatedAt`、`identity{name,species,revision}`、`activity{what,why,startedAt}`、`nextWakeAt`、`wakeCountToday`、`openCommitments[{what,dueAt}]`、`today{turns,wakes,activities,failures}`。**不回** `relations` 的备注、**不回**账本正文 —— 私密内容不出 Host。状态文件坏掉时返回 `{ ok: false, error: "life/state-corrupt:<file>" }`，而不是编一个看起来正常的界面。

**为什么客户端零构建。** dsh 的 web shell 用自有 lazy-CJS 表加载客户端模块：`window.__ModuleLoader__.load({ id, factory })`，`require('react')` 由 shell 提供。所以 `client/life-overview.js` 是一份手写文件，不含 JSX、不引依赖、不需要打包；`package.json` 里 `dsh.client.platform = 'web'`、`exports['./client']` 指向它、`files` 带上 `client/`。同时**保留** `dsh.bundle.patch`：只写 `dsh.client` 会让 `dsh plugin add` 只当普通依赖装、插件行不挂，客户端半身就永远不会被扫描（这个坑在 `docs/dsh-ui-slots.md` 里记着）。注册进 `shell.overlay`（已验证的 shell 级 slot）；`settings.section` 用同一个组件额外注册一次，slot 不存在就静默跳过。

**没有界面的 profile 不受影响。** `webServer` 不在模块级 `inject` 里；headless/SDK 组合没有它，`installLifeUi` 就什么都不注册、不 warn —— 工具面仍是 17 个，验证见 `verify/ui.mjs` 的 headless 一节。

**像素级未验证。** 我们只在两层证明过它：客户端模块出现在页面的 boot manifest 里、被 shell 按 URL 取到；模块在桩 loader 里执行 `apply()` 后确实注册进了 slot 并产出元素。**没有人真的看着它在屏幕上渲染出来** —— 本仓库没有可驱动的浏览器。别把「注册成功」读成「看得见」。

## 本包强制的设计规则

1. **身份不是 Agent 能改的。** `life_identity_update` 会拒绝任何身份字段，除非主人确认过。非身份字段（如展示名）可自由修改。
2. **同时只有一个主要活动。** 起第二个是错误，不是静默覆盖。
3. **要证据，不要声称。** 结束活动要记下结果和证据。
4. **快照有界。** 连续性不该每天多花 token。
5. **不自建定时器。** 唤醒走 dsh 的 `schedule`，插件不持有 `setInterval` —— 自己持有的定时器会随会话一起死掉，那正是 `schedule` 存在要修的问题。抖动 / 静默 / 预算是我们加的**策略**，不是第二套调度器。
6. **外部副作用先记「发送中」。** 状态落盘之后才允许调用 transport；拿不到平台对象 ID 就是 `unconfirmed`，没有自动重发，只有显式对账或人工确认。
7. **批准绑定字节。** 改一个字旧批准就失效；批准字段（版本/渠道/账号/有效期）缺失或过期都不允许发送。
8. **标识是硬闸。** 没有显式标识（含内容编号）与元数据，记录不能进入 `confirmed`；没有任何去除标识的函数。

## 验证

```sh
node ../../verify/smoke.mjs       # 68 项：存储不变量、持久性、损坏降级、唤醒策略与记账、7 天 soak、活动选择器（确定性，不 spawn dsh）
node ../../verify/day-report.mjs  # 22 项：把账本渲染成「它的一天」的报告工具
node ../../verify/life-week.mjs   # 16 项：7 天生命线的端到端回放
node ../../verify/e2e-tools.mjs   # 17 项：真实 dsh profile 启动并挂载
node ../../verify/pack-install.mjs # 9 项：打出来的 tarball 能不能装进 profile 并激活
```

`e2e` 那套不是 mock。它从 shipped 模板组合出一个真实的 dsh profile，用 `dsh plugin` 装上，真启动，然后断言运行系统实际产出了什么：磁盘上的身份、账本里的真实 `turn/end` 事件、**装配后**系统提示词里的生命层 section、以及 17 个工具 schema 全部对模型可见。

## 已知限制

- **选择器是规则，不是情绪。** §6.2 的权重仍是初始工程方案：它给的是可解释的短名单，不表示模型必须照做，也不替代长期规划；成本上限之外的判断仍靠模型自己。
- **账本记的是回合边界，不是结果。** 监听工具结果能让账本证明更多，尚未接。
- **没有 UI。** 生命只能通过工具看到。
- **默认每条命一个 profile。** 多个 `lifeId` 可用，但还没有机制阻止两个 profile 指向同一个。
- **连续多日唤醒可靠性未实测。** `docs/PLAN.md` §10.2 的决策门是无人干预 7 天；策略层已用确定性 soak（8 组参数、367 次唤醒）覆盖「不跳日、不落静默、不超预算、跨天重置」，但真实跑 7 天没做过。会话归档会掐断唤醒（dsh 的 `schedule` 语义），产品层还没有归档策略。
- **`every + jitter > 24h` 且目标本身不落静默段时，仍可能跨过一整个日历日**；当前只保证「被静默段推出整天」会被夹回该日最后一个允许时刻。
- **`paused` / `wakeEnabled: false` 不撤销已排的闹钟**，只停止继续布防；见上文的说明。
- **发布线只验证到「批准 + 假 transport」。** approval 四态、TOCTOU、`unconfirmed` 都用假 approval/假 fetch 覆盖；真实 Web 弹窗没点过、真实 Telegram 一次也没发过（测试从不联网）。Telegram `query()` 不可用，所以「已发但回执丢失」只能靠人工确认。
- **平台会剥掉隐式标识。** 我们保证自己这一端显式+隐式都写；第三方平台重编码/剥离元数据不在我们控制内，不声称「已完全合规」（见 `docs/compliance-cn.md` §五）。
- **对着 dsh `0.2.1-rc.2` 写的。** dsh 处于 developer preview，官方明写会有破坏性兼容变更，所以这里的配置与工具名还不是稳定契约。
