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
  // demo-data 守着「对外页面上的数字没有过期」：它是 docs/assets/life-demo.json
  // 与当前实现是否一致的闸门。放在 day-report 旁边 —— 两者都不需要 dsh，都便宜。
  { name: 'demo data', file: 'verify-demo-data.log', outcome: process.env.DEMODATA_OUTCOME },
  { name: 'life week', file: 'verify-life-week.log', outcome: process.env.LIFEWEEK_OUTCOME },
  { name: 'ui', file: 'verify-ui.log', outcome: process.env.UI_OUTCOME },
  { name: 'publish', file: 'verify-publish.log', outcome: process.env.PUBLISH_OUTCOME },
  { name: 'e2e', file: 'verify-e2e.log', outcome: process.env.E2E_OUTCOME },
  { name: 'pack', file: 'verify-pack.log', outcome: process.env.PACK_OUTCOME },
  // landing 在没有浏览器的机器上自己 SKIP（exit 0），所以不会把闸门弄红。
  { name: 'landing', file: 'verify-landing.log', outcome: process.env.LANDING_OUTCOME },
  { name: 'market', file: 'verify-market.log', outcome: process.env.MARKET_OUTCOME },
  { name: 'scenarios', file: 'verify-scenarios.log', outcome: process.env.SCENARIOS_OUTCOME },
  // framework 守的是总览图（docs/framework.html）：图上的边与数必须与源码一致。
  { name: 'framework', file: 'verify-framework.log', outcome: process.env.FRAMEWORK_OUTCOME },
  // video 守的是视频发布线：标注、核验、批准绑定文件字节。
  { name: 'video', file: 'verify-video.log', outcome: process.env.VIDEO_OUTCOME },
  // 入库的视频物证是否还带着当前规则的标识（物证不许过期）。
  { name: 'video evidence', file: 'verify-video-evidence.log', outcome: process.env.VIDEOEVIDENCE_OUTCOME },
  // claims 守的是「文档里的数字不许手抄、不许回流成旧值」。它读的正是前面那些
  // 套件的项数，所以**只出现一次，且排在最后** —— 两处一样的条目曾经让这个
  // workflow 与这份报告各有一份重复（一个人加的、另一个人也加了），
  // workflow 侧直接 0 秒失败：YAML 的重复 key 让整个文件非法。
  { name: 'claims', file: 'verify-claims.log', outcome: process.env.CLAIMS_OUTCOME },
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
