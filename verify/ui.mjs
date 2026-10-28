/**
 * UI seam verification — no browser required.
 *
 * What this suite can and cannot see: it proves the package declares both halves
 * correctly, that the hand-written client module executes and registers into its
 * slots under a stub loader, that the Host route returns live state from a real
 * on-disk store, that corruption is reported instead of fabricated, and that a
 * profile without a web server is untouched. It does NOT prove pixels — nothing
 * here renders a DOM. See packages/dsh-life/README.md ("界面").
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolveDshBin } from './dsh-bin.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PLUGIN = path.join(REPO, 'packages', 'dsh-life')
// 带随机后缀，否则与并发的另一份 verify 互删目录（见 verify/smoke.mjs 同处的说明）。
const HOME = process.env.VERIFY_DSH_HOME || fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-life-ui-'))
process.env.DSH_HOME = HOME

const results = []
function check (label, ok, detail = '') {
  results.push({ label, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}
function skip (label, detail = '') {
  console.log(`SKIP  ${label}${detail ? ` — ${detail}` : ''}`)
}

fs.rmSync(HOME, { recursive: true, force: true })
fs.mkdirSync(HOME, { recursive: true })

// ---- 1. The package declares both halves -----------------------------------
const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'package.json'), 'utf8'))
check('package.json keeps dsh.bundle.patch (a plugin row, not a plain dependency)',
  manifest.dsh?.bundle?.patch === './cordis.patch.yml')
check('package.json declares dsh.client.platform === "web"', manifest.dsh?.client?.platform === 'web')
const clientExport = manifest.exports?.['./client']
const clientPath = typeof clientExport === 'string'
  ? path.join(PLUGIN, clientExport)
  : path.join(PLUGIN, clientExport?.default || '')
check('exports["./client"] resolves to a real file', Boolean(clientExport) && fs.existsSync(clientPath),
  `${clientExport} (${fs.existsSync(clientPath) ? fs.statSync(clientPath).size + ' B' : 'missing'})`)
check('files[] ships the client directory (pack-install derives its list from exports)',
  Array.isArray(manifest.files) && manifest.files.includes('client'))
check('the host half stays dependency-free', !manifest.dependencies || Object.keys(manifest.dependencies).length === 0)

// ---- 2. The client module runs under a stub loader -------------------------
const source = fs.readFileSync(clientPath, 'utf8')
let loaded
const windowStub = { __ModuleLoader__: { load: (mod) => { loaded = mod } } }
new Function('window', 'fetch', 'setInterval', 'clearInterval', source)(
  windowStub,
  () => Promise.reject(new Error('no network in this suite')),
  () => 0,
  () => {},
)
check('client module registers itself with the lazy-CJS loader', Boolean(loaded) && loaded.id === 'dsh-life',
  loaded ? `id=${loaded.id}` : 'load() never called')

const ReactStub = {
  createElement: (type, props, children) => ({ type, props, children }),
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
}
const clientExports = loaded.factory((specifier) => {
  if (specifier === 'react') return ReactStub
  throw new Error(`stub loader has no module ${JSON.stringify(specifier)}`)
})
check('factory exports apply/inject and requires only react',
  typeof clientExports.apply === 'function' && JSON.stringify(clientExports.inject) === '["slots"]')

const registrations = []
const ctx = {
  slots: {
    inject: (name, cb) => cb(),
    register: (options, component) => { registrations.push({ options, component }); return () => {} },
  },
}
clientExports.apply(ctx)
const overlay = registrations.find((r) => r.options.name === 'shell.overlay')
check('apply() registers the screen into shell.overlay',
  Boolean(overlay) && overlay.options.id === 'life-overview' && overlay.options.order === 1000,
  overlay ? `name=${overlay.options.name} id=${overlay.options.id} order=${overlay.options.order}` : `${registrations.length} registrations`)
check('the settings.section companion is registered from the same component',
  Boolean(registrations.find((r) => r.options.name === 'settings.section')))
const element = overlay && overlay.component()
check('the component renders the probe-identifiable element', Boolean(element) && element.props.id === 'life-overview')

// ---- 3. Client-side hygiene ------------------------------------------------
const forbidden = [
  ['document.write', /document\s*\.\s*write/],
  ['eval', /\beval\s*\(/],
  ['innerHTML', /innerHTML/],
  ['an inlined token', /\b(token|api[_-]?key|secret)\s*[:=]/i],
]
const violations = forbidden.filter(([, pattern]) => pattern.test(source)).map(([name]) => name)
check('client code has no document.write / eval / innerHTML / inlined token', violations.length === 0,
  violations.join(', ') || 'clean')
const fetched = [...source.matchAll(/fetch\(\s*([^,)]+)/g)].map((m) => m[1].trim())
const onlyStateUrl = source.includes("const STATE_URL = '/life/state.json'") &&
  fetched.length > 0 && fetched.every((target) => target === 'STATE_URL') &&
  !/https?:\/\//.test(source)
check('client fetches only /life/state.json and nothing else', onlyStateUrl,
  `${fetched.join(', ')} via STATE_URL; absolute URLs=${/https?:\/\//.test(source)}`)

// ---- 4. Host route over a real store --------------------------------------
const { LifeStore } = await import(pathToFileURL(path.join(PLUGIN, 'lib', 'store.js')).href)
const { installLifeUi, readLifeState, LIFE_STATE_PATH } = await import(pathToFileURL(path.join(PLUGIN, 'lib', 'ui.js')).href)
check('the route path is the one the client fetches', LIFE_STATE_PATH === '/life/state.json')

const fixed = new Date('2026-10-28T10:00:00.000Z')
const store = new LifeStore({ home: path.join(HOME, 'ui-store'), lifeId: 'ui', clock: () => fixed })
store.ensure({ name: '大肥鱼', species: 'whale' })
store.startActivity({ what: '练第 38 层', why: '昨天连挂两次' })
store.makeCommitment({ what: '把游标修好', dueAt: '2026-10-29T09:00:00.000Z' })
store.rememberPerson({ name: '主人', note: '只有主人能看到的私密备注' })
store.appendLedger({ kind: 'turn', detail: { sessionId: 'session-x', turn: 1, reason: null, woke: false } })
store.appendLedger({ kind: 'turn', detail: { sessionId: 'session-x', turn: 2, reason: 'error', woke: true } })
store.appendLedger({ kind: 'wake', detail: { messageId: 'm-1', sessionId: 'session-x' } })
store.appendLedger({ kind: 'activity-end', detail: { what: '读文档', outcome: 'failed', note: '账本正文不应外泄' } })
store.updateWake({ nextAt: '2026-10-28T12:00:00.000Z', dayKey: '2026-10-28', countToday: 2 })

let route
const fakeRoot = {
  inject: (deps, cb) => { cb({ webServer: { register: (r) => { route = r } } }) },
}
installLifeUi(fakeRoot, store, { lifeId: 'ui' })
check('installLifeUi registers exactly one exact-path route', Boolean(route) && route.kind === 'exact' && route.path === LIFE_STATE_PATH,
  route ? `${route.kind} ${route.path}` : 'nothing registered')

function callHandler (handler) {
  let body = ''
  const res = {
    writeHead: () => {},
    end: (chunk) => { body += chunk === undefined ? '' : String(chunk) },
  }
  handler({ method: 'GET' }, res)
  return body
}

const state = JSON.parse(callHandler(route.handler))
check('the route returns live state, not a cached document',
  state.ok === true && state.generatedAt === fixed.toISOString() &&
  state.identity.name === '大肥鱼' && state.identity.species === 'whale' && state.identity.revision === 1,
  `generatedAt=${state.generatedAt} identity=${state.identity?.name}/${state.identity?.species}/v${state.identity?.revision}`)
check('the current activity keeps its reason (the "why" of the screen)',
  state.activity?.what === '练第 38 层' && state.activity?.why === '昨天连挂两次' && Boolean(state.activity?.startedAt),
  JSON.stringify(state.activity))
check('the open commitment reaches the screen with its due date',
  Array.isArray(state.openCommitments) && state.openCommitments.length === 1 &&
  state.openCommitments[0].what === '把游标修好' && Boolean(state.openCommitments[0].dueAt))
check('per-day counters come from the real ledger',
  state.today.turns === 2 && state.today.wakes === 1 && state.today.activities === 1 && state.today.failures === 2,
  JSON.stringify(state.today))
check('wake bookkeeping is exposed as counts only', state.wakeCountToday === 2 && state.nextWakeAt === '2026-10-28T12:00:00.000Z')
const serialized = JSON.stringify(state)
check('private material never leaves the Host',
  !serialized.includes('只有主人能看到的私密备注') && !serialized.includes('账本正文不应外泄') &&
  !serialized.includes('"note"') && !serialized.includes('"ledger"'),
  serialized.includes('私密') ? 'relations note leaked' : 'no note/ledger fields')

// ---- 5. Corrupt state is reported, never fabricated -----------------------
fs.writeFileSync(store.files.activity, '{ this is not json', 'utf8')
const corrupt = JSON.parse(callHandler(route.handler))
check('a corrupt state file answers { ok: false } instead of a made-up screen',
  corrupt.ok === false && String(corrupt.error || '').includes('state-corrupt'),
  JSON.stringify(corrupt))
let threw = false
try { readLifeState(store) } catch (err) { threw = true }
check('readLifeState refuses to describe unreadable state', threw)

// ---- 6. headless: the UI seam must be invisible ---------------------------
const plugin = await import(pathToFileURL(path.join(PLUGIN, 'lib', 'index.js')).href)
const events = []
const routeBeforeHeadless = route
// Mirrors verify/smoke.mjs: every dependency callback runs, but a headless
// composition provides no `webServer`, so the UI seam has nothing to register.
// `tools`/`systemPrompt` are provided so this isolates the UI change instead of
// re-testing the whole plugin.
const headlessTools = []
const headlessCtx = {
  logger: { info: () => {}, warn: (m) => events.push({ kind: 'warn', m }) },
  effect: () => () => {},
  on: () => () => {},
  inject: (deps, cb) => {
    if (deps.includes('tools')) return cb({ tools: { register: (def) => { headlessTools.push(def.name); return () => {} } } })
    if (deps.includes('systemPrompt')) return cb({ systemPrompt: { section: () => () => {} } })
    return cb({})
  },
}
plugin.apply(headlessCtx, { lifeId: 'headless-ui' })
const warns = events.filter((e) => e.kind === 'warn')
check('headless boot applies with zero warnings', warns.length === 0, warns.map((w) => w.m).join('; '))
// 工具数从源码数，不写死：判据是「headless profile 下注册的 == 源码里定义的」。
// 写死一个数的话，每加一个工具这条都会红，而红的原因是「数字过期」不是「headless 少了东西」。
const declaredTools = [...fs.readFileSync(path.join(PLUGIN, 'lib', 'index.js'), 'utf8')
  .matchAll(/name: '(life_[a-z_]+)'/g)].length
check('the model-facing tool surface matches the source (no tool lost in a headless profile)',
  headlessTools.length === declaredTools,
  `${headlessTools.length} registered / ${declaredTools} declared`)
check('a headless composition registers no UI route at all', route === routeBeforeHeadless,
  route === routeBeforeHeadless ? 'no registration attempted' : 'a route appeared')

// ---- 7. A real web profile mounts both the plugin and a web server --------
let dshBin
try {
  dshBin = resolveDshBin(process.env.DSH_BIN, [path.join(REPO, 'node_modules', '@deepseek-ai', 'dsh')])
} catch (err) {
  skip('real web profile composition', 'DSH_BIN not resolved (see verify/README.md)')
}
if (dshBin) {
  const CHILD_PATH = [path.dirname(process.execPath), process.env.PATH || ''].filter(Boolean).join(path.delimiter)
  const run = (args) => new Promise((resolve) => {
    const child = spawn(process.execPath, [dshBin, ...args], {
      env: { ...process.env, DSH_HOME: HOME, PATH: CHILD_PATH },
      cwd: REPO,
      timeout: 180_000,
    })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { out += d })
    child.on('close', (code) => resolve({ code, out }))
  })
  const init = await run(['--profile', 'uiverify', '--from-default-profile', 'web', '--dump-config'])
  check('a profile composes from the shipped web template', init.code === 0, `exit=${init.code}`)
  const add = await run(['plugin', '--profile', 'uiverify', 'add', `link:${PLUGIN}`])
  check('dsh plugin manager accepts dsh-life as a bundle layer', add.code === 0,
    add.out.trim().split('\n').filter(Boolean).slice(-1)[0]?.slice(0, 100))
  const dump = await run(['--profile', 'uiverify', '--dump-config'])
  const hasPlugin = /id: dsh-life/.test(dump.out)
  const hasWebServer = /webserver/i.test(dump.out)
  check('the composed profile carries dsh-life and a webServer at once', hasPlugin && hasWebServer,
    `dsh-life=${hasPlugin} webServer=${hasWebServer}`)
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length) {
  console.log(`failed: ${failed.map((r) => r.label).join(' | ')}`)
  process.exit(1)
}
process.exit(0)
