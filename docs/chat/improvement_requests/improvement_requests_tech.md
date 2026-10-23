# Improvement Request — Technical Details

## File Locations

### Shared
- `src/shared/improvementRequests.ts` — `ImprovementTarget`, `ImprovementContext`, `ImprovementRequestInput`, `ImprovementOutcome<T>`, refusal codes (`no_target`, `invalid_comment`, `reauth_required`, `no_account`, `refused`, `failed`), `IMPROVEMENT_COMMENT_MAX` (4000).

### Main process
- `src/main/services/improvementRequestService.ts` — `listTargets`, `context`, `create`; `locate()` is the one place that decides which sessions count.
- `src/main/ipc/improvementRequests.ipc.ts` — `registerImprovementRequestHandlers` (registered in `src/main/ipc/index.ts`): activation gate, active profile, delegate.
- `src/main/db/agents.ts` — `agentSessionRepo.listByChat()`: every agent's `a2a_sessions` row in a chat.
- `src/main/services/cinna-http.ts:cinnaSend()` — now accepts `GET`; a 4xx comes back as `{status, body}` data, only a 401 throws.

### Preload
- `src/preload/index.ts` — `window.api.improvementRequests.{targets, context, create}`.

### Renderer
- `src/renderer/src/components/chat/ImprovementRequestDialog.tsx` — the dialog (built on `DialogShell`, `align="top"`, `w-[30rem]`); `improvementConfirmation()` builds the toast sentence.
- `src/renderer/src/hooks/useImprovementRequests.ts` — `useImprovementTargets`, `useCreateImprovementRequest`, `IMPROVEMENT_KEY`.
- `src/renderer/src/components/chat/ChatInput.tsx` — owns the open state (`improvementChatId`), the mutation and the dialog; passes `actions.improvementRequest` to the menu.
- `src/renderer/src/components/chat/ComposerPlusMenu.tsx` — `PlusActions` / `PlusAction`, the `actions` view.
- `src/renderer/src/components/settings/SettingsLayout.tsx` — `useDialogChrome`, see below.

## Database Schema
No new table. Reads `a2a_sessions` (`chatId`, `agentId`, `taskId`, `updatedAt`) and `chat_on_demand_agents` (`chatOnDemandAgentRepo.listAgentIds`); the chat's own `agentId` joins the attached set.

## IPC Channels
- `improvement:targets` `(chatId) -> ImprovementTarget[]` — no network; empty hides the action.
- `improvement:context` `({chatId, agentId}) -> ImprovementOutcome<{context}>` — `GET /api/v1/sessions/{task_id}/improvement-context`.
- `improvement:create` `({chatId, agentId, comment, includeMemory}) -> ImprovementOutcome<{request: {id}}>` — `POST /api/v1/improvement-requests` with `session_id`, `comment`, `include_memory`.

## Services & Key Methods
- `locate(userId, chatId)` — requires `visibleChat`; keeps rows with a `taskId` whose agent is attached or bound, owned by the profile (`agentRepo.getOwned`), and `isBundleAgent` with `capabilitiesFor(agent).auth === 'cinna'`; bound agent sorted first.
- `sessionFor()` — re-resolves `{chatId, agentId}` on every call, so a stale renderer can only name an agent that is still eligible (else `no_target`).
- `toContext()` — maps core's snake_case answer; `REASON_TEXT` turns core's machine reasons into sentences, with a generic fallback.
- `failure()` / `refusal()` — transport errors and core's `{detail}` sentence as data; a lost session calls `broadcastReauthRequired`.

## Renderer behaviour worth knowing
- The send is owned by the composer (`useCreateImprovementRequest`), not the dialog: TanStack runs a hook-level `onSuccess` after the dialog closed, so the toast and the close are never lost. One mutation serves every chat the composer shows, so `ChatInput` treats its state as this chat's only when `variables.input.chatId` matches.
- The context query (`[IMPROVEMENT_KEY, 'context', chatId, agentId]`, `staleTime: 0`, no retry) re-runs on every open and agent change; a successful send invalidates it so the "sent before" count is fresh.
- Targets are invalidated when `isStreaming` goes true → false.

## Dialog chrome and info tips
`useDialogChrome` (shared by every `DialogShell`) ignores Escape while an info tip is open and ignores presses on one. The tip is portaled into `<body>`, outside the modal, so without this Escape closed the whole dialog and a click inside the tip counted as outside. Detected through `INFO_TIP_ATTR` (`data-info-tip`), as in [Run Commands](../run_commands/run_commands_tech.md).

## Configuration
None. Needs a profile linked to a Cinna account; otherwise `no_account`.

## Security
- The renderer never supplies a core session id; main derives it from `{chatId, agentId}` after a profile-scope check.
- Only agents authenticated with the account's own Cinna token qualify, so core can verify ownership.
- Memory is opt-in per request in main, whatever the checkbox's default.
