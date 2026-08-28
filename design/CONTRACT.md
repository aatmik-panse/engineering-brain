# Engineering Brain — Technical Contract (authoritative)

Every file in the skill MUST conform to this contract exactly. Where a document and this contract disagree, this contract wins. Do not invent new event types, endpoints, flags, or paths beyond what is specified here.

## File layout (skill package)

Repo root: `/Users/profitoniumapps/.superset/sessions/quilted-lingonberry`
Skill root: `<repo>/skills/engineering-brain/`

```
engineering-brain/
  SKILL.md                      # core skill: the reasoning loop + routing table
  reference/
    classification.md           # scoring dimensions, level selection, escalation/de-escalation
    levels.md                   # Level 0–4 playbooks incl. which cockpit events to emit at each step
    guardian.md                 # architectural degradation checklist, when/how to interrupt
    options.md                  # generating genuinely distinct options, comparison + recommendation format
    failure-analysis.md         # failure scenario taxonomy and per-scenario template
    scaling-cost.md             # scaling tiers, cost estimation format, evidence honesty
    issue-template.md           # GitHub issue generation (gh CLI), project stages
    post-implementation.md      # learning report format + system map update procedure
    system-map.md               # building map.json from real code; node/edge kinds; merging rules
    cockpit.md                  # full cockpit runtime protocol (boot, endpoints, events, poll loop, recovery)
  scripts/
    brain.mjs                   # boot: ensure server running, create session, print JSON
    brain-server.mjs            # the local HTTP + SSE server (can run detached)
    emit.mjs                    # append an event to the session journal + broadcast
    poll.mjs                    # long-poll for the next user action from the UI
    status.mjs                  # server + sessions status (works with server down)
    stop.mjs                    # shut the server down
    lib/
      state.mjs                 # shared: project-root resolution, state paths, journal read/append, server.json
  ui/
    index.html
    app.js
    style.css
```

All scripts: Node >= 18, ESM `.mjs`, **zero npm dependencies** (node:http, node:fs, node:path, node:crypto, node:child_process only). `Date.now()`/randomness are fine here (these run in real Node).

## Runtime state (created in the TARGET project where the skill is used)

Project root = walk up from cwd to the nearest directory containing `.git` (fallback: cwd).

```
<project>/.engineering-brain/
  server.json                   # { port, token, pid, startedAt }
  map.json                      # persistent system map (schema below)
  sessions/<sessionId>/
    meta.json                   # { sessionId, request, cwd, startedAt, status: "active"|"ended" }
    journal.jsonl               # one JSON event envelope per line, append-only
```

`sessionId` format: `eb-` + base36 timestamp + `-` + 4 random hex chars.

## Server

- Bind `127.0.0.1` only. Default port **8641**; if busy, try 8642–8650; write the chosen port to `server.json`.
- Auth token: random 16-hex generated at server start, stored in `server.json`. All POST endpoints and `/poll` require it via `x-brain-token` header or `?token=` query param. `GET /` injects it into the page as `window.__BRAIN__ = { token, port }`.
- One server serves all sessions of one project. `brain.mjs` reuses a healthy running server (probe `GET /health`).

### Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | `{ ok: true, pid, startedAt }` |
| GET | `/` | serve `ui/index.html` (inject `window.__BRAIN__`) |
| GET | `/app.js`, `/style.css` | static UI assets |
| GET | `/sessions` | `{ sessions: [meta.json...] }` newest first |
| GET | `/state?session=<id>` | `{ meta, events: [envelope...] }` (full journal replay) |
| GET | `/events?session=<id>&since=<seq>` | SSE: replay envelopes with `seq > since`, then live. Frame: `id: <seq>\ndata: <json>\n\n`. Comment heartbeat every 25s. |
| POST | `/emit` | body `{ session, type, data }` → validates type, assigns `seq`, appends to journal, broadcasts. Returns `{ ok, seq }`. |
| POST | `/decide` | body `{ session, action: { type, decisionId?, choiceId?, message? } }` → assigns action `id`, queues for poll, ALSO journals it as an `user_action` event (so the UI trail shows it). Returns `{ ok, id }`. |
| GET | `/poll?session=<id>&timeout=<ms>` | long-poll: returns the next queued (undelivered) user action, or `{ type: "timeout" }` after timeout (default 600000). Actions are marked delivered when returned (at-most-once; the journal keeps the durable record). |
| GET | `/map` | contents of `map.json` (or `{ nodes: [], edges: [], learnings: [] }`) |
| POST | `/map` | body = full map object → replaces `map.json`. Returns `{ ok }`. |
| POST | `/shutdown` | graceful exit |

`system_map` events are ALSO merged into `map.json` by the server on emit: upsert nodes by `id`, upsert edges by `(from, to, kind)`.

## Event envelope (journal line + SSE payload)

```json
{ "seq": 12, "ts": 1724800000000, "session": "eb-...", "type": "classified", "data": { ... } }
```

`seq` is per-session, monotonically increasing from 1.

## Event types: agent → UI (exhaustive)

| type | data |
|---|---|
| `session_start` | `{ request, cwd }` |
| `classified` | `{ level: 0-4, levelName, scores: { complexity, risk, uncertainty, reversibility, blastRadius } each "low"\|"medium"\|"high", rationale, plannedSteps: [string], skippedSteps: [{ step, why }] }` |
| `reclassified` | `{ fromLevel, toLevel, why }` |
| `step` | `{ name, status: "start"\|"done"\|"skipped", detail? }` |
| `inspection` | `{ area, summary, files: [string], claims: [{ text, evidence: "observed"\|"measured"\|"inferred"\|"estimated"\|"unknown" }] }` |
| `system_map` | `{ nodes: [Node], edges: [Edge], focus: [nodeId] }` (focus = nodes touched by the current request) |
| `concern` | `{ severity: "info"\|"warning"\|"critical", title, detail, recommendation? }` |
| `options` | `{ decisionId, comparisonDimensions: [string], options: [{ id, name, tagline, recommended: bool, effort, scores: { <dimension>: { score: 1-5, note? } }, pros: [string], cons: [string], debt?, why }] }` |
| `decision_needed` | `{ decisionId, kind: "choose_option"\|"approve"\|"question", prompt, choices?: [{ id, label }] }` |
| `implementation` | `{ summary, changes: [{ file, kind: "added"\|"modified"\|"removed", note }] }` |
| `validation` | `{ summary, checks: [{ name, result: "pass"\|"fail"\|"skipped", detail? }] }` |
| `learning` | `{ whatChanged: [string], howItWorksNow, whyThisApproach, whatWasAvoided, newRisks: [string], watchNext: [string] }` |
| `note` | `{ text }` |
| `user_action` | (journaled copy of a /decide action) `{ id, type, decisionId?, choiceId?, message? }` |
| `session_end` | `{ outcome: "completed"\|"abandoned"\|"handed_off" }` |

## User actions: UI → agent (via POST /decide, consumed via GET /poll)

```json
{ "id": "a-3", "ts": 1724800000000, "type": "decision", "decisionId": "d1", "choiceId": "B" }
{ "id": "a-4", "ts": ..., "type": "steer", "message": "prefer the queue approach" }
{ "id": "a-5", "ts": ..., "type": "answer", "decisionId": "d2", "message": "we have ~200 daily users" }
```

## System map schema (`map.json` and `system_map` event payloads)

```json
{
  "nodes": [{ "id": "api", "name": "API", "kind": "api", "responsibility": "...", "evidence": "observed", "risks": ["..."], "meta": {} }],
  "edges": [{ "from": "frontend", "to": "api", "kind": "request", "evidence": "observed" }],
  "learnings": [{ "ts": 0, "summary": "..." }],
  "updatedAt": 0
}
```

Node kinds: `app | module | service | frontend | api | db | model | job | queue | worker | external | ai | auth | cache | scheduler | event`.
Edge kinds: `request | dataflow | event | dependency | call | read | write`.
Evidence values everywhere: `observed | measured | inferred | estimated | unknown`.

## CLI behavior (exact)

- `node scripts/brain.mjs [--request "<text>"]`
  Ensures server running (spawn `brain-server.mjs` detached, stdio ignored, unref), waits for `/health`, creates a session (meta.json + `session_start` event when `--request` given), prints ONE JSON line:
  `{ "ok": true, "url": "http://127.0.0.1:<port>/?session=<id>", "port": ..., "sessionId": "...", "token": "...", "mapExists": bool, "projectRoot": "..." }`
- `node scripts/emit.mjs --session <id> --type <type> (--data '<json>' | --data-file <path>)`
  POSTs `/emit`. Prints `{ "ok": true, "seq": n }`. Non-zero exit + `{ "ok": false, "error": ... }` on failure/unknown type.
- `node scripts/poll.mjs --session <id> [--timeout <ms>]`
  Long-polls `/poll` (default 600000 ms), prints exactly one JSON user action (or `{ "type": "timeout" }`) and exits 0.
- `node scripts/status.mjs`
  Prints `{ server: { running, port, pid } , sessions: [...] }` — must work when the server is down (reads state dir directly).
- `node scripts/stop.mjs`
  POSTs `/shutdown`; prints `{ "ok": true }`.

All CLI JSON goes to stdout as a single line; diagnostics to stderr.

## UI requirements

Single-page, dark, control-room aesthetic. No frameworks, no build step, vanilla JS (ES modules OK). Connects via SSE with reconnect using last received `seq` (`since` param). Session picked from `?session=` or newest active.

Layout:
- **Header**: request text, level badge (L0–L4, color ramp: gray → blue → teal → amber → red), session status, escalation indicator when `reclassified`.
- **Left column — Decision Trail**: vertical timeline rendering every event meaningfully: `classified` as a card with score chips + planned/skipped steps; `step` entries with status; `inspection` with evidence badges per claim; `concern` as amber/red cards; `reclassified` as a prominent escalation marker; `user_action` entries; `learning` summary link.
- **Main area — tabs**:
  - *System Map*: SVG force-directed graph from `/map` + live `system_map` events. Nodes colored by kind, `focus` nodes highlighted with a glow/ring. Click a node → side panel with responsibility, evidence, risks, dependencies (in/out edges).
  - *Options*: option cards side by side; recommended card visually elevated with a "Recommended" tag; per-dimension 1–5 score bars with notes on hover/tap; pros/cons lists; honest `why` text.
  - *Learning*: renders the latest `learning` event as the post-implementation report.
  - *Activity*: raw event feed (type, time, compact JSON).
- **Decision dock** (bottom, appears on `decision_needed`, hides after answering): prompt + choice buttons (from `choices` or the current `options` ids) + free-text input for `answer`/`steer`. Posting sends `/decide` with the token.
- **Steer box** always available (sends `{ type: "steer", message }`).
- Evidence badges styled distinctly (observed=solid, measured=solid, inferred=outline, estimated=dashed, unknown=muted).

## Durability (impeccable-grade recovery)

- The journal is canonical. The server's pending-action queue must survive restarts: when `/poll` delivers an action, the server appends its id to `sessions/<id>/delivered.jsonl` (one JSON `{ "id": "a-3", "ts": ... }` per line, internal file — NOT a journal event type). On startup, the server rebuilds each session's pending queue as: `user_action` events in the journal whose ids are absent from `delivered.jsonl`, in seq order.
- Therefore: server killed between a UI click and a poll → after restart, the next `poll.mjs` still receives that action. Never lose a human decision.
- `status.mjs` reports, per active session, the count of pending (undelivered) actions.
- Server writes must be crash-safe: journal and delivered files are append-only; `map.json`/`server.json`/`meta.json` written via temp-file + rename.

## UI additions

- **Session picker**: header dropdown listing sessions from `/sessions` (newest first, active ones marked); switching updates `?session=` and re-subscribes SSE from seq 0.
- Keyboard: decision dock choices reachable by Tab, activate with Enter; visible focus rings throughout.
- Graceful degradation: long strings truncate with ellipsis + title attr; 500+ events must not freeze the trail (render incrementally).

## Cockpit protocol (how the skill instructs the agent to use this)

1. On classifying a request Level >= 2 (or on user request "show me" / "open the cockpit"), run `brain.mjs --request "..."`, tell the user the URL once.
2. Emit events at every milestone (classified, step, inspection, system_map, concern, options, implementation, validation, learning, session_end). Chat stays lean; the cockpit is the detail channel.
3. On emitting `decision_needed`, run `poll.mjs` as a **background task** (Claude Code policy: never block the foreground shell; the harness notifies on completion). React to the returned action; keep polling if the action was `steer`.
4. Levels 0–1: no cockpit, no server — pure judgment, minimal chat.
5. Recovery: `status.mjs` before assuming state; the journal is canonical.
