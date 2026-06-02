import { describe, it, expect } from 'vitest'
import {
  normalizeUrl,
  mcpIdentityKey,
  agentIdentityKey,
  modeKey,
  mcpRowToDescriptor,
  agentRowToDescriptor
} from './identity'
import type { McpProviderRow } from '../db/mcpProviders'
import type { AgentRow } from '../db/agents'

// The identity normalizers are the linchpin of portable dependency sync: two
// devices must derive the SAME key for the SAME logical dependency, or the
// manifest stops being stable across a round trip. These tests pin the
// normalization rules (and their conservative edges) down.

describe('normalizeUrl', () => {
  it('lowercases scheme + host but preserves path case', () => {
    expect(normalizeUrl('HTTPS://Example.COM/MCP/Path')).toBe('https://example.com/MCP/Path')
  })

  it('strips a trailing slash but keeps the rest of the path', () => {
    expect(normalizeUrl('https://example.com/mcp/')).toBe('https://example.com/mcp')
    expect(normalizeUrl('https://example.com/')).toBe('https://example.com')
  })

  it('drops the default port for the scheme', () => {
    expect(normalizeUrl('https://example.com:443/p')).toBe('https://example.com/p')
    expect(normalizeUrl('http://example.com:80/p')).toBe('http://example.com/p')
  })

  it('keeps a non-default port', () => {
    expect(normalizeUrl('http://example.com:8080/p')).toBe('http://example.com:8080/p')
  })

  it('drops the fragment but keeps the query (MCP endpoints are path/query-significant)', () => {
    expect(normalizeUrl('https://example.com/mcp?token=x#frag')).toBe(
      'https://example.com/mcp?token=x'
    )
  })

  it('treats trailing-slash variants as the same normalized URL', () => {
    expect(normalizeUrl('https://example.com/mcp')).toBe(normalizeUrl('https://example.com/mcp/'))
  })

  it('does NOT fuse distinct paths (would mis-merge two servers)', () => {
    expect(normalizeUrl('https://example.com/a')).not.toBe(normalizeUrl('https://example.com/b'))
  })

  it('returns empty string for nullish input', () => {
    expect(normalizeUrl(null)).toBe('')
    expect(normalizeUrl(undefined)).toBe('')
    expect(normalizeUrl('')).toBe('')
  })

  it('falls back to a trimmed/lowercased value for un-parseable input', () => {
    expect(normalizeUrl('  Not A Url/  ')).toBe('not a url')
  })
})

describe('mcpIdentityKey', () => {
  it('keys stdio by command + JSON args (exact)', () => {
    expect(
      mcpIdentityKey({ kind: 'mcp', transport: 'stdio', command: 'npx', args: ['-y', 'foo'], name: 'X' })
    ).toBe('stdio|npx|["-y","foo"]')
  })

  it('keys stdio with no args as an empty array', () => {
    expect(
      mcpIdentityKey({ kind: 'mcp', transport: 'stdio', command: 'srv', args: null, name: 'X' })
    ).toBe('stdio|srv|[]')
  })

  it('keys http/sse by transport + normalized url', () => {
    expect(
      mcpIdentityKey({ kind: 'mcp', transport: 'streamable-http', url: 'https://h.io/mcp/', name: 'X' })
    ).toBe('streamable-http|https://h.io/mcp')
  })

  it('distinguishes transports for the same url', () => {
    const url = 'https://h.io/mcp'
    expect(mcpIdentityKey({ kind: 'mcp', transport: 'sse', url, name: 'X' })).not.toBe(
      mcpIdentityKey({ kind: 'mcp', transport: 'streamable-http', url, name: 'X' })
    )
  })

  it('renamed stdio args produce a different key (documented exact-match behavior)', () => {
    const a = mcpIdentityKey({ kind: 'mcp', transport: 'stdio', command: 'srv', args: ['--a'], name: 'X' })
    const b = mcpIdentityKey({ kind: 'mcp', transport: 'stdio', command: 'srv', args: ['--b'], name: 'X' })
    expect(a).not.toBe(b)
  })
})

describe('agentIdentityKey', () => {
  it('keys a remote agent by its server-stable backend UUID', () => {
    expect(
      agentIdentityKey({
        kind: 'agent',
        source: 'remote',
        remoteTargetType: 'agent',
        remoteTargetId: 'uuid-123'
      })
    ).toBe('remote|agent|uuid-123')
  })

  it('keys a local agent by normalized card URL', () => {
    expect(
      agentIdentityKey({ kind: 'agent', source: 'local', cardUrl: 'https://A.io/.well-known/agent/' })
    ).toBe('local|https://a.io/.well-known/agent')
  })
})

describe('modeKey', () => {
  it('trims and lowercases', () => {
    expect(modeKey('  Deep Work  ')).toBe('deep work')
    expect(modeKey('default')).toBe(modeKey('DEFAULT'))
  })
})

describe('mcpRowToDescriptor', () => {
  const base = {
    id: 'm1',
    userId: '__default__',
    name: 'My MCP',
    transportType: 'streamable-http',
    command: null,
    args: null,
    url: 'https://h.io/mcp',
    env: null,
    enabled: true,
    authTokensEncrypted: null,
    clientInfo: null,
    createdBySync: false,
    createdAt: new Date()
  } as unknown as McpProviderRow

  it('maps an http provider row to a descriptor (no envKeys when env is null)', () => {
    const d = mcpRowToDescriptor(base)
    expect(d).toMatchObject({ kind: 'mcp', transport: 'streamable-http', url: 'https://h.io/mcp', name: 'My MCP' })
    expect(d.envKeys).toBeUndefined()
  })

  it('exposes env KEY NAMES only — never values', () => {
    const row = { ...base, env: { API_KEY: 'secret', REGION: 'eu' } } as McpProviderRow
    const d = mcpRowToDescriptor(row)
    expect(d.envKeys).toEqual(['API_KEY', 'REGION'])
    expect(JSON.stringify(d)).not.toContain('secret')
  })
})

describe('agentRowToDescriptor', () => {
  const base = {
    id: 'a1',
    userId: '__default__',
    name: 'Agent',
    description: null,
    protocol: 'a2a',
    cardUrl: null,
    endpointUrl: null,
    protocolInterfaceUrl: null,
    protocolInterfaceVersion: null,
    accessTokenEncrypted: null,
    cardData: null,
    skills: null,
    enabled: true,
    source: 'local',
    remoteTargetType: null,
    remoteTargetId: null,
    remoteMetadata: null,
    createdBySync: false,
    createdAt: new Date()
  } as unknown as AgentRow

  it('builds a local descriptor from cardUrl', () => {
    const row = { ...base, cardUrl: 'https://a.io/card' } as AgentRow
    expect(agentRowToDescriptor(row)).toEqual({
      kind: 'agent',
      source: 'local',
      cardUrl: 'https://a.io/card',
      name: 'Agent'
    })
  })

  it('falls back to endpointUrl when cardUrl is absent', () => {
    const row = { ...base, endpointUrl: 'https://a.io/endpoint' } as AgentRow
    expect(agentRowToDescriptor(row)?.kind).toBe('agent')
    expect((agentRowToDescriptor(row) as { cardUrl: string }).cardUrl).toBe('https://a.io/endpoint')
  })

  it('returns null for a local agent with no card/endpoint URL', () => {
    expect(agentRowToDescriptor(base)).toBeNull()
  })

  it('builds a remote descriptor carrying the optional server URL', () => {
    const row = {
      ...base,
      source: 'remote',
      remoteTargetType: 'agent',
      remoteTargetId: 'uuid-9'
    } as AgentRow
    expect(agentRowToDescriptor(row, 'https://srv.io')).toEqual({
      kind: 'agent',
      source: 'remote',
      remoteTargetType: 'agent',
      remoteTargetId: 'uuid-9',
      serverUrl: 'https://srv.io',
      name: 'Agent'
    })
  })

  it('returns null for a remote agent missing its backend UUID', () => {
    const row = { ...base, source: 'remote', remoteTargetType: 'agent', remoteTargetId: null } as AgentRow
    expect(agentRowToDescriptor(row)).toBeNull()
  })
})
