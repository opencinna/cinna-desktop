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
- Shown as a due chip: Today / Tomorrow / Yesterday or "Nov 15" (year added when not the current one) for the due's day bucket (below); warning tone when that day is before today and the task is open, muted when checked.

#### Timed due dates (Phase 2d)

The contract (the orchestrator's `cinna-assistant/feature.md`, "Phase 2d") gives `due:` an optional time, with or without a zone. `📅` stays date-only: a time after it is not part of the token (`📅 2026-11-15T09:00` is not read at all and stays as text; `📅 2026-11-15 09:00` is a date-only due and `09:00` stays in the text). `✅` is unchanged.

| Token | Kind | Meaning |
|---|---|---|
| `due:YYYY-MM-DD` | all-day | that day in the device's current zone |
| `due:YYYY-MM-DDTHH:mm` | floating | wall-clock time in the device's current zone |
| `due:YYYY-MM-DDTHH:mm±HH:MM` (or `±HHMM`, `Z`) | pinned instant | an exact instant; travel does not move it |
| `due:YYYY-MM-DDTHH:mm±HH:MM[Area/City]` | pinned zoned | the wall time in that IANA zone; on a mismatch the zone wins |

The desktop's reading of it, where the contract is silent (`tasks.ts`, tested in `tasks.timed.test.ts`; mobile implements the same read rules):

- **Shape.** The date, then optionally `THH:mm`, optionally `:ss`, then optionally an offset `Z`, `±HH:MM` or `±HHMM`, then — only after an offset — optionally `[zone]` (no `]` or whitespace inside). The token still starts a word and ends at whitespace or line end, so `T09:00[Europe/London]` (zone without an offset), `+01` (hours only) and `T9:00` are not tokens at all: the text stays visible and there is no due, as for any unknown token.
- **Validity.** The date must be a real calendar date, or the token gives no due and the next valid token on the line wins. An impossible time (`T25:00`, `T09:60`, `T09:00:60`) reads as all-day on its date, as builds before times did (reconciled 2026-11-16). A syntactic match is still stripped on a task line either way. Seconds are read (they count in a pinned instant) and never shown.
- **Kind.** No time → all-day. A time without an offset → floating. An offset without a zone → pinned; `Z` and `-00:00` are UTC. An offset is usable when its HH ≤ 23 and MM ≤ 59 (RFC 3339 / Temporal syntax); an unusable one alone makes the token floating.
- **Zone name.** A zone is valid when it is IANA-shaped (`^[A-Za-z][A-Za-z_]*(?:/[A-Za-z0-9_+\-]+)+$`) or `UTC` in any case, **and** `Intl.DateTimeFormat` accepts it. So `[+01:00]`, `[EST]`, `[GMT]` are unknown zones, even though `Intl` takes them. A name that `Intl` resolves to the same name in another case takes `Intl`'s casing (`america/new_york` → `America/New_York`, `utc` → `UTC`); an alias keeps its written name, because ICU resolves some current names to legacy ones (`Asia/Kolkata` → `Asia/Calcutta`, `Asia/Kathmandu` → `Asia/Katmandu`).
- **Zone.** A valid zone wins: the instant is the written wall date-time in that zone, whatever the offset says (a usable offset or not). In a DST gap the time moves forward by the gap (`2026-03-29T01:30` in London is 02:30 BST); in an overlap, a written offset that is one of the zone's two offsets there picks that occurrence (`2026-11-01T01:30-05:00[America/New_York]` is the second 01:30, instant 1793514600000), otherwise the earlier instant (Temporal's "compatible" with offset "prefer"). An unknown zone falls back to the offset; if the offset is unusable too, the token is floating.
- **Day bucket.** All-day and floating use their own written date; pinned uses the instant's date in the device's current zone. Overdue and Today colouring use the day only: a timed due later today is "Today", not overdue, even after its time has passed.
- **Chip.** The day label, then for a timed due its time in the device zone, in the device's 12/24-hour clock (the locale's short time: "15:00" or "3:00 PM"; tokens are always written 24-hour): a floating due its own wall time, a pinned due its instant. A pinned due whose offset at that instant differs from the device's offset at that instant adds where it was written: `Today 15:00 (09:00 New York)`, the zone's last path segment with `_` as a space, or for an offset-only token, `UTC` and any `Etc/*` zone (whose names invert the sign) the offset as `UTC`, `UTC+1`, `UTC+5:30`, `UTC−5` (hours unpadded, minutes only when non-zero, a real minus sign U+2212; `Etc/GMT+5` shows `UTC−5`). When the origin's date differs from the device-local date, the origin starts with its weekday: `Yesterday 20:00 (Mon 09:00 Kiritimati)` (rule 8 below). The same offset in another zone shows no origin. A timed chip's title adds the token as written; its accessible name is the wording without it.
- **Text.** Never normalised; the desktop does not write times. `parseTasks` keeps `dueDate` as the token's written date and adds `due` (the kind, time, instant and offset).

**Mobile must mirror exactly** (a difference here moves a todo to another day or time on one app):

1. `TOKEN` groups, in order: leading space, `due:` date, hour, minute, second, offset, zone, `📅` date; `✅` uncaptured. Offset `Z|[+-]\d{2}:?\d{2}`, zone `\[[^\]\s]+\]` only after an offset, then whitespace or line end.
2. Offset usable only when HH ≤ 23 and MM ≤ 59.
3. `-00:00` is UTC (offset 0), not RFC 3339's "local offset unknown".
4. DST gap: the time moves forward by the gap. Overlap: a written offset valid for the zone at that wall time picks the occurrence; otherwise the earlier instant.
5. An impossible date gives no due (the next valid token wins); an impossible time (HH > 23, mm > 59, ss > 59) reads as all-day on its date. Either token is still stripped from a task line.
6. A pinned due is bucketed by its instant's date in the device zone, never by its written date.
7. The zone-name rule above: IANA-shaped or `UTC`, then `Intl`-valid; otherwise the offset is used.
8. Origin day (user, 2026-11-16): when the origin's calendar date (the instant plus the offset used, as a wall date) differs from the device-local date of the instant, the origin part starts with that origin date's weekday as a fixed English three-letter abbreviation (`Sun` `Mon` `Tue` `Wed` `Thu` `Fri` `Sat`, never localised, like the month names) and a space: `Yesterday 20:00 (Mon 09:00 Kiritimati)`. No date is added: the two dates are at most two days apart, so the weekday is never ambiguous, even across a month or year boundary (`Jan 1, 2027 10:00 (Thu 20:00 New York)`). Same date: no weekday (`Today 15:00 (09:00 New York)`).
9. Offset origin label: `UTC` for zero, else `UTC` + sign (`+`, or U+2212 `−`) + unpadded hours + `:MM` only when the minutes are non-zero (`UTC+1`, `UTC+5:30`, `UTC−5`, `UTC−9:30`). Used for offset-only tokens, `UTC` and `Etc/*` zones.
10. Clock (user, 2026-11-16): chip and origin times use the device's 12/24-hour setting: the locale's short time, overridden on macOS by System Settings → "24-hour time" (desktop reads `AppleICUForce24HourTime` / `AppleICUForce12HourTime`, read only, at launch and on window focus); the weekday and month names stay fixed English.

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
