/**
 * Bakes the three landing scenarios from docs/STORY.md into one video.
 *
 *   Scene 1 — 一个垂类，一年的真实踩坑史
 *   Scene 2 — 小团队缺测试，而它有耐心
 *   Scene 3 — 开源项目共养一个记得事的成员
 *   Scene 4 — 诚实的一页：这些是方向，不是演示
 *
 * 每一幕都是两拍，因为「展示价值」需要两拍：
 *   第 1 拍 —— 它做什么（具体到可核对的动作）
 *   第 2 拍 —— 所以值什么（「没有它 / 有它」的对比，不是形容词）
 *
 * 只演第 1 拍，观众会想「挺有意思」；只演第 2 拍，观众会想「凭什么」。
 * docs/STORY.md 对每个场景都写了「为什么不能是工具」，这一版把它演出来。
 *
 * 手法与 bake-showcase.mjs 一致：`pagx render` 不接受时间参数，所以每一帧
 * 在这里算出来、各自写成一个 PAGX 文档。PAGX 负责矢量/文字/图片合成，
 * 运动由这个文件负责。
 *
 * 用法：
 *   PAGX_BIN=... node bake-scenarios.mjs
 *   ffmpeg -framerate 30 -i frames-scen/f%04d.png -c:v libx264 -pix_fmt yuv420p \
 *     -crf 19 -movflags +faststart scenarios.mp4
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const PAGX = process.env.PAGX_BIN || 'node_modules/@libpag/pagx/bin/darwin/pagx'
const AVATAR_SRC = process.env.AVATAR_SRC || 'avatar.png'
const AV = fs.readFileSync(AVATAR_SRC).toString('base64')
const OUT = 'frames-scen'
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

// 文字节点重复太多次，收成助手，免得每帧都在拼同样的 XML。
const txt = (left, top, w, h, s, size, color, align = 'start', bold = false, lh = 1.35) => `
  <Layer left="${left}" top="${top}" width="${w}" height="${h}">
    <TextBox textAlign="${align}" width="${w}" height="${h}">
      <Text text="${s}" fontFamily="STHeiti"${bold ? ' fontStyle="Bold"' : ''} fontSize="${size}" lineHeight="${lh}"/>
      <Fill color="${color}"/>
    </TextBox>
  </Layer>`

const bar = (alpha, tag) => `
  <Layer id="hdr" left="34" top="20" alpha="${alpha}">
    <Layer left="0" top="0" width="28" height="28">
      <Rectangle width="28" height="28" roundness="9"/><Fill color="#E8EEFA"/>
    </Layer>
    <Layer left="3" top="3" width="22" height="22">
      <Rectangle width="22" height="22"/><Fill><ImagePattern image="@avatar"/></Fill>
    </Layer>
    ${txt(36, 2, 420, 24, '场景 · ' + tag, 16, INK, 'start', true)}
  </Layer>`

const shell = (alpha) => `
  <Layer id="card" left="40" top="72" alpha="${alpha}" width="720" height="336">
    <Rectangle width="720" height="336" roundness="24"/><Fill color="#FFFFFF"/>
    <Stroke color="#E4EAF5" width="1.5"/>
    <DropShadowStyle offsetY="10" blurX="30" blurY="30" color="#1B2C6116"/>
  </Layer>`

const frame = (inner) => `<?xml version="1.0" encoding="UTF-8"?>
<pagx width="${W}" height="${H}">
  <Resources>
    <Image id="avatar" source="data:image/png;base64,${AV}"/>
  </Resources>
  <Layer name="bg" width="100%" height="100%"><Rectangle width="100%" height="100%"/><Fill color="#EEF3FB"/></Layer>
${inner}
</pagx>`

// 顶部那条「谁在养」的设定线：价值必须有主语。
const who = (alpha, role, budget) => `
  <Layer left="34" top="52" alpha="${alpha}">
    ${txt(0, 0, 300, 20, role, 12.5, ACC)}
    ${budget ? txt(732, 0, 34, 20, budget, 12.5, MUTED, 'end') : ''}
  </Layer>`

/**
 * 第 2 拍的通用版式：「没有它 / 有它」两栏 + 底部一句结论。
 *
 * 为什么用对比而不是形容词：场景的价值命题是「它不能被换成一个更好的工具」，
 * 那就必须让观众看见**换之前和换之后**，而不是被告知「它很有价值」。
 */
const contrast = (alpha, left, right, strip, stripColor = ACC) => `
  <Layer left="64" top="104" alpha="${alpha}" width="672" height="20">
    ${txt(0, 0, 300, 20, left.title, 13.5, BAD, 'start', true)}
    ${txt(372, 0, 300, 20, right.title, 13.5, OK, 'start', true)}
  </Layer>
  <Layer left="64" top="132" alpha="${alpha}" width="300" height="120">
    ${txt(0, 0, 300, 110, left.body, 12.5, INK, 'start', false, 1.5)}
  </Layer>
  <Layer left="436" top="132" alpha="${alpha}" width="300" height="120">
    ${txt(0, 0, 300, 110, right.body, 12.5, INK, 'start', false, 1.5)}
  </Layer>
  <Layer left="64" top="272" alpha="${alpha}" width="672" height="1">
    <Rectangle width="672" height="1"/><Fill color="#EDF1F8"/>
  </Layer>
  <Layer left="64" top="288" alpha="${alpha}" width="672" height="52">
    <Rectangle width="672" height="52" roundness="13"/><Fill color="#F4F7FF"/>
    <Stroke color="#DCE5F7" width="1.2"/>
    ${txt(18, 14, 636, 24, strip, 13.5, stripColor, 'start', true)}
  </Layer>`

const foot = (alpha, s, color = ACC) => txt(64, 372, 672, 24, s, 13, color)

// ============================================================
// 场景 1 — 真实踩坑史
//   第 1 拍：五次尝试的日志（两次失败、一次重读手册、第 4 次才通）
//   第 2 拍：内容农场写完就发 vs 它试过才发
// ============================================================
function sc1 (t) {
  const inP = eo(seg(t, 0, 0.5))
  const setting = eo(seg(t, 0.3, 0.5))

  const attempts = [
    ['09:12', '读到 SPI 时序表', '打算试', MUTED],
    ['09:40', '刷固件 · 读寄存器', '失败：MOSI 上无输出', BAD],
    ['10:05', '换 CPOL/CPHA 组合', '失败：时序仍然错', BAD],
    ['10:30', '重读手册', '发现读错了时序表', '#A16207'],
    ['11:02', '第 4 次尝试', '通了', OK],
  ]
  let rows = ''
  attempts.forEach(([tm, what, res, col], i) => {
    const a = eo(seg(t, 0.5 + i * 0.3, 0.28))
    const y = 112 + i * 40
    rows += `
    <Layer left="64" top="${y}" alpha="${a}">
      ${txt(0, 2, 46, 20, tm, 12, MUTED)}
      <Layer left="52" top="0" width="20" height="22"><Ellipse width="8" height="8" position="0,7"/><Fill color="${col}"/></Layer>
      ${txt(74, 0, 190, 22, what, 13, INK)}
      ${txt(272, 2, 210, 20, res, 12, col)}
    </Layer>`
  })
  // 最后一条右侧补一个「有工具证据」的徽章：这就是与内容农场的分界线。
  const badge = eo(seg(t, 2.1, 0.4))
  rows += `
    <Layer left="600" top="${112 + 4 * 40}" alpha="${badge}" width="136" height="22">
      <Rectangle width="136" height="22" roundness="11"/><Fill color="#E7F6EC"/>
      ${txt(0, 2, 136, 18, '每步都有工具证据', 11, OK, 'center')}
    </Layer>`

  // ---- 第 2 拍 ----
  const out = eo(seg(t, 3.6, 0.5))
  const val = eo(seg(t, 4.1, 0.6))
  const f = eo(seg(t, 6.6, 0.7))

  return frame(`${bar(inP, '一个垂类，一年的真实踩坑史')}
${who(setting, '一个人 · 下班后没精力写博客 · 每天预算 3 元')}
${shell(inP)}
  <Layer alpha="${1 - out}">${rows}</Layer>
  ${contrast(val,
    { title: '内容农场', body: '读完文档就写&#10;没试过，也没有证据&#10;&#10;写得快，但读的人&#10;第二天就不信了' },
    { title: '它', body: '试了 4 次才通&#10;每次失败都记下来&#10;&#10;每条内容后面&#10;都有一次真实的调用' },
    '一年 ≈ 260 次真实尝试 —— 这些尝试，内容农场不会做')}
  ${foot(f, '一年后他有了一个「真实踩坑史」的账号，而他没有写过一个字')}`)
}

// ============================================================
// 场景 2 — 缺测试，而它有耐心
//   第 1 拍：一场游玩，两份产出（对内的数据 / 对外的记录）
//   第 2 拍：人手测试会疲 vs 它不会
// ============================================================
function sc2 (t) {
  const inP = eo(seg(t, 0, 0.5))
  const setting = eo(seg(t, 0.3, 0.5))
  const play = eo(seg(t, 0.5, 0.5))
  const split = eo(seg(t, 1.4, 0.5))
  const find = eo(seg(t, 1.7, 0.45))
  const steps = eo(seg(t, 2.6, 0.5))

  const action = `
  <Layer left="64" top="104" alpha="${play}" width="672" height="26">
    ${txt(0, 0, 672, 26, '今天玩了 3 小时 12 分 · 21 局 · 记录到 4 处异常', 14, INK)}
  </Layer>
  <Layer left="376" top="142" alpha="${split}" width="1" height="220">
    <Rectangle width="1" height="220"/><Fill color="#EDF1F8"/>
  </Layer>
  <Layer left="64" top="150" alpha="${split}" width="300" height="24">
    ${txt(0, 0, 300, 24, '对内：结构化卡关数据', 14, INK, 'start', true)}
  </Layer>
  <Layer left="64" top="182" alpha="${find}" width="300" height="120">
    ${txt(0, 0, 300, 110, '第 3 关 · 跳跃后立刻转向&#10;相机穿墙，画面外可见地面缝隙', 12.5, INK, 'start', false, 1.5)}
  </Layer>
  <Layer left="64" top="252" alpha="${steps}" width="300" height="20">
    ${txt(0, 0, 300, 20, '复现步骤已生成 · 37 局里出现 9 次', 11.5, MUTED)}
  </Layer>
  <Layer left="64" top="278" alpha="${steps}" width="140" height="22">
    <Rectangle width="140" height="22" roundness="11"/><Fill color="#E7F6EC"/>
    ${txt(0, 2, 140, 18, '可复现 · 有录像', 11, OK, 'center')}
  </Layer>
  <Layer left="408" top="150" alpha="${split}" width="300" height="24">
    ${txt(0, 0, 310, 24, '对外：玩家第一次玩', 14, INK, 'start', true)}
  </Layer>
  <Layer left="408" top="182" alpha="${split}" width="310" height="130">
    ${txt(0, 0, 310, 120, '在第 3 关撞了 9 次墙。&#10;每次都是同一个动作：&#10;落地瞬间转身 ——&#10;然后镜头就不认识我了。', 12.5, INK, 'start', false, 1.5)}
  </Layer>
  <Layer left="408" top="308" alpha="${split}" width="310" height="20">
    ${txt(0, 0, 310, 20, '有人就是爱看别人第一次玩', 11.5, MUTED)}
  </Layer>`

  const out = eo(seg(t, 4.2, 0.5))
  const val = eo(seg(t, 4.7, 0.6))
  const f = eo(seg(t, 7.2, 0.7))

  return frame(`${bar(inP, '小团队缺测试，而它有耐心')}
${who(setting, '三个人做独立游戏 · 测试人力不够')}
${shell(inP)}
  <Layer alpha="${1 - out}">${action}</Layer>
  ${contrast(val,
    { title: '人手测试', body: '三个人挤时间测&#10;测到第二周就疲了&#10;&#10;「这个我测过了」&#10;—— 但其实没复现' },
    { title: '它', body: '每天 3 小时，一天不落&#10;不会累，也不给面子&#10;&#10;说「这里很烦」的时候&#10;顺手附上录像' },
    '对内是 bug 数据，对外是游玩记录 —— 同一场游玩，两份产出', OK)}
  ${foot(f, '一个不会累、不给面子、如实说「这里很烦」的测试员 —— 而且它的「烦」有证据')}`)
}

// ============================================================
// 场景 3 — 记得事的成员
//   第 1 拍：三个月前否掉方案 B，今天有人再提
//   第 2 拍：机器人只记得这次对话 vs 成员记得
// ============================================================
function sc3 (t) {
  const inP = eo(seg(t, 0, 0.5))
  const setting = eo(seg(t, 0.3, 0.5))
  const axis = eo(seg(t, 0.5, 0.5))
  const past = eo(seg(t, 0.9, 0.5))
  const now = eo(seg(t, 1.9, 0.5))
  const recall = eo(seg(t, 2.8, 0.6))
  const recallBody = eo(seg(t, 3.3, 0.5))

  const action = `
  <Layer left="88" top="176" alpha="${axis}" width="560" height="2">
    <Rectangle width="560" height="2"/><Fill color="#DCE4F2"/>
  </Layer>
  <Layer left="88" top="170" alpha="${axis}" width="10" height="10"><Ellipse width="10" height="10"/><Fill color="${MUTED}"/></Layer>
  <Layer left="638" top="168" alpha="${axis}" width="14" height="14"><Ellipse width="14" height="14"/><Fill color="${ACC}"/></Layer>
  ${txt(88, 190, 200, 20, '三个月前', 12, MUTED)}
  ${txt(608, 190, 120, 20, '今天', 12, ACC)}
  <Layer left="88" top="112" alpha="${past}">
    ${txt(0, 0, 300, 24, '否决了方案 B', 13.5, INK)}
    ${txt(0, 26, 340, 20, '原因：构建时间从 2 分钟涨到 11 分钟', 11.5, MUTED)}
  </Layer>
  <Layer left="392" top="112" alpha="${now}">
    ${txt(0, 0, 330, 24, '又有人提方案 B', 13.5, INK)}
    ${txt(0, 26, 340, 20, '看起来是个没人记得的好主意', 11.5, MUTED)}
  </Layer>
  <Layer left="88" top="238" alpha="${recall}" width="620" height="72">
    <Rectangle width="620" height="72" roundness="14"/><Fill color="#EAF0FF"/>
    ${txt(20, 14, 580, 24, '它记得：三个月前否掉过一次，因为构建时间', 13.5, ACC, 'start', true)}
  </Layer>
  <Layer left="88" top="272" alpha="${recallBody}" width="620" height="30">
    ${txt(20, 0, 580, 24, '还附上了当时的讨论记录与那个数字', 12, MUTED)}
  </Layer>`

  const out = eo(seg(t, 4.3, 0.5))
  const val = eo(seg(t, 4.8, 0.6))
  const f = eo(seg(t, 7.3, 0.7))

  return frame(`${bar(inP, '开源项目共养一个记得事的成员')}
${who(setting, '二十人的开源项目组 · 共养一条')}
${shell(inP)}
  <Layer alpha="${1 - out}">${action}</Layer>
  ${contrast(val,
    { title: '机器人', body: '只记得这次对话&#10;下次问起，从零开始&#10;&#10;于是同一个方案&#10;会被否掉两次' },
    { title: '它', body: '记得三个月前为什么否掉&#10;记得谁提过、谁反对&#10;&#10;每周还写一份&#10;「这一周发生了什么」' },
    '二十个人的记忆不会丢在一个不在场的人身上 —— 这是它唯一的用处', ACC)}
  ${foot(f, '机器人不记得三个月前的话，成员记得')}`)
}

// ============================================================
// 场景 4 — 诚实的一页
//   不写这一幕，前三幕就变成了「它已经在这样生活」的暗示。
//   价值讲得越满，这一幕越不能省。
// ============================================================
function sc4 (t) {
  const inP = eo(seg(t, 0, 0.5))
  const head = eo(seg(t, 0.4, 0.5))
  const a = eo(seg(t, 1.0, 0.5))
  const b = eo(seg(t, 1.7, 0.5))
  const c = eo(seg(t, 2.4, 0.5))
  const f = eo(seg(t, 3.4, 0.7))

  const item = (y, alpha, ok, text) => `
  <Layer left="64" top="${y}" alpha="${alpha}">
    <Layer left="0" top="1" width="18" height="18">
      <Ellipse width="18" height="18"/><Fill color="${ok ? '#E7F6EC' : '#FEF2F2'}"/>
    </Layer>
    ${txt(3, 1, 16, 18, ok ? '✓' : '✕', 11.5, ok ? OK : BAD, 'center', true)}
    ${txt(28, 0, 620, 24, text, 13, INK)}
  </Layer>`

  return frame(`${bar(inP, '诚实的一页')}
${shell(inP)}
  <Layer left="64" top="98" alpha="${head}" width="672" height="52">
    ${txt(0, 0, 672, 26, '这三个场景，现在跑到哪一步', 17, INK, 'start', true)}
    ${txt(0, 28, 672, 20, '对着仓库逐条核过 —— 不是对着愿望', 12.5, MUTED)}
  </Layer>
  ${item(160, a, true, '生命层 · 自主唤醒 · 活动选择 · 证据规则 —— 已实现且已验证')}
  ${item(192, a, true, '沙盒内真的执行 —— 复用 dsh 的 sandbox')}
  ${item(228, b, false, '对外发布到社交平台 —— 未实现')}
  ${item(258, b, false, '连续 7 天真实运行 —— 生活骨架已验，有模型的运行未做')}
  <Layer left="64" top="${292}" alpha="${c}" width="672" height="52">
    <Rectangle width="672" height="52" roundness="13"/><Fill color="#FFF8E8"/>
    <Stroke color="#F0E0BC" width="1.2"/>
    ${txt(18, 8, 636, 40, '所以三个场景停在同一个地方：&#10;它能过自己的日子，但日子还发不出去。', 12.5, '#8A6414', 'start', true, 1.35)}
  </Layer>
  <Layer left="64" top="${356}" alpha="${f}" width="672" height="22">
    ${txt(0, 0, 672, 22, '这些是方向，不是演示 —— 把两者混起来，第一次被追问就崩', 12.5, MUTED)}
  </Layer>`)
}

const SCENES = [
  { name: 'pitfall', dur: 7.8, fn: sc1 },
  { name: 'testbot', dur: 8.4, fn: sc2 },
  { name: 'memory', dur: 8.4, fn: sc3 },
  { name: 'honest', dur: 4.6, fn: sc4 },
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
