import { defineConfig } from 'vitest/config'

/**
 * `make vault-switch-live`: the opt-in live lane of a vault agent's change of
 * engine. A real VM (test-flavor helper, real guest image), the real pinned
 * OpenCode and Antigravity set up by the switch, and THREE short billed turns
 * on the repo `.env` OPENAI_API_KEY and GEMINI_API_KEY. Never part of
 * `npm test`. See vault-switch-live.vault.ts.
 */
export default defineConfig({
  test: {
    name: 'vault-switch-live',
    environment: 'node',
    include: ['scripts/vault/vault-switch-live.vault.ts'],
    testTimeout: 30 * 60_000,
    hookTimeout: 10 * 60_000
  }
})
