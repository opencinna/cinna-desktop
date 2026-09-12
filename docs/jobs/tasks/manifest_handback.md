# Manifest Handback

## Purpose

Let a kit agent attach a concise, verified-work note when returning a handed-off task to its existing coordinator. The runner's normal completed-turn return remains in place; a marker adds context to that return.

## Core Concepts

- **Declaration** — a kit manifest handovers entry with both target_slug=coordinator and target_kind=coordinator. A sibling merely named coordinator keeps its existing meaning.
- **Eligible turn** — the specialist currently holding an autonomous coordinator task. Ordinary chats, script steps and delegated tool calls are not eligible.
- **Handback note** — data from a successful final assistant answer, saved in the ownership transition and passed to the coordinator's next turn.

## User Stories / Flows

1. The agent author adds the exact coordinator declaration to the kit manifest. The optional discriminator belongs to contract 1.3; it does not require restamping existing folders or using an `@coordinator` slug.
2. An autonomous coordinator hands work to that agent. Main checks the actual local kit folder and supplies eligibility for that turn.
3. After finishing and settling required questions, the agent ends its answer with a standalone `/handback <note>` line. The note describes what it did, verified and left open, within 4,000 characters.
4. The existing coordinator receives the note with the ownership transition and decides what to do next. The original answer stays in the conversation. A successful specialist without a marker still returns normally.

## Business Rules

- **Both declaration and host eligibility are required.** Text cannot create a coordinator, select another agent or claim an unrelated task. Unknown target kinds grant no authority.
- **Questions and failure take precedence.** Cancellation, failure, budget exhaustion, uncertain request bookkeeping or an outstanding saved question cannot become a successful handback because a marker appeared.
- **Only the answer counts.** Main reads the completed ACP assistant answer, excluding reasoning fallback, tool results and replayed history. A marker must be the final nonblank line at column zero; empty, oversized, nonterminal, indented, blockquoted or open-code-fence markers have no effect.
- **The note is context.** It does not finish the whole task or execute commands embedded in the note. The coordinator still owns completion decisions and budgets.
- **Older behavior stays distinct.** Older desktop schemas accept the added key, but their prompts still describe handovers as sibling hints. They cannot activate this coordinator-return convention. External kit.py/cinna-core behavior is unverified and depends on those tools; the desktop does not certify it.
- **Unattended work can ask for help.** Both kit and bare-agent prompts allow a request to come from a person or an unattended task and direct agents to available question/permission mechanisms without assuming someone is watching. Bare agents do not thereby gain manifest handback.

## Architecture Overview

Fresh kit declaration + current task-owner eligibility → successful ACP answer → bounded terminal marker → typed note → request/ownership checks → saved transition and existing coordinator continuation.

## Integration Points

- [Technical details](manifest_handback_tech.md) — declaration, driver and result boundaries.
- [Autonomous tasks](autonomous_tasks.md) — handoff, normal specialist return and task completion.
- [Kit contract](../../agents/local_agents/kit_contract.md) and [local agent prompts](../../agents/local_agents/engine.md) — portable manifest data and generated guidance.
- [Turn outcomes](../../chat/messaging/turn_completion.md) and [Inbox](inbox.md) — successful completion and human-wait precedence.

Schedules, complete token accounting and phase 7 protocol/new-driver cleanup remain separate work.
