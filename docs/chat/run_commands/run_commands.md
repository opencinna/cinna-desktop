# Run Commands from a Message

## Purpose

An agent's reply often contains a command to run: `uv run scripts/check_credentials.py --live`. Clicking it opens a **Run Script window** with the command in an editable line, ready to run in the agent's folder. Right-clicking it offers **Run**, **Run in background** and **Edit and Run…** for the same. The output streams in the window, and the user can hand it back to the agent as an attachment.

## Core Concepts

- **Command** — code in an assistant message that looks like a shell command: an inline code span or a fenced block. Recognised by `detectCommand` (`src/shared/commandRun.ts`)
- **Clickable command** — in a persisted, settled reply of an agent that can run commands, such a span or block wears the file reference's box with an edge of its own colour (`--color-command-ref-edge`, green) and opens the window on click. Clicking runs nothing
- **Run Script window** — a modal card like the [file preview](../file_preview/file_preview.md): it grows from the click, has a read-only terminal for its body and the command line at its foot. One exists at a time, app-wide
- **Parameters form** — for a script whose parameters can be read from its source, a sidebar of the window with one field per parameter, kept in step with the command line. Absent for every other command
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
4. On a one-line command, ↑ and ↓ walk the chat's earlier commands (most recent first, each once) and back to what was typed. On a command that soft-wraps, ↑ and ↓ first move the caret between its rows, and walk the history only from the first row (↑) or the last (↓): a long command's caret could not otherwise be moved up a row without losing the line
5. It is read-only while a run is going and while a start is in flight. It edits the command; it is not the run's stdin, which stays closed

### Filling a script's parameters
1. The reply holds `uv run scripts/report.py italy --year 2026`, and `report.py` is an argparse script in the agent's folder. Clicking it opens the window with a **Parameters** sidebar beside the terminal, already filled from the command (Scope `italy`, Year `2026`)
2. Before the first run the terminal shows the script's own summary and description, dimmed, in place of "Press Run…"
3. Ticking a switch such as Apply adds `--apply` to the end of the line; typing in Year rewrites only `--year …`; clearing a field removes only its words. The rest of the line, in the user's order and quoting, stays as typed
4. Editing the line by hand updates the form the same way. If the line stops being one simple command that names the script (a pipe, another script, a `$`), the form is **edited by hand**: it shows its last values dimmed and read-only, with a line saying so, and follows the line again as soon as it parses
5. While a run is going or starting the form reads and edits nothing, as the line does not

### Running a script from the file preview
1. The agent named `scripts/report.py` in its reply and the user opened it in the [file preview](../file_preview/file_preview.md). Its header offers **Run…**
2. Pressing it closes the preview and opens the Run Script window on the command main chose (`python3 scripts/report.py`), with the Parameters form when the script has one. Nothing has run; Run in the window is the consent, as for any command
3. A script main will not build a command for (outside the folder, a credential, not a script it knows how to start) leaves the preview open and says so under its header
4. The window is the same as for a clicked command, with one difference: it has no source message, so main knows the agent as the chat's own. The window runs, inspects and opens Choose… in that agent, and a run started from it can be run again after a reload

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
- **Several commands** (a second line, `;`, `|`, `&&` or a trailing `&`, outside quotes): "Several commands — check each before you run them." A `#` comment is not a command (its `;` and a comment-only line separate nothing), nor is a here-document's body (`python3 - <<EOF … EOF`): a one-command line is not called several because of what it quotes. This sharpens the sentence only; whether the menu offers Run is `looksAutoRunnable`'s call, which still refuses such a line
- **Anything else** the rule does not know to be read-only: "This command isn't known to be read-only — check it before you run it."
- **Main's own sentence** when a menu Run was refused at level 2 (a missing script, a path outside the folder, …)
- The generic `needs_review` sentence ("This command can change or delete files, so it runs after you check it.") remains only as the fallback reason for that code

### When a form appears
- **The script is the agent's own and readable**: a regular file inside the agent's folder (by real path, so a symlink out of it is outside), or in a pinned skill folder, that is not protected for a read (credentials, `.cinna/`, `.git/`, secret-looking names), at most 512 KB, and not binary. The command must be one simple command naming it (`[interpreter] script …`, `uv run script.py …`, `./script.sh …`, env assignments first are fine)
- **The parameters come from the source, never from running it.** Running a script to ask `--help` would execute the agent's code before the user pressed Run
- **Which scripts**: the ones that say their parameters in a form the reader knows. The agent kit's scripts guide asks for exactly that: a docstring `Usage:` line, `help=` on every argparse argument and literal option names, so the window can show the options without running anything. A script that does not follow it gets no form, or a thinner one
- **Python, argparse**: calls to `add_argument` on the script's **one** `ArgumentParser`, or on the parser a `build_parser()`-style factory returns (a function whose body returns the parser, called as `parser = build_parser()` or `build_parser().parse_args()`). Its argument groups count. A **Usage** line in the module docstring fills what argparse did not say; option lines in the docstring (`  --basis month   per month`) supply help text for a flag already known
- **Python, click**: the `@click.option` / `@click.argument` stack on the script's **one** `@click.command`, with the command actually called. Groups, a second command, params built by hand and prompts as options give no form
- **Python, typer**: the signature of the script's **one** command, either `typer.run(main)` or a single `@app.command()` on an app that is called, with `typer.Option` / `typer.Argument` as defaults or in `Annotated`. `typer.Context` parameters are not shown. Enums, `Literal`, string annotations, `@app.callback`, `add_typer` and a shared `typer.Option` give no form
- **At most one framework speaks.** A script using argparse and click, or click and typer, together gets no form: which parser is the real one is not something the source states
- **Shell, getopts**: a `while getopts "<literal optstring>" var` loop and the `case` that handles it give the option letters; the leading `# Usage:` block names and explains them. getopts decides the flag set, so a Usage option getopts does not know (or that disagrees on whether it takes a value) means no form: the script reads it somewhere the reader does not look. A letter the Usage block does not name is still shown, labelled by the variable its arm sets. A letter whose arm exits (`-h`, `-V`) is left out, as argparse's help is. Positionals come from the Usage block only
- **getopts stops at the first operand**, so the form writes options before positionals and reads every word after the first operand as an operand. A script that reads an operand (`$1`, `shift`, `$@`) at the top level before its `while getopts` loop, or whose Usage line puts a positional before an option, gets no form: the line's order would not be the order the script reads
- **Shell without getopts**: a leading `# Usage:` comment block is the only source
- **Fails closed.** Subparsers, a second parser, `parents=`, a parser that is not assigned to a name, an `add_argument` on anything else, a parser name rebound to something else, `**kwargs` in a call, a custom action, a flag that is not a string literal, an unterminated string, more than 200 calls, or literals nested deeper than 8 give **no form** (so do the click, typer and getopts refusals above). A form that omitted or misread a parameter would be worse than none, and the window is then the plain one
- **Anything surprising is quiet**: an unreadable or oversized file, a refusal, an error, or an answer slower than 150 ms leaves the window without a form and says nothing

### What the form shows
- **Positionals first, then options**, in declaration order. Parameters that **write** (a switch named or described as apply, write, force, delete, commit, overwrite or push) go **last, under a divider**, labelled in the warning colour with "writes". The label is humanised from the destination (`as_of` becomes "As of"); a positional that is required carries `*`; a `(?)` beside the label holds the script's help, its flags, and a default the control cannot show itself
- **Field kinds**: a switch is a toggle; a `--x/--no-x` switch (click, typer's bools) shows its effective state, so one the script declares on opens **on** with nothing on the line, and its `(?)` and tooltip show both flags and `Default: on` or `off`; a count is a number field; a parameter with up to four short choices is segmented buttons (pressing the chosen one again leaves it to the script), more choices a select; a date is a text field with a calendar button; a path is a text field with **Choose…**; everything else is text. A repeated or multi-value parameter is one field of words as a shell would read them
- **Defaults are placeholders, not values.** An empty field is left out of the command, so the script's own default applies: the placeholder reads `default: data`, or **set by the script** when the default is an expression the reader cannot evaluate (`date.today().year`), or the format wanted (`YYYY-MM-DD`)
- **Choose…** opens the desktop's native file dialog in the agent's folder (a folder too, on macOS) and writes the path **relative to the folder** when it is inside it, as chosen otherwise
- **Other arguments**: one line below the fields for every word the form does not know (an unknown option, anything after `--`). Typing there edits those words only
- A header line says where the form came from ("From report.py") and, behind its `(?)`, that the script is read and not run; the script's Usage line is shown there

### How the form and the line stay in step
- **A switch writes only what differs from the script's default.** Turning on an off-by-default switch adds `--x`; turning off an on-by-default one adds `--no-x`; putting either back to its default removes the words, so the line never carries a flag that changes nothing. When both flags are on the line the last wins, as the script reads it
- **Options come first for getopts.** A new option goes before the first operand, a new positional after the options, and the form builds the line in that order
- **Form edits rewrite only that parameter**, in place. A parameter newly set is added where it belongs (a positional after the previous one, an option at the end, before a `--`); a cleared one loses its words and nothing else. If an edit in place would not read back as the form says, the whole line is rewritten in spec order, keeping the text up to and including the script word verbatim. The form always shows what the line says, never what was typed
- **Line edits update the form** on each keystroke: `--year=2026` and `--year 2026` both read, `-vvv` reads as a count of three
- The user's choices are never lost to the sync: unknown words survive in Other arguments, in order

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
- **Fixed size.** The card is 70% of the viewport tall, with a fixed header, body and footer. The command line's rows (one, up to six; more scrolls) are counted once at open, including the soft wraps of a long line, so nothing resizes while the user types. For a script with a form the count also reserves room for the switches the form could add and the line does not yet name (sized by the flag the form would write — the off flag for a switch that is on — and a flag written as a quoted word counts as named), at most three rows in all; a longer line scrolls to its tail when the form appends to it
- **A refusal or guard line takes its row from the terminal**, never from the command line: nothing under the user's cursor moves
- **Run, Run again and Stop share one slot of one width**, and Run in background is hidden (kept in layout) while a run is going, so a press that swaps them moves nothing. The state and time in the header are a fixed place rewritten in place
- **Stop is guarded against a double-click on Run.** For 400 ms after Stop takes Run's place a pointer press on it is ignored: the second press of a double-click on Run would otherwise stop the run it just started. The keyboard is not held back, and a window opened on an already-running run shows Stop unguarded
- **Escape and a press outside close it** (after a 500 ms guard against the second press of the opening double-click), unless the ⋯ menu or a file preview opened from it is up; those take the key or press first
- **A window run closes nothing on failure**: a refusal or spawn error is a line above the command line, inside the window
- **The form is there from the first frame or never.** The window waits up to 150 ms for main to read the script (a repeat read is cached and answers well inside that) and opens without a form after that; a form that appeared a moment later would shift the terminal under the user's eyes. The form's rows, field kinds and header line are fixed by the script, so typing, toggling and the hand-edited state change values and one line of text, never the layout
- **A parameter's `(?)` tip is not outside the window**: while it is open, Escape closes the tip, not the window, and a press on it is not a press outside
- **A window closes on its own** when its run is removed from the Commands badge, when the active profile changes (even with a start in flight), and, for Run in background, when the background run has started

### The ⋯ menu
Open script, Preview source (the [file preview](../file_preview/file_preview.md) opens over the window), Open folder, Copy command, and Add output to message once ended. The first two apply only when the command names a script inside the agent's folder (a relative path with no `..`).

### A window opened on a run it did not start
The badge's **Open output** can open a run this renderer has no record of (after a reload). The window then has no source message, and names a recent reply of the run's agent when the user runs again. If there is none, the start says "The message this command came from is no longer in the chat." instead of running.

### Refusals are data
`userCommands:run` returns `{ ok: false, code, reason }`, never a thrown error, because a thrown error's code does not reach the renderer. Codes: `needs_review` (opens the window with the reason), `not_local`, `folder_missing`, `chat_not_found`, `spawn_failed`. A refusal from the window shows inside it and closes nothing; from the menu it shows in the menu. `userCommands:commandForFile` (the preview's Run…) answers the same way and adds `not_runnable`: "Cinna doesn't know how to run this file as a script.", or, for a `#!` script whose only missing piece is the execute bit, "This script isn't executable. Make it executable (chmod +x) to run it here." — said as such because the fix is one `chmod`, not a different file

### What it deliberately does not do
- No automatic follow-up turn: the agent learns of a run only from an attached output
- No interactive input, no PTY (the terminal is a viewer, not a shell), no running of a text selection
- No confirmation for Run and Run in background in the menu; clicking a command runs nothing at all
- The form never runs the script, never evaluates Python, and never guesses: it shows what the source states literally and leaves the rest to the script
- The form does not validate: a bad year or a missing required positional is the script's to refuse when run
- No remote or cinna-core agents
- No notification when a background run ends; the badge is the signal

## Architecture Overview

```
click a command ──────────────► Run Script window (nothing running) ─► Run ─► userCommands:run {reviewed:true}
file preview Run… ─► userCommands:commandForFile ─► Run Script window (then as Edit and Run…)
right-click ─► detectCommand + looksAutoRunnable (renderer) ─► menu items
  Run / Run in background ─► userCommands:run {reviewed:false} ─► window on the run / badge only
  Edit and Run… ─► Run Script window
        │ (a script) ─► userCommands:inspect ─► main reads the source ─► Parameters form ⇄ command line
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
- [File Preview](../file_preview/file_preview.md) — the window is a sibling modal and shares its entrance and exit motion; Preview source opens a file preview over it, and the preview's **Run…** closes it and opens this window on a script
- [Antigravity](../../agents/local_agents/antigravity_engine.md) — shares the own-command rule
- [File Attachments](../file_attachments/file_attachments.md) — the output joins the composer as any dropped text file
- [UX Rules](../../development/ui_guidelines/ux_rules.md) — the window keeps a fixed size while the user types or a run streams
- Technical details: [Run Commands (tech)](run_commands_tech.md)
