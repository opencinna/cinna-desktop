# Agent Publish — an agent publishes, the person shares

## Purpose

A folder agent can publish a file or folder from its own folder as an [artifact](artifacts.md) with one tool call, `artifacts_publish`. Every `cinna` tool is allowed silently by every engine, so the provider decides, in one place (the policy, below). By default **the call does not wait**: a new artifact is published private, and a republish into an artifact this agent published updates it for whoever the owner already shared it with. The approval card appears only when the call cannot be sure. An agent can hand over a report; it cannot decide who reads it, because the tool takes no visibility or link and sharing stays the person's.

## Core Concepts

- **`artifacts_publish`** — the one tool, on the same `cinna` MCP server as the eight `tasks_*` tools. Arguments: `path` (relative to the agent's folder), `title`, optional `description`, `entry` (the HTML page to open first) and `artifact_id` (republish into an artifact this machine published before). Nothing else is accepted: an agent that sends a visibility or a share argument is refused with "An agent publishes privately; the user shares." The contract is cinna-core's `artifacts.schema.json`, held equal to the registered tool by a parity test ([Kit Contract](../../agents/local_agents/kit_contract_tech.md)).
- **Publish approval** — the card in the transcript where the call waits, in the few cases the policy asks: the agent's name, the title, kind, the files (with what is left out struck through), the size, who would see it, and **Deny**, **Edit…**, **Publish**. The same request is a row in the [Inbox](../../jobs/tasks/inbox.md) whose address begins `art_` (then the tool call's id), so it can be answered when the chat is not on screen. A chat that had no task gains one for the row, as it does for an engine's permission ask.
- **Edit…** — opens the Publish dialog on the agent's request. The person can change title, description, start page, Update versus Publish as new, and the audience, then publish. Through the card this is the way a request reaches an audience other than the one it would keep.
- **The policy** (`agentArtifactPolicy`) — decides publish or ask. See [The gate](#the-gate).
- **The `cinna-artifacts` skill** — the platform skill that teaches an agent when to publish and how to build a site that works in the sandbox. See [Skill delivery](#skill-delivery).

## User Stories / Flows

1. An agent calls `artifacts_publish` on `reports/q3` for the first time. No card: the artifact is published private, the transcript shows its [artifact card](artifacts.md), and the agent gets the result at once. The person shares it from **Share…** if they want.
2. The agent republishes the same path later. Core is read; the person is still the owner, so it publishes with the audience kept, even if shared. The transcript shows a line "Updated without asking" above the card.
3. The agent names an `artifact_id` that another agent published, or core cannot be read for the artifact, or the person is no longer its owner. The chat shows the approval card with `Deny`, `Edit…`, `Publish`; the Inbox shows a row "Publish artifact" with **Publish** and **Deny**. The agent's call is blocked.
4. The person presses **Publish** on either surface. Main publishes with the agent's arguments, the card becomes the [artifact card](artifacts.md) of the result, the row settles, and the agent gets `{artifact_id, revision, url, kind, file_count, size_bytes, excluded}`.
5. The person presses **Deny**: the agent gets "The user declined to publish `reports/q3`; do not retry unless they ask." The transcript says "Not published — you declined".
6. The person presses **Edit…**, changes the title and picks *Everyone on the instance*, then publishes: the artifact is published as edited and the agent's result describes what really happened.
7. A failure on **Publish** (the instance unreachable, the folder over the limits) is said in the card, which stays; the request is still pending, so the person can retry, edit or deny.

## Business Rules

### Who is offered the tool

- Only a **folder agent's own session**, and only while the active profile's instance keeps artifacts (the support main last read; `hub/core.ts` reads it as each profile becomes ready). A session with no artifacts support is never offered a tool it cannot use.
- The session is validated like the task tools': an activated app, the profile it was opened under, a chat that answers to this agent, an enabled agent. The agent's folder comes from that check, never from the call.
- What is read, sent and remembered is the **session's** profile's account, not whichever profile is active when the call lands.

### The gate

- **A new artifact publishes without asking**, private: it reaches nobody but its owner.
- **A republish into this agent's own artifact publishes without asking** (`agentArtifactPolicy`). "Its own" is the local row's `agentId` equal to the agent: by the agent's own call, or by the person's Publish… from that agent's chat. The path need not match when `artifact_id` is given. Core is read **right now**: still the user's, it publishes and **keeps the audience, shared or not**. This is a product decision: republishing updates the artifact for whoever the owner already shared it with, rather than asking on every update. The agent still cannot widen it.
- **It asks (the card) when** core cannot be read for an existing artifact, the user is no longer the owner, or `artifact_id` names another agent's artifact.
- **The state is read fresh, never from the local row.** Ownership set on core never reaches this machine's memory, so a stale row could name an artifact the person no longer owns. Publishing on that would have written into someone else's artifact.
- **An agent never shares.** The tool takes no visibility and no link; a new artifact is private and a republish leaves the audience as the person set it (`keep`). When a card is shown it says who would see the new content (for an artifact already shared, it says so) before anything is sent.
- **A deleted artifact becomes a new one.** If core no longer has the artifact the agent asked to update, it is published as a new private artifact, without a card.
- The old per-agent "approved" record is gone: `approved_agent_id` is no longer read or written (the column stays to spare a migration).

### Waiting, and ending the wait

- Only a call that raised the card waits. It waits for the park timeout (an hour, the same as every parked ask). Nobody answering is "Nobody answered the request to publish … within an hour"; the transcript says "Not published — no answer within an hour".
- **Stop** (the chat is stopped, the turn aborted) cancels the wait: "The request to publish … was cancelled before the user answered". The transcript says the chat stopped before the person answered.
- **A stop or timeout during an approved upload waits for it**, up to two minutes. An upload cannot be called back; the call settles with what really happened (published, or the stop/timeout if the upload failed), not with a cancel that hides an artifact now on the instance.
- One answer runs at a time. A second **Publish** while one is uploading is refused ("already being answered").
- Every refusal reaches the agent as a sentence it can act on, and the row also carries a note in the person's words (`artifact-refusal:…`), so the transcript never shows the agent's phrasing as if it were the system's.

### What the agent is told when the tool refuses

A path outside the workspace, a missing path, an excluded path (the sentence names the reason), a folder where every file is excluded, an `entry` that is not an HTML file in the folder (with the pages that are), an over-limit folder, an unknown `artifact_id`, and a profile without support are all refused before anything is published or any card is shown.

## Skill delivery

The `cinna-artifacts` skill is platform-owned: it arrives in the kit bundle (`skills/cinna-artifacts/`) beside `cinna-tasks` and is delivered the same ways — with one extra gate, because an agent must never read about a tool it is not offered:

- **Gated on support, per profile.** The skill is delivered, and the prompt's "Cinna artifacts" section written, only while the active profile's instance keeps artifacts. With no gate installed it is closed.
- **Claude** — a second desktop-owned local plugin (`<userData>/cinna-plugins/cinna-artifacts/`), rebuilt when the skill's tree hash changes, beside the `cinna-tasks` plugin.
- **OpenCode** — `skills.paths` now lists each platform skill by **its own folder** (`cinna-tasks`, and `cinna-artifacts` only while supported), not the bundle's `skills/` root: the root would hand every agent `cinna-artifacts` whether or not it was offered the tool. Opening `cinna-artifacts` is allowed like `cinna-tasks`, so the platform's own skill does not stop the turn for a click.
- **Codex** — no skill loader, so the prompt names `SKILL.md` by absolute path.
- **Antigravity** — an isolated home gets a copy of the skill and the prompt names it; the copy is removed from an earlier launch's home when artifacts are no longer supported; a native home gets the same path pointer as Codex.
- **`cinna-artifacts` is a reserved name**: an agent's own or catalog skill may not take it.
- **Where a kit agent builds what it publishes.** A kit agent in conversation mode is told to write only under `app-data/` (never published) and, for anything it will publish, under `artifacts/<name>/`. The folder is the kit's `artifacts` role (contract 1.13.0 and later), which the prompt reads from the bundled `layout.json` (`artifactsFolderRole()`) rather than hard-coding, and the `cinna-artifacts` skill and the `path` description of `artifacts_publish` say the same. It is runtime-only like `app-data/`: git-ignored by the agent template, listed in `never_travels` and the cloud-import excludes, so what one person's runs built never reaches teammates or a cloud copy. Why it exists: before it, the only place a kit agent could write was `app-data/`, which publishing refuses, so an agent asked to build a report and publish it had nowhere that worked. Under an older contract the prompt names no such folder, rather than inventing one that would travel with a shared agent, and the agent has to be told where to write. A bare folder agent writes where it is asked. A folder built elsewhere is not refused; `artifacts/` is the convention, not a restriction.
- **Running sessions keep their old state.** The skill and tool set are read when a session starts. A non-Claude engine already running when support changes keeps what it had until it is relaunched; Claude reads its plugin per session.

## Known limits

- **Codex's 60 second tool timeout.** codex-acp times an MCP tool call out after 60 seconds by default, which is shorter than any approval a person will answer. It now matters only for the remaining card cases (an unreadable core, a lost ownership, another agent's artifact): a Codex agent's call is cut short while the card is still waiting. Ordinary publishes no longer wait. Fixing it needs a change to the pinned adapter's patch, which is not made here ([Runtime Pins](../../development/runtime_pins/runtime_pins_llm.md)).
- **Own-artifact memory is local.** "This agent published it" is the row on this computer; an artifact published from another machine is not recognised, so an `artifact_id` naming it asks.

## Architecture Overview

```
Agent (engine) -> cinna MCP (conductorBridge) -> ArtifactToolProvider.callTool
   -> validate session -> inspect -> policy (fresh detail read for an existing row)
        publish -> publishService.publish (new: private; own republish: keep audience) -> result
        ask  -> needs_input(art_<id>) -> approvals.open (blocks)
                  transcript card / Inbox row / Edit… -> approvals.answer -> publish -> settle
   <- artifact_id, revision, url, kind, file_count, size_bytes, excluded
```

## Integration Points

- [Artifacts](artifacts.md): what publishing sends and refuses, the cards and Share.
- [Agent Task Tools](../../jobs/tasks/agent_task_tools.md): the other tools on the `cinna` server; same session validation.
- [The Cinna Task Protocol](../../jobs/tasks/task_protocol.md): skill delivery per engine, which `cinna-artifacts` follows.
- [Inbox](../../jobs/tasks/inbox.md): the `art_` row and how its answer is routed.
- [Ask User Question](../ask_user_question/ask_user_question.md): the approval is raised as a Publish/Deny question, so the Inbox and the transcript already know how to show and answer it.

[Technical details](agent_publish_tech.md)
