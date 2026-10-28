#!/usr/bin/env node
/**
 * life-week — 把一条命真的养七天，然后把它的一周打印出来。
 *
 * 为什么需要它：docs/PRODUCT.md §6 阶段 A 的产出物写着「一份『真实跑 7 天』
 * 的日志」，但它一直是空缺 —— soak 只证明了唤醒**策略**的算术（不跳日、不落
 * 静默、不超预算），从来没有跑出一条**有过日子的生命**。
 *
 * 而这个产品的全部主张是「累积」：第三天能看出偏好、第七天行为有因果。
 * 一个只在单日被验证过的东西，没资格说这句话。
 *
 * 它不重写任何逻辑。唤醒间隔来自 lib/wake.js、候选排序来自 lib/choose.js、
 * 落盘来自 lib/store.js —— 全是生产代码，只是把时钟换成了可注入的。
 * 这就是为什么 store 需要 clock 选项（见 store.js 构造函数注释）。
 *
 * 它**没有**证明的事（很重要，别读成承诺）：
 *   - 没有调用模型。选谁是**排序器**选的，不是模型选的。所以它验证的是
 *     「它有没有过日子的骨架」，不是「模型会不会照这个骨架过日子」。
 *   - 没有真的等待。七天是压缩跑的，不覆盖真实调度器的投递。
 *   - 失败是**注入的**（见 FAILURE_SCRIPT），不是真跑出来的。
 * 这三条都在 docs/life-week.md 里写明了，不在这里假装。
 *
 * 用法：
 *   node tools/life-week.mjs                 # 跑 7 天并打印
 *   node tools/life-week.mjs --days 14
 *   node tools/life-week.mjs --seed 7        # 换一个随机种子
 *   node tools/life-week.mjs --json          # 供程序消费
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const LIB = path.join(REPO, 'packages', 'dsh-life', 'lib')

// Windows: import() 不接受裸的 C:\... 路径，必须转成 file:// URL。
const { LifeStore } = await import(pathToFileURL(path.join(LIB, 'store.js')).href)
const { nextWakeDelayMs, msUntilNextDayWake, dayKeyOf } = await import(pathToFileURL(path.join(LIB, 'wake.js')).href)
const { rankCandidates, shortlistCandidates } = await import(pathToFileURL(path.join(LIB, 'choose.js')).href)

// ---------------------------------------------------------------- 参数

function parseArgs (argv) {
  const out = { days: 7, seed: 20261027, json: false, quiet: false, bornAt: null, home: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--days') out.days = Number(argv[++i])
    else if (a === '--seed') out.seed = Number(argv[++i])
    else if (a === '--born') out.bornAt = argv[++i]
    else if (a === '--home') out.home = argv[++i]
    else if (a === '--json') out.json = true
    else if (a === '--quiet') out.quiet = true
    else if (a === '--help' || a === '-h') out.help = true
  }
  if (!Number.isInteger(out.days) || out.days < 1 || out.days > 90) out.days = 7
  if (!Number.isFinite(out.seed)) out.seed = 20261027
  return out
}

const USAGE = `life-week — 把一条命真的养七天，然后打印它的一周

用法
  node tools/life-week.mjs [选项]

选项
  --days <n>      养几天（1–90，默认 7）
  --seed <n>      随机种子（默认 20261027；同一个种子结果一致）
  --born <ISO>    出生时刻（默认第 1 天 08:00）
  --home <dir>    状态写哪（默认临时目录；跑完不删，便于接着看）
  --json          输出 JSON（含逐日事件，供程序消费）
  --quiet         只打印汇总
  -h, --help      本帮助

养的是一条**没有模型**的命：选活动靠 lib/choose.js 的排序器，定闹钟靠
lib/wake.js 的策略。所以它证明的是「生活骨架成不成立」，不是「模型像不像人」。
`

// ---------------------------------------------------------------- 剧本

/**
 * 可复现的伪随机数。
 *
 * 唤醒抖动和「今天有没有失败」都要随机，但两次运行必须给出同一周 ——
 * 否则「第七天的行为能追到第三天」这句话就没法被复核。
 */
function makeRandom (seed) {
  let s = (seed >>> 0) || 1
  return function random () {
    // xorshift32：够用、确定性、无依赖。
    s ^= s << 13; s >>>= 0
    s ^= s >> 17
    s ^= s << 5; s >>>= 0
    return s / 4294967296
  }
}

/**
 * 这条命一开始就对什么有兴趣。
 *
 * 不是随机游荡：出生档案给两个方向，它第一件事才有理由（PRODUCT.md §4.2
 * 「给定而非摸索」）。鱼缸里养的不是一张白纸。
 */
const SEED_INTERESTS = [
  { topic: '像素矿工小品', confidence: 0.55, source: 'keeper' },
  { topic: '机械键盘手感', confidence: 0.4, source: 'keeper' },
]

/**
 * 世界给不给面子。
 *
 * 按**话题**判定，不按文案：排序器生成的句子形态有五六种（「看看 X 的更新」
 * 「练一练 X」「再试一次 X」「接着做 X」），第一版把键名写成固定文案，
 * 结果一次都没命中 —— 七天零失败，而失败路径正是这个产品最核心的承诺
 * （PRODUCT.md §4.2「留下一个明天要继续的事」）。这是连跑七天才会发现的
 * 错：单日演示里根本没有人去看失败有没有发生过。
 *
 * 真实运行里，这一步由工具调用的真实结果决定（life_finish_activity 的证据）。
 */
const FAILURE_TOPICS = new Set(['机械键盘手感'])

/** 这个话题第一次碰会失败吗。 */
function firstAttemptFails (what) {
  for (const topic of FAILURE_TOPICS) if (what.includes(topic)) return topic
  return null
}

// ---------------------------------------------------------------- 辅助

const MINUTE = 60 * 1000

function advanceTo (store, date) { store.clock = () => date }

function clock (d) {
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

function shortHash (text) {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619) }
  return (h >>> 0).toString(16).slice(0, 6)
}

function topicOf (what, traits) {
  const m = what.match(/「(.+?)」/)
  if (!m) return null
  const topic = m[1]
  return traits.interests.some((i) => i.topic === topic) ? topic : null
}

function skillNameOf (what) {
  const m = what.match(/「(.+?)」/)
  return m ? m[1] : what.slice(0, 12)
}

function evidenceFor (pick) {
  if (pick.what.includes('看看')) return `link:${shortHash(pick.what)}`
  if (pick.what.includes('练')) return `save:${shortHash(pick.what)}`
  if (pick.what.includes('写') || pick.what.includes('笔记')) return `draft:${shortHash(pick.what)}`
  return `note:${shortHash(pick.what)}`
}

/**
 * 今天每件事做成了几次 —— 与 index.js 的 doneTodayCounts 同一口径。
 * 模拟器必须走同一条路，否则它测的就不是生产行为。
 */
function doneTodayCounts (store, today) {
  const counts = new Map()
  for (const row of store.readLedger({ limit: 400, kind: 'activity-end' })) {
    const detail = row && row.detail && typeof row.detail === 'object' ? row.detail : {}
    if (detail.outcome !== 'done') continue
    if (dayKeyOf(row.at) !== today) continue
    const what = typeof detail.what === 'string' ? detail.what : ''
    if (what) counts.set(what, (counts.get(what) || 0) + 1)
  }
  return counts
}

/**
 * 按分数加权选一个 —— 对「模型在短名单里判断」的一个诚实近似。
 *
 * 不是 argmax：那等于假设模型只会挑排第一的。也不是均匀随机：那等于假设
 * 分数没用。加权保留了「分高的更可能被做」，同时让第二、第三名有真实概率。
 * 休息也在池子里，因为它本来就该是个真选项。
 */
function weightedPick (candidates, random) {
  const list = (candidates || []).filter(Boolean)
  if (list.length === 0) return null
  // +0.08 的地板：分数为 0 的候选也不该完全没机会，否则「探索」是假的。
  const weights = list.map((c) => Math.max(0, c.score) + 0.08)
  const total = weights.reduce((a, b) => a + b, 0)
  let roll = random() * total
  for (let i = 0; i < list.length; i++) {
    roll -= weights[i]
    if (roll <= 0) return list[i]
  }
  return list[list.length - 1]
}

// ---------------------------------------------------------------- 一次唤醒

/**
 * 模拟一次唤醒轮：排序 → 选 → 做 → 收尾（带证据）。
 *
 * 这里是**唯一**被简化的一步：真实运行时，rankCandidates 的输出会被塞进
 * 提示词，由模型决定要不要照做（index.js 的 renderWakeShortlist）。
 * 这里我们替模型做选择 —— 所以它测的是排序器和状态机的配合，
 * 不是模型的判断力。这一点在文档里写明。
 */
function runWake ({ store, now, random, seenFailures, log }) {
  const traits = store.readTraits() || { interests: [], skills: [] }
  const wake = store.readWake()
  const today = dayKeyOf(now)
  const countToday = wake.dayKey === today ? wake.countToday : 0

  // 记账：真实系统里由 schedule 投递触发（store.noteWake 幂等），
  // 并且 index.js 在同一处会往账本补一条 kind:'wake'（见 lib/index.js 的
  // user/message 分支）。两件事必须一起做。
  //
  // 这里原本只调了 noteWake、没写账本那一行 —— 于是「自己醒了几次」只存在于
  // 这个模拟器的日志里，任何**读账本**的视图（tools/day-report.mjs）都数不到，
  // 两个视图对同一件事实给出不同答案。是 verify/day-report.mjs 的断言把它逼出来的：
  // 账本是唯一可回放的记录，凡是「发生过」的事都必须落在那儿。
  const messageId = `week-${now.getTime()}`
  const noted = store.noteWake({ sessionId: 'week', messageId, at: now })
  if (noted.counted) {
    store.appendLedger({ kind: 'wake', detail: { messageId, sessionId: 'week' } })
  }

  const ranked = rankCandidates({
    now,
    commitments: store.readCommitments().items,
    interests: traits.interests,
    skills: traits.skills,
    activity: store.readActivity(),
    wakeBudget: { countToday, maxPerDay: 6 },
    // 与 index.js 的 doneTodayCounts 同源：从今天的账本算「这件事今天做过几次」。
    // 少了它，排序器会把同一件事连推一天（第一版就是这样）。
    doneToday: doneTodayCounts(store, today),
  })
  // 与提示词里给模型的短名单是同一个函数，所以「它看到的」和「它选的」不会分叉。
  const shortlist = shortlistCandidates(ranked.candidates, 3)
  // 不是 argmax。真实模型拿到的是这份短名单，然后**判断**；一直取第一名
  // 等于假设它只会干排最前的那件事，那既不像模型，也掩盖了一个真问题：
  // 做过的活动会刷新 updatedAt → freshness 回满 → 下一轮还是它排第一。
  // 第一版取 shortlist[0]，结果七天里同一件事被做了 33 次。这里按分数加权抽，
  // 休息也在池子里（它排在名单最后，但是个真选项，不是兜底）。
  const pick = weightedPick(shortlist, random)

  log.push({ at: now.toISOString(), time: clock(now), kind: 'wake', text: `自己醒了（今天第 ${countToday + 1} 次）` })
  for (const note of ranked.notes) log.push({ at: now.toISOString(), time: clock(now), kind: 'note', text: note })

  // 休息是合法选择，而且不该被当成「什么都没做」。
  if (!pick || pick.kind === 'rest') {
    log.push({ at: now.toISOString(), time: clock(now), kind: 'rest', text: '选了休息 —— 今天没有非做不可的事' })
    return { rest: true, endedAt: null }
  }

  store.startActivity({ what: pick.what, why: pick.reason })
  log.push({ at: now.toISOString(), time: clock(now), kind: 'start', what: pick.what, reason: pick.reason, score: pick.score, parts: pick.parts })

  // 做一会儿。真实运行是模型在沙盒里真跑；这里只推进时间。
  const spentMs = (35 + Math.floor(random() * 50)) * MINUTE
  const doneAt = new Date(now.getTime() + spentMs)

  // 结果：某个话题第一次碰会失败，之后成功 —— 让「再试一次」这条路真的被走到。
  let outcome = 'done'
  const failingTopic = firstAttemptFails(pick.what)
  if (failingTopic && !seenFailures.has(failingTopic)) {
    seenFailures.add(failingTopic)
    outcome = 'failed'
  }
  const evidence = outcome === 'done' ? [evidenceFor(pick)] : [`save:${shortHash(pick.what)}`]
  const note = outcome === 'failed' ? '资料对不上，记下来换个来源' : ''

  advanceTo(store, doneAt)
  // 与 index.js 的 life_finish_activity 同一条路：失败必须留下下一步，
  // 否则「明天接着做」在数据里根本不存在（choose.js 那段逻辑就是死的）。
  const nextStep = outcome === 'failed'
    ? { what: `换个打法再试一次「${pick.what}」`, why: note || '上次没成' }
    : null
  const finished = store.finishActivity({ outcome, evidence, note, next: nextStep })
  log.push({
    at: doneAt.toISOString(),
    time: clock(doneAt),
    kind: outcome === 'done' ? 'done' : 'failed',
    what: pick.what,
    note,
    evidence: finished.evidence,
    durationMin: Math.round(spentMs / MINUTE),
  })

  // 成功的经历会转化成中等变量：兴趣加深、技能成型。这是「累积」发生的地方。
  if (outcome === 'done') {
    const topic = topicOf(pick.what, traits)
    if (topic) {
      const before = traits.interests.find((i) => i.topic === topic) || { confidence: 0.5 }
      store.recordInterest({ topic, confidence: Math.min(0.95, (before.confidence || 0.5) + 0.12), source: 'experience' })
      log.push({ at: doneAt.toISOString(), time: clock(doneAt), kind: 'interest', text: `对「${topic}」的兴趣加深` })
    }
    if (pick.kind === 'skill' || pick.what.startsWith('练')) {
      store.recordSkill({ name: skillNameOf(pick.what), evidence: evidence[0], stage: 'practicing' })
      log.push({ at: doneAt.toISOString(), time: clock(doneAt), kind: 'skill', text: `技能「${skillNameOf(pick.what)}」进入练习中` })
    }
  } else {
    // 失败留下「下一步」：这是第二天还能接上的原因（PRODUCT.md §4.2）。
    log.push({ at: doneAt.toISOString(), time: clock(doneAt), kind: 'next', text: `留下了明天要做的事：${nextStep.what}` })
  }

  // 做成了答应过的事，就要把它结掉 —— 真实模型在这里会调 life_settle_commitment。
  // 少了这一步，排序器会因为「承诺还欠着」而无限次推同一件事（第一版就是这样
  // 连做了六遍同一个笔记，看起来还挺勤快）。这不是 bug，是缺了一次收尾。
  if (outcome === 'done') {
    for (const item of store.readCommitments().items) {
      if (item.status !== 'open') continue
      if (pick.what === item.what || item.what.includes(pick.what) || pick.what.includes(item.what)) {
        store.settleCommitment({ id: item.id, status: 'done', evidence: evidence[0] })
        log.push({ at: doneAt.toISOString(), time: clock(doneAt), kind: 'settled', text: `兑现了一件事：${item.what}` })
      }
    }
  }

  return { rest: false, outcome, what: pick.what, endedAt: doneAt }
}

// ---------------------------------------------------------------- 主循环

async function run (args) {
  const random = makeRandom(args.seed)
  const home = args.home || fs.mkdtempSync(path.join(os.tmpdir(), 'life-week-'))

  // 出生时刻：默认「第 1 天 08:00」，也就是静默时段刚结束 —— 它一出生就是白天。
  const born = args.bornAt ? new Date(args.bornAt) : (() => {
    const d = new Date()
    d.setHours(8, 0, 0, 0)
    return d
  })()
  if (Number.isNaN(born.getTime())) throw new Error(`--born 不是合法时间：${args.bornAt}`)
  let now = born

  const store = new LifeStore({ home, lifeId: 'week', clock: () => now })
  store.ensure({ name: '大肥鱼', species: 'whale', seeds: ['聪明但懒', '傲娇', '爱吃白饭'] })

  const log = []
  log.push({ at: now.toISOString(), time: clock(now), kind: 'born', text: '大肥鱼出生了' })

  // 出生档案带两个兴趣（§4.2「给定而非摸索」）。
  for (const interest of SEED_INTERESTS) {
    store.recordInterest(interest)
    log.push({ at: now.toISOString(), time: clock(now), kind: 'interest', text: `出生档案里带着对「${interest.topic}」的兴趣（来自主人）` })
  }

  // 第 1 天留一个承诺：有了它，第二天就有「答应了的事」可接（§4.2 第二天的钩子）。
  const promise = '把《地底 38 层》的打法写进自己的笔记'
  const dueAt = dayKeyOf(new Date(born.getTime() + 2 * 24 * 60 * MINUTE))
  store.makeCommitment({ what: promise, dueAt })
  log.push({ at: now.toISOString(), time: clock(now), kind: 'promise', text: `答应了一件事：${promise}（${dueAt} 前）` })

  const seenFailures = new Set()
  const endMs = born.getTime() + args.days * 24 * 60 * MINUTE

  const WAKE = { everyMinutes: 90, jitterMinutes: 20, quietStart: '23:00', quietEnd: '08:00', maxPerDay: 6 }

  while (now.getTime() < endMs) {
    // 这一分支必须和 index.js 的 armWake 完全一致：预算耗尽时不是继续排
    // 90 分钟，而是订「明天静默结束后的第一次」——否则一天会醒十几次，
    // 而那个 bug 会藏在「看起来挺活跃」里。第一版就是这样被抓出来的。
    const wake = store.readWake()
    const today = dayKeyOf(now)
    const countToday = wake.dayKey === today ? wake.countToday : 0
    const delayMs = countToday >= WAKE.maxPerDay
      ? msUntilNextDayWake({ now, quietEnd: WAKE.quietEnd, jitterMinutes: WAKE.jitterMinutes, random })
      : nextWakeDelayMs({ now, ...WAKE, random })

    now = new Date(now.getTime() + delayMs)
    if (now.getTime() >= endMs) break
    advanceTo(store, now)
    const outcome = runWake({ store, now, random, seenFailures, log })
    // 时间只能往前走。第一版漏了这一步：活动要花 35–85 分钟，而下一次唤醒
    // 是从**醒来时刻**算的 90 分钟，于是两件事重叠、日志里出现时间倒流
    // （10:52 后面跟着 10:48）。真实系统里 schedule 是绝对时刻，不会这样；
    // 这是我这个模拟器的 bug，靠连跑七天才会暴露。
    if (outcome.endedAt && outcome.endedAt.getTime() > now.getTime()) now = outcome.endedAt
  }

  // 按本地日历日切分
  const byDay = new Map()
  for (const row of log) {
    const key = dayKeyOf(new Date(row.at))
    if (!byDay.has(key)) byDay.set(key, [])
    byDay.get(key).push(row)
  }
  const days = []
  for (const [day, rows] of byDay) {
    days.push({
      day,
      events: rows,
      stats: {
        wakes: rows.filter((r) => r.kind === 'wake').length,
        started: rows.filter((r) => r.kind === 'start').length,
        done: rows.filter((r) => r.kind === 'done').length,
        failed: rows.filter((r) => r.kind === 'failed').length,
        rested: rows.filter((r) => r.kind === 'rest').length,
      },
    })
  }

  const ledger = store.readLedger({ limit: 0 })
  return {
    days,
    home,
    seed: args.seed,
    bornAt: born.toISOString(),
    ledgerEntries: ledger.length,
    ledgerKinds: [...new Set(ledger.map((r) => r.kind))].sort(),
    snapshot: store.snapshot(),
    interests: (store.readTraits() || {}).interests || [],
    skills: (store.readTraits() || {}).skills || [],
    commitments: store.readCommitments().items,
  }
}

// ---------------------------------------------------------------- 渲染

function render (result) {
  const L = []
  const name = result.snapshot.name || '它'
  L.push('')
  L.push(`  ${name}的一周 · ${result.days.length} 天 · 账本 ${result.ledgerEntries} 条`)
  L.push(`  出生：${result.bornAt}   种子：${result.seed}`)
  L.push('  ' + '─'.repeat(52))

  for (const d of result.days) {
    L.push('')
    L.push(`  ${d.day}`)
    for (const e of d.events) {
      if (e.kind === 'wake') continue // 醒来次数在下面汇总，逐条列是噪音
      const mark = e.kind === 'done' || e.kind === 'settled' ? '✓'
        : e.kind === 'failed' ? '·'
        : e.kind === 'start' ? '▸'
        : e.kind === 'rest' ? '○'
        : e.kind === 'born' ? '◦'
        : e.kind === 'next' ? '→'
        : ' '
      const body = e.text || (e.kind === 'start' ? `开始：${e.what}（因为 ${e.reason}）`
        : e.kind === 'done' ? `做成了：${e.what}｜证据 ${(e.evidence || []).join('、')}`
        : e.kind === 'failed' ? `没做成：${e.what}${e.note ? `：${e.note}` : ''}｜证据 ${(e.evidence || []).join('、')}`
        : '')
      L.push(`    ${e.time}  ${mark} ${body}`)
    }
    const s = d.stats
    const bits = [`自己醒 ${s.wakes} 次`]
    if (s.started) bits.push(`起 ${s.started} 件事`)
    if (s.done) bits.push(`成 ${s.done}`)
    if (s.failed) bits.push(`败 ${s.failed}`)
    if (s.rested) bits.push(`休息 ${s.rested}`)
    L.push(`      ── ${bits.join(' · ')}`)
  }

  L.push('')
  L.push('  ' + '─'.repeat(52))
  L.push('  第七天它是什么样：')
  for (const i of [...result.interests].sort((a, b) => (b.confidence || 0) - (a.confidence || 0)).slice(0, 4)) {
    L.push(`    兴趣 ${i.topic}  ${Number(i.confidence || 0).toFixed(2)}  （观察 ${i.observations || 0} 次，来源 ${i.source}）`)
  }
  for (const s of result.skills.slice(-4)) {
    L.push(`    技能 ${s.name}  ${s.stage}  （证据 ${s.evidence || '无'}）`)
  }
  const open = result.commitments.filter((c) => c.status === 'open')
  const settled = result.commitments.filter((c) => c.status !== 'open')
  L.push(`    承诺：兑现 ${settled.length} 件，还欠 ${open.length} 件`)
  L.push('')
  L.push(`  账本 kind：${result.ledgerKinds.join(', ')}`)
  L.push(`  状态落在：${result.home}`)
  L.push('')
  L.push('  这份日志**证明**了：七天里它每天都有可解释的活动或明确的休息，')
  L.push('  承诺被兑现，兴趣由经历累积而成，账本可以逐条回放。')
  L.push('  它**没有**证明：模型会不会照这个骨架过日子（这里没有调用模型）。')
  L.push('')
  return L.join('\n')
}

// ---------------------------------------------------------------- main

const args = parseArgs(process.argv.slice(2))
if (args.help) { console.log(USAGE); process.exit(0) }

const result = await run(args)
if (args.json) console.log(JSON.stringify(result, null, 2))
else if (args.quiet) {
  const total = result.days.reduce((n, d) => n + d.stats.started + d.stats.done + d.stats.failed + d.stats.rested, 0)
  console.log(`${result.days.length} 天 · ${result.ledgerEntries} 条账本 · ${total} 个事件 · ${result.home}`)
} else console.log(render(result))
