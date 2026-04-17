---
description: "Use when changing Home-Ops batch evaluate orchestration, pending-pipeline evaluation, or the evaluate-worker agent/skill contract. Covers delegating one-home report drafting to the Evaluate Worker custom agent while keeping browser, deduplication, and merge work in the main agent."
name: "Evaluate Worker Delegation"
applyTo: "modes/evaluate.md,.github/agents/evaluate-worker.agent.md,.github/skills/evaluate-worker/SKILL.md"
---
# Evaluate Worker Delegation

- In batch `evaluate` with no explicit target, keep the main agent responsible for reading `data/pipeline.md`, deduplicating homes, choosing primary and fallback URLs, and building one canonical work item per physical property.
- Keep browser-backed verification, hosted-session attachment, normalized fact extraction, and source-plan preparation in the main agent. Do not push that live-browser work into report workers.
- After one canonical property's evidence packet is ready, delegate the drafting work to the `Evaluate Worker` custom agent in `.github/agents/evaluate-worker.agent.md`.
- Use one `Evaluate Worker` invocation per canonical home. Do not bundle multiple homes into one worker request.
- Pass the worker a prepared evidence packet that includes buyer context, normalized listing facts, verification result, primary and fallback URLs for the same home, concrete research targets or evidence, and any relevant prior report or tracker context.
- The worker should return a report draft plus structured metadata such as score, recommendation, confidence, suggested status, tracker note, shortlist rationale, and evidence gaps.
- Keep report numbering, tracker staging, tracker merges, processed-pipeline edits, shortlist updates, and final batch summaries in the main agent.
- If runtime is tight, dispatch one-home workers in waves of up to 5, but only after each home's evidence packet is complete enough for drafting.
- If the `Evaluate Worker` agent is unavailable, preserve the same one-home worker contract instead of falling back to ad hoc multi-home drafting.
- When changing the worker agent or skill contract, keep the orchestration boundary aligned: workers draft one home from supplied evidence; the main agent owns browser work and final writes.