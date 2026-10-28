#!/usr/bin/env node
/**
 * day-report — 把机器账本渲染成「它的一天」。
 *
 * 为什么需要它：`ledger.jsonl` 是给机器看的（kind + detail + ISO 时间），
 * 只有开发者读得懂。而「用户第二天回来看到什么」是这个产品的核心体验
 * （docs/PRODUCT.md §4），所以必须有一层把事实翻译成人话的东西。
 *
 * 它不是新功能，是既有数据的对外呈现（docs/PRODUCT.md §9.2）。
 *
 * 用法：
 *   node tools/day-report.mjs                     # 今天
 *   node tools/day-report.mjs --date 2026-10-27   # 指定日期
 *   node tools/day-report.mjs --life default      # 指定生命
 *   node tools/day-report.mjs --json              # 供程序消费
 *
 * 读数来源：$DSH_HOME/life/<lifeId>/{ledger.jsonl,identity.json,activity.json,
 * traits.json,commitments.json,wake.json}
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ---------------------------------------------------------------- 参数

function parseArgs (argv) {
  const out = { date: null, life: 'default', json: false, all: false, root: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--date') out.date = argv[++i]
    else if (a === '--life') out.life = argv[++i]
    else if (a === '--json') out.json = true
    else if (a === '--all') out.all = true
    else if (a === '--root') out.root = argv[++i]
    else if (a === '--help' || a === '-h') out.help = true
  }
  return out
}

const USAGE = `day-report — 把机器账本渲染成「它的一天」

用法
  node tools/day-report.mjs [选项]

选项
  --date <YYYY-MM-DD>   指定日期（默认本地今天）
  --life <lifeId>       生命实例（默认 default）
  --all                 列出全部有记录的日期
  --json                输出 JSON（供程序消费）
  --root <dir>          覆盖 $DSH_HOME
  -h, --help            显示本帮助

账本在 $DSH_HOME/life/<lifeId>/ledger.jsonl。`

// ---------------------------------------------------------------- 读取

const dshHome = (args) =>
  args.root || process.env.DSH_HOME || path.join(os.homedir(), '.dsh')

function lifeDir (args) {
  return path.join(dshHome(args), 'life', args.life)
}

function readJson (file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'))
    return v && typeof v === 'object' ? v : null
  } catch { return null }
}

function readLedger (file) {
  let text = ''
  try { text = fs.readFileSync(file, 'utf8') } catch { return [] }
  const rows = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      const v = JSON.parse(t)
      if (v && typeof v === 'object') rows.push(v)
    } catch {
      // A half-written tail line is expected after a hard kill; skip it rather
      // than losing the whole day (the store does the same when reading).
    }
  }
  return rows
}

// ---------------------------------------------------------------- 时间

/** 本地日历日，YYYY-MM-DD。 */
function localDay (iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function localTime (iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '--:--'
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

function todayLocal () { return localDay(new Date().toISOString()) }

// ---------------------------------------------------------------- 翻译层
//
// 这是本工具的核心：把 kind + detail 变成一句人话，并标注它意味着什么。
// 每一条都带 kind 供程序消费，带 text 供人阅读。

function describe (row) {
  const k = row.kind
  const d = row.detail && typeof row.detail === 'object' ? row.detail : {}

  switch (k) {
    case 'born':
      return { kind: 'born', tone: 'start', text: `${d.name || '它'}出生了` }

    case 'identity-change':
      return {
        kind: 'identity-change', tone: 'slow',
        text: `身份更新到 v${d.revision}（慢变量，需要主人确认）`,
      }

    case 'interest': {
      const conf = typeof d.confidence === 'number' ? `${d.confidence.toFixed(1)}` : null
      const from = d.source ? `来自${zhSource(d.source)}` : ''
      return {
        kind: 'interest', tone: 'medium',
        text: `对「${d.topic}」的兴趣${conf ? ` = ${conf}` : ''}${from ? `（${from}）` : ''}`,
      }
    }

    case 'skill':
      return {
        kind: 'skill', tone: 'medium',
        text: `技能「${d.name}」进入 ${zhStage(d.stage)}`,
      }

    case 'encounter':
      return {
        kind: 'encounter', tone: 'relation',
        text: `遇到 ${d.name}${d.kind ? `（${zhRelation(d.kind)}）` : ''}`,
      }

    case 'commitment':
      return {
        kind: 'commitment', tone: 'promise',
        text: `答应了一件事：${d.what}${d.dueAt ? `（${d.dueAt} 前）` : ''}`,
      }

    case 'commitment-settled':
      return {
        kind: 'commitment-settled', tone: d.status === 'done' ? 'good' : 'warn',
        text: d.status === 'done' ? '兑现了一件事' : '放下一件事',
      }

    case 'activity-start':
      return {
        kind: 'activity-start', tone: 'doing',
        text: `开始：${d.what}${d.why ? `（因为 ${d.why}）` : ''}`,
      }

    case 'activity-end': {
      const ev = Array.isArray(d.evidence) && d.evidence.length
        ? d.evidence.filter((x) => typeof x === 'string' && x && x !== 'undefined')
        : []
      const outcome = d.outcome === 'done' ? '做成了'
        : d.outcome === 'failed' ? '没做成'
        : d.outcome === 'abandoned' ? '放弃了'
        : '结束了'
      const why = d.note ? `：${d.note}` : ''
      const proof = ev.length ? `｜证据 ${ev.join('、')}` : ''
      // 失败留下的「下一步」也要显示出来：那是第二天能接上的原因
      // （docs/PRODUCT.md §4.2），而这个产品最被引用的一句话就是它。
      // 只显示「没做成」而不显示「它给自己留了什么」，等于把因果链砍掉一半。
      const handoff = d.next && typeof d.next === 'object' && d.next.what
        ? `｜留下：${d.next.what}`
        : ''
      return {
        kind: 'activity-end', tone: d.outcome === 'done' ? 'good' : 'warn',
        text: `${outcome}${why}${proof}${handoff}`,
        evidence: ev,
        next: d.next && typeof d.next === 'object' ? { what: d.next.what, why: d.next.why || '' } : null,
      }
    }

    case 'turn':
      return { kind: 'turn', tone: 'noise', text: null } // 不展示，只计数

    // 唤醒也进账本（lib/index.js 在 schedule 投递时写 kind:'wake'）。
    // 它不进时间线：一天醒六次会把真正发生的事情淹掉；它只进底部的计数。
    case 'wake':
      return { kind: 'wake', tone: 'noise', text: null }

    default:
      return { kind: k || 'unknown', tone: 'noise', text: null }
  }
}

function zhSource (s) {
  return ({ experience: '经历', browsing: '浏览', keeper: '主人', agent: '自己' })[s] || s
}
function zhStage (s) {
  return ({ learning: '学习中', practicing: '练习中', competent: '熟练' })[s] || s
}
function zhRelation (s) {
  return ({ keeper: '主人', friend: '朋友', public: '公开' })[s] || s
}

// ---------------------------------------------------------------- 组装

function buildDay (args, day) {
  const dir = lifeDir(args)
  const identity = readJson(path.join(dir, 'identity.json'))
  const activity = readJson(path.join(dir, 'activity.json'))
  const traits = readJson(path.join(dir, 'traits.json'))
  const commitments = readJson(path.join(dir, 'commitments.json'))
  const wake = readJson(path.join(dir, 'wake.json'))
  const ledger = readLedger(path.join(dir, 'ledger.jsonl'))

  const rows = ledger.filter((r) => localDay(r.at) === day)
  const events = []
  let turns = 0
  for (const r of rows) {
    const d = describe(r)
    if (d.kind === 'turn') { turns++; continue }
    if (!d.text) continue
    events.push({ at: r.at, time: localTime(r.at), ...d })
  }

  const started = events.filter((e) => e.kind === 'activity-start').length
  const finished = events.filter((e) => e.kind === 'activity-end')
  const doneN = finished.filter((e) => e.tone === 'good').length
  const failedN = finished.filter((e) => e.tone === 'warn').length

  const openCommitments = ((commitments && commitments.items) || [])
    .filter((c) => c.status === 'open')

  // 「明天想做什么」——按优先级取第一个能解释的来源，而不是编一句话。
  //
  // 失败留下的下一步排在最前（仅次于「现在正在做」）：它是它自己写下的、
  // 最具体的一句，比「承诺」和「兴趣最高的方向」都更接近「明天会做什么」。
  // 这一段原本没有读 `activity.next`，于是日志里最该被看见的那条因果链
  // （今天没成 → 明天接着做）在页面上反而不出现。
  let tomorrow = null
  if (activity && activity.current) {
    tomorrow = `还在进行：${activity.current.what}`
  } else if (activity && activity.next && activity.next.what) {
    tomorrow = `记着要做：${activity.next.what}`
  } else if (openCommitments.length) {
    tomorrow = `答应过还没做：${openCommitments[0].what}`
  } else if (traits && Array.isArray(traits.interests) && traits.interests.length) {
    const top = [...traits.interests].sort((a, b) => (b.confidence || 0) - (a.confidence || 0))[0]
    tomorrow = `最可能接着做：${top.topic}`
  }

  // 唤醒次数从**账本**数，不从 wake.json 数。
  //
  // 这里原本读的是 `wake.deliveries` —— 一个不存在的字段（wake.json 里存的是
  // `lastMessageIds`，一串消息 id，没有时间戳，跨天还会被截到最近 20 条）。
  // 后果是 wakes 恒为 null，而 null 被下面的渲染跳过，于是「自己醒来 N 次」
  // 这一行**永远不会显示**，也没有任何东西报错。是 verify/day-report.mjs 的
  // 断言把它逼出来的。
  //
  // 账本才是唯一可回放的记录（kind:'wake' 带 messageId），所以数它。
  const awake = rows.filter((r) => r.kind === 'wake').length

  return {
    day,
    life: { id: args.life, name: identity ? identity.name : null, bornAt: identity ? identity.bornAt : null, revision: identity ? identity.revision : null },
    events,
    stats: { turns, activitiesStarted: started, activitiesDone: doneN, activitiesFailed: failedN, wakes: awake },
    openCommitments: openCommitments.length,
    currentActivity: activity && activity.current ? activity.current.what : null,
    tomorrow,
    empty: events.length === 0 && turns === 0,
  }
}

// ---------------------------------------------------------------- 渲染

function render (d) {
  const L = []
  const name = d.life.name || '它'

  L.push('')
  L.push(`  ${name}的一天 · ${d.day}`)
  L.push('  ' + '─'.repeat(46))

  if (d.empty) {
    L.push('')
    L.push('  今天没有任何记录。')
    L.push('')
    L.push('  这可能是正常的（它在休息），也可能是它没跑起来。')
    L.push('  想区分，看系统健康而不是看这里 —— 休息不等于故障。')
    L.push('')
    return L.join('\n')
  }

  L.push('')
  for (const e of d.events) {
    const mark = e.tone === 'good' ? '✓'
      : e.tone === 'warn' ? '·'
      : e.tone === 'doing' ? '▸'
      : e.tone === 'start' ? '◦'
      : ' '
    L.push(`  ${e.time}  ${mark} ${e.text}`)
  }

  L.push('')
  L.push('  ' + '─'.repeat(46))
  const bits = []
  if (d.stats.activitiesStarted) bits.push(`起了 ${d.stats.activitiesStarted} 件事`)
  if (d.stats.activitiesDone) bits.push(`做成 ${d.stats.activitiesDone} 件`)
  if (d.stats.activitiesFailed) bits.push(`没成 ${d.stats.activitiesFailed} 件`)
  if (d.stats.wakes != null && d.stats.wakes > 0) bits.push(`自己醒来 ${d.stats.wakes} 次`)
  L.push(`  今天：${bits.length ? bits.join(' · ') : '没什么活动'}`)
  if (d.stats.turns) L.push(`  对话往返 ${d.stats.turns} 次（不计入上面）`)
  L.push('')

  if (d.tomorrow) {
    L.push(`  明天大概会：${d.tomorrow}`)
    L.push('')
  }
  if (d.openCommitments > 0) {
    L.push(`  还欠着 ${d.openCommitments} 件事。`)
    L.push('')
  }
  return L.join('\n')
}

// ---------------------------------------------------------------- main

const args = parseArgs(process.argv.slice(2))
if (args.help) { console.log(USAGE); process.exit(0) }

const dir = lifeDir(args)
if (!fs.existsSync(dir)) {
  console.error(`找不到这条命：${dir}`)
  console.error('提示：用 --root 指定 $DSH_HOME，或 --life 指定实例。')
  process.exit(1)
}

if (args.all) {
  const ledger = readLedger(path.join(dir, 'ledger.jsonl'))
  const days = [...new Set(ledger.map((r) => localDay(r.at)).filter(Boolean))].sort()
  if (args.json) console.log(JSON.stringify({ days }, null, 2))
  else {
    console.log('')
    console.log(`  有记录的日期（${days.length} 天）`)
    for (const d of days) {
      const n = ledger.filter((r) => localDay(r.at) === d).length
      console.log(`    ${d}   ${n} 条`)
    }
    console.log('')
  }
  process.exit(0)
}

const day = args.date || todayLocal()
if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
  console.error(`日期格式应为 YYYY-MM-DD，收到：${day}`)
  process.exit(1)
}

const report = buildDay(args, day)
if (args.json) console.log(JSON.stringify(report, null, 2))
else console.log(render(report))
