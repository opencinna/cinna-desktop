# Kit Contract & Manifest Layer — Technical Details

Implementation reference for [Kit Contract & Manifest Layer](kit_contract.md).

## File Locations

### Bundled kit (data, not code — core's render, never edited here)

The contract members, which the app reads:

| Path | What it is |
|------|-----------|
| `resources/cinna-agent-kit/kit.json` | Core's kit descriptor: `contract_version` (the authority), `kit_version`, core's public-cloud URLs, the CLI pin, the guide ladder. It also names the kit-only files below (`START.md`, `tools/kit.py`, `guides/`); nothing here reads those keys |
| `resources/cinna-agent-kit/CONTRACT_VERSION` | Plain-text contract version. Fallback only — `kit.json`'s `contract_version` is the authority |
| `resources/cinna-agent-kit/CHANGELOG.md` | Core's per-version entries, including the note on the versions the desktop minted before 1.5.0, plus the Compatibility table every host applies |
| `resources/cinna-agent-kit/schema/cinna-agent.schema.json` | JSON Schema 2020-12 for `cinna-agent.json`; every property annotated with `x-scope` / `x-import` |
| `resources/cinna-agent-kit/schema/publications.schema.json` | Schema for the sibling `publications.json` ledger |
| `resources/cinna-agent-kit/layout.json` | Folder model: workshop and agent roles, `survives_update` flags, `scaffold_ignore_files`, `desktop_owned`, `cloud_import_excludes`, `secret_files`, `local_command_runner` |
| `resources/cinna-agent-kit/conformance/` | `README.md` (format and matching rule) and `manifests/*.json`, the cases `conformance.test.ts` runs |
| `resources/cinna-agent-kit/templates/root/` | Workshop skeleton: `AGENTS.md`, `CLAUDE.md`, `README.md`, dotless `gitignore` |
| `resources/cinna-agent-kit/templates/agent/` | Agent skeleton: `cinna-agent.json` with `{{TOKEN}}` placeholders, `AGENTS.md`, `CLAUDE.md`, `README.md`, `Makefile`, `pyproject.toml`, `.python-version`, `workspace_requirements.txt`, `.claude/settings.local.json`, `docs/`, `scripts/`, `credentials/`, `knowledge/`, `skills/`, `config/`, `files/`, `app-data/{storage,cache,uploads}/` |

The kit-only members, carried for the workshop copy and never read by the app (except the one path building mode names):

| Path | What it is |
|------|-----------|
| `resources/cinna-agent-kit/VERSION` | The kit content hash (core's `_content_version`, equal to `kit.json`'s `kit_version`). What `syncWorkshopKit` compares a workshop copy the desktop installed on (and requires, for a copy to count as complete). **Never** a contract version |
| `resources/cinna-agent-kit/README.md`, `START.md` | The kit's index and an assistant's starting point, which the root template's `AGENTS.md` sends it to |
| `resources/cinna-agent-kit/guides/*.md` | The numbered guide ladder |
| `resources/cinna-agent-kit/assistants/*.md` | Per-host notes (`claude-code.md`, `codex.md`, `cinna-desktop.md`, `other.md`). `cinna-desktop.md` is the file building mode names — `KIT_DESKTOP_NOTES` in `promptAssembly.ts` |
| `resources/cinna-agent-kit/tools/kit.py` | Core's kit tool (Python ≥3.10, run with `uv run`). Shipped 0755; the desktop never runs it |
| `resources/cinna-agent-kit/desktop_contract_answers.md` | Core's answers to the desktop's contract questions; documentation only |

### Bundle tooling

- `scripts/kit-sync/sync.mjs` — `make kit-sync`. Renders the whole of core's `docs/local_agent_kit/` as core's `LocalAgentKitService` does, checks the rendered `VERSION` against the kit hash it computed, and swaps the result into `resources/cinna-agent-kit/`. See [Updating the bundle](#updating-the-bundle)
- `scripts/kit-sync/bundleFiles.ts` — `applyTarballModes()` (directories and `.py` 0755, other files 0644, as in core's tarball) and `freshWorkDir()`
- `src/main/kit/treeSwap.ts` — `swapInto(staging, target, rename?, remove?)`: replaces a tree wholesale by two renames on one filesystem. The previous tree is parked at `<staging>.previous` and renamed back if the second rename fails, so the target is never missing; the staging tree is removed on every failure path, and when the previous tree cannot be put back either, the error names where it is. Removing the staging or parked tree is best-effort through an injectable `remove`, so a leftover never turns a finished swap into a failure nor hides the rename error; callers clear leftovers on their next run (`freshWorkDir`, the workshop sync's stale-staging sweep). Shared by `sync.mjs` (into `resources/`) and `syncWorkshopKit` (into `<root>/.cinna-kit/`), so it imports only `node:` builtins and logs nothing
- `.gitignore` — `!/resources/cinna-agent-kit/**`, so a global ignore cannot keep a bundle file out of the repository (see [The bundle is core's](kit_contract.md#the-bundle-is-cores-and-is-never-edited-here))
- `scripts/kit-sync/kit.lock.json` — what the last sync rendered: core commit, whether core's tree was dirty, `contract_version`, `kit_version`, `file_count`, `tree_hash`
- `src/main/kit/contractTreeHash.ts` — the tree hash, shared by the script and the test: sha256 over `<path>\0<sha256 of file>\n` per file, POSIX paths sorted by UTF-8 bytes. Imports only `node:` builtins so `node --experimental-strip-types` can run it; a symlink or other non-regular entry is an error

### Shared (main + renderer, type-only and pure)

- `src/shared/kit/manifest.ts` — `CinnaAgentManifest` and its member types (`CredentialSlot`, `AgentSchedule`, `AgentHandover`, `AgentPrompts`, `AgentFeatures`, `AgentRuntimeRef`, `AgentPublication`, `AgentCloudStamp`), plus `MANIFEST_TOKENS`, `SLUG_PATTERN`, `ENV_PREFIX_PATTERN`, `RUN_REFERENCE_PATTERN`, `MANIFEST_FILE`, `DESKTOP_STATE_FILE`
- `src/shared/kit/contractVersion.ts` — `parseSemver()`, `compareSemver()`, `compareVersionStrings()`, `checkContractCompatibility()`, and the `ContractCompatibilityStatus` union

### Main process

- `src/main/kit/contractStore.ts` — resolves and caches the active contract; reads schema, layout, template roots
- `src/main/kit/manifestIo.ts` — read/parse/serialize/write `cinna-agent.json`, stamps, the modified-underneath guard, temp sweeping
- `src/main/kit/validator.ts` — the TS port of `kit.py validate`
- `src/main/kit/layout.ts` — typed view over `layout.json`, glob matching, command localization
- `src/main/kit/exportTree.ts` — export file list, content hash, total size
- `src/main/kit/miniYaml.ts` — the small YAML reader, and the one frontmatter writer
- `src/main/kit/hash.ts` — `sha256Hex()`, the one digest both `exportTree` and `manifestIo` use
- `src/main/errors.ts` — `KitError` / `KitErrorCode`

### Tests

`src/main/kit/contractStore.test.ts`, `contractVersion.test.ts`, `exportTree.test.ts`, `layout.test.ts`, `manifestIo.test.ts`, `miniYaml.test.ts`, `validator.test.ts`, `treeSwap.test.ts` (the previous tree is put back when the swap fails, a missing target is installed into, and a parked tree that cannot be removed does not fail a finished swap, and an unrecoverable swap names where the previous tree is), and two that are about the bundle itself:

- `contractBundle.test.ts` — the bundle matches the lock's tree hash and file count (a hand edit fails here, naming `make kit-sync`); `CONTRACT_VERSION`, `kit.json`, `layout.json` and the lock agree on one version; the bundle is the full kit (`README.md`, `START.md`, `VERSION`, `tools/kit.py`, `assistants/cinna-desktop.md` and at least one guide) and its `VERSION` is the lock's `kit_version`; `tools/kit.py` is executable and the rest has core's tarball modes; and `isSecretFile()` agrees with the bundled `secret_files`, the export exclusion and each `gitignore` template on its own
- `conformance.test.ts` — runs every `conformance/manifests/*.json` case through `validateManifest()`. A finding's code is turned into a field path by dropping `manifest.` and keeping the longest leading run of segments that names a field in the bundled schema; nothing is special-cased, so a code that does not name its field is a validator bug

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
- `readVersionAt(root)` — a tree's contract version: `kit.json`'s `contract_version`, else `CONTRACT_VERSION`, else null. Exported so `syncWorkshopKit` reads a workshop's version exactly as resolution does
- `getContractVersion()`, `getSchema()`, `getLayout()`, `getLayoutView()`, `getTemplateRoot(kind)` — cached accessors

`kit.json`'s `contract_version` is read first; `CONTRACT_VERSION` is the fallback. `VERSION` is **never** read here: in the bundle and in every full kit it holds the *kit* content hash. Its one reader is `syncWorkshopKit` in `agentsHomeService.ts`, which compares it as a hash (see [Folder Index (tech)](folder_index_tech.md#srcmainserviceslocalagentsagentshomeservicets)).

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
  - `isExcludedFromExport(relPath)` — `cloud_import_excludes` **or** `secret_files`. Applied in `collectExportFiles`, so it governs the files hashed as well as the ones copied
  - `isSecretFile(relPath)` — `secret_files` alone
  - `survivesUpdate(relPath)` — unknown paths survive: a refresh never removes something the contract does not claim
  - `localizeCommand(command, {hasPyproject})` — first matching rule wins; an unevaluable condition runs the command unchanged and warns once per rule via `warnUnknownCondition()`
  - `scaffoldIgnoreFiles(kind)` — the dotless→dotted pairs for one template tree
  - `desktopOwned()`
- `normalizeRelPath(relPath)` — POSIX, root-relative, no `./`, no trailing slash
- `isSecretByRules(rules, relPath)` — the `secret_files` evaluator, answering as cinna-cli's `is_secret_filename` does: clauses (`basename_equals` / `basename_prefix` / `basename_suffix`) test the basename at any depth, rules OR together. Fail-safe by position: a rule that is not an object is secret outright; an unevaluable `match` clause (absent, empty, not an object, unknown key, no usable string) counts as a hit, an unevaluable `unless` as a miss
- `DEFAULT_SECRET_FILE_RULES` — the dotenv rule, used when a layout has no non-empty `secret_files.rules`. `parseLayout` keeps the declared rules **unnarrowed** (`SecretFileRule = unknown`): filtering an unreadable entry at parse time would switch its fail-safe off one function early
- `matchesPattern(pattern, relPath)` — the exclude-glob matcher: trailing slash = directory and everything under it, `*` within a segment, `**` across segments, anchored at the root unless it opens with `**`

### `src/main/kit/validator.ts`

Entry points:

- `validateManifest(manifest, options)` — every check that needs no filesystem. Exported so an in-memory manifest (an editor, the scaffolder) can be checked before it is written
- `validateAgentFolder(agentDir, options)` — manifest plus everything only the folder can answer. `contractVersion` is **required** here (`ValidateFolderOptions`), because a caller that forgot it used to disable the gate silently
- `isValid(report)` — `errors.length === 0`
- `readCommandCatalog(agentDir, relPath?)` → `{commands, unreadable}`
- `readMakefileTargets(agentDir)` → `Set<string>` (`.PHONY` and pattern rules excluded)

Manifest handovers retain the existing slug schema. Contract 1.3 adds optional string target_kind without an enum; only the exact coordinator pair receives desktop handback meaning. The validator rejects a malformed known pair, preserves absent-kind sibling behavior and grants no authority to unknown strings. See [manifest handback](../../jobs/tasks/manifest_handback_tech.md) for main eligibility and the qualified older-tool compatibility boundary.

Manifest checks: `checkIdentity()`, `checkString()`, `checkPrompts()`, `checkExamplePrompts()`, `checkRuntime()`, `checkCredentials()`, `checkSchedules()`, `checkHandovers()`, `checkPublications()`.

`checkRuntime()` grades `runtime.complexity` as a **warning** in both of its cases — an unrecognised tier, and `model` plus `complexity` together — never an error, because an error here removes the folder from the engine rather than annotating it. `runtime.engine` is the same: an unrecognised name warns `manifest.runtime.engine` ("…runs on OpenCode instead"), and `claude`/`codex` beside a credential warns. See [Reading is tolerant, writing is strict](kit_contract.md#reading-is-tolerant-writing-is-strict).

**A finding's code names its field**, because the conformance set matches findings by field path and derives the path from the code. So a type error in the runtime block is `manifest.runtime.<key>.type` (`model`, `credential`, `engine`, `permissions`), and `manifest.runtime.type` is left for `runtime` itself not being an object; the coordinator-pair error is `manifest.handovers.target_kind.coordinator_target`, under the field that asked for a coordinator; and the legacy warning is `manifest.schema_version.restamp`. Each of those had a code naming no field, or the wrong one, until the conformance set ran against this validator. Anything that reads findings by code — tests, UI filters — must use these.

Folder checks (`checkFiles()`), in order: prompt files exist and are non-empty → catalogued commands have Makefile targets and readable definitions → `status_refresh_command`'s `/run:<name>` resolves → every `scripts/*.py` is mentioned in `scripts/README.md` → `app-data/storage/STATUS.md` parses as frontmatter with a `status` field → `checkSecrets()` → an info when the folder predates the active contract.

Notable constants: `KNOWN_CREDENTIAL_TYPES` (unknown → warning, never rejection), `SCHEDULE_TYPES`, `CRON_PATTERN`, `UUID_PATTERN`, `COMMAND_NAME_PATTERN`, `SECRET_LOOKALIKE` (`runtime.credential` must be a reference, so an `sk-`/`ghp_`/`AKIA`-shaped value is an error telling the user to rotate it), `UNWALKED_DIRS`.

**Deliberately not ported** from `kit.py validate`: `_validate_requirements`, which reconciles an agent's `pyproject.toml` against the cloud workspace's `requirements.txt` and can rewrite the latter. The desktop has no Python at runtime and must not rewrite a file an assistant owns. That is a decision, not an omission — see the module header and the handover's "One divergence we should agree on".

#### `checkIdentity()` and the legacy exemption

`isLegacy` is `contract_version === undefined && id === undefined && schema_version !== undefined`. A legacy manifest gets one `manifest.schema_version.restamp` warning and returns. Anything else requires both fields and runs the gate:

| Gate status | Finding |
|-------------|---------|
| `ok` | none |
| `app_too_old` | error `contract.app_too_old` |
| `migratable` | warning `contract.migratable` |
| `unknown` | error `manifest.contract_version.invalid` |
| no `contractVersion` supplied | info `contract.unchecked` |

This must stay identical to the conditional `allOf` in `schema/cinna-agent.schema.json` and to the CHANGELOG's Compatibility table. The schema's `$comment` says so. Those two are core's: a change starts there, arrives through `make kit-sync`, and `checkIdentity()` follows in the same commit as the sync.

#### `readCommandCatalog()` and issue attribution

`sequenceEntrySpans(text, 'commands')` computes the line span of each `- ` entry in the top-level sequence. An issue from `parseWithIssues()` is blamed on the entry whose span contains its line; that entry is pushed to `unreadable` and **not** offered. An issue falling outside every span is recorded with `name: null`. The validator turns each into an **error** `commands.unparseable` — the entry would otherwise become a `/run:` button executing something other than what the file says.

#### `isSecretFile()` and `isIgnoredPath()`

`isSecretFile(rel, layout?)` — true for `credentials.json`, `*.pem`, `*.key`, `*.p12`, and every dotenv shape (`.env`, `.env.<suffix>`, `<name>.env`) not ending `.example`, `.sample` or `.template`; with a layout, also for anything its `secret_files` rules call secret. The rule is built in so the check holds without a layout. Its other copies — `secret_files`, `cloud_import_excludes`, and the agent and root `gitignore` templates — are all core's; `contractBundle.test.ts` checks this function against them.

`isTemplateCoveredSecret(rel)` (private) — the shapes the desktop's agent `gitignore` template always ignored: `credentials.json`, `*.env` (not `.env.example`), `*.pem`, `*.key`, `*.p12`. It decides the grade below.

`checkSecrets()` walks the folder with `listFilesRecursively(agentDir, '', true)` — dotfiles included for this check only, dot *directories* and `UNWALKED_DIRS` still skipped — and keeps what `isSecretFile(rel, layout)` accepts. For each hit:

- no ignore rule covers it → `secrets.not_ignored`, an **error** when `isTemplateCoveredSecret` accepts the path (someone removed a rule), otherwise a **warning** whose message names the line to add (`.env.*` for a `.env.<suffix>`) — the pre-1.5.0 templates never had that line, so the folder is not at fault
- the layout would let it travel → `secrets.exported`, an error

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
- `parseFrontmatter(text)` → `{data, body, issues} | null` for `---`-delimited frontmatter (STATUS.md, and a Claude folder subagent's `.claude/agents/*.md`). `issues` is the same list `parseWithIssues` returns, so a caller that acts on the values — [the Claude engine's subagent reader](claude_engine_tech.md#folder-subagents-claudeagentsts) — can refuse the file rather than pass on a value that is plausible and wrong
- `parseScalar(raw)` — quoted strings, `null`/`~`, booleans, ints, floats, simple `[a, b]` inline sequences
- `formatFrontmatter(data, body?)` → the `---`-delimited block above a markdown body — the module's **one writer**, used by the [exported handoff note](../../jobs/tasks/handoff_note_export.md). Flat scalars only (`string | number | boolean | null`); `undefined` omits the key, since an optional field left out is a different claim from one written as `null`

`MiniYamlIssue.code` is one of:

| Code | Shape | What the reader would return instead |
|------|-------|--------------------------------------|
| `block_scalar` | `key: \|` or any of `>`, `\|-`, `>-`, `\|+`, `>+`, `\|2`, `>2` | the marker itself, e.g. `"\|"`; the block body is dropped |
| `skipped_line` | a line indented past every key above it | nothing — the text is silently dropped |
| `inline_comment` | an unquoted value containing `" #"` | everything before the `#`, i.e. a shorter string |

Internals: `toLines()` (tabs→2 spaces, blanks/comments/document markers dropped, 1-based line numbers kept for attribution), `noteScalarIssues()`, `splitKey()`, `parseBlock()` / `parseMap()` / `parseSequence()`, `stripComment()`, `unquote()`, `hasInlineComment()`. Reading never throws — a file it cannot make sense of returns `{data: {}, issues: []}`. **Writing does**, on a key or a number it cannot promise to read back: `formatFrontmatter` is called with values from code, so an input it would mangle is a mistake to be told about rather than a line to emit and regret.

**The writer's contract is the round trip, in three parts**: `parseFrontmatter(formatFrontmatter(data, body))` returns that data, that body, **and an empty `issues` list**. The third part is the one that matters, because of what this subset does to input it cannot represent — it returns a plausible wrong value rather than failing, so a writer that emits an issue-producing line is writing a file it cannot read. Four rules fall out of it:

- **Strings are always quoted, never bare.** A bare scalar round-trips for most strings and then silently changes `42`, `true`, `null`, `~`, `[a]`, a leading `-` and anything containing `" #"` into something else. Two characters removes the whole class, and there is then no judgement call to get wrong.
- **Line terminators and control characters are folded to spaces.** Not "control characters" as `< 0x20` — U+2028 and U+2029 are not in that range and `splitKey`'s `.` does not match them, so a value carrying one fails to split, the line is dropped, and **the key is silently absent from the document with no issue reported**: the one outcome this module exists to prevent. U+0085 is folded with them because a real YAML reader — which is what an agent reading the file will use — treats it as a break. Tabs and newlines are folded because `toLines()` rewrites them before a quote is ever considered, so a literal one cannot survive whatever the writer does — and an unfolded newline in a title would end the frontmatter block early and lose *the rest of the fields*, not just that value.
- **A number that would render in exponential notation is refused.** JavaScript switches to it below 1e-6 and at or above 1e21, and neither numeric pattern in the reader accepts an exponent — `0.0000001` would come back as the string `'1e-7'` with no issue raised. The rendered token is checked against the reader's own grammar, which catches `NaN` and the infinities for free.
- **`__proto__` is refused as a key.** It passes the key pattern and still does not survive: `parseMap` assigns onto an object literal, where it is a setter, so the line is written, parsed, and the key is simply not in the result. Refused in the writer rather than fixed in the reader — the reader's behaviour is older than the writer and shared with the kit's own files.

### `src/main/kit/exportTree.ts`

- `collectExportFiles(agentDir, layout)` — sorted agent-relative POSIX paths surviving `cloud_import_excludes`. **Symlinks are skipped as entries and never traversed**, so a folder that travels cannot reach outside itself. An unreadable directory is logged and skipped
- `hashExportFiles(agentDir, files)` → `{contentHash, unreadable}` — SHA-256 over `` `${rel}\0${sha256(bytes)}\n` `` lines, paths re-sorted defensively. An unreadable file folds in the fixed `UNREADABLE_MARKER` (`\0unreadable`) instead of a digest
- `buildExportTree(agentDir, layout)` → `{files, contentHash, totalBytes, unreadable}`; `KitError('export_failed')` when the folder itself cannot be stat'd

**Publish must refuse while `unreadable` is non-empty.** The hash stays stable and comparable, but it describes a tree that does not exist: recorded on a publication it reads as "up to date" forever, and on a scan it looks like drift that never resolves.

cinna-core must be able to compute the identical value — see the handover's "Same `content_hash`" conformance section.

### `src/main/kit/hash.ts`

`sha256Hex(data)` — one function, shared by `exportTree` and `manifestIo` so "are these the same bytes" is answered the same way in both. Neither may answer it from metadata: `cp -p`, `rsync -t` and several editors preserve mtime and size across a rewrite.

## Configuration

- **Contract version**: whatever core minted, in `CONTRACT_VERSION`, `kit.json` and `layout.json` — `contractBundle.test.ts` holds all three and the lock to one value. `1.5.0` at the time of writing. A scaffolded folder records whatever this build bundles, which is what the scanner and agents-home tests assert rather than a pinned literal. The fields the desktop introduced — `runtime.complexity`, `runtime.engine` (deliberately without an enum), `handovers[].target_kind` — are core's schema since 1.5.0; see [The Claude Engine](claude_engine.md) and [The Codex Engine](codex_engine.md) for how the engine is read
- **No refresh endpoint.** The desktop's retired `kit.json` declared a `refresh` block; core's has none, and nothing in the desktop fetches a kit or runs `kit.py`. A workshop's `.cinna-kit/` is read for [contract resolution](kit_contract.md#contract-resolution) and written only by the [workshop sync](kit_contract.md#the-workshop-copy-installed-where-missing-kept-current-only-where-the-desktop-put-it), from the bundle, and only where it is missing, broken or marked as the desktop's install. In a tree it owns the sync also keeps `.cinna-kit/.last_refresh_check` under a day old so the root `AGENTS.md` never sends an assistant to `kit.py refresh`; a kit the user downloaded gets neither
- **`STALE_TEMP_MS`**: 60 000 ms, in `src/main/kit/manifestIo.ts`
- No environment variables, no app settings, no user-facing configuration

## Updating the bundle

```
make kit-sync                      # core at $CINNA_CORE_PATH, else ../workflow-runner-core, working tree
make kit-sync CORE=<path>          # another checkout
make kit-sync REF=<rev>            # core at a git revision instead of its working tree
```

The script reads core's kit tree, `backend/app/services/cli/local_agent_kit_service.py` and `backend/app/core/config.py`; mirrors the service's snapshot, render and content-version logic; checks every constant it mirrors against core's source; and **stops rather than guessing** when the CLI defaults or the token set cannot be read unambiguously. It keeps every rendered file — there is no member filter — and **stops when the rendered `VERSION` is not the kit hash it computed**, because that is the one place core writes its own answer to "what did this render hash". It builds in `scripts/kit-sync/.work/` (gitignored, outside `resources/` so packaging never sees a half-built tree), applies core's tarball modes, swaps the tree in with `swapInto`, and rewrites `kit.lock.json`.

Never edit `resources/cinna-agent-kit/` or the lock by hand; a change the desktop needs goes into core first. After a sync, in the same commit:

- run `npm test` — `contractBundle.test.ts` and `conformance.test.ts` are where a new render first disagrees with the desktop's code
- check that git holds every file the lock counts: `git status resources/cinna-agent-kit` should list each new file, and `git ls-files resources/cinna-agent-kit | wc -l` should equal the lock's `file_count` once staged. The `.gitignore` un-ignore covers the global ignores seen so far; a file dropped anyway is only noticed when a clean checkout fails the tree-hash test
- if `WORKFLOW_PROMPT.md` changed, re-check `SCAFFOLD_PLACEHOLDER_LINE` in `draftService.ts`, which is copied from it
- if the template token set changed, re-check `SUBSTITUTED_FILES` in `scaffoldService.ts`
- if `assistants/cinna-desktop.md` moved or was renamed, update `KIT_DESKTOP_NOTES` in `promptAssembly.ts` — building mode names the file only when it exists, so a stale path fails silently rather than loudly
- if the root template's freshness rule changed (the `.last_refresh_check` name, its period, or `kit.py`'s stamp format), re-check `REFRESH_CHECK_FILE`, `REFRESH_CHECK_MAX_AGE_MS` and `refreshCheckStamp()` in `agentsHomeService.ts`
- check the lock's `core_dirty`: `true` means the render came from uncommitted core work and cannot be reproduced from a commit

A render with any changed file changes `VERSION`, so once the build ships every workshop `.cinna-kit/` the desktop installed is replaced on its next pass — any file in it that is not in the new render is gone. A kit the user downloaded is not affected.

## Packaging

Three entries in `electron-builder.yml` work together, and changing one alone breaks `bundledContractDir()` in `src/main/kit/contractStore.ts`:

| Entry | Purpose |
|-------|---------|
| `extraResources: [{from: resources/cinna-agent-kit, to: cinna-agent-kit}]` | Copies the tree to `Resources/cinna-agent-kit` as a **real directory**, with no asar shim in the read path |
| `files: ['!resources/cinna-agent-kit/**']` | Keeps the tree **out of the asar** so it is not packed twice — once inside and unpacked again by `asarUnpack`, once as an extra resource |
| `asarUnpack: ['resources/**']` | Pre-existing, for the icon PNGs imported with electron-vite's `?asset`. The `files` exclusion above is what stops it matching the contract |

Both `electron-builder.yml` and `contractStore.ts` carry reciprocal comments pointing at each other; read both before touching either.

**`afterPack` makes the shipped tree whole.** electron-builder's directory walker (builder-util `walk`) drops every `.gitkeep` and `.DS_Store` before any file pattern is consulted, and creates no empty directories, so the templates' `files/`, `app-data/uploads/` and `app-data/storage/` used to vanish from packaged builds — scaffolded agents lacked them and the workshop kit was not core's tree. No `extraResources` filter can prevent it. `scripts/packaged-kit.cjs` (`completePackagedKit`, called at the end of `afterPack` in `scripts/packaged-dependencies.cjs`) copies back every bundle file the shipped tree lacks, mode included, then fails the build unless the shipped tree's file count and tree hash equal `scripts/kit-sync/kit.lock.json` — the same hash `contractBundle.test.ts` pins the repo copy to, restated in CommonJS. `scripts/packaged-kit.test.cjs` (in `npm run test:packaging`) simulates the filtered copy and checks the restore, the mode of `tools/kit.py`, and that a changed file still fails.

Path resolution is lazy (`app.isPackaged` is only consulted inside the function) so the module is importable before `app.whenReady()`:

- packaged → `join(process.resourcesPath, 'cinna-agent-kit')`
- development → `join(app.getAppPath(), 'resources', 'cinna-agent-kit')`

The contract is read as a *tree* — schema, layout, and templates copied file by file — so electron-vite's `?asset` import (single files, as `src/main/host/desktop/appIconService.ts` uses) does not apply.

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
