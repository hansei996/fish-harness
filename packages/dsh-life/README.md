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

**11 个模型可见工具**（`life_*`）：我是谁、活动生命周期、兴趣、技能、承诺、人物、账本、主人确认的身份修改。

**每轮一段有界的上下文** —— 连续性花的是固定小额 token，不随生命长度增长。

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
```

| 字段 | 含义 |
| --- | --- |
| `lifeId` | `$DSH_HOME/life/` 下的目录名。字母数字 `-` `_`，最长 64。 |
| `name` `species` | 初始身份。**只在生命尚不存在时使用**。 |
| `seeds` | 最多 8 个性格种子。是起点，不是完整人设。 |
| `injectContext` | 每轮注入有界生命快照。 |
| `autoCreate` | 首次加载时若不存在则创建。 |
| `maxLedgerEntries` | 账本上限；远超后折半收敛。 |

## 状态布局

`$DSH_HOME/life/<lifeId>/`：

```
identity.json      慢变量 · 带版本号；主人确认的修改才会 +1
traits.json        中变量：兴趣、技能
relations.json     人物，作用域分 keeper / friend / public
commitments.json   承诺及其结算
activity.json      唯一的当前活动 + 上一次已完成的
ledger.jsonl       追加式记录：真实发生了什么
```

写是原子的（tmp + rename）。读容忍文件缺失或损坏 —— **一个截断的 JSON 不该弄死一条命**。账本会跳过写了一半的尾行，而不是丢掉它周围的历史。

## 本包强制的设计规则

1. **身份不是 Agent 能改的。** `life_identity_update` 会拒绝任何身份字段，除非主人确认过。非身份字段（如展示名）可自由修改。
2. **同时只有一个主要活动。** 起第二个是错误，不是静默覆盖。
3. **要证据，不要声称。** 结束活动要记下结果和证据。
4. **快照有界。** 连续性不该每天多花 token。
5. **不自建定时器。** 唤醒应当走 dsh 的 `schedule`（或社区的 `dsh-proactive`），因为插件自己持有的定时器会随会话一起死掉 —— 那正是它们存在要修的问题。

## 验证

```sh
node ../../verify/smoke.mjs       # 26 项：存储不变量、持久性、损坏降级
node ../../verify/e2e-tools.mjs   # 15 项：真实 dsh profile 启动并挂载
```

`e2e` 那套不是 mock。它从 shipped 模板组合出一个真实的 dsh profile，用 `dsh plugin` 装上，真启动，然后断言运行系统实际产出了什么：磁盘上的身份、账本里的真实 `turn/end` 事件、**装配后**系统提示词里的生命层 section、以及 11 个工具 schema 全部对模型可见。

## 已知限制

- **还没有自主唤醒。** 存储和工具是完整的，但还没有东西能让它自己醒来。那属于 dsh 的 `schedule`，是下一步；插件自建 `setInterval` 会是那个 bug 而不是那个 feature。
- **账本记的是回合边界，不是结果。** 监听工具结果能让账本证明更多，尚未接。
- **没有 UI。** 生命只能通过工具看到。
- **默认每条命一个 profile。** 多个 `lifeId` 可用，但还没有机制阻止两个 profile 指向同一个。
- **活动选择是手动的。** 模型自己挑；还没有候选排序或预算感知的调度器。
- **对着 dsh `0.2.1-rc.2` 写的。** dsh 处于 developer preview，官方明写会有破坏性兼容变更，所以这里的配置与工具名还不是稳定契约。
