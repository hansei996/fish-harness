/**
 * Does the real `web` profile wake a Session on its own? Opt-in live check.
 *
 *   node verify/live/wake-live.mjs          # manual only; nothing runs it in CI
 *
 * It boots the genuine shipped `web` profile three times against a throwaway
 * DSH_HOME (never ~/.dsh) and asserts exactly three facts:
 *
 *   1. a one-shot wake, armed by one process, is delivered into the Session by a
 *      *different* process that started after the task came due — as a
 *      `user/message` whose `source.kind === 'schedule'`;
 *   2. the host's own ledger recorded that delivery (`schedule.history` →
 *      `deliveredAt`, matching `messageId`);
 *   3. after yet another restart, the same `messageId` is still in the durable
 *      Session prefix (`sessionController.inspect`).
 *
 * It does NOT look at model output. There is no API key here on purpose: the
 * model call fails, and that is irrelevant — what is under test is delivery.
 *
 * Cost: ~1–2 minutes of wall clock, three local processes, no network model
 * spend. Not part of `npm run verify`; run it by hand before a release if the
 * wake path changed.
 *
 * ── READ THIS BEFORE TRUSTING A PASS ───────────────────────────────────────────
 * The overlay at `verify/live/wake.patch.yml` DISABLES all shipped agent presets
 * and the preset registry. On dsh 0.2.1-rc.2 no Session can be created in the
 * shipped `web` profile otherwise: every preset's audit re-mounts plugins the
 * deployment already mounted and reports `agent-preset/invalid` (persona prompt
 * section, persistent pwsh tool, compact command, subagent model selection).
 * That is a dsh bug. The workaround means the Session here is preset-free, so
 * the persona, the preset tool set and subagent tooling are absent, and this
 * check says nothing about the desktop GUI's composition. See the overlay and
 * verify/live/README.md; the assertions stay valid once the bug is fixed.
 * ──────────────────────────────────────────────────────────────────────────────
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveDshBin } from '../dsh-bin.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..')
const PATCH = path.join(HERE, 'wake.patch.yml')
const PROBE_STATE = 'wake-state.json'
const PROBE_RESULT = 'wake-result.json'

const AFTER_SECONDS = Number(process.env.WAKE_LIVE_AFTER_SECONDS || 25)
const BOOT_TIMEOUT_MS = Number(process.env.WAKE_LIVE_BOOT_TIMEOUT_MS || 150_000)

banner()

// The entry point is a pnpm junction; spawn it without realpath and dsh cannot
// resolve its own dependencies. verify/dsh-bin.mjs owns that fix — reusing it
// here is also a live check that it still resolves a junction the way it claims.
let DSH
try {
  DSH = resolveDshBin(process.env.DSH_BIN, [path.join(REPO, 'node_modules', '@deepseek-ai', 'dsh')])
} catch (err) {
  environment([`cannot resolve a spawnable dsh: ${err.message}`])
}

// Throwaway HOME. Wiped on every run so "already delivered" can never pass for
// "delivered now"; ~/.dsh is never touched.
const HOME = process.env.WAKE_LIVE_DSH_HOME || path.join(os.tmpdir(), 'dsh-life-wake-live-home')
const STATE = path.join(HOME, PROBE_STATE)
const RESULT = path.join(HOME, PROBE_RESULT)
fs.rmSync(HOME, { recursive: true, force: true })
fs.mkdirSync(HOME, { recursive: true })

// dsh's plugin manager may spawn the package manager, so node must be on PATH.
const CHILD_PATH = [path.dirname(process.execPath), process.env.PATH || ''].filter(Boolean).join(path.delimiter)

console.log(`  dsh       ${DSH}`)
console.log(`  version   ${await version()}`)
console.log(`  DSH_HOME  ${HOME}  (throwaway)`)
console.log(`  overlay   ${relative(PATCH)}  (presets disabled — see the header)`)
console.log(`  one-shot  ${AFTER_SECONDS}s out; the Host is killed before it comes due\n`)

const timeline = []
const results = []

// ── arm: create a Session, arm the wake, leave immediately ────────────────────
const arm = await boot('arm')
const state = readJson(STATE)
if (arm.code !== 0 || !state || !state.scheduleId) {
  environment([
    'the arm process did not create a Session and arm a wake',
    `exit=${arm.code}`,
    ...tail(arm.out, 6),
    ...(readJson(RESULT) ? [`probe: ${JSON.stringify(readJson(RESULT))}`] : []),
  ])
}
const event = lastEvent(arm.out, 'armed')
timeline.push(`arm      ${event ? event.at : state.armedAt}  session ${state.sessionId}`)
timeline.push(`         schedule ${state.scheduleId} due ${state.scheduledAt}`)

const due = Date.parse(state.scheduledAt)
if (!Number.isFinite(due)) environment([`the armed task has no parseable scheduledAt: ${state.scheduledAt}`])

// The arm process is gone; wait until the task is genuinely overdue, so the
// delivery below can only come from dsh's own boot-time catch-up.
const waitMs = Math.max(0, due + 3_000 - Date.now())
console.log(`  host is down with the task still armed; waiting ${Math.ceil(waitMs / 1000)}s until it is overdue…\n`)
await sleep(waitMs)
timeline.push(`due      ${state.scheduledAt}  no Host process running`)

// ── watch: a second process must deliver the overdue task on startup ──────────
const watch = await boot('watch')
const watched = readJson(RESULT)
if (!watched || watch.code === 10) environment(['the watch process wrote no result', ...tail(watch.out, 6)])
if (watched.reason === 'service-missing') {
  environment(['the composed profile has no schedule/session service — is this really the `web` template?'],
    Object.entries(watched.services || {}).map(([k, v]) => `${k}=${v}`))
}
const wakeEvent = lastEvent(watch.out, 'wake-message')
if (wakeEvent) timeline.push(`watch    ${wakeEvent.at}  user/message source.kind=schedule ${watched.messageId}`)

results.push(check(
  'dsh delivered the armed wake into the Session as a schedule-sourced message',
  Boolean(watched.messageId) && watched.sourceKind === 'schedule',
  `messageId=${watched.messageId ?? 'none'} source.kind=${watched.sourceKind ?? 'none'}` +
    (watched.textHead ? ` text=${JSON.stringify(watched.textHead.slice(0, 40))}` : ''),
))

const history = watched.history || {}
results.push(check(
  'the schedule ledger recorded that delivery (deliveredAt matches messageId)',
  Boolean(history.deliveredAt) && history.messageId === watched.messageId,
  history.deliveredAt
    ? `deliveredAt=${history.deliveredAt} scheduledAt=${history.scheduledAt} messageId=${history.messageId}`
    : `no ledger row (${watched.reason})`,
))
if (history.deliveredAt) timeline.push(`ledger   ${history.deliveredAt}  deliveredAt, messageId ${history.messageId}`)

// ── replay: a third process must still find that messageId on disk ────────────
const replay = await boot('replay')
const replayed = readJson(RESULT)
if (!replayed || replayed.ok !== true) {
  environment(['the replay process could not read the persisted Session', ...tail(replay.out, 6)])
}
timeline.push(`replay   ${lastEvent(replay.out, 'replayed')?.at ?? 'n/a'}  ${replayed.eventCount} persisted events, ${replayed.hits} wake hit(s)`)

results.push(check(
  'the same messageId survives a restart in the persisted Session prefix',
  Boolean(watched.messageId) && replayed.messageIds.includes(watched.messageId),
  watched.messageId
    ? `delivered=${watched.messageId} persisted=${JSON.stringify(replayed.messageIds)}`
    : `cannot compare: the watch phase reported no delivered messageId, though the prefix holds ${replayed.hits} wake event(s) ${JSON.stringify(replayed.messageIds)} — the wake may have arrived without being observed`,
))

// ── verdict ───────────────────────────────────────────────────────────────────
console.log('\ntimeline')
for (const line of timeline) console.log(`  ${line}`)

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
const modelTurn = watched.turnStarted
  ? 'the wake did start a turn; its model call failed on purpose (no credential)'
  : 'no turn/start was observed'
console.log(`note: ${modelTurn}. Model output is not asserted.`)
if (failed.length) {
  console.log(`\nFAILED (assertion, not environment): ${failed.map((r) => r.label).join(' | ')}`)
  process.exit(1)
}
console.log('\nPASS: the wake path works unattended — but only under the preset-free overlay.')
process.exit(0)

// ── helpers ───────────────────────────────────────────────────────────────────
function banner () {
  console.log('\nwake-live — does the real `web` profile wake a Session by itself?\n')
  console.log('  boots the shipped `web` profile 3× against a throwaway DSH_HOME:')
  console.log('    1. create a Session and arm a one-shot wake, then exit (Host down)')
  console.log('    2. boot again after the task is overdue: expect the delivery + ledger row')
  console.log('    3. boot once more: expect the same messageId in the persisted prefix')
  console.log('  needs: dsh 0.2.1-rc.2 (DSH_BIN), the shipped `web` template, ~1–2 min')
  console.log('  spends: nothing — no model credential is used; the model call is expected to fail')
  console.log('  warns: the overlay disables every shipped preset. That is a workaround for a')
  console.log('         dsh preset-audit bug, not a normal way to run dsh. See the header.\n')
}

function relative (target) {
  return path.relative(REPO, target).split(path.sep).join('/')
}

function sleep (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function version () {
  const out = await once(['--version'], 60_000)
  return (out.out.trim().split('\n').pop() || 'unknown').slice(0, 40)
}

function once (args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [DSH, ...args], {
      env: { ...process.env, DSH_HOME: HOME, PATH: CHILD_PATH },
      cwd: REPO,
      timeout: timeoutMs,
    })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { out += d })
    child.on('close', (code) => resolve({ code, out }))
  })
}

/** One `dsh web --patch …` process. `--patch` must precede the app's own flags. */
function boot (mode) {
  fs.rmSync(RESULT, { force: true })
  return new Promise((resolve) => {
    const started = Date.now()
    const child = spawn(process.execPath, [DSH, 'web', '--patch', PATCH, '--no-open', '--port', '0'], {
      env: {
        ...process.env,
        DSH_HOME: HOME,
        PATH: CHILD_PATH,
        WAKE_LIVE_MODE: mode,
        WAKE_LIVE_STATE: STATE,
        WAKE_LIVE_RESULT: RESULT,
        WAKE_LIVE_CWD: HOME,
        WAKE_LIVE_AFTER_SECONDS: String(AFTER_SECONDS),
      },
      cwd: REPO,
      timeout: BOOT_TIMEOUT_MS,
    })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { out += d })
    child.on('close', (code) => {
      const ms = Date.now() - started
      console.log(`  [${mode}] exited code=${code} after ${(ms / 1000).toFixed(1)}s`)
      resolve({ code, out, ms })
    })
  })
}

function readJson (file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return undefined }
}

/** Probe modes print one JSON object per line; ignore dsh's human banner. */
function probeEvents (out) {
  const events = []
  for (const line of String(out).split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    try { events.push(JSON.parse(trimmed)) } catch {}
  }
  return events
}

function lastEvent (out, kind) {
  const events = probeEvents(out).filter((e) => e.kind === kind)
  return events.length ? events[events.length - 1] : undefined
}

function tail (out, lines) {
  return String(out).trim().split('\n').slice(-lines).map((l) => `  | ${l}`)
}

function check (label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `\n        ${detail}` : ''}`)
  return { label, ok }
}

/** Environment problem: the check could not run. Distinct exit code from a FAIL. */
function environment (lines) {
  console.log('\nENV  cannot run this check on this machine:')
  for (const line of lines) console.log(`  ${line}`)
  console.log('\n  fix the environment (dsh 0.2.1-rc.2 via DSH_BIN, the shipped `web` template,')
  console.log('  a writable temp dir) and re-run. This is NOT a verdict on the wake path.')
  process.exit(2)
}
