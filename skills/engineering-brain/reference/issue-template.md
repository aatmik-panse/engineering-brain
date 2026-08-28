# GitHub Issues — Generating Work Items After Understanding

Issues are the source of truth for work. Generate an issue only AFTER understanding: inspect the affected systems first, then write. An issue written before inspection encodes the user's guess; an issue written after inspection encodes reality. If a decision is still open (Level 3+ with an unresolved `decision_needed`), the issue is not `Ready` yet — file it at an earlier stage or wait.

## Idea ≠ Decision ≠ Task ≠ Implementation

These are four different artifacts. Collapsing them is how bad work gets scheduled:

- **Idea** — a direction worth exploring ("exports feel slow, maybe cache them"). Cheap, unvalidated.
- **Decision** — a chosen approach with reasons, after inspection and (if warranted) an options comparison.
- **Task** — a scoped, validated unit of work with success criteria. This is what the template below captures.
- **Implementation** — the code. Never the first artifact.

Worked reshaping example: the user files the idea *"cache the dashboard API, it's slow."* Inspection shows the dashboard endpoint is slow because it fires 30 sequential queries — one per widget — each fast on its own (observed via request logs and the handler at `src/api/dashboard.ts`). A cache would mask the symptom, add invalidation bugs, and still be slow on every cache miss. The idea enters `Exploring`; the decision that comes out is "batch the widget queries into one round-trip"; the task filed at `Ready` is **"Batch dashboard widget queries"** — a different task than the idea requested, and the right one. Record the reshaping in the issue's WHY so the original reporter sees their idea was heard, not ignored.

## Suggested project stages

`Ideas → Exploring → Decision → Ready → In Progress → Review/Validation → Done`

- **Ideas**: raw, one paragraph is fine. No template required.
- **Exploring**: inspection happening; findings accumulate as comments.
- **Decision**: approach chosen (link the options comparison reasoning); template gets filled in.
- **Ready**: full template complete, success criteria testable, no open decisions.
- **In Progress / Review-Validation / Done**: execution stages; on Done, close with a comment summarizing the learning report (see `post-implementation.md`).

Implement stages with whatever the repo already uses — a GitHub Project status field or `stage:*` labels. Do not introduce a second tracking mechanism if one exists.

## The template

Every `Ready` issue carries these nine sections. Keep each tight; delete nothing.

```
## GOAL            — the outcome, one or two sentences, user/system-facing
## WHY             — the problem evidence; if inspection reshaped the request, say how
## CURRENT STATE   — how it works today: files, flow, data. Evidence-labeled facts, not lore
## SUCCESS CRITERIA— testable checkboxes; if you can't test it, it isn't a criterion
## RECOMMENDED APPROACH — the chosen approach and, briefly, what it beat and why
## ARCHITECTURAL IMPACT — components touched, new/changed edges, map deltas
## KNOWN RISKS     — what could go wrong, each with severity and mitigation
## IMPLEMENTATION NOTES — ordering, gotchas, code locations the implementer needs
## VALIDATION REQUIREMENTS — the concrete checks that gate Done
```

## Worked example

`invoice-pdf-issue.md`:

```markdown
## GOAL
Users can download any invoice as a PDF from the invoice detail page, generated within 30 seconds of request.

## WHY
Support handles ~15 manual PDF requests/week (observed: support inbox label "invoice-pdf"). The original idea was "render a PDF in the API endpoint"; inspection showed renders take 3–8s (estimated from puppeteer-pdf benchmarks on our template size), which would block API workers behind the 30s gateway timeout — so this became an async worker task instead.

## CURRENT STATE
- Invoice data: `src/models/invoice.ts`, Postgres `invoices` + `invoice_lines` (observed).
- Detail page: `src/frontend/pages/InvoiceDetail.tsx`, fetches `GET /api/invoices/:id` (observed).
- Background jobs: BullMQ worker `src/worker/index.ts` on existing Redis, already handles `send-email` jobs with retry/backoff (observed).
- No PDF generation exists anywhere in the codebase (observed: grep for pdf/puppeteer/wkhtmltopdf is empty).

## SUCCESS CRITERIA
- [ ] "Download PDF" on invoice detail enqueues a render and shows pending state
- [ ] PDF ready within 30s for a 3-page invoice; UI offers the download
- [ ] Render failure retries 3x, then surfaces a user-visible error (not silence)
- [ ] API p95 latency unchanged (compare before/after on `GET /api/invoices/:id`)

## RECOMMENDED APPROACH
New `render-invoice-pdf` job on the existing worker; output to the existing uploads bucket; client polls `GET /api/invoices/:id/pdf-status`. Beat inline rendering (blocks API workers) and a dedicated export service (solves scale we do not have at ~15 requests/week). Decision d1, option B, approved by user 2026-08-28.

## ARCHITECTURAL IMPACT
Touches: api, worker, frontend. New edges: api → queue (enqueue render job), worker → uploads bucket (write PDF). No new services, stores, or dependencies except `puppeteer-core` in the worker.

## KNOWN RISKS
- Chromium in the worker image grows it ~280 MB (estimated) — verify deploy limits. Mitigation: use the existing base image's system Chromium if present.
- Long renders could starve `send-email` jobs. Mitigation: separate BullMQ queue name, shared worker process.

## IMPLEMENTATION NOTES
Template HTML can reuse `src/frontend/components/InvoicePrintView.tsx` markup — render it server-side rather than duplicating layout (guardian: avoid duplicate logic). Job payload: `{ invoiceId }` only; re-fetch data in the worker so retries see fresh state.

## VALIDATION REQUIREMENTS
- Unit: PDF job handler with a mocked renderer (success, retry, permanent failure)
- Integration: enqueue → poll → download against a dev invoice with 40 line items
- Manual: visual check of the rendered PDF vs InvoicePrintView for one real invoice
```

## gh CLI invocations

Write the body to a temp file, then create — never inline a multi-section body as a `--body` string:

```bash
gh issue create \
  --title "Invoice PDF export via existing worker" \
  --body-file invoice-pdf-issue.md \
  --label "stage:ready" \
  --assignee "@me"
```

Stage transitions and linking:

```bash
gh issue edit 142 --remove-label "stage:ready" --add-label "stage:in-progress"
gh issue comment 142 --body-file exploration-findings.md      # Exploring-stage findings
gh issue close 142 --comment "Shipped in #147. Learning report in the PR description."
```

If the repo uses a GitHub Project instead of labels, move items with `gh project item-edit` against the project's Status field; discover the field with `gh project field-list <number> --owner <org>`.

After creating the issue, surface it in the cockpit and chat:

```bash
node <skill-root>/scripts/emit.mjs --session eb-m1x9k2-a4f7 --type note --data '{"text":"Filed issue #142 (Invoice PDF export via existing worker) at stage:ready — approach B as decided in d1."}'
```
