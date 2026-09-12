# Script Definitions — Technical Contract

## File Locations

- Shared: `src/shared/taskScript.ts` defines `TaskScript`, `ScriptStep` and `ScriptAgentRef`; `src/shared/jobs.ts` adds `JobRuntimeDefinition` to job data/create/patch DTOs; `src/shared/tasks.ts` carries task script data.
- Main validation: `src/main/tasks/scriptRouter.ts` validates definitions, expands templates, compacts outputs and selects ready steps; `src/main/tasks/jobRuntimeDefinition.ts` validates merged job runtime fields; `src/main/tasks/runtimeBudget.ts` checks budget values.
- Main persistence: `src/main/db/schema.ts`, `src/main/db/jobs.ts`, `src/main/db/tasks.ts`, `src/main/db/migrations/jobs.ts` and `src/main/db/migrations/tasks.ts`.
- Main callers: `src/main/services/jobService.ts`, `src/main/services/taskService.ts` and `src/main/services/taskExecutionService.ts`.
- Sync: `src/main/sync/collections.ts` job/task mappers carry definitions; `src/shared/sync.ts` supplies the portable agent descriptor variants.
- Preload: `src/preload/index.ts` reuses shared job create/update DTOs. Renderer: existing Jobs and Task pages receive data; this foundation adds no editor, graph view or dispatch hook.
- Tests: `src/main/tasks/scriptRouter.test.ts` covers validation/interpolation; `src/main/tasks/scriptDefinitionPersistence.test.ts` covers local writes, sync round trips, migration replay and pre-dispatch refusal.

## Authoring Contract

### Script object

Only `version`, `agents` and `steps` are accepted at the top level. `version` must equal numeric `1`. `agents` is a plain/null-prototype object mapping aliases to descriptors; `steps` contains 1–64 entries. Human-only graphs may use an empty agent map. At most 64 aliases are accepted.

Aliases and step IDs match `[a-z][a-z0-9_-]{0,63}`. `goal`, `constructor`, `prototype` and `__proto__` are reserved. Step IDs are unique; aliases and step IDs are separate namespaces. Local validation rejects unknown fields rather than accepting instructions this version cannot interpret.

### Portable agent descriptors

Every descriptor has `kind: 'agent'` and may have a nonblank `name` of at most 256 characters for display. The exact source-specific fields are:

| Source | Required identity fields |
| --- | --- |
| `folder` | `manifestId`: nonblank string, at most 256 characters |
| `local` | `cardUrl`: HTTP(S) URL, at most 2,048 characters, no embedded username/password |
| `remote` | `serverUrl`: same URL rules; `remoteTargetId`: nonblank string up to 256 characters; `remoteTargetType`: `agent`, `app_mcp_route` or `identity` |

No extra descriptor keys are accepted. Definitions store these descriptors directly; validation does not look up agents, fetch cards or make their availability a claim. Existing job `sync_deps` and attachment joins are not rebuilt from script aliases in this foundation.

### Steps and dependencies

Each step has `id` and optional `after`, plus exactly one action: `agent` alias with `prompt`, or `ask_user` question text. A human step cannot also carry `agent` or `prompt`. Unknown step fields are rejected. `after` is normalized to an array, accepts at most 64 IDs, and rejects duplicates, missing targets and cycles, including self-dependency. Array order need not be topological.

Prompt/question text must be nonblank and at most 64,000 JavaScript string characters; accepted text retains its original whitespace. The serialized agent map plus normalized steps must fit the validator's 1 MiB UTF-8 aggregate text bound.

Templates support only `{{goal}}` and `{{step_id.text}}`, allowing whitespace inside the braces. An output reference must name a direct or transitive dependency. Unknown expressions and unmatched double braces are rejected. `expandScriptTemplate` requires each referenced output to be an own string-valued property and inserts it exactly once; inserted braces remain literal. Expanded text may not exceed 64,000 characters. `compactScriptOutput` limits context output to 16,000 characters, including an explicit shortening notice. These are data helpers, not evidence that step conversations or execution exist.

### Job runtime fields and budgets

`JobRuntimeDefinition` permits `router: 'coordinator' | 'script' | null`, `script: TaskScript | null`, and `budget: TaskBudget | null`, all optional. Null/omitted fields preserve ordinary jobs. An explicit router is accepted only for `type: 'local'`; script data requires `router: 'script'`; budget data requires an explicit autonomous router. A script router always requires a valid script.

A non-null budget accepts only `maxRounds`, `maxMinutes` and `maxTokens`. It fills missing rounds/time with 20 and 60; rounds must be an integer from 1–1,000, minutes finite and greater than zero through 1,440, and tokens a positive safe integer. A null budget stays null at definition storage. A structurally valid token field is not a claim of token enforcement: current autonomous execution refuses unsupported token budgets before dispatch, as described in [autonomous runtime details](autonomous_tasks_tech.md).

## Database Schema

- `jobs.router` is nullable text; `jobs.script` and `jobs.budget` are nullable JSON-backed text columns. `migrateJobs` adds missing columns idempotently, leaving existing jobs null and preserving populated definitions on rerun.
- `tasks.script` is nullable JSON-backed text, added by `migrateTasks`; task router and budget already existed. The DTO includes `script`, defaulting absent stored values to null.
- `jobsRepo` create/upsert and `taskRepo` create/upsert carry script fields explicitly. Runtime progress is not stored in script JSON. Existing coordinator checkpoints remain device-local; this foundation adds no script checkpoint table.

## IPC Channels

No new channels are added. `job:create(input: JobCreateInputDto)` and `job:update(id, patch: JobPatchDto)` accept the runtime fields through existing ownership/activation checks. Job list/detail results include them. Task read DTOs include script data; ordinary task update has no script replacement field.

`job:execute` still reaches the existing dispatch paths. `jobService.executeLocal` validates any non-null runtime definition and refuses with “This job requires the autonomous job executor.” before creating a chat, task or attempt. The remote execution branch also validates unexpected runtime data rather than ignoring it. `taskExecutionService.start` refuses both `router === 'script'` and any non-null script payload, preventing a script-bearing task from falling through ordinary Continue.

## Services & Key Methods

- `validateTaskScript(input)` returns a normalized copy with explicit dependency arrays; invalid local definitions throw before persistence.
- `readyScriptSteps(script, states)` returns pending steps whose dependencies are completed, in definition order. It neither claims nor dispatches them; a durable scheduler remains separate work.
- `jobRuntimeDefinition(input)` validates the coupled router/script/budget fields. `jobService.create` calls it before saving; `update` calls it only when the patch owns `type`, `router`, `script` or `budget`, using merged existing values. Title/prompt-only edits preserve future runtime data.
- `taskService.create` validates script definitions and rejects script children; `update` refuses router transitions into/out of script. The script is a creation-time choice on the local service path, not a promise that incoming sync cannot update the stored payload.
- The job/task sync mappers encode definitions as stored and apply received script/budget JSON without passing it through local validators. Future versions, extra fields and unknown router strings survive the raw persistence/encode path and unrelated edits. TypeScript casts on sync are not validation; the task DTO's display-oriented router parser may normalize an unknown router, while the stored value remains intact.

## Renderer Components

The existing job form still edits ordinary prompt/agent/mode/connector fields. It offers no versioned script authoring or autonomous job controls. Do not infer readiness from existing router badges or dependency setup panels: these describe ordinary job attachments, not resolved script aliases.

## Configuration

No new setting, schedule, environment variable or runtime toggle is introduced. Definition bounds are constants in `scriptRouter.ts`; current coordinator runtime settings remain separate.

## Security

Job and task ownership checks remain profile-scoped, including sync upsert collision protection. App sync uses the existing encrypted collection path; script references neither install agents nor carry credentials. Parsing accepts data and substitutions only, rejects inherited output keys and credential-bearing URLs, and never evaluates shell/JavaScript. Stored future definitions are preserved for compatibility; unsupported execution is refused rather than downgraded to an ordinary model turn.
