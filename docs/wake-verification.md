# 自主唤醒的独立验证（验了什么 / 没验什么）

> 基线 dsh `0.2.1-rc.2`，2026-10-26 本机实跑。本套件：`verify/smoke.mjs` **61 项**（26 原有 +
> 16 唤醒 + 10 soak + 9 活动选择器）、`verify/e2e-tools.mjs` **17 项**；另有一条 opt-in 的真实唤醒检查（见文末）。
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
- 无 `schedule` 服务：`apply` 零 warn、仍注册 13 工具 + 1 个 prompt section；`turn/end` 只 info 一次「没有 schedule 服务」。
- `life_wake`：注册 `afterMinutes`/`at`；都不给报 `life/wake-requires-timing`；无服务报 `life/schedule-unavailable`；预算用完报 `life/wake-budget-exhausted`。
- `afterMinutes=45` 记录 `after_seconds=2700`，只删自己那条旧闹钟（别人的任务保留）；静默段内请求推到 08:00（`shiftedForQuiet=true`、`after_seconds=30600`）。

**原 bug 的回归断言是「会红」的（mutation 实测）**
- 在临时副本把已修的 `isQuietAt(target, {quietStart: settings.wakeQuietStart, …})` 改回 `isQuietAt(target, settings)`，同一场景得到 `shiftedForQuiet=false, after_seconds=300`，smoke 那条断言随即失败；真实现是 `true/30600`。
- 同类检查点：`isQuietAt` 的裸名/前缀名映射单独断言，防止新调用点再直接套 `settings`（`armWake` 的两个调用点单独核对过）。

**e2e（真 dsh，headless）**
- 真 dsh 从 headless 模板组合、`plugin add` 装插件、boot；账本记到真实 turn；13 个 `life_*` 工具与 prompt section 到达模型；二次 boot 不覆盖已有生命。
- boot 输出无 `[dsh-life]` warn/error（注意下方弱证据说明）；`--profile e2e --from-default-profile web --dump-config` 的输出确有 `- id: schedule` / `name: '@deepseek-ai/dsh-schedule'`。
- 原有 15 项全部保留（工具数 11→12→13 跟着实现更新）。

**真实唤醒（opt-in，不属于这两套脚本；我独立复跑 3/3）**
- `verify/live/wake-live.mjs`：在**干净安装**（`_dshrt2`）的 shipped `web` profile、**未改动的 shipped `standard` preset** 下，我本机复跑 3/3（2026-10-26 17:12–17:13Z）：环境前置 `session/create → agentPreset:"standard"`；A 进程布防 25s 后退出 → B 进程 boot 补投一条 `source.kind='schedule'` 的 `user/message`（messageId `8b619f04…`）→ `schedule.history` 的 `deliveredAt` 与之一致 → C 进程重启后同一 messageId 仍在持久化 session 前缀里。
- 之前「必须 preset-free 才能建会话」是**坏安装**导致的误判（旧 `_dshrt` 的 preset audit 失败）；干净安装下没有禁用任何 preset。为什么当初会误判、怎么识别坏安装，见 `docs/wake-e2e.md` 与 `verify/live/README.md`（脏安装会 `exit 2`，不是失败判定）。

**7 天模拟 soak（策略层，确定性）**
- 真实 7 天跑不了（无凭据、要 7 天）；但策略是纯函数 + 一个随机源，所以用**固定时钟 + `mulberry32` 种子**把 `docs/PLAN.md` §10.2 的 7 天决策门在策略层跑一遍。`runSoak()` 驱动**真实插件接线**：记录型假 Host 布防 → 时钟跳到到期 → 投一条 `source.kind='schedule'` → `turn/end` 让它重排；假 Host 也模拟 `docs/wake-e2e.md` 实测的「一次性任务投递后 `list()` 为空」。
- 8 组运行（默认 90/20/6、crowded 90/20/14、极端 1440/240，含 seed 60/42），共 **367 次唤醒**：默认每天 6 次、7/7 跨天来自「预算用尽」，明天落在 08:00–08:20；crowded 每天 10–11 次（最后一条 22:06–22:58）、7/7 跨天来自「静默推送」，没有一天空；极端 1440/240 开局当天 0 次（第一次间隔 20–28h），之后每天 1 次。
- 断言（detail 带每天 first/last 实际时刻）：每天 ≥1 次且 ≤ 预算；任何一次不在 23:00–08:00；相邻 ≥60s（实测最小 4209s）；每个 `after_seconds` 是 ≥60 的整数（4209–98159s）；同日目标必在 `every±jitter`；跨天目标是「quiet-end+jitter」「同一区间」或「被夹的 22:59」；每次投递后 `wake.dayKey`/`countToday` 只属于当天（367 次无跨天累加）。
- **原边界已修（2026-10-27）**：修复前 `every=1440m, jitter=240m` + `mulberry32(60)` 从 08:00 起，第 8 天整天 0 次唤醒（d7 22:19 → d9 08:20，gap 34.02h）；修复后 d8 22:59 有唤醒、最大 gap 27.27h，seed42（08:00 起）序列逐条不变；keeper 22:00 起的 seed42 也从「d3 空」变成 d3 22:59。修法是 `wake.js` 的 `clampToLastAllowedMoment`：静默推送后目标 ≥ 后天时，夹到第一个被跳过那天的 `quietStart-1min`（默认 22:59）；只到明天的目标原样返回。
- **新断言**：①「不跳日」——任意相邻两次唤醒的本地日历日序号差 ≤ 1（比「每天至少一次」更贴根因；修复前 seed60 必红）；②极端 1440/240 的 seed60/42 连续 7 天每天 ≥1（带每天 first/last 时间）；③回归——默认与 crowded 的 6 条 7 天序列对**修复前 golden**（sha256 前 16 位）逐条一致，extreme/42 也一致；④单函数级：「目标只在明天」的静默顺延延迟仍为 `34320000ms`/08:02，「目标 ≥ 后天」被夹到 22:59（`88800000ms`），`quietStart='00:00'` 与非法窗不夹且保留原值。

**活动选择器（`choose.js` + 接线）**
- `urgencyOf`：逾期 1 > 今天到期 0.911 > 3 天后 0.675 > 无 `dueAt` 0.15（不是 0）。
- `interestScore`：高置信+新鲜 0.900 > 低置信 0.200；陈旧记录 0.405（有下限，不归零）；只观察 1–2 次 +0.15，3 次起 +0；观察 1 次 0.650 > 9 次 0.500。
- `unfinishedScore`：failed 0.9 > 记录过 next 0.75 > 上次 done 0.15 > 无 0；`switchCost`：切走 1、继续同一件/休息/没有进行中活动都 0。
- `rankCandidates`：5 个候选排序稳定、两次调用逐字节一致；非 rest 候选的 `score` 能从 `parts` 复算，且 commitment/interest/explore 分项与 `urgencyOf`/`interestScore`/`explorationBonusOf` × `CHOOSER_WEIGHTS` 完全对上（调权重不会假红）；「休息」始终存在：固定 0.35（`REST_CANDIDATE_SCORE`）、parts 全 0、evidence 非空。
- 预算：只剩 1 次唤醒时，今天到期的承诺从 0.411 掉到 0.191，休息从第 2 升到第 1；`notes` 明说「今天只剩 1 次」。
- 接线：唤醒轮 prompt 追加 **216 字符**短名单（上限 600，含「休息，什么都不做」）；主人轮**+0 字符**；`chooserEnabled:false` 时唤醒 prompt 与改前逐字节一致（拼回「自己醒来」两句 + 主人轮文本可复原）。
- `life_candidates`：注册、默认 `chooserTopN=3`、`topN` 1–5 生效（9→5、2.5→默认）、始终含 rest、返回 `CHOOSER_WEIGHTS`；`chooserEnabled:false` 明确报 `life/chooser-disabled` 而不是空列表。

## 没验到什么（诚实边界）

1. **桌面 GUI（Electron）的一次真实唤醒仍未被观察到**：shipped `standard` preset 下已在 `verify/live` 观察到 3/3，但桌面 profile 从未触碰。
2. **不覆盖真实模型回复**：e2e 与 live 都没有凭据，`llm` 调用按预期失败；唤醒后的回答、工具使用、是否编造经历都未验。活动选择器只验了纯函数与 prompt 文本（构造状态是人工的），模型是否照短名单行动也未验。
3. **e2e 的「无 warn」是弱证据**：headless 不安装 cordis logger exporter，`logger.info/warn` 根本不打印；该断言只证明输出里没有 `[dsh-life]` 诊断且事件路径仍跑通。真正的零 warn 由 smoke 的记录型假 logger 证明。
4. **真实 7 天墙钟仍未跑**：soak 是策略层模拟（固定时钟 + 种子），不含模型、真实 dsh `schedule` 的持久化/重启/凭据；「醒来之后做什么」也没有模拟。真实多日漂移仍未观察。
5. **`life_wake` 的并发竞态未测**：`list → delete → create` 与 `noteWake` 非原子；两个会话同时请求可能留下多余闹钟。当前只覆盖串行路径。
6. **非默认静默窗 + 大间隔的「非静默跨日」未测**：本次修复只夹「静默推送跨整日」；当 `every+jitter > 24h` 且目标本身直接落在后天（不经静默推送）时仍可能跳日。默认 23:00–08:00 下 soak 没构造出这种序列，但换一个合法静默窗（如 12:00–14:00）理论上可构造；未覆盖。

## 怎么复现

```powershell
$node="C:\Users\13553\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
$env:DSH_BIN="C:\Users\13553\Downloads\DSH_workspace\_dshrt\node_modules\@deepseek-ai\dsh\lib\bin.js"
$env:PATH="C:\Users\13553\Downloads\DSH_workspace\_bin;C:\Users\13553\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin;"+$env:PATH
$env:VERIFY_DSH_HOME="...\_scratch\smoke-home-verify"   # 与 e2e 各用一个，避免并发互相清目录
$env:E2E_DSH_HOME="...\_scratch\e2e-home-verify"
cd ...\fish-harness
& $node verify/smoke.mjs        # 61 项（含 10 项 soak、9 项选择器），约 9s
& $node verify/e2e-tools.mjs    # 17/17，真启动 dsh，约 1–3 min
# opt-in：真实 web profile 的一次投递（~1–2 min，需另设 WAKE_LIVE_DSH_HOME）
& $node verify/live/wake-live.mjs
```

smoke 的唤醒段完全不 spawn dsh：它 import 真插件 + 真 `LifeStore`，时钟与随机数都是注入的。时间断言都用「记录下来的 `after_seconds` + 固定 `now`」反算目标本地时间，失败信息带实际值（如 `after_seconds=31200 (520m), target=08:10`），便于远程诊断。
