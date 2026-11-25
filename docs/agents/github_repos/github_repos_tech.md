# GitHub Repos — Technical Details

Behaviour and rules: [GitHub Repos](github_repos.md).

## File Locations

### Main process

- `src/shared/github.ts` — `OPENCINNA_APP` (public client id, slug), `OPENCINNA_INSTALL_URL`, `GITHUB_CHANGED` (`github:changed`), the DTOs (`GithubStatusDto`, `GithubNeedDto`, `GithubDeviceFlowDto`, `GithubCoverage`), `GithubResult<T>`, `GITHUB_URLS` (the two pages the renderer may open: `manage`, `applications`). Dependency-free; the renderer imports it
- `src/main/services/github/githubAuthService.ts` — per-profile sign-in, refresh, coverage cache, device flow, needs; the `githubAuthService` singleton and the two hook setters
- `src/main/services/github/githubApi.ts` — the GitHub HTTP calls (device code, poll, refresh, `/user`, `/user/installations` with pagination, `/repos/{owner}/{repo}` for visibility), response validation; base URLs read per call
- `src/main/services/github/githubCoverage.ts` — `parseRepo`, `ownerOf`, `coverageOf`, `installUrlFor`
- `src/main/services/github/githubNeeds.ts` — `createNeedsRegistry` (needs and dismissed keys, in memory)
- `src/main/services/github/githubLoopback.ts` — `githubLoopbackRoutes(service, options?)`: `/github/token` and `/github/needed`, the sentences in `GITHUB_MESSAGES`, `GITHUB_COVERAGE_DEADLINE_MS` (12 s) and `GITHUB_TOKEN_ROUTE_BUDGET_MS` (35 s); `options` (`coverageDeadlineMs`, `routeBudgetMs`, `now`) exist for tests
- `src/main/services/serviceCredentials/tokenServer.ts` — the listener; `route(path, handle)` registers exact extra paths
- `src/main/services/serviceCredentials/service.ts` — `githubEndpointFor` (kit agents only), `registerTokenRoute`
- `src/main/services/skillRuntime.ts` — `engineCredentialEnv` (sets or strips `CINNA_GITHUB_URL`, `CINNA_GITHUB_BEARER` and the git helper entries), `ghWrapperPath`
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
- `token(userId)` — `token` | `needed` (`sign_in`/`reconnect`) | `unavailable`. Not available profile → sign_in; expiry null or at least `MIN_TOKEN_TTL_MS` (10 min) away → as is; else `refresh`, one flight per profile
- refresh — a dead refresh token (`bad_refresh_token`, `incorrect_client_credentials`, expired locally, none stored) → `expire` (tokens dropped, state `expired` persisted and published, coverage and visibility caches dropped); any other refusal or network error → `unavailable`. `expire` records **no** need: the wrapper may still fall back to the user's own gh login, so the Reconnect row comes only from the wrapper's `/github/needed` (Settings shows `expired` from the account state). A refresh that returns no new refresh token keeps the old one. A profile that moved on (sign-out, removal: its `gen` bumped) during the call gets nothing written back
- `startDeviceFlow`, `cancelDeviceFlow` — one flow per profile; polling honours `slow_down`, ends on `expired_token`, `access_denied`, the code's own expiry or another error; completion reads `/user`, persists, clears the account need, publishes, reads coverage, then runs the signed-in hook
- `coverageFor(userId, repo)` — cached; refreshes when never read, and at most once per `COVERAGE_MISS_REFRESH_MS` (60 s) while the repo is not covered; null when unreadable
- `visibilityFor(userId, repo)` — `'public'` | `'private'` | null (unknown), from `GET {api}/repos/{owner}/{repo}` with the profile's token: 200 with `private: false` → public, `private: true` → private; 404 → private; 403 (often a rate limit), 401, 5xx, a 200 without the field, unreachable, timeout or no token → null. A definite answer is kept per lowercased repo for `VISIBILITY_REFRESH_MS` (60 s) in `Profile.visibility`; a read in flight is shared; an unknown answer is dropped when it settles, so the next request asks again. At most `VISIBILITY_CACHE_MAX` (500) entries, oldest evicted. Dropped with the coverage cache (`clearCoverage`: expiry, completed sign-in, sign-out, removal). Asked only for an uncovered repo on a `via: "gh"` request
- `checkAgain`, `recordNeed` (the profile's own state decides sign-in vs reconnect; `chatless` lists the agent in `chatlessAgentIds`), `dismiss`, `signOut`, `profileRemoved`, `holderOf` (the holder's profile and `chatless`; `{ locked: true }` when that profile exists but cannot serve; `{ conflict: true }`; null when there is no profile, or it is gone (`GithubProfileAccess.exists` false): sign_in, nothing recorded), `chatlessNeeds` (the Inbox's needs), `ghMissing`, `installProfileAccess`
- Every GitHub call times out after `GITHUB_HTTP_TIMEOUT_MS` (20 s). The token route bounds the rest: the refresh (≤ 20 s) plus the coverage and visibility reads (≤ `GITHUB_COVERAGE_DEADLINE_MS`, 12 s, and never past `GITHUB_TOKEN_ROUTE_BUDGET_MS`, 35 s, from the request's start) stay below the wrapper's 40 s wait, so a slow GitHub answers before curl gives up
- `core.ts` supplies profile access: `agentHolder` is `githubHolderOf(turnLock.sharedOrigins(agentId), activatedProfileUserId)` (`githubLoopback.ts`, detailed below); available means the profile exists and is either the active one or passwordless/unlocked; `exists` tells a locked profile from a deleted one. It also hooks the managed gh: a completed sign-in runs `which('gh')` and installs only if none; a wrapper `gh_missing` report starts the install and answers whether one is running

`githubNeeds.ts`: one account need (key `account`), one install need per owner (key `install:<owner lowercased>`, repositories merged), `agentIds` per need and `chatlessAgentIds` (listed only when non-empty), `dismissedKeys`; only keys of those two shapes are remembered as dismissed.

### Which profile a request is served for

`turnLock` holds carry an optional `HoldOrigin` `{ userId?, chatless?: 'command' | 'schedule' }`, recorded at acquisition. `turnLock.sharedOrigins(agentId)` lists every shared hold's origin (null for none), oldest first; `githubHolderOf` resolves each to its `userId` or, without one, `activatedProfileUserId()` (`auth/activatedProfile.ts`, the active profile once activated, else null). More than one distinct profile → `{ conflict: true }`: `/github/token` answers `{unavailable: true, message: GITHUB_MESSAGES.otherProfile}` and `/github/needed` records nothing. Otherwise that profile, with `chatless` set (the newest hold's kind) only when **every** shared hold recorded a chatless origin: a hold that recorded none, or a chat's turn, may be shown in a chat, so the need then gets the chat's row and no Inbox card / agent-page row. Who records what:
- a chat's model turn — `acpDriver` passes `{ userId: runScope.profileUserId }` to `withLock` (the run's profile, not `chats.user_id`: a folder agent's chat is owned by the default profile and shared across profiles)
- a chat's `/run:` — `resolveCommandRunner(…, profileUserId)` → `runForTurn` → `run(…, { userId })`
- a scheduled command — `runScheduled(…, profileUserId)` records `{ userId, chatless: 'schedule' }` (`localScheduleService` passes `scope.profileUserId`)
- a status refresh (`statusRefresh.ts`), a dashboard's refresh command and a dashboard endpoint (`endpointRunner`) — `{ userId: activatedProfileUserId(), chatless: 'command' }` at start
- not recorded: Finish setup's `credentials-env` hold; it works for the active profile

`inboxService.list` adds `github: GithubNeedInboxItem[]` (`{ kind: 'github_need', need, agents: [{ id, name }] }`) from `githubAuthService.chatlessNeeds(profile)`, names from the agent rows.

`githubCoverage.ts:installUrlFor`: `repo_not_selected` → the installation's configure page (organizations/<owner>/settings/installations/<id>, or settings/installations/<id>); otherwise the app's install page, with `permissions?target_id=<owner id>` when known.

## The loopback routes

Registered on the credential token listener (`127.0.0.1`, ephemeral port, same bearer per agent, same held-while-a-turn-runs rule, Host/Origin/size checks as the Google route; body must be a JSON object, else 422). `CINNA_GITHUB_URL` is the listener origin plus `/github`; `CINNA_GITHUB_BEARER` the agent's bearer (named to avoid every secret-like word — AUTH, KEY, SECRET, TOKEN, PASS, CREDENTIALS… — because Claude Code's `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`, set in API Token mode, strips such names from the agent's Bash; the earlier `CINNA_GITHUB_AUTH` was stripped, checked by `claude.launch.subprocess-env-scrub-gh`). Every kit agent gets them, with or without a Google record. Every string value in an answer is free of `"`, `\` and newlines, since the wrapper reads them with sed.

- `POST /github/token` `{repo?: "owner/repo", via?: "gh" | "git" | "write"}` (`via` absent or anything else = `git`, failing closed; the wrapper always sends it: `git` from `auth git-credential`, `write` for a gh command on its write list, `gh` otherwise) →
  - `{token, expires_at (epoch seconds or null), login, name, email}`
  - `{needed: "sign_in" | "reconnect", message}`
  - `{needed: "install", message, repo}` — the coverage cache says the repo is not covered, and either `via` is `git`/`write` (a push, a fetch of a repo that is not public — a public clone or fetch never asks git's helper — or a gh write: GitHub refuses the app on an uncovered repo whatever its visibility) or `via` is `gh` and `visibilityFor` says private. Via `gh`, an uncovered public repo, or one whose visibility is unknown, gets the token
  - `{unavailable: true, message}` — transient, another profile holds the agent (`otherProfile`), or the holder's profile is locked (`locked`; nothing is recorded). A deleted holder profile answers `{needed: "sign_in"}` and records nothing

  Unknown coverage hands the token out, for `gh` and `git` alike: installations unreadable, or the coverage and visibility reads not done by the deadline (`GITHUB_COVERAGE_DEADLINE_MS` from when the token is in hand, capped at `GITHUB_TOKEN_ROUTE_BUDGET_MS` from the request). A read that misses the deadline goes on in the background and fills its cache.
- `POST /github/needed` `{kind: "sign_in" | "reconnect" | "install" | "gh_missing", repo?}` → `{ok: true}`, recorded under the same holder profile as `/github/token`, with `chatless` from the hold; `gh_missing` → `{ok: true, installing: boolean}`; any other kind → 422 `{detail: {code: "invalid_request", message}}`

Sentences (`GITHUB_MESSAGES`): "GitHub isn't connected. Ask the user to click Sign in to GitHub under the message box, then run this command again." / "The GitHub sign-in has expired. Ask the user to click Reconnect GitHub under the message box, then run this command again." / "Cinna's GitHub app can't reach <repo> yet. Ask the user to click Allow access under the message box, then run this command again." / "GitHub could not be reached to refresh the sign-in. Try again in a moment." / "Another Cinna profile is running this agent right now. Try again when its run has finished." / "This agent's Cinna profile is locked. Ask the user to unlock it, then run this command again."

## The `gh` wrapper

Written to `<userData>/gh-shim/gh` (rewritten whenever its content differs; its empty config directory is `<userData>/gh-config`), and put first on `PATH` by `withDeveloperToolShims` for every child that takes the developer-tool shims, on macOS and Linux, always. It needs `curl` (and `sed`, `head`, `grep`). Its second line is the marker `# cinna-gh-wrapper` (`GH_WRAPPER_MARKER`). Real `gh`: the first on `PATH` outside Cinna's own directories (`gh-shim`, `tool-shims`, `git-shim`) that does not carry the marker in its first five lines (`head -n 5 | grep -q`), so another Cinna instance's wrapper (a dev and a release app, two userData directories) is never taken for the real `gh` and the two never exec each other in a loop; else the managed one.

Per call:
1. No endpoint (`CINNA_GITHUB_URL`/`_AUTH` unset, or no curl): the real `gh` untouched (127 and "gh: command not found" if there is none).
2. The repo is read from `-R`/`--repo` (`OWNER/REPO`, `github.com/OWNER/REPO` or a `https://github.com/…` URL; any other host names no repo), `repo clone|view|edit|fork|sync|set-default|archive|unarchive|delete <repo>`, `api repos/<o>/<r>/…`; the positional is the first argument that is neither a flag nor the value of a known value flag (`--org`, `--remote-name`, `--fork-name`, `-u`, `-s/--source`, `--state`, `-b/--branch/--body`, `-B/--base`, `-H/--head`, `-t/--title`, `--template`, `-F/--body-file`, `-l/--label`, `-a/--assignee`, `-r/--reviewer`, `-m/--milestone`, `-q/--jq`, `--json`, `-L/--limit`, `-S/--search`, `-d/--description`, `-h/--homepage`, `--default-branch`, `--add-topic`, `--remove-topic`, `--visibility`). Only when none is named does the folder's `origin` (when on github.com) answer, and only for commands that act on the current repository: `pr`, `issue`, `release`, `run`, `workflow`, `browse`, `cache`, `secret`, `variable`, `label`, `ruleset`, `attestation`, and `repo view|edit|sync|fork|set-default|deploy-key|archive|unarchive|rename|delete` without `-R`/`--repo` or a repo argument. Never for `auth`, `api`, `search`, `gist`, `repo clone|list|create`, `status`, `extension`, `config`, `alias`, `codespace`, `org`, `project`, `ssh-key`, `gpg-key` or an unknown command. `-R`/`--repo` naming another host (`HOST/OWNER/REPO`, a URL or scp-style remote not on github.com) runs the real `gh` untouched before any token request. `POST /token` `{"repo"?, "via"}` (curl `--max-time` 40; bearer on stdin), `via` `write` for: `pr create|edit|merge|comment|close|reopen|review|ready|lock|unlock`, `issue create|edit|comment|close|reopen|delete|lock|unlock|transfer|pin|unpin`, `release create|edit|delete|upload|delete-asset`, `repo edit|delete|archive|unarchive|rename|fork|sync`, `repo deploy-key add|delete`, `label create|edit|delete|clone`, `secret|variable set|delete`, `workflow run|enable|disable`, `run rerun|cancel|delete`, `cache delete`, and `api` with `-X`/`--method` other than GET or any `-f`/`-F`/`--field`/`--raw-field`/`--input`; `gh` for everything else.
3. Not answered, by curl's exit: 7 (could not connect: refused, or a sandbox's refusal of the connect, which curl also reports as 7) or 28 before connecting → exit 4 with `GH_NETWORK_MESSAGE` ("This GitHub command needs network access, which this sandbox blocks. Run the same command again with escalated permissions. It is not an internet outage."); 28 after connecting → exit 1 with `GH_SLOW_MESSAGE` ("Cinna is taking too long to answer for GitHub. Try again in a moment."); anything else (52 empty reply, 56 reset, …) → exit 1 with `GH_RETRY_MESSAGE` ("Cinna could not answer for GitHub just now. Try again in a moment.").
4. Answer other than 200 (a 401: nothing holds the agent any more): the real `gh` untouched.
5. A token: no `gh` anywhere → report `gh_missing` and exit 1 with `GH_INSTALLING_MESSAGE` ("Cinna is still installing gh, try again in a moment.") or `GH_NOT_INSTALLED_MESSAGE` ("gh isn't installed and Cinna couldn't install it. Ask the user to install the GitHub CLI from https://cli.github.com, then run this command again."). Otherwise `exec` the real `gh` with `GH_TOKEN`, `GH_CONFIG_DIR` the empty directory, `GH_PROMPT_DISABLED=1`, and `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, `GITHUB_ENTERPRISE_TOKEN`, `GH_HOST` removed. `repo clone` is not `exec`'d: afterwards, on success, the clone directory gets the commit identity if git has no `user.email` there.
6. Needed (or unavailable): the user's own login (`gh auth token --hostname github.com`) → the real `gh` untouched. Else for `sign_in`/`reconnect`/`install`, `POST /needed` and print the endpoint's message, exit 4. Anything else (unavailable): its message, exit 1.

git: `gh auth git-credential get|store|erase`. For a github.com https request in a child with the endpoint, only `get` is answered (`POST /token` with `"via":"git"`, the repo from `path`; the not-answered cases print the same sentences with the same exits): a token as `username=x-access-token` and `password`, else the user's own helper through the real `gh`; a need prints its message and exits 0 (git then fails by itself). `store` and `erase` do nothing for a token the wrapper served. Anything else passes through to the real `gh`.

`engineCredentialEnv` appends, after any `GIT_CONFIG_*` entries already in the env, three: the `credential.https://github.com.helper` list reset to empty, that key set to the wrapper (`!'<…>/gh-shim/gh' auth git-credential`), and `credential.https://github.com.useHttpPath=true` so git passes `path=owner/repo.git`; this beats a user's osxkeychain or `gh auth setup-git` helper. Only when the endpoint is set and the wrapper file exists (a helper naming a missing file would break every github.com remote). A `GIT_CONFIG_COUNT` that is set but not a non-negative integer of at most four digits (empty counts as 0) leaves the env's `GIT_CONFIG_*` untouched and adds nothing (logged once at debug): renumbering over a count git itself refuses could lose the user's entries, so that child's git uses the user's own helpers. Without the endpoint any entries of ours are removed and the rest renumbered (`withoutGithubCredentialHelper`), and `createGhShim.apply` strips them too. Same input always gives the same env, so a pool launch key built from it is stable.

## Configuration

- `CINNA_GITHUB_WEB_URL`, `CINNA_GITHUB_API_URL` — base URLs for github.com and api.github.com, read per call (E2E points them at fakes: `src/main/services/github/testSupport/fakeGithub.ts`)
- `CINNA_GH_DOWNLOAD=off` — no managed gh download (the E2E fixture sets it on every launch)
- `RUNTIME_PINS.gh` in `src/shared/runtimePins.ts` — the managed gh's version and archives; installs to `<userData>/runtimes/gh-<version>/bin/gh`; failure marker `.gh-<version>-unsupported`

## Security

- Access and refresh tokens, the device code and the agent bearer are registered with `rememberCredentialSecrets`, so log redaction covers them. Tokens never reach the renderer, a log, a file under the agent's folder or a command line.
- The loopback checks (Host, no Origin, per-agent bearer, held-only-while-a-turn-runs) are those of the credential token listener; a child that outlives its turn gets 401 and the wrapper falls back to the user's own login.
- Only `https://github.com` pages open from `github:open-install` and `github:open-url`.
- The commit email is the noreply form; it never reaches the renderer.
