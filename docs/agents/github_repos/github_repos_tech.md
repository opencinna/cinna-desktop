# GitHub Repos — Technical Details

Behaviour and rules: [GitHub Repos](github_repos.md).

## File Locations

### Main process

- `src/shared/github.ts` — `OPENCINNA_APP` (public client id, slug), `OPENCINNA_INSTALL_URL`, `GITHUB_CHANGED` (`github:changed`), the DTOs (`GithubStatusDto`, `GithubNeedDto`, `GithubDeviceFlowDto`, `GithubCoverage`), `GithubResult<T>`, `GITHUB_URLS` (the two pages the renderer may open: `manage`, `applications`). Dependency-free; the renderer imports it
- `src/main/services/github/githubAuthService.ts` — per-profile sign-in, refresh, coverage cache, device flow, needs; the `githubAuthService` singleton and the two hook setters
- `src/main/services/github/githubApi.ts` — the GitHub HTTP calls (device code, poll, refresh, `/user`, `/user/installations` with pagination), response validation; base URLs read per call
- `src/main/services/github/githubCoverage.ts` — `parseRepo`, `ownerOf`, `coverageOf`, `installUrlFor`
- `src/main/services/github/githubNeeds.ts` — `createNeedsRegistry` (needs and dismissed keys, in memory)
- `src/main/services/github/githubLoopback.ts` — `githubLoopbackRoutes`: `/github/token` and `/github/needed`, and the sentences in `GITHUB_MESSAGES`
- `src/main/services/serviceCredentials/tokenServer.ts` — the listener; `route(path, handle)` registers exact extra paths
- `src/main/services/serviceCredentials/service.ts` — `githubEndpointFor` (kit agents only), `registerTokenRoute`
- `src/main/services/skillRuntime.ts` — `engineCredentialEnv` (sets or strips `CINNA_GITHUB_URL`, `CINNA_GITHUB_AUTH` and the git helper entries), `ghWrapperPath`
- `src/main/shell/ghShim.ts` — the wrapper script, the `GIT_CONFIG_*` helpers (`withGithubCredentialHelper`, `withoutGithubCredentialHelper`, `githubCredentialHelperFor`), `createGhShim`
- `src/main/shell/developerToolShims.ts` — `withDeveloperToolShims` applies the gh wrapper last, so its directory is first on `PATH`
- `src/main/shell/managedGh.ts` — the managed gh (`ensureInstalled`, `installing`, `binaryLocation`)
- `src/main/hub/core.ts` — wires profile access, the loopback routes and the managed-gh hooks
- `src/main/db/githubAccounts.ts` — the encrypted record; `src/main/db/users.ts` deletes it with the profile; `src/main/services/authService.ts` calls `githubAuthService.profileRemoved`
- `src/main/ipc/github.ipc.ts` — the `github:*` handlers
- `src/main/services/localAgents/toolDetectionService.ts` — a `gh` row (source `managed` when only Cinna's copy exists)

### Preload

- `src/preload/index.ts` — `window.api.github`: `status`, `signIn`, `cancelSignIn`, `signOut`, `checkAgain`, `dismiss`, `openInstall`, `openUrl`, `onChanged`

### Renderer

- `src/renderer/src/hooks/useGithub.ts` — `useGithubStatus` (invalidated on `github:changed`), `useGithubSignIn` (phases: idle, starting, pending, expired, denied, error; copies the code through main's clipboard on start), `useGithubSignOut`, `openGithubUrl`, `useGithubCheckOnFocus`
- `src/renderer/src/components/chat/composerGithubNotices.tsx` — `useGithubNotices` (a chat: every need of its agent; the new-chat screen, which is the agent's page: only the needs a run of that agent with no chat hit, no Continue), `githubNeedNotice`, `githubResolvedNotice`, `useGithubAllowAccess`, `GITHUB_CONTINUE_MESSAGE`; wired in `ChatInput.tsx` after the readiness notices
- `src/renderer/src/components/inbox/InboxGithubCard.tsx` — `GithubNeedCard`, `GITHUB_INBOX_TEXT`: the Inbox card (`snapshot.github`) with the row's action and Dismiss (`github:dismiss`); `InboxView.tsx` renders it, `useInboxList` re-reads on `github:changed`
- `src/renderer/src/stores/githubNotice.store.ts` — per chat, in memory: the keys shown and the chats whose need cleared
- `src/renderer/src/components/settings/GithubAccountSection.tsx` — the Settings section; `UserAccountsSection.tsx` renders it under a Profiles section; `SettingsLayout.tsx` `SettingsCard` gained `flush`

## Database Schema

No table. One row per profile in `app_settings`, key `__github:<userId>` (`GITHUB_ACCOUNT_KEY_PREFIX`), value the keystore-encrypted JSON of the account (login, numeric id, name, noreply email, state, access and refresh token with their expiries), base64. It is not an `AppSettingsSchema` key, so `appSettingsRepo.getAll` never lists it and no settings channel writes it. `userRepo.deleteWithCascade` removes it. An `expired` record keeps who it was and no tokens. Persisting needs secure storage; without it a sign-in or Reconnect fails with a sentence, and a refresh that cannot be stored is held in memory for the session (a restart then needs Reconnect).

## IPC Channels

All answer `GithubResult<T>` (`{ok, value}` or `{ok:false, error}`), never throw, and act on the active profile main resolves itself (no `userId` argument). Each requires an activated session.

- `github:status` `() → GithubStatusDto` — `{account: {login, state, coverage, coverageFetchedAt} | null, device, needs, dismissed}`
- `github:sign-in` `() → GithubDeviceFlowDto` — starts the flow or answers the pending one, then opens its `verificationUri` (only a `https://github.com` URL ever opens); the code stays in `status.device` if the browser did not open
- `github:cancel-sign-in`, `github:sign-out` `() → null`
- `github:check-again` `() → GithubStatusDto` — reads the installations; within 10 s of the last one it answers the cached status
- `github:dismiss` `(key) → null`
- `github:open-install` `(key) → null` — opens the `installUrl` main stored for that install need; the URL never comes from the renderer
- `github:open-url` `(target: 'manage' | 'applications') → null`
- Event `github:changed` `{userId}` (audience `all`) on any change of sign-in, coverage, device flow or needs

## Services & Key Methods

`githubAuthService.ts:createGithubAuthService`:
- `token(userId, agentId?)` — `token` | `needed` (`sign_in`/`reconnect`) | `unavailable`. Not available profile → sign_in; expiry null or at least `MIN_TOKEN_TTL_MS` (10 min) away → as is; else `refresh`, one flight per profile
- refresh — a dead refresh token (`bad_refresh_token`, `incorrect_client_credentials`, expired locally, none stored) → `expire` (tokens dropped, state `expired`, a `reconnect` need, coverage dropped); any other refusal or network error → `unavailable`. A refresh that returns no new refresh token keeps the old one. A profile that moved on (sign-out, removal: its `gen` bumped) during the call gets nothing written back
- `startDeviceFlow`, `cancelDeviceFlow` — one flow per profile; polling honours `slow_down`, ends on `expired_token`, `access_denied`, the code's own expiry or another error; completion reads `/user`, persists, clears the account need, publishes, reads coverage, then runs the signed-in hook
- `coverageFor(userId, repo)` — cached; refreshes when never read, and at most once per `COVERAGE_MISS_REFRESH_MS` (60 s) while the repo is not covered; null when unreadable
- `checkAgain`, `recordNeed` (the profile's own state decides sign-in vs reconnect; `chatless` lists the agent in `chatlessAgentIds`), `dismiss`, `signOut`, `profileRemoved`, `holderOf` (the holder's profile and `chatless`, null when that profile cannot serve), `chatlessNeeds` (the Inbox's needs), `ghMissing`, `installProfileAccess`
- Every GitHub call times out after `GITHUB_HTTP_TIMEOUT_MS` (20 s), shorter than the wrapper's 40 s wait on `/github/token`, so a hung refresh answers "try again" before curl gives up and reads as a blocked sandbox
- `core.ts` supplies profile access: `agentHolder` is `githubHolderOf(turnLock.latestOrigin(agentId), active profile)` (`githubLoopback.ts`): the profile recorded with the newest hold on the agent that recorded an origin, else the active one; available means the profile exists and is either the active one or passwordless/unlocked. It also hooks the managed gh: a completed sign-in runs `which('gh')` and installs only if none; a wrapper `gh_missing` report starts the install and answers whether one is running

`githubNeeds.ts`: one account need (key `account`), one install need per owner (key `install:<owner lowercased>`, repositories merged), `agentIds` per need and `chatlessAgentIds` (listed only when non-empty), `dismissedKeys`; only keys of those two shapes are remembered as dismissed.

### Which profile a request is served for

`turnLock` holds carry an optional `HoldOrigin` `{ userId?, chatless?: 'command' | 'schedule' }`, recorded at acquisition. `turnLock.sharedOrigins(agentId)` lists every shared hold's origin (null for none), oldest first; `githubHolderOf` resolves each to its `userId` or, without one, `activatedProfileUserId()` (`auth/activatedProfile.ts`, the active profile once activated, else null). More than one distinct profile → `{ conflict: true }`: `/github/token` answers `{unavailable: true, message: GITHUB_MESSAGES.otherProfile}` and `/github/needed` records nothing. Otherwise that profile, with the newest hold's `chatless`. Who records what:
- a chat's model turn — `acpDriver` passes `{ userId: runScope.profileUserId }` to `withLock` (the run's profile, not `chats.user_id`: a folder agent's chat is owned by the default profile and shared across profiles)
- a chat's `/run:` — `resolveCommandRunner(…, profileUserId)` → `runForTurn` → `run(…, { userId })`
- a scheduled command — `runScheduled(…, profileUserId)` records `{ userId, chatless: 'schedule' }` (`localScheduleService` passes `scope.profileUserId`)
- a status refresh (`statusRefresh.ts`), a dashboard's refresh command and a dashboard endpoint (`endpointRunner`) — `{ userId: activatedProfileUserId(), chatless: 'command' }` at start
- not recorded: Finish setup's `credentials-env` hold; it works for the active profile

`inboxService.list` adds `github: GithubNeedInboxItem[]` (`{ kind: 'github_need', need, agents: [{ id, name }] }`) from `githubAuthService.chatlessNeeds(profile)`, names from the agent rows.

`githubCoverage.ts:installUrlFor`: `repo_not_selected` → the installation's configure page (organizations/<owner>/settings/installations/<id>, or settings/installations/<id>); otherwise the app's install page, with `permissions?target_id=<owner id>` when known.

## The loopback routes

Registered on the credential token listener (`127.0.0.1`, ephemeral port, same bearer per agent, same held-while-a-turn-runs rule, Host/Origin/size checks as the Google route; body must be a JSON object, else 422). `CINNA_GITHUB_URL` is the listener origin plus `/github`; `CINNA_GITHUB_AUTH` the agent's bearer (named to avoid KEY, SECRET and TOKEN, which engines' env filters may exclude). Every kit agent gets them, with or without a Google record. Every string value in an answer is free of `"`, `\` and newlines, since the wrapper reads them with sed.

- `POST /github/token` `{repo?: "owner/repo"}` →
  - `{token, expires_at (epoch seconds or null), login, name, email}`
  - `{needed: "sign_in" | "reconnect", message}`
  - `{needed: "install", message, repo}` — the token is withheld when the cache says the repo is not covered
  - `{unavailable: true, message}` — transient
- `POST /github/needed` `{kind: "sign_in" | "reconnect" | "install" | "gh_missing", repo?}` → `{ok: true}`, recorded under the same holder profile as `/github/token`, with `chatless` from the hold; `gh_missing` → `{ok: true, installing: boolean}`; any other kind → 422 `{detail: {code: "invalid_request", message}}`

Sentences (`GITHUB_MESSAGES`): "GitHub isn't connected. Ask the user to click Sign in to GitHub under the message box, then run this command again." / "The GitHub sign-in has expired. Ask the user to click Reconnect GitHub under the message box, then run this command again." / "Cinna's GitHub app can't reach <repo> yet. Ask the user to click Allow access under the message box, then run this command again." / "GitHub could not be reached to refresh the sign-in. Try again in a moment."

## The `gh` wrapper

Written to `<userData>/gh-shim/gh` (rewritten whenever its content differs; its empty config directory is `<userData>/gh-config`), and put first on `PATH` by `withDeveloperToolShims` for every child that takes the developer-tool shims, on macOS and Linux, always. It needs `curl`. Real `gh`: the first on `PATH` outside Cinna's own directories (`gh-shim`, `tool-shims`, `git-shim`), else the managed one.

Per call:
1. No endpoint (`CINNA_GITHUB_URL`/`_AUTH` unset, or no curl): the real `gh` untouched (127 and "gh: command not found" if there is none).
2. The repo is read from `-R`/`--repo`, `repo clone|view|fork|sync <repo>`, `api repos/<o>/<r>/…`, else the folder's `origin` when it is on github.com. `POST /token` (curl `--max-time` 40; bearer on stdin).
3. Not answered: connection refused → exit 4 with `GH_NETWORK_MESSAGE` ("This GitHub command needs network access, which this sandbox blocks. Run the same command again with escalated permissions. It is not an internet outage."); connected but timed out → exit 1 with `GH_SLOW_MESSAGE` ("Cinna is taking too long to answer for GitHub. Try again in a moment.").
4. Answer other than 200 (a 401: nothing holds the agent any more): the real `gh` untouched.
5. A token: no `gh` anywhere → report `gh_missing` and exit 1 with `GH_INSTALLING_MESSAGE` ("Cinna is still installing gh, try again in a moment.") or `GH_NOT_INSTALLED_MESSAGE` ("gh isn't installed and Cinna couldn't install it. Ask the user to install the GitHub CLI from https://cli.github.com, then run this command again."). Otherwise `exec` the real `gh` with `GH_TOKEN`, `GH_CONFIG_DIR` the empty directory, `GH_PROMPT_DISABLED=1`, and `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, `GITHUB_ENTERPRISE_TOKEN`, `GH_HOST` removed. `repo clone` is not `exec`'d: afterwards, on success, the clone directory gets the commit identity if git has no `user.email` there.
6. Needed (or unavailable): the user's own login (`gh auth token --hostname github.com`) → the real `gh` untouched. Else for `sign_in`/`reconnect`/`install`, `POST /needed` and print the endpoint's message, exit 4. Anything else (unavailable): its message, exit 1.

git: `gh auth git-credential get|store|erase`. For a github.com https request in a child with the endpoint, only `get` is answered: a token as `username=x-access-token` and `password`, else the user's own helper through the real `gh`; a need prints its message and exits 0 (git then fails by itself). `store` and `erase` do nothing for a token the wrapper served. Anything else passes through to the real `gh`.

`engineCredentialEnv` appends, after any `GIT_CONFIG_*` entries already in the env, three: the `credential.https://github.com.helper` list reset to empty, that key set to the wrapper (`!'<…>/gh-shim/gh' auth git-credential`), and `credential.https://github.com.useHttpPath=true` so git passes `path=owner/repo.git`; this beats a user's osxkeychain or `gh auth setup-git` helper. Only when the endpoint is set and the wrapper file exists (a helper naming a missing file would break every github.com remote). Without the endpoint any entries of ours are removed and the rest renumbered (`withoutGithubCredentialHelper`), and `createGhShim.apply` strips them too. Same input always gives the same env, so a pool launch key built from it is stable.

## Configuration

- `CINNA_GITHUB_WEB_URL`, `CINNA_GITHUB_API_URL` — base URLs for github.com and api.github.com, read per call (E2E points them at fakes: `src/main/services/github/testSupport/fakeGithub.ts`)
- `CINNA_GH_DOWNLOAD=off` — no managed gh download (the E2E fixture sets it on every launch)
- `RUNTIME_PINS.gh` in `src/shared/runtimePins.ts` — the managed gh's version and archives; installs to `<userData>/runtimes/gh-<version>/bin/gh`; failure marker `.gh-<version>-unsupported`

## Security

- Access and refresh tokens, the device code and the agent bearer are registered with `rememberCredentialSecrets`, so log redaction covers them. Tokens never reach the renderer, a log, a file under the agent's folder or a command line.
- The loopback checks (Host, no Origin, per-agent bearer, held-only-while-a-turn-runs) are those of the credential token listener; a child that outlives its turn gets 401 and the wrapper falls back to the user's own login.
- Only `https://github.com` pages open from `github:open-install` and `github:open-url`.
- The commit email is the noreply form; it never reaches the renderer.
