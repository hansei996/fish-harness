# 无人值守的 web profile 能不能真醒一次（实测）

> 基线 dsh `0.2.1-rc.2`（`_dshrt/node_modules/`），2026-10-26 实跑，独立临时 `DSH_HOME`，未使用真实模型凭据。
> 一次性脚本与原始日志在 `_scratch/wake-e2e/`（不入库）。

## 结论

**能。** 三件事都跑通了：(1) 无人值守在真实 `web` profile 里起一个会话；(2) 布防一次性唤醒、到点被 dsh 投递；(3) Host 停机错过到期后，下次启动即补投，且该消息已持久化、可回放。

前提有两个，都必须满足：**自带一个 driver 插件**（`dsh web --patch`），且**绕过 shipped preset**（见卡点 1）。

## 怎么起（最小可复用做法）

`dsh web` 只是 HTTP 服务（`--host/--port/--no-open/--public-url/--trusted-host/--tls-*`），没有任何「跑一轮」的入口；`--help` 里没有非交互 turn 的开关。无人值守的入口是 patch 层：

```
dsh web --patch _scratch/wake-e2e/patch.yml --no-open --port 0
```

- `--patch` 必须在 app 参数之前，放在 `--no-open` 之后就报 `unknown option '--patch'`。
- patch 的 `insert` 里可以写**相对路径**，锚定在 patch 文件旁（`--dump-config` 显示为 `file:///…/driver.mjs`），不需要发布 npm 包。
- 插件里（`root.inject(['schedule','sessionController','connection','typertGateway'], …)`）：
  1. 建会话**必须走 Peer**：`ctx.connection.createPeer({principal:{kind:'owner'}})`，再 `ctx.typertGateway.dispatchRpc('session/create', {args:{request:{cwd}}}, signal, peer)`。payload 外壳恰好一层 `args`，真正参数再包一层 `request`。
  2. `ctx.schedule.create(sessionId, {title, prompt, after_seconds})` 布防。
  3. `ctx.on('session/event')` 观测；`user/message` 的 `data.source.kind === 'schedule'` 就是唤醒。

## 证据（本机，同一 `DSH_HOME`，三个连续进程）

| 观察 | 时间戳（UTC） |
| --- | --- |
| 布防：`schedule-baf5126c…`，`scheduledAt 15:00:54.052Z`，布防进程 15:00:34.056Z 已退出 | 15:00:34 |
| 第二次 boot（15:00:59 起）补投：`turn/start` → `user/message` `sourceKind:"schedule"` `messageId:"ecf035bf-b19f-47f2-99c7-0d8b0795501f"`，正文以 `[SCHEDULE REMINDER]` 开头 | 15:01:25.006 / .018 |
| 第三次 boot 用 `sessionController.inspect(sessionId)` 读持久化前缀：20 条事件，命中 1 条 `source.kind==='schedule'`，`messageId` 与上面**同一个** `ecf035bf…` | 15:01:31 |
| 到期即时投递另一次：`schedule.history` 回执 `scheduledAt 14:57:34.781Z` → `deliveredAt 14:57:34.803Z`，`messageId` 与事件同值 | 14:57:34 |

模型调用都以 `TRANSPORT` 失败（temp `DSH_HOME` 无凭据、无 key），会话尾部是 `llm/retry` → `turn/end`。这不影响结论：被验证的是「投递是否真的进了会话」，不是模型回复。

## 卡点（两条，都实测过）

1. **shipped preset 全部不可用**：任何 `session/create` 都返回 `agent-preset/invalid`，`standard` 与 `minimal` 一样。原因是每个 preset 树在 audit 时把 deployment 级插件重挂一遍：
   - `persona: prompt section "deployment:persona-prefix" is already registered`
   - `tool-subagent: standing modelSelectionSettings requires a scoped preset Context`
   - （minimal 额外）`command-compact: command "compact" is already registered`、`persistent-pwsh: tool "pwsh" is already registered`

   与入口无关：直接 `ctx.sessionController.create()`、Peer RPC、HTTP 都会撞同一个 audit。绕过办法是 patch 里把 `preset-standard/ptc/minimal/cordis` 与 `agent-preset-registry` 一起 `disabled: true`，会话变成 preset-free 就能建——本文所有证据都是这么跑出来的。**代价**：`agentPreset` 为空，依赖 preset 的能力（人格、工具集、子代理）都缺席；这只是探索期的绕道，正式方案应当修 preset audit 或提供官方「无 preset」组合。

2. **没有对外自动化 API**：`/api` 不是 REST，而是 connection 通道上的 Typert RPC（endpoint 形如 `session/create`，载荷必须恰好 `{args:{…}}`）；鉴权是启动时打印的 `?token=` 换 cookie（loopback 自动通过 host fence），或在进程内 `createPeer`。因此纯外部 CLI/HTTP 驱动可行但需要自己实现这套 RPC，插件内 `createPeer` 是更短的路径。

## 对 dsh-life / e2e 的直接影响

- **账本不要用 `schedule.list()`**：一次性任务投完变 `status:"inactive"`，`list()` 返回 0（实测 count 0），而 `storages/schedule.json` 里仍有 `deliveryHistory`。用 `history({sessionId,id})` 的 `deliveredAt`/`messageId`，或直接用 `user/message` 事件。
- **冷启动补投是真的**：错过到期不会丢，但投递发生在 boot 后约 20–26s（storage 就绪之后），别在 plugin `apply` 里立即期望它。
- **e2e 必须换模板 + driver**：`headless`/`sdk` 没有 `schedule`，`verify/e2e-tools.mjs` 现在的 headless 路线**测不到唤醒**；要测就 `dsh web --patch … --no-open`，断言 `session/event` 里 `source.kind==='schedule'`，而不是断言模型输出。

## 建议下一步

1. 短期（已落地）：driver 插件 + 无 preset patch 已固化为独立、手动 opt-in 的 `verify/live/wake-live.mjs`（`node verify/live/wake-live.mjs`，约 1 分钟，不烧模型 key，不进 CI）；本文的三条证据就是它的三条断言，跑法见 `verify/live/README.md`。
2. 中期：定位 preset audit 的重挂问题（能否让 preset 树不重注册 deployment 级 `systemPrompt`/`tools`/`commands`），争取在 `standard` 下也能无人值守建会话——否则生命层在桌面 profile 上永远只能靠 GUI 先起会话。
3. 若接受依赖 GUI：至少可在 GUI 里建好会话、由 dsh-life 布防，冷启动补投这一条已经证明可靠。

## 未验证

- 有真实凭据时唤醒轮能否完整跑完（本机故意不给 key，只看到 `llm/retry` → `turn/end` error）。
- 桌面 GUI（Electron + `~/.dsh/profiles/desktop`）是否也受卡点 1 影响：未在该 profile 上跑（避免动真实 HOME），所以「GUI 能建会话、shipped web 不能」这一矛盾仍未解释。
- 跨多个进程周期以上的长期可靠性（连醒多日）未测。
