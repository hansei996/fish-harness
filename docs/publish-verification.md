# 发布线验证（验了什么 / 没验什么）

> 2026-10-27/28 本机实跑。`node verify/publish.mjs` = **26/26**。整套用假 approval、
> 假 transport、假 `fetch`；**不启动 dsh、不联网**，也不读任何真实凭据。

## 验到了什么

**outbox 状态机（A）**
- 转移矩阵：`confirmed` 只从 `sending`/`unconfirmed` 来（同 `platformId` 幂等），`unconfirmed` 只从 `sending` 来；`checked` 只从 `draft`/`checked`；`approved` 只从 `checked`/`approved`；`beginSend` 只从有效 `approved`（`sending`→`already-sending`、`unconfirmed`→`unconfirmed-needs-reconcile`、`confirmed`→`already-confirmed`）；`markFailed` 只拒 `confirmed`。
- **`sending` 永不自动重发**：写成 `sending` 落盘 → 新 store 读成 `unconfirmed`（`lastError=recovered-from-sending`、`platformId=null`）；不查不发的状态下 transport 0 次；显式 `sendAttempt` 也被 `unconfirmed-needs-reconcile` 拒绝（0 次）；只有显式 `reconcile` 会 `query`，query 拿到 id 后才 `confirmed`。
- 幂等键 `contentId|contentVersion|channel|account`：改任一字段键变；重复 append 只 1 条；伪造同键不同 `contentId` 报 duplicate。
- 改一个字符 → `contentVersion` 变 → `revalidate` 拒绝（记录回 `checked`、`approval=null`）。
- 并发同键：transport 只被调 1 次，第二次 `rejected/send-in-flight`。
- **修剪**（lead 定的三档）：`approved`/`sending`/`unconfirmed` = committed **永不修剪、不占 max**；`draft`/`checked` = proposed 丢最老；`confirmed`/`failed` = settled 用剩余预算、丢最老；`pruneOutboxWithStats` 报 dropped 计数，store 写 `lastPruned`。**这条是本次验证先发现 bug（旧实现会删掉 `unconfirmed`）后修的**。
- 破损/截断的 `outbox.json` → 空列表，不抛。

**标识（B）**
- `labelContent` 的显式标识含 `contentId`、正文可见、重复标注幂等；文本渠道 `implicit=not-applicable`（file 才是 `written`）；模板不含 `{contentId}` 直接拒。
- `assertLabeled` 拒绝：无正文、无 contentId、无标识、标识属于别的 contentId、少了「AI 生成」。
- `outbox/compliance/index` 的**模块导出清单**里没有 strip/remove/unlabel。
- `markConfirmed` 即使拿到 `platformId` 回执，只要标识生成不出来（模板缺「AI 生成」/缺 `{contentId}`）仍然拒。

**`life_publish` 接线（C）**
- `rejected`/`cancelled`/`unavailable`：transport 0 次、记录保持 `checked`、三种返回文案互不相同。
- **TOCTOU**：假 approval 在 `request()` 里同步改存储正文再返回 `allowed-once` → `content-changed`、transport 0 次、记录回 `checked`/`approval=null`。
- 无 approval 服务：`no-approval-channel`；插件仍注册 **17** 个工具、`apply` 零 warn。
- `publisherEnabled:false`：拒绝，且 approval/transport 均 0 次。
- `tokenEnv` 环境变量未设置：在**请求批准之前**返回 `credential-unconfigured`，记录仍 `checked`（不是 `unconfirmed`），真实 fetch 0 次。
- 账本 `kind:'publish'` 的 detail 只有 `contentId/contentVersion/channel/account/status/platformId/textLength`；正文不出现在账本（`confirmed` 与 `unconfirmed` 都验）。

**Telegram 适配器（D，假 fetch）**
- POST `{apiBase}/bot{token}/sendMessage`；body 含 `chat_id`、`text`、`disable_web_page_preview:true`；text 含标识与 contentId；返回 `tg:<message_id>`。
- 非 2xx、fetch 抛错（消息里带 token）、非 JSON 响应 → 都抛错；错误消息里 token 被替换成 `[redacted]`。
- 缺 token → `credential-unconfigured` 且 fetch 0 次；`query()` 返回 `null`（平台不可反查）。
- 源文件没有直接 `fetch(...)`/`http` 调用；本进程真实 fetch **0** 次。

**会红证明（E，`%TEMP%` 副本，未改仓库）**
- 把 `sending→unconfirmed` 改成保持 `sending`：A2 的谓词在副本上为假，打印 `MUTATION-FAIL`（真实断言会红）。
- 去掉 `assertLabeled` 的标识检查：无标识文本被接受，打印 `MUTATION-FAIL`（真实断言会红）。

## 没验到什么（诚实边界）

1. **真实 Web 批准弹窗没点过**：approval 是假 seam；`allowed-once` 的人工点击、UI 拒绝/取消的交互未验。
2. **真实 Telegram 没发过**：全部用假 fetch；真实 API 的错误码、限流、消息长度上限、`message_id` 语义未验。
3. **跨进程并发未测**：`inFlightSends` 只是进程内保护；两个进程同时对同一记录 `sendAttempt` 未测。durable `sending` 只保证「崩溃后不自动重发」，不保证两进程互斥。
4. **崩溃窗口未实测**：`sending` 落盘后、transport 返回前 kill 的语义由读侧归一化证明，没有做真实崩溃注入。
5. **token 脱敏只覆盖 `telegram.js` 自己抛出的错误**：dsh 工具层/日志若另行打印 token 未验；credentials 隔离不是安全边界（同 OS 用户）。
6. **发布内容质量/事实性未验**：证据只校验引用存在，不判断内容真假。
7. **修剪日志只验了 `outbox.json.lastPruned` 与函数返回**，UI/其他出口未验；真实模型是否会在没有批准时尝试绕过工具边界也未验。

## 怎么复现

```powershell
$env:PUBLISH_DSH_HOME="...\_scratch\verify-publish-home"   # 可选，临时 HOME
cd ...\fish-harness
node verify/publish.mjs        # 26/26，约 1s；不需要 DSH_BIN / pnpm / 网络
```

输出里 `MUTATION-FAIL ...` 两行是 E 组故意打印的（在 `%TEMP%` 副本上跑坏了不变量的谓词），
不是本套件的失败；最后一行 `N/N checks passed` 才是判定。
