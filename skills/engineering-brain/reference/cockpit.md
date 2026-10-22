# Cockpit protocol — driving the live cockpit

The cockpit is a local web app served by `scripts/brain-server.mjs`. The agent talks to it exclusively through the CLI scripts in `scripts/`. All state lives in the target project under `<project>/.engineering-brain/` (project root = nearest ancestor directory containing `.git`, else cwd). The append-only journal (`sessions/<id>/journal.jsonl`) is canonical; the server, its queues, and the UI are views over it. When the server, the UI, or your recollection of this session disagrees with the journal, the journal wins.

## The contract (read once)

Execute in order. No step skipped, no step reordered.

1. **Boot only at Level >= 2**, or when the user asks ("show me", "open the cockpit"). Levels 0–1: no cockpit, no server, no spawned processes. Escalating mid-task from 0/1 into 2+: boot at that moment, emit `classified` (the original level and rationale), then `reclassified`.
2. Boot: `node <skill-root>/scripts/brain.mjs --request "<the user's request, verbatim or lightly compressed>"`. It ensures the server is running (reuses a healthy one via `.engineering-brain/server.json`, otherwise spawns `brain-server.mjs` detached), creates a session, journals `session_start`, and prints exactly one JSON line: `{ "ok": true, "url": "...", "port": 8641, "sessionId": "eb-...", "token": "...", "mapExists": true, "projectRoot": "/abs/path" }`. Tell the user the `url` **once**. Save `sessionId` — every emit and poll needs it. The CLIs read port and token from `server.json` themselves; never pass the token by hand. On `{ "ok": false, ... }`: fall back to chat-only operation rather than blocking the task. `mapExists: false` means no system map exists yet; building one (see `system-map.md`) is worthwhile at Level >= 2.
3. Emit an event at **every** milestone — classification, each step start/end, each inspection, map updates, concerns, options, implementation, validation, learning, session end. If it would be worth a paragraph in chat, it is worth an event; then the chat version is one sentence.
4. When a decision genuinely needs the human: emit `options` (for `choose_option`) then `decision_needed`, mirror the question in one chat sentence, and run `poll.mjs` as a **background task** — Claude Code policy: never block the foreground shell; the harness notifies you on completion. React per the poll table below. A `steer` never resolves a pending decision — handle it and poll again.
5. **Never re-ask the user for a decision already made in the UI.** The journal's `user_action` events are the durable record of every click and steer; after any gap, restart, or doubt, scan the journal tail before asking anything in chat.
6. If interrupted, restarted, or unsure of state: `status.mjs` first, journal second, assumptions never (Recovery below).
7. End every session with `learning` then `session_end` (`completed` | `abandoned` | `handed_off`), then optionally `stop.mjs`. Leave the server running if the user is still reading or more work is imminent — it is idle-cheap and `brain.mjs` reuses it. Disk state (`map.json`, journals) persists either way; that persistence is what makes the map and learnings compound across sessions.

Chat is overhead once the cockpit is live. Emit detail — per-file inspection notes, dimension-by-dimension comparisons, long reasoning — to the cockpit; keep chat to decisions, blockers, and one-line progress. No recaps, no narrating what the cockpit already shows.

## Emitting

```
node <skill-root>/scripts/emit.mjs --session <id> --type <type> --data '<json>'
node <skill-root>/scripts/emit.mjs --session <id> --type <type> --data-file <path>   # large payloads (options, system_map)
```

Prints `{ "ok": true, "seq": n }`. The server rejects unknown types — only the types below exist.

### Event type reference (agent → UI, exhaustive)

| type | data |
|---|---|
| `session_start` | `{ request, cwd }` (emitted for you by `brain.mjs --request`) |
| `classified` | `{ level: 0-4, levelName, scores: { complexity, risk, uncertainty, reversibility, blastRadius } each "low"\|"medium"\|"high", rationale, plannedSteps: [string], skippedSteps: [{ step, why }] }` |
| `reclassified` | `{ fromLevel, toLevel, why }` |
| `step` | `{ name, status: "start"\|"done"\|"skipped", detail? }` |
| `thinking` | `{ now, headed? }` — live plain-language pulse: what you are doing right now, where you are heading. Rendered as popups + header strip. One pulse per genuine shift of attention, not per file read; never a substitute for `step`/`inspection`. |
| `inspection` | `{ area, summary, files: [string], claims: [{ text, evidence: "observed"\|"measured"\|"inferred"\|"estimated"\|"unknown" }] }` |
| `system_map` | `{ nodes: [Node], edges: [Edge], focus: [nodeId] }` — `focus` = nodes touched by the current request. The server also merges nodes/edges into `map.json` (upsert nodes by `id`, edges by `(from, to, kind)`). |
| `concern` | `{ severity: "info"\|"warning"\|"critical", title, detail, recommendation? }` |
| `options` | `{ decisionId, comparisonDimensions: [string], options: [{ id, name, tagline, recommended: bool, effort, scores: { <dimension>: { score: 1-5, note? } }, pros: [string], cons: [string], debt?, why }] }` |
| `decision_needed` | `{ decisionId, kind: "choose_option"\|"approve"\|"question", prompt, choices?: [{ id, label }] }` |
| `implementation` | `{ summary, changes: [{ file, kind: "added"\|"modified"\|"removed", note }] }` |
| `validation` | `{ summary, checks: [{ name, result: "pass"\|"fail"\|"skipped", detail? }] }` |
| `learning` | `{ whatChanged: [string], howItWorksNow, whyThisApproach, whatWasAvoided, newRisks: [string], watchNext: [string] }` |
| `note` | `{ text }` |
| `user_action` | journaled copy of a `/decide` action `{ id, type, decisionId?, choiceId?, message? }` — written by the server; you never emit this yourself |
| `session_end` | `{ outcome: "completed"\|"abandoned"\|"handed_off" }` |

**Plain-language layer**: any event's data may carry `plain: string` (a jargon-free Layer-1 rendering shown by the UI's default Simple view), and `options` may carry `situation: string` (plain description of the current state, shown above the cards). Write `tagline`/`pros`/`cons`/`why`/`thinking` for a non-technical reader; `detail`/`scores`/`claims`/file lists are the technical layer the UI collapses in Simple view. Full guidance: [plain-language.md](plain-language.md).

Typical sequences:

- **Level 2**: `classified` → `step`/`inspection` per system → `system_map` (with `focus`) → optional `concern` → `implementation` → `validation` → `learning` → `session_end`.
- **Level 3–4**: as above, plus `options` → `decision_needed` → poll → `user_action` arrives → proceed with the chosen option.

## The poll loop

```
node <skill-root>/scripts/poll.mjs --session <id> [--timeout 600000]   # background task, always
```

Prints exactly one JSON user action and exits 0. `poll.mjs` keeps its own HTTP timeout above the server's window, so a clean `{ "type": "timeout" }` — never a client-side abort — is what you get when nobody acts.

```json
{ "id": "a-3", "ts": 1724800000000, "type": "decision", "decisionId": "d1", "choiceId": "B" }
{ "id": "a-4", "ts": ..., "type": "steer", "message": "prefer the queue approach" }
{ "id": "a-5", "ts": ..., "type": "answer", "decisionId": "d2", "message": "we have ~200 daily users" }
{ "type": "timeout" }
```

| Returned | React |
|---|---|
| `decision` | The user chose. Acknowledge in one chat line, proceed with that option, stop polling for this decision. |
| `answer` | Free-text reply to your `decision_needed` question. Incorporate it and proceed. |
| `steer` | Mid-flight guidance, possibly unrelated to any pending decision. Adjust course, emit a `note` or `step` reflecting it, and immediately start the next background poll — steering does not resolve a decision. |
| `timeout` | Ask in chat; do not pick. |

If the user answers in chat while a poll is in flight, act on the chat answer; when the poll later returns, reconcile: identical → ignore; conflicting → the newest instruction wins, confirm in chat.

Delivery is at-most-once — each action is handed to exactly one poll — and the journal keeps the durable `user_action` record, so no action is ever silently lost. The UI's steer box is always available and it has a session picker (header dropdown, newest first, active sessions marked), so a `steer` can arrive from any poll even when you asked nothing, including on a session the user switched back to. Poll opportunistically during long implementation phases if the user is likely watching.

## Recovery

Never assume server or session state — check it:

```
node <skill-root>/scripts/status.mjs
```

Prints `{ "server": { running, port, pid }, "sessions": [...] }` including, per active session, the count of pending (undelivered) user actions. Works with the server down — it reads the state dir directly.

- **The journal is canonical.** Lost track of what happened: read `.engineering-brain/sessions/<id>/journal.jsonl` directly, or `GET /state?session=<id>`, and resume from the last event rather than re-emitting duplicates.
- **Pending actions survive restarts.** The server tracks delivery in `sessions/<id>/delivered.jsonl` (internal file, not an event type) and on startup rebuilds each pending queue from journaled `user_action` events not yet delivered. Server killed between a UI click and a poll → after restart, the next `poll.mjs` still receives that click. A human decision is never lost — so never re-ask for one; when `status.mjs` shows pending actions, poll and consume them first.
- **Server died / machine restarted**: re-run `brain.mjs` (no `--request`) to revive it, then keep using the ORIGINAL session id — its journal is intact and seq numbering continues from it. Do not start a fresh session to recover an old one.
- `emit.mjs`/`poll.mjs` failing with "server not running" means run `brain.mjs` first (or accept chat-only mode).

## Cleanup

When the task concludes, always emit the final pair:

1. `learning` — the post-implementation report (never just "Done"; see `post-implementation.md`).
2. `session_end` — `{ "outcome": "completed" }` (or `"abandoned"` / `"handed_off"` honestly).

Then optionally:

```
node <skill-root>/scripts/stop.mjs
```

Prints `{ "ok": true }` (idempotent — an already-stopped server is success).
