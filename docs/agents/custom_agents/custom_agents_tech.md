# Command-line Agents — Technical Details

## File Locations

- Main service: `src/main/services/customAgentService.ts`.
- Driver: `src/main/agents/drivers/acp/customLauncher.ts`, `src/main/agents/drivers/acp/acpRuntime.ts`, `src/main/agents/drivers/acp/acpDriver.ts`, `src/main/agents/drivers/acp/acpPool.ts`, `src/main/agents/drivers/acp/acpProcessPool.ts`, `src/main/agents/drivers/acp/acpConnection.ts`; registry `src/main/agents/drivers/index.ts`.
- State: `src/main/services/localAgents/desktopStateService.ts`, `src/main/db/agents.ts`; permissions use `src/shared/localAgentRequests.ts` and captured registration validation in `src/main/services/askDelivery.ts`.
- Contract/IPC: `src/shared/customAgents.ts`, `src/shared/agentDrivers.ts`, `src/main/ipc/agent_a2a.ipc.ts`, `src/preload/index.ts`.
- Renderer: `src/renderer/src/components/agents/CustomAgentModal.tsx`, `src/renderer/src/components/agents/local/LocalAgentsList.tsx`, `src/renderer/src/components/agents/local/NewLocalAgentModal.tsx`.

## Database Schema and Private State

- No new table. `agentRepo.createRuntime/updateRuntime` stores a locally owned agents row with driver acp and driver_config containing custom launcher, command array, required cwd, optional localCwd and a main-generated revision. Synced/folder rows cannot acquire custom management authority merely by carrying that config.
- The binding hashes active profile, owner, agent ID and identity containing source/driver/config/enabled. A revision change or disable/re-enable selects different state; an old captured runtime cannot write into it.
- `desktopStateService.externalRuntimeStatePath()` stores sessions and permissionGrants under the app's external-agents directory, in a runtime-prefixed filename hashed from owner/agent/binding. It does not construct a fake folder or write desktop state to the remote path.
- Session state is keyed by chat ID in this private file. Save writes the file atomically first, then the generic a2a_sessions context-ID mirror. These are not one transaction: a failed database mirror remains repairable from the bound file, while a failed file write must never create an unbound database session. Existing generic context without matching private session refuses reuse rather than migrating an old configuration silently.
- Grant patterns use the existing permissionGrantPatterns/isPermissionGranted rules. Remember and revoke patch only this binding's permissionGrants. Reconfiguration isolates old files; it does not claim to delete old remote sessions or revoke already executed actions.

## IPC Channels

Activation gates every handler; main resolves settings/profile ownership and parses configuration again. Exposed as window.api.customAgents.

| Channel | Input → output |
|---|---|
| `custom-agent:configuration` | local id → name, config, current binding's grants |
| `custom-agent:test` | optional local id, config → token, advertised name/version/authMethods |
| `custom-agent:save` | optional local id/name, config, testToken → local id |
| `custom-agent:revoke-grant` | local id, grant key → void |

Normal agent send/readiness and Inbox/transcript answer channels execute the shared ACP path.

## Services & Key Methods

- `customAgentService.test()` supersedes another probe for the same owner/profile/id-or-new scope, initializes one standalone connection and awaits disposal before issuing a receipt. It never calls authenticate, session/new, session/load or session/prompt. A100ms guard aborts a stale, deleted, replaced, profile-changed or busy probe; stale completion cannot issue a receipt or overwrite readiness.
- Receipts are private, memory-only, expire after10minutes and are capped at100. `save()` checks token, config digest, owner/profile/id, original row identity and turn lock; it consumes the token, rotates configuration revision, invalidates shared readiness and retires the prior process.
- The private readiness map is binding-keyed. Ordinary checks return its latest result or null and do not spawn. Explicit Test failures update the current saved binding to unreachable, with the same ownership/supersession checks as success. Testing an unsaved changed config does not rewrite the saved config's readiness.
- `runtime()` returns AcpRuntimeView with captured validate/readSession/saveSession/isGranted/rememberGrant closures. validate checks profile, current enabled owned row identity and, when supplied, chat ownership. Management reads/revocation can still address a disabled configuration; execution cannot.
- `readAcpRuntime()` in the registry chooses a locally owned external command or a freshly read folder. AcpRuntimeView carries each one's state authority. The driver plans with folder or custom context, preserving one shared turn implementation and per-agent lock.
- `createCustomLauncher()` validates the local process directory and builds the exact executable/argument vector, narrowed child environment and a process key covering owner/agent/binding/config/local cwd/environment. It does no spawning itself. Session configuration supplies no injected MCP servers, mode, model, prompt metadata or setup options; custom questions use elicitation.form while desktop fs/terminal support is not advertised.
- The shared process pool singleton lives in acpPool.ts so configuration lifecycle and driver dispatch retire the same processes. acquire accepts a startup AbortSignal, does not join an aborted start, and disposes a late connection before publishing it. Existing per-agent reuse, locks and idle reaping remain shared with folder agents.
- Stop/ceiling covers acquire/initialize, new/load session and applySetup. Canceled session load cannot fall through into a fresh session. Startup retirement closes the child; no prompt is sent after cancellation. During a prompt, session/cancel and the3second grace distinguish an acknowledged cancellation from local disposal. External grace expiry writes an honest remote-stop-unconfirmed notice. The normal20minute turn ceiling reports failure; user Stop reports taskState/stopReason canceled.
- The driver stores the captured runtime beside each parked request. respond validates it and writes any remembered grant before resolving once. The registration's synchronous validate callback is also checked by deliverAnswer before the ACP orphan fallback, and permission/question continuations validate after their park. This preserves grant/resolve/commit ordering while preventing stale external authority from using the folder fallback.

## Renderer Components

The Agents creation chooser offers Command-line agent independently of folder setup. LocalAgentsList groups external ACP rows by cwd capability and opens `ExternalAgentPage` in chat mode. Its Settings → Connection → Configure action opens `CustomAgentModal`; the row hover Start chat action opens the dashboard with the agent selected. The modal parses the JSON command, holds current test identity across command/cwd/localCwd and disables Save after a change. Request generations and mounted/profile guards ignore stale completions. Test output and errors use bounded reserved areas; failures retain entered values. Auth methods are informational. The shared page owns chat/settings switching and lifecycle actions; the configuration dialog owns tested edits and binding-specific permission revocation.

## Configuration and Security

- Stdio only; a supplied non-stdio transport is rejected. command has1–128 string elements, each at most8192characters without NUL, total JSON at most65536characters, with a nonblank executable. cwd/localCwd are bounded4096character absolute paths without NUL/newlines; only localCwd must be an existing directory on this machine. Display name is bounded200characters.
- ACP initialize timeout is30seconds; probes use the shared connection's process cleanup. Local process directory defaults to app.getPath(home); remote session cwd is always the explicit agent working directory.
- The local spawn receives command and args directly. A user-selected shell or SSH remote shell retains its own interpretation rules; Cinna does not quote/rewrite its remote command. A controlled wrapper must leave stdout for ACP JSON-RPC and write diagnostics to stderr.
- Child environment uses shellEnvForChild from `src/main/shell/env.ts`, including its established session-variable and process-sourced proxy/CA policy. SSH_AUTH_SOCK is preserved; arbitrary login-shell provider secrets are not copied. SSH_ASKPASS_REQUIRE is set to never. Existing CLI/SSH configuration and OS-user access remain available; environment narrowing is not a sandbox or a guarantee that a child cannot read credentials from disk.
- There is no password storage, custom env editor or automatic ACP authentication. Noninteractive SSH options and separately configured host keys/login belong to the user's command; Test proves only protocol initialization.

## Verification Boundary

`src/main/agents/drivers/acp/customLauncher.contract.test.ts` runs the shared driver/launcher/pool/connection and official SDK against a real child via an explicitly configured shell wrapper. It covers every common driver clause, literal argv, separate working directories, no auth/setup/injected tools, continuity, captured grants and silent startup cancellation. `src/main/services/customAgentService.test.ts` adds real SQLite/file/probe ownership, receipt, readiness and revocation checks. `e2e/specs/custom-acp-agent.spec.ts` drives the product with `e2e/fixtures/customAcpCommand.ts`; test existence is not a claim of completed built validation. These fixtures do not establish actual SSH or remote CLI interoperability.
