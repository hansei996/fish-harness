# 无人值守的 web profile 能不能真醒一次（实测）

> 基线 dsh `0.2.1-rc.2`，2026-10-26 实跑，独立临时 `DSH_HOME`，未使用真实模型凭据。
> 可复跑：`verify/live/wake-live.mjs`（手动 opt-in，不进 CI）。一次性脚本与日志在 `_scratch/`（不入库）。

## 结论

**能，而且是在 shipped `standard` preset 下——不需要禁用任何 preset。** 三件事都实测：(1) 无人值守在真实 `web` profile 里起一个会话；(2) 布防一次性唤醒、到点被 dsh 投递；(3) Host 停机错过到期后，下次启动即补投，且该消息已持久化、可回放。

前提两个：**自带一个 driver 插件**（`dsh web` 没有「跑一轮」的入口），以及**用一个健康的 dsh 安装**。第二条是本轮的修正——早先「必须 preset-free 才能建会话」是错的，见「曾经误判」。

## 怎么起（最小可复用做法）

`dsh web` 只是 HTTP 服务（`--host/--port/--no-open/--public-url/--trusted-host/--tls-*`），没有任何「跑一轮」的入口。无人值守入口是 patch 层：

```
dsh web --patch verify/live/wake.patch.yml --no-open --port 0
```

- `--patch` 必须在 app 参数之前（放到 `--no-open` 之后就报 `unknown option '--patch'`）；`insert` 里可写相对路径，锚定在 patch 文件旁，不必发布 npm 包。
- 插件里（`root.inject(['schedule','sessionController','connection','typertGateway'], …)`）：建会话**必须走 Peer** —— `ctx.connection.createPeer({principal:{kind:'owner'}})` + `ctx.typertGateway.dispatchRpc('session/create', {args:{request:{cwd}}}, signal, peer)`（外壳恰好一层 `args`，参数再包一层 `request`）；然后 `ctx.schedule.create(sessionId, {title, prompt, after_seconds})`；用 `ctx.on('session/event')` 观测，`user/message` 的 `data.source.kind === 'schedule'` 就是唤醒。

## 证据

**A. shipped `standard` preset 下（本轮，2026-10-26 17:09–17:10Z，干净安装）**

| 观察 | 时间戳（UTC） |
| --- | --- |
| 环境前置检查 `session/create` 返回 `agentPreset:"standard"`；布防 `session-7f0af990…`／`schedule-bc7fdc62…`，`scheduledAt 17:10:08.951Z`，布防进程约 8s 后退出 | 17:09:34.371 / 17:09:43.967 |
| 到期时无 Host 进程；第二次 boot 补投 `user/message` `sourceKind:"schedule"` `messageId:"9a11977b-8dd2-421b-abd3-ad43e36e1141"`；`history` 回执 `deliveredAt 17:10:15.757Z` 同 id | 17:10:15.797 |
| 第三次 boot 用 `sessionController.inspect()` 读持久化前缀：18 条事件，命中 1 条 `source.kind==='schedule'`，**同一个** `messageId` | 17:10:21.006 |

**B. 更早一轮（2026-10-26 15:00–15:01Z，当时被迫 preset-free）**——投递结论仍成立，只是那个会话没有人格/工具集：

| 观察 | 时间戳（UTC） |
| --- | --- |
| 布防 `schedule-baf5126c…` `scheduledAt 15:00:54.052Z`，布防进程 15:00:34.056Z 已退出；第二次 boot 补投 `turn/start` → `user/message` `messageId:"ecf035bf-b19f-47f2-99c7-0d8b0795501f"` | 15:00:34 / 15:01:25.018 |
| 第三次 boot 读持久化前缀：20 条事件，1 条 wake，**同一个** `ecf035bf…`；另一次到期即时投递 `history` 回执 `scheduledAt 14:57:34.781Z` → `deliveredAt 14:57:34.803Z` | 15:01:31 / 14:57:34 |

两轮的模型调用都以 `TRANSPORT` 失败（临时 `DSH_HOME` 无凭据）——不影响结论：被验证的是「投递是否真的进了会话」，不是模型回复。

## 曾经误判：为什么我们以为必须 preset-free

当时任何 `session/create` 都返回 `agent-preset/invalid`（`persona: prompt section "deployment:persona-prefix" is already registered`、`tool-subagent: standing modelSelectionSettings requires a scoped preset Context`），我们把它当成 dsh 的缺陷，于是用 patch 里 `disabled: true` 掉 4 个 preset + `agent-preset-registry` 绕过——代价是人格/工具集/子代理全缺席，而那是**不能被接受的谎**。

真相是坏的是当时那个 `_dshrt` **安装**（一次 `pnpm` 安装以 exit 1 收尾留下的坏树），不是 dsh：同一个 `0.2.1-rc.2` 干净安装、同样的 HTTP/RPC 路径，稳定返回 `agentPreset:"standard"`。否认实验（坏安装 5/5 失败 vs 干净安装 5/5 成功，源码逐字节相同、锁文件相同）与 audit 的代码行号都在 `docs/dsh-preset-audit.md`。

纪律：**先证明安装健康，再谈唤醒**。`wake-live.mjs` 现在开跑前就查这一条，不健康直接 `exit 2` 并说明「这是安装问题、不是对唤醒路径的判定」——不让它退化成 preset-free 的「能跑」。

## 仍然成立的卡点

**没有对外自动化 API**：`/api` 不是 REST，而是 connection 通道上的 Typert RPC（endpoint 形如 `session/create`，载荷必须恰好 `{args:{…}}`）；鉴权是启动时打印的 `?token=` 换 cookie（loopback 自动通过 host fence），或进程内 `createPeer`。纯外部 CLI/HTTP 驱动要自己实现这套 RPC，插件内 `createPeer` 更短。

## 对 dsh-life / e2e 的直接影响

- **账本不要用 `schedule.list()`**：一次性任务投完变 `status:"inactive"`，`list()` 返回 0（实测 count 0），而 `storages/schedule.json` 里仍有 `deliveryHistory`。用 `history({sessionId,id})` 的 `deliveredAt`/`messageId`，或直接用 `user/message` 事件。
- **冷启动补投是真的**：错过到期不会丢，但投递在 boot 后数十秒内（storage 就绪之后），别在 plugin `apply` 里立即期望。
- **e2e 必须换模板 + driver**：`headless`/`sdk` 没有 `schedule`，`verify/e2e-tools.mjs` 的 headless 路线**测不到唤醒**；要测就用 `verify/live/wake-live.mjs`，断言 `source.kind==='schedule'`，不要断言模型输出。

## 建议下一步

1. 短期（已落地）：`verify/live/` 改为**标准 preset + 一个 driver 插件**，并带环境前置检查；本文 A 组证据就是它的三条断言。
2. 中期：不要为了「能建会话」去禁 preset；若 `session/create` 又报 `agent-preset/invalid`，先按 `docs/dsh-preset-audit.md` 判安装，再谈修代码。桌面 GUI 与本结论一致：Electron 用随包 dsh（`dsh-desktop@0.2.1-rc.2`），其 profile 无任何 `@deepseek-ai/dsh*` 依赖，等于干净安装。

## 未验证

- 有真实凭据时唤醒轮能否完整跑完（本机故意不给 key，只看到 `llm/retry` → `turn/end` error）；GUI 未被真正驱动验证，只在依赖层面判断它等价于干净安装。
- 跨多个进程周期以上的长期可靠性（连醒多日）未测。
