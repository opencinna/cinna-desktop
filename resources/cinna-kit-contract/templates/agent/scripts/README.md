# Scripts

Every script in this folder is listed here, with what it does, how it is run and
what it prints. A script that is not catalogued does not exist as far as the agent
is concerned — `docs/WORKFLOW_PROMPT.md` and any host reading this folder both
start here.

Scripts are always run **from the agent root**, so top-level helpers stay
importable:

```bash
uv run scripts/<name>.py [args]
```

## Shared helpers

| Script | What it does |
|--------|--------------|
| `cinna_credentials.py` | Credential access. `get_credential("<slot>", "<field>")` reads `credentials.json` in the cloud and `credentials/.env` locally, with the same call. Import it; do not read `.env` yourself. |

## Commands

| Script | Run | Prints |
|--------|-----|--------|
| `update_status.py` | `uv run scripts/update_status.py` (`make status`, `/run:status`) | The status line, and writes `app-data/storage/STATUS.md` atomically with `status`, `summary` and `timestamp` frontmatter. |

## Adding a script

1. One script, one step. Print JSON or CSV; write anything large to
   `app-data/storage/`.
2. Run it and see it work before describing it anywhere.
3. Add a row here, in the same change.
4. Wire it into `docs/WORKFLOW_PROMPT.md`, and into `docs/CLI_COMMANDS.yaml` plus
   the `Makefile` if a human should be able to run it directly.

Above roughly eight scripts, group them into subfolders by skill and group this
table the same way.
