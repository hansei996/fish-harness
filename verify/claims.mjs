/**
 * claims — 让「数字必须跑出来，不能抄」这条纪律真的拦得住人。
 *
 * 这条纪律在 `docs/PLAN.md` §14 与 `AGENTS.md` §2.1 都立过，而且**立完之后又被
 * 违反了**：同一件事实在同一个仓库里出现两三个版本（工具 11/13/17，状态文件
 * 7/8，行数 2438/4949/5010，验证项 132/186/195）。原因不是谁抄错了，是同一个
 * 数字有六七个抄写点，改一处不会想起其余六处。
 *
 * 所以这个套件做两件事：
 *
 *   1. **生成块不许漂。** README 里的代码表 / 挂载点 / 状态文件 / verify 命令行
 *      是由 `node tools/facts.mjs --write` 从代码生成的。这里重新生成一遍逐字
 *      比对 —— 改了代码没重新生成，或者有人手改了生成块，都会红。
 *   2. **旧数字不许回流。** 「13 个工具」「9 个状态文件」这类值一旦出现就是错，
 *      除了明确标注为历史叙事的那些行（见下面的 HISTORICAL）。
 *
 * 它**只管结构事实**：工具数、状态文件、行数、挂载点、真跑项数。散落在叙述里的
 * 观测（「七天 31 次唤醒里 30 次给了两个已知兴趣」）是某次运行的记录，不可从当前
 * 代码重算，所以不在范围内 —— 把范围说清，比假装全覆盖诚实。
 *
 * 用法：
 *   node verify/claims.mjs            # 缺 DSH_BIN 时跳过项数类断言，其余照跑
 *   node verify/claims.mjs --json
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { measureCodeFacts, measureSuiteCounts, BLOCKS, checkBlocks, SUITES } from '../tools/facts.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8')

const results = []
function check (label, ok, detail = '') {
  results.push({ label, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

// ---------------------------------------------------------------- 1. 结构事实

const facts = measureCodeFacts()

// A documentation read must not silently launch a browser. Exercise the runner
// boundary, then remove the separation to prove the predicate detects a leak.
const measuredCalls = []
const fakeRun = (_bin, args) => { measuredCalls.push(args); return { status: 0, stdout: '1/1 checks passed', stderr: '' } }
measureSuiteCounts({ runSuite: fakeRun })
const noBrowserCall = (calls) => !calls.some((args) => args[0].endsWith('landing.mjs'))
check('事实度量不启动独立的浏览器验收，UI 使用稳定的 offline 口径',
  noBrowserCall(measuredCalls) && measuredCalls.some((args) => args[0].endsWith('ui.mjs') && args.includes('--offline')))
const browserSuite = SUITES.find((suite) => suite.name === 'landing')
try {
  browserSuite.separate = false
  measuredCalls.length = 0
  measureSuiteCounts({ runSuite: fakeRun })
  check('移除浏览器分离后上述不启动浏览器的判据确实失败', !noBrowserCall(measuredCalls))
} finally { browserSuite.separate = true }
check('即使打印了通过汇总，验证进程异常退出也不能被统计成全绿',
  !measureSuiteCounts({ runSuite: () => ({ status: 1, stdout: '1/1 checks passed', stderr: 'fatal after checks' }) }).allPassed)

// 每个生成块都要真的存在于它的文件里。标记丢了 = 生成块被删了，那就是漂移。
for (const block of BLOCKS) {
  const text = read(block.file)
  check(`生成块 ${block.name} 存在于 ${block.file}`,
    text.includes(`<!-- facts:${block.name} -->`) && text.includes(`<!-- /facts:${block.name} -->`))
}

// 逐字比对（不写盘）。这里要真跑套件，因为有的生成块里含项数。
const suites = measureSuiteCounts()
const withSuites = { ...facts, verify: suites }

// 没跑出计数的套件（多半是没设 DSH_BIN）：**跳过项数类断言，而不是拿 null 去比**。
// 拿 null 比会同时坏两件事：块被渲染成 null 写进文档，或者报一个假的「不一致」。
// 两种都是「用一个跑不动的数字去核对」，正是这条纪律要防的。
if (suites.missing.length) {
  console.log(`SKIP  生成块逐字比对 —— ${suites.missing.join(', ')} 没跑出项数（缺 DSH_BIN？）`)
} else {
  const stale = checkBlocks(withSuites)
  check('文档里每个生成块都与实测一致（改了代码就要重新生成）',
    stale.length === 0,
    stale.length ? stale.map((s) => `${s.file}:${s.block} ${s.reason}`).join('; ') : `${BLOCKS.length} 个块`)
}

// ---------------------------------------------------------------- 2. 旧数字回流

// 这些值一旦出现在文档里就是错的 —— 除非那一行被明确标成历史叙事。
// 历史叙事必须自带标记，不能靠「读者自己看出来」，那正是上一轮误判的来源。
// 每个值都标成 historical：这些数字**在说的是当年那一刻**（讲某个 bug 是怎么被
// 抓到的、某份规划当时面对什么），删掉它们等于毁掉历史记录 —— 而「记下自己错过
// 什么」正是这个仓库的立身之本。所以规则不是「不许出现」，是「不许冒充现状」：
// 出现的那一行必须带 `（历史` / `当年` / `当时` 之类的标记，读者不用自己猜。
//
// 这一条我改过：第一版把 13 个工具与 7 个状态文件标成 historical:false，于是
// README 里「当时的 13 个工具里也没有」这类**合法历史叙述**被判成漂移。核对器
// 比文档严格不是优点 —— 误报会让人学会忽略它，那它就死了。
const STALE = [
  { value: '13 个工具', why: '工具数是 17，只有讲当年的 bug 时才成立', historical: true },
  { value: '9 个状态文件', why: '状态文件是 8，只有讲当年时才成立', historical: true },
  { value: '7 个状态文件', why: '状态文件是 8，只有讲当年时才成立', historical: true },
  // 「11 个工具静默注册失败」讲的是当年那个 bug，删掉会毁掉历史记录。
  { value: '11 个工具', why: '只有讲当年的注册 bug 时才成立，必须标成历史', historical: true },
]

const DOCS = ['README.md', 'docs/PLAN.md', 'docs/PRODUCT.md', 'docs/STORY.md', 'verify/README.md', 'docs/ci.md', 'docs/index.html']
const HISTORICAL = /（历史[：:]|历史上|\(history[:：]|当年|那时候|当时|那时/

const leaks = []
for (const file of DOCS) {
  let text
  try { text = read(file) } catch { continue }
  for (const { value, why, historical } of STALE) {
    if (!text.includes(value)) continue
    for (const line of text.split(/\r?\n/)) {
      if (!line.includes(value)) continue
      if (historical && HISTORICAL.test(line)) continue
      leaks.push(`${file} · 「${value}」 —— ${why}：${line.trim().slice(0, 70)}`)
    }
  }
}
check('文档里没有回流的旧数字（历史叙事须显式标注）',
  leaks.length === 0,
  leaks.length ? `${leaks.length} 处：${leaks.join(' | ')}` : `${DOCS.length} 个文件已扫`)

// ---------------------------------------------------------------- 3. 派生器只有一份

// 上一轮真的发生过：两个 Agent 各写了一个「数事实」的东西，两边的口径立刻漂了
// （挂载点 4 vs 5、账本 kind 13 vs 12）。漂的派生器比没有更糟 —— 它让人以为
// 有一个权威来源，而实际上是两个互相矛盾的说法。
//
// 所以断言：量事实的实现只允许在 tools/facts.mjs 里；verify/ 下不许再有第二份
// 「读 index.js 数 life_ 工具」的逻辑。
const dupeScan = []
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) { walk(full); continue }
    if (!entry.name.endsWith('.mjs')) continue
    if (path.relative(REPO, full) === path.join('tools', 'facts.mjs')) continue
    if (path.relative(REPO, full) === path.join('verify', 'claims.mjs')) continue
    const text = fs.readFileSync(full, 'utf8')
    // 「自己再数一遍」的特征：同时出现工具名正则与一个 tool 计数。
    if (/life_\[a-z_\]\+/.test(text) && /tools\s*=\s*\[/.test(text)) {
      dupeScan.push(path.relative(REPO, full))
    }
  }
}
walk(path.join(REPO, 'tools'))
walk(path.join(REPO, 'verify'))
check('只有 tools/facts.mjs 在量结构事实（没有第二份派生器）',
  dupeScan.length === 0,
  dupeScan.length ? `重复的度量逻辑：${dupeScan.join(', ')}` : '未发现重复')

// ---------------------------------------------------------------- 4. AGENTS.md 承诺的入口真的在

const agents = read('AGENTS.md')
check('AGENTS.md 里承诺的度量入口真实存在（tools/facts.mjs）',
  fs.existsSync(path.join(REPO, 'tools', 'facts.mjs')) && agents.includes('tools/facts.mjs'))
check('AGENTS.md 指向的每个 verify 套件都存在',
  SUITES.every((s) => fs.existsSync(path.join(REPO, s.file))) && agents.includes('verify/smoke.mjs'))

// 文档里引用一个 **不存在的** 脚本，比引用一个过期的数字更糟：读者会照着敲，
// 然后得到一个 ENOENT 而不知道是谁写错了。真的发生过 —— `AGENTS.md` 曾指向
// 一个被删掉的 `verify/numbers.mjs`。
const referenced = new Set()
for (const file of [...DOCS, 'AGENTS.md', 'verify/README.md']) {
  let text
  try { text = read(file) } catch { continue }
  for (const m of text.matchAll(/(?:verify|tools)\/[a-z0-9-]+\.mjs/g)) referenced.add(m[0])
}
const dangling = [...referenced].filter((rel) => !fs.existsSync(path.join(REPO, rel)))
check('文档里引用的每个 verify/tools 脚本都真实存在',
  dangling.length === 0,
  dangling.length ? `指向不存在的文件：${dangling.join(', ')}` : `${referenced.size} 个引用已核`)

// ---------------------------------------------------------------- 5. CI workflow 自身合法

/**
 * 这一条是真事故的产物：`verify.yml` 里 `claims` 步骤被加了两次（两个
 * `id: claims`），GitHub Actions 认为整个 workflow 非法，**run 在 0 秒就失败**，
 * 连 checkout 都没跑。所有套件本地全绿，CI 却全红 —— 而且「0 秒失败」看起来
 * 像基础设施抖动，不像自己写错了。
 *
 * 本地跑一次这个检查只要几毫秒，能省掉一轮 push→等 CI→看日志。
 */
const workflow = read('.github/workflows/verify.yml')

// YAML 的一个子集就够：我们只需要每个步骤的 `id:` 与 `name:`，不需要解析全部语法
// （也不引入 yaml 依赖 —— 这个仓库零运行时依赖是硬约束，verify 也不破例）。
const stepIds = [...workflow.matchAll(/^\s+- name: (.+)$/gm)].map((m) => m[1].trim())
const ids = [...workflow.matchAll(/^\s+id: (\S+)$/gm)].map((m) => m[1])
const dupIds = [...new Set(ids.filter((id) => ids.filter((x) => x === id).length > 1))]
check('workflow 里没有重复的 step id（重复会让整个 run 0 秒失败）',
  dupIds.length === 0,
  dupIds.length ? `重复 id：${dupIds.join(', ')}` : `${ids.length} 个 id`)

// 每套 verify 在 CI 里必须**恰好**被跑一次：漏了等于没进 CI，重复等于浪费机器。
// 只数**真正会被执行的行**：`run:` 里那些 `node verify/xxx.mjs`。
// 不能对着整份 workflow 做全文匹配 —— 注释里提到一个文件名（例如「手动跑请用
// node verify/market.mjs」）会被算成「第二次调用」，于是这条断言报出一个假重复。
// 判据必须贴着「什么会被执行」，而不是「文件里出现过几次这个词」。
const runBlocks = [...workflow.matchAll(/^\s*run:\s*\|\n((?:\s{8,}.*\n?)*)/gm)]
  .map((m) => m[1]).join('\n')
const missingInCi = []
const dupInCi = []
for (const suite of SUITES) {
  const n = (runBlocks.match(new RegExp(`node ${suite.file.replace('.', '\\.')}`, 'g')) || []).length
  if (n === 0) missingInCi.push(suite.name)
  else if (n > 1) dupInCi.push(`${suite.name}×${n}`)
}
check('每套 verify 在 CI 里恰好跑一次',
  missingInCi.length === 0 && dupInCi.length === 0,
  [missingInCi.length ? `没进 CI：${missingInCi.join(', ')}` : '', dupInCi.length ? `重复：${dupInCi.join(', ')}` : ''].filter(Boolean).join('; ') || `${SUITES.length} 套`)

// 本机入口与 CI 必须是**同一组参数**。
//
// 真事故：`package.json` 的 `verify` 链里跑的是 `node verify/market.mjs`（不带
// `--offline`），CI 跑的却是 `node verify/market.mjs --offline`。于是同一台机器上
// `npm run verify` 会把「要联网 / 要本机那棵 dsh 安装树」的检查也跑一遍：本机红、
// CI 绿；而 `tools/facts.mjs` 数项数时用的又是 `offlineArgs`。同一件事三套口径，
// 其中两套是错的 —— 而两边「各自看都没问题」，所以谁也不会发现。
//
// 判据只能是「同一套件在两边拿到的参数是否相同」，不是「两边都提到了它」。
const pkg = JSON.parse(read('package.json'))
const npmChain = String((pkg.scripts && pkg.scripts.verify) || '')
  .split('&&').map((s) => s.trim()).filter(Boolean)
const localArgv = new Map()
for (const cmd of npmChain) {
  const m = /^node\s+(verify\/[\w.-]+\.mjs)((?:\s+--?[\w-]+)*)$/.exec(cmd)
  if (m) localArgv.set(m[1], (m[2] || '').trim())
}
// CI 一侧：只数真正会执行的命令行（跳过以 # 开头的注释行），参数按 **token** 逐个取，
// 一旦遇到 shell 的重定向/管道（`2>&1`、`|`）就停 —— 它后面的是 `tee` 和日志文件名，
// 不是套件参数。前两版分别在 `[^|&]*` 和「过滤 tee 这个词」上翻车，都报出了假不一致；
// 判据必须是「在 shell 语义里什么算参数」。
const ciArgv = new Map()
for (const line of runBlocks.split('\n')) {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#')) continue
  const tokens = trimmed.split(/\s+/)
  if (tokens[0] !== 'node' || !/^verify\/[\w.-]+\.mjs$/.test(tokens[1] || '')) continue
  const args = []
  for (const token of tokens.slice(2)) {
    if (/^(?:\d?>|\d?>&\d+|&|\||`)/.test(token)) break
    args.push(token)
  }
  if (!ciArgv.has(tokens[1])) ciArgv.set(tokens[1], args.join(' '))
}
const argvMismatch = [...ciArgv.entries()]
  .filter(([file, argv]) => localArgv.has(file) && localArgv.get(file) !== argv)
  .map(([file, argv]) => `${file}: npm run verify 用 "${localArgv.get(file) || '(无参数)'}"，CI 用 "${argv || '(无参数)'}"`)
check('npm run verify 与 CI 对同一套 verify 用同一组参数',
  argvMismatch.length === 0,
  argvMismatch.length
    ? argvMismatch.join('; ')
    : `已比对 ${[...ciArgv.keys()].filter((f) => localArgv.has(f)).length} 套（pack 需要真 dsh，故意不在 npm run verify 里）`)

// `package.json` 里的重复 key 是**静默的**：JSON.parse 只留最后一个，肉眼也看不出。
// 真事故：`verify:market` 写了两遍、值还不同，本机入口因此与 CI 不一致，而所有以
// JSON.parse 为依据的检查都看不见它。
{
  const raw = read('package.json')
  const scriptsBlock = (/"scripts"\s*:\s*\{([\s\S]*?)\n\s*\}/.exec(raw) || [])[1] || ''
  const keys = [...scriptsBlock.matchAll(/"([^"]+)"\s*:/g)].map((m) => m[1])
  const dupKeys = [...new Set(keys.filter((k) => keys.filter((x) => x === k).length > 1))]
  check('package.json 的 scripts 里没有重复的 key（后者会静默覆盖前者）',
    dupKeys.length === 0,
    dupKeys.length ? `重复：${dupKeys.join(', ')}` : `${keys.length} 个脚本`)
}

// 每个 `id:` 都要有对应的 outcome 进了 ci-report，否则报告里会少一套而没人发现。
const reported = [...workflow.matchAll(/([A-Z]+)_OUTCOME: \$\{\{ steps\.(\w+)\.outcome \}\}/g)]
  .map((m) => m[2])
const orphanIds = ids.filter((id) => !reported.includes(id) && id !== 'none')
  .filter((id) => workflow.includes(`id: ${id}`) && /Verify —/.test(
    // 找这个 id 所属的步骤名，只统计 Verify 步骤
    (workflow.split(/\n\s+- name: /).find((chunk) => chunk.includes(`id: ${id}`)) || '').split('\n')[0]))
check('CI 里每个 Verify 步骤的 outcome 都进了 Report and gate',
  orphanIds.length === 0,
  orphanIds.length ? `没进报告：${orphanIds.join(', ')}` : `${reported.length} 个 outcome`)

// ---------------------------------------------------------------- 汇总

// ---------------------------------------------------------------- 5. workflow 必须真的合法

// 这一条是被一次真实的 CI 失败逼出来的，而且失败的样子特别难懂：
// workflow 在 0 秒内失败、`jobs` 列表是空的、没有任何日志 —— 原因是 YAML 里
// 出现了**重复的 key**（`CLAIMS_OUTCOME` 与 `verify-claims.log` 各出现两次）。
// 两个人各自往同一个文件里加了同一个步骤，各自看都没问题。
//
// GitHub 对非法 workflow 只给一个很模糊的提示，所以这里自己检。检测方式：
// 在同一缩进层级上，同一个 key 只许出现一次；列表项（`- `）之间互不冲突。
{
  const problems = []
  const files = [
    '.github/workflows/verify.yml',
    '.github/workflows/pages.yml',
  ]
  for (const file of files) {
    let text
    try { text = read(file) } catch { continue }
    // 只看 `key:` 形式的行。用缩进 + 「是否还处在同一个列表项里」来划分作用域：
    // 一个 `- name:` 开头的行会开启一个新的作用域，同名 key 在这里是合法的。
    const scopes = new Map() // `${indent}|${scopeIndex}` -> Set(keys)
    let scope = 0
    text.split(/\r?\n/).forEach((line, i) => {
      const code = line.replace(/#.*$/, '')
      if (!code.trim()) return
      const indent = code.length - code.trimStart().length
      // 列表项开启新作用域（同一层级连续出现时作用域各算各的）。
      if (/^\s*-\s/.test(code)) scope++
      const m = /^\s*(?:-\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*:/.exec(code)
      if (!m) return
      const key = `${indent}|${scope}`
      if (!scopes.has(key)) scopes.set(key, new Map())
      const seen = scopes.get(key)
      if (seen.has(m[1])) {
        problems.push(`${file}:${i + 1} 「${m[1]}」与第 ${seen.get(m[1])} 行重复（同一作用域内）`)
      } else {
        seen.set(m[1], i + 1)
      }
    })
  }
  check('workflow 里没有同一作用域的重复 key（重复会让整个 workflow 0 秒失败）',
    problems.length === 0,
    problems.length ? problems.join('; ') : `${files.length} 个 workflow 已扫`)
}

// 每套 verify 在 CI 里的日志文件必须**唯一**：重复的 path 条目本身不致命，
// 但它和上面那条是同一个错误的两半（同一批人、同一时刻加的）。
{
  const dup = []
  for (const suite of SUITES) {
    const n = (workflow.match(new RegExp(`tee ${suite.file.replace(/^verify\//, 'verify-')}\\.log`, 'g')) || []).length
    if (n > 1) dup.push(`${suite.name}×${n}`)
  }
  check('每套 verify 在 CI 里只写一份日志', dup.length === 0, dup.join(', ') || `${SUITES.length} 套各一份`)
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length) console.log(`failed: ${failed.map((r) => r.label).join(' | ')}`)
process.exit(failed.length ? 1 : 0)
