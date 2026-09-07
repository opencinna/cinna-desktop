# Contract changelog

Structural conventions that changed between contract versions. Read this after
every contract refresh that reports a new version. Newest entry first.

The contract version is a semantic version. **Major** bumps are breaking — a
folder role moved, or a manifest field changed meaning; a tool whose major is
older than the folder's must refuse to operate it and ask to be updated.
**Minor** bumps are additive and safe to ignore. See "Compatibility" below.

## 1.1.0 — work complexity

Additive. A 1.0.0 folder is read and written unchanged by a 1.1.0 tool, and a
1.0.0 tool ignores the new key and reads `runtime.model` as it always did.

### Added

- Optional `runtime.complexity` — `simple` | `medium` | `complex`. Says how hard
  the agent's work is instead of naming a model, and the host resolves it against
  the models the chosen credential actually offers. **Mutually exclusive with
  `runtime.model`**: a tool writes one or the other, never both. A manifest that
  carries both is a *warning*, not an error, and the **model wins** — a host must
  keep running a folder a newer tool wrote, so an unrecognised `complexity` value
  likewise reads as "no complexity declared" rather than as a broken folder.

  It exists because a model id is the least portable thing this file can carry.
  The manifest is committed to a repository, read by a coding assistant and
  uploaded to a Cinna instance on publish, and a model id means something only to
  the catalogue that lists it — it is wrong on a machine with a different
  credential, and stale the week the provider retires it. `medium` means the same
  thing everywhere and does not go out of date.

  A host that offers a choice should resolve a tier against its *live* catalogue
  by model family, not against a table of ids, so a newly released model joins its
  tier without a tool update.

## 1.0.0 — first contract release

Extracted from the start-kit as its own versioned tree, so the desktop can
bundle and refresh the contract without carrying the assistant-facing guides.

### Breaking

- **`contract_version` replaces `schema_version` as the compatibility gate.**
  Every manifest records the contract version it was scaffolded with; every
  publication records the one it was pushed with. The integer `schema_version`
  is still *parsed* — a manifest that carries it is read, not rejected — but it
  no longer decides anything. Re-stamp a legacy manifest by adding
  `contract_version` and `id`.
- **A manifest carries a stable `id`** (UUID v4), written once at scaffold.
  Identity now survives a folder move or a slug rename, so chats, publications
  and cloud twins stay attached. A manifest without an `id` is legacy.
- **Identity is required of everything but a legacy folder.** `contract_version`
  and `id` are *not* in the schema's top-level `required` — a legacy folder must
  still parse — but the schema's `allOf` requires both of any manifest that is
  not legacy, where legacy means "carries `schema_version` and neither of them".
  Every validator applies the same rule: a legacy folder is one warning asking
  for a re-stamp; anything else missing them is an error.
- **`cloud` becomes `publications[]`.** One entry per instance the agent was
  published to — `{platform_url, agent_id, workspace, imported_at, updated_at,
  contract_version, content_hash}` — because a single `cloud` object cannot
  express an agent published to two servers. The old `cloud` object is still
  accepted and still parsed, so an older folder keeps working; tools should
  migrate it into `publications[]` on the next write.

### Added

- `layout.json` — the folder model as data: the role of every folder, whether a
  contract refresh may replace it (`survives_update`), the `cloud_import_excludes`
  glob list, the `local_command_runner` rule that turns a cloud-first
  `python …` command into `uv run …` when the agent has a `pyproject.toml`, and
  `desktop_owned` (`app-data/desktop.json`).
- **Nothing that can hold a credential value travels or is committed.** One list,
  kept identical in three places: `cloud_import_excludes` (what never travels),
  `templates/agent/gitignore` (what is never committed) and every validator's
  secret check. It covers `credentials.json` — what the platform injects at the
  agent root, and what `scripts/cinna_credentials.py` reads in the cloud, so a
  folder that has run there can otherwise carry live values home — plus any
  `.env`, `*.pem`, `*.key`, `*.p12`, and `*.tmp` files left by an interrupted
  atomic write. `credentials/README.md` and `credentials/.env.example` still
  travel: they document the slots without carrying a value.
- Optional manifest `runtime` block — `{model, credential, permissions}`.
  `credential` is a *reference* (a credential type, or the name of a configured
  credential), never a key or a secret value. Absent means "use the host's
  default runtime", which is what a freshly scaffolded agent does.
- Optional manifest `created_at` (ISO 8601), written by the scaffolder.
- `app-data/desktop.json` is named in the folder model as the single
  desktop-owned file: per-machine runtime state, already git-ignored and already
  excluded from cloud import.
- The root `AGENTS.md` template tells an assistant what changes when the
  workshop is managed by Cinna Desktop.

### Changed

- Ignore rules that exclude paths ship as **dotless `gitignore` files**
  (`templates/root/gitignore`, `templates/agent/gitignore`,
  `templates/agent/app-data/cache/gitignore`). The scaffolder restores the dot
  in the created folder. Shipping them dotted would make them live ignore rules
  wherever the contract is stored, hiding scaffold files from that repository.
  `templates/agent/credentials/.gitignore` keeps its dot on purpose — it names
  files no repository should ever track, and that has to be true of this one too.
- `docs/CLI_COMMANDS.yaml` stays cloud-first (`python scripts/x.py`, paths
  relative to the workspace root); the `Makefile` mirrors each command with
  `uv run`. The rule is now declared in `layout.json` instead of being encoded
  by hand in the Makefile, so a host can localize a command it never saw.
- **Every scaffolded agent ships a `pyproject.toml`** (`requires-python >=3.10`,
  no dependencies). It is what makes `uv run` provision a real interpreter
  instead of falling back to the system `python`, and it is the condition the
  `local_command_runner` rule tests — without it a scaffolded agent's
  `/run:` command would run bare `python`, which on macOS is absent or 3.9.
- `layout.json` carries `scaffold_ignore_files`: the dotless-to-dotted pairs a
  scaffolder must restore, per template tree. It used to be prose in this file,
  which meant a scaffolder could restore `gitignore` and miss
  `app-data/cache/gitignore`.

## How to read a future entry

Each release lists, in this order:

1. **Breaking** — a convention that makes an existing folder invalid. The entry
   says how to migrate. A major bump is always a Breaking entry.
2. **Added** — new optional artefacts. Existing folders keep working untouched.
3. **Changed** — wording, defaults, reorganisation. No action needed.

## Compatibility

| Folder vs. tool | Behaviour |
|-----------------|-----------|
| Same major | Run as-is, whatever the minor. |
| Folder major **newer** | Refuse to run it: "update the app" / "refresh the kit". |
| Folder major **older** | Migratable — apply the Breaking entries for the gap, which is what a "Migrate to contract N.0" action does. |
| No `contract_version` | Unknown. Treat as legacy, read it, ask for a re-stamp. |
