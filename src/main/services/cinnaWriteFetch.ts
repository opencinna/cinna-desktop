import { runtimeHost } from '../host/runtimeHost'
import { STATUS_CODES } from 'node:http'
import { getCACertificates } from 'node:tls'
import { Agent, ProxyAgent, interceptors, type Dispatcher } from 'undici'
import { CinnaApiError } from '../errors'

let certificates: string[] | undefined
function trustedCertificates(): string[] {
  return certificates ??= [...new Set([...getCACertificates('default'), ...getCACertificates('system')])]
}

async function proxyFor(url: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted()
  let abort!: () => void
  try {
    return await Promise.race([
      runtimeHost.resolveProxy(url),
      new Promise<never>((_, reject) => {
        signal.throwIfAborted()
        abort = () => reject(signal.reason)
        signal.addEventListener('abort', abort, { once: true })
      })
    ])
  } finally { if (abort) signal.removeEventListener('abort', abort) }
}

function dispatcherFor(proxy: string): Dispatcher {
  // Honor Chromium's first PAC/system route. Never retry a mutation through
  // another proxy or silently bypass an unsupported configured proxy.
  const route = proxy.split(';')[0].trim()
  const tls = { ca: trustedCertificates() }
  if (route === 'DIRECT') return new Agent({ pipelining: 0, connect: tls })
  const match = /^(PROXY|HTTPS)\s+(\S+)$/.exec(route)
  if (!match) throw new Error('The configured proxy type is not supported for Cinna writes.')
  const [, kind, address] = match
  return new ProxyAgent({ uri: `${kind === 'HTTPS' ? 'https' : 'http'}://${address}`,
    pipelining: 0, requestTls: tls, proxyTls: tls })
}

/**
 * Each mutation owns its Node HTTP dispatcher: no pooled replay, redirects or
 * retry interceptors. Electron's buffered writes replay lost POST responses;
 * its one-shot chunked alternative crashes Network Service on that same path.
 * Resolve OS/PAC routing through Electron and trust Node plus system CAs.
 */
export async function cinnaWriteFetch(url: string, init: {
  method: string
  headers: Record<string, string>
  body?: string
  signal: AbortSignal
  beforeDispatch?: () => void
}): Promise<Response> {
  let dispatcher: Dispatcher
  try {
    const proxy = await proxyFor(url, init.signal)
    init.signal.throwIfAborted()
    dispatcher = dispatcherFor(proxy)
  } catch (error) {
    throw new CinnaApiError('request_not_sent', error instanceof Error ? error.message : 'Could not prepare Cinna write.')
  }
  try {
    const target = new URL(url)
    init.beforeDispatch?.()
    init.signal.throwIfAborted()
    const incoming = await dispatcher.compose(interceptors.decompress({ skipErrorResponses: false })).request({ origin: target.origin, path: target.pathname + target.search,
      method: init.method as Dispatcher.HttpMethod, headers: init.headers, body: init.body,
      signal: init.signal, idempotent: false })
    // Complete the body within the same deadline before releasing its transport.
    const bytes = await incoming.body.arrayBuffer()
    if (incoming.statusCode >= 300 && incoming.statusCode < 400) {
      throw new Error('Cinna write redirect refused; check the service URL.')
    }
    const headers = new Headers()
    for (const [key, values] of Object.entries(incoming.headers)) {
      if (values !== undefined) headers.set(key, Array.isArray(values) ? values.join(', ') : values)
    }
    return new Response([204, 205, 304].includes(incoming.statusCode) ? null : bytes, {
      status: incoming.statusCode, statusText: STATUS_CODES[incoming.statusCode] ?? '', headers
    })
  } finally { await dispatcher.destroy() }
}
