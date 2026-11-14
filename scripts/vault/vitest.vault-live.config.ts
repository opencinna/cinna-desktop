import { defineConfig } from 'vitest/config'

/**
 * `make vault-live`: the opt-in live lane of Agent Vault (README "Testing").
 * A real VM (test-flavor helper, real guest image), the real pinned Claude and
 * adapter, and ONE billed Claude Haiku turn on the key in the repo's `.env`.
 * Never part of `npm test`. See vault-live.vault.ts.
 */
export default defineConfig({
  test: {
    name: 'vault-live',
    environment: 'node',
    include: ['scripts/vault/vault-live.vault.ts'],
    testTimeout: 30 * 60_000,
    hookTimeout: 10 * 60_000
  }
})
