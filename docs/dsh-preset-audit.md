# dsh `agent-preset/invalid` 定性：是环境，不是 dsh 缺陷

> 基线 dsh `0.2.1-rc.2`／`rc.3`／`rc.4`，2026-10-27 实测。脚本与原始输出在 `_scratch/preset-audit/`（不入库）。
> 一句话：**这个失败不是 dsh 发版里的 bug，而是本机 `_dshrt` 这个安装的问题。干净安装的 rc.2 一切正常。**

## 结论

| 安装 | 版本 | `session/create` | 证据 |
| --- | --- | --- | --- |
| 干净安装（pnpm → 独立目录，`0_2_1-rc_2`） | 0.2.1-rc.2 | **成功**，返回 `agentPreset:"standard"` | 5/5 次，两个不同 HOME，换顺序仍成功 |
| 干净安装（`0_2_1-rc_3`） | 0.2.1-rc.3 | **成功**，返回 `agentPreset:"standard"` | 2/2 次 |
| 干净安装（`0_2_1-rc_4`） | 0.2.1-rc.4 | **成功** | 1/1 次 |
| 本仓库 `_dshrt` | 0.2.1-rc.2（自称） | **失败** `agent-preset/invalid` | 5/5 次，确定性复现 |

因此：

- **不是版本回归。** rc.2 干净安装就能建带 `standard` preset 的会话，所以「rc.3 修好了」这个说法不成立；rc.3／rc.4 能跑只是它们也是**干净**安装。
- **不需要为这个症状改版本号。** 钉 `rc.3` 会把问题掩盖成「升级解决了」，但下一次 `_dshrt` 式安装还会炸。
- **`verify/live` 里的 preset-free 绕法（禁用 4 个 preset + registry）是为了迁就 `_dshrt`，应退役**：干净安装上不需要它，而且它的代价是人格／工具集／子代理全缺席。

## 最小复现（一条命令）

`_scratch/preset-audit/min-repro.mjs` —— 只做 `createPeer` + `session/create`，不禁用任何 preset、不替换任何服务：

```
DSH_BIN=<dsh 包目录或 lib/bin.js> node min-repro.mjs          # 加 --keep 保留现场
```

它写一个两文件的一次性 overlay（`probe.mjs` 30 行 + `patch.yml`），用 `dsh web --patch … --no-open --port 0` 起真实 web profile，探针把 RPC 结果写成 JSON。

- 退出 `0` = 建成了（缺陷不在这个安装）；`3` = 复现（打印 `code` + 逐行 `reason`）；`2` = 环境跑不动（不是判定）。
- `_dshrt`：`REPRODUCED agent-preset/invalid`（`persona … already registered` + `tool-subagent … requires a scoped preset Context`）。
- 干净 rc.2／rc.3／rc.4：`CREATED session …`，且 `value.agentPreset` 是 `"standard"` —— preset **真的组进去了**，不是静默降级。

## 根因与证据

**报错文本的来源（rc.2 代码，已定位）**：

1. 部署层与 preset 层挂了同一批插件：`dsh-web-app/cordis.patch.yml` 挂 `dsh-persona`（第 14 行起）、`dsh-command-compact`（74-75）、`dsh-tool-subagent*`（88-100）、`model-selection-settings`（67）；`dsh-web-app/presets/standard.patch.yml:11-12` 又挂一次 `dsh-persona`（`minimal`／`ptc` 同理，第 12 行）。
2. preset 树 audit：`dsh-agent-preset-registry/lib/index.js:219-230`（`mountPreset`），`auditRows`（154-179）把每个失败插件拼成 `id (name): detail`，第 **229** 行 `throw new Error(audit.failed.join("\n"))` —— 这正是我们看到的逐行文本。
3. 该 throw 在 boot 时被**吞掉**：`activate()` 的 catch（515-519）只写 `record.broken` 并 `logger.warn`（默认日志级别下看不到），所以 boot 看起来成功。
4. 到 `session/create` 才炸：`mount()`（686-695）→ `retain()`（632-653）→ `diagnostic()` 返回 `record.broken` → 第 **645** 行抛 `RemoteError('agent-preset/invalid', reason, …)`。所以「boot 不报、建会话才报」是设计如此，不是延迟初始化。
5. 底层重复注册的判据在 `dsh-system-prompt/lib/index.js:203`：`NamedEntries` 在同一 scope 内遇到同名 section 就抛 `already registered`。换句话说：**只有当同一个 scope 里出现第二份 `dsh-persona` 实例时才会这样** —— 即模块身份不同（两份物理副本）。

**为什么干净安装不会撞**：两边关键源文件字节一致（`presets/standard.patch.yml`、`cordis.patch.yml`、`agent-preset-registry/lib/index.js`、`system-prompt/lib/index.js`、`persona/lib/index.js` 全部 SAME），锁文件同为 613619 字节，`@deepseek-ai/*` 顶层解析与 `.pnpm` hoist 集合（304 项）也一致，`_dshrt` 内没有指向外部安装根的 junction（876 个 junction 全部内部）。也就是说：**差异不在源码，而在 `_dshrt` 这个被本地折腾过的安装里**；具体哪一份副本被第二次加载，本次时间盒内未定位（已排除：版本、锁文件、hoist 集合、HOME、启动顺序、源码字节）。

**官方正路**：`AgentPresetRegistry.Config`（同文件 441-444）只有 `default` 与 `selectedDefault`（volatile）两个字段，**没有**「继承 deployment 插件但不重挂」的开关，也没有 `presets: []`／`--no-preset` 之类的官方选项。所以没有「配置层面的正路」；正路是**用干净安装 + 默认 preset**，这条已在 rc.2/rc.3/rc.4 上验证可用。

## 建议

1. **不要因为这件事改钉版本。** 若本来就想跟进新版，`0.2.1-rc.4` 是 npm `next`（`latest` 仍是 rc.2），但那是独立的升级决策，与 preset 无关。
2. **重装 dsh 并复测**（已验证有效）：见下面「后来补上的一环」。
3. **把判定接进回归**：`verify/live` 改用默认 preset（删掉禁用块），并在 opener 里先跑一次 `min-repro` 作为环境自检——环境不干净就先失败，而不是让测试去迁就。
4. **桌面 GUI 不是反例**：Electron 的 dsh 是 `@deepseek-ai/dsh-desktop@0.2.1-rc.2` 自带的一份（`~/.dsh/profiles/desktop` 里根本没有 `@deepseek-ai/dsh*` 依赖，只有 `cosmokit`/`schemastery`），它本来就等于「干净安装」，所以 GUI 能新建会话与本文结论一致。

## 后来补上的一环：怎么重装就好了

`_dshrt` 是 2026-10-26 用 `pnpm add @deepseek-ai/dsh@0.2.1-rc.2`（**没有** `--ignore-scripts`）装的，命令最后以
`[ERR_PNPM_IGNORED_BUILDS]` + exit code 1 收尾。同一台机器上重新装一份、加上 `--ignore-scripts`：

```
pnpm add --ignore-scripts @deepseek-ai/dsh@0.2.1-rc.2     # exit 0
DSH_BIN=<新目录> node min-repro.mjs
→ CREATED  session session-ec71c0b8…   agentPreset "standard"   verdict: bug absent
```

所以最可能的解释是：**那次以 exit 1 收尾的安装留下了一棵不完整的树**（多出一份插件实例，与 §根因 第 5 条吻合）。
没有继续追到具体文件——对使用者的意义已经够了：

> **操作守则：装 dsh 一律加 `--ignore-scripts`，并且必须检查 exit code 是 0。**
> 一个「装完了但其实没装完」的 dsh，症状会以 `agent-preset/invalid` 这种完全不相干的形式出现，
> 排查它会花掉一整个会话。CI 里早就是这么装的（见 `docs/ci.md`），本地手工装过一次没守这条，代价就在这里。


## 未验证

- `_dshrt` 为何多出一份插件实例：未定位到具体文件/原因（已列出排除项）。
- 只测了 Windows + Node 24.21.0 + pnpm 11.28.5；其他平台未测。
- `rc.4` 只跑了 1 次；`rc.3` 2 次；干净 rc.2 5 次。
