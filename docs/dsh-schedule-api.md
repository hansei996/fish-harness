# dsh-schedule API：插件如何注册、如何被唤醒

> 基线：dsh `0.2.1-rc.2`，装于 `_dshrt/node_modules/`（2026-10-26 读源码）。`包名/文件:行号` 的真实路径为 `_dshrt/node_modules/.pnpm/**/node_modules/@deepseek-ai/<包名>/<文件>`。只写读到的事实，没读到的进「未知项」。

## 结论

**能做，且不需要自建定时器。**

- 服务名 `schedule`，注入字符串 `'schedule'`：`root.inject(['schedule'], (ctx) => …)`。
- 注册：`ctx.schedule.create(sessionId, { title, prompt, after_seconds | at | every_seconds | daily | weekly | cron })` → 返回带 `id`/`scheduledAt` 的记录；取消只有 `ctx.schedule.delete({ sessionId, id })`。任务在 Host storage domain，重启自动重载并补投逾期任务。
- 「唤醒」不是回调，而是一次**真实 turn**：dsh 自己 `resolveAgent(sessionId)` 恢复会话 → 投一条 `source.kind === 'schedule'` 的 user 消息 → `agent.followup()` 唤醒 driver。插件侧没有 onFire，只能从该会话的 `session/event` 观测 `user/message`；`schedule/changed` 只表示任务集变了，无 payload。
- 约 35 行可落地：`turn/end` 后保证有一个一次性唤醒；`user/message` 且 source 为 `schedule` 时记账。
- 已核实缺口：无 jitter / 免打扰 / 每日预算；`every_seconds` 最小 60s；任务按 `sessionId` 绑定；投递不保证 exactly-once；`headless`/`sdk` 模板不挂 `dsh-web-app`，因此**没有** `schedule` 服务。

## 1. 服务与注入（Q1）

`ScheduleService` 构造时 `super(ctx, "schedule")`（`dsh-schedule/lib/index.js:1992`），类型面是 module augmentation `interface Context { schedule: ScheduleService }`（`dsh-schedule/lib/types/index.d.ts:11-16`）。官方工具插件取服务的写法可直接抄：`ctx.inject(["schedule"], (scheduleCtx) => …)`（`dsh-tool-schedule/lib/index.js:497`）。服务自身依赖 `["agents","sessions","storageDomain","sessionController","sessionPersistence"]`（`dsh-schedule/lib/index.js:1969-1975`），必须与 Session 控制器、持久化后端同进程。

**在不在真实 profile 里**：`dsh-web-app` 的 patch 以 `id: schedule` 挂载它（`dsh-web-app/cordis.patch.yml:135-140`），desktop profile 的 bundles 含 `dsh-web-app`（`~/.dsh/profiles/desktop/package.json:18`）→ 桌面上有。反例：`headless` 模板只有 `dsh-base + dsh-headless`（`dsh-app-boot/lib/index.js:554`），headless bundle 明写 “mounts no Host”（`dsh-headless/cordis.patch.yml:1-2`）→ 没有 schedule。`verify/e2e-tools.mjs:63` 用的正是 headless 模板，**e2e 里唤醒测不出来**。

保持 `root.inject(['schedule'], …)`，不要加进模块级 `export const inject`：dsh-life 的定位是 partial profile 也能启动（`dsh-life/lib/index.js:35-36`），拿不到服务只该「不布防」，不该整个插件不加载。

## 2. 注册一个持久定时器（Q2）

```ts
create(sessionId: SessionId, request: ScheduleCreateRequest, signal?: AbortSignal): Promise<ScheduleRecord>
```
（`dsh-schedule/lib/types/index.d.ts:69`；实现 `lib/index.js:2083-2114`）。`ScheduleCreateRequest` 全部字段（`dsh-schedule/lib/types/types.d.ts:311-328`）：

| 字段 | 含义 | 约束 |
| --- | --- | --- |
| `prompt` | 到点进入会话的正文 | trim 后非空 |
| `title` | 任务名 | 必填，1–120 字符（`lib/index.js:23`） |
| `after_seconds` / `at` | 一次性：延迟秒数 / 绝对时刻（RFC 3339 带偏移，或 `{date,time,time_zone}`） | 正安全整数 / 严格未来 |
| `every_seconds` | 固定周期 | 安全整数且 ≥ 60（`lib/index.js:21`） |
| `daily`/`weekly`/`cron` | 墙钟规则 | 必须显式 IANA `time_zone` |

六个选择器恰好一个（`lib/index.js:2084`），否则 `invalid_selector`；`id` 形如 `schedule-<uuid>`（`lib/index.js:2086`）。取消：`delete({sessionId,id})` → `{deleted:true}` 或 `{deleted:false, code:'schedule_not_found'}`（`types/index.d.ts:102`、`lib/index.js:2164-2181`）。`update` 要交回完整 `expected` 做 compare-and-set（`types.d.ts:363-369`），对「重新布防」没价值，delete+create 更简单。

**持久性**：任务写在 `storageDomain.open(scheduleDomain)` 的 `tasks` 表，`Service.init` 建好 runtime 后立刻 `requestDrive()`（`lib/index.js:1997-2029`），重启后逾期任务重新计算并在启动时投递。官方 README：「one version-1 `schedule` domain … one Host timer」（`dsh-schedule/README.md:63`）、「The Host must be running to deliver reminders」（`README.md:153`）。`create` 不去重，每次都是新 id——要「只有一个闹钟」就先 `list`；子代理会话会被拒（`subagent_session`，`lib/index.js:2097-2098`、`2254-2260`）。

## 3. 到点之后发生了什么（Q3）

`ScheduleRuntime.drive()` 的全部动作（`dsh-schedule/lib/index.js:1562-1647`）：

```js
const resolved = await this.ctx.sessionController.resolveAgent(task.sessionId)  // 1576：冷会话在此恢复
const message = createUserMessage({
  content: [{ type: 'text', text: renderReminderFraming(task.record) }],         // 1586-1595
  source: { kind: 'schedule' },                                                  // 1594
})
resolved.agent.followup(message)                                                 // 1596：入 inbox 并唤醒 driver
if (!await this.ctx.sessions.flush(resolved.agent.session)) throw …              // 1597：落盘才确认投递
```

`followup` 的语义是「Queue an ordinary follow-up turn and wake the driver. The item becomes the sole ordinary message of its own turn.」（`dsh-agent/lib/types/runtime-types.d.ts:187-192`）。所以：**不新建会话、不触发插件事件，只是往原会话塞一条 user 消息再跑一个普通 turn**；会话空闲/冷掉也没关系（`dsh-api-session-controller/lib/types/agent.d.ts:100-105` 的 resolve-or-resume）。

模型看到固定框架 + 我们写的 prompt（`lib/index.js:1386-1401`）：

```
[SCHEDULE REMINDER]
This is a scheduled message from the user
schedule_id_json: "schedule-…"
occurrence_at: 2026-10-26T15:00:00.000Z
reminder_prompt_json: "（create 时传的 prompt）"
```
周期任务合并成一条 `[SCHEDULE REMINDER BATCH]` + `reminders_json`（`lib/index.js:1407-1418`）。插件在唤醒那刻没有专属上下文：只有 (a) 这条 `user/message` 事件；(b) 无参数的 `schedule/changed`（`lib/index.js:2231-2237`，投递 commit 时也会发，`2024-2027`）；(c) 事后 `history()` 拿回执。真正的「生命上下文」仍由 dsh-life 的 prompt section 每轮重渲染（`dsh-life/lib/index.js:74-93`），唤醒 turn 一样拿得到。

## 4. 记账用哪些事件（Q4）

先排除坑：`schedule/change` 是**历史** v1 会话事件（`types/types.d.ts:301-309`），当前 Host 任务不写它，只在 `session/created` 折叠旧日志并告警（`lib/index.js:2031-2041`；`README.md:75` “Historical events do not populate the Host task table”）。**不要拿它记账。**

- `session/event` → `user/message`：data 是整条 `UserMessage`（`id`/`content`/`source`，`dsh-session/lib/types/types.d.ts:295`、`dsh-llm/lib/types/message.d.ts:124-146`）。
- `session/event` → `turn/start` / `turn/end`：`{turn}` / `{turn,reason}`（`types.d.ts:256-287`）；另有 `step/start`、`tool/call`、`tool/result`（词表见 `dsh-session/lib/types/known-event-types.js`）。
- Cordis `schedule/changed`：无参数（`dsh-schedule/lib/types/types.d.ts:414-420`）。
- `schedule.history({sessionId,id,limit})`：`{scheduledAt, deliveredAt, messageId, prompt?}`（`types.d.ts:169-182`、`385-413`）——唯一权威的「真投出去了」凭证。

信封是 `{type, seq, time, data}`（`types.d.ts:490-544`），监听签名 `'session/event'(session, event)`（`types/index.d.ts:61`），dsh-life 已在用（`dsh-life/lib/index.js:103-123`）。回执的 `messageId` 与事件的 `data.id` 同值（`lib/index.js:1606` 传入；`message.d.ts:126` 定义 `id`），所以能对账而不必解析正文。

## 5. 区分「唤醒的 turn」与「主人说话」（Q5）

唯一可靠判据是 producer：唤醒 = `source: {kind:'schedule'}`（`dsh-schedule/lib/index.js:1594`；类型 `dsh-schedule/lib/types/runtime.d.ts:2-8`）；主人在 Web 说话 = `source: {kind:'user', rpcId, …}`（`dsh-api-session-controller/lib/index.js:3224-3228`）。时序上 `turn/start` 先开、`user/message` 后进（`types.d.ts:257-262`；append 在 step 内，`dsh-agent-loop/lib/index.js:1069-1073`），且一条 followup 独占自己的一轮（`runtime-types.d.ts:187-192`），所以「按会话置 flag、到 `turn/end` 消费」是准确的。

## 6. 模型可见的 schedule_* 工具（Q6）

`@deepseek-ai/dsh-tool-schedule` 注册四个工具（`lib/index.js:506-659`），挂在 `standard`/`cordis`/`ptc` 预设（`dsh-web-app/presets/standard.patch.yml:35-36`、`cordis.patch.yml:38-39`、`ptc.patch.yml:35-36`）：

| 工具 | 参数 |
| --- | --- |
| `schedule_create` | `prompt`、`title` 必填 + `after_seconds`/`at`/`every_seconds`/`daily`/`weekly`/`cron` 六选一 |
| `schedule_list` | 无 |
| `schedule_update` | `id` 必填 + 可选 `title`/`prompt` + 至多一个 timing |
| `schedule_delete` | `id` 必填 |

schema 原文 `lib/index.js:510-526`、`602-658`；它们永远作用于调用者自己的会话（`ctx.schedule.create(agent.session.id, …)`，`lib/index.js:540`）。dsh-life 不必复用它们；要让模型自己定「多久后叫我」，注册 `life_wake` 即可：`execute(args, exec)` 的 `exec.agent.session.id`（`dsh-tools/lib/types/index.d.ts:128`；`ToolExecution.agent?: Agent` 在同文件 `228-229`）。dsh-life 的 `tool()` 帮助器目前写死 `execute(args)`（`dsh-life/lib/index.js:306`），加个形参就行。

## 7. 时区 / 抖动 / 免打扰 / 预算（Q7）

- **时区有**：`daily`/`weekly`/`cron` 必须给 `time_zone`（`types.d.ts:106-128`），DST 空洞跳过、重复取较早一次（`types.d.ts:53-54`、`README.md:41,45`）；`at` 支持带偏移 RFC 3339 或 `{date,time,time_zone}`（`types.d.ts:129-139`）。
- **抖动、免打扰、每日预算都没有**：全包大小写不敏感搜 `jitter|quiet hour|budget` **0 命中**；可传字段就是 `ScheduleCreateRequest` 那六个（`types.d.ts:311-328`）；`Config` 只有 `deliveryHistoryDays` / `deliveryHistoryRecords`（`lib/index.js:1976-1979`）。
- **无自动重试**：失败只 warn，任务留表，等下次管理操作/其它唤醒/重启（`lib/index.js:1627-1633`、`README.md:153`）。最小粒度：`every_seconds ≥ 60`，cron 五字段也是一分钟（`README.md:159`）。

结论：抖动、静默时段、每日预算得在**生命层实现**（`after_seconds` 加随机量、用 `at` 把目标推离静默段、用自己账本数当天唤醒次数），不要找 schedule 的字段。

## 8. schedule 不够用时的退路（Q8）

- `ctx.jobs` **不是**调度器：`JobRegistry` 只有 `start/list/get/read/readAt/kill/wait/remove/attachController`，是「跑后台作业」的进程内注册表（`dsh-jobs/lib/types/index.d.ts` 全文；进程内实现见 `dsh-jobs-local`），没有 cron、不跨重启。
- 宿主没有第二个 Host 级定时服务；`schedule` 自己的定时器就是 `setTimeout(...).unref()`（`dsh-schedule/lib/index.js:1641-1646`）。插件自建 `setInterval` 会随会话/进程消失，正是 `docs/PLAN.md:388-398`、`615-626` 要避免的做法。
- 社区包 `dsh-proactive`：registry 描述（`npm view dsh-proactive`，2026-10-26）为 `0.3.2`，自称 once/interval/cron + random jitter、wake cold sessions、quiet hours、daily budget、silent wake 回收（仓库 `github.com/john-walks-slow/dsh-proactive`）。**未安装**在当前 desktop profile（`~/.dsh/profiles/desktop/package.json:4-14`），**源码未读**；与内置 schedule 并用会有两套唤醒源。
- 外部驱动（OS 计划任务定期起 `dsh --profile …`）在 dsh 侧没有现成证据 → 未知项。

**推荐**：内置 `ctx.schedule` + 生命层补抖动/静默/预算。零新依赖，且它已经在桌面上挂着。

## 可直接抄的代码

放在 `apply(root, config)` 里，与现有 `root.inject(['tools'], …)` 并列：

```js
root.inject(['schedule'], (ctx) => {
  const wakeTurns = new Set() // sessionId：本轮是否被唤醒

  const arm = async (sessionId) => {
    try {
      if ((await ctx.schedule.list({ sessionId })).length > 0) return // 已有 active 任务就不重复布防
      const record = await ctx.schedule.create(sessionId, {
        title: '自主唤醒',
        prompt: '没有人说话，你是自己醒来的。先 life_whoami 读状态，再决定继续活动或明确休息；不要虚构经历。',
        after_seconds: 45 * 60 + Math.floor(Math.random() * 15 * 60), // schedule 无 jitter，自己加
      })
      store.recordWakeArm({ sessionId, scheduleId: record.id, at: record.scheduledAt }) // 需新增
    } catch (err) {
      warn(root, `could not arm wake-up: ${messageOf(err)}`) // 子代理会话会 subagent_session
    }
  }

  disposers.push(ctx.on('session/event', (session, event) => {
    if (!event || typeof event !== 'object') return
    if (event.type === 'user/message') {
      const m = event.data
      if (!m || !m.source || m.source.kind !== 'schedule') return // 主人说话是 kind === 'user'
      wakeTurns.add(session.id)
      store.appendLedger({ kind: 'wake', detail: { sessionId: session.id, messageId: m.id } },
        { cap: settings.maxLedgerEntries })
    } else if (event.type === 'turn/end') {
      const d = event.data && typeof event.data === 'object' ? event.data : {}
      store.appendLedger({ kind: 'turn', detail: { sessionId: session.id, turn: d.turn ?? null,
        woke: wakeTurns.delete(session.id) } }, { cap: settings.maxLedgerEntries })
      void arm(session.id) // 每轮结束补齐：主人轮、唤醒轮都算
    }
  }))
})
```

`store.recordWakeArm` 是新增方法（现有 `LifeStore` 只有 `appendLedger` 等，`dsh-life/lib/index.js:48`）。`ctx.on` 返回 disposer（现有写法 `lib/index.js:103-123`）；`session/event` 同步 emit（`dsh-session/lib/types/index.d.ts:55-61`），异步 `arm` 用 `void` 起、内部 catch，不要冒泡。

## 未知项与建议

1. **e2e 必须换模板**：`verify/e2e-tools.mjs:63` 用 `headless`，不挂 `dsh-web-app` → 没有 `schedule`。要验唤醒得用 `web` 模板（`dsh-app-boot/lib/index.js:553`）并让 web 运行时常驻；CI 成本上升。未实跑验证。
2. **会话归档会掐断唤醒**：有 active 提醒的会话归档被拒；选择停掉再归档会删掉这些提醒，取消归档也不恢复（`dsh-schedule/README.md:49`、`lib/index.js:2056-2058`、`2273-2292`）。产品层要定策略。
3. **一个 life 绑几个会话？** 任务按 `sessionId` 绑定，`create` 不校验会话存在（只查子代理，`lib/index.js:2254-2260`）。对每个会话布防 = 同一条命在多处各醒一次。建议在 dsh-life 存唯一 `companionSessionId`（当前 `LifeStore` 没有该字段），或加配置项。
4. **子代理轮也会触发监听**：`session/event` 是全局的，子代理的 `turn/end` 一样会调 `arm`，只是被 `subagent_session` 拒掉。日志会吵；dsh-life 零依赖，不能直接 import `delegationDepthOf`，需白名单过滤。
5. **不保证 exactly-once**：`README.md:154` 明说 enqueue 与任务写入非原子，崩溃可能重复投递。账本要按 `messageId` 幂等，不能按「醒了几次」计数。
6. **连续多日可靠性未实测**：`docs/PLAN.md:615-626` 的决策门是 7 天每天都有可解释活动；本文只证明接口存在，不证明长跑不漂移。
7. **`dsh-proactive` 只读 registry 描述**，未读源码，不判断能否与内置 schedule 共存。
