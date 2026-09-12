import http from 'node:http'

const CALLBACK_HTML = `<!DOCTYPE html><html><head><title>Return to Cinna</title></head>
<body><h1>Return to Cinna</h1><p>Continue in the app to check the authorization result. You can close this tab.</p></body></html>`

export interface OAuthCallbackResult {
  code: string
  state: string
  params: Record<string, string>
  /** Preserve issuer and all callback parameters for the SDK's validation. */
  searchParams: URLSearchParams
}
export interface OAuthCallbackListener {
  promise: Promise<OAuthCallbackResult>
  redirectUrl: string
  abort: () => void
  isPending: () => boolean
}

/** Bind once to an OS-selected loopback port before handing out its redirect URL. */
export async function startOAuthCallback(expectedState: string, timeoutMs = 120_000): Promise<OAuthCallbackListener> {
  let resolve!: (result: OAuthCallbackResult) => void
  let reject!: (error: Error) => void
  const promise = new Promise<OAuthCallbackResult>((yes, no) => { resolve = yes; reject = no })
  // Cleanup can precede the caller awaiting authorization (e.g. a public MCP server).
  void promise.catch(() => {})
  let settled = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let redirectUrl = ''
  const finish = (error?: Error, result?: OAuthCallbackResult): void => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    server.close()
    server.closeAllConnections()
    if (error) reject(error)
    else if (result) resolve(result)
  }
  const server = http.createServer((req, res) => {
    let url: URL
    try { url = new URL(req.url ?? '/', redirectUrl) } catch {
      res.writeHead(400); res.end('Invalid request'); return
    }
    if (req.method !== 'GET' || url.pathname !== '/oauth/callback' || req.headers.host !== new URL(redirectUrl).host) {
      res.writeHead(404); res.end('Not found'); return
    }
    const params = url.searchParams
    const valid = params.getAll('state').length === 1 && params.get('state') === expectedState &&
      params.getAll('code').length <= 1 && params.getAll('iss').length <= 1
    res.writeHead(valid ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'" })
    // No callback-controlled HTML and no success claim before token exchange.
    res.end(CALLBACK_HTML, () => {
      if (!valid) { finish(new Error('OAuth callback state or parameters did not match this connection.')); return }
      finish(undefined, { code: params.get('code') ?? '', state: expectedState,
        params: Object.fromEntries(params), searchParams: new URLSearchParams(params) })
    })
  })
  await new Promise<void>((yes, no) => {
    server.once('error', no)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', no)
      const address = server.address()
      if (!address || typeof address === 'string') { server.close(); no(new Error('Could not bind OAuth callback')); return }
      redirectUrl = `http://127.0.0.1:${address.port}/oauth/callback`
      yes()
    })
  })
  server.on('error', (error) => finish(error))
  timer = setTimeout(() => finish(new Error('OAuth callback timed out')), timeoutMs)
  return { promise, redirectUrl, isPending: () => !settled, abort: () => finish(new Error('OAuth flow aborted')) }
}
