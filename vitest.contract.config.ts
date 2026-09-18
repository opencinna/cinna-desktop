import { defineConfig } from 'vitest/config'

/**
 * The interface-contract tests — `npm run test:contract`, never `npm test`.
 *
 * They run the **real** managed CLI and the real patched ACP adapter over stdio
 * against a loopback fake provider, so they need a ~90 MB binary on the machine
 * (`make contract ENGINE=codex` installs it) and about a minute. A separate
 * config rather than a third project in `vitest.config.ts`, because `vitest run`
 * runs every project of the default config — a project there *would* be part of
 * `npm test`. The default config's `main` project excludes these files for the
 * same reason.
 *
 * One file at a time and no isolation tricks: each file spawns processes and
 * binds loopback ports, and the scenarios inside a file are sequential by
 * design.
 */
export default defineConfig({
  test: {
    name: 'contract',
    environment: 'node',
    include: ['src/main/agents/drivers/acp/contracts/*.contract.test.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 300_000
  }
})
