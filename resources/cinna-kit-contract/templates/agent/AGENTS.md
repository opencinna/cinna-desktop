# {{NAME}}

{{DESCRIPTION}}

This file is for an assistant working **on** this agent. What the agent *does* is
in `docs/WORKFLOW_PROMPT.md` — the single source for its behaviour. Never
duplicate that here.

## Two roles in this folder

| Role | When | What you read |
|------|------|---------------|
| **Builder** | the user asks to change, add, fix or extend the agent | this file, then the kit guides |
| **Agent** | the user asks for the job the agent performs | `docs/WORKFLOW_PROMPT.md`, and nothing from the build session |

Say which role you are in, in one line, before you start.

## Layout

```
cinna-agent.json      identity and definitional metadata — keep it true
docs/                 the three prompts, the command catalog, one doc per local skill
scripts/              everything runnable, plus README.md cataloguing all of it
knowledge/            reference material the agent reads to be correct
config/               non-secret configuration the scripts read
credentials/          credential docs and the local .env — values, never printed
files/                static inputs that ship with the agent
app-data/             everything written at runtime; the only place to write
```

## The build loop

One cycle = one capability.

1. Write the smallest script that does one step. Print machine-readable output
   (JSON or CSV); write large results to `app-data/storage/`.
2. Run it: `uv run scripts/<x>.py`. It works before it is described anywhere.
3. Catalog it in `scripts/README.md`, in the same change.
4. Wire it into `docs/WORKFLOW_PROMPT.md`: which script, how to read its output,
   how to present it.
5. Re-read `cinna-agent.json` and make `description` and `example_prompts` true again.

Then validate:

```bash
uv run ../../.cinna-kit/tools/kit.py validate .
```

## Commands

`docs/CLI_COMMANDS.yaml` is the catalog a host reads to offer `/run:<name>`. It is
**cloud-first**: commands are written as the platform runs them
(`python scripts/x.py`, paths relative to the agent root). The `Makefile` mirrors
each one with `uv run` for local use — every command name there has a target here.
A host that reads the contract's `layout.json` applies the same rule itself.

To have a host refresh status before reading it, set `status_refresh_command` in
`cinna-agent.json` to `/run:status`.

## Non-negotiables

- **Never print, echo or log a secret.** `credentials/.env` is read only from
  inside a script, through `scripts/cinna_credentials.py`.
- **Write only under `app-data/`.** Everything else in this folder is the agent's
  definition, and is changed deliberately, not as a side effect of a run.
- **`app-data/desktop.json`, if present, belongs to Cinna Desktop.** Read-only.
- **Keep `scripts/README.md` and `cinna-agent.json` in sync** with what exists.
