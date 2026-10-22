# Options — Generating Genuinely Distinct Alternatives

Generate options only when multiple strategies are genuinely valid (Level 3+). If inspection shows one approach is clearly right, say so and implement — presenting fake alternatives wastes the user's attention and trains them to ignore your comparisons.

## The straw-man test

An option earns its place only if a reasonable senior engineer would actually choose it for some plausible team or timeline. Before emitting, ask of each option: "Under what real circumstances would this one win?" If you cannot answer, delete it. "Do it badly," "do it without error handling," and "the same approach with a worse library" are straw men, not options.

## The three archetypes

Distinct options usually differ on the effort/robustness axis, not on cosmetics:

- **Fastest** — the smallest change that genuinely satisfies the goal. Reuses existing structures, adds no infrastructure, ships today. Its honest weakness is a known ceiling (scale, flexibility, or duplication), which you must state.
- **Recommended** — the balanced build: right-sized for the system as it exists plus its realistic 6–12 month trajectory. Usually (not always) the one you recommend.
- **Scale-first** — the architecture you would want at 10–100× load or team size: queues, extracted services, dedicated stores. Its honest weakness is cost you pay now for load you do not have.

These are archetypes, not a quota. When the fastest option and the balanced option are the same thing, or the scale-first option solves problems this system will never have, **present 2 options — that is the honest number**. Never pad to 3. Occasionally a 4th appears when two structurally different balanced designs exist (e.g., "extend the API" vs "move it to the worker"); include it only if it passes the straw-man test.

## Comparison dimensions

Pick 4–7 dimensions that actually differentiate these options, from this vocabulary (do not invent new names):

`development effort` · `implementation speed` · `infra cost` · `AI/API cost` · `maintenance` · `complexity` · `performance` · `latency` · `throughput` · `scalability` · `reliability` · `failure risk` · `reversibility` · `technical debt` · `operational difficulty`

Score each option 1–5 per dimension (5 = best). If every option scores the same on a dimension, drop the dimension. Attach a `note` wherever a bare number would mislead, and keep evidence honesty: a scalability score based on reading the schema is inferred — say so in the note ("inferred from schema, not load-tested").

## The opinionated-recommendation rule

Never pretend options are equal. Exactly one option carries `recommended: true`, and every non-recommended option's `why` field must state plainly why it loses — in concrete terms, not hedges. Good: "Option C solves problems we do not have: nothing in this system approaches queue-worthy volume, and it adds Redis to operate." Bad: "All options have trade-offs; it depends on your priorities." If you truly cannot rank them, you have not inspected enough — go back and inspect, or ask the one question that would break the tie.

In chat, give the one-paragraph version: the options exist, which you recommend, and the single strongest reason. The cockpit carries the full matrix.

## Write for the human deciding

The person choosing may not be an engineer. `situation`, `tagline`, `pros`, `cons`, and `why` are jargon-free consequence language — what each choice means for the app, its users, speed, cost, and future work ("renders happen in the background, so the page never freezes", not "async job dispatch via BullMQ"). `scores`, `comparisonDimensions`, and their notes are the technical layer; the UI collapses them behind a "Show me how this works technically" expander in Simple view, so never put decision-critical information only there. Open with `situation`: one plain paragraph describing the current state and why a decision is needed — it renders above the cards. Full rules and translation patterns: `plain-language.md`.

## Emitting the comparison

Full 3-option example — "add PDF export to invoices":

```bash
node <skill-root>/scripts/emit.mjs --session eb-m1x9k2-a4f7 --type options --data '{
  "decisionId": "d1",
  "situation": "Building a PDF of an invoice takes several seconds. If the app builds it while the user waits on the page, everything about that request is stuck until the file is ready — so we need to decide where that slow work should happen.",
  "comparisonDimensions": ["development effort", "latency", "infra cost", "reliability", "scalability", "reversibility"],
  "options": [
    {
      "id": "A", "name": "Inline render in API", "tagline": "Generate the PDF in the request handler", "recommended": false, "effort": "~2 hours",
      "scores": {
        "development effort": { "score": 5, "note": "one endpoint, one library" },
        "latency": { "score": 2, "note": "3-8s render blocks the request; estimated from library benchmarks" },
        "infra cost": { "score": 5 },
        "reliability": { "score": 2, "note": "render failure = request failure, no retry" },
        "scalability": { "score": 2, "note": "renders compete with API traffic for CPU" },
        "reversibility": { "score": 5 }
      },
      "pros": ["Ships today", "No new moving parts"],
      "cons": ["Blocks API workers during render", "Timeout risk on large invoices"],
      "why": "Loses because invoice PDFs can take 8s: users hit request timeouts and API throughput drops during month-end export bursts (inferred from the 30s gateway timeout observed in config)."
    },
    {
      "id": "B", "name": "Render in existing worker", "tagline": "Enqueue a job on the BullMQ worker already processing emails", "recommended": true, "effort": "~1 day",
      "scores": {
        "development effort": { "score": 4, "note": "worker and queue already exist" },
        "latency": { "score": 4, "note": "async: user gets a ready-notification; render off the hot path" },
        "infra cost": { "score": 5, "note": "reuses existing Redis + worker" },
        "reliability": { "score": 4, "note": "queue retries handle transient render failures" },
        "scalability": { "score": 4, "note": "add worker concurrency if volume grows" },
        "reversibility": { "score": 4 }
      },
      "pros": ["Reuses proven infrastructure", "Retries for free", "API stays responsive"],
      "cons": ["Async UX: user waits for a notification", "Adds a job type to the worker"],
      "debt": "None new; extends an existing pattern.",
      "why": "Right-sized: gets renders off the request path using infrastructure this codebase already runs and understands."
    },
    {
      "id": "C", "name": "Dedicated export service", "tagline": "Separate service + S3 + signed URLs + its own queue", "recommended": false, "effort": "~1 week",
      "scores": {
        "development effort": { "score": 1 },
        "latency": { "score": 4 },
        "infra cost": { "score": 2, "note": "new service, bucket, deploy pipeline" },
        "reliability": { "score": 4, "note": "isolated failure domain" },
        "scalability": { "score": 5, "note": "scales independently — but current volume is ~200 exports/day, observed in logs" },
        "reversibility": { "score": 2 }
      },
      "pros": ["Fully isolated", "Handles 1000x current volume"],
      "cons": ["New service to deploy, monitor, and secure", "A week of work"],
      "debt": "Operational surface grows permanently.",
      "why": "Loses because it solves problems we do not have: 200 exports/day is three orders of magnitude below where isolation pays for itself."
    }
  ]
}'
```

Then request the decision and start the background poll:

```bash
node <skill-root>/scripts/emit.mjs --session eb-m1x9k2-a4f7 --type decision_needed --data '{"decisionId":"d1","kind":"choose_option","prompt":"PDF export: inline render (A), existing worker (B, recommended), or dedicated service (C)?","plain":"I have compared the realistic ways to add PDF export. I recommend reusing the background helper the app already runs — pick an option or tell me what matters most to you.","choices":[{"id":"A","label":"A - Inline render"},{"id":"B","label":"B - Existing worker (recommended)"},{"id":"C","label":"C - Dedicated service"}]}'
node <skill-root>/scripts/poll.mjs --session eb-m1x9k2-a4f7   # run as a background task — never block the foreground shell; the harness notifies on completion
```

Tell the user in chat that the comparison is live in the cockpit and which option you recommend. They may answer in chat OR click in the UI — accept whichever arrives first.

## Reacting to poll results

`poll.mjs` prints exactly one JSON action, then exits. Handle each shape:

- `{"type":"decision","decisionId":"d1","choiceId":"B"}` — the user chose. Confirm in one chat line ("Going with B — worker render."), emit a `note` if the choice was not your recommendation and it changes any stated risk, then implement that option. Decision resolved; do not re-poll for it.
- `{"type":"steer","message":"prefer the queue approach but keep exports under 5s"}` — guidance, not a resolution. Incorporate it (update the affected option or your recommendation, re-emit `options` if scores changed), reply briefly in chat, and **run poll.mjs again in the background** — the decision is still open.
- `{"type":"answer","decisionId":"d1","message":"we expect 10x invoice volume next quarter"}` — new information for an open question. Re-evaluate: if it flips the recommendation, say so and re-emit `options` with corrected scores/`why` fields before re-polling; otherwise acknowledge and keep polling.
- `{"type":"timeout"}` — ask in chat; do not pick (`cockpit.md`).
