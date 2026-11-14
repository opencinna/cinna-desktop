/**
 * Checks a pasted engine login before it goes into a vault, so a key that
 * cannot work fails where it was pasted instead of at the first prompt:
 *
 * - an `sk-ant-oat…` token (what `claude setup-token` prints) under
 *   ANTHROPIC_API_KEY: only Claude Code reads it, and only from
 *   CLAUDE_CODE_OAUTH_TOKEN (Claude's login is filed there by prefix). Any
 *   other reader, OpenCode's anthropic provider included, sends it as an API
 *   key and is refused;
 * - a Gemini API key (Antigravity's login): asked of Google once. A refusal
 *   blocks the save; no answer (offline, timeout, 5xx) lets it through, since
 *   the key may well be right.
 *
 * Hub core: plain `fetch`, no Electron. Callers throw the message as a
 * VaultError('invalid').
 */

const GEMINI_CHECK_URL = 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1'
const GEMINI_CHECK_TIMEOUT_MS = 8000

/** The message for a value the secret `name` can never work with, or null. */
export function vaultLoginRefusal(name: string, value: string): string | null {
  if (name === 'ANTHROPIC_API_KEY' && value.trim().startsWith('sk-ant-oat')) {
    return 'This is a Claude Code token (from claude setup-token), not an Anthropic API key. Only Claude Code can sign in with it. Paste an API key from the Anthropic Console (it starts with sk-ant-api).'
  }
  return null
}

/** Why the value stored under `name` cannot sign in, or null when it may. */
export async function vaultLoginProblem(name: string, value: string): Promise<string | null> {
  return vaultLoginRefusal(name, value) ?? (name === 'GEMINI_API_KEY' ? await geminiKeyProblem(value.trim()) : null)
}

async function geminiKeyProblem(key: string): Promise<string | null> {
  let status: number
  try {
    const res = await fetch(GEMINI_CHECK_URL, {
      headers: { 'x-goog-api-key': key },
      signal: AbortSignal.timeout(GEMINI_CHECK_TIMEOUT_MS)
    })
    status = res.status
    await res.body?.cancel().catch(() => {})
  } catch {
    return null // No answer: the key may be right, so it is saved unchecked.
  }
  // Google answers a wrong or disabled key with 400 (API_KEY_INVALID), 401 or 403.
  if (status === 400 || status === 401 || status === 403) {
    return 'Google refused this Gemini API key. Check that it is copied whole and that the Gemini API is enabled for it in Google AI Studio.'
  }
  return null
}
