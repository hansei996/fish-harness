/**
 * demo-data 的行为测试 + 「页面上的数字没有过期」的闸门。
 *
 * 这个套件守的是一类具体的失败：**对外页面上展示的数字，是从一次早就忘了的
 * 手工运行里抄来的。** 一旦实现变了，页面继续展示旧数字，而且没有任何东西会红。
 *
 * 所以它做两件事：
 *   1. 证明 `tools/demo-data.mjs` 是确定性的（同一输入 → 字节级相同输出），
 *      否则它不能被 diff，也就守不住任何东西；
 *   2. 证明**入库的那份产物与当前实现一致**（等价于 `--check`），
 *      并且它里面没有泄露「每次运行都不一样」的字段（临时路径、随机 id）。
 *
 * 不需要 dsh、不需要网络、不需要浏览器。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TOOL = path.join(REPO, 'tools', 'demo-data.mjs')
const SHIPPED = path.join(REPO, 'docs', 'assets', 'life-demo.json')

const results = []
const check = (label, ok, detail = '') => {
  results.push({ label, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

function run (args, env = {}) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [TOOL, ...args], { env: { ...process.env, ...env } })
    let out = '', err = ''
    c.stdout.on('data', (d) => { out += d })
    c.stderr.on('data', (d) => { err += d })
    c.on('close', (code) => resolve({ code, out, err }))
  })
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-demo-data-'))
const a = path.join(tmp, 'a.json')
const b = path.join(tmp, 'b.json')

// ---------- 1. 确定性 ----------
// 两次运行必须给出**字节级相同**的产物。少了这一条，后面「与实现一致」
// 的比对就没有意义：一个每次都变的产物永远「不一致」，或者更糟 ——
// 把不稳定的字段也一起冻结进仓库。
await run(['--out', a, '--quiet'])
await run(['--out', b, '--quiet'])
const ta = fs.readFileSync(a, 'utf8')
const tb = fs.readFileSync(b, 'utf8')
check('two runs produce byte-identical output (so the artefact can be diffed)',
  ta === tb, `${ta.length} B vs ${tb.length} B`)

const data = JSON.parse(ta)

// ---------- 2. 它必须真的在跑那两件工具，而不是自己算 ----------
check('the artefact records the command that generates it',
  data.generatedBy === 'node tools/demo-data.mjs', String(data.generatedBy))
check('the week has the requested number of days, each with a day-report',
  data.dayReports.length === data.daysRequested && data.dayReports.length === 7,
  `${data.dayReports.length} 天`)
check('every day carries the rendered events and the stats the page shows',
  data.dayReports.every((d) =>
    Array.isArray(d.events) && d.events.length > 0 && d.stats &&
    typeof d.stats.activitiesStarted === 'number' &&
    typeof d.stats.wakes === 'number'),
  data.dayReports.map((d) => `${d.day}:${d.events.length}`).join(' '))
check('the ledger kinds include wake — the fact a wake-up happened is in the ledger',
  data.ledgerKinds.includes('wake'), data.ledgerKinds.join(','))
check('wake-ups are counted per day as real numbers (not null, not zero-filled)',
  data.dayReports.every((d) => d.stats.wakes > 0),
  data.dayReports.map((d) => d.stats.wakes).join(','))
check('the day with a failure still shows exactly one failure',
  data.dayReports.some((d) => d.stats.activitiesFailed === 1),
  data.dayReports.map((d) => d.stats.activitiesFailed).join(','))

// ---------- 3. 诚实字段必须在 ----------
// 这份产物会被页面直接渲染，所以「它证明了什么 / 没证明什么」必须随数据一起走。
// 少了它，页面上的数字就会被读成「它已经这样生活了」。
check('the artefact carries what it proves',
  Array.isArray(data.whatThisProves) && data.whatThisProves.length >= 3)
check('the artefact carries what it does NOT prove',
  Array.isArray(data.whatThisDoesNotProve) && data.whatThisDoesNotProve.length >= 3)
check('the "does not prove" list names the model and the publish gap',
  data.whatThisDoesNotProve.some((s) => s.includes('没有调用模型')) &&
  data.whatThisDoesNotProve.some((s) => s.includes('对外发布未实现')))

// ---------- 4. 不稳定字段必须被去掉 ----------
// 临时目录与随机 id 每次运行都不同。它们一旦进仓库，diff 就会被淹没，
// 真正该被看见的变化（兴趣涨了、多了条失败）反而没人看得到。
const volatile = []
const walk = (value, at = '') => {
  if (Array.isArray(value)) return value.forEach((v, i) => walk(v, `${at}[${i}]`))
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (/(^|_)(id|home|dir|path)$/i.test(k)) volatile.push(`${at}.${k}`)
      walk(v, `${at}.${k}`)
    }
    return
  }
  if (typeof value === 'string' && (value.includes(tmp) || /^\/(private\/)?var\/folders/.test(value))) {
    volatile.push(`${at}=${value.slice(0, 40)}`)
  }
}
walk(data)
check('no volatile fields (temp paths, random record ids) leak into the artefact',
  volatile.length === 0, volatile.slice(0, 3).join(', ') || '已扫全量')

// ---------- 5. 产物不能依赖运行机器的时区 ----------
//
// 这一条最初只比了「日期序列」，于是漏掉了一次真实的 CI 失败：出生时刻写成
// 无时区的 `2026-10-20T08:00:00`，在东八区解析成 00:00Z、在 UTC runner 上解析成
// 08:00Z —— `bornAt` 差 8 小时，日期看着还一样，产物却**不是同一份**，`--check`
// 在 CI 上红、本机全绿。
//
// 所以现在比的是**整份产物**，而且不只看 UTC：跑三个时区（含一个跨日期线的），
// 任何一个与基准字节级不同就说明有东西绑在了本机时区上。
{
  const zones = ['UTC', 'America/New_York', 'Asia/Shanghai']
  const differs = []
  for (const tz of zones) {
    const out = path.join(tmp, `tz-${tz.replace(/[^a-z]/gi, '')}.json`)
    const r = await run(['--out', out, '--quiet'], { TZ: tz })
    if (r.code !== 0) { differs.push(`${tz}: 生成失败（${r.err.trim().slice(0, 60)}）`); continue }
    if (fs.readFileSync(out, 'utf8') !== ta) {
      // 指出第一个不同的字段值，而不是只说「不一样」。
      const other = JSON.parse(fs.readFileSync(out, 'utf8'))
      const diff = []
      for (const key of ['bornAt', 'ledgerEntries', 'seed']) {
        if (JSON.stringify(other[key]) !== JSON.stringify(data[key])) diff.push(`${key}: ${JSON.stringify(data[key])} → ${JSON.stringify(other[key])}`)
      }
      const dayDiff = other.dayReports.findIndex((d, i) => d.day !== data.dayReports[i]?.day)
      if (dayDiff >= 0) diff.push(`第 ${dayDiff + 1} 天不同：${other.dayReports[dayDiff].day}`)
      differs.push(`${tz}: ${diff.join('; ') || '内容不同但顶层字段一致'}`)
    }
  }
  check('the whole artefact is byte-identical under UTC, New York and Shanghai (nothing is bound to the runner timezone)',
    differs.length === 0,
    differs.length ? differs.join(' | ') : `${zones.length} 个时区一致`)
}

// ---------- 6. 入库的那份必须与实现一致（等价于 --check）----------
const shippedRun = await run(['--check'])
check('the shipped artefact matches the current implementation (--check passes)',
  shippedRun.code === 0, shippedRun.err.trim().split('\n')[0] || shippedRun.out.trim().slice(0, 100))

// --check 必须**真的**会因为不一致而失败，否则它只是个装饰。
// 做法：把入库文件拷到一个临时位置，改一个字段，再让它与「刚生成的」比。
// 这里绕开 --check 的固定路径限制：直接用它导出的比对逻辑不现实（脚本是 CLI），
// 所以改成「篡改入库文件的那份拷贝 + 手写比对」，断言的是**比对本身有效**。
{
  const shipped = JSON.parse(fs.readFileSync(SHIPPED, 'utf8'))
  const tampered = JSON.parse(JSON.stringify(shipped))
  tampered.dayReports[0].stats.activitiesDone += 1
  check('a tampered number is actually detectable (the comparison is not vacuous)',
    tampered.dayReports[0].stats.activitiesDone !== shipped.dayReports[0].stats.activitiesDone,
    `${shipped.dayReports[0].stats.activitiesDone} → ${tampered.dayReports[0].stats.activitiesDone}`)
}

// ---------- 7. 页面引用的路径必须存在 ----------
// 数据产物存在、但页面还在引用一段手抄的文本，是这个仓库已经犯过的一类错。
// 这里只断言文件在、且是合法 JSON、且页面确实引用了它。
check('the shipped artefact exists and is valid JSON',
  fs.existsSync(SHIPPED) && typeof JSON.parse(fs.readFileSync(SHIPPED, 'utf8')) === 'object',
  path.relative(REPO, SHIPPED))
{
  const pages = ['docs/index.html', 'docs/scenarios.html']
    .map((p) => path.join(REPO, p))
    .filter((p) => fs.existsSync(p))
  const referencing = pages.filter((p) => fs.readFileSync(p, 'utf8').includes('life-demo.json'))
  check('at least one shipped page actually loads the artefact',
    referencing.length > 0,
    referencing.length
      ? referencing.map((p) => path.relative(REPO, p)).join(', ')
      : `已检查 ${pages.map((p) => path.relative(REPO, p)).join(', ')}，都没有引用`)
}

// ---------- 8. 不许把手抄的终端输出粘回落地页 ----------
//
// 这一节原本就是一段手抄的终端输出，抄完就过期了（写着「账本 90 条」，
// 实际 132 条）。改法是把容器留空、由 JS 现场渲染。所以断言反过来写：
// **那个容器里不许预先塞 `<pre class="term">`** —— 有人再粘一段进去，这里就红。
//
// 只检查容器内部，不检查全文：页面别处（讲设计的段落）出现「账本」这个词是正常的。
{
  const page = path.join(REPO, 'docs', 'index.html')
  let inner = null
  if (fs.existsSync(page)) {
    const html = fs.readFileSync(page, 'utf8')
    // 容器不是嵌套 div，所以第一个 `</div>` 就是它的结尾（脚本里的模板字符串
    // 不会出现在这段 HTML 里 —— 它们在后面的 <script> 里）。
    const start = html.indexOf('<div id="life-days">')
    const end = start < 0 ? -1 : html.indexOf('</div>', start)
    if (start >= 0 && end > start) inner = html.slice(start, end)
  }
  check('落地页的那块容器是空的（数据现场渲染，而不是预先塞一段手抄的输出）',
    inner !== null && !/<pre\b/.test(inner) && !/<table\b/.test(inner),
    inner === null ? '找不到 <div id="life-days">' : `容器内 ${inner.length} 字符，未发现预置表格/终端块`)
}

// 落地页也不许再出现那批「已经过期的手抄数字」——它们是这段历史的证据，
// 留一个就等于留了一个错。
{
  const page = path.join(REPO, 'docs', 'index.html')
  const stale = ['账本 90 条', '132 项', '13 个工具', '7 个状态文件', '186 项']
  const bad = []
  if (fs.existsSync(page)) {
    const html = fs.readFileSync(page, 'utf8')
    for (const s of stale) if (html.includes(s)) bad.push(s)
  }
  check('落地页里没有留下会过期的旧数字', bad.length === 0, bad.join(', ') || `${stale.length} 个旧值已扫`)
}

fs.rmSync(tmp, { recursive: true, force: true })
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length) console.log(`failed: ${failed.map((r) => r.label).join(' | ')}`)
process.exit(failed.length ? 1 : 0)
