# dsh approval seam 与凭据：发布线怎么做到「真的需要主人点头」

> 基线：dsh `0.2.1-rc.2`（`_dshrt/node_modules/`，2026-10-27）。证据 `包名/文件:行号`。
> 探针：`_scratch/approval-probe/probe.mjs`（真实服务代码，不联网、不碰 `~/.dsh`）。

## 结论

- **能做，但批准≠内容绑定**。`ctx.approval.request()` 返回闭集 outcome：`allowed-once | rejected | cancelled | unavailable`（`dsh-user-approval/lib/types/types.d.ts:26`），**只有 `allowed-once` 是授权**；请求里没有摘要/账号/TTL/「记住」字段，想绑定内容只能写进 `reason` 字符串，并在批准后**自己重新校验摘要**。
- **headless 不会挂起**：默认 policy `ask` 且没有 answerer 时，结果是 `unavailable`（fail closed），不是弹窗等主人；`DSH_PERMISSION_MODE=danger-full-access` 时 policy 变 `never`，每个请求确定性地 `rejected`。**headless 里没有「让 CI 自己批」的官方口子**，只有这两条确定性路径。
- **e2e 可以测拒绝路径，不能测批准路径**：CI 里能断言 `rejected`/`unavailable` 与审计事件成对；真正的「点同意」只在 Web（`dsh-client-ui-approval`）或 ACP 客户端发生。
- **凭据能读进宿主、不进模型上下文**：`ctx.credentials.resolve(ref)` 返回 `{value, source}`（`dsh-credentials/lib/types/index.d.ts:130`），值是进程内字符串；只要工具不把它放进返回值/日志，模型就看不到。**但这不是安全边界**：agent 的工具进程与用户同一 OS 用户，能读同一个 `.credentials.yaml`（`dsh-credentials-local/README.md:115`）。
- **没有通用「批准后执行」helper**：官方唯一成型的是 sandbox 提权的 `approveEscalation`（`dsh-sandbox/lib/types/escalation.d.ts:142`，返回 `SandboxMode`）。发布动作得自己写「请求 → 只认 `allowed-once` → 重新校验 → 执行 → 记账」。

## A. approval seam

1. **服务与注入**：服务名 `approval`（`dsh-user-approval/lib/index.js:76` `super(ctx, "approval")`；类型 augmentation
   `interface Context { approval: ApprovalService }` 见 `lib/types/index.d.ts:19-23`）。用法 `root.inject(['approval'], (ctx) => …)`；
   base bundle 已挂载（`dsh-base/cordis.patch.yml:259-262`）。
2. **确切签名**（`ApprovalService.request`，`lib/types/index.d.ts:135`、实现 `lib/index.js:128-144`）：
   ```ts
   request(req: {
     agent: Agent           // 必填：被问的 agent，审计写进它的 session
     toolName: string       // 必填：哪个工具在要授权
     callId?: ToolCallId    // 可选：关联已展示的工具调用
     reason?: string        // 可选：唯一能写「为什么/内容摘要」的地方
     signal?: AbortSignal   // 可选：唯一的超时/取消机制（调用方自己定时）
   }): Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'>
   ```
   语义：`signal` 已 abort → `cancelled`；policy `never` → `rejected`；否则 waterfall
   `approval/request`，无 answerer/抛错/返回非词表值 → `unavailable`（`lib/index.js:172-189`）。
   **没有** `timeout`、`default`、`remember`、`risk` 字段——请求对象就这五个。
3. **三种运行时**：
   - `web`：`ui-approval` 挂 `@deepseek-ai/dsh-client-ui-approval`（`dsh-web-app/cordis.patch.yml:329-330`），弹窗交互在该客户端插件里（`dsh-client-ui-approval/lib/client.js:355` 监听 `approval/request`）。
   - `headless`：模板 `[dsh-base, dsh-headless]`（`dsh-app-boot/lib/index.js:554`），**没有任何 approval answerer**。实测组合配置见 `_scratch/approval-probe/dump-headless.txt`：只有 `id: approval`，无 `ui-approval`/acp。→ `ask` 时落 `unavailable`。
   - `sdk`：模板 `[dsh-base, dsh-sdk-app]`（`dsh-app-boot/lib/index.js:555`），同样只有 base 的 approval 服务；**是否另有 answerer 未实跑确认**（见未知项）。
   - ACP 客户端另有一条 answerer（`dsh-acp/lib/index.js:1158` `ctx.on("approval/request", …)`）。
4. **headless 的官方兜底**：不是绕过，而是 policy。`'never'` 的定义是「never prompt anyone: every ask resolves `'rejected'` deterministically」，注释直接点名 CI/无人值守（`lib/types/index.d.ts:44-54`，实现 `lib/index.js:175`）。默认值由 `DSH_PERMISSION_MODE` 决定：`danger-full-access` → `never`，其余 → `ask`（`dsh-base/cordis.patch.yml:262`；permission presets 同表 `267-276`）。
5. **内容绑定**：请求只能带 `toolName` / `callId` / `reason`；审计事件也只记这三样（`lib/types/types.d.ts:37-42`）。结果**不回传任何内容**，所以「批的是不是这一版」必须由调用方用 `reason` 里的摘要 + 批准后的二次校验保证（见代码骨架）。没有有效期字段；`signal` 的时长由调用方定。
6. **事件**（可记账）：
   - 会话事件 `approval/asked` `{id, toolName, callId?, reason?}` 与 `approval/decided` `{id, outcome}`，成对且 turn-enclosed（`lib/types/types.d.ts:27-52`）；`approval/policy` `{policy, source?}`（`lib/types/index.d.ts:24-39`）。
   - 答问 waterfall：Cordis 事件 `approval/request`（`this: Scoped<Agent>`, `req`, `next`），`@mode waterfall`（`lib/types/types.d.ts:72-83`）。
   - 策略切换会 `agent.inject()` 一条 `source.kind === 'user-approval'` 的模型可见通知（`lib/index.js:102-108`、`lib/types/index.d.ts:11-16`）。
7. **批准后执行的 helper**：**没有通用的**。唯一现成范式是 `approveEscalation(request, approval)`（`dsh-sandbox/lib/types/escalation.d.ts:142`），由 `tool-bash` 这样接入：`approver: ctx.get("approval"), agent: exec.agent, callId: exec.callId, toolName: "bash", signal: exec.signal`（`dsh-tool-bash/lib/index.js:360-374`）。它只回答「是否放宽 sandbox」，发布线不能直接复用其判定，但可以照抄这套接线。

## B. 凭据

1. **服务与读取**：`ctx.credentials`（`CredentialProvider`，`dsh-credentials/lib/types/index.d.ts:98-102`）。`resolve(ref)` → `{ value, source } | undefined`（同文件 `130`）；`ref` 用 `credentialRef('TELEGRAM_BOT_TOKEN')` 创建（同文件 `18`）。本地实现 `@deepseek-ai/dsh-credentials-local`（`dsh-base/cordis.patch.yml:125-126`），存 `$DSH_HOME/.credentials.yaml`（README `12`、`44`），优先级：存储文件 > 启动环境 > 项目 `.env` > harness-home `.env`（README `71-80`）。
2. **不进模型上下文的做法**：`resolve()` 只把值给宿主进程；`describe(ref)` 只回 `configured/source/writable`，**永不回值**（README 同段、`index.d.ts:137`）。所以工具里 `get` 到就用、绝不写进返回值或 `console`，模型侧只会看到「已配置/未配置」。
3. **边界（必须写进设计）**：README 明说存储文件仅 OS 用户可读，但「agent tool processes run as that same user, so this store cannot isolate secrets from the agent」；产品从不让 agent 拿到文件路径、也不把文件加载进环境，但那是「discretion, not a boundary」（`dsh-credentials-local/README.md:115`）。→ 发布动作若要防「模型自己偷 token 发帖」，靠凭据隔离不够，必须靠 approval + 工具边界。
4. 若插件读不到（未配置）：`resolve` 返回 `undefined`，没有其他官方通道。此时外部动作只能由用户手动做；宿主 sidecar 方案在 dsh 侧没有现成 seam（未知项）。

## 可直接抄的代码（Cordis 插件）

```js
root.inject(['approval', 'credentials'], (ctx) => {
  // 工具 execute 内部（必须有打开的 turn，后台唤醒的 turn 也算）
  async function publishWithConsent (exec, draft) {
    const digest = sha256(draft)                     // 你自己算，dsh 不提供
    const outcome = await ctx.approval.request({
      agent: exec.agent,
      toolName: 'life_publish',
      callId: exec.callId,                           // 有则传，便于审计关联
      reason: `publish telegram @${draft.account}: sha256=${digest}`,
      signal: exec.signal,                           // 超时/取消由你控制
    })
    if (outcome !== 'allowed-once') return { published: false, code: outcome }

    // 批准只覆盖「这一次」，且 dsh 不记得内容 → 执行前必须重新校验
    if (sha256(draft) !== digest) return { published: false, code: 'content-changed' }
    const tok = await ctx.credentials.resolve(credentialRef('TELEGRAM_BOT_TOKEN'))
    if (tok === undefined) return { published: false, code: 'credential-unconfigured' }

    const res = await postOnce(draft, tok.value)      // 幂等键：draft.idempotencyKey
    return { published: true, messageId: res.messageId, digest } // 绝不回 token
  }
})
```

要点：`exec.callId` 已被官方工具使用（`dsh-tool-bash/lib/index.js:371`）；`credentialRef` 从
`@deepseek-ai/dsh-credentials` 导入（发布包可以依赖它，dsh-life 主包目前刻意零依赖）。

## 探针：真实输出

`node probe.mjs`（真实 `ApprovalService`，真实 Cordis `Context`，最小 session 日志满足 open-turn 前置）：

```
1. ask + 无 answerer              -> "unavailable"    审计: [turn/start, approval/asked, approval/decided]
2. ask + answerer=allowed-once    -> "allowed-once"   审计: [turn/start, approval/asked, approval/decided]
3. setApprovalPolicy(s,'never')   -> "rejected"       审计: [approval/policy, turn/start, approval/asked, approval/decided]
4. 无 open turn                   -> 抛错 "approval.request() outside an open turn…"，审计日志为空
```

第 1 条就是 headless 的真实形态（组合配置见 `dump-headless.txt`：只有 `id: approval`，policy 由
`DSH_PERMISSION_MODE` 决定，默认 `ask`）。**headless 不会挂起、不会批准，只会 fail closed。**

## 未知项与建议

1. **Web 弹窗的实际交互没跑**（需要真实 UI/人工点击）；只核实了插件与监听点。
2. **sdk 模板是否另有 answerer 未实跑**；按模板只有 `dsh-base + dsh-sdk-app`，倾向 `unavailable`。
3. **没有 request 级 TTL/摘要/账号字段**，也没有「记住这个动作」。发布线要在 `reason` 里写
   `sha256 + 账号 + 目标`，并在执行前重新校验（否则批准后被改写内容就是 TOCTOU）。
4. **批准粒度为「一次工具调用」**，不能一次批准覆盖后续多次发布；要逐条确认就得每条一次 `request()`。
5. **没有通用 approve-then-act helper**；`approveEscalation` 只服务 sandbox 提权。
6. **凭据隔离不是安全边界**（同 OS 用户）。若要把 token 藏到模型偷不到的地方，dsh 目前没有
   sidecar/独立进程 seam，属于产品自建（无官方证据，不建议宣称已解决）。
7. headless e2e 只能断言拒绝链路；批准链路只能靠 Web/ACP 或人工验收。
