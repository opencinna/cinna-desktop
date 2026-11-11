# Pinned Files

## Purpose
Keep a few files of a folder agent one click away in every chat with that agent: a plan, a report, a config the user keeps coming back to, without scrolling to the message that named it.

## Core Concepts
- **Pin** — a file the active profile marked for one folder agent. It belongs to the (profile, agent), not to a chat, so it shows in every chat with that agent and in none with another. Files only, never folders.
- **Inside pin** — a file in the agent's folder. Stored relative to the folder, so it survives the folder being moved or renamed; listed against the folder's current location.
- **Outside pin** — a file elsewhere. Stored as an absolute path; moving the file loses it (it then reads as missing).
- **Pinned files block** — the header "Pinned files" with the pin and the count, and every pinned file beneath it. Always open: one click to any file, never two.
- **Reserve** — the room the transcript keeps for the block where the chat's right margin cannot hold it: a right-hand column, or a band above the transcript.
- **Missing pin** — a pin whose path no longer holds a file. It is kept, never dropped silently.

## User Stories / Flows
1. In a folder agent's chat the user right-clicks a file reference (or file link) and picks **Pin file**. The block appears with the file. The same item reads **Unpin file** for a pinned file.
2. In the file preview of a folder agent's file, the **⋯** menu has **Pin file** / **Unpin file** as its first item, above a separator.
3. A click on a row opens the file in the preview, as a click on a reference in the transcript does (an outside file asks for consent as usual).
4. A right-click on a row opens the transcript's own file-reference menu, with **Unpin file** first.
5. Dragging a row onto another reorders the list; a line shows where it will land. New pins go to the bottom.
6. Narrowing the window moves the transcript's column left to keep clear of the block, and on a narrow chat area puts the block above the transcript; the reader's place in the transcript stays where it was.
7. A file deleted by an agent turn shows dimmed with a warning mark; its menu offers only **Unpin file** and **Copy full path**.

## Business Rules
- **Only the chat's root agent's pins show.** In a coordinator's chat, files of the agents it routes to are not listed, and a pin made from one of their references goes to that routed agent, not to the coordinator. The list says what the chat is about; a routed agent's pins would be a second, unexplained list.
- **Folder agents only** (`capabilities.cwd`). Remote and command-line agents have no files main can check, so no item is offered and no list is asked for. Main checks again; the renderer's idea is never trusted.
- **The block never covers a message; the transcript makes room for it.** Three placements, by the chat area's width:
  - *Gutter* — where the room right of the transcript's message column holds the block and its margins (224 px block, 20 px to the window side, 12 px from the column), it floats there and nothing reflows.
  - *Beside* — where it does not, and the chat area is at least 640 px wide, the transcript keeps a right-hand column for it: the column's right edge stays 12 px clear of the block. The composer keeps its own layout.
  - *Above* — a chat area under 640 px puts the block full width in its own band above the transcript, which starts below it.
- **The reserve exists only while the block shows** (at least one pin, a folder root agent, the main chat view). Messages reflow when the first pin comes, the last one goes, or the window crosses a width, never otherwise, and the reader's place is kept across the reflow (at the bottom, the view stays at the bottom).
- **Where it does not show.** With no pins, in [Minimal view](../minimal_view/minimal_view.md), on the new-chat screen, on an agent page's chat or in a dashboard panel's chat. It sits below the top bar's drag strip, and is `no-drag`: a block under the strip would drag the window instead of taking the click.
- **The toggle sends the user's intent, never the stored state.** A file can be spelled differently from the stored pin (a symlinked agent folder). A toggle that read the stored state would undo the pin Pin file meant to make. Pin and Unpin are idempotent.
- **Unpin needs no file.** A pin whose file is gone can always be removed. Pinning refuses a folder ("Only files can be pinned, not folders.") and a file that is not there.
- **The list only stats.** It never reads a file and never touches a macOS-guarded folder (a pin there reads as present), because a chat opened by nobody's click on that folder must not raise a privacy prompt. Opening a pin goes through the ordinary consent and read path.
- **The list is fresh where it matters.** It refreshes when the preview finds a file gone (`not_found`), and when a turn ends (the usual way a file vanishes), so a missing file is marked soon after it vanishes. It does not refetch on window focus (the app's query client turns that off), so a file deleted outside a turn shows as missing at the next of those events.
- **Changes are optimistic, and a refusal undoes them.** The row appears or goes at once; if main refuses, the list returns to what it was and the reason is said (in the menu, or in the preview's error row). A failed drag says "Could not move the file there." beneath the list. Nothing closes because of an error.
- **A missing pin is not dropped.** A file that returns (a rebuilt report) is pinned again with no action, and an agent that rewrites a file by delete-and-create does not lose it.
- **Pins follow the agent's identity.** A re-keyed folder agent keeps its pins; deleting the agent removes them in every profile; deleting a profile removes its pins. A remote row that sync drops and recreates under the same id is not a delete, so its pins stay.
- **Ranks are fractional.** A drag writes a value between the new neighbours, so one move writes one row. When no value fits between two neighbours the drop is refused rather than renumbering the list.

## Architecture Overview

```
Pin file (transcript menu / preview ⋯ / block row menu)
  → togglePinnedFile (mutation in the client's own cache; survives the menu unmounting)
    → agent-files:pins-set → agentPinnedFileService.set
       → locate agent folder from the index row → realpath → stat (file?) → inside? relative : absolute
       → agentPinnedFileRepo.add/remove (agent_pinned_files)

Chat open
  ChatWorkspace (main view only, root agent has capabilities.cwd)
    → PinnedFilesCard → usePinnedFiles → agent-files:pins-list → stat each (guarded paths skipped)
        chat area width → gutter (float) | beside (reserve 'right') | above (reserve 'top')
          → onReserveChange → ChatWorkspace → MessageStream reserve (scroller padding, anchor kept)
    row click → useFilePreviewStore.openAgentFile ; row right-click → file-reference menu ; drag → agent-files:pins-move
```

Technical detail: [Pinned Files — Technical Details](pinned_files_tech.md).

## Integration Points
- [File References](../file_references/file_references.md): the transcript right-click menu gains **Pin file** as its first group; rows reuse the same menu and the same reference shape.
- [File Preview](../file_preview/file_preview.md): the **⋯** menu's first item; a `not_found` there refreshes the list.
- [Run Commands](../run_commands/run_commands.md): the Run Script window's script preview resolves the script path to the canonical one through main first, so its Pin file matches the path the block stores. If main finds nothing, the joined path is kept and the preview says so.
- [Minimal View](../minimal_view/minimal_view.md): hides the block, and with it the reserve.
- [Local Agents](../../agents/local_agents/home_access.md): the guarded-location rule the list obeys.

## Deliberately not done
- No pins for folders, for remote agents, or per chat.
- No sync between profiles or machines; pins are local to the profile.
- No automatic unpinning of missing files.
