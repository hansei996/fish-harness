/**
 * Bakes「它的一周」：四个场景讲一件单日演示讲不了的事 —— 累积。
 *
 *   场景 1 — 第 1 天：一次失败，留下一条明天要做的事
 *   场景 2 — 第 2 天：它醒来时，昨天的失败还在状态里
 *   场景 3 — 7 天：兴趣是被经历推上去的，不是第一天写死的
 *   场景 4 — 诚实的一页：这证明了什么、没证明什么
 *
 * 手法与 bake-showcase.mjs 一致：`pagx render` 不接受时间参数，所以每一帧
 * 在这里算出来、各自写成一个 PAGX 文档。PAGX 负责矢量/文字/图片合成，
 * 运动由这个文件负责。
 *
 * 画面里的每个数字都来自 `node tools/life-week.mjs` 的真实输出，
 * 不是手写的样例值。
 *
 * 用法：
 *   PAGX_BIN=... node bake-oneweek.mjs
 *   ffmpeg -framerate 30 -i frames-week/f%04d.png -c:v libx264 -pix_fmt yuv420p \
 *     -crf 19 -movflags +faststart oneweek.mp4
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const PAGX = process.env.PAGX_BIN || 'node_modules/@libpag/pagx/bin/darwin/pagx'
const AVATAR_SRC = process.env.AVATAR_SRC || 'avatar.png'
const AV = fs.readFileSync(AVATAR_SRC).toString('base64')
const OUT = 'frames-week'
const W = 800, H = 480
const FPS = 30

fs.rmSync(OUT, { recursive: true, force: true })
fs.mkdirSync(OUT, { recursive: true })

const eo = t => 1 - Math.pow(1 - t, 3)
const seg = (t, a, d) => Math.max(0, Math.min(1, (t - a) / d))

const INK = '#1B2C61'
const MUTED = '#8A95AD'
const ACC = '#4F6FC0'
const OK = '#15803D'
const BAD = '#B91C1C'

// 文字节点重复太多次，收成一个助手，免得每个场景都在拼同样的 XML。
const txt = (left, top, w, h, s, size, color, align = 'start', bold = false) => `
  <Layer left="${left}" top="${top}" width="${w}" height="${h}">
    <TextBox textAlign="${align}" width="${w}" height="${h}">
      <Text text="${s}" fontFamily="STHeiti"${bold ? ' fontStyle="Bold"' : ''} fontSize="${size}"/>
      <Fill color="${color}"/>
    </TextBox>
  </Layer>`

const bar = (alpha, tag) => `
  <Layer id="hdr" left="34" top="24" alpha="${alpha}">
    <Layer left="0" top="0" width="30" height="30">
      <Rectangle width="30" height="30" roundness="10"/><Fill color="#E8EEFA"/>
    </Layer>
    <Layer left="3" top="3" width="24" height="24">
      <Rectangle width="24" height="24"/><Fill><ImagePattern image="@avatar"/></Fill>
    </Layer>
    <Layer left="38" top="4" width="420" height="24">
      <TextBox textAlign="start" width="420" height="24">
        <Text text="一周 · ${tag}" fontFamily="STHeiti" fontStyle="Bold" fontSize="16"/>
        <Fill color="${INK}"/>
      </TextBox>
    </Layer>
  </Layer>`

const shell = (alpha) => `
  <Layer id="card" left="40" top="72" alpha="${alpha}" width="720" height="336">
    <Rectangle width="720" height="336" roundness="24"/><Fill color="#FFFFFF"/>
    <Stroke color="#E4EAF5" width="1.5"/>
    <DropShadowStyle offsetY="10" blurX="30" blurY="30" color="#1B2C6116"/>
  </Layer>`

const foot = (alpha, s, color = MUTED) =>
  txt(40, 424, 720, 24, s, 13, color)

const frame = (inner) => `<?xml version="1.0" encoding="UTF-8"?>
<pagx width="${W}" height="${H}">
  <Resources>
    <Image id="avatar" source="data:image/png;base64,${AV}"/>
  </Resources>
  <Layer name="bg" width="100%" height="100%"><Rectangle width="100%" height="100%"/><Fill color="#EEF3FB"/></Layer>
${inner}
</pagx>`

// ============================================================
// 场景 1 — 第 1 天：一次失败，留下一条明天
// 数字来自 `node tools/life-week.mjs`：10:29 没做成、证据 save:aaf500。
// ============================================================
function sc1 (t) {
  const inP = eo(seg(t, 0, 0.5))
  const rows = [
    ['08:00', '出生了 · 带着两个兴趣、一个承诺', MUTED],
    ['09:15', '开始：看看「机械键盘手感」的更新', ACC],
    ['10:29', '没做成：资料对不上｜证据 save:aaf500', BAD],
    ['13:18', '做成了：看看「像素矿工小品」的更新｜证据 link:8f936a', OK],
    ['19:52', '兑现了答应的事', OK],
  ]
  let body = ''
  rows.forEach(([tm, what, col], i) => {
    const a = eo(seg(t, 0.4 + i * 0.34, 0.34))
    const y = 116 + i * 40
    body += `
    <Layer left="64" top="${y}" alpha="${a}">
      ${txt(0, 1, 46, 20, tm, 12, MUTED)}
      <Layer left="52" top="0" width="20" height="22">
        <Ellipse width="8" height="8" position="0,7"/><Fill color="${col}"/>
      </Layer>
      ${txt(74, 0, 560, 22, what, 13, INK)}
    </Layer>`
  })

  // 失败那一条下方拉出交接：这是整个场景的重点
  const hand = eo(seg(t, 2.2, 0.6))
  const line = eo(seg(t, 2.35, 0.5))
  const f = eo(seg(t, 3.4, 0.7))

  return frame(`${bar(inP, '第 1 天 · 一次失败')}
${shell(inP)}
  ${body}
  <Layer left="64" top="${322}" alpha="${line}" width="672" height="1">
    <Rectangle width="672" height="1"/><Fill color="#EDF1F8"/>
  </Layer>
  <Layer left="64" top="${338}" alpha="${hand}" width="672" height="46">
    <Rectangle width="672" height="46" roundness="12"/><Fill color="#F2F6FF"/>
    <Stroke color="#D8E2F5" width="1.2"/>
    ${txt(16, 13, 640, 22, '→  留下了明天要做的事：换个打法再试一次', 13.5, ACC, 'start', true)}
  </Layer>
  ${foot(f, '失败没有变成空白 —— 它变成了一条留给明天的事', ACC)}`)
}

// ============================================================
// 场景 2 — 第 2 天：醒来时，昨天那条还在
// 「在磁盘上」是这里真正要说的事：状态不属于任何一次会话。
// ============================================================
function sc2 (t) {
  const inP = eo(seg(t, 0, 0.5))
  const wake = eo(seg(t, 0.4, 0.5))
  const look = eo(seg(t, 1.2, 0.5))
  const cardA = eo(seg(t, 1.9, 0.6))
  const cardB = eo(seg(t, 2.5, 0.6))
  const note = eo(seg(t, 3.5, 0.7))

  const stateCard = (top, alpha, title, value, vcol) => `
  <Layer left="64" top="${top}" alpha="${alpha}" width="672" height="62">
    <Rectangle width="672" height="62" roundness="14"/><Fill color="#F7F9FD"/>
    <Stroke color="#E4EAF5" width="1.2"/>
    ${txt(20, 10, 620, 18, title, 11.5, MUTED)}
    ${txt(20, 30, 620, 22, value, 14, vcol, 'start', true)}
  </Layer>`

  return frame(`${bar(inP, '第 2 天 · 它接着昨天')}
${shell(inP)}
  <Layer left="64" top="112" alpha="${wake}">
    ${txt(0, 0, 400, 24, '08:02  自己醒来', 14, INK, 'start', true)}
  </Layer>
  <Layer left="64" top="146" alpha="${look}">
    ${txt(0, 0, 620, 22, '先读一眼自己的状态 —— 不是从零开始', 13, MUTED)}
  </Layer>
  ${stateCard(190, cardA, '昨天留下的下一步', '换个打法再试一次「机械键盘手感」', ACC)}
  ${stateCard(262, cardB, '兴趣（第 1 天 → 第 2 天）', '像素矿工小品  0.55 → 0.79 ｜ 观察 3 次', OK)}
  <Layer left="64" top="${342}" alpha="${note}" width="672" height="40">
    <Rectangle width="672" height="40" roundness="12"/><Fill color="#FFF8E8"/>
    <Stroke color="#F0E0BC" width="1.2"/>
    ${txt(16, 10, 640, 20, '这条不在提示词里，在磁盘上 —— 进程重启也不会丢', 12.5, '#8A6414')}
  </Layer>
  ${foot(eo(seg(t, 4.1, 0.7)), '它在继续，不是在重新开始', ACC)}`)
}

// ============================================================
// 场景 3 — 7 天：兴趣是被经历推上去的
// 数值来自真实输出：0.55 → 0.67 → 0.91 → 0.95（观察 17 次）。
// ============================================================
function sc3 (t) {
  const inP = eo(seg(t, 0, 0.5))
  const steps = [
    ['出生档案', 0.55, '来自主人'],
    ['第 1 天', 0.67, '来自经历'],
    ['第 3 天', 0.91, '来自经历'],
    ['第 7 天', 0.95, '来自经历 · 观察 17 次'],
  ]
  const MAXW = 400
  let body = ''
  steps.forEach(([label, value, src], i) => {
    const a = eo(seg(t, 0.4 + i * 0.45, 0.45))
    const y = 122 + i * 52
    const w = Math.max(4, MAXW * value * a)
    body += `
    <Layer left="64" top="${y}" alpha="${Math.min(1, a * 1.4)}">
      ${txt(0, 0, 90, 20, label, 13, INK, 'start', true)}
      <Layer left="96" top="9" width="${MAXW}" height="12">
        <Rectangle width="${MAXW}" height="12" roundness="6"/><Fill color="#EDF1F8"/>
      </Layer>
      <Layer left="96" top="9" width="${w}" height="12">
        <Rectangle width="${w}" height="12" roundness="6"/><Fill color="${ACC}"/>
      </Layer>
      ${txt(510, 0, 60, 20, value.toFixed(2), 13.5, ACC, 'start', true)}
      ${txt(568, 2, 160, 18, src, 11.5, MUTED)}
    </Layer>`
  })

  const f = eo(seg(t, 3.6, 0.7))
  return frame(`${bar(inP, '7 天 · 兴趣长这样')}
${shell(inP)}
  ${body}
  ${foot(f, '0.55 不是人设，是起点；0.95 是 17 次真实经历推上去的', ACC)}`)
}

// ============================================================
// 场景 4 — 诚实的一页
// 这一页是刻意的：不写它，前三个场景就成了「它在像人一样生活」的暗示。
// ============================================================
function sc4 (t) {
  const inP = eo(seg(t, 0, 0.5))
  const stats = eo(seg(t, 0.5, 0.6))
  const yes = eo(seg(t, 1.5, 0.6))
  const no = eo(seg(t, 2.4, 0.6))
  const small = eo(seg(t, 3.4, 0.7))

  const block = (top, alpha, tag, tagCol, body) => `
  <Layer left="64" top="${top}" alpha="${alpha}" width="672" height="74">
    <Rectangle width="672" height="74" roundness="14"/><Fill color="#F7F9FD"/>
    <Stroke color="#E4EAF5" width="1.2"/>
    ${txt(20, 12, 620, 22, tag, 13.5, tagCol, 'start', true)}
    ${txt(20, 40, 630, 22, body, 12.5, INK)}
  </Layer>`

  return frame(`${bar(inP, '诚实的一页')}
${shell(inP)}
  <Layer left="64" top="112" alpha="${stats}">
    ${txt(0, 0, 672, 26, '7 天  ·  90 条账本  ·  16 项断言守着它', 17, INK, 'start', true)}
  </Layer>
  ${block(158, yes, '它证明了', OK, '每天要么在做事、要么明确休息；失败留下下一步；承诺被兑现')}
  ${block(242, no, '它没有证明', BAD, '模型会不会照这个骨架过日子 —— 这份日志里没有调用模型')}
  ${foot(small, '压缩跑完 · 没有真实等待 · 失败是注入的：这是「生活骨架」的证据，不是「像人」的证据', MUTED)}`)
}

// ============================================================
const SCENES = [
  { name: 'day1', dur: 4.6, fn: sc1 },
  { name: 'day2', dur: 5.2, fn: sc2 },
  { name: 'grow', dur: 4.8, fn: sc3 },
  { name: 'honest', dur: 4.8, fn: sc4 },
]

let idx = 0
for (const sc of SCENES) {
  const n = Math.round(sc.dur * FPS)
  console.log(`scene ${sc.name}: ${n} frames`)
  for (let f = 0; f < n; f++) {
    const id = String(idx).padStart(4, '0')
    const src = path.join(OUT, `f${id}.pagx`)
    fs.writeFileSync(src, sc.fn(f / FPS))
    execFileSync(PAGX, ['render', '--scale', '1.5', '-o', path.join(OUT, `f${id}.png`), src], { stdio: 'ignore' })
    fs.unlinkSync(src)
    idx++
  }
}
console.log(`total: ${idx} frames`)
