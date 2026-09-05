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

Four specialists live in `.claude/agents/`. Each is worth delegating to because it does something the main thread does *worse*, not merely something it could offload:

- `cinna-desktop-code-reviewer` — reads the diff cold and rules on it. Run it before committing anything that crosses the main/renderer boundary, runs work concurrently, or touches first run. Its independence is the point: it has not been persuaded by the reasoning that produced the code.
- `cinna-desktop-feature-documenter` — updates the layered docs from the diff. It documents what the code says, not what a summary claims, which is how the two are kept from drifting.
- `cinna-desktop-release` — drives `docs/development/distribution/release.md`, stopping for a human before every irreversible step.
- `e2e-test-writer` — Playwright specs against the built app (`/cinna-desktop.e2e.write <scenario>`).

Implementation stays in the main thread: it holds the context, and the round trip of briefing a separate developer agent costs more than it saves.

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
