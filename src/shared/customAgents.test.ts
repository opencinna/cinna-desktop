import { describe, expect, it } from 'vitest'
import { parseCustomAgentConfig, parseRemoteAcpConfig, parseAcpAccessToken } from './customAgents'

const config = { launcher: 'custom', transport: 'websocket', url: 'wss://cinna.example/acp/connector', cwd: '/app/workspace' }
describe('remote ACP configuration', () => {
  it('accepts remote WSS and loopback WS, preserving the server workspace', () => {
    expect(parseCustomAgentConfig(config)).toEqual(config)
    for (const host of ['localhost', '127.0.0.1', '[::1]']) {
      expect(parseRemoteAcpConfig({ ...config, url: `ws://${host}:8000/acp/test` }).url).toBe(`ws://${host}:8000/acp/test`)
    }
  })
  it.each(['https://server/acp', 'ws://remote/acp', 'wss://user:secret@server/acp', 'wss://server/acp?token=secret', 'wss://server/acp#secret', 'wss://server/acp?', 'file:///tmp/agent', 'ws://localhost.evil/acp'])('rejects unsupported or credential-bearing endpoint %s', (url) => {
    expect(() => parseRemoteAcpConfig({ ...config, url })).toThrow()
  })
  it('validates workspace and token without storing credentials in configuration', () => {
    expect(() => parseRemoteAcpConfig({ ...config, cwd: 'relative' })).toThrow(/absolute/)
    expect(parseRemoteAcpConfig({ ...config, accessToken: 'secret' })).not.toHaveProperty('accessToken')
    expect(parseAcpAccessToken('acp_token')).toBe('acp_token')
    expect(parseAcpAccessToken('')).toBeUndefined()
    for (const token of ['Bearer secret', 'secret\r\nX: header', {}, 'x'.repeat(8193)]) expect(() => parseAcpAccessToken(token)).toThrow()
  })
})
