import type { Page } from '@playwright/test'

/**
 * **Claude Agent on an API token instead of the developer's login** — the
 * opt-in `CINNA_E2E_CLAUDE_AUTH=api_key`.
 *
 * Unset (or `subscription`), nothing changes: a live Claude run uses the
 * real-`HOME` login exception (`realLogin.ts`). Set to `api_key`, every live
 * spec that would launch on the developer's Claude login (`liveEngineOptions()`
 * with `CINNA_E2E_LIVE_ENGINE=claude`, or a spec's own `realLogin` on Claude,
 * as `live-artifacts.spec.ts` has) launches in the **ordinary sandbox** instead
 * — throwaway `HOME`, no login, nothing under the real `HOME` to clean — and
 * `skipOnboarding()` puts the app in Settings → Local Agents' API Token mode
 * on `ANTHROPIC_API_KEY` from `.env`: Claude Agent as the Default runtime, the
 * same binary as its Claude Path, an Anthropic AI credential holding the key,
 * `claudeApiCredentialId` naming it and `claudeAuthMode: 'api_key'`.
 *
 * The turns then bill the key's account per token rather than the
 * subscription. The key goes into the app over `providers.upsert` (encrypted
 * in main) and is never logged.
 */
export const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY?.trim() ?? ''

const RAW = (process.env.CINNA_E2E_CLAUDE_AUTH ?? '').trim() || 'subscription'
if (RAW !== 'subscription' && RAW !== 'api_key') {
  throw new Error(`CINNA_E2E_CLAUDE_AUTH must be subscription or api_key, not "${RAW}"`)
}

/** Whether live Claude runs go through API Token mode rather than the real login. */
export const CLAUDE_API_AUTH = RAW === 'api_key'

/** The credential's name in the app, which the Runtime panel and the settings row quote. */
export const E2E_ANTHROPIC_CREDENTIAL = 'E2E Anthropic'

/** The fixture's form of the mode: the Claude binary to name as the Claude Path. */
export interface ClaudeApiAuth {
  binary: string
}

/**
 * Seed the Anthropic credential (once per profile — found again by name after
 * a relaunch) and answer its id. Exported for a spec that wants the
 * credential but means to pick the mode through the UI itself.
 */
export async function seedAnthropicCredential(page: Page, name: string = E2E_ANTHROPIC_CREDENTIAL): Promise<string> {
  if (ANTHROPIC_API_KEY === '') throw new Error('ANTHROPIC_API_KEY is not set in .env')
  return page.evaluate(async ({ apiKey, name }) => {
    const existing = (await window.api.providers.list()).find((p) => p.type === 'anthropic' && p.name === name)
    if (existing) return existing.id
    const { id } = await window.api.providers.upsert({ type: 'anthropic', name, apiKey, enabled: true })
    return id
  }, { apiKey: ANTHROPIC_API_KEY, name })
}

/**
 * Why the seeded credential cannot run a turn, or null: the app's own
 * `providers.test`, one models-list request that bills nothing. Anthropic's
 * refusal is quoted (it never contains the key) — e.g. an organisation key not
 * scoped to a workspace answers 400 "This API key is not scoped to a
 * workspace…", and the CLI then fails every turn with the same words.
 */
export async function anthropicKeyProblem(page: Page, credentialId: string): Promise<string | null> {
  const tested = await page.evaluate((id) => window.api.providers.test(id), credentialId)
  return tested.success ? null : `ANTHROPIC_API_KEY in .env is refused by Anthropic: ${tested.error ?? 'no reason given'}`
}

/**
 * After activation (idempotent, so after every launch): Claude Agent as the
 * Default runtime on `binary`, API Token mode on the seeded credential.
 */
export async function pinClaudeApiProfile(page: Page, auth: ClaudeApiAuth): Promise<void> {
  const credentialId = await seedAnthropicCredential(page)
  const problem = await anthropicKeyProblem(page, credentialId)
  if (problem) throw new Error(`CINNA_E2E_CLAUDE_AUTH=api_key: ${problem}`)
  await page.evaluate(async ({ binary, credentialId }) => {
    await window.api.settings.set('localAgentsDefaultEngine', 'claude')
    await window.api.settings.set('localAgentsClaudePath', binary)
    await window.api.settings.set('claudeApiCredentialId', credentialId)
    await window.api.settings.set('claudeAuthMode', 'api_key')
  }, { binary: auth.binary, credentialId })
}
