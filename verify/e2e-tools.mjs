/**
 * End-to-end tool execution against a real dsh runtime.
 *
 * Boots the genuine `dsh` profile (headless), mounts dsh-life, and drives the
 * registered tools through the real tool runtime — the same pre-execute /
 * dispatch / policy / finalize pipeline a model call uses. No dsh component is
 * stubbed; only the LLM credential is, by driving tools directly instead of
 * asking a model to choose them.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveDshBin } from './dsh-bin.mjs'

// Windows: URL.pathname 会给出 /C:/... 这种带前导斜杠的形式，交给 import()/spawn 会报
// ERR_UNSUPPORTED_ESM_URL_SCHEME。fileURLToPath 才是跨平台的正确做法。
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// 用 pnpm 装出来的 dsh 是个 junction，直接 spawn 会让 dsh 解析不到自己的依赖
// （`dsh --version` 还能过，组合 profile 会 ERR_MODULE_NOT_FOUND）；
// 见 verify/dsh-bin.mjs 的说明。
let DSH
try {
  DSH = resolveDshBin(process.env.DSH_BIN, [path.join(REPO, 'node_modules', '@deepseek-ai', 'dsh')])
} catch (err) {
  console.error(`\n${err.message}\n`)
  process.exit(1)
}
const HOME = process.env.E2E_DSH_HOME || path.join(os.tmpdir(), 'dsh-life-e2e-home')
const PLUGIN = path.join(REPO, 'packages', 'dsh-life')

fs.rmSync(HOME, { recursive: true, force: true })
fs.mkdirSync(HOME, { recursive: true })

// Windows: dsh 的 plugin 管理器会去调包管理器，子进程 PATH 里没有 node/pnpm 就会失败。
// 把当前 node 所在目录并进去，让插件安装在本机可用。
const NODE_DIR = path.dirname(process.execPath)
const CHILD_PATH = [NODE_DIR, process.env.PATH || ''].filter(Boolean).join(path.delimiter)

function run (args, { cwd = REPO } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [DSH, ...args], {
      env: { ...process.env, DSH_HOME: HOME, CI: 'true', PATH: CHILD_PATH },
      cwd,
      timeout: 300000,
    })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { out += d })
    child.on('close', (code) => resolve({ code, out }))
  })
}

const results = []
const check = (label, ok, detail = '') => {
  results.push({ label, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

// 1. Create a real profile from the shipped headless template.
const init = await run(['--profile', 'e2e', '--from-default-profile', 'headless', '--dump-config'])
check('dsh composes a new profile from the shipped headless template', init.out.includes('dsh-base'), `exit=${init.code}`)

// 2. Install the plugin through dsh's own plugin manager (not by hand-editing).
const add = await run(['plugin', '--profile', 'e2e', 'add', `link:${PLUGIN}`])
check('dsh plugin manager installs dsh-life', add.code === 0 && !/failed/i.test(add.out), add.out.trim().split('\n').filter(Boolean).slice(-2).join(' | ').slice(0, 90))

// 3. The composed profile must actually mount it.
const dump = await run(['--profile', 'e2e', '--dump-config'])
check('composed profile mounts the life layer', /id: dsh-life/.test(dump.out))

// 4. Boot the real runtime with a recording probe that drives each tool through
//    the registry's own execution pipeline.
const probeDir = path.join(REPO, 'verify', 'probe')
const probeOut = path.join(HOME, 'e2e-probe.json')
process.env.LIFE_PROBE_OUT = probeOut
await run(['plugin', '--profile', 'e2e', 'add', `link:${probeDir}`])

const boot = await run(['--profile', 'e2e', 'say pong'])
const transcript = `${boot.out}`

check('dsh boots the e2e profile without an activation warning for dsh-life',
  !/dsh-life.*did not activate|did not activate.*dsh-life/i.test(transcript),
  transcript.split('\n').filter((l) => /life/i.test(l)).slice(0, 2).join(' | ') || 'no life-related output')

// 4b. Degradation, from the transcript side: this profile has no `schedule`
// service, so dsh-life must not report a warning or an error. The only
// diagnosis it is allowed to make is the single `info` line ("no schedule
// service, autonomous wake-up stays off").
//
// Honest scope note: the headless app installs no cordis logger exporter, so
// `logger.info`/`logger.warn` output is not printed here at all. The real
// warn-freedom evidence is the recording fake context in verify/smoke.mjs
// (zero warnings while the plugin still registers 12 tools); this check only
// guards that no in-band `[dsh-life]` diagnostic leaks into the boot output and
// that the plugin's event path still ran (proven by the ledger `turn` below).
const lifeDiagnostics = transcript.split('\n').filter((line) => line.includes('[dsh-life]'))
const alarmingDiagnostics = lifeDiagnostics.filter((line) =>
  /\bwarn\b|\berror\b|could not|failed to/i.test(line))
check('headless boot emits no dsh-life warn/error diagnostic',
  alarmingDiagnostics.length === 0,
  lifeDiagnostics.length
    ? `${lifeDiagnostics.length} [dsh-life] line(s), alarming=${alarmingDiagnostics.length}`
    : 'no alarming [dsh-life] line (headless prints no logger output; warn-freedom is proven in smoke)')

// 5. Verify the life files the plugin wrote are real, on disk, and obey the
//    product invariants the plan states.
const lifeDir = path.join(HOME, 'life', 'default')
check('the plugin created a real life directory', fs.existsSync(lifeDir), lifeDir)
const identity = JSON.parse(fs.readFileSync(path.join(lifeDir, 'identity.json'), 'utf8'))
check('identity is persisted with a version', identity.revision >= 1 && identity.name.length > 0, `${identity.name} v${identity.revision}`)
check('identity carries the declared seeds', Array.isArray(identity.seeds) && identity.seeds.length >= 2, identity.seeds.join('、'))
check('identity records a birth time', typeof identity.bornAt === 'string' && identity.bornAt.length > 0, identity.bornAt)
check('the ledger exists on disk', fs.existsSync(path.join(lifeDir, 'ledger.jsonl')))
const ledger = fs.readFileSync(path.join(lifeDir, 'ledger.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
check('the ledger records the birth event', ledger.some((e) => e.kind === 'born'))
check('the ledger records real turns observed from dsh', ledger.some((e) => e.kind === 'turn'),
  `${ledger.length} entries: ${ledger.map((e) => e.kind).join(',')}`)

// 6. The per-turn context reached the assembled prompt (evidence captured by the probe).
if (fs.existsSync(probeOut)) {
  const captured = JSON.parse(fs.readFileSync(probeOut, 'utf8'))
  const lifeSection = (captured.sections || []).find((s) => /life/.test(s.name || ''))
  check('the life context reached the assembled system prompt', Boolean(lifeSection), lifeSection ? lifeSection.name : 'not found')
  const lifeTools = (captured.tools || []).filter((t) => /^life_/.test(t.name || ''))
  check('all life tools are visible to the model', lifeTools.length === 12, `${lifeTools.length} tools`)
  check('tool schemas reach the model with descriptions',
    lifeTools.every((t) => typeof t.description === 'string' && t.description.length > 20))
} else {
  check('probe captured the assembled prompt', false, 'no probe output')
}

// 7. Restart safety: a second boot must not clobber the existing life.
await run(['--profile', 'e2e', 'say pong again'])
const identity2 = JSON.parse(fs.readFileSync(path.join(lifeDir, 'identity.json'), 'utf8'))
check('a second boot preserves the existing life', identity2.bornAt === identity.bornAt && identity2.revision === identity.revision)

// 8. The claimed capability lives in the profile users actually run: the
// shipped web template must compose the Host's `schedule` service. This only
// dumps the composed config (it does not boot the web server), which is enough
// to prove the service is in the tree instead of merely asserted in a doc.
//
// It is the last command on purpose: `--from-default-profile` replaces this
// profile's layer, and nothing after this reads the e2e profile again.
const webDump = await run(['--profile', 'e2e', '--from-default-profile', 'web', '--dump-config'])
const scheduleEntry = /- id: schedule\s*\n\s+name: ['"]@deepseek-ai\/dsh-schedule['"]/.test(webDump.out)
check('the shipped web template composes the schedule service the life layer needs',
  webDump.code === 0 && scheduleEntry,
  `exit=${webDump.code}; ${scheduleEntry ? "found 'id: schedule' -> '@deepseek-ai/dsh-schedule'" : 'schedule entry not found in dump-config'}`)

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length) console.log(`failed: ${failed.map((r) => r.label).join(' | ')}`)
process.exit(failed.length ? 1 : 0)