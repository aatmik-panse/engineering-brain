# Building the System Map

The map (`<project>/.engineering-brain/map.json`) is the persistent model of the REAL codebase. It is built from files you actually read — repo structure, config, route definitions, imports — never from what a project of this type "usually" contains. If you did not see evidence for a node or edge, it does not go in the map, or it goes in labeled `inferred`/`unknown`.

## Schema

```json
{
  "nodes": [
    { "id": "api", "name": "API", "kind": "api", "responsibility": "HTTP interface: routing, validation, auth enforcement", "evidence": "observed", "risks": ["no rate limiting on public endpoints"], "meta": { "path": "src/api", "routes": 24 } }
  ],
  "edges": [
    { "from": "frontend", "to": "api", "kind": "request", "evidence": "observed" }
  ],
  "learnings": [ { "ts": 1724800000000, "summary": "Moved summarization to a queue; watch queue depth." } ],
  "updatedAt": 1724800000000
}
```

- Node kinds: `app | module | service | frontend | api | db | model | job | queue | worker | external | ai | auth | cache | scheduler | event`
- Edge kinds: `request | dataflow | event | dependency | call | read | write`
- Evidence values: `observed | measured | inferred | estimated | unknown`
- `id`: short, stable, kebab-case (`billing-worker`, `openai`, `db`). Edges reference node ids; never emit an edge whose endpoints are not in the map (add the node, even as `inferred`, first).
- `risks` and `meta` are optional; `meta` holds anything useful to a human clicking the node (paths, counts, versions).

## Discovery heuristics

Work from artifacts to nodes. Each heuristic names what to read and what it yields:

| Read | Yields |
|---|---|
| `package.json` / `pyproject.toml` / `go.mod` (incl. workspaces/monorepo globs) | one `app` node per deployable package; `module` nodes for significant internal packages |
| Route definitions (Express/Fastify routers, FastAPI decorators, Next.js `app/`/`pages/api`, Rails `routes.rb`) | `api` node(s); `frontend → api` edges kind `request` when a client exists |
| Frontend entry points (`vite.config`, `next.config`, `src/App.*`, framework deps) | `frontend` node; major UI areas as `module` nodes when the codebase is large enough to warrant it |
| ORM models, schema files, migrations (`prisma/schema.prisma`, `models.py`, `migrations/`) | one `db` node per database; `model` nodes for the load-bearing entities (not all 40 tables — the ones decisions hinge on); `api → db` edges kind `read`/`write` from the queries you read |
| Queue/worker config (BullMQ/Celery/Sidekiq setup, `worker` entry scripts, consumer registrations) | `queue`, `worker`, `job` nodes; producer `→ queue` edges kind `event` or `write`, `queue → worker` kind `dataflow` |
| Cron/scheduler config (`crontab`, `node-cron` calls, GitHub Actions schedules, k8s CronJobs) | `scheduler` node; `scheduler → job` edges kind `call` |
| Env vars (`.env.example`, config schemas) + SDK imports (`openai`, `@anthropic-ai/sdk`, `stripe`, `@aws-sdk/*`) | `external` nodes per third-party service; `ai` nodes for LLM/model providers; edges kind `call` from whichever module holds the client |
| Auth middleware, session/JWT handling, IdP SDKs (`passport`, `next-auth`, Clerk/Auth0 imports) | `auth` node; `api → auth` kind `dependency` |
| Cache clients (`redis`, `ioredis`, `memcached` imports, cache config) | `cache` node; `read`/`write` edges from its users |
| Event emitters/subscribers (event bus setup, webhook registrations, pub/sub topics) | `event` nodes for named channels when they decouple components; edges kind `event` |
| Import graph between the nodes above (who imports whose client/module) | `dependency` edges; `call` edges where you read the actual invocation |

Depth is proportional to level: L2 maps the systems the request touches; L4 maps everything reachable from them. Do not exhaustively map a 300-module monorepo for a two-file change.

## Evidence labeling

The label answers: *how do I know this exists / behaves this way?*

- `observed` — you read the code or config that defines it. A route you read is observed. An edge is observed only if you read the call site, not just both endpoints.
- `measured` — confirmed by running something (hit the endpoint, ran the query, saw runtime output). Rare during mapping; use it when you have it.
- `inferred` — deduced from indirect evidence. A dependency inferred from an import you saw (but whose call site you did not read) is `inferred`. A `worker → db` edge assumed because "workers usually write results" is `inferred` at best — and only if the worker imports the DB client.
- `estimated` — quantitative judgment (row counts, traffic) attached via `meta`/`risks`; rarely correct for a node's existence.
- `unknown` — you believe it exists (mentioned in a README, referenced env var with no code found) but found no defining artifact. Keep it in the map as a question, visibly weak in the UI.

When later reading upgrades evidence (`inferred` → `observed`), re-emit the node; the upsert overwrites the old label.

## Emitting and merging

Emit via `system_map` events. Payloads are partial and merged, so emit only what changed. Use `--data-file` for anything beyond a few nodes:

```bash
node <skill-root>/scripts/emit.mjs --session eb-m3k9x2-a4f7 --type system_map \
  --data '{"nodes":[{"id":"api","name":"API","kind":"api","responsibility":"HTTP routing, validation, auth enforcement","evidence":"observed","risks":[],"meta":{"path":"src/api"}},{"id":"openai","name":"OpenAI","kind":"ai","responsibility":"Document summarization","evidence":"observed","meta":{"sdk":"openai@4"}}],"edges":[{"from":"api","to":"openai","kind":"call","evidence":"observed"}],"focus":["api","openai"]}'
```

Full-map builds go through a file:

```bash
node <skill-root>/scripts/emit.mjs --session eb-m3k9x2-a4f7 --type system_map --data-file /tmp/eb-map-update.json
```

**Merge semantics** (performed by the server on every `system_map` emit; identical rules if you ever write the map yourself):

- Nodes upsert by `id` — an incoming node replaces the stored node with the same `id`, otherwise appends.
- Edges upsert by the `(from, to, kind)` triple — same triple replaces (e.g. to upgrade `evidence`), new triple appends. `api → db` can hold both a `read` and a `write` edge.
- Nothing is deleted by emit. To remove stale nodes/edges (a service was deleted), GET `/map`, prune, and POST the full corrected object to `/map` — POST replaces the file wholesale.

## Fresh build vs incremental update

`brain.mjs` reports `mapExists` in its boot JSON. Decide:

- **Build fresh** when `mapExists` is false, or the map is untrustworthy — `updatedAt` predates major refactors you can see in git history, node `meta.path` values point at files that no longer exist, or spot-checking two nodes against the code fails. Run the discovery heuristics scoped to the current level, then emit.
- **Update incrementally** otherwise — the normal case. Verify only the region the request touches (read the map, spot-check the touched nodes against the code, fix what drifted), emit only changed/new nodes and edges. Do not re-emit the whole unchanged map; it churns the journal for nothing.
- **After implementation, always update**: nodes/edges you added or changed, plus a `learnings` entry via the post-implementation procedure (see `post-implementation.md`).

## The `focus` field

`focus` is the list of node ids touched by the *current request* — the UI highlights them with a glow so the human sees the blast radius at a glance.

- Set it on the first `system_map` emit of the session, once inspection has established scope.
- Re-emit with an updated `focus` when scope changes (this is often the visual companion to a `reclassified` event: escalation = the glow spreads).
- `focus` describes the session, not the codebase — it is not persisted into `map.json`, so include it on every `system_map` emit where highlighting matters; an emit without meaningful focus should send the current list unchanged or `[]`.

```bash
node <skill-root>/scripts/emit.mjs --session eb-m3k9x2-a4f7 --type system_map \
  --data '{"nodes":[],"edges":[],"focus":["api","openai","db","billing-worker"]}'
```

(Empty `nodes`/`edges` with a new `focus` is legal: it changes highlighting without touching the map.)

## Quality bar

- Node names are what an engineer calls the thing, not file paths. `responsibility` is one sentence about what it OWNS, not what it imports.
- Prefer 10–30 honest nodes over 200 mechanical ones. A map nobody can read protects nobody.
- Every `risks` entry must trace to something read or a labeled inference — the map is where guardian findings accumulate, not a place for generic warnings ("could be slow") that fit any codebase.
