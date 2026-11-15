# Cross-app Note Format

## Purpose

Note bodies sync verbatim between the desktop and the mobile app, so one note must read the same on both: the same memory-note status, the same due dates, the same tags. This doc states the format the desktop reads and where it differs from mobile. It is the desktop's half; the source of truth is cinna-mobile `docs/sync/data_sync/cross_app_alignment.md` (the "Note body format: todos and tags" part) and the parsers it names, cinna-mobile `src/notes/tasks.ts` and `src/notes/tags.ts` (one test per rule in their test files). Where this page and those disagree, they win; fix this page. <!-- nocheck -->

## Why nothing syncs differently

- The format lives in `body`, which syncs as text. Neither app adds a column, collection or payload field for it, and a client that does not recognise it still shows readable text.
- The desktop is a **reader**. It derives everything in memory from the body and never rewrites one: no due token is removed from the stored text, no tag line is appended, no frontmatter is touched. The mobile Cinna Assistant is the only writer; the desktop has no Assistant.
- A desktop edit changes only what the user typed. The editor keeps CRLF bodies' untouched bytes, because a memory note arrives with frontmatter another client wrote and an unrelated keystroke must not rewrite it.

## The format

### Memory notes

- Leading YAML frontmatter with `kind: assistant-memory`. Other keys the desktop knows: `memory_type` (`preference`, `fact`, `person` or `procedure`) and `summary`.
- Identity comes from `kind` alone, never from a folder or a title.
- A memory note is kept off every notes surface except a collapsible "Assistant memory" section: the main Notes list, the composer `?` picker, the hint gate and the tag filter's chips. It opens and edits in the ordinary editor, with its frontmatter preserved byte for byte.
- cinna-mobile's docs say assistant-memory notes are not built there yet (its note index has the seam for the filter). The key names above come from the desktop's brief, not from a mobile doc; confirm them against cinna-mobile before relying on them.

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

## Where the desktop differs

- **Frontmatter `tags` are read.** The `tags` key (a list, or a comma/space separated scalar) counts as tags, read-only, merged with inline ones. Mobile's doc says it will read them once its frontmatter reader exists, so for now a note tagged only in frontmatter is filterable on the desktop and not on mobile. Inline tags are read from the body below the frontmatter.
- **Read only, everywhere.** Mobile writes tags (a tag line at the end of the note) and ticks tasks; the desktop does neither. A checkbox in the desktop's read view is not a control, and a tag can only be added by typing it.
- **Tag filter is a menu plus a flat list.** Mobile's chips and Today view are its own; the desktop offers a `#` "Filter by tag" menu with parent chips and shows a filtered, undraggable, flat list of regular notes.
- **No Today view and no Assistant.** The desktop does not index tasks across notes.
- **Memory note details.** `memory_type`/`type` and `summary`/`description` have a reader (`memoryInfo`) that nothing displays yet.

## Where it lives

See [Notes — Technical Details](../../notes/notes/notes_tech.md#shared-note-format-in-the-read-view) for the parsers' ports (`src/renderer/src/utils/noteFormat/`), the remark plugin that draws chips and pills, and the surfaces that consume them; [Notes](../../notes/notes/notes.md#reading-assistant-memory-todos-and-tags) for the behaviour. Sync itself is in [Native Client Data Sync](data_sync.md).
