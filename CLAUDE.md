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

Do NOT use bare `npx tsc --noEmit` — it hangs silently in this project.

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
- When user says "read core" — read `docs/README.md` (the project index with glossary, domain map, and feature registry)
