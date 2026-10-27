/**
 * Zero-dependency plugin config schema.
 *
 * Cordis validates a plugin's exported `Config` through the Standard Schema
 * interface (`Config['~standard'].validate`), which is what schemastery also
 * implements. dsh-life cannot import schemastery: it is installed into profiles
 * whose dependency roots differ between the npm CLI and the bundled Electron
 * runtime, so it must resolve with Node built-ins alone.
 *
 * So this module implements the same tiny interface directly: defaults,
 * type coercion, and bounded values. A rejected field is reported as a
 * Standard Schema issue rather than silently ignored, because a silently
 * ignored `lifeId` would point two lives at one identity.
 */

const DEFAULTS = {
  lifeId: 'default',
  name: '大肥鱼',
  species: 'whale',
  seeds: ['聪明但懒', '傲娇', '爱吃白饭'],
  injectContext: true,
  autoCreate: true,
  maxLedgerEntries: 20000,
  // Autonomous wake-up. dsh's schedule has neither jitter, quiet hours nor a
  // daily budget, so all three are configured and enforced here.
  wakeEnabled: true,
  wakeEveryMinutes: 90,
  wakeJitterMinutes: 20,
  wakeQuietStart: '23:00',
  wakeQuietEnd: '08:00',
  wakeMaxPerDay: 6,
  wakePrompt: '（自主唤醒）现在没有人跟你说话，是你自己醒的。先 life_whoami 看看自己的状态，再决定继续昨天没做完的事，或者明确休息。真实经历才算经历，没有证据就如实说没做成。',
  // Activity chooser (docs/PLAN.md §6.2). Optional: disabling it leaves the
  // life to decide without a ranked shortlist, which is honest degradation.
  chooserEnabled: true,
  chooserTopN: 3,
  // Publish line (docs/PLAN.md §7.3). Off by default: with no configured
  // channel there must be no outward action at all. Credentials never live
  // here — they belong to the runtime that injects the transport.
  publisherEnabled: false,
  publisherChannels: [],
  publisherProviderCode: 'dsh-life',
  publisherMaxOutbox: 200,
}

/** Channel kinds this build knows how to describe. Credentials are separate. */
export const PUBLISH_CHANNEL_KINDS = Object.freeze(['telegram', 'file'])

/** Any config key that looks like a credential is rejected outright. */
const CREDENTIAL_KEY = /(token|secret|password|credential|api[-_]?key|access[-_]?key|private[-_]?key)/i

/**
 * The one permitted exception: `tokenEnv` holds the *name* of an environment
 * variable, never the secret itself. Everything else that looks like a token
 * key (including `token`) is still refused.
 */
const CREDENTIAL_KEY_ALLOWLIST = new Set(['tokenEnv'])

/** Environment variable names only: uppercase, digits, underscore. */
const TOKEN_ENV_PATTERN = /^[A-Z][A-Z0-9_]{2,63}$/

const CLOCK_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/

function isPlainObject (value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function issue (path, message) {
  return { path: [path], message }
}

/**
 * Collect credential-looking key paths anywhere in the raw config.
 *
 * A publish chain that accepts `token:` in YAML would leak a secret into the
 * life directory and every backup of it, so this is refused even before the
 * field is understood by anything.
 */
function credentialKeyPaths (value, prefix = '', out = [], depth = 0) {
  if (depth > 4 || value === null || typeof value !== 'object') return out
  if (Array.isArray(value)) {
    value.forEach((item, index) => credentialKeyPaths(item, `${prefix}[${index}]`, out, depth + 1))
    return out
  }
  for (const [key, item] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (CREDENTIAL_KEY.test(key) && !CREDENTIAL_KEY_ALLOWLIST.has(key)) out.push(path)
    else credentialKeyPaths(item, path, out, depth + 1)
  }
  return out
}

function validate (input) {
  const issues = []
  const raw = input === undefined || input === null ? {} : input

  if (!isPlainObject(raw)) {
    return { issues: [issue(undefined, 'life config must be an object')] }
  }

  const out = { ...DEFAULTS }

  for (const path of credentialKeyPaths(raw)) {
    issues.push(issue(path, 'credentials must not be stored in plugin config; inject them from the runtime instead'))
  }

  if ('lifeId' in raw) {
    const value = raw.lifeId
    if (typeof value !== 'string' || !value.trim()) {
      issues.push(issue('lifeId', 'lifeId must be a non-empty string'))
    } else if (!/^[A-Za-z0-9_-]{1,64}$/.test(value)) {
      // It becomes a directory name, so refuse anything that could escape it.
      issues.push(issue('lifeId', 'lifeId may only contain letters, digits, hyphen and underscore (max 64)'))
    } else {
      out.lifeId = value
    }
  }

  for (const key of ['name', 'species']) {
    if (!(key in raw)) continue
    const value = raw[key]
    if (typeof value !== 'string' || !value.trim()) {
      issues.push(issue(key, `${key} must be a non-empty string`))
    } else if (value.length > 120) {
      issues.push(issue(key, `${key} must be at most 120 characters`))
    } else {
      out[key] = value
    }
  }

  if ('seeds' in raw) {
    const value = raw.seeds
    if (!Array.isArray(value)) {
      issues.push(issue('seeds', 'seeds must be an array of strings'))
    } else if (value.some((item) => typeof item !== 'string')) {
      issues.push(issue('seeds', 'every seed must be a string'))
    } else if (value.length > 8) {
      issues.push(issue('seeds', 'at most 8 seeds; a starting point is not a full persona'))
    } else {
      out.seeds = value.slice()
    }
  }

  for (const key of ['injectContext', 'autoCreate', 'wakeEnabled', 'chooserEnabled', 'publisherEnabled']) {
    if (!(key in raw)) continue
    if (typeof raw[key] !== 'boolean') {
      issues.push(issue(key, `${key} must be a boolean`))
    } else {
      out[key] = raw[key]
    }
  }

  if ('maxLedgerEntries' in raw) {
    const value = raw.maxLedgerEntries
    if (!Number.isInteger(value) || value < 100 || value > 1000000) {
      issues.push(issue('maxLedgerEntries', 'maxLedgerEntries must be an integer between 100 and 1000000'))
    } else {
      out.maxLedgerEntries = value
    }
  }

  // Wake-up interval, jitter and the daily budget: each is an integer bound,
  // reported as an issue rather than silently clamped so a typo in a profile
  // cannot quietly turn a life into a 15-minute spammer.
  for (const [key, min, max] of [
    ['wakeEveryMinutes', 15, 1440],
    ['wakeJitterMinutes', 0, 240],
    ['wakeMaxPerDay', 1, 48],
    ['chooserTopN', 1, 5],
    ['publisherMaxOutbox', 10, 2000],
  ]) {
    if (!(key in raw)) continue
    const value = raw[key]
    if (!Number.isInteger(value) || value < min || value > max) {
      issues.push(issue(key, `${key} must be an integer between ${min} and ${max}`))
    } else {
      out[key] = value
    }
  }

  // Quiet hours are local wall-clock 'HH:MM'. Format is validated first, then
  // the two ends must differ — an equal pair would mean "quiet all day" or,
  // depending on the interpretation, no quiet at all; either way it is a typo.
  for (const key of ['wakeQuietStart', 'wakeQuietEnd']) {
    if (!(key in raw)) continue
    const value = raw[key]
    if (typeof value !== 'string' || !CLOCK_PATTERN.test(value)) {
      issues.push(issue(key, `${key} must be a 24h 'HH:MM' string`))
    } else {
      out[key] = value
    }
  }
  if (typeof out.wakeQuietStart === 'string' && typeof out.wakeQuietEnd === 'string' &&
      out.wakeQuietStart === out.wakeQuietEnd) {
    issues.push(issue('wakeQuietEnd', 'wakeQuietEnd must differ from wakeQuietStart'))
  }

  if ('wakePrompt' in raw) {
    const value = raw.wakePrompt
    if (typeof value !== 'string' || !value.trim()) {
      issues.push(issue('wakePrompt', 'wakePrompt must be a non-empty string'))
    } else if (value.length > 1000) {
      issues.push(issue('wakePrompt', 'wakePrompt must be at most 1000 characters'))
    } else {
      out.wakePrompt = value
    }
  }

  if ('publisherProviderCode' in raw) {
    const value = raw.publisherProviderCode
    if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(value)) {
      issues.push(issue('publisherProviderCode', 'publisherProviderCode must be 1-64 letters, digits, dot, hyphen or underscore'))
    } else {
      out.publisherProviderCode = value
    }
  }

  if ('publisherChannels' in raw) {
    const value = raw.publisherChannels
    if (!Array.isArray(value)) {
      issues.push(issue('publisherChannels', 'publisherChannels must be an array'))
    } else if (value.length > 10) {
      issues.push(issue('publisherChannels', 'at most 10 publisher channels'))
    } else {
      const channels = []
      const seen = new Set()
      value.forEach((item, index) => {
        const prefix = `publisherChannels[${index}]`
        if (!isPlainObject(item)) {
          issues.push(issue(prefix, 'each publisher channel must be an object { id, kind, account }'))
          return
        }
        const allowedKeys = ['id', 'kind', 'account', 'tokenEnv']
        const extra = Object.keys(item).filter((key) => !allowedKeys.includes(key))
        for (const key of extra) {
          issues.push(issue(`${prefix}.${key}`, 'publisher channel may only contain id, kind, account, tokenEnv; credentials belong to the runtime'))
        }
        const id = typeof item.id === 'string' ? item.id.trim() : ''
        if (!/^[A-Za-z0-9_.-]{1,64}$/.test(id)) {
          issues.push(issue(`${prefix}.id`, 'channel id must be 1-64 letters, digits, dot, hyphen or underscore'))
        } else if (seen.has(id)) {
          issues.push(issue(`${prefix}.id`, 'channel id must be unique'))
        } else {
          seen.add(id)
        }
        if (!PUBLISH_CHANNEL_KINDS.includes(item.kind)) {
          issues.push(issue(`${prefix}.kind`, `channel kind must be one of: ${PUBLISH_CHANNEL_KINDS.join(', ')}`))
        }
        if (typeof item.account !== 'string' || !item.account.trim()) {
          issues.push(issue(`${prefix}.account`, 'channel account must be a non-empty string'))
        } else if (item.account.length > 120) {
          issues.push(issue(`${prefix}.account`, 'channel account must be at most 120 characters'))
        }
        if (item.tokenEnv !== undefined) {
          // A variable *name*, never a value: this is what keeps secrets out of
          // profiles, backups and the model context.
          if (typeof item.tokenEnv !== 'string' || !TOKEN_ENV_PATTERN.test(item.tokenEnv)) {
            issues.push(issue(`${prefix}.tokenEnv`, 'tokenEnv must be an environment variable name like TELEGRAM_BOT_TOKEN'))
          }
        }
        channels.push({
          id,
          kind: item.kind,
          account: typeof item.account === 'string' ? item.account.trim() : '',
          ...(item.tokenEnv === undefined ? {} : { tokenEnv: item.tokenEnv }),
        })
      })
      out.publisherChannels = channels
    }
  }

  if (issues.length) return { issues }
  return { value: out }
}

/** A Standard Schema v1 object, structurally compatible with schemastery. */
export const ConfigSchema = {
  '~standard': {
    version: 1,
    vendor: 'dsh-life',
    validate,
  },
}

export const ConfigDefaults = { ...DEFAULTS }

export default ConfigSchema
