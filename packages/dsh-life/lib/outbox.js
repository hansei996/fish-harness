/**
 * Publish outbox for dsh-life — the state machine, pure logic, no IO.
 *
 * PLAN.md §7.3 fixes the state flow and the reconciliation rules:
 *
 *   draft → checked → approved → sending → confirmed | unconfirmed | failed
 *
 * Three properties are deliberately structural rather than documented advice:
 *
 *   1. **A receipt is not a promise.** After `sending`, anything short of a
 *      platform id means `unconfirmed`. There is no automatic retry path from
 *      `unconfirmed`: only an explicit `reconcile()` (or a human
 *      `confirmManually()`) can move it. A timeout after the content actually
 *      landed is exactly the case that would otherwise double-post.
 *   2. **Approval is bound, not remembered.** `approval` stores the content
 *      version, channel and account it approved, plus an optional expiry.
 *      Editing the text changes the version, so the old approval is dropped and
 *      the record falls back to `checked` — the keeper's "yes" is for exact
 *      bytes, not for the idea.
 *   3. **Labelling is a gate.** `markConfirmed()` re-derives the label and runs
 *      `assertLabeled()` before the state may become `confirmed`. A transport
 *      receipt alone cannot mark something published.
 *
 * The module calls no network, filesystem or clock API of its own: callers pass
 * `now`, a persistence callback and an injected transport. That is what makes
 * the decision gate (send succeeded but receipt lost) testable without a real
 * platform.
 */

import { createHash } from 'node:crypto'
import { assertLabeled, labelContent } from './compliance.js'

/** The complete state vocabulary. No other state is valid on disk. */
export const OUTBOX_STATES = Object.freeze([
  'draft',
  'checked',
  'approved',
  'sending',
  'confirmed',
  'unconfirmed',
  'failed',
])

/** States from which no automatic action may happen. */
export const SETTLED_STATES = Object.freeze(['confirmed', 'failed'])

/** Default retention bound for outbox.json. */
export const DEFAULT_OUTBOX_LIMIT = 200

const MAX_ATTEMPTS = 20
const MAX_RECONCILE_ENTRIES = 20

/**
 * Idempotency keys with a send in flight in this process.
 *
 * The outbox file can only tell us what was durable; two sendAttempt calls can
 * both read the same `approved` record before either writes `sending`. This
 * set is the in-process guard that makes the second call fail loudly instead of
 * posting twice.
 *
 * ## What actually prevents a second post across processes
 *
 * This used to claim "the durable `sending` record plus the platform
 * idempotency key". The second half of that was not true, and it is worth
 * spelling out what is, because the difference decides how much damage an
 * `unconfirmed` row can do:
 *
 *   1. **The re-read after approval** (`index.js` `publishNow`): the approval
 *      wait is the real window — a keeper may take a minute to answer, and
 *      another process can move the record meanwhile. After the answer, the
 *      record is re-read and its status and content version are both compared.
 *      A record that left `checked`, or whose bytes changed, is refused. This
 *      is the load-bearing check; both halves were verified against a second
 *      writer in this same window.
 *   2. **`inFlightSends`** — in-process only. It cannot see another process.
 *   3. **There is no platform idempotency key for Telegram.** `sendMessage`
 *      takes no such parameter (Bot API docs), `telegram.js` accordingly sends
 *      only `chat_id`/`text`/`disable_web_page_preview`, and its `query()`
 *      returns `null` because the API cannot look a message up by key either.
 *
 * So for a Telegram channel the honest statement is: **a concurrent duplicate
 * is prevented by application logic alone, and once a send is `unconfirmed`
 * there is no way to ask the platform whether it landed.** That is exactly why
 * `unconfirmed` has no automatic retry path — the human/reconcile step is the
 * only exit, and it exists because the platform offers no better one.
 *
 * A transport that *does* support an idempotency key can honour it; the
 * candidate already carries `idempotencyKey` for that purpose. Telegram is not
 * such a transport, and the adapter says so instead of pretending.
 */
const inFlightSends = new Set()

/**
 * Content version: a short digest of the exact text. `contentVersion` is what
 * approvals bind to, so one changed character invalidates them.
 */
export function contentVersionOf (text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex').slice(0, 16)
}

/**
 * Idempotency key shared with the platform when it supports one. It contains
 * the approved content version, so a retry of the *same* bytes has the same key
 * while a changed draft cannot be mistaken for the same post.
 */
export function idempotencyKeyOf ({ contentId, contentVersion, channel, account } = {}) {
  const parts = [contentId, contentVersion, channel, account].map((part) => {
    if (typeof part !== 'string' || !part.trim()) throw new Error('life/publish-idempotency-key-incomplete')
    return part.trim()
  })
  return parts.join('|')
}

/** Create a draft record. Does not label yet — `markChecked()` does that. */
export function createDraft ({
  contentId,
  text,
  evidence = [],
  channel,
  account,
  labelOptions = {},
  now = Date.now(),
} = {}) {
  if (typeof contentId !== 'string' || !contentId.trim()) throw new Error('life/publish-content-id-required')
  if (typeof text !== 'string' || !text.trim()) throw new Error('life/publish-text-required')
  if (typeof channel !== 'string' || !channel.trim()) throw new Error('life/publish-channel-required')
  if (typeof account !== 'string' || !account.trim()) throw new Error('life/publish-account-required')
  const at = isoOf(now)
  const record = {
    // `id` and `contentId` are the same value on purpose: 标识办法 §5 requires
    // one stable content number, so there is no second id to drift from it.
    id: contentId.trim(),
    contentId: contentId.trim(),
    text,
    contentVersion: contentVersionOf(text),
    evidence: Array.isArray(evidence) ? evidence.filter((item) => typeof item === 'string' && item.trim()) : [],
    channel: channel.trim(),
    account: account.trim(),
    status: 'draft',
    labeledText: null,
    metadata: null,
    labelOptions: normalizeLabelOptions(labelOptions),
    approval: null,
    idempotencyKey: idempotencyKeyOf({
      contentId,
      contentVersion: contentVersionOf(text),
      channel,
      account,
    }),
    platformId: null,
    lastError: null,
    attempts: [],
    reconcile: [],
    createdAt: at,
    updatedAt: at,
    timeline: [{ at, from: null, to: 'draft', reason: 'created' }],
  }
  return record
}

/**
 * Label the content and move `draft`/`checked` to `checked`.
 *
 * Relabelling is idempotent, so queueing twice is safe. `contentVersion` is
 * recomputed from the labelled text, which is what approval binds to.
 */
export function markChecked (record, { now = Date.now(), labelOptions } = {}) {
  assertRecord(record)
  if (record.status !== 'draft' && record.status !== 'checked') {
    throw new Error(`life/publish-invalid-state: checked-from-${record.status}`)
  }
  const at = isoOf(now)
  const derived = deriveLabel(record, labelOptions)
  const reason = record.status === 'checked' ? 're-checked' : 'label-checked'
  return withTransition(record, 'checked', at, reason, {
    labeledText: derived.labeled.text,
    metadata: derived.labeled.metadata,
    contentVersion: derived.contentVersion,
    labelOptions: derived.labelOptions,
  })
}

/**
 * Record a keeper approval bound to the current content/channel/account.
 *
 * This is intentionally a pure state-machine function: this round has no
 * approval seam, so no tool calls it. The next round wires dsh's `approval` and
 * passes the real decision here. It can never be reached *from* `draft` without
 * passing `checked`, and it binds the exact `contentVersion`.
 */
export function approve (record, {
  approvedBy = 'keeper',
  expiresAt = null,
  now = Date.now(),
  labelOptions,
} = {}) {
  assertRecord(record)
  if (record.status !== 'checked' && record.status !== 'approved') {
    throw new Error(`life/publish-invalid-state: approved-from-${record.status}`)
  }
  const at = isoOf(now)
  const derived = deriveLabel(record, labelOptions)
  let expiry = null
  if (expiresAt !== null && expiresAt !== undefined) {
    const parsed = Date.parse(expiresAt)
    if (!Number.isFinite(parsed)) throw new Error('life/publish-invalid-expires-at')
    if (parsed <= Date.parse(at)) throw new Error('life/publish-approval-expired')
    expiry = new Date(parsed).toISOString()
  }
  const approval = {
    contentVersion: derived.contentVersion,
    channel: record.channel,
    account: record.account,
    approvedBy: typeof approvedBy === 'string' && approvedBy.trim() ? approvedBy.trim() : 'keeper',
    approvedAt: at,
    expiresAt: expiry,
  }
  return withTransition(record, 'approved', at, 'approved', {
    labeledText: derived.labeled.text,
    metadata: derived.labeled.metadata,
    contentVersion: derived.contentVersion,
    labelOptions: derived.labelOptions,
    approval,
  })
}

/**
 * Re-derive the label from the current text and check the stored approval.
 *
 * Returns `{ ok, record, reason }`. On any mismatch it returns a record that has
 * fallen back to `checked` with `approval: null`; callers persist that so a
 * stale "yes" cannot survive in memory only.
 */
export function revalidate (record, { now = Date.now(), labelOptions } = {}) {
  assertRecord(record)
  const at = isoOf(now)
  if (record.status === 'confirmed') return { ok: false, reason: 'already-confirmed', record }
  if (record.status === 'sending') return { ok: false, reason: 'already-sending', record }
  if (record.status === 'unconfirmed') return { ok: false, reason: 'unconfirmed-needs-reconcile', record }
  if (record.status !== 'approved') return { ok: false, reason: 'not-approved', record }
  if (!record.approval) return { ok: false, reason: 'missing-approval', record: invalidate(record, at, 'missing-approval') }

  let derived
  try {
    derived = deriveLabel(record, labelOptions)
  } catch (err) {
    return { ok: false, reason: 'label-invalid', record: invalidate(record, at, 'label-invalid') }
  }

  const approval = record.approval
  if (derived.contentVersion !== approval.contentVersion) {
    return { ok: false, reason: 'content-changed', record: invalidate(record, at, 'content-changed', derived) }
  }
  if (approval.channel !== record.channel || approval.account !== record.account) {
    return { ok: false, reason: 'binding-changed', record: invalidate(record, at, 'binding-changed', derived) }
  }
  const expires = approval.expiresAt ? Date.parse(approval.expiresAt) : null
  if (expires !== null && Number.isFinite(expires) && expires <= Date.parse(at)) {
    return { ok: false, reason: 'approval-expired', record: invalidate(record, at, 'approval-expired', derived) }
  }

  // Refresh the stored label view so a later status read shows exactly the
  // bytes the approval covers.
  return {
    ok: true,
    reason: null,
    record: {
      ...record,
      labeledText: derived.labeled.text,
      metadata: derived.labeled.metadata,
      contentVersion: derived.contentVersion,
      labelOptions: derived.labelOptions,
      updatedAt: at,
    },
  }
}

/**
 * Enter `sending`. Throws with a machine-readable `reason` when the record is
 * not allowed to send. The caller must persist the returned record *before*
 * touching the transport: a crash between the two then reads as "possibly
 * sent", not "never sent".
 */
export function beginSend (record, { now = Date.now(), labelOptions } = {}) {
  assertRecord(record)
  const at = isoOf(now)
  const check = revalidate(record, { now, labelOptions })
  if (!check.ok) {
    const error = new Error(`life/publish-not-approved: ${check.reason}`)
    error.code = 'life/publish-not-approved'
    error.reason = check.reason
    error.record = check.record
    throw error
  }
  return withTransition(check.record, 'sending', at, 'send-started', {
    sendStartedAt: at,
    lastError: null,
    attempts: appendBounded(record.attempts, { at, outcome: 'started' }),
  })
}

/**
 * Mark `confirmed` — only with a platform id and only after the label gate.
 *
 * `markConfirmed` is reachable from `sending` (transport receipt or reconcile)
 * and from `unconfirmed` (explicit reconcile / human confirmation). That is the
 * only way out of the uncertainty.
 */
export function markConfirmed (record, {
  platformId,
  receipt = null,
  now = Date.now(),
  reason = 'receipt',
  labelOptions,
} = {}) {
  assertRecord(record)
  if (record.status === 'confirmed' && record.platformId === platformId) return record
  if (record.status !== 'sending' && record.status !== 'unconfirmed') {
    throw new Error(`life/publish-invalid-state: confirmed-from-${record.status}`)
  }
  if (typeof platformId !== 'string' || !platformId.trim()) {
    throw new Error('life/publish-platform-id-required')
  }
  const at = isoOf(now)
  const derived = deriveLabel(record, labelOptions)
  // The hard compliance gate: a receipt does not excuse a missing label.
  assertLabeled({ text: derived.labeled.text, metadata: derived.labeled.metadata })
  return withTransition(record, 'confirmed', at, reason, {
    labeledText: derived.labeled.text,
    metadata: derived.labeled.metadata,
    contentVersion: derived.contentVersion,
    labelOptions: derived.labelOptions,
    platformId: platformId.trim(),
    receiptAt: at,
    receipt,
    lastError: null,
    attempts: appendBounded(record.attempts, { at, outcome: 'confirmed', platformId: platformId.trim() }),
  })
}

/**
 * The only safe exit from `sending`: no receipt, timeout, an exception, or an
 * unreadable response. Never call send again from this state.
 */
export function markUnconfirmed (record, { error = 'unknown', receipt = null, now = Date.now() } = {}) {
  assertRecord(record)
  if (record.status === 'unconfirmed') return record
  if (record.status !== 'sending') {
    throw new Error(`life/publish-invalid-state: unconfirmed-from-${record.status}`)
  }
  const at = isoOf(now)
  return withTransition(record, 'unconfirmed', at, 'send-outcome-unknown', {
    lastError: typeof error === 'string' ? error : String(error && error.message ? error.message : error),
    receipt,
    // Deliberately keep platformId null: guessing it here would turn an
    // unknown outcome into a fake receipt.
    platformId: null,
    attempts: appendBounded(record.attempts, { at, outcome: 'unconfirmed' }),
  })
}

/**
 * `failed` is reserved for a definitive, provable failure (pre-flight failure or
 * a platform rejection that explicitly says nothing was published). It is never
 * used for an ambiguous send, because that is what `unconfirmed` is for.
 */
export function markFailed (record, { error = 'failed', now = Date.now(), reason = 'definitive-failure' } = {}) {
  assertRecord(record)
  if (record.status === 'confirmed') throw new Error('life/publish-invalid-state: failed-from-confirmed')
  const at = isoOf(now)
  return withTransition(record, 'failed', at, reason, {
    lastError: typeof error === 'string' ? error : String(error && error.message ? error.message : error),
  })
}

/**
 * Record one approval attempt without changing the publish state.
 *
 * dsh approvals have four outcomes (`allowed-once`, `rejected`, `cancelled`,
 * `unavailable`) and their audit events are per tool call, not per content; the
 * publish record therefore keeps its own trace. Only `allowed-once` may be
 * followed by a send, so every other outcome ends here.
 */
export function noteApproval (record, { outcome, reason = null, now = Date.now() } = {}) {
  assertRecord(record)
  const at = isoOf(now)
  const entry = {
    at,
    outcome: String(outcome || 'unknown'),
    reason: typeof reason === 'string' && reason ? reason.slice(0, 160) : null,
  }
  return {
    ...record,
    lastApproval: entry,
    updatedAt: at,
    timeline: [
      ...(Array.isArray(record.timeline) ? record.timeline : []),
      { at, from: record.status, to: record.status, reason: `approval:${entry.outcome}` },
    ],
  }
}

/** Add a reconcile attempt to the record without changing its state. */
export function noteReconcile (record, { outcome, platformId = null, error = null, now = Date.now() } = {}) {
  assertRecord(record)
  const at = isoOf(now)
  const entry = { at, outcome, platformId: platformId || null, error: error ? String(error) : null }
  return {
    ...record,
    reconcile: appendBounded(record.reconcile, entry, MAX_RECONCILE_ENTRIES),
    updatedAt: at,
    timeline: [
      ...(Array.isArray(record.timeline) ? record.timeline : []),
      { at, from: record.status, to: record.status, reason: `reconcile:${outcome}` },
    ],
  }
}

/**
 * One explicit reconciliation attempt for an `unconfirmed` record.
 *
 * Outcomes:
 *   - `confirmed`      — platform id found; record moves to confirmed.
 *   - `retry-allowed`  — the platform says it is not there; only now may the
 *                        record go back to `approved` (or `checked` if the old
 *                        approval can no longer be trusted). A reconcile entry
 *                        is recorded either way.
 *   - `still-unconfirmed` — unanswered/unknown; stay put, ask a human.
 *   - `query-unsupported` — no transport or no query capability.
 */
export async function reconcile (record, {
  transport = null,
  now = Date.now(),
  persist = null,
  labelOptions,
} = {}) {
  assertRecord(record)
  if (record.status !== 'unconfirmed') {
    return { ok: false, outcome: 'invalid-state', record, message: `状态是 ${record.status}，不需要对账` }
  }
  const at = isoOf(now)
  const candidate = candidateOf(record)

  if (!transport || typeof transport.query !== 'function') {
    const noted = noteReconcile(record, { outcome: 'query-unsupported', now: at })
    if (persist) await persist(noted)
    return { ok: false, outcome: 'query-unsupported', record: noted, message: '未配置渠道，无法查询平台；保持 unconfirmed，需要人来确认' }
  }

  let result
  try {
    result = await transport.query(candidate)
  } catch (err) {
    const noted = noteReconcile(record, { outcome: 'query-failed', error: messageOf(err), now: at })
    if (persist) await persist(noted)
    return { ok: false, outcome: 'query-failed', record: noted, message: messageOf(err) }
  }

  const platformId = result && typeof result === 'object' && typeof result.platformId === 'string'
    ? result.platformId.trim()
    : ''
  if (platformId) {
    const confirmed = markConfirmed(record, {
      platformId,
      receipt: result,
      now: at,
      reason: 'reconcile-found',
      labelOptions,
    })
    if (persist) await persist(confirmed)
    return { ok: true, outcome: 'confirmed', record: confirmed }
  }

  if (result && typeof result === 'object' && result.found === false) {
    // Only an explicit "not on the platform" allows a retry.
    const derived = deriveLabel(record, labelOptions)
    const approval = record.approval
    const stillValid = approval &&
      approval.contentVersion === derived.contentVersion &&
      approval.channel === record.channel &&
      approval.account === record.account &&
      !isExpired(approval, at)
    const nextStatus = stillValid ? 'approved' : 'checked'
    const next = withTransition(record, nextStatus, at, 'reconcile-not-published', {
      labeledText: derived.labeled.text,
      metadata: derived.labeled.metadata,
      contentVersion: derived.contentVersion,
      labelOptions: derived.labelOptions,
      approval: stillValid ? approval : null,
      reconcile: appendBounded(record.reconcile, { at, outcome: 'not-published', platformId: null, error: null }, MAX_RECONCILE_ENTRIES),
    })
    if (persist) await persist(next)
    return { ok: true, outcome: 'retry-allowed', record: next }
  }

  const noted = noteReconcile(record, { outcome: 'query-unknown', now: at })
  if (persist) await persist(noted)
  return { ok: false, outcome: 'still-unconfirmed', record: noted, message: '查询没有明确结论，保持 unconfirmed' }
}

/**
 * A human explicitly confirms delivery. The label gate still applies: a manual
 * "yes" cannot publish unlabelled content.
 */
export function confirmManually (record, {
  platformId,
  confirmedBy = 'keeper',
  now = Date.now(),
  labelOptions,
} = {}) {
  assertRecord(record)
  if (record.status !== 'unconfirmed') {
    throw new Error(`life/publish-invalid-state: manual-confirm-from-${record.status}`)
  }
  const confirmed = markConfirmed(record, {
    platformId,
    receipt: { manual: true, confirmedBy },
    now,
    reason: 'manual-confirmation',
    labelOptions,
  })
  return { ...confirmed, confirmedBy }
}

/**
 * Attempt one send. Persists `sending` *before* calling the transport, then
 * either `confirmed` (with a platform id) or `unconfirmed` (everything else).
 *
 * Returns `{ ok, outcome, record, transportCalled, error }`. It never throws for
 * an ambiguous send and never retries by itself.
 */
export async function sendAttempt (record, options = {}) {
  assertRecord(record)
  const key = record.idempotencyKey || record.contentId
  if (inFlightSends.has(key)) {
    return {
      ok: false,
      outcome: 'rejected',
      reason: 'send-in-flight',
      record,
      transportCalled: false,
      error: '同一幂等键已有一次发送在进行；并发第二次发送被拒绝',
    }
  }
  inFlightSends.add(key)
  try {
    return await runSendAttempt(record, options)
  } finally {
    inFlightSends.delete(key)
  }
}

async function runSendAttempt (record, {
  transport = null,
  now = Date.now(),
  persist = null,
  labelOptions,
} = {}) {
  if (!transport || typeof transport.send !== 'function') {
    return { ok: false, outcome: 'no-transport', record, transportCalled: false, error: '未配置渠道' }
  }

  let prepared
  try {
    prepared = beginSend(record, { now, labelOptions })
  } catch (err) {
    if (err.record && persist) await persist(err.record)
    return {
      ok: false,
      outcome: 'rejected',
      reason: err.reason || 'not-approved',
      record: err.record || record,
      transportCalled: false,
      error: messageOf(err),
    }
  }

  // The durable "maybe sent" marker must exist before the side effect.
  if (persist) await persist(prepared)

  try {
    const receipt = await transport.send(candidateOf(prepared))
    if (!receipt || typeof receipt !== 'object' ||
        typeof receipt.platformId !== 'string' || !receipt.platformId.trim()) {
      throw new Error('life/publish-missing-receipt')
    }
    const confirmed = markConfirmed(prepared, {
      platformId: receipt.platformId,
      receipt,
      now,
      reason: 'transport-receipt',
      labelOptions,
    })
    if (persist) await persist(confirmed)
    return { ok: true, outcome: 'confirmed', record: confirmed, transportCalled: true, receipt }
  } catch (err) {
    const unconfirmed = markUnconfirmed(prepared, { error: messageOf(err), now })
    if (persist) await persist(unconfirmed)
    return {
      ok: false,
      outcome: 'unconfirmed',
      record: unconfirmed,
      transportCalled: true,
      error: messageOf(err),
    }
  }
}

/** The stable payload a transport receives (and a query echoes back). */
export function candidateOf (record) {
  assertRecord(record)
  return {
    contentId: record.contentId,
    contentVersion: record.contentVersion,
    idempotencyKey: record.idempotencyKey,
    channel: record.channel,
    account: record.account,
    text: record.labeledText,
    metadata: record.metadata,
    evidence: Array.isArray(record.evidence) ? record.evidence.slice() : [],
  }
}

/**
 * Insert or replace one outbox item, enforcing "one record per idempotency
 * key". If a *different* record already owns the key, the existing one wins and
 * `duplicate: true` is reported: the caller must not create a second post.
 */
export function upsertOutboxItem (items, record, { max = DEFAULT_OUTBOX_LIMIT } = {}) {
  const list = normalizeOutboxItems(items)
  const byId = list.findIndex((item) => item.contentId === record.contentId)
  if (byId >= 0) {
    const next = list.slice()
    next[byId] = record
    const pruned = pruneOutboxWithStats(next, max)
    return { items: pruned.items, record, duplicate: false, dropped: pruned.dropped }
  }
  const byKey = list.find((item) => item.idempotencyKey === record.idempotencyKey)
  if (byKey) {
    return { items: list, record: byKey, duplicate: true, dropped: { proposed: 0, settled: 0 } }
  }
  const pruned = pruneOutboxWithStats([...list, record], max)
  return { items: pruned.items, record, duplicate: false, dropped: pruned.dropped }
}

/**
 * Status classes used by retention.
 *
 * `committed` records describe an external side effect that may already have
 * happened (`approved` is a pending "yes" for exact bytes; `sending` may be in
 * flight; `unconfirmed` may have landed). None of them may ever be pruned —
 * losing an `unconfirmed` row would delete the very evidence reconciliation
 * depends on. `proposed` rows are only suggestions the model can recreate, and
 * `settled` rows are history, so both are expendable.
 */
export const COMMITTED_STATES = Object.freeze(['approved', 'sending', 'unconfirmed'])
export const PROPOSED_STATES = Object.freeze(['draft', 'checked'])

/**
 * Apply the retention budget and report what was dropped.
 *
 * `max` is the budget for **proposed + settled** rows, not a hard file limit:
 * committed rows do not consume it, so the file may legitimately exceed `max`
 * when many approvals are waiting or a crash left uncertain sends. The newest
 * proposed rows are kept first (dropping oldest drafts is the least harmful
 * loss), then settled rows use whatever budget is left, newest first.
 *
 * @returns {{items: Array, dropped: {proposed: number, settled: number}, budget: number, committed: number}}
 */
export function pruneOutboxWithStats (items, max = DEFAULT_OUTBOX_LIMIT) {
  const list = Array.isArray(items) ? items.filter(Boolean) : []
  const budget = Number.isInteger(max) && max > 0 ? max : DEFAULT_OUTBOX_LIMIT
  const committed = list.filter((item) => COMMITTED_STATES.includes(item.status))
  const proposed = list
    .filter((item) => !COMMITTED_STATES.includes(item.status) && !SETTLED_STATES.includes(item.status))
    .slice()
    .sort((a, b) => Date.parse(a.createdAt || 0) - Date.parse(b.createdAt || 0))
  const settled = list
    .filter((item) => SETTLED_STATES.includes(item.status))
    .slice()
    .sort((a, b) => Date.parse(a.createdAt || 0) - Date.parse(b.createdAt || 0))

  const keptProposed = proposed.slice(Math.max(0, proposed.length - budget))
  const keptSettled = settled.slice(Math.max(0, settled.length - Math.max(0, budget - keptProposed.length)))
  const items2 = [...committed, ...keptProposed, ...keptSettled]
    .sort((a, b) => Date.parse(a.createdAt || 0) - Date.parse(b.createdAt || 0))
  return {
    items: items2,
    dropped: {
      proposed: proposed.length - keptProposed.length,
      settled: settled.length - keptSettled.length,
    },
    budget,
    committed: committed.length,
  }
}

/**
 * Backwards-compatible array form. Callers that need the drop counts use
 * {@link pruneOutboxWithStats}; this wrapper exists so persistence code and
 * older tests keep a plain array contract.
 */
export function pruneOutboxItems (items, max = DEFAULT_OUTBOX_LIMIT) {
  return pruneOutboxWithStats(items, max).items
}

/**
 * Read-side recovery. A `sending` record means "the process may have sent it
 * and died before writing the outcome". On load it becomes `unconfirmed`, which
 * has no automatic retry path; the only way forward is reconcile/human.
 */
export function normalizeOutboxItems (items, { now = Date.now() } = {}) {
  const at = isoOf(now)
  const list = Array.isArray(items) ? items : []
  const out = []
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue
    if (typeof raw.contentId !== 'string' || !raw.contentId.trim()) continue
    const status = OUTBOX_STATES.includes(raw.status) ? raw.status : 'failed'
    const item = {
      ...raw,
      id: typeof raw.id === 'string' && raw.id ? raw.id : raw.contentId,
      status,
      evidence: Array.isArray(raw.evidence) ? raw.evidence.filter((entry) => typeof entry === 'string') : [],
      attempts: Array.isArray(raw.attempts) ? raw.attempts : [],
      reconcile: Array.isArray(raw.reconcile) ? raw.reconcile : [],
      timeline: Array.isArray(raw.timeline) ? raw.timeline : [],
    }
    if (status === 'sending') {
      item.status = 'unconfirmed'
      item.lastError = 'recovered-from-sending'
      item.updatedAt = at
      item.timeline = [...item.timeline, { at, from: 'sending', to: 'unconfirmed', reason: 'recovered-after-reload' }]
    }
    out.push(item)
  }
  return out
}

/** Counts per state, for the status tool / UI. */
export function outboxCounts (items) {
  const counts = Object.fromEntries(OUTBOX_STATES.map((state) => [state, 0]))
  for (const item of Array.isArray(items) ? items : []) {
    if (item && Object.prototype.hasOwnProperty.call(counts, item.status)) counts[item.status] += 1
  }
  return counts
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function assertRecord (record) {
  if (!record || typeof record !== 'object' || typeof record.contentId !== 'string') {
    throw new Error('life/publish-record-required')
  }
}

function deriveLabel (record, labelOptions) {
  const options = mergeLabelOptions(record, labelOptions)
  const labeled = labelContent({
    text: record.text,
    identityName: options.identityName,
    contentId: record.contentId,
    providerCode: options.providerCode,
    mediaType: options.mediaType,
    template: options.template,
  })
  // A draft whose text is empty or whose label cannot be produced must never
  // reach checked/approved, so the derivation itself runs the gate.
  assertLabeled(labeled)
  return { labeled, contentVersion: contentVersionOf(labeled.text), labelOptions: options }
}

function normalizeLabelOptions (options) {
  const value = options && typeof options === 'object' ? options : {}
  const out = {}
  if (typeof value.identityName === 'string' && value.identityName.trim()) out.identityName = value.identityName.trim()
  if (typeof value.providerCode === 'string' && value.providerCode.trim()) out.providerCode = value.providerCode.trim()
  if (value.mediaType === 'text' || value.mediaType === 'file') out.mediaType = value.mediaType
  if (typeof value.template === 'string' && value.template.trim()) out.template = value.template
  return out
}

function mergeLabelOptions (record, override) {
  const stored = record.labelOptions && typeof record.labelOptions === 'object' ? record.labelOptions : {}
  const next = { ...stored, ...(override && typeof override === 'object' ? override : {}) }
  const options = normalizeLabelOptions(next)
  if (!options.providerCode) options.providerCode = 'dsh-life'
  if (!options.mediaType) options.mediaType = 'text'
  return options
}

function invalidate (record, at, reason, derived = null) {
  return {
    ...record,
    status: 'checked',
    approval: null,
    ...(derived
      ? {
          labeledText: derived.labeled.text,
          metadata: derived.labeled.metadata,
          contentVersion: derived.contentVersion,
          labelOptions: derived.labelOptions,
        }
      : {}),
    updatedAt: at,
    timeline: [
      ...(Array.isArray(record.timeline) ? record.timeline : []),
      { at, from: record.status, to: 'checked', reason: `approval-invalidated:${reason}` },
    ],
  }
}

function withTransition (record, to, at, reason, extra = {}) {
  return {
    ...record,
    ...extra,
    status: to,
    updatedAt: at,
    timeline: [
      ...(Array.isArray(record.timeline) ? record.timeline : []),
      { at, from: record.status, to, reason },
    ],
  }
}

function appendBounded (list, entry, max = MAX_ATTEMPTS) {
  const next = [...(Array.isArray(list) ? list : []), entry]
  return next.slice(-max)
}

function isExpired (approval, atIso) {
  if (!approval || !approval.expiresAt) return false
  const expires = Date.parse(approval.expiresAt)
  return Number.isFinite(expires) && expires <= Date.parse(atIso)
}

function isoOf (now) {
  if (now instanceof Date) {
    return Number.isNaN(now.getTime()) ? new Date().toISOString() : now.toISOString()
  }
  const date = new Date(now)
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString()
}

function messageOf (err) {
  return (err && err.message) || String(err)
}
