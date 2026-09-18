# Runtime Pins

Which version of each external CLI and ACP adapter Cinna runs, where that number lives, how it is tested, and how it is moved. Behaviour is in [The Codex Engine](../../agents/local_agents/codex_engine.md) and [The Local Engine](../../agents/local_agents/engine.md#binary-resolution-and-what-verified-means); this page is the procedure.

## The manifest

`src/shared/runtimePins.ts` — `RUNTIME_PINS`. **The one place a runtime version lives.** A version compared, downloaded or displayed anywhere is read from it.

| Key | Holds | Managed by Cinna |
|---|---|---|
| `codex` | `cli`, `versionOutput` (exactly what `--version` prints), `adapter`, `adapterOriginalSha256`, `adapterPatchedSha256`, `assets` | Yes — downloaded into `<userData>/runtimes/codex-<version>/` on first use |
| `opencode` | `cli`, `assets` | Yes — `<userData>/engine/opencode-<version>/`, after a configured path and the user's PATH |
| `claude` | `cli`, `adapter` — versions only | **No.** The user's own `claude` runs; this records what the adapter was verified against |

- An asset row is `{file, sha256, url?, executable?}` keyed `${process.platform}-${process.arch}`. Codex rows always carry `url` and `executable` (the archive holds `codex-<target triple>`, installed as `codex`). OpenCode rows derive the URL from the version.
- **Codex has no Windows row, deliberately**: that release zip is several executables, so "publish the one file that was verified" does not describe it. Windows users set a Codex Path.
- **A `sha256` is computed from bytes downloaded from the vendor's own release, never copied from a listing.** It pins those exact bytes; it is not a signature. Bumping a version means recomputing every row for it.
- **The file must stay a module of literals: no imports, no enums.** It is imported by main, the renderer, the E2E fixtures and plain-Node scripts under `node --experimental-strip-types`. Anything a type-stripping loader cannot run breaks the installer and the doc generator, not the app, so the build will not tell you.

### Who reads it

- `src/shared/engine.ts` — `PINNED_ENGINE_VERSION`, `PINNED_CODEX_VERSION` (what the renderer shows)
- `src/main/engine/binaryResolver.ts` — `ENGINE_ASSETS`, `CODEX_ASSETS`, `realCodexResolverDeps`, and `CODEX_SPEC.acceptsVersion`
- `src/main/agents/drivers/acp/codexConductorPolicy.ts` — `SUPPORTED_VERSION` and the patched-adapter digest. **The version installed and the version the restricted chat policy accepts are the same read**, so they cannot drift; they were two unrelated literals before
- `scripts/install-runtime.mjs`, `scripts/generate-contract-docs.mjs`, `e2e/specs/codex-engine.spec.ts`

### The two files that repeat it

They cannot import TypeScript. `src/shared/runtimePins.test.ts` fails when either disagrees.

- `package.json` — the adapter versions, as **exact** strings. A `^` range would let `npm install` move the adapter off the version the patch checksum and the contract snapshot describe
- `src/main/agents/drivers/acp/codexAdapterPatch.json` — adapter version and original/patched digests, read by the CommonJS postinstall and packaging hooks (`scripts/patch-codex-acp.cjs`)

## Test levels

| | Level 1 — interface contract | Level 2 — whole flow |
|---|---|---|
| Asks | Does each interface Cinna relies on still behave | Does a user's flow still work end to end |
| Runs on | The **real** pinned CLI + the real patched adapter over stdio, loopback fake provider. No login, no credential, no provider request | **No dedicated spec exists yet.** The registry's `flow` field is free text naming the step that would exercise each entry |
| Today | `npm run test:contract` | `e2e/specs/codex-engine.spec.ts` (built app, real resolver/launcher/adapter, **scripted** CLI advertising the pinned version string), plus a manual run |

Level 1 pieces, all under `src/main/agents/drivers/acp/contracts/`:

- `codex.contract.ts` — the registry. Data only (the ratchet and the generator read it under type-stripping). Entry: `id`, `area`, `surface`, `name`, `expectation`, `owners` (`file#symbol`), `feature` (what the user loses), `flow`
- `codex.contract.test.ts` — exactly one `it(entry('<id>') …)` per entry. Two scenarios driven once in `beforeAll`; every test asserts on what was observed. The last test compares observed shapes with the snapshot
- `snapshots/codex-<version>.json` — committed baseline. **A run compares; only `make contract-snapshot` writes.** Rewriting it every run made "what changed" invisible
- `codexHarness.ts` — shared with `scripts/probes/runtime-conductor-codex.mjs`, so: Node builtins only, no relative imports, no enums, no parameter properties, no app logger
- `contractRegistry.test.ts` — the **ratchet, in `npm test`**, no binary needed: every id has one test and no test is left over; every owner is an existing file still containing the symbol (literal occurrence, not a declaration); the pinned version has a snapshot naming the same CLI and adapter; `docs/agents/local_agents/contracts/codex_interface.md` equals what the generator would write; that doc is linked from `docs/README.md` and `acp_contract.md`

Config: `vitest.contract.config.ts` is a **separate config, not a project** of `vitest.config.ts` — `vitest run` runs every project of the default config, so a project would be part of `npm test`. The default `main` project excludes `contracts/*.contract.test.ts` for the same reason (`customLauncher.contract.test.ts` is an ordinary unit test and stays).

| Command | Does |
|---|---|
| `make contract ENGINE=codex` | Installs the pinned CLI into the test cache (checksum-verified), runs Level 1 |
| `npm run test:contract` | Level 1 only. **No binary is a failure, not a skip**; `CINNA_CONTRACT_ALLOW_SKIP=1` skips knowingly |
| `make contract-next ENGINE=codex VERSION=x.y.z` | Level 1 against a candidate, pin untouched. Prints the snapshot diff pinned → candidate; the candidate snapshot goes to a temp path |
| `make contract-snapshot ENGINE=codex` | Rewrites the committed snapshot from the pinned CLI |
| `npm run contract:docs` | Regenerates `codex_interface.md`; `-- --check` exits 1 when stale |

- Test cache: `$CINNA_RUNTIME_CACHE`, else `~/.cache/cinna-runtimes/<tool>-<version>/`. Not `userData` — vitest and the probes cannot ask Electron where that is. `CINNA_CONTRACT_CODEX=/abs/codex` overrides the binary
- `ENGINE=codex` is the only engine any of these accept

## E2E never downloads a runtime

`e2e/fixtures/app.ts` sets `CINNA_CODEX_DOWNLOAD=off` on every launch, after a spec's own variables. **A spec that drives Codex must set `localAgentsCodexPath` to its scripted CLI**; putting it on the sandbox PATH is not enough, because no spawned session uses the PATH copy. One that forgets fails with a sentence instead of fetching 90 MB and running the real CLI under a test's name.

## Moving the Codex pin

1. `make contract-next ENGINE=codex VERSION=<new>`. Note the line `UNVERIFIED candidate — sha256 <platform>: <digest>`
2. **Read the snapshot diff before the failures.** It is the list of what the release changed; the failures are the subset Cinna depends on
3. For each red test, open its registry entry: `owners` names the code to fix, `feature` what breaks for the user. Fix the owner, or — when the new behaviour is acceptable — change the `expectation` and its test together. A new interface Cinna starts relying on is a new entry **and** a new test, or the ratchet fails
4. Bump `CODEX_CLI` in `src/shared/runtimePins.ts` and replace **every** asset `sha256`. `scripts/install-runtime.mjs` prints the digest for the platform it runs on only; the other rows are each downloaded from the vendor release and hashed. `versionOutput` and the URLs derive from the version
5. `make contract-snapshot ENGINE=codex` — installs the new pin (verifying the checksum just written) and writes `snapshots/codex-<new>.json`. Review it as a diff against the previous version's file
6. `npm run contract:docs`, then `npm test` — the ratchet confirms snapshot, doc and owners
7. One E2E spec, never the suite: `make e2e-one SPEC=codex-engine`
8. On the real binary: `node --experimental-strip-types scripts/probes/runtime-conductor-codex.mjs <abs path to the new codex>`, then one manual turn in the built app on a real Codex login. Nothing automated covers a paid model, a real login, the reviewer or the sandbox

Moving the **adapter** instead: `package.json` (exact), `RUNTIME_PINS.codex.adapter` and both adapter digests, `codexAdapterPatch.json`, then `npm install` so the postinstall patch runs — it refuses any source digest but the recorded original. Then steps 5–8; the snapshot records the adapter version too.

## Known gaps the contract pins rather than fixes

- `codex.limits.rate-limit-kind` — a provider 429 ends the turn normally; the driver's rate-limit pause keys on the Claude adapter's error shape and never fires on Codex
- `codex.mcp.list-changed-not-adopted` — pinned in both directions: if a release adopts `tools/list_changed`, the new-session-on-tool-change workaround becomes dead weight
- `codex.provider.auxiliary-request` — the CLI's own thread-title (`gpt-5.6-luna`, carries the user's first message) and compaction requests
