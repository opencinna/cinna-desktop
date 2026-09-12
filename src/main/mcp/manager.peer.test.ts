import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { McpProviderConfig } from './types'
import { protocolPeer, BEARER, MODERN, LEGACY, TOOL_NAME, TOOL_TEXT, type ProtocolPeer } from './testSupport/protocolPeers'

const edge = vi.hoisted(() => ({
  rows: new Map<string, Record<string, unknown>>(),
  shellEnv: {} as Record<string, string>,
  openExternal: vi.fn(async (_url: string) => {}),
  save: vi.fn()
}))
vi.mock('electron', () => ({ shell: { openExternal: edge.openExternal } }))
vi.mock('../index', () => ({ getMainWindow: () => null }))
vi.mock('../logger/logger', () => ({ createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }))
vi.mock('../security/keystore', () => ({ encryptApiKey: (text: string) => Buffer.from(text), decryptApiKey: (value: Buffer) => value.toString() }))
vi.mock('../db/mcpProviders', () => ({ mcpProviderRepo: {
  getOwned: (userId: string, id: string) => { const row = edge.rows.get(id); return row?.userId === userId ? row : undefined },
  saveOAuthState: edge.save
} }))
// Only the source of the shell environment is fake; narrowing/merging remain real.
vi.mock('../shell/env', async () => ({
  ...(await import('../shell/envMerge')),
  getShellEnv: async () => edge.shellEnv
}))

const { MCPManager } = await import('./manager')
let manager: InstanceType<typeof MCPManager>
let temporary: string
const peers: ProtocolPeer[] = []

function config(patch: Partial<McpProviderConfig> = {}): McpProviderConfig {
  const value: McpProviderConfig = { id: 'peer-provider', userId: 'peer-user', configRevision: 0,
    name: 'Protocol peer', transportType: 'streamable-http', enabled: true,
    authType: 'bearer', bearerTokenEncrypted: Buffer.from(BEARER), ...patch }
  edge.rows.set(value.id, { ...value, command: value.command ?? null, args: value.args ?? null,
    url: value.url ?? null, env: value.env ?? null, authTokensEncrypted: value.authTokensEncrypted ?? null, clientInfo: value.clientInfo ?? null,
    oauthDiscoveryState: value.oauthDiscoveryState ?? null, createdBySync: false, createdAt: new Date(), updatedAt: new Date() })
  return value
}
async function peer(options: Parameters<typeof protocolPeer>[0]) {
  const value = await protocolPeer(options)
  peers.push(value)
  return value
}
beforeEach(() => {
  temporary = mkdtempSync(join(tmpdir(), 'cinna-mcp-peer-'))
  edge.rows.clear()
  edge.openExternal.mockClear()
  edge.save.mockReset()
  edge.save.mockImplementation((userId: string, id: string, revision: number, patch: Record<string, unknown>) => {
    const row = edge.rows.get(id)
    if (!row || row.userId !== userId || row.configRevision !== revision) throw new Error('Stale fixture configuration')
    Object.assign(row, patch)
  })
  edge.shellEnv = { HOME: temporary, PATH: process.env.PATH ?? '', MCP_TEST_SHELL_SECRET: 'synthetic-login-secret' }
  manager = new MCPManager()
})
afterEach(async () => {
  await manager.disconnectAll()
  await Promise.all(peers.splice(0).map((value) => value.close()))
  rmSync(temporary, { recursive: true, force: true })
})

function expectBearer(value: ProtocolPeer): void {
  expect(value.requests.length).toBeGreaterThan(0)
  for (const request of value.requests) expect(request.authorization).toBe(`Bearer ${BEARER}`)
  expect(edge.openExternal).not.toHaveBeenCalled()
}

describe('MCPManager through the real v2 SDK', () => {
  it('negotiates modern HTTP and sends per-request metadata without legacy initialization', async () => {
    const remote = await peer({ protocol: 'modern' })
    const connection = await manager.connect(config({ url: remote.url }))
    expect(connection.status).toBe('connected')
    expect(connection.tools).toEqual([expect.objectContaining({ name: TOOL_NAME, mcpProviderId: 'peer-provider', providerType: 'mcp' })])
    const result = await manager.callTool('peer-provider', TOOL_NAME, { value: 'request-witness' })
    expect(result).toMatchObject({ content: [{ type: 'text', text: TOOL_TEXT }] })
    expect(result.isError).not.toBe(true)
    expect(remote.methods()).toEqual(['server/discover', 'tools/list', 'tools/call'])
    for (const row of remote.requests.filter((request) => request.rpc)) {
      expect(row.rpc!.params?._meta).toMatchObject({
        'io.modelcontextprotocol/protocolVersion': MODERN,
        'io.modelcontextprotocol/clientCapabilities': {},
        'io.modelcontextprotocol/clientInfo': { name: 'cinna-desktop', version: expect.any(String) }
      })
    }
    expect(remote.requests.find((row) => row.rpc?.method === 'tools/call')?.rpc?.params)
      .toMatchObject({ name: TOOL_NAME, arguments: { value: 'request-witness' } })
    expectBearer(remote)
  })

  it('falls back from method-not-found discovery to the real legacy HTTP handshake', async () => {
    const remote = await peer({ protocol: 'legacy' })
    expect((await manager.connect(config({ url: remote.url }))).status).toBe('connected')
    expect(await manager.callTool('peer-provider', TOOL_NAME, { value: 'legacy' }))
      .toMatchObject({ content: [{ type: 'text', text: TOOL_TEXT }] })
    expect(remote.methods()).toEqual(['server/discover', 'initialize', 'notifications/initialized', 'tools/list', 'tools/call'])
    const initialize = remote.requests.find((row) => row.rpc?.method === 'initialize')!
    expect(initialize.rpc?.params).toMatchObject({ protocolVersion: LEGACY, capabilities: {}, clientInfo: { name: 'cinna-desktop' } })
    expect(remote.requests.find((row) => row.rpc?.method === 'tools/call')?.rpc?.params?._meta).toBeUndefined()
    expectBearer(remote)
  })

  it.each([401, 403, 503] as const)('does not mistake HTTP %i during discovery for a legacy peer', async (probeStatus) => {
    const remote = await peer({ protocol: 'modern', probeStatus })
    const connection = await manager.connect(config({ url: remote.url }))
    expect(connection.status).toBe('error')
    expect(connection.error).toEqual(expect.any(String))
    expect(connection.tools).toEqual([])
    expect(remote.methods()).toEqual(['server/discover'])
    expectBearer(remote)
  })

  it('preserves a real server tool-level isError without throwing away its content', async () => {
    const remote = await peer({ protocol: 'modern' })
    remote.state.toolResult = { resultType: 'complete', isError: true, content: [{ type: 'text', text: 'Peer refuses this tool input.' }] }
    expect((await manager.connect(config({ url: remote.url }))).status).toBe('connected')
    expect(await manager.callTool('peer-provider', TOOL_NAME, { value: 'refused' }))
      .toEqual({ isError: true, content: [{ type: 'text', text: 'Peer refuses this tool input.' }] })
    expect(manager.getConnection('peer-provider')?.status).toBe('connected')
    expect(remote.methods().filter((method) => method === 'tools/call')).toHaveLength(1)
  })

  it.each([
    ['unknown result discriminator', { resultType: 'future_task', content: [{ type: 'text', text: 'must not succeed' }] }],
    ['Task-looking result without tool content', { resultType: 'complete', task: { taskId: 'unsupported-task', status: 'working' } }],
    ['malformed tool content', { resultType: 'complete', content: [{ type: 'text', text: 73 }] }]
  ])('rejects a modern %s through the SDK parser instead of successful undefined content', async (_label, payload) => {
    const remote = await peer({ protocol: 'modern' })
    remote.state.toolResult = payload as Record<string, unknown>
    expect((await manager.connect(config({ url: remote.url }))).status).toBe('connected')
    await expect(manager.callTool('peer-provider', TOOL_NAME, { value: 'bad-result' })).rejects.toThrow()
    expect(remote.methods()).toEqual(['server/discover', 'tools/list', 'tools/call'])
  })

  it('reuses auto negotiation after a real OAuth callback and token exchange', async () => {
    const remote = await peer({ protocol: 'modern', oauth: true })
    const connection = await manager.connect(config({ url: remote.url, authType: 'oauth', bearerTokenEncrypted: undefined }))
    expect(connection.status).toBe('awaiting-auth')
    expect(edge.openExternal).toHaveBeenCalledTimes(1)
    const authorization = new URL(edge.openExternal.mock.calls[0][0])
    expect(authorization.origin).toBe(remote.origin)
    expect(authorization.pathname).toBe('/authorize')
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256')
    const redirect = new URL(authorization.searchParams.get('redirect_uri')!)
    expect(redirect.hostname).toBe('127.0.0.1')
    redirect.searchParams.set('state', authorization.searchParams.get('state')!)
    redirect.searchParams.set('code', 'synthetic-authorized-code')
    redirect.searchParams.set('iss', remote.origin)
    expect((await fetch(redirect)).status).toBe(200)
    await vi.waitFor(() => expect(manager.getConnection('peer-provider')?.status).toBe('connected'))
    expect(await manager.callTool('peer-provider', TOOL_NAME, { value: 'after-browser' }))
      .toMatchObject({ content: [{ type: 'text', text: TOOL_TEXT }] })
    const tokenRequests = remote.requests.filter((row) => row.path === '/token')
    expect(tokenRequests).toHaveLength(1)
    expect(tokenRequests[0].form).toMatchObject({ grant_type: 'authorization_code', code: 'synthetic-authorized-code',
      client_id: 'peer-public-client', code_verifier: expect.any(String) })
    const authorizedRpc = remote.requests.filter((row) => row.rpc && row.authorization === `Bearer ${BEARER}`)
    expect(authorizedRpc.map((row) => row.rpc!.method)).toEqual(['server/discover', 'tools/list', 'tools/call'])
    expect(remote.methods()).not.toContain('initialize')
    for (const row of authorizedRpc) expect(row.rpc!.params?._meta).toMatchObject({
      'io.modelcontextprotocol/protocolVersion': MODERN,
      'io.modelcontextprotocol/clientCapabilities': {},
      'io.modelcontextprotocol/clientInfo': { name: 'cinna-desktop', version: expect.any(String) }
    })
    expect(edge.openExternal).toHaveBeenCalledTimes(1)
    expect(edge.save).toHaveBeenCalledWith('peer-user', 'peer-provider', 0,
      expect.objectContaining({ authTokensEncrypted: expect.any(Buffer) }))
  })

  it('does not reopen a completed callback when fresh discovery rejects the newly exchanged access token', async () => {
    const remote = await peer({ protocol: 'modern', oauth: true, noRefreshToken: true })
    const settings = config({ url: remote.url, authType: 'oauth', bearerTokenEncrypted: undefined })
    expect((await manager.connect(settings)).status).toBe('awaiting-auth')
    expect(edge.openExternal).toHaveBeenCalledTimes(1)
    const authorization = new URL(edge.openExternal.mock.calls[0][0])
    const callback = new URL(authorization.searchParams.get('redirect_uri')!)
    callback.searchParams.set('code', 'synthetic-authorized-code')
    callback.searchParams.set('state', authorization.searchParams.get('state')!)
    callback.searchParams.set('iss', remote.origin)
    remote.state.rejectAuthorized = true
    const response = await fetch(callback)
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('Continue in the app to check the authorization result.')
    await vi.waitFor(() => expect(manager.getConnection(settings.id)).toMatchObject({
      status: 'error', error: expect.stringMatching(/Connect again/)
    }))
    const exchanges = remote.requests.filter((row) => row.path === '/token')
    expect(exchanges).toHaveLength(1)
    expect(exchanges[0].form).toMatchObject({ grant_type: 'authorization_code', code: 'synthetic-authorized-code' })
    const saved = JSON.parse((edge.rows.get(settings.id)!.authTokensEncrypted as Buffer).toString())
    expect(saved).toMatchObject({ access_token: BEARER, issuer: remote.origin })
    expect(saved.refresh_token).toBeUndefined()
    expect(remote.requests.filter((row) => row.rpc?.method === 'server/discover' && row.authorization === `Bearer ${BEARER}`))
      .toHaveLength(1)
    expect(remote.methods()).not.toContain('initialize')
    expect(remote.methods()).not.toContain('tools/list')
    expect(edge.openExternal).toHaveBeenCalledTimes(1)
    // The actual callback server closed; repeating its URL cannot revive authorization.
    await expect(fetch(callback)).rejects.toThrow()
    expect(edge.openExternal).toHaveBeenCalledTimes(1)
    expect(remote.requests.filter((row) => row.path === '/token')).toHaveLength(1)
  })

  it.each(['wrong issuer', 'missing issuer', 'wrong state', 'missing state'] as const)(
    'rejects a callback with %s before token exchange and shows neutral callback text', async (invalid) => {
      const remote = await peer({ protocol: 'modern', oauth: true, requireIssuer: true })
      expect((await manager.connect(config({ url: remote.url, authType: 'oauth', bearerTokenEncrypted: undefined }))).status)
        .toBe('awaiting-auth')
      const authorization = new URL(edge.openExternal.mock.calls[0][0])
      const callback = new URL(authorization.searchParams.get('redirect_uri')!)
      callback.searchParams.set('code', 'synthetic-authorized-code')
      callback.searchParams.set('state', authorization.searchParams.get('state')!)
      callback.searchParams.set('iss', remote.origin)
      if (invalid === 'wrong issuer') callback.searchParams.set('iss', `${remote.origin}/other-issuer`)
      if (invalid === 'missing issuer') callback.searchParams.delete('iss')
      if (invalid === 'wrong state') callback.searchParams.set('state', 'wrong-synthetic-state')
      if (invalid === 'missing state') callback.searchParams.delete('state')
      const response = await fetch(callback)
      expect(response.status).toBe(invalid.includes('state') ? 400 : 200)
      const text = await response.text()
      expect(text).toContain('Return to Cinna')
      expect(text).toContain('Continue in the app to check the authorization result.')
      expect(text).not.toMatch(/success|authorized|connected/i)
      await vi.waitFor(() => expect(manager.getConnection('peer-provider')?.status).toBe(invalid.includes('state') ? 'awaiting-auth' : 'error'))
      expect(remote.requests.filter((row) => row.path === '/token')).toHaveLength(0)
      expect(remote.methods()).not.toContain('tools/list')
      expect(remote.methods()).not.toContain('initialize')
      expect(edge.save.mock.calls.filter((call) => 'authTokensEncrypted' in call[3])).toHaveLength(0)
      expect(edge.openExternal).toHaveBeenCalledTimes(1)
    })

  it('fails a post-connect 401 actionably without opening a dead callback flow or falling back to legacy', async () => {
    const remote = await peer({ protocol: 'modern', oauth: true })
    const settings = config({ url: remote.url, authType: 'oauth', bearerTokenEncrypted: undefined,
      authTokensEncrypted: Buffer.from(JSON.stringify({ access_token: BEARER, token_type: 'Bearer', issuer: remote.origin })),
      clientInfo: { client_id: 'peer-public-client', issuer: remote.origin } })
    expect((await manager.connect(settings)).status).toBe('connected')
    remote.state.rejectAuthorized = true
    await expect(manager.callTool(settings.id, TOOL_NAME, { value: 'authorization-expired' }))
      .rejects.toThrow(/Connect again/)
    expect(manager.getConnection(settings.id)).toMatchObject({ status: 'error',
      error: 'Authorization needs attention. Connect again in MCP settings.' })
    expect(edge.openExternal).not.toHaveBeenCalled()
    expect(remote.requests.filter((row) => row.path === '/token')).toHaveLength(0)
    expect(remote.requests.filter((row) => row.path === '/register')).toHaveLength(0)
    expect(remote.methods()).toEqual(['server/discover', 'tools/list', 'tools/call'])
    await expect(manager.callTool(settings.id, TOOL_NAME, { value: 'must-not-deliver' })).rejects.toThrow(/not connected/)
    expect(remote.methods()).toEqual(['server/discover', 'tools/list', 'tools/call'])
    remote.state.rejectAuthorized = false
    expect((await manager.connect(settings)).status).toBe('connected')
    expect(await manager.callTool(settings.id, TOOL_NAME, { value: 'explicit-reconnect' }))
      .toMatchObject({ content: [{ type: 'text', text: TOOL_TEXT }] })
    expect(remote.methods()).not.toContain('initialize')
    expect(edge.openExternal).not.toHaveBeenCalled()
  })

  it.each(['saved rotation', 'persistence failure'] as const)('handles post-connect refresh with %s through the real SDK', async (outcome) => {
    const remote = await peer({ protocol: 'modern', oauth: true })
    const oldTokens = Buffer.from(JSON.stringify({ access_token: BEARER, token_type: 'Bearer', issuer: remote.origin,
      refresh_token: 'old-peer-refresh-token' }))
    const settings = config({ url: remote.url, authType: 'oauth', bearerTokenEncrypted: undefined,
      authTokensEncrypted: oldTokens, clientInfo: { client_id: 'peer-public-client', issuer: remote.origin } })
    expect((await manager.connect(settings)).status).toBe('connected')
    const writeNormally = edge.save.getMockImplementation()!
    edge.save.mockImplementation((userId: string, id: string, revision: number, patch: Record<string, unknown>) => {
      if (outcome === 'persistence failure' && 'authTokensEncrypted' in patch) throw new Error('Post-connect rotation could not persist')
      return writeNormally(userId, id, revision, patch)
    })
    remote.state.rejectNextAuthorized = 1
    const result = manager.callTool(settings.id, TOOL_NAME, { value: 'refresh-this-call' })
    if (outcome === 'saved rotation') {
      expect(await result).toMatchObject({ content: [{ type: 'text', text: TOOL_TEXT }] })
      expect(manager.getConnection(settings.id)?.status).toBe('connected')
      expect(JSON.parse((edge.rows.get(settings.id)!.authTokensEncrypted as Buffer).toString()))
        .toMatchObject({ access_token: BEARER, refresh_token: 'rotated-peer-refresh-token' })
      expect(remote.methods().filter((method) => method === 'tools/call')).toHaveLength(2)
    } else {
      await expect(result).rejects.toThrow('Post-connect rotation could not persist')
      expect(manager.getConnection(settings.id)).toMatchObject({ status: 'error', error: expect.stringMatching(/Connect again/) })
      expect(edge.rows.get(settings.id)?.authTokensEncrypted).toEqual(oldTokens)
      expect(remote.methods().filter((method) => method === 'tools/call')).toHaveLength(1)
      await expect(manager.callTool(settings.id, TOOL_NAME, {})).rejects.toThrow(/not connected/)
    }
    expect(remote.requests.filter((row) => row.path === '/token')).toHaveLength(1)
    expect(remote.requests.find((row) => row.path === '/token')?.form)
      .toMatchObject({ grant_type: 'refresh_token', refresh_token: 'old-peer-refresh-token' })
    expect(edge.openExternal).not.toHaveBeenCalled()
    expect(remote.methods()).not.toContain('initialize')
  })

  it('surfaces post-connect insufficient scope without escalating or starting a browser flow', async () => {
    const remote = await peer({ protocol: 'modern', oauth: true })
    const settings = config({ url: remote.url, authType: 'oauth', bearerTokenEncrypted: undefined,
      authTokensEncrypted: Buffer.from(JSON.stringify({ access_token: BEARER, token_type: 'Bearer', issuer: remote.origin })),
      clientInfo: { client_id: 'peer-public-client', issuer: remote.origin } })
    expect((await manager.connect(settings)).status).toBe('connected')
    remote.state.rejectAuthorized = true
    remote.state.refusalStatus = 403
    await expect(manager.callTool(settings.id, TOOL_NAME, { value: 'insufficient-scope' })).rejects.toThrow()
    expect(manager.getConnection(settings.id)).toMatchObject({ status: 'error', error: expect.stringMatching(/Connect again/) })
    expect(edge.openExternal).not.toHaveBeenCalled()
    expect(remote.requests.filter((row) => row.path === '/token')).toHaveLength(0)
    expect(remote.requests.filter((row) => row.path === '/register')).toHaveLength(0)
    expect(remote.methods()).toEqual(['server/discover', 'tools/list', 'tools/call'])
  })

  it('does not reuse stored refresh tokens or client registration from a different discovered issuer', async () => {
    const remote = await peer({ protocol: 'modern', oauth: true })
    const settings = config({ url: remote.url, authType: 'oauth', bearerTokenEncrypted: undefined,
      authTokensEncrypted: Buffer.from(JSON.stringify({ access_token: 'old-issuer-access', token_type: 'Bearer',
        refresh_token: 'old-issuer-refresh', issuer: `${remote.origin}/previous-issuer` })),
      clientInfo: { client_id: 'old-issuer-client', issuer: `${remote.origin}/previous-issuer` } })
    expect((await manager.connect(settings)).status).toBe('awaiting-auth')
    expect(remote.requests.filter((row) => row.path === '/register')).toHaveLength(1)
    expect(remote.requests.filter((row) => row.path === '/token')).toHaveLength(0)
    expect(edge.openExternal).toHaveBeenCalledTimes(1)
    const authorization = new URL(edge.openExternal.mock.calls[0][0])
    expect(authorization.origin).toBe(remote.origin)
    expect(authorization.searchParams.get('client_id')).toBe('peer-public-client')
    expect(authorization.toString()).not.toContain('old-issuer-client')
    const callback = new URL(authorization.searchParams.get('redirect_uri')!)
    callback.searchParams.set('code', 'synthetic-authorized-code')
    callback.searchParams.set('state', authorization.searchParams.get('state')!)
    callback.searchParams.set('iss', remote.origin)
    expect((await fetch(callback)).status).toBe(200)
    await vi.waitFor(() => expect(manager.getConnection(settings.id)?.status).toBe('connected'))
    const exchanges = remote.requests.filter((row) => row.path === '/token')
    expect(exchanges).toHaveLength(1)
    expect(exchanges[0].form).toMatchObject({ grant_type: 'authorization_code', client_id: 'peer-public-client' })
    expect(exchanges[0].form?.refresh_token).toBeUndefined()
    expect(JSON.parse((edge.rows.get(settings.id)!.authTokensEncrypted as Buffer).toString())).toMatchObject({ issuer: remote.origin })
    expect(remote.methods()).not.toContain('initialize')
  })

  it('preserves the original refresh persistence error without starting another authorization flow', async () => {
    const remote = await peer({ protocol: 'modern', oauth: true })
    const oldTokens = Buffer.from(JSON.stringify({ access_token: 'expired-peer-access-token', token_type: 'Bearer',
      refresh_token: 'old-peer-refresh-token', issuer: remote.origin }))
    const settings = config({ url: remote.url, authType: 'oauth', bearerTokenEncrypted: undefined,
      authTokensEncrypted: oldTokens, clientInfo: { client_id: 'peer-public-client', issuer: remote.origin } })
    const writeNormally = edge.save.getMockImplementation()!
    edge.save.mockImplementation((userId: string, id: string, revision: number, patch: Record<string, unknown>) => {
      if ('authTokensEncrypted' in patch) throw new Error('Fixture rotated-token persistence failed')
      return writeNormally(userId, id, revision, patch)
    })
    const connection = await manager.connect(settings)
    expect(connection.status).toBe('error')
    expect(connection.error).toContain('Fixture rotated-token persistence failed')
    expect(connection.tools).toEqual([])
    const tokenRequests = remote.requests.filter((row) => row.path === '/token')
    expect(tokenRequests).toHaveLength(1)
    expect(tokenRequests[0].form).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'old-peer-refresh-token' })
    const tokenWrites = edge.save.mock.calls.filter((call) => 'authTokensEncrypted' in call[3])
    expect(tokenWrites).toHaveLength(1)
    expect(JSON.parse(tokenWrites[0][3].authTokensEncrypted.toString())).toMatchObject({
      access_token: BEARER, refresh_token: 'rotated-peer-refresh-token'
    })
    expect(edge.rows.get(settings.id)?.authTokensEncrypted).toEqual(oldTokens)
    expect(edge.openExternal).not.toHaveBeenCalled()
    expect(remote.methods()).not.toContain('tools/list')
    expect(remote.requests.filter((row) => row.path === '/register')).toHaveLength(0)
  })

  it.each(['disconnect', 'configuration change'] as const)('does not save or reconnect after %s during a held token exchange', async (action) => {
    let release!: () => void
    const tokenGate = new Promise<void>((resolve) => { release = resolve })
    const remote = await peer({ protocol: 'modern', oauth: true, tokenGate })
    const oldTokens = Buffer.from(JSON.stringify({ access_token: 'expired-peer-access-token', token_type: 'Bearer',
      refresh_token: 'old-peer-refresh-token', issuer: remote.origin }))
    const settings = config({ url: remote.url, authType: 'oauth', bearerTokenEncrypted: undefined,
      authTokensEncrypted: oldTokens, clientInfo: { client_id: 'peer-public-client', issuer: remote.origin } })
    const connecting = manager.connect(settings)
    try {
      await vi.waitFor(() => expect(remote.requests.find((row) => row.path === '/token')?.form)
        .toMatchObject({ grant_type: 'refresh_token', refresh_token: 'old-peer-refresh-token' }))
      edge.save.mockClear()
      let disconnecting: Promise<void> | undefined
      if (action === 'disconnect') disconnecting = manager.disconnect(settings.id)
      else edge.rows.get(settings.id)!.configRevision = settings.configRevision + 1
      release()
      expect((await connecting).status).not.toBe('connected')
      await disconnecting
      expect(edge.save).not.toHaveBeenCalled()
      expect(edge.rows.get(settings.id)?.authTokensEncrypted).toEqual(oldTokens)
      expect(edge.openExternal).not.toHaveBeenCalled()
      expect(remote.requests.filter((row) => row.path === '/token')).toHaveLength(1)
      expect(remote.methods()).not.toContain('tools/list')
      if (action === 'disconnect') expect(manager.getConnection(settings.id)).toBeUndefined()
      else expect(manager.getConnection(settings.id)?.status).not.toBe('connected')
    } finally { release(); await connecting }
  })

  it('keeps legacy SSE bearer transport working and closes its actual subscriber', async () => {
    const remote = await peer({ protocol: 'sse' })
    expect((await manager.connect(config({ transportType: 'sse', url: remote.url }))).status).toBe('connected')
    expect(await manager.callTool('peer-provider', TOOL_NAME, { value: 'sse' }))
      .toMatchObject({ content: [{ type: 'text', text: TOOL_TEXT }] })
    expect(remote.methods()).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'tools/call'])
    expect(remote.requests.some((row) => row.method === 'GET' && row.path === '/sse')).toBe(true)
    expect(remote.requests.some((row) => row.method === 'POST' && row.path === '/messages')).toBe(true)
    expectBearer(remote)
    await manager.disconnect('peer-provider')
    await vi.waitFor(() => expect(remote.state.sseClosed).toBe(1))
    expect(manager.getConnection('peer-provider')).toBeUndefined()
  })

  it('uses one legacy stdio child with narrowed env, exact tool arguments and real teardown', async () => {
    const logPath = join(temporary, 'stdio.jsonl')
    const source = fileURLToPath(new URL('./testSupport/stdioPeer.mjs', import.meta.url))
    const readLog = (): { kind: string; pid?: number; env?: Record<string, unknown>; rpc?: { method: string; params?: unknown } }[] =>
      existsSync(logPath) ? readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []
    const connected = await manager.connect(config({ transportType: 'stdio', command: process.execPath,
      args: [source, logPath], env: { MCP_TEST_EXPLICIT: 'explicit-fixture-value' } }))
    expect(connected.status).toBe('connected')
    expect(await manager.callTool('peer-provider', TOOL_NAME, { value: 'stdio-witness' }))
      .toMatchObject({ content: [{ type: 'text', text: 'stdio:stdio-witness' }] })
    const starts = readLog().filter((row) => row.kind === 'start')
    expect(starts).toHaveLength(1)
    expect(starts[0].env).toEqual({ HOME: temporary, MCP_TEST_SHELL_SECRET: null, MCP_TEST_EXPLICIT: 'explicit-fixture-value' })
    const methods = readLog().filter((row) => row.kind === 'rpc').map((row) => row.rpc!.method)
    expect(methods).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'tools/call'])
    expect(readLog().find((row) => row.rpc?.method === 'tools/call')?.rpc?.params)
      .toEqual({ name: TOOL_NAME, arguments: { value: 'stdio-witness' } })
    await manager.disconnect('peer-provider')
    await vi.waitFor(() => expect(readLog().filter((row) => row.kind === 'exit')).toHaveLength(1))
    expect(() => process.kill(starts[0].pid!, 0)).toThrow()
    expect(edge.openExternal).not.toHaveBeenCalled()
    expect(manager.getConnection('peer-provider')).toBeUndefined()
  })
})

it('serializes concurrent OAuth calls across one rotating refresh token', async () => {
  let release!: () => void
  const tokenGate = new Promise<void>((resolve) => { release = resolve })
  const remote = await peer({ protocol: 'modern', oauth: true, tokenGate })
  const settings = config({ url: remote.url, authType: 'oauth', bearerTokenEncrypted: undefined,
    authTokensEncrypted: Buffer.from(JSON.stringify({ access_token: BEARER, token_type: 'Bearer', issuer: remote.origin,
      refresh_token: 'old-peer-refresh-token' })), clientInfo: { client_id: 'peer-public-client', issuer: remote.origin } })
  expect((await manager.connect(settings)).status).toBe('connected')
  remote.state.rejectNextAuthorized = 1
  const first = manager.callTool(settings.id, TOOL_NAME, {})
  const second = manager.callTool(settings.id, TOOL_NAME, {})
  try {
    await vi.waitFor(() => expect(remote.requests.filter((row) => row.path === '/token')).toHaveLength(1))
    expect(remote.methods().filter((name) => name === 'tools/call')).toHaveLength(1)
  } finally { release() }
  await expect(Promise.all([first, second])).resolves.toHaveLength(2)
  expect(remote.requests.filter((row) => row.path === '/token')).toHaveLength(1)
})

it('completes OAuth for legacy SSE and encrypts the client registration', async () => {
  const remote = await peer({ protocol: 'sse', oauth: true })
  const settings = config({ url: remote.url, transportType: 'sse', authType: 'oauth', bearerTokenEncrypted: undefined })
  expect((await manager.connect(settings)).status).toBe('awaiting-auth')
  const authorization = new URL(edge.openExternal.mock.calls[0][0])
  const callback = new URL(authorization.searchParams.get('redirect_uri')!)
  callback.searchParams.set('state', authorization.searchParams.get('state')!)
  callback.searchParams.set('code', 'synthetic-authorized-code')
  await fetch(callback)
  await vi.waitFor(() => expect(manager.getConnection(settings.id)?.status).toBe('connected'))
  expect(await manager.callTool(settings.id, TOOL_NAME, {})).toMatchObject({ content: [{ type: 'text', text: TOOL_TEXT }] })
  const stored = edge.rows.get(settings.id)!.clientInfo as { encrypted: string }
  expect(stored).toEqual({ encrypted: expect.any(String) })
  expect(JSON.parse(Buffer.from(stored.encrypted, 'base64').toString()).client_id).toBe('peer-public-client')
})
