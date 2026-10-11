# The Antigravity Engine

## Purpose

Run kit and bare folder agents, plain chats and AI Functions on Google Antigravity's own ACP server, under the user's personal Google login. Cinna installs one pinned server for itself, verified before it is ever run. Antigravity owns the model, the login and the coding tools. Cinna supplies the instructions, controls the run, and shows output, approvals and questions through the shared ACP driver.

## Core Concepts

- **Antigravity engine** — `runtime.engine = antigravity`, the fourth ACP launcher beside OpenCode, Claude Code and Codex. It is not a new driver. Unlike Codex and Claude there is **no adapter**: the server (`agy_acp_server.par`) speaks ACP itself.
- **Managed server** — the pinned Antigravity build (1.3.0) Cinna downloads from Google's release path into `<userData>/runtimes/antigravity-<version>/`. It is one zip holding two files that must sit side by side: `agy_acp_server.par` and `localharness_external`. The zip is checked against a recorded SHA-256. That digest is the **only** proof of version, because Cinna never asks the server for one.
- **Antigravity Path** — an explicit `agy_acp_server.par` in **Settings → Local Development → Developer Tools**, with its `localharness_external` beside it. It replaces the managed copy and is run as-is: Cinna never asks it its version, so every surface labels it **unverified** with no version. There is no PATH form. Google ships no CLI for anyone to have installed, so nothing is detected and nothing on PATH is ever reused.
- **Antigravity home** — the directory the server keeps its settings, conversations, skills and MCP tool schemas in. It is selected by `GEMINI_HOME` and defaults to `~/.gemini`. Where a session's home is decides what that session can see. See [Homes](#which-home-a-session-runs-in).
- **Google login** — the personal Google sign-in (`oauth-personal`), saved by the server. On macOS it is one login-keychain item every home shares. On Linux it is a token file per home. Cinna never holds or reads the token.
- **Work complexity** — Simple, Medium or Complex selects Gemini 3.8 Flash at a low, medium or high thinking level. It never selects a Pro model. With no complexity the server's own default stands (Flash high). A model named on the agent wins over both.
- **Approvals** — a per-agent setting: **Ask for approval** (the server's `default` mode, every command and edit is an ask) or **Automatic** (`yolo`, nothing is asked). The default is Ask. Cinna configures **no sandbox** for Antigravity, so Automatic means unreviewed commands under the user's account.

## User Stories / Flows

### Select Antigravity and start a chat

1. Choose **Antigravity** as the machine default in Settings → Agents → Runtime, or in an agent's **Settings → Runs on**. It is always offered, because there is nothing for the user to install. It is **never chosen automatically**: a fresh installation's default still prefers an installed Claude, then Codex, then OpenCode. Only a setting or a manifest names Antigravity.
2. Log in. Where Antigravity is logged out, **Log in** appears in the Runtime status line, on the agent's "Runs with" panel, in the composer's readiness action and on the build page. A **(?)** beside it names Google's terms: Antigravity is Google's software with its own terms and telemetry, and logging in runs it on the user's Google account.
3. Pressing **Log in** downloads the server first if this machine has none. Cinna then starts the server in the user's own home and asks it to `authenticate` with the personal Google login. The server opens the browser and answers once the sign-in is done. The line reads what it is waiting for, with **Cancel** beside it. The login is then read again from where the server keeps it, and only that answer clears the alarm.
4. Optionally press **Install now** on the Runtime status line. The download is about 111–117 MB on macOS and about 322–334 MB on Linux.
5. Pick **Work complexity**. The Runs-with line names the model it resolves to, for example *Antigravity uses your Google login, on Gemini 3.8 Flash (medium).*
6. Send a message. Cinna installs the server if needed, then checks the login **fresh**. It prepares the home, opens or resumes the chat's session, applies the approval mode and model, and prompts.
7. Answer approvals and questions inline or from the Inbox. Use **Stop** to cancel. A cancel ends a model request or a running command within seconds, and the command's effect does not happen.

### Recover installation or login readiness

1. "Not installed" only ever means an install that **failed**: no pinned build for this platform, a download that did not finish, a digest that did not match, an archive missing `localharness_external`, a Linux machine with nothing that can unpack a zip, or an Antigravity Path that is not an executable file. **Try again** sits beside the sentence. A server that simply has not been fetched yet blocks nothing.
2. A definite logged-out verdict refuses the turn with *"Antigravity is not signed in to Google. Choose Log in above the message box or on the agent's Settings tab."*
3. An error from the server that means the login is gone (`-32000` *Authentication required*, or a `logged_out` / `onboarding_failed` reason) is shown as that same sentence instead of a start failure, and the login is read again.
4. Signing out is not offered. Cinna refuses to send `/logout`, before anything is planned or started, and says why: on macOS the server clears the one keychain token every Antigravity home shares, so it would sign the user out of every agent and of Antigravity itself. To sign out, the user does it in Antigravity.

### Continue after a restart

1. Each chat remembers its Antigravity session, and the next turn loads it. A loaded session keeps its mode but comes back on the server's default model, so the model is set again after every load.
2. The process is keyed by server path, folder and environment, not by model, mode or instructions. One warm server serves every chat of an agent, each in its own session.

## Business Rules

### Install

- **Every spawned session runs the pinned server or the Antigravity Path, and nothing else.** No PATH copy exists to consult. A configured path that is not an executable file is an error, never a silent fall back to the managed copy.
- **Versionless by design.** The server does answer `--version`, with its absl build information (one line is `Build label: <version>`), but it takes about 2.6 seconds. The pinned SHA-256 already proves the bytes are the pinned version, so a second check would add nothing but that wait. The resolver therefore never asks: a managed install reports the pinned version without spawning anything, and a configured path reports no version. The interface contract still watches the build label, so a pin whose bytes and label disagree fails there.
- **An install is both files.** The archive must contain `localharness_external` beside the server, or nothing is published. A published directory that has lost it counts as **not installed** and is replaced as a whole. Codex's companion is repaired in place instead, because it comes from its own archive; Antigravity's comes from the same zip, so re-installing is the only repair.
- **Linux unpacks zips without tar.** GNU tar reads no zip. On Linux a `.zip` goes to the first of `unzip`, `bsdtar` and `python3 -m zipfile` that exists. An unpacker that is missing is skipped. One that runs and fails is the answer. A machine with none of them is told to install `unzip`. Both files are made executable afterwards, because Python's unzip drops mode bits.
- **Windows has no pin row.** Cinna does not ship this engine there; an Antigravity Path is the only route, and nothing about it is verified.
- **Linux is pinned but not watched.** Its server is started with `--uid=` as the ACP registry lists it. The contract has only run on macOS, where `--uid=` is fatal and the server starts with no arguments.

### Login

- **The login is read where the server keeps it, never by starting the server.** A session started in a home that names a login but holds no token opens a browser sign-in by itself, per the server's source (not seen live; the contract only watched the no-`auth.type` case, which refuses quietly). So readiness reads the home's `antigravity-acp/settings.json` for an `auth.type`, plus the token: on macOS the keychain item's attributes only (no prompt, the secret never read), on Linux the token file's existence. The answer is a state only.
- **A turn asks fresh, and no answer refuses on macOS and Linux.** A sign-out in Antigravity a moment ago must not pass on a cached verdict, because the next `session/new` would open a browser in the middle of a chat. When the keychain or settings give no verdict, the turn is refused with *"Cinna could not check the Antigravity login…"*. Readiness and the panels keep the cached, lenient read.
- **There is no terminal form of the login.** Codex and Claude offer a copyable terminal command when an in-app login does not finish. Antigravity's login is an ACP exchange, so there is nothing to copy; Settings' Runtime row is where Log in lives.

### Which home a session runs in

| Session | Home | Why |
|---|---|---|
| Kit folder (isolated), and the local-development build session | `<folder>/.cinna/antigravity` | Keeps the user's `~/.gemini` skills and MCP servers out of a sealed session. It sits **inside** the folder on purpose: the server names the first entry of its sorted workspace list as the command working directory, and a home nested in the cwd sorts after the cwd, so commands run in the folder. Conversations live here, so a session loads only under the same home |
| Bare folder (native) | The user's own `~/.gemini` (or their `GEMINI_HOME`) | Runs like the user's own Antigravity: their skills and MCP servers are loaded |
| Chat mode and AI Function | `<process folder>.agyhome`, beside an empty, desktop-owned process folder under `<userData>` | These sessions have no shell, so the cwd quirk does not apply. They run in that empty folder, never in a chat folder |

- **An isolated home works with no login of its own.** Cinna writes a `settings.json` naming the personal Google login and a `.gitignore` of `*`, so the home never lands in the folder's repository. On macOS the shared keychain token is enough. On Linux the user's token file is copied in, mode 0600, whenever the user's copy is newer.
- **An isolated home is the one thing Cinna writes inside a kit folder besides `app-data/desktop.json`.** The server keeps a session's history in its home, and a home outside the folder would move the command working directory out of the folder. The `.gitignore` is what keeps it out of commits and publishes.
- **A native folder is told its own path.** The server's command directory there can be inside `~/.gemini` instead of the folder. The desktop context therefore names the absolute folder and tells the agent to `cd` into it before every command.

### Instructions

- **The instructions open the first prompt of a new session.** Antigravity has no system-prompt channel over ACP. It reads no `GEMINI.md`, `AGENTS.md` or rules file either. So a new session's first message starts with Cinna's instructions in an `<instructions>` block, and the server keeps them in that session's history.
- **A session is saved for the chat only once the server has taken that first prompt.** A loaded session is never sent the instructions again. Saving a session whose first prompt never arrived — Stop before the prompt, a setup failure, a logged-out refusal — would run every later turn of that chat with no instructions. The session is saved on the agent's first turn content or on the prompt's answer.
- **An edited prompt reaches new sessions only.** An existing chat keeps the instructions its session started with. Editing an agent's workflow does not replace the process either, because instructions are not part of the process key.
- **A bare folder's instructions file is always pasted in**, whichever of `AGENT.md`, `AGENTS.md` or `CLAUDE.md` it is, because Antigravity reads none of them.
- **Skills.** In an isolated home, the `cinna-tasks` skill is installed natively under `config/skills/` and copied again only when its contents change. A native folder's home is the user's own and is never written to, so its prompt points at the bundled `SKILL.md` by path. A kit agent's own skills are given by path in both modes.
- **AI Functions get their instructions on every call**, since every utility session is new.

### Models and approvals

- **Complexity maps to Flash, never Pro.** `simple → gemini-3.8-flash-low`, `medium → gemini-3.8-flash-medium`, `complex → gemini-3.8-flash-high`. A tier must not spend a Pro model on the user's behalf. The model is set through the session's `model` option after every new and every loaded session.
- **Ask for approval is the default, and chat runtimes always use it.** Folder agents follow their Approvals setting. Chat modes, AI Functions, chat conductors and build sessions always run in `default` mode. Neither mode is sandboxed by Cinna. The Approvals copy says so instead of promising one.
- **Grants are Antigravity's own.** Actions are stored as `antigravity:<kind>`, so another engine's grant never answers one. A command grant covers its exact command line **and** the directory it runs in. An edit grant must cover every path. Cinna answers a saved grant with a one-time allow and never picks the server's `allow_always`.
- **An approved edit runs under another id.** The server then ends the ask's own id as failed with *"Tool call was approved but never executed."* That update is dropped, so an approved edit shows one card, not a failed one beside the one that worked.
- **Questions arrive as permission asks.** The built-in `ask_question` raises a permission request whose id starts `interaction_`, whose title is the question and whose options are the answers. Cinna shows it as a single-choice question and answers with the chosen option. No answer, or an answer it did not offer, is sent as *cancelled*, which the server reads as the user declining.

### Cinna's tools and the chat-mode policy

- **Cinna's MCP tools are reached through meta-tools.** The server does not declare MCP tools one by one. The model reads a tool's schema file from the home, then calls `call_mcp_tool`. A tool attached mid-chat is callable on the next turn; the session's tool list is not fixed at creation.
- **A Cinna call is recognised in two shapes.** Under Ask it carries `_meta.mcp {server, tool}`, and it is Cinna's when the server is `cinna`. Under Automatic it is titled `Running <tool>` with a bare name and no server. Such a call counts as Cinna's only when it is not a shell call and Cinna's MCP server offered that name to this session. A bare name alone would claim another server's tool of the same name. A conducting session allows Cinna's calls without an ask, as on every engine ([permissions](permissions.md#a-session-conducting-a-chat-is-not-asked-about-cinnas-own-tools)).
- **An MCP tool's result never reaches the desktop.** The server sends the model's own one-line summary in its place. Cinna shows a completed MCP call with **no output**, because showing the summary would present the model's words as what the tool returned.
- **An isolated folder (a kit folder, or the build session) runs without the engine's scheduler, subagents and messaging.** Cinna owns those there, and a second system inside the engine would run work nobody can see from the desktop. Commands, file edits, search and questions remain.
- **A chat mode or AI Function keeps exactly one built-in: `view_file`.** Every other built-in is switched off by both halves of the server's tool filter. `view_file` stays because the model must read a Cinna tool's schema file before calling it, and without it would call Cinna's tools blind.
- **Known limit, accepted: a chat-mode conductor can read the other chats sharing its process.** Chat runtimes share one server per user, profile and mode, and that server's home holds the saved conversations of **every** chat sharing it. `view_file` can read the whole home. So a plain chat on Antigravity can, if asked, read the saved conversations of the user's other chats on the same mode. They are the same user's own chats. This was accepted rather than fixed; closing it would need a home per chat, which gives up the shared warm process.

### What the engine reports, and what it does not

- **No cost and no per-turn tokens.** A prompt answers with its stop reason alone. The context meter comes from the server's `usage_update {used, size}` after each model call. There is no cost from the server, and none is estimated: a Google account login has no per-token price to estimate from. There is no cache clock and no context breakdown. The selected model telemetry shows is the one Cinna set, not the server's default it opened the session on.
- **The login kind is read from the home.** A signed-in home reports a *Google account* subscription.
- **Session titles are ignored.** The server names sessions `Session <hex>`, which is never a chat's name, so Cinna's own titles apply.
- **No mid-turn steering.** The server does not advertise the steering extension, so a message sent during a turn is queued for the next one ([Pending Messages](../../chat/pending_messages/pending_messages.md)).
- **No requests of its own were seen.** Every model request in the contract was the conversation itself — no title, summary or token-count call.
- **Nothing drives a whole user flow yet.** The contract runs the real server against a fake endpoint. No Level 2 flow, E2E spec or billed live run covers Antigravity.

## Architecture Overview

Agent settings / chat → typed preload and IPC → runtime resolution / shared ACP driver → Antigravity launcher (login check, home preparation, first-prompt instructions) → Antigravity binary service (Antigravity Path, else the managed pinned server, installed on first use) → `agy_acp_server.par` with `localharness_external` → Google's model and the server's built-in tools.

Log in → engine login → the server, in the user's home → ACP `initialize` + `authenticate oauth-personal` → browser sign-in → the login read again from the home.

Approval or question → `session/request_permission` → shared pending request and Inbox → user answer → the same running turn.

## Integration Points

- [Technical Details](antigravity_engine_tech.md) — files, storage, IPC, configuration and evidence limits.
- [Antigravity Interface Contract](contracts/antigravity_interface.md) — generated index of every server interface relied on, each tested against the real pinned server.
- [The ACP Engine Contract](acp_contract.md) — the reasoning behind those observations.
- [The Local Engine](engine.md) — machine default, runtime precedence, binary resolution and prompt assembly.
- [The Codex Engine](codex_engine.md) — the sibling managed engine whose shape this one follows.
- [The Agent Turn](agent_turn.md) — process pooling, session save and load, and cancellation.
- [Local Agent Permissions](permissions.md) — standing grants and the conducting-session rule.
- [Bare Agents](bare_agents.md) — native versus isolated folders.
- [Chat Modes](../../chat/chat_modes/chat_modes.md) and [AI Functions](../../llm/ai_functions/ai_functions.md) — the restricted sessions above.
- [Session Telemetry](../session_telemetry/session_telemetry.md) — the context meter.
- [Runtime Pins](../../development/runtime_pins/runtime_pins_llm.md) — where the version lives and how it is moved.
- [Settings](../../ui/settings/settings.md) — the Runtime row, the Developer Tools row and the Antigravity Path.
