import { randomBytes } from 'node:crypto'
import { shell } from 'electron'
import type { OAuthClientMetadata, StoredOAuthClientInformation, StoredOAuthTokens, OAuthClientProvider, OAuthDiscoveryState } from '@modelcontextprotocol/client'
import { startOAuthCallback, type OAuthCallbackListener } from './oauth-callback'

export interface OAuthStoredState {
  clientInfo?: StoredOAuthClientInformation
  tokens?: StoredOAuthTokens
  discovery?: OAuthDiscoveryState
}
export interface OAuthProviderCallbacks {
  assertCurrent: () => void
  save: (patch: { tokens?: StoredOAuthTokens | null; clientInfo?: StoredOAuthClientInformation | null; discovery?: OAuthDiscoveryState | null }) => void
}

export class McpReauthorizationRequiredError extends Error {}

/** Native public-client OAuth; the SDK owns discovery, issuer validation and refresh. */
export class ElectronOAuthProvider implements OAuthClientProvider {
  private persistenceFailure: unknown
  private redirect: string | undefined
  private verifier: string | undefined
  private expectedState: string | undefined
  private callback: OAuthCallbackListener | undefined
  constructor(private stored: OAuthStoredState, private callbacks: OAuthProviderCallbacks) {}
  hasPersistenceFailure(): boolean { return this.persistenceFailure !== undefined }
  private assertUsable(): void {
    if (this.persistenceFailure) throw this.persistenceFailure
    this.callbacks.assertCurrent()
  }
  private persist(patch: Parameters<OAuthProviderCallbacks['save']>[0]): void {
    this.assertUsable()
    try { this.callbacks.save(patch) } catch (error) {
      // SDK refresh recovery can swallow save errors and attempt authorization.
      // A failed durable rotation must remain fatal for this connection.
      this.persistenceFailure = error instanceof Error ? error : new Error(String(error))
      throw this.persistenceFailure
    }
  }
  get redirectUrl(): string | undefined { this.assertUsable(); return this.redirect }
  get clientMetadata(): OAuthClientMetadata {
    this.assertUsable()
    return { redirect_uris: this.redirect ? [this.redirect] : [], client_name: 'Cinna Desktop',
      application_type: 'native', token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }
  }
  state(): string {
    this.assertUsable()
    if (!this.expectedState || !this.callback?.isPending()) throw new McpReauthorizationRequiredError('MCP authorization needs a new connection. Connect again.')
    return this.expectedState
  }
  clientInformation(): StoredOAuthClientInformation | undefined {
    this.assertUsable(); return this.stored.clientInfo
  }
  saveClientInformation(clientInfo: StoredOAuthClientInformation): void {
    this.assertUsable()
    const registration = { ...clientInfo, ...(this.redirect ? { redirect_uris: [this.redirect] } : {}) }
    this.persist({ clientInfo: registration }); this.stored.clientInfo = registration
  }
  tokens(): StoredOAuthTokens | undefined {
    this.assertUsable(); return this.stored.tokens
  }
  saveTokens(tokens: StoredOAuthTokens): void {
    this.assertUsable(); this.persist({ tokens }); this.stored.tokens = tokens
  }
  discoveryState(): OAuthDiscoveryState | undefined {
    this.assertUsable(); return this.stored.discovery
  }
  saveDiscoveryState(discovery: OAuthDiscoveryState): void {
    this.assertUsable(); this.persist({ discovery }); this.stored.discovery = discovery
  }
  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    this.assertUsable()
    const patch: Parameters<OAuthProviderCallbacks['save']>[0] = {}
    if (scope === 'all' || scope === 'client') patch.clientInfo = null
    if (scope === 'all' || scope === 'tokens') patch.tokens = null
    if (scope === 'all' || scope === 'discovery') patch.discovery = null
    if (Object.keys(patch).length) this.persist(patch)
    if ('clientInfo' in patch) delete this.stored.clientInfo
    if ('tokens' in patch) delete this.stored.tokens
    if ('discovery' in patch) delete this.stored.discovery
    if (scope === 'all' || scope === 'verifier') this.verifier = undefined
  }
  saveCodeVerifier(value: string): void { this.assertUsable(); this.verifier = value }
  codeVerifier(): string {
    this.assertUsable()
    if (!this.verifier) throw new Error('MCP authorization verifier is no longer available. Connect again.')
    return this.verifier
  }
  async redirectToAuthorization(url: URL): Promise<void> {
    this.assertUsable()
    if (!this.callback?.isPending()) throw new McpReauthorizationRequiredError('MCP authorization needs a new connection. Connect again.')
    await shell.openExternal(url.toString())
  }
  async prepareForAuth(): Promise<void> {
    this.cleanup()
    this.assertUsable()
    const state = randomBytes(32).toString('hex')
    const registered = (this.stored.clientInfo as { redirect_uris?: string[] } | undefined)?.redirect_uris?.[0]
    let port = 0
    if (registered) {
      try {
        const url = new URL(registered)
        if (url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.pathname === '/oauth/callback') port = Number(url.port)
      } catch { /* Legacy registration: bind a fresh callback. */ }
    }
    let listener: OAuthCallbackListener
    try { listener = await startOAuthCallback(state, undefined, port) }
    catch (error) {
      if (!port || (error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error
      this.invalidateCredentials('client')
      this.invalidateCredentials('tokens')
      listener = await startOAuthCallback(state)
    }
    try { this.assertUsable() } catch (error) { listener.abort(); throw error }
    this.expectedState = state
    this.callback = listener
    this.redirect = listener.redirectUrl
  }
  async waitForAuthCode(): Promise<URLSearchParams> {
    const callback = this.callback
    if (!callback) throw new Error('MCP authorization is not prepared.')
    const result = await callback.promise
    this.assertUsable()
    if (callback !== this.callback || result.state !== this.expectedState) throw new Error('MCP authorization was superseded.')
    // Token exchange still needs the verifier/redirect, but this listener is consumed.
    this.callback = undefined
    return result.searchParams
  }
  cleanup(): void {
    this.callback?.abort()
    this.callback = undefined
    this.expectedState = undefined
    this.verifier = undefined
  }
}
