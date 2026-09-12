# Managed Agents — Technical Details

## File Locations

- Main: `src/main/services/managedAgentService.ts`; `src/main/agents/drivers/managed/managedDriver.ts`, `managedRun.ts`, `managedEvents.ts`; registry `src/main/agents/drivers/index.ts` and capabilities `src/main/agents/drivers/capabilities.ts`.
- Persistence: `src/main/db/managedAgentSessions.ts`, `src/main/db/agents.ts`, `src/main/db/llmProviders.ts`, `src/main/db/schema.ts`; migrations `src/main/db/migrations/a2a-sessions.ts` and `src/main/db/migrations/providers.ts`.
- IPC: `src/main/ipc/agent_a2a.ipc.ts`; preload `src/preload/index.ts`; public reference types/parser `src/shared/managedAgents.ts`.
- Renderer: `src/renderer/src/components/agents/ManagedAgentModal.tsx`, `src/renderer/src/components/agents/local/LocalAgentsList.tsx` and `NewLocalAgentModal.tsx`; permission surface `src/renderer/src/components/chat/PermissionRequestBlock.tsx`, `src/renderer/src/components/inbox/InboxView.tsx`, `src/renderer/src/hooks/useAgentRequests.ts`, `src/renderer/src/hooks/useReplyUncertainty.ts`, `src/renderer/src/utils/answerError.ts`.

## Database Schema

- `agents`: locally owned row with `driver = managed`; `driver_config` holds credentialId, agentId, environmentId, optional workspaceId/version and a main-generated revision. The ordinary A2A form cannot set runtime configuration. Runtime edits require the same locally owned row and driver; enablement changes rotate its revision too.
- `managed_agent_sessions`: private unique chat/agent binding with immutable remote session ID, binding fingerprint, state and updated timestamp. Chat and agent deletion cascade. The fingerprint covers active profile, agent owner, agent configuration and credential identity. A mismatched binding or unsupported state refuses reuse.
- States: ready before kickoff or after a confirmed normal/stop ending; inflight persisted before sending a message; uncertain after an unconfirmed ending; budget after a remote budget pause. Restart retains these guards.
- Saving a checkpoint and its public `a2a_sessions` context-ID mirror is one transaction. Ownership is checked inside it. The generic session IPC returns that mirror only; private binding fingerprints never join the renderer DTO.
- `llm_providers.config_revision` increments for credential-affecting edits, including disable/re-enable. A name-only edit is stable. `src/main/services/accountConfigService.ts:encryptedSyncedKey()` reuses the encrypted envelope when the decrypted synced key is identical, because randomized re-encryption must not invalidate an otherwise unchanged session.

## IPC Channels

All three handlers require activation and resolve scope in main; exposed as `window.api.managedAgents`.

| Channel | Input → result |
|---|---|
| `managed-agent:configuration` | local agent ID → name and public ManagedAgentConfig |
| `managed-agent:choices` | credentialId, optional workspaceId → agents and environments |
| `managed-agent:save` | optional local id/name, ManagedAgentConfig → local id |

`agent:reply-uncertainty` takes a request ID and returns a warning string or null through window.api.agents.replyUncertainty. It requires activation and synchronous active-profile chat ownership before reading the still-current registration’s claim; credentials, transport bindings and the answer never join that display result.

The normal agent send, readiness, session lookup and shared Inbox answer channels handle execution. No special renderer-controlled session or answer destination is accepted.

## Services & Key Methods

- `managedAgentService.configuration()` reads settings-owned configuration. `choices()` enumerates both remote collections, validating the captured credential after waits and before return, with a shared 30-second deadline and a 1,000-item limit per collection. `save()` retrieves the selected agent/version and environment, rechecks profile/settings scope and original row identity, then saves; an older pending edit cannot overwrite a newer configuration.
- `managedAgentService.prepare()` captures the SDK client, config and private checkpoint. Its validate/save closures recheck profile, chat, agent, enablement, credential revision and config identity. No subsequent lookup silently chooses a replacement destination.
- `createManagedDriver()` keeps one running turn per owner/chat/agent. Readiness validates local configuration and credential availability. Its synchronous respond refuses: the exact per-run asynchronous registration owns replies.
- `runManagedSession()` creates/retrieves a session, attaches SSE before reading every ascending history page, checks readiness, saves inflight and sends one user.message. After acknowledgment it rotates the stream before reading full history again. This discards an old pre-kickoff buffer while recovering the gap without another message POST. Stream failures/closure permit two reattachments, each followed by full history reconciliation.
- `ManagedEvents` shares event identity/stage tracking between history and live SSE. Initial history establishes baseline only. Queued→processed upgrades remain observable, while repeated processed events do not duplicate output. Full history reconciliation resolves tool/confirmation relationships before any permission park. Output starts only after the exact acknowledged kickoff becomes processed. Root idle end_turn/budget_reached end the turn; requires_action registers every unresolved ask permission; unsupported actions refuse. Child idle and preview deltas do not complete or write a turn.
- History and reducer identity tracking cap at 50,000 events. Authoritative agent.message text produces transcript deltas; thinking/running/rescheduled produces working status; tool and result events become message parts. Retrying session errors show progress; exhausted retries, deletion and unexpected termination fail explicitly.
- Every permission registers its private delivery binding and barrier before awaiting all siblings. The confirmation echoes the exact tool ID, allow/deny decision and optional session_thread_id; acknowledgment must match all three and contain an event ID. A queued acknowledgment is acceptance, while the shared answer transaction is the continuation barrier. Subsequent stream output waits for durable commitment even when it arrives before HTTP returns. See [captured delivery](../drivers/drivers_tech.md#captured-asynchronous-reply-delivery).
- Interrupt is idempotent within the run. It cancels local parks, sends user.interrupt, rotates the stream and reconciles complete history, then drains until the exact processed interrupt precedes root idle/termination or the deadline expires. Unconfirmed Stop saves uncertainty and a visible notice. Remote budget encountered during Stop stays a budget checkpoint.
- `src/main/services/a2aStreamingService.ts` preserves stopReason budget in done and TurnOutcome, saving partial text. `src/main/services/a2aAsMcpProvider.ts` exposes a budget ending as an error tool result so a coordinator cannot treat a paused specialist as successful completion.

## Renderer Components

- `LocalAgentsList` exposes Managed entries separately from folder roots; + opens the existing creation chooser. Only its folder creation choice requires Agents Home setup. Sidebar selection opens `ExternalAgentPage` in chat mode; Settings → Connection → Configure opens the Managed modal. The shared page keys its chat workspace by profile/agent and retains it while Settings is visible. Header lifecycle actions remove only the Desktop connection; the modal continues to own resource editing.
- `ManagedAgentModal` filters enabled supported Anthropic API credentials. Load workspace fills resource choices; credential/workspace changes invalidate the loaded selection identity. Editing seeds visible options with saved agent/environment IDs before a successful catalog load; this does not mark loadedFor verified. The load button uses a fixed width so its pending caption cannot resize the credential selector. Save is disabled until current choices exist. Errors retain values; close and edits are disabled during requests. Request generation and mounted/profile guards discard stale responses.
- `PermissionRequestBlock` honors allowRemember false for both transcript and Inbox. `AnswerDeliveryError` preserves the main-owned uncertain code; a failed uncertain submission disables every decision without presenting an accepted answer. `useReplyUncertainty` uses useSyncExternalStore to share warning strings across transcript and Inbox, bounded to 2,000 request IDs. An uncertain answer updates both surfaces immediately. Every newly mounted interactive one-time permission checks main before enabling decisions, polls every700ms while live, and discards responses after unmount/request change. A failed initial read leaves the block inert and retries; a positive warning stays conservative if a later read returns null. Main rehydrates the warning after renderer reload and remains the protection against repeated confirmation IPC. Main-process restart is different: claims expire and ordinary driver reply rows do not replay.

## Configuration

- Uses the installed Anthropic SDK0.125 beta agents/environments/sessions/events API and its HTTP/SSE transport. No custom transport implementation or automatic retry of mutating calls is supplied.
- Existing main-owned credential base URL, or SDK environment/default endpoint, selects the service. ManagedAgentConfig accepts references only, bounds strings to 512 characters without control characters, and accepts only a positive safe-integer version. Name is bounded to 200 characters.
- SDK requests default to 30 seconds and maxRetries zero. Stop drain defaults to 30 seconds. Tests may inject shorter request/stop deadlines.
- SDK0.125's confirmation input type omits session_thread_id although its response event exposes it; the structurally compatible confirmation object carries it on the wire. Preserve this routing field when upgrading the SDK.
- No preview stream, usage/budget configuration, custom tool-result submission, question/auth/elicitation path, attachment upload, remote-resource creation or desktop MCP injection is implemented. Remote budget and unfinished-session recovery require explicit user action outside this turn.

## Security

API keys decrypt only in main and Claude CLI OAuth tokens are refused. Fingerprints are private hashes of the captured binding, never credentials in an IPC payload. A replaced key, temporary disable/re-enable, deleted resource, profile change or edited agent invalidates held operations before further dispatch/save. An already sent remote request cannot be recalled by a local configuration guard; uncertain acceptance never authorizes another POST.

## Verification Boundary

`src/main/agents/drivers/managed/managedRun.peer.test.ts` drives the official SDK against actual fixture HTTP/SSE, including paged history, kickoff gates, sibling permissions, thread routing, local-only commit retry, uncertainty, budgets and Stop. `src/main/services/managedAgentService.test.ts` uses SQLite and actual session IPC for ownership, revisions, rollback and DTO privacy. `src/main/services/accountConfigService.credentialIdentity.test.ts` exercises account sync with randomized encryption. These fixtures do not establish access to a live Claude Managed account.

Recovery revalidates every saved checkpoint against session status and complete baseline history before sending. A local `inflight`, `uncertain`, or `budget` marker is not a permanent lock. Text arriving after Stop is excluded from both content and parts.
