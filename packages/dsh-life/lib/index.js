import fs from 'node:fs'
import path from 'node:path'
import { LifeStore, newId, resolveDshHome } from './store.js'
import { installLifeUi } from './ui.js'
import { ConfigSchema, ConfigDefaults } from './config.js'
import { CHOOSER_WEIGHTS, rankCandidates, renderWakeCandidates, shortlistCandidates } from './choose.js'
import {
  approve,
  createDraft,
  markChecked,
  noteApproval,
  outboxCounts,
  reconcile,
  sendAttempt,
} from './outbox.js'
import { createTelegramTransport } from './telegram.js'
import {
  assertVideoArtifact,
  createRunner,
  fileDigest,
  labelVideo,
  MAX_VIDEO_BYTES,
  MAX_VIDEO_SECONDS,
  probeVideo,
  verifyVideoLabel,
} from './video.js'
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

/**
 * `child_process.spawn`, imported lazily.
 *
 * A static `import { spawn } from 'node:child_process'` would be evaluated at
 * module load, and this package must load in every runtime dsh supports —
 * including ones where the video path is never used. The video labeler is the
 * only consumer, so the import happens on first use and a failure to import
 * degrades to "no video capability", which is an honest state.
 */
let nodeSpawn = null
try {
  // eslint-disable-next-line antiplus/no-dynamic-import
  nodeSpawn = (await import('node:child_process')).spawn
} catch (err) {
  nodeSpawn = null
}

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

  // ---- 0. Read-only UI seam ------------------------------------------------
  // Registers `/life/state.json` only when the profile carries a `webServer`
  // (headless/SDK profiles have none: nothing is registered, nothing is logged).
  installLifeUi(root, store, settings)

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

  // The publish line is record-and-state-machine only in this round: the
  // transport that would actually talk to a platform is injected by the
  // runtime (or a test double), never built here and never read from config.
  const publisherRuntime = {
    transport: resolveTransport(root, config),
    approval: null,
    // Child processes for the video labeller. Built lazily and only when a
    // config actually names an ffmpeg path, so a text-only deployment never
    // touches child_process — and a profile without ffmpeg fails with a clear
    // "no labelling capability" instead of publishing an unlabelled file.
    get runner () {
      if (!settings.videoFfmpegPath) return null
      if (this._runner) return this._runner
      try {
        this._runner = createRunner({ spawn: nodeSpawn })
      } catch (err) {
        this._runner = null
      }
      return this._runner
    },
    _runner: null,
  }

  // Approval is optional for the same reason schedule is: a partial profile
  // must still load. Without it `life_publish` fails closed — it never treats a
  // missing answerer as consent.
  try {
    root.inject(['approval'], (ctx) => {
      try {
        if (ctx && ctx.approval && typeof ctx.approval.request === 'function') {
          publisherRuntime.approval = ctx.approval
        }
      } catch (err) {
        // Never warn during apply: a missing approval channel is a degradation.
      }
    })
  } catch (err) {
    // A context that cannot inject at all (tests, partial profiles) is fine.
  }

  // ---- 1. Model-facing life tools -----------------------------------------
  root.inject(['tools'], (ctx) => {
    for (const definition of buildTools(store, settings, wakeRuntime, publisherRuntime)) {
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

function buildTools (store, settings, wakeRuntime, publisherRuntime) {
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

  // ---- Publish line: records only, no send tool --------------------------
  // Approval (who may say "send") is a separate seam that is not wired yet, so
  // these tools stop at "waiting for the keeper". A tool must never be able to
  // turn its own draft into `approved`, and none of them can reach `confirmed`
  // without a receipt from an injected transport.
  // Media attachment. `life_draft_post` is text-only on purpose: a video draft
  // has to go through labelling *and* a verified burn-in first, and folding that
  // into the text tool would make "record a draft" able to spawn an ffmpeg job.
  tools.push(tool({
    name: 'life_attach_video',
    description: 'Turn a raw video file you already produced into a publishable, labelled artifact: draws the mandatory AI-generation label on every frame (including the first), writes the implicit identifier into the container metadata, and then verifies both by decoding frame 0 and re-reading the metadata. Returns a contentId plus a digest; pass both to life_draft_post. If ffmpeg is unavailable or verification fails, nothing is returned and nothing can be published — an unlabelled video must never leave this process.',
    parameters: {
      path: { type: 'string', required: true, description: 'Absolute path of the raw video produced by your own activity (e.g. a gameplay clip)' },
      text: { type: 'string', description: 'The post body that will carry this video; the platform label is added later by life_publish_queue' },
      evidence: { type: 'array', items: { type: 'string' }, description: 'Ledger-backed references proving the footage is your own experience' },
      channel: { type: 'string', description: 'Configured channel id (or kind); defaults to the only configured channel' },
      account: { type: 'string', description: 'Account for that channel; defaults to the configured account' },
    },
    required: ['path'],
    execute: async (args) => attachVideo(store, settings, publisherRuntime, args),
  }))

  tools.push(tool({
    name: 'life_draft_post',
    description: 'Draft a post from something that actually happened. Every evidence reference must already exist in your life ledger (an activity-end id, an activity-end evidence string, or a ledger entry time); a draft about something you did not do is refused. This only records a draft: nothing is approved, nothing is sent, and there is no tool that can turn this draft into an approval.',
    parameters: {
      text: { type: 'string', required: true, description: 'The post body, in your own voice; the platform label is added later by the queue, do not add your own' },
      evidence: { type: 'array', items: { type: 'string' }, required: true, description: 'Ledger-backed references: activity-end ids/evidence or ledger entry times' },
      channel: { type: 'string', description: 'Configured channel id (or kind); defaults to the only configured channel' },
      account: { type: 'string', description: 'Account for that channel; defaults to the configured account' },
      mediaId: { type: 'string', description: 'A labelled video from life_attach_video to publish with this post; omit for a text-only post' },
    },
    required: ['text', 'evidence'],
    execute: async (args) => draftPost(store, settings, args),
  }))

  tools.push(tool({
    name: 'life_publish_queue',
    description: 'Move a draft to "checked": add the mandatory AI-generation label with its content id and record the version that a keeper approval would have to cover. It stops there and returns waiting-for-owner. This tool can never approve content, and approval/sending are deliberately not registered in this build.',
    parameters: {
      id: { type: 'string', required: true, description: 'contentId returned by life_draft_post' },
    },
    required: ['id'],
    execute: async (args) => queuePost(store, settings, args),
  }))

  tools.push(tool({
    name: 'life_publish_status',
    description: 'Read the publish outbox, or reconcile an unconfirmed delivery explicitly. After sending starts, a missing receipt means "may have been published": the record stays unconfirmed and is never retried automatically. With reconcile=true it asks the configured transport whether the content exists (found -> confirmed with platformId; explicitly not found -> back to approved; unknown -> stays unconfirmed for a human).',
    parameters: {
      id: { type: 'string', description: 'contentId to inspect; omit for a bounded summary' },
      reconcile: { type: 'boolean', description: 'Attempt one reconciliation against the injected transport (never sends)' },
    },
    execute: async (args) => publishStatus(store, settings, publisherRuntime, args),
  }))

  // The seventeenth tool: the only path from `checked` to `sending`. It asks
  // dsh's approval seam and honours exactly one answer: `allowed-once`.
  tools.push(tool({
    name: 'life_publish',
    description: 'Publish one checked draft after the keeper explicitly approves this exact content. It asks dsh for approval and only "allowed-once" is consent; rejected, cancelled and unavailable all mean nothing is sent. Approval is not bound to content by dsh, so the content version is re-checked after approval and a changed draft is refused. A send without a platform id becomes unconfirmed and is never retried automatically — reconcile it instead.',
    parameters: {
      id: { type: 'string', required: true, description: 'contentId of a checked draft from life_publish_queue' },
    },
    required: ['id'],
    execute: async (args, exec) => publishNow(store, settings, publisherRuntime, args, exec),
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
// Publish line wiring
//
// This round deliberately stops at records + a state machine. There is no
// `life_publish_send` tool: approval (who is allowed to say "send") is a dsh
// `approval` seam that is not researched/wired yet, and a tool that could
// approve its own content would make every invariant in outbox.js decorative.
// ---------------------------------------------------------------------------

/**
 * Resolve the injected transport.
 *
 * Credentials and network clients never live in plugin config (the config
 * validator rejects credential-like keys). Tests and future runtime adapters
 * inject the transport one of three ways, in priority order:
 *   1. `config.transport` when `apply()` is called directly;
 *   2. a `lifeTransport` service on the context;
 *   3. `root.lifeTransport` on a recording test context.
 */
function resolveTransport (root, config) {
  try {
    if (config && typeof config === 'object' && config.transport &&
        typeof config.transport === 'object') {
      return config.transport
    }
  } catch (err) {}
  try {
    if (typeof root.get === 'function') {
      const injected = root.get('lifeTransport')
      if (injected && typeof injected === 'object') return injected
    }
  } catch (err) {}
  try {
    if (root && root.lifeTransport && typeof root.lifeTransport === 'object') return root.lifeTransport
  } catch (err) {}
  return null
}

function ensurePublisherEnabled (settings) {
  if (!settings.publisherEnabled) {
    throw new Error('life/publisher-disabled: 发布线未开启（publisherEnabled: false）；没有配置渠道时不做任何对外动作')
  }
}

/** Resolve `{ channel, kind, account }` from config and the caller's arguments. */
function resolvePublishChannel (settings, channelArg, accountArg) {
  const channels = Array.isArray(settings.publisherChannels) ? settings.publisherChannels : []
  if (channels.length === 0) throw new Error('life/publish-no-channels: 没有配置发布渠道（publisherChannels）')
  let chosen = null
  const wanted = typeof channelArg === 'string' ? channelArg.trim() : ''
  if (wanted) {
    chosen = channels.find((item) => item.id === wanted || item.kind === wanted) || null
    if (!chosen) throw new Error(`life/publish-unknown-channel: ${wanted}`)
  } else if (channels.length === 1) {
    chosen = channels[0]
  } else {
    throw new Error('life/publish-channel-required: 配置了多个渠道，请指定 channel')
  }
  const account = typeof accountArg === 'string' && accountArg.trim()
    ? accountArg.trim()
    : chosen.account
  if (account !== chosen.account) {
    throw new Error('life/publish-account-mismatch: 账号不在该渠道的授权范围里')
  }
  return { channel: chosen.id, kind: chosen.kind, account }
}

/**
 * Every reference a draft may cite. `activity-end` records carry the evidence
 * that proves the experience; other ledger entries are addressable by their
 * timestamp, which is the only stable id the append-only log actually has.
 */
function ledgerEvidenceIndex (store) {
  const allowed = new Set()
  for (const row of store.readLedger({ limit: 5000 })) {
    if (!row || typeof row !== 'object') continue
    if (typeof row.at === 'string' && row.at) {
      allowed.add(row.at)
      allowed.add(`ledger:${row.at}`)
    }
    if (row.kind !== 'activity-end') continue
    const detail = row.detail && typeof row.detail === 'object' ? row.detail : {}
    if (typeof detail.id === 'string' && detail.id) allowed.add(detail.id)
    if (Array.isArray(detail.evidence)) {
      for (const entry of detail.evidence) {
        if (typeof entry === 'string' && entry.trim()) allowed.add(entry.trim())
      }
    }
  }
  return allowed
}

/**
 * "Don't write about what you did not do." A draft must cite evidence that
 * already exists in the durable ledger; a plausible-sounding reference is not
 * enough, so this is a refusal rather than a warning.
 */
function requireLedgerEvidence (store, evidence) {
  if (!Array.isArray(evidence) || evidence.length === 0) {
    throw new Error('life/publish-evidence-required: 必须引用真实经历（账本里的 activity-end id/证据或条目时间）')
  }
  const allowed = ledgerEvidenceIndex(store)
  const normalized = []
  for (const entry of evidence) {
    if (typeof entry !== 'string' || !entry.trim()) {
      throw new Error('life/publish-evidence-required: 证据引用必须是非空字符串')
    }
    const reference = entry.trim()
    if (!allowed.has(reference)) {
      throw new Error(`life/publish-evidence-not-found: ${reference}`)
    }
    normalized.push(reference)
  }
  return [...new Set(normalized)]
}

function labelOptionsFor (settings) {
  return {
    identityName: settings.name,
    providerCode: settings.publisherProviderCode,
  }
}

/**
 * `life_attach_video`: label a raw clip, verify the burn-in, and hand back the
 * digest the draft must bind to.
 *
 * The verified artifact is cached in memory for this process only, keyed by its
 * digest. Why not write it to the life directory: the artifact is derived data,
 * the source clip already lives where the activity put it, and persisting a
 * second copy of a 50 MB file per draft would grow the life folder without
 * bound. The digest is what is durable; the path is re-derivable.
 *
 * A cached entry is only reused when the file on disk still hashes to the same
 * digest, so an edited file cannot be published under a stale approval.
 */
const verifiedMedia = new Map()

async function attachVideo (store, settings, runtime, args) {
  ensurePublisherEnabled(settings)
  const input = args && typeof args === 'object' ? args : {}
  const sourcePath = typeof input.path === 'string' ? input.path.trim() : ''
  if (!sourcePath) throw new Error('life/video-file-required')
  if (!path.isAbsolute(sourcePath)) throw new Error('life/video-path-must-be-absolute')
  if (!fs.existsSync(sourcePath)) throw new Error(`life/video-file-missing: ${sourcePath}`)
  if (!runtime.runner) {
    // No runner means no ffmpeg in this profile. Refusing is the whole point of
    // this module: the alternative is publishing the raw file.
    throw new Error('life/video-runner-unavailable: 这个 profile 没有可用的 ffmpeg；没有标注能力时不会发布任何视频')
  }

  const contentId = newId('post')
  const probed = await probeVideo({ filePath: sourcePath, run: runtime.runner, ffprobePath: settings.videoFfprobePath })
  if (probed.durationSec !== null && probed.durationSec > MAX_VIDEO_SECONDS) {
    throw new Error(`life/video-too-long: ${Math.round(probed.durationSec)}s 超过上限 ${MAX_VIDEO_SECONDS}s`)
  }

  const outPath = `${sourcePath.replace(/\.[a-z0-9]+$/i, '')}.labelled.mp4`
  const labelled = await labelVideo({
    inputPath: sourcePath,
    outputPath: outPath,
    contentId,
    providerCode: settings.publisherProviderCode,
    template: settings.videoLabelTemplate,
    fontFile: settings.videoFontPath,
    fontSize: settings.videoFontSize,
    run: runtime.runner,
    ffmpegPath: settings.videoFfmpegPath,
  })

  // Verification is not optional and not reported-and-ignored: `ok: false` means
  // this tool throws. A "labelled" file that cannot prove its label is the one
  // artifact that must never reach the outbox.
  const verified = await verifyVideoLabel({
    labelledPath: labelled.path,
    sourcePath,
    contentId,
    providerCode: settings.publisherProviderCode,
    run: runtime.runner,
    ffmpegPath: settings.videoFfmpegPath,
    ffprobePath: settings.videoFfprobePath,
    maxBytes: MAX_VIDEO_BYTES,
  })
  if (!verified.ok) {
    throw new Error(`life/video-label-unverified: ${verified.problems.join('; ')}`)
  }

  const media = {
    kind: 'video',
    path: labelled.path,
    digest: labelled.digest,
    labelText: labelled.labelText,
    metadata: labelled.metadata.fields,
    durationSec: labelled.durationSec,
    sizeBytes: labelled.sizeBytes,
    width: labelled.width,
    height: labelled.height,
    verifiedAt: new Date().toISOString(),
  }
  assertVideoArtifact({ ...media, contentId })
  verifiedMedia.set(labelled.digest, { ...media, contentId })

  return {
    ok: true,
    mediaId: labelled.digest,
    contentId,
    path: media.path,
    digest: media.digest,
    labelText: media.labelText,
    metadata: media.metadata,
    durationSec: media.durationSec,
    sizeBytes: media.sizeBytes,
    verified: {
      frame0HasLabel: verified.burned ? !verified.burned.identical : null,
      metadataOk: true,
    },
    message: '视频已标注并核验（首帧显式标识 + 容器隐式标识）。下一步：life_draft_post 带上 mediaId 与 text/evidence。',
  }
}

/** `life_draft_post`: record a draft and nothing else. */
function draftPost (store, settings, args) {
  ensurePublisherEnabled(settings)
  const input = args && typeof args === 'object' ? args : {}
  const text = typeof input.text === 'string' ? input.text.trim() : ''
  if (!text) throw new Error('life/publish-text-required')
  if (text.length > 4000) throw new Error('life/publish-text-too-long: 正文最多 4000 字')
  const evidence = requireLedgerEvidence(store, input.evidence)
  const target = resolvePublishChannel(settings, input.channel, input.account)

  // A mediaId must resolve to an artifact that was verified *in this process*.
  // Accepting a bare path or digest from the model would let a post claim a
  // video that was never labelled.
  let media = null
  const mediaId = typeof input.mediaId === 'string' ? input.mediaId.trim() : ''
  if (mediaId) {
    const cached = verifiedMedia.get(mediaId)
    if (!cached) {
      throw new Error('life/publish-media-unknown: mediaId 不是本进程核验过的视频；先调 life_attach_video')
    }
    // Re-hash before trusting the cache: the file may have been replaced.
    if (!fs.existsSync(cached.path) || fileDigest(cached.path) !== cached.digest) {
      verifiedMedia.delete(mediaId)
      throw new Error('life/publish-media-changed: 已核验的视频文件变了，需要重新 life_attach_video')
    }
    media = cached
  }

  const record = createDraft({
    contentId: newId('post'),
    text,
    evidence,
    channel: target.channel,
    account: target.account,
    labelOptions: labelOptionsFor(settings),
    media: media
      ? {
          kind: 'video',
          path: media.path,
          digest: media.digest,
          labelText: media.labelText,
          metadata: media.metadata,
          durationSec: media.durationSec,
          sizeBytes: media.sizeBytes,
          width: media.width,
          height: media.height,
          verifiedAt: media.verifiedAt,
        }
      : null,
  })
  const stored = store.appendOutboxItem(record, { max: settings.publisherMaxOutbox })
  const pruned = stored.dropped && (stored.dropped.proposed > 0 || stored.dropped.settled > 0)
    ? stored.dropped
    : null
  return {
    ok: true,
    id: stored.record.contentId,
    contentId: stored.record.contentId,
    contentVersion: stored.record.contentVersion,
    status: stored.record.status,
    channel: stored.record.channel,
    account: stored.record.account,
    evidence: stored.record.evidence,
    duplicate: stored.duplicate,
    ...(pruned ? { pruned } : {}),
    waitingForOwner: false,
    message: pruned
      ? `草稿已记录；outbox 超出保留预算，清掉了 ${pruned.proposed} 条最老的提案、${pruned.settled} 条最老的已结算记录（待批准/发送中/待对账的记录永不删除）。下一步 life_publish_queue。`
      : '草稿已记录，尚未批准、尚未发送。下一步 life_publish_queue 做标识检查；批准与发送需要主人确认。',
  }
}

/** `life_publish_queue`: label + version the content, then stop and wait. */
function queuePost (store, settings, args) {
  ensurePublisherEnabled(settings)
  const input = args && typeof args === 'object' ? args : {}
  const id = typeof input.id === 'string' ? input.id.trim() : ''
  if (!id) throw new Error('life/publish-id-required')
  const existing = store.findOutboxItem(id)
  if (!existing) throw new Error('life/publish-record-not-found')

  if (existing.status !== 'draft' && existing.status !== 'checked') {
    return {
      ok: true,
      id: existing.contentId,
      status: existing.status,
      advanced: false,
      waitingForOwner: existing.status === 'approved',
      message: queueStatusMessage(existing.status),
    }
  }

  const checked = markChecked(existing, {
    now: new Date(),
    labelOptions: labelOptionsFor(settings),
  })
  const saved = store.updateOutboxItem(existing.contentId, checked, {
    max: settings.publisherMaxOutbox,
  })
  return {
    ok: true,
    id: saved.contentId,
    status: saved.status,
    advanced: existing.status !== 'checked',
    contentVersion: saved.contentVersion,
    labeledText: saved.labeledText,
    metadata: saved.metadata,
    waitingForOwner: true,
    // The one sentence the model must not misread as permission:
    message: '标识检查已通过，等待主人确认。本轮没有工具能把它变成 approved，也不会发送。',
  }
}

function queueStatusMessage (status) {
  if (status === 'approved') return '已获主人批准，等待发送渠道接入（本轮没有发送工具）'
  if (status === 'sending') return '正在发送或上次发送中断；按 unconfirmed 处理，先对账，不要重发'
  if (status === 'unconfirmed') return '发送结果未知：必须显式对账或人工确认，禁止重发'
  if (status === 'confirmed') return '已确认发布，保存了平台对象 ID'
  if (status === 'failed') return '已确认失败；若要重试需重新走批准'
  return `当前状态：${status}`
}

/** Compact one record for the status list (keeps the file bounded in output). */
function compactOutboxItem (item) {
  if (!item || typeof item !== 'object') return null
  return {
    id: item.contentId,
    status: item.status,
    channel: item.channel,
    account: item.account,
    contentVersion: item.contentVersion,
    platformId: item.platformId || null,
    updatedAt: item.updatedAt || null,
  }
}

async function publishStatus (store, settings, runtime, args) {
  const input = args && typeof args === 'object' ? args : {}
  const id = typeof input.id === 'string' ? input.id.trim() : ''
  const wantReconcile = input.reconcile === true
  const outbox = store.readOutbox()
  const counts = outboxCounts(outbox.items)
  const configured = Boolean(runtime.transport)
  const persist = async (record) => {
    store.updateOutboxItem(record.contentId, record, { max: settings.publisherMaxOutbox })
  }

  if (id) {
    const item = outbox.items.find((entry) => entry.contentId === id || entry.id === id)
    if (!item) throw new Error('life/publish-record-not-found')
    if (!wantReconcile) {
      return { ok: true, configured, counts, item }
    }
    if (!configured) {
      return {
        ok: false,
        configured: false,
        outcome: 'no-transport',
        counts,
        item,
        message: '未配置渠道（没有注入 transport），无法查询平台；保持 unconfirmed，需要人工确认',
      }
    }
    const result = await reconcile(item, {
      transport: runtime.transport,
      now: new Date(),
      persist,
      labelOptions: labelOptionsFor(settings),
    })
    return {
      ok: result.ok,
      configured,
      outcome: result.outcome,
      counts: outboxCounts(store.readOutbox().items),
      item: result.record,
      ...(result.message ? { message: result.message } : {}),
    }
  }

  const sorted = outbox.items
    .slice()
    .sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0))
  if (!wantReconcile) {
    return {
      ok: true,
      configured,
      counts,
      total: outbox.items.length,
      items: sorted.slice(0, 20).map(compactOutboxItem).filter(Boolean),
      waitedForReconcile: outbox.items
        .filter((entry) => entry.status === 'unconfirmed')
        .slice(0, 20)
        .map(compactOutboxItem),
    }
  }

  const pending = outbox.items.filter((entry) => entry.status === 'unconfirmed').slice(0, 20)
  if (!configured) {
    return {
      ok: false,
      configured: false,
      outcome: 'no-transport',
      counts,
      reconciled: 0,
      results: [],
      items: pending.map(compactOutboxItem),
      message: '未配置渠道（没有注入 transport），无法查询平台；unconfirmed 记录保持不动，需要人工确认',
    }
  }
  const results = []
  for (const entry of pending) {
    const result = await reconcile(entry, {
      transport: runtime.transport,
      now: new Date(),
      persist,
      labelOptions: labelOptionsFor(settings),
    })
    results.push({
      id: entry.contentId,
      outcome: result.outcome,
      status: result.record.status,
      platformId: result.record.platformId || null,
      ...(result.message ? { message: result.message } : {}),
    })
  }
  return {
    ok: true,
    configured,
    counts: outboxCounts(store.readOutbox().items),
    reconciled: results.length,
    results,
  }
}

/**
 * `life_publish`: ask dsh for consent, then send exactly once.
 *
 * Order is the whole point:
 *   1. only a `checked` record is eligible (a draft is labelled + checked first);
 *   2. a real approval is requested from dsh — a missing answerer is *not*
 *      consent, and no fallback approval path exists;
 *   3. only `allowed-once` continues; the other three outcomes stop here;
 *   4. the record is re-read and the label/version is recomputed after approval
 *      (dsh approvals carry no content digest, so this is the TOCTOU guard);
 *   5. `sendAttempt` writes `sending` before the side effect and maps every
 *      non-receipt outcome to `unconfirmed` (never an automatic retry);
 *   6. the ledger gets a `publish` entry with the digest/length, never the body.
 */
async function publishNow (store, settings, runtime, args, exec) {
  ensurePublisherEnabled(settings)
  const input = args && typeof args === 'object' ? args : {}
  const id = typeof input.id === 'string' ? input.id.trim() : ''
  if (!id) throw new Error('life/publish-id-required')
  const agent = exec && exec.agent
  if (!agent) throw new Error('life/publish-agent-required: 没有 agent，不能向主人请求批准')
  if (!runtime.approval || typeof runtime.approval.request !== 'function') {
    throw new Error('life/publish-no-approval-channel: 这个 profile 没有批准通道（approval 服务未挂载），不能发布')
  }

  const max = settings.publisherMaxOutbox
  let item = store.findOutboxItem(id)
  if (!item) throw new Error('life/publish-record-not-found')
  if (item.status === 'draft') {
    item = store.updateOutboxItem(item.contentId, markChecked(item, {
      now: new Date(),
      labelOptions: labelOptionsFor(settings),
    }), { max })
  }
  if (item.status !== 'checked') {
    return {
      ok: false,
      outcome: 'invalid-state',
      id: item.contentId,
      status: item.status,
      message: queueStatusMessage(item.status),
    }
  }

  // Media pre-flight, before asking for consent.
  //
  // A video record's `checked` state was produced by `life_publish_queue`, which
  // only re-reads stored fields — it does not touch the disk. So this is the
  // point where the artifact is re-verified against the digest the approval
  // will bind to. Asking the keeper to approve a file that has since been
  // replaced (or had its label stripped) would be asking for consent to
  // something that no longer exists.
  const mediaIssue = await checkMediaBeforePublish(settings, runtime, item)
  if (mediaIssue) {
    return {
      ok: false,
      outcome: mediaIssue.outcome,
      id: item.contentId,
      status: item.status,
      message: mediaIssue.message,
    }
  }

  // Resolve the transport before asking for consent: a channel that cannot
  // send should not make the keeper approve something for nothing.
  const resolved = transportForItem(settings, runtime, item)
  if (!resolved) {
    return {
      ok: false,
      outcome: 'no-transport',
      id: item.contentId,
      status: item.status,
      message: '这个渠道没有可用的发送能力（未注入 transport，也不是带 tokenEnv 的 telegram 渠道）；没有请求批准',
    }
  }
  if (resolved.tokenEnv && !envConfigured(resolved.tokenEnv)) {
    // Nothing could have been sent without a token, so this is not the
    // "unconfirmed" case; say it plainly and leave the record checked.
    return {
      ok: false,
      outcome: 'credential-unconfigured',
      id: item.contentId,
      status: item.status,
      message: `渠道凭据环境变量 ${resolved.tokenEnv} 未设置；没有请求批准，也没有发送`,
    }
  }

  const approvedVersion = item.contentVersion
  const approvedChannel = item.channel
  const approvedAccount = item.account
  const reason = approvalReasonFor(item)
  let outcome
  try {
    outcome = await runtime.approval.request({
      agent,
      toolName: 'life_publish',
      ...(exec.callId ? { callId: exec.callId } : {}),
      reason,
      ...(exec.signal ? { signal: exec.signal } : {}),
    })
  } catch (err) {
    await recordApprovalOutcome(store, settings, item, 'error', messageOf(err))
    return {
      ok: false,
      outcome: 'approval-error',
      id: item.contentId,
      status: item.status,
      message: `批准请求失败：${messageOf(err)}（没有发送）`,
    }
  }

  if (outcome !== 'allowed-once') {
    await recordApprovalOutcome(store, settings, item, outcome, null)
    return {
      ok: false,
      outcome: typeof outcome === 'string' && outcome ? outcome : 'unknown',
      id: item.contentId,
      status: 'checked',
      approved: false,
      message: approvalOutcomeMessage(outcome),
    }
  }

  // TOCTOU: the approval carried only a reason string, so re-read storage and
  // recompute what would actually be sent. Any difference means the keeper
  // approved different bytes.
  const fresh = store.findOutboxItem(item.contentId)
  if (!fresh || fresh.status !== 'checked') {
    return {
      ok: false,
      outcome: 'content-changed',
      id: item.contentId,
      status: fresh ? fresh.status : 'missing',
      message: '批准期间记录状态已变化，旧批准作废；没有发送',
    }
  }
  const relabeled = markChecked(fresh, {
    now: new Date(),
    labelOptions: labelOptionsFor(settings),
  })
  if (relabeled.contentVersion !== approvedVersion ||
      relabeled.channel !== approvedChannel ||
      relabeled.account !== approvedAccount) {
    const reverted = store.updateOutboxItem(relabeled.contentId, relabeled, { max })
    await recordApprovalOutcome(store, settings, reverted, 'content-changed', '版本/账号在批准期间变化')
    return {
      ok: false,
      outcome: 'content-changed',
      id: reverted.contentId,
      status: 'checked',
      approved: false,
      message: '内容在批准期间变了，旧批准失效并回到 checked；需要重新入队确认',
    }
  }

  const approvedRecord = approve(relabeled, {
    approvedBy: 'approval:allowed-once',
    now: new Date(),
    labelOptions: labelOptionsFor(settings),
  })
  const noted = noteApproval(approvedRecord, { outcome: 'allowed-once', now: new Date() })
  const result = await sendAttempt(noted, {
    transport: resolved.transport,
    now: new Date(),
    persist: (record) => store.updateOutboxItem(record.contentId, record, { max }),
    labelOptions: labelOptionsFor(settings),
  })

  if (result.outcome === 'confirmed') {
    appendPublishLedger(store, settings, result.record, 'confirmed', result.record.platformId)
    return {
      ok: true,
      outcome: 'confirmed',
      id: result.record.contentId,
      status: 'confirmed',
      platformId: result.record.platformId,
      approval: 'allowed-once',
      message: '主人已批准这一版内容，平台回执已保存（platformId）',
    }
  }
  if (result.outcome === 'unconfirmed') {
    appendPublishLedger(store, settings, result.record, 'unconfirmed', null)
    return {
      ok: false,
      outcome: 'unconfirmed',
      id: result.record.contentId,
      status: 'unconfirmed',
      approval: 'allowed-once',
      message: '批准已通过，但没拿到平台回执：结果未知。不要重发；先 life_publish_status reconcile 或人工确认',
    }
  }
  return {
    ok: false,
    outcome: result.outcome || result.reason || 'not-sent',
    id: result.record.contentId,
    status: result.record.status,
    message: result.error || '没有发送',
  }
}

/**
 * Re-verify a media record immediately before its approval request.
 *
 * Returns `null` when there is nothing to check or everything checks out, or an
 * `{outcome, message}` describing why the publish must not proceed.
 *
 * Deliberately a *re-hash of the file*, not a comparison of stored strings: the
 * stored digest is what was true when the clip was labelled, and the whole point
 * of checking here is that the file may have changed since.
 */
async function checkMediaBeforePublish (settings, runtime, item) {
  const media = item.media
  if (!media || typeof media !== 'object') return null
  if (media.kind !== 'video') {
    return { outcome: 'media-unsupported', message: `这个版本还不支持 ${media.kind} 媒体；没有请求批准` }
  }
  if (!fs.existsSync(media.path)) {
    return { outcome: 'media-missing', message: '视频文件不在了（可能被清理或移动）；没有请求批准' }
  }
  if (fileDigest(media.path) !== media.digest) {
    return { outcome: 'media-changed', message: '视频文件的字节与已核验的那一份不同；没有请求批准，请重新 life_attach_video' }
  }
  const ok = assertVideoArtifactQuiet({ ...media, contentId: item.contentId })
  if (!ok.ok) {
    return { outcome: 'media-metadata-invalid', message: `${ok.message}；没有请求批准` }
  }
  // If an ffmpeg is configured, re-prove the burn-in rather than trusting the
  // stored `metadata` field. Without one, the digest check above is the whole
  // guarantee — and that is stated instead of implied.
  const runner = runtime.runner
  if (!runner) return null
  try {
    const verified = await verifyVideoLabel({
      labelledPath: media.path,
      contentId: item.contentId,
      providerCode: settings.publisherProviderCode,
      run: runner,
      ffmpegPath: settings.videoFfmpegPath,
      ffprobePath: settings.videoFfprobePath,
      maxBytes: MAX_VIDEO_BYTES,
    })
    if (!verified.ok) {
      return { outcome: 'media-label-unverified', message: `视频标注核验不通过：${verified.problems.join('; ')}；没有请求批准` }
    }
  } catch (err) {
    return { outcome: 'media-verify-failed', message: `视频标注核验出错：${messageOf(err)}；没有请求批准` }
  }
  return null
}

/** `assertVideoArtifact` as a plain result instead of a throw. */
function assertVideoArtifactQuiet (media) {
  try {
    assertVideoArtifact(media)
    return { ok: true }
  } catch (err) {
    return { ok: false, message: messageOf(err) }
  }
}

/** Injected transport wins; otherwise build the configured Telegram adapter. */
function transportForItem (settings, runtime, item) {
  if (runtime.transport && typeof runtime.transport.send === 'function') {
    return { transport: runtime.transport, tokenEnv: null, source: 'injected' }
  }
  const channels = Array.isArray(settings.publisherChannels) ? settings.publisherChannels : []
  const channel = channels.find((entry) => entry.id === item.channel)
  if (!channel) return null
  if (channel.kind === 'telegram' && channel.tokenEnv) {
    return {
      transport: createTelegramTransport({ tokenEnv: channel.tokenEnv, fetchImpl: globalThis.fetch }),
      tokenEnv: channel.tokenEnv,
      source: 'telegram-env',
    }
  }
  return null
}

function envConfigured (name) {
  const value = process.env ? process.env[name] : undefined
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * The only place dsh lets us bind content: `reason`. It is bounded to 200
 * characters and starts with the identifiers so clipping can never hide them.
 * No credential ever appears here.
 */
function approvalReasonFor (item) {
  const firstLine = String(item.labeledText || item.text || '')
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean) || ''
  const identity = `life_publish contentId=${item.contentId} contentVersion=${item.contentVersion} ` +
    `channel=${item.channel} account=${item.account}`
  return clipText(`${identity} 首行=${firstLine}`, 200)
}

function approvalOutcomeMessage (outcome) {
  if (outcome === 'unavailable') {
    return '这个 profile 没有批准通道（headless 或无 UI）。按 fail-closed 处理：本次不发送'
  }
  if (outcome === 'rejected') return '主人或策略拒绝了这次发布；没有发送'
  if (outcome === 'cancelled') return '批准被取消；没有发送'
  return `批准结果不是 allowed-once（${String(outcome)}）；没有发送`
}

async function recordApprovalOutcome (store, settings, item, outcome, reason) {
  const noted = noteApproval(item, { outcome, reason, now: new Date() })
  store.updateOutboxItem(item.contentId, noted, { max: settings.publisherMaxOutbox })
  return noted
}

/** Durable audit without the body: digest, length and routing only. */
function appendPublishLedger (store, settings, record, status, platformId) {
  store.appendLedger({
    kind: 'publish',
    detail: {
      contentId: record.contentId,
      contentVersion: record.contentVersion,
      channel: record.channel,
      account: record.account,
      status,
      platformId: platformId || null,
      textLength: typeof record.text === 'string' ? record.text.length : 0,
    },
  }, { cap: settings.maxLedgerEntries })
}

function clipText (value, limit) {
  const text = String(value ?? '')
  if (text.length <= limit) return text
  return `${text.slice(0, Math.max(0, limit - 1))}…`
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
