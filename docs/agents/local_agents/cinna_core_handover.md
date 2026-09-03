# Cinna Desktop → cinna-core: what the start-kit and the server need

A request from the cinna-desktop team to the cinna-core team, covering the changes the
agent start-kit (`kit.py`, guides, templates, schema) and the Cinna server need so that
Cinna Desktop's **Local Agents** feature and the kit produce, read and publish the *same*
agent folders.

## Status, honestly

- The desktop has **authored a candidate contract tree** in its own repo at
  `resources/cinna-kit-contract/` (`kit.json`, `VERSION`, `CHANGELOG.md`,
  `schema/cinna-agent.schema.json`, `layout.json`, `templates/root/`, `templates/agent/`),
  pinned at `contract_version 1.0.0`. That tree is what this document means whenever it
  says "the authored contract". **It has not been published, reviewed by you, or verified
  against `kit.py` or a real server.** Treat it as a concrete proposal, not a fait accompli.
- On the desktop side, the contract *reader* is built and unit-tested: `src/main/kit/`
  (`contractStore`, `layout`, `manifestIo`, `validator`, `exportTree`) and
  `src/shared/kit/` (`manifest`, `contractVersion`). The **scaffolder, scanner, publish
  path and silent link are not written yet** — they are the phases that consume this
  handover, and they are being built against the shapes described here.
- **No server endpoint in section 8 has been called by anything.** Every one of them is
  specified from the design proposal, and the desktop guards each with a capability probe
  that degrades to an existing flow.
- Everything asserted here about the *current* kit comes from an excerpt set we were given
  (the schema, guides 01/02/08/09/12, the root `AGENTS.md` template, the kit `CHANGELOG.md`
  and a function-name outline of `kit.py`). Where we could not check a claim, it is marked
  as an **assumption to confirm** rather than stated as fact. Section 12 lists them all.

Where the desktop's *design proposal* and the *authored contract* disagree, this document
follows the authored contract and calls the divergence out — the design doc is the older
artefact and is stale on those points.

---

## Changes since first issue (revision 2, 2 Sep 2026)

If you already read revision 1, these are the only things that moved. **Section numbers are
unchanged on purpose** — anything you have already cited still points where it did.

1. **A credential leak in the export was found and fixed, and it changes
   `cloud_import_excludes` and both `gitignore` templates.** `credentials.json` — the file the
   *platform itself* writes at the agent root, holding slot → field → **value** — travelled in
   the export and was not git-ignored. See the callout at the head of §6; the exclude list in
   §9.3 changed with it. **This one has a direct question for you: if `kit.py`'s export or
   `_validate_secrets` shares the shape of the bug we found, it has the bug.**
2. **`layout.json` gains `scaffold_ignore_files`** — the dotless→dotted pairs, per template
   tree, as data. Previously that list existed only as prose, so a scaffolder driven by the
   contract alone restored two of three files. §5 (`restore_scaffold_ignore_files`), §6, §9.1.
3. **`templates/agent/pyproject.toml` now ships.** The `local_command_runner` rule is
   conditional on `pyproject.toml` existing, and the template shipped none — so a scaffolded
   agent's `/run:` commands ran bare `python`, contradicting the guides. §6, §9.1.
4. **`commands.unparseable` is a new validator error**, from three `CLI_COMMANDS.yaml` shapes
   the desktop's YAML reader silently got wrong. §9.2 — and, like item 1, it comes with a
   question about whether your YAML handling has the same class of defect.
5. **Manifest write safety (desktop-internal, no action).** The modified-underneath guard is
   now `{mtimeMs, size, hash}` with a SHA-256 content hash; mtime+size alone silently clobbered
   a concurrent writer at equal size with preserved timestamps (`cp -p`, `rsync -t`,
   `git checkout`). Mentioned in §5 only because `kit.py` writes the same file.

Nothing in §3 (manifest fields), §4 (versioning), §7 (the root path), §8 (server endpoints),
§10 or §11 changed. §12's assumption list gained two entries and A1 is untouched.

---

## A note on paths in this document

Three different trees are discussed here and their paths look alike, so they are written
differently throughout:

| Written as | Means | Example |
|---|---|---|
| `src/...`, `resources/...`, `docs/agents/...` | A file in the **cinna-desktop repository**. These are pointers to our implementation, for when you want to see what we actually do | `src/main/kit/validator.ts` |
| `kit.json`, `layout.json`, `schema/...`, `templates/...`, `VERSION`, `CHANGELOG.md` | Relative to the **contract root** — `resources/cinna-kit-contract/` in our repo, `.cinna-kit/` once installed in a workshop | `templates/agent/gitignore` |
| `Local/<slug>/...` | Inside an **agent folder**. Where the surrounding sentence has already established that we are inside one, the prefix is dropped and the path is agent-relative | `Local/<slug>/docs/CLI_COMMANDS.yaml`, then `scripts/README.md` |

The one that catches people is the third: an agent folder has its own `docs/`, `scripts/`,
`config/` and `README.md`, and none of them is this repository's.

---

## 1. What this is and why

A local agent is a plain folder laid out exactly as the kit lays out an agent under
`Local/<slug>/`: `cinna-agent.json`, the three prompt docs and the command catalog under
`Local/<slug>/docs/`, then `scripts/`, `knowledge/`, `config/`, `credentials/` and
`app-data/`. Cinna Desktop is adding an Agents tab that creates such folders in one click,
runs them through a bundled OpenCode engine on the user's existing AI credentials, and
renders the folder — every card on the agent page names the file it reads. The files are the
source of truth; the app's database holds only a derived index.

That makes three parties co-owners of the same folders, none of which talks to the others:
the **desktop** (creates, runs, visualises), an **assistant** (Claude Code, Codex, OpenCode —
develops the folder using the kit's guides), and **cinna-core** (receives the folder
unchanged at import, and serves the kit that defines its shape). The folder is the only
interface between them, so its shape has to be a published, versioned contract rather than a
convention each side re-implements from prose. The kit is unreleased, so these are design
changes rather than migrations — which is the whole reason to settle them now.

---

## 2. The contract / guides split

**The central structural request.** Today `.cinna-kit/` is one tree: guides, templates,
schema, tools, `VERSION`, `CHANGELOG.md`, refreshed as one tarball. We are asking you to
split the machine-readable half out.

| | Contract | Guides |
|---|---|---|
| Contents | `kit.json`, `schema/`, `templates/`, and a new `layout.json` | `README.md` (the ladder), `guides/`, `assistants/`, `tools/kit.py`, `START.md` |
| Audience | Any program that creates, reads, validates or exports a folder | An assistant reading prose |
| Served at | `GET /api/agent-start/contract.tar.gz`, version at `GET /api/agent-start/contract/version` | unchanged from today |
| Versioned by | `contract_version` (semver) | `kit_version` (unchanged) |
| Who bundles it | Cinna Desktop ships a pinned copy inside the app | nobody; downloaded on demand |

The two exact paths above come from the authored `kit.json` `refresh` block
(`base_url: https://cinna.dev/api/agent-start`, `version_path: /contract/version`,
`tarball_path: /contract.tar.gz`). The design proposal only named the tarball; the version
path is our proposal and **the naming is yours to decide** — the desktop reads both from
`kit.json`, so any pair of paths works as long as `kit.json` declares them. The same two
paths must also be served by a linked Cinna instance under its own origin, because a
desktop linked to `acme.opencinna.io` refreshes from that instance, not from `cinna.dev`.

### Why the desktop needs this

- **It must scaffold and validate offline, with no Python.** A user creating an agent on a
  plane gets a folder that `kit.py validate` will accept. That means the desktop carries the
  schema, the templates and the folder model itself — but it has no business shipping, or
  parsing, the prose guides.
- **A kit update should be able to change desktop behaviour without a desktop release**, for
  anything the contract covers: a new folder role, a new exclude pattern, a new command-runner
  rule, a new ignore file the scaffolder must dot-restore. That only works if those things are
  *data* the desktop reads, which is what `layout.json` is for — and every one of those four
  examples has already changed once during Phase 1.
- **Guides and contract change at different rates.** Guides get edited constantly; the
  contract should move rarely and loudly. One tarball with one version number cannot express
  "the prose improved" and "the folder shape changed" differently, and the desktop would
  have to re-download and re-diff the whole kit to find out which happened.

### What we need from the split, precisely

1. **The contract tarball extracts to a tree whose root holds `kit.json` and `layout.json`.**
   `src/main/kit/contractStore.ts` identifies a contract tree by exactly that pair of files
   at the root, and reads the version from `kit.json` `contract_version` (falling back to a
   `VERSION` file at the same root).
2. **A workshop's `.cinna-kit/` must be readable as a contract tree.** The desktop installs
   the contract *at* `<workshop>/.cinna-kit/` and, when a workshop already has a `.cinna-kit/`
   whose contract major matches the bundled one and whose version is newer, it reads the
   workshop copy instead. If your full-kit installer places the contract at
   `.cinna-kit/contract/` rather than merged at `.cinna-kit/` root, the desktop will not find
   it. **This is open question Q1** — see section 11.
3. **`kit.py` should read the contract from the same place.** `kit_config()` and
   `cloud_import_excludes()` (kit.py:227, :234) currently source the folder rules; after the
   split they should read `layout.json`, so there is one exclude list rather than two.
4. **Two version endpoints.** The guides keep whatever `{{KIT_BASE_URL}}/version` returns
   today (guide 12 documents it). The contract needs its own, so a desktop can ask "is my
   folder model stale?" without downloading anything.

**Degraded behaviour if the split does not happen:** the desktop keeps running on its
bundled contract forever. Everything works; nothing refreshes. `kit.py refresh` and the
desktop then drift apart the first time either side changes the folder shape, which is
exactly the failure this split exists to prevent.

**Divergence from the design doc:** the design's decision 3 says the desktop bundles the
prose guides too, "so building mode can read them". The authored contract tree contains
**no guides**, and the authored root `AGENTS.md` tells an assistant that a desktop-managed
`.cinna-kit/` "may carry the contract only … If `kit.py` is not there, install the full kit".
The desktop's in-app building mode will fetch the guides at that point rather than ship them.

---

## 3. Manifest changes

The authored `schema/cinna-agent.schema.json` is the proposal in full. Field by field:

| Field | Current state (kit schema today) | Requested state | Why | What breaks if skipped |
|---|---|---|---|---|
| `id` | Does not exist. Identity is the `slug`, i.e. the folder name. | UUID v4 string, written **once at scaffold** by `kit.py new` and by the desktop, never rewritten. Required (see the conditional rule below). | The desktop's agent row id is `folder:<manifest id>`, so a folder that moves between roots or gets its slug renamed keeps its chats, sessions, on-demand links and cloud twin attached. Import preserves it as the agent's local origin, which lets a twin be matched without a cloud-written stamp. | Renaming a folder orphans every chat with it, and the desktop has to fall back to path-keyed identity, which breaks the moment a user reorganises `Local/`. |
| `contract_version` | Does not exist. `schema_version` (integer, `const: 1`) is the gate, and per the kit CHANGELOG `kit.py` "refuses a manifest whose `schema_version` is higher than the one it understands". | Semver string, written at scaffold, and recorded again on each publication. **The** compatibility gate; the rules are in section 4. | An integer that only ever goes up cannot say "additive, safe to ignore" versus "a folder role moved". Both sides need to distinguish those or every change becomes a hard break. | Every contract change is breaking-by-default, so nothing can be added without stranding folders — and the desktop cannot tell "written by a newer kit" from "written by a newer *major*". |
| `kit_version` | Exists; `["string","null"]`; described as informational; guide 12 says `kit.py validate` reports at info level when an agent predates the current kit. | Unchanged in type and role — but explicitly **never a gate**, in the schema description and in the guides. | Two numbers with two jobs: `kit_version` answers "which guides and templates made this?", `contract_version` answers "may I operate this?". | Nothing breaks immediately; the risk is a future tool branching on `kit_version` and re-creating the problem `contract_version` solves. |
| `runtime` | Does not exist. | Optional object or null: `{model, credential, permissions}`. `model` is a model id as the host names it; `credential` is a **reference** — a credential *type*, or the *name* of a credential configured in the host — and **never a key, token or secret value**; `permissions` is a host-specific object with unknown keys preserved. Absent means "use the host's default runtime", which is what a fresh scaffold has. | A user who assigns an agent a specific model wants that choice to travel with the folder, and to seed the cloud's per-mode model override at import. It must live in the manifest because the manifest is the only thing that travels. | The desktop stores the choice in SQLite instead, violating the feature's central invariant (files are the truth), and the choice is lost on import. |
| `publications[]` | A single `cloud` object: `{platform_url, agent_id, imported_at}`, "written only by the cloud import step". | An array; one entry per instance the agent was published to. Entry: `platform_url` and `agent_id` **required**; `workspace`, `imported_at`, `updated_at`, `contract_version`, `content_hash` optional and nullable. `workspace` is the account workspace the CLI pushed from, relative to the workshop root (e.g. `Cloud/acme.opencinna.io`), and is **absent when the desktop published directly through the account API**. | One object cannot express an agent published to two instances, which the desktop offers on day one. `content_hash` is what makes "N local changes not published" possible. `contract_version` records what the cloud copy was built against. | Publishing to a second instance silently overwrites the first instance's link, and neither side can tell whether a cloud copy is behind. |
| `cloud` | As above. | **Retained, deprecated, still parsed.** A folder that has it keeps working; tools migrate it into `publications[]` on the next write. | Costs nothing and means no pre-1.0.0 folder is rejected. | Folders scaffolded before the change stop validating. |
| `schema_version` | Integer, `const: 1`, in the top-level `required` list. | **Retained as tolerated legacy**: integer, `deprecated: true`, no `const`, not required, and *nothing branches on its value*. | Legacy folders must read, not reject. | Same as above. |
| `created_at` | Does not exist. | Optional ISO 8601 string or null, written by the scaffolder. Informational. | Cheap, and it makes "when did I make this?" answerable without filesystem mtimes, which do not survive a copy. | Nothing. This one is genuinely optional; drop it if you dislike it. |

### The legacy exemption, encoded

The authored schema keeps `required` at `["name", "slug", "description"]` and adds a
top-level conditional: a manifest that carries `schema_version` and **neither**
`contract_version` **nor** `id` is a legacy folder and is exempt; **any other** manifest must
have both `contract_version` and `id`. That is the same rule the desktop validator's
`checkIdentity()` applies (`src/main/kit/validator.ts`), where a legacy manifest produces a
`manifest.legacy` **warning** with a "re-stamp it" message, not an error. If `kit.py validate`
rejects legacy folders outright, the two validators disagree on exactly the case the
exemption exists for.

**Divergences from the design doc, in this section:**

- The design says "`cloud` becomes `publications[]`" without saying the old key survives. The
  authored contract keeps `cloud` readable and deprecated.
- The design implies `schema_version` is simply replaced. The authored contract retains it,
  drops its `const: 1` constraint, and makes it non-required.
- The design lists the publication entry's seven fields without saying which are required.
  The authored schema requires only `platform_url` and `agent_id`.
- `created_at` is not in the design at all; it is new in the authored contract.

---

## 4. Versioning rules

Three numbers, three questions:

| Number | Lives in | Answers |
|---|---|---|
| `contract_version` | the contract (`kit.json`, and a `VERSION` file at the same root); every manifest at scaffold; every publication at push | *May this tool operate this folder?* Semver. **Major** = breaking (a folder role moved, a manifest field changed meaning). **Minor/patch** = additive, safe to ignore. |
| `kit_version` | `.cinna-kit/VERSION`; the manifest, informational | *Which guides and templates scaffolded this agent?* For freshness and changelog lookup. Never a gate. |
| `content_hash` | each `publications[]` entry | *Has the folder changed since it was pushed to that instance?* Construction in section 9. |

### The compatibility gate — both sides apply it identically

Compare the folder's `contract_version` major against the tool's contract major:

- **Folder major newer than the tool's** → refuse. The desktop shows "update the app" and
  will not run the agent; `kit.py` should say "refresh the kit" and exit non-zero. Reported
  by the desktop as `contract.app_too_old`.
- **Folder major older than the tool's** → run it, if the changelog documents the migration
  for the gap. The desktop reports `contract.migratable` as a *warning* and offers a
  "Migrate to contract N.0" action later; it does not refuse.
- **Same major, any minor** → run as-is, silently.
- **Unparseable or absent** → legacy. Read it, report it, ask for a re-stamp
  (`manifest.legacy` / `manifest.contract_version.invalid`).

This is implemented in `src/shared/kit/contractVersion.ts` (`checkContractCompatibility`),
and the same table is in the authored contract's `CHANGELOG.md` under "Compatibility". The
server applies it too, at import: gate on `contract_version`, and record it on the
publication so a later desktop can tell what the cloud copy was built against.

Nothing needs a migration on day one. Recording the number from the first scaffold costs
nothing and is what makes every later adjustment possible — which is the entire argument for
doing this before the kit ships rather than after.

---

## 5. `kit.py` changes

Line numbers refer to the `kit.py` outline we were given; treat them as pointers to the
functions, not as current line numbers.

### `new` — `cmd_new` (:708), `substitute_tokens` (:671), `restore_scaffold_ignore_files` (:685), `new_parser` (:1417)

The desktop ships a TypeScript port of this command. For the two scaffolders to produce
**byte-identical** folders, `kit.py new` needs:

- **`--description "<sentence>"`** — the desktop's New-agent flow starts from one sentence,
  and writes it as the manifest `description`. Today the description appears to come from the
  template only (`template_description()` at :918 suggests a template default exists).
- **`--json`** — emit the created agent's path, slug, id and contract version as JSON on
  stdout, so a conformance suite (and any other tool) can drive the command without scraping
  the human-readable "next steps" output.
- **Four new template tokens**: the authored `templates/agent/cinna-agent.json` carries
  `{{CONTRACT_VERSION}}`, `{{ID}}`, `{{CREATED_AT}}` and `{{DESCRIPTION}}` alongside the
  existing `{{NAME}}` / `{{SLUG}}` / `{{KIT_VERSION}}`. `cmd_new` must fill all of them:
  `id` as a fresh UUID v4 (lowercase hex, hyphenated), `created_at` as an ISO 8601 timestamp,
  `contract_version` from the contract in use.
- **Token substitution now spans more than the manifest.** The new
  `templates/agent/pyproject.toml` carries `{{SLUG}}` and `{{DESCRIPTION}}`, so
  `substitute_tokens` must run across the whole created tree, not only
  `cinna-agent.json`.
- **Manifest serialisation must match**: the desktop writes manifests as 2-space-indented
  JSON with a trailing newline, preserving key order and unknown keys
  (`src/main/kit/manifestIo.ts`). If `kit.py` writes different indentation, key order or
  no trailing newline, the trees differ on the one file that matters most.
- **Concurrent-writer guard, if `kit.py` also rewrites a manifest a desktop may hold open.**
  The desktop now stamps a manifest as `{mtimeMs, size, hash}` with a SHA-256 of the exact
  bytes it read, and refuses a write when the stamp no longer matches. mtime + size alone was
  not enough: `cp -p`, `rsync -t` and `git checkout` all produce an equal-size file with a
  preserved timestamp, and the desktop silently clobbered it. Desktop-internal, but the same
  failure mode exists for anything that reads-then-writes `cinna-agent.json`.

### `restore_scaffold_ignore_files` (:685) — now driven by `layout.json`

The intent is unchanged: the contract ships ignore rules **dotless** (`templates/root/gitignore`,
`templates/agent/gitignore`, `templates/agent/app-data/cache/gitignore`) and the scaffolder
restores the dot, because shipping them dotted would make them live ignore rules wherever the
contract is stored, hiding scaffold files from that repository.
`templates/agent/credentials/.gitignore` keeps its dot deliberately — it names files no
repository should track, and that must be true of the contract's own repository too.

What changed is that **the list is now data**: `layout.json` gains a `scaffold_ignore_files`
map keyed per template tree (`agent`, `root`), each entry a `[path in the template tree, path
in the created folder]` pair. Please read it rather than hard-coding the pairs. The prose-only
version of this list is exactly how the desktop's first scaffolder ended up restoring
`gitignore` and missing `app-data/cache/gitignore` — a bug you would inherit the moment a
fourth ignore file is added to a template.

*(Divergence: neither `scaffold_ignore_files` nor the per-tree keying is in the design doc.)*

### `chat` — new verb

`kit.py chat Local/<slug> "<prompt>"` sends a prompt to the agent as the *connected desktop*
runs it, and prints the real answer. This is the honest replacement for guide 10's
"role-play the agent from a cold read", which tests the builder's imagination rather than the
runtime that will answer the user.

- Read `app-data/desktop.json` inside the agent folder. It carries the local API base URL and
  an agent-scoped bearer token, both rewritten by the desktop on every start (the port is
  random) and cleared when the agent's **Connected** toggle is off.
- POST the prompt to that base URL with the token as a bearer credential; the reply streams
  as newline-delimited JSON. The desktop side of this is a loopback-only HTTP server
  (127.0.0.1, random port, no CORS), authenticated per agent.
- **Exit non-zero, with a one-line explanation, when the desktop is not running** — no marker
  file, connection refused, or a 401. Silently falling back to role-play would defeat the
  point.
- **Standard library only**, per the design, so the verb works wherever `kit.py` does.
- The desktop guarantees the two keys `kit.py` needs. The rest of `desktop.json` is
  desktop-owned and may change shape — **open question Q2** covers how much of it we should
  freeze in the contract.

### `list` — `cmd_list` (:1119), `_rungs_present` (:1062), `_print_table` (:1107)

Add a **`DESKTOP`** column: whether an agent folder carries a live `app-data/desktop.json`,
i.e. whether `kit.py chat` will work on it. One glance answers "can I test this for real?".

### `validate` — `validate_manifest` (:355), `validate_agent` (:986), `cmd_validate` (:1017)

- **Gate on `contract_version`** per section 4, replacing the current "refuse a manifest whose
  `schema_version` is higher" rule.
- **Accept and check the new fields**: `id` (UUID shape), `runtime` (`model`/`credential`
  strings or null; `permissions` an object), `publications[]` (entry shape per section 3).
- **Honour the legacy exemption**: `schema_version` with no `contract_version`/`id` is a
  warning and a re-stamp suggestion, not an error.
- **Reject a `runtime.credential` that looks like a key.** The desktop errors on values
  matching `sk-`, `sk_`, `ghp_`, `gho_`, `xox[baprs]-`, `AIza`, `AKIA` or longer than 200
  characters (`manifest.runtime.credential_looks_like_secret`), and tells the user to rotate
  it. A secret in a file that travels to a cloud is the worst outcome this feature can produce.
- **Widen the secret check beyond `.env`, and fix its ignore scoping** — see the callout at
  the head of §6, which is the single most important change in this revision.
  `gitignore_covers_env` (:312) and `_validate_secrets` (:794) are the functions to look at.
- **Treat an unreadable command in `Local/<slug>/docs/CLI_COMMANDS.yaml` as an error, not a
  silent drop** —
  see §9.2. `cli_command_names` (:581) and `_strip_yaml_scalar` (:569) are the functions to
  look at.

### `export` — `cmd_export` (:1335), `is_excluded` (:1304), `cloud_import_excludes` (:234)

- Source the exclude list from `layout.json` rather than wherever it lives today.
- Match patterns with the semantics `layout.json`'s `cloud_import_excludes_notes` documents
  and `src/main/kit/layout.ts` `matchesPattern` implements — see section 9.
- Optionally print the `content_hash` of the exported tree, which makes the conformance check
  in section 9 a one-liner.

### `refresh` — `cmd_refresh` (:1240), `_swap_kit_tree` (:1222), `_parse_remote_version` (:1196)

Unchanged in mechanism. It should be aware that a workshop's `.cinna-kit/` may have been
installed by the desktop and contain the contract only; installing the full kit over it is
the right behaviour, and the authored root `AGENTS.md` already tells assistants to do that.

### One divergence we should agree on: `_validate_requirements` (:831)

The desktop's validator implements the schema checks plus the file-level checks (prompt files
exist, catalogued commands have Makefile targets, `/run:` references resolve, every script is
in `scripts/README.md`, STATUS.md frontmatter parses, no `.env` is committed or exported). It
deliberately does **not** implement the pyproject/workspace-requirements reconciliation, and
it has no `--fix` mode: the desktop has no Python and cannot repair a Python dependency set.

For the conformance check in section 9 to mean anything, the findings that `kit.py` produces
and the desktop does not must be **warnings, not errors** — otherwise a folder the kit calls
broken is a folder the desktop happily runs. We would rather agree on a short, explicit list
of kit-only findings than pretend the two validators are identical.

---

## 6. Template and guide changes

Everything in this section that lives in `templates/` is already written in the authored
contract; the guide changes are yours to write.

### ⚠ Read this first: a credential leak in the export, and the shape of the bug

We found and fixed a real leak in the desktop's implementation. We are describing it in full
rather than as a diff line, because **if `kit.py` has the same shape, it has the same bug, and
this is the kind that ships live credentials to a server.**

**What leaked.** `credentials.json` is the file *the platform itself* writes at the agent root
in the cloud — slot → field → **value** — and it is what
`templates/agent/scripts/cinna_credentials.py` reads there (`CLOUD_CREDENTIALS = AGENT_ROOT /
"credentials.json"`). An agent folder that has ever run in the cloud, or been pulled back with
`cinna dev`, can therefore carry live credential values at its root. Neither the export
exclude list nor either `gitignore` template mentioned that filename. It travelled, and it was
committable.

**Fixed at four layers, all now in the authored contract:**

1. `layout.json` `cloud_import_excludes` gains `credentials.json`, `**/credentials.json`,
   `**/*.pem`, `**/*.key`, `**/*.p12` and `**/*.tmp` (the last catching a half-written file
   from an interrupted atomic write).
2. **Both** `templates/agent/gitignore` **and** `templates/root/gitignore` gain
   `credentials.json`, `*.pem`, `*.key`, `*.p12` — the root one matters because a workshop is
   often one repository.
3. The desktop validator's `checkSecrets` now runs off a single `isSecretFile()` list covering
   all of the above rather than `.env` alone. Its two findings were renamed accordingly:
   `secrets.env_not_ignored` → **`secrets.not_ignored`**, `secrets.env_exported` →
   **`secrets.exported`**. Both are errors.
4. The ignore-matching underneath it was rewritten.

**The shape of the bug, which is the part that generalises.** The old check read every
`.gitignore` it could find and pooled the lines into one flat set. `credentials/.gitignore`
contains a `credentials.json` line — correctly, for files inside `credentials/`. Pooled into a
flat set, that line made a **root-level** `credentials.json` report as *ignored* when git would
happily commit it. A false negative in a secret check: the tool says safe, the file ships.

The fix re-bases the path per ignore-file scope and skips any source that cannot see the file
(`isIgnoredPath` in `src/main/kit/validator.ts`), so `credentials/.gitignore` governs
`credentials/` and nothing else, with last-match-wins and negations honoured, deepest file
last — the way git resolves it.

**What we are asking you to check:** whether `kit.py`'s `gitignore_covers_env` (:312) and
`_validate_secrets` (:794) pool ignore lines across directory scopes, and whether `cmd_export`
(:1335) drops these filenames. If either answer is no, the same folder that is safe in the
desktop is unsafe through the CLI, and the user has no way to know which path their credentials
took.

**What still travels, on purpose:** `credentials/README.md` and `credentials/.env.example`.
They document the slot names and the env-variable shape and carry no value; the platform needs
them to create the credential drafts. `credentials/.env` never travels, and never has.

### The rest

- **`templates/agent/pyproject.toml` now ships.** The `local_command_runner` rule gates
  `python ` → `uv run ` on `file_exists: pyproject.toml`, and the agent template previously
  shipped none — so a freshly scaffolded agent's `/run:` commands ran bare `python`, directly
  contradicting the guides' "never substitute the system `python3`" rule (on macOS that is
  either absent or 3.9). The file is minimal: `[project]` with `{{SLUG}}`, `{{DESCRIPTION}}`,
  `requires-python = ">=3.10"` and no dependencies. Shipping it was chosen over dropping the
  `when` clause, which would make the rule unconditional and therefore wrong for an agent that
  is not Python at all. *(Not in the design doc.)*
- **`Cloud/<host>/` — one account workspace per instance.** `layout.json` declares
  `workshop.cloud_dir: "Cloud"` with the role `cloud_workspaces`, described as "one cinna-cli
  account workspace per instance, named by host". The authored root `AGENTS.md` and
  `CLAUDE.md` say so, and the root `.gitignore` template ignores `Cloud/*/.cinna/`. Guide 11
  (go-cloud) needs the same, and the rule "inside `Cloud/`, that `CLAUDE.md` wins" now applies
  **per subfolder**.
- **`app-data/desktop.json` documented as desktop-owned.** It is named in `layout.json` under
  `desktop_owned`, it is inside `app-data/` which both `gitignore` templates already exclude
  and `cloud_import_excludes` already drops, so **nothing changes mechanically** — the docs
  just have to say so. Guide 03 (scripts and data) should state: it is the desktop's
  per-machine state (local API address, agent token, engine session ids, granted
  permissions), read-only to an assistant, never edited, never committed, never printed. The
  authored per-agent `AGENTS.md` template already carries that line.
- **The root `AGENTS.md` desktop paragraph.** The authored `templates/root/AGENTS.md` adds a
  section, "If this workshop is managed by Cinna Desktop", covering four things: agents may
  appear between an assistant's sessions (re-read `cinna-agent.json`); `app-data/desktop.json`
  is read-only; test through `kit.py chat` instead of role-playing; and a desktop-managed
  `.cinna-kit/` may carry the contract only, without guides or `tools/`. It also adds the
  `chat` row to the commands table.
- **A new `assistants/cinna-desktop.md`.** Notes for the desktop's own in-app building mode:
  it is a sandboxed assistant with no terminal beyond the engine's bash tool, it must not run
  `kit.py refresh`, and it tests through the local API. This one is **not** in the authored
  contract — it belongs with the guides, which we do not ship.
- **Guide 10 (testing locally): test through the runtime.** When `app-data/desktop.json`
  exists, the builder should run **every** example prompt through `kit.py chat` before calling
  an agent finished, and treat a disappointing answer as a bug in the prompt or the scripts,
  not in the answer. Keep the role-play procedure for the no-desktop case.
- **Guide 01 (first agent) §2**: the scaffold command gains `--description`; §6's validate
  step is unchanged.
- **Guide 12 (keeping up to date)**: the rule "a bump of `schema_version` is always breaking"
  becomes "a **major** bump of `contract_version` is always breaking"; add the contract's own
  changelog and version endpoint alongside the kit's.
- **The local command runner moves into `layout.json` as data.**
  `Local/<slug>/docs/CLI_COMMANDS.yaml` stays cloud-first (`python scripts/x.py`, paths relative to the agent root) and the
  `Makefile` stays its local mirror — but the *rule* that turns one into the other is now
  declared, not hand-encoded. The authored `layout.json` `local_command_runner` block has two
  rules: prefix `python ` → `uv run ` and prefix `python3 ` → `uv run `, each conditional on
  `pyproject.toml` existing in the agent folder. A host applies the first rule whose match and
  condition both hold, else runs the command unchanged. The desktop implements exactly this in
  `src/main/kit/layout.ts` `localizeCommand`. The condition is only meaningful now that the
  agent template ships a `pyproject.toml` — see the bullet above. *(The design mentions one
  rule; the authored contract has two — `python3` was added because the catalog's cloud-first
  convention does not forbid it.)*
- **The dot-restore list moved into `layout.json`** as `scaffold_ignore_files` — see §5.
- **Template file-set details worth confirming**, because byte-identical means byte-identical.
  The authored `templates/agent/` is, in full: `AGENTS.md`, `CLAUDE.md`, `README.md`,
  `Makefile`, `cinna-agent.json`, `pyproject.toml`, `gitignore`,
  `app-data/cache/gitignore`, `app-data/storage/.gitkeep`, `app-data/uploads/.gitkeep`,
  `config/README.md`, `credentials/{README.md, .env.example, .gitignore}`,
  `docs/{CLI_COMMANDS.yaml, WORKFLOW_PROMPT.md, ENTRYPOINT_PROMPT.md, REFINER_PROMPT.md}`,
  `files/README.md`, `knowledge/README.md`,
  `scripts/{README.md, cinna_credentials.py, update_status.py}`. Note `credentials/` ships
  **no `.env`** — a scaffold must never create an empty secret file — and that `.gitkeep` is
  itself in `cloud_import_excludes`. `templates/root/` is `AGENTS.md`, `CLAUDE.md`,
  `README.md`, `gitignore`.

---

## 7. The default root path

The desktop's default agents home is **`~/Documents/CinnaAgents`**
(`src/shared/appSettings.ts`; additional roots are supported, so a workshop a user built by
hand elsewhere is adopted as-is rather than moved).

The design proposal states that the kit's guides currently default to
`~/Documents/MyAgents`. **We could not verify this** — the guide excerpts we were given do
not contain either name, and the file that would carry it (`START.md`, or guide 00) was not
in the excerpt set. See assumption A1.

If that is right, this is the **one item in this document where we are asking you to change
to match us**, rather than the other way round. The argument for `CinnaAgents` is thin but
real: it is the only name that tells a user, from Finder alone, which app owns the folder,
and the desktop is the only party that creates the folder unprompted. Both names are visible
folders, which is the property that actually matters.

We would rather this were an explicit decision — either direction — than a silent divergence
that leaves users with two workshops. If you prefer `MyAgents`, say so and we will change the
desktop default before the feature ships; the setting is one string.

---

## 8. Server endpoints

Grouped by the desktop phase that needs them. Every one is behind a capability probe: the
desktop asks first and falls back to an existing flow when the answer is no.

### 8.1 Contract tarball and version — needed by Phase 1 (contract) and Phase 9 (refresh)

| | |
|---|---|
| **Method / path** | `GET /api/agent-start/contract.tar.gz` and `GET /api/agent-start/contract/version` |
| **Purpose** | Serve the contract subtree independently of the guides, and let a tool check freshness without downloading |
| **Request** | None. Unauthenticated, as the kit tarball is today. Served by `cinna.dev` **and** by every Cinna instance under its own origin |
| **Response** | The tarball extracts to a tree whose root holds `kit.json` and `layout.json`. The version endpoint returns the contract's semver — shape should match whatever `{{KIT_BASE_URL}}/version` returns today, so `_parse_remote_version` (kit.py:1196) can be reused |
| **Without it** | The desktop runs on its bundled contract indefinitely. No refresh, no drift detection, no way to ship a contract change without a desktop release |

### 8.2 `POST /api/v1/cli/account/desktop-token` — needed by Phase 9 (silent link)

| | |
|---|---|
| **Purpose** | Exchange a CLI account token for desktop access + refresh tokens plus the user's email |
| **Why** | When a workshop root contains `Cloud/.cinna/account.json`, the user has already run `cinna login`. The desktop reads it (same OS user, mode `0600`), exchanges the token once, links or switches the profile, runs the usual syncs, and tells the user afterwards. The CLI token is **used once and never stored** |
| **Request** | The CLI account token, plus the desktop's client id. Exact shape TBD — what the desktop needs is: the exchange is bound to the desktop client id, and the resulting tokens appear in the user's token list as a distinguishable entry the user can revoke |
| **Response** | Desktop access token, refresh token, and the account's email address (needed to name the profile without a second round-trip) |
| **Without it** | The desktop falls back to the existing connect card with the instance URL pre-filled from `account.json`. The user types their credentials; everything else is identical. This is a graceful degradation, not a blocker |

### 8.3 Import changes — needed by Phase 9 (publish), and by the CLI

These are changes to the existing agent-import path rather than new endpoints:

- **Preserve the manifest `id`** as the created agent's *local origin*, so a desktop can match
  its local folder to the cloud twin without the cloud having written anything back.
- **Seed the per-mode model override from `runtime.model`** when the manifest carries one.
  `runtime.credential` is a host-local reference and should be ignored server-side.
- **Gate on `contract_version`** using the section 4 rules, and refuse a folder whose major is
  newer than the server's contract, with a message naming the versions.
- **Write a `publications[]` entry** rather than the `cloud` object: `platform_url`,
  `agent_id`, `workspace` (the account workspace the CLI pushed from; omitted when the desktop
  published through the account API), `imported_at`, `updated_at`, `contract_version` and
  `content_hash` (section 9's algorithm, over the same exported tree that was pushed). Migrate
  an existing `cloud` object into the array on that write.
- **`--update` resolves by platform URL**: the entry whose `platform_url` matches the instance
  being pushed to. The desktop uses the entry matching the active profile's server. Either
  tool must be able to update what the other published — which is why `workspace` is optional
  rather than the key.
- **Without it**: publishing from the desktop stays a manual `cinna agent import`, and drift
  detection ("N local changes not published") does not work in either tool, because nothing
  records what was pushed.

### 8.4 Account-CLI endpoints accept desktop tokens — needed by Phase 9 (publish)

| | |
|---|---|
| **Purpose** | Let the desktop replay the CLI's import steps — create the agent, write prompts and metadata, copy the exported tree, push, create credential drafts, create schedules, stamp the manifest — with the token it already holds |
| **Requested change** | The account-CLI endpoints those steps use accept a desktop token carrying CLI account scopes. No new endpoints; a scope/audience change |
| **Without it** | The Publish button cannot exist. The agent page shows the export summary and a "run `cinna agent import` from `Cloud/<host>/`" instruction instead. The manifest stamp is then written by the CLI, and the desktop reads it on the next scan — so the *rest* of the feature (twin matching, drift, per-instance status) still works |

---

## 9. Conformance checklist

Three checks prove the two implementations agree. They can be run entirely on your side once
the desktop ships a build; nothing here needs a server.

### 9.1 Byte-identical scaffold

Scaffold the same agent twice — once with `kit.py new <slug> --name "<Name>" --description
"<sentence>"`, once with the desktop's New-agent flow using the same three inputs — and diff
the two trees recursively, including dotfiles and file modes.

They must differ in **exactly two values**, both inside `cinna-agent.json`: the `id` (a fresh
UUID each time) and `created_at`. Everything else — every file, every byte, the JSON key order
and 2-space indentation and trailing newline — must match. Pin the two variable fields by
passing a fixed id and timestamp if your test harness can, or diff with those two lines
filtered out.

Three things this check now catches that it did not in revision 1, each of which is a real bug
we hit:

- **`.gitignore` and `app-data/cache/.gitignore` both exist and are dotted**, per
  `layout.json` `scaffold_ignore_files` — while `credentials/.gitignore` was shipped dotted and
  stays that way. A scaffolder that restores only the top-level pair passes a naive smoke test
  and leaves `app-data/cache/gitignore` visible in the created folder.
- **`pyproject.toml` exists**, with `{{SLUG}}` and `{{DESCRIPTION}}` substituted. Its absence is
  invisible in a tree diff between two implementations that both omit it, and shows up much
  later as `/run:` executing the system `python`.
- **No file was created that the exclude list or either `gitignore` would have to catch** — in
  particular no `credentials/.env` and no `credentials.json`.

### 9.2 Both validators, both folders

Run `kit.py validate` and the desktop's validator over each of the two trees, and over a
deliberately broken folder. The fixtures that matter:

| Fixture | Expected |
|---|---|
| Missing prompt file; `/run:` reference resolving to nothing | error |
| `runtime.credential` that looks like an API key | error |
| Legacy manifest — `schema_version`, no `contract_version`/`id` | **warning**, plus a re-stamp suggestion |
| A `.env` that no `.gitignore` covers | error `secrets.not_ignored` |
| **A `credentials.json` at the agent root, with only `credentials/.gitignore` present** | error `secrets.not_ignored` — this is the false-negative fixture from §6 |
| Any of `*.pem`, `*.key`, `*.p12` not ignored, or not excluded from export | error `secrets.not_ignored` / `secrets.exported` |
| **A `CLI_COMMANDS.yaml` command whose value is unquoted and contains ` #`, or opens a block scalar (`\|`, `>`)** | error `commands.unparseable`; the command must **not** be offered |
| Unknown credential `type` | **warning**, never an error |
| Catalogued command with no Makefile target | **warning** |

Expect the **same errors and the same warnings**, modulo the agreed kit-only findings from
section 5 (`_validate_requirements` and anything else you decide stays kit-side). Severity
agreement matters as much as the finding: the desktop refuses to run an agent with an error and
runs one with warnings.

The two warning-not-error choices at the bottom of the table came from real considerations
rather than taste: the platform's credential-type list grows independently of any bundled
contract, so an unknown type must never fail a folder; and a command with no Makefile target
still runs through the host, just not by hand.

**The YAML one deserves the same warning as the secret one.** The desktop's reader silently
mis-parsed three shapes of `Local/<slug>/docs/CLI_COMMANDS.yaml`. An unquoted value containing
` #` was
truncated at the `#` — so `/run:check` did not fail, it ran a **different, shorter command**. A
block scalar (`|`, `>`) came back as the literal string `"|"`. An over-indented continuation
line was dropped. None of these raised anything; the catalog simply meant something other than
what was written.

The parser now returns `{data, issues}`, `readCommandCatalog` returns `{commands, unreadable}`
and drops every affected entry, and an unreadable command is an **error** rather than a silent
mis-run — a host must not offer a `/run:` button that executes something the file does not say.
If your handling of this file is a similarly permissive hand-rolled reader — `_strip_yaml_scalar`
(:569) and `cli_command_names` (:581) suggest it is — the same class of defect is there, and
the failure mode is executing the wrong command with the user's credentials in the environment.

### 9.3 Same `content_hash`

Export each tree and compare the hash. Reimplement it exactly as
`src/main/kit/exportTree.ts` does:

1. **Collect the file list.** Walk the agent folder from its root. For each entry, compute its
   agent-root-relative POSIX path (no leading `./`). **Symlinks are never followed and never
   listed** — a folder that travels must not be able to reach outside itself. Skip any path
   the exclude list matches, checking directories too, so an excluded directory is never
   descended into. Dotfiles *are* walked; they are dropped by the exclude patterns
   (`.git/`, `.gitignore`, `**/.env`, …), not by the walk.
2. **Sort the list.** The desktop uses JavaScript's default string sort, i.e. UTF-16 code-unit
   order. For ASCII paths this is byte order and matches Python's `sorted()`; they can differ
   only for non-BMP characters in a filename.
3. **Hash each file's bytes** with SHA-256, lowercase hex. A file that cannot be read is
   logged and hashed as the literal string `unreadable` rather than failing the export — a
   race with a running agent must not fail a scan.
4. **Feed one line per file, in sorted order, into a running SHA-256**: the relative path, a
   single NUL byte (`\0`), the file's hex digest, then a newline (`\n`). Nothing else — no
   mtimes, no sizes, no modes, no directory entries.
5. **The result is the string `sha256:` followed by the lowercase hex digest** of that running
   hash. An empty file list yields `sha256:` plus the digest of the empty input.

Note that the exclude list itself grew in this revision — `credentials.json`,
`**/credentials.json`, `**/*.pem`, `**/*.key`, `**/*.p12` and `**/*.tmp` (see §6). A hash
computed against the old list over a folder that has run in the cloud will not match one
computed against the new list, which is correct: the old one was hashing files that should
never have been in the export at all.

**Exclude-pattern semantics** (implemented in `src/main/kit/layout.ts` `matchesPattern`,
documented in `layout.json`'s `cloud_import_excludes_notes`): patterns match against the
agent-root-relative POSIX path. A trailing `/` excludes that directory and everything beneath
it. `*` matches within one path segment, `?` matches one character within a segment, `**`
matches across segments. A pattern without a leading `**` is **anchored at the agent root** —
so `README.md` excludes the agent's own README and never the agent's own
`Local/<slug>/docs/README.md` or `Local/<slug>/scripts/README.md`. Both pattern and path are normalised first: backslashes to forward
slashes, leading `./` and leading/trailing `/` stripped.

Getting this wrong is quiet: the hash still computes, it just never matches, and the desktop
tells the user their agent has unpublished changes forever.

---

## 10. What we are **not** asking for

- **The cloud→desktop relay and the proxy agent type.** Design phase 4 — a cloud agent whose
  runtime is the user's desktop, with cinna-core owning the card, sessions and credential
  sharing. It is out of scope for this handover and nothing here depends on it. Worth knowing:
  the desktop is building the pieces it would need anyway — a caller-agnostic turn runner that
  already serves direct chat, orchestration, Jobs and the local API; a stable manifest
  identity; and secrets that never leave the machine. What remains for that phase is the relay
  transport and an "online" signal. Do not build for it now.
- **Anything requiring two-way sync.** Publishing is one-way, local → cloud, with an explicit
  warning before overwriting a cloud copy that changed. Reconciliation stays with `cinna dev`,
  which already owns it. The desktop's reverse signal is read-only: it compares the synced
  remote agent's `updated` timestamp against the publication and says "changed in the cloud
  since your last publish", then gets out of the way.
- **An embedded terminal, a second sync engine, or any Python dependency at runtime on the
  desktop side.**

---

## 11. Open questions

Three, all of which change our work depending on the answer.

**Q1 — Where does the contract live inside an installed full `.cinna-kit/`?**
The desktop identifies a contract tree by `kit.json` + `layout.json` at the tree's root, and
looks for one at `<workshop>/.cinna-kit/` so it can prefer a refreshed workshop copy over its
bundled one when the majors match. If your full-kit installer keeps the contract in a
`contract/` subdirectory (`.cinna-kit/contract/kit.json`), the desktop will not find it and
will silently keep using the bundled contract forever. Either the contract files merge into
`.cinna-kit/` root, or tell us the subpath and we will teach `contractStore` to look there.
Related: a `VERSION` file at `.cinna-kit/` root currently holds the *kit* version, so the
desktop reads the contract version from `kit.json` first and treats `VERSION` only as a
fallback — but a merged install would put two meanings on one filename, which we would rather
avoid than paper over.

**Q2 — How much of `app-data/desktop.json` should the contract freeze?**
It is the one desktop-owned file in an agent folder, and the desktop's invariant is that it
owns the shape. But `kit.py chat` has to read the local API base URL and the agent token out
of it, which makes those two keys a shared interface. Should the contract document just those
two keys (our preference — narrow, and the rest stays ours to change), or the whole file? If
the latter, the file stops being desktop-owned in any meaningful sense and we should reconsider
where the chat marker lives.

**Q3 — Can the account API create and update an agent with no `Cloud/<host>/` workspace on
disk?**
The design has the desktop calling the account API directly and writing a `publications[]`
entry with `workspace` absent. The CLI's nine import steps assume a workspace directory it
pushed from. We need to know that (a) the account API supports the create/update sequence
without one, and (b) `cinna agent import --update`, run later from a workspace the user creates
by hand, can resolve and update an entry the desktop wrote with no `workspace` value — matching
on `platform_url` alone. If it cannot, the desktop should create the workspace folder too, and
we would rather know that before building Publish than after.

---

## 12. Assumptions we could not verify

Each of these is stated in the design proposal or inferred from the `kit.py` function outline,
and none of them could be checked against the excerpts we were given. If any is wrong, the
request that depends on it changes.

| # | Assumption | Depends on it |
|---|---|---|
| A1 | The kit guides currently default the workshop path to `~/Documents/MyAgents`. Neither name appears in any excerpt we have; the file that would carry it (`START.md` / guide 00) was not included | Section 7 in its entirety. If the guides have no default at all, there is nothing to align and the desktop simply documents its own |
| A2 | `cmd_new` today substitutes at most `{{NAME}}`, `{{SLUG}}` and `{{KIT_VERSION}}`, and knows nothing of `{{DESCRIPTION}}`, `{{ID}}`, `{{CREATED_AT}}` or `{{CONTRACT_VERSION}}`. We have `substitute_tokens` and `cmd_new` by name only, so we also cannot tell whether substitution already runs tree-wide (which `pyproject.toml` now needs) or only over the manifest | The `--description` / `--json` request and the new tokens in section 5 |
| A3 | The `cloud_import_excludes` list currently lives in `kit.json` and is read by `kit_config()` / `cloud_import_excludes()`. Inferred from the function names | The "move the exclude list into `layout.json`" request; if it lives elsewhere the move is the same, the starting point differs |
| A4 | `kit.py validate`'s per-check severities. We have the `Report` class (`error` / `warn` / `info` / `fix`) and the check function names, but not which check emits which. `_validate_requirements` having a `fix` parameter suggests it can auto-repair | Section 9.2's "same errors and warnings" claim, and the kit-only-findings list in section 5 |
| A5 | `template_description()` (:918) exists to detect a manifest whose `description` is still the template's default, and `_validate_cloud_readiness` (:934) gates the cloud-ready checks. The desktop has no equivalent of the first | Whether the desktop needs a matching check for 9.2 to pass |
| A6 | `cmd_list` / `_rungs_present` currently read the `cloud` object for their cloud-state column | The `DESKTOP` column request is additive either way; only the code path differs |
| A7 | The guides tarball's own URL. We verified `{{KIT_BASE_URL}}/version` from guide 12; the tarball path itself is not in any excerpt | Nothing directly — the contract paths in section 2 are our proposal regardless — but it shapes whether `/contract.tar.gz` reads as consistent with your existing naming |
| A8 | Every endpoint in section 8. None has been called; all shapes come from the design proposal, and where it was silent this document says "shape TBD" rather than inventing one | Section 8 in its entirety |
| A9 | **New in revision 2.** That `kit.py`'s secret check pools `.gitignore` lines across directory scopes, and that its export does not drop `credentials.json` / key material. Inferred from `gitignore_covers_env` (:312) being named for `.env` alone and from `is_env_filename` (:127) existing as the only filename predicate in the outline. **We are asking you to check, not asserting that it is broken** — but this is the one assumption where being wrong in our favour costs nothing and being wrong the other way ships credentials | The callout at the head of §6, and the `secrets.*` rows in §9.2 |
| A10 | **New in revision 2.** That `kit.py` reads `Local/<slug>/docs/CLI_COMMANDS.yaml` with a hand-rolled reader of similar permissiveness to the desktop's. Inferred from `_strip_yaml_scalar` (:569) and `cli_command_names` (:581) — a real YAML dependency would need neither. If `kit.py` uses PyYAML, this whole class of defect is already absent on your side and only the *severity* question remains: does an unreadable command fail validation, or is it silently skipped? | The `commands.unparseable` row in §9.2 |
