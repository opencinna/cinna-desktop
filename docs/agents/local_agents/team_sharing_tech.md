# Team Sharing of Folder Agents — Technical Details

Behaviour and rules are in [Team Sharing](team_sharing.md); this is where they live.

## File Locations

### Shared

- `src/shared/agentSharing.ts` — `AgentRemote` / `AgentRemoteKind`, `LibraryAccess`, `ShareRefusal` (every code, documented at the type), `AgentShareState`, `AgentShareStatus`, `AgentShareResult`, `LibraryAgentDto`, `LibraryListingDto`, `ShareWithTeamDraft`, `SharingOutcome<T>`, `SHARING_CHANGED_CHANNEL`
- `src/shared/inbox.ts` — `TeamChangedInboxItem`, `InboxSnapshot.teamChanges`
- `src/shared/sync.ts` — `JobDependencyStatus.manifestId`, what the blocked-job row matches against the library

### Main process

- **Never-travelling folders** (in `gitService.ts`) — `neverTravelPaths()` (the layout's `never_travels`, parsed by `parseLayout` from `shared_remote.never_travels.paths`; `NEVER_TRAVELS_FALLBACK` for a workshop `.cinna-kit/` older than 1.8.0), added to the exclude block; `untrackNeverTravels()` inside `guardSecrets`; `foldUnsentIfCarrying()` before the push in `shareChanges` and `initWithRemote` (`reset --soft <team ref>`, or `update-ref -d HEAD` before a first send, then one version); `restoreLocalOnlyFolders()` after Get
- **`shared_remote` link** — `DesktopState.shared_remote` (`desktopStateService.ts`, coerced by `coerceSharedRemote`), written by `writeLocalLink` in `sharingService.ts` after Get and Share with the team, cleared on the Use-the-team's-version copy and when Share with the team starts over (`removedFromLibrary`: a cinna remote of the active instance absent from a fresh listing → `removeOrigin`)
- `src/main/services/libraryTrust.ts` — the main-only trust file: git origins per instance, pending library entries, `acceptableGitOrigin()`
- `src/main/services/libraryService.ts` — the per-profile listing cache, `toLibraryEntry()` (snake_case row → `LibraryEntry`, rows lacking `repo_id`, `clone_url` or `slug` dropped), the five-minute poll, `hostOf()`, `knownHosts()`
- `src/main/services/localAgents/sharingService.ts` — the verbs and statuses; `parseRemote()`, `commitIdentity()`, `teamChanges()`
- `src/main/services/localAgents/gitService.ts` — the share half below the root-update half: `readShareRemote`, `readShareStatus`, `shareStateOf`, `commitAll`, `pullRebaseClean`, `push`, `shareChanges`, `diffForSummary`, `initWithRemote`, `clone`, `ignoredPaths`, `removeOrigin`, `isBehindLibrary`, `excludeFromEnclosingRepo`, plus private `authEnv`, `guardSecrets`, `ensureAgentExcludes`, `scrubCredentials`
- `src/main/services/localAgents/localAgentService.ts` — `refuseUnsharedChanges()` inside `delete`, raising `LocalAgentError('unshared_changes')` (code in `src/main/errors.ts`)
- `src/main/services/inboxService.ts` — `teamChangedItems()`, merged into `list()`
- `src/main/services/jobService.ts` — `getDependencyStatus` adds `manifestId` to a folder dependency (never a `legacy:` one)
- `src/main/services/aiFunctionPrompts.ts` — `SHARE_SUMMARY_SYSTEM_PROMPT`
- `src/main/ipc/sharing.ipc.ts` — the channels; registered in `src/main/ipc/index.ts`
- Poll lifecycle: `src/main/auth/activation.ts` (start on activate, stop on switch / deactivate / clear), `src/main/index.ts` (stop on suspend, start on resume), `src/main/hub/core.ts` (stop on shutdown)

### Preload

- `src/preload/index.ts` — `window.api.sharing`: `statuses`, `status`, `draftMessage`, `shareChanges`, `update`, `useTeamVersion`, `shareWithTeamDraft`, `shareWithTeam`, `library`, `get`, `onChanged`

### Renderer

- `src/renderer/src/hooks/useSharing.ts` — queries, mutations and `useSharingWatch`
- `src/renderer/src/utils/shareText.ts` — every sentence: `SHARE_REFUSAL_TEXT`, `shareRefusalSentence`, `SHARE_STATE_TEXT`, `shareStatusSentence`, `SHARE_UI_TEXT`, `FORBIDDEN_SHARE_WORDS`
- `src/renderer/src/components/agents/local/sharing/AgentShareLine.tsx` — the status line, `canUpdate`, `canShareChanges`; owns the line's mutations and opens the dialogs
- `src/renderer/src/components/agents/local/sharing/ShareDialogs.tsx` — `ShareChangesDialog`, `ShareConflictDialog`, `ShareWithTeamDialog`
- `src/renderer/src/components/agents/TeamLibraryPanel.tsx` — the Team library source; `TeamLibraryActions`
- `src/renderer/src/components/agents/CatalogBrowserModal.tsx` — the source switch
- `src/renderer/src/components/agents/local/LocalAgentsList.tsx` — `SharedGlyph`; owns Get and Update for the library panel
- `src/renderer/src/components/agents/local/AgentActionsMenu.tsx` — **Share with the team…**, and the delete dialog's **Remove from this computer** variant
- `src/renderer/src/components/agents/local/LocalAgentPage.tsx` — mounts `AgentShareLine` under the header
- `src/renderer/src/components/inbox/InboxTeamChangedCard.tsx` — `TeamChangedCard`; `InboxView.tsx` merges it into the rows
- `src/renderer/src/components/jobs/TeamLibraryGet.tsx` — the blocked-job row's Get; mounted from `JobDetail.tsx`
- `src/renderer/src/App.tsx` — mounts `useSharingWatch` once, beside `useLocalAgentWatch`

## Database Schema

None. Sharing is derived from each folder's `origin` and from `libraryService`'s in-memory cache; a restart lists again.

## IPC Channels

Every handler calls `userActivation.requireActivated()`, runs in the settings scope (folder agents are machine-local) and reads the active **profile** itself for the token and the library. Only ids cross; no path ever arrives from the renderer. Each resolves a `SharingOutcome<T>`: refusals travel inside `value` as `ShareRefusal` codes, and `success: false` carries only what no surface can show as a state — `reauth_required` (which `_wrap` turns into the app-wide prompt) and a coded `DomainError` such as `not_found`. Anything else throws. The `catalog.ipc.ts` convention.

| Channel | Signature |
|---|---|
| `sharing:statuses` | `() → AgentShareStatus[]` — every shared agent, no network |
| `sharing:status` | `({agentId, fetch?}) → AgentShareStatus \| null` — null when not shared |
| `sharing:draft-message` | `({agentId}) → string` — AI summary, `''` on any failure |
| `sharing:share-changes` | `({agentId, message}) → AgentShareResult` |
| `sharing:update` | `({agentId}) → AgentShareResult` |
| `sharing:use-team-version` | `({agentId}) → AgentShareResult` — `agentId` in the result is the kept copy; on success the handler calls `acpProcessPool.retire(agentId)` |
| `sharing:share-with-team-draft` | `({agentId}) → ShareWithTeamDraft` |
| `sharing:share-with-team` | `({agentId, name, description}) → AgentShareResult` |
| `sharing:library` | `({refresh?}) → LibraryListingDto \| null` — null for a non-Cinna profile |
| `sharing:get` | `({repoId}) → AgentShareResult` — `agentId` is the new row |
| `sharing:changed` | main → renderer event, no payload |

`AgentShareResult` carries the status after the attempt, so the surface needs no refetch. On a successful Use the team's version its `detail` names the per-machine files that could not be copied.

## Services & Key Methods

### `libraryService`

- `refresh(userId)` — `cinnaFetch('/api/v1/library')`; `404`/`403` → empty listing, logged once per host in `missingRoutesLogged`; other errors thrown. Publishes `sharing:changed` only when `signature()` (host + sorted `repoId:headSha:access`) moved
- `refreshQuietly(userId)` — for timers; on `reauth_required` it stops the poll (activation after the re-auth restarts it). A `generation` counter drops the result of a refresh that outlived a `stop()`
- `cached(userId)` — the listing only while its host is still the profile's server; a profile re-pointed elsewhere does not keep the old host's agents
- `knownHosts()` — origins of **every** Cinna profile on the machine; with `libraryTrust` (git origins an instance named) and the folder's `cinna.server`, what makes a remote `cinna` rather than `external`. Whether its token may be used is `authFor`'s separate question

### `sharingService`

- `locateKit` / `locateShared` — through `localAgentService.locate`; a kit agent whose real parent is the root's `Local/`, then `gitService.readShareRemote` for own-repo + `origin`
- `authFor(remote)` — `external` → user's own git; `cinna` on the active profile's host → `{kind:'cinna', origin, token: () => getCinnaAccessToken(profile)}`; `cinna` elsewhere → `'other_account'`, and the caller reads counts with no network
- `statusOf` — `removed` when the remote is `cinna`, its host's listing is loaded and lacks the repo (no fetch then); otherwise `readShareStatus` with the listing's `headSha`
- `shareChanges`, `update` — turn lock (`turnLock.acquire(agentId, 'sharing')`, `turn_in_progress` on contention), then `gitService.shareChanges` / `pullRebaseClean`; on success re-list the library and publish (`update` also rescans the root)
- `useTeamVersion` — mints the token before anything moves; `freeMineDir`; rename; `gitService.clone`; `carryMachineFiles` (ignored paths minus `NOT_CARRIED`, `cpSync` with `force:false`; answers the paths it could not copy, which `missedDetail` puts — up to three, then "and N more" — in the result's `detail`); fresh id + "(my copy)" via `writeManifest` while the copy still has `origin`; then `removeOrigin` and `excludeFromEnclosingRepo` on the copy. Any throw between rename and new id → `putBack` (a landed clone is renamed to `.<slug>.discard-<id>` before deletion — the scanner skips dot-folders — so a partial delete never leaves the original id at the path and never blocks the rename-back) and rethrow `CinnaReauthRequired`, else `failed`
- `shareWithTeam` — refuses without a Cinna profile, outside `Local/`, `git_missing`, `remote_exists`; takes the turn lock (`turn_in_progress`); `gitService.preflightShare` **before** the `POST`, so a refused folder leaves no library entry; `POST /api/v1/library/agents {slug, name, description}` — `libraryTrust.learn` the answer's `clone_url` (refused when not acceptable: non-http(s), or plain http to a non-loopback host from an https instance) and `setPending(host, slug, repoId)`; on `409`, `unfinishedEntry` adopts only that pending repo id, still empty and maintained; `gitService.initWithRemote` with the header scoped to the git origin; `cinna.server` recorded in `.git/config`; `clearPending` once sent
- `library(userId, refresh)` — the cached or refreshed listing joined to this machine: `localCopies` maps by repo id (from `origin`) and by manifest id; `updateAvailable` from `isBehindLibrary`
- `get(userId, repoId)` — listing (refreshed once on a miss) → `not_in_library`; `SLUG_PATTERN`; same-origin `clone_url`; `exists` on slug or manifest id; clone into the **agents home** (`agentsHomeService.requireRoot`); re-check the manifest id that arrived and remove the clone on a clash; rescan
- `teamChanges(userId)` — per shared Cinna agent, `teamChangeOf` (`readShareRemote` + `isBehindLibrary`). Each answer is memoised against the listing's host, fetch time and content plus `gitStateKey(dir)` — `HEAD`, the ref it names, `packed-refs` and `config` stamps read straight from `.git` — so a steady Inbox spawns no git. A worktree's `.git` file is not memoised

### `gitService` share verbs

- `run(..., extraEnv)` — the one runner both halves use; `extraEnv` is merged last and carries only `authEnv`
- `authEnv(auth)` — `GIT_CONFIG_COUNT=2`, `http.<origin>/.extraHeader = Authorization: Bearer <token>`, `http.followRedirects = false`. Called per network child (`runNet`), so each gets a freshly minted token
- `readShareStatus(dir, auth, fetch, libraryHeadSha?)` — `teamRef` is `origin/main`, else the upstream; ahead/behind by `rev-list --left-right --count`; with a library head not in history, `behind` is the count when the commit is present, else `-1`. `changedPaths` = untracked-not-ignored + `diff --name-only <merge-base>`
- `shareStateOf(counts)` — `diverged` / `behind` / `unshared` / `up_to_date`; `other_account` and `removed` are main's
- `pullRebaseClean` — fetch; nothing behind → not done, no refusal; tracked edits or an untracked file on an incoming path → `dirty`; no local versions → `merge --ff-only`; else `rebase --no-autostash`, aborted on failure → `diverged_conflict`
- `push` — `push -u origin HEAD:main`; `classifyPush` → `non_ff` (one `pullRebaseClean` + one retry), `no_access`, `push_rejected` (server's `remote:` lines as `detail`), `fetch_failed`
- `commitAll` — `guardSecrets`, `add -A -- .`, `nothing_to_share` when nothing is staged, commit with `commitFlags` (`commit.gpgsign=false`; `user.name`/`user.email` only where git has none)
- `guardSecrets` — `ensureAgentExcludes` then `trackedSecrets` (`ls-files -z` against `isSecretFile` and `layout.desktopOwned()`); `secrets_tracked` with up to three paths
- `ensureAgentExcludes` — the marked block (`# >>> Cinna Desktop: the agent kit's ignore rules …` / `# <<< Cinna Desktop`) in `--git-path info/exclude`, rules read from the kit's agent `gitignore` template through `layout.json`'s `scaffold_ignore_files`, never hard-coded
- `preflightShare(dir, workshopRoot)` — `git_missing`, else for a folder that is already its own repository `guardSecrets` (`secrets_tracked`); a folder that is not a repository yet tracks nothing and is guarded again when recorded
- `diffForSummary(dir)` — `diff <merge-base>` with every tracked secret (`trackedSecrets`) excluded by `:(exclude,literal)` pathspec, plus untracked file *names*; capped
- `initWithRemote` — `init -b main` unless already its own repo, `writeMissingIgnoreFiles`, `guardSecrets` **before** `remote add` (a refused folder is not left looking shared), commit "Shared with the team", `push`
- `clone` — into `.<slug>.clone-<hex>` beside the target, `--single-branch`; `not_an_agent` without a manifest; `ensureAgentExcludes`; rename into place; `excludeFromEnclosingRepo`
- `excludeFromEnclosingRepo(dir)` — appends `/<rel>/` to the enclosing repository's common-dir `info/exclude`, once

## Renderer Components

- **`AgentShareLine`** — renders only when `useListedShareStatus(agentId)` (the sidebar's already-loaded statuses list) has the agent, so the line's slot is decided at first paint and the per-agent `useShareStatus` only changes its words. Fixed `h-6` line; buttons in a fixed `11rem` right-aligned slot so the sentence truncates at the same point whatever the state offers. A failed read's refusal, or the last action's, replaces the sentence in the same slot in the warning colour. A `diverged_conflict` from Update or Share changes opens the conflict dialog here; the kept copy is announced through the page's `onNote` slot
- **`ShareChangesDialog`** — field present and editable from the first frame; the draft fills it only if untouched. **`ShareConflictDialog`** — two buttons, **Keep working on mine** focused. **`ShareWithTeamDialog`** — name and description fields filled per field the user has not typed into. None owns its mutation: each is owned by the component that opens it, with hook-level callbacks (`useSharing.ts`) so a close-on-success survives the dialog's unmount; none can be dismissed while its action runs
- **`TeamLibraryPanel`** — tiles built like the bundle tiles; Get / Update available / Installed + Open; per-tile busy state and refusal from `TeamLibraryActions`, owned by `LocalAgentsList` so closing the dialog mid-Get loses nothing and the landing on the new page still happens
- **`CatalogBrowserModal`** — `useTeamLibrary({refresh:true})`; the source tablist renders only when the parent passed `library` **and** the listing is non-null. Refresh acts on whichever source is shown
- **`SharedGlyph`** (sidebar) — `Users` icon beside the row button (not inside it, so the row's accessible name stays the agent's name); the dot inside the glyph's own box, so a state change moves nothing. Dot when `unshared` or `behind !== 0`, not for `removed` / `other_account`
- **`AgentActionsMenu`** — **Share with the team…** only for a kit agent the statuses list says is not shared, on a `cinna_user` profile whose library query returned data. A shared kit agent's delete is titled **Remove from this computer** everywhere it names itself and always trashes the folder
- **`TeamChangedCard`** — `onActed` retains the card before the call, as an answered ask is; `diverged_conflict` navigates to the agent page. Row key `team:<agentId>:<changedAt>` so a newer change is a new card. **Not counted** in the Inbox badge (`inboxWaitingCount` counts asks and dispatcher cards only)
- **`TeamLibraryGet`** — mounted only for an `unavailable` dependency with a `manifestId`, so a job with nothing to get never reads the library; renders nothing until the library lists a match with no local copy. Success invalidates `['jobs', jobId]`

## State Management

- Query keys (`useSharing.ts`) are prefixed `['sharing', …]` and keyed by the active profile, because `other_account` and access read differently under another account
- `useSharingWatch` invalidates every sharing query and the Inbox on `sharing:changed`
- `useShareStatus` for an `external` remote passes `fetch: true` at most once a minute per agent, decided from a module-level clock (`lastExternalFetch`) rather than from "this is a refetch" — a fetch publishes `sharing:changed`, which invalidates the status, which would otherwise fetch again
- Mutation settle writes the returned status into the caches and invalidates the list, the library, and — after an action that rewrote a folder — the agents list

## Configuration

- `REFRESH_INTERVAL_MS` (libraryService) — five minutes
- Git timeouts are the root-update half's: local reads and the long network timeout per network child
- `MAX_SUMMARY_DIFF_CHARS` 16 000 (what the summary reads), `MAX_SUMMARY_CHARS` 600 (what the field keeps), `MAX_DETAIL_CHARS` 300 (server words carried back)

## Security

- **The token** — minted per git child, environment only, header scoped to the remote's origin, redirects off, only for a remote whose instance is the active profile's (`other_account` reaches no network). `scrubCredentials` on every stderr that is logged or returned; `redactRemoteUrl` on `AgentRemote.url`
- **Origins** — `src/main/services/libraryTrust.ts` keeps, in `<userData>/team-library-trust.json` (main-only; the settings store is renderer-writable), the git origins each instance named in a listing (`libraryService.refresh` learns every `clone_url`) or a create answer, and the pending entry per instance and slug. `parseRemote` calls a remote `cinna` only when its git origin is an instance's own or trusted by it (`trusts` / `serversFor`); `.git/config` `cinna.server` (`gitService.setCinnaServer`) only picks among those, then the active profile's host. `authFor` re-checks `trusts` before minting. `acceptableGitOrigin`: https, or http only from an http instance or to loopback
- **Secrets** — kit ignore rules forced through `.git/info/exclude`; `secrets_tracked` before any record, and for Share with the team before the library entry exists; missing kit ignore files written on first share; tracked secrets left out of the text the AI summary reads
- **Identity** — never the machine's login or host name in a recorded version
- **Plaintext on the server, by design** — an agent in the Team library is an ordinary git repository on the Cinna server, readable by the server and by everyone the library grants. Unlike [data sync](../../sync/data_sync/data_sync.md), nothing here is end-to-end encrypted; the protection is what is kept out of the repository
- **Paths** — every folder is resolved in main from an agent id or a library repo id; Get's target is `Local/<slug>` under the agents home with the slug checked against `SLUG_PATTERN`

## Testing

- `src/main/services/localAgents/gitService.test.ts` — real repositories and the real binary (bare origins, two clones), plus a local HTTP server that checks the header reaches only its origin, is never written to `.git/config`, and is not carried across a redirect
- `src/main/services/localAgents/sharingService.test.ts` — real folders, real agent index, real git; `cinnaFetch` and `getCinnaAccessToken` mocked, the latter's calls proving whether a token was minted; counts `execFile` spawns to prove a memoised Inbox read runs no git
- `src/main/ipc/sharing.ipc.test.ts` — the outcome wrapping
- `src/renderer/src/utils/shareText.test.ts` — every string against `FORBIDDEN_SHARE_WORDS`
- Component tests beside `AgentShareLine`, `CatalogBrowserModal`, `AgentActionsMenu`, `LocalAgentsList`, `LocalAgentPage`, `InboxView.teamChanged`, `TeamLibraryGet`
