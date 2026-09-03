# Local mirror of docs/CLI_COMMANDS.yaml.
# Same commands, localized: `python …` becomes `uv run …`. Keep one target per
# command name in the catalog — a host that offers /run:<name> looks for it here.

.DEFAULT_GOAL := help
.PHONY: help status

help:
	@echo "$(notdir $(CURDIR)) — available commands:"
	@echo "  make status   Refresh app-data/storage/STATUS.md and print the status line."

status:
	uv run scripts/update_status.py
