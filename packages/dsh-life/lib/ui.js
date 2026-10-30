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
 * Events are projected through an allowlist, never returned as raw ledger rows.
 * Relations notes, witness/evidence bodies and private conversation text stay
 * on the Host. The client fetches this over
 * the same origin, so this file is the only place that decides what leaves the
 * Host.
 */

/** Exact route the client half fetches. Kept in sync with client/life-overview.js. */
export const LIFE_STATE_PATH = '/life/state.json'
export const LIFE_AVATAR_PATH = '/life/avatar.png'
export const LIFE_LEDGER_PATH = '/api/life/ledger'
export const LIFE_DRAFTS_PATH = '/api/life/bilibili-drafts'
export const LIFE_DRAFT_EXPORT_PATH = '/api/life/bilibili-export'

/** At most this many open commitments reach the screen. */
const MAX_COMMITMENTS = 3
const MAX_RECENT_EVENTS = 5
const TURN_LABELS = { completed: '完成了一次回应', error: '一次回应失败', aborted: '停止了一次回应',
  blocked: '一次回应受阻', 'max-tokens': '回应达到长度上限', interrupted: '一次回应中断' }

function brief (value, max = 240) {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

// Do not spread event.detail: it can contain private notes, evidence and account
// identifiers. A new ledger kind needs an explicit public presentation here.
function publicEvent (row) {
  const d = row.detail || {}
  const what = brief(d.what)
  let label
  switch (row.kind) {
    case 'born': label = '开始了自己的生活'; break
    case 'activity-start': label = what ? `开始：${what}` : null; break
    case 'activity-end': label = what ? `${d.outcome === 'done' ? '完成' : d.outcome === 'resting' ? '休息' : '未完成'}：${what}` : null; break
    case 'interest': label = d.topic ? `记下一个兴趣：${brief(d.topic)}` : null; break
    case 'skill': label = d.name ? `积累技能：${brief(d.name)}` : null; break
    case 'commitment': label = what ? `记住约定：${what}` : null; break
    case 'commitment-settled': label = d.status === 'done' ? '兑现了一件约定' : '更新了一件约定'; break
    case 'wake': label = '自己醒来了'; break
    case 'publish': label = d.status === 'draft' ? '保存了一份投稿草稿' : d.status === 'confirmed' ? '一条作品收到发布回执' : '更新了作品的发布状态'; break
    case 'turn': label = Object.hasOwn(TURN_LABELS, d.reason) ? TURN_LABELS[d.reason] : '一轮回应结束'; break
    case 'identity-change': label = '更新了身份档案'; break
    case 'encounter': label = '记下了一次关系互动'; break
    default: return null
  }
  return label ? {
    at: row.at, kind: row.kind, label,
    evidenceCount: Array.isArray(d.evidence) ? d.evidence.filter((item) => typeof item === 'string' && item.trim()).length : 0,
    outcome: row.kind === 'activity-end' ? brief(d.outcome, 32) : null,
  } : null
}

function ledgerItem ({ id, row }) {
  const item = publicEvent(row)
  if (!item) return null
  const d = row.detail || {}
  return { ...item, id, why: brief(d.why),
    entityId: ['activity-start', 'activity-end', 'commitment', 'commitment-settled'].includes(row.kind) ? brief(d.id, 80) : null,
    nextStep: row.kind === 'activity-end' && d.next?.what ? brief(d.next.what) : null,
    canDraft: ['activity-start', 'activity-end', 'interest', 'skill'].includes(row.kind),
  }
}

/** An owner-only ledger page, with cursors that do not shift on new appends. */
export function readLifeLedger (store, { cursor = '', category = 'all', limit = 25, eventId = '' } = {}) {
  const groups = { all: null, activity: ['activity-start', 'activity-end'], interest: ['interest', 'skill'],
    commitment: ['commitment', 'commitment-settled'], turn: ['turn', 'wake'], publish: ['publish'] }
  if (!Object.hasOwn(groups, category) || !Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('life/ledger-invalid-query')
  const entries = store.ledgerEntries()
  if (eventId) {
    const entry = entries.find((e) => e.id === eventId)
    const event = entry && ledgerItem(entry)
    if (!event) throw new Error('life/ledger-event-not-found')
    const d = entry.row.detail || {}
    return { ok: true, event: { ...event, evidence: (Array.isArray(d.evidence) ? d.evidence : [])
      .filter((e) => typeof e === 'string' && e.trim()).slice(0, 8).map((e) => brief(e, 1000)) },
      related: event.entityId ? entries.map(ledgerItem).filter((e) => e && e.entityId === event.entityId).slice(-10) : [] }
  }
  const filtered = entries.map(ledgerItem).filter((item) => item && (!groups[category] || groups[category].includes(item.kind))).reverse()
  const after = cursor ? filtered.findIndex((item) => item.id === cursor) : -1
  if (cursor && after < 0) throw new Error('life/ledger-cursor-expired')
  const items = filtered.slice(after + 1, after + 1 + limit)
  return { ok: true, items, total: filtered.length,
    nextCursor: after + 1 + items.length < filtered.length ? items.at(-1).id : null }
}

function draftView (record) {
  return { id: record.contentId, version: record.contentVersion, status: 'manual-draft',
    createdAt: record.createdAt, updatedAt: record.updatedAt, ...record.manualDraft }
}

/** Connection owns Host/Origin checks, signed-cookie admission and owner scope. */
export function installOwnerLifeUi (root, store) {
  root.inject(['connection'], (ctx) => {
    if (!ctx.connection?.fetch?.register) return
    const register = (route) => typeof ctx.effect === 'function'
      ? ctx.effect(() => ctx.connection.fetch.register(route)) : ctx.connection.fetch.register(route)
    const json = (value, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store' } })
    const wrap = (handler) => async (request) => {
      try { return await handler(request) } catch (err) {
        const error = messageOf(err)
        const status = /conflict|cursor-expired/.test(error) ? 409 : /not-found|source-unavailable/.test(error) ? 404 : 400
        return json({ ok: false, error }, status)
      }
    }
    register({ path: LIFE_LEDGER_PATH, methods: ['GET'], requestBody: 'buffered', fetch: wrap(async (request) => {
      const p = new URL(request.url).searchParams
      return json(readLifeLedger(store, { cursor: p.get('cursor') || '', category: p.get('category') || 'all',
        limit: p.has('limit') ? Number(p.get('limit')) : 25, eventId: p.get('event') || '' }))
    }) })
    register({ path: LIFE_DRAFTS_PATH, methods: ['GET', 'POST'], requestBody: 'buffered', fetch: wrap(async (request) => {
      if (request.method === 'GET') return json({ ok: true, items: store.readBilibiliDrafts().map(draftView) })
      if (!request.headers.get('content-type')?.startsWith('application/json')) return json({ ok: false, error: 'life/json-required' }, 415)
      const body = await request.text()
      if (Buffer.byteLength(body, 'utf8') > 32768) return json({ ok: false, error: 'life/body-too-large' }, 413)
      const input = JSON.parse(body)
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('life/bilibili-invalid-input')
      return json({ ok: true, item: draftView(store.saveBilibiliDraft(input)) })
    }) })
    register({ path: LIFE_DRAFT_EXPORT_PATH, methods: ['GET'], requestBody: 'buffered', fetch: wrap(async (request) => {
      const file = store.exportBilibiliDraft(new URL(request.url).searchParams.get('id'))
      return new Response(file.text, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store',
        'content-disposition': `attachment; filename="bilibili-${file.contentId}.txt"`, 'x-content-type-options': 'nosniff' } })
    }) })
  })
}

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
  for (const name of ['identity', 'activity', 'commitments', 'wake', 'traits', 'outbox']) {
    const file = files[name]
    if (typeof file !== 'string') continue
    let text
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch (err) {
      if (err && err.code === 'ENOENT') continue // not born yet is different from unreadable
      throw new Error(`life/state-unreadable:${name}`)
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
export function readLifeState (store, { now, wakeEnabled = true, wakeMaxPerDay = null } = {}) {
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
  const traits = store.readTraits()
  const outbox = store.readOutbox()
  const wakeCountToday = wake.dayKey === dayKey ? wake.countToday : 0
  const maxPerDay = Number.isInteger(wakeMaxPerDay) && wakeMaxPerDay >= 0 ? wakeMaxPerDay : null
  const attention = {
    approval: outbox.items.filter((item) => item.status === 'checked').length,
    unconfirmed: outbox.items.filter((item) => item.status === 'unconfirmed').length,
    manualDrafts: outbox.items.filter((item) => item.manualDraft?.platform === 'bilibili' && item.status === 'draft').length,
  }
  attention.total = attention.approval + attention.unconfirmed + attention.manualDrafts

  const today = { turns: 0, wakes: 0, activities: 0, failures: 0 }
  const events = []
  for (const row of store.readLedger({ limit: 0 })) {
    if (!row || typeof row.at !== 'string') continue
    const when = new Date(row.at)
    if (Number.isNaN(when.getTime()) || dayKeyOf(when) !== dayKey) continue
    const event = publicEvent(row)
    if (event) events.push(event)
    if (row.kind === 'turn') {
      today.turns += 1
      // dsh's TurnEndReasonMap uses "completed" for success and "aborted" for
      // cancellation. Only "error" explicitly means the turn failed; a reason
      // being present is not evidence of failure (the first live API test caught this).
      if (row.detail && row.detail.reason === 'error') today.failures += 1
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
      lifeId: store.lifeId,
      bornAt: identity && typeof identity.bornAt === 'string' ? identity.bornAt : null,
      name: identity && identity.name ? identity.name : 'unknown',
      species: identity && identity.species ? identity.species : 'unknown',
      revision: identity && Number.isInteger(identity.revision) ? identity.revision : 0,
    },
    activity: activity.current && typeof activity.current.what === 'string'
      ? {
          what: activity.current.what,
          why: typeof activity.current.why === 'string' ? activity.current.why : '',
          startedAt: typeof activity.current.startedAt === 'string' ? activity.current.startedAt : null,
          evidenceCount: Array.isArray(activity.current.evidence) ? activity.current.evidence.length : 0,
        }
      : null,
    nextWakeAt: typeof wake.nextAt === 'string' ? wake.nextAt : null,
    wakeCountToday,
    lifeStatus: !identity ? 'uninitialized' : activity.current ? 'active' : 'idle',
    health: { status: 'readable', scope: 'life-state' },
    wake: {
      enabled: wakeEnabled !== false, paused: wake.paused, maxPerDay,
      remainingToday: maxPerDay === null ? null : Math.max(0, maxPerDay - wakeCountToday),
    },
    // No cost meter is connected yet. Zero would claim the life was free.
    budget: { status: 'unavailable' },
    attention,
    nextStep: activity.next && typeof activity.next.what === 'string'
      ? { what: brief(activity.next.what), why: brief(activity.next.why) } : null,
    interests: (Array.isArray(traits?.interests) ? traits.interests : [])
      .filter((item) => item && typeof item.topic === 'string')
      .slice().sort((a, b) => (b.confidence || 0) - (a.confidence || 0)).slice(0, 3)
      .map((item) => ({ topic: brief(item.topic, 80), confidence: Number.isFinite(item.confidence) ? Math.max(0, Math.min(1, item.confidence)) : null })),
    recentEvents: events.reverse().sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, MAX_RECENT_EVENTS),
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
  try { installOwnerLifeUi(root, store) } catch {}
  try {
    root.inject(['webServer'], (ctx) => {
      try {
        if (!ctx || !ctx.webServer || typeof ctx.webServer.register !== 'function') return
        ctx.webServer.register({
          kind: 'exact', path: LIFE_AVATAR_PATH,
          handler: (req, res) => {
            if (req.method !== 'GET' && req.method !== 'HEAD') {
              res.writeHead(405, { allow: 'GET, HEAD' }); res.end(); return
            }
            try {
              const bytes = fs.readFileSync(new URL('../client/assets/whale-placeholder.png', import.meta.url))
              res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' })
              res.end(req.method === 'HEAD' ? undefined : bytes)
            } catch (err) {
              res.writeHead(404); res.end()
            }
          },
        })
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
