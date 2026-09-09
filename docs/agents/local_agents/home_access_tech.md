# The Agents Folder Question — Technical Details

Implementation reference for [The Agents Folder Question](home_access.md). The home itself, and everything downstream of it, is [Agents Home, Scanner & Folder Index](folder_index.md).

## File Locations

### Shared
- `src/shared/localAgents.ts` — `AgentsHomeAccess` (`'ready' | 'needs_consent' | 'denied'`) and `AgentsHomeState` (`{path, access, guarded}`)
- `src/shared/appSettings.ts` — `localAgentsHomeAcknowledged` joins `AppSettingsSchema`

### Main process
- `src/main/services/localAgents/homePath.ts` — **new**: `defaultHomePath()`, `configuredHomePath()`, `isGuardedLocation(path, platform?)`. Pure path resolution, split out of `agentsHomeService` because "which folder is the home?" and "make the home exist" have different costs
- `src/main/services/localAgents/homeAccessService.ts` — **new**: the consent gate — `state()`, `mustAsk()`, `grant()`, `acknowledge()`, `refused()` / `noteRefusal()` / `clearRefusal()`
- `src/main/services/localAgents/homeAccessService.test.ts` — **new**: the gate's own suite
- `src/main/services/localAgents/agentsHomeService.ts` — `ensureHome()` refuses; `prepare()` and `tryEnsureHome()` are new; `rootRows()` / `rootDtos()` split off `listRootRows()` / `listRoots()`; `homePath` re-exports `configuredHomePath`
- `src/main/services/localAgents/localAgentService.ts` — `LocalAgentListResult.homeAccess`
- `src/main/services/appSettingsService.ts` — the `localAgentsHomeAcknowledged` value check
- `src/main/db/appSettings.ts` — `localAgentsHomeAcknowledged: ''` in `DEFAULTS`
- `src/main/errors.ts` — `home_consent_required` and `home_access_denied` on `LocalAgentErrorCode`
- `src/main/ipc/local_agent.ipc.ts` — `local-agent:home-state`, `:home-grant`, `:home-choose`
- `src/main/localdev/localDevService.ts` — `reconcileOnce` prepares the home before building the account workspace

### Preload
- `src/preload/index.ts` — `window.api.localAgents.homeState` / `.homeGrant` / `.homeChoose`; `.list` now resolves `homeAccess` as well

### Renderer
- `src/renderer/src/components/agents/local/AgentsHomeModal.tsx` — **new**: the explainer, and the refusal's follow-up question
- `src/renderer/src/components/agents/local/AgentsHomeModal.test.tsx` — **new**
- `src/renderer/src/stores/agentsHome.store.ts` — **new**: `useAgentsHomeStore`
- `src/renderer/src/hooks/useLocalAgents.ts` — `useAgentsHome`, `useGrantAgentsHome`, `useChooseAgentsHome`, `useAgentsHomeQuestion`, `useRaiseAgentsHomeQuestion`, `AGENTS_HOME_KEY`
- `src/renderer/src/hooks/useAgentsHomeHint.ts` — reads `homeState()` instead of `rootsList()`
- `src/renderer/src/App.tsx` — `<AgentsHomeModal />` inside `OnboardingGate`
- `src/renderer/src/components/agents/local/LocalAgentsList.tsx` — raises the question; branches the `+` and the empty state
- `src/renderer/src/components/agents/local/LocalAgentPage.tsx` — the no-selection placeholder branches
- `src/renderer/src/components/settings/LocalAgentsSettingsSection.tsx` — the home's recovery row at the head of Agent Folders

### Packaging and tests
- `electron-builder.yml` — `NSDocumentsFolderUsageDescription` (and `NSDownloadsFolderUsageDescription`) rewritten from the electron-vite defaults
- `e2e/fixtures/app.ts` — `answerAgentsFolder(cinna)`

## IPC Channels

| Channel | Type | Signature |
|---|---|---|
| `local-agent:home-state` | invoke | `() → AgentsHomeState`. **The one local-agent channel that is not activation-gated** — the onboarding copy names this folder before there is an activated user to gate on. Creates nothing and reads nothing |
| `local-agent:home-grant` | invoke | `() → AgentsHomeState`. `agentsHomeService.prepare()`. The macOS Documents prompt lands inside this call, which is why it is a call of its own made from a button rather than a side effect of a screen that wanted the path |
| `local-agent:home-choose` | invoke | `() → { cancelled: true } \| { cancelled: false; state: AgentsHomeState }`. The recovery from a refused folder, and the **only** way the home moves — nothing in the renderer writes `localAgentsHome` directly. **Takes no path** — the OS picker in main is the only source, as with `:root-add`, and picking there is also what grants access to the folder. Throws `home_access_denied` (after restoring the previous setting) rather than answering with a `denied` state |
| `local-agent:list` | invoke | gained `homeAccess: AgentsHomeAccess` beside `roots` and `agents` |

`:home-grant` and `:home-choose` call `userActivation.requireActivated()` like every other handler in the family; `:home-state` deliberately does not.

## Services & Key Methods

### `src/main/services/localAgents/homePath.ts`
- `defaultHomePath()` — `~/Documents/CinnaAgents`, resolved with **no filesystem work at all**. That is the invariant the gate rests on
- `configuredHomePath()` — the `localAgentsHome` setting through `assertUsableRoot`, falling back to the default when it no longer passes. A *configured* path is `realpath`ed and that is accepted: it exists only because the user picked it in the OS directory panel, and a folder chosen that way is already granted
- `isGuardedLocation(path, platform = process.platform)` — a prefix test with `isWithin`, on the **unresolved** path, against `Documents`, `Desktop`, `Downloads` and `Library/Mobile Documents` under `homedir()`. `realpath` would follow a synced `~/Documents` to its iCloud location — which is guarded too — but it also reads the filesystem, so both spellings are listed instead. Always `false` off `darwin`

### `src/main/services/localAgents/homeAccessService.ts`
- `state(userId)` → `AgentsHomeState` — path, `guarded`, and `access`. Never reports `denied` except from the in-memory refusal, because a refusal is not stored and only an attempt can produce one
- `mustAsk(userId)` — the gate `ensureHome` consults. `false` when the path is not guarded, when the acknowledgement names it, or when a root row exists for it **and** the folder is still on disk
- `grant()` — `await mkdir(path, {recursive: true})`, then `acknowledge(path)` and clear the refusal. `EPERM` / `EACCES` → `{access: 'denied'}` and the refusal is recorded; any other error is thrown. Async on purpose: the prompt blocks the calling thread, and a synchronous `mkdir` here would stop the window redrawing and queue every other IPC call behind a dialog the user is still reading. Acknowledging happens **after** the write — acknowledging a folder that then failed to be created would suppress the explanation on the next attempt
- `acknowledge(path)` — idempotent merge into `localAgentsHomeAcknowledged`
- `refused(path)` / `noteRefusal(path)` / `clearRefusal()` — the module-level `refusedPath`, in memory for the life of the process
- `readAcknowledged()` (module-private) — a corrupt value reads as "nobody has been told": the worst case is explaining the folder once more

`userId` is whichever scope the caller works in, and the two callers differ — every local-agent channel is in the settings scope (`__default__`), local development passes the profile id. The acknowledgement is installation-global so they agree once the question is answered; only the root-row shortcut is scope-sensitive, and answering "ask" for a scope with no row is the safe direction.

### `src/main/services/localAgents/agentsHomeService.ts`
- `ensureHome(userId)` — unchanged except that it now **throws `home_consent_required`** when `homeAccessService.mustAsk` says so, before resolving anything
- `prepare(userId)` → `Promise<AgentsHomeState>` — `grant()` (async `mkdir`, the prompt) then `ensureHome()` (synchronous scaffolding, with the grant already in hand). Returns `denied` rather than throwing it
- `tryEnsureHome(userId)` → `AgentsHomeAccess` — the attempt, reported instead of thrown. Short-circuits on a refusal this process already has, since re-attempting costs a second `EPERM` per call for an answer already held; `grant()` is the retry, and it is reached from a button
- `rootRows(userId)` / `rootDtos(userId)` — the rows and DTOs **as they stand**, with no attempt at the home. `listRootRows` / `listRoots` keep the attempt (through `tryEnsureHome`, not `ensureHome`)
- `homePath` — `configuredHomePath`, for callers that want the path and nothing else
- `installRoot(rootPath)` — an `EPERM` / `EACCES` from `installRootTemplates` is now `home_access_denied` rather than `write_failed`: the only fixes are a different folder or a flipped switch, and the app can offer both once it knows which failure it had

### `src/main/services/localAgents/localAgentService.ts`
- `list(userId)` — **one** `tryEnsureHome`, whose answer becomes `homeAccess`, then `rootRows` / `rootDtos`. Going through `listRootRows` and `listRoots` would attempt the home twice more and only the first attempt's answer would reach the renderer

### `src/main/ipc/local_agent.ipc.ts` — `:home-choose`
Move-try-restore: read `localAgentsHome`, `appSettingsService.set` the picked path (so it faces the same `assertUsableRoot` check as a value written through `settings:set` — the picker can reach `/` and the user's home itself), `prepare`, and restore the previous value on a throw **or** on a non-`ready` state. `prepare` reads the setting to know which folder to make, so the value has to move first; a folder that could not be created must not stay the configured home, or the next `ensureHome` takes its "the home moved" branch and repoints the home root at a folder that does not exist.

### `src/main/localdev/localDevService.ts`
`reconcileOnce` calls `agentsHomeService.prepare(userId)` before `workspacePathFor` — which reaches `ensureHome` and would otherwise be refused for want of an explanation the consent screen already gave. A non-`ready` answer is `markFailed(detail, 'workspace')` plus `{phase: 'attention', reason: 'workspace'}`, with the detail branching on `guarded` rather than on the platform: a read-only or root-owned folder fails the same way on Linux, where System Settings → Privacy & Security is not a place.

## Renderer

### `src/renderer/src/stores/agentsHome.store.ts`
`{ask: 'needs_consent' | 'denied' | null, dismissed: [...], request(access), reopen(access), dismiss()}`.

A store rather than local state in the modal because the two halves are in different places: what *raises* the question is a surface that wanted the folder, and what *asks* it is a modal mounted once at the top of the app so it survives the user navigating away. `request('ready')` clears `ask` **and** `dismissed` — the folder now existing is the only thing that makes an earlier answer stale. `request` is ignored for a question already in `dismissed`; `reopen` bypasses that, and is what every recovery button calls.

`dismissed` is why "Not now" holds: the raising effect runs on every render where the list has data, and that list refetches on watcher pushes and re-fires when a second consumer mounts, so without it the modal would reappear on its own over whatever the user had moved on to.

### `src/renderer/src/hooks/useLocalAgents.ts`
- `useRaiseAgentsHomeQuestion()` — the effect that calls `request(access)`. Called by `LocalAgentsList` and by nothing else
- `useAgentsHomeQuestion()` → `AgentsHomeAccess | undefined` — the *actionable* question: `'ready'` whenever `roots.length > 0`, otherwise the list's `homeAccess`. `undefined` until the list lands, because not knowing is not the same as ready and a surface that guessed would flash the wrong empty state. Straight from main — the renderer briefly kept its own refusal latch, and two answers to "is the folder usable?" is one too many
- `useAgentsHome()` — `AGENTS_HOME_KEY` = `['agents-home']`, `queryFn: homeState()`. Creates nothing on either side of the bridge
- `useGrantAgentsHome()` / `useChooseAgentsHome()` — the two mutations. A refusal resolves as `denied`; it is not an error
- `afterHomeChange(queryClient, state)` (module-private) — `setQueryData(AGENTS_HOME_KEY, state)` so the modal's branch changes in the same commit as the answer (an invalidate would leave it rendering the old question for the length of a refetch), `request(state.access)`, then invalidates `LOCAL_AGENTS_KEY` and `LOCAL_AGENT_ROOTS_KEY`. Both outcomes, not just the good one: a refusal changes what main reports for the rest of the process, and a list left holding `needs_consent` would be the surfaces disagreeing with the dialog on screen

Settings reads `data.homeAccess` **raw**, not `useAgentsHomeQuestion()` — reporting where the home is is that screen's job whether or not another root makes the app usable without it.

## Renderer Components

| Component | Notes |
|---|---|
| `AgentsHomeModal` | Renders `null` until the store asks, then mounts `AgentsHomeDialog` — a separate component **so it mounts with the question**. `useDialogChrome` (`src/renderer/src/components/settings/SettingsLayout.tsx`) takes its initial focus and focus-return on mount/unmount, which from an always-mounted component would both happen once at app start; unmounting is also what forgets the last attempt's error, so a message from a folder pick cannot follow the dialog into the next open (rule 6). Initial focus is on **Not now**, the recoverable choice; Escape and outside-click are ignored while a call is in flight |
| `AgentsHomeDialog` | Two questions in one shell. `BODY_MIN_HEIGHT` (`min-h-[368px]`, sized for the taller branch and **measured in the built app** — the guess was 24 px short) and the primary button's `min-w-[152px]` are both rule 1: the shell is centred, so without the reserved height the footer rose 8 px when the explainer became the "where instead?" question, and at their natural widths `Choose folder…` sat 18 px left of `Create folder`, under the pointer that had just pressed it. The error slot is always present at `min-h-[2lh]` — a multiple of its own leading rather than a measured pixel count. A branch change resets both mutations, since the last attempt's message belongs to the question it replaced. Copy branches on `guarded`, never on the platform or on `denied`. **try again** is an accent text button inside the sentence that says when to press it, not a third verb in the footer (rule 11) |
| `LocalAgentsList` | Calls `useRaiseAgentsHomeQuestion()`. While the question stands the `+` calls `reopen(access)` instead of opening the Add-an-agent dialog, and the empty state reads "Your agents need a folder" with **Set one up** / **Pick another folder** — named for the question they open, not for the modal's own `Choose folder…`, which is one click further in (rule 10) |
| `LocalAgentPage` | The no-selection placeholder says the folder is missing rather than pointing at a `+` that cannot finish |
| `LocalAgentsSettingsSection` | A row at the head of **Agent Folders**, present only while `homeAccess !== 'ready'`: the state as the label (`No agents folder yet` / `macOS did not allow that folder` / `That folder could not be written to`), the path as a **wrapping** hint (`truncate` cut the folder name itself at the 800 px minimum window), and the button that resolves it in the same row (rule 12). The `aria-label` carries the full visible name |

## Configuration

| Setting | Where | Notes |
|---|---|---|
| `localAgentsHomeAcknowledged` | `src/shared/appSettings.ts`; default `''` in `src/main/db/appSettings.ts`; default (machine) scope | JSON `{"<path>": true}` — the home paths the user has had explained. Empty means nobody has been told. Keyed by path because the explanation is about a *place*. Only `true` is ever written; the value check **refuses** `false` rather than accepting and ignoring it, since a refusal is deliberately not recorded and a `false` here could only come from something writing a shape this feature does not have |

`appSettingsService.VALUE_CHECKS.localAgentsHomeAcknowledged` parses the JSON, requires a non-array object, and requires every value to be `true` — the same reasoning as `localDevConsent`: the shape is checked once at the boundary rather than defended at every read.

`electron-builder.yml`'s `NSDocumentsFolderUsageDescription` is the string macOS shows inside its own prompt, under the app name. It is a fallback for a prompt that arrives ahead of the in-app explainer, not the mechanism.

## Error Codes

| Code | Meaning |
|---|---|
| `home_consent_required` | The home is in a guarded folder and the user has not been told. Not a failure of anything the user did — the caller's job is to explain the folder and call `grant`, not to report an error. Raised only by `ensureHome`; `tryEnsureHome` and `prepare` convert it |
| `home_access_denied` | macOS refused the write, or the grant was revoked. Distinct from `write_failed` because the only fixes are a different folder or a flipped switch, and the app can offer both. Thrown by `installRoot` and by `:home-choose`; converted to a `denied` state everywhere else |

## Security

- **`:home-choose` takes no path.** The native dialog in main is the only source, and the picked path still goes through `assertUsableRoot` on its way into the setting — the picker can reach `/` and the user's home itself, and neither may become a folder the app scaffolds into
- **`:home-state` is unauthenticated by design and returns no secret.** A path and two booleans, on a channel the onboarding screen needs before there is an activated user. Its only filesystem call is the `existsSync` above, on a path the caller is being told anyway and only where a root row already names it — there is no caller-supplied path and so nothing it can be asked to probe
- **Refusals log `guarded` and an errno, never the path**, matching the rest of the feature's rule that logs must not be a filesystem-layout oracle

## Testing Notes

- `src/main/services/localAgents/homeAccessService.test.ts` mocks `homedir()` to a tmpdir, so a real `Documents/` under it exercises the guarded branch without touching the developer's own. The assertions are mostly about what does **not** happen: `ensureHome` creating nothing while the question stands, `state()` answering with the folder absent and no `stat` of it, a non-guarded home asking nothing, an install with a row *and* the folder asking nothing, and the same install asking again when the row outlived the folder. It also pins the rule that costs the most to get wrong — an adopted workshop stays in `listRoots` while the home question is open
- `AgentsHomeModal.test.tsx` pins the two questions in one dialog, that nothing shows until something asks, that "Not now" holds but a *different* question still gets through, that the previous attempt's message does not survive the branch change, and that the copy blames the folder rather than macOS where macOS is not the reason
- E2E: `answerAgentsFolder(cinna)` in `e2e/fixtures/app.ts` — see [End-to-End Tests](../../development/e2e/e2e_llm.md)
