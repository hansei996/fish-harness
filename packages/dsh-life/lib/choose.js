/**
 * Activity chooser for dsh-life — pure ranking math, no IO.
 *
 * docs/PLAN.md §6.2 gives the one formula this layer must own:
 *
 *   priority = commitment urgency + interest match + unfinished value
 *              + moderate exploration - cost - risk - switching cost
 *
 * The point is not to quantify feelings; it is to keep a life from waking up
 * with no idea what it could do, and to make every suggestion explainable
 * enough that the keeper can ask "why this one". So each candidate carries the
 * weighted `parts` that produced its score and a one-sentence Chinese reason.
 *
 * Rest is a first-class candidate, never a fallback: §6.2 explicitly allows
 * rest, inaction and stopping so a life does not manufacture events to look
 * alive. It has a fixed, honest score and is appended to every shortlist even
 * when many activity candidates outscore it.
 *
 * Everything here is deterministic: `now` is injectable and no randomness is
 * used, so a temporary test can assert exact numbers.
 */

const DAY_MS = 24 * 60 * 60 * 1000

/** Fixed score of "rest / do nothing". Lower than a real pull, higher than noise. */
export const REST_CANDIDATE_SCORE = 0.35

/** Hard cap for the wake-turn shortlist: it is paid for on every wake. */
export const WAKE_SHORTLIST_MAX_CHARS = 600

/**
 * Weights applied to the 0..1 raw terms before subtracting costs. Positive
 * terms can exceed 1 in total; the final score is clamped. The weights are
 * exported so the README and tests can point at the same numbers instead of
 * duplicating magic values.
 */
export const CHOOSER_WEIGHTS = Object.freeze({
  commitment: 0.55,
  interest: 0.55,
  unfinished: 0.55,
  explore: 0.12,
  cost: 0.4,
  risk: 0.2,
  switch: 0.25,
})

/** Base complexity of a candidate kind, before the wake-budget penalty. */
const COST_BASE = Object.freeze({
  continue: 0.05,
  retry: 0.18,
  next: 0.12,
  commitment: 0.2,
  interest: 0.1,
  skill: 0.25,
  rest: 0,
})

/** How risky it is to spend a wake on this kind of candidate. */
const RISK_BASE = Object.freeze({
  continue: 0.04,
  retry: 0.12,
  next: 0.08,
  commitment: 0.05,
  interest: 0.15,
  skill: 0.1,
  rest: 0,
})

/** Honest practice level → how much unfinished business it represents. */
const SKILL_STAGE_VALUE = Object.freeze({
  learning: 0.55,
  practicing: 0.8,
  competent: 0.45,
})

const SKILL_STAGE_LABEL = Object.freeze({
  learning: '刚起步',
  practicing: '练习中',
  competent: '已经能上手',
})

const MAX_COMMITMENT_CANDIDATES = 4
const MAX_INTEREST_CANDIDATES = 3
const MAX_SKILL_CANDIDATES = 2

const KIND_ORDER = ['continue', 'retry', 'next', 'commitment', 'interest', 'skill', 'rest']

// ---------------------------------------------------------------------------
// Individual terms
// ---------------------------------------------------------------------------

/**
 * Commitment urgency in 0..1.
 *
 * Overdue is the maximum. A due date is read as "end of that local day" when
 * it is a bare `YYYY-MM-DD`, because a promise due "today" is not late at
 * lunchtime. A commitment without a date still gets a small floor: forgetting
 * it forever because it was written down vaguely would be the wrong lesson.
 */
export function urgencyOf (commitment, now = Date.now()) {
  const at = toMillis(now)
  const due = dueTimeOf(commitment && commitment.dueAt)
  if (due === null) return 0.15
  const days = (due - at) / DAY_MS
  if (days < 0) return 1
  if (days <= 7) return clamp01(0.95 - (days / 7) * 0.55)
  // Long-dated promises fade, but never below the no-date floor + a little.
  return clamp01(Math.max(0.2, 0.4 - ((days - 7) / 60) * 0.2))
}

/** How much a low-observation interest deserves one more look (0..0.15). */
export function explorationBonusOf (interest) {
  const observations = Number.isInteger(interest && interest.observations)
    ? interest.observations
    : 0
  return observations <= 2 ? 0.15 : 0
}

/**
 * Interest match in 0..1: confidence decayed by staleness, plus a small
 * exploration bonus. Freshness has a floor (0.45) because a long-loved topic
 * does not become worthless just because it was not touched for a month.
 */
export function interestScore (interest, now = Date.now()) {
  const at = toMillis(now)
  const confidence = clamp01(numberOf(interest && interest.confidence))
  const updated = Date.parse(interest && interest.updatedAt)
  const ageDays = Number.isFinite(updated) ? Math.max(0, (at - updated) / DAY_MS) : 45
  const freshness = Math.max(0.45, 1 - (ageDays / 45) * 0.55)
  return clamp01(confidence * freshness + explorationBonusOf(interest))
}

/**
 * Value of unfinished business in 0..1: a recorded `next` step or a failed
 * last attempt is worth continuing; a completed last activity is not.
 */
export function unfinishedScore (activity) {
  if (!activity || typeof activity !== 'object') return 0
  const next = activity.next
  if (next && (typeof next === 'string' ? next.trim() : next.what)) return 0.75
  const last = activity.lastFinished
  if (!last || typeof last !== 'object') return 0
  if (last.outcome === 'failed') return 0.9
  if (last.outcome === 'abandoned') return 0.35
  if (last.outcome === 'done') return 0.15
  return 0.2
}

/**
 * Switching cost in 0..1. Continuing the same activity is free; starting a
 * different one while something is running is expensive. Rest is deliberately
 * free: it is the safe option, and its score is fixed anyway (see
 * `REST_CANDIDATE_SCORE`).
 */
export function switchCost (current, candidate) {
  // Accept either the live activity (`{ what }`) or the whole activity state
  // (`{ current: { what } }`): both are natural at call sites, and confusing
  // them must not silently make switching free.
  const active = current && typeof current === 'object' && current.current
    ? current.current
    : current
  if (!active || typeof active !== 'object' || !active.what) return 0
  const kind = candidate && typeof candidate === 'object' ? candidate.kind : null
  const what = candidate && typeof candidate === 'object' ? candidate.what : candidate
  if (kind === 'rest') return 0
  if (kind === 'continue' || what === active.what) return 0
  return 1
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

/**
 * Rank everything this life could do right now.
 *
 * @param {object} input
 * @param {Date|number|string} [input.now] - injectable clock
 * @param {Array|{items:Array}} [input.commitments] - open commitments
 * @param {Array|{interests:Array}} [input.interests]
 * @param {Array|{skills:Array}} [input.skills]
 * @param {object} [input.activity] - `{ current, next, lastFinished }`
 * @param {{countToday?:number,maxPerDay?:number,remaining?:number}} [input.wakeBudget]
 * @returns {{candidates:Array,rest:object,notes:string[]}} sorted strongest first,
 *   always containing the rest candidate; `notes` explains global context.
 */
export function rankCandidates ({
  now = Date.now(),
  commitments,
  interests,
  skills,
  activity,
  wakeBudget,
} = {}) {
  const at = toMillis(now)
  const budget = wakeBudgetOf(wakeBudget)
  const current = activity && typeof activity === 'object' && activity.current
    ? activity.current
    : null
  const notes = []
  const raw = []

  const make = (spec) => {
    const candidate = buildCandidate(spec, current, budget)
    if (candidate) raw.push(candidate)
  }

  // 1. Continue what is already running: one main activity at a time, and
  // finishing is cheaper than starting over.
  if (current && typeof current.what === 'string' && current.what.trim()) {
    make({
      what: current.what,
      kind: 'continue',
      raw: { unfinished: 0.8, risk: RISK_BASE.continue },
      reason: `「${current.what}」还没结束，做完它比换一件事更省力`,
      evidence: continuationEvidence(current),
    })
    notes.push(`进行中的活动「${current.what}」还没结束：换活动的切换损耗已计入其他候选`)
  }

  // 2. Unfinished business: a recorded next step, or a failed attempt.
  if (!current) {
    const unfinished = unfinishedFrom(activity)
    if (unfinished) {
      make({
        what: unfinished.what,
        kind: unfinished.kind,
        raw: { unfinished: unfinishedScore(activity), risk: RISK_BASE[unfinished.kind] },
        reason: unfinished.reason,
        evidence: unfinished.evidence,
      })
      notes.push(unfinished.note)
    }
  }

  // 3. Open commitments, most urgent first.
  const openCommitments = listOf(commitments, 'items')
    .filter((item) => item && typeof item === 'object' && typeof item.what === 'string' && item.what.trim())
    .filter((item) => item.status === undefined || item.status === 'open')
    .sort((a, b) => urgencyOf(b, at) - urgencyOf(a, at))
    .slice(0, MAX_COMMITMENT_CANDIDATES)
  for (const commitment of openCommitments) {
    make({
      what: commitment.what,
      kind: 'commitment',
      raw: { commitment: urgencyOf(commitment, at), risk: RISK_BASE.commitment },
      reason: commitmentReason(commitment, at),
      evidence: commitmentEvidence(commitment),
    })
  }
  if (openCommitments.length === 0) notes.push('没有未结的承诺')

  // 4. Interests, strongest and freshest first. Exploration is split out so the
  // tool can show why an only-twice-observed topic still made the list.
  const interestCandidates = listOf(interests, 'interests')
    .filter((item) => item && typeof item === 'object' && typeof item.topic === 'string' && item.topic.trim())
    .filter((item) => numberOf(item.confidence) > 0)
    .map((item) => ({ item, score: interestScore(item, at) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_INTEREST_CANDIDATES)
  for (const { item, score } of interestCandidates) {
    const exploration = explorationBonusOf(item)
    const base = clamp01(score - exploration)
    const observations = Number.isInteger(item.observations) ? item.observations : 0
    make({
      what: `看看「${item.topic}」的更新`,
      kind: 'interest',
      raw: {
        interest: base,
        explore: exploration,
        risk: RISK_BASE.interest + (observations <= 1 ? 0.2 : 0),
      },
      reason: interestReason(item, observations),
      evidence: interestEvidence(item),
    })
  }

  // 5. Skills worth practicing. A skill record without evidence is still a
  // lead, not a claim of competence; the candidate only proposes practice.
  const skillCandidates = listOf(skills, 'skills')
    .filter((item) => item && typeof item === 'object' && typeof item.name === 'string' && item.name.trim())
    .map((item) => ({ item, value: SKILL_STAGE_VALUE[item.stage] ?? 0.3 }))
    .sort((a, b) => b.value - a.value)
    .slice(0, MAX_SKILL_CANDIDATES)
  for (const { item, value } of skillCandidates) {
    make({
      what: `练一练「${item.name}」`,
      kind: 'skill',
      raw: {
        unfinished: value,
        explore: item.stage === 'learning' ? 0.5 : 0,
        risk: RISK_BASE.skill,
      },
      reason: skillReason(item),
      evidence: skillEvidence(item),
    })
  }

  // 6. Rest is always one of the candidates, whatever the scores are.
  const rest = restCandidate(budget, current)

  // Same activity must not appear twice under two kinds; the stronger framing
  // wins, and the loser's reason is still represented in `notes`.
  const byWhat = new Map()
  for (const candidate of raw) {
    const previous = byWhat.get(candidate.what)
    if (!previous || candidate.score > previous.score) byWhat.set(candidate.what, candidate)
  }
  const candidates = [...byWhat.values(), rest].sort(compareCandidates)

  if (budget.remaining <= 1) {
    notes.push(`今天只剩 ${budget.remaining} 次唤醒额度：新活动的成本已上调，收尾或休息更合适`)
  }
  if (candidates.length === 1) {
    notes.push('当前没有可排的活动：休息是唯一诚实的选择')
  }

  return { candidates, rest, notes }
}

// ---------------------------------------------------------------------------
// Model-facing shortlist
// ---------------------------------------------------------------------------

/**
 * Pick the entries a wake turn is allowed to show: `topN` activity candidates
 * (already ranked) plus rest, always last. This is the same function the
 * `life_candidates` tool uses, so the prompt and the tool cannot disagree.
 */
export function shortlistCandidates (candidates, topN = 3) {
  const list = Array.isArray(candidates) ? candidates.filter(Boolean) : []
  const rest = list.find((candidate) => candidate.kind === 'rest') || null
  const limit = clampTopN(topN)
  const activities = list.filter((candidate) => candidate.kind !== 'rest').slice(0, limit)
  return rest ? [...activities, rest] : activities
}

/**
 * Render the bounded wake-turn shortlist.
 *
 * The length guarantee matters more than completeness: this text is paid on
 * every wake, and a truncated tail is cheaper than an unbounded prompt. Rest is
 * reserved first, then activity lines are added until the cap is reached; a
 * pathological reason is clipped rather than allowed to blow the budget.
 */
export function renderWakeCandidates ({
  candidates,
  topN = 3,
  maxChars = WAKE_SHORTLIST_MAX_CHARS,
} = {}) {
  const limit = Number.isInteger(maxChars) && maxChars >= 80 ? maxChars : WAKE_SHORTLIST_MAX_CHARS
  const picked = shortlistCandidates(candidates, topN)
  if (picked.length === 0) return ''
  const rest = picked[picked.length - 1]
  const activities = picked.slice(0, -1)
  const header = '你现在可以做的事（按你自己的历史排的，不是命令）：'

  const restLine = (number) => `${number}. ${clip(rest.what, 40)} —— ${clip(rest.reason, 90)}`
  const activityLines = (list) => list.map((candidate, index) => (
    `${index + 1}. ${clip(candidate.what, 40)} —— ${clip(candidate.reason, 90)}`
  ))

  let kept = activities.slice()
  let lines = []
  for (;;) {
    lines = activityLines(kept)
    lines.push(restLine(kept.length + 1))
    const text = [header, ...lines].join('\n')
    if (text.length <= limit || kept.length === 0) break
    kept = kept.slice(0, -1)
  }

  let text = [header, ...lines].join('\n')
  if (text.length <= limit) return text

  // Even header + rest alone overflow: shorten the rest reason, keep rest.
  const prefix = `1. ${clip(rest.what, 40)} —— `
  const room = Math.max(0, limit - header.length - 1 - prefix.length)
  text = `${header}\n${prefix}${clip(rest.reason, room)}`
  return text.length <= limit ? text : text.slice(0, limit)
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function buildCandidate (spec, current, budget) {
  const kind = spec.kind
  if (!spec.what || typeof spec.what !== 'string' || !spec.what.trim()) return null
  const risk = clamp01(spec.raw.risk ?? RISK_BASE[kind] ?? 0)
  const cost = clamp01((COST_BASE[kind] ?? 0.2) + budgetPenalty(kind, budget.remaining))
  const switchRaw = switchCost(current, { what: spec.what, kind })
  const parts = {
    commitment: r3(clamp01(spec.raw.commitment ?? 0) * CHOOSER_WEIGHTS.commitment),
    interest: r3(clamp01(spec.raw.interest ?? 0) * CHOOSER_WEIGHTS.interest),
    unfinished: r3(clamp01(spec.raw.unfinished ?? 0) * CHOOSER_WEIGHTS.unfinished),
    explore: r3(clamp01(spec.raw.explore ?? 0) * CHOOSER_WEIGHTS.explore),
    cost: r3(cost * CHOOSER_WEIGHTS.cost),
    risk: r3(risk * CHOOSER_WEIGHTS.risk),
    switch: r3(switchRaw * CHOOSER_WEIGHTS.switch),
  }
  const score = r3(clamp01(
    parts.commitment + parts.interest + parts.unfinished + parts.explore -
    parts.cost - parts.risk - parts.switch,
  ))
  return {
    what: spec.what,
    kind,
    score,
    parts,
    reason: spec.reason || '',
    evidence: normalizeEvidence(spec.evidence),
  }
}

function restCandidate (budget, current) {
  const progress = `${budget.countToday}/${budget.maxPerDay}`
  let reason
  if (current) {
    reason = `今天已经醒过 ${progress} 次；选休息会先暂停「${current.what}」，但它不会被丢掉`
  } else if (budget.remaining <= 1) {
    reason = `今天已经醒过 ${progress} 次，只剩最后一次；现在休息是合理的选择，不是偷懒`
  } else {
    reason = `今天已经醒过 ${progress} 次；休息也是允许的选择，没必要时时制造活动`
  }
  return {
    what: '休息，什么都不做',
    kind: 'rest',
    score: REST_CANDIDATE_SCORE,
    parts: { commitment: 0, interest: 0, unfinished: 0, explore: 0, cost: 0, risk: 0, switch: 0 },
    reason,
    evidence: ['休息不需要证据：它不是一项成就，而是一个允许的选择'],
  }
}

function unfinishedFrom (activity) {
  if (!activity || typeof activity !== 'object') return null
  const next = activity.next
  if (next && (typeof next === 'string' ? next.trim() : next.what)) {
    const what = typeof next === 'string' ? next : next.what
    return {
      what: `接着做「${what}」`,
      kind: 'next',
      reason: `你已经把下一步记成「${what}」，接着做不用重新热身`,
      evidence: nextEvidence(next),
      note: `记录了一个下一步：「${what}」`,
    }
  }
  const last = activity.lastFinished
  if (!last || typeof last !== 'object' || !last.what) return null
  if (last.outcome !== 'failed' && last.outcome !== 'abandoned') return null
  const verb = last.outcome === 'failed' ? '失败了' : '中止了'
  const note = typeof last.note === 'string' && last.note.trim() ? `：${clip(last.note.trim(), 40)}` : ''
  return {
    what: `再试一次「${last.what}」`,
    kind: 'retry',
    reason: `上一次「${last.what}」${verb}${note}，再试一次比开新坑有价值`,
    evidence: Array.isArray(last.evidence) && last.evidence.length
      ? last.evidence.slice()
      : ['上次活动没有留下证据，只有结果记录'],
    note: `上一次活动「${last.what}」${verb}，还没有解决`,
  }
}

function commitmentReason (commitment, now) {
  const due = dueTimeOf(commitment.dueAt)
  if (due === null) {
    return `「${commitment.what}」没有写截止日期，但它还欠着；挑一件了结比开新坑踏实`
  }
  const delta = due - now
  if (delta < 0) {
    const lateDays = Math.max(1, Math.ceil(-delta / DAY_MS))
    return `「${commitment.what}」已经逾期 ${lateDays} 天，先把它处理掉`
  }
  const days = Math.ceil(delta / DAY_MS)
  if (days <= 1) return `「${commitment.what}」今天到期，先把它处理掉`
  return `「${commitment.what}」还有约 ${days} 天到期，可以提前做`
}

function commitmentEvidence (commitment) {
  const who = commitment.to ? `对 ${commitment.to}` : '没有记录对谁'
  const due = commitment.dueAt ? `，截止 ${commitment.dueAt}` : '，没有截止日期'
  const id = commitment.id ? `#${commitment.id}` : ''
  return [`承诺${id}（${who}）${due}`]
}

function interestReason (interest, observations) {
  const confidence = formatNumber(interest.confidence)
  if (observations <= 2) {
    return `你对「${interest.topic}」的置信度是 ${confidence}，但只观察过 ${observations} 次，值得多看一眼`
  }
  return `你对「${interest.topic}」的置信度是 ${confidence}，已经观察过 ${observations} 次，可以继续`
}

function interestEvidence (interest) {
  const observations = Number.isInteger(interest.observations) ? interest.observations : 0
  const source = interest.source ? `，来源 ${interest.source}` : ''
  const line = `兴趣记录：「${interest.topic}」置信度 ${formatNumber(interest.confidence)}，观察 ${observations} 次${source}`
  return interest.note ? [line, `备注：${clip(String(interest.note), 60)}`] : [line]
}

function skillReason (skill) {
  const label = SKILL_STAGE_LABEL[skill.stage] || '有记录'
  return `技能「${skill.name}」${label}，练一次能留下证据；只记不练它就还是纸上的`
}

function skillEvidence (skill) {
  const stage = SKILL_STAGE_LABEL[skill.stage] || skill.stage || '未记录'
  const evidence = typeof skill.evidence === 'string' && skill.evidence.trim()
    ? `，证据 ${clip(skill.evidence.trim(), 60)}`
    : '，暂无证据'
  return [`技能记录：「${skill.name}」${stage}${evidence}`]
}

function continuationEvidence (current) {
  const started = current.startedAt ? `（开始于 ${current.startedAt}）` : ''
  const id = current.id ? ` ${current.id}` : ''
  const list = [`进行中的活动${id}${started}`]
  if (Array.isArray(current.evidence) && current.evidence.length) list.push(...current.evidence)
  return list
}

function nextEvidence (next) {
  if (next && typeof next === 'object' && Array.isArray(next.evidence) && next.evidence.length) {
    return next.evidence.slice()
  }
  return ['activity.next 里记录的下一步']
}

/** Empty evidence must say so honestly instead of implying proof. */
function normalizeEvidence (evidence) {
  const list = Array.isArray(evidence)
    ? evidence.filter((item) => item !== undefined && item !== null && String(item).trim())
    : []
  return list.length ? list.map(String) : ['无证据，只是想法']
}

function budgetPenalty (kind, remaining) {
  // Cheap continuation and rest are exempt: the point is to stop opening new
  // large activities when only a wake or two is left today.
  if (kind === 'continue' || kind === 'rest') return 0
  if (remaining <= 1) return 0.55
  if (remaining === 2) return 0.25
  return 0
}

function wakeBudgetOf (input) {
  const value = input && typeof input === 'object' ? input : {}
  const maxPerDay = Number.isInteger(value.maxPerDay) && value.maxPerDay > 0 ? value.maxPerDay : 6
  const rawCount = Number(value.countToday)
  const countToday = Number.isFinite(rawCount) ? Math.max(0, Math.floor(rawCount)) : 0
  const rawRemaining = Number(value.remaining)
  const remaining = Number.isFinite(rawRemaining)
    ? Math.max(0, Math.floor(rawRemaining))
    : Math.max(0, maxPerDay - countToday)
  return { countToday, maxPerDay, remaining }
}

/** Due instant. A bare `YYYY-MM-DD` means the end of that local day. */
function dueTimeOf (value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string' || !value.trim()) return null
  const text = value.trim()
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (dateOnly) {
    const date = new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]), 23, 59, 59, 999)
    return Number.isNaN(date.getTime()) ? null : date.getTime()
  }
  const parsed = Date.parse(text)
  return Number.isFinite(parsed) ? parsed : null
}

function listOf (value, key) {
  if (Array.isArray(value)) return value
  if (value && typeof value === 'object' && Array.isArray(value[key])) return value[key]
  return []
}

function compareCandidates (a, b) {
  if (b.score !== a.score) return b.score - a.score
  const kindDiff = KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)
  if (kindDiff !== 0) return kindDiff
  if (a.what === b.what) return 0
  return a.what < b.what ? -1 : 1
}

function clampTopN (value) {
  const number = Number(value)
  if (!Number.isInteger(number)) return 3
  return Math.min(5, Math.max(1, number))
}

function toMillis (value) {
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return Date.now()
}

function numberOf (value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

/** Trim to at most `limit` characters, marking the cut with an ellipsis. */
function clip (text, limit) {
  const value = String(text ?? '')
  const max = Math.max(0, Math.floor(limit))
  if (value.length <= max) return value
  if (max <= 1) return '…'.slice(0, max)
  return `${value.slice(0, max - 1)}…`
}

function formatNumber (value) {
  const number = numberOf(value)
  return String(Math.round(number * 100) / 100)
}

function clamp01 (value) {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

function r3 (value) {
  return Math.round(clamp01(value) * 1000) / 1000
}
