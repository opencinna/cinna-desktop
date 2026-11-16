# Cross-app Note Format

## Purpose

Note bodies sync verbatim between the desktop and the mobile app, so one note must read the same on both: the same memory-note status, the same due dates, the same tags. This doc states the format the desktop reads and where it differs from mobile. It is the desktop's half; the source of truth is cinna-mobile `docs/sync/data_sync/cross_app_alignment.md` (the "Note body format: todos and tags" and "Memory notes and frontmatter" parts) and the code it names, cinna-mobile `src/notes/tasks.ts`, `src/notes/tags.ts`, `src/notes/frontmatter.ts` and `src/notes/memoryNotes.ts` (with their tests). Where this page and those disagree, they win; fix this page. <!-- nocheck -->

## Why nothing syncs differently

- The format lives in `body`, which syncs as text. Neither app adds a column, collection or payload field for it, and a client that does not recognise it still shows readable text.
- The desktop is a **reader**. It derives everything in memory from the body and never rewrites one: no due token is removed from the stored text, no tag line is appended, no frontmatter is touched. The mobile Cinna Assistant is the only writer: it creates memory notes and edits their keys; the desktop has no Assistant.
- A desktop edit changes only what the user typed. The editor keeps CRLF bodies' untouched bytes, because a memory note arrives with frontmatter another client wrote and an unrelated keystroke must not rewrite it.

## The format

### Memory notes

- Leading YAML frontmatter with `kind: assistant-memory` (exact match on the trimmed value). Other keys: `memory_type` (`preference`, `fact`, `person` or `procedure`, a routine) and `summary` (one line, at most 200 characters). Any other key is kept and never interpreted.
- Identity comes from `kind` alone, never from a folder, a title or a tag.
- Both apps detect a block with the same rules, the desktop's `src/renderer/src/utils/frontmatter.ts:splitFrontmatter()`: optional BOM, a `---` first line, closed by the first later `---` or `...` line, a key line (or nothing) first inside, and every top-level line a key line, comment, blank, indented continuation or `- item`. CRLF and LF are both accepted.
- Mobile writes a new memory note as `kind`, `memory_type`, `summary` in that order, LF line endings, no `tags`, at the root; the text after the block is the details. An update changes only `memory_type`, `summary` and, when asked, the text.
- A memory note is kept off every notes surface except a collapsible "Assistant memory" section: the main Notes list, the composer `?` picker, the hint gate and the tag filter's chips. It opens and edits in the ordinary editor, with its frontmatter preserved byte for byte.

### Task syntax

- A task is a GFM task item: `-`, `*` or `+`, then `[ ]` or `[x]`/`[X]`, then text. Spacing is as loose as an editor's checkbox; a trailing `\r` is ignored. Lines inside fenced code are not tasks.
- Due date: `due:YYYY-MM-DD` (what the Assistant writes) or `📅 YYYY-MM-DD` (Obsidian Tasks). The token starts a word, ends at whitespace or line end, and the date must be a real calendar date. A token wrapped in emphasis is not read.
- The first valid due token on the line wins. Every due token is stripped from the displayed text; Obsidian's `✅ YYYY-MM-DD` done-date is tolerated and stripped, not interpreted.
- `due:YYYY-MM-DDTHH:mm` is accepted and the time ignored. Mobile's parser and doc both do this and call times "reserved"; the desktop mirrors the parser.
- Shown as a due chip: Today / Tomorrow / Yesterday or "Nov 15" (year added when not the current one), the device's local day; warning tone when overdue and open, muted when checked.

### Tags

- Obsidian's rules: `#` plus letters, numbers, `_`, `-`, `/` and other Unicode letters, marks and symbols including emoji; anything else ends the tag. At least one non-numeric character (`#1984` is not a tag, `#y1984` is).
- The `#` must start a word (line start or after whitespace): `foo#bar`, URL fragments, `\#tag` and `# Heading` are not tags. Emphasis markers before the `#` are see-through (`**#urgent**` is a tag, `x**#y**` is not).
- Fenced code, inline code spans and markdown link text or URLs hold no tags.
- Case-insensitive: the key is the lower-cased form, the display keeps the casing first seen. Nested with `/`: filtering by `inbox` matches `#inbox` and `#inbox/…`; a trailing `/` is dropped.
- Frontmatter `tags` are read on both apps, read-only, merged with inline tags: the frontmatter's tags first, then inline tags scanned only in the text after the block. The value is a list (`[a, b]` or `- item` lines) or a comma/space separated scalar; each item loses a leading `#` and a trailing `/`, and invalid ones are skipped. Neither app writes `tags` into frontmatter.

## Where the desktop differs

These match the "Differences from the desktop" list in cinna-mobile's doc.

- **Reader, not writer.** Mobile writes memory notes, edits their keys line by line (every other byte kept) and writes tags on an end-of-note tag line and ticks tasks. The desktop does none of this and never rewrites a body; a checkbox in its read view is not a control, and a tag can only be added by typing it.
- **CRLF and BOM in the split.** Detection is the same, the result is not. The desktop's `splitFrontmatter` returns parsed entries and a body re-joined with `\n`, the BOM and CRLF dropped; it is used for display and detection only, never saved. Mobile returns the block's exact source plus the untouched rest, so the two concatenate to the stored body. The desktop's byte preservation comes from its editor instead: the textarea edits the whole raw body and splices each edit back so untouched bytes, CRLF included, stay as stored.
- **Nested values.** The desktop keeps a nested map or list of maps as a raw source-text value (shown in the frontmatter card); mobile's reader omits them. Neither reads them as tags or memory keys.
- **`memory_type` / `summary` defaults.** The desktop's `memoryInfo` returns the raw string or `null`: no lower-casing, no validation against the four types, no fallback summary. It accepts `type` and `description` as aliases (first non-empty wins), as mobile does. Mobile lower-cases, reads an unknown or missing type as `fact`, and uses the first content line (markers dropped, 120 characters) when `summary` is missing. Nothing on the desktop displays these values yet.
- **Where memory shows.** The desktop lists memory notes in a collapsible "Assistant memory" section at the bottom of its Notes sidebar, opened in the ordinary editor, and keeps them out of the main list, the `?` picker, its hint and the tag filter. Mobile has no memory section on any notes surface; it lists them in Settings → Assistant → Memory.
- **Title edit and summary.** Mobile treats the title as the summary and writes a title edit back to `summary`. The desktop's title is a separate field and its editor never touches frontmatter, so a desktop title edit leaves `summary` unchanged, and mobile's memory index keeps showing the old summary.
- **Frontmatter lines are never tasks.** On both apps. The desktop's read view renders, and its remark plugin scans, only the body after the block, so a frontmatter line never gets a due chip or a stripped token. Its line numbers are relative to that body; it keeps no task index, so nothing depends on body-wide line numbers. (`parseTasks` in `src/renderer/src/utils/noteFormat/tasks.ts` has no frontmatter handling itself, but nothing outside its tests calls it.)
- **Derived in memory, no index.** Mobile keeps derived note indexes (rebuilt on upgrade, version 1 → 2, for frontmatter); the desktop derives tags and memory status in memory from the note list on every render, and has no Today view or cross-note task index.
- **Tag filter is a menu plus a flat list.** The desktop offers a `#` "Filter by tag" menu with parent chips and shows a filtered, undraggable, flat list of regular notes; clicking a tag pill in the note editor sets the same filter.

## Job mode marker (`@assistant`)

A job's manifest carries `modeName`, normally a chat mode's portable name. Mobile has an Assistant that desktop does not, so a mobile job that runs as the Assistant syncs with the reserved value `@assistant` (cinna-mobile `src/jobs/jobMode.ts` <!-- nocheck -->; desktop's copy is `src/shared/jobMode.ts`). The payload is unchanged; only the value is reserved. The comparison trims and ignores case, and the marker wins over a chat mode that happens to carry the same name, on both apps.

A desktop cannot run an Assistant job, and running it on its default chat mode would do different work under the same title. So the desktop:

- **Pull.** `resolveMode` returns no mode for the marker, with no fallback to the default mode. Any other unknown name still falls back to the default mode (or none) locally.
- **Keeps the marker.** `buildJobManifest` keeps the prior `modeName` when no local chat mode has that name and the job's `modeId` is still what a pull would have given (none for the marker, the default mode's id for any other name). A rename, an agent or MCP change, a non-mode update and the local-agent rekey all rebuild the manifest without dropping it, so the next push does not hand mobile a different job. An explicit mode pick on the desktop replaces it; that is the only way the desktop changes it. A dependency change rebuilds normally. Known limit: for an ordinary unknown name (not the marker), changing which mode is the default after the pull, or renaming the default mode, makes the next rebuild drop the preserved name. The marker is unaffected.
- **Never runs it.** The desktop, remote and scheduled executors refuse the job, a due schedule occurrence is skipped, and the UI disables Run and scheduling for it and says where the job runs. It is not a needs-setup dependency. See [Jobs](../../jobs/jobs/jobs.md#a-job-mobile-runs-as-the-assistant).

This replaces the earlier behaviour mobile's doc describes (the desktop falls back to the default mode and drops the marker on its next edit).

## Where it lives

See [Notes — Technical Details](../../notes/notes/notes_tech.md#shared-note-format-in-the-read-view) for the parsers' ports (`src/renderer/src/utils/noteFormat/`), the remark plugin that draws chips and pills, and the surfaces that consume them; [Notes](../../notes/notes/notes.md#reading-assistant-memory-todos-and-tags) for the behaviour. Sync itself is in [Native Client Data Sync](data_sync.md).
