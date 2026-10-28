/**
 * video — 守住「视频发布线」：标注、核验、绑定批准、以及在真的 ffmpeg 上跑通一遍。
 *
 * 为什么需要这一套：视频发布有三处**看起来能做、实际没做**的地方，而且它们都不会自己报错。
 *
 *   1. **标了没标，肉眼分不出。** 文本标识错了，读者能看出来；视频标识错了，
 *      只是画面上少了一行字。所以这里不只检查「ffmpeg 退出码是 0」，
 *      而是**解码首帧、比像素**，证明那行字真的烧进去了（§4(4) 明确要求
 *      「视频起始画面……添加显著提示标识」）。
 *   2. **隐式标识在容器里，不在字幕里。** §5 要求文件元数据含生成合成属性、
 *      提供者编码、内容编号。这里回读容器元数据逐字段核，并核**内容编号与记录一致**。
 *   3. **换了文件，批准还生效 —— 这是最危险的一条。** 批准绑定的是内容版本；
 *      如果版本只算字幕，「通过」之后换掉视频文件就能绕过。所以：
 *        - `contentVersion` 把媒体摘要算进去（纯文本调用结果不变）；
 *        - 发布前**重新哈希磁盘上的文件**，并且重新核验标识；
 *        - 上传时不匹配就拒绝，连 `unconfirmed` 都不会变成（因为没发）。
 *
 * 本套件用**本机真的 ffmpeg/ffprobe**跑一遍完整链路，其余纯逻辑断言用注入的假
 * runner 跑。
 *
 * **缺 ffmpeg 是 FAIL，不是 SKIP。** 这一条与 `verify/landing.mjs` 的选择相反，
 * 理由是这两套的价值不同：landing 在没浏览器时仍有 15 条像素无关的断言可跑，
 * 而这一套里「真的烧进了首帧」那 8 条**就是**它的价值 —— 跳过它们之后，
 * 剩下的只是在测自己的假 runner。一个会自己缩小范围的检查，正是本仓库最反对的
 * 「能骗过自己的检查」。所以 ffmpeg 是环境要求：CI 装（verify.yml 有安装步骤），
 * 本地跑之前也装。缺了就说清楚缺什么，而不是悄悄少 8 条。
 *
 * 用法：
 *   node verify/video.mjs
 *   FFMPEG_PATH=/opt/homebrew/bin/ffmpeg node verify/video.mjs
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PLUGIN = path.join(REPO, 'packages', 'dsh-life')

// 动态 import 必须显式过 `pathToFileURL`，不能藏在一个小 helper 里 ——
// `verify/day-report.mjs` 有一条静态断言专门扫这件事（Windows 上 `import('C:\...')`
// 会报 ERR_UNSUPPORTED_ESM_URL_SCHEME，这个坑本仓库踩过两次）。写成 helper 之后
// 那条断言看不见 `pathToFileURL`，于是它报「裸路径 import」。
const video = await import(pathToFileURL(path.join(PLUGIN, 'lib', 'video.js')).href)
const outbox = await import(pathToFileURL(path.join(PLUGIN, 'lib', 'outbox.js')).href)

const results = []
const check = (label, ok, detail = '') => {
  results.push({ label, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}
const skip = (label, detail = '') => console.log(`SKIP  ${label}${detail ? ` — ${detail}` : ''}`)
const messageOf = (err) => (err && err.message) || String(err)

// --------------------------------------------------------------- 1. 纯逻辑

// 隐式标识序列化：四个必填字段都要在，且能原样读回。
{
  const comment = video.serializeMediaMetadata({ providerCode: 'dsh-life', contentId: 'post-1' })
  const parsed = video.parseMediaMetadata(comment)
  check('隐式标识：四个必填字段都能序列化并读回（marker/synthetic/provider/contentId）',
    parsed && parsed.marker === 'dsh-life' && parsed.synthetic === '1' &&
      parsed.provider === 'dsh-life' && parsed.contentId === 'post-1',
    comment)

  check('隐式标识：缺少提供者编码或内容编号时拒绝生成',
    (() => {
      try { video.serializeMediaMetadata({ providerCode: '', contentId: 'x' }); return false } catch (err) { return true }
    })() &&
    (() => {
      try { video.serializeMediaMetadata({ providerCode: 'p', contentId: '' }); return false } catch (err) { return true }
    })())

  // 别人的文件不能被误认成我们的：标记不对就返回 null（而不是抛错，也不是当成合法）。
  check('隐式标识：别人的 comment 不认（返回 null），不是抛错也不是误认',
    video.parseMediaMetadata('handbrake;version=1.7') === null &&
    video.parseMediaMetadata('') === null &&
    video.parseMediaMetadata(null) === null)
}

// 标识模板必须带内容编号 —— 与文本标识同一条硬规则。
{
  let refused = false
  try {
    await video.labelVideo({
      inputPath: '/nonexistent.mp4', outputPath: '/tmp/out.mp4', contentId: 'x',
      template: '没有编号', run: async () => ({ code: 0, stdout: '', stderr: '' }),
    })
  } catch (err) { refused = err.message.includes('requires-content-id') }
  check('显式标识：模板丢掉 {contentId} 时拒绝（内容编号是必填项）', refused)
}

// 不允许把输出写成输入：那会让「到底标没标上」不可回答，还可能毁掉唯一的源文件。
{
  let refused = false
  const same = path.join(os.tmpdir(), 'same.mp4')
  try {
    await video.labelVideo({
      inputPath: same, outputPath: same, contentId: 'x',
      run: async () => ({ code: 0, stdout: '', stderr: '' }),
    })
  } catch (err) { refused = err.message.includes('output-must-differ') }
  check('标注：拒绝覆盖输入文件（否则无法回答「标上了没有」，且可能毁掉源文件）', refused)
}

// contentVersion 必须绑住媒体：这是「换文件绕过批准」的堵口。
{
  const text = '今天打了一局'
  const digestA = 'a'.repeat(64)
  const digestB = 'b'.repeat(64)
  const plain = outbox.contentVersionOf(text)
  check('内容版本：纯文本调用的结果与加媒体参数之前完全一样（旧记录与旧断言不漂）',
    plain === outbox.contentVersionOf(text, null) && plain === outbox.contentVersionOf(text, undefined))

  check('内容版本：字幕相同但视频不同 → 版本不同（换文件无法复用旧批准）',
    outbox.contentVersionOf(text, digestA) !== outbox.contentVersionOf(text, digestB) &&
    outbox.contentVersionOf(text, digestA) !== plain)
}

// 草案记录：没有摘要的媒体必须被拒绝（否则版本等于忽略视频）。
{
  const base = { contentId: 'p1', text: 'hi', channel: 'c', account: 'a' }
  const okMedia = {
    kind: 'video', path: '/tmp/v.mp4', digest: 'c'.repeat(64),
    labelText: '—— AI 生成 · 内容编号 p1',
    metadata: { marker: 'dsh-life', synthetic: '1', provider: 'dsh-life', contentId: 'p1' },
  }
  const withMedia = outbox.createDraft({ ...base, media: okMedia })
  check('草案：带媒体时记录里带上了摘要，且 candidate 里有 media',
    withMedia.media.digest === okMedia.digest && outbox.candidateOf(withMedia).media.kind === 'video')

  const bad = [
    { ...okMedia, digest: '' },
    { ...okMedia, digest: 'nothex' },
    { ...okMedia, kind: 'audio' },
    { ...okMedia, metadata: null },
    { ...okMedia, labelText: '' },
  ]
  const refused = bad.every((media) => {
    try { outbox.createDraft({ ...base, media }); return false } catch (err) { return true }
  })
  check('草案：媒体缺摘要 / 摘要不是 64 位 hex / 不是视频 / 缺元数据 / 缺标识文本 —— 一律拒绝', refused)

  check('草案：不带媒体时记录里没有 media 字段（纯文本记录形状未变）',
    !('media' in outbox.createDraft(base)))
}

// assertVideoArtifact 是硬闸：每一项缺失都要拦下来。
{
  const good = {
    contentId: 'p1', path: '/tmp/v.mp4', digest: 'd'.repeat(64),
    labelText: '—— AI 生成 · 内容编号 p1',
    metadata: { marker: 'dsh-life', synthetic: '1', provider: 'dsh-life', contentId: 'p1' },
  }
  const cases = [
    ['缺 contentId', { ...good, contentId: '' }],
    ['缺 path', { ...good, path: '' }],
    ['缺 marker', { ...good, metadata: { ...good.metadata, marker: '' } }],
    ['缺 synthetic', { ...good, metadata: { ...good.metadata, synthetic: '' } }],
    ['缺 provider', { ...good, metadata: { ...good.metadata, provider: '' } }],
    ['内容编号不一致', { ...good, metadata: { ...good.metadata, contentId: 'other' } }],
    ['摘要格式错', { ...good, digest: 'short' }],
    ['标识文本不含内容编号', { ...good, labelText: '—— AI 生成' }],
  ]
  const missed = cases.filter(([, media]) => {
    try { video.assertVideoArtifact(media); return true } catch (err) { return false }
  })
  check('硬闸 assertVideoArtifact：每一项缺失都拦得住', missed.length === 0,
    missed.length ? missed.map(([n]) => n).join(', ') : `${cases.length} 种缺失已核`)
  check('硬闸 assertVideoArtifact：完整的一份通过',
    (() => { try { video.assertVideoArtifact(good); return true } catch (err) { return false } })())
}

// 模块不许导出任何「去掉标识」的函数（与 compliance.js 同一条纪律）。
{
  const exported = Object.keys(video)
  const suspicious = exported.filter((name) => /strip|remove|unlabel|erase|clean/i.test(name))
  check('模块不导出任何去除标识的函数（标识只能加，不能减）',
    suspicious.length === 0,
    suspicious.length ? `可疑导出：${suspicious.join(', ')}` : `${exported.length} 个导出已扫`)
}

// --------------------------------------------------------------- 2. 真 ffmpeg
//
// 这一半是整套的价值所在：「视频已经标注」这句话只有在**首帧像素被真的比对过**
// 之后才算数。所以它不能因为缺 ffmpeg 就整段跳过 —— 那样剩下的断言只是在测
// 自己注入的假 runner，而这一套的项数也会从 21 掉到 14，让「没装工具」伪装成
// 「数字对不上」。做法改成：缺 ffmpeg 时**每条照样注册、全部失败**，
// 并说清缺的是什么。红一次、装上，比长期静默少 8 条好。

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg'
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe'

const hasFfmpeg = await new Promise((resolve) => {
  const child = spawn(FFMPEG, ['-version'], { stdio: ['ignore', 'pipe', 'pipe'] })
  child.on('error', () => resolve(false))
  child.on('close', (code) => resolve(code === 0))
})

/**
 * 注册一条「需要真 ffmpeg」的断言。
 *
 * 传进来的是**动作的 thunk**，不是算好的结果 —— 缺 ffmpeg 时根本不去执行它，
 * 于是不会在别处炸出一堆无关的 ENOENT，只会得到一句干净的「缺 ffmpeg」。
 */
const realCheck = async (label, thunk) => {
  if (!hasFfmpeg) {
    check(label, false, `缺 ffmpeg（${FFMPEG}）：这一条没有真的验证 —— 装上 ffmpeg，或设 FFMPEG_PATH 指过去`)
    return
  }
  try {
    const { ok, detail } = await thunk()
    check(label, ok, detail)
  } catch (err) {
    check(label, false, `执行出错：${messageOf(err)}`)
  }
}

const dir = hasFfmpeg ? fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-life-video-')) : null
const src = dir ? path.join(dir, 'source.mp4') : null
const labelled = dir ? path.join(dir, 'labelled.mp4') : null
const run = hasFfmpeg ? video.createRunner({ spawn }) : null

// 供后续断言共享的结果（缺 ffmpeg 时为空，realCheck 不会用到）。
let probedSource = null
let labelledResult = null
let verified = null
const FONT = process.env.VIDEO_FONT_PATH ||
  (fs.existsSync('/System/Library/Fonts/Hiragino Sans GB.ttc')
    ? '/System/Library/Fonts/Hiragino Sans GB.ttc'
    : null)

await realCheck('真 ffmpeg：造出一段测试素材（2 秒 / 320x240）', async () => {
  const made = await run(FFMPEG, [
    '-v', 'error', '-f', 'lavfi', '-i', 'color=c=navy:s=320x240:d=2:r=10',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', src, '-y',
  ])
  return { ok: made.code === 0 && fs.existsSync(src), detail: made.code === 0 ? '' : made.stderr.slice(0, 120) }
})

await realCheck('探测：读出时长/宽高/编码，且未标注的素材没有本产品的隐式标识', async () => {
  probedSource = await video.probeVideo({ filePath: src, run, ffprobePath: FFPROBE })
  return {
    ok: probedSource.durationSec === 2 && probedSource.width === 320 &&
      probedSource.height === 240 && probedSource.metadata === null,
    detail: JSON.stringify({ d: probedSource.durationSec, w: probedSource.width, h: probedSource.height }),
  }
})

await realCheck('标注：产出新文件（不覆盖输入）、带摘要、带四个隐式标识字段', async () => {
  labelledResult = await video.labelVideo({
    inputPath: src, outputPath: labelled, contentId: 'post-e2e',
    fontFile: FONT, run, ffmpegPath: FFMPEG,
  })
  return {
    ok: labelledResult.path === labelled && fs.existsSync(src) && fs.existsSync(labelled) &&
      /^[0-9a-f]{64}$/.test(labelledResult.digest) &&
      labelledResult.metadata.fields.contentId === 'post-e2e',
    detail: `digest=${labelledResult.digest.slice(0, 12)}… bytes=${labelledResult.sizeBytes}`,
  }
})

await realCheck('核验：已标注的文件通过（元数据齐全 + 首帧标识区与素材不同）', async () => {
  verified = await video.verifyVideoLabel({
    labelledPath: labelled, sourcePath: src, contentId: 'post-e2e',
    run, ffmpegPath: FFMPEG, ffprobePath: FFPROBE,
  })
  return {
    ok: verified.ok === true && verified.burned && verified.burned.identical === false,
    detail: verified.ok
      ? `首帧标识区 span=${verified.burned.labelledSpan}（素材 ${verified.burned.sourceSpan}）`
      : verified.problems.join('; '),
  }
})

// **反例**：拿没标注的素材冒充「已标注」，必须红。这是这一套里最重要的一条 ——
// 没有它，上面那条只能证明「检查会通过」，不能证明「检查会发现没有标识」。
await realCheck('核验：未标注的素材必须被拒（隐式标识缺失 + 首帧没有烧进显式标识）', async () => {
  const unlabelled = await video.verifyVideoLabel({
    labelledPath: src, sourcePath: src, contentId: 'post-e2e',
    run, ffmpegPath: FFMPEG, ffprobePath: FFPROBE,
  })
  return {
    ok: unlabelled.ok === false &&
      unlabelled.problems.some((p) => p.includes('隐式标识')) &&
      unlabelled.problems.some((p) => p.includes('显式标识')),
    detail: unlabelled.problems.join('; '),
  }
})

// 内容编号对不上也要拦：拿别人的编号去验，字面正确但归属错了。
await realCheck('核验：内容编号与记录不一致时拒绝', async () => {
  const wrongId = await video.verifyVideoLabel({
    labelledPath: labelled, sourcePath: src, contentId: 'post-other',
    run, ffmpegPath: FFMPEG, ffprobePath: FFPROBE,
  })
  return {
    ok: wrongId.ok === false && wrongId.problems.some((p) => p.includes('contentId')),
    detail: wrongId.problems.join('; '),
  }
})

// 大小上限：把上限设成 1 字节，必须红（渠道限制要先在本地发现，不是上传后 413）。
await realCheck('核验：超过渠道大小上限时拒绝（本地就发现，而不是上传后被平台拒）', async () => {
  const tooBig = await video.verifyVideoLabel({
    labelledPath: labelled, sourcePath: src, contentId: 'post-e2e',
    run, ffmpegPath: FFMPEG, ffprobePath: FFPROBE, maxBytes: 1,
  })
  return {
    ok: tooBig.ok === false && tooBig.problems.some((p) => p.includes('超过渠道上限')),
    detail: tooBig.problems.join('; '),
  }
})

// 幂等：对已标注的文件再标一次，不应把标识叠成两行。
await realCheck('标注：对已标注的文件再标一次，标识文本不重复叠加（幂等）', async () => {
  const twice = path.join(dir, 'twice.mp4')
  const second = await video.labelVideo({
    inputPath: labelled, outputPath: twice, contentId: 'post-e2e',
    fontFile: FONT, run, ffmpegPath: FFMPEG,
  })
  return {
    ok: second.metadata.fields.contentId === 'post-e2e' &&
      second.metadata.comment === labelledResult.metadata.comment,
    detail: second.metadata.comment,
  }
})

if (dir) fs.rmSync(dir, { recursive: true, force: true })

// ------------------------------------------------- 3. 入库的那件证据
//
// `docs/assets/video-label-demo.mp4` 是页面用来声称「我们真的标了」的物证。
// 物证最危险的形态是**过期**：代码改了、标注规则变了，而那个文件还是旧的，
// 页面照旧拿它当证据。所以这里也核它一遍 —— 它必须带着当前规则要求的隐式标识。
await realCheck('入库的视频物证带着当前规则的隐式标识（物证不许过期）', async () => {
  const shipped = path.join(REPO, 'docs', 'assets', 'video-label-demo.mp4')
  if (!fs.existsSync(shipped)) {
    return { ok: false, detail: '缺 docs/assets/video-label-demo.mp4 —— 跑 node showcase/bake-video-label.mjs' }
  }
  const probed = await video.probeVideo({ filePath: shipped, run, ffprobePath: FFPROBE })
  const fields = probed.metadata
  return {
    ok: Boolean(fields) && fields.marker === video.MEDIA_MARKER &&
      fields.synthetic === '1' && Boolean(fields.provider) && Boolean(fields.contentId),
    detail: fields
      ? `contentId=${fields.contentId}, provider=${fields.provider}, ${probed.durationSec}s/${probed.sizeBytes}B`
      : '文件里没有隐式标识 —— 物证与当前实现脱钩了，重新生成它',
  }
})

// --------------------------------------------------------------- 汇总

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length) console.log(`failed: ${failed.map((r) => r.label).join(' | ')}`)
process.exit(failed.length ? 1 : 0)
