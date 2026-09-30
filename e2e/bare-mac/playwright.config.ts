import { defineConfig } from '@playwright/test'

/**
 * The bare-Mac suite: the packaged app, installed into a fresh macOS VM with no
 * developer tools, driven over CDP from the host. Run it through `make
 * bare-mac`, which packages the app (or takes APP=) and checks the base image.
 * Details: docs/development/bare_mac/bare_mac.md
 */
export default defineConfig({
  testDir: './specs',
  outputDir: '../test-results/bare-mac',
  // Apple's licence allows two macOS guests per host, and a boot is most of a
  // test's cost; one at a time keeps the host usable.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  // Clone, boot, copy ~300 MB, and a Claude Code download in one spec.
  timeout: 15 * 60_000,
  expect: { timeout: 30_000 },
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure',
    // A missing button fails in a minute, not at the 15-minute test timeout.
    actionTimeout: 60_000
  }
})
