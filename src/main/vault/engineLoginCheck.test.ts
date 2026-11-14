import { afterEach, describe, expect, it, vi } from 'vitest'
import { vaultLoginProblem, vaultLoginRefusal } from './engineLoginCheck'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('vaultLoginRefusal', () => {
  it('refuses a claude setup-token token stored as an Anthropic API key', () => {
    expect(vaultLoginRefusal('ANTHROPIC_API_KEY', ' sk-ant-oat01-abc')).toMatch(/Claude Code token/)
  })

  it('lets an API key and the token under its own name through', () => {
    expect(vaultLoginRefusal('ANTHROPIC_API_KEY', 'sk-ant-api03-abc')).toBeNull()
    expect(vaultLoginRefusal('CLAUDE_CODE_OAUTH_TOKEN', 'sk-ant-oat01-abc')).toBeNull()
  })
})

describe('vaultLoginProblem for a Gemini key', () => {
  function answer(status: number): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn(async () => new Response('{}', { status }))
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  it('asks Google with the key in a header, not the URL', async () => {
    const fetchMock = answer(200)
    expect(await vaultLoginProblem('GEMINI_API_KEY', ' AIzaGood ')).toBeNull()
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).not.toContain('AIza')
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('AIzaGood')
  })

  it.each([400, 401, 403])('refuses a key Google answers with %i', async (status) => {
    answer(status)
    expect(await vaultLoginProblem('GEMINI_API_KEY', 'AIzaBad')).toMatch(/Google refused/)
  })

  it('saves unchecked when Google cannot be asked or fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed') }))
    expect(await vaultLoginProblem('GEMINI_API_KEY', 'AIzaKey')).toBeNull()
    answer(503)
    expect(await vaultLoginProblem('GEMINI_API_KEY', 'AIzaKey')).toBeNull()
  })

  it('asks nothing for other secrets', async () => {
    const fetchMock = answer(400)
    expect(await vaultLoginProblem('OPENAI_API_KEY', 'sk-x')).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
