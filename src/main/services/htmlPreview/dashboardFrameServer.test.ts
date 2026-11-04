import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..')
vi.mock('../../host/runtimeHost', () => ({ runtimeHost: { isPackaged: false, resourcesPath: '', getAppPath: () => repoRoot } }))
vi.mock('../../logger/logger', () => ({ createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }) }))

const { createDashboardFrameServer, dashboardFrameCsp } = await import('./dashboardFrameServer')
const { dashboardHelperScript } = await import('./dashboardHelper')
const { DASHBOARDS_BRIDGE_REPO_PATH } = await import('../../kit/dashboardsProtocol')

/** The dash- handler: the one sink a component page can send to. */

let base = ''
let agentDir = ''
let componentDir = ''
let user = 'p1'
let counter = 0

function put(rel: string, content: string, root = componentDir): void {
  const file = join(root, rel)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
}

function server(overrides: { resolve?: () => unknown } = {}) {
  return createDashboardFrameServer({
    currentUserId: () => user,
    resolve: (overrides.resolve as never) ?? (() => ({ agentDir, componentDir, entry: 'index.html', isSecret: (rel: string) => rel.endsWith('secret.json') })),
    newToken: (bytes) => `${bytes === 16 ? 't' : 'x'}${(++counter).toString().padStart(4, '0')}`
  })
}

const get = (s: ReturnType<typeof server>, url: string, method = 'GET') => s.handle({ url, method })

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'dash-frame-'))
  agentDir = join(base, 'agent')
  componentDir = join(agentDir, 'dashboards', 'chart')
  put('index.html', '<!doctype html><html><head><title>c</title></head><body>hi</body></html>')
  put('app.js', 'window.x = 1')
  put('data.json', '{"a":1}')
  put('api/data.mjs', 'console.log("{}")')
  put('.env', 'TOKEN=1')
  put('nested/.hidden.js', 'x')
  put('secret.json', '{}')
  put('credentials.json', '{}')
  put('deploy.pem', 'key')
  put('credentials/.env', 'SECRET=1', agentDir)
  user = 'p1'
  counter = 0
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

describe('dashboardFrameServer', () => {
  it('serves the entry page with the helper after <head>, a path-scoped CSP and the sandboxing headers', async () => {
    const s = server()
    const { url, token } = s.register({ agentId: 'folder:m1', component: 'chart' }, 'index.html')
    expect(url).toMatch(/^cinna-preview:\/\/dash-t\d+\/t\d+\/index\.html$/)
    const host = new URL(url).hostname
    const res = await get(s, url)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html.startsWith('<!doctype html><html><head><script>/*\n * dashboards-bridge.js')).toBe(true)
    expect(html).toContain('<title>c</title>')
    expect(res.headers.get('content-security-policy')).toBe(dashboardFrameCsp(host, token))
    const csp = dashboardFrameCsp(host, token)
    const src = `cinna-preview://${host}/${token}/`
    expect(csp).toContain(`connect-src ${src};`)
    expect(csp).toContain(`script-src ${src} 'unsafe-inline';`)
    expect(csp).toContain("frame-src 'none'")
    expect(csp).toContain("default-src 'none'")
    expect(csp).not.toMatch(/'self'|cinna-preview: |cinna-preview:;/)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('serves its own static files, and answers HEAD with no body', async () => {
    const s = server()
    const { url } = s.register({ agentId: 'folder:m1', component: 'chart' }, 'index.html')
    const js = await get(s, url.replace('index.html', 'app.js?leak=123'))
    expect(js.status).toBe(200)
    expect(js.headers.get('content-type')).toBe('text/javascript')
    expect(await js.text()).toBe('window.x = 1')
    const head = await get(s, url.replace('index.html', 'data.json'), 'HEAD')
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')
  })

  it('answers GET and HEAD only', async () => {
    const s = server()
    const { url } = s.register({ agentId: 'folder:m1', component: 'chart' }, 'index.html')
    for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) expect((await get(s, url, method)).status).toBe(405)
  })

  it('never serves api/, dot segments, credential or secret files, or anything outside the component', async () => {
    const s = server()
    const { url } = s.register({ agentId: 'folder:m1', component: 'chart' }, 'index.html')
    const prefix = url.replace('index.html', '')
    symlinkSync(join(agentDir, 'credentials'), join(componentDir, 'creds'))
    symlinkSync(join(base), join(componentDir, 'up'))
    put('outside.txt', 'nope', base)
    for (const path of ['api/data.mjs', 'API/data.mjs', '.env', 'nested/.hidden.js', '%2e%2e/%2e%2e/credentials/.env', 'a%2Fb', 'secret.json', 'credentials.json', 'deploy.pem', 'creds/.env', 'up/outside.txt', '', 'nested']) {
      expect((await get(s, prefix + path)).status, path).toBe(404)
    }
  })

  it('serves a skill’s component from its folder outside the agent, judging secrets by its agent-relative path', async () => {
    const skillComponent = join(base, 'cache', 'crm', 'dashboards', 'pipeline')
    put('index.html', '<p>pipeline</p>', skillComponent)
    put('chart.js', 'x', skillComponent)
    put('api/data.py', 'x', skillComponent)
    put('vendor.env', 'X=1', skillComponent)
    put('outside.txt', 'nope', join(base, 'cache'))
    symlinkSync(join(base, 'cache'), join(skillComponent, 'up'))
    const judged: string[] = []
    const s = server({
      resolve: () => ({
        agentDir,
        componentDir: skillComponent,
        agentRelDir: 'skills/crm/dashboards/pipeline',
        entry: 'index.html',
        isSecret: (rel: string) => {
          judged.push(rel)
          return rel.endsWith('.env')
        }
      })
    })
    const { url } = s.register({ agentId: 'folder:m1', component: 'pipeline', skill: 'crm' }, 'index.html')
    const prefix = url.replace('index.html', '')
    expect((await get(s, url)).status).toBe(200)
    expect(await (await get(s, prefix + 'chart.js')).text()).toBe('x')
    expect(judged).toEqual(['skills/crm/dashboards/pipeline/index.html', 'skills/crm/dashboards/pipeline/chart.js'])
    for (const path of ['api/data.py', 'vendor.env', 'up/outside.txt']) expect((await get(s, prefix + path)).status, path).toBe(404)
  })

  it('serves nothing to another tile token, another host, or after release', async () => {
    const s = server()
    const a = s.register({ agentId: 'folder:m1', component: 'chart' }, 'index.html')
    const host = new URL(a.url).hostname
    expect((await get(s, `cinna-preview://${host}/t9999/index.html`)).status).toBe(404)
    expect((await get(s, a.url.replace(host, 'dash-other'))).status).toBe(404)
    expect(s.release(a.token)).toBe(true)
    expect((await get(s, a.url)).status).toBe(404)
  })

  it('shares one host per profile, and drops it with every frame when another profile is active', async () => {
    const s = server()
    const a = s.register({ agentId: 'folder:m1', component: 'chart' }, 'index.html')
    const b = s.register({ agentId: 'folder:m1', component: 'chart' }, 'index.html')
    expect(new URL(a.url).hostname).toBe(new URL(b.url).hostname)
    expect(a.token).not.toBe(b.token)
    user = 'p2'
    expect((await get(s, a.url)).status).toBe(404)
    user = 'p1'
    // Dropped for good: switching back does not revive the old host.
    expect((await get(s, a.url)).status).toBe(404)
    const c = s.register({ agentId: 'folder:m1', component: 'chart' }, 'index.html')
    expect(new URL(c.url).hostname).not.toBe(new URL(a.url).hostname)
    expect((await get(s, c.url)).status).toBe(200)
  })

  it('serves nothing once the component is gone', async () => {
    const s = server({ resolve: () => null })
    const { url } = s.register({ agentId: 'folder:m1', component: 'chart' }, 'index.html')
    expect((await get(s, url)).status).toBe(404)
  })

  it('injects the kit bridge byte for byte, which cannot close its own script tag', async () => {
    const { readFileSync } = await import('node:fs')
    const script = dashboardHelperScript()
    expect(script).toBe(readFileSync(join(repoRoot, DASHBOARDS_BRIDGE_REPO_PATH), 'utf8'))
    expect(script).not.toMatch(/<\//)
    const s = server()
    const { url } = s.register({ agentId: 'folder:m1', component: 'chart' }, 'index.html')
    const html = await (await get(s, url)).text()
    expect(html).toContain(`<head><script>${script}</script><title>`)
  })
})

describe('dashboardFrameServer: a cloud frame (D6.3)', () => {
  function remote(answer?: (segments: string[], method: string) => Awaited<ReturnType<import('./dashboardFrameServer').RemoteFrameSource['file']>>) {
    const calls: Array<{ segments: string[]; method: string }> = []
    return {
      calls,
      source: {
        entry: 'app/index.html',
        file: async (segments: string[], method: 'GET' | 'HEAD') => {
          calls.push({ segments, method })
          return answer?.(segments, method) ?? { ok: true as const, contentType: 'text/html; charset=utf-8', body: new TextEncoder().encode('<html><head></head><body>core</body></html>') }
        }
      }
    }
  }

  it('serves core’s bytes and Content-Type under the dash host with the desktop’s own CSP and headers, without a second bridge', async () => {
    const s = server()
    const { source, calls } = remote()
    const { url, token } = s.registerRemote(source)
    expect(url).toMatch(/^cinna-preview:\/\/dash-t\d+\/t\d+\/app\/index\.html$/)
    const res = await get(s, url)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('<html><head></head><body>core</body></html>')
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(res.headers.get('content-security-policy')).toBe(dashboardFrameCsp(new URL(url).hostname, token))
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect([...res.headers.keys()].sort()).toEqual(['access-control-allow-origin', 'cache-control', 'content-security-policy', 'content-type', 'referrer-policy', 'x-content-type-options'])
    expect(calls).toEqual([{ segments: ['app', 'index.html'], method: 'GET' }])
  })

  it('answers GET and HEAD only, HEAD with no body', async () => {
    const s = server()
    const { source, calls } = remote()
    const { url } = s.registerRemote(source)
    for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH']) expect((await get(s, url, method)).status).toBe(405)
    const head = await get(s, url, 'HEAD')
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')
    expect(calls.map((c) => c.method)).toEqual(['HEAD'])
  })

  it('never asks core for api/, dot segments or another tile’s path', async () => {
    const s = server()
    const { source, calls } = remote()
    const { url } = s.registerRemote(source)
    const prefix = url.replace('app/index.html', '')
    for (const path of ['api/data.py', 'API/x', '.env', '%2e%2e/x', 'x/%2e%2e/%2e%2e/y', 'a%2Fb', '']) expect((await get(s, prefix + path)).status, path).toBe(404)
    expect((await get(s, url.replace(/\/t\d+\//, '/t9999/'))).status).toBe(404)
    expect(calls).toEqual([])
  })

  it('passes the relay’s refusal as a status page under the same CSP, and stops serving on release or another profile', async () => {
    const s = server()
    const { source } = remote(() => ({ ok: false, status: 503, message: 'The agent’s environment isn’t running.' }))
    const { url, token } = s.registerRemote(source)
    const res = await get(s, url)
    expect(res.status).toBe(503)
    expect(await res.text()).toBe('The agent’s environment isn’t running.')
    expect(res.headers.get('content-security-policy')).toBe(dashboardFrameCsp(new URL(url).hostname, token))
    s.release(token)
    expect((await get(s, url)).status).toBe(404)
    const again = s.registerRemote(remote().source)
    user = 'p2'
    expect((await get(s, again.url)).status).toBe(404)
  })
})
