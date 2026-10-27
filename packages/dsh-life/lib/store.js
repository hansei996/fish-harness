import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { dayKeyOf } from './wake.js'

/**
 * Durable life-state store.
 *
 * Owns the one thing dsh does not: a *life*, as opposed to a *session*.
 * dsh already persists the conversation (core/session), durable goals (goal) and
 * host-wide reminders (schedule). Those are all bound to a session. This store
 * holds the identity that outlives any single session, the slow/medium/fast
 * state variables, relationships, and the life ledger.
 *
 * Every write is atomic (tmp + rename) and every read tolerates a corrupt or
 * absent file, because a fish that dies because a JSON file got truncated is
 * exactly the failure this whole product exists to prevent.
 */

export function resolveDshHome () {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

function nowIso () {
  return new Date().toISOString()
}

export function newId (prefix) {
  const hex = Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join('')
  return `${prefix}-${hex}`
}

function readJson (file) {
  try {
    const text = fs.readFileSync(file, 'utf8')
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch (err) {
    return null
  }
}

function writeJsonAtomic (file, value) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, file)
}

function appendJsonl (file, entry) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8')
}

function readJsonl (file) {
  let text = ''
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    return []
  }
  const out = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed)
      if (parsed && typeof parsed === 'object') out.push(parsed)
    } catch (err) {
      // A half-written tail line is expected after a hard kill; skip it rather
      // than losing the whole ledger.
    }
  }
  return out
}

const LIFE_SCHEMA_VERSION = 1

/**
 * Default shape of wake.json. Every field is present so a caller never has to
 * distinguish "absent" from "never happened", and a corrupt file degrades to
 * exactly this instead of throwing.
 */
const DEFAULT_WAKE = {
  sessionId: null,
  scheduleId: null,
  armedAt: null,
  nextAt: null,
  dayKey: null,
  countToday: 0,
  paused: false,
  lastMessageIds: [],
}

/** At most this many delivered message ids are remembered for idempotency. */
const WAKE_ID_HISTORY = 20

export class LifeStore {
  /**
   * @param {object} options
   * @param {string} [options.home] - override for tests
   * @param {string} options.lifeId - stable identity of this life
   */
  constructor (options = {}) {
    this.home = options.home || resolveDshHome()
    this.lifeId = options.lifeId || 'default'
    this.dir = path.join(this.home, 'life', this.lifeId)
    this.files = {
      identity: path.join(this.dir, 'identity.json'),
      traits: path.join(this.dir, 'traits.json'),
      relations: path.join(this.dir, 'relations.json'),
      commitments: path.join(this.dir, 'commitments.json'),
      activity: path.join(this.dir, 'activity.json'),
      ledger: path.join(this.dir, 'ledger.jsonl'),
      wake: path.join(this.dir, 'wake.json'),
    }
  }

  /** Create the on-disk life if it does not exist yet. Idempotent. */
  ensure ({ name, species, seeds } = {}) {
    fs.mkdirSync(this.dir, { recursive: true })
    let identity = this.readIdentity()
    if (!identity) {
      identity = {
        schemaVersion: LIFE_SCHEMA_VERSION,
        lifeId: this.lifeId,
        name: name || '大肥鱼',
        species: species || 'whale',
        bornAt: nowIso(),
        /** Slow variable: only a keeper decision changes this. */
        revision: 1,
        seeds: Array.isArray(seeds) && seeds.length ? seeds.slice(0, 5) : ['聪明但懒', '傲娇', '爱吃白饭'],
        updatedAt: nowIso(),
      }
      writeJsonAtomic(this.files.identity, identity)
      this.appendLedger({ kind: 'born', detail: { name: identity.name, species: identity.species } })
    }
    if (!this.readTraits()) {
      writeJsonAtomic(this.files.traits, { schemaVersion: LIFE_SCHEMA_VERSION, interests: [], skills: [], habits: [], updatedAt: nowIso() })
    }
    if (!this.readRelations()) {
      writeJsonAtomic(this.files.relations, { schemaVersion: LIFE_SCHEMA_VERSION, people: [], updatedAt: nowIso() })
    }
    if (!this.readCommitments()) {
      writeJsonAtomic(this.files.commitments, { schemaVersion: LIFE_SCHEMA_VERSION, items: [], updatedAt: nowIso() })
    }
    if (!this.readActivity()) {
      writeJsonAtomic(this.files.activity, { schemaVersion: LIFE_SCHEMA_VERSION, current: null, next: null, updatedAt: nowIso() })
    }
    if (!this.readWakeFile()) {
      writeJsonAtomic(this.files.wake, {
        schemaVersion: LIFE_SCHEMA_VERSION,
        ...DEFAULT_WAKE,
        updatedAt: nowIso(),
      })
    }
    return identity
  }

  readIdentity () {
    const value = readJson(this.files.identity)
    return value && value.lifeId ? value : null
  }

  /**
   * Slow variable update. Deliberately gated: the caller must pass `confirmed`
   * to change identity, because a web page must never be able to rewrite who
   * the fish is.
   */
  updateIdentity (patch = {}, { confirmed = false } = {}) {
    const identity = this.readIdentity()
    if (!identity) throw new Error('life/identity-missing')
    if (!confirmed) {
      // Only allow non-identity-bearing fields to change without confirmation.
      const allowed = {}
      for (const key of ['displayName', 'avatar']) {
        if (key in patch) allowed[key] = patch[key]
      }
      if (Object.keys(allowed).length === 0) {
        throw new Error('life/identity-requires-keeper-confirmation')
      }
      const next = { ...identity, ...allowed, updatedAt: nowIso() }
      writeJsonAtomic(this.files.identity, next)
      return next
    }
    const next = {
      ...identity,
      ...patch,
      lifeId: identity.lifeId,
      bornAt: identity.bornAt,
      revision: (identity.revision || 1) + 1,
      updatedAt: nowIso(),
    }
    writeJsonAtomic(this.files.identity, next)
    this.appendLedger({ kind: 'identity-change', detail: { revision: next.revision, patch } })
    return next
  }

  readTraits () {
    return readJson(this.files.traits)
  }

  readRelations () {
    return readJson(this.files.relations) || { people: [] }
  }

  readCommitments () {
    return readJson(this.files.commitments) || { items: [] }
  }

  readActivity () {
    return readJson(this.files.activity) || { current: null, next: null }
  }

  /** Raw wake.json, or null when absent/corrupt (used only by ensure). */
  readWakeFile () {
    return readJson(this.files.wake)
  }

  /**
   * Normalized wake state. A missing, truncated or type-corrupt file degrades
   * field by field to {@link DEFAULT_WAKE} instead of throwing: a life must
   * never die because its alarm ledger was half written.
   */
  readWake () {
    const raw = this.readWakeFile()
    const wake = { ...DEFAULT_WAKE, lastMessageIds: [] }
    if (!raw || typeof raw !== 'object') return wake
    if (typeof raw.sessionId === 'string' && raw.sessionId) wake.sessionId = raw.sessionId
    if (typeof raw.scheduleId === 'string' && raw.scheduleId) wake.scheduleId = raw.scheduleId
    if (typeof raw.armedAt === 'string') wake.armedAt = raw.armedAt
    if (typeof raw.nextAt === 'string') wake.nextAt = raw.nextAt
    if (typeof raw.dayKey === 'string') wake.dayKey = raw.dayKey
    if (Number.isInteger(raw.countToday) && raw.countToday >= 0) wake.countToday = raw.countToday
    if (raw.paused === true) wake.paused = true
    if (Array.isArray(raw.lastMessageIds)) {
      wake.lastMessageIds = raw.lastMessageIds
        .filter((id) => typeof id === 'string' && id)
        .slice(-WAKE_ID_HISTORY)
    }
    return wake
  }

  /** Merge a patch into wake.json and write it atomically. */
  updateWake (patch = {}) {
    const current = this.readWake()
    const next = {
      schemaVersion: LIFE_SCHEMA_VERSION,
      ...current,
      ...(patch && typeof patch === 'object' ? patch : {}),
      updatedAt: nowIso(),
    }
    next.lastMessageIds = Array.isArray(next.lastMessageIds)
      ? next.lastMessageIds.filter((id) => typeof id === 'string' && id).slice(-WAKE_ID_HISTORY)
      : []
    writeJsonAtomic(this.files.wake, next)
    return next
  }

  /**
   * Record one delivered wake-up message.
   *
   * dsh does not guarantee exactly-once delivery (docs/dsh-schedule-api.md
   * §未知项 5), so this is idempotent by `messageId`: a re-delivered message
   * does not consume a second daily slot. The counter resets on the local
   * calendar day, not on a rolling 24h window, because the budget is a
   * "per day" promise.
   */
  noteWake ({ sessionId = null, messageId = null, at = null } = {}) {
    const moment = at === null || at === undefined ? new Date() : new Date(at)
    const date = Number.isNaN(moment.getTime()) ? new Date() : moment
    const dayKey = dayKeyOf(date)
    const wake = this.readWake()
    const known = typeof messageId === 'string' && wake.lastMessageIds.includes(messageId)
    if (known) {
      return {
        counted: false,
        countToday: wake.dayKey === dayKey ? wake.countToday : 0,
        dayKey,
      }
    }
    const sameDay = wake.dayKey === dayKey
    const countToday = (sameDay ? wake.countToday : 0) + 1
    const lastMessageIds = typeof messageId === 'string' && messageId
      ? [...wake.lastMessageIds, messageId].slice(-WAKE_ID_HISTORY)
      : wake.lastMessageIds
    const patch = { dayKey, countToday, lastMessageIds }
    if (typeof sessionId === 'string' && sessionId) patch.sessionId = sessionId
    this.updateWake(patch)
    return { counted: true, countToday, dayKey }
  }

  /**
   * Medium variable: interests, skills, habits. Each entry carries a confidence
   * and a source so growth can be explained and audited later.
   */
  recordInterest ({ topic, confidence = 0.5, source = 'agent', note = '' } = {}) {
    if (!topic || typeof topic !== 'string') throw new Error('life/invalid-topic')
    const traits = this.readTraits() || { interests: [], skills: [], habits: [] }
    traits.interests = Array.isArray(traits.interests) ? traits.interests : []
    const existing = traits.interests.find((item) => item.topic === topic)
    const bounded = Math.max(0, Math.min(1, Number(confidence) || 0))
    if (existing) {
      existing.confidence = bounded
      existing.source = source
      existing.note = note || existing.note
      existing.observations = (existing.observations || 1) + 1
      existing.updatedAt = nowIso()
    } else {
      traits.interests.push({
        topic,
        confidence: bounded,
        source,
        note,
        observations: 1,
        firstSeenAt: nowIso(),
        updatedAt: nowIso(),
      })
    }
    traits.updatedAt = nowIso()
    writeJsonAtomic(this.files.traits, traits)
    this.appendLedger({ kind: 'interest', detail: { topic, confidence: bounded, source } })
    return existing || traits.interests[traits.interests.length - 1]
  }

  recordSkill ({ name, evidence = '', stage = 'learning' } = {}) {
    if (!name || typeof name !== 'string') throw new Error('life/invalid-skill')
    const traits = this.readTraits() || { interests: [], skills: [], habits: [] }
    traits.skills = Array.isArray(traits.skills) ? traits.skills : []
    const existing = traits.skills.find((item) => item.name === name)
    if (existing) {
      existing.stage = stage
      existing.evidence = evidence || existing.evidence
      existing.updates = (existing.updates || 1) + 1
      existing.updatedAt = nowIso()
    } else {
      traits.skills.push({ name, evidence, stage, updates: 1, firstSeenAt: nowIso(), updatedAt: nowIso() })
    }
    traits.updatedAt = nowIso()
    writeJsonAtomic(this.files.traits, traits)
    this.appendLedger({ kind: 'skill', detail: { name, stage } })
    return existing || traits.skills[traits.skills.length - 1]
  }

  /**
   * Relations and commitments are separate from public interaction, so a public
   * post can never read the keeper's private thread.
   */
  rememberPerson ({ name, kind = 'keeper', note = '' } = {}) {
    if (!name || typeof name !== 'string') throw new Error('life/invalid-person')
    const relations = this.readRelations()
    relations.people = Array.isArray(relations.people) ? relations.people : []
    const existing = relations.people.find((item) => item.name === name)
    if (existing) {
      existing.note = note || existing.note
      existing.interactions = (existing.interactions || 0) + 1
      existing.updatedAt = nowIso()
    } else {
      relations.people.push({ name, kind, note, interactions: 1, firstSeenAt: nowIso(), updatedAt: nowIso() })
    }
    relations.updatedAt = nowIso()
    writeJsonAtomic(this.files.relations, relations)
    this.appendLedger({ kind: 'encounter', detail: { name, kind } })
    return existing || relations.people[relations.people.length - 1]
  }

  makeCommitment ({ what, dueAt = null, to = 'keeper' } = {}) {
    if (!what || typeof what !== 'string') throw new Error('life/invalid-commitment')
    const commitments = this.readCommitments()
    commitments.items = Array.isArray(commitments.items) ? commitments.items : []
    const item = {
      id: newId('cmt'),
      what,
      to,
      dueAt,
      status: 'open',
      createdAt: nowIso(),
    }
    commitments.items.push(item)
    // Keep the file bounded; a life can run for years.
    if (commitments.items.length > 200) {
      commitments.items = commitments.items.filter((row) => row.status === 'open').concat(
        commitments.items.filter((row) => row.status !== 'open').slice(-50),
      )
    }
    commitments.updatedAt = nowIso()
    writeJsonAtomic(this.files.commitments, commitments)
    this.appendLedger({ kind: 'commitment', detail: { id: item.id, what, dueAt } })
    return item
  }

  settleCommitment ({ id, status = 'done', evidence = '' } = {}) {
    const commitments = this.readCommitments()
    commitments.items = Array.isArray(commitments.items) ? commitments.items : []
    const item = commitments.items.find((row) => row.id === id)
    if (!item) throw new Error('life/commitment-not-found')
    if (item.status !== 'open') throw new Error('life/commitment-already-settled')
    item.status = status
    item.evidence = evidence
    item.settledAt = nowIso()
    commitments.updatedAt = nowIso()
    writeJsonAtomic(this.files.commitments, commitments)
    this.appendLedger({ kind: 'commitment-settled', detail: { id, status, evidence } })
    return item
  }

  openCommitments () {
    const commitments = this.readCommitments()
    return (commitments.items || []).filter((row) => row.status === 'open')
  }

  /**
   * One main activity at a time, matching the plan's constraint.
   * Evidence is required: a fish may never claim it did something without it.
   */
  startActivity ({ what, why = '', evidence = [] } = {}) {
    if (!what || typeof what !== 'string') throw new Error('life/invalid-activity')
    const activity = this.readActivity()
    if (activity.current) throw new Error('life/activity-already-running')
    const next = {
      id: newId('act'),
      what,
      why,
      evidence: Array.isArray(evidence) ? evidence : [],
      startedAt: nowIso(),
    }
    activity.current = next
    activity.updatedAt = nowIso()
    writeJsonAtomic(this.files.activity, activity)
    this.appendLedger({ kind: 'activity-start', detail: { id: next.id, what, why } })
    return next
  }

  finishActivity ({ outcome = 'done', evidence = [], note = '' } = {}) {
    const activity = this.readActivity()
    if (!activity.current) throw new Error('life/no-activity-running')
    const finished = {
      ...activity.current,
      outcome,
      note,
      evidence: [...(activity.current.evidence || []), ...(Array.isArray(evidence) ? evidence : [])],
      endedAt: nowIso(),
    }
    activity.current = null
    activity.lastFinished = finished
    activity.updatedAt = nowIso()
    writeJsonAtomic(this.files.activity, activity)
    // Evidence belongs in the ledger too: it is the append-only record the day
    // report and any later reconciliation read. It used to be written only to
    // activity.json, so the one durable, ordered trace of what happened dropped
    // the very thing the evidence rule (PLAN.md §3.3) depends on.
    this.appendLedger({
      kind: 'activity-end',
      detail: {
        id: finished.id,
        what: finished.what,
        outcome,
        note,
        evidence: finished.evidence,
      },
    })
    return finished
  }

  /**
   * Append one durable life event.
   *
   * `cap` is honoured lazily: rewriting the whole ledger on every append would
   * make a long-lived fish progressively slower, so trimming happens only once
   * the file has grown well past the cap and then collapses by half.
   */
  appendLedger (entry, { cap = 0 } = {}) {
    const row = { at: nowIso(), lifeId: this.lifeId, ...entry }
    delete row.cap
    appendJsonl(this.files.ledger, row)
    if (cap > 0) {
      try {
        const stats = fs.statSync(this.files.ledger)
        // ~200 bytes per row is a safe over-estimate; only check occasionally.
        if (stats.size > cap * 200 * 2) {
          const rows = readJsonl(this.files.ledger)
          if (rows.length > cap) {
            const kept = rows.slice(-Math.floor(cap / 2))
            const tmp = `${this.files.ledger}.tmp-${process.pid}`
            fs.writeFileSync(tmp, `${kept.map((item) => JSON.stringify(item)).join('\n')}\n`, 'utf8')
            fs.renameSync(tmp, this.files.ledger)
          }
        }
      } catch (err) {
        // Trimming is best-effort; never fail a write because of it.
      }
    }
  }

  readLedger ({ limit = 50, kind = null } = {}) {
    let rows = readJsonl(this.files.ledger)
    if (kind) rows = rows.filter((row) => row.kind === kind)
    if (limit > 0 && rows.length > limit) rows = rows.slice(-limit)
    return rows
  }

  /** Compact, model-facing snapshot. Bounded so it can be injected every turn. */
  snapshot () {
    const identity = this.readIdentity()
    const traits = this.readTraits() || { interests: [], skills: [] }
    const activity = this.readActivity()
    const open = this.openCommitments()
    const wake = this.readWake()
    const interests = (traits.interests || [])
      .slice()
      .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
      .slice(0, 5)
      .map((item) => `${item.topic}(${Math.round((item.confidence || 0) * 100)}%)`)
    const skills = (traits.skills || []).slice(-5).map((item) => `${item.name}:${item.stage}`)
    return {
      lifeId: this.lifeId,
      name: identity ? identity.name : 'unknown',
      identityRevision: identity ? identity.revision : 0,
      species: identity ? identity.species : 'unknown',
      seeds: identity ? identity.seeds : [],
      currentActivity: activity.current ? activity.current.what : null,
      currentActivityWhy: activity.current ? activity.current.why : null,
      interests,
      skills,
      openCommitments: open.slice(0, 5).map((row) => ({ id: row.id, what: row.what, dueAt: row.dueAt })),
      // Kept deliberately tiny: the snapshot is injected every turn.
      nextWakeAt: wake.nextAt,
      wakeCountToday: wake.dayKey === dayKeyOf(new Date()) ? wake.countToday : 0,
    }
  }
}
