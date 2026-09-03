# Agent workshop — orchestrator instructions

You are working in the root of an agent workshop. Read this file at the start of
every session here, then read `.cinna-kit/README.md` for the document index and the
capability ladder.

## Folder model

```
.
├── AGENTS.md      # this file
├── CLAUDE.md      # points here
├── .cinna-kit/    # the kit: contract, guides, templates, tools (never edit by hand)
├── Local/         # one folder per agent — the agents you build
└── Cloud/         # empty until the user goes cloud (see below)
```

List what exists:

```bash
uv run .cinna-kit/tools/kit.py list
```

## Your three roles

| Role | Where | What you do |
|------|-------|-------------|
| **Orchestrator** | here, at the root | Create, list, compare and coordinate agents. |
| **Builder** | inside `Local/<slug>` | Change an agent: scripts, prompts, config, manifest. |
| **Agent** | inside `Local/<slug>` | Act *as* the agent, following its `docs/WORKFLOW_PROMPT.md`. |

Switching rules:

- The user names a task the agent performs → **Agent**.
- The user asks to change / add / fix / extend → **Builder**.
- The user talks about several agents, or about which agent should do what → **Orchestrator**.
- Each agent folder has its own `AGENTS.md`; inside `Local/<slug>`, that file wins
  over this one.

Say which role you switched into, in one line, before you start.

## Commands

All kit commands run through `uv` (`uv run …`); it provisions Python 3.10+ by
itself, so never substitute the system `python3`. If `uv --version` fails, follow
START.md step 4 to install it before anything else.

| Command | Use |
|---------|-----|
| `uv run .cinna-kit/tools/kit.py new <slug> [--name "Display Name"]` | Scaffold a new agent in `Local/<slug>/`. |
| `uv run .cinna-kit/tools/kit.py validate Local/<slug>` | Check the agent is coherent and cloud-ready. |
| `uv run .cinna-kit/tools/kit.py list` | Table of agents, rungs present, cloud state. |
| `uv run .cinna-kit/tools/kit.py refresh [--check]` | Update the kit from the platform. |
| `uv run .cinna-kit/tools/kit.py export Local/<slug> --to <dir>` | Produce the cloud-import tree without the CLI. |
| `uv run .cinna-kit/tools/kit.py chat Local/<slug> "<prompt>"` | Send a prompt to the agent through the connected desktop and print the answer. |

Never create an agent folder by hand — the scaffold carries the cloud-compatible
layout, and a hand-made folder will fail `validate` later.

## If this workshop is managed by Cinna Desktop

Cinna Desktop keeps its agents in a workshop exactly like this one, and creates
them from the app. When you see `app-data/desktop.json` inside an agent folder,
you are in one:

- **Agents may appear without you.** A folder can be created from the app between
  two of your sessions. Re-read `cinna-agent.json` before assuming what exists.
- **`app-data/desktop.json` is read-only to you.** It is the desktop's own
  per-machine state — local API address, agent token, session ids, granted
  permissions. Never edit it, never commit it, never print its contents.
- **Test through the real runtime instead of role-playing.** With the marker file
  present, `uv run .cinna-kit/tools/kit.py chat Local/<slug> "<prompt>"` sends the
  prompt to the agent as the desktop runs it and prints the real answer. Run every
  example prompt through it before you call an agent finished.
- **A desktop-managed `.cinna-kit/` may carry the contract only** (schema,
  templates, `layout.json`), without the guides and `tools/`. If `kit.py` is not
  there, install the full kit before using the commands above; the contract in
  place is still the authority on the folder shape.

## Freshness

If `.cinna-kit/.last_refresh_check` is missing or older than 7 days, run
`uv run .cinna-kit/tools/kit.py refresh --check` before doing anything else.
It is offline-tolerant: on a network error it warns and you continue.
After any successful refresh, read `.cinna-kit/CHANGELOG.md`.

## Non-negotiables

- **Never print, echo or log a secret.** Read `credentials/.env` only from inside a
  script, never in the conversation.
- **Run the ladder check after every substantive change** (`.cinna-kit/README.md`)
  and report the result in one line.
- **Never add a ladder rung whose trigger has not fired.**
- **Keep `cinna-agent.json` in sync** with what the agent actually does.
- **Keep `scripts/README.md` in sync** with the scripts that exist.

## Cloud

`Cloud/` is empty until the user decides to move an agent to the platform. At that
point it gets one cinna-cli account workspace per instance, named by host
(`Cloud/acme.opencinna.io/`), each with its own `.cinna/account.json`, `CLAUDE.md`
and `context/` folder. **Inside `Cloud/`, that `CLAUDE.md` wins** — it is generated
by the CLI and describes the cloud workflow, not this one.

Read `.cinna-kit/guides/11-go-cloud.md` before touching anything in `Cloud/`.
