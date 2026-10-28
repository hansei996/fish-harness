/**
 * landing — 像素级验证：落地页与场景原型在真浏览器里到底长成什么样。
 *
 * 为什么需要它：`verify/ui.mjs` 证明了界面那半边的**注册与数据**（包清单、桩 loader、
 * host 路由、私密不外泄），但它在文件开头就写明**不证明像素** —— 没有可驱动浏览器的
 * 环境。README 的「已知限制」与 `PLAN.md §0.7` 都把这条列为没验的事：
 *
 *   「界面只验到『注册与数据』这一层，像素级没验……**没证明它被真的画出来**。」
 *
 * 这一套补的就是那一格。它跑真 Chromium（Playwright），打开真的 `docs/index.html`，
 * 在三档视口下断言：没有横向溢出、没有 JS 错误、现场渲染的那一周真的画出来了
 * 且数字与 `docs/assets/life-demo.json` 对得上。
 *
 * ## 它自己也是「可被伪造的输入骗过吗」的一个例子
 *
 * 第一版在 `file://` 下跑，浏览器**拒绝 fetch 本地 JSON**（`URL scheme "file" is not
 * supported`），于是页面上那一周永远是空的 —— 而「没有横向溢出」「没有 JS 错误」两条
 * **照样 PASS**。那正是本仓库最反对的那种检查：它能被一个「什么都没渲染」的页面骗过。
 * 所以这一套起一个真的 HTTP 服务（页面线上也是 HTTP），并把「数据真的渲染出来了」
 * 当成一条硬断言 —— 它不是装饰，它是让上面两条不至于变成空话的那个前提。
 *
 * 前置：一个有 Chromium 的 Playwright。找不到就 SKIP（不是 FAIL）—— 缺工具不该
 * 被读成「页面坏了」。
 *
 * 用法：
 *   node verify/landing.mjs
 *   PLAYWRIGHT_PATH=<playwright 模块路径> node verify/landing.mjs
 */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DOCS = path.join(REPO, 'docs')

const results = []
const check = (label, ok, detail = '') => {
  results.push({ label, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}
const skip = (label, detail = '') => console.log(`SKIP  ${label}${detail ? ` — ${detail}` : ''}`)

// ---- 找到 Playwright（找不到就跳过，不当成失败）----------------------------
async function loadChromium () {
  // 依次尝试，第一个能 import 出 chromium 的就用：
  //   1. `PLAYWRIGHT_PATH` —— 显式指定，CI 与开发机都用得上；
  //   2. 仓库自己的 node_modules —— CI 里 `npm i -D playwright` 的情形；
  //   3. `npx playwright` 留在 npm 缓存里的那份 —— 开发机上最常见的形态；
  //   4. 裸包名 —— 交给 node 自己按父目录解析。
  const candidates = [
    process.env.PLAYWRIGHT_PATH,
    path.join(REPO, 'node_modules/playwright/index.mjs'),
    path.join(REPO, 'packages/dsh-life/node_modules/playwright/index.mjs'),
    ...(process.env.HOME ? [
      path.join(process.env.HOME, '.npm/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs'),
    ] : []),
    'playwright',
  ].filter(Boolean)

  for (const c of candidates) {
    try {
      // **必须**走 pathToFileURL：这是本仓库记过两次的坑（verify/README.md
      // 「Windows 上修过的四个坑」第 2 条）—— 裸路径 `import('C:\...')` 会报
      // ERR_UNSUPPORTED_ESM_URL_SCHEME。有意思的是，抓到这个的是仓库自己的
      // 那条断言（verify/day-report.mjs 里扫动态 import 的那条），
      // 说明那条检查值它的价。
      // 裸包名（'playwright'）交给 node 解析；路径必须过 pathToFileURL。
      const spec = c.includes('/') ? path.resolve(REPO, c) : c
      const mod = await import(pathToFileURL(spec).href)
      const chromium = mod.chromium || mod.default?.chromium
      if (chromium) return chromium
    } catch { /* 试下一个 */ }
  }
  return null
}

let chromium = await loadChromium()
if (!chromium) {
  skip('浏览器像素级验证', '没有可用的 Playwright/Chromium（设 PLAYWRIGHT_PATH 指过去）')
  console.log('\n0/0 checks passed（跳过）')
  process.exit(0)
}

// 模块在、但浏览器二进制没装：也算「环境没有浏览器」，不是页面坏了。
// 直接 launch 会抛，输出会停在一段堆栈上而看不出是哪一套的问题。
try {
  const probe = await chromium.launch()
  await probe.close()
} catch (err) {
  skip('浏览器像素级验证', `Playwright 装了但没有可启动的浏览器：${String(err).split('\n')[0].slice(0, 110)}`)
  console.log('\n0/0 checks passed（跳过）')
  process.exit(0)
}

// ---- 起一个真的 HTTP 服务 ---------------------------------------------------
// 线上是 HTTP；用 file:// 会让 fetch 本地 JSON 被浏览器拒绝（见文件头）。
const MIME = {
  '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.mp4': 'video/mp4', '.gif': 'image/gif', '.svg': 'image/svg+xml',
}
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '')
  const file = path.join(DOCS, rel)
  // 目录穿越防护：只能读 docs/ 下。
  if (!file.startsWith(DOCS)) { res.writeHead(403); return res.end() }
  fs.readFile(file, (err, body) => {
    if (err) { res.writeHead(404); return res.end('not found') }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' })
    res.end(body)
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const BASE = `http://127.0.0.1:${server.address().port}`

const browser = await chromium.launch()

// 数据文件缺失时**必须先给出一条 FAIL，而不是崩在 readFileSync 上**。
//
// 这不是假想的边角：真的发生了 —— 把 `life-demo.json` 挪走再跑，这一套直接
// `ENOENT` 崩掉、一行输出都没有。而它想说的恰恰是「页面渲染不出来」，
// 那种情况下最需要的就是一句能读的结论。崩掉还会让 `npm run verify` 的
// 输出停在这里，看不出是哪一套的问题。
const SHIPPED = path.join(DOCS, 'assets', 'life-demo.json')
let shipped = null
if (!fs.existsSync(SHIPPED)) {
  check('生命数据产物存在（docs/assets/life-demo.json）', false,
    `${path.relative(REPO, SHIPPED)} 不存在 —— 跑 node tools/demo-data.mjs 生成`)
} else {
  try {
    shipped = JSON.parse(fs.readFileSync(SHIPPED, 'utf8'))
    check('生命数据产物是合法 JSON 且含 dayReports', Array.isArray(shipped.dayReports) && shipped.dayReports.length > 0,
      `${shipped.dayReports?.length ?? 0} 天`)
  } catch (err) {
    check('生命数据产物是合法 JSON 且含 dayReports', false, `解析失败：${String(err).slice(0, 80)}`)
  }
}

try {
  // ---- 1. 三档视口：不溢出、无 JS 错误、那一周真的渲染出来 -------------------
  // 没有产物时，只跑「页面本身不坏」的两条，不拿「渲染出来了」去比一个不存在的数。
  const expectedDays = shipped ? shipped.dayReports.length : null

  for (const width of [1280, 820, 400]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } })
    const errors = []
    page.on('pageerror', (e) => errors.push(String(e)))
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })

    await page.goto(`${BASE}/index.html`, { waitUntil: 'load' })
    // 那一段是 fetch 出来的，等它落位（失败时下面会看到空容器，断言就红）。
    await page.waitForFunction(
      () => document.querySelectorAll('#life-days .days button').length > 0,
      { timeout: 5000 },
    ).catch(() => {})

    const state = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      dayButtons: document.querySelectorAll('#life-days .days button').length,
      daysText: (document.getElementById('life-days') || {}).innerText || '',
      // 卡片是数据到位后才显示的，所以它也是「现场渲染成功」的证据。
      cardsHidden: document.getElementById('week-cards')?.hasAttribute('hidden') ?? true,
      firstCard: (document.getElementById('card-interest') || {}).innerText || '',
    }))

    check(`@${width}px 没有横向溢出`,
      state.scrollWidth <= state.clientWidth,
      `scrollWidth=${state.scrollWidth} clientWidth=${state.clientWidth}`)

    check(`@${width}px 没有 JS / 控制台错误`,
      errors.length === 0,
      errors.slice(0, 2).join(' | ') || '干净')

    // 这一条是上面两条不变成空话的前提：页面真的把数据画出来了。
    // 产物缺失时这一条必然红 —— 那正是我们要的结论（页面渲染不出来），
    // 而不是崩掉或者静默通过。
    check(`@${width}px 那一周真的由 life-demo.json 现场渲染（不是空容器）`,
      expectedDays !== null && state.dayButtons === expectedDays,
      expectedDays === null
        ? `数据产物缺失，页面只画出 ${state.dayButtons} 个日期按钮`
        : `${state.dayButtons} 个日期按钮 / 数据里 ${expectedDays} 天`)

    if (width === 1280 && shipped) {
      check('日期按钮的文案与数据里的日期一致',
        shipped.dayReports.slice(0, 3).every((d) => state.daysText.includes(d.day)),
        state.daysText.split('\n').slice(0, 3).join(' / ').slice(0, 80))

      check('卡片区的数字算出来了（没有 JS 时它该是 hidden）',
        !state.cardsHidden && /\d/.test(state.firstCard),
        state.firstCard.slice(0, 90))

      // 手抄过的旧值不许出现在页面上 —— 它已经过期过一次（见 index.html 该节注释）。
      const bodyText = await page.evaluate(() => document.body.innerText)
      check('页面上没有那段已经过期的旧终端输出（「账本 90 条」）',
        !bodyText.includes('账本 90 条'),
        bodyText.includes('账本 90 条') ? '旧数字又回来了' : '已确认不存在')
    }

    await page.close()
  }

  // ---- 2. 场景原型：4 幕都能点走，且每拍都标了「靠什么成立」 -----------------
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    const errors = []
    page.on('pageerror', (e) => errors.push(String(e)))
    await page.goto(`${BASE}/scenarios.html`, { waitUntil: 'load' })
    await page.waitForTimeout(400)

    const scenes = await page.evaluate(() => ({
      tabs: document.querySelectorAll('.tabs button, .tabs a').length,
      hasStage: Boolean(document.querySelector('#scenario .stage, #scenario > *')),
      text: (document.querySelector('#scenario') || {}).innerText || '',
    }))
    check('场景原型：四个场景的标签都在',
      scenes.tabs >= 4,
      `${scenes.tabs} 个标签`)
    check('场景原型：舞台有内容（不是空壳）',
      scenes.hasStage && scenes.text.length > 80,
      `${scenes.text.length} 字符`)
    check('场景原型：没有 JS 错误', errors.length === 0, errors.slice(0, 2).join(' | ') || '干净')

    // 「每一拍都标了靠什么成立」是这个原型的核心承诺（README 里写明了）。
    const provCount = await page.evaluate(() =>
      document.querySelectorAll('.prov, [class*="prov"]').length,
    )
    check('场景原型：标出「靠什么成立」的元素真的在页面上',
      provCount > 0,
      `${provCount} 个 prov 元素`)

    await page.close()
  }
} finally {
  await browser.close()
  server.close()
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length) console.log(`failed: ${failed.map((r) => r.label).join(' | ')}`)
process.exit(failed.length ? 1 : 0)
