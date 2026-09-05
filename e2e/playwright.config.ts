import { defineConfig } from '@playwright/test'
import { config as loadEnv } from 'dotenv'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The E2E suite drives the *built* app (`out/`) through Playwright's Electron
 * support. `npm run test:e2e` builds first; `npm run test:e2e:only` does not,
 * for iterating on specs against an unchanged build.
 *
 * Credentials come from `.env` at the repo root and nowhere else — the app
 * never reads it. Specs that need a live model check `process.env` and skip
 * without one, so the default run is green on a machine with no keys.
 */
export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
loadEnv({ path: join(repoRoot, '.env'), quiet: true })

/**
 * The cross-repo integration spec is opt-in, by file, rather than by a `.env`
 * check inside it.
 *
 * Every other live spec skips itself when its credential is absent, which is
 * the right shape for something that costs one model call. This one drives a
 * real server and really installs a toolchain — minutes of work and a real
 * account workspace on disk — so a developer who has filled in `.env` for
 * `make e2e-integration` must not then get it as part of every `make e2e`.
 * `make e2e-integration` is the only thing that sets the variable.
 */
const integrationOnly = process.env.CINNA_E2E_INTEGRATION === '1'

export default defineConfig({
  testDir: './specs',
  testIgnore: integrationOnly ? [] : ['**/cinna-integration.spec.ts'],
  // Fills the per-machine engine cache once (see fixtures/engine-cache.ts).
  globalSetup: './global-setup.ts',
  outputDir: './test-results',
  // One Electron per worker, and one worker until the suite is trusted.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  }
})
