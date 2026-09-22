# Credential delivery verification — 2026-09-21

Tests use dummy service secrets. Real Desktop authorizations were limited to two disposable accounts on the local Core at `http://localhost:8000`. Electron tests use isolated userData and a test-only keystore adapter; they do not alter the developer's real keychain. These accounts are deleted after verification.

| Check | Result |
| --- | --- |
| Desktop complete Vitest suite | 6,554 passed; 6 existing skips |
| Added ACP/command lock probes, together with their regression suites | 176 passed |
| Final focused storage/helper/redaction/live-stream checks | 34 passed |
| Desktop Node, renderer, E2E typechecks | passed |
| Desktop production build | passed |
| Headless Hub boundary + durable transcript/reconnect probe | passed |
| Core delivery, kit API/scaffold, SMTP and environment-builder tests | 280 passed; 10 environment-dependent skips |
| Core frontend TypeScript build check and new API Python lint | passed |
| CLI contract and local-import suites | 129 passed; 2 skips |
| Isolated Electron local credentials and UI create/attach/detach | passed |
| Live Core owned/shared attach, rotation, opt-out, account switch, logout | passed |
| Existing kit `.env` actions and bare-folder menu | 2 passed |
| Delegated kit requester → bare executor, blocked report, reply, completion | passed, including separate attachments and redaction |
| Live admin CLI account | metadata 200; materialization 403 |

Pinned runtime probes used fake loopback providers, disposable homes, real ACP adapters/binaries, and a shell child that read `CINNA_CREDENTIALS_PATH` outside its cwd. All passed: Claude Code 2.1.276 / adapter 0.76.0; Codex 0.155.0 / adapter 1.11.0; OpenCode 1.18.27. They verify environment propagation and external-file access, not a promise of OS isolation.

Service tests also exercise unavailable encryption, permissions/write-on-change, authored-file preservation, tracked-path refusal, stable attachment identity after profile recreation, busy-turn revocation, malformed-list preservation, account/suspend response invalidation, shared offline TTL, cleanup failure, moved bare folders, and Python helper precedence/placeholder/transform behavior. Screenshots of the new Settings and Agent Credentials surfaces were reviewed; create/attach/detach was driven through the UI.

## Repeating locally

From Desktop:

```sh
npm test
npm run typecheck
npm run test:hub
npm run build
npx vitest run -c vitest.contract.config.ts src/main/agents/drivers/acp/contracts/credentials.contract.test.ts
npx playwright test -c e2e/playwright.config.ts service-credentials.spec.ts open-credentials-env.spec.ts delegation-bare.spec.ts
```

The live Core case is opt-in. With local signup enabled, run `e2e/fixtures/create-live-credentials.py` in Core's backend container and redirect stdout to a private (`umask 077`) temporary file. It creates disposable owner/recipient users, a shared dummy token, and interactive PKCE Desktop authorizations. Pass the file as `CINNA_CREDENTIALS_LIVE_FIXTURE` for `service-credentials.spec.ts`. The test deliberately logs out/revokes the owner Desktop client; use new authorizations for another run. Delete both disposable users via `DELETE /api/v1/users/me` using their fixture web headers, then remove the fixture file. Never commit it.

From Core:

```sh
docker compose exec -T backend pytest tests/api/external/test_desktop_credentials.py tests/api/cli/test_local_agent_kit.py tests/unit/test_local_kit_tool.py tests/api/credentials/test_email_smtp_credential.py tests/api/credentials/test_credential_service_uri_env_sync.py -q
```

From CLI: `.venv/bin/python -m pytest tests/test_kit_contract.py tests/test_local_import.py -q`.

The local development Core migration was applied. These are working-tree changes; no production deployment or release was performed. Other installations need the Core migration/backend/frontend followed by a Desktop build.


## Review corrections — 2026-09-22

The nine review findings were addressed. Activation isolates unsafe or undecryptable agent folders, stored token identity is read without network refresh, and Linux service-credential storage policy no longer changes the existing provider/OAuth keystore. Redaction covers raw and JSON-escaped secrets, including `api_key`. Permission refusals keep polling, empty credential fingerprints survive lifecycle changes, and attachment changes wait for the current turn. Readiness and both Core helper copies match type plus service identity. Desktop validates and displays sibling publication ledgers with legacy manifest fallback.

Regression coverage includes symlink and decryption failures alongside a healthy agent, expired stored token identity, offline recovery and stalled startup requests, every streaming split of escaped PEM/password/API-key values, a scheduled 403 recovery followed by 401 stop, stable empty and unchanged attached fingerprints, rotation, queued detach and account-switch invalidation, wrong-service token rejection, and publication-ledger precedence.

Fresh checks after these fixes:

- Complete Desktop Vitest suite: **6,570 passed, 6 existing skips** (399 test files).
- Node, renderer and E2E typechecks, production build, and Hub boundary/durable transcript probe passed.
- Core kit/API tests: **270 passed, 10 skipped**.
- CLI kit/import tests with live Core layout parity enabled: **130 passed, 1 skipped**.
- Isolated Electron credentials/UI, `.env`, and delegation tests: **5 passed**.
- Fresh live Core owner/shared attach, rotation, opt-out, account isolation and logout: **1 passed**. Both disposable accounts and the private authorization fixture were deleted afterward.

The sandbox blocks localhost server binding; integration tests were rerun with local-server access. The full-suite run also exposed two fixed-delay races in the test helper; it now acquires the real queued turn lock.


## Credential UI and profile sync — 2026-09-22

Settings actions now use the shared Settings button component. Local creation starts with searchable type cards and opens the selected form; all types expose Service URI with contextual help. The remote toolbar places Manage on Remote beside Sync Now. Core’s standard forms, OAuth forms, SSH metadata editor, agent API connection/key editors, and MCP connection editor all save Service URI as top-level metadata; template field-sharing offers it for every type.

Manual sync carries the displayed profile ID through IPC, rejects stale-profile actions, and owns its in-flight operation by profile and lifecycle epoch. Retirement aborts credential HTTP calls. Sensitive requests use `cache: no-store`, avoiding browser ETag/304 ambiguity and persistent caching of delivered values, with a 30-second request deadline. Unsupported endpoints and server failures have distinct UI errors and scoped diagnostic logs.

The complete Desktop suite passed **6,589 tests (6 existing skips)**. Verification also includes 46 focused Desktop checks, 15 browser-driven Core credential form saves, Desktop/Core typechecks and production builds, the Electron picker/create/attach/detach flow, and fresh live Core repeated unchanged-list sync, rotation, revocation and account-isolation checks. The live Electron test also opens the remote credentials screen and uses Sync Now successfully. Disposable live accounts and authorization fixtures are deleted after each run. Picker, form/help, remote toolbar, and Core Service URI screenshots were visually reviewed.

A final metadata-edit regression verifies that changing or clearing an API token’s Service URI also updates its compatibility field without replacing the secret. All 22 service tests passed after that change, followed by a fresh Desktop build and successful live Core/UI run.

Run Core’s UI regressions with `node --test tests/credentialForms.test.mjs` from `frontend/`.

## Profile request identity — 2026-09-22

Credential list IPC now carries the renderer’s profile ID and server URL, as does manual sync. Both are checked against the active profile before returning its data or starting HTTP. The query key includes the server URL and discards cancelled responses. The shared HTTP client rejects session/server changes during token resolution and includes the profile ID in failure logs. Remote settings show the destination server explicitly.

Validation: 40 credential regressions and 52 related HTTP-consumer tests passed, along with all typechecks and the production build. A two-host Electron regression switches from a server returning 404 to a working server through the real profile switcher, verifies the old error disappears, and proves Sync Now makes no additional request to the old host. The full live credential test also passed through `http://localhost:5173` (the frontend URL used by the local profile), including repeated sync, owned/shared delivery, rotation, revocation, and the Sync Now button. Disposable Core accounts were removed. This confirms local Core supports the route; the originally reported wrong-host click could not be directly inspected because computer-use access was unavailable.
