# Runtime Pins

Which version of each external CLI and ACP adapter Cinna runs, where that number lives, how it is tested, and how it is moved. Behaviour is in [The Codex Engine](../../agents/local_agents/codex_engine.md), [The Claude Engine](../../agents/local_agents/claude_engine.md#which-claude-runs) and [The Local Engine](../../agents/local_agents/engine.md#binary-resolution-and-what-verified-means); this page is the procedure.

## The manifest

`src/shared/runtimePins.ts` — `RUNTIME_PINS`. **The one place a runtime version lives.** A version compared, downloaded or displayed anywhere is read from it.

| Key | Holds | Managed by Cinna |
|---|---|---|
| `codex` | `cli`, `versionOutput` (exactly what `--version` prints), `adapter`, `adapterOriginalSha256`, `adapterPatchedSha256`, `assets` | Yes — a PATH copy reporting exactly `versionOutput` is reused (`path-pinned`); otherwise downloaded into `<userData>/runtimes/codex-<version>/` on first use |
| `opencode` | `cli`, `assets` | Yes — `<userData>/engine/opencode-<version>/`, after a configured path and the user's PATH |
| `claude` | `cli`, `versionOutput` (`<cli> (Claude Code)`), `adapter`, `assets` | Yes — on Codex's terms: exact-version PATH copy, else `<userData>/runtimes/claude-<version>/`. The adapter is unpatched, so there are no adapter digests |

- An asset row is `{file, sha256, url?, executable?, format?, size?}` keyed `${process.platform}-${process.arch}`. Codex rows always carry `url`, `executable` (the archive holds `codex-<target triple>`, installed as `codex`) and `size`. Claude rows carry `url`, `size` and `format: 'executable'` — the asset **is** the binary (215–232 MB), from Anthropic's release bucket (`<release>/<platform>/claude`, listed by `<release>/manifest.json`), and nothing is unpacked. OpenCode rows derive the URL from the version and record no size.
- **`size` is exact and load-bearing**: the download's size ceiling (what lets a 215 MB executable past a guard sized for archives), the progress denominator when the server declares no length, the base of the download's time ceiling, and the "about N MB" the settings row promises. The field is `format`, not `kind`: `kindBranches.test.ts` counts every `.kind ===` in the tree.
- **Codex has no Windows row, deliberately**: that release zip is several executables, so "publish the one file that was verified" does not describe it. Windows users set a Codex Path. **Claude has none either**: the launcher's child-environment rules and the login probe are POSIX-verified only. Claude's Linux rows are the glibc builds; libc is not detected.
- **A `sha256` describes bytes somebody downloaded from the vendor's own release.** It pins those exact bytes; it is not a signature. Bumping a version means replacing every row for it. Codex's release publishes no digests, so every archive is downloaded and hashed. Claude's bucket publishes `checksum` and `size` per platform in `manifest.json` — the numbers the vendor's own installer trusts — and `make pin-assets` reads them by default, since re-deriving them means ~900 MB across four platforms; **run it with `--verify` before committing a bump**, which downloads each binary and refuses a row whose bytes disagree. The 2.1.276 rows were verified that way.
- **The file must stay a module of literals: no imports, no enums.** It is imported by main, the renderer, the E2E fixtures and plain-Node scripts under `node --experimental-strip-types`. Anything a type-stripping loader cannot run breaks the installer and the doc generator, not the app, so the build will not tell you.

### Who reads it

- `src/shared/engine.ts` — `PINNED_ENGINE_VERSION`, `PINNED_CODEX_VERSION`, `PINNED_CLAUDE_VERSION` (what the renderer shows)
- `src/main/engine/binaryResolver.ts` — `ENGINE_ASSETS`, `CODEX_ASSETS`, `CLAUDE_ASSETS`, `realCodexResolverDeps` / `realClaudeResolverDeps`, and `CODEX_SPEC` / `CLAUDE_SPEC` `.acceptsVersion`
- `src/main/engine/engineBinaryService.ts` — each pin's `versionOutput` (what a managed copy is reported as without spawning it) and `assets[…].size`
- `src/main/agents/drivers/acp/codexConductorPolicy.ts` — `SUPPORTED_VERSION` and the patched-adapter digest. **The version installed and the version the restricted chat policy accepts are the same read**, so they cannot drift; they were two unrelated literals before
- `scripts/install-runtime.mjs`, `scripts/pin-assets.mjs`, `scripts/generate-contract-docs.mjs`, `e2e/specs/codex-engine.spec.ts`

### The two files that repeat it

They cannot import TypeScript. `src/shared/runtimePins.test.ts` fails when either disagrees.

- `package.json` — the adapter versions, as **exact** strings. A `^` range would let `npm install` move the adapter off the version the patch checksum and the contract snapshot describe
- `src/main/agents/drivers/acp/codexAdapterPatch.json` — adapter version and original/patched digests, read by the CommonJS postinstall and packaging hooks (`scripts/patch-codex-acp.cjs`)

## Test levels

| | Level 1 — interface contract | Level 2 — whole flow |
|---|---|---|
| Asks | Does each interface Cinna relies on still behave | Does a user's flow still work end to end |
| Runs on | The **real** pinned CLI + the real adapter (Codex's patched) over stdio, loopback fake provider. No login, no credential, no provider request. Claude additionally runs in a scratch `HOME` behind an **egress trap**: `HTTPS_PROXY`/`HTTP_PROXY` name a loopback proxy that records each host and refuses it, which is how "no real request" is asserted rather than assumed — for proxy-honouring traffic only; it is a record, not a firewall | **No dedicated spec exists yet, for either engine.** The registry's `flow` field is free text naming the step that would exercise each entry, and a `live` entry's `flow` starts `live flow:` |
| Today | `npm run test:contract` | Codex: `e2e/specs/codex-engine.spec.ts` (built app, real resolver/launcher/adapter, **scripted** CLI advertising the pinned version string), plus a manual run. Claude: **a manual run only** — `claude-engine.spec.ts` and `claude-logged-out.spec.ts` stop at the picker and the login probe and never run a turn, because a real turn bills a subscription. `live` entries are therefore checked by hand today |

Level 1 pieces, all under `src/main/agents/drivers/acp/contracts/`:

- `codex.contract.ts`, `claude.contract.ts` — the registries; the entry types live in the first. Data only (the ratchet and the generator read them under type-stripping). Entry: `id`, `area`, `surface`, `name`, `expectation`, `owners` (`file#symbol`), `feature` (what the user loses), `flow`, and optional **`live`**
- **`live: '<why>'`** marks an entry that cannot be exercised against a fake provider — it needs a real login, a paid model or the vendor's servers. Its test is `it.skip(entry('<id>') …)`, **never a faked pass**; the ratchet holds both directions (a `live` entry must be skipped, and `it.skip` may be used for nothing else), and the generated doc prints **Live only** with the reason. Claude has three: the login following `HOME`, a subscription usage limit, and the background updater
- `codex.contract.test.ts`, `claude.contract.test.ts` — exactly one `it(entry('<id>') …)` per entry. Two scenarios driven once in `beforeAll`; every test asserts on what was observed. The last test compares observed shapes with the snapshot
- `snapshots/{codex,claude}-<version>.json` — committed baseline, one per engine; `snapshotTools.ts` holds the stable key order and the line diff both tests print. **A run compares; only `make contract-snapshot` writes.** Rewriting it every run made "what changed" invisible
- `claudeHarness.ts` — the scratch `HOME`, the fake `/v1/messages` endpoint, the egress trap, `findContractClaude`; the adapter connection and base environment come from `codexHarness.ts`
- `codexHarness.ts` — shared with `scripts/probes/runtime-conductor-codex.mjs`, so: Node builtins only, no relative imports, no enums, no parameter properties, no app logger
- `contractRegistry.test.ts` — the **ratchet, in `npm test`**, no binary needed: every id has one test and no test is left over; every owner is an existing file still containing the symbol (literal occurrence, not a declaration); the pinned version has a snapshot naming the same CLI and adapter; `docs/agents/local_agents/contracts/{codex,claude}_interface.md` equals what the generator would write; each doc is linked from `docs/README.md` and `acp_contract.md`. It runs once per engine (`describe.each`); a third engine is a third row

Config: `vitest.contract.config.ts` is a **separate config, not a project** of `vitest.config.ts` — `vitest run` runs every project of the default config, so a project would be part of `npm test`. The default `main` project excludes `contracts/*.contract.test.ts` for the same reason (`customLauncher.contract.test.ts` is an ordinary unit test and stays).

| Command | Does |
|---|---|
| `make contract ENGINE=codex\|claude` | Installs that engine's pinned CLI into the test cache (checksum-verified), runs **its** Level 1 file. For Claude, a `claude` on PATH whose bytes hash to the pinned `sha256` is copied instead of downloaded — the digest is the verification either way |
| `npm run test:contract` | Level 1 for **every** engine. **No binary is a failure, not a skip**; `CINNA_CONTRACT_ALLOW_SKIP=1` skips knowingly |
| `make contract-next ENGINE=<engine> VERSION=x.y.z` | Level 1 against a candidate, pin untouched. Prints the snapshot diff pinned → candidate; the candidate snapshot goes to a temp path |
| `make contract-snapshot ENGINE=<engine>` | Rewrites the committed snapshot from the pinned CLI |
| `make pin-assets ENGINE=<engine> VERSION=x.y.z` | Prints `url` + `sha256` + `size` for **every** platform of that version, as lines ready to paste into `runtimePins.ts`. Codex: downloads and hashes each archive. Claude: reads the vendor manifest; append `--verify` to the script (`node --experimental-strip-types scripts/pin-assets.mjs claude <v> --verify`) to download and compare. The platform list is the pinned one — a platform is added by adding its row first, deliberately |
| `npm run contract:docs` | Regenerates both interface docs; `-- --check` exits 1 when either is stale. **Never hand-edit them** |

- Test cache: `$CINNA_RUNTIME_CACHE`, else `~/.cache/cinna-runtimes/<tool>-<version>/`. Not `userData` — vitest and the probes cannot ask Electron where that is. `CINNA_CONTRACT_CODEX=/abs/codex` / `CINNA_CONTRACT_CLAUDE=/abs/claude` override the binary — how `contract-next` names a candidate
- `ENGINE` is `codex` or `claude`; anything else is a usage error

## E2E never downloads a runtime

`e2e/fixtures/app.ts` sets `CINNA_CODEX_DOWNLOAD=off` and `CINNA_CLAUDE_DOWNLOAD=off` on every launch, after a spec's own variables. **A spec that drives Codex or Claude must set `localAgentsCodexPath` / `localAgentsClaudePath` itself**; putting a fake on the sandbox PATH is not enough, because a spawned session uses a PATH copy only at exactly the pinned version. One that forgets fails with a sentence instead of fetching 90–215 MB and running the real CLI under a test's name — except on a machine whose own install happens to be the pin, where it would silently run that; naming the path removes the difference. Details in [the E2E guide](../e2e/e2e_llm.md).

## Moving a pin

Written for Codex; Claude differs only where a step says so.

1. `make contract-next ENGINE=codex VERSION=<new>`. Note the line `UNVERIFIED candidate — sha256 <platform>: <digest>`
2. **Read the snapshot diff before the failures.** It is the list of what the release changed; the failures are the subset Cinna depends on
3. For each red test, open its registry entry: `owners` names the code to fix, `feature` what breaks for the user. Fix the owner, or — when the new behaviour is acceptable — change the `expectation` and its test together. A new interface Cinna starts relying on is a new entry **and** a new test, or the ratchet fails
4. Bump `CODEX_CLI` (or `CLAUDE_CLI`) in `src/shared/runtimePins.ts` and replace **every** asset `sha256` **and `size`** with the output of `make pin-assets ENGINE=<engine> VERSION=<new>` (Claude: with `--verify`). `scripts/install-runtime.mjs` prints the digest for the platform it runs on only, and doing the other three by hand is how a row ends up stale. `versionOutput` and the URLs derive from the version
5. `make contract-snapshot ENGINE=codex` — installs the new pin (verifying the checksum just written) and writes `snapshots/codex-<new>.json`. Review it as a diff against the previous version's file
6. `npm run contract:docs`, then `npm test` — the ratchet confirms snapshot, doc and owners
7. One E2E spec, never the suite: `make e2e-one SPEC=codex-engine` (Claude: `SPEC=claude-engine`)
8. On the real binary: `node --experimental-strip-types scripts/probes/runtime-conductor-codex.mjs <abs path to the new codex>`, then one manual turn in the built app on a real Codex login. Nothing automated covers a paid model, a real login, the reviewer or the sandbox. Claude has no probe script: do the manual turn on a real Claude login, and walk its three `live` entries by hand — the managed binary reports the user's login with no Keychain prompt, and a long session does not move `~/.local/bin/claude`. Users whose own install is the *old* pin stop matching after the bump and get the download on their next turn; the superseded managed copy is swept only after the new one runs, and not within 7 days of use

Moving the **adapter** instead: `package.json` (exact), `RUNTIME_PINS.codex.adapter` and both adapter digests, `codexAdapterPatch.json`, then `npm install` so the postinstall patch runs — it refuses any source digest but the recorded original. Then steps 5–8; the snapshot records the adapter version too.

## Known gaps the contract pins rather than fixes

- `codex.limits.rate-limit-kind` — a provider 429 ends the turn normally; the driver's rate-limit pause keys on the Claude adapter's error shape and never fires on Codex
- `codex.mcp.list-changed-not-adopted` — pinned in both directions: if a release adopts `tools/list_changed`, the new-session-on-tool-change workaround becomes dead weight
- `claude.mcp.list-changed-adopted` — the opposite finding, pinned the same way: if a release stops adopting it, the Claude launcher needs `sessionToolsFixed` too
- `claude.provider.auxiliary-request` — the CLI's session-title requests: the first beside the first prompt, carrying the user's first message, on the conversation's model, no tools
- `claude.provider.no-real-egress` — with `ANTHROPIC_BASE_URL` set the CLI still tries `api.anthropic.com`; refused by the trap. A new host appearing there is a new place the CLI sends something
- `codex.provider.auxiliary-request` — the CLI's own thread-title (`gpt-5.6-luna`, carries the user's first message) and compaction requests
