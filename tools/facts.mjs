#!/usr/bin/env node
/**
 * facts — 这个仓库里那些「会被写进文档、然后慢慢漂掉」的数字，只在这里量一次。
 *
 * 为什么需要它：本仓库自己早就立过口径（`docs/PRODUCT.md` 末节「数字口径」、
 * `docs/PLAN.md` §11 的复盘）——**数字靠抄、不靠跑，抄来的数字比没有更误导**。
 * 立是立了，但没有机器守着，所以它又漂了一次。同一件事实在不同文件里有 2–3 个版本：
 *
 *   事实            文档里出现过的值      实测
 *   模型可见工具     11 / 13 / 17         见下
 *   状态文件         7 / 9                见下
 *   宿主代码行数     2438 / 4949          见下
 *   验证项数         132 / 186            见下
 *
 * 漂移的原因不是谁抄错了，是**同一个事实有六七个抄写点**（README、落地页、PLAN、
 * PRODUCT、verify/README、dsh-life/README、ci.md），改一处不会想起其余六处。
 * 所以修法不是「这次抄准」，是让抄错会被 CI 拦下来：这个文件量事实，
 * `verify/claims.mjs` 拿文档里的声明跟它逐条对。
 *
 * 它只读文件、只跑 verify 套件，不写任何东西。
 *
 * 用法：
 *   node tools/facts.mjs            # 人读的表格
 *   node tools/facts.mjs --json     # 供程序消费（verify/claims.mjs 用这个）
 *   node tools/facts.mjs --suites   # 额外真跑七套 verify 数项数（慢，约 30s，需要一个能跑的 dsh）
 */
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PLUGIN = path.join(REPO, 'packages', 'dsh-life')

/** 行数口径必须和 `wc -l` 一致（数换行符），否则末尾换行会让数字 ±1 漂。 */
function lineCount (file) {
  const text = fs.readFileSync(file, 'utf8')
  let n = 0
  for (const ch of text) if (ch === '\n') n++
  return n
}

function jsFiles (dir) {
  const full = path.join(PLUGIN, dir)
  if (!fs.existsSync(full)) return []
  return fs.readdirSync(full).filter((f) => f.endsWith('.js')).sort()
}

/**
 * 量出所有静态事实。不需要 dsh，不需要网络。
 *
 * 这些数字的唯一权威来源是代码本身：工具数是 `lib/index.js` 里模型可见的工具定义
 * 条数，状态文件数是 `store.js` 构造函数里真正落盘的那几个路径。谁改了代码，
 * 这里立刻跟着变 —— 这正是要的。
 */
export function measureCodeFacts () {
  const index = fs.readFileSync(path.join(PLUGIN, 'lib', 'index.js'), 'utf8')
  const store = fs.readFileSync(path.join(PLUGIN, 'lib', 'store.js'), 'utf8')

  const tools = [...index.matchAll(/name: '(life_[a-z_]+)'/g)].map((m) => m[1])
  const stateFiles = [...store.matchAll(/\w+: path\.join\(this\.dir, '([^']+)'\)/g)].map((m) => m[1])

  // 账本 kind 的口径是「真正写进账本的那一个」，而且必须扫全部宿主文件：
  // `turn` / `wake` 由 index.js 的事件监听写，`publish` 由发布线写，只在
  // store.js 里数会少三样。
  //
  // 反过来，**无脑 grep `kind: '...'` 会数多** —— `choose.js` 里候选理由有
  // `kind: 'rest' | 'next' | 'continue' | 'retry'`，`ui.js` 里路由有
  // `kind: 'exact'`，它们都叫 kind，但一个字都不进账本。（这是真的踩过的坑：
  // 第一版这样数出 18，比真值多 6。）所以只认 `appendLedger(` 之后的第一个 kind。
  const kinds = new Set()
  for (const file of jsFiles('lib')) {
    const text = fs.readFileSync(path.join(PLUGIN, 'lib', file), 'utf8')
    const call = /appendLedger\s*\(/g
    let m
    while ((m = call.exec(text))) {
      const hit = /kind:\s*'([a-z-]+)'/.exec(text.slice(m.index, m.index + 400))
      if (hit) kinds.add(hit[1])
    }
  }

  const hostFiles = jsFiles('lib')
  const clientFiles = jsFiles('client')
  const files = {}
  for (const f of hostFiles) files[`lib/${f}`] = lineCount(path.join(PLUGIN, 'lib', f))
  for (const f of clientFiles) files[`client/${f}`] = lineCount(path.join(PLUGIN, 'client', f))

  // 挂载点：模块级 inject，加上 ui.js 里条件注册的 webServer（它不在模块级，
  // 但确实是第 6 个挂载点 —— 漏了它就会跟着文档一起写错）。
  const moduleMounts = [...index.matchAll(/root\.inject\(\[([^\]]+)\]/g)]
    .map((m) => m[1].replace(/['\s]/g, '').split(','))
    .flat()
  const uiMounts = /inject\(\['webServer'\]/.test(fs.readFileSync(path.join(PLUGIN, 'lib', 'ui.js'), 'utf8'))
    ? ['webServer']
    : []
  const serviceMounts = [...new Set([...moduleMounts, ...uiMounts])].sort()
  const events = [...new Set([...index.matchAll(/root\.on\('([^']+)'/g)].map((m) => m[1]))].sort()

  // 客户端半身注册进的 slot。它们不是 Host 服务挂载点，所以单独数 ——
  // 混在一起数正是文档里「六个挂载点」这种数法的来源，谁也复核不了。
  const clientSrc = fs.readFileSync(path.join(PLUGIN, 'client', 'life-overview.js'), 'utf8')
  const slots = [...clientSrc.matchAll(/slots\.inject\('([^']+)'/g)].map((m) => m[1]).sort()

  // effect()：卸载时反注册。README 把它列在同一张表里，但它是清理而不是挂载，
  // 所以分开报，别再合成一个「N 个挂载点」。
  const hasEffect = /root\.effect\(/.test(index)

  return {
    tools: { count: tools.length, names: tools },
    stateFiles: { count: stateFiles.length, names: stateFiles },
    ledgerKinds: { count: kinds.size, names: [...kinds].sort() },
    code: {
      hostFiles: hostFiles.length,
      clientFiles: clientFiles.length,
      files,
      totalLines: Object.values(files).reduce((a, b) => a + b, 0),
    },
    // 分开报，不合成一个模糊的「挂载点数」：合成之后没人能复核，而文档里
    // 「六个挂载点」正是这么来的（7 行 inject/on/effect 混数）。
    serviceMounts,
    events,
    slots,
    hasEffect,
  }
}

/**
 * 各套 verify 的名字、文件、以及各自在 CI 里的 outcome 变量。
 *
 * `claims` **不在**这个表里，而且不能进来：它自己会调用 `measureSuiteCounts()`
 * 来核对「文档里的项数」，把它算进被数的集合就是递归。它由 verify/claims.mjs
 * 与 CI 单独跑，并在 verify/README 的表里以显式的一行（不带项数）出现 ——
 * 少一行比多一个自指的循环好。
 */
export const SUITES = [
  { name: 'smoke', file: 'verify/smoke.mjs', outcome: 'SMOKE_OUTCOME' },
  { name: 'day-report', file: 'verify/day-report.mjs', outcome: 'DAYREPORT_OUTCOME' },
  { name: 'demo-data', file: 'verify/demo-data.mjs', outcome: 'DEMODATA_OUTCOME' },
  { name: 'life-week', file: 'verify/life-week.mjs', outcome: 'LIFEWEEK_OUTCOME' },
  { name: 'ui', file: 'verify/ui.mjs', outcome: 'UI_OUTCOME' },
  { name: 'publish', file: 'verify/publish.mjs', outcome: 'PUBLISH_OUTCOME' },
  { name: 'e2e', file: 'verify/e2e-tools.mjs', outcome: 'E2E_OUTCOME' },
  { name: 'pack', file: 'verify/pack-install.mjs', outcome: 'PACK_OUTCOME' },
  // landing 需要一个有 Chromium 的 Playwright。CI 里没有就自己 SKIP（0/0），
  // 所以把它放进表里是安全的 —— 它不会因为缺浏览器而把流水线弄红。
  { name: 'landing', file: 'verify/landing.mjs', outcome: 'LANDING_OUTCOME' },
]

/**
 * 真跑每一套并数出它自己的项数。
 *
 * 为什么数「跑出来的」而不是源码里的 `check(`：`check` 会在循环里被调很多次
 * （soak 就是），静态数不出真实项数。而项数正是文档在引用的事实，所以只能真跑。
 */
export function measureSuiteCounts ({ env = process.env, timeoutMs = 600000 } = {}) {
  const suites = []
  for (const suite of SUITES) {
    const started = Date.now()
    const r = spawnSync(process.execPath, [path.join(REPO, suite.file)], {
      env, timeout: timeoutMs, encoding: 'utf8', cwd: REPO,
    })
    const text = `${r.stdout || ''}${r.stderr || ''}`
    const match = /(\d+)\/(\d+) checks passed/.exec(text)
    // 项数取 `M`（总项数），**不是** `N`（通过数）。
    //
    // 第一版取了 N，于是「有一套正在红」的时候，文档里的总项数会悄悄变小 ——
    // 实测踩到过：demo-data 15/16 时，总项数被写成 210 而不是 211，页面看上去
    // 一切正常，只是少了一项。项数是一个**结构事实**（有多少条断言），
    // 通过率是**运行结果**；把前者写成后者，等于让一次随机失败改写文档。
    const passed = match ? Number(match[1]) : null
    const total = match ? Number(match[2]) : null
    // `0/0` 是「这套自己跳过了」（例如 landing 在没有 Chromium 的机器上），
    // **不是「零项」**。把它当成 0 写进文档，读者会以为这套没有断言 ——
    // 而它其实有 17 条，只是这台机器跑不了。所以标成 skipped，不进合计。
    const skipped = total === 0
    suites.push({
      name: suite.name,
      file: suite.file,
      count: skipped ? null : total,
      passed: skipped ? null : passed,
      total: skipped ? null : total,
      skipped,
      ok: !skipped && r.status === 0 && passed !== null && passed === total,
      exitCode: r.status,
      ms: Date.now() - started,
    })
  }
  // 「跑不起来」和「自己跳过」是两件事：前者要拦住，后者只是这台机器没有那个工具。
  const missing = suites.filter((s) => s.total === null && !s.skipped).map((s) => s.name)
  const skippedSuites = suites.filter((s) => s.skipped).map((s) => s.name)
  const failing = suites.filter((s) => s.total !== null && s.passed !== s.total).map((s) => `${s.name} ${s.passed}/${s.total}`)
  return {
    suites,
    total: suites.reduce((sum, s) => sum + (s.total || 0), 0),
    // 没跑出计数的套件必须被点名 —— 否则 `total` 会静默少算，被写进文档。
    missing,
    // 自己跳过的（缺工具，不是坏了）：要能看见，但不该让流水线红。
    skipped: skippedSuites,
    // 有一套在红也照样报出来：项数是结构事实，不应该被一次失败改写，
    // 但「现在有一套是红的」必须能被看见，不能悄悄混在总项数里。
    failing,
    allPassed: failing.length === 0 && missing.length === 0,
  }
}

/**
 * 文档里那些**必须等于实测**的区域，用成对标记围起来，由 `--write` 生成、
 * 由 `--check` 校验。
 *
 * 为什么不让文档直接写数字：同一个事实有六七个抄写点，人改不全。让机器写，
 * 人手就只剩「决定要不要引用」这一件事。这也正是 `tools/demo-data.mjs`
 * 已经用过的手法（生成一次、入库、`--check` 拦住漂移）。
 *
 * 标记形如：
 *   <!-- facts:file-table -->
 *   ...生成内容...
 *   <!-- /facts:file-table -->
 */
/**
 * 每个宿主文件/客户端文件「做什么」。放在这里而不是 README 里，是为了让整张
 * 代码表由一个地方生成 —— 行数会漂，描述也会漂（文件被改名/合并时）。
 * 键必须覆盖 `measureCodeFacts().code.files` 的全部文件，`--check` 会核这一点。
 */
const FILE_ROLES = {
  'lib/index.js': '插件入口：注册 17 个工具、注入上下文、监听会话事件、向 `schedule` 布防、发布线接线',
  'lib/store.js': '生命状态机：三档变量、承诺、关系、账本、唤醒绑定、outbox；原子落盘',
  'lib/outbox.js': '发布状态机：`draft → checked → approved → sending → confirmed / unconfirmed / failed`、幂等键、三档修剪',
  'lib/choose.js': '活动选择器：七项加权、理由与明细、休息恒存；时钟可注入、无随机',
  'lib/wake.js': '唤醒策略纯函数：静默区间、`every ± jitter`、不跳日夹取、明日兜底；随机量可注入',
  'lib/config.js': '零依赖 Standard Schema 校验器（唤醒 / 选择器 / 发布）',
  'lib/compliance.js': '内容标识：显式 + 隐式、「没有 strip 函数」的硬闸',
  'lib/telegram.js': 'Telegram 适配器（假 fetch 可测、错误里擦 token、平台不可反查就照实说）',
  'lib/ui.js': 'Host 半身：`/life/state.json` 现读真实状态，私密内容不出 Host',
  'client/life-overview.js': '浏览器半身：手写 lazy-CJS、只 `require(\'react\')`、零构建',
}

/** 每套 verify 查什么、要不要 dsh。命令行那段由它生成，数字由真跑填。 */
const SUITE_ROLES = {
  smoke: { needsDsh: true, what: '存储不变量 + 唤醒策略 + 7 天 soak + 活动选择器（确定性）' },
  'day-report': { needsDsh: false, what: '当天报告工具' },
  'demo-data': { needsDsh: false, what: '对外页面引用的那份数据产物与实现一致（含时区稳定性）' },
  'life-week': { needsDsh: false, what: '连跑七天' },
  ui: { needsDsh: false, what: '界面那半边的包清单 / 桩 loader / host 路由 / 私密不外泄' },
  publish: { needsDsh: false, what: '发布状态机 / 标识硬闸 / approval 四态 / TOCTOU / Telegram 脱敏（不联网）' },
  e2e: { needsDsh: true, what: '真实 dsh 端到端' },
  pack: { needsDsh: true, what: '打出来的包能不能装进 profile 并激活' },
  landing: { needsDsh: false, what: '落地页与场景原型的像素级验证（真 Chromium；缺浏览器则跳过）' },
}

export const BLOCKS = [
  {
    name: 'file-table',
    file: 'README.md',
    render: (facts) => {
      const missing = Object.keys(facts.code.files).filter((f) => !FILE_ROLES[f])
      if (missing.length) throw new Error(`FILE_ROLES 缺少：${missing.join(', ')}（新文件要补上职责）`)
      const rows = Object.entries(facts.code.files)
        .map(([file, n]) => `| \`${file}\` | ${n} | ${FILE_ROLES[file]} |`)
      return [
        '| 文件 | 行数 | 做什么 |',
        '| --- | --- | --- |',
        ...rows,
        `| **合计** | **${facts.code.totalLines}** | ${facts.code.hostFiles} 个宿主文件 + ${facts.code.clientFiles} 个客户端文件，零自有依赖 |`,
      ].join('\n')
    },
  },
  {
    // 「N 套共 M 项」那一行：以前手写成「七套共 186 项」并逐套列出数字，
    // 每加一条断言就过期一次（186→203 之间漂了好几次，没有一次有人回头改）。
    // 逐套明细已经在下面的 verify-commands 块里，这里只留一句话。
    name: 'verify-summary',
    file: 'README.md',
    render: (facts) => {
      if (!facts.verify) throw new Error('verify-summary 需要 --suites 真跑的结果')
      const n = facts.verify.suites.length
      const zh = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'][n] || String(n)
      return `| [\`verify/\`](verify/) | ${zh}套共 **${facts.verify.total} 项**；另有一条 opt-in 的真实唤醒检查（3 项） |`
    },
  },
  {
    // 文件清单里那一行也列了套件名，同样会随「加一套」而漏（加 demo-data 时就漏了）。
    name: 'verify-workflow',
    file: 'README.md',
    render: (facts) => {
      if (!facts.verify) throw new Error('verify-workflow 需要 --suites 真跑的结果')
      const n = facts.verify.suites.length
      const zh = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'][n] || String(n)
      const names = facts.verify.suites.map((s) => s.name).join(' / ')
      return `| [\`.github/workflows/verify.yml\`](.github/workflows/verify.yml) | ubuntu + windows 各跑一遍${zh}套 verify（${names}） |`
    },
  },
  {
    // 「验证」那一节的开头句：它写着「合计 186 项」，而 186 是好几轮以前的数。
    name: 'verify-headline',
    file: 'README.md',
    render: (facts) => {
      if (!facts.verify) throw new Error('verify-headline 需要 --suites 真跑的结果')
      const n = facts.verify.suites.length
      const zh = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'][n] || String(n)
      const sn = (name) => {
        const s = facts.verify.suites.find((x) => x.name === name) || {}
        return s.skipped ? '未跑' : (s.count ?? '?')
      }
      const per = `存储/策略/soak ${sn('smoke')} + 当天报告 ${sn('day-report')} + 数据产物 ${sn('demo-data')}`
        + ` + 七天连续 ${sn('life-week')} + 界面 ${sn('ui')} + 发布线 ${sn('publish')}`
        + ` + 真实 dsh 端到端 ${sn('e2e')} + 打包安装 ${sn('pack')}`
      return [
        `${zh}套 verify 在 GitHub Actions 上 **ubuntu + windows 各跑一遍**`,
        `（[\`.github/workflows/verify.yml\`](.github/workflows/verify.yml)，固定 dsh \`0.2.1-rc.2\`，失败时日志进 artifact）。`,
        `合计 **${facts.verify.total} 项**：${per}。`,
      ].join('')
    },
  },
  {
    // 命令行那段：数字来自真跑，注释里的「查什么」来自 SUITE_ROLES。
    name: 'verify-commands',
    file: 'README.md',
    render: (facts) => {
      if (!facts.verify) throw new Error('verify-commands 需要 --suites 真跑的结果')
      // 这里**不放耗时**。第一版放了（`· 2.7s`），结果是这个块每次重跑都不一样，
      // 「生成块与实测一致」这条断言永远红 —— 一个永远红的断言等于没有断言。
      // 耗时是观测，不是事实；事实是项数。
      const lines = facts.verify.suites.map((s) => {
        const role = SUITE_ROLES[s.name]
        const prefix = role.needsDsh ? 'DSH_BIN=<dsh bin> ' : ''
        const cmd = `${prefix}node ${s.file}`
        // 自己跳过的套件（这台机器缺工具）不写「null 项」—— 那会被读成
        // 「这套没有断言」。写成「本机未跑」，并说明为什么。
        const what = s.skipped ? `${role.what}（本机未跑：缺工具）` : `${s.count} 项 · ${role.what}`
        // 命令要留一列再写注释；DSH_BIN 那几条前缀很长，用 50 才能都对齐。
        return `${cmd.padEnd(50)}# ${what}`
      })
      lines.push(
        'DSH_BIN=<dsh bin> node verify/live/wake-live.mjs'.padEnd(50) +
        '# 可选 · 真实 web profile 的一次真实唤醒（先体检安装）',
        '# 另外：node verify/claims.mjs 核对文档里这些数字有没有过期',
        '# （它不在上面的项数里 —— 它数的就是这些项数，不能自己数自己）',
      )
      return ['```sh', ...lines, '```'].join('\n')
    },
  },
  {
    // 落地页的「生命层」一行。落地页是 HTML，注释标记用的是 `<!-- -->`，
    // 与 README 一样的形式 —— 同一套 write/check 逻辑不用改。
    name: 'life-size',
    file: 'docs/index.html',
    render: (facts) => `      <div class="row"><span class="n">生命层：身份、兴趣、承诺、账本<span>${facts.code.hostFiles} 个宿主文件 ${facts.code.totalLines} 行（含客户端半身 ${facts.code.files['client/life-overview.js']} 行），零自有依赖，${facts.tools.count} 个工具，${facts.stateFiles.count} 个状态文件</span></span><span class="pill done">已完成</span></div>`,
  },
  {
    // 落地页的「验证」一行。以前写「132 项」，而真值一直在动。
    name: 'verify-count',
    file: 'docs/index.html',
    render: (facts) => {
      if (!facts.verify) throw new Error('verify-count 需要真跑结果')
      return `      <div class="row"><span class="n">验证：${facts.verify.total} 项全绿<span>存储不变量 · 当天报告 · 连跑七天 · 界面注册 · 发布线 · 真实 dsh 端到端 · 打包安装</span></span><span class="pill done">已完成</span></div>`
    },
  },
  {
    // PLAN 的代码规模行：它以前写「4949 行 / 6 个服务挂载点 / 9 个状态文件」，
    // 三个数全是错的（真值 5010 / 5 / 8），而没有任何东西会报错。
    name: 'plan-code-size',
    file: 'docs/PLAN.md',
    render: (facts) => {
      const per = Object.entries(facts.code.files)
        .map(([f, n]) => `\`${f.replace(/^lib\//, '').replace(/^client\//, '')}\` ${n}`)
        .join(' / ')
      return [
        `**代码规模**：${facts.code.hostFiles} 个 host 文件 + ${facts.code.clientFiles} 个 client 文件，`,
        `${facts.code.totalLines} 行（${per}），零自有依赖，${facts.tools.count} 个工具，`,
        `${facts.serviceMounts.length} 个服务挂载点 + ${facts.events.length} 个会话事件 + 客户端 ${facts.slots.length} 个 slot，`,
        `${facts.stateFiles.count} 个状态文件。`,
      ].join('')
    },
  },
  {
    // PLAN §11.1 的表：它手写了每套的项数（68/22/26…）与合计（186），
    // 一个都没跟上代码。这两处直接由真跑结果生成。
    name: 'plan-verify-table',
    file: 'docs/PLAN.md',
    render: (facts) => {
      if (!facts.verify) throw new Error('plan-verify-table 需要真跑结果')
      const byName = new Map(facts.verify.suites.map((s) => [s.name, s]))
      const rows = [
        ['smoke', 'verify/smoke.mjs', '存储不变量、持久性、损坏降级、**唤醒策略与记账、7 天 soak**、**活动选择器**（确定性，可注入随机量）', false],
        ['day-report', 'verify/day-report.mjs', '「它的一天」报告工具：账本→人话的翻译、失败照实说、结论带证据、缺数据不崩', false],
        ['demo-data', 'verify/demo-data.mjs', '对外页面引用的数据产物与实现一致；含「换时区结论不变」与「篡改能被发现」', false],
        ['life-week', 'verify/life-week.mjs', '连跑七天（压缩时钟，复用生产的 store/choose/wake）', false],
        ['ui', 'verify/ui.mjs', '界面半边：包清单、桩 loader 注册、host 路由的真实数据、私密不外泄、headless 零回归', false],
        ['publish', 'verify/publish.mjs', '发布线：状态机、标识硬闸、approval 四态、TOCTOU、Telegram 载荷与脱敏；含两组 mutation', false],
        ['e2e', 'verify/e2e-tools.mjs', '真 dsh 端到端：组合 profile → `dsh plugin` 安装 → 启动 → 断言运行系统实际产出', true],
        ['pack', 'verify/pack-install.mjs', '`pnpm pack` 出的 tarball 装进全新 profile 能否激活（最接近 npm 的替身）', true],
      ]
      const table = [
        '| 套件 | 项数 | 查什么 | 需要真 dsh？ |',
        '| --- | --- | --- | --- |',
        ...rows.map(([name, file, what, dsh]) => {
          const s = byName.get(name)
          const cell = s.skipped ? '**—**（本机未跑）' : `**${s.count}**`
          return `| \`${file}\` | ${cell} | ${what} | ${dsh ? '是' : '否'} |`
        }),
        '| `verify/live/wake-live.mjs` | **3**（opt-in） | 真实 web profile 下的一次真实唤醒（三个连续进程），默认不进 CI | 是 |',
      ].join('\n')
      return [
        `实测 **${facts.verify.total} 项全绿**，命令与前置条件见 [\`verify/README.md\`](../verify/README.md)：`,
        '',
        table,
        '',
        `${['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'][facts.verify.suites.length]}套都在 GitHub Actions 上 ubuntu + windows 各跑一遍（[\`.github/workflows/verify.yml\`](../.github/workflows/verify.yml)）。`,
        `**项数与合计都是真跑出来的**（\`node tools/facts.mjs\` 量、\`node verify/claims.mjs\` 拦），不再手写。`,
      ].join('\n')
    },
  },
  {
    // verify/README 的总表：项数在这里被手抄了三遍（smoke 68、day-report 22、
    // e2e 写 13 个工具），而真值一直在动。
    name: 'verify-table',
    file: 'verify/README.md',
    render: (facts) => {
      const v = facts.verify
      if (!v) throw new Error('verify-table 需要真跑结果')
      const byName = new Map(v.suites.map((s) => [s.name, s]))
      // 从 SUITES 推，不再手写一份映射 —— 手写的那份每加一套就会漏一次，
      // 而漏掉的表现是「表格里少一行」，没人会注意（正是它本要解决的问题）。
      const fileOf = Object.fromEntries(SUITES.map((s) => [s.name, s.file]))
      const rows = Object.keys(fileOf).map((name) => {
        const s = byName.get(name)
        const role = SUITE_ROLES[name]
        if (s.skipped) {
          return `| \`${fileOf[name]}\` | 本机未跑（缺浏览器等工具）：${role.what} | — |`
        }
        return `| \`${fileOf[name]}\` | ${s.count} 项：${role.what}${role.needsDsh ? '（需要真 dsh）' : '（不需要真 dsh）'} | ${s.passed}/${s.total} 通过${s.ok ? '' : ' ⚠'} |`
      })
      return [
        `| 套件 | 查什么 | 本机实测（合计 ${v.total} 项） |`,
        '|---|---|---|',
        ...rows,
        '| `verify/claims.mjs` | 文档里的数字有没有过期（它数的就是上面这些项数，所以不计入合计） | 见 `node verify/claims.mjs` |',
      ].join('\n')
    },
  },
  {
    // 状态文件块：以前这里手列 7 个，而 store 实际写 8 个 —— 少的正是发布线加的
    // outbox.json。少列一个状态文件，读的人就会以为发布没有持久化。
    name: 'state-files',
    file: 'README.md',
    render: (facts) => {
      const missing = facts.stateFiles.names.filter((f) => !STATE_ROLES[f])
      if (missing.length) throw new Error(`STATE_ROLES 缺少：${missing.join(', ')}`)
      const width = Math.max(...facts.stateFiles.names.map((n) => n.length))
      return [
        `\`$DSH_HOME/life/<lifeId>/\` —— ${facts.stateFiles.count} 个状态文件：`,
        '',
        '```',
        ...facts.stateFiles.names.map((f) => `${f.padEnd(width)}  ${STATE_ROLES[f]}`),
        '```',
      ].join('\n')
    },
  },
  {
    // 挂载点块：以前这里写「六个挂载点」，是把 5 个 inject + 2 个 on + 1 个 effect
    // 混数出来的 —— 谁也没法复核「6」是怎么来的。分开列，每行都能 grep 到。
    name: 'mounts',
    file: 'README.md',
    render: (facts) => {
      // 左列对齐到最长的一条，读起来像一张表，而不是一串随手写的行。
      const left = [
        ...facts.serviceMounts.map((n) => `inject(['${n}'])`),
        ...facts.events.map((n) => `on('${n}')`),
        ...(facts.hasEffect ? ['effect()'] : []),
      ]
      const width = Math.max(...left.map((l) => l.length))
      const rows = left.map((l) => `${l.padEnd(width)}  → ${MOUNT_TARGETS[l.replace(/^(inject\(\['|on\(')/, '').replace(/'\]\)$|'\)$/, '')] ?? '（未登记目标：请补 MOUNT_TARGETS）'}`)
      return [
        `**${facts.serviceMounts.length} 个服务挂载点 + ${facts.events.length} 个会话事件 + 客户端 ${facts.slots.length} 个 slot**（全部是公开扩展点）：`,
        '',
        '```',
        ...rows,
        '```',
      ].join('\n')
    },
  },
]

/** 每个状态文件是什么。README 的状态块由它生成：漏一个文件就是漏一个状态。 */
const STATE_ROLES = {
  'identity.json': '慢变量 · 带版本号',
  'traits.json': '兴趣 · 技能（带置信度与来源）',
  'relations.json': '主人 / 公开分开存',
  'commitments.json': '承诺',
  'activity.json': '当前 + 上一次',
  'ledger.jsonl': '追加式账本 · 半行跳过 · 有上限',
  'wake.json': '唤醒绑定 · 下一个闹钟 · 当天预算 · 已投递 messageId',
  'outbox.json': '发布草稿与回执 · 幂等键 · 三档修剪（committed 永不丢）',
}

/** 每个挂载点/事件「接到什么」。`--check` 会在有挂载点没登记时直接抛错。 */
const MOUNT_TARGETS = {
  tools: "ctx.tools.register()  注册 17 个工具",
  systemPrompt: 'ctx.systemPrompt.section()  注入每轮上下文',
  schedule: 'ctx.schedule.create()  布防一次性唤醒',
  approval: 'ctx.approval.request()  发布前逐条确认',
  webServer: 'ctx.webServer.register()  /life/state.json（headless 里不注册）',
  'agent/inbox/claimed': '在 prompt 组装前知道「这一轮是唤醒」',
  'session/event': '账本：turn、schedule 投递',
  'effect()': '卸载时全部反注册',
}

/**
 * 被度量的那些文件里，有没有**未提交**的改动？
 *
 * 为什么需要它：`--write` 会把当前工作区量出来的数字**写进文档**，而 CI 看到的
 * 是提交后的状态。两者不一致时，文档里就留下一个「本地全绿、CI 全红」的数字。
 *
 * 这不是假设 —— 真的发生了：并行干活时，一个 agent 的 `verify/demo-data.mjs`
 * 有未提交改动（13 条断言），`--write` 把 16 写进了 README，而提交的版本是 17。
 * 本地跑一遍全绿（因为本地读的是同一个工作区），CI 上 `claims` 报「生成块与实测
 * 不一致」——**而 CI 是对的，文档是错的**。
 *
 * 所以 `--write` 在有未提交改动时拒绝执行：读 C 写 A 得到 B，这种账没人能对。
 * `--check` 只警告不拒绝（它不会把数字写进任何文件，破坏性为零）。
 */
function uncommittedMeasuredFiles () {
  // 被度量的路径：宿主代码（工具数/行数/状态文件/挂载点）与各套 verify（项数）。
  const paths = ['packages/dsh-life', 'verify', 'tools']
  let out = ''
  try {
    out = execFileSync('git', ['status', '--porcelain', '--', ...paths], {
      cwd: REPO, encoding: 'utf8',
    })
  } catch {
    // 没有 git（或不在仓库里）时不能判断，就当作干净 —— 不因为环境缺 git 而拦人。
    return null
  }
  return out.split('\n')
    .map((l) => l.slice(3).trim())
    .filter(Boolean)
    // facts.mjs 自己肯定可能是脏的（你正在改它），那不是「数字来源不可信」。
    .filter((f) => f !== 'tools/facts.mjs')
}

/** 把 CRLF 归一成 LF。生成与比对都必须走它，否则 Windows 上会假红。 */
const normalizeEol = (text) => text.replace(/\r\n/g, '\n')

const MARK = (name) => ({ open: `<!-- facts:${name} -->`, close: `<!-- /facts:${name} -->` })

/** 把 blocks 里的区域重写进文件。返回改过哪些文件。 */
/**
 * 生成块里出现 `null` / `NaN` 一律当成错误，而不是「写下去再说」。
 *
 * 真的发生过：一次并发跑里 e2e 没跑出计数，`verify-count` 块当场被写成
 * 「验证：178 项全绿」—— 少算了 17 项，而**页面上看不出任何异常**。
 * 把 `null` 写进文档比不写更糟，因为它长得像个数。
 */
function assertRenderable (name, text) {
  const bad = /\b(null|undefined|NaN)\b/.exec(text)
  if (bad) throw new Error(`生成块 ${name} 渲染出了 ${bad[1]}：拒绝写入文档。\n${text}`)
}

export function writeBlocks (facts, { only = null } = {}) {
  for (const block of BLOCKS) {
    if (only && !only.includes(block.name)) continue
    assertRenderable(block.name, block.render(facts))
  }
  const touched = new Set()
  for (const block of BLOCKS) {
    if (only && !only.includes(block.name)) continue
    const file = path.join(REPO, block.file)
    const text = fs.readFileSync(file, 'utf8')
    const { open, close } = MARK(block.name)
    const i = text.indexOf(open)
    const j = text.indexOf(close)
    if (i < 0 || j < 0) throw new Error(`${block.file} 缺少 ${open} / ${close} 标记`)
    // 写回时必须**保持文件原有的换行风格**。文件可能是 CRLF（Windows 的
    // checkout），而生成内容用的是 `\n`；直接拼会写出一个混合换行的文件 ——
    // README 上实测会产生 451 行假 diff，把真正的一行改动埋掉。
    const eol = text.includes('\r\n') ? '\r\n' : '\n'
    const body = normalizeEol(block.render(facts)).split('\n').join(eol)
    const next = text.slice(0, i + open.length) + eol + body + eol + text.slice(j)
    if (next !== text) { fs.writeFileSync(file, next); touched.add(block.file) }
  }
  return [...touched]
}

/** 只比对不写。返回不一致的块。 */
export function checkBlocks (facts) {
  for (const block of BLOCKS) assertRenderable(block.name, block.render(facts))
  const stale = []
  for (const block of BLOCKS) {
    const text = fs.readFileSync(path.join(REPO, block.file), 'utf8')
    const { open, close } = MARK(block.name)
    const i = text.indexOf(open)
    const j = text.indexOf(close)
    if (i < 0 || j < 0) { stale.push({ block: block.name, file: block.file, reason: '标记缺失' }); continue }
    // 换行必须归一化再比：块的生成用的是 `\n`，而 checkout 出来可能是 CRLF
    // （`.gitattributes` 没固定 eol，Windows 上 runner 的 core.autocrlf 会改它）。
    // 不归一化的话，Windows 上会报「每个块都不一致」—— 而文件其实一个字都没错。
    // 这条是实测出来的：把 README 转成 CRLF，`--check` 立刻报 6 个块 STALE。
    const onDisk = normalizeEol(text.slice(i + open.length, j)).replace(/^\n|\n$/g, '')
    const fresh = normalizeEol(block.render(facts))
    if (onDisk !== fresh) stale.push({ block: block.name, file: block.file, reason: '与实测不一致' })
  }
  return stale
}

function human (facts) {
  const lines = ['这个仓库的事实（唯一权威来源：代码与真跑）', '']
  lines.push(`  模型可见工具          ${facts.tools.count}   ${facts.tools.names[0]} … ${facts.tools.names.at(-1)}`)
  lines.push(`  状态文件              ${facts.stateFiles.count}   ${facts.stateFiles.names.join(' ')}`)
  lines.push(`  账本 kind             ${facts.ledgerKinds.count}   ${facts.ledgerKinds.names.join(' ')}`)
  lines.push(`  宿主 / 客户端文件      ${facts.code.hostFiles} / ${facts.code.clientFiles}`)
  lines.push(`  代码行数（wc -l 口径） ${facts.code.totalLines}`)
  for (const [file, n] of Object.entries(facts.code.files)) lines.push(`      ${file.padEnd(26)} ${n}`)
  lines.push(`  服务挂载点            ${facts.serviceMounts.length}   ${facts.serviceMounts.join(' ')}`)
  lines.push(`  会话事件监听          ${facts.events.length}   ${facts.events.join(' ')}`)
  lines.push(`  客户端 slot           ${facts.slots.length}   ${facts.slots.join(' ')}`)
  lines.push(`  卸载 effect           ${facts.hasEffect ? '有' : '无'}`)
  if (facts.verify) {
    lines.push('', '  verify 套件（真跑）')
    for (const s of facts.verify.suites) {
      lines.push(`    ${s.ok ? 'ok  ' : 'BAD '}${s.name.padEnd(11)} ${String(s.passed).padStart(3)}/${String(s.total).padEnd(3)} ${String(s.ms).padStart(6)}ms`)
    }
    lines.push(`    合计 ${facts.verify.total} 项${facts.verify.failing.length ? ` —— 红：${facts.verify.failing.join(', ')}` : ''}`)
  } else {
    lines.push('', '  （加 --suites 会真跑七套 verify 数项数；需要一个能跑的 dsh，约 30s）')
  }
  return lines.join('\n')
}

function main () {
  const argv = process.argv.slice(2)
  const facts = measureCodeFacts()
  // --write / --check 都要真跑套件：项数是文档在引用的事实，不能来自缓存。
  const needSuites = argv.includes('--suites') || argv.includes('--write') || argv.includes('--check')
  if (needSuites) facts.verify = measureSuiteCounts()

  const dirty = uncommittedMeasuredFiles()

  if (argv.includes('--write')) {
    // 有未提交改动时**拒绝写入**：写进去的数字描述的是工作区，而 CI 看到的是提交。
    // 详见 uncommittedMeasuredFiles() 的说明（这真的发生过）。
    if (dirty && dirty.length && !argv.includes('--allow-dirty')) {
      console.error('拒绝写入：被度量的文件里有未提交改动，写进去的数字 CI 看不到。')
      for (const f of dirty.slice(0, 12)) console.error(`  未提交：${f}`)
      if (dirty.length > 12) console.error(`  …还有 ${dirty.length - 12} 个`)
      console.error('\n先把它们提交（或 stash），再跑 --write。确实要预览就加 --allow-dirty。')
      process.exitCode = 1
      return
    }
    const touched = writeBlocks(facts, { only: argValue(argv, '--only') })
    console.log(touched.length ? `已更新：${touched.join(', ')}` : '无需更新（已是最新）')
    return
  }

  if (argv.includes('--check')) {
    // --check 不改文件，破坏性为零，所以只警告 —— 但必须说清结论可能不对。
    if (dirty && dirty.length) {
      console.error(`注意：被度量的文件里有 ${dirty.length} 个未提交改动，下面的结论只对当前工作区成立。`)
    }
    const stale = checkBlocks(facts)
    if (stale.length) {
      for (const s of stale) console.error(`STALE  ${s.file} 的 ${s.block} 块：${s.reason}`)
      console.error('\n跑 `node tools/facts.mjs --write` 重新生成。')
      process.exitCode = 1
      return
    }
    console.log('文档里的生成块与实测一致。')
    return
  }
  console.log(argv.includes('--json') ? JSON.stringify(facts, null, 2) : human(facts))
}

/** `--only a,b` 的值。 */
function argValue (argv, flag) {
  const i = argv.indexOf(flag)
  return i >= 0 && argv[i + 1] ? argv[i + 1].split(',').map((s) => s.trim()) : null
}

// 只有被当命令行跑时才执行；被 import 时（verify/claims.mjs）只导出函数。
// Windows 上 argv[1] 是裸路径，必须过 pathToFileURL 才能与 import.meta.url 比 ——
// 本仓库已经因为漏这一步在 CI 上红过一次（verify/README.md「Windows 上修过的四个坑」）。
const invokedDirectly = Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) main()
