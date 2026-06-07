# Apply-Patch Diff

## Purpose

Renders the OpenCode / Codex `apply_patch` tool call as a readable git-style diff (per-file op badge, path, add/delete tally, colorized lines) instead of dumping the raw `patch_text` string through the generic key/value tool renderer.

## Core Concepts

- **`apply_patch` tool** — A tool an agent calls to create/modify/delete files. Its single argument `patch_text` carries a textual patch in the OpenCode/Codex envelope (`*** Begin Patch` … `*** End Patch`).
- **File op** — One of `Add` / `Update` / `Delete`, parsed from `*** Add File:` / `*** Update File:` / `*** Delete File:` markers. Each op may carry a `*** Move to:` rename target.
- **Hunk** — An `@@`-prefixed context header inside an Update op.
- **Diff line** — A patch body line classified as addition (`+`), deletion (`-`), context (leading space), or hunk header. Additions/deletions are tallied per file for the `+N −M` badge.
- **Render guard** — A single `parsePatch()` call that returns the structured files or `null`; `null` means "not a (valid) patch", so the caller falls back to the generic tool renderer.

## User Stories / Flows

1. An agent calls `apply_patch` with a `patch_text` payload to write or edit files.
2. The transcript renders an **Applying patch · N files** collapsible header (collapsed by default).
3. Expanding shows one card per file: an op badge (Add/Update/Delete), the file path (with a `→` rename when moved), a `+N −M` tally, and the colorized diff body (green additions, red deletions, muted context/hunk headers).
4. If the agent also attaches the resulting file, it renders separately as a downloadable badge (see [Agent Attachments](../agent_attachments/agent_attachments.md)).

## Business Rules

- **Parse-or-fall-through**: the dedicated diff view is used only when `patch_text` parses into ≥1 file op. Any non-string, non-patch, or empty-result payload falls back to the generic tool renderer.
- **Errors keep the generic block**: when the tool call carries an error, the standard tool block renders instead so the failure stays visible (the diff view is success-only).
- **Collapsed by default on render**: matches every other auxiliary transcript block; only the header (icon + label + file count) shows until the user expands.
- **Transparent when collapsed**: no card chrome (border/background) until expanded — inherited from the shared disclosure shell.
- **Add ops have only additions; Delete ops have no body lines.** Update ops mix hunks, context, additions, and deletions.

## Architecture Overview

```
Agent stream (tool part, toolName = apply_patch)
  -> ToolNarrationBlock / ToolCallBlock (render guard: parsePatch(patch_text))
       -> parsePatch() -> PatchFile[]  (or null -> generic tool renderer)
       -> ApplyPatchBlock(files)
            -> DisclosureBlock (shared collapsible shell)
                 -> FileDiffCard per file (badge + path + tally + diff lines)
```

## Integration Points

- [Conversation UI](../conversation_ui/conversation_ui.md) — Hosts the transcript blocks; `ApplyPatchBlock` is one of its disclosure blocks and shares the `DisclosureBlock` shell documented there.
- [Agent Attachments](../agent_attachments/agent_attachments.md) — The file an `apply_patch` produces is often also attached and rendered as a download badge.
- Theming — All colors reference CSS variables from `src/renderer/src/assets/main.css`.
