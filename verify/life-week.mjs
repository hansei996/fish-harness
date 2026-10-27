/**
 * life-week 的行为测试。
 *
 * 它保证的对象是「连跑七天」这件事本身：如果这个工具哪天跑出来一周全是同
 * 一件事、或者账本对不上、或者时间倒流，那么我们对外说的「它过了七天日
 * 子」就是假的 —— 而它是阶段 A 唯一拿得出手的证据（PRODUCT.md §6）。
 *
 * 所以测的不是「输出好不好看」，是：
 *   1. 结构：七天、每天都有记录、账本 kind 完整
 *   2. 诚实：每天要么有可解释的活动，要么是明确的休息
 *   3. 因果：失败留下了下一步；承诺被兑现
 *   4. 不重复：同一件事不会占掉一整天的每次唤醒
 *   5. 确定：同一个种子必须给出同一周（否则结论无法复核）
 *
 * 不需要真 dsh：只依赖 store/choose/wake 与本地文件。
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TOOL = path.join(REPO, 'tools', 'life-week.mjs')

const results = []
const check = (label, ok, detail = '') => {
  results.push({ label, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

function run (args) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [TOOL, ...args])
    let out = '', err = ''
    c.stdout.on('data', (d) => { out += d })
    c.stderr.on('data', (d) => { err += d })
    c.on('close', (code) => resolve({ code, out, err }))
  })
}

// ---------- 1. 默认跑一周 ----------
const week = await run(['--json'])
let report = null
try { report = JSON.parse(week.out) } catch {}
check('runs and emits parseable JSON', week.code === 0 && report !== null, week.err.trim().slice(0, 120))

const days = (report && report.days) || []
check('covers seven local calendar days', days.length === 7, `days=${days.length}`)

check('every day has either a real activity or an explicit rest — never a blank day',
  days.every((d) => d.stats.started > 0 || d.stats.rested > 0),
  days.map((d) => `${d.day}:${d.stats.started}/${d.stats.rested}`).join(' '))

check('never exceeds the daily wake budget of six',
  days.every((d) => d.stats.wakes <= 6),
  `max=${Math.max(...days.map((d) => d.stats.wakes))}`)

// 时间必须单调：活动耗时 35–85 分钟，第一版从「醒来时刻」而不是「做完时刻」
// 排下一次，日志里出现过 10:52 后面接 10:48。
let backwards = 0
for (const d of days) {
  const ts = d.events.map((e) => Date.parse(e.at))
  for (let i = 1; i < ts.length; i++) if (ts[i] < ts[i - 1]) backwards++
}
check('time never runs backwards inside a day', backwards === 0, `out-of-order=${backwards}`)

// ---------- 2. 账本与因果 ----------
const kinds = new Set(report ? report.ledgerKinds : [])
const requiredKinds = ['born', 'commitment', 'commitment-settled', 'interest', 'activity-start', 'activity-end']
const missingKinds = requiredKinds.filter((k) => !kinds.has(k))
check('the ledger records the whole week, not just a summary', missingKinds.length === 0,
  missingKinds.length ? `missing: ${missingKinds.join(', ')}` : `kinds=${[...kinds].join(', ')}`)

const allEvents = days.flatMap((d) => d.events)
const failedEvent = allEvents.find((e) => e.kind === 'failed')
const nextEvent = allEvents.find((e) => e.kind === 'next')
check('a failure happened, and it left a next step behind — the hand-off to tomorrow',
  Boolean(failedEvent) && Boolean(nextEvent),
  failedEvent ? `failed=${JSON.stringify(failedEvent.what)}; next=${JSON.stringify(nextEvent.text)}` : 'no failure in the week')

check('every finished activity carries evidence',
  allEvents.filter((e) => e.kind === 'done' || e.kind === 'failed')
    .every((e) => Array.isArray(e.evidence) && e.evidence.length > 0),
  `${allEvents.filter((e) => e.kind === 'done' || e.kind === 'failed').length} finishes checked`)

const settled = allEvents.filter((e) => e.kind === 'settled')
check('the promise made on day one was kept', settled.length > 0, `settled=${settled.length}`)

// ---------- 3. 不重复：这是「活人感」的底线 ----------
// 至少一天里，同一件事不能占满所有唤醒。第一版就是这样（一天 6 次同一件），
// 而它看起来还挺勤快 —— 所以必须有断言。
const worstDay = days
  .map((d) => {
    const counts = {}
    for (const e of d.events) if (e.kind === 'start') counts[e.what] = (counts[e.what] || 0) + 1
    const top = Math.max(0, ...Object.values(counts))
    return { day: d.day, top, wakes: d.stats.wakes }
  })
  .sort((a, b) => b.top - a.top)[0]
check('no single day is spent entirely on one repeated activity',
  !worstDay || worstDay.top <= 4,
  worstDay ? `worst=${worstDay.day} top=${worstDay.top}/${worstDay.wakes} wakes` : 'no activities')

// ---------- 4. 确定性 ----------
const again = await run(['--json'])
const report2 = (() => { try { return JSON.parse(again.out) } catch { return null } })()
const strip = (r) => r && JSON.stringify({ days: r.days.map((d) => ({ d: d.day, e: d.events.map((e) => [e.time, e.kind, e.text || e.what || '']) })) })
check('the same seed produces the same week — the claim can be re-checked',
  strip(report) !== null && strip(report) === strip(report2))

const other = await run(['--json', '--seed', '7'])
const report3 = (() => { try { return JSON.parse(other.out) } catch { return null } })()
check('a different seed produces a different week', strip(report3) !== null && strip(report3) !== strip(report))

// ---------- 5. 参数与帮助 ----------
const three = await run(['--json', '--days', '3'])
const report4 = (() => { try { return JSON.parse(three.out) } catch { return null } })()
check('--days is honoured', report4 !== null && report4.days.length === 3, `days=${report4 && report4.days.length}`)

const quiet = await run(['--quiet'])
check('--quiet prints a one-line summary', quiet.code === 0 && quiet.out.trim().split('\n').length === 1,
  JSON.stringify(quiet.out.trim()).slice(0, 90))

const help = await run(['--help'])
check('--help prints usage', help.code === 0 && help.out.includes('用法'))

const human = await run([])
check('the human view states what it does *not* prove',
  human.code === 0 && human.out.includes('没有') && human.out.includes('模型'),
  human.out.includes('没有') ? 'states its own limit' : 'missing the limit note')

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length) console.log(`failed: ${failed.map((r) => r.label).join(' | ')}`)
process.exit(failed.length ? 1 : 0)
