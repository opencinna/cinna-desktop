# Run Commands from a Message

## Purpose

An agent's reply often contains a command to run: `uv run scripts/check_credentials.py --live`. Clicking it opens a **Run Script window** with the command in an editable line, ready to run in the agent's folder. Right-clicking it offers **Run**, **Run in background** and **Edit and Run…** for the same. The output streams in the window, and the user can hand it back to the agent as an attachment.

## Core Concepts

- **Command** — code in an assistant message that looks like a shell command: an inline code span or a fenced block. Recognised by `detectCommand` (`src/shared/commandRun.ts`)
- **Clickable command** — in a persisted, settled reply of an agent that can run commands, such a span or block wears the file reference's box with an edge of its own colour (`--color-command-ref-edge`, green) and opens the window on click. Clicking runs nothing
- **Run Script window** — a modal card like the [file preview](../file_preview/file_preview.md): it grows from the click, has a read-only terminal for its body and the command line at its foot. One exists at a time, app-wide
- **Run** (menu) — starts the command now, unreviewed, and opens the window on the run
- **Run in background** (menu) — starts the same process and leaves the window closed. The run is in the **Commands** badge under the composer
- **Edit and Run…** (menu) — opens the window on the command without running it. Pressing Run in the window is the consent, so a window run is always reviewed
- **Collapse / Close** — both hide the window and neither stops the run. Collapse shrinks the card into the Commands badge; Close fades it
- **The own-command rule** — what "looks safe" means: one simple command that is the agent's own script, or a read-only basic (`ls cat head tail wc file stat grep rg find pwd`) on paths inside its folder. It is the rule Antigravity's auto-approval uses ([Antigravity](../../agents/local_agents/antigravity_engine.md)), kept in one place so the two cannot drift
- **Command run** — a session-activity item of kind `command` ([Session Activity](../../agents/session_activity/session_activity.md)), with a log file in app data
- **Workspace root** — the agent's folder: where the command runs and what the rule checks against

## User Stories / Flows

### Running a suggested command
1. The agent replies with `uv run scripts/load_time_keys.py --apply` in a code span or block
2. The user clicks it. The Run Script window opens from the click, the command in its line and a dimmed hint ("Press Run (⌘↩) to start.") in the terminal. Nothing has run
3. Enter (a one-line command) or Run starts it. The output streams in; the Run button becomes **Stop** in the same slot
4. When it ends, the button reads **Run again**. The command line is editable again, and a second run clears the terminal under a dimmed `── run 2 ──` line, so a rerun never clears silently
5. Collapse or Close hides the window; the command keeps running. **Open output** on its row in the Commands badge popover reopens the window on that run (and closes the popover behind it, or Escape would close the popover first)

Right-click offers the same by menu: **Run** starts a command that looks safe at once and opens the window on the run, **Run in background** starts it with no window, and **Edit and Run…** opens the window unrun. Keyboard: a focused command opens on Enter or Space, growing from the window's centre since a key has no click point.

### A command that does not look safe
1. The reply holds `rm -rf build`, or `git status`, or a pipe
2. Clicking it, or choosing **Edit and Run…** (the only item the menu offers for it), opens the window with one guard sentence above the command line saying why
3. Run and Run in background are in the window. An edited command is not classified again: running it from the window is the consent

### Run turns out not to be allowed
1. The menu offered Run (the command looked like the agent's own script), but the script is missing, outside the folder, protected, or an option is not in the rule's table
2. Main answers `needs_review` with the rule's own sentence ("scripts/x.py was not found in the agent's folder.")
3. The window opens on the command with that sentence as its guard line. Never a dead end. If another window opened meanwhile, the menu shows the sentence instead and the other window is left alone

### The command line
1. Enter runs a one-line command; in a multi-line block Enter is a new line. Shift+Enter or Alt+Enter is always a new line
2. ⌘↩ (Ctrl+Enter) always runs; ⇧⌘↩ runs in the background
3. A held key's repeats run nothing, so the press that opened the window cannot run it; nor does an Enter that commits an IME composition
4. On a one-line command, ↑ and ↓ walk the chat's earlier commands (most recent first, each once) and back to what was typed
5. It is read-only while a run is going and while a start is in flight. It edits the command; it is not the run's stdin, which stays closed

### Giving the output to the agent
1. When a run has ended, its row in the Commands popover, and the window's ⋯ menu, offer **Add output to message**
2. The output is attached to the composer as a text file (`output-<script>.txt`, e.g. `output-check.txt`; `output-<first word>.txt` otherwise) through the path a dropped file takes
3. The agent sees the run only when the user sends that attachment

### Stopping and removing
1. A running row and the window's Stop slot have **Stop**; the row ends as *Stopped*
2. An ended row has **Remove**, which deletes the run and its log

## Business Rules

### What counts as a command
- Inline code: its first word is a known command name (`uv`, `python`, `npm`, `git`, `rm`, `ls`, …) **and** it has at least two words, or it starts with `./`. So `uv run x.py` and `./run.sh` count; `git` alone and a tool name such as `tasks_report` do not
- Fenced block with a shell language (`bash sh zsh shell`): its non-blank, non-`#` lines. In `console`, only the lines starting `$ ` or `% `, prompt stripped (the rest is sample output). With no language, only when every line passes the inline rule. Any other language is never a command
- **A leading prompt is not part of the command**: one `$ `, `% ` or `!` is stripped (Claude suggests `! <command>` when it wants the user to run something in the user's own terminal). What is stripped is what runs, what the window shows and what the rule checks. A `!` elsewhere is left alone
- Code that is a [file reference](../file_references/file_references.md) keeps the file menu and its preview; commands are looked for only when no reference was found. Code inside a link or inside a fenced block is not looked at as a span. A text selection is never a command
- Only **assistant** messages that are persisted (not streaming) and whose agent can run commands
- **Clicks that do not open it**: ending a text selection inside the command, and the second click of a double-click (the first already opened the window). A command is therefore still selectable and copyable

### Which agents
- **Local agents with a folder only**: a folder agent, a kit or bare folder agent, and the local-development build session's workspace. Remote, cinna-core, chat-runtime, websocket and custom-launcher agents get no items. The renderer decides from its cached agents (when the transcript renders, and again at menu open); main decides again and answers `not_local`
- In a multi-agent chat the agent is the message's own (`sourceAgentId`), else the chat's

### The safety guard: two levels, and not a security boundary
- **Level 1, in the renderer, synchronous, no disk**: `looksAutoRunnable` is the disk-free half of the rule. It must parse as one simple command (no `&&`, `|`, `;`, redirection, `$`, glob, `~`, backtick), and be either an own-script form with a relative path containing no `..`, or a read-only basic whose options are in its exact table. Pass: the menu offers Run, Run in background and Edit and Run…, and the window opens with no guard line. Fail: the menu offers Edit and Run… alone, and the window opens with a guard line
- **Level 2, at run, in main, authoritative**: the full rule with the agent's real folder and pinned skill folders. Real paths, so a symlink out of the folder is outside it; `credentials/`, `.cinna/`, `.git/` and secret-looking files are protected; a recursive search may not start at the folder itself. A refusal is `needs_review`
- Run and Run in background (menu) are therefore only the commands Antigravity would run without asking. **This is a convenience filter, not a security boundary.** The script it runs is any regular file in the folder, including one the agent just wrote, and the window runs anything the user typed or confirmed, with the user's rights. Nothing here is sandboxed
- The rule is shared. Changing `ownCommandPolicy.ts` or `commandRun.ts` changes Antigravity's auto-approval **and** this feature, on purpose

### The guard sentence
The window says **why** it is holding a command, not only that it is, so the user knows what to check. The sentence is fixed when the window opens (`commandReviewReason`, from `autoRunRefusal`), never recomputed while the user edits, so nothing appears or disappears as they type:
- **Several commands** (a second line, `;`, `|`, `&&` or a trailing `&`, outside quotes): "Several commands — check each before you run them."
- **Anything else** the rule does not know to be read-only: "This command isn't known to be read-only — check it before you run it."
- **Main's own sentence** when a menu Run was refused at level 2 (a missing script, a path outside the folder, …)
- The generic `needs_review` sentence ("This command can change or delete files, so it runs after you check it.") remains only as the fallback reason for that code

### Where it runs, and with what
- **Folder**: the agent's workspace root, resolved where a turn's folder view is built (`agentWorkspaceFolder`), not the ACP session cwd (Antigravity's is `<folder>/.cinna/antigravity`). A folder that no longer exists is refused as `folder_missing`, and so is a folder agent that has dropped out of the rescanned list because its folder moved: it was on this computer, so "not local" would be the wrong thing to say
- **Process**: `$SHELL -c <command>` (fallback `/bin/zsh`), stdin closed, stdout and stderr over pipes, **no PTY**, in its own process group. A command that prompts gets end-of-input and fails. Run and Run in background are the same non-interactive process; only whether the window opens differs
- **Environment**: what a terminal in that folder would see: the login shell's environment, narrowed as every child's is, plus colour hints (`FORCE_COLOR`, `CLICOLOR_FORCE`, `TERM=xterm-256color`), `COLUMNS` and `PYTHONUNBUFFERED=1`. **No agent credentials and no `.env` are injected**; an agent's script reads its own
- **`COLUMNS` is the window's width**, in terminal columns, so a tool that wraps or draws a table fits what the user sees. A window run sends the measured terminal width; a menu Run, before any window has measured, sends an estimate from the card's width. Main clamps it to 40–400 and uses 120 when none is sent
- **`PYTHONUNBUFFERED=1` exists because the output is a pipe, not a PTY**: Python block-buffers a pipe, so a script's progress arrived all at once when it ended, which defeats a live terminal
- **Output**: stdout and stderr interleave into one log, `<userData>/command-runs/<chatId>/<itemId>.log`, capped at 20 MB. At the cap a final `[output truncated]` line is written and later output is dropped; the process keeps running. The window replays the last 2 MB and says when earlier output is not shown. An attachment carries the last 200 KB, ANSI stripped, under a header (`$ <command>`, folder, exit code or Stopped, duration)
- **Exit**: 0 is *Completed* (the run list, the badge and the window's state all say Completed); a non-zero code or a signal is *Failed* with `Exit code N · <folder>` or the signal as its summary (the window's state reads `Exit N` or the signal); a spawn error is *Failed* with the error. A Stop requested before the process closes wins whatever the exit (a server exits 0 on SIGTERM)

### Lifetime
- **Runs die with the app.** The whole `command-runs/` folder is deleted at startup, and quitting signals every running group (SIGTERM, SIGKILL after two seconds). The activity hub is memory-only, so nothing could show them after a restart
- **Stop**: SIGTERM to the group, SIGKILL after five seconds. Closing or collapsing the window never stops anything: Stop is the only way, besides quit and chat removal. A run that ends on its own leaves what it started in the background running, as a terminal would; Stop and quit reach the whole group
- **Chat trashed or deleted**: its runs are killed and its logs deleted. A run that was still starting when the chat went away is killed before anyone sees it
- A run's log is deleted when its row leaves the hub (Remove, the newest-five cap, the chat clearing)

### The window keeps its shape
- **Fixed size.** The card is 70% of the viewport tall, with a fixed header, body and footer. The command line's rows (one, up to six; more scrolls) are counted once at open, including the soft wraps of a long line, so nothing resizes while the user types
- **A refusal or guard line takes its row from the terminal**, never from the command line: nothing under the user's cursor moves
- **Run, Run again and Stop share one slot of one width**, and Run in background is hidden (kept in layout) while a run is going, so a press that swaps them moves nothing. The state and time in the header are a fixed place rewritten in place
- **Stop is guarded against a double-click on Run.** For 400 ms after Stop takes Run's place a pointer press on it is ignored: the second press of a double-click on Run would otherwise stop the run it just started. The keyboard is not held back, and a window opened on an already-running run shows Stop unguarded
- **Escape and a press outside close it** (after a 500 ms guard against the second press of the opening double-click), unless the ⋯ menu or a file preview opened from it is up; those take the key or press first
- **A window run closes nothing on failure**: a refusal or spawn error is a line above the command line, inside the window
- **A window closes on its own** when its run is removed from the Commands badge, when the active profile changes (even with a start in flight), and, for Run in background, when the background run has started

### The ⋯ menu
Open script, Preview source (the [file preview](../file_preview/file_preview.md) opens over the window), Open folder, Copy command, and Add output to message once ended. The first two apply only when the command names a script inside the agent's folder (a relative path with no `..`).

### A window opened on a run it did not start
The badge's **Open output** can open a run this renderer has no record of (after a reload). The window then has no source message, and names a recent reply of the run's agent when the user runs again. If there is none, the start says "The message this command came from is no longer in the chat." instead of running.

### Refusals are data
`userCommands:run` returns `{ ok: false, code, reason }`, never a thrown error, because a thrown error's code does not reach the renderer. Codes: `needs_review` (opens the window with the reason), `not_local`, `folder_missing`, `chat_not_found`, `spawn_failed`. A refusal from the window shows inside it and closes nothing; from the menu it shows in the menu.

### What it deliberately does not do
- No automatic follow-up turn: the agent learns of a run only from an attached output
- No interactive input, no PTY (the terminal is a viewer, not a shell), no running of a text selection
- No confirmation for Run and Run in background in the menu; clicking a command runs nothing at all
- No remote or cinna-core agents
- No notification when a background run ends; the badge is the signal

## Architecture Overview

```
click a command ──────────────► Run Script window (nothing running) ─► Run ─► userCommands:run {reviewed:true}
right-click ─► detectCommand + looksAutoRunnable (renderer) ─► menu items
  Run / Run in background ─► userCommands:run {reviewed:false} ─► window on the run / badge only
  Edit and Run… ─► Run Script window
        │
        ▼ main: chat, message and agent checks ─► agentCommandWorkspace
        │         ─► ownCommandRefusal (unless reviewed) ─► spawn $SHELL -c in the folder
        ▼
 log file ─► MessagePort (userCommands:output) ─► xterm in the window
 session activity item (kind: command) ─► Commands badge ─► Stop / Open output (window) / Add output / Remove
```

## Integration Points

- [Session Activity](../../agents/session_activity/session_activity.md) — the `command` kind, the Commands badge, and the places that must not treat a command as the agent's work
- [Conversation UI](../conversation_ui/conversation_ui.md) — the message context menu and its last group
- [File References](../file_references/file_references.md) — code that is a reference keeps its own menu; a command shares the reference's box with its own edge colour
- [File Preview](../file_preview/file_preview.md) — the window is a sibling modal and shares its entrance and exit motion; Preview source opens a file preview over it
- [Antigravity](../../agents/local_agents/antigravity_engine.md) — shares the own-command rule
- [File Attachments](../file_attachments/file_attachments.md) — the output joins the composer as any dropped text file
- [UX Rules](../../development/ui_guidelines/ux_rules.md) — the window keeps a fixed size while the user types or a run streams
- Technical details: [Run Commands (tech)](run_commands_tech.md)
