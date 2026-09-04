import { test } from './app'

/**
 * Specs that talk to a real model. The key comes from `.env` at the repo root
 * (loaded by the Playwright config) and is handed to the app the same way a
 * user would: through `provider:upsert`, or typed into the onboarding screen.
 */
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY?.trim() ?? ''

export function requireLiveKey(): void {
  test.skip(OPENAI_API_KEY === '', 'OPENAI_API_KEY is not set in .env')
}
