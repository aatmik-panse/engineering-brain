# Post-Implementation — Learning Report, Map Update, Session End

Never end with just "Done." Every change ends with an explanation proportional to its level — L0 a one-line confirmation, L1 a short what/where/why in chat (see `levels.md`); no events, no cockpit. Every Level 2+ change ends with the full six-section learning report below (compact in chat, structured as a `learning` event), a system map update, and `session_end`. This is where the system gets smarter: the report tells the human what actually happened, the map update tells the NEXT session what the codebase now looks like.

## The learning report

Six sections, in this order — never fewer. Write it in chat (compact) and emit it as a `learning` event (structured). Facts only — every claim in it should be checkable against the diff or a validation run.

1. **What changed** — the concrete deltas: files, endpoints, jobs, schema. Bullet list, not prose.
2. **How it works now** — the new flow end to end, in the words a new teammate would need. This is the section people reread in three months.
3. **Why this approach** — the reasoning that won, referencing the decision if one was made. One paragraph.
4. **What was avoided** — the roads not taken and dodged degradations (guardian catches, rejected options). This is real work; make it visible.
5. **New risks** — what this change makes newly possible to go wrong. "None" is acceptable only if true.
6. **What to watch next** — concrete observable signals with thresholds where possible, plus known follow-ups. Not vague vigilance — things someone could put on a dashboard or calendar.

### Worked example (chat form)

> **What changed**: `render-invoice-pdf` job added to the worker (`src/worker/jobs/renderInvoicePdf.ts`); `GET /api/invoices/:id/pdf-status` and enqueue call in `src/api/invoices.ts`; download button + pending state in `InvoiceDetail.tsx`; `puppeteer-core` added to worker deps only.
>
> **How it works now**: clicking Download PDF enqueues a BullMQ job on a new `pdf` queue (same Redis, same worker process as `email`). The worker re-fetches the invoice, renders the shared `InvoicePrintView` markup server-side, writes the PDF to the uploads bucket, and stores the object key on the invoice row. The client polls pdf-status every 2s and swaps to a download link when ready. Failures retry 3x with backoff, then set status `failed`, which the UI surfaces.
>
> **Why this approach**: renders take 3–8s, so they had to leave the request path; the worker and Redis already existed, so async cost almost nothing (decision d1, option B, user-approved).
>
> **What was avoided**: inline rendering (would have blocked API workers behind the 30s gateway timeout); a dedicated export service (isolation we don't need at ~15 exports/week); duplicating the invoice layout — the worker renders the same `InvoicePrintView` component the frontend uses, so there is one source of truth for invoice appearance.
>
> **New risks**: worker image grew 210 MB (measured) from Chromium — deploys are ~40s slower; a burst of PDF jobs shares worker CPU with email jobs (separate queues, same process).
>
> **What to watch next**: `pdf` queue depth (alert if >50 sustained); email job latency after PDF launch — if it degrades, split the worker processes (follow-up noted in issue #142); Chromium version pinning on the next base-image bump.

### The learning event

Emit the same content structured. Exact payload shape (all six fields required; `plain` is optional — one sentence a non-technical person understands, summarizing what changed for them, per `plain-language.md`):

```bash
node <skill-root>/scripts/emit.mjs --session eb-m1x9k2-a4f7 --type learning --data '{
  "plain": "Invoice PDFs are now built in the background: clicking Download no longer makes the page wait, and the link appears as soon as the file is ready.",
  "whatChanged": [
    "render-invoice-pdf job added to worker (src/worker/jobs/renderInvoicePdf.ts)",
    "GET /api/invoices/:id/pdf-status + enqueue call in src/api/invoices.ts",
    "Download button with pending/failed states in InvoiceDetail.tsx",
    "puppeteer-core added to worker dependencies only"
  ],
  "howItWorksNow": "Download click enqueues a BullMQ job on a new pdf queue (existing Redis/worker). Worker re-fetches the invoice, renders the shared InvoicePrintView markup to PDF, writes it to the uploads bucket, and records the object key. Client polls pdf-status; retries 3x then surfaces failure.",
  "whyThisApproach": "Renders take 3-8s so they had to leave the request path; the worker and Redis already existed, making async nearly free (decision d1, option B, user-approved).",
  "whatWasAvoided": "Inline rendering (blocks API workers behind the 30s gateway timeout); a dedicated export service (unneeded at ~15 exports/week); duplicating invoice layout — the worker reuses InvoicePrintView, one source of truth.",
  "newRisks": [
    "Worker image +210 MB (measured) from Chromium; deploys ~40s slower",
    "PDF bursts share worker CPU with email jobs (separate queues, same process)"
  ],
  "watchNext": [
    "pdf queue depth — alert if >50 sustained",
    "email job latency post-launch; split worker processes if degraded (issue #142)",
    "Chromium version pinning on next base-image bump"
  ]
}'
```

## System map update

Update the map so it reflects the code as it now is, evidence-labeled `observed` (you just wrote it).

**Default: emit `system_map` deltas.** The server merges every `system_map` event into `map.json` automatically — nodes upserted by `id`, edges upserted by `(from, to, kind)` — so emit ONLY the nodes and edges this change created or altered, never the whole map. Include changed nodes in `focus`:

```bash
node <skill-root>/scripts/emit.mjs --session eb-m1x9k2-a4f7 --type system_map --data '{
  "nodes": [
    { "id": "worker", "name": "Background Worker", "kind": "worker", "responsibility": "BullMQ consumer: email sending and invoice PDF rendering", "evidence": "observed", "risks": ["Chromium adds 210MB to image", "pdf and email jobs share CPU"], "meta": { "queues": ["email", "pdf"] } },
    { "id": "queue-pdf", "name": "pdf queue", "kind": "queue", "responsibility": "Invoice PDF render jobs, retry 3x with backoff", "evidence": "observed", "risks": [], "meta": {} }
  ],
  "edges": [
    { "from": "api", "to": "queue-pdf", "kind": "event", "evidence": "observed" },
    { "from": "queue-pdf", "to": "worker", "kind": "dataflow", "evidence": "observed" },
    { "from": "worker", "to": "uploads", "kind": "write", "evidence": "observed" }
  ],
  "focus": ["worker", "queue-pdf"]
}'
```

**Structural rewrite: POST /map.** Use only when merging cannot express the change — nodes/edges must be REMOVED or renamed (a service deleted, a module split, ids restructured). `POST /map` replaces `map.json` wholesale, so: `GET /map`, rewrite the full object in memory (keep `learnings`, append to it, set `updatedAt`), then POST it back with the token. Read port and token from the project's `.engineering-brain/server.json`:

```bash
PORT=$(node -p "JSON.parse(require('fs').readFileSync('.engineering-brain/server.json')).port")
TOKEN=$(node -p "JSON.parse(require('fs').readFileSync('.engineering-brain/server.json')).token")
curl -s "http://127.0.0.1:$PORT/map" > /tmp/map.json
# ...edit /tmp/map.json: remove the deleted legacy-export node and its edges, append a learnings entry, bump updatedAt...
curl -s -X POST "http://127.0.0.1:$PORT/map" -H "x-brain-token: $TOKEN" -H "content-type: application/json" --data-binary @/tmp/map.json
```

Never POST a partial object to `/map` — it replaces, not merges; a partial body destroys the map.

## Ending the session

Last event, always, once the report and map update are emitted:

```bash
node <skill-root>/scripts/emit.mjs --session eb-m1x9k2-a4f7 --type session_end --data '{"outcome":"completed"}'
```

Outcomes: `completed` — implemented and validated; `abandoned` — the user cancelled or the approach was rejected without replacement (still emit `learning` first if anything was built or discovered — abandonment reasons are learnings too); `handed_off` — work continues outside this session (an issue was filed for someone else, or the user took over). Do not emit further events for this session after `session_end`; a follow-up request starts a new session via `brain.mjs`.
