import { createServer, type RequestListener } from 'node:http'
import type { AddressInfo } from 'node:net'
import { gzipSync } from 'node:zlib'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const resolveProxy = vi.hoisted(() => vi.fn(async () => 'DIRECT'))
vi.mock('electron', () => ({ session: { defaultSession: { resolveProxy } } }))
const { cinnaWriteFetch } = await import('./cinnaWriteFetch')
const servers: ReturnType<typeof createServer>[] = []
beforeEach(() => { resolveProxy.mockReset().mockResolvedValue('DIRECT') })
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve())
    server.closeAllConnections()
  })))
})
async function listen(handler: RequestListener): Promise<string> {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}
function write(url: string, extra: Partial<Parameters<typeof cinnaWriteFetch>[1]> = {}): Promise<Response> {
  return cinnaWriteFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    signal: AbortSignal.timeout(1500), ...extra })
}
it('preserves compressed error JSON and supports empty DELETE responses', async () => {
  const bodies: string[] = []
  const url = await listen(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    bodies.push(Buffer.concat(chunks).toString())
    if (req.method === 'DELETE') { res.writeHead(204); res.end(); return }
    res.writeHead(400, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' })
    res.end(gzipSync('{"detail":"Rejected"}'))
  })
  const response = await write(url)
  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({ detail: 'Rejected' })
  expect((await write(url, { method: 'DELETE', body: undefined })).status).toBe(204)
  expect(bodies).toEqual(['{}', ''])
})
it('never replays a lost POST and leaves subsequent requests healthy', async () => {
  let calls = 0
  const url = await listen(async (req, res) => {
    for await (const _chunk of req) { /* consume the accepted mutation */ }
    calls++
    if (calls === 1) { res.destroy(); return }
    res.end('{"ok":true}')
  })
  await expect(write(url)).rejects.toThrow()
  expect(calls).toBe(1)
  expect(await (await write(url)).json()).toEqual({ ok: true })
  expect(calls).toBe(2)
})
it('does not follow a redirect or dispatch after credential invalidation', async () => {
  let calls = 0
  const url = await listen((_req, res) => { calls++; res.writeHead(307, { Location: '/other' }); res.end() })
  await expect(write(url)).rejects.toThrow('redirect refused')
  expect(calls).toBe(1)
  await expect(write(url, { beforeDispatch: () => { throw new Error('session replaced') } })).rejects.toThrow('session replaced')
  expect(calls).toBe(1)
})
it('applies the deadline to stalled response bodies', async () => {
  let started!: () => void
  const ready = new Promise<void>((resolve) => { started = resolve })
  const url = await listen((_req, res) => { res.writeHead(200); res.write('{'); started() })
  const controller = new AbortController()
  const pending = write(url, { signal: controller.signal })
  const rejected = expect(pending).rejects.toThrow()
  await ready
  controller.abort(new Error('deadline'))
  await rejected
})
it('bounds proxy resolution and refuses unsupported routing without dispatch', async () => {
  resolveProxy.mockReturnValueOnce(new Promise(() => {}))
  const controller = new AbortController()
  const pending = write('https://service.test/write', { signal: controller.signal })
  controller.abort(new Error('deadline'))
  await expect(pending).rejects.toMatchObject({ code: 'request_not_sent' })
  resolveProxy.mockResolvedValueOnce('SOCKS localhost:1080; DIRECT')
  await expect(write('https://service.test/write')).rejects.toMatchObject({ code: 'request_not_sent' })
})
it('uses the resolved HTTP proxy with the same mutation and bearer header', async () => {
  const received: unknown[] = []
  const proxy = await listen(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    received.push([req.url, req.headers.authorization, Buffer.concat(chunks).toString()])
    res.end('{"ok":true}')
  })
  resolveProxy.mockResolvedValue(`PROXY ${new URL(proxy).host}`)
  expect(await (await write('http://service.invalid/write', { headers: { Authorization: 'Bearer test-only' } })).json()).toEqual({ ok: true })
  expect(received).toEqual([['http://service.invalid/write', 'Bearer test-only', '{}']])
})
