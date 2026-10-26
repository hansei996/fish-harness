/**
 * Wake-up timing math for dsh-life — pure functions, no IO.
 *
 * dsh's `schedule` service is a durable Host timer with no jitter, no quiet
 * hours and no daily budget (see docs/dsh-schedule-api.md §7). Those three
 * guarantees are the life layer's job: they are computed here, then handed to
 * `ctx.schedule.create(...)` as a plain one-shot delay. Keeping the math free
 * of IO is what makes it testable deterministically by injecting `random`.
 *
 * All clock values are interpreted in the host's local time zone, because
 * "23:00–08:00 quiet hours" is a wall-clock promise to the keeper, not a UTC
 * interval. `dayKeyOf` is the same local-calendar notion used to reset the
 * daily wake budget.
 */

const MINUTE_MS = 60 * 1000

/** dsh's schedule rejects anything shorter than one minute. */
export const MIN_WAKE_DELAY_MS = 60 * 1000

/** Parse 'HH:MM' (24h) into minutes since midnight, or null when malformed. */
export function parseClock (value) {
  if (typeof value !== 'string') return null
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value.trim())
  if (!match) return null
  return Number(match[1]) * 60 + Number(match[2])
}

/** Local calendar day key, `YYYY-MM-DD`. */
export function dayKeyOf (value) {
  const date = toDate(value)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/**
 * Whether a wall-clock instant falls inside the quiet window.
 *
 * The window is half-open `[start, end)` and supports crossing midnight
 * (23:00 → 08:00 means 23:00 included, 08:00 excluded). A malformed or empty
 * window is never quiet, so a broken config degrades to "always allowed"
 * instead of silencing the life forever.
 */
export function isQuietAt (value, { quietStart, quietEnd } = {}) {
  const start = parseClock(quietStart)
  const end = parseClock(quietEnd)
  if (start === null || end === null || start === end) return false
  const date = toDate(value)
  const minutes = date.getHours() * 60 + date.getMinutes()
  if (start < end) return minutes >= start && minutes < end
  return minutes >= start || minutes < end
}

/**
 * Next delay before an autonomous wake-up.
 *
 * Rule: `now + everyMinutes ± jitterMinutes`. If that target lands inside the
 * quiet window it is pushed to the first quiet-end after it, plus a small
 * `0..jitterMinutes` spread so several lives do not wake on the same second.
 * A long interval can make that push jump over a whole calendar day; see
 * {@link clampToLastAllowedMoment} for the one exception that keeps the life
 * from disappearing for 24h. The result is always strictly positive and at
 * least one minute, since schedule's minimum granularity is 60s.
 *
 * `random` is injectable: a fixed function makes the output deterministic for
 * tests. It is called at most twice (spread, then quiet-window spread).
 */
export function nextWakeDelayMs ({
  now,
  everyMinutes,
  jitterMinutes = 0,
  quietStart,
  quietEnd,
  random = Math.random,
} = {}) {
  const from = toDate(now)
  const every = positiveNumber(everyMinutes, 90)
  const jitter = Math.max(0, positiveNumber(jitterMinutes, 0) || 0)
  const roll = sample(random)

  const spread = (roll * 2 - 1) * jitter * MINUTE_MS
  let target = from.getTime() + every * MINUTE_MS + spread

  const window = { quietStart, quietEnd }
  if (isQuietAt(target, window)) {
    const endMinutes = parseClock(quietEnd)
    // Quiet-end is guaranteed parseable here: isQuietAt returned true.
    const quietSpread = Math.floor(sample(random) * jitter * MINUTE_MS)
    target = nextClockAfter(target, endMinutes) + quietSpread
    // A quiet window that spans almost the whole day plus a large jitter can
    // land back inside it; settle exactly on the boundary rather than loop.
    if (isQuietAt(target, window)) target = nextClockAfter(target, endMinutes)
    // The push may now be two or more calendar days away, which would erase an
    // entire day of the life. Keep one allowed moment on the first skipped day.
    target = clampToLastAllowedMoment({ now: from, targetMs: target, quietStart, quietEnd })
  }

  return Math.max(MIN_WAKE_DELAY_MS, Math.round(target - from.getTime()))
}

/**
 * Keep a quiet-pushed target from skipping a whole local calendar day.
 *
 * With a 1440-minute interval and wide jitter, the target can land in the quiet
 * window so late that the quiet-end push lands on the *next* day's morning.
 * That is legal ("never wake during quiet hours") but it deletes a calendar day
 * from the life: no wake-up, no activity, nothing to explain to the keeper.
 *
 * When the pushed target is two or more local days ahead, the earliest skipped
 * day gets one allowed instant instead: one minute before quiet starts (22:59
 * for the default 23:00–08:00 window). A target that is only one day ahead is
 * returned untouched, so the ordinary "sleep until tomorrow morning" rollover
 * is byte-for-byte unchanged.
 *
 * No clamping when the window cannot supply a safe previous minute:
 * - `quietStart === '00:00'` would produce "yesterday 23:59", i.e. a past time;
 * - a malformed or empty window has no meaningful last allowed moment.
 *
 * @returns {number} epoch ms of the (possibly clamped) target.
 */
export function clampToLastAllowedMoment ({ now, targetMs, quietStart, quietEnd } = {}) {
  const from = toDate(now)
  const target = toMillis(targetMs)
  if (target === null) return from.getTime()

  const start = parseClock(quietStart)
  const end = parseClock(quietEnd)
  if (start === null || end === null || start === end) return target
  if (start === 0) return target

  const fromDay = localDayNumber(from)
  const targetDay = localDayNumber(new Date(target))
  if (targetDay - fromDay < 2) return target

  // The earliest day that would otherwise have no wake at all.
  const skipped = new Date(
    from.getFullYear(),
    from.getMonth(),
    from.getDate() + 1,
    Math.floor((start - 1) / 60),
    (start - 1) % 60,
    0,
    0,
  )
  const clamped = skipped.getTime()
  if (!Number.isFinite(clamped) || clamped <= from.getTime()) return target
  return Math.min(clamped, target)
}

/**
 * Delay until the next quiet-end boundary — the "come back tomorrow" delay used
 * once the daily wake budget is spent.
 *
 * Returns the first `quietEnd` strictly after `now` (today's if it is still
 * ahead, otherwise tomorrow's) plus an optional `0..jitterMinutes` spread.
 * With the default 23:00–08:00 window an exhausted budget at any evening hour
 * therefore yields "tomorrow morning", never a 15-minute retry loop.
 */
export function msUntilNextDayWake ({
  now,
  quietEnd,
  jitterMinutes = 0,
  random = Math.random,
} = {}) {
  const from = toDate(now)
  const endMinutes = parseClock(quietEnd)
  const boundary = parseClock('08:00')
  const jitter = Math.max(0, positiveNumber(jitterMinutes, 0) || 0)
  const delay = nextClockAfter(from, endMinutes === null ? boundary : endMinutes) - from.getTime()
  const spread = Math.floor(sample(random) * jitter * MINUTE_MS)
  return Math.max(MIN_WAKE_DELAY_MS, Math.round(delay + spread))
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function toDate (value) {
  if (value instanceof Date) return new Date(value.getTime())
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value)
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return new Date(parsed)
  }
  return new Date()
}

/** Epoch ms for a Date/number/parseable string, or null when unusable. */
function toMillis (value) {
  if (value instanceof Date) {
    const time = value.getTime()
    return Number.isFinite(time) ? time : null
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

/**
 * Local calendar day as an integer day number.
 *
 * Built from local year/month/day through UTC so that DST shifts cannot make
 * two instants of the same local day compare as different days (and so the
 * difference is a day count, not a string comparison).
 */
function localDayNumber (date) {
  return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / (24 * 60 * 60 * 1000))
}

function nextClockAfter (value, clockMinutes) {
  const from = toDate(value)
  const candidate = new Date(
    from.getFullYear(),
    from.getMonth(),
    from.getDate(),
    Math.floor(clockMinutes / 60),
    clockMinutes % 60,
    0,
    0,
  )
  if (candidate.getTime() <= from.getTime()) candidate.setDate(candidate.getDate() + 1)
  return candidate.getTime()
}

function positiveNumber (value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : fallback
}

function sample (random) {
  const value = typeof random === 'function' ? Number(random()) : NaN
  if (!Number.isFinite(value)) return 0.5
  return Math.min(0.999999, Math.max(0, value))
}
