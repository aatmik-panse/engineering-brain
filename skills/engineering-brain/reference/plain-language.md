# Human understanding and simplicity

A core purpose of this skill is not only better engineering decisions, but making the human **understand what the agent is doing**. Assume the user may not know architecture, databases, APIs, queues, dependencies, or scalability patterns. Your job is to translate complexity into understandable decisions. Success is not how much technical information you provide — it is whether the human feels more confident about what is happening.

Turn "Claude is doing a million complicated things and I have no idea what is happening" into "I understand the problem, I understand my choices, and I understand why we are doing this."

## The five questions

Before any significant change, the human must be able to answer, in this order:

1. What does the app do right now?
2. What is the actual problem?
3. Why is this a problem?
4. What are the realistic ways to solve it?
5. Which option do you recommend, and why?

Never open with implementation details unless they are required to decide.

## Explain the decision, not the technology

Wrong: "We should introduce an asynchronous queue-based architecture with decoupled workers and distributed processing."

Right: "Right now, the app waits for everything to finish before it can continue. That is one reason it can become slow. We have two choices: make the current process faster, or move the slow work into the background. I recommend moving it into the background because it will keep the app responsive as more people use it."

Technical detail comes afterward, as an optional deeper layer — never as the opening.

## Three layers, default to Layer 1

- **Layer 1 — Simple**: what is happening, in plain language.
- **Layer 2 — Practical**: what changes for the app, its users, speed, reliability, cost, or future development.
- **Layer 3 — Technical**: how it actually works internally.

Reveal deeper layers only when the user asks, when the detail is necessary to decide, or when the risk is high enough that the detail materially matters.

## Translate every technical claim into its consequence

Whenever you name a technical issue, pair it with what it means practically:

| Technical statement | Also say |
|---|---|
| "This service is a single point of failure." | "If this one part stops working, this whole feature stops, because nothing else can take over." |
| "This introduces a dependency." | "One part of the app now relies on another. If we change one, we may also have to change the other." |
| "This does not scale well." | "This works fine now, but if usage grows a lot, it may become slower or more expensive." |
| "This creates a second source of truth." | "The same information will live in two places, and they can silently disagree." |
| "This query degrades with data volume." | "The more records pile up, the slower this page gets — gradually, then noticeably." |

## The cockpit reduces complexity, it does not display it

Before adding anything to the UI, ask: *does the user need this to make a better decision?* If not, hide it behind the "Show me how this works technically" layer. The default (Simple) view answers only the five questions.

Concretely, in cockpit events:

- Write `tagline`, `pros`, `cons`, `why`, and `thinking` fields for a non-technical reader — practical consequences, no jargon. `detail`, `scores`, `claims`, and file lists are the technical layer; the UI hides them in Simple view.
- Add `plain` to significant events — one or two sentences a non-technical person understands:

```bash
node <skill-root>/scripts/emit.mjs --session <id> --type classified --data '{
  "level": 3, "levelName": "Architecture Decision",
  "scores": {"complexity":"medium","risk":"medium","uncertainty":"low","reversibility":"medium","blastRadius":"high"},
  "rationale": "Touches the API, a background job, and the frontend; two valid rendering strategies exist.",
  "plain": "This change affects three parts of the app at once, and there is more than one sensible way to build it — so I will compare the options with you before writing code.",
  "plannedSteps": ["Inspect report pipeline","Generate options","Await decision","Implement"],
  "skippedSteps": [{"step":"Cost modeling","why":"No new infrastructure in either option"}]
}'
```

- Give `options` a `situation` field — the plain "current situation" paragraph rendered above the cards:

```json
{ "decisionId": "d1", "situation": "Your app currently handles this process in one long chain. It works, but if one step becomes slow, the whole process has to wait.", "comparisonDimensions": ["…"], "options": ["…"] }
```

## Live thinking pulses

Between milestones, emit `thinking` so the human always knows what you are doing and where you are heading — the cockpit shows these as live popups and a header status strip:

```bash
node <skill-root>/scripts/emit.mjs --session <id> --type thinking --data '{
  "now": "Reading how the report page loads its data",
  "headed": "then I can tell whether the slowness is in the app or in the data source"
}'
```

Rules: plain language only (both fields); one pulse per genuine shift of attention — not per file read; never a substitute for `step`/`inspection` milestones, which stay the structured record.

## Do not overwhelm

- Analysis exists for clarity, not volume. Do not show every idea your reasoning generated.
- Do not manufacture alternatives because alternatives are possible; present only genuinely useful options (often two).
- Do not turn a simple decision into an architecture debate.
- If one option is clearly better, say so. Never hide behind neutrality when you have a well-supported recommendation.

## Dynamic depth

Read the user's level from how they write and what they ask:

- **Non-technical signals** (outcome language, no jargon, "make it faster"): plain language, practical consequences, simple examples. Chat and event `plain` fields carry the explanation.
- **Technical signals** (names internals, asks about trade-offs, reads the code): go deeper by default — architecture, dependencies, precise trade-offs. Still emit `plain` fields; someone else may read the cockpit.
- **Unsure**: begin simple; let them open the technical layer.

## Core rule

The user does not need to understand every mechanism. They need to answer: *What is the agent doing? Why? What are the options? What happens with each? Do I agree?* Everything you emit and say should serve those five answers.
