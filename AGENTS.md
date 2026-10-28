# Working in this repository

Conventions for anyone — human or agent — modifying this codebase. Each rule below
corresponds to a failure that actually occurred here; none are style preferences.

Start with the design documents:

- [`docs/PLAN.md`](docs/PLAN.md) — how it is built
- [`docs/PRODUCT.md`](docs/PRODUCT.md) — who it is for, why they stay
- [`docs/STORY.md`](docs/STORY.md) — why it is worth building

---

## 1. The governing test

> If an artifact cannot be described in one sentence as "this proves X", it is
> performance, not work.

Operational form: **feed it a deliberately vacuous input.** If it still passes,
it validates form, not substance.

A build gate was written for this repository and then deleted: an entirely empty
intent card (goal: "think first"; options: "a", "b") passed all three of its rules.
It was removed because a gate that can be fooled reports that work is under
control when it is not, and that false confidence leads to less rigor next time,
not more.

Before writing anything, ask: **if the content were removed and only the form
remained, would this still pass?**

---

## 2. Hard rules

### 2.1 Numbers are measured, never copied

The same fact has appeared with three or four different values in this
repository (tools: 11/13/17; state files: 7/8; LOC: 2438/4949).

- Authoritative sources: `node tools/facts.mjs` (measures structural facts and
  generates the marked blocks in the docs), `node verify/claims.mjs` (re-measures
  and checks every claim and generated block against them).
- This rule was violated *after* those tools existed. It is therefore enforced as
  an assertion: run `node verify/claims.mjs` after changing code, and it reports
  every document claiming a value the code contradicts. Run
  `node tools/facts.mjs --write` to regenerate the marked blocks in the docs.
- Volatile external figures must come from a single authoritative source. For
  GitHub stars, use the repository page, not the search API:

  ```sh
  curl -sSL https://github.com/<owner>/<repo> | grep -o '"stargazerCount":[0-9]*'
  ```

### 2.2 Every bug fix gets an assertion, and the assertion is verified

Required sequence: add the assertion → **restore the bug** → confirm the
assertion fails → restore the fix. An assertion that was never seen failing is
untested. One assertion in this repository passed unconditionally because its
checks were combined in the wrong order.

The same rule applies to a **figure**. A diagram is the artifact most likely to
look right while being wrong: a nonexistent dependency edge, a stale tool count,
a hand-copied byte figure are indistinguishable from true facts once drawn. So
every external-facing figure gets its own suite that re-derives what it claims
from source — see `verify/framework.mjs` for `docs/framework.html`, which checks
the drawn `import` edges as a **set equality** against the source (a missing edge
misleads exactly as much as an invented one).

Two corollaries learned the hard way:

- **A suite's check count is a structural fact**, so it must not vary by
  environment. Checks that need a local install (a resolvable `dsh`) or the
  network go behind an `--offline` flag that skips them *without counting them*
  (`verify/framework.mjs`, `verify/market.mjs`). Otherwise `claims` reports a
  false red on a machine whose numbers are actually correct.
- **A number that supports the central claim must never be transcribed.** The
  per-turn injected snapshot was hand-written as 682 bytes in `docs/MEMORY.md`
  while the measured value was 621 — and that number is the only evidence for
  "it stays cheap as it ages". It is now measured by `tools/facts.mjs`.

### 2.3 Platform and API facts come from official documentation

Assumptions about external interfaces have repeatedly been wrong:

- `sendMessage` has no idempotency parameter (Bot API reference). A source comment
  claiming cross-process safety from "the platform idempotency key" was false.
- The Bot API cannot look up a message by id. Returning `null` from `query()` is
  the honest result, not an omission.

Write a falsifiable experiment before recording a conclusion.

### 2.4 Every line of the plan is either implemented or marked not-done

There is no third state. The checklists in `docs/PLAN.md §0.7` exist for this.
When implementation and plan disagree, the implementation is authoritative and
the divergence is recorded.

### 2.5 Renumbering sections requires re-checking all references

Sections have been renumbered three times and cross-references have broken each
time. Confirm a heading exists before citing it:

```sh
grep '^### 7.3' docs/PLAN.md
```

---

## 3. Marking what is not done

Credibility depends on this and the requirements are specific.

- Unimplemented features are stated as such in the body text, not relegated to a
  footnote.
- External-facing artifacts (demos, landing page, videos) carry an explicit
  "what this proves / what it does not prove" statement. See
  [`docs/scenarios.html`](docs/scenarios.html), where each panel is labelled
  implemented or speculative with the source file named.
- `README.md` → "已知限制" is the reference for this practice. New unverified
  items are added there, not omitted because they are unflattering.

Deliberately scoped exceptions exist. Design mockups and demos depict the
intended product, not current capability; drawing an unbuilt channel is
legitimate. The honesty rule governs **capability claims** (channel support in
`docs/PRODUCT.md §7`, statements like "publishing is not implemented"), not
mockups.

---

## 4. Code conventions

- **No runtime dependencies.** The plugin loads into both an npm CLI and a
  bundled Electron runtime, which resolve dependencies from different roots. Only
  Node built-ins guarantee both. Justify any proposed dependency against this.
- **Pure logic in `lib/*.js`; IO in `store.js`.** State machines, ranking,
  labelling, and the outbox are pure with injectable clocks. This is what makes
  them deterministically testable, and what allows seven simulated days to run in
  0.1s.
- **Atomic writes.** All persistence is tmp-file plus rename. All reads tolerate
  corrupt or truncated files; a half-written JSON must not kill a life.
- **Comments explain why, not what.** Comment density is intentional: it records
  the reasoning behind a decision and which simpler alternative was tried and
  failed.

---

## 5. Verification

```sh
export DSH_BIN=<path to dsh lib/bin.js>   # required by some suites

node verify/smoke.mjs         # store, policy, soak, activity chooser
node verify/day-report.mjs    # ledger → human-readable day
node verify/life-week.mjs     # seven consecutive simulated days
node verify/ui.mjs            # UI registration and data layer
node verify/publish.mjs       # publish state machine, labelling, reconciliation
node verify/e2e-tools.mjs     # real dsh end to end
node verify/pack-install.mjs  # packaging and installation
node tools/facts.mjs          # structural facts (single source of truth)
node verify/claims.mjs        # documentation claims vs. measured code
```

Do not hard-code suite counts in prose; measure them.

Notes:

- On Windows, dynamic imports must go through `pathToFileURL`; a bare path raises
  `ERR_UNSUPPORTED_ESM_URL_SCHEME`. This has been hit twice, the second time
  because the suite passed on macOS. The Windows CI job is worth running.
- Browser automation, video rendering, and writes to `.git` require
  `sandbox_permissions: require_escalated`.
- A behavioural change updates both the assertion and the documentation.

---

## 6. Commits and collaboration

- Commit messages are written in Chinese and explain why the change was made,
  not only what changed.
- Stage only the files you modified. Multiple agents work in this repository
  concurrently; `git add -A` will capture their work in progress.
- Before reporting a defect in someone else's code, distinguish a real defect
  from a false alarm. A previous report of a "lost update" in the outbox was
  caused by calling `writeOutbox`, which the production path never uses (zero
  call sites). A false alarm costs as much as a missed one.
- Reverts leave a record. When removing something, state why in the commit
  message — the rationale for deleting `harness/` is preserved in the commit
  history. Do not rewrite history to erase mistakes; later readers need to know
  what was tried and rejected.

---

## 7. Principles worth remembering

1. Remaining alive matters more than being capable. The other half is feeling
   alive, which cannot be an optimization target — optimizing for it produces
   performance.
2. The system requires its agent to say "I did not manage it" when there is no
   evidence. The same standard applies to its authors.
3. Empty words cannot produce bugs. Test whether something is real by whether it
   surfaces facts nothing else would.
