import http from 'node:http'
import { URL } from 'node:url'

const SUCCESS_HTML = `<!DOCTYPE html>
<html><head><title>Authorization Complete</title>
<style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0f0f0f;color:#e0e0e0}
.box{text-align:center}.check{font-size:48px;margin-bottom:16px}h1{font-size:20px;margin:0 0 8px}p{color:#999;font-size:14px}</style>
</head><body><div class="box"><div class="check">&#10003;</div><h1>Authorization successful</h1><p>You can close this tab and return to Cinna.</p></div></body></html>`

const ERROR_HTML = (msg: string): string => `<!DOCTYPE html>
<html><head><title>Authorization Failed</title>
<style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0f0f0f;color:#e0e0e0}
.box{text-align:center}h1{font-size:20px;margin:0 0 8px;color:#ef4444}p{color:#999;font-size:14px}</style>
</head><body><div class="box"><h1>Authorization failed</h1><p>${msg}</p></div></body></html>`

export interface OAuthCallbackResult {
  code: string
  state?: string
  /** All query parameters from the callback URL (for extracting extra data like client_id) */
  params: Record<string, string>
}

/**
 * Starts a temporary local HTTP server to receive the OAuth authorization callback.
 * Returns a promise that resolves with the auth code when the callback is received.
 * The server is automatically shut down after receiving the callback or on timeout.
 */
export function waitForOAuthCallback(port: number, timeoutMs = 120_000): {
  promise: Promise<OAuthCallbackResult>
  redirectUrl: string
  abort: () => void
} {
  let resolve: (result: OAuthCallbackResult) => void
  let reject: (err: Error) => void
  const promise = new Promise<OAuthCallbackResult>((res, rej) => {
    resolve = res
    reject = rej
  })

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)

    if (url.pathname !== '/oauth/callback') {
      res.writeHead(404)
      res.end('Not found')
      return
    }

    const code = url.searchParams.get('code')
    const error = url.searchParams.get('error')
    const errorDescription = url.searchParams.get('error_description')
    const state = url.searchParams.get('state') ?? undefined

    if (error) {
      res.writeHead(400, { 'Content-Type': 'text/html' })
      res.end(ERROR_HTML(errorDescription || error))
      cleanup()
      reject(new Error(`OAuth error: ${error} - ${errorDescription || ''}`))
      return
    }

    if (!code) {
      res.writeHead(400, { 'Content-Type': 'text/html' })
      res.end(ERROR_HTML('Missing authorization code'))
      cleanup()
      reject(new Error('OAuth callback missing authorization code'))
      return
    }

    const params: Record<string, string> = {}
    for (const [k, v] of url.searchParams.entries()) {
      params[k] = v
    }

    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(SUCCESS_HTML)
    cleanup()
    resolve({ code, state, params })
  })

  const timeout = setTimeout(() => {
    cleanup()
    reject(new Error('OAuth callback timed out'))
  }, timeoutMs)

  function cleanup(): void {
    clearTimeout(timeout)
    server.close()
  }

  server.listen(port, '127.0.0.1')

  return {
    promise,
    redirectUrl: `http://127.0.0.1:${port}/oauth/callback`,
    abort: () => {
      cleanup()
      reject(new Error('OAuth flow aborted'))
    }
  }
}

/**
 * Find an available port for the OAuth callback server.
 */
export function findAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = http.createServer()
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (addr && typeof addr === 'object') {
        const port = addr.port
        server.close(() => resolve(port))
      } else {
        server.close(() => reject(new Error('Could not find available port')))
      }
    })
    server.on('error', reject)
  })
}
