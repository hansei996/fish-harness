/**
 * 用**生产代码**产出一段「标注后的视频」证据，放进 docs/assets/。
 *
 * 为什么要有这个脚本而不是直接手工拷文件：那份 mp4 是这张页面声明的证据
 * （「每帧烧了显式标识、容器里有隐式标识」），手工拷的话，代码改了之后
 * 产物不会跟着变，而页面照旧声称它证明了什么 —— 这正是本仓库最反对的
 * 「产物与声称脱钩」。跑一次脚本就能重新生成并重新核验。
 *
 * 用法：
 *   node showcase/bake-video-label.mjs          # 生成 + 核验
 *   node showcase/bake-video-label.mjs --check  # 只核验已入库的产物（CI 用）
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PLUGIN = path.join(REPO, 'packages', 'dsh-life')
const video = await import(pathToFileURL(path.join(PLUGIN, 'lib', 'video.js')).href)

const OUT_DIR = path.join(REPO, 'docs', 'assets')
const OUT_MP4 = path.join(OUT_DIR, 'video-label-demo.mp4')
const OUT_PNG = path.join(OUT_DIR, 'video-label-frame0.png')
const CONTENT_ID = 'post-20261028-a7f3'
const FONT = process.env.VIDEO_FONT_PATH ||
  (fs.existsSync('/System/Library/Fonts/Hiragino Sans GB.ttc')
    ? '/System/Library/Fonts/Hiragino Sans GB.ttc'
    : null)

const run = video.createRunner({ spawn })

// ---- --check：只核验已经入库的那一份（CI 上不需要 ffmpeg 之外的任何东西）----
if (process.argv.includes('--check')) {
  if (!fs.existsSync(OUT_MP4)) {
    console.error(`缺 ${path.relative(REPO, OUT_MP4)} —— 跑 node showcase/bake-video-label.mjs 生成`)
    process.exit(1)
  }
  const probed = await video.probeVideo({ filePath: OUT_MP4, run })
  const fields = probed.metadata
  const problems = []
  if (!fields) problems.push('入库的 mp4 里没有隐式标识')
  else {
    if (fields.marker !== video.MEDIA_MARKER) problems.push('marker 不对')
    if (fields.synthetic !== '1') problems.push('缺 synthetic=1')
    if (!fields.provider) problems.push('缺 provider')
    if (fields.contentId !== CONTENT_ID) problems.push(`contentId 是 ${fields.contentId}，期望 ${CONTENT_ID}`)
  }
  if (problems.length) {
    console.error(`入库的视频证据不合格：${problems.join('; ')}`)
    process.exit(1)
  }
  console.log(`入库的视频证据合格：contentId=${fields.contentId}, provider=${fields.provider}, ${probed.durationSec}s/${probed.sizeBytes}B`)
  process.exit(0)
}

// ---- 生成 ----
fs.mkdirSync(OUT_DIR, { recursive: true })
const workDir = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'dsh-life-video-bake-'))
const raw = path.join(workDir, 'raw.mp4')

// 一段渐变底 + 右上角走秒的素材，代表「它自己录的一段」。
// 不是真游戏录像 —— 脚本不假装它是；素材内容与标识是否合规无关。
const made = await run('ffmpeg', ['-v', 'error', '-f', 'lavfi',
  '-i', 'gradients=s=640x360:d=4:r=24:c0=0x0b1a3a:c1=0x2b5fd9',
  '-vf', `drawtext=fontfile='${FONT}':text='%{eif\\:t\\:d}s':fontsize=44:fontcolor=white@0.85:x=w-tw-24:y=24`,
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', raw, '-y'])
if (made.code !== 0) throw new Error(`造素材失败：${made.stderr.slice(0, 200)}`)

const labelled = await video.labelVideo({
  inputPath: raw, outputPath: OUT_MP4, contentId: CONTENT_ID,
  fontFile: FONT, fontSize: 20, run,
})

// 首帧另存一张 png：视频要下载才能看，而「标识在第一帧」这件事值得一眼可见。
const frame = await run('ffmpeg', ['-v', 'error', '-i', OUT_MP4, '-frames:v', '1', OUT_PNG, '-y'])
if (frame.code !== 0) throw new Error(`抽首帧失败：${frame.stderr.slice(0, 200)}`)

// **产完就核**：不核的话，这个脚本可能生成一份没有标识的文件然后入库。
const verified = await video.verifyVideoLabel({
  labelledPath: OUT_MP4, sourcePath: raw, contentId: CONTENT_ID, run,
})
if (!verified.ok) {
  console.error(`生成的产物核验不通过：${verified.problems.join('; ')}`)
  process.exit(1)
}

// 反例也要在生成时确认一次：没有它，上面的「通过」只证明检查会点头。
const negative = await video.verifyVideoLabel({ labelledPath: raw, sourcePath: raw, contentId: CONTENT_ID, run })
if (negative.ok) {
  console.error('反例失败：未标注的素材竟然被核验通过了，说明核验根本没在看画面')
  process.exit(1)
}

fs.rmSync(workDir, { recursive: true, force: true })
console.log(`已生成并核验：${path.relative(REPO, OUT_MP4)}（${labelled.sizeBytes}B）+ ${path.relative(REPO, OUT_PNG)}`)
console.log(`  显式标识：${labelled.labelText}`)
console.log(`  隐式标识：${labelled.metadata.comment}`)
console.log(`  首帧核验：标识区 span=${verified.burned.labelledSpan}（原始素材 ${verified.burned.sourceSpan}）`)
console.log(`  反例：未标注的素材被拒绝（${negative.problems.length} 条理由）`)
