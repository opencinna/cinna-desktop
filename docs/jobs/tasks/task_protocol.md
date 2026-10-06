# The Cinna Task Protocol — one vocabulary for agents and tasks

## Purpose

An agent that works on Cinna tasks — reporting how its work went, adding work to its own queue, asking another agent for work — uses one set of words for it, whichever engine it runs on and whichever Cinna host runs it. The desktop is one host of that protocol. This document covers what the desktop takes from it, how it teaches it to its folder agents, and where each part is enforced.

## Core Concepts

- **The protocol (CTP v1)** — the eight tools, their arguments, the status words, the result packet's first line and the turn context block. It is written in cinna-core and arrives in the desktop inside the [kit bundle](../../agents/local_agents/kit_contract.md) (`protocols/tasks.schema.json`, kit contract 1.6.0). **The source of truth is cinna-core's kit, not this repository.** A change to a tool's arguments starts there and reaches the desktop through `make kit-sync`.
- **Three bindings** — three ways of doing the same verbs:
  - **Tools** — the `tasks_*` tools on the loopback MCP server named `cinna`, offered to a folder agent's own session ([Agent Task Tools](agent_task_tools.md)).
  - **Files** — `.cinna/tasks/*.md` as an agent's own queue ([Folder Tasks](folder_tasks.md)) and `.cinna/handovers/<id>/` as a request for work ([File Handovers](file_handovers.md)), for a terminal, a script, `git` or a person, with no tool server at all.
  - **cinna-core** — cinna-core's own agent environments serve the same eight tools on their own `cinna` server; the desktop reaches cinna-core's tasks through its [task adapter](cinna_adapter.md) and delegates to its agents through the [Handover Bus](handover_bus.md)'s cloud channel.
- **The `cinna-tasks` skill** — the platform-owned text that teaches the protocol: what a Cinna task is and is not, the two rules, a verb table, the lifecycle, how to delegate, and the file binding (`SKILL.md` and `references/file-protocol.md`). Versioned with the protocol and shipped in the same bundle (`skills/cinna-tasks/`).
- **Ref** — a task reference as the host shows it (`t-3f9a2b1c`, `TASK-5`, a folder task's id). The agent copies it from a tool result or the turn context and never builds one.
- **Target** — the opaque string `tasks_targets` hands out and `tasks_create.assignee` takes back: `folder:<agentId>`, `kit:<agentId>` or `cinna:<adapter>:<agentId>`.
- **Category and report status** — two vocabularies on purpose. `category` (`backlog`, `ready`, `active`, `waiting`, `done`) is where a task sits; `done` covers completed, failed and cancelled work. A report's `status` (`in_progress`, `blocked`, `done`, `failed`) is the executor's statement about its work. The desktop writes `done` as `completed` and `failed` as `error` on its own status column.
- **Result packet** — what a requester reads when delegated work comes back: a desktop-authored message in its own chat, never a tool return, whose first line is always `Task result from <agent> on <ref>: <status> — <summary>`.
- **Cinna task context** — the data-only block the desktop puts in front of each folder agent turn: who and where the agent is, its current task and whether a report is required, the chain and queue counts, and the skill's version.

## User Stories / Flows

1. **A turn starts on a task.** The agent's message arrives behind the context block, for example `- current task: \`t-3f9a2b1c\` "Add retry" (report required: yes)` and `- tasks skill: cinna-tasks v1`. The system prompt's short Cinna tasks section has already told it the two rules and how to open the skill.
2. **The agent opens the skill** before its first `tasks_*` call — by name on Claude and OpenCode, or by reading `SKILL.md` at the absolute path its prompt names on Codex.
3. **It works and reports.** It may comment on the way (`tasks_comment`), and ends with `tasks_report` `done` or `failed` and a one-line summary, or `blocked` with a question. The desktop records the report on the task, and the [dispatcher](task_dispatcher.md), a job run or the [Handover Bus](handover_bus.md) reads it.
4. **It hands work on.** It calls `tasks_targets`, passes one entry's `target` verbatim as `assignee` to `tasks_create` with an `id` and the whole brief as `description`, and ends its turn. Later its chat gets a system turn starting `Task result from …`, and it answers a question for it with `tasks_reply`.
5. **Somebody without a tool server takes part.** A terminal session writes a brief, a report or a task file, following the same skill's file reference. The desktop treats the file exactly as it treats the tool call it corresponds to.

## Business Rules

### The contract is cinna-core's, and the desktop proves it matches

- **The desktop's tool schemas are a copy, held equal by a test.** The schemas are written out in the desktop's tool provider, and a parity test compares every tool's input schema with the bundled `tasks.schema.json`, its `$ref`s resolved. They are written out rather than read from the file at runtime, because an engine reads each tool's input schema on its own, without the file's shared definitions.
- **The parity test skips, rather than fails, when the bundle has no schema yet**, so a tree from before the sync stays green. Once the schema is in the bundle, a tool that differs from it by one property fails the suite.
- **Old tool names are not registered.** The schema keeps a record of the names each host used before (`handover_targets`, `task_create`, … on the desktop). The desktop registers none of them: an alias would double every agent's tool list, and the desktop keeps no list of tool names that an alias would have to stay in.
- **Server name `cinna`, tool names `tasks_*`.** Every engine prefixes the server name (Claude `mcp__cinna__tasks_report`, Codex `mcp.cinna.tasks_report`, OpenCode `cinna_tasks_report`), so there is no technical clash with an engine's own tools. The noun-first names and the skill's first paragraph exist to stop a model confusing a Cinna task with its own plan or todo tool, or with a subagent call. Under the old names, `task_create` sat beside Claude's `Task` and `TodoWrite`.

### Instructions: a short stub in the prompt, the protocol in the skill

- **The system prompt keeps only what must never be missed**: the two rules, quoted from the skill (report before ending a turn on an assigned task; never wait inside a turn), the agent's own id (a brief's `origin.agent` has to state it), and one line saying how to open the skill. It replaced a section of about sixty lines that every folder agent read on every turn, almost all of it the file protocol, which most turns never use.
- **The stub is per agent and per engine, never per turn.** Codex pools processes by their prompt bytes, so a chat id or a task id in the prompt would start one process per chat. Everything that changes per turn goes in the context block instead.
- **No skill, no promise.** When the build's bundle has no skill, the line about opening it is left out and the context block has no `tasks skill:` line, so such a build runs its agents as before, with a prompt that says nothing about a skill they cannot open.
- **The skill reaches each engine by that engine's own mechanism:**
  - **Claude** — as a skill of a local plugin the desktop owns, copied under `userData` and passed in the session options on both the isolated and the native branch. A plugin passed this way is not a user or project setting, so the isolated branch's `settingSources: []` does not hide it (measured: [Claude Engine Contract](../../agents/local_agents/claude_contract.md)). Claude names it `cinna-tasks:cinna-tasks`.
  - **OpenCode** — through `skills.paths` in the generated config, pointing at the bundle's `skills/` folder, with reads under that folder allowed and opening `cinna-tasks` allowed. Without those two allows, under the agent's ask-by-default profile, every opening of the platform's own skill and every read of its reference would stop the turn for a click.
  - **Codex** — no skill loader, so the prompt names `SKILL.md` by absolute path. The read needs no approval, because the Codex sandbox limits writes and not reads (measured on the pinned CLI: [Codex interface](../../agents/local_agents/contracts/codex_interface.md)).
- **A failure to deliver the skill does not stop a turn.** Every step falls back to "no skill". The only case left uncovered is Claude: the prompt's line follows whether the skill is in the bundle, not whether the plugin copy succeeded, so a failed copy leaves an agent told to open a skill it does not have. The failure is logged.

### The context block is data, never instructions

- **Facts only.** It says what is true this turn; what those facts mean is taught in one versioned place, the skill, with the prompt's stub as the reminder.
- **Only for agents in a folder on this machine**, and never persisted: the transcript keeps the user's text alone.
- **`report required: yes`** means someone is waiting on an outcome: the agent's own queue dispatched the task, another agent delegated it, or it is a job run's task. `no` is a hand-opened chat's task, where the turn's end may still settle it.
- **The counts line shows only its nonzero parts**, and is left out when all are zero. A zero is not news: the counts exist so an agent knows there is something to look at without polling `tasks_list`.

### Reporting has one verb

- **`tasks_report` is the only way an agent says how work went.** Closing a task that has been worked on through `tasks_update` is refused, and the refusal names `tasks_report`. A manual close writes no summary and no handoff note, so the task would read as closed with nothing said about how the work went.
- **Repeating a report changes nothing.** The agent may not remember whether its last call landed, so repeating it has to be safe.
- **A report's first line is what every list shows.** The summary is required and must be one line.

## What this deliberately does not do

- **Delegated work is not a subagent call.** It runs later, in another conversation, and comes back as a message. Nothing waits inside a turn.
- **The files cannot discover targets.** There is no file form of `tasks_targets`; a file requester must already know the project path.
- **No tools for nested or remote-launched sessions**: those sessions do not get the `cinna` tools.
- **The desktop does not edit the protocol or the skill.** Both are bundle files that only `make kit-sync` writes.
- **Nothing at runtime reads `tasks.schema.json`.** The parity test is what keeps the desktop's copy equal to it.

## Architecture Overview

```
cinna-core docs/local_agent_kit --make kit-sync--> resources/cinna-agent-kit/
   protocols/tasks.schema.json   --parity test-->  DelegationToolProvider (8 tasks_* schemas)
   skills/cinna-tasks/           --Claude-->   <userData>/cinna-plugins/cinna-tasks/ -> session plugins
                                 --OpenCode--> skills.paths + scoped external_directory allow
                                 --Codex-->    prompt line naming SKILL.md
Folder agent prompt  <- cinnaTasksSection (two rules, agent id, how to open the skill)
Each turn            <- "Cinna task context" block (here, current task, counts, skill version)
tasks_* call -> cinna loopback MCP -> taskToolService -> own queue / Handover Bus / task record
Delegated result -> system turn "Task result from <agent> on <ref>: <status> — <summary>"
```

## Integration Points

- [Agent Task Tools](agent_task_tools.md) — the eight tools as the desktop serves them, and who may call which on what.
- [Handover Bus](handover_bus.md) — delegation, the gate, results and the return packet.
- [File Handovers](file_handovers.md) and [Folder Tasks](folder_tasks.md) — the file binding.
- [The Task Dispatcher](task_dispatcher.md) — the queue that reads a report to decide whether to go on.
- [Kit Contract](../../agents/local_agents/kit_contract.md) — the bundle the schema and the skill arrive in.
- [The Claude Engine](../../agents/local_agents/claude_engine.md), [The Codex Engine](../../agents/local_agents/codex_engine.md), [The Local Engine](../../agents/local_agents/engine.md) — the launch options that carry the skill.
- [Technical details](task_protocol_tech.md).
