# Local Development — Account Build Sessions

## Purpose

Give a signed-in Cinna user one place to describe an agent and start building it with a local assistant. The desktop makes the target account, runtime and available instructions visible; the assistant uses cinna-cli to build, test and inspect current Cinna Core state.

## Core Concepts

| Term | Meaning |
|---|---|
| **Build session** | A normal direct chat with an internal local builder, working in the CLI-provisioned account workspace |
| **Builder** | A reusable desktop agent bound to one profile, account workspace and engine. It is the assistant doing the development, not the remote agent being built |
| **Build readiness** | Ready account workspace with JSON CLI support, plus a resolved runtime and its prerequisites. A ready toolchain alone cannot establish that the selected assistant can run |
| **Local Development Runtime** | Installation-wide build settings, separate from local-agent settings. Default Runtime inherits the machine's local-agent engine; an explicit choice overrides it for building |
| **Build guide** | A read-only modal containing getting-started advice, the session briefing and available public Markdown documents loaded from the account workspace |

## User Stories / Flows

### From the footer to the first message

1. Click the Local Development footer icon. It is present during installation, when setup needs attention, and when ready. The ready label is **Local development is ready — start building**. Every click opens the build page in chat mode; opening it sends no prompt and creates no cloud agent.
2. The header reads **Agents Development on domain**. The instance link and account name/email share a row and wrap on narrow windows. Link text removes the HTTP(S) protocol and trailing slashes, retaining any path; clicking opens the original full URL in the default browser. Runtime/model badges identify the assistant, for example **Claude Agent with subscription** and **opus**.
3. If setup or runtime checks are pending, the page explains the work and displays the available setup checklist. Installation may continue after leaving the page. Once prerequisites pass, the composer appears and receives focus without another footer click.
4. Describe the intended agent under **What would you like to build?**. The heading, explanation, input, send controls and suggested prompts form a vertically centered section below the header, with scrolling in short windows. **Start building** sits below the input without a standing keyboard-helper line; Enter sends, Shift + Enter inserts a newline, and composition input is respected.
5. A suggested prompt only fills the draft. Sending prepares the internal builder and opens a direct chat without inheriting the general new-chat page's chat mode or MCP selections. The normal chat then owns streaming, questions, approvals and subsequent messages.

### Fixing a prerequisite

1. Healthy composers show no connection-success panel or empty warning space. A genuine workspace/runtime problem appears in a warning panel above the input, with the full reason and recovery actions; unresolved prerequisites disable sending and suggested prompts.
2. **Retry setup** repairs a workspace in an attention state. Missing Claude/Codex can open the existing install dialog. Runtime or Local Development settings take the user to the relevant remedy; a legacy CLI requires tooling with JSON workspace support.
3. Fix the prerequisite and use **Check again**. A failed preparation leaves the page and draft intact. Readiness warnings in existing chats use the same panel above their input, including Check again or Cinna re-authentication where applicable.

### Inspecting the guide and choosing the assistant

1. **Build guide** is closed by default. Open it to see a left-hand table of contents and the selected rendered Markdown document in the main pane. Getting started is always available; Session instructions and workspace documents appear when a context snapshot exists.
2. The guide exposes the actual available `CLAUDE.md`, `context/README.md` and `context/platform/README.md` included in the assistant's briefing. It is not an editor or a recursive workspace browser. Missing/unreadable documents are omitted, not invented; the assistant can consult installed CLI help and further context during work.
3. Close, Escape or clicking the backdrop dismisses the modal and restores focus to its trigger. The guide does not reopen on arriving output or while typing.
4. **Settings**, to the left of Build guide, opens build details. **Local Development Runtime** offers **Default Runtime**, **Claude Agent**, **Codex** and **Custom OpenCode**. Custom OpenCode additionally offers a build-specific AI credential or Default credential. The same page names the account workspace and CLI version and offers Open workspace and Local Development setup.
5. **Work complexity**, below the runtime cards, has a label/help control on the left and a dropdown on the right. It defaults to **Complex**, including when the engine is inherited. **Start chat** returns to the same draft.

### Resuming after restart

1. Open the previous build conversation. Runtime readiness waits for any idle/installing account restoration instead of treating an unfinished startup check as a broken setup.
2. OpenCode also loads its model catalogue before resolving the build model; an empty process cache after restart is not proof that the credential lacks a suitable model.
3. A settled setup failure remains actionable. Probes do not continuously restart failed setup. A changed profile, workspace or effective engine refuses the saved builder with an instruction to start a new build session.
4. Stop remains responsive while runtime restoration or launch planning is pending. Shared preparation may finish for other callers, but its late result cannot launch the canceled turn.

## Business Rules

### Engine inheritance is separate from build complexity

| Setting | Default | Rule |
|---|---|---|
| Runtime | Default Runtime | Follows Settings → Default → Agents → Runtime. Selecting an explicit build engine does not rewrite that default |
| OpenCode credential | Default credential | Uses normal runtime credential resolution. A build credential override applies only to explicit Custom OpenCode; a missing chosen credential blocks rather than silently spending another credential |
| Work complexity | Complex | Independent build choice, even with Default Runtime. Does not edit a local agent's manifest or desktop state |

| Complexity | Claude model alias | Codex reasoning effort | OpenCode |
|---|---|---|---|
| Simple | haiku | low | Resolve Simple against the chosen credential's catalogue |
| Medium | sonnet | medium | Resolve Medium against that catalogue |
| Complex | opus | high | Resolve Complex against that catalogue |

Codex keeps its CLI default model. Claude/Codex retain their CLI authentication and the existing runtime approval mechanisms; selecting a build engine does not sign in for the user. OpenCode follows the shared model-tier resolution and refusal rules rather than a build-specific table of model IDs.

### The account shown is the account used

- Preparation compares the displayed profile, instance, workspace, runtime, credential, model and complexity against main's current context, then checks again across asynchronous execution-context preparation. A stale screen must not silently send to another account or runtime.
- Builder reuse requires an enabled row with the same profile, workspace and engine. Chats remain separate even when they share that builder. Builder rows are stored with local runtime agents but listed only for their owning active profile.
- Saved rows bind **profile/workspace/engine**, not a permanent snapshot of credential/model/complexity. Those choices resolve again on later runtime reads. Switching the engine requires a new compatible build session; returning to a matching engine can reuse its builder.
- A builder's Local connection tooltip identifies its saved engine as Claude Code, Codex or OpenCode, with ACP · stdio, This computer and Local Development. Missing/invalid engine metadata reads Not recorded instead of guessing today's default. The tooltip needs no private configuration lookup.
- Internal builders open Local Development settings rather than the generic command configuration editor. Generic configuration, Test and Save refuse a builder ID, so the placeholder command cannot replace its managed launch behavior.
- Leaving the entry page or changing accounts during first-chat preparation cannot select or send the late chat. An empty chat is soft-deleted on best effort only while the originating account remains active; successful same-account cleanup refreshes both Chats and Trash. Cleanup after an account switch is deliberately skipped because deletion is scoped to the currently active account.
- Drafts are isolated by profile and survive page/settings navigation for the renderer's lifetime. Returning to the active, ready composer restores the caret to the end and shows its last line, so continued typing appends to the draft. They are not saved across app restart. Typing neither rereads readiness nor reparses the guide.

### A local conversation is not proof of a remote build

- Opening the page and preparing the builder create no cloud agent, sync session or workspace document. The first message asks the assistant to begin; subsequent CLI/tool calls perform the work under the runtime's approval policy and Cinna's own access controls.
- Instructions identify the instance/account and working directory, ask the assistant to inspect available agents and CLI help, and require fresh remote-status checks before reporting creation/update/readiness. The desktop does not implement a second cloud-agent creation API or a background remote-status monitor here.
- Compact Cinna CLI dots describe transcript presentation status, not remote verification. A saved command can have a green/done dot with no recorded result; expanding it says **No output recorded.** A stderr result remains visibly distinct. See [Conversation UI](../../chat/conversation_ui/conversation_ui.md).

## Architecture Overview

Footer → build page → typed session-context/preparation IPC → active-profile workspace and runtime resolution → internal ACP builder → normal direct chat → Claude/Codex/OpenCode tools → cinna-cli → Cinna Core.

Build guide ← the same public workspace documents and session briefing assembled by main for that runtime.

## Integration Points

- [Local Development](local_dev.md) owns installation, account setup, consent, repair and CLI execution context; [technical details](build_sessions_tech.md) describe builder storage and lifecycle guards.
- [The Local Engine](../local_agents/engine.md), [Claude](../local_agents/claude_engine.md) and [Codex](../local_agents/codex_engine.md) own model resolution, binary/login behavior and runtime launchers.
- [Agent Drivers & Readiness](../drivers/drivers.md) owns turn execution, cancellation and composer refusals; [Command-line Agents](../custom_agents/custom_agents.md) supplies the private session/grant storage reused internally.
- [Chat Routing](../../chat/chat_routing/chat_routing.md) owns direct chat creation; [Conversation UI](../../chat/conversation_ui/conversation_ui.md) owns compact CLI rendering and generic console formatting.
- [Appearance](../../ui/appearance/appearance.md) — Shared preference for entry-composer grid/border bursts and secondary action glows; actual input interaction fades its artwork, while autofocus alone permits idle decoration.
- [Settings](../../ui/settings/settings.md) distinguishes machine defaults, build-specific settings and active-account setup.

## Validation and limits

- Focused service/component tests cover guide exposure, context changes, builder reuse, restoration/model warmup, cancel-safe preflight, guarded chat creation/cleanup, settings persistence and console rendering. Typechecks and production build verify integration; they do not prove a real remote build completed.
- The optional real-server integration spec contains entry-page/guide/settings assertions after CLI setup. No full E2E suite or live assistant-to-Cinna build round trip was run for this change.
- Profiles on the same host still share the CLI workspace location and setup consent. CLI identity checks remain authoritative; separate per-account directories are outside this feature.
