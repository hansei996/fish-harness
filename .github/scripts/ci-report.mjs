/**
 * Turn the two verify suites into one CI verdict plus a summary for remote triage.
 *
 * Both suites run with `continue-on-error`, so this script sees their real
 * outcomes and can let the second suite run even when the first one failed.
 * It writes the same markdown to the step summary (if GitHub provides one) and
 * to `verify-report.md`, which the workflow uploads as an artifact.
 *
 * Node builtins only: the repo has no dependencies and CI must not add any.
 */
import fs from 'node:fs'
import path from 'node:path'

function read (file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

function tail (text, lines = 30) {
  const body = text.trimEnd()
  if (!body) return '(no output)'
  return body.split(/\r?\n/).slice(-lines).join('\n')
}

function dshVersion () {
  try {
    // DSH_BIN is the package's lib/bin.js; its grandparent is the package dir.
    const dir = path.dirname(path.dirname(process.env.DSH_BIN || ''))
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version
  } catch {
    return 'unknown'
  }
}

const smoke = process.env.SMOKE_OUTCOME || 'unknown'
const e2e = process.env.E2E_OUTCOME || 'unknown'
const os = process.env.MATRIX_OS || process.env.RUNNER_OS || 'unknown'

const fence = (body) => '```text\n' + tail(body) + '\n```'
const rows = [
  ['os', os],
  ['node', process.version],
  ['dsh', dshVersion()],
  ['smoke', smoke],
  ['e2e', e2e],
]

const markdown = [
  `## verify — ${os}`,
  '',
  '| item | value |',
  '| --- | --- |',
  ...rows.map(([key, value]) => `| ${key} | ${value} |`),
  '',
  `<details><summary>smoke output (last 30 lines, ${smoke})</summary>`,
  '',
  fence(read('verify-smoke.log')),
  '',
  '</details>',
  '',
  `<details><summary>e2e output (last 30 lines, ${e2e})</summary>`,
  '',
  fence(read('verify-e2e.log')),
  '',
  '</details>',
  '',
].join('\n')

fs.writeFileSync('verify-report.md', markdown)
if (process.env.GITHUB_STEP_SUMMARY) {
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown)
}
console.log(markdown)

if (smoke !== 'success' || e2e !== 'success') {
  console.error(`verify failed: smoke=${smoke} e2e=${e2e}`)
  process.exit(1)
}
