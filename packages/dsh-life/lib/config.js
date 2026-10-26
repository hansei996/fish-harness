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
}

const CLOCK_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/

function isPlainObject (value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function issue (path, message) {
  return { path: [path], message }
}

function validate (input) {
  const issues = []
  const raw = input === undefined || input === null ? {} : input

  if (!isPlainObject(raw)) {
    return { issues: [issue(undefined, 'life config must be an object')] }
  }

  const out = { ...DEFAULTS }

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

  for (const key of ['injectContext', 'autoCreate', 'wakeEnabled']) {
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
