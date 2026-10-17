# File References

## Purpose

A folder agent works inside its folder and names files all the time: `data/reforecast/pulled/omp.csv`, `scripts/pull.py:42`. In that agent's chat, an inline code span that names a real file or folder is clickable, and so is a markdown link whose destination is one (Codex writes `[Index CSV](</abs/path/index.csv>)`). <!-- nocheck --> A file opens in the shared [preview modal](../file_preview/file_preview.md), which expands from the click point and has **Open** and **Open folder** in its header's **⋯** menu. A folder opens in Finder / Explorer. A right-click offers what a user does with a named file next: copy its contents or save them to Notes, copy its full path, show it in its folder, or start a new chat that points at it. The user never has to go looking for a file the agent has just named.

## Core Concepts

- **File Reference**: an inline code span whose text, or a markdown link whose destination, main resolved to an existing file or folder, for one agent. It carries:
  - the span text or the link's rendered `href`, which is the lookup key;
  - its source, `span` or `link`, so a span and a link with the same text are two references;
  - the canonical realpath;
  - a display path: relative to the agent folder when inside it, else `~/…` or absolute;
  - its kind, `file` or `dir`;
  - whether it is **inside** the agent folder.
- **File link**: a reference that came from a markdown link. It renders as an ordinary link, opens like a span, and never navigates.
- **Candidate**: a span or link destination whose *shape* could be a path. Only candidates are ever looked up.
- **Scope**: the agent a bubble is resolved against. An assistant row uses its `sourceAgentId` and a user row its `addressedAgentId`; either falls back to the chat's own agent. Only an agent whose capabilities include `cwd` has a scope. Today that means the folder launchers (OpenCode, Claude, Codex), for kit and bare folders alike.
- **Base**: a folder an earlier reference lives in. A later short span or link may be resolved against it.
- **Outside-Folder Consent**: the native dialog main shows before Cinna previews, opens or reveals a reference outside the agent folder.
- **Credential file**: a file whose name says it holds secrets. It is never read into the renderer.
- **Guarded location**: `~/Documents`, `~/Desktop`, `~/Downloads` or iCloud Drive (`~/Library/Mobile Documents`). macOS asks the user before an app touches any of them. See [The Agents Folder Question](../../agents/local_agents/home_access.md).
- **Open strategy**: how **Open** hands a file to the operating system, which never involves executing it.
- **Reference menu**: the transcript's right-click menu when it lands on a reference. It replaces **Copy text** / **Save to Notes** of the span text with **Open in browser** (HTML files only), **Copy contents**, **Save to Notes** (of the file), **Copy full path**, **Show in the folder** and **Reference in a new chat**, then, last and in a group of its own, **Publish…** when the profile can publish [artifacts](../artifacts/artifacts.md).
- **Whole-file read**: the file's complete text, for Copy contents and Save to Notes. Unlike a preview it is never truncated: a file over the cap is refused. Copy contents reads up to 25 MB, the same as a preview; Save to Notes up to 4 MB.

## User Stories / Flows

### Previewing a file the agent named
1. The agent's reply finishes streaming and is saved. Inline code spans that name a real file gain an accent-tinted fill and a thin edge around the same inline code box, and the line does not move.
2. The user clicks one. Main checks that the path may be used; for a path inside the agent folder the answer is immediate.
3. The preview modal expands from the click point. It shows:
   - the file name and its path in the agent folder;
   - the **⋯** menu (**Open**, **Open folder**) and Close;
   - the rendered content: markdown, JSON, a CSV table, highlighted Python, or plain text for other code and config.
4. From the **⋯** menu, **Open** hands the file to the user's editor or its system app, and **Open folder** selects it in Finder. A failure shows in a row under the header and closes nothing.

### A link the agent wrote
1. The agent writes `[Index CSV](</Users/me/agent/app data/index.csv>)`. Once the reply is saved, the link resolves like a span and looks like any other link: link colour and underline, no box. <!-- nocheck -->
2. Hovering shows the display path; a click opens the same preview, or shows a folder in Finder, through the same checks. The window never navigates, and a middle-click does nothing.
3. A link that does not resolve — a missing file, `mailto:`, any non-`http(s)` destination in a chat with no folder or a bubble still streaming — is its text, with the destination as a tooltip. An `http(s)` link opens in the browser, as everywhere.

### Showing a folder
1. The user clicks a span that names a folder. Its tooltip ends in `/`.
2. After the same check, the folder is selected in Finder / Explorer and no modal opens. If showing it fails, the modal opens where the click was and says why.

### A file outside the agent folder
1. The agent names `~/shared-data/exports/q3.csv`. It links like any other reference, because detection only checks that the path exists.
2. On click, main shows a native dialog attached to the window. It reads "Show a file outside <agent>'s folder?", shows the `~/…` path, and has **Show file** and **Cancel** buttons.
   - When Cinna would read the file, the dialog adds "Cinna reads it to preview it here."
   - For a folder it reads "Show a folder outside…", and its button is **Show in Finder** (**Show in folder** off macOS).
3. The dialog may offer a checkbox: "Don't ask again for anything inside “exports” until Cinna restarts".
4. **Show file** opens the preview. **Cancel** opens nothing and shows nothing, because the user chose it.

### A file that cannot be shown
- **A credential file** (`.env`, `server.pem`, `credentials/api.json`): the modal says "Preview is off for credential files." Open and Open folder still work.
- **A type with no preview** (`.gz`, `.xlsx`): the modal says "No preview for this file type." The header still works.
- **A file that has gone** since the reply: "That file is no longer there." Open and Open folder are disabled in the **⋯** menu, since they could only fail.
- **A folder that has gone**: "That folder is no longer there.", with no file actions.

### From the keyboard
1. Tab reaches a reference. Enter or Space opens it, and the modal grows from its centre.
2. Focus moves into the modal, so Tab reaches the path, the **⋯** button and Close. Enter on **⋯** opens the menu with its first item focused. Escape closes the modal, and once it has faded out, focus goes back to the reference.

### Right-clicking a reference
1. The user right-clicks a linked span with nothing selected in it. The reference is outlined, and the menu opens with two groups separated by a divider:
   - **Copy contents** and **Save to Notes**;
   - **Copy full path**, **Show in the folder** and **Reference in a new chat**.

   A third group, **Publish…**, follows when the active profile is a signed-in Cinna account whose instance keeps [artifacts](../artifacts/artifacts.md) and the reference is a file or folder inside the agent's folder that is not a credential file. It is offered for folders and binary types too, since main publishes bytes, not text. It opens the Publish dialog, closes the menu, and the resulting card lands right after the message the reference was rendered in.

   Near the bottom of the window the menu opens upwards from the pointer instead.

   A folder, a known binary type (`report.pdf`, `photo.jpg`) or a credential file shows only the second group. An HTML file (`.html`, `.htm`, `.xhtml`) gets a group of its own first: **Open in browser**.
2. **Copy contents** puts the whole file on the clipboard and closes the menu.
3. **Save to Notes** creates a note from the file and opens it, the way a transcript excerpt does. The note is titled:
   - for a markdown file, by its frontmatter `title:`, else its first H1, else its first heading of any level, else its file name;
   - for anything else, by its file name.

   A markdown or `.txt` file is saved as written. Any other file is saved inside a fenced code block tagged with its language (`py`, `ts`, `json`, `makefile`…), so a script reads as code in the note.
4. **Copy full path** copies the absolute path. Nothing is read and nothing is asked.

   **Show in the folder** selects the file or folder in Finder / the file manager and closes the menu. It is offered wherever Copy full path is, folders, binary types and credential files included, since nothing is read. For a path outside the agent folder it first asks "Show a file outside <agent>'s folder?", with a **Show in Finder** button (**Show in folder** off macOS); **Cancel** closes the menu and shows nothing. A failure — main's reason, such as "Could not show the file in its folder." — is said inside the menu.
5. **Open in browser** opens the file in the user's default web browser and closes the menu. For a file outside the agent folder it first asks "Open a file outside <agent>'s folder in your browser?", with an **Open in browser** button; **Cancel** closes the menu and opens nothing. "No browser could open this file." is said inside the menu.
6. **Reference in a new chat** opens the new-chat screen with the reference's agent selected, the composer focused, and "The file \`<path>\` " already typed, ready for the rest of the sentence. A folder reads "The folder \`<path>\` ". Text already in the new-chat composer stays, and the reference goes on a line under it.
7. For a file outside the agent folder, the two content items first ask to read it: "Let Cinna read a file outside <agent>'s folder?", **Read file** or **Cancel**. The menu stays open while the dialog is up. **Cancel** closes the menu and reads nothing. The running item shows a spinner and the others dim until it ends.
8. A failure is said inside the menu, which stays open for a retry with focus back on the item that failed: "This file is over 25 MB." (Copy contents) or "This file is over 4 MB." (Save to Notes), "This isn't a text file.", "That file is no longer there.". An agent that has been switched off shows the toast "*Name* is disabled", one that is gone "That agent is no longer available".
9. A selection inside a path still wins: selecting part of it and right-clicking gives the ordinary **Copy text** / **Save to Notes** of the selection.
10. A file link gets the same menu, outlined the same way, and a right-click on code inside it takes the link's file. A link that did not resolve opens no menu, as plain prose does.

## Business Rules

### Where references link
- **Only in the chat of an agent that runs in a folder** (`capabilities.cwd`). Remote, command-line and managed agents have no folder to resolve against. Main's `locate` also refuses any id that is not a folder agent's.
- **In message bubbles only**, user and assistant alike. Nothing links in these places:
  - a coordinator's nested agent sub-threads;
  - thinking and tool blocks.
- **Inline code and inline links only.** A `code` element inside a fenced or indented block never links, even when its text exactly matches a resolved span. Reference-style links (`[name][id]`) are not read.
- **Code inside a rendered link is never a reference of its own**, whether the link is a file link or `http(s)`. Otherwise a click on ``[`out.csv`](/abs/out.csv)`` would act twice, once for the span and once for the link. Inside a link that did not resolve, which renders as text, the code is an ordinary span again. <!-- nocheck -->
- **Not while streaming.** Resolution reads the saved transcript, so a bubble still receiving tokens shows plain inline code and local links as text. Its links appear once the message is saved.
- **Keyed by span text, and links by `href`.** Every inline occurrence of the same span text in one agent's bubbles links to the same path, and so does every link with the same `href`. The two are looked up separately.

### Links that go nowhere are not links
- **A non-`http(s)` link is a file link or plain text.** In every chat bubble, a link whose destination did not resolve — a missing path, `mailto:`, `file://`, or any local path outside a folder agent's chat or while streaming — renders as its text with the destination as a tooltip. `setWindowOpenHandler` opens `http(s)` in the browser and silently drops everything else, so such a link used to look clickable and do nothing. Folder documents already followed this rule.
- **`http(s)` is unchanged**: it opens in the browser.
- **A file link never navigates.** A click, Enter or Space opens the preview; the default action is always prevented, and a middle-click, which would open the `href` in a new window, does nothing.
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
- **De-duplicated and capped.** Candidates are kept in transcript order (the first occurrence of each span text or `href` wins) and capped at 500 per agent, spans and links together. Later references in a very long chat do not link.

### Which links are candidates
- **The key is the `href` exactly as the bubble renders it.** The link component only ever sees its `href`, so the scanner reproduces react-markdown's: the `<…>` stripped, backslash escapes and character references decoded, then percent-encoded the same way (a space becomes `%20`). A test renders awkward destinations through react-markdown and requires the scanner to produce the same list. As with spans, a disagreement costs an unlinked link, never a wrong one.
- **A link is explicit intent, so its rule is looser than a span's.** Whitespace is allowed (once decoded), and neither a `/` nor an extension is required: `[notes](README)` is a candidate. <!-- nocheck -->
- **Refused outright**: a URL with a scheme (`http:`, `mailto:`, `file:`), a protocol-relative `//host`, an in-page `#anchor` or `?query`, control characters, and anything over 1024 characters.
- **Line suffixes are dropped from the path**: a trailing `:line` / `:line:col`, and a `#L12`, `#L12-L20` or `#L3C4` anchor.
- **A `#` is otherwise part of the name**, except a heading anchor (no `.` or `/` in it) after a name with an extension: `README.md#install` names `README.md`, while `notes#1.md` and `notes#section` are names as written. An encoded `%23` is always a name character.
- **`%XX` escapes are decoded** before the path is looked up, so `[Index](</a/my file.csv>)` finds `my file.csv`. A malformed escape leaves the text as written. <!-- nocheck -->
- **Filtered twice**, like spans: the renderer chooses, and main re-applies the link rule.
- **Known cases that do not link:** a relative `file:line` with no slash (`app.py:12` reads as a URL scheme, and react-markdown blanks its `href` too), a Windows `C:\` path, a `file://` URL, and a destination using a named character reference other than `&amp;`, `&lt;`, `&gt;`, `&quot;`, `&apos;` and `&nbsp;`.

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
- **Only earlier references contribute**, spans and links alike. Both are resolved as one list in transcript order, and the base list is capped at 200 and keeps its first entries, so **a link never disappears when a later message arrives** — and a later span cannot unlink an earlier link, or the other way round.
- **Detection only stats.** Nothing is read. A path outside the agent folder is linked here and checked later, at the click.
- **Inside or outside is decided on realpaths.** Every path is a canonical realpath, so a symlink out of the agent folder counts as outside.

### Links do not flicker
- **Resolved per agent.** Each agent's candidates are resolved in one request, keyed by their ordered list of source and text. A message that adds a span or link re-resolves, and so does a change of order alone; an unchanged transcript does not.
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
  - It says "Cinna reads it to preview it here." only when it is asking to *show* a file — a click or **Open** — and the file is a previewable type and not a credential file.
- **It says what Cinna is about to do.**
  - A click and **Open** ask to *show* the file: **Show file**.
  - **Open folder** and **Show in the folder** ask to show it in the file manager: "Show a file outside <agent>'s folder?", **Show in Finder** (**Show in folder** off macOS), and no preview line, since nothing is read.
  - **Open in browser** asks "Open a file outside <agent>'s folder in your browser?", with an **Open in browser** button and no preview line.
  - Copy contents and Save to Notes ask to *read* it: "Let Cinna read a file outside <agent>'s folder?", with a **Read file** button and "Cinna reads it to copy it or save it to Notes."
  - A folder is always asked about as a folder to show in the file manager, whatever the action.

  A dialog that promised a preview would not be consent to putting the file on the clipboard, and one that promised to read a file Cinna only hands to Finder or a browser would ask for more than it takes.
- **One approval, whichever words asked for it.** An approval given for any one action covers every other: one given to read covers a later click, and the other way round. While a dialog for a path is open, a second request for the same path waits for that dialog's answer, in whatever words it was asked.
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
  - `*.pem` and `*.key`;
  - SSH private keys: names starting `id_rsa`, `id_dsa`, `id_ecdsa`, `id_ed25519` or `id_xmss` (so `id_ed25519_work` too), except the public `*.pub` half;
  - tool credential stores known by name: `.netrc`, `_netrc`, `.npmrc`, `.pypirc`, `.pgpass`, `.git-credentials`, `.dockercfg`;
  - stores known by folder and name, matched as whole path segments: `…/.docker/config.json`, `…/.aws/credentials`, `…/.kube/config`;
  - anything under the agent's `credentials/` folder, except `README.md` and `*.example`.
- **Names are compared without case**, erring towards refusing.
- **Main checks two spellings**: the realpath and the path as the renderer spelled it. Neither a symlink nor a data-volume spelling gets past it.
- **The renderer checks the name first** as well, only so that `.env` shows the credential message rather than "No preview for this file type", and so its right-click menu does not offer contents main would refuse.
- **Only reading is refused**: the preview and the whole-file read ("Cinna does not read credential files."). Open, Open folder, Copy full path and Show in the folder still work.

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
- **A preview and a whole-file read** compare the opened file's device and inode with the stat that passed the checks. If a rename or a new symlink changed them in between, they refuse as not found.
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
- **Open in browser is a separate action**, offered for HTML files only. It goes to the default *web browser* (the `https:` handler), because the app `.html` files open with is often an editor, and falls back to the system app only when no browser launch worked. The path is re-checked right before the launch, as for Open. See [File Preview](../file_preview/file_preview.md#open-in-browser).

### Previews
- **What previews:** every type an attachment previews, plus code and config shown as text (`py`, `sh`, `ts`, `sql`, `toml`, …). This is a separate rule from the attachment one, so attachment behaviour is unchanged.
- **Read in main**, capped at 25 MB, with the same truncation-safe decode as attachments. A truncated preview says "Preview truncated — open the file to see the full content."
- **A type with no preview is never read.**
- **An HTML file renders with the files beside it.** Its page asks for `style.css` or `img/chart.png`, and main serves them only from the page's own folder and below, never a dotfile or dot-folder, never a credential file, never over 25 MB, and only when that path is inside the agent folder or under an approval already given. A page never raises the consent dialog: an outside page approved as a single file renders without its assets. See [File Preview — Security](../file_preview/file_preview_tech.md#html-preview-frame).

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
- **A file link looks like a link, not like a span.** It keeps the ordinary link colour and underline and adds only a pointer cursor. Until resolution lands it is plain text in a span, so any padding, edge or fill would reflow the line at the swap. Its tooltip is the display path (a folder's ends in `/`), and its accessible name is "Preview <link text>" or "Show <link text> in its folder". The same click rules apply.

### The modal for a file reference
- **The header** holds, in order:
  - the file icon and file name;
  - the display path, muted, next to the name; a click copies it (left out when it would repeat the name);
  - the CSV filter, when it applies;
  - the **⋯** menu, holding **Open** then **Open folder**, and Close.

  There is no Download button: the file is already on disk.
- **A failure before there is anything to show still opens the modal**, where the click was, and says why. A click that does nothing is worse.
  - A failed read says "Couldn't load preview: …".
  - A failed folder reveal says "Couldn't show it in its folder: …", or main's own sentence when that already names the action.
- **A failed header action** is named in a row under the header: "Couldn't open it: …" or "Couldn't show it in its folder: …". It closes nothing, and the row is hidden when the body already says the same thing.
- **Shared with attachments:** the entrance, the fade-out on close, the card pinned to the top, focus handling and the press guard are rules of the modal itself. See [File Preview](../file_preview/file_preview.md).

### The right-click menu
- **It is the transcript's own menu**, with the same placement rule, outline, pointer and keyboard handling, one-action-at-a-time guard and in-menu errors as Copy text / Save to Notes. See [Conversation UI](../conversation_ui/conversation_ui.md#reusing-message-text). Only a rendered reference gets these items; inline code that did not resolve, or a reference in a bubble still streaming, gets the plain text menu.
- **A file link takes precedence over code inside it.** A right-click on ``[`out.csv`](…)`` acts on the link's file, matching the click rule that code inside a link is not a reference. <!-- nocheck -->
- **The items are decided once, when the menu opens**, from the reference as the transcript resolved it. Nothing appears or disappears while the menu is open, so the item under the pointer is the one clicked.
- **Contents are offered unless they plainly cannot be text.** A folder, a known binary type or a credential name gets the path items only. A known text type (every previewable type, `.log`, `.out`, `.err`, rotated logs such as `app.log.1`, and conventional names such as `Makefile`, `Dockerfile`, `.gitignore`, `LICENSE`) is offered. So is an unknown type (`.gz`, an extensionless `NOTES`): main reads it and decides from the bytes.
- **The whole file or nothing.** The read goes through the same checks as a preview — containment or approval, files only, never a credential file, the device and inode re-checked once open — and is never truncated:
  - over the cap, it is refused, and the sentence names that cap: "This file is over 25 MB." for Copy contents, "This file is over 4 MB." for Save to Notes. A file that grows past the cap after the size check is caught by the read, not cut short;
  - a known binary type, a NUL byte or bytes that are not valid UTF-8 are refused as "This isn't a text file."

  A note or a clipboard holding only the start of a file, as a preview may, would pass for the whole of it.
- **Each use has its own cap.** Copy contents goes as far as a preview does, 25 MB, so a file the user can preview is a file they can copy; the clipboard takes it and nothing is edited. Save to Notes stays at 4 MB, because a note is opened and edited in place, not just held. The menu says which use it is; any other value gets the note cap.
- **The menu survives the consent dialog, and only that.** A native dialog takes the window's focus, and a window blur normally closes the menu. A blur is ignored only while the consent call is pending; once it has answered, switching away closes the menu again even if the read or the note is still running. Declining closes the menu silently, as a declined click opens nothing.
- **Copy contents writes the clipboard from main.** The renderer's clipboard refuses a write from a document without focus, and after a consent dialog the document may not have it back. Copy full path, which asks nothing, uses the renderer's clipboard as Copy text does.
- **Publish… is decided with the other items, once, at open.** Whether artifacts are supported is read before the menu opens, so it neither appears nor disappears under the pointer. An outside reference and a credential reference never offer it: main would refuse the first and publish nothing of the second. The renderer only hands over `{agentId, path}`; main re-checks everything ([Artifacts](../artifacts/artifacts.md#what-may-be-published)).
- **Reference in a new chat uses the reference's own agent**: the agent whose folder the span resolved in, which in a routed chat can be a different agent from the chat's. It lands where every "chat with this agent" action lands — the new-chat screen, that agent preselected, the Chats list beside it — as [New Chat with This Agent](../../ui/keyboard_shortcuts/keyboard_shortcuts.md) does. The path is written into the new-chat screen's draft before the screen mounts, so it is in the input with the caret after it; a line break separates it from text the user had already typed there, which is kept.
- **The path is the realpath**, for Copy full path and Reference in a new chat alike, not the display path: a relative path means nothing in another chat or tool.

### Deliberately not done
- **No approval survives a restart**, and none is written anywhere.
- **Nothing links** for a remote or command-line agent, in a coordinator's sub-threads, in reference-style markdown links or in code blocks.
- **No outside path is logged.** A path outside the agent folder is logged only as its length. A launch failure is logged by error name only, because `execFile`'s error message quotes its arguments.

## Architecture Overview

```
Resolve (saved transcript)
  MessageStream → collectFileRefSources (folder agents only, per agent, in order)
    → FileRefResolver → useAgentFileRefs → extractFileRefEntries (spans + link hrefs, interleaved)
        → window.api.agentFiles.resolve → agent-files:resolve
           → agentFileService.resolve → localAgentService.locate (index row)
              → resolveFileRefs: span/link rule re-check → guarded-folder skip → stat → base heuristic
    ← refs per agent → FileRefContext {refs, links} around each bubble (null while streaming)
       → MarkdownCode renders <code class="file-ref" role="button">
       → MarkdownLink renders <a class="file-link" role="button"> | http(s) <a target=_blank> | <span title=href>

Click
  useFilePreviewStore.openAgentFile(agentId, ref, click point)
    → agent-files:authorize: inside or approved? → yes | native dialog (one per path)
       denied → nothing
       folder → agent-files:reveal → shell.showItemInFolder
       file   → FilePreviewModal expands from the click point
                  → agent-files:read-preview (containment/consent → credential → kind → dev/inode) → text
                  Open        → authorize → agent-files:open   → editor | system app | open -t | reveal
                  Open in browser (html) → authorize → agent-files:open-in-browser → browser | system app
                  Open folder → authorize → agent-files:reveal
                  html page → html-preview:open → cinna-preview://<token>/… (document + assets in its folder, never asks)

Right-click
  useMessageContextMenu → fileRefTargetOf(a.file-link, else code) → { agentId, ref } → messageMenuItems (decided once)
    Copy contents / Save to Notes
      → readAgentFileText: agent-files:authorize (dialog if outside) → agent-files:read-text
         (containment/consent → file → credential → binary name → dev/inode → 25 MB copy | 4 MB note → NUL / UTF-8)
      Copy contents → clipboard:write-text (main's clipboard)
      Save to Notes → fileNoteFromContents → note:create → Notes tab, note opens
    Open in browser (html)  → agent-files:authorize (dialog if outside) → agent-files:open-in-browser
    Copy full path          → navigator.clipboard (no IPC, no dialog)
    Show in the folder      → agent-files:authorize (dialog if outside) → agent-files:reveal
    Reference in a new chat → startAgentChat(agent, draft) → new-chat screen, path in the composer
```

For file paths, IPC signatures and method-level detail see [File References — Technical Details](file_references_tech.md).

## Integration Points

- [File Preview](../file_preview/file_preview.md): the modal a file opens in, including its entrance, focus and error states. Attachments and file references share it.
- [Agent Drivers & Readiness](../../agents/drivers/drivers.md): `capabilities.cwd` decides which agents' chats link.
- [Open in Tools](../../agents/local_agents/open_in_tools.md): the Default Tool that **Open** prefers. The editor launch is the one the agent page uses.
- [The Agents Folder Question](../../agents/local_agents/home_access.md): owns the guarded-location check this feature reuses, so the resolver never probes a guarded folder.
- [Kit Contract](../../agents/local_agents/kit_contract.md): the `credentials/` folder convention the credential rule follows.
- [Conversation UI](../conversation_ui/conversation_ui.md): the message bubbles the links render in, and the transcript right-click menu the reference items live in.
- [Notes](../../notes/notes/notes.md): Save to Notes creates an ordinary note from the file, and opens it as a saved excerpt is opened.
- [Artifacts](../artifacts/artifacts.md): the **Publish…** item, and the persisted message a reference remembers (`MessageIdContext`) so the card goes after it. A link to `/artifact/<uuid>` is also no file link: it renders as an artifact card.
- [Keyboard Shortcuts](../../ui/keyboard_shortcuts/keyboard_shortcuts.md): Reference in a new chat shares the "chat with this agent" landing and the disabled/missing-agent toast with the chat-starting shortcuts.
- [Settings Scope](../../core/settings_scope/settings_scope.md): folder agents are located in the settings scope, and approvals are keyed by the profile scope.
