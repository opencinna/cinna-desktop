# Run Commands from a Message

## Purpose

An agent's reply often contains a command to run: `uv run scripts/check_credentials.py --live`. Right-clicking it offers **Run**, **Run in background** and **Edit and Run…**, which run it in the agent's folder, show the output, and let the user hand that output back to the agent as an attachment.

## Core Concepts

- **Command** — code in an assistant message that looks like a shell command: an inline code span or a fenced block. Recognised by `detectCommand` (`src/shared/commandRun.ts`), once, when the menu opens
- **Run** — starts the command now and opens the output panel
- **Run in background** — starts the same process and leaves the panel closed. The run is in the **Commands** badge under the composer
- **Edit and Run…** — the reviewed path: a dialog with the command in an editable field, then Run or Run in background. The two clicks to get there are the consent
- **The own-command rule** — what "looks safe" means: one simple command that is the agent's own script, or a read-only basic (`ls cat head tail wc file stat grep rg find pwd`) on paths inside its folder. It is the rule Antigravity's auto-approval uses ([Antigravity](../../agents/local_agents/antigravity_engine.md)), kept in one place so the two cannot drift
- **Command run** — a session-activity item of kind `command` ([Session Activity](../../agents/session_activity/session_activity.md)), with a log file in app data
- **Workspace root** — the agent's folder: where the command runs and what the rule checks against

## User Stories / Flows

### Running a suggested command
1. The agent replies with `uv run scripts/load_time_keys.py --apply` in a code span or block
2. The user right-clicks it. Below a separator the menu has **Run**, **Run in background** and **Edit and Run…**
3. **Run** starts it and docks the output panel between the transcript and the composer, with the output streaming in. Stop, Close and the state are in its header
4. Close hides the panel; the command keeps running. **Open output** in the Commands badge popover reopens it

### A command that does not look safe
1. The reply holds `rm -rf build`, or `git status`, or a pipe
2. The menu offers **Edit and Run…** only
3. The dialog shows one line explaining why ("This command can change or delete files, so it runs after you check it."), the command in a monospace field, the folder read-only below it, and Cancel / Run in background / Run. ⌘↩ (Ctrl+Enter) runs
4. An edited command is not classified again: running it from the dialog is the consent

### Run turns out not to be allowed
1. The menu offered Run (the command looked like the agent's own script), but the script is missing, outside the folder, protected, or an option is not in the rule's table
2. Main answers `needs_review` with the rule's own sentence ("scripts/x.py was not found in the agent's folder.")
3. The menu closes and the edit dialog opens with that sentence. Never a dead end

### Giving the output to the agent
1. When a run has ended, its row in the Commands popover, and the output panel's header, offer **Add output to message**
2. The output is attached to the composer as a text file (`output-<script>.txt`, e.g. `output-check.txt`; `output-<first word>.txt` otherwise) through the path a dropped file takes
3. The agent sees the run only when the user sends that attachment

### Stopping and removing
1. A running row and the panel header have **Stop**; the row ends as *Stopped*
2. An ended row has **Remove**, which deletes the run and its log

## Business Rules

### What counts as a command
- Inline code: its first word is a known command name (`uv`, `python`, `npm`, `git`, `rm`, `ls`, …) **and** it has at least two words, or it starts with `./`. So `uv run x.py` and `./run.sh` count; `git` alone and a tool name such as `tasks_report` do not
- Fenced block with a shell language (`bash sh zsh shell`): its non-blank, non-`#` lines. In `console`, only the lines starting `$ ` or `% `, prompt stripped (the rest is sample output). With no language, only when every line passes the inline rule. Any other language is never a command
- **A leading prompt is not part of the command**: one `$ `, `% ` or `!` is stripped (Claude suggests `! <command>` when it wants the user to run something in the user's own terminal). What is stripped is what runs, what the dialog shows and what the rule checks. A `!` elsewhere is left alone
- Code that is a [file reference](../file_references/file_references.md) keeps the file menu; commands are looked for only when no reference was found. A text selection is never a command
- Only **assistant** messages that are persisted (not streaming) and whose agent can run commands

### Which agents
- **Local agents with a folder only**: a folder agent, a kit or bare folder agent, and the local-development build session's workspace. Remote, cinna-core, chat-runtime, websocket and custom-launcher agents get no items. The renderer decides from its cached agents at menu open; main decides again and answers `not_local`
- In a multi-agent chat the agent is the message's own (`sourceAgentId`), else the chat's

### The safety guard: two levels, and not a security boundary
- **Level 1, at menu open, in the renderer, synchronous**: `looksAutoRunnable` is the disk-free half of the rule. It must parse as one simple command (no `&&`, `|`, `;`, redirection, `$`, glob, `~`, backtick), and be either an own-script form with a relative path containing no `..`, or a read-only basic whose options are in its exact table. Pass: Run, Run in background and Edit and Run… Fail: Edit and Run… alone
- **Level 2, at run, in main, authoritative**: the full rule with the agent's real folder and pinned skill folders. Real paths, so a symlink out of the folder is outside it; `credentials/`, `.cinna/`, `.git/` and secret-looking files are protected; a recursive search may not start at the folder itself. A refusal is `needs_review`
- Run and Run in background are therefore only the commands Antigravity would run without asking. **This is a convenience filter, not a security boundary.** The script it runs is any regular file in the folder, including one the agent just wrote, and Edit and Run… runs anything the user typed or confirmed, with the user's rights. Nothing here is sandboxed
- The rule is shared. Changing `ownCommandPolicy.ts` or `commandRun.ts` changes Antigravity's auto-approval **and** this feature, on purpose

### Where it runs, and with what
- **Folder**: the agent's workspace root, resolved where a turn's folder view is built (`agentWorkspaceFolder`), not the ACP session cwd (Antigravity's is `<folder>/.cinna/antigravity`). A folder that no longer exists is refused as `folder_missing`
- **Process**: `$SHELL -c <command>` (fallback `/bin/zsh`), stdin closed, stdout and stderr over pipes, **no PTY**, in its own process group. A command that prompts gets end-of-input and fails. Run and Run in background are the same non-interactive process; only the panel differs
- **Environment**: what a terminal in that folder would see: the login shell's environment, narrowed as every child's is, plus colour hints (`FORCE_COLOR`, `CLICOLOR_FORCE`, `TERM=xterm-256color`, `COLUMNS=120`). **No agent credentials and no `.env` are injected**; an agent's script reads its own
- **Output**: stdout and stderr interleave into one log, `<userData>/command-runs/<chatId>/<itemId>.log`, capped at 20 MB. At the cap a final `[output truncated]` line is written and later output is dropped; the process keeps running. The panel replays the last 2 MB and says when earlier output is not shown. An attachment carries the last 200 KB, ANSI stripped, under a header (`$ <command>`, folder, exit code or Stopped, duration)
- **Exit**: 0 is *Completed* (the run list and badge say Completed; the output panel's header shows `Exit 0`); a non-zero code or a signal is *Failed* with `Exit code N · <folder>` or the signal as its summary; a spawn error is *Failed* with the error. A Stop requested before the process closes wins whatever the exit (a server exits 0 on SIGTERM)

### Lifetime
- **Runs die with the app.** The whole `command-runs/` folder is deleted at startup, and quitting signals every running group (SIGTERM, SIGKILL after two seconds). The activity hub is memory-only, so nothing could show them after a restart
- **Stop**: SIGTERM to the group, SIGKILL after five seconds. A run that ends on its own leaves what it started in the background running, as a terminal would; Stop and quit reach the whole group
- **Chat trashed or deleted**: its runs are killed and its logs deleted. A run that was still starting when the chat went away is killed before anyone sees it
- A run's log is deleted when its row leaves the hub (Remove, the newest-five cap, the chat clearing)

### Refusals are data
`userCommands:run` returns `{ ok: false, code, reason }`, never a thrown error, because a thrown error's code does not reach the renderer. Codes: `needs_review` (opens the dialog with the reason), `not_local`, `folder_missing`, `chat_not_found`, `spawn_failed`. A spawn error shows inside the open dialog and closes nothing.

### What it deliberately does not do
- No automatic follow-up turn: the agent learns of a run only from an attached output
- No interactive input, no PTY, no running of a text selection
- No confirmation for Run and Run in background
- No remote or cinna-core agents
- No notification when a background run ends; the badge is the signal

## Architecture Overview

```
right-click code ─► detectCommand + looksAutoRunnable (renderer, at open) ─► menu items
Run / Run in background ─► userCommands:run {reviewed:false}
Edit and Run… ─► dialog ─► userCommands:run {reviewed:true}
        │
        ▼ main: chat, message and agent checks ─► agentCommandWorkspace
        │         ─► ownCommandRefusal (unless reviewed) ─► spawn $SHELL -c in the folder
        ▼
 log file ─► MessagePort (userCommands:output) ─► xterm panel
 session activity item (kind: command) ─► Commands badge ─► Stop / Open output / Add output / Remove
```

## Integration Points

- [Session Activity](../../agents/session_activity/session_activity.md) — the `command` kind, the Commands badge, and the places that must not treat a command as the agent's work
- [Conversation UI](../conversation_ui/conversation_ui.md) — the message context menu and its last group
- [File References](../file_references/file_references.md) — code that is a reference keeps its own menu
- [Antigravity](../../agents/local_agents/antigravity_engine.md) — shares the own-command rule
- [File Attachments](../file_attachments/file_attachments.md) — the output joins the composer as any dropped text file
- [UX Rules](../../development/ui_guidelines/ux_rules.md) — the dialog and the panel keep a fixed size while the user types or a run streams
- Technical details: [Run Commands (tech)](run_commands_tech.md)
