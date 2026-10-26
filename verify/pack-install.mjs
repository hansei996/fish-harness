/**
 * Does the package we would publish still install?
 *
 * `link:` installs skip dependency resolution, so they cannot catch a tarball
 * that ships without `lib/choose.js`, or that pnpm refuses because of a peer
 * dependency. This suite packs `packages/dsh-life` the way `pnpm publish`
 * would, asserts the tarball contains every file the manifest promises, then
 * installs the tarball into a throwaway profile and boots it once to prove the
 * plugin still activates.
 *
 * The expected file set is derived from `package.json`, never from a second
 * hard-coded list: the `files` field (directories expanded), npm's
 * always-shipped files, and the paths the manifest itself promises to serve
 * (`main`, `exports`, the dsh bundle patch). Adding a file under `lib/` extends
 * what CI checks automatically, and dropping an entry from `files` while the
 * manifest still serves it is caught instead of silently shrinking the tarball.
 *
 * Child output is captured through a log file instead of a pipe: when a boot
 * is killed at its timeout, whatever it printed before hanging is still on
 * disk, which is exactly what makes a timeout diagnosable.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { resolveDshBin } from './dsh-bin.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PLUGIN = path.join(REPO, 'packages', 'dsh-life')
const MANIFEST = path.join(PLUGIN, 'package.json')

let DSH
try {
  DSH = resolveDshBin(process.env.DSH_BIN, [path.join(REPO, 'node_modules', '@deepseek-ai', 'dsh')])
} catch (err) {
  console.error(`\n${err.message}\n`)
  process.exit(1)
}

const HOME = process.env.PACK_DSH_HOME || path.join(os.tmpdir(), 'dsh-life-pack-home')
const PACK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-life-pack-'))
const BOOT_TIMEOUT_MS = 90_000

// 打包产物绝不允许落进仓库；mkdtemp(os.tmpdir()) 只是防止有人以后改坏这里。
if (PACK_DIR.startsWith(REPO + path.sep)) {
  console.error(`refusing to pack inside the repo: ${PACK_DIR}`)
  process.exit(1)
}
fs.rmSync(HOME, { recursive: true, force: true })
fs.mkdirSync(HOME, { recursive: true })

// dsh 的 plugin manager 会去调 pnpm；Windows 上子进程 PATH 里没有 node/pnpm 就会失败。
const NODE_DIR = path.dirname(process.execPath)
const CHILD_PATH = [NODE_DIR, process.env.PATH || ''].filter(Boolean).join(path.delimiter)

const results = []
const check = (label, ok, detail = '') => {
  results.push({ label, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

const tail = (text, lines = 20) => text.trimEnd().split(/\r?\n/).slice(-lines).join('\n')

function run (label, command, args, { cwd = REPO, timeoutMs = 300_000, shell = false } = {}) {
  const logPath = path.join(PACK_DIR, `${label}.log`)
  const fd = fs.openSync(logPath, 'w')
  const res = spawnSync(command, args, {
    stdio: ['ignore', fd, fd],
    cwd,
    env: { ...process.env, DSH_HOME: HOME, CI: 'true', PATH: CHILD_PATH },
    timeout: timeoutMs,
    shell,
  })
  fs.closeSync(fd)
  return {
    status: res.status,
    timedOut: res.error?.code === 'ETIMEDOUT',
    spawnError: res.error?.code,
    output: fs.readFileSync(logPath, 'utf8'),
  }
}

// Windows 上 pnpm 常常只是 .cmd shim（corepack / 本机 shim），非 shell 的 spawn 找不到；
// CI 的 pnpm/action-setup 给的是独立可执行文件，shell 也能跑到它。
const quoteForShell = (arg) => (/[\s"]/.test(arg) ? `"${arg.replaceAll('"', '\\"')}"` : arg)
const runPnpm = (label, args, opts) => process.platform === 'win32'
  ? run(label, ['pnpm', ...args.map(quoteForShell)].join(' '), [], { ...opts, shell: true })
  : run(label, 'pnpm', args, opts)
const runDsh = (label, args, opts) => run(label, process.execPath, [DSH, ...args], opts)

function reportFailure (label, result) {
  if (result.status === 0 && !result.timedOut) return
  console.log(`\n${label} output (exit ${result.status}${result.timedOut ? ', timed out' : ''}):\n${tail(result.output)}`)
}

// ---- 1. pnpm has to be runnable -------------------------------------------
const pnpm = runPnpm('pnpm', ['--version'], { timeoutMs: 120_000 })
check('pnpm is on PATH (pack and dsh plugin add both call it)',
  pnpm.status === 0 && Boolean(pnpm.output.trim()),
  pnpm.status === 0 ? pnpm.output.trim() : `${pnpm.spawnError || `exit=${pnpm.status}`}`)
if (pnpm.status !== 0) finish()

// ---- 2. pnpm pack -----------------------------------------------------------------
const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'))
const tarballName = `${manifest.name}-${manifest.version}.tgz`
const tarballPath = path.join(PACK_DIR, tarballName)
const pack = runPnpm('pack', ['pack', '--pack-destination', PACK_DIR], { cwd: PLUGIN, timeoutMs: 180_000 })
check('pnpm pack produces the tarball we would publish',
  pack.status === 0 && fs.existsSync(tarballPath),
  pack.status === 0 ? tarballName : `exit=${pack.status}${pack.timedOut ? ' (timed out)' : ''}`)
if (!fs.existsSync(tarballPath)) {
  reportFailure('pnpm pack', pack)
  finish()
}

// ---- 3. what the manifest promises is what the tarball ships ------------------
function walk (root, dir, into) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(root, absolute, into)
    else if (entry.isFile()) into.add(path.relative(root, absolute).split(path.sep).join('/'))
  }
}

function promisedFiles (root, pkg) {
  const expected = new Set()
  const missingOnDisk = new Set()
  // npm always ships the manifest, README/LICENCE and the `main` file, whether
  // or not `files` names them; modelling that keeps this list honest.
  expected.add('package.json')
  for (const name of ['README.md', 'README', 'LICENSE', 'LICENCE']) {
    if (fs.existsSync(path.join(root, name))) expected.add(name)
  }
  if (pkg.main) {
    const mainFile = pkg.main.split(path.sep).join('/')
    if (fs.existsSync(path.join(root, mainFile))) expected.add(mainFile)
    else missingOnDisk.add(mainFile)
  }
  for (const entry of pkg.files ?? []) {
    if (/[*?[\]{}]/.test(entry)) {
      console.warn(`note: "files" entry "${entry}" is a glob; only literal files and directories are expanded here`)
      continue
    }
    const absolute = path.join(root, entry)
    let stat
    try { stat = fs.statSync(absolute) } catch { missingOnDisk.add(entry); continue }
    if (stat.isDirectory()) walk(root, absolute, expected)
    else expected.add(entry.split(path.sep).join('/'))
  }
  // `files` is not the only declaration of what must ship: `exports`, `main`
  // and the dsh bundle patch are contracts the package itself promises. They
  // catch the release bug this suite exists for — dropping an entry from
  // `files` (e.g. "locale") while the manifest still serves it.
  for (const declared of contractFiles(root, pkg)) {
    if (expected.has(declared)) continue
    const absolute = path.join(root, declared)
    if (fs.existsSync(absolute)) expected.add(declared)
    else missingOnDisk.add(declared)
  }
  return { expected: [...expected].sort(), missingOnDisk: [...missingOnDisk] }
}

function contractFiles (root, pkg) {
  const declared = [pkg.dsh?.bundle?.patch]
  for (const value of Object.values(pkg.exports ?? {})) {
    if (typeof value === 'string') declared.push(value)
    else if (value && typeof value === 'object') {
      for (const nested of Object.values(value)) if (typeof nested === 'string') declared.push(nested)
    }
  }
  const files = new Set()
  for (const declaredPath of declared.filter(Boolean)) {
    if (/[*?[\]{}]/.test(declaredPath)) {
      let matches = []
      try { matches = fs.globSync(declaredPath, { cwd: root }) } catch { /* treat as absent */ }
      for (const match of matches) files.add(match.split(path.sep).join('/'))
    } else {
      files.add(declaredPath.replace(/^\.\//, '').split(path.sep).join('/'))
    }
  }
  return files
}

function readTarball (tgz) {
  const buffer = zlib.gunzipSync(fs.readFileSync(tgz))
  const field = (block, offset, length) => block.subarray(offset, offset + length).toString('utf8').replace(/\0.*$/s, '')
  const entries = new Set()
  let offset = 0
  let pendingName = null
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const name = field(header, 0, 100)
    const prefix = field(header, 345, 155)
    const size = Number.parseInt(field(header, 124, 12).trim(), 8) || 0
    const type = String.fromCharCode(header[156] || 48)
    offset += 512
    const body = buffer.subarray(offset, offset + size)
    offset += Math.ceil(size / 512) * 512
    if (type === 'x' || type === 'g') {
      const pax = /^\d+ path=(.*)$/m.exec(body.toString('utf8'))
      if (pax) pendingName = pax[1]
      continue
    }
    if (type === 'L') { pendingName = body.toString('utf8').replace(/\0.*$/s, '').trim(); continue }
    if (type !== '0') continue // directories and links are not shipped files
    entries.add((pendingName || (prefix ? `${prefix}/${name}` : name)).replace(/^package\//, ''))
    pendingName = null
  }
  return entries
}

const { expected, missingOnDisk } = promisedFiles(PLUGIN, manifest)
check('every file the manifest names exists in the checkout', missingOnDisk.length === 0, missingOnDisk.join(', '))

const shipped = readTarball(tarballPath)
const missing = expected.filter((entry) => !shipped.has(entry))
check('the tarball ships every file the package promises', missing.length === 0,
  missing.length ? `missing: ${missing.join(', ')}` : `${shipped.size} files, ${expected.length} promised`)
check('the tarball keeps cordis.patch.yml at the package root (dsh bundle patch path)',
  shipped.has('cordis.patch.yml'))

// ---- 4. install the tarball into a profile that has never seen it ------------
const init = runDsh('init', ['--profile', 'packed', '--from-default-profile', 'headless', '--dump-config'])
check('dsh composes a fresh profile from the shipped headless template',
  init.status === 0 && init.output.includes('dsh-base'), `exit=${init.status}`)
reportFailure('dsh profile init', init)

const add = runDsh('add', ['plugin', '--profile', 'packed', 'add', `file:${tarballPath}`])
check('dsh plugin manager installs the packed tarball',
  add.status === 0 && !/failed/i.test(add.output),
  add.output.trim().split(/\r?\n/).filter(Boolean).slice(-2).join(' | ').slice(0, 110))
reportFailure('dsh plugin add', add)

const dump = runDsh('dump', ['--profile', 'packed', '--dump-config'])
check('the installed tarball mounts the life layer', dump.status === 0 && /- id: dsh-life/.test(dump.output),
  `exit=${dump.status}`)
reportFailure('dsh dump-config', dump)

// ---- 5. boot it once: activation is the only proof the files are right ------
// No credentials here, so the model call is expected to fail; the point is that
// the plugin activated and wrote a real life before the transport gave up.
const boot = runDsh('boot', ['--profile', 'packed', 'say', 'pong'], { timeoutMs: BOOT_TIMEOUT_MS })
const identity = path.join(HOME, 'life', 'default', 'identity.json')
const lifeOnDisk = fs.existsSync(identity)
check('booting the packed profile creates a real life',
  !boot.timedOut && lifeOnDisk,
  boot.timedOut ? `timed out after ${BOOT_TIMEOUT_MS / 1000}s` : `exit=${boot.status}; identity=${lifeOnDisk ? 'present' : 'missing'}`)
// A non-zero exit is expected here (no credentials), so only a timeout or a
// missing life is worth dumping the transcript for.
if (boot.timedOut || !lifeOnDisk) {
  console.log(`\ndsh boot output (exit ${boot.status}${boot.timedOut ? ', timed out' : ''}):\n${tail(boot.output)}`)
}

finish()

function finish () {
  const failed = results.filter((result) => !result.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  if (failed.length) {
    console.log(`failed: ${failed.map((result) => result.label).join(' | ')}`)
    console.log(`\nkept for debugging:\n  tarball dir: ${PACK_DIR}\n  DSH_HOME:    ${HOME}`)
  } else {
    fs.rmSync(PACK_DIR, { recursive: true, force: true })
    fs.rmSync(HOME, { recursive: true, force: true })
  }
  process.exit(failed.length ? 1 : 0)
}
