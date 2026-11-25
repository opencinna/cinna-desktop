import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TLSSocket } from 'node:tls'
import type { AddressInfo } from 'node:net'

/**
 * `https://github.com/<owner>/<repo>.git` served from bare repositories on this machine, for
 * git's own credential path (`credential.https://github.com.helper` → the wrapper's
 * `gh auth git-credential get` → `/github/token` with `via: "git"`).
 *
 * The helper Cinna wires is keyed on `https://github.com`, so the remote really has to be that
 * URL: a loopback origin would not reach the helper at all. The child's git reaches it through
 * an HTTP proxy the command names itself (`git -c http.proxy=<proxy> -c http.sslVerify=false`):
 * the proxy accepts `CONNECT github.com:443` only (any other host is refused, so nothing goes to
 * the real GitHub), terminates TLS with a throwaway self-signed certificate made by `openssl`,
 * and answers git's smart-HTTP requests with `git http-backend` as a CGI. Every request must
 * carry Basic `x-access-token:<token>` — the form the wrapper hands git — or it gets 401 and a
 * `WWW-Authenticate` challenge, which is what makes git ask its credential helper.
 *
 * Not real: DNS and TLS for github.com (the proxy and an unverified certificate stand in), and
 * GitHub's own authorization (any request with the token is allowed, on any repository).
 */
export interface FakeGitRemote {
  /** `http://127.0.0.1:<port>`, for `http.proxy`. */
  proxy: string
  /** Every `CONNECT` target asked of the proxy, in order. */
  connects: string[]
  /** Every smart-HTTP request (path with query) and whether it carried the expected token. */
  requests: { method: string; path: string; authorized: boolean; auth: string | null }[]
  /** Make an empty bare repository for `owner/repo`. */
  createBare(repo: string): void
  /** `git log --format=%s` of `ref` in the bare `owner/repo` ('' when the ref does not exist). */
  subjects(repo: string, ref: string): string
  reset(): void
  close(): Promise<void>
}

/** git run by this process, never reading the developer's global or system config. */
const gitEnv = (home: string): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null'
})

async function readAll(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

/** Run `git http-backend` as a CGI for one request and relay its answer. */
function cgi(root: string, req: IncomingMessage, res: ServerResponse, body: Buffer, user: string): void {
  const url = new URL(req.url ?? '/', 'https://github.com')
  const env: NodeJS.ProcessEnv = {
    ...gitEnv(root),
    GIT_PROJECT_ROOT: root,
    GIT_HTTP_EXPORT_ALL: '1',
    REMOTE_USER: user,
    REMOTE_ADDR: '127.0.0.1',
    REQUEST_METHOD: req.method ?? 'GET',
    PATH_INFO: decodeURIComponent(url.pathname),
    QUERY_STRING: url.search.replace(/^\?/, ''),
    CONTENT_TYPE: req.headers['content-type'] ?? '',
    CONTENT_LENGTH: String(body.length),
    ...(req.headers['content-encoding'] ? { HTTP_CONTENT_ENCODING: String(req.headers['content-encoding']) } : {}),
    ...(req.headers['git-protocol'] ? { GIT_PROTOCOL: String(req.headers['git-protocol']) } : {})
  }
  const child = spawn('git', ['http-backend'], { env })
  const out: Buffer[] = []
  child.stdout.on('data', (chunk: Buffer) => out.push(chunk))
  child.stderr.on('data', () => undefined)
  child.on('close', () => {
    const all = Buffer.concat(out)
    const split = all.indexOf('\r\n\r\n')
    const head = split >= 0 ? all.subarray(0, split).toString() : ''
    const rest = split >= 0 ? all.subarray(split + 4) : all
    let status = 200
    const headers: Record<string, string> = {}
    for (const line of head.split('\r\n')) {
      const colon = line.indexOf(':')
      if (colon < 0) continue
      const name = line.slice(0, colon).trim(), value = line.slice(colon + 1).trim()
      if (name.toLowerCase() === 'status') status = Number.parseInt(value, 10) || 200
      else headers[name] = value
    }
    res.writeHead(status, headers)
    res.end(rest)
  })
  child.stdin.end(body)
}

export async function startFakeGitRemote(token: string): Promise<FakeGitRemote> {
  const dir = mkdtempSync(join(tmpdir(), 'cinna-e2e-git-remote-'))
  const root = join(dir, 'repos')
  mkdirSync(root)
  const keyPath = join(dir, 'key.pem'), certPath = join(dir, 'cert.pem')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath,
    '-subj', '/CN=github.com', '-days', '1'], { stdio: 'ignore' })
  const key = readFileSync(keyPath), cert = readFileSync(certPath)
  const expected = `Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`
  const connects: string[] = []
  const requests: FakeGitRemote['requests'] = []

  // Never listens: the proxy hands it each decrypted CONNECT tunnel.
  const git: Server = createServer((req, res) => {
    void (async () => {
      const auth = req.headers.authorization ?? null
      const authorized = auth === expected
      requests.push({ method: req.method ?? 'GET', path: req.url ?? '/', authorized, auth })
      const body = await readAll(req)
      if (!authorized) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="GitHub"', 'content-type': 'text/plain' })
        res.end('Authentication required\n')
        return
      }
      cgi(root, req, res, body, 'x-access-token')
    })()
  })

  const proxy: Server = createServer((_req, res) => {
    res.writeHead(403)
    res.end()
  })
  const tunnels = new Set<{ destroy(): void }>()
  proxy.on('connect', (req: IncomingMessage, socket, head: Buffer) => {
    connects.push(req.url ?? '')
    tunnels.add(socket)
    socket.on('close', () => tunnels.delete(socket))
    if (req.url !== 'github.com:443') {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
      return
    }
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    if (head.length) socket.unshift(head)
    const tls = new TLSSocket(socket, { isServer: true, key, cert })
    tls.on('error', () => undefined)
    git.emit('connection', tls)
  })
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`

  return {
    proxy: origin,
    connects,
    requests,
    createBare(repo) {
      const path = join(root, `${repo}.git`)
      mkdirSync(path, { recursive: true })
      execFileSync('git', ['init', '--bare', '--quiet', '--initial-branch=main', path], { env: gitEnv(dir), stdio: 'ignore' })
    },
    subjects(repo, ref) {
      try {
        return execFileSync('git', ['--git-dir', join(root, `${repo}.git`), 'log', '--format=%s', ref], { env: gitEnv(dir), stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
      } catch {
        return ''
      }
    },
    reset() {
      connects.length = 0
      requests.length = 0
      rmSync(root, { recursive: true, force: true })
      mkdirSync(root)
    },
    async close() {
      for (const socket of tunnels) socket.destroy()
      proxy.closeAllConnections()
      await new Promise<void>((resolve) => proxy.close(() => resolve()))
      git.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }
}
