#!/usr/bin/env node
/**
 * market — 复核 docs/MARKET.md 里那些数字还能不能复现。
 *
 * 为什么需要它：`docs/MARKET.md` 是本仓库唯一一份**引用外部世界**的文档。
 * 而它引用的东西（星数、下载量、别人的许可与商业模式）全都会随时间变 ——
 * 一份「上个月的星数」写在那里，读者不会知道它过期了。这个仓库对内部数字
 * 已经机械化（`tools/facts.mjs` 量、`verify/claims.mjs` 拦），对外部数字
 * 同样必须能复跑，否则它就成了本仓库最反对的那种东西：**抄来的数字**。
 *
 * ## 这套是 opt-in 的，因为需要网络
 *
 * CI **不跑它**。网络不可用、超时、被限流 —— 一律打印 SKIP 并 exit 0。
 * 「查不到」不等于「错了」，把前者报成失败会让人学会忽略这个套件。
 *
 * ## 容差是分开定的，因为漂移速度不同
 *
 *   · 星数：±5%。它每天都在动，而且我们无法控制采集那一刻的精确值。
 *   · npm 下载量：±15%。它按天聚合，跨月边界时会跳。
 *   · 许可 / 商业模式声明：**必须完全一致**。这两样变了是重大事件
 *     （例如 OpenClaw 忽然推出付费档），必须以 FAIL 的形式被人看见。
 *
 * 用法：
 *   node verify/market.mjs
 *   node verify/market.mjs --json
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DOC = path.join(REPO, 'docs', 'MARKET.md')

const results = []
const check = (label, ok, detail = '') => {
  results.push({ label, ok })
  if (!process.argv.includes('--json')) console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}
const skip = (label, detail = '') => {
  if (!process.argv.includes('--json')) console.log(`SKIP  ${label}${detail ? ` — ${detail}` : ''}`)
}

const doc = fs.existsSync(DOC) ? fs.readFileSync(DOC, 'utf8') : ''
if (!doc) {
  console.error(`找不到 ${path.relative(REPO, DOC)} —— 没有文档就没什么可核对的`)
  process.exit(1)
}

// ---------------------------------------------------------------- 取数

/** curl 一次，超时就当「网络不可用」。返回 null 表示取不到（而不是「值为空」）。 */
function fetchText (url, { timeout = 20 } = {}) {
  try {
    return execFileSync('curl', ['-sSL', '--max-time', String(timeout), url], {
      encoding: 'utf8', timeout: (timeout + 5) * 1000, maxBuffer: 16 * 1024 * 1024,
    })
  } catch {
    return null
  }
}

/** 只用仓库页的权威字段。不用 search API 的 total_count（本环境返回过不可靠值）。 */
function starCount (repo) {
  const html = fetchText(`https://github.com/${repo}`)
  if (html === null) return null
  const m = /"stargazerCount":(\d+)/.exec(html)
  return m ? Number(m[1]) : null
}

function npmMonthly (pkg) {
  const body = fetchText(`https://api.npmjs.org/downloads/point/last-month/${pkg}`)
  if (body === null) return null
  try {
    const j = JSON.parse(body)
    return typeof j.downloads === 'number' ? j.downloads : null
  } catch {
    return null
  }
}

/**
 * 从文档里读一个「项目 · 星数」的声称。
 *
 * 用**项目显示名**定位所在行，再从同一行里取加粗的数字 —— 这正是文档的排版约定
 * （星数一律写成 `**263,943**`）。这样这条断言读的是**文档真正写下的那个值**，
 * 而不是我在这里再抄一遍。
 *
 * 这里踩过一次坑：第一版用 repo 全名（`deepseek-ai/deepseek-harness`）去定位，
 * 而文档里写的是「DeepSeek Harness」—— 于是 7 个仓库全报「没写星数」。
 * **是断言错了，不是文档错了。** 表格引用的自然是项目名，不是仓库路径。
 */
function claimedStars (label) {
  // 找「提到这个项目、**并且**带一个加粗数字」的那一行。
  //
  // 不能只看「第一个提到它的行」：项目名总会在正文里被顺带提起（例如第 0 层的
  // 分类行里同时出现 dsh / OpenClaw / LangChain），那一行当然没有星数。
  // 断言要读的是**表格里那个声称**，所以判据是「这一行既提到它、又写了数字」。
  const line = doc.split(/\r?\n/).find((l) => l.includes(label) && /\*\*[\d,]+\*\*/.test(l))
  if (!line) return { found: false }
  const m = /\*\*([\d,]+)\*\*/.exec(line)
  return m ? { found: true, value: Number(m[1].replace(/,/g, '')) } : { found: false }
}

const within = (actual, claimed, pct) => claimed > 0 && Math.abs(actual - claimed) / claimed <= pct

// ---------------------------------------------------------------- 1. 星数

const REPOS = [
  // [仓库, 文档里用的显示名]
  ['deepseek-ai/deepseek-harness', 'DeepSeek Harness'],
  ['openclaw/openclaw', 'OpenClaw'],
  ['mem0ai/mem0', 'mem0'],
  ['letta-ai/letta', 'Letta (MemGPT)'],
  ['getzep/zep', 'Zep'],
  ['joonspk-research/generative_agents', 'generative_agents（斯坦福小镇）'],
  ['a16z-infra/ai-town', 'AI Town（a16z）'],
  ['moeru-ai/airi', 'Project AIRI'],
]

// `--offline`：只查文档自身的形态（那一半不需要网络，而且那才是 CI 最该守的）。
// 需要联网的断言在离线时一律 SKIP —— 见下面 netDown 的处理。
const OFFLINE = process.argv.includes('--offline') || process.env.MARKET_OFFLINE === '1'

let netDown = 0
const drifted = []
const missing = []
// 先探一次连通性。**这一步很重要**：CI 的 runner 到 github.com 的请求可能被
// 限流或拒绝，而「取不到」绝不能被读成「数字错了」—— 那是把环境的锅扣在文档头上。
// 探不通就整体走离线分支：只跑不需要网络的那几条。
const probeNet = () => !OFFLINE && fetchText('https://api.npmjs.org/downloads/point/last-month/mem0ai', { timeout: 8 }) !== null
const NET = probeNet()
if (!NET) skip('联网复核（星数 / npm 下载量 / 别人 README 原文）', OFFLINE ? '--offline' : '这台机器取不到外网')

for (const [repo, label] of REPOS) {
  if (!NET) break
  const actual = starCount(repo)
  if (actual === null) { netDown++; continue }
  const { found, value } = claimedStars(label)
  if (!found) { missing.push(`${label}（${repo}）`); continue }
  if (!within(actual, value, 0.05)) drifted.push(`${repo}: 文档 ${value} → 实测 ${actual}`)
}

if (!NET) {
  // 离线：什么都不报（上面已经 SKIP 一次，不重复刷屏）。
} else if (netDown === REPOS.length) {
  skip('星数复核', `网络不可用或被限流（${REPOS.length} 个仓库全部取不到）`)
} else if (netDown > 0) {
  skip(`星数复核（部分）`, `${netDown}/${REPOS.length} 个取不到，可能是限流`)
}
if (NET && netDown < REPOS.length) {
  check('docs/MARKET.md 里每个星数都还在 ±5% 以内',
    drifted.length === 0, drifted.length ? drifted.join(' | ') : `${REPOS.length - netDown} 个已核`)
  check('每个被引用的仓库在文档里都写了星数',
    missing.length === 0, missing.length ? `没写星数：${missing.join(', ')}` : `${REPOS.length} 个`)
}

// ---------------------------------------------------------------- 2. npm 下载量

const NPM = [
  ['@deepseek-ai/dsh', 1606851, 0.15],
  ['mem0ai', 627554, 0.15],
]
const npmBad = []
let npmDown = 0
for (const [pkg, claimed] of NPM) {
  if (!NET) break
  const actual = npmMonthly(pkg)
  if (actual === null) { npmDown++; continue }
  if (!within(actual, claimed, 0.15)) npmBad.push(`${pkg}: 文档 ${claimed} → 实测 ${actual}`)
}
if (!NET) { /* 离线：上面已 SKIP */ } else if (npmDown === NPM.length) skkipOrSkip()
else {
  check('docs/MARKET.md 里的 npm 月下载量还在 ±15% 以内', npmBad.length === 0, npmBad.join(' | ') || `${NPM.length} 个已核`)
}
function skkipOrSkip () { skip('npm 下载量复核', `网络不可用或被限流（${NPM.length} 个全部取不到）`) }

// ---------------------------------------------------------------- 3. 许可与商业模式（必须完全一致）

// 这两样变了是重大事件，所以容差是零。判据取自文档里同段落的原文陈述。
const CLAIMS = [
  { repo: 'deepseek-ai', what: 'dsh 是 MIT', ok: /DeepSeek Harness[\s\S]*?MIT/.test(doc) },
  { repo: 'openclaw', what: 'OpenClaw 是 MIT 且写明 no paid tier', ok: /no paid tier/.test(doc) && /OpenClaw[\s\S]*?MIT/.test(doc) },
]
for (const c of CLAIMS) {
  check(`文档里关于「${c.what}」的陈述仍原样在（这条是我们引用别人的商业模式，最不能漂）`, c.ok)
}

// 直接去别人的 README 复查那两句原文 —— 这是这套里唯一「读别人的字」的断言，
// 也正是它值钱的地方：OpenClaw 某天推付费档，这里第一个红。
{
  const readme = NET ? fetchText('https://raw.githubusercontent.com/openclaw/openclaw/main/README.md') : null
  if (readme === null) {
    skip('OpenClaw 的 no-paid-tier 原文复查', '取不到 README（网络或限流）')
  } else {
    check('OpenClaw 的 README 仍然写着没有付费档 / 没有托管 / 没有 token',
      /no paid tier/i.test(readme),
      /no paid tier/i.test(readme) ? '原文仍在' : '原文不见了 —— 若它推出了付费档，docs/MARKET.md 的整节结论要重写')
    check('OpenClaw 仍然由 501(c)(3) 基金会治理',
      /501\(c\)\(3\)/.test(readme), /501\(c\)\(3\)/.test(readme) ? '原文仍在' : '治理结构变了')
  }
}

// ---------------------------------------------------------------- 4. 我们自己那格不许吹（本地，不需要网络）

// MARKET.md 的能力矩阵里，我们唯一标「未实现」的是发布线的真实对接。
// 这一条必须留着 —— 一个把「未实现」写掉的版本，是这份文档最危险的退化方式。
check('能力矩阵里仍然写明「对外发布未接真实平台」',
  /未接真实平台|没发过|未实现/.test(doc),
  '这一格删掉就等于声称它已经能对外发了')
check('明确写了这份调研没有人读过 / 不是市场验证',
  /没有人读过|不是市场验证/.test(doc),
  '桌面研究与市场验证的区别必须写清')
check('三个证伪条件都在，且第三条的阈值被标成假设',
  (doc.match(/\|\s*[123]\s*\|/g) || []).length >= 3 && /阈值是假设|猜的/.test(doc),
  '没有数字的止损线等于没有止损线，但数字必须标明它是猜的')

// ---------------------------------------------------------------- 汇总

const failed = results.filter((r) => !r.ok)
if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ total: results.length, failed: failed.length, results }, null, 2))
} else {
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  if (failed.length) console.log(`failed: ${failed.map((r) => r.label).join(' | ')}`)
}
process.exit(failed.length ? 1 : 0)
