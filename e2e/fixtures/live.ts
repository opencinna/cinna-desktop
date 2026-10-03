import { test, type CinnaApp } from './app'

/**
 * Specs that talk to a real model. The key comes from `.env` at the repo root
 * (loaded by the Playwright config) and is handed to the app the same way a
 * user would: through `provider:upsert`, or typed into the onboarding screen.
 */
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY?.trim() ?? ''

/**
 * Billed specs run only when asked for: `make e2e-live`, or `make e2e-one` with
 * a spec whose name contains `live`, sets `CINNA_E2E_LIVE=1`. A full `make e2e`
 * with a key in `.env` would otherwise spend it on every run.
 */
export const LIVE_REQUESTED = process.env.CINNA_E2E_LIVE === '1'

export function requireLiveKey(): void {
  test.skip(!LIVE_REQUESTED, 'live specs run only through make e2e-live or make e2e-one SPEC=<live spec>')
  test.skip(OPENAI_API_KEY === '', 'OPENAI_API_KEY is not set in .env')
}

/** Fast chat models with dependable tool calling, best first. */
export const PREFERRED_MODELS: readonly string[] = ['gpt-4.1-mini', 'gpt-4o-mini', 'gpt-5-mini']

/**
 * A provider with the real key and a default chat mode on one of the models
 * the app lists for it — the state onboarding leaves behind, seeded over IPC.
 *
 * The model is the first of {@link PREFERRED_MODELS} the app lists, so agent
 * specs get a fast model that calls tools reliably; failing that, the first
 * listed id containing `mini` (the list is newest first).
 */
export async function seedOpenAiDefaultMode(cinna: CinnaApp): Promise<string> {
  return cinna.page.evaluate(async ({ apiKey, preferred }) => {
    const { id } = await window.api.providers.upsert({
      type: 'openai',
      name: 'OpenAI',
      apiKey,
      enabled: true
    })
    const tested = await window.api.providers.test(id)
    if (!tested.success) throw new Error(`provider test failed: ${tested.error}`)
    // The composer resolves a mode's model against the app's own list for the
    // provider, so the mode must name one of those — not one from the live probe.
    const listed = (await window.api.providers.listModels()).filter((m) => m.providerId === id)
    const model = preferred.map((p) => listed.find((m) => m.id === p)).find(Boolean)
      ?? listed.find((m) => m.id.includes('mini')) ?? listed[0]
    if (!model) throw new Error('the app lists no models for the provider')
    await window.api.chatModes.upsert({ name: 'Default', providerId: id, modelId: model.id, isDefault: true })
    return model.id
  }, { apiKey: OPENAI_API_KEY, preferred: PREFERRED_MODELS })
}
