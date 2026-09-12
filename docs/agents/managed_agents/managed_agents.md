# Managed Agents (Claude)

## Purpose

Connect an existing Claude workspace agent and environment to a Cinna chat. Claude owns the remote execution; Cinna owns the conversation, permission decisions and continuity with that remote session.

## Core Concepts

- **Managed agent** — a locally configured agent row using the `managed` driver. This is distinct from a Cinna account-provisioned AI credential, which is also called managed elsewhere in Settings.
- **Credential** — an enabled Anthropic API credential already present in AI Credentials. A Claude CLI login cannot authenticate this service.
- **Session** — the remote conversation associated with one local chat and agent. Only a session whose saved state is ready and whose credential/configuration still matches may accept another turn.
- **Permission** — a remote tool action explicitly awaiting allow or deny. Its answer belongs to the original session and, where present, its child thread.

## User Stories / Flows

1. Open **Agents**, press **+**, and choose **Managed (Claude)**. No Agents Home folder is required.
2. Choose an API credential and press **Load workspace**. Select an existing agent and environment. **More options** exposes a local name, workspace ID and agent version; leaving version empty uses latest.
3. Press **Add agent**. Main verifies the selected remote resources before saving the local configuration; the new agent opens in chat. Failed loading or saving retains the dialog and entered values; the Load workspace control keeps its width while loading.
4. Send a message. The first turn creates a remote session; later ready turns reuse that exact session. The transcript shows authoritative message text and tool activity as they arrive.
5. Answer a permission in the transcript or Inbox with **Allow once** or **Deny**. Continuation waits for both the remote acknowledgment and local durable settlement.
6. Select an existing Managed sidebar entry to open its chat landing page. **Settings → Connection → Configure** opens configuration; **Start chat** returns to the preserved page draft. Saved agent/environment IDs appear immediately; loading the workspace verifies the available choices before Save becomes available. Saving a configuration revision makes previous session bindings incompatible; start a new chat for the changed configuration.
7. **More actions → Delete agent** confirms removal of the Desktop connection. Existing chats and the remote Claude agent/environment remain. Enabled direct connections have no Disable action; previously disabled connections can be enabled again.

## Business Rules

- Credentials stay in main. The form selects references, never a key or an arbitrary service URL. Readiness checks local credential/configuration availability; it does not prove remote account access. Discovery and save verify that access through the service.
- Permission answers are one-time decisions. **Always allow** is hidden, and main normalizes an old caller's Always request to once without creating a standing grant.
- A missing acknowledgment is uncertain, not permission to resend. Transcript and Inbox keep the error visible and disable further decisions across navigation and renderer reload. A newly opened live Managed permission stays disabled until main has checked its current acknowledgment state; a failed check keeps it disabled while polling retries. If remote acceptance succeeded but local settlement failed, retry only commits the same answer locally.
- Old history cannot complete the new turn. Cinna waits for the acknowledged new user message to be processed before accepting output or a root session ending. Child-thread idle events cannot end the parent turn.
- Stop sends at most one interrupt and waits for its processed marker followed by a root idle/terminated event, with a bounded drain. Partial output is retained. Without confirmation, the transcript says only local waiting stopped and the saved session becomes uncertain.
- A remote budget ending preserves partial text and records a budget pause. It is not task completion. Saved budget, inflight and uncertain checkpoints are revalidated against remote status and full history before another kickoff. Once the remote session is idle with completed work, the chat can continue. Pending work or a live budget pause still requires resolution in Claude.
- Changing the credential, active profile or agent configuration invalidates held work. A saved session is never silently rebound to a replacement credential or configuration. Routine account sync carrying the identical key preserves credential identity.
- This integration does not create remote agents/environments, configure budgets, attach files, inject desktop MCP tools, run local commands or expose a local working folder. It supports tool permissions, not custom-tool-result submission, questions, auth asks or elicitation. Thinking events show progress; preview text deltas and usage are not exposed as authoritative transcript output.

## Architecture Overview

Agents / chat / Inbox → typed preload IPC → Managed service and driver → Anthropic SDK sessions/events → shared run events and durable transcript/request settlement.

## Integration Points

- [Agent Drivers & Readiness](../drivers/drivers.md) owns capability dispatch.
- [Inbox](../../jobs/tasks/inbox.md) owns durable answer settlement and aggregate task state.
- [Turn Outcomes](../../chat/messaging/turn_completion.md) preserves budget and cancellation outcomes for execution owners.
- [Account Provisioning](../../llm/account_provisioning/account_provisioning.md) supplies account credentials through the existing provider mechanism.
- [Technical details](managed_agents_tech.md) describes the SDK boundary, private checkpoint and reconciliation rules.
