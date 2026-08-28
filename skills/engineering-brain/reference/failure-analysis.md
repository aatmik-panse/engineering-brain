# Failure Point Analysis

Analyze how the system behaves when parts of it break. Output feeds the cockpit as `inspection` and `concern` events, and feeds the options comparison when reliability differentiates approaches.

## When to run this analysis

- **Level 4: always.** Failure analysis is a mandatory step of the L4 playbook. Never skip it, even if the system "looks simple."
- **Level 3: only when reliability is a comparison dimension.** If the options genuinely differ in failure behavior (sync call vs queue, single provider vs fallback, one DB vs read replica), run the analysis and let it drive the `reliability` and `failure risk` scores in the `options` event. If all options share the same failure profile, skip it and record why.
- **Levels 0–2: skip**, unless the request itself is about reliability (e.g. "why do we lose jobs when the worker restarts?") — then the analysis IS the work, at whatever level was classified.

When you skip it at L3, say so in the `classified` or `step` event:

```bash
node <skill-root>/scripts/emit.mjs --session eb-m3k9x2-a4f7 --type step \
  --data '{"name":"failure analysis","status":"skipped","detail":"all three options share the same runtime path; failure behavior is identical, reliability is not a differentiator"}'
```

## Scenario taxonomy

Run every scenario that has a corresponding component in the system map. Skip scenarios with no matching component (no queue → no queue-overload scenario) and note the skip.

| Scenario | Trigger | Applies when the map has |
|---|---|---|
| AI provider down | Provider outage, 5xx, auth revocation | any `ai` node |
| DB down | Primary unreachable, failover window, disk full | any `db` node |
| Worker crash | OOM, unhandled exception, deploy kill, host loss mid-job | any `worker`/`job` node |
| Queue overload | Enqueue rate > drain rate; backlog grows unbounded | any `queue` node |
| Rate limit | External API returns 429/quota exhausted | any `external`/`ai` node |
| Traffic spike | 10–50x normal request rate for minutes–hours | any `api`/`frontend` node |
| Slow dependency | Dependency answers, but at 10–100x normal latency | any `external`/`db`/`ai` edge |
| Partial failure | One instance/shard/region fails while others serve | any replicated or multi-instance component |

Slow dependency is usually worse than a hard-down dependency: hard failures trip fast, slowness ties up connections, threads, and timeouts upstream. Analyze it separately even when "X down" is already covered.

## Per-scenario template

Answer all six questions per scenario. "unknown" is an acceptable answer — an invented one is not.

1. **What fails** — the operations that error or hang, named concretely ("POST /generate returns 502", not "some requests fail").
2. **What continues** — everything unaffected. If the answer is "nothing," that is a finding (see cascading, below).
3. **What retries** — which layer retries, how many times, with what backoff, and whether retries are safe (idempotency).
4. **What data may be lost** — in-flight requests, unacked queue messages, uncommitted writes, in-memory state. "None, everything is journaled" must be traceable to code you read.
5. **User impact** — what the user sees: error page, stale data, delayed result, silent nothing. Silent nothing is the worst answer.
6. **Recovery behavior** — what happens when the component returns: automatic drain, manual replay, thundering herd, permanent loss.

## Classification

Tag each scenario result with exactly one primary classification:

- **SPOF** — the component's failure takes the whole capability (or system) down and nothing compensates. One `ai` node with no fallback, in the synchronous request path, is a SPOF for every feature that calls it.
- **Graceful degradation** — the feature gets worse but core function survives (cached answer served, AI feature disabled with a notice, writes queued for later).
- **Retryable** — the failure is transient and the existing retry/queue machinery absorbs it without operator action or data loss.
- **Cascading** — the failure propagates: slow DB → connection pool exhaustion → API thread starvation → health checks fail → load balancer removes healthy-but-busy instances. Always trace one level further than the direct failure before ruling this out.

A scenario can be retryable AND cascading (retries amplify load on a struggling dependency). When both apply, report cascading — it dominates.

Evidence rules apply (see `scaling-cost.md`): retry counts you read in code are `observed`; behavior you deduce from architecture is `inferred`; behavior that depends on config you have not seen is `unknown`.

## Emitting the analysis

Emit one `inspection` per analysis pass (or per scenario for L4 depth), and a `concern` for every SPOF or cascading finding:

```bash
node <skill-root>/scripts/emit.mjs --session eb-m3k9x2-a4f7 --type inspection \
  --data '{"area":"failure analysis: AI provider down","summary":"OpenAI is a synchronous SPOF for summarization; no timeout, no fallback, no queue","files":["src/services/summarize.ts","src/api/routes/documents.ts"],"claims":[{"text":"summarize() awaits the provider inline with no timeout configured","evidence":"observed"},{"text":"a provider outage will exhaust the API connection pool within minutes under normal load","evidence":"inferred"},{"text":"no requests are persisted before the provider call, so in-flight work is lost","evidence":"observed"}]}'

node <skill-root>/scripts/emit.mjs --session eb-m3k9x2-a4f7 --type concern \
  --data '{"severity":"critical","title":"AI provider is a cascading SPOF","detail":"Provider outage blocks API threads (no timeout), which starves unrelated endpoints sharing the pool. Classification: cascading.","recommendation":"Add a 10s timeout + circuit breaker minimum; queue-based decoupling if async is acceptable."}'
```

## Worked example: "AI provider down", current vs recommended

Feature: document upload triggers AI summarization. Current architecture: `frontend → api → ai (synchronous)`, summary written to `db` on response.

**Current architecture**

| Question | Answer | Evidence |
|---|---|---|
| What fails | Every `POST /documents` (upload handler awaits the summary before responding) | observed — `documents.ts:41` |
| What continues | Reads, auth, unrelated endpoints — until pool exhaustion, then nothing | inferred |
| What retries | Nothing. No retry wrapper on the SDK call | observed |
| Data lost | The uploaded file persists (S3 write happens first); the summarization *intent* is lost — no record it was ever attempted | observed |
| User impact | Upload spinner until browser timeout, then a generic 500. User assumes the upload failed and re-uploads | inferred |
| Recovery | Provider returns → new uploads work. Documents uploaded during the outage never get summaries | inferred |

Classification: **SPOF, becomes cascading** under load (no timeout → pool exhaustion spreads the outage to unrelated endpoints).

**Recommended architecture** — `api` enqueues a `summarize` job → `queue` → `worker → ai`, status field on the document row:

| Question | Answer |
|---|---|
| What fails | Only summarization. Upload returns 202 immediately with `summary: "pending"` |
| What continues | Everything, including uploads. The outage is invisible outside the summary field |
| What retries | Worker retries 5x with exponential backoff + jitter; after that the job parks in a dead-letter state |
| Data lost | None — the job row is the durable record of intent |
| User impact | Summary shows "processing" longer than usual; UI already handles this state |
| Recovery | Worker drains the backlog automatically; dead-lettered jobs replayed with one command |

Classification: **graceful degradation + retryable**. Cost of the improvement: a queue, a worker, a status field, and eventual-consistency UX — which is why this is an option to compare, not an automatic mandate (rule 6: the most resilient architecture is not automatically the best). Feed both rows into the `options` event's `reliability` and `failure risk` scores with honest `why` text.

## Anti-patterns

- Do not analyze scenarios the system cannot have. No worker → no worker-crash scenario. Emit the skip reason instead of padding the report.
- Do not present recovery behavior as fact when it depends on infrastructure config you have not read (supervisor restarts, queue redelivery settings). Label it `unknown` and, at L4, list verifying it as a step.
- Do not let the analysis silently expand the request into a reliability rewrite. Findings become `concern` events and issue candidates; the user decides scope.
