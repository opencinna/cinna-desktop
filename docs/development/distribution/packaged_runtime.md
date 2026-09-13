# Packaged Runtime Dependencies

## Purpose

A distributed app must resolve its dependencies from the files it ships. A successful development run or Vite build cannot establish that: Claude's packaged ACP adapter failed before `initialize` because `@agentclientprotocol/sdk` was left inside the adjacent archive.

This distribution aspect covers build-time dependency discovery and isolated runtime checks. Signing and publishing belong to [Release & Distribution](release.md); engine behavior and measured protocol evidence belong to the [ACP Engine Contract](../../agents/local_agents/acp_contract.md).

## The archive boundary

- **Main-process packages** can load through Electron's asar filesystem support. `electron.vite.config.ts` externalizes dependencies, so the compiled main output still imports shipped packages.
- **ACP child packages** run with `ELECTRON_RUN_AS_NODE=1` from real files under `app.asar.unpacked`. Both the adapter entry and its runtime dependency closure must be unpacked; ordinary child-process resolution cannot reach a dependency left only in the sibling `app.asar`.
- **External CLIs** remain user-owned. Claude uses `CLAUDE_CODE_EXECUTABLE`; Codex uses `CODEX_PATH`. Shipping the JavaScript adapter and SDK does not require shipping their fallback CLI binaries.

Build flow: installed production tree → `beforePack` discovery → electron-builder collection and unpacking → `afterPack` manifest validation → signing and artifacts → separately invoked runtime smoke checks.

## Discovery and build rules

`scripts/packaged-dependencies.cjs` exports `runtimePackages`, `beforePack` and `afterPack`. Both hooks are registered in `electron-builder.yml` and run whenever electron-builder packages this app, including cross-builds. `npm run build` alone invokes Vite and does not run them.

`runtimePackages` starts from `@agentclientprotocol/claude-agent-acp` and `@agentclientprotocol/codex-acp` and follows the installed layout:

- Read manifests directly, including packages whose exports hide their manifest. Search ancestor dependency directories only as far as the supplied app root, so an ancestor developer installation cannot satisfy a missing package.
- Traverse `dependencies`, `peerDependencies` and `optionalDependencies`. Missing required dependencies and required peers throw `Missing runtime dependency …, required from …`.
- Missing optional dependencies and optional peers are allowed. An optional peer is still required when also declared in `dependencies`; an `optionalDependencies` entry makes that dependency optional. Installed optional packages are traversed, and their required children must resolve.
- Track visited package directories to terminate cycles and preserve distinct nested versions. Return sorted, relative paths with forward slashes. Dev dependencies are outside this traversal.
- Skip names beginning with `@anthropic-ai/claude-agent-sdk-` or `@openai/codex`, matching the root and nested CLI exclusions in `electron-builder.yml`. Keep the helper and file exclusions aligned; omitting a required launcher override would activate an intentionally absent fallback.

`beforePack` derives one `**/node_modules/<package-name>/**` pattern per discovered name, merges it with existing `asarUnpack` entries and removes duplicates. Matching every depth matters: electron-builder can re-hoist a package after npm installed it nested. A source-directory-only pattern missed that destination. Existing resource unpacking remains part of the configuration.

Unpack patterns only act on packages electron-builder collects. The Claude SDK's required `@modelcontextprotocol/sdk` peer was installed by npm but omitted from the distribution while it was implicit. `package.json` declares `@modelcontextprotocol/sdk` at `1.29.0` as a production dependency, with `package-lock.json` updated accordingly. The app's `@modelcontextprotocol/client` dependency serves a separate consumer and does not replace this peer requirement.

`afterPack` finds the target resources directory through the packager and traverses its actual `app.asar.unpacked` manifests, reporting `Verified … unpacked ACP runtime packages` on success. A missing required package fails packaging before signing/publishing. This is a manifest-resolution guard: it does not execute adapters, validate semver ranges or exports, check native ABI compatibility, or prove optional packages and lazy assets are usable. Its count can differ from the source tree after collection/hoisting; equality of counts is not required.

## Commands and coverage

Run from the checkout with dependencies installed. The fixture source, Node, Electron and TypeScript are checkout-owned test tooling; these are not standalone end-user commands. Runtime commands require an already packaged build and do not build it themselves. Quote paths containing spaces.

| Command | What it establishes |
|---|---|
| `npm run test:packaging` | Eight Node tests: six dependency/hook fixtures and two main-check environment regressions. No package or Electron launch is required. |
| `npm run test:packaged:acp -- <app-executable> <resources-directory>` | Both shipped adapters complete ACP v1 `initialize` using the supplied packaged Electron executable. |
| `npm run test:packaged:main -- <resources-directory>` | The project's installed Electron loads the copied package's external main imports and exercises selected native/WASM/parser paths. |

For a macOS arm64 build, the runtime invocations are:

- `npm run test:packaged:acp -- "dist/mac-arm64/Cinna Desktop.app/Contents/MacOS/Cinna Desktop" "dist/mac-arm64/Cinna Desktop.app/Contents/Resources"`
- `npm run test:packaged:main -- "dist/mac-arm64/Cinna Desktop.app/Contents/Resources"`

Use the executable/resources paths of the target artifact on other platforms. Run runtime checks on a host that supports its native architecture, with the project Electron version/native ABI matching the packaged dependencies for the main check. A passing cross-build guard is not runtime evidence for the target.

`npm test` remains the Vitest suite. It does not run these commands. `.github/workflows/release-linux.yml` runs `npm run test:packaging` after `npm ci`, then `npm run release:linux`, which runs the build hooks. Neither that workflow nor `afterPack` invokes the packaged runtime smoke checks. Those are manual release verification, separate from full [E2E tests](../e2e/e2e.md).

### ACP isolation

`scripts/check-packaged-acp.mjs` copies only the shipped unpacked tree to a temporary directory outside the checkout. Each adapter runs there with temporary HOME/config directories, a constructed environment without inherited loader overrides or credentials, and the packaged executable in Node mode. Each `initialize` has a 15-second deadline; the check terminates the adapter and removes its temporary tree afterwards.

Claude receives an unused executable path because this handshake does not start a Claude turn. Codex starts its app-server during initialization, so the check supplies `src/main/agents/drivers/acp/testSupport/fakeCodexAppServer.mjs` through a temporary launcher. That fixture uses the check runner's Node, while the adapter uses packaged Electron. The POSIX shell and Windows cmd launchers quote Node/server paths through environment values; a raw Node shebang failed when the Node installation path contained spaces. This launcher is test infrastructure, not the production CLI launcher.

### Main-process isolation

`scripts/check-packaged-main.cjs` launches the project's Electron with an allowlist of OS/GUI environment variables and temporary HOME/config/cache/temp directories. It removes `NODE_PATH`, `NODE_OPTIONS`, credentials and inherited `ELECTRON_RUN_AS_NODE` **before startup**. Clearing loader variables inside the probe would be too late: CommonJS dependencies could already use developer packages.

`scripts/packaged-main-probe.cjs` sets temporary userData and copies the actual `app.asar` and unpacked tree outside the checkout, preserving the archive boundary. It uses the checkout's TypeScript parser as harness tooling to discover static external import declarations in the packaged main JavaScript files, excluding built-ins and Electron. Resolve hooks anchor the probe's dynamic imports at the copied main entry. The production app entry is not booted.

The probe imports each discovered specifier, then queries an in-memory `better-sqlite3` database, initializes and hashes with `libsodium-wrappers-sumo`, and extracts synthetic RTF/PDF text through `officeparser`, including the dynamic PDF.js worker path. Import count is discovered from the artifact, not hardcoded. The launcher has a 45-second deadline and the probe a 30-second deadline; both clean up their temporary directories on normal completion/failure.

## Evidence and limits

Measured on macOS arm64: both packaged ACP initializations passed, 21 external main imports loaded, and SQLite, libsodium, RTF and PDF checks passed. The eight fixture/environment tests passed, including a regression that demonstrates CommonJS can load a developer-only package through inherited `NODE_PATH` before asserting the sanitized environment prevents it. The ACP command also passed for both adapters when invoked with a Node executable path containing spaces.

No Windows or Linux packaged runtime verification is established by this evidence; the Windows launcher branch is implementation, not a measured platform result. The checks make no live model request and establish no live login, CLI sandbox/approval behavior, OCR, renderer flow, full application startup, or exhaustive document-format coverage. Static import discovery is supplemented by the named lazy paths, not a guarantee about every dynamic import.

## Diagnosing a failure

| Symptom | Check |
|---|---|
| `beforePack` reports a missing dependency | Inspect the named requiring manifest and installed dependency tree. Required peers count; packages outside the app root do not. |
| `afterPack` fails although discovery passed | Inspect production dependency collection, root/nested `files` exclusions and generated all-depth unpack patterns. A pattern cannot restore a package electron-builder omitted; the MCP SDK peer omission required an explicit production dependency. |
| Adapter exits before `initialize` with module-not-found | Check the shipped unpacked tree, not just the development install or archive contents. Rebuild and run the isolated ACP command. |
| Main imports pass but parsing/native use fails | Follow the reported SQLite, libsodium or parser stage. Imports alone do not exercise native bindings, WASM initialization or dynamically loaded workers. |
| Runtime fails on a different architecture or Electron version | Separate host/ABI compatibility from missing files. Record the actual runtime and target; rerun on a compatible host. |

When an adapter dependency changes, keep manifest collection, CLI exclusions and consumer checks together. When another lazy main-process path becomes relevant, add an explicit probe for its real operation rather than treating static imports as sufficient coverage.
