/**
 * Bakes the product showcase: three scenes telling one continuous story.
 *
 *   Scene 1 — 它现在在做什么 (activity card, progress, live counter)
 *   Scene 2 — 一条动态发到八个平台 (channel grid + per-channel receipts)
 *   Scene 3 — 桌宠形态 (desktop pet with speech bubble)
 *
 * `pagx render` takes no time argument, so each frame is computed here and
 * emitted as its own PAGX document. PAGX does vector/text/image compositing;
 * this file owns the motion.
 *
 * Usage:
 *   npm install @libpag/pagx
 *   node bake-showcase.mjs
 *   ffmpeg -framerate 30 -i frames/f%04d.png -c:v libx264 -pix_fmt yuv420p \
 *     -crf 19 -movflags +faststart demo.mp4
 *
 * Output frames are git-ignored; only the rendered video/GIF are committed.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

// Resolve the platform binary the @libpag/pagx CLI ships.
const PAGX = process.env.PAGX_BIN || 'node_modules/@libpag/pagx/bin/darwin/pagx'
// The avatar is read from the repo and inlined as a data URI, so this script
// has no hidden input and every generated PAGX file stays self-contained.
// avatar.png is the placeholder art with its hard-cropped edges feathered;
// regenerate it from design/placeholder-whalegirl.png if the art changes.
const AVATAR_SRC = process.env.AVATAR_SRC || 'avatar.png'
const AV = fs.readFileSync(AVATAR_SRC).toString('base64')
const OUT = 'frames'
const W = 800, H = 480
const FPS = 30

fs.rmSync(OUT, { recursive: true, force: true })
fs.mkdirSync(OUT, { recursive: true })

const eo = t => 1 - Math.pow(1 - t, 3)
const ei = t => t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
const seg = (t, a, d) => Math.max(0, Math.min(1, (t - a) / d))
const fade = (t, a, d, hold) => { const p = seg(t, a, d); const q = hold === undefined ? 1 : seg(t, hold, d); return eo(p) * (1 - eo(q)) }

const CH = [
  ['wx', '微信', '#1AAD19'], ['qq', 'QQ', '#12B7F5'], ['wb', '微博', '#E6162D'], ['xhs', '小红书', '#FF2442'],
  ['bili', '哔哩哔哩', '#00AEEC'], ['tg', 'Telegram', '#2AABEE'], ['x', '推特', '#161C2C'], ['of', 'OnlyFans', '#00AFF0'],
]

const header = (alpha) => `
  <Layer id="hdr" left="34" top="26" alpha="${alpha}">
    <Layer left="0" top="0" width="30" height="30">
      <Rectangle width="30" height="30" roundness="10"/><Fill color="#E8EEFA"/>
    </Layer>
    <Layer left="3" top="3" width="24" height="24">
      <Rectangle width="24" height="24"/>
      <Fill><ImagePattern image="@avatar"/></Fill>
    </Layer>
    <Layer left="38" top="4" width="200" height="24">
      <TextBox textAlign="start" width="200" height="24">
        <Text text="大肥鱼" fontFamily="STHeiti" fontStyle="Bold" fontSize="17"/>
        <Fill color="#1B2C61"/>
      </TextBox>
    </Layer>
  </Layer>
  <Layer id="axes" left="600" top="30" alpha="${alpha}">
    <Layer left="0" top="0" width="60" height="20">
      <TextBox textAlign="start" width="60" height="20">
        <Text text="活动中" fontFamily="STHeiti" fontSize="13"/><Fill color="#4F6FC0"/>
      </TextBox>
    </Layer>
    <Layer left="70" top="0" width="72" height="20">
      <TextBox textAlign="start" width="72" height="20">
        <Text text="系统正常" fontFamily="STHeiti" fontSize="13"/><Fill color="#15803D"/>
      </TextBox>
    </Layer>
  </Layer>`

// ---------------- scene 1: activity ----------------
function s1 (t) {
  const inP = eo(seg(t, 0, 0.8))
  const rise = (1 - inP) * 20
  const bob = Math.sin(t * 2 * Math.PI / 3) * 5
  const figA = eo(seg(t, 0.25, 0.6))
  const prog = ei(seg(t, 1.0, 2.6))
  const mins = Math.round(42 * prog)
  const pulse = 0.5 + 0.5 * Math.sin(t * 2 * Math.PI / 1.4)
  const dotR = 5 + pulse * 3
  const BAR = 330, barW = Math.max(1, BAR * prog)
  const l1 = eo(seg(t, 0.4, 0.5)), l2 = eo(seg(t, 0.65, 0.5)), l3 = eo(seg(t, 0.9, 0.5))
  const C = { x: 40, y: 72, w: 720, h: 336 }
  const TX = C.x + 320

  return `<?xml version="1.0" encoding="UTF-8"?>
<pagx width="${W}" height="${H}">
  <Resources>
    <Image id="avatar" source="data:image/png;base64,${AV}"/>
    <Composition id="mask1" width="${C.w}" height="${C.h}">
      <Layer width="${C.w}" height="${C.h}"><Rectangle width="${C.w}" height="${C.h}" roundness="24"/><Fill color="#FFFFFF"/></Layer>
    </Composition>
  </Resources>
  <Layer name="bg" width="100%" height="100%"><Rectangle width="100%" height="100%"/><Fill color="#EEF3FB"/></Layer>
  ${header(inP)}
  <Layer id="card" left="${C.x}" top="${C.y + rise}" alpha="${inP}" width="${C.w}" height="${C.h}">
    <Rectangle width="${C.w}" height="${C.h}" roundness="24"/><Fill color="#FFFFFF"/>
    <Stroke color="#E4EAF5" width="1.5"/>
    <DropShadowStyle offsetY="10" blurX="30" blurY="30" color="#1B2C6116"/>
  </Layer>
  <Layer id="clip1" left="${C.x}" top="${C.y + rise}" alpha="${inP}" width="${C.w}" height="${C.h}" mask="mask1" maskType="contour">
    <Layer left="${C.x + 44}" top="${C.y + rise + 58 + bob}" alpha="${figA}" width="224" height="224">
      <Rectangle width="224" height="224"/><Fill><ImagePattern image="@avatar"/></Fill>
    </Layer>
  </Layer>
  <Layer left="${TX}" top="${C.y + rise + 56}" alpha="${l1}" width="360" height="22">
    <TextBox textAlign="start" width="360" height="22"><Text text="正在" fontFamily="STHeiti" fontSize="14"/><Fill color="#6D7893"/></TextBox>
  </Layer>
  <Layer left="${TX}" top="${C.y + rise + 84}" alpha="${l1}" width="400" height="42">
    <TextBox textAlign="start" width="400" height="42"><Text text="练《矿工与矮人》第 38 层" fontFamily="STHeiti" fontStyle="Bold" fontSize="23"/><Fill color="#1B2C61"/></TextBox>
  </Layer>
  <Layer left="${TX}" top="${C.y + rise + 134}" alpha="${l2}" width="400" height="28">
    <TextBox textAlign="start" width="400" height="28"><Text text="有存档证据 · 昨天在这儿挂了两次" fontFamily="STHeiti" fontSize="14"/><Fill color="#6D7893"/></TextBox>
  </Layer>
  <Layer left="${TX}" top="${C.y + rise + 186}" alpha="${l2}" width="${BAR}" height="7">
    <Rectangle width="${BAR}" height="7" roundness="3.5"/><Fill color="#E4EAF5"/>
  </Layer>
  <Layer left="${TX}" top="${C.y + rise + 186}" alpha="${l2}" width="${barW.toFixed(1)}" height="7">
    <Rectangle width="${barW.toFixed(1)}" height="7" roundness="3.5"/><Fill color="#4F6FC0"/>
  </Layer>
  <Layer left="${TX - 22 - dotR}" top="${C.y + rise + 189.5 - dotR}" alpha="${(l2 * (0.5 + pulse * 0.5)).toFixed(3)}" width="${dotR * 2}" height="${dotR * 2}">
    <Ellipse width="${dotR * 2}" height="${dotR * 2}"/><Fill color="#4F6FC0"/>
  </Layer>
  <Layer left="${TX}" top="${C.y + rise + 220}" alpha="${l3}" width="400" height="26">
    <TextBox textAlign="start" width="400" height="26"><Text text="已进行 ${mins} 分钟 · 上限 60" fontFamily="STHeiti" fontSize="14"/><Fill color="#6D7893"/></TextBox>
  </Layer>
  <Layer left="${TX}" top="${C.y + rise + 264}" alpha="${l3}" width="400" height="26">
    <TextBox textAlign="start" width="400" height="26"><Text text="下一步想：把打法写进技能经验" fontFamily="STHeiti" fontSize="14"/><Fill color="#4F6FC0"/></TextBox>
  </Layer>
</pagx>`
}

// ---------------- scene 2: channels + publishing ----------------
function s2 (t) {
  const inP = eo(seg(t, 0, 0.6))
  const TXT = 'MULTI'
  const cardW = 720, cardX = 40, cardY = 72, cardH = 336
  const cols = 4, cw = 168, chh = 62
  const gx = cardX + 12, gy = cardY + 62

  // each tile pops in staggered; two get deselected; publish then fires
  let tiles = ''
  CH.forEach(([id, name, color], i) => {
    const row = Math.floor(i / cols), col = i % cols
    const pop = eo(seg(t, 0.35 + i * 0.07, 0.4))
    const x = gx + col * cw, y = gy + row * chh
    // QQ and OnlyFans are switched off at 2.0s; the rest stay on
    const off = (id === 'qq' || id === 'of') ? eo(seg(t, 2.0, 0.35)) : 0
    const alpha = pop * (1 - off * 0.62)
    const dotAlpha = pop * (1 - off)
    const tick = seg(t, 3.15 + i * 0.06, 0.3)   // receipt lands after publish
    tiles += `
    <Layer left="${x}" top="${y}" alpha="${alpha.toFixed(3)}">
      <Layer left="0" top="8" width="34" height="34">
        <Rectangle width="34" height="34" roundness="11"/><Fill color="${color}22"/>
      </Layer>
      <Layer left="0" top="12" width="34" height="26">
        <TextBox textAlign="center" width="34" height="26"><Text text="${name.slice(0,1)}" fontFamily="STHeiti" fontStyle="Bold" fontSize="15"/><Fill color="${color}"/></TextBox>
      </Layer>
      <Layer left="44" top="6" width="110" height="22">
        <TextBox textAlign="start" width="110" height="22"><Text text="${name}" fontFamily="STHeiti" fontSize="14"/><Fill color="#1B2C61"/></TextBox>
      </Layer>
      <Layer left="44" top="28" width="110" height="18">
        <TextBox textAlign="start" width="110" height="18"><Text text="${tick > 0.5 ? '已送达' : '待发布'}" fontFamily="STHeiti" fontSize="12"/><Fill color="${tick > 0.5 ? '#15803D' : '#8A95AD'}"/></TextBox>
      </Layer>
      <Layer left="146" top="14" alpha="${dotAlpha.toFixed(3)}" width="10" height="10">
        <Ellipse width="10" height="10"/><Fill color="#22A06B"/>
      </Layer>
    </Layer>`
  })

  const btnPop = eo(seg(t, 1.5, 0.4))
  const progress = eo(seg(t, 2.4, 1.6))

  return `<?xml version="1.0" encoding="UTF-8"?>
<pagx width="${W}" height="${H}">
  <Resources>
    <Image id="avatar" source="data:image/png;base64,${AV}"/>
  </Resources>
  <Layer name="bg" width="100%" height="100%"><Rectangle width="100%" height="100%"/><Fill color="#EEF3FB"/></Layer>
  ${header(inP)}
  <Layer id="card2" left="${cardX}" top="${cardY}" alpha="${inP}" width="${cardW}" height="${cardH}">
    <Rectangle width="${cardW}" height="${cardH}" roundness="24"/><Fill color="#FFFFFF"/>
    <Stroke color="#E4EAF5" width="1.5"/>
    <DropShadowStyle offsetY="10" blurX="30" blurY="30" color="#1B2C6116"/>
  </Layer>
  <Layer left="${cardX + 22}" top="${cardY + 22}" alpha="${inP}" width="400" height="26">
    <TextBox textAlign="start" width="400" height="26"><Text text="一条动态，发到八个平台" fontFamily="STHeiti" fontStyle="Bold" fontSize="16"/><Fill color="#1B2C61"/></TextBox>
  </Layer>
  <Layer left="${cardX + cardW - 200}" top="${cardY + 24}" alpha="${inP}" width="180" height="22">
    <TextBox textAlign="end" width="180" height="22"><Text text="${t < 2.0 ? '8 个已连接' : '6 个已连接'}" fontFamily="STHeiti" fontSize="13"/><Fill color="#8A95AD"/></TextBox>
  </Layer>
  ${tiles}
  <Layer left="${cardX + 22}" top="${cardY + cardH - 76}" alpha="${btnPop}" width="200" height="40">
    <Rectangle width="200" height="40" roundness="12"/><Fill color="#4F6FC0"/>
  </Layer>
  <Layer left="${cardX + 22}" top="${cardY + cardH - 68}" alpha="${btnPop}" width="200" height="24">
    <TextBox textAlign="center" width="200" height="24"><Text text="${progress > 0.02 ? '同步发布中…' : '同步发布'}" fontFamily="STHeiti" fontStyle="Bold" fontSize="15"/><Fill color="#FFFFFF"/></TextBox>
  </Layer>
  <Layer left="${cardX + 250}" top="${cardY + cardH - 60}" alpha="${progress}" width="${420 * progress}" height="8">
    <Rectangle width="${420 * progress}" height="8" roundness="4"/><Fill color="#4F6FC0"/>
  </Layer>
</pagx>`
}

// ---------------- scene 3: desktop pet ----------------
function s3 (t) {
  const inP = eo(seg(t, 0, 0.7))
  const petIn = eo(seg(t, 0.3, 0.7))
  const bob = Math.sin(t * 2 * Math.PI / 2.6) * 6
  const bubbleIn = eo(seg(t, 1.0, 0.5))
  const reply = eo(seg(t, 2.4, 0.5))
  const p = { x: 636, y: 250, s: 132 }
  // The bubble contracts once the reply arrives: a fixed height left a large
  // empty panel above a one-line message.
  const bh = 116 - reply * 40
  const bubble = { x: 388, y: 128, w: 348, h: bh }

  return `<?xml version="1.0" encoding="UTF-8"?>
<pagx width="${W}" height="${H}">
  <Resources>
    <Image id="avatar" source="data:image/png;base64,${AV}"/>
  </Resources>
  <Layer name="bg" width="100%" height="100%"><Rectangle width="100%" height="100%"/><Fill color="#DFE9F8"/></Layer>
  <Layer left="40" top="30" alpha="${inP * 0.22}" width="220" height="60">
    <TextBox textAlign="start" width="220" height="60"><Text text="14:52" fontFamily="STHeiti" fontSize="46"/><Fill color="#1B2C61"/></TextBox>
  </Layer>
  <Layer left="44" top="96" alpha="${inP * 0.55}" width="300" height="24">
    <TextBox textAlign="start" width="300" height="24"><Text text="整张桌面只有它一个角落" fontFamily="STHeiti" fontSize="14"/><Fill color="#6D7893"/></TextBox>
  </Layer>

  <Layer id="bubble" left="${bubble.x}" top="${bubble.y}" alpha="${bubbleIn}" width="${bubble.w}" height="${bubble.h}">
    <Rectangle width="${bubble.w}" height="${bubble.h}" roundness="16"/><Fill color="#FFFFFF"/>
    <Stroke color="#E4EAF5" width="1.5"/>
    <DropShadowStyle offsetY="8" blurX="20" blurY="20" color="#1B2C6118"/>
    <Layer left="18" top="18" width="${bubble.w - 36}" height="52">
      <TextBox textAlign="start" width="${bubble.w - 36}" height="52">
        <Text text="${reply > 0.5 ? '在忙，一会儿回你。' : '还在第 38 层，换了打法还是没过。'}" fontFamily="STHeiti" fontSize="14"/>
        <Fill color="#1B2C61"/>
      </TextBox>
    </Layer>
    <Layer left="18" top="74" alpha="${1 - reply}" width="70" height="26">
      <Rectangle width="70" height="26" roundness="13"/><Fill color="#EEF3FB"/>
      <Layer left="0" top="3" width="70" height="20">
        <TextBox textAlign="center" width="70" height="20"><Text text="回它" fontFamily="STHeiti" fontSize="12"/><Fill color="#1B2C61"/></TextBox>
      </Layer>
    </Layer>
    <Layer left="96" top="74" alpha="${1 - reply}" width="80" height="26">
      <TextBox textAlign="start" width="80" height="26"><Text text="别烦我" fontFamily="STHeiti" fontSize="12"/><Fill color="#8A95AD"/></TextBox>
    </Layer>
  </Layer>

  <Layer left="${p.x}" top="${p.y + bob}" alpha="${petIn}" width="${p.s}" height="${p.s}">
    <Rectangle width="${p.s}" height="${p.s}"/><Fill><ImagePattern image="@avatar"/></Fill>
  </Layer>
  <Layer left="${p.x + p.s - 16}" top="${p.y + bob + 10}" alpha="${petIn}" width="12" height="12">
    <Ellipse width="12" height="12"/><Fill color="#4F6FC0"/>
  </Layer>

  <Layer left="${Math.min(p.x - 40, W - (p.s + 80) - 24)}" top="${Math.min(p.y + p.s + 16, H - 60)}" alpha="${petIn}" width="${p.s + 80}" height="44">
    <Rectangle width="${p.s + 80}" height="44" roundness="14"/><Fill color="#FFFFFFCC"/>
    <Stroke color="#E4EAF5" width="1"/>
    <Layer left="24" top="11" width="20" height="22"><Rectangle width="20" height="8" roundness="4"/><Fill color="#8A95AD"/></Layer>
    <Layer left="${p.s / 2 + 8}" top="11" width="20" height="22"><Rectangle width="20" height="8" roundness="4"/><Fill color="#8A95AD"/></Layer>
    <Layer left="${p.s + 12}" top="11" width="20" height="22"><Rectangle width="20" height="8" roundness="4"/><Fill color="#8A95AD"/></Layer>
  </Layer>
</pagx>`
}

const SCENES = [
  { name: 'activity', dur: 5.5, fn: s1 },
  { name: 'publish', dur: 5.0, fn: s2 },
  { name: 'pet', dur: 4.5, fn: s3 },
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
