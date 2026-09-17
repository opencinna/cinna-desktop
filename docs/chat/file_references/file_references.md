# File References

## Purpose

A folder agent works inside its folder and names files all the time: `data/reforecast/pulled/omp.csv`, `scripts/pull.py:42`. In that agent's chat, an inline code span that names a real file or folder is clickable. A file opens in the shared [preview modal](../file_preview/file_preview.md), which expands from the click point and has **Open folder** and **Open** in its header. A folder opens in Finder / Explorer. The user never has to go looking for a file the agent has just named.

## Core Concepts

- **File Reference**: an inline code span whose text main resolved to an existing file or folder, for one agent. It carries:
  - the span text, which is the lookup key;
  - the canonical realpath;
  - a display path: relative to the agent folder when inside it, else `~/…` or absolute;
  - its kind, `file` or `dir`;
  - whether it is **inside** the agent folder.
- **Candidate**: a span whose *shape* could be a path. Only candidates are ever looked up.
- **Scope**: the agent a bubble is resolved against. An assistant row uses its `sourceAgentId` and a user row its `addressedAgentId`; either falls back to the chat's own agent. Only an agent whose capabilities include `cwd` has a scope. Today that means the folder launchers (OpenCode, Claude, Codex), for kit and bare folders alike.
- **Base**: a folder an earlier reference lives in. A later short span may be resolved against it.
- **Outside-Folder Consent**: the native dialog main shows before Cinna previews, opens or reveals a reference outside the agent folder.
- **Credential file**: a file whose name says it holds secrets. It is never read into the renderer.
- **Guarded location**: `~/Documents`, `~/Desktop`, `~/Downloads` or iCloud Drive (`~/Library/Mobile Documents`). macOS asks the user before an app touches any of them. See [The Agents Folder Question](../../agents/local_agents/home_access.md).
- **Open strategy**: how **Open** hands a file to the operating system, which never involves executing it.

## User Stories / Flows

### Previewing a file the agent named
1. The agent's reply finishes streaming and is saved. Inline code spans that name a real file gain an accent-tinted fill and a thin edge around the same inline code box, and the line does not move.
2. The user clicks one. Main checks that the path may be used; for a path inside the agent folder the answer is immediate.
3. The preview modal expands from the click point. It shows:
   - the file name and its path in the agent folder;
   - **Open folder**, **Open** and Close;
   - the rendered content: markdown, JSON, a CSV table, or plain text for code and config.
4. **Open** hands the file to the user's editor or its system app. **Open folder** selects it in Finder. A failure shows in a row under the header and closes nothing.

### Showing a folder
1. The user clicks a span that names a folder. Its tooltip ends in `/`.
2. After the same check, the folder is selected in Finder / Explorer and no modal opens. If showing it fails, the modal opens where the click was and says why.

### A file outside the agent folder
1. The agent names `~/shared-data/exports/q3.csv`. It links like any other reference, because detection only checks that the path exists.
2. On click, main shows a native dialog attached to the window. It reads "Show a file outside <agent>'s folder?", shows the `~/…` path, and has **Show file** and **Cancel** buttons.
   - When Cinna would read the file, the dialog adds "Cinna reads it to preview it here."
   - For a folder it reads "Show a folder outside…", and its button is **Show in Finder**.
3. The dialog may offer a checkbox: "Don't ask again for anything inside “exports” until Cinna restarts".
4. **Show file** opens the preview. **Cancel** opens nothing and shows nothing, because the user chose it.

### A file that cannot be shown
- **A credential file** (`.env`, `server.pem`, `credentials/api.json`): the modal says "Preview is off for credential files." Open and Open folder still work.
- **A type with no preview** (`.gz`, `.xlsx`): the modal says "No preview for this file type." The header still works.
- **A file that has gone** since the reply: "That file is no longer there." Open and Open folder are disabled, since they could only fail.
- **A folder that has gone**: "That folder is no longer there.", with no file actions.

### From the keyboard
1. Tab reaches a reference. Enter or Space opens it, and the modal grows from its centre.
2. Focus moves into the modal, so Tab reaches the path, Open folder, Open and Close. Escape closes the modal, and once it has faded out, focus goes back to the reference.

## Business Rules

### Where references link
- **Only in the chat of an agent that runs in a folder** (`capabilities.cwd`). Remote, command-line and managed agents have no folder to resolve against. Main's `locate` also refuses any id that is not a folder agent's.
- **In message bubbles only**, user and assistant alike. Nothing links in these places:
  - a coordinator's nested agent sub-threads;
  - thinking and tool blocks;
  - markdown links: a `[name](path)` is left alone. <!-- nocheck -->
- **Inline code only.** A `code` element inside a fenced or indented block never links, even when its text exactly matches a resolved span.
- **Not while streaming.** Resolution reads the saved transcript, so a bubble still receiving tokens shows plain inline code. Its links appear once the message is saved.
- **Keyed by span text.** Every inline occurrence of the same text in one agent's bubbles links to the same path.
- **Over the text the bubble renders.** Resolution reads each message with attachment tags stripped and nested code fences repaired, which is the same string its bubble shows. Unrepaired, the outer closer of an unescaped nested block opened a new block that swallowed the prose after it, so a path named in that prose was taken for code and never looked up.

### Which spans are candidates
- **The shape rule.** A candidate must pass every check:
  - 2–512 characters and no whitespace;
  - no `://` and no leading `-`;
  - none of `* ? [ ] { } < > | " ' $ =` or a backtick;
  - either a `/` or a trailing `.ext` of 1–10 letters or digits.
- **A trailing `:line` or `:line:col`** is stripped from the path but kept in the key.
- **Why the rule exists:** a span that reads like a command (`rm -rf *`), a URL or prose is never looked up at all.
- **Filtered twice.** The renderer applies the rule to choose what to ask about, and **main applies it again**, because the renderer is not trusted to have done so.
- **A small scanner finds the spans**, not the parser that draws the bubble. When the two disagree, the cost is a span that does not link, never a wrong link: a link needs a rendered inline `code` whose exact text main resolved.
- **De-duplicated and capped.** Candidates are kept in transcript order (the first occurrence wins) and capped at 500 per agent. Later spans in a very long chat do not link.

### How a candidate resolves
- **Directly first.**
  - An absolute path is used as it is.
  - `~/…` resolves against the home folder.
  - Anything else resolves against the agent folder. Main reads that folder from the agent's index row, never from the renderer.
- **Then against bases**, for a relative span without `..` that did not resolve directly. The bases are:
  - the folder of each earlier reference: a file's parent, or the folder itself;
  - that folder's ancestors, while they are still strictly inside the agent folder;
  - for a reference outside the agent folder, only its own folder.
- **Exactly one match, or no link.** A span resolved through bases links only when exactly one distinct file matches, so `summary.md` next to two different earlier files stays plain text. This is how the short names an agent uses after giving a full path get linked: `pulled/reseller.csv` after `data/reforecast/pulled/omp.csv`.
- **Only earlier spans contribute.** The base list is capped at 200 and keeps its first entries, so **a link never disappears when a later message arrives**.
- **Detection only stats.** Nothing is read. A path outside the agent folder is linked here and checked later, at the click.
- **Inside or outside is decided on realpaths.** Every path is a canonical realpath, so a symlink out of the agent folder counts as outside.

### Links do not flicker
- **Resolved per agent.** Each agent's candidates are resolved in one request, keyed by their ordered list. A message that adds a span re-resolves; an unchanged transcript does not.
- **The previous answer stays up.** While a new answer is on its way, the previous links stay on screen.
  - The obvious tool, TanStack's `keepPreviousData`, does nothing across a key change inside `useQueries`. Before this rule, every link in the chat went blank each time a turn added a span.
  - The remembered answer belongs to one chat, so another chat's links for the same text never show.
- **A failed resolve links nothing** and is not retried.

### Main owns every decision
- **The renderer names paths; main decides.** The renderer only sends back paths that resolve gave it. Every read, open and reveal re-checks that the realpath is inside the agent folder **or** approved for this profile, and refuses with `needs_consent` otherwise. A renderer cannot assert consent.
- **Inside references are re-checked too.** The renderer asks main even about a reference resolved as inside: that flag was true when the transcript resolved, and the file may since have become a symlink out of the folder. Main answers for an inside path without showing a dialog.
- **Failures come back as data** (`{ success: false, code, error }`), because a thrown error's code does not survive IPC.

### Outside-folder consent
- **Linked, but checked at the click.** The native dialog is shown by main and attached to the window.
  - It shows `~/…` paths and calls a folder a folder.
  - It says "Cinna reads it to preview it here." only when the file is a previewable type and not a credential file.
- **Approvals live in memory only.**
  - They end when Cinna quits.
  - They are kept per profile, so switching profile never carries one person's approvals over to another.
  - A file approval covers that one file. The optional folder approval covers everything inside that folder, subfolders included.
- **Some folders are never offered for approval**: the home folder, any folder containing it (`/Users`), `/`, and a volume root (`/Volumes/X`, `/mnt/X`, `/media/<user>/X`, `/run/media/<user>/X`). Approving one of those would approve nearly everything.
- **The covered folder gets its own line** in the dialog, unless it is the path already shown.
- **One dialog per path at a time.** A second click on the same path while its dialog is open waits for that answer instead of opening another. Before this rule, two quick clicks opened two dialogs.
- **Denied means nothing happens.** No modal and no error: the user chose it.

### Credential files are never read into the renderer
- **Which files count:**
  - `.env` and `.env.*`, except `.env.example`, `.env.sample` and `.env.template`;
  - `*.pem`, `*.key`, `id_rsa*` and `id_ed25519*`;
  - anything under the agent's `credentials/` folder, except `README.md` and `*.example`.
- **Names are compared without case**, erring towards refusing.
- **Main checks two spellings**: the realpath and the path as the renderer spelled it. Neither a symlink nor a data-volume spelling gets past it.
- **The renderer checks the name first** as well, only so that `.env` shows the credential message rather than "No preview for this file type".
- **Only the preview is refused.** Open and Open folder still work.

### macOS spellings
- **The data volume.** `/System/Volumes/Data/Users/me` is the same folder as `/Users/me`, and `realpath` keeps whichever spelling it was given. That spelling used to get around the containment, credential and home-folder rules.
  - Every realpath is now canonicalised: the prefix is dropped when the shorter path is the same file (same device and inode).
  - Checks that err towards refusing drop the prefix as plain text, without touching the disk: a guarded location, a credential name, a folder too broad to approve.
- **Opening a chat must not raise a privacy prompt.** Resolution runs when a chat opens, and a "would like to access files in your Downloads folder" prompt at that moment would follow no click.
  - A path under a guarded location is never probed: not directly, not through `~/`, and not as a base join.
  - The one exception is an agent folder inside that same guarded folder.
  - A reference that lands in a guarded folder anyway, through a symlink, adds no bases.
  - A click may still raise the prompt, because then it follows something the user did.
- **The guard ignores case.** APFS ignores case by default, so `~/downloads/q3.csv` is the Downloads folder. That spelling used to slip past a case-sensitive comparison.
  - On a case-sensitive volume, the fold treats an unguarded path as guarded. That is the safe direction.
  - The same check gates the Agents Home consent.
  - The exception for an agent inside a guarded folder is compared as spelled, so an agent in `~/Documents/a` does not link `~/DOCUMENTS/x.md`.

### Check, then use
- **A preview** compares the opened file's device and inode with the stat that passed the checks. If a rename or a new symlink changed them in between, it refuses as not found.
- **Open** re-takes the realpath immediately before launching, and refuses if it changed.
- **Open folder** does not re-check, because selecting a path in the file manager executes nothing.

### Open never executes the file
- **A folder** is always revealed.
- **A binary document** goes to its system app, even when a default editor is set, because an editor would show its bytes. The types: `pdf`, `xlsx`, `xls`, `docx`, `doc`, `pptx`, `ppt`, `numbers`, `pages`, `key`, `png`, `jpg`, `jpeg`, `gif`, `webp`, `heic`.
- **Text and code** try each of these in turn:
  1. the user's [Default Tool](../../agents/local_agents/open_in_tools.md), when that is an installed editor (a CLI assistant as default does not count);
  2. the system app, for `csv`, `tsv`, `md`, `markdown`, `txt`, `log`, `json`, `yaml` and `yml`;
  3. macOS's default text editor (`open -t`);
  4. off macOS, the file is only selected in the file manager.
- **A credential name never reaches the system app.**
  - `.key` is a Keynote document to the OS and a private key to the agent that wrote it, and the name alone cannot tell which. Before this rule, a PEM key opened in Keynote.
  - A credential file goes to the editor, else `open -t`, else a reveal.
- **The system app is used only for allowlisted types.** `shell.openPath` runs whatever the OS associates with a type, so a `.command` or an `.app` would execute.
- **When the system app refuses**, the message is "No app could open this file."

### Previews
- **What previews:** every type an attachment previews, plus code and config shown as text (`py`, `sh`, `ts`, `sql`, `toml`, …). This is a separate rule from the attachment one, so attachment behaviour is unchanged.
- **Read in main**, capped at 512 KB, with the same truncation-safe decode as attachments. A truncated preview says "Preview truncated — open the file to see the full content."
- **A type with no preview is never read.**

### What a reference looks like
- **It looks pressable.** It keeps the inline code box, tints its fill slightly towards the accent (orange in the dark theme, blue in the light one), and adds a 1px edge. The edge deepens on hover, and the cursor is a pointer. See [UX rule 11](../../development/ui_guidelines/ux_rules.md): a control must not look like the text beside it.
  - **The edge is neutral, one tone off the span's fill**: lighter than the fill in the dark theme, darker in the light one.
  - **It is never the accent.** An accent edge reads as a frame, and makes the text inside look cramped.
  - **The tint is faint.** It sets a link apart from the inline code beside it without reading as a highlight.
- **Nothing moves when links appear.** Links arrive after resolution, under text the user may be reading.
  - The edge is an inset shadow, not a border: a border grows the span by 2px and reflows the line.
  - Wrapped pieces are not padded one by one (`box-decoration-break: clone`). Plain inline code is not padded that way, and with it the line shifted when links appeared.
- **Keyboard focus has its own ring**: a 2px accent outline, which takes no layout space, rather than the hover edge.
- **It is a `code` element with a button role**, not a `<button>`, which would not wrap inside a paragraph.
  - Its tooltip is the display path. A folder's ends in `/`, so it does not read as a file of that name.
  - Its accessible name says what a click does, "Preview <text>" or "Show <text> in its folder" ([UX rule 10](../../development/ui_guidelines/ux_rules.md)).
- **Clicks that do not open it:** selecting part of a path does not open it, and the second click of a double-click opens nothing more.

### The modal for a file reference
- **The header** holds, in order:
  - the file icon and file name;
  - the display path, muted, next to the name; a click copies it (left out when it would repeat the name);
  - the CSV filter, when it applies;
  - **Open folder**, **Open** and Close.

  There is no Download button: the file is already on disk.
- **A failure before there is anything to show still opens the modal**, where the click was, and says why. A click that does nothing is worse.
  - A failed read says "Couldn't load preview: …".
  - A failed folder reveal says "Couldn't show it in its folder: …", or main's own sentence when that already names the action.
- **A failed header action** is named in a row under the header: "Couldn't open it: …" or "Couldn't show it in its folder: …". It closes nothing, and the row is hidden when the body already says the same thing.
- **Shared with attachments:** the entrance, the fade-out on close, the card pinned to the top, focus handling and the press guard are rules of the modal itself. See [File Preview](../file_preview/file_preview.md).

### Deliberately not done
- **No approval survives a restart**, and none is written anywhere.
- **Nothing links** for a remote or command-line agent, in a coordinator's sub-threads, in markdown links or in code blocks.
- **No outside path is logged.** A path outside the agent folder is logged only as its length. A launch failure is logged by error name only, because `execFile`'s error message quotes its arguments.

## Architecture Overview

```
Resolve (saved transcript)
  MessageStream → collectFileRefSources (folder agents only, per agent, in order)
    → FileRefResolver → useAgentFileRefs → extractFileRefCandidates
        → window.api.agentFiles.resolve → agent-files:resolve
           → agentFileService.resolve → localAgentService.locate (index row)
              → resolveFileRefs: shape re-check → guarded-folder skip → stat → base heuristic
    ← refs per agent → FileRefContext around each bubble (null while streaming)
       → MarkdownCode renders <code class="file-ref" role="button">

Click
  useFilePreviewStore.openAgentFile(agentId, ref, click point)
    → agent-files:authorize: inside or approved? → yes | native dialog (one per path)
       denied → nothing
       folder → agent-files:reveal → shell.showItemInFolder
       file   → FilePreviewModal expands from the click point
                  → agent-files:read-preview (containment/consent → credential → kind → dev/inode) → text
                  Open        → authorize → agent-files:open   → editor | system app | open -t | reveal
                  Open folder → authorize → agent-files:reveal
```

For file paths, IPC signatures and method-level detail see [File References — Technical Details](file_references_tech.md).

## Integration Points

- [File Preview](../file_preview/file_preview.md): the modal a file opens in, including its entrance, focus and error states. Attachments and file references share it.
- [Agent Drivers & Readiness](../../agents/drivers/drivers.md): `capabilities.cwd` decides which agents' chats link.
- [Open in Tools](../../agents/local_agents/open_in_tools.md): the Default Tool that **Open** prefers. The editor launch is the one the agent page uses.
- [The Agents Folder Question](../../agents/local_agents/home_access.md): owns the guarded-location check this feature reuses, so the resolver never probes a guarded folder.
- [Kit Contract](../../agents/local_agents/kit_contract.md): the `credentials/` folder convention the credential rule follows.
- [Conversation UI](../conversation_ui/conversation_ui.md): the message bubbles the links render in.
- [Settings Scope](../../core/settings_scope/settings_scope.md): folder agents are located in the settings scope, and approvals are keyed by the profile scope.
