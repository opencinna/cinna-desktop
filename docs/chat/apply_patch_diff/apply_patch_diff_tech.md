# Apply-Patch Diff — Technical Details

Renderer-only feature — no DB, IPC, preload, or main-process surface.

## File Locations

### Renderer

| File | Role |
|------|------|
| `src/renderer/src/utils/applyPatch.ts` | Pure (no React/Electron) parser. `parsePatch(raw)` returns `PatchFile[]` or `null`. Exports the `PatchOp` / `PatchLineType` / `PatchLine` / `PatchFile` types. Single source of truth for the patch grammar. |
| `src/renderer/src/utils/applyPatch.test.ts` | Vitest unit tests (node env) covering Add / Update+hunk / Delete / Move / multi-file / CRLF / non-patch inputs. |
| `src/renderer/src/components/chat/ApplyPatchBlock.tsx` | Presentational diff view. Receives already-parsed `files: PatchFile[]`, renders the `DisclosureBlock` header (`Applying patch · N files`) and one `FileDiffCard` per file. Holds the `OP_META` badge map (label/icon/color per op). |
| `src/renderer/src/components/chat/DisclosureBlock.tsx` | Shared collapsible shell it composes — see [Conversation UI tech](../conversation_ui/conversation_ui_tech.md). |
| `src/renderer/src/components/chat/ToolNarrationBlock.tsx` | Render-guard call site for A2A `tool`-kind parts (`toolName === 'apply_patch'`). |
| `src/renderer/src/components/chat/ToolCallBlock.tsx` | Render-guard call site for tool-call rows (`name === 'apply_patch'`); guard sits above the component's hooks so it stays hook-free. |

## Patch Grammar (`parsePatch`)

- Strips `*** Begin Patch` / `*** End Patch` and `*** End of File` markers.
- File-op markers (regex-matched): `*** Add File: <path>`, `*** Update File: <path>`, `*** Delete File: <path>`; `*** Move to: <path>` sets `moveTo` on the current file.
- Body lines within a file: `@@…` → `hunk`; leading `+` → `add` (counted); leading `-` → `del` (counted); else → `context` (leading space stripped).
- Normalizes CRLF → LF before splitting.
- Returns `null` when input isn't a string, lacks `*** `, or yields zero files — this is the contract the call-site render guards depend on.

## Render Guard Pattern

- Both call sites do a **single** `parsePatch(input.patch_text)` and use the result two ways: truthy → render `<ApplyPatchBlock files={…} />`; `null` → fall through to the generic renderer. No double parse, and no blank-render risk (the block never re-parses or returns `null`).
- `ToolNarrationBlock`: guard runs after its hooks (already called) — safe.
- `ToolCallBlock`: guard runs before its hooks and is pure, so the early return doesn't violate rules-of-hooks; it also requires `!error` so failing calls keep the standard block.

## Diff Card Rendering (`FileDiffCard`)

- Header row: op icon (`FilePlus2` / `FilePen` / `FileMinus2`), op badge (color from `OP_META`), monospace path with `ArrowRight` + `moveTo` on rename, right-aligned `+additions` / `−deletions` tally.
- Body: `<pre>` of diff lines — additions `--color-success`, deletions `--color-danger`, context `--color-text-secondary`, hunk headers muted on a faint secondary background. `max-h-80 overflow-y-auto`, `overflow-x-auto`.
- All colors via `var(--color-*)`.

## Tests

- `npx vitest run src/renderer/src/utils/applyPatch.test.ts` (or `npm test` for the full suite). Vitest config (`vitest.config.ts`) runs node-env over `src/**/*.test.ts`; the parser is pure so it needs no DOM.

## Security

- Diff content renders as React children (text nodes), never `innerHTML`/`dangerouslySetInnerHTML` — no markup injection from patch payloads.
