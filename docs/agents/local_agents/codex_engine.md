# The Codex Engine

## Purpose

Run kit and bare folder agents inside Cinna's chat UI using the user's installed Codex CLI. Codex owns the login and coding tools; Cinna supplies the folder instructions, controls the run, and presents streaming output, approvals and questions through the shared ACP driver.

## Core Concepts

- **Codex engine** — `runtime.engine = codex`, an ACP launcher rather than a new driver or a Managed agent. It can be an agent's own choice or this machine's Default runtime.
- **CLI login** — the authentication saved by Codex, including a ChatGPT login or a saved API-key login. Cinna holds no Codex credential and does not infer a subscription from a successful login check.
- **CLI profile** — Codex's normal user/project configuration and saved state, selected by `CODEX_HOME` when set. User/project instructions, skills and MCP configuration remain Codex's responsibility.
- **Work complexity** — Simple, Medium or Complex selects low, medium or high reasoning effort. No choice means medium effort. The model stays Codex's configured default unless the agent explicitly names one.
- **Approvals** — a separate per-agent Codex setting: Ask for approval by default, or Automatic. Both retain Codex's workspace-write sandbox; the setting chooses who reviews escalation requests.

## User Stories / Flows

### Select Codex and start a chat

1. Install Codex through **Settings → Agents → Runtime**, or use an existing installation on the login-shell PATH. Run `codex login` in a terminal; Cinna does not perform the login.
2. Select **Codex** as the machine default, or choose it in the agent's **Settings → Runs on** selector. An installed CLI is offered; an explicitly selected but missing CLI remains visible with an installation remedy.
3. Pick **Work complexity**. Changing to Codex clears the previous desktop credential/model and preserves the complexity, so a model from another runtime is not silently sent to Codex.
4. Send a message. Cinna checks the folder and CLI readiness, assembles the instructions, opens or resumes the chat's Codex session and applies the approval mode before prompting.
5. Read text, tool results and plans in the normal chat. Answer any approval or question inline or through the shared Inbox request surface. A question's Other answer returns to the original Codex question, without a second companion-field widget.
6. Use **Stop** to cancel. Cinna settles pending asks and bounds the cancellation wait; a process that will not stop is retired by the shared driver.

### Recover installation or login readiness

1. A missing executable offers the Runtime installation remedy. A definite logged-out verdict asks for `codex login`.
2. After installing or logging in, use **Check again** to refresh readiness; Runtime tool refresh also refreshes the login verdict. A new directory added to the shell PATH, or a changed shell `CODEX_HOME`, requires an app restart because shell environment resolution is cached for the process lifetime.
3. An inconclusive login probe permits a turn. The actual startup can then return its error; an unfamiliar CLI status message must not permanently strand a working installation.

### Continue after a restart or a settings change

1. Each chat remembers its engine session through the existing desktop and SQLite stores. A resumed session suppresses replay so prior output does not become a second copy of the next answer.
2. The next turn re-reads the folder and prepares current instructions and runtime settings. A changed launch specification replaces that agent's pooled process, then loads the remembered session with current configuration.
3. If the local engine cannot load its remembered session, the shared driver creates a new session. Existing Cinna transcript messages remain visible; they are not automatically replayed as replacement model history.

## Business Rules

- **The declared engine wins.** With no recognized engine, a declared credential or model retains the OpenCode path; otherwise the agent follows the machine default. On the first successful default-settling pass, an existing selection is preserved; an installation already holding folder agents keeps OpenCode; a fresh installation prefers an installed Claude, then Codex, then OpenCode. Detection chooses installation, not login readiness. The result is saved once, so installing another CLI later cannot silently change billing or permissions.
- **No desktop credential on the Codex path.** Reading a manifest with both Codex and a credential ignores the credential and warns; Cinna refuses to write that combination. CLI readiness does not depend on the desktop provider catalogue or its credential enablement.
- **An explicit model is respected.** There is no desktop model catalogue or Advanced picker for Codex. A model can be declared in the runtime data; otherwise the CLI selects its default. Unsupported model/effort combinations are errors from Codex, not an invitation for Cinna to substitute a different model. The shared writer refuses model plus complexity together; tolerant reads still pass a declared model and derive effort from any recognized complexity.
- **The folder prompt supplements Codex.** Kit prompt assembly and bare `AGENT.md` assembly feed developer instructions; Codex retains its own core instructions and normal configuration. Cinna does not apply Claude's settings isolation to Codex, and an empty injected MCP list does not promise that Codex has no configured MCP servers.
- **Ask for approval means escalation approval.** Workspace writes can proceed without a request; network access and filesystem operations outside the sandbox's allowed roots require escalation. Codex's normal temporary-directory allowances remain. Cinna does not promise a request before every edit or every external-file read.
- **Automatic uses Codex's reviewer in the same sandbox.** It is independent of Claude's setting and default. Cinna never selects full access, and a mode-setting failure refuses the turn before prompting. Grants can only answer requests the CLI actually forwards to Cinna.
- **Remembered grants belong to the agent and engine.** `codex:` action names prevent grants from another engine authorizing a Codex request. Command identity includes the complete request scope, including SOCKS host/protocol information that the adapter carries outside its raw input. Every patch path must be covered. Cinna sends only a one-time allow even when applying a saved grant, so it does not write the CLI's own persistent approval rules.
- **Authentication stays with the CLI.** The narrowed child environment preserves the selected profile and tool PATH but excludes shell billing keys and adapter overrides. This is environment narrowing, not isolation from Codex's own readable configuration or saved login.
- **A mid-turn message can start a turn nobody reads, so that turn is cancelled.** The adapter advertises the steering extension, so a message sent to a running Codex agent is offered to its turn. When that turn has already ended underneath, the adapter ignores the request to start nothing and starts a turn of its own. The desktop cancels it, retires the process unless another turn already holds it, and queues the message for the next turn. A steer sent before Codex has registered the turn it was just prompted with gets the same answer, only after that whole turn is over, so the desktop offers a message only once the turn has streamed its first content. Like every engine that steers, Codex is offered a message only while no tool call is running; a message sent during a command is queued and handed in when the command ends. The rule came from Claude, whose CLI aborts a running command for a steer; whether Codex would is not known, and waiting costs it only the wait. See [Pending Messages](../../chat/pending_messages/pending_messages.md) and [the ACP contract](acp_contract.md#the-steering-extension).

## Architecture Overview

Agent settings / chat → typed preload and IPC → runtime resolution / shared ACP driver → Codex launcher → Electron Node running the pinned ACP adapter → user's Codex app server → CLI-owned model and tools.

Approval / question → ACP request → shared pending request and Inbox → user answer → ACP response → the same running Codex turn.

## Integration Points

- [Technical Details](codex_engine_tech.md) — files, storage, IPC, packaging, configuration and evidence boundaries.
- [The Local Engine](engine.md) — machine default, runtime precedence and folder prompt assembly.
- [The Agent Turn](agent_turn.md) — process pooling, sessions, replay suppression, cancellation and request lifetime.
- [The ACP Engine Contract](acp_contract.md) — measured adapter behavior and what still needs a real CLI/model validation.
- [Local Agent Permissions](permissions.md) — standing grants, answer persistence and revocation.
- [Agent Drivers & Readiness](../drivers/drivers.md) — capabilities and pre-send readiness.
- [Bare Agents](bare_agents.md) — the same engine choice with desktop state outside the adopted folder.
- [The Claude Engine](claude_engine.md) — sibling CLI launcher with different configuration and approval semantics.
