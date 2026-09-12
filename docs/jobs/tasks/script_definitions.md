# Script Definitions

## Purpose

Store a portable plan of agent steps and human questions alongside a reusable job or durable task. Validation rejects ambiguous dependencies and executable expressions before a local definition is saved.

This is a definition foundation. The desktop does not yet execute the graph or offer a script editor. Saving or syncing a script does not start agents or create Inbox questions.

## Core Concepts

- **Script** — versioned data containing agent aliases and a directed, acyclic graph of steps.
- **Agent alias** — a script-local name for a portable agent descriptor. It is not a device-local database ID or a display-name lookup.
- **Step** — either a prompt for one declared agent alias or a human question, with optional dependencies.
- **Template** — literal text with goal or dependency-output substitutions. It contains no JavaScript, shell evaluation or nested scripts.
- **Autonomous job definition** — an explicit job router (`script` or `coordinator`), optional budget and, for `script`, the script itself. An ordinary job leaves these fields null.

## Authoring Flow

1. A programmatic caller supplies a version-1 definition through the existing job create/update contract; the current Job Edit form has no script controls.
2. Main validates the merged runtime configuration and the entire graph before writing. Invalid local changes leave the saved definition intact.
3. Job details and task DTOs carry the saved definition. Encrypted app sync transfers its portable data without installing agents or starting work.
4. Attempting to run a defined autonomous job through the current job executor is refused before a chat, task or job attempt is created. A task carrying a script also cannot use ordinary **Continue**.

## Business Rules

- **Preserve ordinary jobs.** A null job router keeps the existing routing derived from agents and connectors. An explicit `coordinator` job definition is distinct from an ordinary job whose spawned chat happens to use coordinator routing.
- **Validate the whole definition.** Local autonomous routing requires a local job. Script data requires the script router, and a budget requires an autonomous router. Editing runtime fields validates the existing values merged with the patch, so clearing a router cannot silently discard a still-present script.
- **Dependencies control data access.** A step may read the goal and the output of its direct or transitive dependencies. Sibling, self and unknown outputs are rejected; declaration order does not substitute for dependency edges.
- **Text stays data.** Substitution is single-pass: braces inside inserted output are not evaluated again. Oversized expanded prompts are refused instead of silently truncating instructions. A separate compact-output helper marks shortened output explicitly.
- **A task's script choice is fixed locally.** A script task needs a validated definition when created and cannot be a child task. Local task updates cannot switch into or out of the script router; no service-level script edit action is exposed.
- **Preserve future data without executing it.** Sync stores received script and budget payloads without current-version normalization. Unrelated title edits preserve them. Editing a job's runtime configuration or attempting execution validates supported syntax again, so receiving a newer definition cannot cause a fallback model run.
- **Portable references do not transport agents.** Script aliases remain inside the definition, separate from the job's ordinary dependency joins. Receiving them does not create agent rows or resolve aliases into execution targets. Folder agents remain local files; see [Local Agents Are Not Synced](../../agents/local_agents/local_only.md).

## Architecture Overview

Programmatic job/task authoring → main validation → SQLite definition → DTO and encrypted app sync.

Execution request → runtime-definition guard → refusal until the autonomous job/script executor exists.

## Integration Points

- [Technical contract](script_definitions_tech.md) — exact fields, bounds, parser helpers and persistence paths.
- [Jobs](../jobs/jobs.md) — reusable definitions and existing attempt history.
- [Tasks](tasks.md) and [device sync](cross_device.md) — durable work and portable fields.
- [Autonomous tasks](autonomous_tasks.md) — the existing coordinator-chat runner; storing a coordinator job definition does not invoke it.
