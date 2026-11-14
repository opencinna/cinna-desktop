import { defineConfig } from 'vitest/config'

/**
 * `npx vitest run --config scripts/vault/vitest.move-smoke.config.ts`: Move to
 * vault… against a real VM (test-flavor VaultHelper.app, build/vault-guest),
 * with the real pinned linux-arm64 Claude Code and this app's adapter. Not part
 * of `npm test`: it boots a VM, downloads ~340 MB once, and takes minutes.
 * No prompt is sent (no billing). See move-smoke.vault.ts.
 */
export default defineConfig({
  test: {
    name: 'vault-move-smoke',
    environment: 'node',
    include: ['scripts/vault/move-smoke.vault.ts'],
    testTimeout: 30 * 60_000,
    hookTimeout: 5 * 60_000
  }
})
