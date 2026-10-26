# verify/live — checks that need a real dsh process tree

Opt-in. Nothing here runs in `npm run verify`, in CI, or from the product; you
type the command yourself. They are slow and they boot real Hosts.

## `wake-live.mjs` — does the real `web` profile wake a Session on its own?

```bash
DSH_BIN=/path/to/node_modules/@deepseek-ai/dsh node verify/live/wake-live.mjs
# Windows PowerShell
$env:DSH_BIN='C:\...\node_modules\@deepseek-ai\dsh'; node verify/live/wake-live.mjs
```

`DSH_BIN` may name the package directory or `lib/bin.js`; `verify/dsh-bin.mjs`
realpaths it, which pnpm's junction needs. Needs the **shipped `web` profile**,
because `headless` and `sdk` compose no `schedule` service.

**Cost:** ~2 minutes, four short-lived local processes (one is the environment
check below), a throwaway `DSH_HOME` under the temp dir (wiped at start, left on
disk afterwards so a failure can be read). **No model credential is used**, so no
spend — the wake turn's model call is expected to fail.

**Presets are not touched.** `wake.patch.yml` inserts exactly one driver plugin
and changes no preset, no registry and no service. The plugin exists only because
`dsh web` has no command that runs a turn unattended. The Session under test runs
the shipped `standard` preset, persona and tool set included.

### Precondition: the installation must be healthy

Before the three phases the runner asks its own question: can this `dsh` create a
Session in the shipped `web` profile, and does it come back with
`agentPreset: "standard"`? It boots the profile once with a two-file throwaway
overlay (`createPeer` + `session/create`, nothing else) and inspects the answer.

- **Healthy** → prints `env ok  session/create → agentPreset="standard"` and runs
  the phases. The `agentPreset` value is also recorded in the arm timeline, so a
  PASS always carries the preset it was obtained under.
- **Damaged install** (`agent-preset/invalid`, or a Session created *without*
  `standard`) → **exit 2**, labelled `ENV`, with the raw reason lines. This is
  explicitly *not* a verdict on the wake path: the wake path was never reached.
  A damaged pnpm tree (one left behind by a failed install) produces exactly this
  while a clean install of the same version returns `standard` — see
  `docs/dsh-preset-audit.md` for the reproduction and how to tell them apart.
- It also refuses a **preset-free** result rather than passing under a profile
  shape the product does not ship.

### What it proves

Three assertions, nothing else:

1. A one-shot wake armed by process A is delivered into the Session by process B,
   which starts *after* the task came due — as a `user/message` with
   `source.kind === 'schedule'`.
2. dsh's own ledger recorded that delivery: `schedule.history` returns a
   `deliveredAt` whose `messageId` equals the delivered message.
3. After a third boot, the same `messageId` is still in the durable Session
   prefix (`sessionController.inspect`) — so the wake survives the process that
   received it.

Process A exits before the task is due, so the delivery in step 1 can only come
from dsh's boot-time catch-up — the "the machine was off" case, which is the one
that matters for a companion that outlives a session.

All three run with the shipped preset; no part of the profile is disabled.

### What it does NOT prove

- **A wake turn completing against a real model.** There is no credential here;
  the turn reaches `llm/retry` and ends in an error. Delivery is proved, the
  reply is not.
- **The desktop GUI.** `~/.dsh/profiles/desktop` is never touched. The GUI is an
  Electron host running its own bundled dsh, and this check does not exercise it.
- **Long-run reliability.** One wake, one restart. Nothing here says a companion
  wakes correctly every day for a week.
- **Anything about preset-free compositions.** The runner refuses them instead of
  measuring them, precisely because an earlier revision of this file did the
  opposite.

### History: why this file used to disable every preset

Worth keeping, because the mistake is instructive. An earlier revision disabled
`preset-standard/ptc/minimal/cordis` and `agent-preset-registry`, because every
`session/create` was failing with:

```
agent-preset/invalid
persona: prompt section "deployment:persona-prefix" is already registered
tool-subagent: standing `modelSelectionSettings` requires a scoped preset Context
```

That was read as a dsh defect, and the check was bent around it — which made the
script claim "the wake path works, as long as the companion gives up the persona,
the preset tool set and subagent tooling". Both halves were wrong:

- the failure was **one damaged local install**, not dsh. A clean install of the
  same `0.2.1-rc.2` returns `agentPreset: "standard"` every time
  (`docs/dsh-preset-audit.md`);
- the workaround therefore proved less than it appeared to, and a reader would
  have concluded the product needs that sacrifice.

The overlay no longer disables anything. The `agentPreset === "standard"` line in
the output, plus the precondition above, is what stops the same mistake returning.

### Reading the result

- `PASS`/`FAIL` lines are the three assertions, followed by a timeline of the
  timestamps that matter and the messageId they hang on.
- exit `0` — all three passed; exit `1` — an assertion failed (a real finding);
  exit `2` — `ENV`: the check could not run (no spawnable dsh, no `schedule`
  service, boot failure, or an install that cannot create a preset Session).
  Exit 2 is never a verdict on the wake path.

### Knobs

| variable | default | meaning |
| --- | --- | --- |
| `DSH_BIN` | — | dsh package dir or `lib/bin.js` (required) |
| `WAKE_LIVE_DSH_HOME` | `<tmp>/dsh-life-wake-live-home` | throwaway HOME; wiped at start, left on disk afterwards so a failure can be read |
| `WAKE_LIVE_AFTER_SECONDS` | `25` | how far out the one-shot is armed |
| `WAKE_LIVE_BOOT_TIMEOUT_MS` | `150000` | per-process cap |
