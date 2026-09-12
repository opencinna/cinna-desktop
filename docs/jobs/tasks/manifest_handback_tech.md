# Manifest Handback: Technical Details

## File Locations

- Contract: `src/shared/kit/manifest.ts`, `src/shared/kit/handovers.ts`, `src/main/kit/validator.ts`, `resources/cinna-kit-contract/schema/cinna-agent.schema.json`, `resources/cinna-kit-contract/CHANGELOG.md`.
- Eligibility: `src/main/services/taskRunnerService.ts`, `src/main/services/runExecutionService.ts`, `src/main/agents/drivers/driver.ts`.
- Folder/driver: `src/main/agents/drivers/index.ts`, `src/main/agents/drivers/acp/acpDriver.ts`, `src/main/agents/drivers/acp/handback.ts`.
- Result/prompt: `src/main/services/a2aStreamingService.ts`, `src/main/services/turnCompletion.ts`, `src/main/services/localAgents/promptAssembly.ts`.

## Database Schema

No schema or checkpoint migration is added. The existing assistant message retains its marker. The existing agent_transition message records the bounded note; the saved coordinator continuation prompt includes the same notice because transition rows are omitted from provider history. It is not written as a new task destination or executable command.

## IPC Channels

No new IPC or preload field exists. handbackEligible is an internal runner/executor option, not part of a renderer send payload. Existing selected-chat attachment and saved-message queries show the answer and transition.

## Services & Key Methods

- `isCoordinatorHandover` recognizes only the exact target_kind/target_slug coordinator pair. Optional target_kind is an open string, not a future-incompatible enum. Absent kind retains sibling semantics; unknown kinds do not authorize this feature.
- `checkHandovers` retains the existing slug syntax, validates a declared kind's type and refuses a recognized coordinator kind with a different slug. Only the exact pair skips sibling/self lookup warnings. The pinned older schema accepts additional keys and old missing/self sibling checks are warnings. The changelog limits compatibility claims to verified desktop behavior.
- `taskRunnerService.drive` sets eligibility only for its handed-off agent owner. runExecutionService rejects eligible options without an owning task and agent, or with coordinator tools, and retains its ordinary profile/chat/device admission checks.
- `readAcpFolder` rescans through localAgentService.get and adds coordinatorHandback only for a kit manifest with the declaration. This snapshot is read on the turn path; cached prompt text never grants authority.
- ACP `finish` calls `readHandbackNote` only after protocol end_turn with no error, no aborted signal, host eligibility and the kit declaration. It reads accumulator.answerText, never the display fallback joining other part kinds. AcpMessageStream fixes text/thinking/tool-result kinds, and session/load replay is dropped before accumulation.
- `readHandbackNote` normalizes newlines, removes trailing blank lines and accepts the final column-zero `/handback ` line with a trimmed nonempty note of at most 4,000 characters. It tracks backtick/tilde fences so an unclosed example is not a control. It returns data without altering the saved answer.
- RunAgentTurnResult and TurnOutcome carry an optional typed handback note. The streaming wrapper forwards it only on completed outcomes after transcript persistence. Remote A2A metadata does not populate this field.
- The coordinator validates authority and outcome/request bookkeeping before consuming the note. Open questions retain the specialist owner. On successful return it JSON-quotes the agent-provided note in both the transition and next coordinator input; ordinary unmarked return is unchanged.
- `handoverSection` renders legacy sibling hints separately from conditional coordinator-marker guidance. Unknown kinds supply neither coordinator authority nor marker guidance. Kit and bare desktop context now describe unattended requests; no per-task IDs or capabilities are stored in shared prompt context.

## Renderer Components

There is no new editor, button or marker parser in the renderer. Existing transcript rendering shows the preserved answer and ownership notice. NoticeBlock permits its text flex item to shrink and wrap unbroken words in both live and expanded persisted views; long path/token notes previously overflowed the conversation. Collapsed preview behavior is unchanged, and the Inbox retains its normal question precedence. Script steps and ordinary delegates do not gain a coordinator destination.

## Configuration

The bundled contract is 1.3.0 in VERSION, kit.json and layout.json. Existing major-version compatibility rules remain unchanged; folders are not automatically rewritten. The note bound is fixed at 4,000 characters. No setting or environment variable enables handback independently of main ownership.

## Security

Manifest data and final text are insufficient by themselves. Only the current main-owned specialist turn can produce this typed note, and the runner's current claim, cancellation, request and completion checks remain authoritative. Tool results, thoughts, session replay, bare-agent prompts and unknown manifest kinds cannot acquire control. The note remains untrusted conversational context; it does not select a new model, agent, task or chat.

## Validation and Boundaries

`src/main/agents/drivers/acp/handback.test.ts` pins parser cases; `acpDriver.test.ts` covers answer versus tool/reasoning/replay and unsuccessful endings; `src/main/agents/drivers/index.test.ts` covers fresh declaration changes and bare folders. Validator, prompt and taskRunnerService tests cover compatibility, delegate exclusion, note propagation and saved-question precedence. These references describe coverage, not a completed built-app validation claim. External kit.py/cinna-core compatibility remains unverified.
