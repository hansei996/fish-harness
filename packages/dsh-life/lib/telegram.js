/**
 * Telegram Bot API transport for dsh-life — zero dependencies, injectable fetch.
 *
 * This is the one real channel adapter, kept deliberately tiny. Two design
 * choices matter:
 *
 *   1. **The token comes from an environment variable name, never from plugin
 *      config.** `createTelegramTransport({ tokenEnv })` reads
 *      `process.env[tokenEnv]` at call time. The value is used only in the
 *      request URL and is never returned, logged, or stored; error messages are
 *      scrubbed before they leave this module. (Credential isolation is still
 *      not a security boundary — the agent runs as the same OS user — so the
 *      approval + tool boundary is what actually gates publishing.)
 *   2. **`query()` returns `null` on purpose.** The Bot API has no "look this up
 *      by idempotency key" endpoint; pretending to check would turn an unknown
 *      delivery into a fake answer. `null` means "cannot verify", so the outbox
 *      stays `unconfirmed` and a human/平台 reconciliation is required.
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const TELEGRAM_API_BASE = 'https://api.telegram.org'
/** Bot API hard limit for `sendVideo` uploads. */
export const TELEGRAM_MAX_VIDEO_BYTES = 50 * 1024 * 1024
const TOKEN_ENV_PATTERN = /^[A-Z][A-Z0-9_]{2,63}$/
const MAX_ERROR_CHARS = 300

/**
 * @param {object} options
 * @param {string} options.tokenEnv - environment variable *name* holding the bot token
 * @param {Function} [options.fetchImpl] - injected fetch (tests use a fake; never real in tests)
 * @param {string} [options.apiBase] - API root, defaults to the public Bot API
 * @returns {{send: Function, query: Function}}
 */
export function createTelegramTransport ({
  tokenEnv,
  fetchImpl = globalThis.fetch,
  apiBase = TELEGRAM_API_BASE,
  maxVideoBytes = TELEGRAM_MAX_VIDEO_BYTES,
} = {}) {
  if (typeof tokenEnv !== 'string' || !TOKEN_ENV_PATTERN.test(tokenEnv)) {
    throw new Error('life/telegram-token-env-invalid: tokenEnv must be an env var name like TELEGRAM_BOT_TOKEN')
  }
  const base = typeof apiBase === 'string' && apiBase.trim()
    ? apiBase.trim().replace(/\/+$/, '')
    : TELEGRAM_API_BASE
  const request = typeof fetchImpl === 'function' ? fetchImpl : null

  return {
    /**
     * Send one item, dispatching on whether it carries media.
     *
     * Throws for every outcome that is not a proven success, which the outbox
     * maps to `unconfirmed` (never an automatic retry).
     */
    async send (candidate) {
      const media = candidate && candidate.media
      if (media && media.kind === 'video') return await this.sendVideo(candidate)
      if (media) throw new Error(`life/telegram-media-unsupported: ${media.kind}`)
      return await this.sendMessage(candidate)
    },

    /**
     * Upload one labelled video with its labelled caption.
     *
     * Two things are checked here rather than trusted from the caller:
     *
     *   1. **The file still hashes to the digest the approval bound.** The
     *      caption alone would not notice a swapped file, and the approval was
     *      for exact bytes. A mismatch aborts *before* any request, so it cannot
     *      even become `unconfirmed` — nothing was sent.
     *   2. **It fits the platform limit.** A 50 MB cap is Telegram's, not ours;
     *      discovering it as a 413 after upload wastes the approval.
     *
     * `multipart/form-data` is built by hand because the module has no
     * dependencies and `fetch` + `FormData` + a file stream is the one
     * combination that differs between Node and the Electron runtime. A Buffer
     * body is portable; the cost is holding one video in memory, bounded by the
     * size check above.
     */
    async sendVideo (candidate) {
      const token = readToken(tokenEnv)
      if (!request) throw new Error('life/telegram-fetch-unavailable')
      const chatId = candidate && candidate.account
      const text = candidate && candidate.text
      const media = candidate && candidate.media
      if (typeof chatId !== 'string' || !chatId.trim()) throw new Error('life/telegram-chat-id-required')
      if (typeof text !== 'string' || !text.trim()) throw new Error('life/telegram-text-required')
      const filePath = media && typeof media.path === 'string' ? media.path : ''
      if (!filePath) throw new Error('life/telegram-media-path-required')
      if (!fs.existsSync(filePath)) throw new Error(`life/telegram-media-missing: ${path.basename(filePath)}`)

      const bytes = fs.readFileSync(filePath)
      if (bytes.length > maxVideoBytes) {
        throw new Error(`life/telegram-media-too-large: ${bytes.length} > ${maxVideoBytes}`)
      }
      if (typeof media.digest === 'string' && media.digest && digestOf(bytes) !== media.digest) {
        throw new Error('life/telegram-media-digest-mismatch: 文件与已批准的那一份不是同一份，拒绝上传')
      }

      const boundary = `----dshlife${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
      const parts = []
      parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n`,
        'utf8',
      ))
      // `caption` keeps the visible label next to the video; §4(4) asks for it
      // 在视频播放周边, and the burn-in covers the 起始画面 half.
      parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${text}\r\n`,
        'utf8',
      ))
      parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="video"; filename="${path.basename(filePath)}"\r\n`
        + 'Content-Type: video/mp4\r\n\r\n',
        'utf8',
      ))
      parts.push(bytes)
      parts.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'))
      const body = Buffer.concat(parts)

      let response
      try {
        response = await request(`${base}/bot${token}/sendVideo`, {
          method: 'POST',
          headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
          body,
        })
      } catch (err) {
        throw scrub(new Error(`telegram video request failed: ${messageOf(err)}`), token)
      }
      return await readReceipt(response, token)
    },

    /** Send one text message. */
    async sendMessage (candidate) {
      const token = readToken(tokenEnv)
      if (!request) throw new Error('life/telegram-fetch-unavailable')
      const chatId = candidate && candidate.account
      const text = candidate && candidate.text
      if (typeof chatId !== 'string' || !chatId.trim()) {
        throw new Error('life/telegram-chat-id-required')
      }
      if (typeof text !== 'string' || !text.trim()) {
        throw new Error('life/telegram-text-required')
      }

      let response
      try {
        response = await request(`${base}/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text,
            disable_web_page_preview: true,
          }),
        })
      } catch (err) {
        throw scrub(new Error(`telegram request failed: ${messageOf(err)}`), token)
      }

      return await readReceipt(response, token)
    },

    /**
     * The Bot API cannot answer "did message X (sent with this key) land?".
     * Returning null means "unverifiable" — the caller must keep the record
     * unconfirmed and ask a human. This is a platform limitation, not a todo.
     */
    async query () {
      return null
    },
  }
}

/**
 * Turn one Bot API response into a platform id, or throw.
 *
 * Both `sendMessage` and `sendVideo` share this: the two endpoints differ only
 * in the request body, and duplicating the receipt logic would let one of them
 * drift into accepting a response the other rejects.
 */
async function readReceipt (response, token) {
  let payload = null
  try {
    payload = await response.json()
  } catch (err) {
    // A non-JSON body is an unknown outcome; let the upper layer mark it
    // unconfirmed rather than guessing.
    throw scrub(new Error(`HTTP ${response && response.status} non-JSON response`), token)
  }

  if (!response || response.ok !== true || !payload || payload.ok !== true) {
    const status = response && response.status
    const description = payload && typeof payload.description === 'string'
      ? payload.description
      : ''
    throw scrub(new Error(`HTTP ${status} ${description}`.trim()), token)
  }

  const messageId = payload.result && payload.result.message_id
  if (!Number.isInteger(messageId)) {
    throw scrub(new Error('telegram response missing result.message_id'), token)
  }
  // Deliberately no raw response: it can contain the chat payload, and the
  // caller only needs the stable platform object id.
  return { platformId: `tg:${messageId}` }
}

/** sha256 of a Buffer, as lowercase hex. */
function digestOf (bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function readToken (tokenEnv) {
  const value = process.env[tokenEnv]
  if (typeof value !== 'string' || !value.trim()) {
    const error = new Error(`credential-unconfigured: environment variable ${tokenEnv} is not set`)
    error.code = 'credential-unconfigured'
    throw error
  }
  return value.trim()
}

function messageOf (err) {
  return (err && err.message) || String(err)
}

/** Strip the token from any message before it reaches logs or tool output. */
function scrub (error, token) {
  const text = messageOf(error).split(token).join('[redacted]').slice(0, MAX_ERROR_CHARS)
  const safe = new Error(text)
  safe.code = error && error.code
  return safe
}
