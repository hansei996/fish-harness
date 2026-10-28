/**
 * scenarios — 守住 `docs/SCENARIOS.md` 那份落地剧本的「可被证伪」。
 *
 * 这份文档的用途是把「它过日子」翻译成逐时刻的动作。它有两种典型的退化方式，
 * 而且两种都不会自己报错：
 *
 *   1. **引用了不存在的东西。** 工具名、状态文件名、`§X.Y` 章节号、被引用的文件 ——
 *      写错一个，读者会照着想，然后卡在一个根本不存在的能力上。这个仓库因为
 *      重排编号改坏过三次引用（`AGENTS.md` §2.5），所以这一条要机器守。
 *   2. **丢掉「未实现」的标记。** 这份剧本最危险的样子是它读起来像「它已经在
 *      这样生活」—— 而那正是本仓库反复在防的错。所以「发布未接真实平台」、
 *      「能力包未做」这两句必须一直在。
 *
 * 它**不检查**的东西：剧本里的时刻、对话、分数是否「合理」—— 那些是设想，
 * 设想不需要断言，只需要**标出来**（文档里用 `[实]` / `[缺]`）。
 *
 * 不需要 dsh、不需要网络。约 1s。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8')

const results = []
const check = (label, ok, detail = '') => {
  results.push({ label, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

const DOC = 'docs/SCENARIOS.md'
if (!fs.existsSync(path.join(REPO, DOC))) {
  console.error(`找不到 ${DOC}`)
  process.exit(1)
}
const doc = read(DOC)
const plugin = read('packages/dsh-life/lib/index.js')
const store = read('packages/dsh-life/lib/store.js')

// ---------- 1. 工具名 / 状态文件名必须真实存在 -------------------------------
// 判据是「文档里出现的 life_* 名字，在代码里都能找到」—— 不是「代码里的名字都
// 被文档提到」（那会要求文档列全表，而它会随代码变、又变成一处会漂的抄写）。

const mentioned = [...new Set([...doc.matchAll(/\b(life_[a-z_]+)\b/g)].map((m) => m[1]))].sort()
const realTools = new Set([...plugin.matchAll(/name: '(life_[a-z_]+)'/g)].map((m) => m[1]))
const ghostTools = mentioned.filter((t) => !realTools.has(t))
check('每个被提到的 life_* 工具在代码里真实存在',
  ghostTools.length === 0,
  ghostTools.length ? `不存在的工具：${ghostTools.join(', ')}` : `${mentioned.length} 个工具已核`)

const stateFiles = [...new Set([...doc.matchAll(/\b([a-z-]+\.jsonl?)\b/g)].map((m) => m[1]))].sort()
const realState = [...store.matchAll(/path\.join\(this\.dir, '([^']+)'\)/g)].map((m) => m[1])
const ghostState = stateFiles.filter((f) => !realState.includes(f))
check('每个被提到的状态文件真实存在',
  ghostState.length === 0,
  ghostState.length ? `不存在的状态文件：${ghostState.join(', ')}` : `${stateFiles.length} 个状态文件已核`)

// 账本 kind 同样核一遍：剧本里引用了 `kind: 'publish'` 一类，写错就误导。
const kinds = [...new Set([...doc.matchAll(/kind: '([a-z-]+)'/g)].map((m) => m[1]))]
const realKinds = new Set()
for (const file of fs.readdirSync(path.join(REPO, 'packages/dsh-life/lib'))) {
  if (!file.endsWith('.js')) continue
  const text = read(`packages/dsh-life/lib/${file}`)
  for (const m of text.matchAll(/appendLedger\s*\([\s\S]{0,300}?kind:\s*'([a-z-]+)'/g)) realKinds.add(m[1])
}
const ghostKinds = kinds.filter((k) => !realKinds.has(k))
check('每个被提到的账本 kind 真实存在',
  ghostKinds.length === 0,
  ghostKinds.length ? `不存在的 kind：${ghostKinds.join(', ')}` : `${kinds.length} 种 kind 已核`)

// ---------- 2. §X.Y 引用必须解析得到 ----------------------------------------
// 这是这个仓库改坏过三次的那类引用（AGENTS.md §2.5）。

const planHeadings = new Set([...read('docs/PLAN.md').matchAll(/^#{2,3} (\d+(?:\.\d+)*)/gm)].map((m) => m[1]))
const refs = [...new Set([...doc.matchAll(/`?§(\d+(?:\.\d+)*)/g)].map((m) => m[1]))]
const badRefs = refs.filter((r) => !planHeadings.has(r))
check('每个 §X.Y 引用在 PLAN.md 里都有对应标题',
  badRefs.length === 0,
  badRefs.length ? `解析不到的引用：${badRefs.map((r) => `§${r}`).join(', ')}` : `${refs.length} 个引用已核`)

// ---------- 3. 被引用的文件必须存在 ------------------------------------------
// 文档里用的是**简名**（`lib/store.js`），与仓库其他地方一致；所以要按后缀匹配，
// 而不是当成仓库根下的路径。

const cited = [...new Set([...doc.matchAll(/`([a-zA-Z0-9_/.-]+\.(?:js|mjs|mp4|html|json))`/g)].map((m) => m[1]))]
const all = []
const walk = (dir) => {
  for (const e of fs.readdirSync(path.join(REPO, dir), { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue
    const rel = `${dir}/${e.name}`
    if (e.isDirectory()) walk(rel)
    else all.push(rel)
  }
}
for (const top of ['packages', 'tools', 'verify', 'docs', 'showcase', 'design']) {
  if (fs.existsSync(path.join(REPO, top))) walk(top)
}
// 状态文件（identity.json / outbox.json / …）是**运行期产物**，不在仓库里 ——
// 它们属于「运行期会出现哪些名字」，已经由上面那条状态文件名断言核过了。
// 这一条只管**仓库里应该存在的**源码/文档/媒体文件。
const RUNTIME = new Set(realState)
const missingFiles = cited
  .filter((c) => !RUNTIME.has(c))
  .filter((c) => !all.some((p) => p === c || p.endsWith(`/${c}`)))
check('每个被引用的文件都能在仓库里找到',
  missingFiles.length === 0,
  missingFiles.length ? `找不到：${missingFiles.join(', ')}` : `${cited.length} 个引用已核`)

// ---------- 4.「未实现」的话必须一直在 --------------------------------------
// 这一节存在的理由：这份剧本最危险的退化，是它被改得读起来像「已经这样生活」。

check('仍然写明「对外发布没接真实平台」',
  /一次真实 Telegram 都没发过|没接过真实平台|未接真实平台/.test(doc)
  && /对外发布到真实平台[\s\S]{0,40}未实现/.test(doc),
  '删掉这句，剧本就变成了能力声称')

check('仍然写明「能力包未实现」',
  /能力包[\s\S]{0,60}未实现|未实现[\s\S]{0,40}能力包/.test(doc),
  '三个场景里「真的去跑 / 真的去玩」的动作都指它')

check('每一节都有「怎么核对」的判据',
  (doc.match(/### \d\.\d+ 怎么核对/g) || []).length >= 3,
  `${(doc.match(/怎么核对/g) || []).length} 处`)

check('每个「价值论证」都写了「换成更好的工具会怎样」',
  (doc.match(/为什么还是不行/g) || []).length >= 3,
  `${(doc.match(/为什么还是不行/g) || []).length} 处`)

check('没有一个场景被写成「已经在这样跑」',
  /这份文档里没有一处是/.test(doc) && /可被证伪的设想/.test(doc),
  '头尾各有一处声明才算完整')

// ---------- 5. 与 STORY.md 的口径一致 ---------------------------------------
// 两份文档讲同一件事，如果对「发布是否实现」给出不同答案，读者会信哪一份？

const story = read('docs/STORY.md')
const storySaysUnpublished = /对外发布到社交平台[\s\S]{0,80}未实现|发布线打通之前/.test(story)
check('SCENARIOS.md 与 STORY.md 对「发布未实现」的口径一致',
  storySaysUnpublished,
  storySaysUnpublished ? '两份都写明' : 'STORY.md 里那句话被删了/改了 —— 两份文档开始各说各话')

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length) console.log(`failed: ${failed.map((r) => r.label).join(' | ')}`)
process.exit(failed.length ? 1 : 0)
