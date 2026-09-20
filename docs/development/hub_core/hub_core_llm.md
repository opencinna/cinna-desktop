# Hub core and desktop ownership

Phase 1 extracts a dependency boundary, while the desktop keeps running the core
in its Electron main process. No local daemon, HTTP hop, authentication token,
renderer change, SSH installer or remote Hub API is introduced here.

## Allocate a feature before implementing it

| Responsibility | Sources | Rule |
|---|---|---|
| Agent discovery/configuration, readiness, drivers, turns, runtime pools, tasks, jobs, Inbox, permissions, delegation, schedules, recovery, persistence | `src/main/agents`, `services`, `tasks`, `db`, `auth`, `engine`, `kit`, `sync`, `mcp`, `managed`, `shell` | Hub core. Must load under plain Node. All durable decisions and writes belong here. |
| Shared startup/shutdown and service wiring | `src/main/hub/core.ts`, `hub/agentReadiness.ts` | Run independent of IPC registration. Install a host first; initialize once per process. |
| Platform operations | `src/main/host/runtimeHost.ts` | Neutral contract for paths, app metadata, package resolution, keystore, HTTP/proxy, child Node runtime, shutdown hooks, optional shell operations. No Electron imports or fallback. Resolve paths lazily, after profile overrides. |
| Electron implementation, native dialogs, tray, updater, icons, deep links | `src/main/host/desktop` | Desktop-only. Concrete windows and Electron types stay here or in `ipc`, `window`, `index.ts`. |
| Local Development workspace orchestration | `src/main/localdev/{localDevService,developmentSessionService,...}.ts` | Desktop feature. Inject through `host/desktopFeatures.ts`; never import these orchestration services from core. `localdev/toolchain.ts` remains a reusable host-neutral tool helper used by agent detection. |
| IPC and MessagePort | `src/main/ipc`, `src/preload` | Desktop transport. Call core services; no new business logic or DB queries in handlers. |
| Presentation and interactions | `src/renderer` | UI only. Use typed preload contracts; never import main/core or access SQLite, credentials or process management. |
| DTOs, event envelopes, pure contracts | `src/shared` | No runtime imports from main. |

The existing core domain directories remain where they were: `src/main/hub` is the
composition boundary, not a second copy of those implementations. A new task or
permission rule belongs in the existing core service, even when the first caller
is a desktop button. Ask whether the behavior must work with no window attached.
If yes, own it in core; the button only requests it and renders the result.

## Host and event contracts

`index.ts` installs `createDesktopHost()`, the desktop event publisher and optional
desktop features before `initializeHubCore()`. Electron `net.fetch`, safeStorage,
proxy routing and unpacked adapter resolution retain their desktop behavior.
`cinnaWriteFetch` still uses its one-shot Undici dispatcher; only proxy resolution
is injected. Never replace that write path with retrying fetch middleware.

Core pushes DTOs through `publishEvent(channel, payload, audience)`. The desktop
adapter resolves live windows at send time. `main` preserves former main-window
notifications; `all` preserves sync and Local Development broadcasts. Logger
already has a neutral `setLogSink`; its window adapter is
`host/desktop/logBroadcast.ts`. No core service may obtain a `BrowserWindow`,
import `index.ts`, `window/*`, `ipc/*`, or `host/desktop/*`, including through a
re-export or dynamic import. UI-dependent actions such as browser login or
revealing a file go through host capabilities; a headless host can explicitly
refuse them. Missing capabilities must never silently perform desktop actions.

Local Development hooks preserve profile-switch invalidation and driver runtime
configuration. The absent extension returns no development context and rejects
attempts to restore a desktop build session. It does not load the desktop feature.

`shutdownHubCore()` persists partial turns and signals child processes before its
first await. Electron calls it on quit; a Node owner can await it before closing
SQLite. Viewer unsubscribe only detaches `liveRunHub.watch`; it never shuts down
the core or cancels a turn. Owning processes still end at actual desktop Quit.

`ipc/_wrap.ts` registers wrapped handlers in the generic `HandlerRegistry<Context>`
and installs an Electron invoke adapter. Activation checks and existing thrown vs
returned error behavior remain intact. The table is internal: it is not a remote
API and must not be exposed wholesale. Phase 2 needs its own narrow authenticated
transport and request context, not synthetic Electron events.

## Verification and limitations

- `npm test`: includes `hub/boundary.test.ts`, which runs the AST import ratchet.
- `npm run test:hub`: import ratchet plus a plain-Node bundle/boot/turn experiment.
  The bundle rejects desktop modules and Electron dependencies, including transitive
  ones. CI runs it on Linux; no Electron mock or runtime download is involved.
- `npm run typecheck`, `npm run test:packaging`, `npm run build`,
  `make e2e-offline`: desktop regression checks. Build before E2E.
- For a packaged build, also run `npm run test:packaged:main -- <resources>`
  with matching Electron and `npm run test:packaged:acp -- <executable> <resources>`.
  These check the shipped dependency tree and native modules outside the checkout.
- `npm run test:contract`: real installed pinned CLI/adapter contracts against fake
  loopback providers, in temporary profiles. Does not download absent binaries.

The Node spike uses a temporary HOME and database, a scripted ACP child, fixed
`__default__` profile activation, shared run execution and Inbox services. It
unsubscribes a viewer, parks a permission with no viewer, reattaches, answers, then
checks the saved assistant transcript after closing/reopening SQLite. No UI,
real credentials or provider requests are needed. Local loopback access is needed
for the production conductor MCP server.

This is not `cinna-hub serve`. Its SQLite factory injects the existing diagnostic
`node:sqlite` adapter; production desktop keeps `better-sqlite3`. The installed
Electron native addon cannot be reused by Node (measured ABI 145 vs 127). A shipping
hub must supply a Node-built addon, or separately validate a production
`node:sqlite` driver. The narrow test adapter is not that driver. The spike refuses
secret encryption and desktop actions; no production headless keystore exists yet.

See `phase0_results.md` in this directory for the evidence and the real-host
checks that this offline spike cannot establish. Do not treat a short scripted
permission wait as an hour-long Claude/Codex run or an SSH/service-manager test.
