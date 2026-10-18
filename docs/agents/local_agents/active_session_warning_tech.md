# The Active-Session Warning: Technical Details

Behaviour and rules: [The Active-Session Warning](active_session_warning.md).

## File Locations

| Layer | Files |
|---|---|
| Shared | `src/shared/agentSessions.ts` — `AgentActiveSession` (`agentId`, `chatId`, `title`, `startedAt?`), `AgentActiveSessionsResult`, `AGENT_SESSIONS_CHANGED_CHANNEL` (`agentSessions:changed`) |
| Service (Hub core) | `src/main/services/activeAgentSessions.ts` — `activeAgentSessions(profileUserId)`, `liveAgentIds(profileUserId)`; `src/main/services/taskRunnerState.ts` — `onTaskRunnerWorkingChanged` |
| IPC | `src/main/ipc/agent_sessions.ipc.ts` — `agentSessions:active`, registered in `src/main/ipc/index.ts` |
| Preload | `src/preload/index.ts` — `window.api.agentSessions.active()` / `.onChanged(handler)` (returns an unsubscribe) |
| Renderer | `src/renderer/src/hooks/useAgentSessions.ts` (`useAgentActiveSessions`, `AGENT_SESSIONS_KEY`); `src/renderer/src/components/agents/AgentActiveSessionNotice.tsx`; `useActiveSessionNotices` in `components/chat/ComposerReadiness.tsx`; mounted by `ChatInput.tsx`, `tasks/TaskView.tsx` (`TaskSessionNotice`) and `agents/local/AgentTasksTab.tsx` |

## IPC

- `agentSessions:active` → `{ok: true, sessions}` (newest first), or `{ok: false, code: 'not_activated'}` before a profile is active. Returned as data, because a thrown `DomainError.code` does not survive the bridge; the hook reads a failure as an empty list.
- `agentSessions:changed` (push) — sent through `publishEvent` on every `onRunOpened` / `onRunClosed` and whenever a task runner starts or stops *working* in a chat. Carries the chat id; the renderer only re-reads.

## Services & Key Methods

- `heldChats` — the union of `activeRunsByChat` keys and `taskRunnersByChat` entries with `working` true. The agent is the run's own once it resolved, else the chat's bound one. `liveAgentIds` is this list's agent ids; the dispatcher uses it for boot recovery's "no live turn" check.
- `activeAgentSessions` — drops chats the profile cannot see (`visibleChat`), deleted chats and turns with no agent; the title is trimmed and the default `New Chat` becomes null. `startedAt` comes from an in-memory map filled on `onRunOpened`, so a runner-only chat has none and sorts last.
- `taskRunnersByChat` is a `Map` subclass whose `set`, `delete` and `clear` call the registered listeners when a chat's `working` flag flips. Writers keep using plain map calls; an idle reservation coming and going is not news.

## Renderer Components

- `useAgentActiveSessions({enabled})` — one `useQuery` with `staleTime: 0`, `refetchOnWindowFocus` and `retry: 1`, no poll. While mounted and enabled it invalidates on `agentSessions:changed`, `taskDispatch:changed` and `chat.onTitleUpdated`. `staleTime: 0` because pushes reach only mounted readers; a run that started while no surface was showing would be missed otherwise.
- `AgentActiveSessionNotice` — props `agents`, `scale` (`chrome` for the task page, `settings` for the Tasks tab), `advice` (`conflict`, or `run-next` on the Tasks tab), `excludeChatIds`, `live`, `snapshotKey`. `runningSessionsOf` and `activeSessionSentence` are shared with the composer. `useShownSessions` keeps the snapshot (derived-state pattern) and replaces it when the key changes, or once, when the first read after mount lands.
- `useActiveSessionNotices(agents)` — returns `ComposerNotice` rows (`active-session:<agentId>`, warning tone, `Open` as a `NoticeButton` with `aria-describedby` on the sentence). `ChatInput` passes the picked agents only while `chatId === null`; with none, nothing is read.
- The task page's notice takes `selected` from the Continue-with picker, not the assignee, because Continue starts that agent; Start through a queue uses the assignee. Both keep `snapshotKey = task.id`.
