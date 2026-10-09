# Team Sharing of Folder Agents — Technical Details

Behaviour and rules are in [Team Sharing](team_sharing.md); this is where they live.

## File Locations

### Shared

- `src/shared/agentSharing.ts` — `AgentRemote` / `AgentRemoteKind`, `LibraryAccess`, `ShareRefusal` (every code, documented at the type), `AgentShareState`, `AgentShareStatus`, `AgentShareResult`, `LibraryAgentDto` (with `pushedBy`), `LibraryListingDto`, `ShareWithTeamDraft` (what the dialog is pre-filled from), `ShareWithTeamInput` / `ShareWithTeamPerson` (what it sends: name and people, no description), `LibraryPrincipal` (`user` / `role` / `everyone`), `LibraryPerson`, `LibraryGrantInput`, `AgentPeopleDto` (`visible`, `people`, `selfUserId`), `SetPeopleResult`, `PersonSearchResult`, `AgentVersionDto` (no sha: nothing restores), `SharingOutcome<T>`, `SHARING_CHANGED_CHANNEL`
- `src/shared/inbox.ts` — `TeamChangedInboxItem`, `InboxSnapshot.teamChanges`
- `src/shared/sync.ts` — `JobDependencyStatus.manifestId`, what the blocked-job row matches against the library

### Main process

- **Never-travelling folders** (in `gitService.ts`) — `neverTravelPaths()` (the layout's `never_travels`, parsed by `parseLayout` from `shared_remote.never_travels.paths`; `NEVER_TRAVELS_FALLBACK` for a workshop `.cinna-kit/` older than 1.8.0), applied only when the remote is a Cinna library (`isCinna(auth)`). It covers the exclude block, `untrackNeverTravels()` in `commitAll`, `dropNeverTravelsFromUnsent()` → `rewriteUnsent()` before the push in `shareChanges` and `initWithRemote`, `rewriteUnsent()` before the rebase in `pullRebaseClean` and again after a `non_ff` retry's Update in `push`, and `restoreLocalOnlyFolders()` after Get. `preflightShare` and `initWithRemote`'s guard only check
- **`shared_remote` link** — `DesktopState.shared_remote` (`desktopStateService.ts`, coerced by `coerceSharedRemote`), written by `writeLocalLink` in `sharingService.ts` after Get and Share with the team, cleared on the Use-the-team's-version copy and when Share with the team starts over. The restart condition is `removedFromLibrary`: a `cinna` remote of the active instance that a fresh listing with `available: true` does not list. `createAndSend(…, replaceOrigin)` then runs `removeOrigin` only once the new entry exists
- `src/main/services/libraryTrust.ts` — the main-only trust file: git origins per instance, pending library entries, `acceptableGitOrigin()`
- `src/main/services/libraryService.ts` — the per-profile listing cache, `toLibraryEntry()` (snake_case row → `LibraryEntry`, rows lacking `repo_id`, `clone_url` or `slug` dropped), the five-minute poll, `hostOf()`, `knownHosts()`
- `src/main/services/localAgents/sharingService.ts`: the verbs and statuses. Also `parseRemote(originUrl, cinnaHosts, recordedServer, trust, preferredServer)`, and `remoteOf()`, which calls it with `knownHosts()`, `libraryTrust` and the active profile's host. Also `commitIdentity()`, `teamChanges()`, `unfinishedEntry()`, `removedFromLibrary()`, `recordServer()` and `writeLocalLink()`; for People and Remove sharing, `toCoreGrants` / `fromCoreGrants` (exported for tests), `initialGrants`, `libraryWrite`, `libraryTarget` and `selfIn`
- `src/main/services/localAgents/gitService.ts`: the share half, below the root-update half. `readShareRemote` (also answers `cinnaServer`), `setCinnaServer`, `unsetCinnaServer`, `readHistory` (`HISTORY_LIMIT`), `neverTravelPaths`, `restoreLocalOnlyFolders`, `readShareStatus`, `shareStateOf`, `commitAll`, `pullRebaseClean`, `push`, `shareChanges`, `diffForSummary`, `initWithRemote`, `clone`, `ignoredPaths`, `removeOrigin`, `isBehindLibrary`, `excludeFromEnclosingRepo`. Private: `authEnv`, `guardSecrets`, `ensureAgentExcludes`, `isCinna`, `untrackNeverTravels`, `dropNeverTravelsFromUnsent`, `rewriteUnsent`, `scrubCredentials`
- `src/main/services/localAgents/localAgentService.ts` — `refuseUnsharedChanges()` inside `delete`, raising `LocalAgentError('unshared_changes')` (code in `src/main/errors.ts`)
- `src/main/services/inboxService.ts` — `teamChangedItems()`, merged into `list()`
- `src/main/services/jobService.ts` — `getDependencyStatus` adds `manifestId` to a folder dependency (never a `legacy:` one)
- `src/main/services/aiFunctionPrompts.ts` — `SHARE_SUMMARY_SYSTEM_PROMPT`
- `src/main/ipc/sharing.ipc.ts` — the channels; registered in `src/main/ipc/index.ts`
- Poll lifecycle: `src/main/auth/activation.ts` (start on activate, stop on switch / deactivate / clear), `src/main/index.ts` (stop on suspend, start on resume), `src/main/hub/core.ts` (stop on shutdown)

### Preload

- `src/preload/index.ts` — `window.api.sharing`: `statuses`, `status`, `draftMessage`, `shareChanges`, `update`, `useTeamVersion`, `shareWithTeamDraft`, `shareWithTeam`, `people`, `setPeople`, `searchPeople`, `history`, `unshare`, `library`, `get`, `onChanged`

### Renderer

- `src/renderer/src/hooks/useSharing.ts` — queries, mutations and `useSharingWatch`; `useSharePeople`, `useShareHistory`, `useSetSharePeople`, `useUnshare`
- `src/renderer/src/utils/shareText.ts` — every sentence: `SHARE_REFUSAL_TEXT`, `shareRefusalSentence`, `SHARE_STATE_TEXT`, `shareStatusSentence` (the full sentence: tooltip and Sharing tab), `SHARE_BADGE_TEXT`, `shareBadgeText` (the badge's short form), `shareStatusWarns`, `SHARE_ACCESS_TEXT` (Can use / Can edit / Maintainer), `libraryRefusalSentence` (People and Remove sharing: the server's own sentence on a `failed`), `SHARE_UI_TEXT`, `FORBIDDEN_SHARE_WORDS`
- `src/renderer/src/components/agents/local/sharing/AgentShareBadge.tsx` — `AgentShareBadge`, and `useAgentShareStatus` (the listed status until the agent's own lands), which the Sharing tab reads too
- `src/renderer/src/components/agents/local/sharing/useShareActions.tsx` — `useShareActions` (Update, Share changes, Use the team's version and their dialogs), `canUpdate`, `canShareChanges`
- `src/renderer/src/components/agents/local/sharing/SharingTab.tsx` — `SharingTab`: `WhereSection`, `PeopleSection`, `HistorySection`, `RemoveSection`
- `src/renderer/src/components/agents/local/sharing/ShareDialogs.tsx` — `ShareChangesDialog`, `ShareConflictDialog`, `ShareWithTeamDialog`, `ShareWithPersonDialog`, `RemoveSharingDialog`; the private `PeopleSearch` / `usePeopleSearch`, and `AccessSelect`
- `src/renderer/src/components/agents/TeamLibraryPanel.tsx` — the Team library source; `TeamLibraryActions`
- `src/renderer/src/components/agents/CatalogBrowserModal.tsx` — the source switch
- `src/renderer/src/components/agents/local/LocalAgentsList.tsx` — owns Get and Update for the library panel; reads `useShareStatuses()` though its rows show nothing of it, so the list is loaded before any agent page opens
- `src/renderer/src/components/agents/local/AgentActionsMenu.tsx` — **Share with the team…**, and the delete dialog's **Remove from this computer** variant
- `src/renderer/src/components/agents/local/LocalAgentPage.tsx` — owns the one `useShareActions` and renders its `dialogs` in both modes; passes `AgentShareBadge` to the compact `RuntimePanel` as `leading`; adds the `sharing` tab only when `useListedShareStatus` has the agent
- `src/renderer/src/components/agents/local/RuntimePanel.tsx` — the compact summary's `leading` slot, rendered before the runtime badges; `fieldClasses.ts`'s `SUMMARY_BADGE` is the class both share
- `src/renderer/src/components/inbox/InboxTeamChangedCard.tsx` — `TeamChangedCard`; `InboxView.tsx` merges it into the rows
- `src/renderer/src/components/jobs/TeamLibraryGet.tsx` — the blocked-job row's Get; mounted from `JobDetail.tsx`
- `src/renderer/src/App.tsx` — mounts `useSharingWatch` once, beside `useLocalAgentWatch`

## Database Schema

None. Whether an agent is shared comes from each folder's `origin` and from `libraryService`'s in-memory cache, and a restart lists the library again. Outside the database:

- `<userData>/team-library-trust.json` (`libraryTrust`): `{gitOrigins: {<instance origin>: [<git origin>…]}, pending: {<instance origin>: {<slug>: <repo id>}}}`. The instance's own origin is never written to it. It is written atomically (temp file, fsync, rename). A failed write is logged, and the list still holds in memory for that run. A host with no `userData` keeps it **in memory only**, never in a shared fallback such as the temp directory, where any local user could plant a trust list
- `cinna.server` in each shared folder's `.git/config`: the instance's API origin, written after Get and after Share with the team once `.git` exists
- `shared_remote` in each shared folder's `app-data/desktop.json`: `{kind, repo_id, clone_url}`, written and cleared by `writeLocalLink` and never read for a decision

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
| `sharing:share-with-team` | `({agentId, name, people}) → AgentShareResult` — `people: {userId, access}[]`; the description is the manifest's, never taken from the renderer |
| `sharing:people` | `({agentId}) → AgentPeopleDto \| null` — null when the active profile cannot speak for the entry (not shared, `external`, another account's, or a `404`) |
| `sharing:set-people` | `({agentId, people: LibraryGrantInput[]}) → SetPeopleResult` — the whole list; `people` in the answer is the server's |
| `sharing:search-people` | `({query}) → PersonSearchResult[]` |
| `sharing:history` | `({agentId}) → AgentVersionDto[]` — `[]` when not shared |
| `sharing:unshare` | `({agentId, deleteFromLibrary}) → AgentShareResult` — `deleteFromLibrary` is taken only as a literal `true` |
| `sharing:library` | `({refresh?}) → LibraryListingDto \| null` — null for a non-Cinna profile |
| `sharing:get` | `({repoId}) → AgentShareResult` — `agentId` is the new row |
| `sharing:changed` | main → renderer event, no payload |

`AgentShareResult` carries the status after the attempt, so the surface needs no refetch. On a successful Use the team's version its `detail` names the per-machine files that could not be copied.

## Services & Key Methods

### `libraryService`

- `refresh(userId)` — `cinnaFetch('/api/v1/library')`; `404`/`403` → empty listing with `available: false`, logged once per host in `missingRoutesLogged`. `statusOf`'s `removed` and `removedFromLibrary` both require `available`, so a stand-in listing never reads as an entry deleted. other errors thrown. Every row's `clone_url` goes to `libraryTrust.learn(host, …)`. Publishes `sharing:changed` only when `signature()` (host + sorted `repoId:headSha:access`) moved
- `refreshQuietly(userId)` — for timers; on `reauth_required` it stops the poll (activation after the re-auth restarts it). A `generation` counter drops the result of a refresh that outlived a `stop()`
- `cached(userId)` — the listing only while its host is still the profile's server; a profile re-pointed elsewhere does not keep the old host's agents
- `knownHosts()` — origins of **every** Cinna profile on the machine; with `libraryTrust` (git origins an instance named) and the folder's `cinna.server`, what makes a remote `cinna` rather than `external`. Whether its token may be used is `authFor`'s separate question

### `sharingService`

- `locateKit` / `locateShared` — through `localAgentService.locate`; a kit agent whose real parent is the root's `Local/`, then `gitService.readShareRemote` for own-repo + `origin`
- `authFor(shared)`: `external` means the user's own git. A `cinna` remote on the active profile's host gives `{kind:'cinna', origin: <git origin of originUrl>, token: () => getCinnaAccessToken(profile)}`, but only after `libraryTrust.trusts(host, gitOrigin)` passes a second time. Otherwise it falls back to `external`. A `cinna` remote on another host gives `'other_account'`, and the caller reads counts with no network
- `statusOf` — `removed` when the remote is `cinna`, its host's listing is loaded with `available: true` and lacks the repo (no fetch then); otherwise `readShareStatus` with the listing's `headSha`
- `shareChanges`, `update` — turn lock (`turnLock.acquire(agentId, 'sharing')`, `turn_in_progress` on contention), then `gitService.shareChanges` / `pullRebaseClean`; on success re-list the library and publish (`update` also rescans the root)
- `useTeamVersion` — mints the token before anything moves; `freeMineDir`; rename; `gitService.clone`; `carryMachineFiles` (ignored paths minus `NOT_CARRIED`, `cpSync` with `force:false`; answers the paths it could not copy, which `missedDetail` puts — up to three, then "and N more" — in the result's `detail`); fresh id + "(my copy)" via `writeManifest` while the copy still has `origin`; then `writeLocalLink(copy, null)`, `removeOrigin` and `excludeFromEnclosingRepo` on the copy. Any throw between rename and new id → `putBack` (a landed clone is renamed to `.<slug>.discard-<id>` before deletion — the scanner skips dot-folders — so a partial delete never leaves the original id at the path and never blocks the rename-back) and rethrow `CinnaReauthRequired`, else `failed`
- `shareWithTeam`: refuses without a Cinna profile, outside `Local/`, and on `git_missing`. It refuses `remote_exists` unless `removedFromLibrary` holds, meaning `origin` is a `cinna` remote of the active host that a fresh `libraryService.refresh` with `available: true` does not list. It then takes the turn lock (`turn_in_progress`); `gitService.preflightShare(dir, root, true)` (read-only) **before** the `POST`, so a refused folder leaves no library entry; `POST /api/v1/library/agents {slug, name, description, grants}` — `description` is always the manifest's (`shareWithTeamDraft`), `grants` the chosen people as `{principal: {user_id}, access}`, which core today ignores. `libraryTrust.learn` the answer's `clone_url` (refused when not acceptable: non-http(s), or plain http to a non-loopback host from an https instance) and `setPending(host, slug, repoId)`; on `409`, `unfinishedEntry` adopts only that pending repo id, still empty and maintained. Then the grants: an entry with no `maintainers` is refused `failed`; otherwise `PUT …/agents/<repo_id>/grants` with `initialGrants` (each maintainer as `maintain`, then each chosen person not already one), and any refusal from that write is `failed` with a sentence, before anything below runs. For a restart, `removeOrigin` + `writeLocalLink(dir, null)` only now, after the entry exists; `gitService.initWithRemote` with the header scoped to the git origin; `recordServer` and `writeLocalLink` whenever `.git` exists, sent or not; `clearPending` once sent
- `people(userId, agentId)` — `libraryTarget` (a `cinna` remote with a repo id whose `authFor` is the active profile's), else null; `GET …/grants` through `fromCoreGrants`, which reads a bare array or one under `grants` / `data`, a principal as `"everyone"` or an object with `user_id` / `role`, the name from `display_name`, `full_name` or `email` on the row or the principal, and drops a row it cannot place. `403` → `{visible: false, people: [], selfUserId: null}`; `404` → null; anything else throws. `selfUserId` from `selfIn`: `getStoredCinnaSubject(profile)` (the stored token's `sub`, no network), kept only when it is a user in the list
- `setPeople(userId, agentId, people)` — `parseGrantInputs` rejects the whole list on one malformed row (`failed`); `PUT …/grants` with `toCoreGrants`. The answer's `people` is `fromCoreGrants` of the `PUT`'s body, or a fresh `people()` when that is empty; then `refreshListing()` and `sharing:changed`, since the listing's maintainers and the caller's access may have moved. No turn lock: it writes nothing on disk
- `libraryWrite(profile, path, method, body?, goneIsDone)` — the one writer for grants and delete. A 2xx with no JSON (`invalid_response`) is a write that happened; `404` with `goneIsDone` is success; `403` is `no_access` rather than `cinnaFetch`'s `reauth_required` (a role, not a dead session); a real `reauth_required` still throws for the prompt; anything else is `failed` with the server's `detail`
- `searchPeople(query)` — under two trimmed characters, or a profile with no host, `[]` without a request; `GET /api/v1/users/search?q=…&limit=10`, rows from `data` (`id`, `email`, `full_name`, the name falling back to the email); `403` / `404` → `[]`
- `history(userId, agentId)` — `locateShared` then `gitService.readHistory`; `[]` when not shared
- `unshare(userId, agentId, deleteFromLibrary)` — `not_shared` without `locateShared`; turn lock (`turn_in_progress`); with `deleteFromLibrary`, `libraryTarget` (else `other_account`) and `DELETE /api/v1/library/agents/<repo_id>` through `libraryWrite(…, goneIsDone: true)`, a refusal returning before anything local; then `gitService.removeOrigin` (`failed` when git refused), `writeLocalLink(dir, null)`, `unsetCinnaServer` (a failure only logged). After the lock: `refreshListing()` and `settle` (rescan + `sharing:changed`). It never calls `refuseUnsharedChanges`
- `library(userId, refresh)` — the cached or refreshed listing joined to this machine: `localCopies` maps by repo id (from `origin`) and by manifest id; `updateAvailable` from `isBehindLibrary`
- `get(userId, repoId)` — listing (refreshed once on a miss) → `not_in_library`; `SLUG_PATTERN`; `libraryTrust.learn` the `clone_url` (refused when not acceptable); `exists` on slug or manifest id; clone into the **agents home** (`agentsHomeService.requireRoot`); `recordServer`; `restoreLocalOnlyFolders` and `writeLocalLink` (a failure there is logged, not a refusal); re-check the manifest id that arrived and remove the clone on a clash; rescan
- `teamChanges(userId)` — per shared Cinna agent, `teamChangeOf` (`readShareRemote` + `isBehindLibrary`). Each answer is memoised against the listing's host, fetch time and content plus `gitStateKey(dir)` — `HEAD`, the ref it names, `packed-refs` and `config` stamps read straight from `.git` — so a steady Inbox spawns no git. A worktree's `.git` file is not memoised

### `gitService` share verbs

- `run(..., extraEnv)` — the one runner both halves use; `extraEnv` is merged last and carries only `authEnv`
- `authEnv(auth)` — `GIT_CONFIG_COUNT=2`, `http.<origin>/.extraHeader = Authorization: Bearer <token>`, `http.followRedirects = false`. Called per network child (`runNet`), so each gets a freshly minted token
- `readShareStatus(dir, auth, fetch, libraryHeadSha?)` — `teamRef` is `origin/main`, else the upstream; ahead/behind by `rev-list --left-right --count`; with a library head not in history, `behind` is the count when the commit is present, else `-1`. `changedPaths` = untracked-not-ignored + `diff --name-only <merge-base>`
- `shareStateOf(counts)` — `diverged` / `behind` / `unshared` / `up_to_date`; `other_account` and `removed` are main's
- `pullRebaseClean(dir, auth, identity, workshopRoot)` — fetch; nothing behind → not done, no refusal; tracked edits or an untracked file on an incoming path → `dirty`; no local versions → `merge --ff-only`; else, for a Cinna remote, `rewriteUnsent` first, then `rebase --no-autostash`, aborted on failure → `diverged_conflict`
- `push` — `push -u origin HEAD:main`; `classifyPush` → `non_ff` (one `pullRebaseClean`, `rewriteUnsent` again for a Cinna remote, one retry), `no_access`, `push_rejected` (server's `remote:` lines as `detail`), `fetch_failed`
- `commitAll(dir, message, identity, workshopRoot, neverTravel)` — `guardSecrets(…, neverTravel, untrack: true)`, `add -A -- .`, `nothing_to_share` when nothing is staged, commit with `commitFlags` (`commit.gpgsign=false`; `user.name`/`user.email` only where git has none)
- `guardSecrets(gitPath, dir, workshopRoot, neverTravel, untrack)` — `ensureAgentExcludes`; with `neverTravel && untrack`, `untrackNeverTravels` (`rm -r --cached --ignore-unmatch` over `neverTravelPaths`), the only place anything is untracked; then `trackedSecrets` (`ls-files -z` against `isSecretFile` and `layout.desktopOwned()`), minus, with `neverTravel`, paths under the never-travel folders; `secrets_tracked` with up to three paths
- `ensureAgentExcludes` — the marked block (`# >>> Cinna Desktop: the agent kit's ignore rules …` / `# <<< Cinna Desktop`) in `--git-path info/exclude`, rules read from the kit's agent `gitignore` template through `layout.json`'s `scaffold_ignore_files`, never hard-coded. Then, for a Cinna remote only, the `neverTravelPaths` folders, written as `/credentials/` and `/app-data/`
- `neverTravelPaths(workshopRoot)`: `getLayout(workshopRoot).never_travels`, which `parseLayout` reads from `shared_remote.never_travels.paths`. When that is absent or empty, `NEVER_TRAVELS_FALLBACK` (`credentials/`, `app-data/`) applies. Each entry is normalised to end in `/`
- `dropNeverTravelsFromUnsent`: `fetch origin` (`fetch_failed` on failure), then `rewriteUnsent`. When the team ref is not an ancestor of `HEAD`, it then runs `pullRebaseClean`, whose `dirty` / `diverged_conflict` is the answer
- `rewriteUnsent(gitPath, dir, never)`: `rev-list --full-history <HEAD> --not <team ref> -- credentials app-data`, or all of `HEAD` when there is no team ref. If nothing touches those paths, it does nothing. A detached `HEAD` is refused `failed` with a sentence. Otherwise it walks `rev-list --reverse --topo-order --parents` over the same range. For each commit, it rebuilds the tree in a scratch `GIT_INDEX_FILE` under the git dir (`read-tree`, `rm -r --cached`, `write-tree`). Then `commit-tree` uses the original message (raw from `cat-file`), author, committer and dates, and the mapped parents. Commits whose tree and parents did not change are kept as they are. The branch moves by `update-ref <branch> <new> <old>` (compare-and-swap). The working tree and the real index are never touched
- `restoreLocalOnlyFolders(dir, workshopRoot)`: copies each never-travelling folder from the agent template (`cpSync`, `force:false`). It then gives any dotless template ignore file under them its dot, as `scaffold_ignore_files` maps it
- `setCinnaServer(dir, origin)`: `git config cinna.server <origin>`, returning false when git refused
- `preflightShare(dir, workshopRoot, neverTravel)` — `git_missing`, else for a folder that is already its own repository `guardSecrets(…, untrack: false)` (`secrets_tracked`). Read-only apart from the exclude block; a folder that is not a repository yet tracks nothing and is guarded again when recorded
- `diffForSummary(dir)` — `diff <merge-base>` with every tracked secret (`trackedSecrets`) excluded by `:(exclude,literal)` pathspec, plus untracked file *names*; capped
- `initWithRemote` — `init -b main` unless already its own repo, `writeMissingIgnoreFiles`, `guardSecrets` (check only) **before** `remote add` (a refused folder is not left looking shared), `commitAll` "Shared with the team", for a Cinna remote `dropNeverTravelsFromUnsent`, `push`
- `clone` — into `.<slug>.clone-<hex>` beside the target, `--single-branch`; `not_an_agent` without a manifest; `ensureAgentExcludes` (never-travel folders only for a Cinna remote); rename into place; `excludeFromEnclosingRepo`
- `readHistory(dir, limit = HISTORY_LIMIT)` — `[]` unless own repo with a `HEAD`; `log -n 30 --format=%H%x1f%s%x1f%an%x1f%aI%x1e HEAD`, split on the record separator; `unsent` for each sha in `rev-list refs/remotes/origin/main..HEAD`, none when there is no `origin/main`. Reads only the local refs: no fetch
- `unsetCinnaServer(dir)` — `config --unset-all cinna.server`; a key that was not set (exit 5) counts as unset, checked by `config --get`
- `excludeFromEnclosingRepo(dir)` — appends `/<rel>/` to the enclosing repository's common-dir `info/exclude`, once

## Renderer Components

- **`AgentShareBadge`** — `useAgentShareStatus`: `useListedShareStatus(agentId)` (the sidebar's already-loaded statuses list) decides whether it renders at all, and the per-agent `useShareStatus` only replaces the status once it lands. One `flex-nowrap` unit (`data-share-unit`): a `<button data-share-badge>` (Users icon, `shareBadgeText`, the full `shareStatusSentence` in `title`, warning colour per `shareStatusWarns`) whose click calls the page's `onOpenSharing`, then Update and Share changes… as `SUMMARY_BADGE`-shaped buttons. It takes `actions` from the page and owns no mutation; keyed by agent id
- **`useShareActions(agentId, {onError, onNote})`** — one instance, in `LocalAgentPage`: the `useUpdateShared`, `useShareChanges` and `useUseTeamVersion` mutations, which dialog is open, and the `dialogs` node the page renders outside both modes. Results arrive through hook-level `onResult`, so a `diverged_conflict` landing after the badge unmounted still opens `ShareConflictDialog`. Dialog state resets when `agentId` changes. The page routes `onError` through `shareErrorSink`: `SharingTab`'s `WhereSection` registers its own line via `bindActionErrors` while mounted, otherwise the page's error slot. After the badge's click the page focuses `#agent-tab-sharing` once settings mode renders
- **`SharingTab`** — `null` until `useAgentShareStatus` has a status; `useTeamLibrary({refresh: true})` for the entry's facts (matched by `repoId`). `PeopleSection` only for `onActiveLibrary` (a `cinna` remote, not `other_account` / `removed`). Its edits go through `useSetSharePeople`, with `fromDialogRef` sending a refusal to the dialog (Add) or under the list (select, remove); `confirmingKey` holds the one row asking to remove; the self row has an empty spacer where the remove would be. `visible: false` renders the listing's maintainers and the hint. `HistorySection` renders `useShareHistory`. `RemoveSection` owns `useUnshare` (hook-level `onResult`, since success unmounts the tab) and offers the delete only when `onActiveLibrary`, the entry is listed and `entry.access === 'maintain'`
- **`ShareChangesDialog`** — field present and editable from the first frame; the draft fills it only if untouched. **`ShareConflictDialog`** — two buttons, **Keep working on mine** focused. **`ShareWithTeamDialog`** — the name, filled by the draft unless typed into, then `PeopleSearch` and a fixed-height chosen list (`h-[5.5rem]`, "Only you, for now." when empty), each row an `AccessSelect` defaulting to `read` and a remove. **`ShareWithPersonDialog`** — `PeopleSearch` (focused), a one-line chosen slot present before anyone is picked, `AccessSelect`, Add. **`RemoveSharingDialog`** — `danger` heading, Cancel focused, the unchecked delete checkbox only with `offerDelete`, a fixed-width confirm. `PeopleSearch`: a 250 ms debounce, a ticket so an older answer never replaces a newer one, the previous results kept while searching, and a fixed `h-[7.5rem]` results area that holds the hint, "Searching…", "No one found." or the list, so typing moves nothing. None owns its mutation: each is owned by the component that opens it, with hook-level callbacks (`useSharing.ts`) so a close-on-success survives the dialog's unmount; none can be dismissed while its action runs
- **`TeamLibraryPanel`** — tiles built like the bundle tiles; Get / Update available / Installed + Open; per-tile busy state and refusal from `TeamLibraryActions`, owned by `LocalAgentsList` so closing the dialog mid-Get loses nothing and the landing on the new page still happens
- **`CatalogBrowserModal`** — `useTeamLibrary({refresh:true})`; the source tablist renders only when the parent passed `library` **and** the listing is non-null. Refresh acts on whichever source is shown
- **`AgentActionsMenu`**: **Share with the team…** only for a kit agent that the statuses list says is not shared, or lists as `removed`. It also requires a `cinna_user` profile whose library query returned data. A shared kit agent's delete is titled **Remove from this computer** everywhere it names itself and always trashes the folder
- **`TeamChangedCard`** — `onActed` retains the card before the call, as an answered ask is; `diverged_conflict` navigates to the agent page. Row key `team:<agentId>:<changedAt>` so a newer change is a new card. **Not counted** in the Inbox badge (`inboxWaitingCount` counts asks and dispatcher cards only)
- **`TeamLibraryGet`** — mounted only for an `unavailable` dependency with a `manifestId`, so a job with nothing to get never reads the library; renders nothing until the library lists a match with no local copy. Success invalidates `['jobs', jobId]`

## State Management

- Query keys (`useSharing.ts`) are prefixed `['sharing', …]` and keyed by the active profile, because `other_account` and access read differently under another account
- `sharingPeopleKey(profile, agentId)` and `sharingHistoryKey(profile, agentId)` sit under the same `['sharing', …]` prefix, so `useSharingWatch` refreshes them with everything else. `useSharePeople` and `useShareHistory` have a 30-second `staleTime` and no interval
- `useSharingWatch` invalidates every sharing query and the Inbox on `sharing:changed`
- `useShareStatus` for an `external` remote passes `fetch: true` at most once a minute per agent, decided from a module-level clock (`lastExternalFetch`) rather than from "this is a refetch" — a fetch publishes `sharing:changed`, which invalidates the status, which would otherwise fetch again
- Mutation settle writes the returned status into the caches and invalidates the list, the library, every agent's People and History, and — after an action that rewrote a folder — the agents list
- `useSetSharePeople` writes the answered list straight into that agent's People key before invalidating it, so the next edit builds on the server's list and a select does not snap back while the refetch runs
- `useUnshare` on success sets the agent's status key to `null` and drops it from every cached statuses list at once; that removal is what takes the badge and the Sharing tab away (the page then falls back to Overview)

## Configuration

- `REFRESH_INTERVAL_MS` (libraryService) — five minutes
- Git timeouts are the root-update half's: local reads and the long network timeout per network child
- `HISTORY_LIMIT` (gitService) — 30 versions; the people search asks for `limit=10` and waits `SEARCH_DEBOUNCE_MS` (250, `ShareDialogs.tsx`) after typing
- `MAX_SUMMARY_DIFF_CHARS` 16 000 (what the summary reads), `MAX_SUMMARY_CHARS` 600 (what the field keeps), `MAX_DETAIL_CHARS` 300 (server words carried back)

## Security

- **The token** — minted per git child, environment only, header scoped to the remote's origin, redirects off, only for a remote whose instance is the active profile's (`other_account` reaches no network). `scrubCredentials` on every stderr that is logged or returned; `redactRemoteUrl` on `AgentRemote.url`
- **Origins** — `src/main/services/libraryTrust.ts` keeps, in `<userData>/team-library-trust.json` (main-only; the settings store is renderer-writable), the git origins each instance named in a listing (`libraryService.refresh` learns every `clone_url`) or a create answer, and the pending entry per instance and slug. `parseRemote` calls a remote `cinna` only when its git origin is an instance's own or trusted by it (`trusts` / `serversFor`); `.git/config` `cinna.server` (`gitService.setCinnaServer`) only picks among those, then the active profile's host. `authFor` re-checks `trusts` before minting. `acceptableGitOrigin`: https, or http only from an http instance or to loopback
- **Secrets** — kit ignore rules forced through `.git/info/exclude`; `secrets_tracked` before any record, and for Share with the team before the library entry exists; missing kit ignore files written on first share; tracked secrets left out of the text the AI summary reads
- **Who can get a new entry** — the grants `PUT` is the only restriction while core ignores `grants` on create and adds `everyone: read`, so `createAndSend` sends nothing until it succeeds. The window between create and `PUT` is open on core's side and cannot be closed from here (see [the business rule](team_sharing.md#a-new-agent-reaches-only-the-people-chosen-never-everyone))
- **Identity** — never the machine's login or host name in a recorded version
- **Plaintext on the server, by design** — an agent in the Team library is an ordinary git repository on the Cinna server, readable by the server and by everyone the library grants. Unlike [data sync](../../sync/data_sync/data_sync.md), nothing here is end-to-end encrypted; the protection is what is kept out of the repository
- **Paths** — every folder is resolved in main from an agent id or a library repo id; Get's target is `Local/<slug>` under the agents home with the slug checked against `SLUG_PATTERN`

## Testing

- `src/main/services/localAgents/gitService.test.ts`: real repositories and the real binary (bare origins, two clones). A pre-receive hook refuses any new file under `credentials/` or `app-data/`, in any version of the send. It stands in for cinna-core's push policy, which is how rewriting and untracking are proven. Cases cover: a developer's history keeping each version's message and author, a teammate's newer version kept while only this folder's unsent credentials are dropped, an Update that leaves the credentials folder on disk, the detached-HEAD refusal, a non-Cinna remote still receiving `credentials/`, and a read-only preflight. A local HTTP server checks that the header reaches only its origin, is never written to `.git/config`, and is not carried across a redirect
- `src/main/services/libraryTrust.test.ts`: `learn` / `trusts` / `serversFor`, `acceptableGitOrigin`, pending entries, persistence through the file, and memory only when the host has no `userData`
- `src/main/kit/layout.test.ts`: `never_travels` is read from the bundled `layout.json`, and is absent from a contract that predates it
- `src/main/services/localAgents/sharingService.test.ts` — real folders, real agent index, real git; `cinnaFetch` and `getCinnaAccessToken` mocked, the latter's calls proving whether a token was minted; `libraryTrust` pointed at a temp file; counts `execFile` spawns to prove a memoised Inbox read runs no git
- `src/main/ipc/sharing.ipc.test.ts` — the outcome wrapping
- `src/renderer/src/utils/shareText.test.ts` — every string against `FORBIDDEN_SHARE_WORDS`, the badge forms included
- `sharingService.test.ts` also covers Share with the team's grants (created with the chosen people, the `PUT` before any send, nothing sent when it fails or no maintainer is named), People (both mappings, `403` as not visible, no request for another account's agent, the whole-list `PUT`, search from two characters), History, and Remove sharing (local only, delete first, a refused delete changing nothing, another account's agent, the turn lock)
- Component tests beside `AgentShareBadge` (first-paint slot, the actions surviving the badge's unmount, the dialogs), `SharingTab`, `CatalogBrowserModal`, `AgentActionsMenu` (Share with the team's people picker), `LocalAgentsList`, `LocalAgentPage` (the tab only for a shared agent, the fallback to Overview, the badge's click and focus), `InboxView.teamChanged`, `TeamLibraryGet`. None of these talks to a real cinna-core
