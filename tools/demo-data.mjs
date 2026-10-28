#!/usr/bin/env node
/**
 * demo-data — 把「它的一周」导出成一份可入库、可 diff、可复核的数据。
 *
 * 为什么需要它：对外页面（docs/index.html）与场景原型（docs/scenarios.html）
 * 都需要展示「它的一天/一周到底长什么样」。这些数字**不能手写** ——
 * PRODUCT.md §0.7 立的口径是「没有对应命令的行不许留在表里」。手写一次，
 * 第二次改实现就没人回来改数字，页面就开始撒谎。
 *
 * 所以这个脚本不自己算任何东西：它调 `tools/life-week.mjs` 跑七天，再对每天
 * 调一次 `tools/day-report.mjs --json`（也就是用户第二天真正会看到的那层渲染），
 * 两者都是生产工具。这个脚本只做两件事：**编排** 和 **去掉不稳定字段**。
 *
 * 去掉不稳定字段是为了让产物可 diff：`home` 是临时目录、记录 id 带随机段，
 * 它们每次都不同，留着会让「重新生成一次」变成两百行假 diff，真正该被看见的
 * 变化（兴趣涨了、多了条失败）反而被埋掉。
 *
 * 用法：
 *   node tools/demo-data.mjs                      # 写到 docs/assets/life-demo.json
 *   node tools/demo-data.mjs --out /tmp/x.json
 *   node tools/demo-data.mjs --days 7 --seed 20261027
 *   node tools/demo-data.mjs --check              # 只比对，不写（CI 用）
 *
 * --check 的语义：重新生成一遍，与已入库的那份逐字段比。不一致就退出码 1 并
 * 指出第一个不同点。它拦住的是「实现变了、页面上还是旧数字」。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const LIFE_WEEK = path.join(REPO, 'tools', 'life-week.mjs')
const DAY_REPORT = path.join(REPO, 'tools', 'day-report.mjs')
const LIFE_ID = 'week'
const DEFAULT_OUT = path.join(REPO, 'docs', 'assets', 'life-demo.json')

// 出生时刻固定：不固定的话「第 1 天」会跟着运行当天漂，产物就没法 diff。
const PINNED_BORN = '2026-10-20T08:00:00'

function parseArgs (argv) {
  const out = { out: DEFAULT_OUT, days: 7, seed: 20261027, check: false, quiet: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--out') out.out = argv[++i]
    else if (a === '--days') out.days = Number(argv[++i])
    else if (a === '--seed') out.seed = Number(argv[++i])
    else if (a === '--check') out.check = true
    else if (a === '--quiet') out.quiet = true
    else if (a === '--help' || a === '-h') out.help = true
  }
  return out
}

const USAGE = `demo-data — 把「它的一周」导出成可入库、可 diff 的数据

用法
  node tools/demo-data.mjs [选项]

选项
  --out <file>    写到哪（默认 docs/assets/life-demo.json）
  --days <n>      养几天（默认 7）
  --seed <n>      随机种子（默认 20261027）
  --check         只比对已入库的那份，不写；不一致则退出码 1
  --quiet         不打印摘要
  -h, --help      本帮助

产物由 tools/life-week.mjs 与 tools/day-report.mjs 的真实输出拼成，
本脚本不自己算任何数字。`

// ---------------------------------------------------------------- 编排

const runJson = (script, args, env = {}) => {
  const out = execFileSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    maxBuffer: 64 * 1024 * 1024,
  })
  return JSON.parse(out)
}

/**
 * 去掉每次运行都会变、且与「它过得怎么样」无关的字段。
 *
 * 只删两种：绝对路径（临时目录）与带随机段的记录 id。**不删时间、不删证据、
 * 不删结论** —— 那些正是页面要展示的东西，删了就变成粉饰。
 */
const VOLATILE_KEY = /(^|_)(id|home|dir|path)$/i
function stripVolatile (value) {
  if (Array.isArray(value)) return value.map(stripVolatile)
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      if (VOLATILE_KEY.test(k)) continue
      out[k] = stripVolatile(v)
    }
    return out
  }
  return value
}

function build (args) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-data-'))
  try {
    // 1) 真跑七天（生产工具，不是这个脚本自己模拟的）。
    const week = runJson(LIFE_WEEK, [
      '--home', home, '--days', String(args.days),
      '--seed', String(args.seed), '--born', PINNED_BORN, '--json',
    ])

    // 2) 对每一天调一次 day-report —— 也就是「用户第二天真正看到的那层」。
    //    日列表从账本里取，而不是从 week.days 推：两边来源不同，一旦不一致
    //    应该表现为「这里少一天」，而不是被这里悄悄对齐掉。
    const listed = runJson(DAY_REPORT, ['--life', LIFE_ID, '--all', '--json'], { DSH_HOME: home })
    const days = listed.days.map((day) =>
      runJson(DAY_REPORT, ['--life', LIFE_ID, '--date', day, '--json'], { DSH_HOME: home }))

    return stripVolatile({
      generatedBy: 'node tools/demo-data.mjs',
      // 这份产物是**压缩跑**出来的：不调用模型、不真的等待。
      // 页面必须带着这句话，否则就是把模拟当成生活展示。
      whatThisProves: [
        '七天里每天都有可解释的活动或明确的休息',
        '承诺被兑现，兴趣由经历累积而成（不是第一天写死的人设）',
        '账本可以逐条回放：每条结论后面都跟着证据',
      ],
      whatThisDoesNotProve: [
        '没有调用模型 —— 选活动的是排序器（lib/choose.js），不是模型',
        '没有真的等待 —— 七天是压缩跑的，不覆盖真实调度器的投递',
        '对外发布未实现 —— 页面里它「发了内容」的部分目前停在草稿',
      ],
      seed: args.seed,
      daysRequested: args.days,
      ledgerEntries: week.ledgerEntries,
      ledgerKinds: week.ledgerKinds,
      bornAt: week.bornAt,
      life: { name: week.snapshot.name, species: week.snapshot.species },
      interests: week.interests.map((i) => ({
        topic: i.topic,
        confidence: i.confidence,
        observations: i.observations,
        source: i.source,
      })),
      skills: week.skills.map((s) => ({ name: s.name, stage: s.stage })),
      commitments: week.commitments.map((c) => ({ what: c.what, status: c.status, dueAt: c.dueAt })),
      // day-report 的输出原样保留（含 tone 与 evidence 结构），页面直接渲染它。
      dayReports: days,
    })
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------- 比对

/** 逐字段找第一个不同点，而不是只说「不一致」。 */
function firstDifference (a, b, at = '') {
  if (a === b) return null
  const ta = a === null ? 'null' : Array.isArray(a) ? 'array' : typeof a
  const tb = b === null ? 'null' : Array.isArray(b) ? 'array' : typeof b
  if (ta !== tb) return `${at || '<root>'}: 类型不同（${ta} vs ${tb}）`
  if (ta === 'array') {
    if (a.length !== b.length) return `${at}: 长度不同（${a.length} vs ${b.length}）`
    for (let i = 0; i < a.length; i++) {
      const d = firstDifference(a[i], b[i], `${at}[${i}]`)
      if (d) return d
    }
    return null
  }
  if (ta === 'object') {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])]
    for (const k of keys) {
      if (!(k in a)) return `${at}.${k}: 已入库的产物里有、新产物里没有`
      if (!(k in b)) return `${at}.${k}: 新产物里有、已入库的产物里没有`
      const d = firstDifference(a[k], b[k], `${at}.${k}`)
      if (d) return d
    }
    return null
  }
  return `${at}: ${JSON.stringify(a)} → ${JSON.stringify(b)}`
}

// ---------------------------------------------------------------- main

const args = parseArgs(process.argv.slice(2))
if (args.help) { console.log(USAGE); process.exit(0) }

const data = build(args)
const text = JSON.stringify(data, null, 2) + '\n'

if (args.check) {
  if (!fs.existsSync(args.out)) {
    console.error(`FAIL  ${path.relative(REPO, args.out)} 不存在 —— 页面引用的数据没有入库`)
    process.exit(1)
  }
  const onDisk = fs.readFileSync(args.out, 'utf8')
  let parsed = null
  try { parsed = JSON.parse(onDisk) } catch (e) {
    console.error(`FAIL  ${path.relative(REPO, args.out)} 不是合法 JSON：${e.message}`)
    process.exit(1)
  }
  const diff = firstDifference(parsed, data)
  if (diff) {
    console.error(`FAIL  入库的数据与现在的实现不一致：${diff}`)
    console.error('      跑 `node tools/demo-data.mjs` 重新生成，并检查页面上的数字。')
    process.exit(1)
  }
  console.log(`PASS  ${path.relative(REPO, args.out)} 与实现一致（${data.ledgerEntries} 条账本 · ${data.dayReports.length} 天）`)
  process.exit(0)
}

fs.mkdirSync(path.dirname(args.out), { recursive: true })
fs.writeFileSync(args.out, text)

if (!args.quiet) {
  const rel = path.relative(REPO, args.out)
  console.log(`写入 ${rel}`)
  console.log(`  ${data.dayReports.length} 天 · 账本 ${data.ledgerEntries} 条 · kind ${data.ledgerKinds.join(', ')}`)
  for (const d of data.dayReports) {
    const s = d.stats
    console.log(`  ${d.day}  起了 ${s.activitiesStarted} · 成 ${s.activitiesDone} · 没成 ${s.activitiesFailed} · 自己醒 ${s.wakes} 次`)
  }
}
