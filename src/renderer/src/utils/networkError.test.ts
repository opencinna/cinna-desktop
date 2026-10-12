import { describe, expect, it } from 'vitest'
import { describeNetworkError } from './networkError'

describe('describeNetworkError', () => {
  it('names a refused connection from Chromium and from Node', () => {
    expect(describeNetworkError('net::ERR_CONNECTION_REFUSED')).toEqual({ summary: 'Network error occurred. Connection refused.', technical: 'net::ERR_CONNECTION_REFUSED' })
    expect(describeNetworkError('connect ECONNREFUSED 127.0.0.1:8000')?.summary).toBe('Network error occurred. Connection refused.')
  })

  it('keeps what failed from main’s prefix, and the whole text as the detail', () => {
    const raw = 'Could not install Mutagen: net::ERR_NAME_NOT_RESOLVED'
    expect(describeNetworkError(raw)).toEqual({ summary: 'Could not install Mutagen. Network error occurred. The server address could not be found.', technical: raw })
    expect(describeNetworkError('Could not install uv: fetch failed')?.summary).toBe('Could not install uv. Network error occurred.')
  })

  it('does not take Node’s own wording as the lead', () => {
    expect(describeNetworkError('request to https://x/ failed, reason: connect ECONNREFUSED 1.2.3.4:443')?.summary).toBe('Network error occurred. Connection refused.')
  })

  it('recognises undici and Node certificate failures', () => {
    expect(describeNetworkError('fetch failed')?.summary).toBe('Network error occurred.')
    expect(describeNetworkError('UND_ERR_CONNECT_TIMEOUT')?.summary).toBe('Network error occurred. The connection timed out.')
    expect(describeNetworkError('self-signed certificate in certificate chain')?.summary).toBe('Network error occurred. The server’s certificate could not be verified.')
  })

  it('falls back to a generic sentence for an unlisted net code', () => {
    expect(describeNetworkError('net::ERR_BLOCKED_BY_CLIENT')?.summary).toBe('Network error occurred.')
  })

  it('leaves URL and request errors, prose and empty values alone', () => {
    expect(describeNetworkError('net::ERR_INVALID_URL')).toBeNull()
    expect(describeNetworkError('net::ERR_ABORTED')).toBeNull()
    expect(describeNetworkError('write EPIPE')).toBeNull()
    expect(describeNetworkError('Could not reach your Cinna server.')).toBeNull()
    expect(describeNetworkError('The setup token was rejected. Try Repair.')).toBeNull()
    expect(describeNetworkError('')).toBeNull()
    expect(describeNetworkError(null)).toBeNull()
  })
})
