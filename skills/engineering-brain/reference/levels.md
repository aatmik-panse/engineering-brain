# Level Playbooks (L0–L4)

One playbook per level: trigger profile, exact step sequence, cockpit events per step, what NOT to do, and human decision points. Level selection and scoring: `classification.md`. Event payload schemas: `cockpit.md`; the payloads below are canonical shapes.

**Dynamic re-evaluation applies at every level**: after each step, if evidence contradicts the current level, reclassify immediately (emit `reclassified` at L2+; boot the cockpit first when escalating from L0/L1). Never finish a task at a level the evidence no longer supports.

## Cockpit boot (Levels 2+ only)

```bash
node <skill-root>/scripts/brain.mjs --request "Change the orders list default sort to newest-first"
# → {"ok":true,"url":"http://127.0.0.1:8641/?session=eb-mfwz1x2b-a4f1","port":8641,"sessionId":"eb-mfwz1x2b-a4f1","token":"9f2c...","mapExists":true,"projectRoot":"/Users/x/proj"}
```

Tell the user the URL exactly once ("Cockpit: http://127.0.0.1:8641/?session=eb-mfwz1x2b-a4f1"). `brain.mjs` journals `session_start` itself. Chat is overhead afterwards — emit detail to the cockpit; keep chat to decisions, blockers, and one-line progress. If anything looks wrong (stale session, unclear server state), run `node <skill-root>/scripts/status.mjs` before assuming; the journal is canonical and pending UI actions survive server restarts (recovery: `cockpit.md`). Always finish a cockpit session with `session_end` (`outcome`: `completed` | `abandoned` | `handed_off`).

## Level 0 — Direct

**Trigger**: all five scores low. Typos, label text, isolated style tweaks, mechanical renames.
**Steps**: implement → validate (run the narrowest relevant check: render, lint, one test) → one-line confirmation to the user.
**Events**: none. No cockpit, no server, no `brain.mjs`.
**Do NOT**: boot the cockpit, ask questions, present options, explain architecture, write a summary longer than the diff.
**Decision points**: none.
**Re-evaluate**: if the "trivial" edit turns out to touch a second subsystem or a cached/derived value, stop, reclassify (usually to L2), boot the cockpit, emit `classified` (original level + rationale) then `reclassified`.

## Level 1 — Guided

**Trigger**: small but meaningful; one subsystem, one obvious approach, but the user should understand what changed and why.
**Steps**: understand (read the touched code) → one-paragraph "what I'll do and why" in chat → implement → explain changes (what/where/why, 3–6 lines).
**Events**: none. No cockpit, no server.
**Do NOT**: boot the cockpit, generate options, emit anything, ask questions unless a clarifying answer would change the implementation (materiality test), pad the explanation.
**Decision points**: none — proceed without waiting after stating the plan.
**Re-evaluate**: same escalation rule as L0. The most common escalation in practice is L1 → L2 during the "understand" step.

## Level 2 — Investigate

**Trigger**: multiple parts of the codebase affected, or medium+ uncertainty about the affected path — but once inspected, one reasonable approach.
**Steps**: boot cockpit → classify → inspect relevant systems → map what's touched → explain current flow + concerns → choose approach (state it, don't ask) → implement → validate → short learning report → end.

1. Boot (above), then emit `classified`:
```bash
node <skill-root>/scripts/emit.mjs --session eb-mfwz1x2b-a4f1 --type classified \
  --data '{"level":2,"levelName":"Investigate","scores":{"complexity":"low","risk":"medium","uncertainty":"medium","reversibility":"low","blastRadius":"medium"},"rationale":"Sort order flows through SQL, Redis cache key, and scroll cursor; stale-cache risk. One sane approach once mapped.","plannedSteps":["inspect order read path","map touched systems","implement sort + cache key change","validate cache invalidation"],"skippedSteps":[{"step":"options","why":"no genuinely distinct strategies — cache key must change either way"},{"step":"approval","why":"trivially revertible"}]}'
```
2. Bracket each step with `step` events; emit `inspection` with evidence-labeled claims as you learn:
```bash
node <skill-root>/scripts/emit.mjs --session eb-mfwz1x2b-a4f1 --type step \
  --data '{"name":"inspect order read path","status":"start"}'
node <skill-root>/scripts/emit.mjs --session eb-mfwz1x2b-a4f1 --type inspection \
  --data '{"area":"orders read path","summary":"Sort is applied in three layers; cache key omits sort direction, so flipping the default serves stale ordering for ~15 min.","files":["src/api/orders.ts","src/cache/keys.ts","web/src/hooks/useOrders.ts"],"claims":[{"text":"ORDER BY created_at ASC hardcoded in listOrders query","evidence":"observed"},{"text":"cache TTL is 900s","evidence":"observed"},{"text":"~15 min of stale ordering after deploy if key unchanged","evidence":"inferred"}]}'
node <skill-root>/scripts/emit.mjs --session eb-mfwz1x2b-a4f1 --type step \
  --data '{"name":"inspect order read path","status":"done","detail":"3 layers involved; cache key is the trap"}'
```
3. Emit `system_map` with `focus` on touched nodes (nodes/edges per the map schema; the server merges them into `map.json`):
```bash
node <skill-root>/scripts/emit.mjs --session eb-mfwz1x2b-a4f1 --type system_map \
  --data '{"nodes":[{"id":"orders-api","name":"Orders API","kind":"api","responsibility":"list/read orders","evidence":"observed","risks":["cache key omits sort direction"],"meta":{}},{"id":"redis","name":"Redis","kind":"cache","responsibility":"list-response cache, 900s TTL","evidence":"observed","risks":[],"meta":{}}],"edges":[{"from":"orders-api","to":"redis","kind":"read","evidence":"observed"}],"focus":["orders-api","redis"]}'
```
4. Emit `concern` for anything meaningful found (guardian checklist in `guardian.md`); include a `recommendation` when you have one. Then state the chosen approach in chat and via a `note` event — do NOT open a decision.
5. Implement, then emit `implementation` and `validation`:
```bash
node <skill-root>/scripts/emit.mjs --session eb-mfwz1x2b-a4f1 --type implementation \
  --data '{"summary":"Default sort flipped to newest-first; sort direction added to cache key so old entries miss cleanly.","changes":[{"file":"src/api/orders.ts","kind":"modified","note":"ORDER BY created_at DESC default"},{"file":"src/cache/keys.ts","kind":"modified","note":"sort direction in key"},{"file":"web/src/hooks/useOrders.ts","kind":"modified","note":"cursor uses createdAt desc"}]}'
node <skill-root>/scripts/emit.mjs --session eb-mfwz1x2b-a4f1 --type validation \
  --data '{"summary":"Unit + integration green; manual cache-miss check passed.","checks":[{"name":"orders api tests","result":"pass"},{"name":"cache key uniqueness test","result":"pass"},{"name":"load test","result":"skipped","detail":"no complexity-class change"}]}'
```
6. Emit a short `learning` (fields below under L4 — same shape, fewer entries), then `session_end` with `{"outcome":"completed"}`.

**Do NOT**: generate an options comparison, emit `decision_needed`, run `poll.mjs`, or block on the user. L2 informs; it does not ask.
**Decision points**: none by default. Exception: if inspection surfaces a question that passes the materiality test, emit `decision_needed` with `kind: "question"` and poll (mechanics under L3).
**Re-evaluate**: inspection is exactly where L2 → L3/L4 escalations happen (genuine alternatives appear, or a migration/high-consequence path is revealed). Emit `reclassified` and switch playbooks mid-session.

## Level 3 — Architecture Decision

**Trigger**: two or more genuinely distinct strategies whose long-term consequences differ; medium+ blast radius. Example: adding rate limiting (in-process vs Redis-backed vs gateway).
**Steps**: boot + `classified` (level 3, `"levelName":"Architecture Decision"`) → understand goal (ask only material questions) → inspect architecture (`step`/`inspection`/`system_map` as in L2) → generate genuinely distinct alternatives (rules in `options.md`) → compare + recommend → human decides → implement → validate → learning → end.

1. Emit `options` (write the JSON to a temp file — this payload is large):
```bash
node <skill-root>/scripts/emit.mjs --session eb-mfx2c8qq-7b2e --type options --data-file /tmp/eb-options-d1.json
```
`/tmp/eb-options-d1.json`:
```json
{"decisionId":"d1","comparisonDimensions":["development effort","infra cost","complexity","failure risk","scalability","reversibility"],
 "options":[
  {"id":"A","name":"In-process token bucket","tagline":"No new infra; per-instance limits only","recommended":false,"effort":"~0.5 day",
   "scores":{"development effort":{"score":5},"infra cost":{"score":5},"complexity":{"score":5},"failure risk":{"score":3,"note":"limits multiply per instance"},"scalability":{"score":2,"note":"breaks at >1 instance"},"reversibility":{"score":5}},
   "pros":["zero dependencies","simplest code"],"cons":["incorrect once horizontally scaled","no shared view of abuse"],
   "why":"Loses because the deploy target is already 3 instances — limits would be 3x the intended ceiling from day one (observed in fly.toml)."},
  {"id":"B","name":"Redis-backed sliding window","tagline":"Correct shared limits; one new moving part","recommended":true,"effort":"~2 days",
   "scores":{"development effort":{"score":4},"infra cost":{"score":4,"note":"existing Redis reused"},"complexity":{"score":4},"failure risk":{"score":4,"note":"fail-open on Redis outage"},"scalability":{"score":5},"reversibility":{"score":4}},
   "pros":["correct across instances","Redis already in the stack","fail-open keeps API up"],"cons":["adds Redis to the request hot path"],"debt":"limiter config lives in code until a second consumer needs it",
   "why":"Correct at the current topology, reuses existing infra, degrades gracefully."},
  {"id":"C","name":"Gateway-level limiting","tagline":"Zero app code; config coupling to the edge provider","recommended":false,"effort":"~1 day",
   "scores":{"development effort":{"score":4},"infra cost":{"score":3,"note":"paid tier feature"},"complexity":{"score":4},"failure risk":{"score":4},"scalability":{"score":5},"reversibility":{"score":3,"note":"provider lock-in"}},
   "pros":["no app changes","battle-tested"],"cons":["per-user limits need auth context the gateway lacks","provider lock-in"],
   "why":"Loses because limits must vary by API key tier, which only the app knows (observed in plans table)."}]}
```
2. Emit `decision_needed` with `kind: "choose_option"`, then poll as a **background task** (never block the foreground shell; the harness notifies on completion):
```bash
node <skill-root>/scripts/emit.mjs --session eb-mfx2c8qq-7b2e --type decision_needed \
  --data '{"decisionId":"d1","kind":"choose_option","prompt":"Rate limiting strategy — I recommend B (Redis sliding window). Choose or steer.","choices":[{"id":"A","label":"In-process token bucket"},{"id":"B","label":"Redis sliding window (recommended)"},{"id":"C","label":"Gateway-level"}]}'
node <skill-root>/scripts/poll.mjs --session eb-mfx2c8qq-7b2e --timeout 600000   # run in background
```
3. React to the returned action: `{"type":"decision","decisionId":"d1","choiceId":"B"}` → proceed with B. `{"type":"steer","message":"..."}` → adjust and keep polling (the decision is still open). `{"type":"answer",...}` → incorporate, re-emit updated `options` if it changes the comparison. `{"type":"timeout"}` → tell the user in chat the cockpit decision is pending and ask there; do not silently pick. In chat, mirror the recommendation in two sentences — the user may never open the cockpit; the chat must stand alone.
4. Implement → `implementation` → `validation` → `learning` → `session_end`, exactly as L2.

**Do NOT**: pad the comparison with strawmen; present options as equally good (mark exactly one `recommended: true` and give honest `why` losses); start implementing before the decision when the choice genuinely matters; skip the recommendation ("you decide" is an abdication). If mid-comparison one option becomes clearly dominant, say so, de-escalate to L2 (`reclassified`), and proceed.
**Decision points**: one `choose_option` decision. If the user replies in chat instead of the cockpit, honor the chat answer and emit a `note` recording it.
**Re-evaluate**: if the chosen option turns out to require a migration or new infra during implementation, escalate to L4 (`reclassified`) and get approval before the risky part.

## Level 4 — System Design

**Trigger**: major or risky — data migrations, new infrastructure, high failure consequences, hard-to-reverse changes. Example: moving user uploads from local disk to S3.
**Steps**: boot + `classified` (level 4, `"levelName":"System Design"`) → deep architecture analysis → dependency mapping (`system_map` with full touched subgraph + `focus`) → failure point analysis (per `failure-analysis.md`; emit each material finding as `concern`) → scaling scenarios + cost modeling (per `scaling-cost.md`; emit as `inspection` claims with honest evidence labels — `estimated` and `unknown` are respectable) → alternative architectures (`options`, as L3, when genuinely distinct designs exist) → implementation phases (emit a `note` listing the phases; each phase gets `step` start/done) → **approval** → phased execution → validation per phase → learning → end.

Failure-analysis concern example:
```bash
node <skill-root>/scripts/emit.mjs --session eb-mfx9k44p-c0d3 --type concern \
  --data '{"severity":"critical","title":"Migration window can lose uploads","detail":"Files written to local disk after the copy pass but before the cutover flag flips are never mirrored to S3. Single point of loss, not retryable.","recommendation":"Dual-write during migration; cutover reads to S3 only after a verified backfill diff is empty."}'
```

The approval gate — emit `decision_needed` with `kind: "approve"` BEFORE executing anything hard to reverse, and poll in the background:
```bash
node <skill-root>/scripts/emit.mjs --session eb-mfx9k44p-c0d3 --type decision_needed \
  --data '{"decisionId":"d2","kind":"approve","prompt":"Plan: dual-write to disk+S3 (phase 1, reversible) → backfill + verify (phase 2) → cutover reads (phase 3, flag) → remove disk path (phase 4, after 7 days clean). Est. S3 cost $4–9/mo (estimated; assumes <50GB, current growth). Approve execution?","choices":[{"id":"approve","label":"Approve plan"},{"id":"reject","label":"Hold — I have changes"}]}'
node <skill-root>/scripts/poll.mjs --session eb-mfx9k44p-c0d3 --timeout 600000   # run in background
```
On `approve` → execute phases, emitting `step`/`implementation`/`validation` per phase. On `reject` or `steer` → revise, re-emit the plan `note` and a fresh `decision_needed` (new `decisionId`). No approval action AND no chat answer → do not execute; end with `{"outcome":"handed_off"}`.

Full learning report (mandatory at L4, same shape as L2/L3):
```bash
node <skill-root>/scripts/emit.mjs --session eb-mfx9k44p-c0d3 --type learning \
  --data '{"whatChanged":["uploads dual-written to S3","backfill of 41k files verified","reads cut over behind UPLOADS_S3 flag"],"howItWorksNow":"Uploads go to S3 via signed PUT; disk path remains as fallback for 7 days.","whyThisApproach":"Dual-write + verified backfill was the only plan with zero loss window; big-bang copy had a critical gap.","whatWasAvoided":["big-bang migration","new CDN layer (premature — no latency complaint observed)"],"newRisks":["S3 outage now blocks uploads (fail-closed by choice)"],"watchNext":["S3 4xx/5xx rate for 7 days","disk-path hit count must reach 0 before phase 4"]}'
```

**Do NOT**: execute anything irreversible before approval; fake precision in cost/scale numbers (ranges + evidence labels, per `scaling-cost.md`); skip failure analysis because the happy path looks clean; collapse phases to move faster.
**Decision points**: `approve` before execution, always. Plus `choose_option` earlier if alternative architectures were presented. Approval received in chat counts — record it with a `note`.
**Re-evaluate**: even L4 can de-escalate — if deep analysis shows the existing abstraction absorbs the change safely, emit `reclassified` toward L2, say so plainly, and spare the user the ceremony. That honesty is the product.
