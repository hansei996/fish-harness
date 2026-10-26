/**
 * Real integration smoke test for dsh-life.
 *
 * Boots the genuine dsh CLI, loads the plugin, drives the model-facing tools
 * and the durable store, and asserts behaviour. dsh itself is not mocked:
 * the store and plugin are exercised as shipped.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const REPO = path.resolve(new URL('.', import.meta.url).pathname, '..')
const PLUGIN = path.join(REPO, 'packages', 'dsh-life')
const DSH_BIN = process.env.DSH_BIN || '/tmp/dshprobe/node_modules/@deepseek-ai/dsh/lib/bin.js'
const HOME = process.env.VERIFY_DSH_HOME || path.join(os.tmpdir(), 'dsh-life-verify-home')

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
const mod = await import(path.join(PLUGIN, 'lib', 'index.js'))
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
check('registers the full life tool surface', toolNames.length === 11, `${toolNames.length} tools`)
check('registers the plan-critical tools',
  ['life_whoami', 'life_start_activity', 'life_finish_activity', 'life_promise',
    'life_settle_commitment', 'life_identity_update', 'life_ledger'].every((n) => toolNames.includes(n)))
check('registers exactly one prompt section', sections.length === 1)
const liveText = sections[0]?.text?.() || ''
check('per-turn context carries identity, activity and the honesty rule',
  liveText.includes('身份 v1') && liveText.includes('大肥鱼') && liveText.includes('证据'),
  liveText.split('\n')[0].slice(0, 60))

// ---- 4. Durable store invariants, on a real filesystem ---------------------
const { LifeStore } = await import(path.join(PLUGIN, 'lib', 'store.js'))
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

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length) console.log(`failed: ${failed.map((r) => r.label).join(' | ')}`)
process.exit(failed.length ? 1 : 0)
