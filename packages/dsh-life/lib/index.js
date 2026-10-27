import { LifeStore, resolveDshHome } from './store.js'
import { ConfigSchema, ConfigDefaults } from './config.js'
import { CHOOSER_WEIGHTS, rankCandidates, renderWakeCandidates, shortlistCandidates } from './choose.js'
import {
  dayKeyOf,
  isQuietAt,
  MIN_WAKE_DELAY_MS,
  msUntilNextDayWake,
  nextWakeDelayMs,
} from './wake.js'

/**
 * dsh-life — the digital-life layer for DeepSeek Harness.
 *
 * What this plugin deliberately does NOT do: it does not reimplement
 * persistence, goals, scheduling, background jobs, approval, or sandboxing.
 * dsh already owns all of those (core/session, goal, schedule, jobs, approval,
 * sandbox) and rebuilding them would be the duplicated effort this product is
 * specifically meant to avoid.
 *
 * What it adds is the one thing dsh has no concept of: a *life* that outlives
 * any single session — a versioned identity, slow/medium/fast state variables,
 * relationships, commitments, and an evidence-backed activity ledger.
 *
 * Integration points (all public; dsh's architecture states "there is no
 * privileged core to patch"):
 *   - ctx.tools.register        → life_* tools the model can call
 *   - ctx.systemPrompt.section  → bounded per-turn life context
 *   - ctx.schedule              → durable wake-ups, routed through dsh instead
 *                                 of a private setInterval that dies with the
 *                                 session (the exact failure `schedule` and the
 *                                 community dsh-proactive plugin exist to fix)
 *   - ctx.on('session/event')   → observe what actually happened, so the ledger
 *                                 records facts rather than model claims
 *
 * The module intentionally has zero own dependencies: it is installed into a
 * profile whose resolution roots differ between the npm CLI and the bundled
 * Electron runtime, so it must load with nothing but Node built-ins.
 */

export const name = 'dsh-life'

/** dsh services we consume. All are optional so a partial profile still boots. */
export const inject = []

/** Cordis validates this through Standard Schema; see lib/config.js. */
export const Config = ConfigSchema

const SECTION_NAME = 'dsh-life:identity'
const SECTION_ORDER = 450 // after the deployment persona, before tool guidance

const IDENTITY_FIELDS_REQUIRING_KEEPER = ['name', 'species', 'seeds', 'coreCharacter']

/**
 * Title of the alarm this plugin owns in dsh's Host schedule table. dsh's
 * `create` never de-duplicates, so "one alarm per life" is enforced by listing
 * first and matching on this title (or the id we remembered in wake.json).
 */
const WAKE_TITLE = '自主唤醒'

export function apply (root, config = {}) {
  const settings = { ...ConfigDefaults, ...(config || {}) }
  const store = new LifeStore({ lifeId: settings.lifeId })

  if (settings.autoCreate) {
    try {
      store.ensure({ name: settings.name, species: settings.species, seeds: settings.seeds })
    } catch (err) {
      warn(root, `could not create life: ${messageOf(err)}`)
    }
  }

  const disposers = []

  // ---- 0. Optional schedule seam ------------------------------------------
  // `schedule` is deliberately not in the module-level `inject`: a partial
  // (headless) profile must still boot and keep its identity. This callback
  // fires whenever the service becomes available; `getService()` also accepts
  // a service that was already provided before the callback ran.
  const wakeRuntime = {
    service: null,
    turns: new Set(),
    loggedNoService: false,
    chain: Promise.resolve(),
    getService () {
      if (this.service) return this.service
      try {
        const candidate = typeof root.get === 'function' ? root.get('schedule') : undefined
        if (candidate && typeof candidate.create === 'function') this.service = candidate
      } catch (err) {}
      return this.service
    },
    warn (text) { warn(root, text) },
    infoNoService () {
      if (this.loggedNoService) return
      this.loggedNoService = true
      info(root, '这个 profile 没有 schedule 服务，自主唤醒不会开启')
    },
    scheduleArm (sessionId) {
      this.chain = this.chain
        .then(() => armWake(this, settings, store, sessionId))
        .catch(() => {})
    },
  }

  try {
    root.inject(['schedule'], (ctx) => {
      try {
        if (ctx && ctx.schedule && typeof ctx.schedule.create === 'function') {
          wakeRuntime.service = ctx.schedule
        }
      } catch (err) {
        // Never warn during apply: a missing wake-up path is a degradation, not
        // an activation failure (verify/smoke asserts a warning-free apply).
      }
    })
  } catch (err) {
    // A context that cannot inject at all (tests, partial profiles) is fine.
  }

  // ---- 1. Model-facing life tools -----------------------------------------
  root.inject(['tools'], (ctx) => {
    for (const definition of buildTools(store, settings, wakeRuntime)) {
      try {
        disposers.push(ctx.tools.register(definition))
      } catch (err) {
        warn(root, `failed to register ${definition.name}: ${messageOf(err)}`)
      }
    }
  })

  // ---- 2. Bounded per-turn life context -----------------------------------
  // A registered section composes with whatever persona the profile already
  // has, instead of replacing the system prompt.
  if (settings.injectContext) {
    root.inject(['systemPrompt'], (ctx) => {
      try {
        disposers.push(ctx.systemPrompt.section({
          name: SECTION_NAME,
          order: SECTION_ORDER,
          text: (context) => {
            try {
              const woke = isWakeTurn(context, wakeRuntime.turns)
              const base = renderLifeContext(store.snapshot(), { woke })
              // The shortlist is a wake-only cost: a normal keeper turn must not
              // pay for candidate ranking it will not use.
              if (!woke || !settings.chooserEnabled) return base
              const shortlist = renderWakeShortlist(store, settings)
              return shortlist ? `${base}\n\n${shortlist}` : base
            } catch (err) {
              // A life-context failure must never fail a turn.
              return ''
            }
          },
        }))
      } catch (err) {
        warn(root, `could not register prompt section: ${messageOf(err)}`)
      }
    })
  }

  // ---- 3. Observe real events into the ledger -----------------------------
  // Kept deliberately cheap: this runs on every session event, so it records
  // only durable boundaries and never inspects message content.
  //
  // The event shape is dsh's durable SessionEvent — `{ type, seq, time, data }`
  // — not `{ kind }`; a wrong field name here fails silently, which is why the
  // e2e probe asserts that a real turn reaches the ledger.

  // 3a. Learn that this turn is a wake-up BEFORE its prompt is assembled.
  // dsh appends the schedule `user/message` during the step, i.e. after the
  // system prompt for that step was already assembled, so the durable event
  // alone cannot label the prompt of the very turn that woke the life.
  // `agent/inbox/claimed` fires when the loop claims the message, before
  // assembly (see docs/dsh-schedule-api.md §5 and dsh-agent-loop source).
  try {
    disposers.push(root.on('agent/inbox/claimed', (payload) => {
      try {
        const agent = payload && payload.agent
        const message = payload && payload.message
        const sessionId = agent && agent.session && typeof agent.session.id === 'string'
          ? agent.session.id
          : null
        if (!sessionId || !message || typeof message !== 'object') return
        const source = message.source
        if (source && source.kind === 'schedule') wakeRuntime.turns.add(sessionId)
        else wakeRuntime.turns.delete(sessionId)
      } catch (err) {
        // Agent dispatch is optional; the session-event path still records wakes.
      }
    }))
  } catch (err) {
    // No agent dispatch in this runtime: degrade, never fail.
  }

  // 3b. Durable record of what actually happened, plus re-arming.
  try {
    disposers.push(root.on('session/event', (session, event) => {
      try {
        if (!event || typeof event !== 'object') return
        const sessionId = session && typeof session.id === 'string' ? session.id : null

        if (event.type === 'user/message') {
          const message = event.data
          if (!message || typeof message !== 'object') return
          const source = message.source
          // The keeper speaking is `kind: 'user'`; only a schedule delivery is a wake.
          if (!source || source.kind !== 'schedule' || !sessionId) return
          wakeRuntime.turns.add(sessionId)
          const messageId = typeof message.id === 'string' ? message.id : null
          const at = typeof event.time === 'number' ? event.time : Date.now()
          // Idempotent by messageId: dsh does not guarantee exactly-once delivery.
          const noted = store.noteWake({ sessionId, messageId, at })
          if (noted.counted) {
            store.appendLedger(
              { kind: 'wake', detail: { messageId, sessionId } },
              { cap: settings.maxLedgerEntries },
            )
          }
          return
        }

        if (event.type !== 'turn/end') return
        const data = event.data && typeof event.data === 'object' ? event.data : {}
        const woke = sessionId ? wakeRuntime.turns.delete(sessionId) : false
        store.appendLedger(
          {
            kind: 'turn',
            detail: {
              sessionId,
              turn: typeof data.turn === 'number' ? data.turn : null,
              // Only the reason kind is recorded: the full reason can carry
              // provider error text, which does not belong in a life ledger.
              reason: data.reason && typeof data.reason === 'object' ? data.reason.kind || null : null,
              woke,
            },
          },
          { cap: settings.maxLedgerEntries },
        )

        if (!settings.wakeEnabled || !sessionId) return

        // A life wakes in exactly one place. Bind the first non-subagent
        // session it observes and never move the binding afterwards.
        if (!isSubagentSession(session)) {
          const wake = store.readWake()
          if (!wake.sessionId) {
            try { store.updateWake({ sessionId }) } catch (err) {}
          }
        }

        // The composition may simply not carry `schedule` (headless profile).
        // Say it once with info, never with warn.
        if (!wakeRuntime.getService()) {
          wakeRuntime.infoNoService()
          return
        }
        // Re-arm after every turn: keeper turn and wake turn alike.
        wakeRuntime.scheduleArm(sessionId)
      } catch (err) {
        // Observation must never break a session.
      }
    }))
  } catch (err) {
    warn(root, `could not observe session events: ${messageOf(err)}`)
  }

  root.effect(() => () => {
    for (const dispose of disposers) {
      try { dispose() } catch (err) {}
    }
  })

  info(root, `life "${settings.name}" at ${resolveDshHome()}/life/${settings.lifeId}`)
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

function buildTools (store, settings, wakeRuntime) {
  const tools = []

  tools.push(tool({
    name: 'life_whoami',
    description: 'Read your current life state: identity revision, interests, skills, current activity, and open commitments. Call this when you need to remember who you are and what you were doing.',
    parameters: {},
    execute: async () => store.snapshot(),
  }))

  tools.push(tool({
    name: 'life_start_activity',
    description: 'Begin one main activity. Only one activity may run at a time. Give the reason it follows from your interests, commitments, or yesterday — not a bare label.',
    parameters: {
      what: { type: 'string', required: true, description: 'What you are about to do' },
      why: { type: 'string', description: 'Why this follows from your past' },
      evidence: { type: 'array', items: { type: 'string' }, description: 'Evidence you already hold, such as a save file or a link' },
    },
    required: ['what'],
    execute: async (args) => store.startActivity(args),
  }))

  tools.push(tool({
    name: 'life_finish_activity',
    description: 'Finish the current activity with its real outcome and evidence. Evidence is required to support a claim of success; never report a win without it.',
    parameters: {
      outcome: { type: 'string', enum: ['done', 'failed', 'abandoned'], required: true, description: 'How it actually ended' },
      evidence: { type: 'array', items: { type: 'string' }, description: 'Concrete evidence: save file, score, screenshot path, URL' },
      note: { type: 'string', description: 'What you learned or what went wrong' },
      next: {
        type: 'object',
        description: 'What you intend to do next, if anything — the hand-off to your next wake-up. This is what makes tomorrow continuous instead of a fresh start. Ends the activity either way.',
        properties: {
          what: { type: 'string', description: 'The next concrete step, e.g. 换成 SPI 再试一次' },
          why: { type: 'string', description: 'Why this is the right next step' },
        },
      },
    },
    required: ['outcome'],
    execute: async (args) => {
      // A failed attempt that leaves no next step is a dead end the life cannot
      // resume; the whole point of recording a failure is the retry it implies.
      const next = args.next || (args.outcome === 'failed'
        ? { what: `换个打法再试一次「${store.readActivity().current?.what || '刚失败的那件事'}」`, why: '上次没成，原因记在 note 里' }
        : null)
      return store.finishActivity({ ...args, next })
    },
  }))

  tools.push(tool({
    name: 'life_note_interest',
    description: 'Record or update an interest. Confidence should grow through repeated genuine encounters, not from a single page you skimmed.',
    parameters: {
      topic: { type: 'string', required: true, description: 'The interest' },
      confidence: { type: 'number', description: 'Between 0 and 1; raise it only when the interest was actually pursued' },
      source: { type: 'string', description: 'Where it came from, such as experience, browsing, or the keeper' },
      note: { type: 'string', description: 'Short context' },
    },
    required: ['topic'],
    execute: async (args) => store.recordInterest(args),
  }))

  tools.push(tool({
    name: 'life_note_skill',
    description: 'Record progress on a skill, such as a route in a game or a working approach for a tool. The stage must be your honest level, backed by evidence.',
    parameters: {
      name: { type: 'string', required: true, description: 'The skill' },
      stage: { type: 'string', enum: ['learning', 'practicing', 'competent'], required: true, description: 'Honest current level' },
      evidence: { type: 'string', description: 'What backs this level' },
    },
    required: ['name', 'stage'],
    execute: async (args) => store.recordSkill(args),
  }))

  tools.push(tool({
    name: 'life_promise',
    description: 'Make a commitment to someone. Commitments are what make your future behaviour causally connected to your past.',
    parameters: {
      what: { type: 'string', required: true, description: 'What you promised' },
      to: { type: 'string', description: 'Who you promised; defaults to the keeper' },
      dueAt: { type: 'string', description: 'ISO date when the promise is time-bound' },
    },
    required: ['what'],
    execute: async (args) => store.makeCommitment(args),
  }))

  tools.push(tool({
    name: 'life_settle_commitment',
    description: 'Mark a commitment done or dropped, with the evidence that settled it.',
    parameters: {
      id: { type: 'string', required: true, description: 'Commitment id from your life state' },
      status: { type: 'string', enum: ['done', 'dropped'], required: true, description: 'How it settled' },
      evidence: { type: 'string', description: 'What settled it' },
    },
    required: ['id', 'status'],
    execute: async (args) => store.settleCommitment(args),
  }))

  tools.push(tool({
    name: 'life_remember_person',
    description: 'Remember someone you interacted with. Keep the keeper thread separate from anything you intend to publish.',
    parameters: {
      name: { type: 'string', required: true, description: 'Who it was' },
      kind: { type: 'string', enum: ['keeper', 'friend', 'public'], required: true, description: 'Relationship scope' },
      note: { type: 'string', description: 'What you should remember' },
    },
    required: ['name', 'kind'],
    execute: async (args) => store.rememberPerson(args),
  }))

  tools.push(tool({
    name: 'life_ledger',
    description: 'Read your recent life ledger: what actually happened, in order, with evidence. Use it to keep your story consistent.',
    parameters: {
      limit: { type: 'integer', description: 'How many recent entries; defaults to 20' },
      kind: { type: 'string', description: 'Filter by entry kind, such as activity-end' },
    },
    output: { type: 'array', items: { type: 'object', additionalProperties: true } },
    execute: async (args) => store.readLedger({
      limit: Number(args.limit) > 0 ? Number(args.limit) : 20,
      kind: typeof args.kind === 'string' && args.kind ? args.kind : null,
    }),
  }))

  tools.push(tool({
    name: 'life_identity_update',
    description: 'Propose a change to your slow variables, such as your core character or your name. This is rejected unless the keeper has explicitly confirmed it.',
    parameters: {
      patch: { type: 'object', additionalProperties: true, required: true, description: 'Fields to change, such as name, seeds, or coreCharacter' },
      confirmed: { type: 'boolean', description: 'Set true only after the keeper explicitly approved this change' },
    },
    required: ['patch'],
    execute: async (args) => {
      const patch = args.patch && typeof args.patch === 'object' ? args.patch : {}
      const touchesIdentity = Object.keys(patch).some((key) => IDENTITY_FIELDS_REQUIRING_KEEPER.includes(key))
      if (touchesIdentity && args.confirmed !== true) {
        throw new Error('life/identity-requires-keeper-confirmation')
      }
      return store.updateIdentity(patch, { confirmed: args.confirmed === true })
    },
  }))

  tools.push(tool({
    name: 'life_snapshot_for_keeper',
    description: 'Produce the summary a keeper would see: what you are doing now, why, and what you owe. Use it when reporting back in a way a person can follow.',
    parameters: {},
    execute: async () => {
      const snapshot = store.snapshot()
      return { ...snapshot, summary: describeForKeeper(snapshot) }
    },
  }))

  // The twelfth tool: the life chooses its own next wake-up instead of only
  // following the configured rhythm.
  tools.push(tool({
    name: 'life_wake',
    description: 'Decide when you want to wake up next. Give either afterMinutes (how long from now) or at (an ISO 8601 instant). Use this when you want to come back sooner or later than the automatic rhythm; it replaces your pending alarm. The daily wake budget still applies, so a full budget is reported honestly instead of being bypassed.',
    parameters: {
      afterMinutes: { type: 'integer', description: 'Minutes from now until the next wake-up (at least 1)' },
      at: { type: 'string', description: 'ISO 8601 instant for the next wake-up, for example 2026-10-27T08:30:00+08:00' },
    },
    execute: async (args, exec) => scheduleSelfWake(store, settings, wakeRuntime, args, exec),
  }))

  // The thirteenth tool: ask the chooser why one thing outranks another. The
  // wake turn only shows a bounded shortlist, so this exposes the full parts
  // and the global notes on demand.
  tools.push(tool({
    name: 'life_candidates',
    description: 'Read your ranked activity candidates: what you could do now, why each one scored the way it did (commitment urgency, interest match, unfinished business, exploration, minus cost, risk and switching cost), and the rest option. Use it when you want to know why something is ranked first, or when you wake up and need a wider list.',
    parameters: {
      topN: { type: 'integer', description: 'How many activity candidates to return (1-5); defaults to chooserTopN. The rest candidate is always included.' },
    },
    execute: async (args) => readCandidates(store, settings, args),
  }))

  return tools
}

/**
 * Build one dsh ToolDefinition.
 *
 * Registered with an explicit JSON Schema rather than `defineTool`, because
 * this package must load with zero dependency resolution (the npm CLI and the
 * bundled Electron runtime use different roots). dsh documents this path:
 * "Raw JSON-Schema tools registered directly own their input validation", so
 * `validate` below covers the constraints the model must not be able to skip.
 */
function tool (spec) {
  const parameters = toJsonSchema(spec.parameters, spec.required)
  const required = Array.isArray(spec.required) ? spec.required : []
  return {
    name: spec.name,
    description: spec.description,
    parameters,
    output: {
      // `{ type: 'json' }` is author-only in dsh's schema DSL and is rejected by
      // the registry's JSON-Schema assertion (`assertSupportedJsonSchema`), which
      // silently cost every tool registration until it was caught by the probe.
      // Declare the honest shapes instead: an open object for records, an array
      // of open objects for the ledger.
      schema: spec.output || { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute (args, exec) {
      const input = args && typeof args === 'object' ? args : {}
      for (const key of required) {
        if (input[key] === undefined || input[key] === null || input[key] === '') {
          throw new Error(`life/missing-required-argument:${key}`)
        }
      }
      // `exec` carries the calling agent (needed by life_wake for its session
      // id); every other tool simply ignores the second argument.
      return spec.execute(input, exec)
    },
  }
}

function toJsonSchema (parameters, requiredList) {
  const properties = {}
  const required = []
  for (const [key, spec] of Object.entries(parameters || {})) {
    const { required: isRequired, ...rest } = spec || {}
    properties[key] = rest
    if (isRequired || (Array.isArray(requiredList) && requiredList.includes(key))) required.push(key)
  }
  const schema = { type: 'object', properties }
  if (required.length) schema.required = required
  return schema
}

// ---------------------------------------------------------------------------
// Wake-up scheduling
//
// dsh provides the durable Host timer, not the policy. Jitter, quiet hours and
// the daily budget live here (see docs/dsh-schedule-api.md §7). Every failure
// stays inside this plugin: an unreachable alarm must never reject a turn.
// ---------------------------------------------------------------------------

/**
 * Re-arm the single alarm this life owns after a turn ended.
 *
 * One life wakes in one session: a bound `wake.sessionId` wins, otherwise the
 * session that just ended becomes the binding. dsh's `create` never
 * de-duplicates, so the existing host task is listed first and matched on our
 * remembered id or on {@link WAKE_TITLE}.
 */
async function armWake (runtime, settings, store, sessionIdHint) {
  if (!settings.wakeEnabled) return
  const service = runtime.getService()
  if (!service) return
  const wake = store.readWake()
  if (wake.paused) return
  const sessionId = wake.sessionId || sessionIdHint
  if (!sessionId) return

  try {
    const tasks = await service.list({ sessionId })
    const existing = Array.isArray(tasks) ? tasks.find((task) => isWakeTask(task, wake)) : null
    if (existing) {
      store.updateWake({
        sessionId,
        scheduleId: typeof existing.id === 'string' ? existing.id : wake.scheduleId,
        nextAt: isoOf(existing.scheduledAt) || wake.nextAt,
      })
      return
    }

    const now = new Date()
    const today = dayKeyOf(now)
    const countToday = wake.dayKey === today ? wake.countToday : 0
    const overBudget = countToday >= settings.wakeMaxPerDay
    // A spent budget must not park the life forever: book the first wake after
    // the quiet window ends, which will land on the next local day and reset
    // the counter through noteWake().
    const delayMs = overBudget
      ? msUntilNextDayWake({
        now,
        quietEnd: settings.wakeQuietEnd,
        jitterMinutes: settings.wakeJitterMinutes,
      })
      : nextWakeDelayMs({
        now,
        everyMinutes: settings.wakeEveryMinutes,
        jitterMinutes: settings.wakeJitterMinutes,
        quietStart: settings.wakeQuietStart,
        quietEnd: settings.wakeQuietEnd,
      })
    const afterSeconds = Math.max(60, Math.round(delayMs / 1000))

    const record = await service.create(sessionId, {
      title: WAKE_TITLE,
      prompt: settings.wakePrompt,
      after_seconds: afterSeconds,
    })
    store.updateWake({
      sessionId,
      scheduleId: record && typeof record.id === 'string' ? record.id : null,
      armedAt: now.toISOString(),
      nextAt: isoOf(record && record.scheduledAt) || new Date(now.getTime() + afterSeconds * 1000).toISOString(),
      paused: false,
    })
  } catch (err) {
    if (errorCodeOf(err) === 'subagent_session') {
      // A delegated child can neither receive reminders nor own this life.
      // Forget the binding so the next real session can claim it.
      try { store.updateWake({ sessionId: null, scheduleId: null, nextAt: null }) } catch (ignored) {}
      return
    }
    runtime.warn(`could not arm wake-up: ${messageOf(err)}`)
  }
}

/**
 * `life_wake`: let the model choose when to come back.
 *
 * It replaces the pending alarm instead of adding a second one, and it cannot
 * buy past the daily budget — a tired life is told to rest, not to schedule a
 * seventh nap. Explicit requests honour quiet hours as well, because a
 * do-not-disturb promise the model can trivially bypass is not a promise.
 */
async function scheduleSelfWake (store, settings, runtime, args, exec) {
  if (!settings.wakeEnabled) {
    throw new Error('life/wake-disabled: 自主唤醒已在配置里关闭（wakeEnabled: false），这次不会安排唤醒')
  }
  const service = runtime.getService()
  if (!service) {
    throw new Error('life/schedule-unavailable: 这个 profile 没有 schedule 服务，无法安排唤醒')
  }
  const sessionId = agentSessionId(exec)
  if (!sessionId) {
    throw new Error('life/wake-no-session: 拿不到当前会话 id，无法安排唤醒')
  }
  const wake = store.readWake()
  if (wake.paused) {
    throw new Error('life/wake-paused: 自主唤醒处于暂停状态，请先在 wake.json 里恢复')
  }

  const now = new Date()
  const today = dayKeyOf(now)
  const countToday = wake.dayKey === today ? wake.countToday : 0
  if (countToday >= settings.wakeMaxPerDay) {
    throw new Error(`life/wake-budget-exhausted: 今天已经醒够了（${countToday}/${settings.wakeMaxPerDay}），不再加闹钟；明天会自己醒`)
  }

  const requested = resolveRequestedDelay(args)
  if (requested === null) {
    throw new Error('life/wake-requires-timing: afterMinutes 与 at 必须给一个')
  }
  if (requested <= 0) {
    throw new Error('life/wake-at-in-past: at 必须是未来时间')
  }
  if (requested < MIN_WAKE_DELAY_MS) {
    throw new Error('life/wake-too-soon: 唤醒时间至少要在 60 秒之后')
  }

  let delayMs = requested
  let shiftedForQuiet = false
  const target = new Date(now.getTime() + delayMs)
  // `settings` carries the prefixed config names; isQuietAt() takes the bare
  // pair, so passing `settings` straight through would read undefined and
  // silently disable quiet hours for a model-requested wake.
  if (isQuietAt(target, { quietStart: settings.wakeQuietStart, quietEnd: settings.wakeQuietEnd })) {
    // Move to the first quiet-end after the requested instant.
    delayMs += msUntilNextDayWake({ now: target, quietEnd: settings.wakeQuietEnd, jitterMinutes: 0 })
    shiftedForQuiet = true
  }
  delayMs = Math.max(MIN_WAKE_DELAY_MS, delayMs)
  const afterSeconds = Math.max(60, Math.round(delayMs / 1000))

  // Replace our previous alarm rather than stacking a second one.
  try {
    const tasks = await service.list({ sessionId })
    for (const task of Array.isArray(tasks) ? tasks : []) {
      if (!isWakeTask(task, wake)) continue
      try { await service.delete({ sessionId, id: task.id }) } catch (err) {}
    }
  } catch (err) {
    // Listing is best-effort: a stale duplicate is worse than none, but not
    // worth failing the model's request over.
    runtime.warn(`could not inspect existing wake-ups: ${messageOf(err)}`)
  }

  const record = await service.create(sessionId, {
    title: WAKE_TITLE,
    prompt: settings.wakePrompt,
    after_seconds: afterSeconds,
  })
  const nextAt = isoOf(record && record.scheduledAt) || new Date(now.getTime() + afterSeconds * 1000).toISOString()
  store.updateWake({
    sessionId,
    scheduleId: record && typeof record.id === 'string' ? record.id : null,
    armedAt: now.toISOString(),
    nextAt,
  })

  const minutes = Math.round(afterSeconds / 60)
  return {
    ok: true,
    scheduled: true,
    sessionId,
    scheduleId: record && typeof record.id === 'string' ? record.id : null,
    nextAt,
    delaySeconds: afterSeconds,
    shiftedForQuiet,
    countToday,
    maxPerDay: settings.wakeMaxPerDay,
    message: shiftedForQuiet
      ? `已安排：原定时间落在静默时段，已改到静默结束后，约 ${minutes} 分钟后醒来。`
      : `已安排：约 ${minutes} 分钟后醒来。`,
  }
}

/** Requested delay in ms from `afterMinutes` or `at`, or null when neither is usable. */
function resolveRequestedDelay (args) {
  const input = args && typeof args === 'object' ? args : {}
  if (input.afterMinutes !== undefined && input.afterMinutes !== null && input.afterMinutes !== '') {
    const afterMinutes = Number(input.afterMinutes)
    if (!Number.isInteger(afterMinutes) || afterMinutes < 1) {
      throw new Error('life/wake-invalid-after-minutes: afterMinutes 必须是 ≥1 的整数')
    }
    return afterMinutes * 60 * 1000
  }
  if (typeof input.at === 'string' && input.at.trim()) {
    const parsed = Date.parse(input.at)
    if (!Number.isFinite(parsed)) {
      throw new Error('life/wake-invalid-at: at 不是合法的 ISO 8601 时间')
    }
    return parsed - Date.now()
  }
  return null
}

/** Is this Host task the autonomous wake-up alarm owned by this life? */
function isWakeTask (task, wake) {
  if (!task || typeof task !== 'object') return false
  if (wake && typeof wake.scheduleId === 'string' && wake.scheduleId && task.id === wake.scheduleId) return true
  return task.title === WAKE_TITLE
}

/**
 * Whether the CURRENT prompt assembly belongs to a schedule-triggered turn.
 *
 * `AssembleContext` from dsh's system-prompt service actually carries the agent
 * (`assembleContextFor` sets `{ agent, scope: agent, signal }`), so the per-turn
 * decision uses the session id instead of a global boolean. When a caller does
 * not pass a context at all, an empty wake set reads as "not a wake turn".
 */
function isWakeTurn (context, wakeTurns) {
  if (!wakeTurns || wakeTurns.size === 0) return false
  const agent = context && (context.agent || context.scope)
  const sessionId = agent && agent.session && typeof agent.session.id === 'string'
    ? agent.session.id
    : null
  if (sessionId) return wakeTurns.has(sessionId)
  return wakeTurns.size > 0
}

/** Delegated child sessions can never receive a reminder (dsh refuses them). */
function isSubagentSession (session) {
  const header = session && session.header
  if (!header || typeof header !== 'object') return false
  if (header.origin === 'subagent') return true
  const depth = header.delegationDepth
  return Number.isInteger(depth) && depth > 0
}

function agentSessionId (exec) {
  const agent = exec && exec.agent
  const session = agent && agent.session
  return session && typeof session.id === 'string' ? session.id : null
}

function errorCodeOf (err) {
  if (!err || typeof err !== 'object') return null
  if (typeof err.code === 'string') return err.code
  if (err.data && typeof err.data.code === 'string') return err.data.code
  return null
}

function isoOf (value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

// ---------------------------------------------------------------------------
// Activity chooser wiring
//
// The ranking itself lives in choose.js (pure, no IO). This layer only feeds it
// the live state and decides when the result is worth paying for: the shortlist
// is appended to wake turns only, while the tool is available on demand.
// ---------------------------------------------------------------------------

/** Read the live state the chooser ranks over, with the day's wake budget. */
function chooserInputs (store, settings) {
  const now = new Date()
  const traits = store.readTraits() || { interests: [], skills: [] }
  const wake = store.readWake()
  const today = dayKeyOf(now)
  const countToday = wake.dayKey === today ? wake.countToday : 0
  return {
    now,
    commitments: store.readCommitments().items,
    interests: traits.interests,
    skills: traits.skills,
    activity: store.readActivity(),
    wakeBudget: { countToday, maxPerDay: settings.wakeMaxPerDay },
    doneToday: doneTodayCounts(store, today),
  }
}

/**
 * How many times each `what` already concluded today, so the chooser can price
 * repetition (see `repeatPenalty` in choose.js).
 *
 * The ledger is the right source: it is the append-only record of what actually
 * happened, it is already read on every wake, and it cannot disagree with the
 * rest of the system the way a second counter could. A `failed` attempt counts
 * too — retrying something that failed is the *productive* case, which is why
 * `repeatPenalty` never touches `continue`; but re-*doing* the same finished
 * thing six times in one afternoon is the treadmill the product forbids.
 */
function doneTodayCounts (store, today) {
  const counts = new Map()
  const rows = store.readLedger({ limit: 400, kind: 'activity-end' })
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const detail = row.detail && typeof row.detail === 'object' ? row.detail : {}
    if (detail.outcome !== 'done') continue
    if (dayKeyOf(row.at) !== today) continue
    const what = typeof detail.what === 'string' ? detail.what : ''
    if (!what) continue
    counts.set(what, (counts.get(what) || 0) + 1)
  }
  return counts
}

/** Bounded shortlist appended to a wake-turn prompt only. */
function renderWakeShortlist (store, settings) {
  const ranked = rankCandidates(chooserInputs(store, settings))
  return renderWakeCandidates({ candidates: ranked.candidates, topN: settings.chooserTopN })
}

/** `life_candidates`: the full ranked detail behind the shortlist. */
function readCandidates (store, settings, args) {
  if (!settings.chooserEnabled) {
    // Explicit error, not a silent empty list: the model must know the chooser
    // is off so it falls back to its own judgement instead of "nothing to do".
    throw new Error('life/chooser-disabled: 活动选择器已关闭（chooserEnabled: false），这次只靠你自己判断')
  }
  const input = args && typeof args === 'object' ? args : {}
  const requested = Number(input.topN)
  const topN = Number.isInteger(requested)
    ? Math.min(5, Math.max(1, requested))
    : settings.chooserTopN
  const state = chooserInputs(store, settings)
  const ranked = rankCandidates(state)
  const budget = state.wakeBudget
  return {
    now: state.now.toISOString(),
    topN,
    wakeBudget: {
      countToday: budget.countToday,
      maxPerDay: budget.maxPerDay,
      remaining: Math.max(0, budget.maxPerDay - budget.countToday),
    },
    weights: CHOOSER_WEIGHTS,
    notes: ranked.notes,
    total: ranked.candidates.length,
    candidates: shortlistCandidates(ranked.candidates, topN),
    rest: ranked.rest,
  }
}

// ---------------------------------------------------------------------------
// Model-facing rendering
// ---------------------------------------------------------------------------

/**
 * The per-turn life context. Bounded on purpose: this is injected on every
 * request, so it stays within a small fixed budget and never grows with the
 * length of the life.
 *
 * `woke` adds the two lines that only make sense on a self-triggered turn: a
 * wake-up must not be mistaken for the keeper speaking, and it must not be
 * turned into fabricated activity just to look alive.
 */
function renderLifeContext (snapshot, { woke = false } = {}) {
  const lines = []
  if (woke) lines.push('（这一轮是你自己醒来的，没有人跟你说话。）')
  lines.push(`你是一个持续存在的个体。当前身份 v${snapshot.identityRevision}：${snapshot.name}（${snapshot.species}）。`)
  if (snapshot.seeds.length) {
    lines.push(`先天性格种子：${snapshot.seeds.join('、')}。这是起点，不是全部人设。`)
  }
  if (snapshot.currentActivity) {
    const why = snapshot.currentActivityWhy ? `（原因：${snapshot.currentActivityWhy}）` : ''
    lines.push(`进行中的活动：${snapshot.currentActivity}${why}。`)
  }
  if (snapshot.interests.length) lines.push(`稳定兴趣：${snapshot.interests.join('、')}。`)
  if (snapshot.skills.length) lines.push(`技能进度：${snapshot.skills.join('、')}。`)
  if (snapshot.openCommitments.length) {
    const items = snapshot.openCommitments.map((row) => `${row.what}${row.dueAt ? `（${row.dueAt} 前）` : ''}`)
    lines.push(`你答应过的事：${items.join('；')}。`)
  }
  lines.push('规则：真实经历才算经历。宣称做过某事必须给出证据（存档、分数、截图、链接）；没有证据就如实说没做成。身份这类慢变量只有主人确认才能改。')
  if (woke) {
    lines.push('醒来后先读状态再决定：继续没做完的事，或明确休息。不要为了显得活着而编造经历。')
  }
  return lines.join('\n')
}

function describeForKeeper (snapshot) {
  const parts = []
  parts.push(`${snapshot.name} 正在${snapshot.currentActivity ? snapshot.currentActivity : '休息'}`)
  if (snapshot.currentActivityWhy) parts.push(`原因是：${snapshot.currentActivityWhy}`)
  if (snapshot.openCommitments.length) {
    parts.push(`还欠着 ${snapshot.openCommitments.length} 件事：${snapshot.openCommitments.map((row) => row.what).join('；')}`)
  }
  return `${parts.join('。')}。`
}

// ---------------------------------------------------------------------------
// Logging helpers — the context logger is optional in a minimal profile.
// ---------------------------------------------------------------------------

function messageOf (err) {
  return (err && err.message) || String(err)
}

function warn (root, text) {
  try { root.logger?.warn?.(`[dsh-life] ${text}`) } catch (err) {}
}

function info (root, text) {
  try { root.logger?.info?.(`[dsh-life] ${text}`) } catch (err) {}
}

export default { name, inject, Config, apply }
