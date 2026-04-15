# Development Setup

## Purpose

Quick-start guide for developing Cinna Desktop, including commands, tech stack, and known gotchas.

## Commands

```bash
npm install      # Install dependencies
npm run dev      # Start dev server with hot reload
npm run build    # Production build (outputs to out/)
npm run start    # Preview the production build
```

## Tech Stack

| Layer | Tech |
|-------|------|
| Shell | Electron 39 via electron-vite 5 |
| UI | React 19, Tailwind CSS v4 (via @tailwindcss/vite), Lucide icons |
| State | Zustand 5 (ephemeral UI state), TanStack Query 5 (DB-backed data) |
| DB | better-sqlite3 + Drizzle ORM (auto-migrating on startup) |
| LLM | @anthropic-ai/sdk, openai, @google/generative-ai |
| MCP | @modelcontextprotocol/sdk (stdio + SSE + streamable-http, OAuth DCR) |
| IDs | nanoid |
| Markdown | react-markdown + remark-gfm + rehype-highlight |

## Project Structure

```
src/
├── main/                          # Electron main process (Node.js)
│   ├── index.ts                   # App entry, window creation, provider init
│   ├── db/                        # SQLite + Drizzle (schema, migrations)
│   ├── ipc/                       # IPC handlers (chat, llm, provider, mcp)
│   ├── llm/                       # LLM adapters (anthropic, openai, gemini)
│   ├── mcp/                       # MCP manager, OAuth provider, callback server
│   └── security/                  # safeStorage encrypt/decrypt
├── preload/
│   ├── index.ts                   # contextBridge — typed window.api
│   └── index.d.ts                 # Global type declaration
└── renderer/
    └── src/
        ├── main.tsx               # React root
        ├── App.tsx                # QueryClientProvider + layout shell
        ├── assets/main.css        # Tailwind v4 + CSS variables (themes)
        ├── stores/                # Zustand stores (ui, chat)
        ├── hooks/                 # TanStack Query hooks (chat, providers, mcp, models)
        └── components/            # React components (layout, chat, settings)
```

## Gotchas

1. **Tailwind v4 + electron-vite**: Custom CSS MUST be inside `@layer base` in `main.css`, otherwise it overrides Tailwind utility classes (unlayered CSS beats `@layer utilities`)

2. **Preload must be CJS format**: Built as `index.mjs` but MUST use CommonJS (`format: 'cjs'` in `electron.vite.config.ts`). Sandbox mode doesn't support ESM imports — silently fails, causing `window.api` to be `undefined`. Debug with `ELECTRON_ENABLE_LOGGING=1 npm run dev`

3. **`ipcRenderer.postMessage` args**: Message data is the **second argument** to `ipcMain.on` handler: `(event, message)`. Ports are on `event.ports`. Do NOT use `event.message`

4. **safeStorage availability**: `safeStorage.isEncryptionAvailable()` can return false on some Linux setups; keystore falls back to base64

5. **Model lists**: Anthropic fetches dynamically (with hardcoded fallback). OpenAI and Gemini use hardcoded lists — edit arrays in `src/main/llm/{openai,gemini}.ts`

6. **DB migrations are inline SQL**: No drizzle-kit push. Schema changes require ALTER TABLE in `src/main/db/client.ts:runMigrations()`

7. **MCP OAuth callback uses localhost**: Temporary HTTP server on `127.0.0.1` with random port; shuts down after callback or 2-minute timeout. Redirect URI changes each auth flow — DCR handles this

## UI Layout

```
+------------------------------------------+
|  TitleBar (40px, drag region)            |
|  [traffic lights] [sidebar toggle]       |
+------------+-----------------------------+
|  Sidebar   |  MainArea                   |
|  (240px)   |                             |
| [+ New Chat]  Default: centered input   |
|  ChatList  |    controls below input     |
|            |    ([+] left, send right)   |
|            |  Active chat: messages +    |
|            |    input box at bottom      |
|            |  Settings: provider cards   |
|  ---------|                             |
|  Settings  |                             |
|  Theme     |                             |
+------------+-----------------------------+
```

## Theming

- Dark/light via CSS custom properties on `<html data-theme="dark|light">`
- Variables in `src/renderer/src/assets/main.css` inside `@layer base`
- State in `src/renderer/src/stores/ui.store.ts`, persisted to `localStorage('cinna-theme')`
- All components use `var(--color-*)` — no hardcoded colors

## Project Status

### Done
- Electron + React + TypeScript skeleton with electron-vite
- Tailwind CSS v4, SQLite with auto-migration, full chat CRUD
- Three LLM adapters with streaming (Anthropic, OpenAI, Gemini)
- MCP provider management (stdio/SSE/streamable-http) with OAuth DCR
- MessagePort streaming, multi-turn tool-call loop (up to 10 rounds), per-chat model + MCP selection
- Default provider/model, dark/light theme, markdown rendering
- Compact UI with animated sidebar, controls row, metadata popups
- Animated tool call blocks: provider-first badges, shimmer progress bar, smooth expand/collapse

### Known Gaps
- Chat title auto-generation (currently truncated first message)
- Keyboard shortcuts, error toasts, window state persistence
- Inline chat rename, message editing/deletion
- Conversation export, system prompt UI, image/file attachments
- Streaming cancellation cleanup, search across chats
- App packaging (electron-builder configured but untested)
