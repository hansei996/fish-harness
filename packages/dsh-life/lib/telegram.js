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

export const TELEGRAM_API_BASE = 'https://api.telegram.org'
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
     * Send one message. Throws for every outcome that is not a proven success,
     * which the outbox maps to `unconfirmed` (never an automatic retry).
     */
    async send (candidate) {
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
