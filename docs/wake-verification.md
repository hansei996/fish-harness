# 自主唤醒的独立验证（验了什么 / 没验什么）

> 基线 dsh `0.2.1-rc.2`，2026-10-26 本机实跑。本套件：`verify/smoke.mjs` **42/42**、
> `verify/e2e-tools.mjs` **17/17**；另有一条 opt-in 的真实唤醒检查（见文末）。
> 本文只写这些脚本实际能证明的事。

## 验到了什么

**策略数学（smoke，确定性：固定本地时钟 + 固定 `Math.random`）**
- `isQuietAt` 半开区间 `[start, end)`：23:00–08:00 的 22:59/23:00/00:00/07:59/08:00 依次为 F/T/T/T/F；12:00–14:00 不跨界；坏配置退化为「从不静默」。
- `nextWakeDelayMs` 落在 `every ± jitter`（random 0/0.5/1 → 70/90/≈110m）；`jitterMinutes=0` 时与 `random` 无关；结果永远 ≥60s。
- 目标落进静默段被推到其后第一个静默结束（22:50→08:00=550m；23:30→08:00=510m；12:00–14:00 内→14:00=130m）；对一天 48 个半小时起点扫描，无目标落在静默段。
- `msUntilNextDayWake`：07:00→60m、08:00→1440m、09:00→1380m（明天）、22:50+jitter→560m；坏 `quietEnd` 回退 08:00。

**布防 / 去重 / 预算（smoke，记录型假 `schedule` 服务）**
- 只有 `turn/end` 布防；按记录断言 `after_seconds=5400`（90m）、`title='自主唤醒'`、`prompt` 等于配置默认值、`sessionId` 正确。
- Host 仍列出我们那条任务时，第二个 `turn/end` 不重复 `create`。
- **一次性任务投递后 `list()` 为空**（`docs/wake-e2e.md` 实测 inactive）；脚本把「模拟投递后下一次 `turn/end` 会重建」固定成断言，防止实现把「旧的还在」当前提。
- 当天预算用满后布明天 08:10（`after_seconds=79800`），不是 90 分钟后重试；23:30 的 `turn/end` 布到 08:10 而非 01:00。

**记账 / 唤醒轮上下文（smoke，真实 `LifeStore` 落盘）**
- `source.kind==='schedule'` 的 `user/message`：账本多一条 `wake`、`countToday+1`、`turn/end` 的 `woke:true`、该轮 prompt 有「这一轮是你自己醒来的」；主人轮（`kind:'user'`）三者都不发生。
- 同一 `messageId` 重复投递：`wake` 行与 `countToday` 都不重复加（重复投递仍把它的那一轮标记为 `woke:true`）。

**降级与 `life_wake`（smoke）**
- 无 `schedule` 服务：`apply` 零 warn、仍注册 12 工具 + 1 个 prompt section；`turn/end` 只 info 一次「没有 schedule 服务」。
- `life_wake`：注册 `afterMinutes`/`at`；都不给报 `life/wake-requires-timing`；无服务报 `life/schedule-unavailable`；预算用完报 `life/wake-budget-exhausted`。
- `afterMinutes=45` 记录 `after_seconds=2700`，只删自己那条旧闹钟（别人的任务保留）；静默段内请求推到 08:00（`shiftedForQuiet=true`、`after_seconds=30600`）。

**原 bug 的回归断言是「会红」的（mutation 实测）**
- 在临时副本把已修的 `isQuietAt(target, {quietStart: settings.wakeQuietStart, …})` 改回 `isQuietAt(target, settings)`，同一场景得到 `shiftedForQuiet=false, after_seconds=300`，smoke 那条断言随即失败；真实现是 `true/30600`。
- 同类检查点：`isQuietAt` 的裸名/前缀名映射单独断言，防止新调用点再直接套 `settings`（`armWake` 的两个调用点单独核对过）。

**e2e（真 dsh，headless）**
- 真 dsh 从 headless 模板组合、`plugin add` 装插件、boot；账本记到真实 turn；12 个 `life_*` 工具与 prompt section 到达模型；二次 boot 不覆盖已有生命。
- boot 输出无 `[dsh-life]` warn/error（注意下方弱证据说明）；`--profile e2e --from-default-profile web --dump-config` 的输出确有 `- id: schedule` / `name: '@deepseek-ai/dsh-schedule'`。
- 原有 15 项全部保留（工具数 11→12 跟着实现更新）。

**真实唤醒（opt-in，不属于这两套脚本；我独立复跑 3/3）**
- `verify/live/wake-live.mjs`（探索者提供，证据与源码行号见 `docs/wake-e2e.md`）：A 进程布防 25s 后退出 → 到期时 Host 不在 → B 进程 boot 后补投一条 `source.kind='schedule'` 的 `user/message`（messageId `dde963b6…`）→ `schedule.history` 的 `deliveredAt` 与之一致 → C 进程重启后同一 messageId 仍在持久化 session 前缀里。
- 重要前提：overlay 禁用了全部 shipped preset（dsh preset-audit bug），会话是 preset-free；模型调用无凭据、按预期失败。

## 没验到什么（诚实边界）

1. **「正常 preset / 桌面 GUI 下的一次真实唤醒」仍未被观察到**：live 脚本能醒，但只能在 preset-free overlay 下；桌面 Electron profile 从未触碰。
2. **不覆盖真实模型回复**：e2e 与 live 都没有凭据，`llm` 调用按预期失败；唤醒后的回答、工具使用、是否编造经历都未验。
3. **e2e 的「无 warn」是弱证据**：headless 不安装 cordis logger exporter，`logger.info/warn` 根本不打印；该断言只证明输出里没有 `[dsh-life]` 诊断且事件路径仍跑通。真正的零 warn 由 smoke 的记录型假 logger 证明。
4. **不覆盖跨多日漂移**：预算与静默按本地日历日算，但只测单日边界，没有连跑多日。
5. **`life_wake` 的并发竞态未测**：`list → delete → create` 与 `noteWake` 非原子；两个会话同时请求可能留下多余闹钟。当前只覆盖串行路径。

## 怎么复现

```powershell
$node="C:\Users\13553\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
$env:DSH_BIN="C:\Users\13553\Downloads\DSH_workspace\_dshrt\node_modules\@deepseek-ai\dsh\lib\bin.js"
$env:PATH="C:\Users\13553\Downloads\DSH_workspace\_bin;C:\Users\13553\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin;"+$env:PATH
$env:VERIFY_DSH_HOME="...\_scratch\smoke-home-verify"   # 与 e2e 各用一个，避免并发互相清目录
$env:E2E_DSH_HOME="...\_scratch\e2e-home-verify"
cd ...\fish-harness
& $node verify/smoke.mjs        # 42/42，约 5s
& $node verify/e2e-tools.mjs    # 17/17，真启动 dsh，约 1–3 min
# opt-in：真实 web profile 的一次投递（~1–2 min，需另设 WAKE_LIVE_DSH_HOME）
& $node verify/live/wake-live.mjs
```

smoke 的唤醒段完全不 spawn dsh：它 import 真插件 + 真 `LifeStore`，时钟与随机数都是注入的。时间断言都用「记录下来的 `after_seconds` + 固定 `now`」反算目标本地时间，失败信息带实际值（如 `after_seconds=31200 (520m), target=08:10`），便于远程诊断。
