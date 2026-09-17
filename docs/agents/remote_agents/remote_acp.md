# Remote ACP agents

Connect Cinna Desktop directly to a Cinna-core ACP connector or another ACP WebSocket server. No local agent executable or Agents Home is required.

## Connect to Cinna-core

1. In Cinna-core, create or open the agent's **ACP connector** and issue an ACP token. Copy its WebSocket endpoint, such as `wss://api.example.com/acp/{connector_id}`.
2. In Desktop, open **Agents → + → Advanced options → Remote ACP agent** in **Add an agent**.
3. Paste the **ACP endpoint** and **Access token** separately. Keep **Remote working directory** at `/app/workspace` for Cinna-core. Other servers can use a different absolute server-side path.
4. Press **Test**. Desktop opens a connection, sends `initialize`, displays the advertised name/version, then closes the connection. Testing creates no remote session and sends no prompt.
5. Press **Add agent**, then send a message. Text, thought and tool updates stream into the conversation; ACP permission and form-question requests use the existing reply widgets. **Stop** sends `session/cancel`.

Select the entry under **Agents → ACP agents** to open its chat landing page. Use **Settings → Connection → Configure** to edit the connection; **Start chat** returns to the preserved draft. The password field never receives the stored token: leave it unchanged to retain it, enter a replacement, or choose **Clear saved token**. Changing the endpoint requires explicitly entering or clearing the token, so a saved credential is not silently forwarded to another endpoint. Test the resulting configuration before saving. The header **More actions → Delete agent** confirms removal of the Desktop connection while preserving chats and the server workspace. Enabled direct connections have no Disable action; previously disabled ones retain an Enable action.

These agents are manually managed in the default/settings scope, like manually added A2A agents. They are not part of the Cinna account's automatic A2A synchronization and use the ACP connector token, not the account JWT. Session and permission state is additionally bound to the active profile and configuration revision. Changing a saved configuration requires a new chat instead of reusing the former token's sessions or permissions.

## Protocol profile

The implementation speaks ACP v1 with the official TypeScript SDK, using one UTF-8 JSON-RPC object per WebSocket text frame. Authentication uses `Authorization: Bearer ...` during the native WebSocket upgrade. Use `wss://`; `ws://` is accepted for loopback development (`localhost`, `127.0.0.1`, `[::1]`). Credentials, queries and fragments are rejected in endpoint URLs. HTTP/SSE endpoints and Socket.IO endpoints are not supported by this connection form.

ACP allows custom bidirectional transports, while Streamable HTTP is still a draft in the [ACP v1 transport specification](https://agentclientprotocol.com/protocol/v1/transports). WebSocket is an experimental remote profile in the [Python SDK](https://agentclientprotocol.github.io/python-sdk/web-transport/), matching Cinna-core's implementation; it is not a claim that every ACP server exposes a WebSocket endpoint. Existing stdio/SSH agents remain available through **Command-line agent**.

Desktop advertises form elicitation, without client filesystem or terminal capabilities. It sends no client MCP servers, local directories, or file attachments to remote sessions. Cinna-core's hosted profile accepts text prompts and requires `/app/workspace`; the server owns its tools, models, and environment.

A live connection reuses the same session. After the idle connection closes or the app restarts, Desktop uses `session/load` when the server advertises it and suppresses replayed history in the current reply. A refused load is surfaced, without silently starting another conversation. A server without `loadSession` supports continuity while connected and requires a new chat after disconnecting. An accepted follow-up message reactivates its completed, failed, or cancelled local chat task, so subsequent permission requests remain answerable. This does not reopen jobs, remotely bound tasks, archived tasks, or tasks running on another device; ordinary stale run events cannot reopen a terminal task. Prompts are never retried automatically after a disconnect, since the server may already have executed them. Partial output is retained.

## Implementation and verification

- `src/shared/customAgents.ts`: validated stdio/WebSocket configuration union; endpoint and token validation.
- `src/main/services/customAgentService.ts`: main-process initialize-only probes, expiring exact-configuration/credential test receipts, encrypted-token persistence through the existing keystore, and profile/revision-bound sessions and grants.
- `src/main/agents/drivers/acp/customLauncher.ts`: WebSocket connection plans; remote plans do not read shell environment, inspect local directories, or spawn processes.
- `src/main/agents/drivers/acp/acpWebSocketConnection.ts`: authenticated native WebSocket streams, bounded startup/send waits, framing checks and disposal. Limits: 256 KiB outgoing frame, 1 MiB incoming frame, 8 MiB incoming queue, 15-second send wait, 30-second initialization wait.
- `src/main/agents/drivers/acp/acpClient.ts`: shared SDK request and notification routing for stdio and WebSocket, including traffic received before session handlers bind.
- Existing ACP driver/pool: streaming translation, session reuse/load, permissions/questions, cancellation, idle cleanup, account/configuration lifetime.
- `CustomAgentModal`, `NewLocalAgentModal`, `ExternalAgentPage`: add/test/edit and agent-page entry points. `RemoteAcpAgentCard` remains in the source but is not the routed Settings surface. The agent DTO exposes only `acpTransport` and `hasAccessToken`, never the token or private configuration.

The repository tests use a real loopback WebSocket server whose contract mirrors Cinna-core's `/acp/{connector_id}` dispatcher: bearer authentication, `initialize`, hosted cwd/no-MCP rules, UUID session IDs, replay, text updates and cancel notifications. They cover credential replacement/clearing, stale binding isolation, peer errors, malformed traffic, partial disconnects, permission replies and session continuity. The Electron end-to-end test creates an agent through the UI, tests wrong/correct tokens, checks credential redaction, and completes two permission-bearing turns in the same remote session. No live Cinna-core account or model is needed for these tests.

```sh
npx vitest run src/shared/customAgents.test.ts src/main/services/customAgentService.test.ts src/main/agents/drivers/acp/acpWebSocketConnection.test.ts src/main/agents/drivers/acp/remoteAcpDriver.test.ts
npm run build
npx playwright test -c e2e/playwright.config.ts e2e/specs/remote-acp-agent.spec.ts
```
