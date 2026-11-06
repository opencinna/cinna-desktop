# Dependency Updates

What Cinna Desktop depends on, where each version lives, how to tell what is stale or vulnerable, and the order to move things in. The procedure for moving an **agent runtime** pin is [Runtime Pins](../runtime_pins/runtime_pins_llm.md); this page decides *when* and *in what order*, and keeps what each update round taught us.

## Three kinds of dependency

| Kind | Version lives in | Moved by | Proof it still works |
|---|---|---|---|
| **npm packages** (main, preload, renderer, build, tests) | `package.json` + `package-lock.json` | `npm install <pkg>@<ver>`, this page | `npm test`, `npm run typecheck`, `npm run test:hub`, `npm run test:packaging`, `npx electron-vite build`, then E2E |
| **Agent runtimes** — Claude Code, Codex, OpenCode, Antigravity ACP server, managed git; and the two ACP **adapters** (`@agentclientprotocol/claude-agent-acp`, `@agentclientprotocol/codex-acp`), which are npm packages pinned **exact** and patched at postinstall | `src/shared/runtimePins.ts` (`RUNTIME_PINS`); adapters also in `package.json` and `src/main/agents/drivers/acp/*AdapterPatch.json` | [Runtime Pins → Moving a pin](../runtime_pins/runtime_pins_llm.md#moving-a-pin) | `make contract ENGINE=…` (unbilled, fake provider), the ratchet in `npm test`, then billed `make live-flow` / live specs |
| **Managed toolchain** — uv (and the Python it installs) | `src/main/localdev/toolchain.ts` (`PINNED_UV_VERSION` + four per-platform digests) | by hand: bump the version, recompute all four `sha256`s | `npm test`; the bare-Mac run for first-run behaviour |

## Risk tiers (npm)

| Tier | Packages | Why it matters | How to move |
|---|---|---|---|
| **1 — runtime-coupled** | the ACP adapters, `@agentclientprotocol/sdk` | patched source with recorded digests; an interface contract covers them | only by the Runtime Pins procedure, never by `npm update` (exact pins prevent it) |
| **2 — security surface** | `electron`, `electron-updater`, `electron-builder`, `undici`, `@modelcontextprotocol/sdk` / `client`, `@anthropic-ai/sdk`, `openai`, `@google/genai`, `@anthropic-ai/claude-agent-sdk`, `@a2a-js/sdk`, `socket.io-client`, `ws` | network, update channel, sandbox, keys | every release: no unexplained high/critical advisory; Electron must stay within the three supported majors |
| **3 — native / ABI** | `better-sqlite3` (rebuilt per target by `npmRebuild: true` in `electron-builder.yml`), `libsodium-wrappers-sumo`, `@napi-rs/canvas` (transitive) | a wrong ABI or arch passes on the host and fails in the package | move with the Electron major; prove with `npm run test:packaging` and a packaged build ([Packaged Runtime](../distribution/packaged_runtime.md)) |
| **4 — build & test tooling** | `electron-vite`, `vite`, `@vitejs/plugin-react`, `vitest`, `jsdom`, `typescript`, `tailwindcss` + plugins, `postcss`, `esbuild`, `ssri`, `@playwright/test`, `@types/*` | breaks the build, not the user | as one group: electron-vite pins the vite major, vitest follows vite |
| **5 — UI & utilities** | `react`, `react-dom`, `@tanstack/react-query`, `zustand`, `lucide-react`, markdown stack (`react-markdown`, `remark-*`, `rehype-*`, `unified`, `hast-util-to-jsx-runtime`, `lowlight`), `@xterm/*`, `drizzle-orm`, `nanoid`, `officeparser`, `qrcode`, `@scure/bip39` | visible regressions | in-range freely; majors one at a time |

Exact pins outside tier 1 — `unified`, `remark-parse`, `undici` — are deliberate; read `git log -S'"<pkg>": "'` -- package.json before relaxing one.

## Checking

```bash
npm outdated                          # Current / Wanted (in range) / Latest
npm audit --omit=dev                  # what ships; the full `npm audit` adds build/test tooling
node --experimental-strip-types scripts/runtime-compat.mjs latest claude   # pin= latest= changed=
node --experimental-strip-types scripts/runtime-compat.mjs latest codex    # GitHub API; retry on 5xx
npm view @opencode/cli version
gh api repos/astral-sh/uv/releases/latest --jq .tag_name
gh api repos/desktop/dugite-native/releases/latest --jq .tag_name
```

Antigravity's newest version is found by hand ([Runtime Pins](../runtime_pins/runtime_pins_llm.md#moving-a-pin)). Electron's supported majors: <https://www.electronjs.org/docs/latest/tutorial/electron-timelines> — only the latest three are supported.

## Cadence

- **Every release** — the pre-flight in [Release](../distribution/release.md#1-pre-flight-checks) runs `npm audit --omit=dev` and `npm outdated`. A high or critical advisory in a direct dependency is either fixed (an in-range `npm update <pkg>` is usually enough) or named, with the reason, in the release notes draft. An Electron major that has left support blocks the release until an update round is scheduled.
- **Weekly** — the runtime compatibility check in [Runtime Pins](../runtime_pins/runtime_pins_llm.md#the-weekly-compatibility-check-manual) (unbilled).
- **Monthly, or before a feature release** — an update round, below.

## An update round

1. **Snapshot** — `npm outdated` and `npm audit --json` into `drafts/deps_update/` (gitignored), and a **baseline** of the unbilled checks on the untouched tree (`npx vitest run`, `npm run typecheck`, `npm run test:hub`, `npm run test:packaging`, `npx electron-vite build`), so a failure afterwards is known to be new.
2. **Read the release notes** of every major (and every runtime) between pin and latest, and grep our code for each breaking change before installing anything.
3. **Move in groups, heaviest first**, re-running the unbilled checks after each group:
   1. Electron + build toolchain (tiers 2–4 that move together: `electron`, `electron-builder`, `electron-updater`, `electron-vite`, `vite`, `@vitejs/plugin-react`, `vitest`, `jsdom`, `better-sqlite3`, Tailwind, `@types/node` matched to Electron's Node)
   2. LLM and protocol SDKs
   3. Agent runtimes and adapters — one engine at a time, by the Runtime Pins procedure up to its unbilled steps
   4. UI and utilities; `typescript` last, since it judges everything else
4. **Unbilled verification** — the five checks above, `make contract ENGINE=…` for every moved runtime, then single E2E specs (`make e2e-one SPEC=e2e/specs/<name>.spec.ts`, after a build — it does not build) for the surfaces the round touched. Never the whole suite. `make bare-mac` belongs here too whenever Electron, a runtime or the managed toolchain moved; after a Playwright bump, `npx playwright install chromium-headless-shell` first.
5. **Billed verification, with the user's approval** — `make live-flow ENGINE=claude|codex CONFIRM=1`, the live specs on each engine one at a time, a packaged build and the bare-Mac run when Electron, the updater or native modules moved.
6. **Record** what the round taught under *Findings* below, then fold anything structural into the doc it belongs to.

## Findings

What an update round learned that the next round would otherwise have to rediscover. Newest first. Keep each entry to the fact and the action; move it into the relevant feature doc when it becomes permanent behaviour.

### Round 2026-11 (from 0.10.0)

**Billed and manual verification** (newest first)
- **MCP client 2.4 against a real OAuth server** (`live-mcp-oauth.spec.ts`, local cinna-core's agent MCP connectors: OAuth 2.1, DCR, PKCE): sign-in through the loopback redirect, a relaunch with no new sign-in, an issuer-less (pre-2.4) token record still connecting, and a refused access token refreshed silently with the issuer stamped back. The client stamps a missing issuer only when it runs its auth flow (a 401), never on a token that still works. Core must advertise its MCP issuer on the URL Desktop connects to (`make mcp-set-url URL=http://localhost:8000` for the run). The cross-host redirect refusal stays untested.
- **Opt-in live specs drift silently.** The sharing, catalog and team specs need fixtures (`live-catalog.py`, `live-team-sharing.py`), so nothing runs them by default; 11 of their tests had drifted from UI work since (the "published" wording, the stacked Share dialog, the kit's `cinna-dashboards` skill in OpenCode's `permission.skill`, a row's install-link button) — none was a product or dependency bug. Run them in every round.
- **Run `make bare-mac` early, not only before a release.** Its first run in this round failed five specs on Apple's "Install Command Line Developer Tools" dialog: `uv python install` (the pre-warm), a first `uv run` and `uv tool install` patch the downloaded CPython with `install_name_tool`, found by `PATH` — on a Mac without the tools that is the `/usr/bin` stub. Not caused by the round: 0.10.0 already raised it (the pre-warm shipped there) and no full bare-Mac pass had run since. Every app-spawned uv now runs under the developer-tool shims; uv only warns when the patch fails. Find the culprit in a kept VM (`CINNA_BARE_KEEP=1`) with `/usr/bin/log show` (in the guest's zsh, `log` is a builtin): the CLT request names its PID and parent.
- **OpenCode 2.2.5 paints its `--version` line when colour is forced** (`FORCE_COLOR`, which Playwright passes to the app), so the exact pin comparison discarded the downloaded pinned engine ("The downloaded engine was not opencode 2.2.5"). Only specs without `engine: true` download it, so most of the suite never saw it; `live.spec.ts`'s plain chat did. The probe now runs with `NO_COLOR=1` and strips ANSI, and a refused download logs what it probed. Same lesson as Codex's login wording: CLI output Cinna parses breaks on minor releases — check version, status and login lines under `FORCE_COLOR` too.
- **A Playwright bump needs `npx playwright install chromium-headless-shell`.** Without it every spec that opens core's web page (`live-artifacts`, `live-artifacts-access`) fails with "Executable doesn't exist"; Electron specs are unaffected, so it hides until a live run.
- **ACP SDK 2.x removed `ClientSideConnection`**, which the drafts probes (subagent probe, ad-hoc live probes) imported; `drafts/deps_update/live/rawAcp.mjs` is a raw JSON-RPC stand-in with the same surface.
- Claude 2.1.318 on a real login: `make live-flow` 16/16; `promptSuggestions: false` sends no `prompt_suggestion` after two turns while the control session sends one; the subagent probe (`drafts/subagent_probe`, S1–S4) shows the patched resume routing working (the resumed generation gets its frames and children, no dropped updates) and its replay through the driver ends every subagent `completed`. Tool search is on for real logins (`SendMessage` is a deferred tool); restricted conductor chats still reach Cinna's tools. Fork subagents stayed unprobed.
- Codex 0.167 on a real login: conductor probe 40/40, `make live-flow` 16/16, an API-key login parses as `api_key` from `API key configured - sk-…`, `live-subagents` C (Stop ends the tree) passes. Patch edit 4 (whole command output) is still needed: unpatched 2.5.0 resends output only when nothing streamed.
- **A live spec that asserts on a side effect and then ends kills the turn still running** (the agent's closing reply), so `checkLiveEngine` finds no `ACP turn complete` — every time on Codex, which is slower to reply than OpenCode. Wait for the chat's `activeRunId` to clear (`live-folder-tasks` does now). `live-dispatcher` and `live-delegation` end the same way on their last turn.
- Antigravity 1.4.5 real Flash turns work, but the whole-turn `usage` was not confirmed: the account's quota ran out mid-spec. The quota notice ("Usage Limit Reached …") arrives as the reply text, not as an error.
- Core-side, not desktop: `live-artifacts` L6 — the cloud agent published revision 2, but the Markdown core served lacked the added line.

**Before starting**
- The baseline on a clean `main` was not green: `kindBranches.test.ts` had drifted (fixed in the round), and `ChatList.test.tsx` flakes under full-suite load and passes alone. Take a baseline every round; never assume `main` is green.
- `scripts/runtime-compat.mjs latest codex` reads the GitHub API and fails on a 504; `gh api repos/openai/codex/releases --jq '[.[]|select(.prerelease|not)|.tag_name][0]'` is the fallback.

**Electron**
- Electron 41 left support on 2026-08-24, with advisories that have no 41 fix. Supported majors move every ~8 weeks, so an update round every two months at the latest keeps us inside the window.
- **44 made `clipboard` async and W3C-shaped**: `read(format)`, `readBuffer`, `readImage` are gone, `readText`/`writeText` return Promises, and raw formats go through MIME types (`text/uri-list` is the native file-reference format on every OS). Any synchronous IPC answered from the clipboard (`event.returnValue`) has to become async.
- **Electron ≥43 needs `better-sqlite3` 13** — 12.x prebuilds stop at Electron 42. 13 is N-API with the binaries in the npm package.
- **45 deprecates the synchronous `safeStorage` calls; 46 (due 2027-01-05) removes them.** `RuntimeHost.keystore` is synchronous, with ~18 caller files — that refactor must land before the round that takes 46.
- 44 dropped macOS 12; release notes must say macOS 13+. **Installs on the dropped macOS would auto-update into an app that won't open**: electron-builder writes the minimum only into `Info.plist`, never into `latest-mac.yml`. electron-updater (6.8.3 and later) skips an update whose manifest names `minimumSystemVersion` above `os.release()`, the Darwin version (macOS 13 = `22.0.0`); the release runbook's draft check adds that line (`release.md`, step 6). Raise it whenever Electron drops another macOS.
- `@types/node` follows Electron's bundled Node (45 → Node 24), not the developer's Node.
- **The async clipboard port (done in this round):** `text/uri-list` read through `clipboard.read()` carries every file of a Finder copy on macOS (CRLF-separated, percent-encoded), and an Excel-style copy reads as `text/plain` + `image/png` with no uri-list — so `pastedFiles.ts` now parses only that one format. The composer cancels the native paste only when the event has both `Files` and text, asks main asynchronously, and inserts the text with `execCommand('insertText')` so Cmd+Z still undoes it.
- **electron-builder 26.18 stopped installing ~82 packages transitively**, among them `ssri`, which `scripts/packaged-dependencies.cjs` (the beforePack hook) requires; it is a declared devDependency now. After any electron-builder bump, run `npm run test:packaging` before anything else and check that every `require` in `scripts/*.cjs` names a declared package.
- A TIFF-only pasteboard (only `public.tiff`, written through `NSPasteboard`) still reads as `image/png` through Electron 45's `clipboard.read()` on macOS. An osascript `as TIFF picture` probe adds a `PNGf` copy and proves nothing. `nativeImage.createFromBuffer` decodes JPEG but not TIFF, so the non-PNG fallback in `clipboard.ts` covers JPEG only.
- Electron 45 downloads its binary on the first `require('electron')`, not only at postinstall.
- The x64 packaged-main probe under Rosetta takes ~63 s, longer than the script's former 45 s deadline; a timeout there is not a broken package. `test:packaged:main` and `test:packaged:acp` check one architecture per run.
- better-sqlite3 13 ships all eight platform prebuilds plus its `deps/` and `src/` inside the package, and the mac packages carry all of them; a `files` exclusion in `electron-builder.yml` would trim them.

**Build toolchain**
- vite 8 moves together with `@vitejs/plugin-react` 6, `electron-vite` 6 and `vitest` ≥4 (vitest 3 bundles vite ≤7 as a direct dependency).
- `scripts/check-hub-core.mjs` imports `esbuild`, which was only reachable through electron-vite 5 / vite 7; it is a declared devDependency now, on the `^0.27` line vite 8's optional peer accepts (0.25 conflicts).
- **npm 10 can crash resolving the vite 8 group** (`Cannot read properties of null (reading 'edgesOut')`), on an optional-peer chain that reaches `jsdom@31` and its `@napi-rs/canvas` peer. What worked: uninstall the old vite/vitest/electron-vite, `npx npm@11 install --package-lock-only`, `npm ci`, then a plain npm 10 `npm install` to normalize the lockfile. Afterwards a plain npm 10 `npm install` leaves the lockfile unchanged, and CI uses `npm ci`.
- electron-vite 6 adds `externalizeDepsPlugin` to main and preload by default (remove the explicit call), and `build.rollupOptions` is `rolldownOptions`. The preload stays `format: 'cjs'` → `.mjs`, still a single `require("electron")`, but rolldown drops its `"use strict"` header.
- **rolldown splits `out/main` into ~84 statically imported chunks** (14 files under vite 7). Startup, E2E and the packaged probe pass; module evaluation order is the new thing to suspect when a main-process singleton misbehaves after a toolchain bump.
- vitest 4 types an untyped `vi.fn()` as `Mock<Procedure | Constructable>`, which is not callable; `ReturnType<typeof vi.fn>` annotations become `Mock<(...args: any[]) => any>`. vitest 4 also gave the *real* module to the second of two concurrent dynamic imports of a mocked module; vitest 5 fixes it. Skip from vitest 3 straight to 5.
- `@tailwindcss/vite` sat in `dependencies`, so lightningcss and Tailwind's native oxide shipped inside the app; it is a devDependency now.
- vitest 5 suggests `pool: 'vmThreads'`: jsdom setup is ~40% of the renderer test time.
- `jsdom` 31 conflicts with the `@napi-rs/canvas` 0.1.x already in the tree; wait for it.

**TypeScript**
- TS 6 and 7 reject `baseUrl` (`tsconfig.web.json`) and need `./` on `paths` entries.
- **TS 7.0 ships no JavaScript API** (`require('typescript')` returns only the version), which `scripts/check-hub-boundary.mjs` (in `npm test` and CI), `scripts/packaged-main-probe.cjs` and the Codex contract harness use. Stay on 6.x until 7.1 brings the API back.

**LLM and protocol SDKs**
- `@anthropic-ai/sdk` 1.x sends the key as `Authorization: Bearer`. `src/main/llm/anthropic.ts` forces `x-api-key` already; test fakes that read `x-api-key` (`managedPeer.ts`, `e2e/fixtures/managedService.ts`) must accept both.
- `@anthropic-ai/sdk` 1.x also stopped adding `?beta=true` to the models-list URL, added a `'refusal'` stop reason and requires `stop_details` on managed idle events (fixtures carry `stop_details: null`). A managed session that went idle with `stop_reason: refusal` never ended its turn; that gap predated the bump, the 1.x types made it visible, and the round closed it: the turn now settles as failed with the refusal's reason, in a live run and in recovery (`managedEvents.ts`, `managedTurnRecoverer.ts`).
- **The Gemini adapter is on `@google/genai` now** (3.0.0), through `models.generateContentStream`, because `chats.create` throws on our `function` role for tool results and rewrites history. The new SDK reads Vertex, base URL, API version and key from the shell environment, so the adapter pins `vertexai: false`, `apiVersion: 'v1beta'` and the base URL. It refuses before sending a schema node with both `type` and `anyOf`, or a bare `type: 'null'`, which `geminiSchema.ts` now rewrites. Its errors are a JSON body, rebuilt into the old `[<code> <STATUS>] message` shape.
- `@modelcontextprotocol/client` 2.4 keeps stored OAuth tokens that have no issuer (it stamps them on first use and logs a warning), so connectors do not sign in again. It no longer follows a redirect to another host, so a connector URL that redirects cross-host now fails.
- `@agentclientprotocol/sdk` 2.4 delivers the permission-request fields we read exactly as 1.8 did.
- What `npm audit fix` (non-forced) clears, and what only a major clears: `zod` (moves with `claude-agent-acp`), `pdfjs-dist` (needs `officeparser` 8), `esbuild` 0.28. Several advisories come in through `@a2a-js/sdk`'s express server dependencies.
- `@a2a-js/sdk` 1.x is the A2A 1.0 protocol rewrite (`A2AClient` removed, part shapes changed); it moves only together with cinna-core.
- `@google/generative-ai` is end-of-life in favour of `@google/genai`; `npm outdated` does not show it, because the old package has no newer version.
- The ACP adapters each carry their own nested `@agentclientprotocol/sdk`, so ours can move independently of them.

**Runtimes and adapters**
- An adapter bump drags the CLI pin with it: `claude-agent-acp` 0.101.0 pins `claude-agent-sdk` 0.3.318 exactly (≈ Claude Code 2.1.318), and `codex-acp` 2.5.0 expects Codex 0.165+. Move adapter and CLI as one task per engine.
- **Claude, moved in this round** (adapter 0.89.1 → 0.101.0, CLI 2.1.296 → 2.1.318, `claude-agent-sdk` pinned exact at 0.3.318, the SDK's `claudeCodeVersion`):
  - The research reports disagreed about the patch. The tarball settled it: `native-subagents.js` was rewritten, yet every anchor still occurs once. The adapter's own resume routing covers only its "RFD" subagent form; the `_meta.jetbrains.air` declaration selects the "AIR" form, where the old bug remains, so all seven edits stay. **Settle patch questions against `npm pack <adapter>@<ver>`, never against release notes.**
  - **0.101.0 turns `promptSuggestions` on for every session**: one hidden, billed model request after each turn, shown only to AIR clients. The launcher sends `promptSuggestions: false`, and the contract entry `claude.session.prompt-suggestions-off` holds it. On every adapter bump, look for new default-on options that make model requests.
  - 0.101.0 starts sessions in `auto` mode. The launcher's `set_mode` after every new/load overrides it, but any harness or probe that skips `set_mode` lands in auto, whose reviewer a fake provider cannot answer.
  - CLI 2.1.304 enables tool search behind a custom base URL, so the contract's fake provider saw deferred tools. The contract harness sets `ENABLE_TOOL_SEARCH=false`; tool search itself is uncovered.
  - `session_info_update` races the end of the first prompt (the CLI's title), so the snapshot no longer lists it among first-prompt update kinds.
  - `earlierPatches` reversals die with the version they reverse to; empty the map on an adapter bump.
- `codex-acp` 2.5.0 renamed two anchors our patch needs (`createMcpSeverConfig` → `toCodexMcpServerConfig`, `resumeThread({` gone) and gained a native ACP `systemPrompt`, which may replace our `_meta.cinna.systemPrompt` edit.
- `claude-agent-acp` 0.101.0 rewrote `dist/native-subagents.js` (609 → 1864 lines) and routes SendMessage resumes itself.
- **Codex, moved in this round** (adapter 2.2.2 → 2.5.0, CLI 0.162.1 → 0.167.0):
  - The patch's MCP merge is re-anchored on `toCodexMcpServerConfig` and the resume edit on `resumeThreadWithInstructions({`; all five edits stay. We keep `_meta.cinna.systemPrompt` rather than 2.5's native ACP `systemPrompt`, which appends to the configured instructions, refuses on a busy thread and needs the `/unstable` SDK types.
  - The adapter's `@openai/codex` dependency range (^0.165) is not enforced in code; Cinna runs the pinned CLI through `CODEX_PATH`, so that npm copy is unused.
  - **0.167 changed the API-key line of `codex login status`** (`API key configured - sk-…` instead of `Logged in using an API key`), and login detection fell to `unknown`. The contract's `login-status` entry now holds an API-key login too. **CLI output that Cinna parses is the first thing a minor CLI release breaks.**
  - The 0.166 `codex-exec-server-<triple>` asset is optional (the executor is linked into `codex`), so it is not a companion.
  - `cli_daybreak` and `plugin_discovery_prefetch` joined the deny-list as precautions.
- Codex's restricted-chat policy (`codexConductorPolicy.ts`, `FEATURES_DISABLED`) is a deny-list: a new default-on feature is let through silently. Diff `codex features list` between old and new pin on every bump.
- OpenCode 2.0.30 brought `OPENCODE_DISABLE_CLAUDE_CODE` back, and 2.1.0 changed its storage format, so a profile cannot go back to 2.0.x afterwards.
- Antigravity publishes no release notes; the latest version is in the ACP registry, and its contract is the only check. **1.3.0 → 1.4.5, moved in this round**, failed seven contract entries before it was taken: the prompt answer now carries a token `usage` that is the sum over the whole turn (read as such since), the workspace-cwd quirk is fixed upstream, unasked MCP calls now carry `_meta.mcp` like asked ones, `run_workflow` is a new built-in tool, and `start_subagent` is a deprecated alias of `invoke_subagent`, so filters must name both. Its macOS zip shrank to 93 MiB.
- **OpenCode 2.0.27 → 2.2.5, moved in this round**, changed nothing the contract looks at. `OPENCODE_DISABLE_CLAUDE_CODE(_SKILLS)` is back in the binary, but the plugin opt-out alone still hides personal skills, so Cinna does not set it. The default-on `experimental_image_generate` tool already falls under every profile's `'*': 'ask' | 'deny'`. Its 2.1.0 storage change means a 2.0.x copy on the user's PATH may not read sessions 2.2.5 wrote (untested).
- git (dugite-native `v2.56.0-2`) and uv 0.13.7 moved by hand; GitHub's and Astral's published digests are an independent check on the ones computed.
- **Unit-test flakes rise when agents build in parallel.** `ChatList`, `serviceCredentials/service`, `CopyInstallLinkButton`, `dashboardRefreshService` and `acpDriver` each failed once under load and passed alone. Judge the suite from one quiet run at the end.

**Utilities**
- `lucide-react` 1.x removed brand icons (`Github`); renamed icons survive as aliases.
- `officeparser` 8 replaced `ast.toText()` with `(await ast.to('text')).value`, and from 8.1 it runs pdf.js in a child process (`ELECTRON_RUN_AS_NODE`). The packaged-main probe now proves that child works in both mac packages: a child that cannot start leaves a `PDF_SEPARATE_PROCESS_UNAVAILABLE` warning, and the probe fails on any. 8.5's Node floor admits Electron 45's Node 24.22 but not the developer/CI Node 22.23, so the pin is `~8.4.1` until local Node moves.
- The x64 packaged probe under Rosetta reaches officeparser at ~62 s, so the probe's own deadline now follows the launcher's (passed as an argument) instead of a fixed 30 s.
- `@tanstack/react-query` 5.106 rejects an object literal in `setQueryData<T>` whenever `T` is a union or nullable (TS 5.9 and 6.0 alike). Pass a typed const instead.
- TypeScript 6.0 needed only the `tsconfig.web.json` `baseUrl`/`./paths` change.
- `npm audit fix` (non-forced) took `electron-builder` to 26.18.1 on its `v26` dist-tag, newer than `latest`. What it cannot clear is dev-only: `esbuild` 0.27 (fix is 0.28, `--force`) and `minimatch` through `@electron/universal` (`--force` would downgrade electron-builder to 24). Never `--force`.
- Removed as unused: `drizzle-kit`, `libsodium-wrappers` (non-sumo), `@types/libsodium-wrappers(-sumo)` (stubs) and `autoprefixer`. `@tailwindcss/postcss` stays: `postcss.config.js` uses it, possibly a second Tailwind pass beside `@tailwindcss/vite` (unverified). `@tailwindcss/vite` moved to `devDependencies`.
- `lucide-react` 1.x redrew ~54 of the icons we use; renamed ones still resolve as aliases, so nothing fails and only a look at the screens shows the change.
- `unified` and `remark-parse` are pinned exact on purpose: `nestedFences.ts` must parse with the single copy react-markdown renders with.
