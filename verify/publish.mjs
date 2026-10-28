/**
 * Independent verification of the publish line — the first dsh-life feature
 * with an external side effect.
 *
 * The question is not "can it send": it is "when the answer is anything other
 * than a proven yes, does it send zero times". Every check below is designed to
 * fail loudly on that side of the line:
 *
 *   - the outbox state machine never auto-retries an ambiguous send;
 *   - the explicit AI label is a hard gate, even when a receipt exists;
 *   - approval is requested through a fake seam and only `allowed-once` may
 *     proceed; the content is re-read after approval (TOCTOU);
 *   - the Telegram adapter uses an injected fetch only — this process refuses
 *     every real network call.
 *
 * No dsh process is booted and no network is touched. Run:
 *   node verify/publish.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PLUGIN = path.join(REPO, 'packages', 'dsh-life')
// 带随机后缀，否则与并发的另一份 verify 互删目录（见 verify/smoke.mjs 同处的说明）。
const HOME = process.env.PUBLISH_DSH_HOME || fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-life-publish-'))
process.env.DSH_HOME = HOME
fs.rmSync(HOME, { recursive: true, force: true })
fs.mkdirSync(HOME, { recursive: true })

/** 源码里定义了多少个 life_* 工具 —— 判据是「注册的 == 定义的」，不是一个写死的数。 */
function declaredToolCount () {
  const src = fs.readFileSync(path.join(REPO, 'packages', 'dsh-life', 'lib', 'index.js'), 'utf8')
  return [...src.matchAll(/name: '(life_[a-z_]+)'/g)].length
}

const results = []
const check = (label, ok, detail = '') => {
  results.push({ label, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

// The verification process itself must never reach the network. Any accidental
// real fetch lands here and fails the run (and is counted for D5).
let realFetchCalls = 0
globalThis.fetch = () => {
  realFetchCalls += 1
  throw new Error('life/publish-verify-network-forbidden: this suite must not touch the network')
}

const outbox = await import(pathToFileURL(path.join(PLUGIN, 'lib', 'outbox.js')).href)
const compliance = await import(pathToFileURL(path.join(PLUGIN, 'lib', 'compliance.js')).href)
const telegram = await import(pathToFileURL(path.join(PLUGIN, 'lib', 'telegram.js')).href)
const plugin = await import(pathToFileURL(path.join(PLUGIN, 'lib', 'index.js')).href)
const { LifeStore } = await import(pathToFileURL(path.join(PLUGIN, 'lib', 'store.js')).href)

const NOW = Date.parse('2026-10-28T00:00:00.000Z')
const iso = (value) => new Date(value).toISOString()
const messageOf = (err) => (err && err.message) || String(err)
function attempt (fn) {
  try {
    return { threw: false, value: fn() }
  } catch (err) {
    return { threw: true, error: err, message: messageOf(err) }
  }
}
async function attemptAsync (fn) {
  try {
    return { threw: false, value: await fn() }
  } catch (err) {
    return { threw: true, error: err, message: messageOf(err) }
  }
}

// ---------------------------------------------------------------------------
// A. Outbox state machine
// ---------------------------------------------------------------------------
const draft = (contentId = 'c-transition', text = '正文') => outbox.createDraft({
  contentId, text, channel: 'tg', account: 'acct', now: NOW,
})
const checkedRecord = outbox.markChecked(draft(), { now: NOW })
const approvedRecord = outbox.approve(checkedRecord, { now: NOW })
const sendingRecord = outbox.beginSend(approvedRecord, { now: NOW })
const confirmedRecord = outbox.markConfirmed(sendingRecord, { platformId: 'tg:1', now: NOW })
const unconfirmedRecord = outbox.markUnconfirmed(sendingRecord, { error: 'timeout', now: NOW })
const failedRecord = outbox.markFailed(approvedRecord, { error: 'platform said no', now: NOW })
const stateRecords = {
  draft: draft(),
  checked: checkedRecord,
  approved: approvedRecord,
  sending: sendingRecord,
  confirmed: confirmedRecord,
  unconfirmed: unconfirmedRecord,
  failed: failedRecord,
}

// A1a. Provenance of the two states that end an ambiguous send.
const confirmedFrom = Object.entries(stateRecords).map(([status, record]) => ({
  status,
  outcome: attempt(() => outbox.markConfirmed(record, { platformId: 'tg:9', now: NOW })),
}))
const confirmedOnlyFrom = confirmedFrom.filter((row) => !row.outcome.threw).map((row) => row.status)
const unconfirmedFrom = Object.entries(stateRecords).map(([status, record]) => ({
  status,
  outcome: attempt(() => outbox.markUnconfirmed(record, { error: 'x', now: NOW })),
}))
const unconfirmedOnlyFrom = unconfirmedFrom.filter((row) => !row.outcome.threw).map((row) => row.status)
const sameConfirmed = outbox.markConfirmed(confirmedRecord, { platformId: 'tg:1', now: NOW })
const sameUnconfirmed = outbox.markUnconfirmed(unconfirmedRecord, { now: NOW })
check('outbox A1: confirmed only comes from sending/unconfirmed, unconfirmed only from sending, and both are idempotent',
  confirmedOnlyFrom.join(',') === 'sending,unconfirmed' &&
  unconfirmedOnlyFrom.join(',') === 'sending,unconfirmed' &&
  sameConfirmed === confirmedRecord &&
  sameUnconfirmed === unconfirmedRecord &&
  confirmedFrom.find((row) => row.status === 'confirmed').outcome.threw &&
  confirmedFrom.find((row) => row.status === 'draft').outcome.threw &&
  unconfirmedFrom.find((row) => row.status === 'confirmed').outcome.threw,
  `confirmed from=[${confirmedOnlyFrom}], unconfirmed from=[${unconfirmedOnlyFrom}], ` +
  `same-receipt idempotent=${sameConfirmed === confirmedRecord}, same-unconfirmed idempotent=${sameUnconfirmed === unconfirmedRecord}`)

// A1b. The rest of the transition matrix: label, approve, begin send, fail.
const checkedFrom = Object.entries(stateRecords).map(([status, record]) => ({
  status,
  ok: !attempt(() => outbox.markChecked(record, { now: NOW })).threw,
}))
const approvedFrom = Object.entries(stateRecords).map(([status, record]) => ({
  status,
  ok: !attempt(() => outbox.approve(record, { now: NOW })).threw,
}))
const beginFrom = Object.entries(stateRecords).map(([status, record]) => {
  const outcome = attempt(() => outbox.beginSend(record, { now: NOW }))
  return {
    status,
    ok: !outcome.threw,
    reason: outcome.threw ? outcome.error.reason || outcome.message : null,
  }
})
const failedFrom = Object.entries(stateRecords).map(([status, record]) => ({
  status,
  ok: !attempt(() => outbox.markFailed(record, { error: 'x', now: NOW })).threw,
}))
const beginReasons = Object.fromEntries(beginFrom.map((row) => [row.status, row.reason]))
check('outbox A1b: checked/approved/beginSend/markFailed obey the documented matrix',
  checkedFrom.filter((row) => row.ok).map((row) => row.status).join(',') === 'draft,checked' &&
  approvedFrom.filter((row) => row.ok).map((row) => row.status).join(',') === 'checked,approved' &&
  beginFrom.filter((row) => row.ok).map((row) => row.status).join(',') === 'approved' &&
  beginReasons.unconfirmed === 'unconfirmed-needs-reconcile' &&
  beginReasons.sending === 'already-sending' &&
  beginReasons.confirmed === 'already-confirmed' &&
  failedFrom.filter((row) => !row.ok).map((row) => row.status).join(',') === 'confirmed',
  `checked from=[${checkedFrom.filter((r) => r.ok).map((r) => r.status)}]; ` +
  `approved from=[${approvedFrom.filter((r) => r.ok).map((r) => r.status)}]; ` +
  `beginSend from=[${beginFrom.filter((r) => r.ok).map((r) => r.status)}]; ` +
  `beginSend reasons=${JSON.stringify(beginReasons)}; markFailed refused from=` +
  `[${failedFrom.filter((r) => !r.ok).map((r) => r.status)}]`)

// A2. A durable `sending` record is read back as unconfirmed, and nothing sends
// until an explicit reconcile.
const recoveringStore = new LifeStore({ lifeId: 'outbox-recovery' })
recoveringStore.ensure({})
recoveringStore.writeOutbox({ items: [sendingRecord] }, { max: 200 })
const rawOutboxOnDisk = JSON.parse(fs.readFileSync(recoveringStore.files.outbox, 'utf8'))
const recoveredStore = new LifeStore({ lifeId: 'outbox-recovery' })
const recoveredItems = recoveredStore.readOutbox().items
const recovered = recoveredItems[0]
const recoveryTransport = (() => {
  const calls = { send: 0, query: 0 }
  return {
    calls,
    async send () { calls.send += 1; return { platformId: 'tg:should-not-happen' } },
    async query () { calls.query += 1; return { platformId: 'tg:found-after-reconcile' } },
  }
})()
const resendAttempt = await outbox.sendAttempt(recovered, { transport: recoveryTransport, now: NOW })
const beforeReconcile = { ...recoveryTransport.calls }
const reconcileResult = await outbox.reconcile(recovered, { transport: recoveryTransport, now: NOW })
check('outbox A2: a durable sending record reloads as unconfirmed, never auto-sends, and only an explicit reconcile can resolve it',
  rawOutboxOnDisk.items[0].status === 'sending' &&
  recovered.status === 'unconfirmed' &&
  recovered.lastError === 'recovered-from-sending' &&
  recovered.platformId === null &&
  resendAttempt.outcome === 'rejected' &&
  resendAttempt.reason === 'unconfirmed-needs-reconcile' &&
  beforeReconcile.send === 0 && beforeReconcile.query === 0 &&
  reconcileResult.outcome === 'confirmed' &&
  reconcileResult.record.platformId === 'tg:found-after-reconcile' &&
  recoveryTransport.calls.send === 0 && recoveryTransport.calls.query === 1,
  `on disk=${rawOutboxOnDisk.items[0].status} -> read=${recovered.status}; ` +
  `sendAttempt=${resendAttempt.outcome}/${resendAttempt.reason}; ` +
  `transport before reconcile send/query=${beforeReconcile.send}/${beforeReconcile.query}; ` +
  `reconcile=${reconcileResult.outcome} platformId=${reconcileResult.record.platformId}; ` +
  `transport after send/query=${recoveryTransport.calls.send}/${recoveryTransport.calls.query}`)

// A3. Idempotency keys and duplicate protection.
const keyBase = { contentId: 'c-key', contentVersion: 'v-key', channel: 'tg', account: 'acct' }
const key = outbox.idempotencyKeyOf(keyBase)
const keyVariants = [
  outbox.idempotencyKeyOf({ ...keyBase, contentId: 'c-key-2' }),
  outbox.idempotencyKeyOf({ ...keyBase, contentVersion: 'v-key-2' }),
  outbox.idempotencyKeyOf({ ...keyBase, channel: 'file' }),
  outbox.idempotencyKeyOf({ ...keyBase, account: 'acct-2' }),
]
const keyStore = new LifeStore({ lifeId: 'outbox-keys' })
keyStore.ensure({})
const keyDraft = outbox.createDraft({ ...keyBase, text: '正文', now: NOW })
const firstAppend = keyStore.appendOutboxItem(keyDraft, { max: 200 })
const secondAppend = keyStore.appendOutboxItem(keyDraft, { max: 200 })
const fabricated = { ...keyDraft, contentId: 'c-key-other', id: 'c-key-other' }
const duplicateAppend = keyStore.appendOutboxItem(fabricated, { max: 200 })
check('outbox A3: the same contentId/version/channel/account yields one record; changing any field changes the key',
  keyVariants.every((variant) => variant !== key) &&
  firstAppend.duplicate === false && secondAppend.duplicate === false &&
  keyStore.readOutbox().items.length === 1 &&
  duplicateAppend.duplicate === true &&
  keyStore.findOutboxByIdempotencyKey(firstAppend.record.idempotencyKey)?.contentId === 'c-key',
  `key=${key}; variants differ=${keyVariants.every((v) => v !== key)}; ` +
  `records after three appends=${keyStore.readOutbox().items.length}, duplicate-flag=${duplicateAppend.duplicate}`)

// A4. One changed character changes the version and kills the old approval.
const versionDraft = outbox.createDraft({ contentId: 'c-version', text: '第一版正文', channel: 'tg', account: 'acct', now: NOW })
const versionChecked = outbox.markChecked(versionDraft, { now: NOW })
const versionApproved = outbox.approve(versionChecked, { now: NOW })
const tampered = { ...versionApproved, text: '第一版正文。' }
const tamperedCheck = outbox.revalidate(tampered, { now: NOW })
const unchangedCheck = outbox.revalidate(versionApproved, { now: NOW })
check('outbox A4: a one-character edit changes contentVersion, drops the approval, and revalidate refuses the stale yes',
  outbox.contentVersionOf('第一版正文') !== outbox.contentVersionOf('第一版正文。') &&
  tamperedCheck.ok === false &&
  tamperedCheck.reason === 'content-changed' &&
  tamperedCheck.record.status === 'checked' &&
  tamperedCheck.record.approval === null &&
  unchangedCheck.ok === true,
  `versions ${outbox.contentVersionOf('第一版正文')} vs ${outbox.contentVersionOf('第一版正文。')}; ` +
  `revalidate altered=${tamperedCheck.ok}/${tamperedCheck.reason} -> ${tamperedCheck.record.status}/approval=${tamperedCheck.record.approval}; ` +
  `revalidate unchanged=${unchangedCheck.ok}`)

// A5. Concurrent sends for one key: one transport call, the second is refused.
let releaseSend
const sendGate = new Promise((resolve) => { releaseSend = resolve })
const concurrentCalls = { send: 0 }
const concurrentTransport = {
  async send () {
    concurrentCalls.send += 1
    await sendGate
    return { platformId: 'tg:concurrent' }
  },
  async query () { return null },
}
const concurrentFirst = outbox.sendAttempt(approvedRecord, { transport: concurrentTransport, now: NOW })
await new Promise((resolve) => setTimeout(resolve, 20))
const concurrentSecond = outbox.sendAttempt(approvedRecord, { transport: concurrentTransport, now: NOW })
releaseSend()
const [firstResult, secondResult] = await Promise.all([concurrentFirst, concurrentSecond])
check('outbox A5: a second send for the same key is rejected while the first is in flight, and the transport runs once',
  concurrentCalls.send === 1 &&
  firstResult.outcome === 'confirmed' &&
  secondResult.outcome === 'rejected' &&
  secondResult.reason === 'send-in-flight' &&
  secondResult.transportCalled === false,
  `transport calls=${concurrentCalls.send}; first=${firstResult.outcome}; ` +
  `second=${secondResult.outcome}/${secondResult.reason}, transportCalled=${secondResult.transportCalled}`)

// A6. Retention: committed records are never pruned; proposed/settled share the
// max budget and are dropped oldest-first.
const COMMITTED = ['approved', 'sending', 'unconfirmed']
const PROPOSED = ['draft', 'checked']
const SETTLED = ['confirmed', 'failed']
const retainedRecord = (contentId, status, hours) => ({
  contentId,
  id: contentId,
  status,
  createdAt: iso(NOW - hours * 3600 * 1000),
  updatedAt: iso(NOW - hours * 3600 * 1000),
})
function runPrune (items, max) {
  const result = outbox.pruneOutboxItems(items, max)
  const kept = Array.isArray(result) ? result : (result && Array.isArray(result.items) ? result.items : [])
  const keptIds = new Set(kept.map((item) => item.contentId))
  return { kept, keptIds, dropped: items.filter((item) => !keptIds.has(item.contentId)) }
}
function prunePolicy (items, max) {
  const { kept, keptIds } = runPrune(items, max)
  const newestFirst = (list) => list.slice().sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
  const committed = items.filter((item) => COMMITTED.includes(item.status))
  const proposed = items.filter((item) => PROPOSED.includes(item.status))
  const settled = items.filter((item) => SETTLED.includes(item.status))
  const expectedProposed = newestFirst(proposed).slice(0, Math.min(proposed.length, max))
  const expectedSettled = newestFirst(settled).slice(0, Math.max(0, max - expectedProposed.length))
  const expectedIds = new Set([...committed, ...expectedProposed, ...expectedSettled].map((item) => item.contentId))
  const committedAllKept = committed.every((item) => keptIds.has(item.contentId))
  const droppedIds = items.filter((item) => !keptIds.has(item.contentId)).map((item) => item.contentId)
  const expectedDropped = items.filter((item) => !expectedIds.has(item.contentId)).map((item) => item.contentId)
  const exact = expectedIds.size === keptIds.size && [...expectedIds].every((id) => keptIds.has(id))
  return {
    ok: committedAllKept && exact,
    detail: `max=${max}: committed kept=${committed.filter((i) => keptIds.has(i.contentId)).length}/${committed.length}; ` +
      `kept=${kept.length}; dropped=[${droppedIds.join(',')}] expected=[${expectedDropped.join(',')}]`,
  }
}
const retentionCases = []
{
  const items = [
    retainedRecord('unconfirmed-1', 'unconfirmed', 1),
    ...Array.from({ length: 10 }, (_, index) => retainedRecord(`draft-${index + 1}`, 'draft', 2 + index)),
    retainedRecord('confirmed-1', 'confirmed', 20),
  ]
  retentionCases.push({ name: 'committed + 10 proposed + 1 settled', result: prunePolicy(items, 10) })
}
{
  const items = [
    retainedRecord('approved-1', 'approved', 1),
    retainedRecord('sending-1', 'sending', 2),
    retainedRecord('unconfirmed-1', 'unconfirmed', 3),
    ...Array.from({ length: 5 }, (_, index) => retainedRecord(`checked-${index + 1}`, 'checked', 4 + index)),
    ...Array.from({ length: 5 }, (_, index) => retainedRecord(`confirmed-${index + 1}`, 'confirmed', 10 + index)),
    retainedRecord('failed-1', 'failed', 30),
  ]
  retentionCases.push({ name: '3 committed + 5 proposed + 6 settled', result: prunePolicy(items, 6) })
}
{
  const items = [
    ...Array.from({ length: 8 }, (_, index) => retainedRecord(`draft-${index + 1}`, 'draft', 1 + index)),
    retainedRecord('confirmed-1', 'confirmed', 40),
    retainedRecord('failed-1', 'failed', 41),
  ]
  retentionCases.push({ name: '8 proposed + 2 settled, no committed', result: prunePolicy(items, 5) })
}
{
  const items = [
    retainedRecord('draft-a', 'draft', 1),
    retainedRecord('checked-b', 'checked', 2),
    ...Array.from({ length: 5 }, (_, index) => retainedRecord(`settled-${index + 1}`, 'confirmed', 10 + index)),
  ]
  retentionCases.push({ name: '2 proposed + 5 settled', result: prunePolicy(items, 3) })
}
check('outbox A6: committed (approved/sending/unconfirmed) is never pruned; proposed and settled are dropped oldest-first within the max budget',
  retentionCases.every((entry) => entry.result.ok),
  retentionCases.map((entry) => `${entry.name}: ${entry.result.detail}`).join(' | '))

// A6b. The drop decision is observable: per-class counts and a durable
// lastPruned record, so "my draft disappeared" can be answered without guessing.
{
  const noCommitted = outbox.pruneOutboxWithStats([
    ...Array.from({ length: 8 }, (_, index) => retainedRecord(`draft-${index + 1}`, 'draft', 1 + index)),
    retainedRecord('confirmed-1', 'confirmed', 20),
    retainedRecord('failed-1', 'failed', 21),
  ], 5)
  const withCommitted = outbox.pruneOutboxWithStats([
    retainedRecord('approved-1', 'approved', 1),
    retainedRecord('unconfirmed-1', 'unconfirmed', 2),
    ...Array.from({ length: 8 }, (_, index) => retainedRecord(`checked-${index + 1}`, 'checked', 3 + index)),
    retainedRecord('confirmed-1', 'confirmed', 30),
    retainedRecord('failed-1', 'failed', 31),
  ], 5)
  const pruneStore = new LifeStore({ lifeId: 'outbox-prune-stats' })
  pruneStore.ensure({})
  const written = pruneStore.writeOutbox({
    items: [
      ...Array.from({ length: 8 }, (_, index) => retainedRecord(`w-draft-${index + 1}`, 'draft', 1 + index)),
      retainedRecord('w-confirmed', 'confirmed', 30),
    ],
  }, { max: 5 })
  const rawAfterWrite = JSON.parse(fs.readFileSync(pruneStore.files.outbox, 'utf8'))
  check('outbox A6b: prune stats report dropped proposed/settled counts and the store records lastPruned',
    noCommitted.dropped.proposed === 3 && noCommitted.dropped.settled === 2 &&
    noCommitted.budget === 5 && noCommitted.committed === 0 && noCommitted.items.length === 5 &&
    withCommitted.dropped.proposed === 3 && withCommitted.dropped.settled === 2 &&
    withCommitted.committed === 2 && withCommitted.items.length === 7 &&
    written.dropped.proposed === 3 && written.dropped.settled === 1 &&
    rawAfterWrite.lastPruned && rawAfterWrite.lastPruned.proposed === 3 &&
    rawAfterWrite.lastPruned.settled === 1 && typeof rawAfterWrite.lastPruned.at === 'string',
    `no committed: dropped=${JSON.stringify(noCommitted.dropped)} committed=${noCommitted.committed} kept=${noCommitted.items.length}; ` +
    `with committed: dropped=${JSON.stringify(withCommitted.dropped)} committed=${withCommitted.committed} kept=${withCommitted.items.length}; ` +
    `store returned dropped=${JSON.stringify(written.dropped)} lastPruned=${JSON.stringify(rawAfterWrite.lastPruned)}`)
}

// A7. Corrupt / truncated outbox.json degrades to an empty list instead of throwing.
const corruptStore = new LifeStore({ lifeId: 'outbox-corrupt' })
corruptStore.ensure({})
let corruptRead = null
let corruptThrew = false
try {
  fs.writeFileSync(corruptStore.files.outbox, '{"schemaVersion":1,"items":[{"contentId":"half-')
  corruptRead = corruptStore.readOutbox()
} catch (err) {
  corruptThrew = true
}
let garbageRead = null
let garbageThrew = false
try {
  fs.writeFileSync(corruptStore.files.outbox, JSON.stringify({
    items: [null, 'junk', { contentId: '' }, { contentId: 'kept', status: 'made-up' }],
  }))
  garbageRead = corruptStore.readOutbox()
} catch (err) {
  garbageThrew = true
}
check('outbox A7: a truncated or garbage outbox.json degrades to a safe list without throwing',
  corruptThrew === false && corruptRead && corruptRead.items.length === 0 &&
  garbageThrew === false && garbageRead && garbageRead.items.length === 1 &&
  garbageRead.items[0].status === 'failed',
  `truncated -> items=${corruptRead ? corruptRead.items.length : 'threw'}; ` +
  `garbage -> items=${garbageRead ? garbageRead.items.length : 'threw'} status=${garbageRead?.items[0]?.status}`)

// ---------------------------------------------------------------------------
// B. Mandatory AI-generation label
// ---------------------------------------------------------------------------
const labelled = compliance.labelContent({
  text: '今天把第 38 层打过了，存档在 save:38',
  contentId: 'post-label-1',
  identityName: '大肥鱼',
  providerCode: 'dsh-life',
})
const labelledAgain = compliance.labelContent({ text: labelled.text, contentId: 'post-label-1' })
const fileLabelled = compliance.labelContent({ text: '正文', contentId: 'post-file-1', mediaType: 'file' })
const badTemplate = attempt(() => compliance.labelContent({ text: '正文', contentId: 'x', template: 'AI 生成（没有编号）' }))
check('compliance B1: the explicit label contains the contentId and is visible; text channels say implicit is not-applicable; a template without {contentId} is refused',
  compliance.hasExplicitLabel(labelled.text, 'post-label-1') &&
  labelled.text.includes('post-label-1') &&
  labelled.text.includes('AI 生成') &&
  labelled.metadata.contentId === 'post-label-1' &&
  labelled.metadata.synthetic === true &&
  labelled.metadata.implicit === 'not-applicable' &&
  labelledAgain.text === labelled.text &&
  fileLabelled.metadata.implicit === 'written' &&
  badTemplate.threw &&
  badTemplate.message.includes('life/compliance-label-template-requires-content-id'),
  `label tail=${JSON.stringify(labelled.text.split('\n').slice(-1)[0])}; implicit text/file=` +
  `${labelled.metadata.implicit}/${fileLabelled.metadata.implicit}; idempotent=${labelledAgain.text === labelled.text}; ` +
  `bad template=${badTemplate.message}`)

const assertCases = {
  ok: () => compliance.assertLabeled(labelled),
  noText: () => compliance.assertLabeled({ text: '', metadata: { contentId: 'x' } }),
  noId: () => compliance.assertLabeled({ text: '正文', metadata: {} }),
  unlabelled: () => compliance.assertLabeled({ text: '正文没有标识', metadata: { contentId: 'x' } }),
  wrongId: () => compliance.assertLabeled({ text: '正文\n\n—— AI 生成 · 内容编号 other', metadata: { contentId: 'x' } }),
  noAiMarker: () => compliance.assertLabeled({ text: '正文\n\n内容编号 x', metadata: { contentId: 'x' } }),
}
const assertOutcomes = Object.fromEntries(Object.entries(assertCases).map(([name, fn]) => [name, attempt(fn)]))
check('compliance B2: assertLabeled accepts a correctly labelled body and rejects missing text/id, a stripped label, or a label for another contentId',
  assertOutcomes.ok.threw === false &&
  assertOutcomes.noText.threw && assertOutcomes.noText.message.includes('life/compliance-missing-text') &&
  assertOutcomes.noId.threw && assertOutcomes.noId.message.includes('life/compliance-missing-content-id') &&
  assertOutcomes.unlabelled.threw && assertOutcomes.unlabelled.message.includes('life/compliance-missing-explicit-label') &&
  assertOutcomes.wrongId.threw &&
  assertOutcomes.noAiMarker.threw,
  Object.entries(assertOutcomes).map(([name, outcome]) => `${name}=${outcome.threw ? 'refused' : 'accepted'}`).join(', '))

const FORBIDDEN_EXPORTS = /strip|remove|unlabel/i
const moduleExports = {
  compliance: Object.keys(compliance),
  outbox: Object.keys(outbox),
  plugin: Object.keys(plugin),
}
const forbiddenExports = Object.entries(moduleExports)
  .flatMap(([module, names]) => names.filter((name) => FORBIDDEN_EXPORTS.test(name)).map((name) => `${module}.${name}`))
check('compliance B3: no module exports a strip/remove/unlabel function — the label cannot be removed through the public API',
  forbiddenExports.length === 0,
  forbiddenExports.length ? `forbidden exports: ${forbiddenExports.join(', ')}` : `exports scanned: ` +
    Object.entries(moduleExports).map(([module, names]) => `${module}=${names.length}`).join(', '))

// B4: a receipt is not a licence to skip the label. Force label derivation to
// produce text that cannot pass the gate, then try to confirm with a platform id.
const unreachableLabel = {
  ...sendingRecord,
  contentId: 'c-unlabelled-receipt',
  id: 'c-unlabelled-receipt',
  text: '正文',
  labelOptions: { template: '内容编号 {contentId}' },
}
const unlabelledConfirm = attempt(() => outbox.markConfirmed(unreachableLabel, {
  platformId: 'tg:receipt-but-unlabelled',
  now: NOW,
}))
const brokenTemplate = {
  ...sendingRecord,
  contentId: 'c-broken-template',
  id: 'c-broken-template',
  text: '正文',
  labelOptions: { template: 'AI 生成（没有占位符）' },
}
const brokenConfirm = attempt(() => outbox.markConfirmed(brokenTemplate, {
  platformId: 'tg:receipt-but-broken-template',
  now: NOW,
}))
check('compliance B4: markConfirmed refuses even with a receipt when the mandatory label cannot be produced',
  unlabelledConfirm.threw &&
  unlabelledConfirm.message.includes('life/compliance-missing-explicit-label') &&
  brokenConfirm.threw &&
  brokenConfirm.message.includes('life/compliance-label-template-requires-content-id'),
  `unlabelled=${unlabelledConfirm.message}; broken template=${brokenConfirm.message}`)

// ---------------------------------------------------------------------------
// C. life_publish wiring: fake approval + fake transport
// ---------------------------------------------------------------------------
function publishCtx ({ withApproval = true } = {}) {
  const state = {
    warnings: [],
    infos: [],
    tools: [],
    sections: [],
    handlers: new Map(),
    approvalRequests: [],
    approvalHandler: async () => 'rejected',
  }
  const approval = {
    async request (request) {
      state.approvalRequests.push(request)
      return state.approvalHandler(request, state)
    },
  }
  const ctxFor = (deps) => {
    const ctx = {
      on: (name, handler) => {
        if (!state.handlers.has(name)) state.handlers.set(name, [])
        state.handlers.get(name).push(handler)
        return () => {}
      },
    }
    if (deps.includes('tools')) ctx.tools = { register: (definition) => { state.tools.push(definition); return () => {} } }
    if (deps.includes('systemPrompt')) ctx.systemPrompt = { section: (section) => { state.sections.push(section); return () => {} } }
    if (deps.includes('approval')) ctx.approval = approval
    return ctx
  }
  const root = {
    logger: {
      warn: (message) => state.warnings.push(String(message)),
      info: (message) => state.infos.push(String(message)),
    },
    get: () => undefined,
    on: (name, handler) => {
      if (!state.handlers.has(name)) state.handlers.set(name, [])
      state.handlers.get(name).push(handler)
      return () => {}
    },
    inject: (deps, callback) => {
      if (deps.includes('approval') && !withApproval) return
      callback(ctxFor(deps))
    },
    effect: () => () => {},
  }
  state.root = root
  return state
}
function fakeTransport ({ receipt = { platformId: 'tg:42' }, failure = null } = {}) {
  const calls = { send: [], query: [] }
  return {
    calls,
    async send (candidate) {
      calls.send.push(candidate)
      if (failure) throw (typeof failure === 'function' ? failure(candidate) : failure)
      return typeof receipt === 'function' ? receipt(candidate) : receipt
    },
    async query (candidate) {
      calls.query.push(candidate)
      return null
    },
  }
}
function publishFixture ({ lifeId, config = {}, withApproval = true }) {
  const state = publishCtx({ withApproval })
  plugin.apply(state.root, {
    lifeId,
    publisherEnabled: true,
    publisherChannels: [{ id: 'tg', kind: 'telegram', account: 'acct' }],
    ...config,
  })
  const store = new LifeStore({ lifeId })
  return { state, store }
}
const toolOf = (state, name) => state.tools.find((definition) => definition.name === name)
/** sha256 of a buffer, same definition the video module uses. */
const createHash = (await import('node:crypto')).createHash
const seedChecked = (store, {
  contentId = 'post-1',
  text = '今天把第 38 层打过了，存档在 save:38',
  channel = 'tg',
  account = 'acct',
} = {}) => {
  const labelOptions = { identityName: '大肥鱼', providerCode: 'dsh-life' }
  const record = outbox.createDraft({ contentId, text, channel, account, labelOptions, now: NOW })
  const checked = outbox.markChecked(record, { labelOptions, now: NOW })
  return store.appendOutboxItem(checked).record
}
const publishCall = (state, id) => toolOf(state, 'life_publish').execute(
  { id },
  { agent: { session: { id: 'publish-session' } }, callId: 'call-1' },
)

// C1: the three non-consent outcomes must all send zero times and be distinct.
{
  const transport = fakeTransport()
  const fixture = publishFixture({ lifeId: 'publish-outcomes', config: { transport } })
  seedChecked(fixture.store, { contentId: 'post-outcomes' })
  const outcomes = ['rejected', 'cancelled', 'unavailable']
  const seen = []
  let approvalCount = 0
  fixture.state.approvalHandler = async () => {
    const outcome = outcomes[approvalCount]
    approvalCount += 1
    return outcome
  }
  const resultsByOutcome = []
  for (const expected of outcomes) {
    const result = await publishCall(fixture.state, 'post-outcomes')
    resultsByOutcome.push({ expected, result })
    seen.push(result.outcome)
  }
  const stored = fixture.store.findOutboxItem('post-outcomes')
  check('publish C1: rejected/cancelled/unavailable all send zero times, keep the record checked, and return distinguishable text',
    // 与源码里定义的工具数比，不写死一个数：加工具时这条不该红，
    // 「注册漏了一个」才该红。
    fixture.state.tools.length === declaredToolCount() &&
    fixture.state.warnings.length === 0 &&
    fixture.state.approvalRequests.length === 3 &&
    transport.calls.send.length === 0 &&
    seen.join(',') === outcomes.join(',') &&
    resultsByOutcome.every((row) => row.result.ok === false && row.result.status === 'checked') &&
    new Set(resultsByOutcome.map((row) => row.result.message)).size === 3 &&
    stored.status === 'checked' &&
    stored.lastApproval?.outcome === 'unavailable',
    `tools=${fixture.state.tools.length}, warnings=${fixture.state.warnings.length}, ` +
    `approvals=${fixture.state.approvalRequests.length}, sends=${transport.calls.send.length}, ` +
    `outcomes=[${seen}], messages distinct=${new Set(resultsByOutcome.map((row) => row.result.message)).size}, ` +
    `record=${stored.status}/lastApproval=${stored.lastApproval?.outcome}`)
}

// C2: TOCTOU — the approval handler changes the stored body before answering
// `allowed-once`. The publish must not send the changed bytes.
{
  const transport = fakeTransport()
  const fixture = publishFixture({ lifeId: 'publish-toctou', config: { transport } })
  seedChecked(fixture.store, { contentId: 'post-toctou', text: '原始正文，只有这一版被批准' })
  const original = fixture.store.findOutboxItem('post-toctou')
  fixture.state.approvalHandler = async () => {
    const item = fixture.store.findOutboxItem('post-toctou')
    fixture.store.updateOutboxItem('post-toctou', { text: `${item.text}（批准期间被改）` }, { max: 200 })
    return 'allowed-once'
  }
  const result = await publishCall(fixture.state, 'post-toctou')
  const stored = fixture.store.findOutboxItem('post-toctou')
  check('publish C2 (TOCTOU): changing the stored body during approval makes the old yes invalid — zero sends, back to checked',
    result.outcome === 'content-changed' &&
    result.ok === false &&
    transport.calls.send.length === 0 &&
    fixture.state.approvalRequests.length === 1 &&
    stored.status === 'checked' &&
    stored.approval === null &&
    stored.contentVersion !== original.contentVersion &&
    stored.text.includes('批准期间被改'),
    `outcome=${result.outcome}, transport sends=${transport.calls.send.length}, ` +
    `version ${original.contentVersion} -> ${stored.contentVersion}, record=${stored.status}/approval=${stored.approval}`)
}

// C3: no approval channel (headless) fails closed; the plugin still loads.
{
  const fixture = publishFixture({
    lifeId: 'publish-no-approval',
    config: { transport: fakeTransport() },
    withApproval: false,
  })
  seedChecked(fixture.store, { contentId: 'post-no-approval' })
  const result = await attemptAsync(() => publishCall(fixture.state, 'post-no-approval'))
  const stored = fixture.store.findOutboxItem('post-no-approval')
  check('publish C3: without the approval service the tool fails with no-approval-channel, sends zero times, and the plugin still registers every declared tool with no apply warning',
    result.threw &&
    result.message.includes('life/publish-no-approval-channel') &&
    fixture.state.tools.length === declaredToolCount() &&
    fixture.state.warnings.length === 0 &&
    stored.status === 'checked',
    `error=${result.message}; tools=${fixture.state.tools.length}, warnings=${fixture.state.warnings.length}, ` +
    `record=${stored.status}`)
}

// C4: the publish line is off by default / when disabled.
{
  const transport = fakeTransport()
  const fixture = publishFixture({
    lifeId: 'publish-disabled',
    config: { publisherEnabled: false, transport },
  })
  seedChecked(fixture.store, { contentId: 'post-disabled' })
  const result = await attemptAsync(() => publishCall(fixture.state, 'post-disabled'))
  const stored = fixture.store.findOutboxItem('post-disabled')
  check('publish C4: publisherEnabled:false refuses before any approval or send path',
    result.threw &&
    result.message.includes('life/publisher-disabled') &&
    fixture.state.approvalRequests.length === 0 &&
    transport.calls.send.length === 0 &&
    stored.status === 'checked' && stored.approval === null,
    `error=${result.message}; approvals=${fixture.state.approvalRequests.length}, sends=${transport.calls.send.length}, ` +
    `record=${stored.status}`)
}

// C5: a missing credential is caught before asking the keeper; it is not an
// unconfirmed send.
{
  const tokenEnv = 'DSH_LIFE_VERIFY_MISSING_TELEGRAM_TOKEN'
  delete process.env[tokenEnv]
  const fixture = publishFixture({
    lifeId: 'publish-credential',
    config: { publisherChannels: [{ id: 'tg', kind: 'telegram', account: 'acct', tokenEnv }] },
  })
  seedChecked(fixture.store, { contentId: 'post-credential', channel: 'tg' })
  const result = await publishCall(fixture.state, 'post-credential')
  const stored = fixture.store.findOutboxItem('post-credential')
  check('publish C5: an unconfigured token is reported before approval and never becomes an unconfirmed send',
    result.outcome === 'credential-unconfigured' &&
    result.status === 'checked' &&
    fixture.state.approvalRequests.length === 0 &&
    stored.status === 'checked' &&
    stored.platformId === null &&
    realFetchCalls === 0,
    `outcome=${result.outcome}, approvals=${fixture.state.approvalRequests.length}, ` +
    `record=${stored.status}/platformId=${stored.platformId}, real fetch calls=${realFetchCalls}`)
}

// C6: the durable ledger records routing/digest/length, never the body.
{
  const fixture = publishFixture({
    lifeId: 'publish-ledger',
    config: { transport: fakeTransport({ receipt: { platformId: 'tg:4242' } }) },
  })
  fixture.state.approvalHandler = async () => 'allowed-once'
  const secretBody = 'SECRET-BODY-THAT-MUST-NOT-ENTER-THE-LEDGER'
  const record = seedChecked(fixture.store, { contentId: 'post-ledger', text: secretBody })
  const confirmedResult = await publishCall(fixture.state, 'post-ledger')
  const publishLedger = fixture.store.readLedger({ limit: 200 }).filter((entry) => entry.kind === 'publish')
  const confirmedDetail = publishLedger[publishLedger.length - 1]?.detail || {}
  const detailKeys = Object.keys(confirmedDetail).sort().join(',')

  const failingFixture = publishFixture({
    lifeId: 'publish-ledger-unconfirmed',
    config: { transport: fakeTransport({ failure: new Error('socket closed after write') }) },
  })
  failingFixture.state.approvalHandler = async () => 'allowed-once'
  const failingRecord = seedChecked(failingFixture.store, { contentId: 'post-ledger-unconfirmed', text: secretBody })
  const unconfirmedResult = await publishCall(failingFixture.state, 'post-ledger-unconfirmed')
  const unconfirmedLedger = failingFixture.store.readLedger({ limit: 200 }).filter((entry) => entry.kind === 'publish')
  const unconfirmedDetail = unconfirmedLedger[unconfirmedLedger.length - 1]?.detail || {}
  const ledgerBodies = JSON.stringify([...publishLedger, ...unconfirmedLedger])
  check('publish C6: the publish ledger has routing/digest/length only — never the body — for both confirmed and unconfirmed outcomes',
    confirmedResult.outcome === 'confirmed' &&
    confirmedDetail.contentId === 'post-ledger' &&
    confirmedDetail.status === 'confirmed' &&
    confirmedDetail.platformId === 'tg:4242' &&
    confirmedDetail.textLength === record.text.length &&
    detailKeys === 'account,channel,contentId,contentVersion,platformId,status,textLength' &&
    unconfirmedResult.outcome === 'unconfirmed' &&
    unconfirmedDetail.status === 'unconfirmed' &&
    unconfirmedDetail.platformId === null &&
    unconfirmedDetail.textLength === failingRecord.text.length &&
    !ledgerBodies.includes(secretBody),
    `confirmed detail keys=${detailKeys}, platformId=${confirmedDetail.platformId}, textLength=${confirmedDetail.textLength}; ` +
    `unconfirmed status/platformId=${unconfirmedDetail.status}/${unconfirmedDetail.platformId}; ` +
    `body leaked=${ledgerBodies.includes(secretBody)}`)
}

// ---------------------------------------------------------------------------
// C7. 视频发布线：批准绑定的是**文件字节**，不是字幕
// ---------------------------------------------------------------------------
//
// 这一段补的是「发布线最危险的一个洞」：如果内容版本只算字幕，那么主人点了
// 「通过」之后换掉视频文件，批准照样生效 —— 主人同意的是**那一份字节**。
// 所以这里断言三件事，每件都有对应的反例：
//
//   1. 发布前**重新哈希磁盘上的文件**；文件变了就拒绝，且不请求批准、不发送；
//   2. 带媒体的记录，其内容版本包含文件摘要（改文件 = 改版本 = 旧批准作废）；
//   3. 上传时**再核一次**摘要；不匹配就在发请求之前拒绝 —— 于是连 unconfirmed
//      都不会产生（什么都没发出去）。
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-life-video-publish-'))
  const videoFile = path.join(dir, 'clip.mp4')
  fs.writeFileSync(videoFile, Buffer.from('pretend-this-is-a-labelled-mp4'))

  const videoOutbox = await import(pathToFileURL(path.join(PLUGIN, 'lib', 'outbox.js')).href)
  const videoModule = await import(pathToFileURL(path.join(PLUGIN, 'lib', 'video.js')).href)
  const digest = videoModule.fileDigest(videoFile)
  const contentId = 'post-video-1'
  const media = {
    kind: 'video',
    path: videoFile,
    digest,
    labelText: '—— AI 生成 · 内容编号 ' + contentId,
    metadata: { marker: 'dsh-life', synthetic: '1', provider: 'dsh-life', contentId },
    durationSec: 2,
    sizeBytes: fs.statSync(videoFile).size,
  }
  const seedVideoChecked = (store, overrides = {}) => {
    const labelOptions = { identityName: '大肥鱼', providerCode: 'dsh-life' }
    const record = videoOutbox.createDraft({
      contentId, text: '今天打了一局，录了下来', channel: 'tg', account: 'acct',
      labelOptions, media: { ...media, ...overrides }, now: NOW,
    })
    const checked = videoOutbox.markChecked(record, { labelOptions, now: NOW })
    return store.appendOutboxItem(checked).record
  }

  // (a) 基线：一切正常时，媒体原样送到 transport，并且内容版本含摘要。
  {
    const transport = fakeTransport()
    const fixture = publishFixture({ lifeId: 'video-ok', config: { transport } })
    const seeded = seedVideoChecked(fixture.store)
    check('publish C7a: 带媒体的记录，内容版本包含文件摘要（与纯文本版本不同）',
      seeded.media.digest === digest &&
        seeded.contentVersion !== videoOutbox.contentVersionOf(seeded.text),
      `version=${seeded.contentVersion}`)

    fixture.state.approvalHandler = async () => 'allowed-once'
    const result = await publishCall(fixture.state, contentId)
    check('publish C7a: 批准通过后媒体随 candidate 一起发出（transport 收到了 media）',
      result.ok === true && result.outcome === 'confirmed' &&
        transport.calls.send.length === 1 &&
        transport.calls.send[0].media && transport.calls.send[0].media.digest === digest,
      `outcome=${result.outcome}, sends=${transport.calls.send.length}`)
  }

  // (b) **核心反例**：批准前文件被换掉 → 拒绝、零发送、零批准请求。
  {
    const transport = fakeTransport()
    const fixture = publishFixture({ lifeId: 'video-swapped', config: { transport } })
    seedVideoChecked(fixture.store)
    // 伪造「有人把文件换了」：内容变了，记录里的摘要没变。
    fs.writeFileSync(videoFile, Buffer.from('a DIFFERENT clip that was never labelled'))
    fixture.state.approvalHandler = async () => 'allowed-once'
    const result = await publishCall(fixture.state, contentId)
    check('publish C7b: 发布前文件被替换 → 拒绝，零发送、零批准请求（批准绑定的是字节）',
      result.ok === false && result.outcome === 'media-changed' &&
        transport.calls.send.length === 0 &&
        fixture.state.approvalRequests.length === 0,
      `outcome=${result.outcome}, sends=${transport.calls.send.length}, approvals=${fixture.state.approvalRequests.length}`)
    // 恢复，供后续用例继续。
    fs.writeFileSync(videoFile, Buffer.from('pretend-this-is-a-labelled-mp4'))
  }

  // (c) 文件不见了也一样：不能因为「读不到」就当成通过。
  {
    const transport = fakeTransport()
    const fixture = publishFixture({ lifeId: 'video-missing', config: { transport } })
    const gone = path.join(dir, 'not-there.mp4')
    seedVideoChecked(fixture.store, { path: gone, digest: digest })
    fixture.state.approvalHandler = async () => 'allowed-once'
    const result = await publishCall(fixture.state, contentId)
    check('publish C7c: 视频文件不在了 → 拒绝，零发送、零批准请求（读不到 ≠ 通过）',
      result.ok === false && result.outcome === 'media-missing' &&
        transport.calls.send.length === 0 && fixture.state.approvalRequests.length === 0,
      `outcome=${result.outcome}`)
  }

  // (d) 元数据被抹掉（内容编号对不上）也要拦 —— 摘要没变也可能标识不全。
  {
    const transport = fakeTransport()
    const fixture = publishFixture({ lifeId: 'video-meta', config: { transport } })
    seedVideoChecked(fixture.store, {
      metadata: { marker: 'dsh-life', synthetic: '1', provider: 'dsh-life', contentId: 'somebody-else' },
    })
    fixture.state.approvalHandler = async () => 'allowed-once'
    const result = await publishCall(fixture.state, contentId)
    check('publish C7d: 隐式标识里的内容编号与记录不一致 → 拒绝，零发送',
      result.ok === false && result.outcome === 'media-metadata-invalid' && transport.calls.send.length === 0,
      `outcome=${result.outcome}`)
  }

  // (e) 上传时的最后一道：**在批准的等待窗口里**换掉文件（这才是真实的 TOCTOU 窗口 ——
  // 主人看字幕、思考、点「通过」可能要好几分钟）。此时预检已经跑过，所以只有
  // transport 自己再核一次摘要才拦得住。拦不住就会把一份没标注的文件发出去。
  {
    const transport = {
      calls: { send: [] },
      async send (candidate) {
        this.calls.send.push(candidate)
        const live = videoModule.fileDigest(candidate.media.path)
        if (live !== candidate.media.digest) {
          throw new Error('life/telegram-media-digest-mismatch: 文件与已批准的那一份不是同一份，拒绝上传')
        }
        return { platformId: 'tg:7' }
      },
    }
    const fixture = publishFixture({ lifeId: 'video-late-swap', config: { transport } })
    seedVideoChecked(fixture.store)
    fixture.state.approvalHandler = async () => {
      // 批准期间文件被替换 —— 预检已经过去了。
      fs.writeFileSync(videoFile, Buffer.from('swapped while the keeper was deciding'))
      return 'allowed-once'
    }
    const result = await publishCall(fixture.state, contentId)
    const stored = fixture.store.findOutboxItem(contentId)
    check('publish C7e: 批准等待期间文件被换 → 上传前拒绝 → unconfirmed（结果未知），绝不自动重发',
      result.ok === false && result.outcome === 'unconfirmed' && stored.status === 'unconfirmed' &&
        transport.calls.send.length === 1,
      `outcome=${result.outcome}, record=${stored.status}, sends=${transport.calls.send.length}`)
    fs.writeFileSync(videoFile, Buffer.from('pretend-this-is-a-labelled-mp4'))
  }

  fs.rmSync(dir, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// D. Telegram adapter with an injected fetch
// ---------------------------------------------------------------------------
const FAKE_TOKEN = '123456789:AAFakeTokenForVerification_9xQ2'
const labelledForTelegram = compliance.labelContent({
  text: '今天把第 38 层打过了，存档在 save:38',
  contentId: 'post-tg-1',
  identityName: '大肥鱼',
})
{
  process.env.DSH_LIFE_VERIFY_TELEGRAM_TOKEN = FAKE_TOKEN
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({ url, options })
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 4242 } }) }
  }
  const transport = telegram.createTelegramTransport({
    tokenEnv: 'DSH_LIFE_VERIFY_TELEGRAM_TOKEN',
    fetchImpl,
    apiBase: 'https://telegram.invalid',
  })
  const candidate = {
    contentId: 'post-tg-1',
    account: 'chat-99',
    text: labelledForTelegram.text,
    metadata: labelledForTelegram.metadata,
  }
  const sent = await transport.send(candidate)
  const request = calls[0]
  const body = JSON.parse(request.options.body)
  check('telegram D1: POSTs to /bot{token}/sendMessage with chat_id, the labelled text, and disable_web_page_preview',
    calls.length === 1 &&
    request.url === `https://telegram.invalid/bot${FAKE_TOKEN}/sendMessage` &&
    request.options.method === 'POST' &&
    request.options.headers['content-type'] === 'application/json' &&
    body.chat_id === 'chat-99' &&
    body.disable_web_page_preview === true &&
    body.text.includes('AI 生成') &&
    body.text.includes('post-tg-1') &&
    sent.platformId === 'tg:4242',
    `url=${request.url.replace(FAKE_TOKEN, '<token>')}, method=${request.options.method}, ` +
    `chat_id=${body.chat_id}, disable_web_page_preview=${body.disable_web_page_preview}, ` +
    `label/contentId in text=${body.text.includes('AI 生成')}/${body.text.includes('post-tg-1')}, platformId=${sent.platformId}`)
}
{
  const failureCases = []
  const runFailure = async (name, fetchImpl) => {
    const transport = telegram.createTelegramTransport({
      tokenEnv: 'DSH_LIFE_VERIFY_TELEGRAM_TOKEN',
      fetchImpl,
      apiBase: 'https://telegram.invalid',
    })
    const outcome = await attemptAsync(() => transport.send({ account: 'chat-99', text: '正文\n\n—— AI 生成 · 内容编号 c-x' }))
    failureCases.push({ name, outcome })
  }
  await runFailure('non-2xx', async () => ({
    ok: false,
    status: 401,
    json: async () => ({ ok: false, description: 'Unauthorized' }),
  }))
  await runFailure('transport throws with token in message', async () => {
    throw new Error(`connect ECONNREFUSED (bot${FAKE_TOKEN} unreachable)`)
  })
  await runFailure('non-JSON body', async () => ({
    ok: true,
    status: 200,
    json: async () => { throw new Error('not json') },
  }))
  check('telegram D2: non-2xx, thrown transport errors and non-JSON bodies all throw, and the token never appears in the error',
    failureCases.every((row) => row.outcome.threw) &&
    failureCases.every((row) => !row.outcome.message.includes(FAKE_TOKEN)) &&
    failureCases[0].outcome.message.includes('401') &&
    failureCases.some((row) => row.outcome.message.includes('[redacted]')),
    failureCases.map((row) => `${row.name}=${row.outcome.threw ? 'threw' : 'resolved'}` +
      ` (token=${row.outcome.message.includes(FAKE_TOKEN)})`).join(', '))
}
{
  const tokenEnv = 'DSH_LIFE_VERIFY_UNSET_TOKEN'
  delete process.env[tokenEnv]
  let fetchCalls = 0
  const transport = telegram.createTelegramTransport({
    tokenEnv,
    fetchImpl: async () => { fetchCalls += 1; return { ok: true, status: 200, json: async () => ({ ok: true }) } },
    apiBase: 'https://telegram.invalid',
  })
  const outcome = await attemptAsync(() => transport.send({ account: 'chat-99', text: '正文' }))
  check('telegram D3: a missing token throws credential-unconfigured before any request',
    outcome.threw && outcome.message.includes('credential-unconfigured') && fetchCalls === 0,
    `error=${outcome.message}; fetch calls=${fetchCalls}`)
}
{
  const transport = telegram.createTelegramTransport({
    tokenEnv: 'DSH_LIFE_VERIFY_TELEGRAM_TOKEN',
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1 } }) }),
    apiBase: 'https://telegram.invalid',
  })
  const queried = await transport.query({ contentId: 'x' })
  check('telegram D4: query() returns null and says the platform cannot be reverse-queried',
    queried === null,
    `query()=${String(queried)} (null means unverifiable, so the outbox stays unconfirmed)`)
}
{
  // The outbox comment used to claim cross-process safety came partly from "the
  // platform idempotency key". That was never true for Telegram, and a false
  // safety claim is worse than none: it makes a duplicate post look impossible
  // when it is merely unlikely. Pin the fact down instead of trusting prose.
  //
  // Two halves, both measured rather than asserted:
  //   1. the request body contains no idempotency-ish field, even though the
  //      candidate carries `idempotencyKey`; and
  //   2. `query()` cannot look a message up, so an `unconfirmed` row can never
  //      be resolved by asking the platform.
  const bodies = []
  const transport = telegram.createTelegramTransport({
    tokenEnv: 'DSH_LIFE_VERIFY_TELEGRAM_TOKEN',
    fetchImpl: async (url, options) => {
      bodies.push(JSON.parse(options.body))
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 7 } }) }
    },
    apiBase: 'https://telegram.invalid',
  })
  await transport.send({
    contentId: 'key-probe',
    contentVersion: 'v1',
    // The key is offered to the transport on purpose: if the adapter ever starts
    // sending it, this check should notice rather than silently pass.
    idempotencyKey: 'key-probe|v1|tg|acct',
    account: 'chat-1',
    text: '正文\n\n—— AI 生成 · 内容编号 key-probe',
  })
  const body = bodies[0] || {}
  const sentKeys = Object.keys(body).sort()
  const idempotencyFields = sentKeys.filter((key) => /idempot|dedup|client_?id|message_?key/i.test(key))
  const lookup = await transport.query({ contentId: 'key-probe', idempotencyKey: 'key-probe|v1|tg|acct' })
  check('telegram D6: the adapter sends no idempotency key and cannot reverse-query — so a Telegram send has no platform-side duplicate guard',
    idempotencyFields.length === 0 &&
    lookup === null &&
    sentKeys.join(',') === 'chat_id,disable_web_page_preview,text',
    `sent fields=[${sentKeys.join(',')}]; idempotency-ish=${idempotencyFields.length}; query()=${String(lookup)}` +
    ` → duplicates are prevented by application logic only, and an unconfirmed row needs a human`)
}
{
  const telegramSource = fs.readFileSync(path.join(PLUGIN, 'lib', 'telegram.js'), 'utf8')
  // Comments mention "fetch" in prose; only real calls in code matter here.
  const telegramCode = telegramSource
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
  const directFetchCalls = telegramCode.match(/\bfetch\s*\(/g) || []
  const httpImports = telegramCode.match(/\b(?:require|import)\s*\(?['"](?:node:)?https?['"]/g) || []
  const stubFetch = globalThis.fetch
  globalThis.fetch = undefined
  let noFetchSend
  try {
    const noFetchImpl = telegram.createTelegramTransport({ tokenEnv: 'DSH_LIFE_VERIFY_TELEGRAM_TOKEN' })
    noFetchSend = await attemptAsync(() => noFetchImpl.send({ account: 'x', text: 'y' }))
  } finally {
    globalThis.fetch = stubFetch
  }
  check('telegram D5: the only network exit is the injected fetch — this process made zero real requests and the module has no direct fetch/http call',
    realFetchCalls === 0 &&
    directFetchCalls.length === 0 &&
    httpImports.length === 0 &&
    noFetchSend && noFetchSend.threw && noFetchSend.message.includes('life/telegram-fetch-unavailable'),
    `realFetchCalls=${realFetchCalls}, direct fetch( in source=${directFetchCalls.length}, ` +
    `http imports=${httpImports.length}, missing fetchImpl send=${noFetchSend ? noFetchSend.message : 'not attempted'}`)
}

// ---------------------------------------------------------------------------
// D7. Telegram 视频上传：真的组了 multipart，而且上传前再核一次字节
// ---------------------------------------------------------------------------
//
// 文本那条（D1）只看 JSON 体。视频这一条必须看 **multipart** —— 这也是最容易
// 「看起来发了、其实发的是空体」的地方。所以这里断言：
//   - 走的是 /sendVideo，不是 /sendMessage（发错端点会得到一个没有视频的消息）；
//   - body 里真有文件字节，且 Content-Type 是 video/mp4；
//   - caption 带显式标识（§4(4) 的「播放周边」那一半，与首帧烧字互补）；
//   - 文件与记录的摘要不匹配时，**在发请求之前**就拒绝。
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-life-tg-video-'))
  const clip = path.join(dir, 'clip.mp4')
  // 一小段带高位字节的内容：如果实现把二进制当字符串处理，这些字节会变形，
  // 而摘要校验正是抓这个的（这个坑在 video.js 里真的踩到过）。
  const bytes = Buffer.concat([Buffer.from([0x00, 0x01, 0xff, 0xfe]), Buffer.alloc(64, 0xa5)])
  fs.writeFileSync(clip, bytes)
  const digest = createHash('sha256').update(bytes).digest('hex')
  const caption = '—— AI 生成 · 内容编号 post-tg-video\n今天打了一局'
  const candidate = {
    contentId: 'post-tg-video', contentVersion: 'v', idempotencyKey: 'k',
    channel: 'tg', account: '12345', text: caption, metadata: {},
    media: { kind: 'video', path: clip, digest, sizeBytes: bytes.length, durationSec: 2 },
  }

  const requests = []
  const transport = telegram.createTelegramTransport({
    tokenEnv: 'TG_VIDEO_TOKEN',
    fetchImpl: async (url, options) => {
      requests.push({ url, options })
      return { ok: true, status: 200, async json () { return { ok: true, result: { message_id: 99 } } } }
    },
  })
  process.env.TG_VIDEO_TOKEN = 'token-video-secret'
  const sent = await transport.send(candidate)
  const body = requests[0].options.body
  const bodyText = Buffer.isBuffer(body) ? body.toString('latin1') : String(body)

  check('telegram D7a: 视频走 /sendVideo（不是 /sendMessage），拿到 message_id',
    sent.platformId === 'tg:99' && /\/sendVideo$/.test(requests[0].url),
    `${requests[0].url.replace(/bot[^/]*/, 'bot…')} -> ${sent.platformId}`)

  check('telegram D7a: body 是 multipart，含文件字节、文件名与 video/mp4',
    Buffer.isBuffer(body) &&
      /multipart\/form-data; boundary=/.test(requests[0].options.headers['content-type']) &&
      bodyText.includes('name="video"; filename="clip.mp4"') &&
      bodyText.includes('Content-Type: video/mp4') &&
      body.includes(bytes),
    `body=${Buffer.isBuffer(body) ? body.length + 'B' : typeof body}`)

  // 用**字节**比，不要用 latin1 解码后的字符串比：caption 是 UTF-8，把 body 当
  // latin1 读会把中文变成乱码，于是这条会红 —— 而红的原因是检查写错了，不是代码错了。
  // （这个坑刚踩到过：同一个 body 的前两条断言过、这条不过。）
  check('telegram D7a: caption 带上显式标识（播放周边那一半，与首帧烧字互补）',
    body.includes(Buffer.from(caption, 'utf8')))

  // 反例 1：文件被换过 → 必须**在发请求之前**拒绝，requests 保持不动。
  {
    const before = requests.length
    fs.writeFileSync(clip, Buffer.from('a different file entirely'))
    const swapped = await attemptAsync(() => transport.send(candidate))
    check('telegram D7b: 上传前文件摘要不匹配 → 拒绝，且一个请求都没发出去',
      swapped.threw && swapped.message.includes('digest-mismatch') && requests.length === before,
      `threw=${swapped.threw}, requests+${requests.length - before}`)
    fs.writeFileSync(clip, bytes)
  }

  // 反例 2：超过渠道上限 → 本地就拒，不发。
  {
    const before = requests.length
    const tiny = telegram.createTelegramTransport({
      tokenEnv: 'TG_VIDEO_TOKEN',
      maxVideoBytes: 4,
      fetchImpl: async () => { throw new Error('must not be called') },
    })
    const tooBig = await attemptAsync(() => tiny.send(candidate))
    check('telegram D7c: 超过渠道大小上限 → 本地拒绝，一个请求都没发出去',
      tooBig.threw && tooBig.message.includes('too-large') && requests.length === before,
      String(tooBig.message).slice(0, 80))
  }

  // 反例 3：文件不存在 → 明确报缺文件，而不是发一个空视频。
  {
    const before = requests.length
    const missing = await attemptAsync(() => transport.send({
      ...candidate, media: { ...candidate.media, path: path.join(dir, 'nope.mp4') },
    }))
    check('telegram D7d: 文件不存在 → 明确拒绝（不会发一个空的视频）',
      missing.threw && missing.message.includes('media-missing') && requests.length === before,
      String(missing.message).slice(0, 80))
  }

  // 反例 4：transport 不能承载的媒体类型 → 拒绝，不静默降级成纯文字发布。
  {
    const before = requests.length
    const unsupported = await attemptAsync(() => transport.send({
      ...candidate, media: { ...candidate.media, kind: 'audio' },
    }))
    check('telegram D7e: 不支持的媒体类型 → 拒绝，不静默降级成纯文字发布',
      unsupported.threw && unsupported.message.includes('media-unsupported') && requests.length === before,
      String(unsupported.message).slice(0, 80))
  }

  delete process.env.TG_VIDEO_TOKEN
  fs.rmSync(dir, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// E. Mutation proofs: copy the code to %TEMP%, break the invariant, and show
// that the same predicate the suite uses would FAIL on the broken copy.
// ---------------------------------------------------------------------------
const mutationRoot = path.join(os.tmpdir(), `dsh-life-publish-mut-${process.pid}`)
fs.rmSync(mutationRoot, { recursive: true, force: true })
fs.mkdirSync(path.join(mutationRoot, 'recovery'), { recursive: true })
fs.mkdirSync(path.join(mutationRoot, 'label'), { recursive: true })
fs.copyFileSync(path.join(PLUGIN, 'lib', 'outbox.js'), path.join(mutationRoot, 'recovery', 'outbox.js'))
fs.copyFileSync(path.join(PLUGIN, 'lib', 'compliance.js'), path.join(mutationRoot, 'recovery', 'compliance.js'))
fs.copyFileSync(path.join(PLUGIN, 'lib', 'outbox.js'), path.join(mutationRoot, 'label', 'outbox.js'))
fs.copyFileSync(path.join(PLUGIN, 'lib', 'compliance.js'), path.join(mutationRoot, 'label', 'compliance.js'))
{
  const recoveryFile = path.join(mutationRoot, 'recovery', 'outbox.js')
  const original = fs.readFileSync(recoveryFile, 'utf8')
  const mutated = original.replace("item.status = 'unconfirmed'", "item.status = 'sending'")
  if (mutated === original) throw new Error('mutation E1 target not found')
  fs.writeFileSync(recoveryFile, mutated, 'utf8')
  const mutatedOutbox = await import(pathToFileURL(recoveryFile).href)
  const mutatedRecovered = mutatedOutbox.normalizeOutboxItems([sendingRecord], { now: NOW })[0]
  const predicate = (record) => record.status === 'unconfirmed' && record.lastError === 'recovered-from-sending'
  if (predicate(mutatedRecovered)) {
    check('mutation E1: breaking sending->unconfirmed makes the A2 assertion fail', false,
      'mutated copy still satisfied the invariant; mutation did not take effect')
  } else {
    console.log(`MUTATION-FAIL  A2 predicate on mutated copy: expected status=unconfirmed, got status=${mutatedRecovered.status} — the real A2 check would FAIL`)
    check('mutation E1: breaking sending->unconfirmed makes the A2 assertion fail (mutated copy returns sending)',
      true,
      `mutated status=${mutatedRecovered.status} (real suite requires unconfirmed); predicate would fail as intended`)
  }
}
{
  const labelFile = path.join(mutationRoot, 'label', 'compliance.js')
  const original = fs.readFileSync(labelFile, 'utf8')
  const mutated = original.replace('if (!hasExplicitLabel(text, contentId)) {', 'if (false) {')
  if (mutated === original) throw new Error('mutation E2 target not found')
  fs.writeFileSync(labelFile, mutated, 'utf8')
  const mutatedCompliance = await import(pathToFileURL(labelFile).href)
  const outcome = attempt(() => mutatedCompliance.assertLabeled({ text: '正文没有标识', metadata: { contentId: 'x' } }))
  const predicate = (result) => result.threw && result.message.includes('life/compliance-missing-explicit-label')
  if (predicate(outcome)) {
    check('mutation E2: removing the label gate makes the B2 assertion fail', false,
      'mutated copy still rejected unlabelled text; mutation did not take effect')
  } else {
    console.log('MUTATION-FAIL  B2 predicate on mutated copy: unlabelled text was accepted — the real B2 check would FAIL')
    check('mutation E2: removing the label gate makes the B2 assertion fail (mutated copy accepts unlabelled text)',
      true,
      `mutated assertLabeled=${outcome.threw ? 'refused' : 'accepted'}; real suite requires refusal`)
  }
}
fs.rmSync(mutationRoot, { recursive: true, force: true })

// ---------------------------------------------------------------------------
const failed = results.filter((result) => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length) console.log(`failed: ${failed.map((result) => result.label).join(' | ')}`)
if (realFetchCalls !== 0) console.log(`real fetch calls during the run: ${realFetchCalls} (must be 0)`)
process.exit(failed.length ? 1 : 0)
