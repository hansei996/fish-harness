import fs from 'node:fs'
import { dayKeyOf } from './wake.js'

/**
 * Read-only UI seam for the "运行总览" screen.
 *
 * The screen's data comes from `/life/state.json`, which this module serves by
 * reading {@link LifeStore} *on every request* — nothing is cached and nothing
 * is composed ahead of time, so the page can never show yesterday's story as
 * today's. The handler is strictly read-only and deliberately narrow: identity
 * (public fields), the current activity with its reason, the next wake-up, the
 * open commitments, and per-day counters.
 *
 * What it must never expose: relations notes, ledger rows, witness/evidence
 * bodies, or anything the keeper said in private. The client fetches this over
 * the same origin, so this file is the only place that decides what leaves the
 * Host.
 */

/** Exact route the client half fetches. Kept in sync with client/life-overview.js. */
export const LIFE_STATE_PATH = '/life/state.json'

/** At most this many open commitments reach the screen. */
const MAX_COMMITMENTS = 3

function messageOf (err) {
  return String(err && err.message ? err.message : err)
}

/**
 * Refuse to describe a state file that exists but cannot be parsed.
 *
 * {@link LifeStore} degrades a corrupt file to empty values on purpose, so a
 * crashed write never kills the life. That is right for the model-facing
 * snapshot and wrong for a screen: "没有正在进行的事" would be a claim, not a
 * degradation. So the read path here is the one place that distinguishes a
 * missing file (fine, `ensure()` may not have run) from a corrupt one (report it).
 *
 * @param {import('./store.js').LifeStore} store
 */
function assertStateReadable (store) {
  const files = store && store.files ? store.files : {}
  for (const name of ['identity', 'activity', 'commitments', 'wake']) {
    const file = files[name]
    if (typeof file !== 'string') continue
    let text
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch (err) {
      continue // absent is not corrupt
    }
    try {
      JSON.parse(text)
    } catch (err) {
      throw new Error(`life/state-corrupt:${name}`)
    }
  }
}

/**
 * Build the public state document from the store.
 *
 * Every field is derived from files on disk at call time. A missing or corrupt
 * file degrades to an empty value through the store's own tolerant readers; a
 * genuine read failure is the caller's to report as `{ ok: false }`.
 *
 * @param {import('./store.js').LifeStore} store
 * @param {{ now?: Date|string|number }} [options]
 */
export function readLifeState (store, { now } = {}) {
  assertStateReadable(store)
  // The store owns the clock (tests inject a fixed one); use it so "today" and
  // `generatedAt` agree with the wake counters written under the same clock.
  const clock = store && typeof store.clock === 'function' ? store.clock() : undefined
  const at = now === undefined ? (clock === undefined ? new Date() : new Date(clock)) : new Date(now)
  const moment = Number.isNaN(at.getTime()) ? new Date() : at
  const dayKey = dayKeyOf(moment)
  const identity = store.readIdentity()
  const activity = store.readActivity()
  const wake = store.readWake()

  const today = { turns: 0, wakes: 0, activities: 0, failures: 0 }
  for (const row of store.readLedger({ limit: 0 })) {
    if (!row || typeof row.at !== 'string') continue
    const when = new Date(row.at)
    if (Number.isNaN(when.getTime()) || dayKeyOf(when) !== dayKey) continue
    if (row.kind === 'turn') {
      today.turns += 1
      // A turn that closed with a reason kind is a failed turn. `reason` is the
      // only trace kept in the ledger (see lib/index.js), so this is the whole
      // definition of "failed" available here — state it, don't guess wider.
      if (row.detail && typeof row.detail.reason === 'string' && row.detail.reason) today.failures += 1
    } else if (row.kind === 'wake') {
      today.wakes += 1
    } else if (row.kind === 'activity-end') {
      today.activities += 1
      const outcome = row.detail && typeof row.detail.outcome === 'string' ? row.detail.outcome : 'done'
      if (outcome !== 'done' && outcome !== 'resting') today.failures += 1
    }
  }

  return {
    ok: true,
    generatedAt: moment.toISOString(),
    identity: {
      name: identity && identity.name ? identity.name : 'unknown',
      species: identity && identity.species ? identity.species : 'unknown',
      revision: identity && Number.isInteger(identity.revision) ? identity.revision : 0,
    },
    activity: activity.current && typeof activity.current.what === 'string'
      ? {
          what: activity.current.what,
          why: typeof activity.current.why === 'string' ? activity.current.why : '',
          startedAt: typeof activity.current.startedAt === 'string' ? activity.current.startedAt : null,
        }
      : null,
    nextWakeAt: typeof wake.nextAt === 'string' ? wake.nextAt : null,
    wakeCountToday: wake.dayKey === dayKey ? wake.countToday : 0,
    openCommitments: store.openCommitments().slice(0, MAX_COMMITMENTS).map((row) => ({
      what: String(row.what || ''),
      dueAt: typeof row.dueAt === 'string' ? row.dueAt : null,
    })),
    today,
  }
}

/**
 * Mount the state route when the profile has a web server, and do nothing at all
 * when it does not.
 *
 * `webServer` is deliberately not in the module-level `inject`: a headless or SDK
 * profile must boot with the life layer unchanged, without a warning and without
 * a route. This function therefore never throws and never logs — it only decides
 * whether there is a place to register.
 *
 * @param {object} root - Cordis context of the plugin.
 * @param {import('./store.js').LifeStore} store
 * @param {object} [settings]
 */
export function installLifeUi (root, store, settings = {}) {
  if (!root || typeof root.inject !== 'function') return
  try {
    root.inject(['webServer'], (ctx) => {
      try {
        if (!ctx || !ctx.webServer || typeof ctx.webServer.register !== 'function') return
        // Signature: dsh-host-webserver/lib/types/index.d.ts — WebRoute
        // { kind: 'exact' | 'prefix', path: string, handler(req, res) }.
        ctx.webServer.register({
          kind: 'exact',
          path: LIFE_STATE_PATH,
          handler: (req, res) => {
            if (req && req.method && req.method !== 'GET' && req.method !== 'HEAD') {
              res.writeHead(405, { 'content-type': 'application/json; charset=utf-8', allow: 'GET, HEAD' })
              res.end(JSON.stringify({ ok: false, error: 'life/read-only' }))
              return
            }
            let body
            try {
              body = JSON.stringify(readLifeState(store, settings))
            } catch (err) {
              // A corrupt or unreadable state must still answer: the screen then
              // says "拿不到状态" instead of showing a blank or a fake story.
              body = JSON.stringify({ ok: false, error: messageOf(err) })
            }
            res.writeHead(200, {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-store',
            })
            res.end(body)
          },
        })
      } catch (err) {
        // Never let the UI seam break a boot.
      }
    })
  } catch (err) {
    // Never let the UI seam break a boot.
  }
}
