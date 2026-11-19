import { defineConfig } from 'vitest/config'

/**
 * `make vault-provider-error-smoke`: a vault Antigravity turn whose server
 * stays silent shows the Gemini error vaultd read from its transcript, on a
 * real VM (test-flavor helper, real guest image, real pinned server), hub core
 * initialized as the desktop does. Not billed: a dummy key, Gemini's hosts off
 * the allowlist, the 503 written by the lane. Never part of `npm test`. See
 * vault-provider-error-smoke.vault.ts.
 */
export default defineConfig({
  test: {
    name: 'vault-provider-error-smoke',
    environment: 'node',
    include: ['scripts/vault/vault-provider-error-smoke.vault.ts'],
    testTimeout: 30 * 60_000,
    hookTimeout: 10 * 60_000
  }
})
