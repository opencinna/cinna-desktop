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

export default defineConfig({
  testDir: './specs',
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
