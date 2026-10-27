/**
 * Bakes the three landing scenarios from docs/STORY.md into one video.
 *
 *   Scene 1 — 一个垂类，一年的真实踩坑史（试了 vs 写了）
 *   Scene 2 — 小团队缺测试，而它有耐心（对外的记录 / 对内的数据）
 *   Scene 3 — 开源项目共养一个记得事的成员（它记得三个月前）
 *
 * Same technique as bake-showcase.mjs: `pagx render` takes no time argument,
 * so each frame is computed here and emitted as its own PAGX document. PAGX
 * does the vector/text/image compositing; this file owns the motion.
 *
 * Usage:
 *   PAGX_BIN=... node bake-scenarios.mjs
 *   ffmpeg -framerate 30 -i frames-scen/f%04d.png -c:v libx264 ... scenarios.mp4
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
const ei = t => t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
const seg = (t, a, d) => Math.max(0, Math.min(1, (t - a) / d))

const INK = '#1B2C61'
const MUTED = '#8A95AD'
const ACC = '#4F6FC0'
const OK = '#15803D'

// Top bar: same vocabulary as the product demo, but the right side carries the
// scenario name instead of the two state axes.
const bar = (alpha, tag) => `
  <Layer id="hdr" left="34" top="24" alpha="${alpha}">
    <Layer left="0" top="0" width="30" height="30">
      <Rectangle width="30" height="30" roundness="10"/><Fill color="#E8EEFA"/>
    </Layer>
    <Layer left="3" top="3" width="24" height="24">
      <Rectangle width="24" height="24"/><Fill><ImagePattern image="@avatar"/></Fill>
    </Layer>
    <Layer left="38" top="4" width="300" height="24">
      <TextBox textAlign="start" width="300" height="24">
        <Text text="场景 · ${tag}" fontFamily="STHeiti" fontStyle="Bold" fontSize="16"/>
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

const frame = (inner) => `<?xml version="1.0" encoding="UTF-8"?>
<pagx width="${W}" height="${H}">
  <Resources>
    <Image id="avatar" source="data:image/png;base64,${AV}"/>
  </Resources>
  <Layer name="bg" width="100%" height="100%"><Rectangle width="100%" height="100%"/><Fill color="#EEF3FB"/></Layer>
${inner}
</pagx>`

// ============================================================
// Scene 1 — 真实踩坑史：试了 vs 写了
// ============================================================
function sc1 (t) {
  const inP = eo(seg(t, 0, 0.55))

  // the four attempts land one by one, like a real log being written
  const attempts = [
    ['09:12', '读到 SPI 时序表', '打算试', MUTED],
    ['09:40', '刷固件 · 读寄存器', '失败：MOSI 上无输出', '#B91C1C'],
    ['10:05', '换 CPOL/CPHA 组合', '失败：时序仍然错', '#B91C1C'],
    ['10:30', '重读手册', '发现读错了时序表', '#A16207'],
    ['11:02', '第 4 次尝试', '通了', OK],
  ]
  let rows = ''
  attempts.forEach(([tm, what, res, col], i) => {
    const a = eo(seg(t, 0.45 + i * 0.42, 0.36))
    const y = 122 + i * 44
    const isLast = i === attempts.length - 1
    rows += `
    <Layer left="64" top="${y}" alpha="${a}">
      <Layer left="0" top="2" width="46" height="20">
        <TextBox textAlign="start" width="46" height="20"><Text text="${tm}" fontFamily="STHeiti" fontSize="12"/><Fill color="${MUTED}"/></TextBox>
      </Layer>
      <Layer left="52" top="0" width="26" height="22">
        <Ellipse width="8" height="8" position="0,7"/>
        <Fill color="${col}"/>
      </Layer>
      <Layer left="78" top="0" width="180" height="22">
        <TextBox textAlign="start" width="180" height="22"><Text text="${what}" fontFamily="STHeiti" fontSize="13"/><Fill color="${INK}"/></TextBox>
      </Layer>
      <Layer left="262" top="2" width="180" height="20">
        <TextBox textAlign="start" width="180" height="20"><Text text="${res}" fontFamily="STHeiti" fontSize="12"/><Fill color="${col}"/></TextBox>
      </Layer>
      ${isLast ? `<Layer left="440" top="0" width="120" height="22">
        <Rectangle width="120" height="22" roundness="11"/><Fill color="#E7F6EC"/>
        <Layer left="0" top="2" width="120" height="18">
          <TextBox textAlign="center" width="120" height="18"><Text text="有工具证据" fontFamily="STHeiti" fontSize="11"/><Fill color="${OK}"/></TextBox>
        </Layer>
      </Layer>` : ''}
    </Layer>`
  })

  // the divider and the two-column contrast appear once the log is complete
  const div = eo(seg(t, 2.7, 0.4))
  const contra = eo(seg(t, 3.0, 0.5))
  const foot = eo(seg(t, 4.2, 0.6))

  return frame(`${bar(inP, '一个垂类，一年的真实踩坑史')}
${shell(inP)}
  ${rows}
  <Layer left="64" top="${356}" alpha="${div}" width="672" height="1">
    <Rectangle width="672" height="1"/><Fill color="#EDF1F8"/>
  </Layer>
  <Layer left="64" top="${372}" alpha="${contra}" width="672" height="24">
    <TextBox textAlign="start" width="672" height="24">
      <Text text="内容农场不试，它试 —— 每条内容后面都有一次真实的工具调用记录" fontFamily="STHeiti" fontSize="13"/>
      <Fill color="${ACC}"/>
    </TextBox>
  </Layer>`)
}

// ============================================================
// Scene 2 — 缺测试：对外的记录 / 对内的数据
// ============================================================
function sc2 (t) {
  const inP = eo(seg(t, 0, 0.55))
  const play = eo(seg(t, 0.5, 0.5))        // the session itself
  const split = eo(seg(t, 1.7, 0.55))      // two outputs appear
  const data = eo(seg(t, 2.4, 0.6))
  const foot = eo(seg(t, 4.3, 0.6))

  const find = eo(seg(t, 1.95, 0.45))
  const steps = eo(seg(t, 2.9, 0.6))

  return frame(`${bar(inP, '小团队缺测试，而它有耐心')}
${shell(inP)}

  <!-- the session: it actually played -->
  <Layer left="64" top="${104}" alpha="${play}" width="672" height="26">
    <TextBox textAlign="start" width="672" height="26">
      <Text text="今天玩了 3 小时 12 分 · 21 局 · 记录到 4 处异常" fontFamily="STHeiti" fontSize="14"/>
      <Fill color="${INK}"/>
    </TextBox>
  </Layer>

  <!-- divider -->
  <Layer left="376" top="${142}" alpha="${split}" width="1" height="${240}">
    <Rectangle width="1" height="240"/><Fill color="#EDF1F8"/>
  </Layer>

  <!-- left: the internal output -->
  <Layer left="64" top="${150}" alpha="${split}" width="300" height="24">
    <TextBox textAlign="start" width="300" height="24"><Text text="对内：结构化卡关数据" fontFamily="STHeiti" fontStyle="Bold" fontSize="14"/><Fill color="${INK}"/></TextBox>
  </Layer>
  <Layer left="64" top="${184}" alpha="${find}" width="300" height="120">
    <TextBox textAlign="start" width="300" height="120">
      <Text text="第 3 关 · 跳跃后立刻转向&#10;相机穿墙，画面外可见地面缝隙" fontFamily="STHeiti" fontSize="12.5"/>
      <Fill color="${INK}"/>
    </TextBox>
  </Layer>
  <Layer left="64" top="${238}" alpha="${steps}" width="300" height="20">
    <TextBox textAlign="start" width="300" height="20"><Text text="复现步骤已生成 · 37 局里出现 9 次" fontFamily="STHeiti" fontSize="11.5"/><Fill color="${MUTED}"/></TextBox>
  </Layer>
  <Layer left="64" top="${264}" alpha="${steps}" width="300" height="22">
    <Rectangle width="132" height="22" roundness="11"/><Fill color="#E7F6EC"/>
    <Layer left="0" top="2" width="132" height="18">
      <TextBox textAlign="center" width="132" height="18"><Text text="可复现 · 有录像" fontFamily="STHeiti" fontSize="11"/><Fill color="${OK}"/></TextBox>
    </Layer>
  </Layer>

  <!-- right: the external output -->
  <Layer left="408" top="${150}" alpha="${split}" width="300" height="24">
    <TextBox textAlign="start" width="300" height="24"><Text text="对外：玩家第一次玩" fontFamily="STHeiti" fontStyle="Bold" fontSize="14"/><Fill color="${INK}"/></TextBox>
  </Layer>
  <Layer left="408" top="${184}" alpha="${split}" width="310" height="130">
    <TextBox textAlign="start" width="310" height="130">
      <Text text="在第 3 关撞了 9 次墙。每次都是同一个动作：&#10;落地瞬间转身 —— 然后镜头就不认识我了。" fontFamily="STHeiti" fontSize="12.5"/>
      <Fill color="${INK}"/>
    </TextBox>
  </Layer>
  <Layer left="408" top="${294}" alpha="${split}" width="310" height="20">
    <TextBox textAlign="start" width="310" height="20"><Text text="有人就是爱看别人第一次玩" fontFamily="STHeiti" fontSize="11.5"/><Fill color="${MUTED}"/></TextBox>
  </Layer>

  <Layer left="64" top="${372}" alpha="${foot}" width="672" height="24">
    <TextBox textAlign="start" width="672" height="24">
      <Text text="一个不会累、不给面子、如实说「这里很烦」的测试员 —— 而它的「烦」有证据" fontFamily="STHeiti" fontSize="13"/>
      <Fill color="${ACC}"/>
    </TextBox>
  </Layer>`)
}

// ============================================================
// Scene 3 — 共养成员：它记得三个月前
// ============================================================
function sc3 (t) {
  const inP = eo(seg(t, 0, 0.55))
  const axis = eo(seg(t, 0.4, 0.5))
  const past = eo(seg(t, 0.9, 0.5))       // three months ago
  const now = eo(seg(t, 2.0, 0.5))        // today someone proposes it again
  const recall = eo(seg(t, 3.0, 0.6))     // it remembers
  const foot = eo(seg(t, 4.3, 0.6))

  const bob = Math.sin(t * 2 * Math.PI / 3.4) * 4

  return frame(`${bar(inP, '开源项目共养一个记得事的成员')}
${shell(inP)}

  <!-- the long axis -->
  <Layer left="${88}" top="${176}" alpha="${axis}" width="${560}" height="2">
    <Rectangle width="560" height="2"/><Fill color="#DCE4F2"/>
  </Layer>
  <Layer left="${88}" top="${170}" alpha="${axis}" width="10" height="10">
    <Ellipse width="10" height="10"/><Fill color="${MUTED}"/>
  </Layer>
  <Layer left="${638}" top="${168}" alpha="${axis}" width="14" height="14">
    <Ellipse width="14" height="14"/><Fill color="${ACC}"/>
  </Layer>
  <Layer left="${88}" top="${190}" alpha="${axis}" width="200" height="20">
    <TextBox textAlign="start" width="200" height="20"><Text text="三个月前" fontFamily="STHeiti" fontSize="12"/><Fill color="${MUTED}"/></TextBox>
  </Layer>
  <Layer left="${608}" top="${190}" alpha="${axis}" width="120" height="20">
    <TextBox textAlign="start" width="120" height="20"><Text text="今天" fontFamily="STHeiti" fontSize="12"/><Fill color="${ACC}"/></TextBox>
  </Layer>

  <!-- three months ago -->
  <Layer left="88" top="${112}" alpha="${past}">
    <Layer left="0" top="0" width="300" height="24">
      <TextBox textAlign="start" width="300" height="24"><Text text="否决了方案 B" fontFamily="STHeiti" fontSize="13.5"/><Fill color="${INK}"/></TextBox>
    </Layer>
    <Layer left="0" top="26" width="340" height="20">
      <TextBox textAlign="start" width="340" height="20"><Text text="原因：构建时间从 2 分钟涨到 11 分钟" fontFamily="STHeiti" fontSize="11.5"/><Fill color="${MUTED}"/></TextBox>
    </Layer>

  </Layer>

  <!-- today: someone proposes it again -->
  <Layer left="${392}" top="${112}" alpha="${now}">
    <Layer left="0" top="0" width="330" height="24">
      <TextBox textAlign="start" width="330" height="24"><Text text="又有人提方案 B" fontFamily="STHeiti" fontSize="13.5"/><Fill color="${INK}"/></TextBox>
    </Layer>
    <Layer left="0" top="26" width="340" height="20">
      <TextBox textAlign="start" width="340" height="20"><Text text="看起来是个没人记得的好主意" fontFamily="STHeiti" fontSize="11.5"/><Fill color="${MUTED}"/></TextBox>
    </Layer>
  </Layer>

  <!-- the recall -->
  <Layer left="88" top="${248}" alpha="${recall}" width="620" height="76">
    <Rectangle width="620" height="76" roundness="14"/><Fill color="#EAF0FF"/>
    <Layer left="20" top="16" width="580" height="24">
      <TextBox textAlign="start" width="580" height="24"><Text text="它记得：三个月前否掉过一次，因为构建时间。" fontFamily="STHeiti" fontSize="13.5"/><Fill color="${ACC}"/></TextBox>
    </Layer>
    <Layer left="20" top="44" width="580" height="20">
      <TextBox textAlign="start" width="580" height="20"><Text text="还附上了当时的讨论记录与那个数字。" fontFamily="STHeiti" fontSize="11.5"/><Fill color="${MUTED}"/></TextBox>
    </Layer>
  </Layer>

  <!-- Keep the avatar inside the card: the card ends at y=408, so a 104px box
       anchored at 296 with the footer at 372 never collides. -->
  <Layer left="648" top="326" alpha="${recall}" width="72" height="72">
    <Rectangle width="72" height="72"/><Fill><ImagePattern image="@avatar"/></Fill>
  </Layer>

  <Layer left="64" top="${372}" alpha="${foot}" width="672" height="24">
    <TextBox textAlign="start" width="672" height="24">
      <Text text="机器人不记得三个月前的话，成员记得" fontFamily="STHeiti" fontSize="13"/>
      <Fill color="${ACC}"/>
    </TextBox>
  </Layer>`)
}

const SCENES = [
  { name: 'pitfall', dur: 6.0, fn: sc1 },
  { name: 'testbot', dur: 6.0, fn: sc2 },
  { name: 'memory', dur: 6.0, fn: sc3 },
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
