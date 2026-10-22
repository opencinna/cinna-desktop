# Path Mentions ("Mention in Cinna")

## Purpose

Send a file or folder to Cinna from outside it. Right-click in Finder, choose **Mention in Cinna**, and the new-chat composer opens with the item as a reference chip, on the folder agent it belongs to. The same chip is what **Reference in a new chat** (a transcript's file reference) now produces.

## Core Concepts

- **Path mention**: a file or folder path handed to Cinna by another process. macOS delivers it as an `open-file` event.
- **Reference chip**: a pill in the composer's attachment row (`PathRefBadge`) showing the last segment of the path, a folder or file icon, an X to remove, and the path (`~/…` under the home) as its tooltip. Not clickable.
- **A reference is a path, not an attachment.** Nothing is read, copied or uploaded. The chip becomes a line of the message text, so the agent receives the path and uses its own tools on it. This is why a reference works for a folder, for a file the engine cannot take as an attachment, and for an agent that supports no attachments at all.
- **Finder Quick Action**: the Automator workflow "Mention in Cinna" installed in `~/Library/Services`. It runs `open` with the selected paths and nothing else.
- **Mention buffer**: main's holding area for validated paths until the signed-in renderer takes them.
- **Folder agent match**: the folder agent a mention starts its chat with.

## User Stories / Flows

1. **Install**: Settings → Features → Finder (macOS only; the section does not exist elsewhere) has one switch, **Mention in Cinna**. On installs the workflow into `~/Library/Services` and asks macOS to re-read its Services; off removes it. The item then appears in Finder's right-click menu under Quick Actions or Services.
2. **Mention**: select one or more files and folders in Finder, right-click, **Mention in Cinna**. Cinna comes to the front (launching if it was not running; a window closed earlier is recreated) and shows the new-chat screen with one chip per item.
3. **Agent**: the chat starts with the folder agent whose folder contains the first item; that replaces whatever agents the new-chat draft held. With no such folder agent, the most recently used folder agent is a guess, applied only when the new-chat draft has no agents yet; otherwise, and when there is no folder agent at all, the chat keeps the agent selection the new-chat draft already holds.
4. **Send**: the user types or not, and sends. Each chip becomes a line `Referenced folder: `<absolute path>`` or `Referenced file: ...` after the typed text, a blank line between. The transcript links those backticked paths like any other file reference (see [File References](../file_references/file_references.md)).
5. **Reference in a new chat** (right-click on a file reference in the transcript) puts the same chip, for the reference's realpath, into the new-chat draft with that reference's agent.
6. **Busy elsewhere**: when a dialog is open or the screen is not the chat view (Settings with a half-filled form, say), nothing navigates. The chips go into the new-chat draft, with the agent, and a toast says "<name> added to a new chat" or "N items added to a new chat".
7. **Before sign-in**: login, onboarding, a locked profile. Main keeps the paths; the signed-in shell takes them when it mounts, and again whenever a profile becomes ready.
8. **Update**: if the installed workflow is from an older template or points at a different app location, the Finder section shows "Installed from an older Cinna." with **Update**. A failed install or removal shows a one-sentence reason as its own row below the switch.

## Business Rules

- **Every path is untrusted.** Any process can run `open` with any argument. A path is accepted only if it is a string, absolute, at most 4096 characters, free of NUL and control characters and of the line and paragraph separators U+2028 and U+2029 (a line break would split the line the chip is sent as), and its realpath exists and is a file or folder. The same checks run again on the realpath, which a symlink can make into anything. Refusals are dropped with a debug log, never shown. A mention can do no more than put a chip in a composer the user then chooses to send.
- **Not a URL.** The Quick Action uses `open`, not a `cinna://` link, so a web page has no way to reach this path. The connect deep link is a different funnel (see [Connect](../../auth/onboarding/connect_link.md)).
- **A burst is one selection.** Unlike the connect link, where the latest click replaces the previous one, mentions accumulate: macOS sends one event per selected item. The buffer dedups by realpath, holds at most 20, and announces itself 150 ms after the last arrival, so the renderer takes the whole selection at once instead of the first item.
- **Resolved when taken, not when clicked.** The folder agent depends on the profile; deciding at take time means a profile switch between the Finder click and the take picks the right agent. Folder agents considered are those that are enabled, have a folder, can run in a working directory, and (for a development agent) belong to this profile. Nested agent folders: the deepest wins. A folder agent whose folder is gone is skipped, since a chat started on it would fail at its first turn.
- **Only the first item picks the agent.** A selection spanning two agents' folders goes to the first item's agent; the other chips still name their absolute paths.
- **Chips are unique by path**, across mentions, repeated clicks and Reference in a new chat. The remove button removes by path.
- **A chip alone is sendable.** Send and Enter are enabled with chips and no text; Stop is not shown in place of Send while chips are present. The chips are consumed on send by path, so a mention that arrives while the send is in flight survives it.
- **Titles name the typed text.** The chat's title is derived from the message with its reference lines removed; with no typed text it is the chips' names joined by commas. A title of "Referenced file: <absolute path>" is the failure this prevents. See [Auto Chat Titles](../auto_titles/auto_titles.md).
- **Take is never dropped.** Main clears its buffer when the renderer takes, so a take that finishes after the renderer re-rendered is still applied.
- **The workflow is ours by exact path.** Removal looks at `~/Library/Services/Mention in Cinna.workflow`, refuses if it is not a directory, and deletes only that.
- **Dev builds** install a command that opens the running Electron.app by path, since the bundle id belongs to the packaged app.
- **Not done here**: no `CFBundleDocumentTypes`, so Cinna does not claim to open files (it is not offered in Finder's Open With). No Windows or Linux equivalent; the Features section hides.

## Architecture Overview

```
Finder -> Quick Action (open -b <bundle id> "$@") -> Launch Services
  -> Electron open-file (main, module scope) -> pathMentionIntentService
       validate (realpath, stat) -> buffer + 150 ms settle -> raise window -> 'path-mention:pending'
  -> renderer usePathMentions -> pathMention.take() -> pathMentionService (folder agent match)
  -> startAgentChat / addToNewChat -> composer draft pathRefs -> PathRefBadge
  -> send: withPathRefs -> message text -> transcript file references
```

## Integration Points

- [File References](../file_references/file_references.md): Reference in a new chat adds a chip; sent lines render as file references.
- [Conversation UI](../conversation_ui/conversation_ui.md): the composer's attachment row and draft hold the chips.
- [Auto Chat Titles](../auto_titles/auto_titles.md): the fallback title strips reference lines.
- [Keyboard Shortcuts](../../ui/keyboard_shortcuts/keyboard_shortcuts.md): `startAgentChat` is shared with the chat-starting shortcuts.
- [Settings](../../ui/settings/settings.md): Features → Finder.
- [Bare Mac](../../development/bare_mac/bare_mac.md): install and run inside a fresh VM.
- [Technical Details](path_mentions_tech.md)
