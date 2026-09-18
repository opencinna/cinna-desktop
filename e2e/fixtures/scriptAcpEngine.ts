import { chmodSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { repoRoot } from '../playwright.config'
import type { CustomAgentConfig } from '../../src/shared/customAgents'
import type { CinnaApp } from './app'

export const SCRIPT_MODEL = 'qwen3:8b'
/**
 * What a released prompt sends: `updates` are bare `session/update` payloads
 * (or `{ sessionId, update }` for a frame under another session, such as a
 * Claude subagent's child) sent in order before `text`; `after` makes the agent
 * ask for more once the prompt has returned (see {@link ScriptAcpHeld}); `more`
 * sends the updates and keeps the prompt open, held in `mores[i]` until the
 * next stage of the same turn is released (`text` and `after` wait for the last).
 */
export interface ScriptAcpReply {
  text?: string
  updates?: Record<string, unknown>[]
  after?: boolean
  more?: boolean
}
/** A held request other than a prompt: `/after` (traffic between turns), `/more` (the next stage of a held prompt) or `/stop` (`_session/async_task/stop`). */
export interface ScriptAcpHeld {
  params: Record<string, unknown>
  closed: boolean
  released: boolean
  release(body: Record<string, unknown>): void
}
export interface ScriptAcpCall {
  cwd: string
  pid: number
  sessionId: string
  text: string
  closed: boolean
  released: boolean
  release(reply: string | ScriptAcpReply): void
}
/** Real launcher/ACP IPC; only the remote agent's deterministic behavior is scripted. */
export async function scriptAcpEngine() {
  const calls: ScriptAcpCall[] = []
  const unexpected: string[] = []
  /** `initialize` params, one per process start (the client's advertised capabilities). */
  const inits: Record<string, unknown>[] = []
  const afters: ScriptAcpHeld[] = []
  const stops: ScriptAcpHeld[] = []
  const mores: ScriptAcpHeld[] = []
  const pending = new Set<ServerResponse>()
  const server = createServer((req, res) => {
    const send = (body: unknown): void => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)) }
    if (req.url === '/api/tags') { send({ models: [{ name: SCRIPT_MODEL, model: SCRIPT_MODEL, details: { family: 'qwen3', parameter_size: '8.2B' } }] }); return }
    if (req.url === '/api/version') { send({ version: '0.6.2' }); return }
    const routes = ['/prompt', '/initialize', '/after', '/more', '/stop']
    if (req.method !== 'POST' || !routes.includes(req.url ?? '')) {
      unexpected.push(`${req.method} ${req.url}`); res.statusCode = 404; send({}); return
    }
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      if (req.url === '/initialize') { inits.push(JSON.parse(raw)); send({}); return }
      if (req.url === '/after' || req.url === '/more' || req.url === '/stop') {
        const held: ScriptAcpHeld = { params: JSON.parse(raw), closed: false, released: false,
          release(reply) { if (held.closed || held.released) throw new Error(`${req.url} is no longer held`); held.released = true; send(reply) } }
        pending.add(res)
        res.on('close', () => { held.closed = true; pending.delete(res) })
        ;(req.url === '/after' ? afters : req.url === '/more' ? mores : stops).push(held)
        return
      }
      const body = JSON.parse(raw) as { cwd: string; pid: number; sessionId: string; prompt: { type: string; text?: string }[] }
      const call: ScriptAcpCall = { cwd: body.cwd, pid: body.pid, sessionId: body.sessionId,
        text: body.prompt.filter((part) => part.type === 'text').map((part) => part.text ?? '').join(''),
        closed: false, released: false,
        release(text) { if (call.closed || call.released) throw new Error('ACP prompt is no longer held'); call.released = true; send(typeof text === 'string' ? { text } : text) } }
      pending.add(res)
      res.on('close', () => { call.closed = true; pending.delete(res) })
      calls.push(call)
    })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    host, calls, unexpected, inits, afters, mores, stops,
    /**
     * The same agent as a command-line ACP agent (`customAgents.save`): no
     * engine setting and no credential, and the custom launcher's own
     * `clientCapabilities`. Runs in `<sandbox>/script-acp-cwd`.
     */
    customConfig(cinna: CinnaApp): CustomAgentConfig {
      const dir = join(cinna.sandbox.root, 'script-acp-cwd')
      mkdirSync(dir, { recursive: true })
      const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
      const cwd = realpathSync(dir)
      return { launcher: 'custom', cwd, localCwd: cwd,
        command: ['/bin/sh', '-c', `export SCRIPT_ACP_CONTROLLER=${quote(host)}; exec "$@"`, 'script-acp',
          process.execPath, join(repoRoot, 'e2e/fixtures/scriptAcpAgent.mjs')] }
    },
    async install(cinna: CinnaApp): Promise<void> {
      const shim = join(cinna.sandbox.root, 'script-fake-opencode')
      const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
      writeFileSync(shim, ['#!/bin/sh', 'if [ "$1" = "--version" ]; then echo "1.18.27-e2e-fake"; exit 0; fi',
        `export SCRIPT_ACP_CONTROLLER=${quote(host)}`,
        `exec ${quote(process.execPath)} ${quote(join(repoRoot, 'e2e/fixtures/scriptAcpAgent.mjs'))} "$@"`, ''].join('\n'))
      chmodSync(shim, 0o755)
      await cinna.page.evaluate((path) => window.api.settings.set('localAgentsEnginePath', path), shim)
    },
    async close(): Promise<void> {
      pending.forEach((res) => res.destroy())
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}
export type ScriptAcpEngine = Awaited<ReturnType<typeof scriptAcpEngine>>
