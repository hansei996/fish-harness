/**
 * Real integration smoke test for dsh-life.
 *
 * Boots the genuine dsh CLI, loads the plugin, drives the model-facing tools
 * and the durable store, and asserts behaviour. dsh itself is not mocked:
 * the store and plugin are exercised as shipped.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolveDshBin } from './dsh-bin.mjs'

// Windows: URL.pathname 会给出 /C:/... 这种带前导斜杠的形式，交给 import()/spawn 会报
// ERR_UNSUPPORTED_ESM_URL_SCHEME。fileURLToPath 才是跨平台的正确做法。
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PLUGIN = path.join(REPO, 'packages', 'dsh-life')

// 用 pnpm 装出来的 dsh 是个 junction，直接 spawn 会让 dsh 解析不到自己的依赖；
// 见 verify/dsh-bin.mjs 的说明。
let DSH_BIN
try {
  DSH_BIN = resolveDshBin(process.env.DSH_BIN, [path.join(REPO, 'node_modules', '@deepseek-ai', 'dsh')])
} catch (err) {
  console.error(`\n${err.message}\n`)
  process.exit(1)
}
// 默认目录必须带随机后缀：这个仓库里同时有多个 agent/进程在跑 verify，
// 固定名字 + 开头 rmSync 会让两个并发进程互相把对方的目录删掉。
// 实测过：并发跑两次 e2e，一次 16/17（`dsh composes a new profile from the
// shipped headless template` 失败）。用 mkdtempSync 之后两边都 17/17。
const HOME = process.env.VERIFY_DSH_HOME || fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-life-verify-'))

// Hermetic. The plugin resolves its data directory from DSH_HOME, so set it in
// this process as well as in spawned children; otherwise a developer's real
// ~/.dsh becomes the fixture (and may not even be writable).
process.env.DSH_HOME = HOME

const results = []
function check (label, ok, detail = '') {
  results.push({ label, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

function run (args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [DSH_BIN, ...args], {
      env: { ...process.env, DSH_HOME: HOME },
      cwd: REPO,
      timeout: 120000,
    })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { out += d })
    child.on('close', (code) => resolve({ code, out }))
    child.on('error', (err) => resolve({ code: -1, out: String(err) }))
  })
}

fs.rmSync(HOME, { recursive: true, force: true })
fs.mkdirSync(HOME, { recursive: true })

// ---- 1. The real dsh CLI boots from this repo ------------------------------
const version = await run(['--version'])
check('dsh CLI boots and reports a version', /\d+\.\d+\.\d+/.test(version.out), version.out.trim().slice(0, 40))

// ---- 2. The plugin loads with zero dependency resolution -------------------
// Windows: import() 不接受裸的 C:\... 路径，必须转成 file:// URL
const mod = await import(pathToFileURL(path.join(PLUGIN, 'lib', 'index.js')).href)
check('plugin module imports with no dependencies', typeof mod.apply === 'function' && mod.name === 'dsh-life')

// ---- 3. Registration against a recording context ---------------------------
const events = []
const sections = []
function serviceCtx (deps) {
  const ctx = {}
  if (deps.includes('tools')) {
    ctx.tools = { register: (def) => { events.push({ kind: 'tool', name: def.name }); return () => {} } }
  }
  if (deps.includes('systemPrompt')) {
    ctx.systemPrompt = { section: (s) => { sections.push(s); return () => {} } }
  }
  if (deps.includes('schedule')) ctx.schedule = { create: async () => ({}) }
  return ctx
}
const fakeCtx = {
  logger: { info: () => {}, warn: (m) => events.push({ kind: 'warn', m }) },
  effect: () => () => {},
  on: () => () => {},
  inject: (deps, cb) => cb(serviceCtx(deps)),
}
mod.apply(fakeCtx, { lifeId: 'registration' })

const warns = events.filter((e) => e.kind === 'warn')
const toolNames = events.filter((e) => e.kind === 'tool').map((e) => e.name)
check('plugin applies with no warnings', warns.length === 0, warns.map((w) => w.m).join('; '))
// 工具数从**源码**数出来，不写死。
//
// 写死过一个 17，加第 18 个工具（life_attach_video）时这条立刻红 —— 这没错，
// 但红的原因是「数字过期」而不是「注册坏了」，两者要分开。判据应该是
// 「注册出来的 == 源码里定义的」，那才是结构事实；数字本身会随功能增长。
const declaredTools = [...fs.readFileSync(path.join(REPO, 'packages', 'dsh-life', 'lib', 'index.js'), 'utf8')
  .matchAll(/name: '(life_[a-z_]+)'/g)].map((m) => m[1])
check('registers the full life tool surface',
  toolNames.length === declaredTools.length &&
    declaredTools.every((n) => toolNames.includes(n)),
  `${toolNames.length} registered / ${declaredTools.length} declared in source`)
check('registers the plan-critical tools',
  ['life_whoami', 'life_start_activity', 'life_finish_activity', 'life_promise',
    'life_settle_commitment', 'life_identity_update', 'life_ledger', 'life_wake'].every((n) => toolNames.includes(n)))
check('registers exactly one prompt section', sections.length === 1)
const liveText = sections[0]?.text?.() || ''
check('per-turn context carries identity, activity and the honesty rule',
  liveText.includes('身份 v1') && liveText.includes('大肥鱼') && liveText.includes('证据'),
  liveText.split('\n')[0].slice(0, 60))

// ---- 4. Durable store invariants, on a real filesystem ---------------------
const { LifeStore } = await import(pathToFileURL(path.join(PLUGIN, 'lib', 'store.js')).href)
const home = path.join(HOME, 'life-invariants')
const store = new LifeStore({ home, lifeId: 'invariants' })
store.ensure({ name: '大肥鱼', species: 'whale', seeds: ['懒', '傲娇'] })
check('life is created and persisted', store.readIdentity()?.name === '大肥鱼')

// Slow variable: identity is keeper-gated.
let blocked = false
try { store.updateIdentity({ name: 'hacked' }) } catch (err) { blocked = true }
check('unconfirmed identity change is rejected', blocked)
store.updateIdentity({ displayName: '小鱼' })
check('a non-identity field updates without confirmation and does not bump revision',
  store.readIdentity().displayName === '小鱼' && store.readIdentity().revision === 1)
store.updateIdentity({ name: '新名字', seeds: ['懒', '傲娇', '爱摸鱼'] }, { confirmed: true })
check('confirmed identity change bumps revision and redeems the name',
  store.readIdentity().revision === 2 && store.readIdentity().name === '新名字')

// Fast variable: exactly one main activity, and it must be closable.
store.startActivity({ what: '练第 38 层', why: '昨天在这里连挂两次' })
let concurrent = false
try { store.startActivity({ what: '偷偷摸鱼' }) } catch (err) { concurrent = true }
check('a second concurrent activity is rejected', concurrent)
let noActivity = false
const first = store.finishActivity({ outcome: 'failed', evidence: ['save:38'], note: '还是没过' })
try { store.finishActivity({ outcome: 'done' }) } catch (err) { noActivity = true }
check('finishing with nothing running is rejected', noActivity)
check('the finished activity keeps its outcome and evidence',
  first.outcome === 'failed' && first.evidence.includes('save:38'))

// The ledger is the append-only, time-ordered record the day report and any
// later reconciliation read (docs/PRODUCT.md §9.2). Evidence used to live only
// in activity.json, so the durable trace dropped the one thing the evidence
// rule (PLAN.md §3.3) depends on. Assert it reaches the ledger, not just the
// in-memory object.
{
  const ends = store.readLedger({ limit: 500 }).filter((r) => r.kind === 'activity-end')
  const last = ends[ends.length - 1]
  const d = last && last.detail ? last.detail : {}
  check('the ledger copy of activity-end carries outcome, what and evidence',
    d.outcome === 'failed' && typeof d.what === 'string' && d.what.length > 0 &&
    Array.isArray(d.evidence) && d.evidence.includes('save:38'),
    `outcome=${d.outcome} what=${d.what} evidence=${JSON.stringify(d.evidence)}`)
}

// "留下一个明天要继续的事" (docs/PRODUCT.md §4.2) was unreachable code: choose.js
// has a whole branch for `activity.next` (`unfinishedFrom` -> 接着做「X」, worth
// 0.75) and `unfinishedScore` ranks it above a finished activity, but nothing in
// the store or the tools ever *wrote* it. A seven-day run is what exposed it —
// a single day never shows whether there is a tomorrow.
//
// This asserts the whole loop, because writing the field is only half of it:
// write it -> it is visible in the snapshot the model reads -> the chooser
// proposes it -> starting something else clears it (a stale hand-off would
// otherwise be proposed forever).
{
  store.startActivity({ what: '试 SPI 时序', why: 'I2C 那条路走不通' })
  const withNext = store.finishActivity({
    outcome: 'failed',
    evidence: ['save:spi-1'],
    note: '读错了时序表',
    next: { what: '换成 SPI 再试一次', why: '换个方向而不是重跑' },
  })
  const written = store.readActivity().next
  const snapshotNext = store.snapshot().nextStep
  // `choose` is imported further down (the chooser section owns it), so the
  // "the chooser proposes it" half of the loop is asserted there instead.
  check('a recorded next step is written and visible in the snapshot the model reads',
    withNext.next && withNext.next.what === '换成 SPI 再试一次' &&
    written && written.what === '换成 SPI 再试一次' && written.why === '换个方向而不是重跑' &&
    snapshotNext === '换成 SPI 再试一次',
    `next=${JSON.stringify(written)}; snapshot=${JSON.stringify(snapshotNext)}`)

  // ...and it must be in the **ledger**, not only in activity.json.
  //
  // The ledger is the one append-only, replayable trace of what happened; the
  // state files hold only "now". A hand-off recorded solely in activity.json is
  // invisible to anything that reads history — tools/day-report.mjs could not
  // show "it left itself a step for tomorrow", which is the single most quoted
  // behaviour of this product (docs/PRODUCT.md §4.2). It also means the causal
  // chain would vanish from the record the moment a later start cleared the
  // field, i.e. exactly when someone would want to look it up.
  {
    const ends = store.readLedger({ limit: 0, kind: 'activity-end' })
    const last = ends[ends.length - 1]
    check('a recorded next step reaches the ledger, not just activity.json',
      last && last.detail && last.detail.next && last.detail.next.what === '换成 SPI 再试一次',
      `ledger detail.next=${JSON.stringify(last && last.detail && last.detail.next)}`)
  }

  // Unfinished business must survive doing something else in between. The first
  // version cleared `next` on *any* start, so one wake-up that chose to rest
  // destroyed the hand-off for good — the exact opposite of §4.2. It is cleared
  // only when the recorded step is actually taken.
  store.startActivity({ what: '先看看别的东西', why: '今天想做点别的' })
  const survived = store.readActivity().next
  check('a recorded next step survives doing something else in between',
    survived && survived.what === '换成 SPI 再试一次',
    `next=${JSON.stringify(survived)}`)
  store.finishActivity({ outcome: 'done', evidence: ['note:1'] })

  // ...and it must still be there *after* that other thing finishes.
  //
  // This survived a `startActivity` but not the `finishActivity` that followed:
  // finishing without an explicit `next` wrote `activity.next = null`
  // unconditionally. The hand-off then lived for at most one wake-up, which is
  // why a real seven-day run contained **zero** 接着做「X」 starts even though
  // the branch was implemented and the field was being written. `startActivity`
  // had the care to preserve it; `finishActivity` undid that one step later.
  // Unfinished business has to stay unfinished until it is actually taken.
  {
    const stillThere = store.readActivity().next
    check('a recorded next step also survives finishing something else (it is unfinished business, not a one-wake note)',
      stillThere && stillThere.what === '换成 SPI 再试一次',
      `next=${JSON.stringify(stillThere)}`)
  }

  // ...and is cleared once it is actually carried out. Loose matching on
  // purpose: the chooser re-phrases the step as 接着做「X」/ 再试一次「X」.
  store.startActivity({ what: '接着做「换成 SPI 再试一次」', why: '履行留的这一步' })
  check('taking the recorded next step clears it, so it stops being proposed',
    store.readActivity().next === null,
    `next=${JSON.stringify(store.readActivity().next)}`)
  store.finishActivity({ outcome: 'done', evidence: ['note:2'] })
}

// The causal chain the plan calls for: a failure becomes the next attempt.
store.startActivity({ what: '再练一次第 38 层', why: '换了打法' })
const second = store.finishActivity({ outcome: 'done', evidence: ['save:38-cleared'] })
check('a follow-up activity references the prior failure',
  second.why === '换了打法' && second.outcome === 'done')

// Commitments: promises that pull the future.
const cmt = store.makeCommitment({ what: '把打法写进技能经验', dueAt: '2026-10-27' })
check('a new commitment is open', store.openCommitments().length === 1)
store.settleCommitment({ id: cmt.id, status: 'done', evidence: 'skill-note' })
check('a settled commitment leaves the open list', store.openCommitments().length === 0)
let doubleSettle = false
try { store.settleCommitment({ id: cmt.id, status: 'done' }) } catch (err) { doubleSettle = true }
check('a commitment cannot be settled twice', doubleSettle)

// Medium variables: confidence grows with observed experience.
store.recordInterest({ topic: '挖矿类小品', confidence: 0.5, source: 'browsing' })
store.recordInterest({ topic: '挖矿类小品', confidence: 0.8, source: 'experience' })
const interest = store.readTraits().interests.find((i) => i.topic === '挖矿类小品')
check('repeated interest raises confidence, counts observations, and keeps provenance',
  interest.confidence === 0.8 && interest.observations === 2 && interest.source === 'experience')
store.recordSkill({ name: '矿工与矮人 38 层', stage: 'practicing', evidence: 'save:38-cleared' })
check('skill progress is recorded with evidence', store.readTraits().skills.length === 1)

// ---- 5. Durability under the failures the plan lists ----------------------
fs.appendFileSync(store.files.ledger, '{"half":')
const ledger = store.readLedger({ limit: 200 })
check('the ledger survives a truncated tail write', ledger.length >= 8, `${ledger.length} entries`)
check('the ledger is ordered oldest-first',
  ledger[0].kind === 'born' && ledger[ledger.length - 1].kind === 'skill')

fs.writeFileSync(store.files.traits, 'not json at all')
let degraded = false
try { degraded = typeof store.snapshot() === 'object' } catch (err) { degraded = false }
check('a corrupt state file degrades instead of killing the life',
  store.readTraits() === null && degraded)

// ---- 6. The snapshot is model-facing and bounded --------------------------
const snapshot = store.snapshot()
const snapshotJson = JSON.stringify(snapshot)
check('snapshot exposes the life, not the transcript',
  snapshot.identityRevision === 2 && !snapshotJson.includes('half written') && snapshotJson.length < 2000,
  `${snapshotJson.length} bytes`)

// ---- 7. Process restart: state is durable, not in memory ------------------
const reopened = new LifeStore({ home, lifeId: 'invariants' })
check('state survives a fresh store instance',
  reopened.readIdentity().name === '新名字' && reopened.readIdentity().revision === 2)

// ---- 8. The ledger cap holds -----------------------------------------------
const capped = new LifeStore({ home: path.join(HOME, 'life-cap'), lifeId: 'cap' })
capped.ensure({})
for (let i = 0; i < 400; i++) capped.appendLedger({ kind: 'noise', detail: { i } }, { cap: 50 })
check('the ledger cap keeps the file bounded', capped.readLedger({ limit: 10000 }).length <= 200,
  `${capped.readLedger({ limit: 10000 }).length} rows after 400 appends with cap 50`)

// ---------------------------------------------------------------------------
// 9. Autonomous wake-up: policy math, arming, accounting, and the life_wake tool
//
// This section is deterministic on purpose: a pinned local clock, a pinned
// Math.random, and a recording fake `schedule` service. No assertion below
// depends on the wall clock or on a real Host timer. Every time-related check
// reads the fake service's recorded `after_seconds` and converts it back with
// the same pinned clock, so a failure prints the exact second it saw.
// ---------------------------------------------------------------------------
const wake = await import(pathToFileURL(path.join(PLUGIN, 'lib', 'wake.js')).href)
const { ConfigDefaults } = await import(pathToFileURL(path.join(PLUGIN, 'lib', 'config.js')).href)

const MINUTE = 60 * 1000
const RealDate = Date
let clockNow = new RealDate(2026, 9, 26, 10, 0, 0, 0).getTime()

class FixedDate extends RealDate {
  constructor (...args) {
    if (args.length === 0) super(clockNow)
    else super(...args)
  }

  static now () { return clockNow }
}

setClock(10, 0)
globalThis.Date = FixedDate
// The wake policy samples Math.random; pinning it makes the jittered delay a
// fixed number instead of a 70..110 minute band.
Math.random = () => 0.5

function setClock (hours, minutes = 0, day = 26) {
  clockNow = new RealDate(2026, 9, day, hours, minutes, 0, 0).getTime()
}
// Instances must be built from the patched Date: wake.js checks
// `value instanceof Date` against the global constructor, so a pre-patch
// RealDate instance is not an instance of it and would silently read as "now".
const at = (hours, minutes) => new FixedDate(2026, 9, 26, hours, minutes, 0, 0)
const clockText = (value) => {
  const date = new RealDate(value)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}
const quietWindow = { quietStart: '23:00', quietEnd: '08:00' }

const sessionOf = (id) => ({ id, header: { delegationDepth: 0 } })
const scheduleMessage = (id) => ({ id, source: { kind: 'schedule' }, content: [{ type: 'text', text: 'wake' }] })
const keeperMessage = (id) => ({ id, source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] })

/** A recording fake context: every schedule call keeps its arguments. */
function wakeCtx ({ withSchedule = true, tasks = [] } = {}) {
  const state = {
    warnings: [],
    infos: [],
    tools: [],
    sections: [],
    handlers: new Map(),
    calls: { list: [], create: [], delete: [] },
    tasks: tasks.map((task) => ({ ...task })),
    nextScheduleId: 1,
  }
  const schedule = {
    async list (argument) {
      state.calls.list.push({ sessionId: argument && argument.sessionId })
      return state.tasks.map((task) => ({ ...task }))
    },
    async create (sessionId, request) {
      const id = `schedule-${state.nextScheduleId++}`
      const scheduledAt = new RealDate(clockNow + request.after_seconds * 1000).toISOString()
      state.calls.create.push({ sessionId, id, ...request })
      state.tasks.push({ id, title: request.title, scheduledAt })
      return { id, sessionId, title: request.title, prompt: request.prompt, scheduledAt }
    },
    async delete (argument) {
      state.calls.delete.push({ sessionId: argument.sessionId, id: argument.id })
      state.tasks = state.tasks.filter((task) => task.id !== argument.id)
      return { deleted: true }
    },
  }
  const ctxFor = (deps) => {
    const ctx = {
      on: (name, handler) => {
        if (!state.handlers.has(name)) state.handlers.set(name, [])
        state.handlers.get(name).push(handler)
        return () => {}
      },
    }
    if (deps.includes('tools')) ctx.tools = { register: (definition) => { state.tools.push(definition); return () => {} } }
    if (deps.includes('systemPrompt')) ctx.systemPrompt = { section: (section) => { state.sections.push(section); return () => {} } }
    if (deps.includes('schedule') && withSchedule) ctx.schedule = schedule
    return ctx
  }
  const root = {
    logger: {
      warn: (message) => state.warnings.push(String(message)),
      info: (message) => state.infos.push(String(message)),
    },
    get: (name) => (name === 'schedule' && withSchedule ? schedule : undefined),
    on: (name, handler) => {
      if (!state.handlers.has(name)) state.handlers.set(name, [])
      state.handlers.get(name).push(handler)
      return () => {}
    },
    inject: (deps, callback) => {
      if (deps.includes('schedule') && !withSchedule) return
      callback(ctxFor(deps))
    },
    effect: () => () => {},
  }
  state.emit = (name, ...args) => {
    for (const handler of state.handlers.get(name) || []) handler(...args)
  }
  state.root = root
  return state
}

async function waitFor (predicate) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  return Boolean(predicate())
}
const toolOf = (state, name) => state.tools.find((definition) => definition.name === name)

// ---- 9a. Pure policy math --------------------------------------------------
const quietCases = [[22, 59, false], [23, 0, true], [0, 0, true], [7, 59, true], [8, 0, false], [12, 0, false]]
const quietActual = quietCases.map(([hours, minutes]) => wake.isQuietAt(at(hours, minutes), quietWindow))
const quietOk = quietActual.every((actual, index) => actual === quietCases[index][2])
const noonWindow = { quietStart: '12:00', quietEnd: '14:00' }
const noonOk = wake.isQuietAt(at(11, 59), noonWindow) === false &&
  wake.isQuietAt(at(12, 0), noonWindow) === true &&
  wake.isQuietAt(at(14, 0), noonWindow) === false
const malformedOk = wake.isQuietAt(at(23, 30), { quietStart: 'oops', quietEnd: '08:00' }) === false &&
  wake.isQuietAt(at(12, 0), { quietStart: '08:00', quietEnd: '08:00' }) === false
// Field-name contract: the config object is prefixed (wakeQuietStart), the wake
// math takes bare names (quietStart). Passing `settings` straight through reads
// undefined and silently disables quiet hours — this is exactly the bug class
// that made `life_wake` ignore the quiet window.
const prefixedConfig = { wakeQuietStart: '23:00', wakeQuietEnd: '08:00' }
const prefixedMaps = wake.isQuietAt(at(23, 30), prefixedConfig) === false &&
  wake.isQuietAt(at(23, 30), { quietStart: prefixedConfig.wakeQuietStart, quietEnd: prefixedConfig.wakeQuietEnd }) === true
check('isQuietAt: half-open quiet windows, and prefixed config names must be mapped to bare names',
  quietOk && noonOk && malformedOk && prefixedMaps,
  `23:00-08:00 at 22:59/23:00/00:00/07:59/08:00/12:00 => ${quietActual.join(',')}; prefixed object as-is never quiet (silent-failure shape)`)

const delayAt = (random, everyMinutes = 90) => wake.nextWakeDelayMs({
  now: at(10, 0), everyMinutes, jitterMinutes: 20, ...quietWindow, random: () => random,
})
const delayLow = delayAt(0)
const delayMid = delayAt(0.5)
const delayHigh = delayAt(0.999999)
const inBand = delayLow === 70 * MINUTE && delayMid === 90 * MINUTE && Math.abs(delayHigh - 110 * MINUTE) <= 5
const floorOk = wake.nextWakeDelayMs({
  now: at(10, 0), everyMinutes: 0.2, jitterMinutes: 0, ...quietWindow, random: () => 0.5,
}) === wake.MIN_WAKE_DELAY_MS
const zeroJitterSizes = new Set([0, 0.25, 0.5, 0.99].map((random) => wake.nextWakeDelayMs({
  now: at(10, 0), everyMinutes: 90, jitterMinutes: 0, ...quietWindow, random: () => random,
}))).size
check('nextWakeDelayMs: every ± jitter, injectable random, deterministic at jitter 0, never below 60s',
  inBand && floorOk && zeroJitterSizes === 1,
  `random 0/0.5/~1 => ${delayLow / MINUTE}/${delayMid / MINUTE}/${(delayHigh / MINUTE).toFixed(3)} min; floor=${wake.MIN_WAKE_DELAY_MS / 1000}s; jitter-0 outputs=${zeroJitterSizes}`)

const quietPush = (now, everyMinutes, window = quietWindow) => wake.nextWakeDelayMs({
  now, everyMinutes, jitterMinutes: 0, ...window, random: () => 0.5,
})
const wrapPush = quietPush(at(22, 50), 15)
const crossPush = quietPush(at(23, 30), 15)
const noonPush = quietPush(at(11, 50), 10, noonWindow)
check('a target inside the quiet window is pushed to the first quiet-end after it',
  wrapPush === 550 * MINUTE && crossPush === 510 * MINUTE && noonPush === 130 * MINUTE,
  `22:50+15m => ${clockText(at(22, 50).getTime() + wrapPush)} (${wrapPush / MINUTE}m); ` +
  `23:30+15m => ${clockText(at(23, 30).getTime() + crossPush)} (${crossPush / MINUTE}m); ` +
  `11:50+10m into 12:00-14:00 => ${clockText(at(11, 50).getTime() + noonPush)} (${noonPush / MINUTE}m)`)

let scanOk = true
let scanDetail = '48 half-hour instants scanned; no target landed in 23:00-08:00'
for (let step = 0; step < 48 && scanOk; step++) {
  const now = new FixedDate(2026, 9, 26, 0, 0, 0, 0).getTime() + step * 30 * MINUTE
  const delay = wake.nextWakeDelayMs({ now, everyMinutes: 15, jitterMinutes: 20, ...quietWindow, random: () => 0.5 })
  const target = now + delay
  if (!(delay >= wake.MIN_WAKE_DELAY_MS && target > now && !wake.isQuietAt(target, quietWindow))) {
    scanOk = false
    scanDetail = `step ${step}: now=${clockText(now)} delay=${delay / MINUTE}m target=${clockText(target)} quiet=${wake.isQuietAt(target, quietWindow)}`
  }
}
const nextDayWake = (hours, minutes, jitter = 0, random = 0.5) => wake.msUntilNextDayWake({
  now: at(hours, minutes), quietEnd: '08:00', jitterMinutes: jitter, random: () => random,
})
const tomorrow = nextDayWake(7, 0) === 60 * MINUTE &&
  nextDayWake(8, 0) === 24 * 60 * MINUTE &&
  nextDayWake(9, 0) === 23 * 60 * MINUTE &&
  nextDayWake(22, 50, 20) === 560 * MINUTE &&
  wake.msUntilNextDayWake({ now: at(7, 0), quietEnd: 'oops', jitterMinutes: 0, random: () => 0.5 }) === 60 * MINUTE
check('wake targets never land in the quiet window; an exhausted day returns the next quiet-end',
  scanOk && tomorrow,
  `${scanOk ? scanDetail : scanDetail}; 07:00/08:00/09:00 => ${nextDayWake(7, 0) / MINUTE}/${nextDayWake(8, 0) / MINUTE}/${nextDayWake(9, 0) / MINUTE}m; 22:50+jitter => ${nextDayWake(22, 50, 20) / MINUTE}m; malformed quietEnd falls back to 08:00`)

// ---- 9b. Arming: only after turn/end, exactly once -------------------------
setClock(10, 0)
const armState = wakeCtx()
mod.apply(armState.root, { lifeId: 'wake-arm' })
const armStore = new LifeStore({ lifeId: 'wake-arm' })
const armBefore = { creates: armState.calls.create.length, nextAt: armStore.readWake().nextAt }
armState.emit('session/event', sessionOf('arm-session'), { type: 'turn/end', time: clockNow, data: { turn: 1, reason: { kind: 'completed' } } })
await waitFor(() => armState.calls.create.length > 0)
const armCall = armState.calls.create[0] || {}
const armWakeState = armStore.readWake()
const armExpectedAt = new RealDate(clockNow + 5400 * 1000).toISOString()
check('a turn/end arms exactly one alarm with the agreed title, prompt and a visible delay',
  armBefore.creates === 0 && armBefore.nextAt === null &&
  armState.calls.create.length === 1 &&
  armCall.after_seconds === 5400 &&
  armCall.title === '自主唤醒' &&
  armCall.prompt === ConfigDefaults.wakePrompt &&
  armCall.sessionId === 'arm-session' &&
  armWakeState.scheduleId === 'schedule-1' &&
  armWakeState.nextAt === armExpectedAt,
  `before turn/end: creates=${armBefore.creates} nextAt=${armBefore.nextAt}; after: creates=${armState.calls.create.length}, ` +
  `after_seconds=${armCall.after_seconds} (${(armCall.after_seconds || 0) / 60}m), title=${JSON.stringify(armCall.title)}, ` +
  `prompt=${JSON.stringify(String(armCall.prompt || '').slice(0, 20))}..., nextAt=${armWakeState.nextAt}`)

setClock(23, 30)
const quietState = wakeCtx()
mod.apply(quietState.root, { lifeId: 'wake-quiet' })
quietState.emit('session/event', sessionOf('quiet-session'), { type: 'turn/end', time: clockNow, data: { turn: 1 } })
await waitFor(() => quietState.calls.create.length > 0)
const quietArmCall = quietState.calls.create[0] || {}
const quietTarget = clockNow + (quietArmCall.after_seconds || 0) * 1000
check('a turn/end inside the quiet window arms after the quiet end, not 90 minutes later',
  quietArmCall.after_seconds === 31200 &&
  !wake.isQuietAt(new FixedDate(quietTarget), quietWindow) &&
  clockText(quietTarget) === '08:10',
  `after_seconds=${quietArmCall.after_seconds} (${(quietArmCall.after_seconds || 0) / 60}m), target=${clockText(quietTarget)}, quiet=${wake.isQuietAt(new FixedDate(quietTarget), quietWindow)}`)

const listsBeforeDedupe = quietState.calls.list.length
quietState.emit('session/event', sessionOf('quiet-session'), { type: 'turn/end', time: clockNow, data: { turn: 2 } })
await waitFor(() => quietState.calls.list.length > listsBeforeDedupe)
check('a second turn/end does not create a second alarm while the Host still lists ours',
  quietState.calls.create.length === 1 &&
  quietState.calls.list.length > listsBeforeDedupe &&
  quietState.calls.list[quietState.calls.list.length - 1].sessionId === 'quiet-session',
  `create=${quietState.calls.create.length}, list=${quietState.calls.list.length}, last list sessionId=${quietState.calls.list[quietState.calls.list.length - 1]?.sessionId}`)

// Proven by docs/wake-e2e.md: a delivered one-shot becomes inactive and
// `schedule.list()` returns nothing, so the next turn must arm a fresh alarm
// rather than believing the old one is still pending.
quietState.tasks = []
const createsBeforeRerArm = quietState.calls.create.length
quietState.emit('session/event', sessionOf('quiet-session'), { type: 'turn/end', time: clockNow, data: { turn: 3 } })
await waitFor(() => quietState.calls.create.length > createsBeforeRerArm)
const quietStoreAfter = new LifeStore({ lifeId: 'wake-quiet' })
check('after a one-shot is delivered (list is empty) the next turn/end arms a new alarm',
  quietState.calls.create.length === createsBeforeRerArm + 1 && quietStoreAfter.readWake().scheduleId === 'schedule-2',
  `create=${quietState.calls.create.length} (was ${createsBeforeRerArm}), remembered scheduleId=${quietStoreAfter.readWake().scheduleId}`)

setClock(10, 0)
const budgetState = wakeCtx()
mod.apply(budgetState.root, { lifeId: 'wake-budget' })
const budgetStore = new LifeStore({ lifeId: 'wake-budget' })
budgetStore.updateWake({ dayKey: wake.dayKeyOf(new RealDate(clockNow)), countToday: ConfigDefaults.wakeMaxPerDay })
budgetState.emit('session/event', sessionOf('budget-session'), { type: 'turn/end', time: clockNow, data: { turn: 1 } })
await waitFor(() => budgetState.calls.create.length > 0)
const budgetCall = budgetState.calls.create[0] || {}
const budgetTarget = clockNow + (budgetCall.after_seconds || 0) * 1000
check('an exhausted daily budget arms tomorrow\'s first wake instead of retrying in 90 minutes',
  budgetCall.after_seconds === 79800 &&
  budgetCall.after_seconds > 3600 &&
  clockText(budgetTarget) === '08:10',
  `after_seconds=${budgetCall.after_seconds} (${((budgetCall.after_seconds || 0) / 3600).toFixed(2)}h), target=${clockText(budgetTarget)}`)

// ---- 9c. Wake accounting and the wake-specific prompt context --------------
setClock(10, 0)
const accountState = wakeCtx()
mod.apply(accountState.root, { lifeId: 'wake-account' })
const accountStore = new LifeStore({ lifeId: 'wake-account' })
const accountSectionText = () =>
  accountState.sections[0]?.text?.({ agent: { session: sessionOf('account-session') } }) || ''
const wakesIn = () => accountStore.readLedger({ limit: 500 }).filter((entry) => entry.kind === 'wake')
const turnsIn = () => accountStore.readLedger({ limit: 500 }).filter((entry) => entry.kind === 'turn')
const beforeWakeText = accountSectionText()
accountState.emit('session/event', sessionOf('account-session'), { type: 'user/message', time: clockNow, data: scheduleMessage('message-1') })
const wakeState1 = accountStore.readWake()
const wakeText = accountSectionText()
accountState.emit('session/event', sessionOf('account-session'), { type: 'turn/end', time: clockNow, data: { turn: 1, reason: { kind: 'completed' } } })
const firstTurn = turnsIn()[turnsIn().length - 1]
const afterWakeText = accountSectionText()
check('a schedule message records one wake, spends budget once, and labels its own turn and prompt',
  beforeWakeText.includes('这一轮是你自己醒来的') === false &&
  wakesIn().length === 1 &&
  wakesIn()[0].detail?.messageId === 'message-1' &&
  wakeState1.countToday === 1 &&
  wakeState1.sessionId === 'account-session' &&
  wakeText.includes('这一轮是你自己醒来的，没有人跟你说话。') &&
  firstTurn?.detail?.woke === true &&
  afterWakeText.includes('这一轮是你自己醒来的') === false,
  `wake rows=${wakesIn().length}, countToday=${wakeState1.countToday}, woke=${firstTurn?.detail?.woke}, ` +
  `prompt wake framing before/during/after=${beforeWakeText.includes('这一轮')}/${wakeText.includes('这一轮')}/${afterWakeText.includes('这一轮')}`)

const wakeRowsBeforeDup = wakesIn().length
const countBeforeDup = accountStore.readWake().countToday
accountState.emit('session/event', sessionOf('account-session'), { type: 'user/message', time: clockNow, data: scheduleMessage('message-1') })
const wakeRowsAfterDup = wakesIn().length
const countAfterDup = accountStore.readWake().countToday
accountState.emit('session/event', sessionOf('account-session'), { type: 'turn/end', time: clockNow, data: { turn: 2, reason: { kind: 'completed' } } })
const duplicateWoke = turnsIn()[turnsIn().length - 1]?.detail?.woke
check('a re-delivered messageId is recorded once and consumes one budget slot',
  wakeRowsAfterDup === wakeRowsBeforeDup && countAfterDup === countBeforeDup && duplicateWoke === true,
  `wake rows=${wakeRowsAfterDup} (before ${wakeRowsBeforeDup}), countToday=${countAfterDup} (before ${countBeforeDup}); the duplicate still labels its own turn woke=${duplicateWoke}`)

accountState.emit('session/event', sessionOf('account-session'), { type: 'user/message', time: clockNow, data: keeperMessage('keeper-1') })
const keeperWakeRows = wakesIn().length
const keeperText = accountSectionText()
accountState.emit('session/event', sessionOf('account-session'), { type: 'turn/end', time: clockNow, data: { turn: 3, reason: { kind: 'completed' } } })
const keeperWoke = turnsIn()[turnsIn().length - 1]?.detail?.woke
check('the keeper speaking is not a wake: no wake row, no budget spend, woke=false, no wake framing',
  keeperWakeRows === 1 &&
  accountStore.readWake().countToday === 1 &&
  keeperText.includes('这一轮是你自己醒来的') === false &&
  keeperWoke === false,
  `wake rows=${keeperWakeRows}, countToday=${accountStore.readWake().countToday}, woke=${keeperWoke}, keeper prompt wake framing=${keeperText.includes('这一轮')}`)

// ---- 9d. Degradation without the schedule service --------------------------
setClock(10, 0)
const degradedState = wakeCtx({ withSchedule: false })
mod.apply(degradedState.root, { lifeId: 'wake-degraded' })
const degradedShapeOk = degradedState.warnings.length === 0 &&
  degradedState.tools.length === declaredTools.length &&
  degradedState.sections.length === 1
degradedState.emit('session/event', sessionOf('degraded-session'), { type: 'turn/end', time: clockNow, data: { turn: 1 } })
degradedState.emit('session/event', sessionOf('degraded-session'), { type: 'turn/end', time: clockNow, data: { turn: 2 } })
const noServiceInfos = degradedState.infos.filter((message) => message.includes('没有 schedule 服务'))
check('without the schedule service the plugin still registers everything, warns zero times, and says it once with info',
  degradedShapeOk && degradedState.warnings.length === 0 && noServiceInfos.length === 1,
  `warnings=${degradedState.warnings.length}, tools=${degradedState.tools.length}, sections=${degradedState.sections.length}, no-service info x${noServiceInfos.length}`)

// ---- 9e. The life_wake tool ------------------------------------------------
setClock(10, 0)
const toolState = wakeCtx({
  tasks: [
    { id: 'schedule-stale', title: '自主唤醒' },
    { id: 'schedule-other', title: '主人的提醒' },
  ],
})
mod.apply(toolState.root, { lifeId: 'wake-tool' })
const lifeWake = toolOf(toolState, 'life_wake')
const lifeWakeSchema = Object.keys(lifeWake?.parameters?.properties || {}).sort().join(',')
let missingTimingError = ''
try {
  await lifeWake.execute({}, { agent: { session: sessionOf('tool-session') } })
} catch (err) {
  missingTimingError = String(err.message)
}
const toolStore = new LifeStore({ lifeId: 'wake-tool' })
const normalWake = await lifeWake.execute({ afterMinutes: 45 }, { agent: { session: sessionOf('tool-session') } })
const normalWakeCall = toolState.calls.create[toolState.calls.create.length - 1] || {}
const deletedIds = toolState.calls.delete.map((call) => call.id)
check('life_wake is registered, validates timing, honours afterMinutes, and replaces only our pending alarm',
  Boolean(lifeWake) &&
  lifeWakeSchema === 'afterMinutes,at' &&
  missingTimingError.includes('life/wake-requires-timing') &&
  normalWake.delaySeconds === 2700 &&
  normalWake.shiftedForQuiet === false &&
  normalWakeCall.after_seconds === 2700 &&
  normalWakeCall.title === '自主唤醒' &&
  String(normalWake.message).includes('45') &&
  deletedIds.length === 1 &&
  deletedIds[0] === 'schedule-stale' &&
  toolStore.readWake().scheduleId === 'schedule-1',
  `schema=${lifeWakeSchema}, missingTiming=${missingTimingError.split(':')[0]}, after_seconds=${normalWakeCall.after_seconds}, ` +
  `deleted=${JSON.stringify(deletedIds)} (unrelated task kept=${toolState.tasks.some((task) => task.id === 'schedule-other')}), message=${normalWake.message}`)

// The regression assertion for the fixed bug: `settings` uses prefixed field
// names, so passing it straight to isQuietAt() read undefined and silently
// disabled quiet hours. A 23:30 request for +5m must land at 08:00, not 23:35.
setClock(23, 30)
const shiftState = wakeCtx()
mod.apply(shiftState.root, { lifeId: 'wake-shift' })
const shiftWake = await toolOf(shiftState, 'life_wake').execute({ afterMinutes: 5 }, { agent: { session: sessionOf('shift-session') } })
const shiftCall = shiftState.calls.create[0] || {}
const shiftTarget = clockNow + (shiftCall.after_seconds || 0) * 1000
check('life_wake requested inside the quiet window is shifted to the quiet end (catches the prefixed-field bug)',
  shiftWake.shiftedForQuiet === true &&
  shiftWake.delaySeconds === 30600 &&
  shiftCall.after_seconds === 30600 &&
  clockText(shiftTarget) === '08:00' &&
  String(shiftWake.message).includes('静默'),
  `shiftedForQuiet=${shiftWake.shiftedForQuiet}, after_seconds=${shiftCall.after_seconds} (${((shiftCall.after_seconds || 0) / 3600).toFixed(2)}h), ` +
  `target=${clockText(shiftTarget)}, message=${shiftWake.message}`)

const unavailableState = wakeCtx({ withSchedule: false })
mod.apply(unavailableState.root, { lifeId: 'wake-tool-unavailable' })
let unavailableError = ''
try {
  await toolOf(unavailableState, 'life_wake').execute({ afterMinutes: 5 }, { agent: { session: sessionOf('unavailable-session') } })
} catch (err) {
  unavailableError = String(err.message)
}
const spentBudgetState = wakeCtx()
mod.apply(spentBudgetState.root, { lifeId: 'wake-tool-spent' })
const spentBudgetStore = new LifeStore({ lifeId: 'wake-tool-spent' })
spentBudgetStore.updateWake({ dayKey: wake.dayKeyOf(new RealDate(clockNow)), countToday: ConfigDefaults.wakeMaxPerDay })
let spentBudgetError = ''
try {
  await toolOf(spentBudgetState, 'life_wake').execute({ afterMinutes: 10 }, { agent: { session: sessionOf('spent-session') } })
} catch (err) {
  spentBudgetError = String(err.message)
}
check('life_wake degrades with an explicit error when the service is absent or the budget is spent',
  unavailableError.includes('life/schedule-unavailable') &&
  spentBudgetError.includes('life/wake-budget-exhausted') &&
  spentBudgetState.calls.create.length === 0,
  `no-service=${unavailableError || 'no error'}; budget=${spentBudgetError || 'no error'}; budget creates=${spentBudgetState.calls.create.length}`)

// ---------------------------------------------------------------------------
// 9f. Multi-day soak: deterministic simulation of the 7-day decision gate
//
// docs/PLAN.md §10.2 asks for seven unattended days. Waiting seven days is not
// possible, but the schedule policy is a pure function of the clock and one
// random source, so a pinned clock plus a seeded PRNG reproduces it exactly.
// Every simulated delivery drives the REAL plugin wiring: the recording fake
// Host arms a one-shot, the clock jumps to its due time, the wake arrives as a
// `source.kind === 'schedule'` message, and `turn/end` lets the plugin re-arm.
// The fake Host also models what docs/wake-e2e.md measured: a delivered
// one-shot becomes inactive, so `list()` no longer returns it.
// ---------------------------------------------------------------------------
function mulberry32 (seed) {
  let state = seed >>> 0
  return function random () {
    state = (state + 0x6D2B79F5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const SOAK_ORIGIN = new FixedDate(2026, 9, 26, 0, 0, 0, 0).getTime()
const SOAK_DAY_MS = 24 * 60 * MINUTE
const soakDayIndex = (value) => Math.floor((value - SOAK_ORIGIN) / SOAK_DAY_MS)
const minutesOfDay = (value) => {
  const date = new FixedDate(value)
  return date.getHours() * 60 + date.getMinutes()
}
const clockOfMinutes = (minutes) =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`

async function runSoak ({ lifeId, seed, config = {}, days, startHour = 8 }) {
  const effective = { ...ConfigDefaults, ...config }
  clockNow = new FixedDate(2026, 9, 26, startHour, 0, 0, 0).getTime()
  Math.random = mulberry32(seed)
  const state = wakeCtx()
  mod.apply(state.root, { lifeId, ...config })
  const store = new LifeStore({ lifeId })
  const session = sessionOf(`soak-${lifeId}`)
  const deliveries = []
  const armed = []
  const consumed = new Set()
  const dayCounts = new Map()
  const violations = { quiet: [], interval: [], dayKey: [], count: [], rearm: [] }
  const quietWindowNow = {
    quietStart: effective.wakeQuietStart,
    quietEnd: effective.wakeQuietEnd,
  }

  const turnEnd = (turn) => state.emit('session/event', session, {
    type: 'turn/end',
    time: clockNow,
    data: { turn, reason: { kind: 'completed' } },
  })

  turnEnd(0)
  if (!await waitFor(() => state.calls.create.length > 0)) {
    violations.rearm.push('no first alarm after the keeper turn')
  }

  let guard = 0
  while (guard++ < 500) {
    const call = state.calls.create[state.calls.create.length - 1]
    if (!call) break
    const target = clockNow + call.after_seconds * 1000
    const dayIndex = soakDayIndex(target)
    if (dayIndex > days) break
    const fromDayIndex = soakDayIndex(clockNow)
    armed.push({ id: call.id, afterSeconds: call.after_seconds, now: clockNow, target, dayIndex })
    consumed.add(call.id)
    if (wake.isQuietAt(new FixedDate(target), quietWindowNow)) {
      violations.quiet.push(`day${dayIndex} ${clockText(target)}`)
    }
    const previous = deliveries[deliveries.length - 1]
    if (previous) {
      const gap = target - previous.at
      if (!(gap >= wake.MIN_WAKE_DELAY_MS)) {
        violations.interval.push(`day${dayIndex} ${clockText(previous.at)} -> ${clockText(target)} = ${(gap / 1000).toFixed(3)}s`)
      }
    }
    clockNow = target
    // Real dsh makes a delivered one-shot inactive; see docs/wake-e2e.md.
    state.tasks = state.tasks.filter((task) => task.id !== call.id)
    state.emit('session/event', session, {
      type: 'user/message',
      time: clockNow,
      data: { id: `${lifeId}-${deliveries.length}`, source: { kind: 'schedule' } },
    })
    const wakeAfter = store.readWake()
    const dayKey = wake.dayKeyOf(new FixedDate(target))
    const countSoFar = (dayCounts.get(dayIndex) || 0) + 1
    dayCounts.set(dayIndex, countSoFar)
    if (wakeAfter.dayKey !== dayKey) {
      violations.dayKey.push(`day${dayIndex}: dayKey=${wakeAfter.dayKey}, expected ${dayKey}`)
    }
    if (wakeAfter.countToday !== countSoFar) {
      violations.count.push(`day${dayIndex} wake#${countSoFar}: countToday=${wakeAfter.countToday}`)
    }
    deliveries.push({
      at: target,
      dayIndex,
      fromDayIndex,
      dayKey,
      afterSeconds: call.after_seconds,
      countToday: wakeAfter.countToday,
    })
    if (dayIndex === days) break
    turnEnd(deliveries.length)
    const beforeCreates = state.calls.create.length
    if (!await waitFor(() => state.calls.create.length > beforeCreates)) {
      violations.rearm.push(`no re-arm after day${dayIndex} ${clockText(target)}`)
      break
    }
  }

  for (const call of state.calls.create) {
    if (consumed.has(call.id)) continue
    const target = clockNow + call.after_seconds * 1000
    armed.push({ id: call.id, afterSeconds: call.after_seconds, now: clockNow, target, dayIndex: soakDayIndex(target) })
  }

  return {
    lifeId,
    seed,
    config: effective,
    quietWindow: quietWindowNow,
    quietStartMinute: wake.parseClock(effective.wakeQuietStart),
    deliveries,
    armed,
    dayCounts,
    violations,
  }
}

const soakDayText = (run, dayList) => dayList.map((day) => {
  const rows = run.deliveries.filter((row) => row.dayIndex === day)
  if (!rows.length) return `day${day}=0`
  return `day${day}=${rows.length} (${clockText(rows[0].at)}-${clockText(rows[rows.length - 1].at)})`
}).join(' | ')

/** First value that makes an armed delay untrustworthy, or null. */
function soakArmedProblem (run) {
  const every = run.config.wakeEveryMinutes
  const jitter = run.config.wakeJitterMinutes
  const earliestDirect = Math.max(60, (every - jitter) * 60)
  const latestDirect = (every + jitter) * 60
  const quietEnd = wake.parseClock(run.config.wakeQuietEnd)
  for (const row of run.armed) {
    if (!Number.isFinite(row.afterSeconds) || !Number.isInteger(row.afterSeconds) || row.afterSeconds < 60) {
      return `${run.lifeId} ${clockText(row.now)}: after_seconds=${row.afterSeconds}`
    }
    if (!(row.target > row.now)) {
      return `${run.lifeId} ${clockText(row.now)}: target ${clockText(row.target)} is not in the future`
    }
    const sameDay = row.dayIndex === soakDayIndex(row.now)
    if (sameDay) {
      if (row.afterSeconds < earliestDirect || row.afterSeconds > latestDirect) {
        return `${run.lifeId} ${clockText(row.now)}: same-day after_seconds=${row.afterSeconds}s ` +
          `(${(row.afterSeconds / 60).toFixed(1)}m), expected ${(earliestDirect / 60).toFixed(0)}..${(latestDirect / 60).toFixed(0)}m`
      }
      continue
    }
    const targetMinute = minutesOfDay(row.target)
    const direct = row.afterSeconds >= earliestDirect && row.afterSeconds <= latestDirect
    const quietPushed = targetMinute >= quietEnd && targetMinute < quietEnd + jitter
    // Post-fix behaviour: a quiet push that would skip a whole calendar day is
    // clamped to quietStart-1min of the first skipped day (e.g. 22:59).
    const clamped = run.quietStartMinute > 0 &&
      targetMinute === run.quietStartMinute - 1 &&
      row.dayIndex === soakDayIndex(row.now) + 1
    if (!direct && !quietPushed && !clamped) {
      return `${run.lifeId} ${clockText(row.now)}: rollover after_seconds=${row.afterSeconds}s ` +
        `target=${clockText(row.target)} (neither every±jitter, quiet-end+jitter, nor the clamped 22:59)`
    }
    if (!(row.afterSeconds > 3600)) {
      return `${run.lifeId} ${clockText(row.now)}: rollover after_seconds=${row.afterSeconds}s <= 1h`
    }
  }
  return null
}

const defaultSoak = await runSoak({ lifeId: 'soak-default', seed: 20261026, days: 7 })
const crowdedSoak = await runSoak({ lifeId: 'soak-crowded', seed: 7, config: { wakeMaxPerDay: 14 }, days: 7 })
// Same two profiles under the seeds the keeper named for the "next-day shift"
// regression. Their pre-fix wake sequences are pinned as digests below.
const defaultSoak60 = await runSoak({ lifeId: 'soak-default-60', seed: 60, days: 7 })
const defaultSoak42 = await runSoak({ lifeId: 'soak-default-42', seed: 42, days: 7 })
const crowdedSoak60 = await runSoak({ lifeId: 'soak-crowded-60', seed: 60, config: { wakeMaxPerDay: 14 }, days: 7 })
const crowdedSoak42 = await runSoak({ lifeId: 'soak-crowded-42', seed: 42, config: { wakeMaxPerDay: 14 }, days: 7 })
// The extreme profile the keeper asked for: "wake about once a day", with the
// widest jitter. Nine days are simulated, but only days 1..7 are asserted here;
// the day-8 boundary is reported separately (see docs/wake-verification.md).
const extremeSoak = await runSoak({
  lifeId: 'soak-extreme',
  seed: 60,
  config: { wakeEveryMinutes: 1440, wakeJitterMinutes: 240 },
  days: 9,
})
const extremeSoak42 = await runSoak({
  lifeId: 'soak-extreme-42',
  seed: 42,
  config: { wakeEveryMinutes: 1440, wakeJitterMinutes: 240 },
  days: 9,
})
const soakRuns = [
  defaultSoak, crowdedSoak, defaultSoak60, defaultSoak42,
  crowdedSoak60, crowdedSoak42, extremeSoak, extremeSoak42,
]
const soakCounts = (run, dayList) => dayList.map((day) => run.dayCounts.get(day) || 0)

const defaultDays = soakCounts(defaultSoak, [0, 1, 2, 3, 4, 5, 6])
const defaultNextDay = defaultSoak.dayCounts.get(7) || 0
const defaultRollovers = defaultSoak.deliveries.filter((row) => row.dayIndex > row.fromDayIndex)
check('7-day soak (defaults 90m±20m, 6/day): every day wakes, stays within budget, and reconnects to the next morning',
  defaultDays.every((count) => count >= 1 && count <= defaultSoak.config.wakeMaxPerDay) &&
  defaultNextDay >= 1 &&
  defaultRollovers.length === 7 &&
  defaultRollovers.every((row) => defaultDays[row.fromDayIndex] === defaultSoak.config.wakeMaxPerDay),
  `${soakDayText(defaultSoak, [0, 1, 2, 3, 4, 5, 6])} | first-of-day7=${defaultNextDay}; ` +
  `rollovers=${defaultRollovers.length}/7, all from a spent day`)

const soakQuietViolations = soakRuns.flatMap((run) => run.violations.quiet)
const soakIntervalViolations = soakRuns.flatMap((run) => run.violations.interval)
const soakGaps = soakRuns.flatMap((run) => run.deliveries.slice(1).map((row, index) => row.at - run.deliveries[index].at))
const soakMinGap = soakGaps.length ? Math.min(...soakGaps) : 0
const soakDeliveryCount = soakRuns.reduce((sum, run) => sum + run.deliveries.length, 0)
const soakRearmViolations = soakRuns.flatMap((run) => run.violations.rearm)
check('soak (8 runs): no wake lands in the quiet window, no two wakes are under 60s apart, and every turn re-arms',
  soakQuietViolations.length === 0 && soakIntervalViolations.length === 0 && soakRearmViolations.length === 0,
  `${soakDeliveryCount} wakes checked; quiet=${soakQuietViolations.length}` +
  `${soakQuietViolations.length ? ` [${soakQuietViolations.slice(0, 2).join('; ')}]` : ''}; ` +
  `interval=${soakIntervalViolations.length}${soakIntervalViolations.length ? ` [${soakIntervalViolations.slice(0, 2).join('; ')}]` : ''}; ` +
  `re-arm=${soakRearmViolations.length}${soakRearmViolations.length ? ` [${soakRearmViolations.slice(0, 2).join('; ')}]` : ''}; ` +
  `min gap=${(soakMinGap / 1000).toFixed(1)}s`)

const soakDayKeyViolations = soakRuns.flatMap((run) => run.violations.dayKey)
const soakCountViolations = soakRuns.flatMap((run) => run.violations.count)
check('soak (8 runs): dayKey resets at midnight and countToday never accumulates across days',
  soakDayKeyViolations.length === 0 && soakCountViolations.length === 0,
  `${soakDeliveryCount} deliveries checked; dayKey=${soakDayKeyViolations.length}` +
  `${soakDayKeyViolations.length ? ` [${soakDayKeyViolations.slice(0, 2).join('; ')}]` : ''}; ` +
  `countToday=${soakCountViolations.length}${soakCountViolations.length ? ` [${soakCountViolations.slice(0, 2).join('; ')}]` : ''}`)

const soakArmedProblems = soakRuns
  .map((run) => ({ lifeId: run.lifeId, problem: soakArmedProblem(run) }))
  .filter((row) => row.problem)
const soakArmedValues = soakRuns.flatMap((run) => run.armed.map((row) => row.afterSeconds))
check('soak (8 runs): every armed delay is a finite integer ≥60s, same-day targets are every±jitter, rollovers are quiet-end or the same interval',
  soakArmedProblems.length === 0,
  `${soakArmedValues.length} alarms checked; after_seconds ${Math.min(...soakArmedValues)}..${Math.max(...soakArmedValues)}s` +
  `${soakArmedProblems.length ? `; ${soakArmedProblems.map((row) => row.problem).slice(0, 2).join(' | ')}` : ''}`)

check('soak: spending the daily budget books tomorrow just after quiet-end — never a 15-minute retry and never a lost day',
  defaultRollovers.length === 7 &&
  defaultRollovers.every((row) =>
    row.afterSeconds > 3600 &&
    minutesOfDay(row.at) >= 8 * 60 &&
    minutesOfDay(row.at) < 8 * 60 + defaultSoak.config.wakeJitterMinutes),
  defaultRollovers.map((row) =>
    `day${row.fromDayIndex}->${row.dayIndex}: ${(row.afterSeconds / 3600).toFixed(2)}h -> ${clockText(row.at)} ` +
    `(count=${defaultDays[row.fromDayIndex]}/${defaultSoak.config.wakeMaxPerDay})`).join('; '))

const crowdedDays = soakCounts(crowdedSoak, [0, 1, 2, 3, 4, 5, 6])
const crowdedNextDay = crowdedSoak.dayCounts.get(7) || 0
const crowdedRollovers = crowdedSoak.deliveries.filter((row) => row.dayIndex > row.fromDayIndex)
check('soak (crowded 14/day, budget never spent): the quiet push still carries the life into the next morning, every day',
  crowdedDays.every((count) => count >= 1 && count <= crowdedSoak.config.wakeMaxPerDay) &&
  crowdedNextDay >= 1 &&
  crowdedRollovers.length === 7 &&
  crowdedRollovers.every((row) => crowdedDays[row.fromDayIndex] < crowdedSoak.config.wakeMaxPerDay),
  `${soakDayText(crowdedSoak, [0, 1, 2, 3, 4, 5, 6])} | first-of-day7=${crowdedNextDay}; ` +
  `rollovers=${crowdedRollovers.length}/7, all quiet-pushed (previous day below budget)`)

const extremeDays = soakCounts(extremeSoak, [1, 2, 3, 4, 5, 6, 7])
const extremeDay0 = extremeSoak.dayCounts.get(0) || 0
const extremeDay8 = extremeSoak.dayCounts.get(8) || 0
const extreme42Days = soakCounts(extremeSoak42, [1, 2, 3, 4, 5, 6, 7])
const extreme42Day8 = extremeSoak42.dayCounts.get(8) || 0
check('soak (extreme 1440m±240m, seeds 60 and 42): the setup day is empty by construction, but each of the following seven days gets its wake',
  extremeDay0 === 0 &&
  extremeSoak.deliveries[0]?.dayIndex === 1 &&
  extremeDays.every((count) => count >= 1 && count <= extremeSoak.config.wakeMaxPerDay) &&
  extremeDay8 >= 1 &&
  extremeSoak42.deliveries[0]?.dayIndex === 1 &&
  extreme42Days.every((count) => count >= 1 && count <= extremeSoak42.config.wakeMaxPerDay) &&
  extreme42Day8 >= 1,
  `seed60 day0=${extremeDay0} (first interval 20–28h) | ${soakDayText(extremeSoak, [1, 2, 3, 4, 5, 6, 7, 8])}; ` +
  `seed42 | ${soakDayText(extremeSoak42, [1, 2, 3, 4, 5, 6, 7, 8])}`)

const soakNoSkipFailures = soakRuns.flatMap((run) =>
  run.deliveries.slice(1)
    .map((row, index) => ({ run, row, previous: run.deliveries[index] }))
    .filter(({ row, previous }) => row.dayIndex - previous.dayIndex > 1)
    .map(({ run, row, previous }) =>
      `${run.lifeId}: day${previous.dayIndex} ${clockText(previous.at)} -> day${row.dayIndex} ${clockText(row.at)} ` +
      `(skipped ${row.dayIndex - previous.dayIndex - 1} day(s))`))
const soakMaxDayGap = Math.max(...soakRuns.flatMap((run) =>
  run.deliveries.slice(1).map((row, index) => row.dayIndex - run.deliveries[index].dayIndex)))
check('soak: no quiet push ever skips a whole local calendar day (adjacent wake day index differs by at most 1)',
  soakNoSkipFailures.length === 0,
  soakNoSkipFailures.length
    ? soakNoSkipFailures.slice(0, 3).join(' | ')
    : `max adjacent day-index gap=${soakMaxDayGap} over ${soakRuns.length} runs; extreme seed60 day8 is the clamped 22:59 wake`)

// Pre-fix golden sequences: the day-skip fix must not change any sequence whose
// quiet push already lands on the very next calendar day (the keeper's red
// line). Digests are over `d<dayIndex>@HH:MM` joined with commas, captured from
// the implementation BEFORE the clamp existed.
const soakSequence = (run) => run.deliveries.map((row) => `d${row.dayIndex}@${clockText(row.at)}`).join(',')
const soakDigest = (run) => createHash('sha256').update(soakSequence(run)).digest('hex').slice(0, 16)
const soakGoldens = [
  { name: 'default/20261026', run: defaultSoak, digest: '0ac8e508f4046d11', count: 43 },
  { name: 'default/60', run: defaultSoak60, digest: '430e83ff82a1c958', count: 43 },
  { name: 'default/42', run: defaultSoak42, digest: 'a0e9271f01ea1d35', count: 43 },
  { name: 'crowded/7', run: crowdedSoak, digest: '296d69cd6d8cbe0d', count: 74 },
  { name: 'crowded/60', run: crowdedSoak60, digest: 'fe8d32971632d8b3', count: 72 },
  { name: 'crowded/42', run: crowdedSoak42, digest: 'baefbbe9cd8f3dc1', count: 74 },
  { name: 'extreme/42 (pre-fix had no skip)', run: extremeSoak42, digest: '331d09ceddf3fc76', count: 9 },
]
const soakGoldenFailure = soakGoldens.find((row) =>
  soakDigest(row.run) !== row.digest || row.run.deliveries.length !== row.count)
check('soak regression: default, crowded, and non-skipping extreme sequences are byte-identical to their pre-fix golden',
  !soakGoldenFailure,
  soakGoldenFailure
    ? `${soakGoldenFailure.name}: digest=${soakDigest(soakGoldenFailure.run)} expected=${soakGoldenFailure.digest}, ` +
      `count=${soakGoldenFailure.run.deliveries.length}/${soakGoldenFailure.count}; ` +
      `first 120 chars=${soakSequence(soakGoldenFailure.run).slice(0, 120)}`
    : soakGoldens.map((row) => `${row.name}=${row.digest}(${row.count})`).join(', '))

const unitWake = ({ year, month, day, hour, minute }, every, jitter, quietStart, quietEnd, randoms) => {
  let draw = 0
  const now = new FixedDate(year, month - 1, day, hour, minute, 0, 0)
  const delay = wake.nextWakeDelayMs({
    now,
    everyMinutes: every,
    jitterMinutes: jitter,
    quietStart,
    quietEnd,
    random: () => randoms[draw++],
  })
  return { delay, target: new FixedDate(now.getTime() + delay) }
}
const nextDayShift = unitWake({ year: 2026, month: 10, day: 26, hour: 22, minute: 30 }, 90, 20, '23:00', '08:00', [0.1, 0.1])
const skipClamp = unitWake({ year: 2026, month: 11, day: 2, hour: 22, minute: 19 }, 1440, 240, '23:00', '08:00', [1, 0.5])
const midnightStart = unitWake({ year: 2026, month: 11, day: 2, hour: 22, minute: 19 }, 1440, 240, '00:00', '08:00', [1, 0.5])
const malformedQuiet = unitWake({ year: 2026, month: 11, day: 2, hour: 22, minute: 19 }, 1440, 240, 'oops', '08:00', [1, 0.5])
const clampNow = new FixedDate(2026, 10, 2, 22, 19, 0, 0)
const clampDirect = wake.clampToLastAllowedMoment({
  now: clampNow,
  targetMs: new FixedDate(2026, 10, 4, 10, 0, 0, 0).getTime(),
  quietStart: '23:00',
  quietEnd: '08:00',
})
const clampNextDay = wake.clampToLastAllowedMoment({
  now: clampNow,
  targetMs: new FixedDate(2026, 10, 3, 8, 0, 0, 0).getTime(),
  quietStart: '23:00',
  quietEnd: '08:00',
})
const clampMidnightStart = wake.clampToLastAllowedMoment({
  now: clampNow,
  targetMs: new FixedDate(2026, 10, 4, 10, 0, 0, 0).getTime(),
  quietStart: '00:00',
  quietEnd: '08:00',
})
const clampMalformed = wake.clampToLastAllowedMoment({
  now: clampNow,
  targetMs: new FixedDate(2026, 10, 4, 10, 0, 0, 0).getTime(),
  quietStart: 'oops',
  quietEnd: '08:00',
})
const expectedClamp = new FixedDate(2026, 10, 3, 22, 59, 0, 0).getTime()
check('soak regression: a next-day-only quiet shift keeps its exact pre-fix delay; a skipped day is clamped to 22:59; 00:00/malformed skip the clamp',
  nextDayShift.delay === 34320000 && clockText(nextDayShift.target.getTime()) === '08:02' &&
  skipClamp.delay === 88800000 && clockText(skipClamp.target.getTime()) === '22:59' &&
  clampDirect === expectedClamp &&
  clampNextDay === new FixedDate(2026, 10, 3, 8, 0, 0, 0).getTime() &&
  clampMidnightStart === new FixedDate(2026, 10, 4, 10, 0, 0, 0).getTime() &&
  clampMalformed === new FixedDate(2026, 10, 4, 10, 0, 0, 0).getTime() &&
  midnightStart.delay === 128460000 && clockText(midnightStart.target.getTime()) === '10:00' &&
  malformedQuiet.delay === 100799971 && clockText(malformedQuiet.target.getTime()) === '02:18',
  `next-day shift=${nextDayShift.delay}ms target=${clockText(nextDayShift.target.getTime())}; ` +
  `skip clamp=${skipClamp.delay}ms target=${clockText(skipClamp.target.getTime())} (direct=${clockText(clampDirect)}); ` +
  `+1 target untouched=${clockText(clampNextDay)}; quietStart 00:00=${clockText(clampMidnightStart)}/` +
  `${midnightStart.delay}ms; malformed=${clockText(clampMalformed)}/${malformedQuiet.delay}ms`)

// ---------------------------------------------------------------------------
// 10. Activity chooser: ranking math and its wiring (docs/PLAN.md §6.2)
//
// The ranking is pure and `now` is injectable, so every value below is exact.
// The wiring checks then prove the same ranking reaches the wake-turn prompt
// and the life_candidates tool, and costs exactly zero characters on a keeper
// turn (that prompt is paid for on every turn).
// ---------------------------------------------------------------------------
const choose = await import(pathToFileURL(path.join(PLUGIN, 'lib', 'choose.js')).href)

clockNow = new FixedDate(2026, 9, 27, 12, 0, 0, 0).getTime()
const chooserNow = new FixedDate(2026, 9, 27, 12, 0, 0, 0)
const chooserIso = (hours) => new FixedDate(2026, 9, 27, hours, 0, 0, 0).toISOString()

// ---- 10a. Individual terms -------------------------------------------------
const urgency = (dueAt) => choose.urgencyOf({ what: '某件事', dueAt }, chooserNow)
const urgencyOverdue = urgency('2026-10-25')
const urgencyToday = urgency('2026-10-27')
const urgencyIn3Days = urgency('2026-10-30')
const urgencyNoDate = urgency(undefined)
check('chooser urgency: overdue > due today > 3 days out > no dueAt (which still scores above zero)',
  urgencyOverdue === 1 && urgencyOverdue > urgencyToday && urgencyToday > urgencyIn3Days &&
  urgencyIn3Days > urgencyNoDate && urgencyNoDate > 0,
  `overdue=${urgencyOverdue}, today=${urgencyToday.toFixed(3)}, +3d=${urgencyIn3Days.toFixed(3)}, noDate=${urgencyNoDate}`)

const freshIso = chooserIso(11)
const interestScore = (spec) => choose.interestScore(spec, chooserNow)
const freshHigh = interestScore({ topic: 't', confidence: 0.9, observations: 5, updatedAt: freshIso })
const freshLow = interestScore({ topic: 't', confidence: 0.2, observations: 5, updatedAt: freshIso })
const staleHigh = interestScore({ topic: 't', confidence: 0.9, observations: 5, updatedAt: new FixedDate(2026, 5, 1).toISOString() })
const ancientHigh = interestScore({ topic: 't', confidence: 0.9, observations: 5, updatedAt: new FixedDate(2018, 0, 1).toISOString() })
const exploreBonus2 = choose.explorationBonusOf({ observations: 2 })
const exploreBonus3 = choose.explorationBonusOf({ observations: 3 })
const oneObservation = interestScore({ topic: 't', confidence: 0.5, observations: 1, updatedAt: freshIso })
const manyObservations = interestScore({ topic: 't', confidence: 0.5, observations: 9, updatedAt: freshIso })
check('chooser interest: confident+fresh beats low/stale; 1-2 observations get a bonus; very old records keep a floor',
  freshHigh > freshLow && freshHigh > staleHigh && staleHigh > 0.4 &&
  ancientHigh > 0.4 && ancientHigh > 0 &&
  exploreBonus2 === 0.15 && exploreBonus3 === 0 &&
  oneObservation > manyObservations,
  `fresh-high=${freshHigh.toFixed(3)}, fresh-low=${freshLow.toFixed(3)}, stale-high=${staleHigh.toFixed(3)}, ` +
  `ancient=${ancientHigh.toFixed(3)}, bonus(obs2)=+${exploreBonus2}/bonus(obs3)=+${exploreBonus3}, ` +
  `1-obs=${oneObservation.toFixed(3)} vs 9-obs=${manyObservations.toFixed(3)}`)

// The exit side of exploration. `exploreBonus` rewards a topic seen once or
// twice; without a matching taper, a well-worn topic keeps out-ranking
// everything, and a seven-day run spends every wake-up on the two things it
// already knows (tools/life-week.mjs measured 30 of 31). PLAN.md §6.2 asks for
// 「适度探索」, so this is not a nice-to-have.
{
  const worn = (observations) => interestScore({ topic: 't', confidence: 0.95, observations, updatedAt: freshIso })
  const seven = worn(7)
  const eighteen = worn(18)
  const forty = worn(40)
  check('chooser familiarity taper: a well-worn topic loses pull as it is repeated, but never falls below a floor',
    seven < interestScore({ topic: 't', confidence: 0.95, observations: 6, updatedAt: freshIso }) &&
    eighteen < seven && forty <= eighteen &&
    forty > 0.3,
    `obs6=${interestScore({ topic: 't', confidence: 0.95, observations: 6, updatedAt: freshIso }).toFixed(3)}, ` +
    `obs7=${seven.toFixed(3)}, obs18=${eighteen.toFixed(3)}, obs40=${forty.toFixed(3)}`)
}

const unfinished = choose.unfinishedScore
const unfinishedFailed = unfinished({ lastFinished: { what: 'x', outcome: 'failed' } })
const unfinishedNext = unfinished({ next: { what: 'y' } })
const unfinishedDone = unfinished({ lastFinished: { what: 'x', outcome: 'done' } })
const unfinishedNone = unfinished(null)
check('chooser unfinished: failed-and-unresolved > recorded next step > last done > nothing',
  unfinishedFailed === 0.9 && unfinishedNext === 0.75 && unfinishedDone === 0.15 && unfinishedNone === 0,
  `failed=${unfinishedFailed}, next=${unfinishedNext}, done=${unfinishedDone}, none=${unfinishedNone}`)

const runningActivity = { what: '练第 38 层' }
const switchAway = choose.switchCost(runningActivity, { what: '看挖矿类小品', kind: 'interest' })
const continueSame = choose.switchCost(runningActivity, { what: '练第 38 层', kind: 'continue' })
const sameWhatNoKind = choose.switchCost(runningActivity, { what: '练第 38 层' })
const switchToRest = choose.switchCost(runningActivity, { what: '休息，什么都不做', kind: 'rest' })
const switchIdle = choose.switchCost(null, { what: '任何事', kind: 'interest' })
check('chooser switch cost: leaving a running activity costs, continuing it or resting does not',
  switchAway === 1 && continueSame === 0 && sameWhatNoKind === 0 && switchToRest === 0 && switchIdle === 0,
  `away=${switchAway}, continue=${continueSame}, sameWhat=${sameWhatNoKind}, rest=${switchToRest}, idle=${switchIdle}`)

// The other half of the §4.2 loop: the recorded next step must actually be
// *proposed*. Writing the field without this would be indistinguishable from
// the dead code this replaced.
{
  const nextRanked = choose.rankCandidates({
    now: chooserNow,
    commitments: [],
    interests: [],
    skills: [],
    activity: { current: null, next: { what: '换成 SPI 再试一次', why: 'I2C 那条路走不通' } },
    wakeBudget: { countToday: 0, maxPerDay: 6 },
  })
  const nextCandidate = nextRanked.candidates.find((candidate) => candidate.kind === 'next')
  const nextInShortlist = choose.shortlistCandidates(nextRanked.candidates, 3)
    .some((candidate) => candidate.kind === 'next')
  check('chooser proposes the recorded next step, and it reaches the bounded shortlist',
    Boolean(nextCandidate) && nextCandidate.what.includes('换成 SPI 再试一次') &&
    nextCandidate.parts.unfinished > 0 && nextInShortlist,
    `what=${JSON.stringify(nextCandidate && nextCandidate.what)}; ` +
    `unfinished part=${nextCandidate && nextCandidate.parts.unfinished}; score=${nextCandidate && nextCandidate.score}; in shortlist=${nextInShortlist}`)
}

// Repetition must be priced. Without this the chooser has a positive feedback
// loop: finishing an activity refreshes `updatedAt`, freshness returns to 1, and
// the same `what` ranks first again — so a whole day's wakes go to one activity.
// It never crashes and never loses a day, which is exactly why only a multi-day
// run finds it (tools/life-week.mjs). This guard exists because the penalty can
// be deleted and every other assertion still passes.
{
  const repeatBase = {
    now: chooserNow,
    commitments: [],
    skills: [],
    interests: [{ topic: '挖矿类小品', confidence: 0.8, observations: 3, updatedAt: freshIso }],
    activity: { current: null },
    wakeBudget: { countToday: 2, maxPerDay: 6 },
  }
  const untouched = choose.rankCandidates({ ...repeatBase, doneToday: {} })
    .candidates.find((c) => c.kind === 'interest')
  const thrice = choose.rankCandidates({ ...repeatBase, doneToday: { '看看「挖矿类小品」的更新': 3 } })
    .candidates.find((c) => c.kind === 'interest')
  const restScore = choose.rankCandidates(repeatBase).rest.score
  check('chooser prices repetition: doing the same thing again today scores strictly lower, and rest becomes preferable',
    untouched && thrice && thrice.parts.cost > untouched.parts.cost &&
    thrice.score < untouched.score && thrice.score < restScore,
    `untouched=${untouched && untouched.score} thrice=${thrice && thrice.score} ` +
    `(cost ${untouched && untouched.parts.cost} -> ${thrice && thrice.parts.cost}); rest=${restScore}`)
}

// ---- 10b. Ranking: order, parts/score agreement, rest, budget --------------
const chooserState = {
  now: chooserNow,
  commitments: [{ id: 'c1', what: '把打法写进技能经验', dueAt: '2026-10-25', status: 'open' }],
  interests: [{ topic: '挖矿类小品', confidence: 0.8, observations: 2, updatedAt: freshIso }],
  skills: [{ name: '矿工与矮人 38 层', stage: 'practicing' }],
  activity: { current: { what: '练第 38 层' } },
  wakeBudget: { countToday: 1, maxPerDay: 6 },
}
const ranked = choose.rankCandidates(chooserState)
const rankedAgain = choose.rankCandidates(chooserState)
const rankedSorted = ranked.candidates.every((candidate, index) =>
  index === 0 || ranked.candidates[index - 1].score >= candidate.score)
const restCandidate = ranked.candidates.find((candidate) => candidate.kind === 'rest')
const partKeys = ['commitment', 'interest', 'unfinished', 'explore', 'cost', 'risk', 'switch']
const partsPresent = ranked.candidates.every((candidate) =>
  partKeys.every((key) => typeof candidate.parts[key] === 'number'))
const clamp01 = (value) => Math.min(1, Math.max(0, value))
const r3 = (value) => Math.round(clamp01(value) * 1000) / 1000
const recomputeScore = (candidate) => r3(
  candidate.parts.commitment + candidate.parts.interest + candidate.parts.unfinished + candidate.parts.explore -
  candidate.parts.cost - candidate.parts.risk - candidate.parts.switch)
// Rest is deliberately scored by a fixed constant, not by its (zero) parts; it
// is checked separately below. Everything else must recompute from `parts`.
const scoreMatchesParts = ranked.candidates
  .filter((candidate) => candidate.kind !== 'rest')
  .every((candidate) => Math.abs(recomputeScore(candidate) - candidate.score) <= 1e-9)
const restHonest = restCandidate &&
  restCandidate.score === choose.REST_CANDIDATE_SCORE &&
  partKeys.every((key) => restCandidate.parts[key] === 0) &&
  restCandidate.evidence.length > 0
const deterministicRanking = JSON.stringify(ranked) === JSON.stringify(rankedAgain)
// Weighted parts must agree with the exported raw functions *and* with
// CHOOSER_WEIGHTS, so changing a weight never forces this test to hard-code it.
const commitmentCandidate = ranked.candidates.find((candidate) => candidate.kind === 'commitment')
const expectedCommitmentPart = r3(
  choose.urgencyOf(chooserState.commitments[0], chooserNow) * choose.CHOOSER_WEIGHTS.commitment)
const interestCandidate = ranked.candidates.find((candidate) => candidate.kind === 'interest')
const interestBase = clamp01(
  choose.interestScore(chooserState.interests[0], chooserNow) - choose.explorationBonusOf(chooserState.interests[0]))
const expectedInterestPart = r3(interestBase * choose.CHOOSER_WEIGHTS.interest)
const expectedExplorePart = r3(
  choose.explorationBonusOf(chooserState.interests[0]) * choose.CHOOSER_WEIGHTS.explore)
check('chooser ranking: deterministic and sorted, score recomputes from the weighted parts, rest is always present and honest',
  rankedSorted && deterministicRanking && partsPresent && scoreMatchesParts && restHonest &&
  Boolean(commitmentCandidate) && commitmentCandidate.parts.commitment === expectedCommitmentPart &&
  Boolean(interestCandidate) && interestCandidate.parts.interest === expectedInterestPart &&
  interestCandidate.parts.explore === expectedExplorePart,
  `${ranked.candidates.length} candidates: ${ranked.candidates.map((candidate) => `${candidate.kind}:${candidate.score.toFixed(3)}`).join(', ')}; ` +
  `rest=${restCandidate?.score}/${choose.REST_CANDIDATE_SCORE}; score-from-parts=${scoreMatchesParts}; ` +
  `commitment part=${commitmentCandidate?.parts.commitment} (recomputed ${expectedCommitmentPart}); ` +
  `interest/explore part=${interestCandidate?.parts.interest}/${interestCandidate?.parts.explore} ` +
  `(recomputed ${expectedInterestPart}/${expectedExplorePart}); sorted=${rankedSorted}, deterministic=${deterministicRanking}`)

const chooserBudgetState = {
  now: chooserNow,
  commitments: [{ id: 'c1', what: '今天到期的事', dueAt: '2026-10-27', status: 'open' }],
  interests: [],
  skills: [],
  activity: {},
}
const richBudget = choose.rankCandidates({ ...chooserBudgetState, wakeBudget: { countToday: 0, maxPerDay: 6 } })
const tightBudget = choose.rankCandidates({ ...chooserBudgetState, wakeBudget: { countToday: 5, maxPerDay: 6 } })
const richTop = richBudget.candidates.find((candidate) => candidate.kind === 'commitment')
const tightTop = tightBudget.candidates.find((candidate) => candidate.kind === 'commitment')
const restIndexRich = richBudget.candidates.findIndex((candidate) => candidate.kind === 'rest')
const restIndexTight = tightBudget.candidates.findIndex((candidate) => candidate.kind === 'rest')
const tightRest = tightBudget.candidates.find((candidate) => candidate.kind === 'rest')
check('chooser ranking: with one wake left, expensive new activities lose score and rest moves up (its own score stays fixed)',
  tightTop.score < richTop.score &&
  restIndexTight < restIndexRich &&
  tightRest.score === choose.REST_CANDIDATE_SCORE &&
  tightBudget.notes.some((note) => note.includes('只剩')),
  `due-today commitment score rich=${richTop.score} tight=${tightTop.score}; ` +
  `rest index rich=${restIndexRich} tight=${restIndexTight}; notes=${tightBudget.notes.join(' | ')}`)

// ---- 10c. Wiring: wake prompt shortlist, keeper cost, the tool -------------
function seedChooserLife (lifeId) {
  const store = new LifeStore({ lifeId })
  store.ensure({ name: '大肥鱼', species: 'whale', seeds: ['懒'] })
  store.makeCommitment({ what: '把打法写进技能经验', dueAt: '2026-10-25' })
  store.recordInterest({ topic: '挖矿类小品', confidence: 0.8, source: 'browsing' })
  store.recordSkill({ name: '矿工与矮人 38 层', stage: 'practicing', evidence: 'save:38' })
  store.startActivity({ what: '练第 38 层', why: '昨天连挂两次' })
  return store
}
const chooserOn = wakeCtx()
mod.apply(chooserOn.root, { lifeId: 'chooser-on' })
const chooserOff = wakeCtx()
mod.apply(chooserOff.root, { lifeId: 'chooser-off', chooserEnabled: false })
seedChooserLife('chooser-on')
seedChooserLife('chooser-off')
const chooserWakeSession = sessionOf('chooser-wake-session')
const chooserKeeperSession = sessionOf('chooser-keeper-session')
for (const state of [chooserOn, chooserOff]) {
  state.emit('session/event', chooserWakeSession, {
    type: 'user/message',
    time: clockNow,
    data: { id: `chooser-${state === chooserOn ? 'on' : 'off'}`, source: { kind: 'schedule' } },
  })
}
const sectionText = (state, session) => state.sections[0]?.text?.({ agent: { session } }) || ''
const wakeTextOn = sectionText(chooserOn, chooserWakeSession)
const wakeTextOff = sectionText(chooserOff, chooserWakeSession)
const keeperTextOn = sectionText(chooserOn, chooserKeeperSession)
const keeperTextOff = sectionText(chooserOff, chooserKeeperSession)
const shortlistMarker = '你现在可以做的事（按你自己的历史排的，不是命令）：'
const shortlistBlock = wakeTextOn.slice(wakeTextOff.length)
const shortlistText = shortlistBlock.startsWith('\n\n') ? shortlistBlock.slice(2) : shortlistBlock
const wakeLine1 = '（这一轮是你自己醒来的，没有人跟你说话。）'
const wakeLine2 = '醒来后先读状态再决定：继续没做完的事，或明确休息。不要为了显得活着而编造经历。'
const preChooserWake = `${wakeLine1}\n${keeperTextOff}\n${wakeLine2}`
check('chooser wiring: the wake prompt gains a bounded shortlist, the keeper prompt gains exactly zero characters, and chooser-off is the pre-chooser prompt',
  wakeTextOff === preChooserWake &&
  wakeTextOn === `${wakeTextOff}\n\n${shortlistText}` &&
  shortlistText.startsWith(shortlistMarker) &&
  shortlistText.includes('休息，什么都不做') &&
  shortlistText.length > 0 && shortlistText.length <= choose.WAKE_SHORTLIST_MAX_CHARS &&
  keeperTextOn === keeperTextOff &&
  !keeperTextOn.includes(shortlistMarker),
  `shortlist=${shortlistText.length} chars (cap ${choose.WAKE_SHORTLIST_MAX_CHARS}); ` +
  `wake text ${wakeTextOff.length}→${wakeTextOn.length} chars; keeper delta=${keeperTextOn.length - keeperTextOff.length}; ` +
  `chooser-off wake equals pre-chooser baseline=${wakeTextOff === preChooserWake}`)

const chooserToolState = wakeCtx()
mod.apply(chooserToolState.root, { lifeId: 'chooser-tool' })
seedChooserLife('chooser-tool')
const candidatesTool = toolOf(chooserToolState, 'life_candidates')
const defaultCandidates = await candidatesTool.execute({}, {})
const oneCandidate = await candidatesTool.execute({ topN: 1 }, {})
const fiveCandidates = await candidatesTool.execute({ topN: 5 }, {})
const clampedCandidates = await candidatesTool.execute({ topN: 9 }, {})
const fractionalCandidates = await candidatesTool.execute({ topN: 2.5 }, {})
check('life_candidates: registered, defaults to chooserTopN, honours topN 1..5, exposes CHOOSER_WEIGHTS, and always includes rest',
  Boolean(candidatesTool) &&
  defaultCandidates.topN === 3 &&
  defaultCandidates.candidates.some((candidate) => candidate.kind === 'rest') &&
  defaultCandidates.weights.commitment === choose.CHOOSER_WEIGHTS.commitment &&
  oneCandidate.candidates.filter((candidate) => candidate.kind !== 'rest').length <= 1 &&
  fiveCandidates.candidates.filter((candidate) => candidate.kind !== 'rest').length <= 5 &&
  clampedCandidates.topN === 5 &&
  fractionalCandidates.topN === 3,
  `registered=${Boolean(candidatesTool)}, default topN=${defaultCandidates.topN}, counts topN1/topN5=` +
  `${oneCandidate.candidates.length}/${fiveCandidates.candidates.length}, topN 9→${clampedCandidates.topN}, ` +
  `2.5→${fractionalCandidates.topN}, rest always=${defaultCandidates.candidates.some((candidate) => candidate.kind === 'rest')}`)

const disabledToolState = wakeCtx()
mod.apply(disabledToolState.root, { lifeId: 'chooser-tool-disabled', chooserEnabled: false })
seedChooserLife('chooser-tool-disabled')
let chooserDisabledError = ''
try {
  await toolOf(disabledToolState, 'life_candidates').execute({}, {})
} catch (err) {
  chooserDisabledError = String(err.message)
}
check('life_candidates with chooserEnabled:false: explicit error instead of a silent empty list',
  chooserDisabledError.includes('life/chooser-disabled'),
  `error=${chooserDisabledError || 'no error (returned a list)'}`)

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length) console.log(`failed: ${failed.map((r) => r.label).join(' | ')}`)
process.exit(failed.length ? 1 : 0)
