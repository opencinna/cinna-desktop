vi.mock('../host/runtimeHost', async () => {
  const { createDesktopHost } = await import('../host/desktop/runtimeHost')
  return { runtimeHost: createDesktopHost() }
})
import { createServer as createHttpServer, type Server } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { connect, type AddressInfo, type Socket } from 'node:net'
import { readFileSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'

const resolveProxy = vi.hoisted(() => vi.fn())
vi.mock('electron', () => ({ session: { defaultSession: { resolveProxy } } }))
vi.mock('node:tls', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:tls')>()
  return { ...original, getCACertificates: (kind: 'default' | 'system') => [
    ...original.getCACertificates(kind),
    readFileSync(new URL('./__fixtures__/cinna-write/localhost-test.pem', import.meta.url), 'utf8')
  ] }
})
const { cinnaWriteFetch } = await import('./cinnaWriteFetch')
// Public fixture identity, used only by loopback tests; never an application key.
const tls = {
  cert: readFileSync(new URL('./__fixtures__/cinna-write/localhost-test.pem', import.meta.url)),
  key: readFileSync(new URL('./__fixtures__/cinna-write/localhost-test.key', import.meta.url))
}
const servers: Server[] = []
const sockets = new Set<Socket>()
afterEach(async () => {
  for (const socket of sockets) socket.destroy()
  sockets.clear()
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})
async function listen(server: Server): Promise<string> {
  servers.push(server)
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return `127.0.0.1:${(server.address() as AddressInfo).port}`
}
function write(url: string): Promise<Response> {
  return cinnaWriteFetch(url, { method: 'POST', headers: { Authorization: 'Bearer fixture' }, body: '{"test":true}',
    signal: AbortSignal.timeout(2000) })
}
it.each(['PROXY', 'HTTPS'])('sends HTTPS through a %s CONNECT tunnel with trusted certificates', async (kind) => {
  const received: unknown[] = []
  const target = await listen(createHttpsServer(tls, async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    received.push([req.url, req.headers.authorization, Buffer.concat(chunks).toString()])
    res.end('{"ok":true}')
  }))
  const connects: string[] = []
  const proxy = kind === 'HTTPS' ? createHttpsServer(tls) : createHttpServer()
  proxy.on('connect', (req, socket, head) => {
    connects.push(req.url!)
    const upstream = connect(Number(target.split(':')[1]), '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) upstream.write(head)
      socket.pipe(upstream).pipe(socket)
    })
    sockets.add(upstream)
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
  })
  resolveProxy.mockResolvedValue(`${kind} ${await listen(proxy)}`)
  expect(await (await write(`https://${target}/execute`)).json()).toEqual({ ok: true })
  expect(connects).toEqual([target])
  expect(received).toEqual([['/execute', 'Bearer fixture', '{"test":true}']])
})
it('refuses proxy authentication without falling back to a direct mutation', async () => {
  let direct = 0
  const target = await listen(createHttpsServer(tls, (_req, res) => { direct++; res.end('{}') }))
  const proxy = createHttpServer()
  let connects = 0
  proxy.on('connect', (_req, socket) => {
    connects++
    socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n')
  })
  resolveProxy.mockResolvedValue(`PROXY ${await listen(proxy)}; DIRECT`)
  await expect(write(`https://${target}/execute`)).rejects.toThrow()
  expect(connects).toBe(1)
  expect(direct).toBe(0)
})
