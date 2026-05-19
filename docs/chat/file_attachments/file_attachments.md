# File Attachments

## Purpose

Lets a Cinna user attach local files to messages sent to a Cinna remote agent. Files are uploaded to the user's Cinna backend, referenced on the A2A wire via message metadata, and shown as compact badges in the composer (before sending) and under user-message bubbles (after sending). Clicking a sent badge triggers a save-as flow back to the local disk.

## Core Concepts

- **Attachment** — A file uploaded to the user's Cinna backend and attached to a single user turn. Tracked in-app via `MessageAttachment` (id, filename, size, mimeType)
- **Pending Attachment** — An uploaded file waiting in the composer to be sent. Removable via the `[x]` button; cleared if the user switches to a non-Cinna target or sends successfully
- **Attach Menu** — Small popup anchored to the `[+]` button. Currently exposes one entry ("Add files" / paperclip); designed to grow ("Clipboard", "Browse workspace", etc.)
- **Remote Agent** — Required destination type. Files only flow to A2A targets sourced from the Cinna backend (`agent.source === 'remote'`). Local agents and raw LLM modes have nowhere to receive files
- **`cinna_file_ids` Metadata** — A2A message metadata key carrying the list of uploaded file ids. The Cinna backend reads this and transfers the actual file contents into the agent environment's `./uploads/` before the agent receives the message

## User Stories / Flows

### Attaching a file in an active chat
1. User is in a chat bound to a Cinna remote agent (or with a remote agent active for multi-agent routing)
2. `[+]` button appears to the left of Send. User clicks it
3. Attach menu opens above the button. User picks "Add files"
4. Native OS file picker opens; user selects one or more files
5. Each file streams to the Cinna backend (`POST /api/v1/files/upload`). Successful uploads appear as badges inside the rounded input container, bottom-right
6. User can remove a pending badge with `[x]` before sending; soft-delete fires against the backend
7. User types their message (optional — attachment-only sends are allowed in active chats) and hits Send
8. User message persists with `attachments[]` on the row; A2A request carries `metadata.cinna_file_ids`
9. After send, badges clear from the composer

### Attaching a file on the new-chat screen
1. User is on the new-chat screen as a Cinna user — `[+]` is visible regardless of agent selection (uploads are user-scoped on the backend, not chat-scoped)
2. User picks files via the menu; badges appear in the composer
3. User types their first message and either selects a Cinna remote agent or has one preselected
4. On send, the chat is created, bound to the agent, and the first user turn carries the attachments
5. If the user has picked a non-remote destination (local agent, LLM-only chat mode), send is blocked with an inline error — attachments stay so the user can re-route or remove them

### Viewing attachments in history
1. User scrolls back through a chat. Every user message that originally shipped files renders its attachment badges right-aligned under the bubble
2. Badges show a file-type icon, truncated filename, and size

### Downloading a previously-sent attachment
1. User clicks a badge under a sent message bubble
2. Native save dialog opens with the original filename as the default, anchored to the user's Downloads folder
3. On confirm, the file streams from the Cinna backend to the chosen path
4. The OS file manager reveals the saved file (Finder on macOS, Explorer on Windows)
5. On failure, a dismissible error label appears under that bubble's badge row

## Business Rules

### Destination gating
- The `[+]` button is rendered when (the user is a Cinna user) AND (active chat with a remote target OR the new-chat screen)
- Pending attachments are dropped automatically if the next-message target stops being a remote agent (e.g., user switches active agent to a local one)
- Send-time guard on the new-chat path: if attachments are pending but the chosen destination isn't a remote agent, send is blocked with an inline message rather than silently dropping files
- Local-agent chats and pure LLM-mode chats never see the `[+]` button

### Upload
- Each file uploads sequentially through `cinnaFileService.uploadMany`
- A single failure aborts the loop; already-uploaded ids are surfaced in the thrown error's `detail` field (JSON-encoded) so callers can decide on cleanup. Today the desktop leaves them for the backend's 24h GC
- MIME type is sent as a best-effort guess based on file extension; the backend's whitelist makes the final call
- File size cap is enforced server-side (100MB by default — see Cinna backend config)

### Wire format
- A2A `message.metadata.cinna_file_ids` carries the list of file UUIDs
- No file bytes go over the A2A channel; only references
- Local agents (non-Cinna A2A) silently ignore the metadata key — forward-compatible

### Persistence
- The `attachments` JSON column on the `messages` table stores the condensed `MessageAttachment[]` per user row
- Assistant turns never carry attachments — the column is null on those
- Re-rendering history (chat reload, app restart) pulls the same column, so badges survive everywhere the message survives

### Download
- Download is per-attachment: clicking a badge fires one save-as flow at a time per file id
- Multiple concurrent downloads are allowed across different badges (different ids); the same file id can't be double-clicked into two parallel saves
- Failures are surfaced under the bubble that owns the failed attachment, scoped by `errorFileId` so unrelated bubbles stay clean
- The file is revealed in the OS file manager after a successful save, not auto-opened — security-conscious default

### Staleness on chat switch
- The composer's pending list is scoped to a chat. Switching chats while an upload is in flight drops the resolving file (the bytes still reach the backend; the desktop just refuses to attach them to the new chat). Handled via a generation counter inside `useChatAttachments`

## Architecture Overview

```
[+] button (ChatInput) -> AttachMenuPopup -> "Add files"
  -> useChatAttachments.pick()
    -> window.api.files.pickAndUpload()
      -> files:pick-and-upload IPC
        -> dialog.showOpenDialog (native picker)
        -> cinnaFileService.uploadMany(userId, paths)
          -> for each path: net.fetch POST /api/v1/files/upload
          -> returns MessageAttachment[]

Send (ChatInput) -> useChatComposer.submit(text, attachments)
  -> useChatStream.startAgent(agentId, chatId, content, { attachments })
    -> window.api.agents.sendMessage (AgentSendPayload includes attachments)
      -> agent:send-message IPC (MessagePort)
        -> messageRoutingService.prepareAgentSend({ attachments })
          -> messageRepo.saveUser({ attachments })
        -> a2aStreamingService.streamToAgent({ fileIds })
          -> buildSendParams(..., { cinna_file_ids: [...] })
          -> A2A sendMessageStream / sendMessage

Click badge (MessageBubble) -> useFileDownload.download(attachment)
  -> useFileDownloadStore.download()
    -> window.api.files.download({ fileId, filename })
      -> files:download IPC
        -> dialog.showSaveDialog
        -> cinnaFileService.downloadToPath (stream pipeline)
        -> shell.showItemInFolder(savedPath)
```

## Integration Points

- [Messaging](../messaging/messaging.md) — Attachments piggy-back on the existing user-message persistence and A2A send path; `messageRoutingService.prepareAgentSend` is the single chokepoint for both attachment-bearing and plain user turns
- [Agents](../../agents/agents/agents.md) — A2A streaming + endpoint resolution. Attachments require `agent.source === 'remote'` (Cinna-managed agents synced from a Cinna server)
- [A2A Streaming Pipeline](../../agents/agents/streaming_pipeline.md) — `buildSendParams` accepts a `metadata` map; `cinna_file_ids` rides on the user message's `metadata` field
- [Cinna Accounts](../../auth/cinna_accounts/cinna_accounts.md) — File uploads use the user's Cinna access token (auto-refreshed on expiry); `not_cinna_user` is a hard error from the file service
- [Multi-Agent Chats](../multi_agent/multi_agent.md) — Attachment-target gate follows the composer's `activeAgent`, so switching agents mid-chat re-evaluates the `[+]` button and any pending uploads

## Backend Dependency

Files reach the agent environment only when the Cinna backend reads `metadata.cinna_file_ids` from the inbound A2A message and forwards them to `SessionService.send_session_message` as `file_ids`. The desktop side is fully wired regardless; agents on backends without this hook receive the message text only.
