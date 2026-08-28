# Scaling & Cost Analysis

Estimate how the system behaves as usage grows and what each option costs — without inventing numbers. This analysis runs at Level 4 always, and at Level 3 when scalability or cost is a genuine differentiator between options. Its outputs feed `inspection` claims, `options` scores, and `concern` events.

## The no-fake-precision rule

Never state a number more precisely than your evidence supports. "~$40–120/mo depending on cache hit rate" is honest; "$83.50/mo" derived from three stacked guesses is fabrication with a decimal point. Precision must be earned by measurement. If you multiplied two estimates, the result is at best an estimate — widen the range accordingly. **Speculation is never presented as measured reality.** A claim without a label defaults to the weakest reading; label everything.

## Evidence labels

Every quantitative or behavioral claim carries exactly one label — the same vocabulary as everywhere else in this skill, plus one prose-only extension:

- **observed** — you read the code, schema, or config that makes the claim true ("pool size 10 in `db.ts:8`").
- **measured** — you ran it and have the number (benchmark output, `EXPLAIN ANALYZE`, load test, billing dashboard you were shown).
- **inferred** — follows from observed structure ("no index on the sort column, so the sort is in-memory") without running anything.
- **estimated** — derived from stated assumptions and arithmetic you show. Always a range, never a point.
- **unknown** — you cannot bound it with current information. Say so plainly; an unknown stated honestly beats a confident guess.
- **requires benchmarking** (prose only) — unknown, AND a specific cheap measurement would resolve it. Name the measurement ("run `EXPLAIN ANALYZE` on the feed query at 1M rows of synthetic data").

In prose and cockpit summaries, use all six labels. In event payloads, the contract's evidence enum is exactly `observed | measured | inferred | estimated | unknown` — map **requires benchmarking → `unknown`** and put the proposed benchmark in the claim text:

```bash
node <skill-root>/scripts/emit.mjs --session eb-m3k9x2-a4f7 --type inspection \
  --data '{"area":"scaling: feed query","summary":"Feed query is the first credible bottleneck; needs a benchmark before choosing between options","files":["src/db/queries/feed.ts","prisma/schema.prisma"],"claims":[{"text":"feed query joins 3 tables with no index on posts.created_at","evidence":"observed"},{"text":"at 10k users (~2M post rows, estimated) this join likely exceeds 500ms p95 — requires benchmarking with synthetic data before trusting","evidence":"unknown"},{"text":"current table has 1,842 rows (SELECT COUNT ran locally)","evidence":"measured"}]}'
```

## Scaling tiers

Analyze behavior at five tiers: **current / 100 / 1k / 10k / 100k users**. For each tier state: the first component to degrade, the failure mode (latency, cost, errors, ops burden), and the label for that claim. Rules:

- Anchor "current" in observed reality: actual row counts, actual traffic if visible, actual instance sizes from config. If none of that is visible, say "current load: unknown" and ask only if it materially affects the decision (rule 3).
- Translate "users" into the load unit that actually stresses the system (requests/sec, rows, jobs/day, tokens/day) and state the conversion assumption.
- Stop at the tier where the analysis stops being useful. A tool for a 12-person team does not need a 100k-user row filled with fiction — write "not a realistic tier for this product; skipped" (rule 6: do not solve future problems that do not exist).

### Worked bottleneck hypothesis (honest phrasing)

> **Tier 10k users** (~2M posts, ~20 req/s peak — estimated, assuming 200 posts/user and the 10:1 read ratio observed in the route handlers). First bottleneck hypothesis: the feed query. It performs an unindexed sort on `posts.created_at` (observed — `feed.ts:27`, no matching index in `schema.prisma`). On similar Postgres shapes this degrades noticeably somewhere between 10^5 and 10^7 rows, but where it lands for this schema and hardware is **requires benchmarking** — a synthetic 2M-row `EXPLAIN ANALYZE` would settle it in under an hour. Connection pool exhaustion is the second candidate (pool size 10, observed in `db.ts:8`) but only if p95 latency actually degrades — it is downstream of the same unknown.

Note what this paragraph does: names the mechanism, cites the file, gives a bounded range instead of a fake number, names the measurement that would resolve it, and keeps the dependent claim conditional.

## Cost estimation

Costs are **ranges with a confidence level and explicit assumptions**. Break every option's cost into five components; write "negligible" or "none" explicitly rather than omitting a row:

1. **Dev cost** — effort to build, in time (hours/days/weeks), not currency.
2. **Infra** — compute, storage, queue/DB hosting, bandwidth. Monthly.
3. **AI/API** — per-unit provider pricing × estimated volume. This is where fake precision breeds: token counts per request are estimated unless you measured a real payload; volume is estimated from the tier assumption. Show the arithmetic.
4. **Maintenance** — ongoing engineering: dependency upgrades, breakage surface, "who understands this in 6 months."
5. **Operational** — running it: monitoring, on-call surface, dead-letter replays, capacity tuning.

Confidence levels: **high** (priced from a rate card × measured volume), **medium** (rate card × estimated volume), **low** (stacked estimates — widen the range and say so).

### Worked example: Option B (queue + worker for AI summarization), 1k-user tier

> **Dev cost:** 2–4 days (estimated — queue infra exists in the repo already, observed; the range covers dead-letter handling and UI status states).
> **Infra:** $5–15/mo — one small worker instance; queue rides the existing Redis (observed in `docker-compose.yml`). Confidence: medium.
> **AI/API:** $30–90/mo. Assumptions: ~50 summaries/day at 1k users (estimated from the 5%-of-uploads ratio observed in current logs — that ratio itself is measured over one week, thin sample), ~3k input + 500 output tokens per summary (estimated — no real payload measured; **requires benchmarking** one production-shaped document), current provider rate card (observed, checked today). Arithmetic: 50/day × 30 × ~$0.02–0.06/summary. Confidence: low — token estimate dominates the error bar.
> **Maintenance:** low — one new moving part, standard library, no custom protocol.
> **Operational:** one new failure surface (worker liveness, queue depth). Needs one alert on queue depth; ~1 hr/mo expected. estimated.

Fold the totals into the `options` event honestly — scores get notes, not naked numbers:

```bash
node <skill-root>/scripts/emit.mjs --session eb-m3k9x2-a4f7 --type options \
  --data '{"decisionId":"d1","comparisonDimensions":["development effort","infra cost","AI/API cost","scalability","reliability"],"options":[{"id":"A","name":"Inline call","tagline":"Keep the synchronous provider call","recommended":false,"effort":"0.5 day","scores":{"development effort":{"score":5},"infra cost":{"score":5,"note":"$0 added"},"AI/API cost":{"score":4,"note":"same volume as B"},"scalability":{"score":2,"note":"blocks API threads; degrades past ~1k users (estimated)"},"reliability":{"score":1,"note":"provider outage = feature outage, cascades via pool"}},"pros":["zero new infrastructure","simplest to understand"],"cons":["cascading SPOF (see concern)","no retry, work lost on failure"],"why":"Cheapest today, but the failure analysis showed cascading behavior; loses on reliability, not on cost."},{"id":"B","name":"Queue + worker","tagline":"Async summarization with durable jobs","recommended":true,"effort":"2-4 days","scores":{"development effort":{"score":3,"note":"2-4 days, estimated"},"infra cost":{"score":4,"note":"$5-15/mo, medium confidence"},"AI/API cost":{"score":4,"note":"$30-90/mo, LOW confidence - token size unmeasured"},"scalability":{"score":5,"note":"drain rate tunable by worker count"},"reliability":{"score":5,"note":"retry + dead-letter; outage degrades gracefully"}},"pros":["survives provider outages","backlog absorbs spikes"],"cons":["eventual consistency in UI","one more component to operate"],"debt":"queue infra must be monitored","why":"Wins on every reliability dimension for 2-4 days of work; AI cost is identical across options so it does not differentiate."}]}'
```

## Rules of engagement

- Never let a measured label launder an estimated chain: "measured 1,842 rows today" does not make "2M rows at 10k users" measured.
- If cost or scale does not differentiate the options, say so in one line and do not build the tables — the analysis exists to change decisions, not to decorate them.
- When an unknown materially affects the recommendation, either propose the benchmark (if cheap) or surface it as a `decision_needed` question — do not average over it silently.
- Re-check provider rate cards rather than reciting remembered prices; label the check date.
