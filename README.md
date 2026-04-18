# Cinna Desktop

> **Experimental** — This project is in an early experimental phase and under active development. APIs, data models, and features may change without notice. Use at your own risk. Not recommended for production workloads.

> **Tip:** This project is designed to be explored with AI coding assistants. Try prompts like `read core and explain how i can work with a2a agents` to navigate the codebase and understand any feature in depth.
> If you're using an AI assistant other than Claude Code, make sure to include `CLAUDE.md` in the context — it contains the project conventions and navigation instructions.

**Agent Communication Desktop — a lightweight cross-platform chat client for talking to AI agents over open protocols.**

Cinna Desktop is an Electron app that gives you a single, unified interface for chatting with:

- **Cinna agents** running on a [cinna-core](https://github.com/opencinna/cinna-core) server (cloud at `opencinna.io` or self-hosted) — auto-discovered and kept in sync via your account
- **Any A2A-compatible agent** — paste an Agent Card URL and start streaming
- **Raw LLMs** (Anthropic, OpenAI, Gemini) — bring your own API key, optionally extended with MCP tool servers

The goal: no web UI tab per platform, no copy-pasting between tools. One desktop client, any agent, any protocol.

## Why Cinna Desktop

Agentic systems are fragmenting. Every platform ships its own web UI; every LLM provider has its own chat app; every MCP or A2A endpoint needs a separate client. Cinna Desktop is the opposite — a thin, local-first client that speaks the standard protocols (**A2A**, **MCP**) and treats agents, LLMs, and tool servers as interchangeable endpoints you can mix into a single conversation.

Local-first by design:

- API keys and OAuth tokens are encrypted at rest via Electron's `safeStorage` (OS keychain) and never leave the main process
- All conversations, agents, providers, and settings live in a local SQLite database
- Multiple local user accounts with optional password auth, fully data-isolated
- Optional link to a Cinna server via OAuth 2.0 + PKCE for remote agent sync — you opt in

## Key Features

### Chat
- Multi-provider chat (Anthropic, OpenAI, Gemini) with streaming responses over Electron `MessagePort`
- Tool-call loop with live tool execution rendering
- Markdown rendering, syntax-highlighted code blocks, per-message provider/model binding
- Persistent conversations in local SQLite (Drizzle ORM)

### Agents (A2A)
- Register external agents by Agent Card URL — A2A Protocol v1.0 discovery and streaming
- `@-mention` an agent directly from the new-chat input to route the conversation through it
- Remote agents auto-synced from your connected Cinna server, categorized for quick access
- JWT-based authentication for Cinna-hosted agents

### MCP Connectors
- Connect to MCP servers over stdio, SSE, or streamable-HTTP transports
- OAuth with Dynamic Client Registration (DCR) for remote MCP servers
- Tools aggregated across all active connections and exposed to any LLM adapter

### Chat Modes
- Named presets bundling an LLM provider/model, a set of MCP servers, and a color scheme
- One click to start a fully configured conversation

### Accounts
- Local user profiles (PBKDF2-SHA512, 100k iterations) — every chat, provider, and agent is user-scoped
- Built-in guest account for zero-friction first run
- Connect any local account to a Cinna server (cloud or self-hosted) via OAuth 2.0 + PKCE with automatic token rotation

### Developer Experience
- In-app debug logger with full-window overlay (`⌘\``), scoped loggers for main/renderer
- Typed `window.api.*` bridge — fully sandboxed renderer with `contextIsolation` + `nodeIntegration: false`
- Hot-reloading dev server via `electron-vite`

## Architecture

```
+------------------------------------------------+
|                 MAIN PROCESS                   |
|                                                |
|  SQLite (Drizzle)  LLM SDKs  MCP Clients  A2A  |
|  User accounts (PBKDF2)  Session management    |
|  API keys & tokens encrypted via safeStorage   |
|                                                |
|  IPC Handlers (ipcMain.handle / .on)           |
|  + MessagePort for streaming                   |
+------------------+-----------------------------+
                   |  contextBridge (typed window.api)
+------------------+-----------------------------+
|              RENDERER (sandboxed)              |
|  contextIsolation: true, nodeIntegration: false|
|  React 19 + Zustand + TanStack Query           |
|  Tailwind v4, CSS-variable theming             |
|  window.api.auth.* / .chat.* / .providers.*    |
|  window.api.agents.* / .mcp.* / .llm.*         |
+------------------------------------------------+
```

**Security model**: API keys and OAuth tokens are encrypted at rest using Electron's `safeStorage` (OS keychain) and stored as blobs in SQLite. They are decrypted only in the main process. User passwords are hashed with PBKDF2-SHA512 (100k iterations). All data is user-scoped — every IPC query filters by the active user ID. The renderer is fully sandboxed — it can only access the typed `window.api.*` methods exposed via contextBridge.

See [`docs/README.md`](docs/README.md) for the full project index, glossary, and per-feature architecture docs.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Shell | Electron 41, electron-vite, electron-builder |
| Renderer | React 19, TypeScript, Zustand, TanStack Query, Tailwind CSS v4 |
| Main | Node.js, better-sqlite3, Drizzle ORM |
| LLM SDKs | `@anthropic-ai/sdk`, `openai`, `@google/generative-ai` |
| Protocols | `@a2a-js/sdk` (A2A), `@modelcontextprotocol/sdk` (MCP) |
| Crypto | Electron `safeStorage`, PBKDF2-SHA512, OAuth 2.0 + PKCE |

## Quick Start

```bash
git clone https://github.com/opencinna/cinna-desktop.git
cd cinna-desktop
npm install
npm run dev      # launches the app with hot reload
```

To produce a distributable build:

```bash
npm run build
```

See [`docs/development/setup/setup.md`](docs/development/setup/setup.md) for the full development workflow, build validation commands, and project gotchas.

## Contributing

Contributions are welcome. Please open an issue first to discuss what you'd like to change.

## License

[GPL-3.0](LICENSE)
