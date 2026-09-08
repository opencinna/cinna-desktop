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
- `npx tsc --noEmit --project tsconfig.web.json` — type-check renderer code only
- `make e2e` — build, then drive the real Electron app with Playwright (`e2e/`); `make help` lists the other E2E targets. A manual step, not part of `npm test`. Each test gets a throwaway `HOME` and `userData`; never launch the built app in a test without that sandbox. To add a scenario: `/cinna-desktop.e2e.write <scenario>` (the `e2e-test-writer` agent); writing rules in `docs/development/e2e/e2e_llm.md`

Do NOT use bare `npx tsc --noEmit` — it hangs silently in this project.

## Agents

`/cinna-desktop.feature <request>` runs the whole loop — build, review, fix, document, commit. **The steps below are the default with or without it. Do them unprompted; the user should not have to ask for a review.**

- **Before committing** anything that crosses the main/renderer boundary, runs work concurrently, touches first run, or changes an IPC payload → launch `cinna-desktop-code-reviewer`. Verify each finding yourself before acting on it, then re-review the delta if the fixes were substantial. This is where the expensive bugs are caught: a change can pass its tests, look right in a screenshot, and still never reach the renderer.
- **When a user-visible surface changes** (a component, dialog, page or settings section added or changed) → launch `cinna-desktop-ux-reviewer` alongside the code reviewer. It judges the change against `docs/development/ui_guidelines/ux_rules.md` — nothing jumps while the user types or clicks through a wizard, controls before information, banners only when something needs attention, errors that close nothing, and a settings tab built like the tab beside it — and it looks at the built screen, not just the JSX. Read the rules yourself before building the surface, along with `ui_guidelines_llm.md` for the type scale and the `SettingsLayout` primitives every settings tab is built from; the reviewer is the check, not the first time you meet them.
- **Once the code settles** → launch `cinna-desktop-feature-documenter`. It works from the diff, so when it contradicts your summary of your own change, it is usually right.
- **When a user-visible flow changes** → `/cinna-desktop.e2e.write <scenario>` (the `e2e-test-writer` agent).
- **Cutting a release** → `cinna-desktop-release`, which drives `docs/development/distribution/release.md` and stops for a human before every irreversible step.

Implementation stays in the main thread — it holds the context, and briefing a separate developer agent costs more than it saves. Delegate for **independence** (judging or describing your own work) or **context economy** (a search that would otherwise flood you); if a delegation gives neither, do it yourself.

## Architecture

See `docs/README.md` for the project index, glossary, and domain map. Feature docs live in `docs/{domain}/{feature}/` following the layered documentation structure (see `.claude/commands/cinna-core.feature.doc.md`).

**TL;DR**: Electron main process handles SQLite (Drizzle), LLM SDK calls, MCP connections, and API key encryption (safeStorage). Renderer is fully sandboxed React 19 + Tailwind v4 + Zustand + TanStack Query. Communication via typed `window.api.*` (contextBridge) and MessagePort for streaming.

## Key Conventions

- All colors use CSS variables `var(--color-*)` defined in `src/renderer/src/assets/main.css` — never hardcode colors
- Custom CSS must go inside `@layer base` in main.css (otherwise it overrides Tailwind v4 utilities)
- Preload builds to `.mjs` (CJS format) — main process references `../preload/index.mjs`. Must use `format: 'cjs'` in electron.vite.config.ts because sandbox mode doesn't support ESM imports
- API keys and OAuth tokens never leave the main process — renderer only sees `hasApiKey: boolean` / `hasAuth: boolean`
- Model lists are hardcoded in each adapter (`src/main/llm/{anthropic,openai,gemini}.ts`)
- DB migrations are inline SQL in `src/main/db/client.ts` `runMigrations()` — add ALTER TABLE for schema changes
- `ipcRenderer.postMessage` sends data as the second argument to the `ipcMain.on` handler (not `event.message`) — see `llm.ipc.ts` handler. Ports are on `event.ports`.
- When user says "read core", "read docs", or "read about feature ..." — start context discovery from `docs/README.md` (the project index with glossary, domain map, and feature registry), then follow links from there into the relevant `docs/{domain}/{feature}/` folder
