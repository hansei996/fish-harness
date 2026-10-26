import { LifeStore, resolveDshHome } from './store.js'
import { ConfigSchema, ConfigDefaults } from './config.js'

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

  // ---- 1. Model-facing life tools -----------------------------------------
  root.inject(['tools'], (ctx) => {
    for (const definition of buildTools(store, settings)) {
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
          text: () => {
            try {
              return renderLifeContext(store.snapshot())
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
  // only durable turn boundaries and never inspects message content.
  //
  // The event shape is dsh's durable SessionEvent — `{ type, seq, time, data }`
  // — not `{ kind }`; a wrong field name here fails silently, which is why the
  // e2e probe asserts that a real turn reaches the ledger.
  try {
    disposers.push(root.on('session/event', (session, event) => {
      try {
        if (!event || typeof event !== 'object' || event.type !== 'turn/end') return
        const data = event.data && typeof event.data === 'object' ? event.data : {}
        store.appendLedger(
          {
            kind: 'turn',
            detail: {
              sessionId: (session && session.id) || null,
              turn: typeof data.turn === 'number' ? data.turn : null,
              // Only the reason kind is recorded: the full reason can carry
              // provider error text, which does not belong in a life ledger.
              reason: data.reason && typeof data.reason === 'object' ? data.reason.kind || null : null,
            },
          },
          { cap: settings.maxLedgerEntries },
        )
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

function buildTools (store, settings) {
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
    },
    required: ['outcome'],
    execute: async (args) => store.finishActivity(args),
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
    async execute (args) {
      const input = args && typeof args === 'object' ? args : {}
      for (const key of required) {
        if (input[key] === undefined || input[key] === null || input[key] === '') {
          throw new Error(`life/missing-required-argument:${key}`)
        }
      }
      return spec.execute(input)
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
// Model-facing rendering
// ---------------------------------------------------------------------------

/**
 * The per-turn life context. Bounded on purpose: this is injected on every
 * request, so it stays within a small fixed budget and never grows with the
 * length of the life.
 */
function renderLifeContext (snapshot) {
  const lines = []
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
