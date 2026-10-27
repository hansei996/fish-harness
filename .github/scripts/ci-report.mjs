/**
 * Turn the verify suites into one CI verdict plus a summary for remote triage.
 *
 * Every suite runs with `continue-on-error`, so this script sees their real
 * outcomes and can let later suites run even when an earlier one failed.
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

// 每套件：报告里显示的名字、raw log 文件名、自己的 outcome 环境变量。
// log 文件名显式写出，不用 `verify-${name}.log` 推：`day-report` 会让推导出错的
// （推导得到 verify-day-report.log 只有当 name 恰好等于文件名片段时才成立）。
const suites = [
  { name: 'smoke', file: 'verify-smoke.log', outcome: process.env.SMOKE_OUTCOME },
  { name: 'day report', file: 'verify-day-report.log', outcome: process.env.DAYREPORT_OUTCOME },
  { name: 'e2e', file: 'verify-e2e.log', outcome: process.env.E2E_OUTCOME },
  { name: 'pack', file: 'verify-pack.log', outcome: process.env.PACK_OUTCOME },
].map((suite) => ({ ...suite, outcome: suite.outcome || 'unknown' }))
const os = process.env.MATRIX_OS || process.env.RUNNER_OS || 'unknown'

const fence = (body) => '```text\n' + tail(body) + '\n```'
const details = ({ name, file, outcome }) => [
  `<details><summary>${name} output (last 30 lines, ${outcome})</summary>`,
  '',
  fence(read(file)),
  '',
  '</details>',
].join('\n')

const rows = [
  ['os', os],
  ['node', process.version],
  ['dsh', dshVersion()],
  ...suites.map(({ name, outcome }) => [name, outcome]),
]

const markdown = [
  `## verify — ${os}`,
  '',
  '| item | value |',
  '| --- | --- |',
  ...rows.map(([key, value]) => `| ${key} | ${value} |`),
  '',
  ...suites.flatMap((suite) => [details(suite), '']),
].join('\n')

fs.writeFileSync('verify-report.md', markdown)
if (process.env.GITHUB_STEP_SUMMARY) {
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown)
}
console.log(markdown)

const failed = suites.filter(({ outcome }) => outcome !== 'success')
if (failed.length) {
  console.error(`verify failed: ${failed.map(({ name, outcome }) => `${name}=${outcome}`).join(' ')}`)
  process.exit(1)
}
