import { chmodSync, writeFileSync } from 'node:fs'
import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { repoRoot } from '../playwright.config'
import type { CinnaApp } from './app'

export const SCRIPT_MODEL = 'qwen3:8b'
export interface ScriptAcpCall {
  cwd: string
  pid: number
  sessionId: string
  text: string
  closed: boolean
  released: boolean
  release(text: string): void
}
/** Real launcher/ACP IPC; only the remote agent's deterministic behavior is scripted. */
export async function scriptAcpEngine() {
  const calls: ScriptAcpCall[] = []
  const unexpected: string[] = []
  const pending = new Set<ServerResponse>()
  const server = createServer((req, res) => {
    const send = (body: unknown): void => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)) }
    if (req.url === '/api/tags') { send({ models: [{ name: SCRIPT_MODEL, model: SCRIPT_MODEL, details: { family: 'qwen3', parameter_size: '8.2B' } }] }); return }
    if (req.url === '/api/version') { send({ version: '0.6.2' }); return }
    if (req.method !== 'POST' || req.url !== '/prompt') {
      unexpected.push(`${req.method} ${req.url}`); res.statusCode = 404; send({}); return
    }
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      const body = JSON.parse(raw) as { cwd: string; pid: number; sessionId: string; prompt: { type: string; text?: string }[] }
      const call: ScriptAcpCall = { cwd: body.cwd, pid: body.pid, sessionId: body.sessionId,
        text: body.prompt.filter((part) => part.type === 'text').map((part) => part.text ?? '').join(''),
        closed: false, released: false,
        release(text) { if (call.closed || call.released) throw new Error('ACP prompt is no longer held'); call.released = true; send({ text }) } }
      pending.add(res)
      res.on('close', () => { call.closed = true; pending.delete(res) })
      calls.push(call)
    })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    host, calls, unexpected,
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
