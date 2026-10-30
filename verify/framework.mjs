/**
 * framework — 守住 `docs/framework.html`：那张总图上画的每条线、每个数，都对着源码核。
 *
 * 为什么需要它：那一页的形态是**一张图**，而图是最容易「看起来对」的产物 ——
 * 一条不存在的依赖、一个写错的工具数、一个手抄的行数，在图上和一个真事实长得
 * 一模一样。这个仓库已经因为同一类原因吃过两次亏：
 *
 *   1. 「每轮注入的快照有多大」这个数在三个文件里有三个不同的值，而它是整篇
 *      论点的唯一证据（它要是随寿命增长，「长期跑得起」就反了）。
 *   2. `docs/module-graph.html` 画的是 import 边，但那 11 条边是**手抄**进
 *      页面脚本的，没有任何东西核对它们与源码一致。
 *
 * 所以这一套把图上那几类声称全部变成断言：
 *
 *   - 页面脚本里列的 import 边 == 从源码扫出来的边（一条不许多、一条不许少）；
 *   - 页面里每个 `life_*` 工具名、每个状态文件名都真实存在；
 *   - 页面里引用的每条命令（tools/facts.mjs、verify/*.mjs）真实存在；
 *   - 生成块（包规模、快照字节）与 `measureCodeFacts()` 的最新值逐字一致；
 *   - 「没有证明什么」那段一直在（删掉它，这一页就变成能力声称）。
 *
 * 它**不检查**像素 —— 那由 `verify/landing.mjs` 用真 Chromium 管（它管 index.html
 * 与 scenarios.html）。这一套是纯文本 + 纯源码的核对，不需要浏览器、不需要 dsh、不需要网络。
 *
 * 用法：
 *   node verify/framework.mjs              # 全部（有 DSH_BIN 时会核 dsh 包规模）
 *   node verify/framework.mjs --offline    # 跳过「要本机装了 dsh 才能量」的那几条
 *
 * **`--offline` 是有意的**，理由与 `verify/market.mjs --offline` 完全相同：
 * `tools/facts.mjs` 在数各套项数时会用它（见 SUITES 里的 `offlineArgs`），
 * 而项数是要写进文档的**结构事实**。dsh 包规模取决于本机那棵安装树的 peer 组合
 * （实测同一台机器上就先出现过 560 个目录），跨环境一比就会漂 —— 于是 `claims`
 * 会在 CI 上报一个假红，而页面上的数字其实没错。所以：
 *
 *   - 记录在文档里的项数 = `--offline` 口径（CI 与本机都跑它，稳定）；
 *   - 联网/装了 dsh 时才做得动的核对 = 本机手动跑不带 flag 的那一次。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { measureCodeFacts, BLOCKS } from '../tools/facts.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8')

const results = []
const check = (label, ok, detail = '') => {
  results.push({ label, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

const PAGE = 'docs/framework.html'
if (!fs.existsSync(path.join(REPO, PAGE))) {
  console.error(`找不到 ${PAGE}`)
  process.exit(1)
}
const page = read(PAGE)
const facts = measureCodeFacts()

// `--offline` 只跳「要本机那棵 dsh 安装树才能量」的几条；其余断言（图的边、
// 挂载 API、生成块、诚实性）与网络、与装没装 dsh 都无关，照跑。
const OFFLINE = process.argv.includes('--offline') || process.env.FRAMEWORK_OFFLINE === '1'

// ---------- 1. 图上画的 import 边 == 源码里的 import 边 ---------------------
//
// 判据是**集合相等**，不是「页面里的边在源码里都存在」：
// 后者允许「漏画一条」静默通过，而漏画一条依赖与多画一条一样会误导读者
// （他会以为两个模块没有关系）。所以两个方向都查。
const declared = [...page.matchAll(/\['([a-z-]+)','([a-z-]+)'\]/g)].map((m) => `${m[1]}->${m[2]}`)
// 页面里还用了 ['index','tg'] 这种短名（元素 id 是 n-tg），源码里是 telegram。
// 两条别名的理由：图上用短名省地方（元素 id 是 `n-tg` / `n-comp`），
// 源码里是完整文件名。**只允许这两条**，而且是写死的 —— 让图随便改个名字就过，
// 等于把这条断言变成「图上写什么源码就接受什么」。
const ALIAS = { tg: 'telegram', comp: 'compliance' }
const declaredNorm = new Set(declared.map((e) => {
  const [a, b] = e.split('->')
  return `${a}->${ALIAS[b] || b}`
}))
const realEdges = new Set(facts.edges.map((e) => `${e[0]}->${e[1]}`))

const missing = [...realEdges].filter((e) => !declaredNorm.has(e))
const ghost = [...declaredNorm].filter((e) => !realEdges.has(e))
check('图上画的 import 边与源码一致（不多画、不漏画）',
  missing.length === 0 && ghost.length === 0,
  [
    missing.length ? `源码里有、图上没画：${missing.join(', ')}` : '',
    ghost.length ? `图上有、源码里没有：${ghost.join(', ')}` : '',
  ].filter(Boolean).join('; ') || `${realEdges.size} 条边已核`)

// 边的条数也写进页面文案里（「9 个模块的 11 条 import」），所以单独核一次数字。
const edgeCountClaim = /(\d+)\s*条\s*import/.exec(page)
check('页面文案里的 import 条数与实测一致',
  Boolean(edgeCountClaim) && Number(edgeCountClaim[1]) === facts.edges.length,
  edgeCountClaim ? `页面写 ${edgeCountClaim[1]}，实测 ${facts.edges.length}` : '页面里没找到条数文案')

// ---------- 1b. 页面上写死的那几个结构数字也要对得上 ------------------------
//
// 这几处（工具数、状态文件数、账本 kind 数、模块数）不是生成块，因为它们是散在
// 卡片文案里的，而句子中间的 `<b>17</b> 个工具` 没法用成对标记围起来。所以改成
// 「把页面里的数抓出来、与实测比」：每个数都锚在一个**唯一**的短语上，
// 短语不在（有人重写了那句话）会 FAIL 而不是静默跳过 —— 静默跳过正是这类
// 检查最容易骗过自己的方式。
const NUMERIC_CLAIMS = [
  { label: '工具数', re: /ctx\.tools\.register\(\)\s*×\s*(\d+)/, real: facts.tools.count },
  { label: '工具数（文案）', re: /register\(\)\s*×\s*(?:<b>)?(\d+)/, real: facts.tools.count },
  { label: '状态文件数', re: /写：全部\s*(\d+)\s*个状态文件/, real: facts.stateFiles.count },
  { label: '状态文件数（文案）', re: /(\d+)\s*个状态文件的每一次写入/, real: facts.stateFiles.count },
  { label: '账本 kind 数', re: /只追加\s*<em>(\d+)\s*种 kind/, real: facts.ledgerKinds.count },
  { label: '模块数', re: /(\d+)\s*个模块(?:<\/b>)?的/, real: facts.code.hostFiles },
  { label: '模块数（带标题）', re: /(\d+)\s*个宿主模块/, real: facts.code.hostFiles },
]
for (const c of NUMERIC_CLAIMS) {
  const m = c.re.exec(page)
  check(`页面里的${c.label}与实测一致`,
    Boolean(m) && Number(m[1]) === c.real,
    m ? `页面写 ${m[1]}，实测 ${c.real}` : `页面里没找到${c.label}那句（改文案要同步改这里）`)
}

// ② 组里每个包都必须至少有一条真实挂载（写进文案却没有任何线指向它，
// 读者会以为它被接上了）。判据用 `WIRES` 那份表本身 —— 它就是页面脚本画线用的源。
{
  // 只数 dsh 那一侧的接线（元素 id 前缀 `p-`）：`DISK` 表用的也是 `from:`
  // 这个键（值是 `n-*` 的模块），不加前缀会把磁盘线也算进来，得出 9 而不是 7。
  const wiredIds = [...page.matchAll(/\{ from:'(p-[a-z-]+)'/g)].map((m) => m[1])
  const wiredCount = new Set(wiredIds).size
  const m = /这 <b>(\d+) 个包<\/b>共给了我们 <b>(\d+) 个服务注入 \+ (\d+) 个事件监听 \+ (\d+) 个客户端 slot<\/b>/.exec(page)
  const realMounts = facts.serviceMounts.length
  const realEvents = facts.events.length
  const realSlots = facts.slots.length
  check('页面里「N 个包给了多少扩展点」与实测一致',
    Boolean(m) && Number(m[1]) === wiredCount && Number(m[2]) === realMounts
      && Number(m[3]) === realEvents && Number(m[4]) === realSlots,
    m ? `页面写 ${m[1]} 包 / ${m[2]} 注入 / ${m[3]} 事件 / ${m[4]} slot；实测 ${wiredCount} 包 / ${realMounts} 注入 / ${realEvents} 事件 / ${realSlots} slot`
      : '页面里没找到那句扩展点计数')
}

// ---------- 2. 页面上出现的工具名 / 状态文件名都真实存在 --------------------
const mentionedTools = [...new Set([...page.matchAll(/\b(life_[a-z_]+)\b/g)].map((m) => m[1]))]
const realTools = new Set(facts.tools.names)
const ghostTools = mentionedTools.filter((t) => !realTools.has(t))
check('页面上每个 life_* 工具名真实存在',
  ghostTools.length === 0,
  ghostTools.length ? `不存在：${ghostTools.join(', ')}` : `${mentionedTools.length} 个已核`)

const mentionedState = [...new Set([...page.matchAll(/\b([a-z-]+\.jsonl?)\b/g)].map((m) => m[1]))]
const realState = facts.stateFiles.names
// `/life/state.json` 是 Web 路由名，不是磁盘上的状态文件 —— 它是这一页里唯一
// 合法出现、却不在 `store.files` 里的 `.json`。这不是放水：它的正确性由
// 「页面上写的是 `/life/state.json`」这一条单独查（见下），而不是从状态文件表里豁免。
const ROUTE_NAMES = new Set(['state.json'])
const ghostState = mentionedState.filter((f) => !realState.includes(f) && !ROUTE_NAMES.has(f))
check('页面上每个状态文件名真实存在',
  ghostState.length === 0,
  ghostState.length ? `不存在：${ghostState.join(', ')}` : `${mentionedState.length} 个已核`)

// 那条被排除的 Web 路由名要单独核：它必须与 `lib/ui.js` 里的常量一致，
// 否则页面会写一个打不开的地址，而它看上去完全正常。
const uiSrc = read('packages/dsh-life/lib/ui.js')
const routeMatch = /LIFE_STATE_PATH = '([^']+)'/.exec(uiSrc)
check('页面写的只读接口与 lib/ui.js 的路由常量一致',
  Boolean(routeMatch) && page.includes(routeMatch[1]),
  routeMatch ? `源码 ${routeMatch[1]}，页面${page.includes(routeMatch[1]) ? '一致' : '不一致'}` : '源码里没找到 LIFE_STATE_PATH')

// 挂载点的 API 名：页面把每个挂载点写成 `ctx.tools.register()` 这种形式，
// 写错一个读者就照着抄一个不存在的 API。核法：页面里出现的 `ctx.<服务>.<方法>(`
// 必须在源码里真的出现（去掉 ctx. 前缀，写成 root.inject / root.on 的形式）。
const API_PAIRS = [
  { page: 'ctx.tools.register()', src: 'tools.register(' },
  { page: 'ctx.systemPrompt.section()', src: 'systemPrompt.section(' },
  { page: 'ctx.schedule.create()', src: 'schedule.create' },
  { page: 'ctx.approval.request()', src: 'approval.request(' },
  { page: 'ctx.webServer.register()', src: 'webServer.register(' },
  { page: 'ctx.connection.fetch.register()', src: 'connection.fetch.register(' },
]
const pluginSrc = facts.code.files ? read('packages/dsh-life/lib/index.js') + read('packages/dsh-life/lib/ui.js') : ''
const badApis = API_PAIRS.filter((p) => page.includes(p.page) && !pluginSrc.includes(p.src))
check('页面上写的每个挂载 API 在源码里真的被调用',
  badApis.length === 0,
  badApis.length ? `页面上有、源码里没有：${badApis.map((p) => p.page).join(', ')}`
    : `${API_PAIRS.filter((p) => page.includes(p.page)).length} 个 API 已核`)

// 事件监听的名称同理。
const EVENTS = ['session/event', 'agent/inbox/claimed']
const badEvents = EVENTS.filter((e) => page.includes(e) && !pluginSrc.includes(`on('${e}'`))
check('页面上写的每个事件名在源码里真的被监听',
  badEvents.length === 0,
  badEvents.length ? `不存在：${badEvents.join(', ')}` : `${EVENTS.length} 个事件已核`)

// ---------- 3. 页面引用的命令都真实存在 -------------------------------------
// 引用一个不存在的脚本比引用一个过期的数字更糟：读者会照着敲，然后拿到 ENOENT
// 而不知道是谁写错了。（这个仓库真的发生过 —— AGENTS.md 曾指向被删的 verify/numbers.mjs。）
const referenced = [...new Set([...page.matchAll(/(?:verify|tools)\/[a-z0-9-]+\.mjs/g)].map((m) => m[0]))]
const dangling = referenced.filter((rel) => !fs.existsSync(path.join(REPO, rel)))
check('页面上引用的每个脚本都真实存在',
  dangling.length === 0,
  dangling.length ? `指向不存在的文件：${dangling.join(', ')}` : `${referenced.length} 个引用已核`)

// ---------- 3b. dsh 那一侧的规模（包数 / 版本）也核 --------------------------
//
// **它故意不是生成块**，理由值得写下来：渲染那一格需要本机装好一个可解析的 dsh
// （要读 `$DSH_BIN` 指过去的那棵树）。写成生成块的话，CI 上装出来的 dsh 树与
// 开发机上的**目录数不一样**（peer 组合不同），`claims` 就会在 CI 上报一个假红。
// 所以数字写在页面里、由这一条来核：本机量得到就必须一致，量不到就显式 SKIP。
//
// 「量不到」与「量到了但不一致」是两件事，必须分开 —— 把前者读成后者，人就会
// 学会忽略这条断言。
const dshFacts = facts.dsh
if (OFFLINE) {
  // 跳过**不计入 results**：这样 `--offline` 的项数是确定的（CI 与本机一致），
  // 而「跳过」这件事仍然看得见 —— 静默少几条才是真的骗人。
  console.log('SKIP  dsh 包规模 / .pnpm 目录数 / 版本 —— --offline 口径（要本机装了 dsh 才量得动）')
} else if (!dshFacts || dshFacts.packages === null) {
  console.log('SKIP  dsh 包规模 —— 本机没有可解析的 dsh 安装（设 DSH_BIN 后重跑；或这是 --offline 口径）')
} else {
  const m = /<b>(\d+) 个<\/b> <code>@deepseek-ai\/\*<\/code> 包/.exec(page)
  check('页面里的 dsh 包规模与实测一致',
    Boolean(m) && Number(m[1]) === dshFacts.packages,
    m ? `页面写 ${m[1]}，实测 ${dshFacts.packages}` : '页面里没找到包规模那句')
  const dirM = /<code>\.pnpm<\/code> 下共 (\d+) 个目录/.exec(page)
  check('页面里的 .pnpm 目录数与实测一致',
    Boolean(dirM) && Number(dirM[1]) === dshFacts.entries,
    dirM ? `页面写 ${dirM[1]}，实测 ${dshFacts.entries}` : '页面里没找到目录数那句')
  const vM = /装的是 dsh <code>([^<]+)<\/code>/.exec(page)
  check('页面里写的 dsh 版本与实测一致',
    Boolean(vM) && vM[1] === dshFacts.version,
    vM ? `页面写 ${vM[1]}，实测 ${dshFacts.version}` : '页面里没找到版本那句')
}

// ---------- 4. 生成块与实测一致 ---------------------------------------------
// 这两格（dsh 包规模、每轮快照字节）是本页唯一带数字的地方，都由 facts.mjs 生成。
// 直接复用它的比对逻辑：手改这两格里的任何一个数字都会红。
const pageBlocks = BLOCKS.filter((b) => b.file === PAGE)
check('这一页有生成块（数字不能手写）',
  pageBlocks.length > 0,
  `${pageBlocks.length} 个：${pageBlocks.map((b) => b.name).join(', ')}`)
// 自己比对，不调 `checkBlocks()`：那个函数会渲染**全部**块，而其中几个
// （verify-summary / verify-headline 等）要求 `facts.verify`，不带 `--suites`
// 时它会先抛错 —— 于是这一套会被一句与它无关的异常打断欣赏。这里只比本页的块，
// 比对规则与 facts.mjs 逐字相同（归一化换行 + 去首尾空行），免得两处判据漂开。
const normalizeEol = (text) => text.replace(/\r\n/g, '\n')
const stale = []
for (const block of pageBlocks) {
  const open = `<!-- facts:${block.name} -->`
  const close = `<!-- /facts:${block.name} -->`
  const i = page.indexOf(open), j = page.indexOf(close)
  if (i < 0 || j < 0) { stale.push({ block: block.name, reason: '标记缺失' }); continue }
  const onDisk = normalizeEol(page.slice(i + open.length, j)).replace(/^\n|\n$/g, '')
  if (onDisk !== normalizeEol(block.render(facts))) stale.push({ block: block.name, reason: '与实测不一致' })
}
check('本页的生成块与实测一致',
  stale.length === 0,
  stale.length ? stale.map((s) => `${s.block}：${s.reason}`).join('; ') : `${pageBlocks.length} 个块已核`)

// 快照字节那一格必须真的是量出来的数，不是页面里手打的。判据：页面里的数字
// 出现在 facts.snapshot.bytes 的位置上，且这个数**不是**一个整数常数以外的形式。
check('「每轮注入字节」那一格是本机量出来的',
  Boolean(facts.snapshot) && page.includes(`${facts.snapshot.bytes} 字节封顶`),
  facts.snapshot ? `实测 ${facts.snapshot.bytes} 字节，页面 ${page.includes(`${facts.snapshot.bytes} 字节封顶`) ? '一致' : '不一致'}` : '没量到快照')

// ---------- 5. 诚实性：两段必须在 -------------------------------------------
// 这一页的形态是「一张看起来很完整的图」，它最危险的退化是读起来像
// 「这些都做完了」。所以两段必须一直在：证明什么 / 没有证明什么。
for (const heading of ['这张图证明什么', '这张图没有证明什么']) {
  check(`页面保留了「${heading}」那一段`, page.includes(heading))
}
// 而且「没有证明什么」里必须点出「跨进程没有锁」与「发布线没连过真平台」 ——
// 这两条是最容易被漂亮图掩盖的未实现项。
check('未验清单里点明了「没有跨进程锁」', /没有跨进程锁|跨进程/.test(page))
check('未验清单里点明了「发布线没接真实平台」', /发布线/.test(page) && /真实|没连过|没有过/.test(page))

// ---------- 汇总 -------------------------------------------------------------
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length) console.log(`failed: ${failed.map((r) => r.label).join(' | ')}`)
process.exit(failed.length ? 1 : 0)
