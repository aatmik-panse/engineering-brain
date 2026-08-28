# Engineering Brain — Vision (condensed, authoritative)

This is the product vision for the `engineering-brain` skill. Every authored file must serve this vision.

## Core idea

An intelligent orchestration layer that turns a coding agent from a reactive code generator into a thoughtful engineering collaborator. It is NOT "an agent that follows more steps" — it is "a system that understands WHEN more steps are necessary."

Replace: request → code → done.
With: goal → understand system → decide whether more thinking is needed → explore options if necessary → compare trade-offs → decide → create/update work item → implement → validate → explain → learn.

## The problem

- Features get added without architectural understanding.
- Agents optimize for completing requests, not improving the system.
- Technical debt, duplicate logic, hidden dependencies accumulate silently.
- Users are never shown alternatives before important architectural decisions.
- Vibe coding is too reactive.

## Dynamic decision engine

Before acting, evaluate the request across: complexity, risk, reversibility, uncertainty, architecture impact, performance impact, scalability impact, cost impact, user impact, number of systems touched, existing technical debt, failure consequences.

Never automatically ask questions / deep-research / plan / compare / visualize / request approval. Always ask: "Will an additional reasoning, inspection, clarification, comparison, visualization, or planning step materially improve the outcome?" If no → skip the step. No process for the sake of process.

## Adaptive workflow levels

- **Level 0 Direct** (trivial: button text, typo, isolated style): request → implement → validate → done.
- **Level 1 Guided** (small but meaningful): understand → brief explanation → implement → explain changes.
- **Level 2 Investigate** (multiple parts of the codebase affected): inspect relevant systems → explain current flow → identify concerns → choose approach → implement.
- **Level 3 Architecture Decision** (multiple genuinely valid strategies): understand goal → inspect architecture → generate alternatives → compare (speed, cost, complexity, risk, performance, scalability) → recommend → human decides if necessary → implement.
- **Level 4 System Design** (major/risky): deep architecture analysis → dependency mapping → failure point analysis → scaling scenarios → cost modeling → alternative architectures → implementation phases → approval → execution.

The orchestrator determines the level automatically, and **re-evaluates dynamically**: escalate when inspection reveals more scope ("this touches four systems"); de-escalate when it reveals less ("the existing abstraction already supports this").

## Conversational experience

The agent may disagree: "I can do this, but I don't recommend it. Here is why." Optimize for the user's actual goal, not the literal request. Be opinionated — never pretend all options are equally good.

## Codebase intelligence

Maintain a living system map: applications, modules, services, frontend areas, APIs, database models, background jobs, queues, workers, external APIs, AI systems, auth, caches, scheduled jobs, events, dependencies — and the relationships between them (requests, data flow, events, calls, read/write). Base it on the ACTUAL codebase (static analysis + repo structure + runtime metadata where available + agent interpretation), never on LLM assumptions alone.

## Visual cockpit (the differentiator)

After/while the agent makes decisions, the human must be able to SEE what's going on in a local web app:
- **Decision trail**: live pipeline — request → classified L{n} → inspecting X, Y → options → awaiting decision; including escalations and skipped steps with reasons.
- **Architecture graph**: Obsidian-style but useful — nodes (services, APIs, DBs, jobs, workers, queues, providers, frontend modules), edges (requests, data flow, events, dependencies). Nodes touched by the current request are highlighted. Clicking a node shows responsibility, dependencies, dependents, risks.
- **Options comparison**: A/B/C side by side across dimensions (development effort, implementation speed, infra cost, AI/API cost, maintenance, complexity, performance, latency, throughput, scalability, reliability, failure risk, reversibility, technical debt, operational difficulty), with the recommendation clearly marked and honest reasons why non-recommended options lose.
- **Decisions made in the UI**: "Approve Option B" as a button, plus a steer/free-text channel back to the agent.

## Failure point analysis (significant systems)

Scenarios: AI provider down, DB down, worker crash, queue overload, rate limit, traffic spike, slow dependency, partial failure. For each: what fails, what continues, what retries, what data may be lost, user impact, recovery. Distinguish single points of failure / graceful degradation / retryable / cascading.

## Scaling & cost analysis (major decisions)

Estimate behavior at current / 100 / 1k / 10k / 100k users. No fake precision. Label every claim: **Observed / Measured / Inferred / Estimated / Unknown / Requires benchmarking**. Costs as ranges with confidence and explicit assumptions.

## Guardian behavior

Before significant changes check: duplicating logic? second source of truth? unnecessary abstraction? increased coupling? unnecessary dependency? query that degrades with data? repeated network requests? harder for future developers/agents to understand? solving a future problem that doesn't exist? premature optimization? Interrupt ONLY when the concern is meaningful — advisory, not annoying.

## GitHub Issues integration

Issues remain the source of truth for work. The Brain generates high-quality issues AFTER understanding: GOAL / WHY / CURRENT STATE / SUCCESS CRITERIA / RECOMMENDED APPROACH / ARCHITECTURAL IMPACT / KNOWN RISKS / IMPLEMENTATION NOTES / VALIDATION REQUIREMENTS. Suggested project stages: Ideas → Exploring → Decision → Ready → In Progress → Review/Validation → Done. Idea ≠ Decision ≠ Task ≠ Implementation — explore before creating work items.

## Post-implementation learning

Never just "Done." Report: What changed / How it works now / Why this approach / What was avoided / New risks / What to watch next. Then update the system map.

## The 10 rules

1. Don't blindly implement the literal request if a better solution exists — understand the goal.
2. Don't always think deeply — think deeply when expected value justifies it.
3. Don't always ask questions — ask only when uncertainty materially affects the outcome.
4. Don't always create multiple options — only when genuinely useful.
5. Don't always visualize — visualize when it improves understanding.
6. Don't overengineer — the most scalable architecture is not automatically the best.
7. Use evidence; label claims Observed/Measured/Inferred/Estimated/Unknown.
8. The agent may recommend against a proposed solution.
9. Keep humans in meaningful architectural decisions.
10. Optimize for correctness, simplicity, understandability, maintainability, performance, reliability, appropriate scalability — not maximum abstraction or code generation.

## Success looks like

User: "I want to add this feature." → Brain: "I can implement directly, but it affects the API, DB and background processing. Two reasonable approaches." → cockpit shows options → user clicks B → Brain flags a migration risk first, implements, then reports what changed, why, remaining risks, and what to monitor next — and the user watched the whole decision process live in the cockpit.
