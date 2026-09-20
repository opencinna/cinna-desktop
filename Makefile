# Cinna Desktop — task runner. `make help` lists targets.
#
# The E2E suite drives the *built* Electron app with Playwright. Every test
# runs in a throwaway HOME + userData; nothing here touches your real profile
# except live-ctl, which exists to (docs/development/live_backend/live_backend.md).
# Details: docs/development/e2e/e2e.md — writing tests: docs/development/e2e/e2e_llm.md

PW := npx playwright test -c e2e/playwright.config.ts

.PHONY: help test test-hub typecheck build contract contract-next contract-snapshot pin-assets demo-localdev demo-clean e2e e2e-only e2e-one e2e-live e2e-integration e2e-offline e2e-engine e2e-ui e2e-trace e2e-clean e2e-clean-engine live-ctl live-help live-flow

help: ## List targets
	@grep -E '^[a-zA-Z0-9_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

test: ## Unit suite (vitest, all against fakes)
	npm test

test-hub: ## Hub import boundary and plain-Node offline fixture turn
	npm run test:hub

typecheck: ## Type-check main, preload, renderer and e2e
	npm run typecheck

build: ## Production build into out/ (what the E2E suite launches)
	npx electron-vite build

# The interface contract: every external CLI interface Cinna relies on, checked
# against the REAL pinned binary with a loopback fake provider. No login, no
# provider request. Not part of `make test`. Registry, tests and snapshots:
# src/main/agents/drivers/acp/contracts/ — generated docs:
# docs/agents/local_agents/contracts/{codex,claude}_interface.md
STRIP := node --experimental-strip-types
SNAPSHOTS := src/main/agents/drivers/acp/contracts/snapshots
ENGINES := codex claude
# `npm run test:contract` alone runs every engine; a make target runs the one it
# installed. The override variable is how a candidate binary is named.
CONTRACT_FILE = src/main/agents/drivers/acp/contracts/$(ENGINE).contract.test.ts
CONTRACT_OVERRIDE_codex := CINNA_CONTRACT_CODEX
CONTRACT_OVERRIDE_claude := CINNA_CONTRACT_CLAUDE
check-engine = @case " $(ENGINES) " in *" $(ENGINE) "*) ;; *) echo "usage: make $@ ENGINE=<codex|claude>$(1)"; exit 2;; esac

contract: ## Level 1 contract against the pinned CLI (installs it, checksum-verified, on first use): make contract ENGINE=codex|claude
	$(call check-engine,)
	$(STRIP) scripts/install-runtime.mjs $(ENGINE)
	npm run test:contract -- $(CONTRACT_FILE)

contract-next: ## Same contract against a CANDIDATE version, pin untouched: make contract-next ENGINE=codex VERSION=0.156.0
	$(call check-engine, VERSION=<x.y.z>)
	@test -n "$(VERSION)" || (echo "usage: make contract-next ENGINE=<codex|claude> VERSION=<x.y.z>"; exit 2)
	@DIR=$$(mktemp -d "$${TMPDIR:-/tmp}/cinna-contract-next.XXXXXX"); \
	BIN=$$($(STRIP) scripts/install-runtime.mjs $(ENGINE) --version $(VERSION) --dir "$$DIR/$(ENGINE)-$(VERSION)" | tail -1); \
	test -x "$$BIN" || { echo "could not install $(ENGINE) $(VERSION)"; rm -rf "$$DIR"; exit 1; }; \
	$(CONTRACT_OVERRIDE_$(ENGINE))="$$BIN" npm run test:contract -- $(CONTRACT_FILE); STATUS=$$?; \
	rm -rf "$$DIR"; exit $$STATUS
# The run itself prints the snapshot diff (pinned -> candidate); the candidate's
# snapshot and the diff go to $$TMPDIR/cinna-contract-snapshots/$(ENGINE)-<version>.{json,diff},
# never into $(SNAPSHOTS). The recipe's status is vitest's: non-zero only when a
# contract TEST failed — a snapshot diff alone is success — or when the
# candidate could not be installed at all, which prints "could not install".
# (make itself reports any failed recipe as 2.)

contract-snapshot: ## Rewrite the committed snapshot from the pinned CLI, once a change is understood: make contract-snapshot ENGINE=codex|claude
	$(call check-engine,)
	$(STRIP) scripts/install-runtime.mjs $(ENGINE)
	CINNA_CONTRACT_WRITE_SNAPSHOT=1 npm run test:contract -- $(CONTRACT_FILE)

pin-assets: ## url + sha256 (+ size) for EVERY platform of a version, ready to paste into runtimePins.ts: make pin-assets ENGINE=claude VERSION=2.1.277
	$(call check-engine, VERSION=<x.y.z>)
	@test -n "$(VERSION)" || (echo "usage: make pin-assets ENGINE=<codex|claude> VERSION=<x.y.z>"; exit 2)
	$(STRIP) scripts/pin-assets.mjs $(ENGINE) $(VERSION)

demo-localdev: ## Drive one-click onboarding by hand in a throwaway profile: make demo-localdev SERVER=http://localhost:8000
	npx electron-vite build
	sh scripts/demo-localdev.sh

demo-clean: ## Delete the demo profile, so the next demo-localdev is a cold run
	@S="$${SANDBOX:-$${TMPDIR:-/tmp}cinna-demo-profile}"; rm -rf "$$S"; echo "removed: $$S"

e2e: ## Build, then run every E2E spec (live specs skip without OPENAI_API_KEY in .env)
	npm run test:e2e

e2e-only: ## Run every E2E spec against the existing out/ build
	$(PW)

e2e-one: ## One spec file, optionally one test: make e2e-one SPEC=blocked-job GREP="C5"
	@test -n "$(SPEC)" || (echo "usage: make e2e-one SPEC=<spec name> [GREP=<test title fragment>]"; exit 2)
	$(PW) $(SPEC) $(if $(GREP),-g "$(GREP)")

e2e-live: ## Only the specs that talk to a real model (needs OPENAI_API_KEY in .env)
	@grep -qE '^OPENAI_API_KEY=.+' .env 2>/dev/null || (echo "OPENAI_API_KEY is empty in .env (copy .env.example)"; exit 2)
	$(PW) live

e2e-integration: ## Cross-repo: desktop + a running cinna-core + cinna-cli (needs CINNA_E2E_* in .env)
	@grep -qE '^CINNA_E2E_SERVER_URL=.+' .env 2>/dev/null || (echo "CINNA_E2E_SERVER_URL is empty in .env (copy .env.example)"; exit 2)
	@grep -qE '^CINNA_E2E_EMAIL=.+' .env 2>/dev/null || (echo "CINNA_E2E_EMAIL is empty in .env"; exit 2)
	@grep -qE '^CINNA_E2E_PASSWORD=.+' .env 2>/dev/null || (echo "CINNA_E2E_PASSWORD is empty in .env"; exit 2)
	npx electron-vite build
	CINNA_E2E_INTEGRATION=1 $(PW) cinna-integration

e2e-offline: ## Everything that needs no network: no key, no engine download
	OPENAI_API_KEY= CINNA_E2E_SKIP_ENGINE=1 $(PW)

e2e-engine: ## Fill the per-machine engine cache once (the app downloads and verifies its pinned opencode build)
	$(PW) smoke -g "mock keychain"
	@ls -la "$${CINNA_E2E_ENGINE_CACHE:-$$HOME/.cache/cinna-e2e/engine}"

e2e-ui: ## Playwright's UI mode: pick specs, watch them run, inspect each step
	$(PW) --ui

e2e-trace: ## Open a failure's trace: make e2e-trace TRACE=e2e/test-results/<test>/trace.zip
	@test -n "$(TRACE)" || (echo "usage: make e2e-trace TRACE=e2e/test-results/<test dir>/trace.zip"; exit 2)
	npx playwright show-trace $(TRACE)

e2e-clean: ## Remove E2E artifacts (screenshots, traces, contexts)
	rm -rf e2e/test-results e2e/playwright-report

e2e-clean-engine: ## Drop the per-machine engine cache (next run downloads again)
	rm -rf "$${CINNA_E2E_ENGINE_CACHE:-$$HOME/.cache/cinna-e2e/engine}"

live-ctl: ## Build, then hold the app for live-backend testing on your REAL profile (quit other Cinna apps; back up first)
	npx electron-vite build
	node scripts/live-backend/ctl.mjs

live-flow: ## BILLED, manual: the whole flow on your REAL Claude/Codex login, throwaway userData: make live-flow ENGINE=claude|codex [ONLY=a|d|e] [DROP_PATH=<dir>] [KEEP=1] CONFIRM=1
	$(call check-engine, [ONLY=a|d|e] [DROP_PATH=<dir>] [KEEP=1] CONFIRM=1)
	@test -f out/main/index.js || (echo "no build — run: npx electron-vite build"; exit 2)
	$(STRIP) scripts/live/runtime-flow.mjs $(ENGINE)
# ONLY, DROP_PATH, KEEP and CONFIRM reach the script through make's exported
# command-line variables. Without CONFIRM=1 it asks on a terminal and refuses
# anywhere else; it is never run by CI. Results: scripts/live/results/.

live-help: ## How to drive live-backend tests from a shell
	@echo "source scripts/live-backend/live.sh && live_preflight && live_help"
	@echo "docs: docs/development/live_backend/live_backend.md"
