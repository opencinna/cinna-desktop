import { describe, expect, it } from 'vitest'
import { describeProviderError, formatProviderErrorDetail } from './providerErrors'

/** The Antigravity turn failure as it was stored: prefix, then a one-element array. */
const GOOGLE_MESSAGE =
  'You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. To monitor your current usage, head to: https://ai.dev/rate-limit. \n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 5, model: gemini-2.5-flash\nPlease retry in 33.54910668s.'

const GOOGLE_BODY = [{
  error: {
    code: 429,
    message: GOOGLE_MESSAGE,
    status: 'RESOURCE_EXHAUSTED',
    details: [
      { '@type': 'type.googleapis.com/google.rpc.Help', links: [{ description: 'Learn more about Gemini API quotas', url: 'https://ai.google.dev/gemini-api/docs/rate-limits' }] },
      { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests', quotaValue: '5' }] },
      { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '33s' }
    ]
  }
}]

const GOOGLE_429 = `Internal error: Provider request failed with HTTP 429: ${JSON.stringify(GOOGLE_BODY, null, 2)}`

describe('describeProviderError', () => {
  it('reads a Google RPC 429 behind a prefix and inside a one-element array', () => {
    expect(describeProviderError(GOOGLE_429)).toEqual({
      title: 'Quota or rate limit exceeded (429)',
      // The provider's message in full, not its first sentence.
      message: GOOGLE_MESSAGE.trim(),
      status: 429,
      retryAfterSec: 33,
      links: [{ url: 'https://ai.google.dev/gemini-api/docs/rate-limits', description: 'Learn more about Gemini API quotas' }]
    })
  })

  it('rounds a fractional retry delay up', () => {
    const body = { error: { code: 429, message: 'slow down', details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '12.2s' }] } }
    expect(describeProviderError(JSON.stringify(body))?.retryAfterSec).toBe(13)
  })

  it('tolerates text after the body', () => {
    const text = `HTTP 503: ${JSON.stringify({ error: { message: 'The model is overloaded.' } })} (attempt 3 of 3)`
    expect(describeProviderError(text)).toEqual({
      title: 'Provider is unavailable or overloaded (503)',
      message: 'The model is overloaded.',
      status: 503
    })
  })

  it('reads an OpenAI error, its status from the prefix', () => {
    const text = 'Provider request failed with HTTP 401: ' + JSON.stringify({
      error: { message: 'Incorrect API key provided: sk-…abcd.', type: 'invalid_request_error', param: null, code: 'invalid_api_key' }
    })
    expect(describeProviderError(text)).toEqual({
      title: 'Provider rejected the credentials (401)',
      message: 'Incorrect API key provided: sk-…abcd.',
      status: 401
    })
  })

  it('titles an OpenAI quota error from its code when no status is given', () => {
    const text = JSON.stringify({ error: { message: 'You exceeded your current quota.', type: 'insufficient_quota', code: 'insufficient_quota' } })
    expect(describeProviderError(text)).toEqual({ title: 'Quota or rate limit exceeded', message: 'You exceeded your current quota.' })
  })

  it('reads an Anthropic error', () => {
    const text = 'Error: ' + JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })
    expect(describeProviderError(text)).toEqual({ title: 'Provider is unavailable or overloaded', message: 'Overloaded' })
    const withStatus = 'HTTP 404: ' + JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'model: claude-x' } })
    expect(describeProviderError(withStatus)?.title).toBe('Model or endpoint not found (404)')
  })

  it('falls back to a generic title for an unknown status', () => {
    expect(describeProviderError('HTTP 418: {"error":{"message":"teapot"}}')?.title).toBe('Provider error (418)')
  })

  it('takes an error body for a provider’s only with a status or a known status/type name', () => {
    // Mutation: drop the gate → each of these is titled "Provider error".
    expect(describeProviderError('{"error":{"message":"odd"}}')).toBeNull()
    expect(describeProviderError('MCP server github returned {"error":{"code":-32601,"message":"Method not found"}}')).toBeNull()
    expect(describeProviderError('Tool read_file failed: {"error":{"message":"ENOENT"}}')).toBeNull()
    expect(describeProviderError('{"error":{"type":"something_else","message":"odd"}}')).toBeNull()
    // A known name alone, or a status alone, is enough.
    expect(describeProviderError('{"error":{"status":"UNAVAILABLE","message":"try later"}}')?.title).toBe('Provider is unavailable or overloaded')
    expect(describeProviderError('{"error":{"code":500,"message":"boom"}}')?.title).toBe('Provider service error (500)')
  })

  it('returns null for plain text', () => {
    expect(describeProviderError('The agent crashed.')).toBeNull()
    expect(describeProviderError('')).toBeNull()
  })

  it('returns null for malformed JSON', () => {
    expect(describeProviderError('HTTP 429: [{ "error": { "code": 429, "message": "cut off')).toBeNull()
    expect(describeProviderError('Unexpected token { in JSON at position 4')).toBeNull()
  })

  it('returns null for JSON that is not a provider error', () => {
    expect(describeProviderError('failed: {"status":"bad"}')).toBeNull()
    expect(describeProviderError('failed: {"error":"just a string"}')).toBeNull()
    expect(describeProviderError('failed: [{"error":{"message":"a"}},{"error":{"message":"b"}}]')).toBeNull()
  })
})

describe('formatProviderErrorDetail', () => {
  it('puts the prefix on its own line and indents the body', () => {
    const compact = `Internal error: Provider request failed with HTTP 429: ${JSON.stringify(GOOGLE_BODY)}`
    expect(formatProviderErrorDetail(compact)).toBe(
      `Internal error: Provider request failed with HTTP 429:\n${JSON.stringify(GOOGLE_BODY, null, 2)}`
    )
  })

  it('returns null when the text carries no JSON', () => {
    expect(formatProviderErrorDetail('The agent crashed.')).toBeNull()
  })

  it('returns null instead of throwing on a body nested too deep to re-print', () => {
    // Mutation: drop the try around the stringify → this throws a RangeError.
    // JSON.parse copes with nesting JSON.stringify's recursion does not.
    const depth = 200_000
    const deep = 'HTTP 500: ' + '['.repeat(depth) + ']'.repeat(depth)
    expect(() => formatProviderErrorDetail(deep)).not.toThrow()
    expect(describeProviderError(deep)).toBeNull()
  })
})
