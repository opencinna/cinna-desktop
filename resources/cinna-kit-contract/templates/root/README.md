# Agent workshop

This folder is a workshop for agents you build yourself. Each agent is a plain
folder: prompts, scripts, knowledge and a manifest, laid out the way a Cinna
workspace is laid out, so the same folder runs locally and imports into a Cinna
instance unchanged.

```
.cinna-kit/   the kit — conventions, templates and tools (do not edit by hand)
Local/        your agents, one folder each
Cloud/        one account workspace per Cinna instance you publish to
```

## Getting started

Open this folder in a coding assistant (Claude Code, Codex, OpenCode) and say
what you want the agent to do. The assistant reads `AGENTS.md`, scaffolds the
folder and builds it with you.

Or create agents from Cinna Desktop: the Agents tab creates them here, runs them,
and shows what each folder contains. Both routes produce the same folder, and you
can switch between them mid-build.

## The commands you will actually use

```bash
uv run .cinna-kit/tools/kit.py list                    # what exists here
uv run .cinna-kit/tools/kit.py new <slug>              # scaffold a new agent
uv run .cinna-kit/tools/kit.py validate Local/<slug>   # is it coherent and cloud-ready?
```

They need [`uv`](https://docs.astral.sh/uv/); it provisions its own Python.

## Two rules worth knowing

- **Never put a secret anywhere but `credentials/.env`.** It is git-ignored, it is
  excluded from anything published, and its values are read only by the agent's
  own scripts.
- **Everything an agent writes at runtime goes under its `app-data/`.** That folder
  is ignored and never travels; everything else in the folder is the agent itself.
