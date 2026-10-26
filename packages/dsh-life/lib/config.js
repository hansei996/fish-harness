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
}

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

  for (const key of ['injectContext', 'autoCreate']) {
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
