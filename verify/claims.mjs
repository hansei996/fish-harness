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

// ---------------------------------------------------------------- 汇总

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length) console.log(`failed: ${failed.map((r) => r.label).join(' | ')}`)
process.exit(failed.length ? 1 : 0)
