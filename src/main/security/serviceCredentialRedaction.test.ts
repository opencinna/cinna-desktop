import { beforeEach, describe, expect, it } from 'vitest'
import { clearCredentialRedaction, createCredentialEventStream, createCredentialTextStream, redactCredentialValues, rememberCredentialSecrets } from './serviceCredentialRedaction'
beforeEach(clearCredentialRedaction)
describe('credential output boundaries', () => {
  it('redacts overlaps, nested reports, keys, and bearer token substrings', () => {
    rememberCredentialSecrets({ password: 'abcdefgh', access_token: 'abcdefghijkl', http_header_value: 'Bearer secret-value-123', private_key: 'private-key-value' })
    expect(redactCredentialValues({ notes: 'abcdefghijkl abcdefgh', reply: { artifact: 'url/secret-value-123', thinking: 'private-key-value' } })).toEqual({ notes: '***REDACTED*** ***REDACTED***', reply: { artifact: 'url/***REDACTED***', thinking: '***REDACTED***' } })
  })
  it('never emits a secret split at any chunk boundary', () => {
    const secret = 'a-long-secret-token'; rememberCredentialSecrets({ token: secret })
    for (let n = 1; n < secret.length; n++) {
      const stream = createCredentialTextStream()
      expect(stream.push('before ' + secret.slice(0, n)) + stream.push(secret.slice(n) + ' after') + stream.finish()).toBe('before ***REDACTED*** after')
    }
  })
  it('documents the short-string limit and leaves metadata alone', () => {
    rememberCredentialSecrets({ password: 'short', name: 'metadata-long-name' })
    expect(redactCredentialValues('short metadata-long-name')).toBe('short metadata-long-name')
  })
})

it('holds a partial secret after a complete match, including nested agent streams', () => {
  rememberCredentialSecrets({ token: 'long-secret-token' })
  const stream = createCredentialTextStream()
  expect(stream.push('long-secret-token long-sec') + stream.push('ret-token') + stream.finish()).toBe('***REDACTED*** ***REDACTED***')
  const events = createCredentialEventStream()
  const emitted = ['long-sec', 'ret-token'].flatMap(text => events.push({ type: 'child', toolCallId: 'child', agentId: 'agent', event: { type: 'delta', kind: 'text', text } }))
  emitted.push(...events.finish())
  expect(emitted.map(e => e.type === 'child' && e.event.type === 'delta' ? e.event.text : '').join('')).toBe('***REDACTED***')
})

it('redacts API keys and JSON-escaped file values at every streaming boundary', () => {
  const values = { private_key: '-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----', password: 'quoted"and\\backslash\tpassword', api_key: 'api-key-fixture-123' }
  rememberCredentialSecrets(values)
  for (const value of Object.values(values)) {
    for (const representation of [value, JSON.stringify(value).slice(1, -1)]) {
      expect(redactCredentialValues(representation)).toBe('***REDACTED***')
      for (let n = 1; n < representation.length; n++) {
        const stream = createCredentialTextStream()
        expect(stream.push(representation.slice(0, n)) + stream.push(representation.slice(n)) + stream.finish()).toBe('***REDACTED***')
      }
    }
  }
  expect(redactCredentialValues(JSON.stringify(values))).toBe(JSON.stringify({ private_key: '***REDACTED***', password: '***REDACTED***', api_key: '***REDACTED***' }))
})
