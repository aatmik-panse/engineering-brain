# Guardian — Architectural Degradation Checklist

Run this checklist before every significant change: anything Level 2+, anything that adds a dependency, table, abstraction, network call, or copies existing behavior. Do NOT run it for Level 0–1 changes — a typo fix cannot degrade architecture, and checking wastes tokens.

The Guardian is advisory, not annoying. Most findings should be silent cockpit events. Interrupting the user is the exception, reserved for concerns that would be expensive to reverse.

## The 11 checks

For each check: how to detect it, a realistic example, and the default severity. Severity is a starting point — adjust up if the affected code is on a hot path or hard to change later, down if the change is trivially reversible.

### 1. Duplicating logic
- **Detect**: before writing a function, grep for its core terms and domain nouns: `grep -rn "calculateDiscount\|discount" src/ --include="*.ts"`. Search for the behavior, not just the name — the same logic often hides under a different name.
- **Example**: asked to add order-total discounting to the checkout API; `src/cart/pricing.ts` already computes discounts for the cart preview. Writing a second copy means the two drift the first time a discount rule changes.
- **Severity**: `warning`. `critical` if the duplicate is business-critical (billing, auth, permissions).

### 2. Second source of truth
- **Detect**: does the change store, cache, or denormalize data that already lives somewhere authoritative? Grep for the field name across models, schemas, and config: `grep -rn "subscription_status" prisma/ src/models/ config/`.
- **Example**: adding a `plan` column to `users` when Stripe is already the authority for plan state. Now two systems can disagree and every bug report starts with "which one is right?"
- **Severity**: `warning`. `critical` if the duplicated truth drives access control or money.

### 3. Unnecessary abstraction
- **Detect**: count call sites. An interface, factory, base class, or plugin system with one implementation and no concrete second use-case planned is speculative. `grep -rn "implements PaymentProvider" src/` — one hit means the interface is ceremony.
- **Example**: wrapping the single Postgres client in a `StorageAdapter` interface "in case we switch databases." Nobody switches databases; everybody pays the indirection tax on every read.
- **Severity**: `info`. `warning` if the abstraction forces changes across multiple files for simple edits.

### 4. Increased coupling
- **Detect**: does module A now import module B's internals, share B's private types, or reach into B's tables? Check import direction: `grep -rn "from '../billing/internal" src/notifications/`. New cross-module imports into `internal/`, direct foreign-table queries, and shared mutable state are the signatures.
- **Example**: the notifications worker starts reading the `invoices` table directly instead of consuming a `invoice.paid` event. Billing can no longer change its schema without breaking notifications.
- **Severity**: `warning`. `critical` when it creates a cycle (A→B and B→A).

### 5. Unnecessary dependency
- **Detect**: before `npm install` / `pip install`, ask: does the stdlib or an existing dependency cover this? Check `package.json` for an overlapping package; check how much of the new package you actually use.
- **Example**: adding `lodash` for one `debounce`, or `axios` when the codebase already uses `fetch` everywhere. Each dependency is a supply-chain surface, an upgrade chore, and a second way to do the same thing.
- **Severity**: `info`. `warning` for heavy deps (adds a build step, native bindings, >1 MB) or a second package overlapping an existing one.

### 6. Query that degrades with data
- **Detect**: inspect new queries for unbounded result sets, `LIKE '%x%'` on large tables, filters/sorts on unindexed columns, and N+1 loops (`for` over rows with a query inside). Grep ORM patterns: `grep -rn "findMany\|SELECT \*" src/` and check for `take`/`LIMIT` and index coverage in the schema.
- **Example**: `db.orders.findMany({ where: { userId } })` with no limit works in dev with 40 orders and times out for the customer with 90,000.
- **Severity**: `warning` on tables expected to grow; `info` on genuinely bounded tables (settings, feature flags). `critical` for unbounded scans on a request hot path.

### 7. Repeated network requests
- **Detect**: look for fetches inside loops, per-item API calls that have a batch endpoint, the same lookup fired by multiple components in one render/request, and missing caching on immutable responses. `grep -rn "await fetch" src/ | grep -B2 "for \|\.map("` is a crude but effective first pass.
- **Example**: enriching a 50-row admin table by calling the AI provider once per row instead of one batched call — 50× latency and 50× cost.
- **Severity**: `warning`. `critical` when the repeated call is metered (paid AI/API) or rate-limited.

### 8. Comprehension cost (harder for future developers/agents)
- **Detect**: after drafting the change, reread it cold. Red flags: control flow spanning >3 files for one feature, meta-programming (dynamic dispatch by string, decorators that rewrite behavior), clever one-liners replacing obvious code, names that no longer match behavior.
- **Example**: replacing three explicit route handlers with a config-driven handler generator. 30 lines saved, but now nobody can grep for "where is the refund endpoint handled?"
- **Severity**: `info`. `warning` if it obscures a money/auth/security path.

### 9. Solving a future problem that doesn't exist
- **Detect**: the justification contains "in case we", "when we eventually", "to support future" — and no issue, user, or metric demands it. Multi-tenancy hooks, i18n plumbing, plugin registries added "while we're here."
- **Example**: building a per-tenant config resolution layer for an app with one tenant and no signed enterprise customer. Every real feature now pays a tax for a hypothetical one.
- **Severity**: `info`. `warning` if it adds schema/API surface that will be painful to remove.

### 10. Premature optimization
- **Detect**: optimization applied without a measurement. Ask: is there an observed or measured number showing this path is slow? Caching layers, hand-rolled memoization, denormalized read models, and worker fan-out added on vibes are the usual forms.
- **Example**: adding Redis caching to an endpoint that serves 12 requests/day in 40 ms. New infra to run, new invalidation bugs, zero user benefit.
- **Severity**: `info`. `warning` when the optimization adds infrastructure or an invalidation problem.

### 11. Hidden dependency
- **Detect**: coupling that no import, schema, or config declares — the kind that accumulates silently. Signatures: reading another component's env vars, files, or cache keys directly; depending on execution order or timing ("the cron must run before the report"); parsing another module's log lines or string formats; two components that must be deployed together with nothing recording that fact. Ask: "if the other side changes, what tells the next developer this will break?" If the answer is "nothing," the dependency is hidden.
- **Example**: the report generator reads the cache key `stats:daily:v2` that the analytics worker happens to write. Nothing links them; the worker team renames the key during a refactor and reports silently go stale for a week.
- **Severity**: `warning` — hidden dependencies are invisible until they break, so surface them even when cheap. `critical` if the hidden link crosses a deploy boundary or carries money/auth state. When the dependency is legitimate, make it visible instead: an explicit import, a shared constant, a declared contract, or at minimum an edge in the system map (`system-map.md`).

## Interruption policy — advisory, not annoying

| Severity | Threshold | Behavior |
|---|---|---|
| `info` | Real but cheap to live with or reverse later (a one-implementation interface, a small dep, a bounded-table query). | **Stay silent in chat.** Emit a `concern` event only. Proceed. |
| `warning` | Would likely cost real rework later, or the user would plausibly choose differently if told (duplicate business logic, new coupling, degrading query on a growing table). | One or two sentences in chat + `concern` event. State the concern and what you're doing about it. Proceed unless the user objects. |
| `critical` | Hard to reverse, or corrupts a source of truth: second authority for money/auth state, module cycle, unbounded scan on a hot path, metered call in a loop. | **Stop.** Emit `concern`, then `decision_needed` (kind `approve`), start `poll.mjs` in the background, and wait for the user. |

Hard limits: never emit more than one `critical` interruption per finding; never repeat the same concern twice in a session (the journal is the record — check what you already emitted); if you found a concern AND already avoided it in your implementation, that is `info` — you are reporting a dodge, not raising an alarm.

## Emit examples

Give every concern a `plain` field translating the finding into its practical consequence — what it means for the app and its users, no jargon (translation table in `plain-language.md`).

Silent info concern (cockpit only, no chat mention):

```bash
node <skill-root>/scripts/emit.mjs --session eb-m1x9k2-a4f7 --type concern --data '{"severity":"info","title":"StorageAdapter has one implementation","detail":"src/storage/adapter.ts defines an interface implemented only by PostgresStorage. Keeping it, but it is speculative.","plain":"There is an extra layer here built for a second storage system that does not exist. It is harmless for now, just unnecessary — worth removing if it never gets used.","recommendation":"Inline the interface if no second backend appears by the next touch of this module."}'
```

Warning (also say one sentence in chat: "Heads up — the cart already computes discounts in src/cart/pricing.ts; I'm reusing it instead of duplicating."):

```bash
node <skill-root>/scripts/emit.mjs --session eb-m1x9k2-a4f7 --type concern --data '{"severity":"warning","title":"Requested change would duplicate discount logic","detail":"Checkout API needs order-total discounting; src/cart/pricing.ts:41 calculateDiscount() already implements the rules for cart preview. A second copy would drift on the next rule change.","plain":"The discount rules would live in two places, and the next time a rule changes, the two copies can silently disagree — customers could see one price in the cart and pay another. I am reusing the existing rules instead.","recommendation":"Extract calculateDiscount into src/pricing/ and call it from both paths. Doing this now."}'
```

Critical — stop and ask (concern, then decision, then background poll):

```bash
node <skill-root>/scripts/emit.mjs --session eb-m1x9k2-a4f7 --type concern --data '{"severity":"critical","title":"Plan status would get a second source of truth","detail":"Adding users.plan while Stripe subscription state is authoritative. Webhook lag or a failed sync means access control disagrees with billing.","plain":"The same information — which plan a user is on — would live in two places, and they can silently disagree. When they do, someone gets features they did not pay for, or a paying customer gets locked out.","recommendation":"Read plan from the existing subscriptions cache (synced by webhook, single writer) instead of a new column."}'
node <skill-root>/scripts/emit.mjs --session eb-m1x9k2-a4f7 --type decision_needed --data '{"decisionId":"d-guardian-1","kind":"approve","prompt":"Storing plan on users creates a second source of truth for billing state. Proceed as requested, or switch to reading the synced subscriptions cache?","choices":[{"id":"proceed","label":"Proceed with users.plan as requested"},{"id":"cache","label":"Use the subscriptions cache (recommended)"}]}'
node <skill-root>/scripts/poll.mjs --session eb-m1x9k2-a4f7   # run as a background task — never block the foreground shell; the harness notifies when it returns
```

React to the poll result: `decision` with a `choiceId` → follow that choice; `steer`/`answer` → incorporate the message and keep polling if the decision is still open; `timeout` → say so in chat once and proceed with the recommended (safer) path ONLY if that path is itself easily reversible, noting the assumption in the eventual `learning` event — if every path is hard to reverse, do not proceed (re-emit `decision_needed` and ask in chat, per `options.md`).
