# Classification: Scoring Rubric and Level Selection

Run this rubric mentally on EVERY request before touching code — seconds, not minutes. Output: a level 0–4. At Level >= 2, boot the cockpit and emit a `classified` event (see `levels.md`). Classification is provisional: re-score whenever inspection changes the picture.

## Scoring dimensions

Score each dimension low / medium / high. Anchors below. When you lack information to score a dimension, that IS the uncertainty score — do not guess low.

**Complexity** — how much reasoning the change itself requires.
- low: mechanical edit, obvious diff ("rename this label")
- medium: new logic within one established pattern ("add a filter to this list endpoint")
- high: new algorithm, concurrency, protocol, or state machine ("dedupe events across workers")

**Risk** — probability something breaks in production.
- low: cosmetic, dead path, behind a flag
- medium: live code path with test coverage, failure would be visible immediately
- high: auth, payments, data writes, migrations, anything with silent-failure potential

**Reversibility** — difficulty of undoing the change. NOTE: this scores reversal *difficulty*, so high = bad, consistent with every other dimension. low = `git revert` fixes it; medium = revert plus cleanup (cache flush, config rollback); high = data migrated, messages consumed, external clients already coupled, emails sent.

**Uncertainty** — how much you don't know about goal or system.
- low: requirement unambiguous, code path known
- medium: requirement clear but the affected code path is unmapped
- high: the goal itself is ambiguous, or behavior depends on unread code / unknown production data

**Architecture impact** — does this change how components relate?
- low: contained inside one module's internals
- medium: changes a contract between two components (API shape, event payload)
- high: new component, new dependency direction, new source of truth

**Performance impact** — low: no hot path; medium: touches a hot path but same complexity class; high: changes query patterns, adds N+1 potential, adds synchronous network calls, or alters a loop's complexity class.

**Scalability impact** — low: behavior identical at 100x load; medium: adds per-request work that grows with data; high: adds per-user state, unbounded queues, full-table scans, or fan-out.

**Cost impact** — low: none; medium: measurable but bounded (one more small instance, modest API calls); high: per-request paid API calls, new infrastructure, storage that grows unbounded.

**User impact** — low: invisible or single-user cosmetic; medium: visible workflow change for some users; high: changes what all users see/do, or can lose user data or trust.

**Systems touched** — low: 1 file/module; medium: 2–3 subsystems (e.g. API + DB); high: 4+ subsystems or anything crossing a service boundary.

**Existing technical debt** — how load-bearing and messy is the area?
- low: clean, tested, recently touched
- medium: works but duplicated logic or thin tests nearby
- high: known haunted area — implicit coupling, no tests, "don't touch" comments

**Failure consequences** — if this ships broken, what happens?
- low: someone files a bug, you fix it
- medium: a feature degrades, users notice, no data harmed
- high: data loss/corruption, security exposure, outage, money moved incorrectly

## Condensing to the five emitted scores

The `classified` event carries exactly five score keys. Fold the twelve dimensions into them:

| Emitted key | Take the MAX of |
|---|---|
| `complexity` | complexity |
| `risk` | risk, failure consequences, existing technical debt |
| `uncertainty` | uncertainty |
| `reversibility` | reversibility (difficulty; high = hard to undo) |
| `blastRadius` | systems touched, architecture, performance, scalability, cost, user impact |

Record the dominating dimension in `rationale` — "risk=high (failure consequences: payment writes)", not just "risk=high".

## Level selection logic

Apply the first rule that matches, top to bottom:

1. **Level 4 — System Design**: `risk` high AND `reversibility` medium+; OR any data migration; OR new infrastructure/external dependency; OR failure consequences high. Human approval required before execution.
2. **Level 3 — Architecture Decision**: two or more *genuinely* distinct strategies exist whose long-term consequences differ (not variants of one approach), AND `blastRadius` medium+. If the alternatives are cosmetic, this is L2.
3. **Level 2 — Investigate**: `blastRadius` medium+ OR `uncertainty` medium+ OR debt high in the touched area — you must inspect before you can safely implement, but once inspected there's one reasonable approach.
4. **Level 1 — Guided**: everything low-to-medium, single subsystem, one obvious approach, but the change is meaningful enough that the user deserves a one-paragraph "what and why" — not just a diff.
5. **Level 0 — Direct**: all five emitted scores low. Just do it.

Tie-breakers: when torn between two levels and `reversibility` is low (easy to undo), pick the lower level — a cheap revert makes deliberation less valuable. When torn and the area has high debt or the request smells bigger than its wording, pick the higher level. Never pick a level for ceremony; pick it for expected value.

## Worked examples

1. **"Fix the typo: 'Prcoeed to checkout' → 'Proceed to checkout'."** All low. **L0.** No cockpit, no questions, edit, verify it renders, done.
2. **"Add a copy-to-clipboard button next to the API key."** complexity low, blastRadius low (one component + existing toast util), risk low. **L1.** One-paragraph explanation, implement, explain changes.
3. **"Change the orders list default sort to newest-first."** *Deceptively simple.* Scored L1 on wording (complexity low, blastRadius low). Inspection reveals sort order is baked into the SQL query, the Redis cache key, AND the infinite-scroll cursor — three subsystems, stale-cache risk. Systems touched → medium, risk → medium. **Reclassify L1 → L2**, boot the cockpit, emit `classified` then `reclassified` (see below).
4. **"Add rate limiting to the public API."** Genuinely distinct strategies: in-process token bucket (simple, breaks on multi-instance) vs Redis-backed counters (correct, adds infra dependency) vs gateway-level (zero code, config coupling). blastRadius medium, consequences differ for years. **L3.** Options + `decision_needed` kind `choose_option`.
5. **"Move user uploads from local disk to S3."** Data migration (reversibility high once files move), cost impact medium-high, failure consequences high (user files), external dependency. **L4.** Dependency map, failure analysis, migration phases, `decision_needed` kind `approve` before executing.
6. **"Migrate ALL our background jobs to a proper queue system."** *Scary-sounding.* Wording implies L4. Ten-minute inspection: there are exactly two jobs, both already invoked through a `JobRunner` interface with one call site, no persistence expectations. Swapping the runner implementation is a contained, reversible change. **De-escalate to L2.** Emit `reclassified` with the evidence; tell the user the honest scope.
7. **"Rename `formatDate` to `formatDateTime` (internal util)."** Mechanical, IDE-safe, all low. **L0.** Do not open the cockpit to rename a function.

## Escalation and de-escalation mid-work

Classification is a hypothesis; inspection is the experiment. Reclassify the moment evidence contradicts the level — never push on with a stale classification.

**Escalate when inspection reveals:** more systems than named (example 3); a hidden write path or shared mutable state; external consumers of the thing you're changing; a required data migration; you'd be creating a second source of truth; tests reveal load-bearing behavior you were about to change; the user's answer to a question widens the goal.

**De-escalate when inspection reveals:** an existing abstraction already supports the change (example 6); the scary-sounding target is dead code or feature-flagged off; the blast radius is one adapter, not the system; the "migration" is a config value.

On reclassifying at cockpit-active levels (2+), emit `reclassified` immediately, then a fresh `step` reflecting the new plan:

```bash
node <skill-root>/scripts/emit.mjs --session eb-mfwz1x2b-a4f1 --type reclassified \
  --data '{"fromLevel":1,"toLevel":2,"why":"Sort order is computed in three places: the SQL query, the Redis cache key, and the infinite-scroll cursor. Single-file assumption was wrong; stale-cache risk added."}'
```

Escalating from L0/L1 (no cockpit yet) INTO L2+: boot the cockpit first (`brain.mjs --request "..."`), emit `classified` with the original level and rationale, then `reclassified` — the trail must show the escalation, not pretend you knew all along. De-escalating from L2+ down: keep the cockpit open for the session; emit `reclassified` and skip the now-unjustified steps via `skippedSteps`-style `step` events with `status: "skipped"`.

## The materiality test

Before EVERY optional step — at every level — ask: **"Will this step materially improve the outcome?"** If no, skip it, and at L2+ record the skip in `classified.skippedSteps` with the reason. Applied per step:

- **Clarifying question**: ask only if different plausible answers lead to different implementations. "Should deleted users keep their comments?" — yes, ask (changes the schema). "Do you prefer `isActive` or `active`?" — no, decide and move on.
- **Deep research/inspection**: inspect only code the change can plausibly touch or break. Reading the whole payment module to change a tooltip fails the test.
- **Multiple options**: generate options only when 2+ approaches are genuinely distinct in long-term consequences AND the user's context (budget, team, timeline) could flip the winner. Never present a strawman to make a favorite look good — if one approach clearly wins, state it and proceed (L2, note the rejected alternative in one line).
- **Visualization (system_map / cockpit)**: emit a map when seeing the topology changes understanding — multi-system flows, new edges, focus on touched nodes. A one-node "map" for a CSS fix fails the test.
- **Approval**: request approval only when the decision is hard to reverse, expensive, or a matter of taste the user owns (L4 always; L3 when the recommendation is close or the user signaled they care). Approval for a trivially revertible refactor is process for its own sake.

No process for the sake of process — every skipped step, skipped for a stated reason, is a feature of this system, not a shortcut.
