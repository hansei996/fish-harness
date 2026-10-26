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

**Cost:** ~1–2 minutes, three short-lived local processes, one throwaway
`DSH_HOME` under the temp dir (wiped per run). **No model credential is used**,
so no spend — the wake turn's model call is expected to fail.

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

It does **not** assert anything about model output, tool use, or the reply.

### What it does NOT prove

- **A wake turn completing against a real model.** There is no credential here;
  the turn reaches `llm/retry` and ends in an error. Delivery is proved, the
  reply is not.
- **The desktop GUI.** `~/.dsh/profiles/desktop` is never touched. The GUI is an
  Electron host with its own composition (including user plugins) and remains
  unverified for this path — see the preset caveat below, which would bite it too
  if that composition mounts the same preset trees.
- **Long-run reliability.** One wake, one restart. Nothing here says a companion
  wakes correctly every day for a week.
- **That this is how the product should run.** See the warning below.

### The workaround you are looking at

`verify/live/wake.patch.yml` disables **all shipped agent presets** and the
preset registry. Without that, on dsh `0.2.1-rc.2`, every `session/create` in the
shipped `web` profile fails with `agent-preset/invalid`: each preset's audit
re-mounts plugins the deployment layer already mounted (persona prompt section,
persistent pwsh tool, compact command, subagent model selection) and reports the
preset unusable. It fails identically through a direct service call, a Peer RPC,
and HTTP, so it is a dsh bug rather than an entry-point problem.

Consequence: the Session under test is **preset-free** — no persona, no preset
tool set, no subagent tooling. That is deliberate sabotage for the duration of
the check, not a supported way to boot dsh. When the upstream audit is fixed,
delete the `disabled` rows and the three assertions should hold unchanged with
the default preset.

Background, with file/line evidence: `docs/dsh-schedule-api.md` and
`docs/wake-e2e.md`.

### Reading the result

- `PASS`/`FAIL` lines are the three assertions, followed by a timeline of the
  timestamps that matter and the messageId they hang on.
- exit `0` — all three passed; exit `1` — an assertion failed (real finding);
  exit `2` — `ENV`, i.e. the check could not run on this machine (no spawnable
  dsh, no `schedule` service, boot failure). Exit 2 is never a verdict on the
  wake path.

### Knobs

| variable | default | meaning |
| --- | --- | --- |
| `DSH_BIN` | — | dsh package dir or `lib/bin.js` (required) |
| `WAKE_LIVE_DSH_HOME` | `<tmp>/dsh-life-wake-live-home` | throwaway HOME; wiped at start, left on disk afterwards so a failure can be read |
| `WAKE_LIVE_AFTER_SECONDS` | `25` | how far out the one-shot is armed |
| `WAKE_LIVE_BOOT_TIMEOUT_MS` | `150000` | per-process cap |
