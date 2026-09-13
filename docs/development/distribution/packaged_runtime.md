# Packaged Runtime Dependencies

## Purpose

A distributed app must resolve its dependencies from the files it ships. A successful development run or Vite build cannot establish that: Claude's packaged ACP adapter failed before `initialize` because `@agentclientprotocol/sdk` was left inside the adjacent archive.

This distribution aspect covers build-time dependency discovery and isolated runtime checks. Signing and publishing belong to [Release & Distribution](release.md); engine behavior and measured protocol evidence belong to the [ACP Engine Contract](../../agents/local_agents/acp_contract.md).

## The archive boundary

- **Main-process packages** can load through Electron's asar filesystem support. `electron.vite.config.ts` externalizes dependencies, so the compiled main output still imports shipped packages.
- **ACP child packages** run with `ELECTRON_RUN_AS_NODE=1` from real files under `app.asar.unpacked`. Both the adapter entry and its runtime dependency closure must be unpacked; ordinary child-process resolution cannot reach a dependency left only in the sibling `app.asar`.
- **External CLIs** remain user-owned. Claude uses `CLAUDE_CODE_EXECUTABLE`; Codex uses `CODEX_PATH`. Shipping the JavaScript adapter and SDK does not require shipping their fallback CLI binaries.

Build flow: installed production tree → `beforePack` dependency/target preparation → target native addon rebuild and dependency collection → archive/unpacked output → `afterPack` shipped-tree validation → signing and artifacts → separately invoked runtime smoke checks.

## Discovery and build rules

`scripts/packaged-dependencies.cjs` owns `runtimePackages`, target Canvas preparation/validation, `beforePack` and `afterPack`. Both hooks are registered in `electron-builder.yml` and run whenever electron-builder packages this app, including cross-builds. `npm run build` alone invokes Vite and does not run them.

`runtimePackages` starts from `@agentclientprotocol/claude-agent-acp` and `@agentclientprotocol/codex-acp` and follows the installed layout:

- Read manifests directly, including packages whose exports hide their manifest. Search ancestor dependency directories only as far as the supplied app root, so an ancestor developer installation cannot satisfy a missing package.
- Traverse `dependencies`, `peerDependencies` and `optionalDependencies`. Missing required dependencies and required peers throw `Missing runtime dependency …, required from …`.
- Missing optional dependencies and optional peers are allowed. An optional peer is still required when also declared in `dependencies`; an `optionalDependencies` entry makes that dependency optional. Installed optional packages are traversed, and their required children must resolve.
- Track visited package directories to terminate cycles and preserve distinct nested versions. Return sorted, relative paths with forward slashes. Dev dependencies are outside this traversal.
- Skip names beginning with `@anthropic-ai/claude-agent-sdk-` or `@openai/codex`, matching the root and nested CLI exclusions in `electron-builder.yml`. Keep the helper and file exclusions aligned; omitting a required launcher override would activate an intentionally absent fallback.

`beforePack` prepares target Canvas payloads first (below), then derives one `**/node_modules/<package-name>/**` pattern per discovered name, merges it with existing `asarUnpack` entries and removes duplicates. Matching every depth matters: electron-builder can re-hoist a package after npm installed it nested. A source-directory-only pattern missed that destination. Target Canvas payload names receive the same all-depth patterns. Existing resource unpacking remains part of the configuration.

Unpack patterns only act on packages electron-builder collects. The Claude SDK's required `@modelcontextprotocol/sdk` peer was installed by npm but omitted from the distribution while it was implicit. `package.json` declares `@modelcontextprotocol/sdk` at `1.29.0` as a production dependency, with `package-lock.json` updated accordingly. The app's `@modelcontextprotocol/client` dependency serves a separate consumer and does not replace this peer requirement.

`afterPack` finds the target resources directory through the packager and traverses its actual `app.asar.unpacked` manifests, reporting `Verified … unpacked ACP runtime packages` on success. A missing required package fails packaging before signing/publishing. The ACP traversal is a manifest-resolution guard: it does not execute adapters, validate dependency semver ranges or exports, check native ABI compatibility, or prove optional packages and lazy assets are usable. `afterPack` separately checks the target Canvas payload manifest and nonempty native file described below; that static check does not load the binary. Its count can differ from the source tree after collection/hoisting; equality of counts is not required.

## Native dependencies across targets

A package manifest cannot establish native compatibility. `electron-builder.yml` keeps `npmRebuild: true` so electron-builder prepares native addons such as `better-sqlite3` for each target's Electron ABI and CPU architecture. With rebuilding disabled, an Intel package built on Apple Silicon retained the host's ARM64 SQLite binding; a check using host Electron could load it and conceal that the target application could not.

A target-specific optional payload is a separate case. `@napi-rs/canvas` ships its native binary through platform packages and has no `binding.gyp`, so the addon rebuild step does not prepare the missing target package. Its payload must be present before electron-builder collects dependencies. PDF text extraction can still pass in Electron with its own DOMMatrix support, so the PDF worker smoke alone does not prove Canvas can initialize or draw.

`canvasTargets` reads the installed `@napi-rs/canvas` manifest and derives the target from electron-builder's platform/architecture, not the host process:

| Target | Optional payload suffix |
|---|---|
| macOS/Mac App Store x64 or arm64 | `darwin-x64` or `darwin-arm64`; universal prepares both |
| Windows x64 or arm64 | `win32-x64-msvc` or `win32-arm64-msvc` |
| Linux x64 or arm64 | `linux-x64-gnu` or `linux-arm64-gnu` |
| Linux armv7l | `linux-arm-gnueabihf` |

The package name is `@napi-rs/canvas-<suffix>` and the binary is `skia.<suffix>.node`. Linux release artifacts target glibc; host libc does not select the payload. Unsupported targets fail. The installed Canvas manifest must pin the selected optional package to exactly its own version.

`prepareCanvasPayload` reuses an installed target only after `validateCanvasPayload` checks its exact name/version/main entry and a nonempty native file. A present but invalid target fails; it is not silently replaced. If absent, preparation requires the matching root `package-lock.json` entry with exact version, resolved tarball and integrity:

- Run `npm pack` for that locked URL with `--ignore-scripts`, into a temporary directory with a two-minute timeout. This may need registry/cache access; it does not run an npm install or change the project's manifests/lockfile.
- Verify downloaded archive bytes against lockfile SRI, extract into a staging directory on the destination filesystem, then validate the manifest/native file.
- Rename the verified tree into the root dependency directory and clean up temporary/staging files. Only the selected target payload is prepared; this does not fetch all optional platform packages.

The installed fast path validates structure/version, not a fresh checksum of previously installed files. `afterPack` independently resolves the target payload from Canvas's unpacked lookup origin and checks the shipped manifest and native file. Missing, wrong-version or empty target payloads fail the build before signing. Presence and manifest identity still do not prove machine-code architecture or runtime drawing; the main smoke covers actual Canvas creation and pixel readback.

Native rebuilds can change the checkout's installed addon binaries. After cross-building, restore dependencies for the development Electron/host architecture before treating a local dev failure as an application regression. Keep the same lockfile and test runtime versions when comparing host and target results.

## Commands and coverage

Run from the checkout with dependencies installed. The fixture source, Node, Electron and TypeScript are checkout-owned test tooling; these are not standalone end-user commands. Runtime commands require an already packaged build and do not build it themselves. Quote paths containing spaces.

| Command | What it establishes |
|---|---|
| `npm run test:packaging` | Thirteen Node tests: six dependency/hook fixtures, five Canvas target/preparation fixtures and two main-check environment regressions. No package or Electron launch is required. |
| `npm run test:packaged:acp -- <app-executable> <resources-directory>` | Both shipped adapters complete ACP v1 `initialize` using the supplied packaged Electron executable. |
| `npm run test:packaged:main -- <resources-directory> [matching-electron-executable]` | The supplied Electron (or the project's installed Electron by default) loads the copied package's external main imports and exercises selected native/WASM/parser paths. |

For a macOS arm64 build, the runtime invocations are:

- `npm run test:packaged:acp -- "dist/mac-arm64/Cinna Desktop.app/Contents/MacOS/Cinna Desktop" "dist/mac-arm64/Cinna Desktop.app/Contents/Resources"`
- `npm run test:packaged:main -- "dist/mac-arm64/Cinna Desktop.app/Contents/Resources"`

Use the executable/resources paths of the target artifact on other platforms. For a cross-built artifact, pass an Electron executable of the target architecture and matching Electron version/native ABI as the main check's optional second argument. The default project Electron may be the build host's architecture. The host must be able to run the selected target executable; choosing a path does not provide emulation. The main check launches its own probe script, so the override must be an Electron runtime that accepts that script, rather than a packaged application entry point. A passing cross-build guard is not runtime evidence for the target.

`npm test` remains the Vitest suite. It does not run these commands. `.github/workflows/release-linux.yml` runs `npm run test:packaging` after `npm ci`, then `npm run release:linux`, which runs the build hooks. Neither that workflow nor `afterPack` invokes the packaged runtime smoke checks. Those are manual release verification, separate from full [E2E tests](../e2e/e2e.md).

### ACP isolation

`scripts/check-packaged-acp.mjs` copies only the shipped unpacked tree to a temporary directory outside the checkout. Each adapter runs there with temporary HOME/config directories, a constructed environment without inherited loader overrides or credentials, and the packaged executable in Node mode. Each `initialize` has a 60-second deadline to allow cold Rosetta translation of a newly built Intel executable; the check terminates the adapter and removes its temporary tree afterwards.

Claude receives an unused executable path because this handshake does not start a Claude turn. Codex starts its app-server during initialization, so the check supplies `src/main/agents/drivers/acp/testSupport/fakeCodexAppServer.mjs` through a temporary launcher. That fixture uses the check runner's Node, while the adapter uses packaged Electron. The POSIX shell and Windows cmd launchers quote Node/server paths through environment values; a raw Node shebang failed when the Node installation path contained spaces. This launcher is test infrastructure, not the production CLI launcher.

### Main-process isolation

`scripts/check-packaged-main.cjs` launches the optional supplied Electron executable, defaulting to the project's Electron, with an allowlist of OS/GUI environment variables and temporary HOME/config/cache/temp directories. It removes `NODE_PATH`, `NODE_OPTIONS`, credentials and inherited `ELECTRON_RUN_AS_NODE` **before startup**. Clearing loader variables inside the probe would be too late: CommonJS dependencies could already use developer packages.

`scripts/packaged-main-probe.cjs` sets temporary userData and copies the actual `app.asar` and unpacked tree outside the checkout, preserving the archive boundary. It uses the checkout's TypeScript parser as harness tooling to discover static external import declarations in the packaged main JavaScript files, excluding built-ins and Electron. Resolve hooks anchor the probe's dynamic imports at the copied main entry. The production app entry is not booted.

The probe imports each discovered specifier, then queries an in-memory `better-sqlite3` database, initializes and hashes with `libsodium-wrappers-sumo`, draws a red rectangle with `@napi-rs/canvas` and checks its pixel bytes, and extracts synthetic RTF/PDF text through `officeparser`, including the dynamic PDF.js worker path. Import count is discovered from the artifact, not hardcoded. The launcher has a 45-second deadline and the probe a 30-second deadline; both clean up their temporary directories on normal completion/failure.

## Evidence and limits

| Measured target/runtime | Result |
|---|---|
| macOS arm64 | Both packaged ACP initializations, 21 external main imports, SQLite, libsodium, RTF and PDF worker checks passed. These runs preceded the explicit Canvas drawing probe; arm64 Canvas drawing remains unverified. |
| macOS x64 under Rosetta on an arm64 host, Electron 41.2.1 | Both packaged ACP initializations passed with the 60-second deadline. The corrected unsigned package passed 21 external main imports, SQLite, libsodium, native Canvas drawing, RTF and PDF worker checks with matching x64 Electron. Target Canvas fetching used the actual locked tarball/SRI path, and its shipped-payload check passed. This is x64 runtime evidence under Rosetta, not a separate Intel-hardware result. |

All thirteen fixture/environment tests passed, including Canvas target selection, lock/integrity validation, staged payload preparation, shipped-payload rejection and a regression that demonstrates CommonJS can load a developer-only package through inherited `NODE_PATH` before asserting the sanitized environment prevents it. The ACP command also passed for both adapters on macOS arm64 when invoked with a Node executable path containing spaces.

No Windows or Linux packaged runtime verification is established by this evidence; the Windows launcher branch is implementation, not a measured platform result. The checks make no live model request and establish no live login, CLI sandbox/approval behavior, OCR, renderer flow, full application startup, or exhaustive document-format coverage. Static import discovery is supplemented by the named lazy paths, not a guarantee about every dynamic import.

## Diagnosing a failure

| Symptom | Check |
|---|---|
| `beforePack` reports a missing dependency | Inspect the named requiring manifest and installed dependency tree. Required peers count; packages outside the app root do not. |
| `afterPack` fails although discovery passed | Inspect production dependency collection, root/nested `files` exclusions and generated all-depth unpack patterns. A pattern cannot restore a package electron-builder omitted; the MCP SDK peer omission required an explicit production dependency. |
| Adapter times out before `initialize` without a module error | Cold target startup under Rosetta can take longer than a warm run; the check allows 60 seconds per adapter. Distinguish a startup timeout from a dependency failure and record target/runtime conditions. |
| Adapter exits before `initialize` with module-not-found | Check the shipped unpacked tree, not just the development install or archive contents. Rebuild and run the isolated ACP command. |
| Main imports pass but parsing/native use fails | Follow the reported SQLite, libsodium or parser stage. Imports alone do not exercise native bindings, WASM initialization or dynamically loaded workers. |
| SQLite reports an incompatible architecture or module ABI | Check the binary inside the target package and `npmRebuild: true`. Test with matching target Electron; host Electron can conceal a host binary accidentally shipped in a cross-built artifact. |
| Canvas cannot load its native binding, although PDF text extraction passed | Check target-specific optional payload preparation independently of addon rebuilding and the PDF worker. The canvas package has no `binding.gyp`; missing optional dependencies do not fail the ACP manifest traversal. |
| Runtime fails on a different architecture or Electron version | Separate host/ABI compatibility from missing files. Record the actual runtime and target; use the main check's optional matching Electron executable on a host capable of running it. |

When an adapter dependency changes, keep manifest collection, CLI exclusions and consumer checks together. When another lazy main-process path becomes relevant, add an explicit probe for its real operation rather than treating static imports as sufficient coverage.
