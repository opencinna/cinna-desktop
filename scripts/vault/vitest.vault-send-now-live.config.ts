import { defineConfig } from 'vitest/config'

/**
 * `make vault-send-now-live`: the opt-in live lane of a queued message's Send
 * now in a vault agent's chat. A real VM (test-flavor helper, real guest
 * image), hub core initialized as the desktop does, turns through the real
 * run queue and run service, and about TWO short billed turns per engine
 * selected by VAULT_SEND_NOW_ENGINES (repo `.env` keys). Never part of
 * `npm test`. See vault-send-now-live.vault.ts.
 */
export default defineConfig({
  test: {
    name: 'vault-send-now-live',
    environment: 'node',
    include: ['scripts/vault/vault-send-now-live.vault.ts'],
    testTimeout: 60 * 60_000,
    hookTimeout: 10 * 60_000
  }
})
