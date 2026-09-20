# Cinna Desktop

Electron desktop chat client for LLMs (Anthropic, OpenAI, Gemini) with MCP connector support.

## Quick Start

```bash
npm install
npm run dev      # Dev server with hot reload
npm run build    # Production build
```

## Build Validation

- `npx electron-vite build` — full build validation (main + preload + renderer)
- `npm run typecheck` — type-check main, renderer and e2e; `npm run typecheck:web` for the renderer alone
- `make e2e` — build, then drive the real Electron app with Playwright (`e2e/`); `make help` lists the other E2E targets. A manual step, not part of `npm test`. Each test gets a throwaway `HOME` and `userData`; never launch the built app in a test without that sandbox. To add a scenario: `/cinna-desktop.e2e.write <scenario>` (the `e2e-test-writer` agent); writing rules in `docs/development/e2e/e2e_llm.md`
- `make contract ENGINE=claude|codex` — interface contract against the real pinned Claude Code or Codex CLI with a fake provider (not part of `npm test`; its ratchet is); versions live only in `src/shared/runtimePins.ts`, and moving one follows `docs/development/runtime_pins/runtime_pins_llm.md`
- Live-backend sessions — `make live-ctl` + `source scripts/live-backend/live.sh`: drive the built app on the real profile against a running cinna-core (`CINNA_CORE_PATH`) and stop/kill/rewind the server mid-turn. Manual and user-approved only (real profile: back up first, no other Cinna instance); runbook in `docs/development/live_backend/live_backend_llm.md`

Do NOT use bare `npx tsc --noEmit` — it hangs silently in this project. `npx tsc --noEmit --project tsconfig.web.json` does not work either: it fails with `TS6307` on the preload types the renderer imports. The npm scripts pass `--composite false`, which is what makes them work — so run the script, not the raw command it wraps.

## Agents

`/cinna-desktop.feature <request>` runs the whole loop — build, review, fix, document, commit. **The steps below are the default with or without it. Do them unprompted; the user should not have to ask for a review.**

- **Once the design is settled** and the rest is mechanical → hand the chunk to `cinna-desktop-developer` (see below for when). Read its report and its diff, then continue with review.
- **Before committing** anything that crosses the main/renderer boundary, runs work concurrently, touches first run, or changes an IPC payload → launch `cinna-desktop-code-reviewer`. Verify each finding yourself before acting on it, then re-review the delta if the fixes were substantial. This is where the expensive bugs are caught: a change can pass its tests, look right in a screenshot, and still never reach the renderer.
- **When a user-visible surface changes** (a component, dialog, page or settings section added or changed) → launch `cinna-desktop-ux-reviewer` alongside the code reviewer. It judges the change against `docs/development/ui_guidelines/ux_rules.md` — nothing jumps while the user types or clicks through a wizard, controls before information, banners only when something needs attention, errors that close nothing, and a settings tab built like the tab beside it — and it looks at the built screen, not just the JSX. Read the rules yourself before building the surface, along with `ui_guidelines_llm.md` for the type scale and the `SettingsLayout` primitives every settings tab is built from; the reviewer is the check, not the first time you meet them.
- **Once the code settles** → launch `cinna-desktop-feature-documenter`. It works from the diff, so when it contradicts your summary of your own change, it is usually right.
- **When a user-visible flow changes** → `/cinna-desktop.e2e.write <scenario>` (the `e2e-test-writer` agent).
- **Cutting a release** → `cinna-desktop-release`, which drives `docs/development/distribution/release.md` and stops for a human before every irreversible step.

Delegate for **independence** (judging or describing your own work) or **context economy** (work whose file-reading and edit-test cycles would otherwise land in your context); if a delegation gives neither, do it yourself.

**Where implementation runs depends on how settled it is.** Design, decisions with the user, and the first cut of anything whose shape is still moving stay in the main thread — it holds the context, and a subagent cannot take mid-course feedback. Once the decisions are made and what remains is a sequence of edit-test cycles you could specify in a page, hand that chunk to `cinna-desktop-developer` and review its diff instead of watching it work. The cost of a turn is the whole context re-read: a hundred small edits at 300K of history cost more than the feature did, and one long session on this project spent two thirds of its input tokens exactly there. The brief is short because the agent's definition carries the project rules: the decisions and why, the files and entry points, what is out of scope, the commands that prove it done. Run it in the same tree unless you keep editing in parallel, in which case give it a worktree. Between phases — after implementation, after review fixes, before docs — compacting or starting a fresh session is cheaper than carrying the transcript forward.

## Architecture

See `docs/README.md` for the project index, glossary, and domain map. Feature docs live in `docs/{domain}/{feature}/` following the layered documentation structure (see `.claude/commands/cinna-desktop.feature.doc.md`).

**TL;DR**: Electron main process handles SQLite (Drizzle), LLM SDK calls, MCP connections, and API key encryption (safeStorage). Renderer is fully sandboxed React 19 + Tailwind v4 + Zustand + TanStack Query. Communication via typed `window.api.*` (contextBridge) and MessagePort for streaming.

## Hub core versus desktop UI

Agent management and execution are shared Hub core, running in-process in the
desktop. Allocate runtime, task, Inbox, permission, scheduling and persistence
features to the existing `src/main` core services. Allocate windows, dialogs,
tray, updater and deep links to `src/main/host/desktop`; renderer components only
present data and request core operations. Platform calls use `host/runtimeHost.ts`,
notifications use `host/events.ts`, and startup/shutdown live in `hub/core.ts`.
Core imports no Electron or desktop transport. The AST ratchet and plain-Node
fixture turn run with `npm run test:hub`. Read
`docs/development/hub_core/hub_core_llm.md` for ownership, extension points and
Phase 0 evidence limits before implementing or reviewing cross-boundary work.

## Key Conventions

- All colors use CSS variables `var(--color-*)` defined in `src/renderer/src/assets/main.css` — never hardcode colors
- Custom CSS must go inside `@layer base` in main.css (otherwise it overrides Tailwind v4 utilities)
- Preload builds to `.mjs` (CJS format) — main process references `../preload/index.mjs`. Must use `format: 'cjs'` in electron.vite.config.ts because sandbox mode doesn't support ESM imports
- API keys and OAuth tokens never leave the main process — renderer only sees `hasApiKey: boolean` / `hasAuth: boolean`
- Model lists are hardcoded in each adapter (`src/main/llm/{anthropic,openai,gemini}.ts`)
- DB migrations live in `src/main/db/migrations/` — add schema changes to the per-domain modules registered by `runAllMigrations`
- `ipcRenderer.postMessage` sends data as the second argument to the `ipcMain.on` handler (not `event.message`) — see `run.ipc.ts` handlers. Ports are on `event.ports`.
- When user says "read core", "read docs", or "read about feature ..." — start context discovery from `docs/README.md` (the project index with glossary, domain map, and feature registry), then follow links from there into the relevant `docs/{domain}/{feature}/` folder
