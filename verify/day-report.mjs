/**
 * day-report 的行为测试。
 *
 * 这个工具的职责是把机器账本翻译成人能读的「它的一天」
 * （docs/PRODUCT.md §9.2）。它不产生新事实，只做呈现 ——
 * 所以测试的重点是：该显示的显示、该省的省、缺数据不崩。
 *
 * 不需要真 dsh：只依赖 store.js 与本地文件。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TOOL = path.join(REPO, 'tools', 'day-report.mjs')
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'day-report-'))

const results = []
const check = (label, ok, detail = '') => {
  results.push({ label, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

function run (args) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [TOOL, ...args], { env: { ...process.env, DSH_HOME: HOME } })
    let out = '', err = ''
    c.stdout.on('data', (d) => { out += d })
    c.stderr.on('data', (d) => { err += d })
    c.on('close', (code) => resolve({ code, out, err }))
  })
}

// ---------- build a life with the real store ----------
// Windows: import() 不接受裸的 C:\... 路径，必须转成 file:// URL。
// 这是本仓库记过的坑（verify/README.md「Windows 上修过的四个坑」第 2 条），
// 漏掉它的后果是 CI 在 windows-latest 上红、本机（macOS）全绿 —— 正是这样发生的。
const { LifeStore } = await import(pathToFileURL(path.join(REPO, 'packages', 'dsh-life', 'lib', 'store.js')).href)
const store = new LifeStore({ home: HOME, lifeId: 'demo' })
store.ensure({ name: '大肥鱼', species: 'whale', seeds: ['懒'] })
store.recordInterest({ topic: '挖矿类小品', confidence: 0.8, source: 'experience' })
store.startActivity({ what: '练第 38 层', why: '昨天挂了两次' })
store.finishActivity({ outcome: 'failed', evidence: ['save:38'], note: '没补药水' })
const cmt = store.makeCommitment({ what: '写进技能经验', dueAt: '2026-10-28' })
store.settleCommitment({ id: cmt.id, status: 'done', evidence: 'note' })
store.startActivity({ what: '写段子草稿', why: '挂得有节奏' })
store.finishActivity({ outcome: 'done', evidence: ['draft:1'] })
for (let i = 0; i < 5; i++) store.appendLedger({ kind: 'turn', detail: { sessionId: 's', turn: i } })
const today = localDay(new Date().toISOString())
function localDay (iso) {
  const d = new Date(iso); const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

// ---------- 1. human output ----------
const human = await run(['--life', 'demo'])
check('runs and exits 0', human.code === 0, human.err.trim().slice(0, 80))
check('names the life and the day', human.out.includes('大肥鱼的一天') && human.out.includes(today))
check('translates activity start into a sentence with its reason',
  human.out.includes('开始：练第 38 层') && human.out.includes('昨天挂了两次'))
check('shows the failure with its evidence',
  human.out.includes('没做成') && human.out.includes('证据 save:38'))
check('shows the success distinctly', human.out.includes('做成了'))
check('translates interest with confidence and source',
  human.out.includes('挖矿类小品') && human.out.includes('0.8') && human.out.includes('经历'))
check('shows the promise being kept', human.out.includes('兑现'))
check('summarises the day rather than listing everything raw',
  human.out.includes('起了 2 件事') && human.out.includes('做成 1 件') && human.out.includes('没成 1 件'))
check('counts turns separately from activities',
  human.out.includes('对话往返 5 次'))
check('suggests what tomorrow holds', human.out.includes('明天大概会'))
check('does not leak raw event kinds into the human view',
  !/(activity-start|activity-end|commitment-settled)/.test(human.out))

// ---------- 2. json output ----------
const js = await run(['--life', 'demo', '--json'])
let parsed = null
try { parsed = JSON.parse(js.out) } catch {}
check('--json emits parseable JSON', parsed !== null && parsed.day === today)
check('--json carries structured events with tone',
  Array.isArray(parsed?.events) && parsed.events.length >= 6 &&
  parsed.events.some((e) => e.kind === 'activity-end' && e.tone === 'warn'))
check('--json keeps evidence as data, not prose',
  parsed?.events.some((e) => Array.isArray(e.evidence) && e.evidence.includes('save:38')))
check('--json reports the same stats as the human view',
  parsed?.stats?.activitiesStarted === 2 && parsed?.stats?.turns === 5)

// ---------- 3. degenerate inputs ----------
const empty = await run(['--life', 'demo', '--date', '2020-01-01'])
check('an empty day is explained, not shown as an error',
  empty.code === 0 && empty.out.includes('没有任何记录') && empty.out.includes('休息不等于故障'))

const all = await run(['--life', 'demo', '--all'])
check('--all lists days with entry counts',
  all.code === 0 && all.out.includes(today) && /\d+ 条/.test(all.out))

const missing = await run(['--life', 'does-not-exist'])
check('a missing life fails clearly with a hint',
  missing.code === 1 && missing.err.includes('找不到这条命') && missing.err.includes('--root'))

const badDate = await run(['--life', 'demo', '--date', 'nope'])
check('a malformed date is rejected', badDate.code === 1 && badDate.err.includes('YYYY-MM-DD'))

const help = await run(['--help'])
check('--help prints usage', help.code === 0 && help.out.includes('用法'))

// ---------- 4. corrupt ledger must not crash ----------
fs.appendFileSync(path.join(HOME, 'life', 'demo', 'ledger.jsonl'), '{"half":')
const afterCorrupt = await run(['--life', 'demo'])
check('a truncated ledger tail still renders the day',
  afterCorrupt.code === 0 && afterCorrupt.out.includes('大肥鱼的一天'))

// ---------- 5. the day-report tool must load anywhere ----------
// 这一条是被 CI 抓出来的：`**/*.mjs` 里的裸路径 `import('./C:/...')` 在
// Windows 上抛 ERR_UNSUPPORTED_ESM_URL_SCHEME，而 macOS 全绿 —— 于是「本机
// 通过」的套件在 CI 上把整个 job 弄红了（gate 读的是 continue-on-error 下的
// 真实 outcome）。修掉那处 import 容易，难的是别再犯，所以改成机器检查。
{
  const scanTargets = [
    path.join(REPO, 'tools'),
    path.join(REPO, 'verify'),
  ]
  const offenders = []
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, name.name)
      if (name.isDirectory()) walk(full)
      else if (name.name.endsWith('.mjs')) {
        // 看每一条 import(...)：参数必须是 pathToFileURL(...) 的形式，
        // 或是注释里提到的（本检查只认代码行）。
        fs.readFileSync(full, 'utf8').split(/\r?\n/).forEach((line, i) => {
          // 先去掉注释与字符串字面量：检查只针对真正的调用，避免把描述文字
          // （例如断言标题里的 "import()"）当成违规。
          const code = line
            .replace(/\/\/.*$/, '')
            .replace(/'(?:[^'\\]|\\.)*'/g, "''")
            .replace(/"(?:[^"\\]|\\.)*"/g, '""')
            .replace(/`(?:[^`\\]|\\.)*`/g, '``')
          if (!/\bimport\s*\(/.test(code)) return
          if (/import\s*\(\s*''/.test(code) || /import\s*\(\s*""/.test(code) || /import\s*\(\s*``/.test(code)) return
          if (/import\s*\(\s*pathToFileURL\s*\(/.test(code)) return // 正确写法
          offenders.push(`${path.relative(REPO, full)}:${i + 1}`)
        })
      }
    }
  }
  for (const t of scanTargets) if (fs.existsSync(t)) walk(t)
  check('every dynamic import in tools/ and verify/ goes through pathToFileURL (Windows)',
    offenders.length === 0,
    offenders.length ? `裸路径 import 在 ${offenders.join(', ')}` : `${scanTargets.length} 个目录已扫`)
}

fs.rmSync(HOME, { recursive: true, force: true })
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length) console.log(`failed: ${failed.map((r) => r.label).join(' | ')}`)
process.exit(failed.length ? 1 : 0)
