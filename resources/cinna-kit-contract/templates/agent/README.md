# {{NAME}}

{{DESCRIPTION}}

## Try it

Example prompts live in `cinna-agent.json` and are shown wherever this agent is
offered. The agent's own instructions are in `docs/WORKFLOW_PROMPT.md`.

## Run its commands

```bash
make            # the commands this agent exposes
make status     # refresh app-data/storage/STATUS.md
```

`docs/CLI_COMMANDS.yaml` is the authoritative catalog; the `Makefile` is its local
mirror. Both need [`uv`](https://docs.astral.sh/uv/).

## What is where

| Path | What it holds |
|------|---------------|
| `cinna-agent.json` | identity, description, example prompts, credential slots, schedules |
| `docs/` | the prompts that define behaviour, and the command catalog |
| `scripts/` | everything the agent runs, catalogued in `scripts/README.md` |
| `knowledge/` | reference material the agent reads |
| `config/` | non-secret configuration |
| `credentials/` | what the agent needs, and the local `.env` (never committed) |
| `app-data/` | runtime output, including `storage/STATUS.md` |
| `pyproject.toml` | the Python version and dependencies `uv run` provisions |

Nothing here is generated. Open the folder in a coding assistant and it can change
any of it.
