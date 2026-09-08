# Kit Contract & Manifest Layer

## Purpose

Cinna Desktop ships a pinned, machine-readable copy of the cinna-core agent start-kit's **contract** — the manifest schema, the folder-layout rules, and the root/agent templates — plus a TypeScript reader, validator and exporter for it. It is what lets the desktop scaffold, read, validate and export kit-shaped agent folders entirely offline: no Python, no network, no cinna-core.

This is Phase 1 of [Local Agents](#integration-points): the foundation every later phase reads. It has no UI, no IPC and no database.

## The governing principle

**Files are the truth; the database is an index.** Nothing in this layer writes to SQLite, and nothing definitional about an agent lives there. An agent folder on disk is the agent; the `agents` row a later phase derives from it is a cache that can be dropped and rebuilt at any time. If a rule here and a row there disagree, the folder wins.

Three parties write these folders and never talk to each other — this desktop, a coding assistant working in the folder, and cinna-core at import time. Every rule below exists because of that.

## A folder that keeps none of it

Everything in this document describes a **kit** folder: one that has a `cinna-agent.json`, and with it an identity, a contract version, prompt documents at known paths, credential slots, a command catalog, a runtime it names and an export tree that can be published.

A folder can also be an agent by keeping **none** of that. A directory holding an `AGENT.md` is a [bare agent](bare_agents.md): no manifest, no layout, no version, no validation against this contract. The desktop reads that one file as the system prompt, runs the folder on the default runtime, and keeps its own state outside it.

The two are not a spectrum, and nothing here is relaxed to accommodate the other:

- **Nothing in this layer runs on a bare folder.** The reader, the validator, the contract gate, the exporter and the scaffolder are all kit-only. `local-agent:validate` short-circuits before reaching them, because this validator run on a bare folder reports a wall of errors about a contract the folder never agreed to keep
- **The contract is not loosened to make bare folders legal.** `AGENT.md` is not a manifest with fewer fields; it is not read by the schema, not versioned, and not part of `layout.json`. A folder either makes the manifest's promises or makes none of them
- **The kit is what a folder gains by being scaffolded**, and this is the clearest statement of what that is worth: commands, credential slots, example prompts, publications, a content hash, a durable UUID identity, and a runtime the folder itself chooses. A bare folder has none of them, and the trade is deliberate — it is somebody's existing repository, and asking it to be converted first is asking for a change nobody wanted

## Core Concepts

- **Kit Contract** — The bundled tree at `resources/cinna-kit-contract/`: `kit.json` (identity + version), `VERSION`, `CHANGELOG.md`, `schema/cinna-agent.schema.json`, `layout.json`, and the two template trees. Pinned at contract version `1.1.0`
- **Agent Manifest** — `cinna-agent.json` at an agent folder's root. The one file every tool that touches the folder agrees on: identity, prompts paths, credential slots, schedules, handovers, publications
- **Agents Root** (a.k.a. workshop) — The folder agent folders live under. May carry its own `.cinna-kit/` copy of the contract, pulled by a later contract refresh
- **Contract Version** — Semver on the folder and on the tool. The compatibility gate — see [Three versions, three questions](#three-versions-three-questions)
- **Kit Version** — Which start-kit scaffolded the agent. Informational, never a gate
- **Content Hash** — A stable SHA-256 over the files that would travel to a Cinna instance. Answers "has this agent changed since it was pushed to that instance?"
- **Legacy Manifest** — A manifest carrying the integer `schema_version` and neither `contract_version` nor `id`. Predates contract 1.0.0; read and warned about, never rejected
- **Export Tree** — The cloud-import view of an agent folder: the sorted list of files that travel, their total size, the content hash, and any files that could not be read
- **Finding** — One validation result: a stable dotted `code`, a message, and an optional agent-relative `path`. Graded `error` / `warning` / `info`

## Three versions, three questions

Three version-ish values live on an agent, and confusing them is the classic way this breaks. Each answers exactly one question.

| Value | Question it answers | Behaviour |
|-------|--------------------|-----------|
| `contract_version` | *Can this tool operate this folder?* | The gate. Folder major **newer** than the tool's → refuse, tell the user to update the app. Folder major **older** → run, and offer migration if the CHANGELOG documents the gap. **Same major** → run as-is, whatever the minor. Absent or unparseable → `unknown`: read the folder, ask for a re-stamp |
| `kit_version` | *Which kit scaffolded this agent?* | Informational only. **Never** branch on it, never gate on it |
| `content_hash` | *Has this agent changed since it was pushed to that instance?* | Recorded per publication. A mismatch against the current export means the instance is behind |

The gate is applied identically by the desktop, by `kit.py validate` and by cinna-core — the rules table lives in `resources/cinna-kit-contract/CHANGELOG.md` under "Compatibility", and the desktop's copy is `src/shared/kit/contractVersion.ts`.

`schema_version` is a fourth, retired value: still parsed so an old folder opens, but it decides nothing.

## User Stories / Flows

### Reading a folder
1. A caller resolves the active contract for the workshop the folder lives in
2. It reads `cinna-agent.json` and gets back the manifest plus a **stamp** — the fingerprint a later write will compare
3. It validates the folder against the contract, getting `{errors, warnings, infos}` back. The validator never throws
4. The contract gate runs as part of validation: a folder from a newer contract major surfaces as an error, not a crash

### Saving an edit to a manifest
1. The page holds the manifest and the stamp it was read with
2. On save the layer re-stamps the file on disk and compares
3. If it still matches, the manifest is written atomically (temp file → fsync → rename), unknown keys and key order intact
4. If it does not match, the write is **refused** with `manifest_modified` and the page prompts a reload — an assistant's edit is never clobbered

### Preparing a folder for publish
1. The folder is walked, applying the contract's `cloud_import_excludes`. Symlinks are never followed and never listed
2. The surviving paths are sorted and hashed into a single `sha256:<hex>` content hash
3. Any file whose bytes could not be read lands in `unreadable`
4. **Publish must refuse while `unreadable` is non-empty** — the hash is still stable and comparable, but it no longer describes the bytes that would be uploaded

### Offering an agent's commands
1. `docs/CLI_COMMANDS.yaml` is read with the small hand-rolled YAML reader <!-- nocheck -->
2. Any entry the reader knows it would mis-read is **dropped**, and reported as a validation **error**
3. Only entries read exactly as written are offered as `/run:<name>`

## Business Rules

### The legacy exemption, and the three places that must agree

A manifest carrying `schema_version` but neither `contract_version` nor `id` is a legacy folder. It must still parse — it is read, reported, and re-stamped, never rejected. Every *other* manifest requires both fields.

That is why `contract_version` and `id` are **not** in the schema's top-level `required`. The requirement is expressed instead as a conditional `allOf` in `resources/cinna-kit-contract/schema/cinna-agent.schema.json`: *if* legacy, nothing extra; *else* require both.

Three artefacts encode this same rule and must be changed in the same commit:

1. The schema's conditional `allOf`
2. `checkIdentity()` in `src/main/kit/validator.ts`
3. The Compatibility section and the 1.0.0 Breaking entry in `resources/cinna-kit-contract/CHANGELOG.md`

The schema carries a `$comment` saying exactly this. **The coupling is load-bearing**: an earlier mismatch between the schema and the validator would have made cinna-core reject folders the desktop happily accepts — the folder travels, the import fails, and nothing on the desktop side saw it coming.

### Secret files never travel

Anything that can hold a credential **value** is excluded from what travels and from what is committed:

- `credentials.json` — the cloud's own credential file (slot → field → *value*), injected by the platform at the **agent root**, and what `scripts/cinna_credentials.py` reads in the cloud. A folder that has ever run in the cloud can otherwise carry live values home
- Any `.env` — **except** `.env.example`
- `*.pem`, `*.key`, `*.p12`

Enforced at four independent layers, so no single mistake leaks:

| Layer | File | What it stops |
|-------|------|---------------|
| Export exclude list | `cloud_import_excludes` in `resources/cinna-kit-contract/layout.json` | The file travelling to a Cinna instance |
| Agent ignore template | `resources/cinna-kit-contract/templates/agent/gitignore` | The file being committed from an agent folder |
| Workshop ignore template | `resources/cinna-kit-contract/templates/root/gitignore` | The same, from the workshop root |
| Validator secret check | `isSecretFile()` in `src/main/kit/validator.ts`, with `isIgnoredPath()` deciding whether a rule already covers it | The user shipping one unknowingly — reported as an **error** |

`isSecretFile()` carries a **"change one, change all three"** comment naming the list, `cloud_import_excludes`, and the agent `gitignore` template as copies of one rule. Treat the root `gitignore` template as a fourth copy of the same rule.

Two files in `credentials/` **deliberately travel**: `credentials/README.md` and `credentials/.env.example`. They document slot names and variable naming and carry no value. `credentials/.env` never travels. That asymmetry is intentional — an imported agent should still explain what credentials it needs.

`templates/agent/credentials/.gitignore` keeps its dot on purpose, while the other ignore templates ship dotless and have the dot restored at scaffold time (see [Scaffold ignore files](#scaffold-ignore-files)). It names files no repository should ever track, and that has to be true of the contract's own repository too.

### Manifest writes are content-hash guarded

A stamp is `{mtimeMs, size, hash}`. Metadata is a cheap pre-check — different mtime or size already proves a change, so the file is not re-read — but the **SHA-256 decides**.

The failure this prevents: a concurrent writer replacing the file at **equal size with preserved timestamps**. `cp -p`, `rsync -t`, `git checkout` and several editors do exactly this, which defeats an mtime+size stamp entirely — the guard would report "unchanged" for precisely the writers it exists to catch, and the desktop would silently overwrite an assistant's edit.

`mtimeNs` plus inode was considered and rejected: it is platform-variable, still metadata, and still loses to a preserving writer.

### Orphaned temp files are swept

Writes are atomic through a temp file in the same directory. If the process is killed between `open` and `rename`, no catch block runs and the temp file survives forever. So temp files older than **60 seconds** are swept on **both read and write** — younger ones may belong to another process writing the same folder right now. The exclude list also drops `**/*.tmp`, so an orphan can never reach a Cinna instance; the sweep is about not confusing whoever opens the folder next.

### The YAML reader fails loudly rather than parsing cleverly

`src/main/kit/miniYaml.ts` handles a deliberately small subset — indentation maps and sequences, scalars, comments, quotes, simple inline lists. It does **not** handle block scalars (`|`, `>`), inline mappings, anchors, tags, or multi-document streams.

The danger is not that unsupported input fails. It is that **it comes back as a plausible wrong value**. A block scalar yields the marker `"|"`. An unquoted `python x.py --tag #1 --keep` yields `"python x.py --tag"` — a *different, shorter command*, and Phase 7 hands that value straight to a subprocess.

So the three shapes that do this are detected, not guessed at:

- a bare block-scalar marker
- an over-indented line with no key to attach it to, dropped silently
- an unquoted value containing `" #"`

`parseWithIssues()` returns `{data, issues}` flagging them by line. `readCommandCatalog()` returns `{commands, unreadable}` and **drops only the entry an issue falls inside**, blaming it by line span rather than discarding the whole file. The validator reports each as `commands.unparseable` — an **error**, not a warning, because a host would otherwise offer a `/run:` button that executes something other than what is written.

**`parseMiniYaml()` remains, and discards issues.** It is for display-only callers that never execute the result — reading STATUS.md frontmatter, for instance. If a value will be run, published, or otherwise acted on, use `parseWithIssues()`. This distinction is the whole point of the module having two entry points.

### Validation severity

- **error** — the folder is broken or would import wrong: a missing required field, a prompt file that is not there, an exposed secret, an unresolvable `/run:`, an unreadable command. The agent is not run
- **warning** — it runs, but is stale or not cloud-ready: no example prompts, an uncatalogued script, a command with no Makefile target, an unrecognised credential `type` (the platform's list grows independently, so an unknown one is reported, never rejected), a legacy manifest
- **info** — worth knowing: the folder predates the active contract, or still carries the deprecated `cloud` stamp

The validator **never throws**. Its callers are a scanner and a page, and neither may crash on a file someone is mid-edit.

#### Reading is tolerant, writing is strict

The two grades are not interchangeable, and an `error` is not a stronger message — it is a decision about whether the agent exists. The scanner turns any error into readiness `invalid`, and an `invalid` folder is dropped from the engine config entirely, so an error is "this folder does not run".

That is why everything a **newer minor** of the contract might add is reported as a warning. The two `runtime.complexity` cases are the worked example: a value outside the three the contract defines, and a manifest carrying `model` *and* `complexity` at once. Erroring on either would brick a folder written by a future 1.x tool, which is precisely what "minor bumps are additive and safe to ignore" promises against and what the compatibility gate — same major, run as-is — says will not happen. Both have defined behaviour instead of a refusal: an unrecognised tier reads as no tier, and where both keys are present the **model wins**.

Writing is the other half, and it is strict: this desktop refuses to write either shape. Tolerating what another tool wrote and being careless about what we write are different jobs, and a tool that emitted a manifest its own validator then flagged would be teaching the user to ignore its own findings.

### Scaffold ignore files

Ignore rules ship **dotless** in the template trees and the scaffolder restores the dot in the created folder — shipping them dotted would make them live ignore rules wherever the contract is stored, hiding scaffold files from that repository. The pairs are declared in `layout.json`'s `scaffold_ignore_files`, per template tree, and a scaffolder must read that list rather than hard-code it: the set has already grown once (`app-data/cache/gitignore`), and a scaffolder that missed the addition left a cache folder tracked by git.

### Contract resolution

The bundled contract is always present. A workshop may additionally carry `.cinna-kit/`, pulled by a later contract refresh. The workshop copy wins **only** when its major matches the bundled one *and* its version is newer. A workshop copy with a newer major is deliberately not adopted — a newer major means the app itself is out of date, and the per-agent gate reports `app_too_old` rather than the app quietly running against a contract this build does not understand.

### Content hash construction

Precise enough to reimplement, because cinna-core must compute the same value:

- Walk the agent folder, applying `cloud_import_excludes`
- **Symlinks are never followed and never listed**
- Sort the surviving agent-relative paths, POSIX separators
- Feed the digest one line per file: `<relative path>\0<sha256 hex of the file bytes>\n`
- Emit `sha256:<hex>` of that stream

No mtime, no inode, no size, no directory order, nothing machine-specific. Two machines holding the same files produce the same hash. A file whose bytes cannot be read folds in a fixed marker instead of a digest — the hash stays stable and comparable, but the file is reported in `unreadable`, and publish must refuse until that list is empty.

### Local command localization

`docs/CLI_COMMANDS.yaml` is written cloud-first (`python scripts/x.py`). `layout.json`'s `local_command_runner` rules turn such a command into the one a local host should run — `python ` / `python3 ` → `uv run `, conditional on the agent having a `pyproject.toml`. Every scaffolded agent ships one for exactly that reason. A rule whose condition this build cannot evaluate runs the command **unchanged** (the safe direction) and logs a warning once, because a silently skipped rule is how a rule stops working without anyone noticing. <!-- nocheck -->

## Architecture Overview

```
resources/cinna-kit-contract/          (bundled, pinned at 1.1.0)
  kit.json  VERSION  CHANGELOG.md
  schema/cinna-agent.schema.json       <- the manifest rules
  layout.json                          <- the folder model as data
  templates/root/  templates/agent/    <- what a scaffold copies
            |
            v
  contractStore  ->  resolves bundled vs. workshop .cinna-kit/
            |
   +--------+---------+----------+-----------+
   |        |         |          |           |
 layout  validator  manifestIo  exportTree  miniYaml
   |        |         |          |           |
   +--------+---------+----------+-----------+
            |
   agent folder on disk  <-- the source of truth
            |
   (Phase 2+) scanner -> agents row  <-- a derived index only
```

No IPC, no renderer, no SQLite in this layer.

## Integration Points

- [Open in… (Local Agent Tools)](open_in_tools.md) — Phase 4 of the same feature; hands a validated agent folder to the user's own assistant or editor. Shares the Agents Root concept
- [Bare Agents & External Roots](bare_agents.md) — the other kind of folder agent: what an `AGENT.md`-only folder is, and everything in this document it does not keep
- [Main-Process Layering](../../development/main_layering/main_layering_llm.md) — `KitError` follows the standard `DomainError` code convention
- [Database Migrations](../../development/migrations/migrations_llm.md) — relevant only to note that this layer adds *none*

## Technical Details

See [Kit Contract (tech)](kit_contract_tech.md).
