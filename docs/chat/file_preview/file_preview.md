# File Preview

## Purpose

One read-only modal for looking at a file **in place**, reached three ways.

**An attachment badge or thumbnail in a chat message.**
- **What previews:** `txt`, `csv`, `md`, `json`, `yaml`/`yml`, Python (`py`/`pyi`), XML and its dialects (`xml`, `xsd`, `xsl`/`xslt`, `plist`, `rss`, `atom`, `kml`, `gpx`, `csproj`, `xaml`), HTML (`html`, `htm`, `xhtml`), and images (`png`, `jpg`/`jpeg`, `gif`, `webp`, `bmp`, `svg`). These open the modal instead of the save dialog. An image attachment shows in the transcript as a 64×64 thumbnail rather than a badge ([File Attachments](../file_attachments/file_attachments.md#thumbnails)).
- **Download stays:** the modal header keeps a **Download** button, so previewing never replaces saving the file. An HTML attachment also gets **Open in browser** beside it.
- **Everything else downloads:** PDF, HEIC, TIFF, Office binaries, archives and the rest still go straight to the save dialog. Preview is an extra shortcut, not a new gate.
- **Both directions of attachment:**
  - **User attachments** under a sent user message ([File Attachments](../file_attachments/file_attachments.md)), `cinna` or `local` source.
  - **Agent attachments** under an assistant reply ([Agent Attachments](../agent_attachments/agent_attachments.md)), always `cinna` source.

**A [file reference](../file_references/file_references.md) in a folder agent's chat.** This is an inline code span that names a real file.
- **Open instead of Download:** the file is already on disk, so the header's **⋯** menu offers **Open** and **Open folder**.
- **More types:** other code and config preview as plain text as well; Python is highlighted, as it is for an attachment.
- **Not images.** An agent file is read as text, so an image it names opens in its system app, as before.

**A file still in the composer**, not sent yet: a thumbnail or a previewable badge above the text box. It opens the same modal with **no Download** — the file is the user's own. A new chat's files are read from their path on disk, since no chat exists to hold them yet.

**A long markdown file**, from either way in, also gets a **Contents** panel: its headings, beside the body or over its right edge, so the user can jump to a section and see where they are. **A Python file** with more than one definition gets the same panel as an outline: top-level functions and classes, and under each class its own methods (no nested functions, nested classes or constants). **An XML file** gets it as the document's sections: the elements that hold other elements, down to four levels below the root.

**An HTML file** is shown the way a browser would show it, scripts and remote content included, inside a sandboxed frame that cannot reach the app; a **Rendered / Source** toggle switches to its highlighted markup. **Open in browser** hands it to the user's default web browser.

## Core Concepts

- **Previewable type**: a filename or MIME type the modal knows how to render.
  - `previewKindFor(filename, mimeType)` (`src/shared/filePreview.ts`) maps it to a `PreviewRenderKind` (`markdown`, `json`, `csv`, `python`, `xml`, `html`, `image` or `text`), or `null` when it is not previewable and should download. The extension wins over the MIME type, because the stores' MIME type is only a best guess.
  - Agent files use `agentFilePreviewKindFor`, which adds other code and config as `text`, drops `image` (agent files are read as text), and leaves attachment behaviour unchanged. A `.py` file resolves to `python` through `previewKindFor` first, so it is highlighted in both places.
- **Preview read path**: the IPC call that reads a file's bytes into memory and returns decoded UTF-8 plus a `truncated` flag.
  - Attachments use `files:read-preview`, and agent files use `agent-files:read-preview`.
  - Both are **capped at `MAX_PREVIEW_BYTES` (512 KB)** in main and use the same truncation-safe decode.
  - The preview read is separate from `files:download`, which writes the *full* file to a path the user chooses.
  - An image is read whole instead, as a `data:` URL: `files:read-image`, refused above 20 MB rather than cut. The thumbnails use `files:read-thumbnail`, a scaled-down copy.
  - A composer file not sent yet is read by path: `files:read-preview-path` for text, `files:read-image` with `{ path }` for an image, only for a path the user picked, dropped or pasted this session.
- **Preview target**: what is open — an `attachment` (marked `composer` when opened from the composer), an `agentFile` (an agent id plus the resolved reference), or a `path` (a new chat's composer file).
- **Single global modal**: one `FilePreviewModal` mounted at the app root, driven by `useFilePreviewStore`.
  - Opening a second preview replaces the first.
  - A monotonic `requestId` discards a stale fetch that finishes after the user opened another file or closed the modal.
  - `openSeq` changes on every open, so the entrance plays again.
- **Render kinds**:
  - `markdown` renders through the shared `react-markdown` stack, the same one used by chat bubbles and the note preview.
    A leading YAML frontmatter block is lifted out and shown as a key/value card above the body; see [Frontmatter](#frontmatter).
  - `json` is a collapsible tree, falling back to raw text if it does not parse; see [JSON tree](#json-tree).
  - `csv`/`tsv` renders as a table: quoted fields are honoured (loosely following RFC 4180) and the first 500 rows are shown.
  - `python` is a wrapped `<pre>` highlighted by lowlight, the engine behind the chat's `rehype-highlight`, so a `.py` file is tokenised and coloured exactly like a fenced `python` block in a message (the same `.hljs-*` palette). If highlighting throws, it shows the plain text, so a file cut at the cap still previews.
  - `xml` is a collapsible tree, falling back to highlighted source when it does not parse; see [XML tree](#xml-tree).
  - `html` is the page rendered in a sandboxed frame, or its highlighted source; see [HTML pages](#html-pages).
  - `image` is the picture, fitted inside the card and centred; see [Images](#images).
  - `text` (including yaml) is a wrapped `<pre>`.
- **Preview frame**: the `<iframe>` an HTML page renders in. Main serves it over the app's own `cinna-preview:` scheme, under a **token** issued for that one file and released when the preview closes.
- **Notice**: a body that is a sentence rather than content. For agent files it is either "Preview is off for credential files." or "No preview for this file type."
- **Header actions**:
  - Attachments get an icon-only Download, except one opened from the composer. An HTML attachment also gets an icon-only **Open in browser** (a globe) before it.
  - Agent files get an icon-only **⋯** button ("More file actions"). Its menu holds **Open**, then **Open in browser** for an HTML file, then **Open folder**.
  - For `csv` only, a **Filter** toggle reveals per-column controls. It is hidden while a notice shows.
  - For `html` only, a **Rendered / Source** segmented toggle. It is hidden while the body is an error or a notice.
  - For a long markdown file, a Python file with several definitions, or an XML file with several sections, a labelled **Contents** toggle, at the app-chrome type scale, shows and hides the Contents panel.
- **Contents panel**: a 240 px column listing a markdown file's H1–H4 headings, a Python file's functions and classes (`name()` for a function or method, the bare name for a class) with methods one level in, or an XML file's sections (`tag · name`), indented by depth, with the current section in the accent colour. See [The Contents panel](#the-contents-panel).
- **Note entry**: a muted, italic Contents line such as "… 12 more `<item>`" that stands for entries left out. It is text, not a link.
- **Entrance**: the card expands from the point the user clicked.
- **Exit**: closing plays the entrance backwards, towards the same point.
- **Header path**: an agent file's display path, beside its name. A click copies it.
- **CSV filter & sort**: when the filter toggle is on, two controls appear.
  - Each column header becomes a click-to-sort control. It cycles none → ascending → descending, and sorts numerically when the values are numbers.
  - A second header row adds a substring filter input per column.

  Filters combine with AND, and sorting applies after filtering. Both are view state in the renderer over the parsed rows; the file itself is never modified.

## User Stories / Flows

### Previewing a previewable attachment
1. The user clicks a `txt` / `csv` / `md` / `json` / `yaml` / `py` badge under any message, their own or an agent's.
2. `useAttachmentOpen` gets a non-null `previewKindFor` result, so it calls `useFilePreviewStore.openPreview(attachment, kind)` instead of downloading.
3. The store fetches `files:read-preview`. The modal expands from the badge and shows the rendered content.
4. The user clicks the **Download** icon in the header to save the full file. This is the standard `files:download` save-as flow, through the shared `useFileDownloadStore`, so the spinner and reveal behave exactly as a badge download does.

### Viewing an image
1. The user clicks an image thumbnail under a message, their own or an agent's.
2. The store reads the whole image as a `data:` URL (`files:read-image`) and decodes it before the modal counts as loaded, so the card appears at its final size.
3. The image sits centred, scaled down to fit the card and never enlarged. The title icon is an image.
4. **Download** in the header saves the original file.
5. An image over 20 MB is not shown: the body reads "Couldn't load preview: Image too large to preview." Bytes that are not an image the preview can show, or do not decode, say so the same way.

### Previewing a file still in the composer
1. The user clicks a thumbnail or a previewable badge above the composer.
2. The modal opens as it would for a sent file, without Download. A cut text file says "Preview truncated at 512 KB." rather than pointing at a download that is not there.
3. On the new-chat screen the file is read from its path. An HTML file there shows its highlighted source only: there is no attachment for the preview frame to serve yet. Once a file is ingested into an open chat, it previews as the attachment it is, HTML rendered.
4. A path the user surfaced more than an hour ago is no longer readable: "This file is no longer available to preview. Attach it again."

### Previewing a file an agent named
1. The user clicks a file reference in a folder agent's chat, and main authorizes the path. See [File References](../file_references/file_references.md).
2. The modal expands from the click. Its header shows the file name, its display path, the **⋯** button and Close. The content comes from `agent-files:read-preview`.
3. The user opens the **⋯** menu and picks **Open** or **Open folder**, which hand the file to the operating system. The menu closes, and the **⋯** icon spins until the action returns. A failure appears in a row under the header.
4. Clicking the path beside the file name copies it. A hint under the path says "Copied".

### Finding a section in a long markdown file
1. The user opens a markdown file with several H1s or several H2s. The header shows **Contents**, and the panel is open unless the user closed it last time.
2. In a wide window the card has grown to the right to hold the panel, and the body sits exactly where it would without it. In a narrow one the panel lies over the body's right edge.
3. Clicking an entry scrolls the body so that heading sits just under the body's top edge. The entry turns accent.
4. Scrolling the body moves the accent to whichever section is now at the top.
5. Resting the pointer on an entry that is cut off shows its full text under it after a quarter of a second.
6. Clicking **Contents** hides the panel, and the card narrows back. The choice holds for the next preview and the next launch.

### Filtering & sorting a CSV preview
1. In a `csv`/`tsv` preview, the user clicks the **Filter** icon in the header. A sortable header and a row of filter inputs appear.
2. Typing in a column's input keeps only rows whose cell contains that text, ignoring case. Several column filters combine with AND.
3. Clicking a column header cycles its sort: none → ascending → descending. A column whose cells are all numbers sorts numerically; otherwise it sorts as locale strings.
4. Toggling the Filter icon off restores the raw row order. The controls reset when a different file is previewed.

### Reading a JSON preview
1. The user opens a `json` badge or agent file. The modal shows a coloured tree, fully unfolded, or with only the top level unfolded when the file is large.
2. Clicking a chevron folds that object or array to `{ … }` / `[ … ]` with its size beside it ("3 keys", "12 items"); clicking the chevron or the braces unfolds it. Alt-click folds or unfolds the whole branch under it.
3. A URL inside a string opens in the browser.

### Reading an XML preview
1. The user opens an `xml` (or `plist`, `rss`, `csproj`, …) badge or agent file. The modal shows a coloured tree of tags, attributes and text, with an element holding one short line of text shown on one row, `<title>Report</title>`.
2. Clicking a chevron folds an element to `<tag …>…</tag>` with its size beside it ("3 children"). Alt-click folds or unfolds the whole branch.
3. With several sections, the header shows **Contents**. Clicking an entry unfolds whatever hides that element and scrolls to it.
4. A file that does not parse, or was cut at 512 KB, shows its highlighted source under a line saying which: "This XML could not be parsed, so it is shown as source." or "The preview is cut at 512 KB, so it is shown as source."

### Viewing an HTML page
1. The user opens an `html` badge or agent file. The card opens wider and at a fixed height, and the page loads inside it as it would in a browser: its scripts run, remote images, fonts and styles load, and an agent file's relative `style.css` or `img/chart.png` beside it load too.
2. Clicking a web link in the page opens it in the user's browser. The page itself stays put.
3. **Source** in the header shows the markup, highlighted. **Rendered** goes back to the page as it was left, without reloading it.
4. **Open in browser** (the globe button for an attachment, the **⋯** menu for an agent file) opens the file in the default web browser. A failure appears in the row under the header: "Couldn't open it in the browser: …", or "No browser could open this file."

### Clicking a non-previewable attachment
1. The user clicks a `pdf` / `heic` / `zip` / … badge.
2. `previewKindFor` returns `null`, so `useAttachmentOpen` falls through to `download(attachment)`: the existing save dialog, unchanged.

### Large or non-UTF-8 file
1. **Large files:** a previewable file larger than 512 KB shows its first 512 KB, plus a notice under the content.
   - For an attachment: "Preview truncated — download the file to see the full content."
   - For an agent file: "…open the file to see the full content."
   - For a composer file: "Preview truncated at 512 KB."
   - An image is never cut: over 20 MB it is refused (see [Images](#images)).
2. **Invalid bytes:** invalid byte sequences decode to the replacement character instead of failing, so the modal always shows *something*. Download or Open still gets the exact bytes.

### Closing
1. Escape, the X button, or a press outside the card closes the modal. A press outside within 500 ms of opening, or of a Contents toggle, is ignored. While the **⋯** menu is open, Escape or a press outside closes only the menu. While focus is inside an HTML page, Escape goes to the page and closes nothing.
2. The card shrinks back towards where it opened while it and the backdrop fade out, as fast as they came in. The page under it takes clicks at once.
3. **Focus:** after a keyboard open, focus returns to whatever held it before, once the fade has ended. After a click open, focus is released and not returned.

## Business Rules

- **Only the attachment click decides preview versus download.** `useAttachmentOpen` is the one place that branches.
  - The composer's `useComposerAttachmentOpen` never downloads: it previews, and a composer badge the preview cannot show is not clickable at all.
  - The shared badge component (`AttachmentBadge`) does not route clicks. It only names them: a list whose click goes through `useAttachmentOpen` (or the composer's) passes `previewsOnClick`, and then a previewable badge's tooltip and accessible name say "Preview *name*" while the rest say "Download *name*" ([UX rule 10](../../development/ui_guidelines/ux_rules.md)).
  - Without the flag every badge says "Download", which keeps correct the badges used elsewhere that always download, such as cinna task attachments.
- **Preview never modifies anything.** It is read-only: no write-back and no re-upload.
- **The byte cap is enforced in main.** The renderer cannot request more than `MAX_PREVIEW_BYTES`.
  - For attachments, the cap is applied in `fileService.readTextPreview` / `cinnaFileService.readBytes`.
  - For agent files, it is applied in `agentFileService.readPreview`.
- **Attachments have the same access control as download.**
  - `local` requires `chatFileRepo.getOwned`.
  - `cinna` calls `GET /api/v1/files/{id}/download` with the user's OAuth bearer.

  Preview shows no file the user could not already download. Agent files follow main's containment, consent and credential rules instead. A composer file read by path must be in the [path guard](../file_attachments/file_attachments.md#path-guard-allowlist): the user picked, dropped or pasted it in the last hour. See [File References](../file_references/file_references.md).
- **A slow fetch never replaces a newer preview.**
  - `requestId` changes on every open and on close. A finished fetch whose id no longer matches is dropped, so a slow load for file A cannot overwrite the modal now showing file B.
  - An agent-file open that is still waiting on its consent dialog is dropped too, when a newer open of either kind happens. An attachment opened after it is never replaced.

### The entrance
- **It expands from the click.**
  - The card scales from 0.92 to 1 while fading in, over 170 ms, with `transform-origin` at the click point relative to the card. The backdrop fades in with it.
  - A keyboard open grows from the centre.
  - Under reduced motion it only fades.
- **The origin is measured on the card the user will see.** The loading card is a fraction of the size of the loaded one, and an origin measured on it was wrong once the content landed.
  - So a new open keeps the card and backdrop invisible until the first settled state: content, a notice or an error. Only opacity changes; the layout is already final.
  - Then it measures the card and animates.
  - A load slower than 150 ms animates the loading card instead of leaving nothing on screen.
- **Attachments share the entrance.** A badge's click handler has no event to hand over, so the store records the last pointer-down anywhere in the window.
  - A pointer-down within the last second is used as the origin.
  - An older one means the open came from the keyboard.

### The exit
- **Closing plays the entrance backwards.**
  - The card scales from 1 to 0.92 towards the point it expanded from, fading out as it goes, and the backdrop fades with it.
  - It uses the entrance's 170 ms and easing, short enough never to be waited on, so closing is no slower than opening.
  - Under reduced motion it only fades.
- **The store closes at once; the modal holds a snapshot.** `close()` resets the store straight away, so a fetch still in flight is dropped and nothing reads a half-closed preview. The modal keeps rendering the last open preview until the fade ends, then unmounts.
- **A fading preview is already closed.** Clicks pass through it to the page, and Escape and outside presses no longer act on it.
- **A new open during the fade cancels the fade**, and the new preview plays its own entrance.
- **Focus comes back when the fade ends**, not at the press, and still only after a keyboard open.

### The card is pinned to the top
- **It sits a tenth of the viewport down**, at most 80% of the viewport tall, rather than centred.
- **Why:** the card only grows downward, so content landing, a notice or an error row appearing never moves the button the user just pressed. This applies to attachments and agent files alike.

### Focus
- **Focus moves into the card** once the entrance starts, so Tab reaches its buttons.
- **The scrolling body can be tabbed to**, and shows the accent focus ring rather than Chromium's default.
- **Focus goes back only after a keyboard open.** Once the close has faded out, it returns to the element that had it before the first open, as long as that element is still in the document. Replacing a preview keeps the original element.
- **After a click open, focus is released.** A link given focus back would show its focus-visible ring once the user closed with Escape, so the card's focus is simply released instead.
- **A backdrop press cannot take focus.** Its default is prevented, so closing does not pull focus onto the page after it was handed back.

### Outside presses straight after an open
- **Ignored for 500 ms after every open**, including an open in an error state. Such a press neither closes the modal nor moves focus.
- **Why:** the second press of a double-click on a link lands on the overlay the first click just opened, and closed it again.
- **The cost:** it also swallows a deliberate dismiss in that half-second, which is accepted.

### Agent-file states
- **The body** shows one of: loading, content, a notice (credential or unsupported), or an error.
- **Error copy:**
  - a failed read: "Couldn't load preview: …";
  - a file that has gone: "That file is no longer there.";
  - a folder that has gone: "That folder is no longer there.";
  - a failed folder reveal: "Couldn't show it in its folder: …", or main's own sentence when that already names the action.
- **A folder reaches the modal only when showing it failed.** It shows a folder icon, its name and path, and no file actions.
- **Open and Open folder are disabled while the body says the file has gone.** They could only fail, and their error would repeat the body, so a click would look like it did nothing. The **⋯** button itself stays enabled, so the user can still see what is unavailable.
- **A failed header action** is named in a row under the header: "Couldn't open it: …", "Couldn't show it in its folder: …", or main's own sentence when that names the action already.
  - It closes nothing ([UX rule 6](../../development/ui_guidelines/ux_rules.md)).
  - The row is hidden when the body already shows the same failure.

### The ⋯ menu
- **Open and Open folder live in a menu, not the header.** They used to be labelled header buttons. The header now holds the Contents toggle, and these two actions are occasional.
- **The trigger never disables.** Its items do, while an action runs or the file has gone. A disabled trigger would hide what exists.
- **The trigger shows the running action.** The menu has closed by the time an action runs, so the **⋯** icon becomes a spinner in place. Nothing moves ([UX rule 1](../../development/ui_guidelines/ux_rules.md)).
- **The menu is portaled out of the card**, like every menu ([UX rule 8](../../development/ui_guidelines/ux_rules.md)). A press on it still counts as inside the card, so picking an item never closes the preview.
- **The menu takes the first dismissal.** While it is open, Escape, Tab or a press outside the card closes the menu and leaves the preview up. Only the next Escape or press closes the preview. Escape and Tab also return focus to the trigger.
- **The keyboard reaches the items.** Opening the menu focuses the first enabled item. The arrow keys, Home and End move between enabled items. With none enabled, focus stays on the trigger.
- **The menu closes with the preview.** A preview that starts fading out takes an open menu with it.
- **Only agent files have it.** An attachment keeps its Download button, and a folder that failed to show has no file actions at all.

### The Contents panel
- **A markdown file offers it only when it is long.** It must have more than one H1 or more than one H2. A short note gets no panel, because a list of one or two headings is not worth the width it takes. Frontmatter is not counted: the headings are read from exactly the body the preview renders.
- **An XML file offers it with at least two sections.** A section is an element that holds other elements, from the root's children down to four levels below the root; the root itself is one per file and is not listed. A leaf such as `<title>`, `<price>` or an empty `<entry id="a"/>` is content, not a section, and listing it would turn the panel into a second copy of the tree.
  - **An entry is named by its tag and the first thing that identifies it**: an `id`, `name`, `key` or `title` attribute, else the short text of a `<name>` or `<title>` child, cut at 60 characters. Without one it is the bare tag.
  - **At most 50 entries per parent.** The rest become one note entry, "… N more", with the tag in mono when they all share one (`<item>`). A feed of ten thousand items would otherwise be a panel of ten thousand rows.
  - **A note entry is not a link.** Nothing scrolls to it and it is never marked current.
  - **A click reaches an element the tree is hiding.** The tree unfolds every folded ancestor and pages far enough down each long child list before the body scrolls, so a click on a section inside a folded branch still lands on it.
- **An HTML file never offers it.** The page scrolls inside its own frame, where the panel cannot see or move it.
- **It is not offered until the preview has loaded.** While loading, or when the body is an error or a notice, the header has no Contents button.
- **Entries are H1 to H4.** H5 and H6 are left out. A lone H1 is the document's title, so it is left out too, and its H2s become the top level. Several H1s are all listed.
- **Indentation follows depth, starting from the shallowest level listed.** Top-level entries are in the text colour and deeper ones are secondary. The current one is accent.
- **Headings are found the way the preview renders them.** A `#` inside a code fence is not a heading, while a setext heading (`===` / `---` underline) is. Inline markup is flattened, so `*(mandatory)*` lists as "(mandatory)".
- **Entries point at source lines, not slugs.** Headings repeat, such as an "Edge Cases" under every section, and a line number cannot. The rendered headings keep the tags the preview already gave them; they only gain the line they came from.
- **A click scrolls only the body.** The window and the page are never scrolled. The heading lands 8 px below the body's top edge. The scroll is smooth, or instant under reduced motion.
- **The current section is the last heading at or above the body's top edge**, or the first entry when none is. It is recomputed once a frame while the body scrolls. The panel scrolls itself to keep the current entry in view.
- **A clicked entry stays current until the user scrolls by hand**, with the wheel, a touch, a key or a press in the body. A heading near the end of the file cannot reach the top, and without the hold the accent would land on an earlier section than the one the user picked.
- **A cut-off entry shows its full text after 250 ms.** The hint appears under the entry and floats over everything else. It replaces the native `title`, which waits about a second and cannot be made faster. An entry that fits shows no hint. Screen readers already get the full text from the button.
- **Whether it is open is remembered**, across previews and launches. It starts open, because only long files offer it.

### Where the Contents panel goes
- **The body never changes width.** It keeps the closed card's width whether the panel is open or not, so its text never reflows when the panel toggles.
- **In a wide enough window the card widens, and the panel sits beside the body.** That happens when the closed width plus 240 px fits within the window minus the overlay's padding, which is from about 1,040 px at the default font size.
  - **With room for the whole panel on the right** (from about 1,280 px), the card grows to the right only. Its left edge, and so the body, stay exactly where they were.
  - **With less room**, the card still widens. It moves left only as far as it must to keep 16 px from the window's right edge, so the body moves left by up to 120 px. The user chose this over an overlay.
- **In a narrower window the panel lies over the body's right side**, with a shadow. The card keeps its width.
- **A preview whose load took longer than the entrance wait (150 ms) uses the overlay**, until the user toggles Contents. The entrance ran on the narrow loading card, and widening it when the content landed would move the header's buttons under a pointer that may be on its way to them.
- **Only the Contents button animates the width**, over the entrance's 170 ms. A preview that opens with the panel already open appears at its final width, and a window resize is followed without animating. Under reduced motion nothing animates.
- **Closing a side-by-side panel keeps it drawn while the card narrows**, so the card clips it away rather than leaving an empty strip.
- **A press outside the card is ignored for 500 ms after a toggle.** Toggling moves the card's edge from under the pointer. A second press on the same spot would otherwise land on the backdrop and close the preview.

### The header path
- **The display path** next to the file name is left out when it equals the name, as it does for a file at the top of the agent folder. The name and the path each have a tooltip for when they are cut off.
- **A click copies the path exactly as shown**: agent-relative inside the agent folder, `~/…` or absolute outside it. Only an agent file has a path; an attachment's header shows none.
- **A hint under the path says what a click does.**
  - Hovering or focusing the path shows "Click to copy".
  - A click turns it into "Copied", or "Couldn't copy" when the clipboard refuses. It fades out 1.2 s later.
- **After a copy, the hint stays hidden until the pointer leaves** or focus moves away. It would otherwise flip straight back to "Click to copy" under a pointer that has not moved. Its words hold while it fades.
- **The hint floats.** It is absolutely positioned under the path, over whatever is below, so showing it moves nothing ([UX rule 1](../../development/ui_guidelines/ux_rules.md)).

### Tables
- **Preview tables have zebra rows.** A CSV table, and any table inside a previewed markdown file, shade every other body row a step darker than the card, starting with the first row. Chat tables are not striped.
- **The stripes follow the rows on screen**, not their order in the file, so filtering or sorting a CSV keeps them alternating.
- **Header rows are not striped**, the CSV filter row included.

### Frontmatter
- **A markdown file's frontmatter is a key/value card above the body, not part of it.** `react-markdown` knows nothing about frontmatter: the opening `---` became a rule and the closing one turned every `key: value` line into one setext heading, so a spec file opened as a paragraph of bold run-on text.
- **The card is its own bordered, tinted box**, so it reads as the file's metadata rather than the document's first table. In this modal it sits outside the markdown body and is not zebra-striped.
- **The same card renders frontmatter in chat messages and notes.** A reply that quotes a file whole, or a pasted spec, would otherwise open with the same rule-and-bold-heading. There it sits inside the Markdown body, which is why it is a definition list and not a table: the body's table, `pre` and `code` rules would restyle a table. See [Conversation UI](../conversation_ui/conversation_ui.md) and [Notes](../../notes/notes/notes.md).
- **Only a block made of `key:` lines counts.** It starts on the first line, closes with `---`/`...`, its first non-blank line is a `key:` line (a `#` comment first does not count), and every other top-level line is one too; keys are identifiers (`name`, `multi_company`, `og:title`), never prose like `**Summary**:`. Anything else is not frontmatter and renders as the document's own markdown. The rule is strict because chat replies open with a `---` separator often enough: a looser match turned a reply's first section into a monospace block.
- **Values are shown by shape:** plain text; a list (`- item`, `[a, b]`, or a spaceless `a,b,c` scalar) as chips; `http(s)` URLs as links that open in the browser, like markdown links.
- **It is a reader, not a YAML parser, and it never drops content.** A nested map or list of maps is shown as its source text inside the card. An empty block renders no card.

### JSON tree
- **A JSON file is a tree the user folds, not a wall of pretty-printed text.** An export or API dump is read by finding one branch; folding the rest away is how.
- **It uses the code-block palette** (`.hljs-*`, both themes): keys in the red of an XML tag, strings green, numbers and `true`/`false`/`null` orange, punctuation in the secondary text colour. It is deliberately not the chat code block's JSON colouring, which paints keys the same orange as numbers: keys stand apart from values here, the way tag names do in XML.
- **A fold never moves the row that was clicked.** Folding near the end of a scrolled preview would shorten the content past the scroll position, and the browser would pull every row above it — the clicked chevron included — down under the pointer. The tree keeps just enough height for the scroll position to survive and scrolls any remaining shift away before paint.
- **A long string wraps with a hanging indent**, so its continuation lines sit inside the row instead of at the key's edge, where they read as more rows.
- **A folded node keeps its size in view** ("N keys" / "N items"), so the user knows what is behind it before opening it.
- **A huge object or array shows 200 members at a time**, with a "Show N more of M" row, so a file that is one enormous list stays usable. Anything nested deeper than 32 levels also starts folded, whatever the file's size.
- **A large file opens with only the root unfolded.** Above 2,000 values every object and array below the top level starts folded: one row per top-level member. Fully expanded, a 500 KB export is tens of thousands of rows to scroll past. Folding from the second level instead is not enough, because a top-level array of records would still show every record unfolded.
- **URLs in strings are links**, `http(s)` only, like frontmatter and markdown links.
- **Text that does not parse shows as plain text.** That includes a file cut at the 512 KB cap, so a large JSON file previews as its raw first 512 KB rather than an error.
- **Another file starts from its own fold state.** Fold state is keyed by path; carried over, it would fold paths that mean something else in the new file.

### XML tree
- **An XML file is a tree the user folds, built like the JSON tree.** The same fold that never moves the clicked row, Alt-click for a branch, 200 children at a time with "Show N more of M", and every element deeper than 32 levels folded at the start.
- **A large file opens with only the root's children listed.** Above 2,000 nodes every element below the root starts folded, for the same reason as JSON: a feed's thousand items, each unfolded, is a wall.
- **Short text stays on the element's row.** An element whose only content is one line of text up to 80 characters reads `<title>Report</title>`, with no chevron. Anything longer gets its own rows.
- **Everything in the file is shown**: the XML declaration, a doctype, comments, CDATA and processing instructions, namespace prefixes and declarations as written. A preview that dropped them would misreport the file.
- **It uses the code-block palette**, as the JSON tree and a fenced `xml` block do: tag names, attribute names, values and comments each in their `.hljs-*` colour, punctuation secondary.
- **What does not parse is shown as highlighted source, and says why.** A malformed file reads "This XML could not be parsed, so it is shown as source." A file cut at the 512 KB cap no longer parses either, but it is not broken, so it says the preview was cut instead of calling the file malformed.
- **The parser fetches nothing.** Chromium's XML parser does not load external entities or DTDs, so a previewed file cannot reach the network or the disk through its doctype.

### HTML pages
- **A page is rendered the way a browser would render it.** Its scripts run, and it loads remote images, styles, fonts and data. An agent's report is usually a page built to be looked at, often with a chart library from a CDN; a preview that stripped scripts or remote content would show an empty page. This was the user's decision, and it carries the risks listed [below](#known-limits-and-accepted-risks).
- **An agent file's relative assets load; an attachment's do not.** A page in the agent folder gets the files beside it, in its own folder and below: its `style.css`, `img/chart.png`, `data.json`. An attachment is one file with nothing beside it, so its relative references are not found.
- **The page cannot reach the app.** It runs in a sandboxed frame with no origin of its own, gets no permission (camera, microphone, notifications, location, clipboard) and cannot download, open a window, or take the app window elsewhere. See [Security](file_preview_tech.md#html-preview-frame).
- **A web link opens in the browser, on a click.** Clicking an `http(s)` link sends it to the user's browser; the page and the app stay where they were. A page cannot do this on its own: a script with no click behind it is stopped, and one click opens one tab. A link to a page beside the document, or to a `#section`, stays inside the frame, and still works on that page.
- **Rendered first, every time.** Every open starts on **Rendered**. **Source** shows the markup highlighted (with its `<style>` and `<script>` in CSS and JavaScript colours), the first 512 KB like every other preview, with the truncation notice. The frame stays loaded while Source shows, so switching back does not reload the page.
- **The whole page renders, up to 20 MB.** The frame is served the file whole, not the preview's first 512 KB, so the truncation notice shows on Source only. A page over 20 MB is refused, and the frame says "This file is too large to show."
- **The card is wider and of a fixed height.** It opens up to 72 rem wide instead of 48, and at 80% of the window tall, whatever the page holds, so nothing resizes while the frame loads. The page sits on white in both themes, as a browser's default canvas does, so a page that sets no background reads as it would there.
- **A page main refuses says so in the body**: "Couldn't render the page: …".
- **Opening an `.html` attachment previews it.** It used to download. It now runs the page's scripts and loads its remote content; Download is still in the header.

### Open in browser
- **It goes to the default web browser, not the `.html` default app.** On many machines that app is an editor. The browser is the `https:` handler: `open -a` on macOS, its executable on Windows, `xdg-open` on Linux, with the system's default app for the file as the last resort.
- **An agent file opens where it is**, so its relative assets load in the browser too. Its path is re-checked right before the launch, as **Open** does.
- **An attachment is copied first**, because a browser needs a file. The copy goes to a folder of the app's own data that only the user may enter, one per attachment (a second Open in browser replaces it), and every copy is removed at the next start. A tab still showing one keeps working until then.
- **Only HTML is offered it**: `.html`, `.htm` and `.xhtml`. It is also in the transcript's right-click menu on an HTML [file reference](../file_references/file_references.md).

### Images
- **The formats are the ones Chromium draws everywhere**: PNG, JPEG, GIF (animated too), WebP, BMP and SVG. HEIC and TIFF are not previewable and download: Chromium has no decoder for either, and main's sniff does not recognise them.
- **An SVG is a picture, not XML.** `.svg` and `image/svg+xml` resolve to `image`, and it renders through an `<img>`, where its scripts do not run and it loads nothing.
- **The bytes decide the type.** Main sniffs the first bytes (and an SVG root element) and builds the `data:` URL from that, never from the name or the renderer; a `.png` that is not an image is refused, "This file is not an image the preview can show."
- **Refused above 20 MB, never cut.** Half an image is not a preview. The refusal points at Download.
- **The card settles after the decode.** The store decodes the image before it clears loading, and the `<img>` gets the natural width and height, so the entrance measures the final card and nothing grows under the pointer.
- **It fits, it never enlarges.** The image is at most the body's width and the card's 80% height less its header, centred on both axes.
- **Full images are cached too**, the last 20 in the session, so opening the same image twice reads it once.

### Known limits and accepted risks
Allowing full remote content was a deliberate choice. These follow from it and are accepted, not open bugs:
- **The page shares the app's cookie jar.** Its remote requests are made from the app's default session, so they carry whatever cookies that session holds for the sites they reach, and the page can reach services on `localhost`.
- **A page's scripts can read the files beside it.** Any file in the page's folder and below, except dotfiles, credential files and anything over 20 MB, can be fetched by the page's own script and sent anywhere.
- **An `.html` attachment runs when previewed.** It used to download.
- **One click can still open one tab anywhere.** Chromium lets a page act on a click for about five seconds, so within that window a page's script can send the browser to any URL of its choosing, once, instead of the link the user clicked.
- **A second link within five seconds is refused**, unless the user has left the app and come back in between (following the first link usually does that). The click does nothing; the user clicks again a moment later.
- **An automated click counts as a user's.** A Playwright or DevTools-protocol click into the frame gives the same activation, so tests and tooling pass the gate as a person would.
- **Escape and Tab inside the page never reach the modal.** While focus is in the frame, Escape cannot close the preview (the X and a press outside the card still do), and Tab moves through the page and on out of it: there is no focus trap.
- **An HTML file outside the agent folder, approved as a single file, renders without its relative assets.** The approval covers that file only; its folder would need a folder approval ("don't ask again").

## Architecture Overview

```
Badge or thumbnail click (MessageBubble user badge | AgentAttachment):
  AttachmentList onClick → useAttachmentOpen(attachment)
    previewKindFor(filename, mime)
      → null     → useFileDownloadStore.download(attachment)   [save-as]
      → kind     → useFilePreviewStore.openPreview(attachment, kind)   origin = last pointer-down (≤ 1 s)
                     → window.api.files.readPreview({ fileId, source })
                        → files:read-preview IPC
                           → fileService.readTextPreview (cap = MAX_PREVIEW_BYTES)
                              local : chatFileRepo.getOwned + readFile (capped)
                              cinna : cinnaFileService.readBytes (GET /files/{id}/download, capped)
                           → decodePreviewText → { text, truncated }
                     image → imageDataCache.loadImage → files:read-image → data: URL (sniffed, ≤ 20 MB) → decode()
                     → FilePreviewModal renders by kind (markdown|json|csv|python|xml|html|image|text)
                        header Download → useFileDownloadStore.download (full file)
                        header Open in browser (html) → files:open-in-browser
                           → copy under userData/html-open-in-browser → default web browser

Composer badge or thumbnail click:
  useComposerAttachmentOpen(attachment)
    pending  → openPathPreview → files:read-preview-path { path } | files:read-image { path }   [path guard]
    ingested → openPreview(attachment, kind, { composer: true })
    → FilePreviewModal, no Download

File reference click (folder agent chat):
  useFilePreviewStore.openAgentFile(agentId, ref, click point)
    → agent-files:authorize → agent-files:read-preview → FilePreviewModal
       header ⋯ menu: Open → agent-files:open · Open in browser (html) → agent-files:open-in-browser
                      · Open folder → agent-files:reveal

Long markdown (either way in):
  markdownToc(body after frontmatter) → several H1s or H2s? → header Contents toggle
  pythonOutline(text) → more than one def/class? → header Contents toggle (CodePreview marks each line)
  parseXml(text) → xmlOutline → two or more sections? → header Contents toggle (XmlTree rows carry the ids)
                 → null (malformed / cut) → highlighted source under a note
    → FilePreviewContents beside the body (card widens) or over it (narrow window / slow load)
       entry click → (xml: unfold and page to the element) → scroll the body to [data-heading-line]

HTML page (either way in), Rendered:
  HtmlPreview → html-preview:open (same checks as the text read, never asks) → cinna-preview://<token>/<name>
    → <iframe sandbox> → cinna-preview: handler: profile, gate and 20 MB re-checked per request
       document (+ link helper) · agent file: assets in its folder subtree · attachment: nothing else
    link click → top navigation (user activation only) → will-navigate → browser, never the app window
  unmount (close / another file) → html-preview:release

FilePreviewModal (both):
  hidden until settled (≤ 150 ms) → measure card → expand from origin → focus card
  close: Escape | X | outside press (after 500 ms, not within 500 ms of a Contents toggle)
         an open ⋯ menu takes Escape or an outside press first
    → store closed at once → last open state plays the entrance backwards (170 ms, clicks reach the page)
    → unmount → focus back only after a keyboard open
```

For file paths, IPC signatures and method-level detail see [File Preview — Technical Details](file_preview_tech.md).

## Integration Points

- [File Attachments](../file_attachments/file_attachments.md): user-uploaded badges and thumbnails route through `useAttachmentOpen`, and preview reuses the same `cinna`/`local` source split. The composer's files, pasted ones included, open here through `useComposerAttachmentOpen`, and the inline thumbnails share this feature's image read and cache.
- [Agent Attachments](../agent_attachments/agent_attachments.md): agent-attached badges preview too; they used to be download-only.
- [File References](../file_references/file_references.md): the second way into this modal. It covers resolution, consent, credential files and the Open strategy. An HTML page's assets go through the same containment, consent and credential checks, and its right-click menu offers Open in browser.
- [Note Attachments](../note_attachments/note_attachments.md): a separate preview surface, `NotePreviewModal`, which shows a live note body at the composer stage. This feature previews files already sent or on disk.

## Future Enhancements (Out of Scope)

- **PDF preview**: render PDF pages inline. Today a PDF downloads, or opens in its system app for an agent file.
- **Image preview for agent files**: an image a folder agent names still opens in its system app; the agent-file read is text only.
- **Syntax highlighting for more code** (`.ts`, `.sh`, …): those attachments still download, and agent files show them as plain text. `CodePreview` registers only the grammars its kinds need (python, and xml with css and javascript for HTML source); another language is a new `PreviewRenderKind` plus its grammar, not a switch to lowlight's whole `common` set.
- **Copying the file's content** from the preview modal: only an agent file's header path copies today.
- **A dialog role and a focus trap**: today, Shift+Tab from the card walks back into the page, and Tab walks out of an HTML page's frame the same way.

---

*Last updated: 2026-09-30*
