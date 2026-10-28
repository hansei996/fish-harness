/**
 * Video labelling for dsh-life — the one place that turns a raw clip into a
 * publishable artifact, and the only place allowed to.
 *
 * Why this is a module and not "a ffmpeg call in the publish path": the
 * labelling rules for video are *positional* and *structural*, and neither can
 * be satisfied by a text label appended to a caption.
 *
 *   - 《人工智能生成合成内容标识办法》§4(4) — 视频要在**起始画面**和播放周边加显著
 *     提示标识. A label that only appears at the end, or only in the caption,
 *     does not satisfy this. So the burn is applied to every frame, and
 *     `verifyVideoLabel()` decodes frame 0 to prove it is really there.
 *   - 同办法 §5 — 隐式标识要写进**文件元数据**，且必须含「生成合成内容属性、服务提供者
 *     名称或编码、内容编号」. That is container metadata, not the caption.
 *   - 同办法 §4 末句 — 提供**下载、复制、导出**功能时文件里也必须含显式标识. So the
 *      labelled artifact is the thing that gets published and shipped; there is
 *     no path here that emits the input bytes unchanged.
 *
 * Two consequences shape the code below:
 *
 *   1. **Failure is loud.** If ffmpeg is missing, or the burn/verify step does
 *      not confirm a label, this module throws. It never returns "the original
 *      file, hopefully fine" — an unlabelled video leaving this process would be
 *      a compliance violation that no later check could undo.
 *   2. **No strip/remove export either.** Like `compliance.js`, this module
 *      exports no function that removes a label. Re-labelling is idempotent
 *      (the label text is deduplicated), but there is no inverse.
 *
 * ffmpeg/ffprobe are external binaries, so they are injected (`run`) and the
 * module itself calls no child_process API. `verify/video.mjs` uses the real
 * binaries; the unit tests inject a fake runner.
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/** The marker that ties container metadata back to this product. */
export const MEDIA_MARKER = 'dsh-life'

/** Metadata keys, in the order they are written. §5 names three of them. */
export const METADATA_KEYS = Object.freeze(['marker', 'synthetic', 'provider', 'contentId'])

/** A uploaded video longer than this is refused by the publish line. */
export const MAX_VIDEO_SECONDS = 600
/** Telegram Bot API's own limit for `sendVideo` uploads is 50 MB. */
export const MAX_VIDEO_BYTES = 50 * 1024 * 1024

/**
 * Serialize the implicit identifier for a container `comment` tag.
 *
 * mp4 has no nested metadata, so the four required fields go into one
 * `key=value` list separated by `;`. Kept to ASCII-safe characters: the
 * contentId is ours, the provider code is validated to `[A-Za-z0-9._-]`, and
 * `marker`/`synthetic` are constants.
 */
export function serializeMediaMetadata ({ providerCode, contentId } = {}) {
  const provider = typeof providerCode === 'string' && providerCode.trim() ? providerCode.trim() : ''
  const id = typeof contentId === 'string' ? contentId.trim() : ''
  if (!provider) throw new Error('life/video-provider-code-required')
  if (!id) throw new Error('life/video-content-id-required')
  if (!/^[A-Za-z0-9._-]+$/.test(provider)) throw new Error('life/video-provider-code-invalid')
  return `marker=${MEDIA_MARKER};synthetic=1;provider=${provider};contentId=${id}`
}

/**
 * Parse a `comment` tag back into fields. Returns `null` when the tag is absent
 * or has no marker from this product, so "not ours" and "ours but malformed"
 * stay distinguishable to the caller.
 */
export function parseMediaMetadata (comment) {
  if (typeof comment !== 'string' || !comment.trim()) return null
  const fields = {}
  for (const part of comment.split(';')) {
    const at = part.indexOf('=')
    if (at <= 0) continue
    fields[part.slice(0, at).trim()] = part.slice(at + 1).trim()
  }
  if (fields.marker !== MEDIA_MARKER) return null
  return fields
}

/** sha256 of a file's bytes — what the approval binds to. */
export function fileDigest (filePath) {
  const hash = createHash('sha256')
  hash.update(fs.readFileSync(filePath))
  return hash.digest('hex')
}

/**
 * Run one external command. Injected so the module has no child_process import
 * and the tests never spawn anything.
 *
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
export function createRunner ({ spawn = null, timeoutMs = 120000 } = {}) {
  if (typeof spawn !== 'function') throw new Error('life/video-runner-requires-spawn')
  return async function run (command, args) {
    return await new Promise((resolve, reject) => {
      const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL') } catch (err) {}
        reject(new Error(`life/video-${path.basename(command)}-timeout`))
      }, timeoutMs)
      child.stdout.on('data', (chunk) => { stdout += String(chunk) })
      child.stderr.on('data', (chunk) => { stderr += String(chunk) })
      child.on('error', (err) => { clearTimeout(timer); reject(err) })
      child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
    })
  }
}

/**
 * Read duration/dimensions/codec without decoding the whole file.
 *
 * `ffprobe -of json` is the only stable machine-readable mode; parsing ffmpeg's
 * human output would break on the first wording change.
 */
export async function probeVideo ({ filePath, run, ffprobePath = 'ffprobe' } = {}) {
  if (typeof run !== 'function') throw new Error('life/video-runner-required')
  if (typeof filePath !== 'string' || !filePath.trim()) throw new Error('life/video-file-required')
  if (!fs.existsSync(filePath)) throw new Error(`life/video-file-missing: ${filePath}`)
  const { code, stdout, stderr } = await run(ffprobePath, [
    '-v', 'error',
    '-show_entries', 'format=duration,size:format_tags=comment:stream=codec_type,codec_name,width,height,duration',
    '-of', 'json',
    filePath,
  ])
  if (code !== 0) throw new Error(`life/video-probe-failed: ${stderr.trim().slice(0, 200)}`)
  let parsed
  try {
    parsed = JSON.parse(stdout)
  } catch (err) {
    throw new Error('life/video-probe-unparsable')
  }
  const streams = Array.isArray(parsed.streams) ? parsed.streams : []
  const video = streams.find((s) => s && s.codec_type === 'video') || null
  if (!video) throw new Error('life/video-no-video-stream')
  const durationSec = Number(parsed.format && parsed.format.duration)
  const sizeBytes = Number(parsed.format && parsed.format.size)
  return {
    durationSec: Number.isFinite(durationSec) ? durationSec : null,
    sizeBytes: Number.isFinite(sizeBytes) ? sizeBytes : null,
    width: Number.isFinite(Number(video.width)) ? Number(video.width) : null,
    height: Number.isFinite(Number(video.height)) ? Number(video.height) : null,
    codec: typeof video.codec_name === 'string' ? video.codec_name : null,
    metadata: parseMediaMetadata(parsed.format && parsed.format.tags && parsed.format.tags.comment),
  }
}

/**
 * Draw the explicit label on **every** frame and write the implicit identifier
 * into the container metadata.
 *
 * `-vf drawtext` without an `enable` expression applies to the whole stream, so
 * the label is in frame 0 — which is the requirement, and which
 * `verifyVideoLabel()` checks by decoding frame 0 rather than trusting this
 * comment.
 *
 * The video stream is re-encoded (`libx264`) because burning text is a pixel
 * operation; audio is copied so a real clip does not lose sound.
 */
export async function labelVideo ({
  inputPath,
  outputPath,
  contentId,
  providerCode = 'dsh-life',
  template = '—— AI 生成 · 内容编号 {contentId}',
  fontFile = null,
  fontSize = 18,
  run,
  ffmpegPath = 'ffmpeg',
} = {}) {
  if (typeof run !== 'function') throw new Error('life/video-runner-required')
  if (typeof inputPath !== 'string' || !inputPath.trim()) throw new Error('life/video-file-required')
  if (typeof outputPath !== 'string' || !outputPath.trim()) throw new Error('life/video-output-required')
  if (path.resolve(inputPath) === path.resolve(outputPath)) {
    // Overwriting the input would make "did the label get applied?" unanswerable
    // and could destroy the only copy of the source.
    throw new Error('life/video-output-must-differ')
  }
  if (typeof contentId !== 'string' || !contentId.trim()) throw new Error('life/video-content-id-required')
  if (typeof template !== 'string' || !template.includes('{contentId}')) {
    // Same rule as the text label: §5 makes the content number mandatory.
    throw new Error('life/video-label-template-requires-content-id')
  }

  const expanded = template.replaceAll('{contentId}', contentId.trim())
  const metadata = serializeMediaMetadata({ providerCode, contentId })
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })

  // drawtext needs its own escaping: `:` and `'` and `\` are filter syntax.
  const escapeText = (value) => String(value)
    .replaceAll('\\', '\\\\')
    .replaceAll(':', '\\:')
    .replaceAll("'", "\\'")
    .replaceAll('%', '\\%')
  const draw = [
    'drawtext=' + [
      fontFile ? `fontfile='${fontFile}'` : null,
      `text='${escapeText(expanded)}'`,
      `fontsize=${Number.isFinite(fontSize) ? fontSize : 18}`,
      'fontcolor=white',
      'box=1',
      'boxcolor=black@0.55',
      'boxborderw=6',
      // Bottom-left, inset 12px: inside the safe area on every aspect ratio.
      'x=12',
      'y=h-th-12',
    ].filter(Boolean).join(':'),
  ].join(',')

  const args = [
    '-v', 'error',
    '-i', inputPath,
    '-vf', draw,
    '-metadata', `comment=${metadata}`,
    // Faststart puts the moov atom first so a partial download still plays —
    // relevant because §4 also covers 下载/导出.
    '-movflags', '+faststart',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'copy',
    outputPath,
    '-y',
  ]
  const { code, stderr } = await run(ffmpegPath, args)
  if (code !== 0) {
    // Never leave a half-written artifact behind to be mistaken for a labelled
    // one. `-y` may have created the file before failing.
    try { fs.rmSync(outputPath, { force: true }) } catch (err) {}
    throw new Error(`life/video-label-failed: ${String(stderr).trim().slice(0, 200)}`)
  }
  if (!fs.existsSync(outputPath)) throw new Error('life/video-label-produced-nothing')

  const probed = await probeVideo({ filePath: outputPath, run, ffprobePath: ffprobePathFrom(ffmpegPath) })
  return {
    path: outputPath,
    labelText: expanded,
    metadata: {
      comment: metadata,
      fields: parseMediaMetadata(metadata),
    },
    durationSec: probed.durationSec,
    sizeBytes: probed.sizeBytes,
    width: probed.width,
    height: probed.height,
    codec: probed.codec,
    digest: fileDigest(outputPath),
  }
}

/**
 * Prove a labelled artifact really carries both identifiers.
 *
 * Three separate questions, deliberately not collapsed into one boolean:
 *   1. is the **implicit** identifier in the container metadata (§5)?
 *   2. is the **explicit** label actually burned into the **first frame**
 *      (§4(4))? Checked by decoding frame 0, comparing the pixels in the label
 *      band against the same band of the unlabelled source. If the band is
 *      identical the label is not there.
 *   3. is the size within the channel's upload limit?
 *
 * The pixel comparison is what makes this a proof rather than a formality:
 * every other check here (the ffmpeg exit code, the metadata tag, the request
 * we sent) could pass while the frame itself carried no visible label.
 */
export async function verifyVideoLabel ({
  labelledPath,
  sourcePath = null,
  contentId = null,
  providerCode = 'dsh-life',
  run,
  ffmpegPath = 'ffmpeg',
  ffprobePath = 'ffprobe',
  maxBytes = MAX_VIDEO_BYTES,
} = {}) {
  const problems = []
  const probed = await probeVideo({ filePath: labelledPath, run, ffprobePath })
  const fields = probed.metadata
  if (!fields) {
    problems.push('容器元数据里没有本产品的隐式标识（marker/synthetic/provider/contentId）')
  } else {
    if (fields.synthetic !== '1') problems.push('隐式标识缺少 synthetic=1（生成合成内容属性）')
    if (!fields.provider) problems.push('隐式标识缺少 provider（服务提供者编码）')
    if (!fields.contentId) problems.push('隐式标识缺少 contentId（内容编号）')
    if (providerCode && fields.provider && fields.provider !== providerCode) {
      problems.push(`隐式标识里的 provider 是 ${fields.provider}，与配置的 ${providerCode} 不一致`)
    }
    if (contentId && fields.contentId && fields.contentId !== contentId) {
      problems.push(`隐式标识里的 contentId 是 ${fields.contentId}，与记录里的 ${contentId} 不一致`)
    }
  }

  if (probed.sizeBytes !== null && probed.sizeBytes > maxBytes) {
    problems.push(`文件 ${probed.sizeBytes} 字节，超过渠道上限 ${maxBytes}`)
  }

  let burned = null
  if (sourcePath) {
    burned = await compareLabelBand({ labelledPath, sourcePath, run, ffmpegPath })
    if (burned.identical) {
      problems.push('首帧的标识区域与被标注前的素材一模一样 —— 画面上没有真的烧进显式标识')
    }
  }

  return {
    ok: problems.length === 0,
    problems,
    metadata: fields,
    durationSec: probed.durationSec,
    sizeBytes: probed.sizeBytes,
    burned,
  }
}

/**
 * Decode frame 0 of both files and measure the label band.
 *
 * Returns `{ identical, labelledSpan, sourceSpan }`. `identical: true` means the
 * band is byte-for-byte unchanged, i.e. nothing was drawn.
 *
 * **Decoding goes through a temp file, never stdout.** The injected runner
 * collects stdout as a JS string, and string round-tripping mangles every byte
 * >= 0x80 — with it, two *different* videos compared equal, so the check
 * reported "identical" for a labelled file and a silent pass looked like a
 * failure. Binary output therefore always lands in a file first.
 */
async function compareLabelBand ({ labelledPath, sourcePath, run, ffmpegPath }) {
  const scale = '160:120'
  const [labelled, source] = await Promise.all([
    decodeFrameToFile({ filePath: labelledPath, run, ffmpegPath, scale }),
    decodeFrameToFile({ filePath: sourcePath, run, ffmpegPath, scale }),
  ])
  return {
    identical: labelled.bytes.equals(source.bytes),
    labelledSpan: bandSpan(labelled),
    sourceSpan: bandSpan(source),
    width: labelled.width,
    height: labelled.height,
  }
}

/**
 * Decode frame 0 to raw RGB **into a file**, then read the bytes.
 *
 * Why a temp file and not stdout: the injected runner collects stdout as a JS
 * string, and string round-tripping mangles every byte >= 0x80. That is not a
 * hypothetical — with a stdout path, two *different* videos compared equal, so
 * "the label band is identical" reported true for a labelled file. A silent
 * byte-encoding bug was wearing the costume of a passing check.
 */
export async function decodeFrameToFile ({ filePath, run, ffmpegPath = 'ffmpeg', scale = '160:120' } = {}) {
  const [w, h] = String(scale).split(':')
  const width = Number(w)
  const height = Number(h)
  const tmp = `${filePath}.frame0-${process.pid}-${Date.now()}.rgb`
  const { code, stderr } = await run(ffmpegPath, [
    '-v', 'error',
    '-i', filePath,
    '-frames:v', '1',
    '-vf', `scale=${scale}`,
    '-f', 'rawvideo',
    '-pix_fmt', 'rgb24',
    tmp,
    '-y',
  ])
  if (code !== 0) {
    try { fs.rmSync(tmp, { force: true }) } catch (err) {}
    throw new Error(`life/video-frame-decode-failed: ${String(stderr).trim().slice(0, 160)}`)
  }
  const bytes = fs.readFileSync(tmp)
  fs.rmSync(tmp, { force: true })
  return { width, height, bytes }
}

/** Pixel-value span inside the label band (bottom-left, where the label goes). */
function bandSpan ({ width, height, bytes }) {
  const x0 = Math.round(width * 0.02)
  const x1 = Math.round(width * 0.75)
  const y0 = Math.max(0, height - Math.round(height * 0.16))
  const y1 = height - 1
  let min = Infinity
  let max = -Infinity
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const at = (y * width + x) * 3
      const value = bytes[at] + bytes[at + 1] + bytes[at + 2]
      if (value < min) min = value
      if (value > max) max = value
    }
  }
  return Number.isFinite(min) ? max - min : 0
}

/** `ffprobe` normally ships next to `ffmpeg`; keep them consistent when overridden. */
function ffprobePathFrom (ffmpegPath) {
  if (typeof ffmpegPath !== 'string' || !ffmpegPath.trim()) return 'ffprobe'
  if (ffmpegPath === 'ffmpeg') return 'ffprobe'
  return path.join(path.dirname(ffmpegPath), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')
}

/**
 * The hard gate the publish line runs before a video record may leave `checked`.
 *
 * It is deliberately a *refusal*: no artefact means no publish. Sharing the
 * shape of `compliance.js#assertLabeled` keeps one mental model for both media.
 */
export function assertVideoArtifact (media) {
  if (!media || typeof media !== 'object') throw new Error('life/video-media-required')
  const id = typeof media.contentId === 'string' ? media.contentId.trim() : ''
  if (!id) throw new Error('life/video-content-id-required')
  if (typeof media.path !== 'string' || !media.path.trim()) throw new Error('life/video-path-required')
  const fields = media.metadata && typeof media.metadata === 'object' ? media.metadata : {}
  if (fields.marker !== MEDIA_MARKER) throw new Error('life/video-metadata-marker-missing')
  if (fields.synthetic !== '1') throw new Error('life/video-metadata-synthetic-missing')
  if (!fields.provider) throw new Error('life/video-metadata-provider-missing')
  if (fields.contentId !== id) throw new Error('life/video-metadata-content-id-mismatch')
  if (typeof media.digest !== 'string' || !/^[0-9a-f]{64}$/.test(media.digest)) {
    throw new Error('life/video-digest-required')
  }
  if (typeof media.labelText !== 'string' || !media.labelText.includes(id)) {
    throw new Error('life/video-label-text-must-carry-content-id')
  }
  return media
}
