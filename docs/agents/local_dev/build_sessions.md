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
2. An attention state offers up to three actions, ordered by what ends it. **Reconnect workspace** appears only for `account_mismatch` and leads in the accent: it renames the workspace belonging to the other account aside and sets this one up fresh — see [Reconnect](local_dev.md#reconnect). **Re-authenticate** appears for `account_mismatch` and `token_expired` and runs the ordinary OAuth round trip without leaving the page. **Retry setup** is always last and repairs setup in any attention state; a capability-probe failure is toolchain attention and Repair reinstalls the tools. Only the pressed action shows a spinner, on its own icon rather than in a changed label, and none of them disables behind a running re-authentication. A missing Claude can open the existing install dialog. A logged-out Claude Code or Codex offers **Log in to Claude Code** / **Log in to Codex** in the same place, which runs the engine's own login on the binary the build session uses — usually Cinna's managed copy, not on the PATH — so the login lands where the session looks. While it runs, **Cancel** appears at the end of the action row and the phase (*Getting … ready…*, then *Waiting for sign-in in your browser…*) shows below the row, never inside it, so no button moves under the user's click; a sign-in that did not finish is reported below the row with the terminal command and **Copy**. When the login ends the page re-reads its context and the blocker clears on its own. Codex and OpenCode never offer Install: Cinna fetches both itself, so offering to install a PATH copy would install a tool no session uses, and a failed managed download is retried in Settings → Agents → Runtime. A legacy CLI blocker names **Cinna CLI 0.4.0 or later**, the installed version and **Default → Local Development**, where the managed CLI can be updated to the connected server's advertised version. If that pin is still older, the server administrator must update it. Runtime blockers open the build runtime details; account setup remains under Profile.
   A reason that is only a raw network failure — `net::ERR_CONNECTION_REFUSED`, `connect ECONNREFUSED 127.0.0.1:8000`, `fetch failed` — reads as a sentence such as *Network error occurred. Connection refused.*, with the original text behind **Show details**; a lead main put in front (*Could not install Mutagen: …*) stays in the sentence so the user still sees what failed. The page's error line does the same. Main passes the error message through unchanged, and a user handed a Chromium error code cannot tell a server that is down from a broken install. Only error codes are matched, so a reason someone wrote as prose is shown exactly as written. Settings → Profile → Local Development shows its attention detail and error the same way; chat warnings still show the raw text.
3. Fix the prerequisite and use **Check again** on the build page or its runtime details. It rereads the managed executable and its help capabilities before checking the selected runtime; refreshing a cached build context alone would preserve a stale legacy result. It installs nothing and changes no consent. The disabled **Checking…** control spins while the request runs, with at least 600 ms of feedback for an immediate result. Errors retain the page and draft; success clears resolved blockers. Readiness warnings in existing chats use the same warning panel above their input, including their own Check again or Cinna re-authentication actions where applicable. A saved build chat's **Check again** also rereads the managed CLI capabilities when its owning account is active and the workspace is ready; a stale legacy result must not survive an explicit check merely because the conversation already exists.

### Inspecting the guide and choosing the assistant

1. **Build guide** is closed by default. Open it to see a left-hand table of contents and the selected rendered Markdown document in the main pane. Getting started is always available; Session instructions and workspace documents appear when a context snapshot exists.
2. The guide exposes the actual available `CLAUDE.md`, `context/README.md` and `context/platform/README.md` included in the assistant's briefing. It is not an editor or a recursive workspace browser. Missing/unreadable documents are omitted, not invented; the assistant can consult installed CLI help and further context during work.
3. Close, Escape or clicking the backdrop dismisses the modal and restores focus to its trigger. The guide does not reopen on arriving output or while typing.
4. **Settings**, to the left of Build guide, opens build details. **Local Development Runtime** offers **Default Runtime**, **Claude Agent**, **Codex**, **Antigravity** and **Custom OpenCode**. Custom OpenCode additionally offers a build-specific AI credential or Default credential. These are the same runtime cards as Settings → Agents, with the same behaviour: clicking a card only selects it, and the selected card carries its next step over itself — **Install**, **Retry**, **Log in**, or **Add credential** for Custom OpenCode with no active credential — or a green **Ready** dot when nothing is missing. The Default Runtime card carries none. One line under the cards says what a setup is doing (with **Cancel** while a login runs) or why it stopped, a failed install's reason, the download's progress, Google's Antigravity terms while Antigravity is selected and not ready, and otherwise what the choice means. See [the Agents tab](../local_agents/agents_tab.md) and [runtime setup](../local_agents/engine.md#runtime-setup-picking-a-runtime-gets-it-ready-but-only-a-button-downloads). The same page names the account workspace and CLI version and offers Open workspace and Local Development setup.
5. **Work complexity**, below the runtime cards, has a label/help control on the left and a dropdown on the right. It defaults to **Complex**, including when the engine is inherited. **Start chat** returns to the same draft.

### Resuming after restart

1. Open the previous build conversation. Runtime readiness waits for any idle/installing account restoration instead of treating an unfinished startup check as a broken setup.
2. OpenCode also loads its model catalogue before resolving the build model; an empty process cache after restart is not proof that the credential lacks a suitable model.
3. A settled setup failure remains actionable. Ordinary list reads and turns reuse the last successful capability snapshot; they do not repeatedly probe CLI help or restart failed setup. Explicit **Check again** in the saved chat refreshes capabilities after any startup restoration has reached ready. A failed check keeps its actual error, and switching accounts during it refuses the old result. A changed profile, workspace or effective engine refuses the saved builder with an instruction to start a new build session.
4. Stop remains responsive while runtime restoration or launch planning is pending. Shared preparation may finish for other callers, but its late result cannot launch the canceled turn.

## Business Rules

### Engine inheritance is separate from build complexity

| Setting | Default | Rule |
|---|---|---|
| Runtime | Default Runtime | Follows Settings → Default → Agents → Runtime. Selecting an explicit build engine does not rewrite that default |
| OpenCode credential | Default credential | Uses normal runtime credential resolution. A build credential override applies only to explicit Custom OpenCode; a missing chosen credential blocks rather than silently spending another credential |
| Work complexity | Complex | Independent build choice, even with Default Runtime. Does not edit a local agent's manifest or desktop state |

| Complexity | Claude model alias | Codex reasoning effort | Antigravity model | OpenCode |
|---|---|---|---|---|
| Simple | haiku | low | `gemini-3.8-flash-low` | Resolve Simple against the chosen credential's catalogue |
| Medium | sonnet | medium | `gemini-3.8-flash-medium` | Resolve Medium against that catalogue |
| Complex | opus | high | `gemini-3.8-flash-high` | Resolve Complex against that catalogue |

Codex keeps its CLI default model. Antigravity never runs a Pro model for a tier. Claude/Codex retain their CLI authentication and the existing runtime approval mechanisms; selecting a build engine downloads nothing and never logs in on a guess: selecting Claude, Codex or Antigravity when its binary is on disk asks the login again and starts it only on a definite *logged out*, which is what the user is about to need. Opening the page starts nothing.

**Antigravity as the build runtime.** It runs on the user's Google login. When that login is missing, the setup notice's action row offers **Log in**, with Google's terms behind a (?) beside it, as Codex and Claude offer theirs. A build session always runs in Antigravity's `default` mode, so every command and edit is an ask. The session's folder is the isolated account folder, so the server's home is `<account folder>/.cinna/antigravity` — outside the synced `workspace/` directory — and cinna-cli's sync ignores `.cinna/` as well, so the home never reaches Cinna Core. A `.gitignore` of `*` keeps it out of git. The server's scheduler and subagents are switched off there, as in any isolated folder. See [The Antigravity Engine](../local_agents/antigravity_engine.md#which-home-a-session-runs-in). OpenCode follows the shared model-tier resolution and refusal rules rather than a build-specific table of model IDs.

### The account shown is the account used

- Preparation compares the displayed profile, instance, workspace, runtime, credential, model and complexity against main's current context, then checks again across asynchronous execution-context preparation. A stale screen must not silently send to another account or runtime.
- Builder reuse requires an enabled row with the same profile, workspace and engine. Chats remain separate even when they share that builder. Builder rows are stored with local runtime agents but listed only for their owning active profile.
- Saved rows bind **profile/workspace/engine**, not a permanent snapshot of credential/model/complexity. Those choices resolve again on later runtime reads. Switching the engine requires a new compatible build session; returning to a matching engine can reuse its builder.
- A builder's Local connection tooltip identifies its saved engine as Claude Code, Codex, Antigravity or OpenCode, with ACP · stdio, This computer and Local Development. Missing/invalid engine metadata reads Not recorded instead of guessing today's default. The tooltip needs no private configuration lookup.
- Internal builders open Local Development settings rather than the generic command configuration editor. Generic configuration, Test and Save refuse a builder ID, so the placeholder command cannot replace its managed launch behavior.
- Leaving the entry page or changing accounts during first-chat preparation cannot select or send the late chat. An empty chat is soft-deleted on best effort only while the originating account remains active; successful same-account cleanup refreshes both Chats and Trash. Cleanup after an account switch is deliberately skipped because deletion is scoped to the currently active account.
- Drafts are isolated by profile and survive page/settings navigation for the renderer's lifetime. Returning to the active, ready composer restores the caret to the end and shows its last line, so continued typing appends to the draft. They are not saved across app restart. Typing neither rereads readiness nor reparses the guide.

### A local conversation is not proof of a remote build

- Opening the page and preparing the builder create no cloud agent, sync session or workspace document. The first message asks the assistant to begin; subsequent CLI/tool calls perform the work under the runtime's approval policy and Cinna's own access controls.
- Instructions identify the instance/account and working directory, ask the assistant to inspect available agents and CLI help, and require fresh remote-status checks before reporting creation/update/readiness. The desktop does not implement a second cloud-agent creation API or a background remote-status monitor here.
- Compact Cinna CLI dots describe transcript presentation status, not remote verification. A saved command can have a green/done dot with no recorded result; expanding it says **No output recorded.** A stderr result remains visibly distinct. See [Conversation UI](../../chat/conversation_ui/conversation_ui.md).

## Architecture Overview

Footer → build page → typed session-context/preparation IPC → active-profile workspace and runtime resolution → internal ACP builder → normal direct chat → Claude/Codex/Antigravity/OpenCode tools → cinna-cli → Cinna Core.

Build guide ← the same public workspace documents and session briefing assembled by main for that runtime.

## Integration Points

- [Local Development](local_dev.md) owns installation, account setup, consent, repair and CLI execution context; [technical details](build_sessions_tech.md) describe builder storage and lifecycle guards.
- [The Local Engine](../local_agents/engine.md), [Claude](../local_agents/claude_engine.md), [Codex](../local_agents/codex_engine.md) and [Antigravity](../local_agents/antigravity_engine.md) own model resolution, binary/login behavior and runtime launchers.
- [Agent Drivers & Readiness](../drivers/drivers.md) owns turn execution, cancellation and composer refusals; [Command-line Agents](../custom_agents/custom_agents.md) supplies the private session/grant storage reused internally.
- [Chat Routing](../../chat/chat_routing/chat_routing.md) owns direct chat creation; [Conversation UI](../../chat/conversation_ui/conversation_ui.md) owns compact CLI rendering and generic console formatting.
- [Appearance](../../ui/appearance/appearance.md) — Shared preference for entry-composer grid/border bursts and secondary action glows; actual input interaction fades its artwork, while autofocus alone permits idle decoration.
- [Settings](../../ui/settings/settings.md) distinguishes machine defaults, build-specific settings and active-account setup.

## Validation and limits

- Focused service/component tests cover guide exposure, context changes, builder reuse, restoration/model warmup, cancel-safe preflight, guarded chat creation/cleanup, settings persistence and console rendering. Typechecks and production build verify integration; they do not prove a real remote build completed.
- The optional real-server integration spec contains entry-page/guide/settings assertions after CLI setup. No full E2E suite or live assistant-to-Cinna build round trip was run for this change.
- Profiles on the same host still share the CLI workspace location and setup consent. CLI identity checks remain authoritative; separate per-account directories are outside this feature.
