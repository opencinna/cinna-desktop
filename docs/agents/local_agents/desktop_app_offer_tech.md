# Detected Desktop Apps — Technical Reference

Business rules: [desktop_app_offer.md](desktop_app_offer.md).

## File Locations

- **Shared** — `src/shared/desktopApps.ts`: `DesktopAppId`, `DetectedDesktopApp`, `isDesktopAppId()`, the phase/result types, `DESKTOP_APP_PHASE_LABEL`, `DESKTOP_APP_BUTTON_LABEL`, `visibleDesktopApps()` (the dismissal filter), `hasWorkingRuntime()` with its `RuntimeSetup` / `CliRuntimeSetup` inputs (the visibility rule) and `desktopAppsBannerText()` (the one sentence)
- **Main**
  - `src/main/services/localAgents/desktopAppsService.ts` — `DESKTOP_APP_SPECS`, `desktopAppRoots()`, `detectDesktopApps()`, `desktopAppsService.list()` (memoized), `resetForTests()`
  - `src/main/services/localAgents/desktopAppConnectService.ts` — `adoptDesktopEngine()`, `createDesktopAppConnect(deps)`, the production `desktopAppConnectService`
  - `src/main/ipc/local_tools.ipc.ts` — the three handlers below
- **Preload** — `src/preload/index.ts`: `window.api.localTools.desktopApps()`, `desktopAppConnect(appId)`, `desktopAppRunning()`
- **Renderer**
  - `src/renderer/src/components/chat/DesktopAppsBanner.tsx` — the banner
  - `src/renderer/src/hooks/useDesktopApps.ts` — `useDesktopApps`, `useDesktopAppRunning`, `useDesktopAppConnect`
  - `src/renderer/src/stores/desktopApps.store.ts` — dismissals
  - `src/renderer/src/components/layout/ChatWorkspace.tsx` — mounts the banner on the new-chat screen when not `embedded`
- **Tests** — `src/shared/desktopApps.test.ts`, `desktopAppsService.test.ts`, `desktopAppConnectService.test.ts`, `DesktopAppsBanner.test.tsx`; E2E `e2e/specs/desktop-apps-offer.spec.ts`; bare-Mac `e2e/bare-mac/specs/desktop-apps-offer.spec.ts`

## Database Schema

None of its own. Adopt writes `app_settings.localAgentsDefaultEngine` and may insert or update a `chat_modes` row; dismissals are in `localStorage`.

## IPC Channels

All three call `userActivation.requireActivated()`.

- `local-tools:desktop-apps` → `DetectedDesktopApp[]` — `desktopAppsService.list()`; never rejects (a failed scan logs and answers `[]`)
- `local-tools:desktop-app-connect` `(appId: unknown)` → `DesktopAppConnectResult` — only the id crosses, checked by `isDesktopAppId()` in the service; an unknown id is `{ outcome: 'failed', reason: 'Unknown app.' }`
- `local-tools:desktop-app-running` → `DesktopAppConnectRunning | null` — the app and phase of the connect in flight
- Cancel reuses `local-tools:engine-login-cancel` with the app's engine; there is no connect-level cancel

## Services & Key Methods

- `desktopAppsService.ts:desktopAppRoots()` — `CINNA_DESKTOP_APP_ROOTS` (path-delimited) when set and non-blank, replacing both the roots and the platform check; otherwise `null` off `darwin`, else `/Applications` and `~/Applications`
- `desktopAppsService.ts:detectDesktopApps()` — for each spec in display order, the first candidate `<root>/<bundle>` that is a directory whose `Contents/Info.plist` contains one of the spec's bundle ids as bytes. `bundleMatches()` never throws
- `desktopAppsService.ts:desktopAppsService.list()` — memoizes the promise for the process's life
- `desktopAppConnectService.ts:createDesktopAppConnect(deps)` — one `ConnectEntry` at a time: same app joins `entry.done`, the other app is refused. `run()` sets the phase `installing` → `checking` → `signing-in` (only if the probe did not answer `logged_in`; a probe that throws is logged and treated as not logged in) → adopt. Every step's failure becomes `{ outcome: 'failed', reason }`; a login's non-success reason is `loginFailureLead()`, falling back to *"Sign-in didn't finish."*
- Production deps: `ensureBinary` → `claudeBinaryService` / `codexBinaryService` `.ensure()`, rethrowing a `ManagedAssetError`'s message or `CLAUDE_NOT_INSTALLED` / `CODEX_NOT_INSTALLED`; `refreshAuth` → `claudeAuthProbe` / `codexAuthProbe` `invalidate()` then `refresh()`; `login` → `engineLogins[engine].start()`
- `desktopAppConnectService.ts:adoptDesktopEngine(engine)` — `appSettingsService.set('localAgentsDefaultEngine', engine)`, then `localAgentService.rescan()` (a failure is logged; the setting stands, as with `settings:set`). Then `chatModeService.resolveEffectiveDefault()`: return when there is none, it has no engine, or it is already this engine; return when it is `managed` and `prioritizeAccountDefaults` is on. Otherwise reuse the first non-managed mode with this engine and no `providerId` — passed back **whole** to `chatModeService.upsert` with `isDefault: true`, because `update` resets any field it is not given — or create one from `ENGINE_MODE` (`Claude`/amber, `Codex`/emerald)

## Renderer Components

- `desktopApps.ts:visibleDesktopApps(detected, dismissed)` — the detected apps whose id is not dismissed; nothing else
- `desktopApps.ts:hasWorkingRuntime({ defaultEngine, hasActiveCredential, cli })` — `true` when `defaultEngine === 'opencode' && hasActiveCredential`, or when either `cli.claude` / `cli.codex` has `auth === 'logged_in'`, or `auth === 'unknown' && installed`. `cli` is `Record<EngineLoginId, { auth: 'logged_in' | 'logged_out' | 'unknown'; installed: boolean }>`
- `DesktopAppsBanner.tsx` — `apps = visibleDesktopApps(detected, dismissed)`; `hasActiveCredential` is `useProviders().data.some(isCredentialActive)`. `needsCli` (apps left, Default runtime and providers answered, and not OpenCode-with-a-credential) is passed as `enabled` to `useClaudeAuth`, `useCodexAuth`, `useClaudeBinary` and `useCodexBinary`; `useLocalTools` is always asked. Renders `null` while there are no apps, the Default runtime or providers are unanswered, or — unless a connect is running or has failed — while any `needsCli` query is unanswered or `hasWorkingRuntime` is `true`. `installed` is the binary state `ready` **or** the tool `available` in `localTools.list()` (a PATH copy at another version is not the binary the probe asks); a missing auth answer is passed as `unknown`. A `region` named *Detected apps*: info icon, sentence, icon button *Dismiss* (dismisses every shown id), then one button per app. The active app and phase come from `useDesktopAppRunning`, falling back to the mutation's own `variables` and `installing` before main has answered. The failure is a `role="alert"` on the button row, from `unwrapIpcError` or the result's `reason`, fallback *"Couldn't set it up."*
- `useDesktopApps.ts:useDesktopAppConnect()` — `mutationKey` `['desktop-app-connect']`; invalidates the running query right after queuing the call so main answers with it in flight. `onSuccess` (only on `enabled`) dismisses the shown ids and invalidates the Default runtime, `chat-modes`, agent credential bindings, `app-settings`, local agents, `agents` and `local-development-context`; `onSettled` invalidates both auth probes, the engine-login running state and the connect running state
- `useDesktopApps.ts:useDesktopAppRunning(pending)` — polls every `DESKTOP_APP_RUNNING_POLL_MS` (1 s) while the mutation is pending or main reports a connect
- `desktopApps.store.ts` — `localStorage['cinna-desktop-apps-dismissed']`, a JSON array of ids; a corrupt blob loads as `[]` and a failed write is ignored

## Configuration

- `CINNA_DESKTOP_APP_ROOTS` — test override of the scanned folders (and of the macOS check). E2E plants `<dir>/Claude.app/Contents/Info.plist` / `<dir>/ChatGPT.app/…`; an empty directory is the only honest "no apps"
- Settings read: `prioritizeAccountDefaults` (by adopt, not the banner); written: `localAgentsDefaultEngine`. Honoured indirectly through the binary services: `localAgentsClaudePath` / `localAgentsCodexPath`, and the download switch the E2E fixture turns off

## Security

- The renderer never learns bundle paths and can send only an app id, validated in main against literals
- Detection opens one file per candidate bundle and nothing under `~/Library` or the Keychain, so it raises no TCC prompt
- No credential is read or copied: the connect asks the CLI whether it is logged in, and signing in is the vendor's own login in the user's browser
