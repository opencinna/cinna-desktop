import { shell } from 'electron'
import type {
  OAuthClientMetadata,
  OAuthClientInformationMixed,
  OAuthTokens
} from '@modelcontextprotocol/sdk/shared/auth.js'
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import { findAvailablePort, waitForOAuthCallback } from './oauth-callback'

export interface OAuthStoredState {
  clientInfo?: OAuthClientInformationMixed
  tokens?: OAuthTokens
}

export interface OAuthProviderCallbacks {
  onTokens: (tokens: OAuthTokens) => void
  onClientInfo: (clientInfo: OAuthClientInformationMixed) => void
}

/**
 * OAuthClientProvider implementation for Electron desktop app.
 * Handles DCR, token persistence, and browser-based authorization.
 */
export class ElectronOAuthProvider implements OAuthClientProvider {
  private _redirectUrl: string | undefined
  private _codeVerifier: string | undefined
  private _callbackAbort: (() => void) | undefined
  private _authCodePromise: Promise<string> | undefined
  private _storedState: OAuthStoredState
  private _callbacks: OAuthProviderCallbacks

  constructor(storedState: OAuthStoredState, callbacks: OAuthProviderCallbacks) {
    this._storedState = storedState
    this._callbacks = callbacks
  }

  get redirectUrl(): string | URL | undefined {
    return this._redirectUrl
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: this._redirectUrl ? [this._redirectUrl] : [],
      client_name: 'Cinna Desktop',
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code']
    }
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this._storedState.clientInfo
  }

  saveClientInformation(clientInfo: OAuthClientInformationMixed): void {
    this._storedState.clientInfo = clientInfo
    this._callbacks.onClientInfo(clientInfo)
  }

  tokens(): OAuthTokens | undefined {
    return this._storedState.tokens
  }

  saveTokens(tokens: OAuthTokens): void {
    this._storedState.tokens = tokens
    this._callbacks.onTokens(tokens)
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    await shell.openExternal(authorizationUrl.toString())
  }

  saveCodeVerifier(codeVerifier: string): void {
    this._codeVerifier = codeVerifier
  }

  codeVerifier(): string {
    return this._codeVerifier ?? ''
  }

  /**
   * Prepares for the OAuth flow by starting the callback server.
   * Must be called before connecting.
   */
  async prepareForAuth(): Promise<void> {
    if (this._callbackAbort) {
      this._callbackAbort()
    }

    const port = await findAvailablePort()
    this._redirectUrl = `http://127.0.0.1:${port}/oauth/callback`
    const { promise, abort } = waitForOAuthCallback(port)
    this._callbackAbort = abort
    const codePromise = promise.then((result) => result.code)
    // Prevent unhandled rejection if cleanup aborts before anyone awaits
    codePromise.catch(() => {})
    this._authCodePromise = codePromise
  }

  /**
   * Waits for the OAuth callback and returns the authorization code.
   */
  async waitForAuthCode(): Promise<string> {
    if (!this._authCodePromise) {
      throw new Error('OAuth flow not prepared - call prepareForAuth() first')
    }
    return this._authCodePromise
  }

  cleanup(): void {
    if (this._callbackAbort) {
      this._callbackAbort()
      this._callbackAbort = undefined
    }
    this._authCodePromise = undefined
  }
}
