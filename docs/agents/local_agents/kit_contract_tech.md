# Kit Contract & Manifest Layer — Technical Details

Implementation reference for [Kit Contract & Manifest Layer](kit_contract.md).

## File Locations

### Bundled contract (data, not code)

| Path | What it is |
|------|-----------|
| `resources/cinna-kit-contract/kit.json` | Contract identity, `contract_version`, pointers to the schema/layout/templates, and the `refresh` endpoint shape a later phase will use |
| `resources/cinna-kit-contract/VERSION` | Plain-text version. Fallback only — `kit.json`'s `contract_version` is the authority |
| `resources/cinna-kit-contract/CHANGELOG.md` | Per-version Breaking / Added / Changed entries, plus the Compatibility table both sides apply |
| `resources/cinna-kit-contract/schema/cinna-agent.schema.json` | JSON Schema 2020-12 for `cinna-agent.json` |
| `resources/cinna-kit-contract/layout.json` | Folder model: workshop and agent roles, `survives_update` flags, `scaffold_ignore_files`, `desktop_owned`, `cloud_import_excludes`, `local_command_runner` |
| `resources/cinna-kit-contract/templates/root/` | Workshop skeleton: `AGENTS.md`, `CLAUDE.md`, `README.md`, dotless `gitignore` |
| `resources/cinna-kit-contract/templates/agent/` | Agent skeleton: `cinna-agent.json` with `{{TOKEN}}` placeholders, `AGENTS.md`, `CLAUDE.md`, `README.md`, `Makefile`, `pyproject.toml`, `docs/`, `scripts/`, `credentials/`, `knowledge/`, `config/`, `files/`, `app-data/{storage,cache,uploads}/` |

### Shared (main + renderer, type-only and pure)

- `src/shared/kit/manifest.ts` — `CinnaAgentManifest` and its member types (`CredentialSlot`, `AgentSchedule`, `AgentHandover`, `AgentPrompts`, `AgentFeatures`, `AgentRuntimeRef`, `AgentPublication`, `AgentCloudStamp`), plus `MANIFEST_TOKENS`, `SLUG_PATTERN`, `ENV_PREFIX_PATTERN`, `RUN_REFERENCE_PATTERN`, `MANIFEST_FILE`, `DESKTOP_STATE_FILE`
- `src/shared/kit/contractVersion.ts` — `parseSemver()`, `compareSemver()`, `compareVersionStrings()`, `checkContractCompatibility()`, and the `ContractCompatibilityStatus` union

### Main process

- `src/main/kit/contractStore.ts` — resolves and caches the active contract; reads schema, layout, template roots
- `src/main/kit/manifestIo.ts` — read/parse/serialize/write `cinna-agent.json`, stamps, the modified-underneath guard, temp sweeping
- `src/main/kit/validator.ts` — the TS port of `kit.py validate`
- `src/main/kit/layout.ts` — typed view over `layout.json`, glob matching, command localization
- `src/main/kit/exportTree.ts` — export file list, content hash, total size
- `src/main/kit/miniYaml.ts` — the small YAML reader
- `src/main/kit/hash.ts` — `sha256Hex()`, the one digest both `exportTree` and `manifestIo` use
- `src/main/errors.ts` — `KitError` / `KitErrorCode`

### Tests

`src/main/kit/contractStore.test.ts`, `contractVersion.test.ts`, `exportTree.test.ts`, `layout.test.ts`, `manifestIo.test.ts`, `miniYaml.test.ts`, `validator.test.ts`.

## Database Schema

**None.** This layer never touches SQLite. Files are the truth; the `agents` row a later phase derives from a folder is an index. Nothing here adds a table, a column or a migration.

## IPC Channels

**None.** Phase 1 is main-process-only. The renderer reaches nothing here directly; later phases expose folder operations through their own services and channels.

## Preload / Renderer

**None.** `src/shared/kit/*` is importable from the renderer (it is type-only and dependency-free, so the agent page can type its manifest), but nothing under `src/main/kit/` is reachable from it.

## Services & Key Methods

### `src/main/kit/contractStore.ts`

- `getBundledContractDir()` — absolute path of the contract shipped with this build; throws `KitError('contract_missing')` when the tree is not where packaging should have put it
- `resolveContract(workshopRoot?)` — the contract to use, `{root, version, source: 'bundled' | 'workshop'}`. A workshop `.cinna-kit/` wins only on **matching major** and a **newer** version; a newer major is logged and ignored so the per-agent gate can report `app_too_old`
- `clearContractCache()` — drops the per-workshop cache after a refresh swaps a tree
- `readContractFile(relPath, workshopRoot?)` — contract-relative read with containment checks; `KitError('invalid_path')` for anything escaping the tree
- `getContractVersion()`, `getSchema()`, `getLayout()`, `getLayoutView()`, `getTemplateRoot(kind)` — cached accessors

`kit.json`'s `contract_version` is read first; `VERSION` is the fallback, because a workshop's `.cinna-kit/VERSION` may hold the *kit* version rather than the contract's when the full kit is installed there.

### `src/main/kit/manifestIo.ts`

- `manifestPath(agentDir)`
- `readStamp(path)` — `{mtimeMs, size, hash}` or `null`
- `stampsMatch(current, expected)` — metadata short-circuit, SHA-256 decides. Exported so every "refuse to save over a changed file" guard in the app answers this the same way
- `parseManifest(text, path?)` — `KitError('manifest_invalid_json' | 'manifest_not_object')`
- `readWithStamp(path)` / `readManifest(path)` — `KitError('manifest_not_found' | 'manifest_unreadable')`
- `serializeManifest(manifest)` — 2-space JSON, trailing newline, key order preserved
- `writeManifest(path, manifest)` — unconditional atomic write; returns the new stamp
- `writeIfUnchanged(path, manifest, stamp)` — `KitError('manifest_modified')` when the file changed underneath

Internal: `writeAtomically()` (temp → `writeSync` → `fsyncSync` → `renameSync`, unlinking the temp on a caught failure) and `sweepStaleTemps()`.

**Temp-file sweeping.** Temps are named `.cinna-agent.json.<pid>.<ms>.tmp`. `sweepStaleTemps()` runs on **both** `readWithStamp()` and `writeAtomically()` and removes matching files older than `STALE_TEMP_MS` (60 000). Both call sites are needed: the error-path `unlink` cannot run after a SIGKILL or a power loss, so a read is also an opportunity to clear an orphan. Younger temps are left alone — they may belong to another process writing the same folder.

**Round-trip fidelity.** A manifest is parsed into a plain object and written back from that same object, so a key this build has never heard of survives byte-identical. Every interface in `src/shared/kit/manifest.ts` carries an index signature to make that typed rather than accidental.

### `src/main/kit/layout.ts`

- `parseLayout(raw)` — tolerant parse of `layout.json`; never throws, degrades to `EMPTY_LAYOUT` with a warning
- `createLayoutView(layout)` → `LayoutView`:
  - `agentRoles()` / `workshopRoles()` — sorted longest-path-first, so the first hit is the most specific
  - `roleFor(relPath)` — the agent-folder role covering a path
  - `isExcludedFromExport(relPath)` — `cloud_import_excludes` applied
  - `survivesUpdate(relPath)` — unknown paths survive: a refresh never removes something the contract does not claim
  - `localizeCommand(command, {hasPyproject})` — first matching rule wins; an unevaluable condition runs the command unchanged and warns once per rule via `warnUnknownCondition()`
  - `scaffoldIgnoreFiles(kind)` — the dotless→dotted pairs for one template tree
  - `desktopOwned()`
- `normalizeRelPath(relPath)` — POSIX, root-relative, no `./`, no trailing slash
- `matchesPattern(pattern, relPath)` — the exclude-glob matcher: trailing slash = directory and everything under it, `*` within a segment, `**` across segments, anchored at the root unless it opens with `**`

### `src/main/kit/validator.ts`

Entry points:

- `validateManifest(manifest, options)` — every check that needs no filesystem. Exported so an in-memory manifest (an editor, the scaffolder) can be checked before it is written
- `validateAgentFolder(agentDir, options)` — manifest plus everything only the folder can answer. `contractVersion` is **required** here (`ValidateFolderOptions`), because a caller that forgot it used to disable the gate silently
- `isValid(report)` — `errors.length === 0`
- `readCommandCatalog(agentDir, relPath?)` → `{commands, unreadable}`
- `readMakefileTargets(agentDir)` → `Set<string>` (`.PHONY` and pattern rules excluded)

Manifest checks: `checkIdentity()`, `checkString()`, `checkPrompts()`, `checkExamplePrompts()`, `checkRuntime()`, `checkCredentials()`, `checkSchedules()`, `checkHandovers()`, `checkPublications()`.

`checkRuntime()` grades `runtime.complexity` as a **warning** in both of its cases — an unrecognised tier, and `model` plus `complexity` together — never an error, because an error here removes the folder from the engine rather than annotating it. See [Reading is tolerant, writing is strict](kit_contract.md#reading-is-tolerant-writing-is-strict).

Folder checks (`checkFiles()`), in order: prompt files exist and are non-empty → catalogued commands have Makefile targets and readable definitions → `status_refresh_command`'s `/run:<name>` resolves → every `scripts/*.py` is mentioned in `scripts/README.md` → `app-data/storage/STATUS.md` parses as frontmatter with a `status` field → `checkSecrets()` → an info when the folder predates the active contract.

Notable constants: `KNOWN_CREDENTIAL_TYPES` (unknown → warning, never rejection), `SCHEDULE_TYPES`, `CRON_PATTERN`, `UUID_PATTERN`, `COMMAND_NAME_PATTERN`, `SECRET_LOOKALIKE` (`runtime.credential` must be a reference, so an `sk-`/`ghp_`/`AKIA`-shaped value is an error telling the user to rotate it), `UNWALKED_DIRS`.

**Deliberately not ported** from `kit.py validate`: `_validate_requirements`, which reconciles an agent's `pyproject.toml` against the cloud workspace's `requirements.txt` and can rewrite the latter. The desktop has no Python at runtime and must not rewrite a file an assistant owns. That is a decision, not an omission — see the module header and the handover's "One divergence we should agree on".

#### `checkIdentity()` and the legacy exemption

`isLegacy` is `contract_version === undefined && id === undefined && schema_version !== undefined`. A legacy manifest gets one `manifest.legacy` warning and returns. Anything else requires both fields and runs the gate:

| Gate status | Finding |
|-------------|---------|
| `ok` | none |
| `app_too_old` | error `contract.app_too_old` |
| `migratable` | warning `contract.migratable` |
| `unknown` | error `manifest.contract_version.invalid` |
| no `contractVersion` supplied | info `contract.unchecked` |

This must stay identical to the conditional `allOf` in `schema/cinna-agent.schema.json` and to the CHANGELOG's Compatibility table. The schema's `$comment` says so; change all three in one commit.

#### `readCommandCatalog()` and issue attribution

`sequenceEntrySpans(text, 'commands')` computes the line span of each `- ` entry in the top-level sequence. An issue from `parseWithIssues()` is blamed on the entry whose span contains its line; that entry is pushed to `unreadable` and **not** offered. An issue falling outside every span is recorded with `name: null`. The validator turns each into an **error** `commands.unparseable` — the entry would otherwise become a `/run:` button executing something other than what the file says.

#### `isSecretFile()` and `isIgnoredPath()`

`isSecretFile(rel)` — true for `credentials.json`, `.env` / `*.env`, `*.pem`, `*.key`, `*.p12`; false for anything ending `.env.example`. It carries the **"change one, change all three"** comment: this list, `cloud_import_excludes` in `layout.json`, and `templates/agent/gitignore` are copies of one rule. (`templates/root/gitignore` is a fourth.)

`checkSecrets()` walks the folder (`listFilesRecursively()` skips dotfiles and `UNWALKED_DIRS`), then explicitly adds the dotted paths the contract names — `credentials/.env` and `.env` — because the walk would otherwise miss the file that matters most. For each hit it emits `secrets.not_ignored` when no ignore rule covers it, and `secrets.exported` when the contract's exclude list would let it travel.

`IGNORE_SOURCES` lists the `.gitignore` files that can cover a path, outermost first (`../../.gitignore`, `../.gitignore`, `.gitignore`, `credentials/.gitignore`), each with a function re-basing the agent-relative path into that file's own frame. **Scope is the trap here**: `credentials/.gitignore` governs `credentials/` and nothing else, so a `credentials.json` at the *agent root* is not covered by the `credentials.json` line inside it. Reading every ignore file into one flat set — which an earlier revision did — reports such a file as safe when it is committable.

`isIgnoredPath()` evaluates the sources in order, last match wins, `!` negations honoured, deepest file last — git's own resolution order. `ignorePatternMatches()` implements the subset:

- anchoring is decided from the pattern **as written** — a leading *or* interior slash anchors it
- a slashless pattern matches any path segment at any depth
- a trailing slash restricts the pattern to directories (matched against every segment above the file)
- character classes and intra-segment `**` are delegated to `matchesPattern()`

> **Known-fragile area.** This matcher was written twice from the same mental model, and made a related false-negative error each time — first by flattening the ignore sources, then by deciding anchoring *after* stripping the leading slash (which made `/credentials.json` unanchored, so a nested `scripts/credentials.json` reported as ignored when git would happily commit it). **Both errors leaked in the same direction, and both survived a passing test suite.** Treat any pattern syntax not in the list above as unverified until someone probes it against real `git check-ignore` output, and prefer adding a probe over adding a rule.

### `src/main/kit/miniYaml.ts`

- `parseWithIssues(text)` → `{data, issues}` — **use this whenever the values will be executed, published, or otherwise acted on**
- `parseMiniYaml(text)` → `data` only — **display-only callers**, which is why it still exists
- `parseFrontmatter(text)` → `{data, body} | null` for `---`-delimited STATUS.md frontmatter
- `parseScalar(raw)` — quoted strings, `null`/`~`, booleans, ints, floats, simple `[a, b]` inline sequences

`MiniYamlIssue.code` is one of:

| Code | Shape | What the reader would return instead |
|------|-------|--------------------------------------|
| `block_scalar` | `key: \|` or any of `>`, `\|-`, `>-`, `\|+`, `>+`, `\|2`, `>2` | the marker itself, e.g. `"\|"`; the block body is dropped |
| `skipped_line` | a line indented past every key above it | nothing — the text is silently dropped |
| `inline_comment` | an unquoted value containing `" #"` | everything before the `#`, i.e. a shorter string |

Internals: `toLines()` (tabs→2 spaces, blanks/comments/document markers dropped, 1-based line numbers kept for attribution), `noteScalarIssues()`, `splitKey()`, `parseBlock()` / `parseMap()` / `parseSequence()`, `stripComment()`, `unquote()`, `hasInlineComment()`. Never throws — a file it cannot make sense of returns `{data: {}, issues: []}`.

### `src/main/kit/exportTree.ts`

- `collectExportFiles(agentDir, layout)` — sorted agent-relative POSIX paths surviving `cloud_import_excludes`. **Symlinks are skipped as entries and never traversed**, so a folder that travels cannot reach outside itself. An unreadable directory is logged and skipped
- `hashExportFiles(agentDir, files)` → `{contentHash, unreadable}` — SHA-256 over `` `${rel}\0${sha256(bytes)}\n` `` lines, paths re-sorted defensively. An unreadable file folds in the fixed `UNREADABLE_MARKER` (`\0unreadable`) instead of a digest
- `buildExportTree(agentDir, layout)` → `{files, contentHash, totalBytes, unreadable}`; `KitError('export_failed')` when the folder itself cannot be stat'd

**Publish must refuse while `unreadable` is non-empty.** The hash stays stable and comparable, but it describes a tree that does not exist: recorded on a publication it reads as "up to date" forever, and on a scan it looks like drift that never resolves.

cinna-core must be able to compute the identical value — see the handover's "Same `content_hash`" conformance section.

### `src/main/kit/hash.ts`

`sha256Hex(data)` — one function, shared by `exportTree` and `manifestIo` so "are these the same bytes" is answered the same way in both. Neither may answer it from metadata: `cp -p`, `rsync -t` and several editors preserve mtime and size across a rewrite.

## Configuration

- **Contract version**: pinned at `1.1.0` in `resources/cinna-kit-contract/kit.json` and `VERSION`, and mirrored in `layout.json`'s `contract_version`. All three move together with the CHANGELOG entry and any schema change the bump describes; a scaffolded folder records whatever this build bundles, which is what the scanner and agents-home tests assert rather than a pinned literal. `1.1.0` added the optional `runtime.complexity` enum (`simple` | `medium` | `complex`), additively: a 1.0.0 folder is read and written unchanged, and a 1.0.0 tool ignores the key and reads `runtime.model` as before
- **Contract refresh endpoints**: declared but unused in Phase 1 — `kit.json`'s `refresh` block names `base_url`, `/contract/version`, `/contract.tar.gz` and `install_dir: .cinna-kit`. A later phase implements the fetch and the atomic swap
- **`STALE_TEMP_MS`**: 60 000 ms, in `src/main/kit/manifestIo.ts`
- No environment variables, no app settings, no user-facing configuration

## Packaging

Three entries in `electron-builder.yml` work together, and changing one alone breaks `bundledContractDir()` in `src/main/kit/contractStore.ts`:

| Entry | Purpose |
|-------|---------|
| `extraResources: [{from: resources/cinna-kit-contract, to: cinna-kit-contract}]` | Copies the tree to `Resources/cinna-kit-contract` as a **real directory**, with no asar shim in the read path |
| `files: ['!resources/cinna-kit-contract/**']` | Keeps the tree **out of the asar** so it is not packed twice — once inside and unpacked again by `asarUnpack`, once as an extra resource |
| `asarUnpack: ['resources/**']` | Pre-existing, for the icon PNGs imported with electron-vite's `?asset`. The `files` exclusion above is what stops it matching the contract |

Both `electron-builder.yml` and `contractStore.ts` carry reciprocal comments pointing at each other; read both before touching either.

Path resolution is lazy (`app.isPackaged` is only consulted inside the function) so the module is importable before `app.whenReady()`:

- packaged → `join(process.resourcesPath, 'cinna-kit-contract')`
- development → `join(app.getAppPath(), 'resources', 'cinna-kit-contract')`

The contract is read as a *tree* — schema, layout, and templates copied file by file — so electron-vite's `?asset` import (single files, as `src/main/services/appIconService.ts` uses) does not apply.

> **The packaged branch has never been executed.** `contractStore.test.ts` covers the development path only, and nothing verifies the packaged one until someone builds an installer and inspects it. If `extraResources` is ever dropped, the packaged path would have to rely on Electron redirecting asar reads to `app.asar.unpacked` — documented behaviour, but unverified here, so prefer the explicit copy.

## Security

- **No secret ever reaches this layer's outputs.** Credential *values* live only in `credentials/.env` and (in the cloud) `credentials.json`; neither is read, exported, hashed into a manifest, or surfaced. The four exclusion layers are listed in [Secret files never travel](kit_contract.md#secret-files-never-travel)
- **`runtime.credential` is a reference, never a key.** A value matching `SECRET_LOOKALIKE` (`sk-`, `sk_`, `ghp_`, `gho_`, `xox[baprs]-`, `AIza`, `AKIA`) or longer than 200 characters is an error telling the user to remove and rotate it
- **Path containment.** `readContractFile()` normalizes, rejects absolute paths and `..` escapes, and re-checks the resolved target is inside the contract root before reading
- **Symlinks never travel.** `collectExportFiles()` neither lists nor follows them, so an export cannot reach outside the agent folder
- **Atomic writes.** Temp → fsync → rename means a concurrent reader never sees half a manifest; the content-hash stamp means a concurrent *writer* is never silently overwritten
- **Executed strings are only ever the ones read exactly as written.** Any command the YAML reader may have mangled is dropped from the catalog and reported as an error, before Phase 7 can hand it to a subprocess

## Error Codes

`KitErrorCode` in `src/main/errors.ts`:

| Code | Raised by |
|------|-----------|
| `contract_missing` | `getBundledContractDir()` — a packaging mistake |
| `contract_unreadable` | `resolveBundled()`, `readContractFile()`, `getSchema()`, `getLayout()` |
| `invalid_path` | `readContractFile()` for anything escaping the contract tree |
| `manifest_not_found` | `readWithStamp()` on `ENOENT` |
| `manifest_unreadable` | `readWithStamp()` on any other read failure |
| `manifest_invalid_json` | `parseManifest()` |
| `manifest_not_object` | `parseManifest()` |
| `manifest_modified` | `writeIfUnchanged()` — the concurrent-write guard |
| `write_failed` | `writeAtomically()`, `writeManifest()` |
| `export_failed` | `buildExportTree()` |

`validateAgentFolder()` catches `KitError` from the manifest read and reports it as a finding coded `manifest.<code>` rather than letting it escape — the validator's contract is that it never throws.

The sibling `LocalAgentErrorCode` and `LocalToolsErrorCode` unions cover what happens *around* a folder (roots, the scanner, the scaffolder) and the machine's own tools respectively; kit-level failures stay on `KitErrorCode`.
