# Cinna Desktop — task runner. `make help` lists targets.
#
# The E2E suite drives the *built* Electron app with Playwright. Every test
# runs in a throwaway HOME + userData; nothing here touches your real profile.
# Details: docs/development/e2e/e2e.md — writing tests: docs/development/e2e/e2e_llm.md

PW := npx playwright test -c e2e/playwright.config.ts

.PHONY: help test typecheck build demo-localdev demo-clean e2e e2e-only e2e-one e2e-live e2e-integration e2e-offline e2e-engine e2e-ui e2e-trace e2e-clean e2e-clean-engine

help: ## List targets
	@grep -E '^[a-zA-Z0-9_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

test: ## Unit suite (vitest, all against fakes)
	npm test

typecheck: ## Type-check main, preload, renderer and e2e
	npm run typecheck

build: ## Production build into out/ (what the E2E suite launches)
	npx electron-vite build

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
