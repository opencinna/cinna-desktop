/**
 * Test support for the GitHub service: a scripted fake GitHub (web + API), an in-memory store with a
 * fake keystore whose sealing can be held, and a logger that records every call. No network.
 */
import { vi } from 'vitest'
import { createGithubAuthService, type GithubProfileAccess } from '../githubAuthService'
import type { ScopedLogger } from '../../../logger/logger'

export const WEB = 'https://github.test'
export const API = 'https://api.github.test'

export interface FakeRequest { url: string; method: string; form: URLSearchParams | null; auth: string | null }
type Reply = { status?: number; json?: unknown; headers?: Record<string, string> } | Error

export function fakeGithub() {
  const requests: FakeRequest[] = []
  /** Scripted answers per path (without query), consumed in order; the last one repeats. */
  const script = new Map<string, Reply[]>()
  const fetch = vi.fn(async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input)
    const form = typeof init?.body === 'string' ? new URLSearchParams(init.body) : null
    const headers = (init?.headers ?? {}) as Record<string, string>
    requests.push({ url: input, method: init?.method ?? 'GET', form, auth: headers.Authorization ?? null })
    const key = `${url.origin}${url.pathname}${url.pathname.endsWith('/installations') || url.pathname.endsWith('/repositories') ? url.search : ''}`
    const replies = script.get(key) ?? script.get(`${url.origin}${url.pathname}`)
    if (!replies?.length) return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 })
    const reply = replies.length > 1 ? replies.shift()! : replies[0]
    if (reply instanceof Error) throw reply
    return new Response(JSON.stringify(reply.json ?? {}), { status: reply.status ?? 200, headers: { 'content-type': 'application/json', ...reply.headers } })
  })
  return {
    fetch, requests,
    on(path: string, ...replies: Reply[]) { script.set(path.startsWith('http') ? path : `${path.startsWith('/user') ? API : WEB}${path}`, replies) },
    count(pathPart: string) { return requests.filter(r => r.url.includes(pathPart)).length }
  }
}

export function fakeStore() {
  const rows = new Map<string, string>()
  const log: string[] = []
  let gate: Promise<void> | null = null
  return {
    rows, log,
    store: { read: (u: string) => rows.get(u) ?? null, write: (u: string, v: string) => { log.push(`write:${u}`); rows.set(u, v) }, remove: (u: string) => { log.push(`remove:${u}`); rows.delete(u) } },
    keystore: {
      secure: () => true,
      encrypt: async (text: string) => { if (gate) await gate; return `sealed:${Buffer.from(text).toString('base64')}` },
      decrypt: async (sealed: string) => Buffer.from(sealed.slice('sealed:'.length), 'base64').toString()
    },
    /** Hold every encrypt until the returned release is called. */
    hold(): () => void { let release!: () => void; gate = new Promise(r => { release = () => { gate = null; r() } }); return release },
    record(userId: string) { const v = rows.get(userId); return v ? JSON.parse(Buffer.from(v.slice('sealed:'.length), 'base64').toString()) : null },
    seed(userId: string, record: Record<string, unknown>) { rows.set(userId, `sealed:${Buffer.from(JSON.stringify(record)).toString('base64')}`) }
  }
}

export function spyLogger() {
  const calls: unknown[][] = []
  const logger: ScopedLogger = {
    debug: (...a) => { calls.push(a) }, info: (...a) => { calls.push(a) }, warn: (...a) => { calls.push(a) }, error: (...a) => { calls.push(a) },
    isDebugEnabled: () => true
  }
  return { logger, text: () => JSON.stringify(calls) }
}

export function makeService(options: { now?: () => number; access?: GithubProfileAccess } = {}) {
  const github = fakeGithub(), storage = fakeStore(), log = spyLogger()
  const published: { userId: string; stored: boolean }[] = []
  const waits: number[] = []
  const service = createGithubAuthService({
    fetch: github.fetch, store: storage.store, keystore: storage.keystore, logger: log.logger,
    publish: userId => { published.push({ userId, stored: storage.rows.has(userId) }) },
    now: options.now, wait: async ms => { waits.push(ms); await new Promise(r => setImmediate(r)) }
  })
  if (options.access) service.installProfileAccess(options.access)
  return { service, github, storage, log, published, waits }
}

export const connected = (over: Record<string, unknown> = {}) => ({
  accessToken: 'ghu_access_OLD_0000000000', expiresAt: Date.now() + 8 * 3600_000, refreshToken: 'ghr_refresh_OLD_000000000', refreshExpiresAt: Date.now() + 180 * 86400_000,
  login: 'alice', id: 42, name: 'Alice "A" Doe', email: '42+alice@users.noreply.github.com', state: 'connected', ...over
})
