/**
 * The store behind *Always allow*, against a real folder.
 *
 * Written against the filesystem rather than a mock because the thing being
 * asserted is that a decision **survives** — the whole reason this store exists
 * is that OpenCode's own does not survive in a form that names one agent. A
 * fake `desktopStateService` would prove the calls were made and nothing about
 * the file that is supposed to outlive the turn.
 *
 * Every mutation named in a comment was run; the table at the bottom records
 * which test each one fails.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

const { permissionGrantService } = await import('./permissionGrantService')
const { desktopStateService } = await import('./desktopStateService')

const ask = (action: string, resources: string[] = []) => ({ action, resources, savable: [] })

let agentDir: string

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), 'cinna-grants-'))
})

afterEach(() => {
  rmSync(agentDir, { recursive: true, force: true })
})

describe('permissionGrantService', () => {
  it('answers no for a folder that has never run', () => {
    // The ask path calls this before any block is written, for a folder that
    // may have no `app-data/` at all. Mutation: let `read` throw on ENOENT —
    // the first permission ask against a fresh agent dies mid-turn.
    expect(permissionGrantService.covers(agentDir, ask('bash', ['ls']))).toBe(false)
    expect(permissionGrantService.list(agentDir)).toEqual([])
  })

  it('remembers a decision and answers the same ask from disk afterwards', () => {
    permissionGrantService.remember(agentDir, ask('webfetch', ['https://docs.example.com/a?v=1']))

    // A *different* URL on the same origin, which is the point of storing the
    // origin: the ask that comes back is never byte-identical to the one that
    // was granted. Mutation: store the resource verbatim fails this.
    expect(
      permissionGrantService.covers(agentDir, ask('webfetch', ['https://docs.example.com/b']))
    ).toBe(true)
    expect(
      permissionGrantService.covers(agentDir, ask('webfetch', ['https://elsewhere.test/b']))
    ).toBe(false)

    // On disk, in the one file the desktop owns inside an agent folder — not in
    // OpenCode's user-global store, which is the entire design.
    const raw = JSON.parse(readFileSync(join(agentDir, 'app-data', 'desktop.json'), 'utf8'))
    expect(raw.permissionGrants).toEqual({
      'webfetch::https://docs.example.com/*': {
        action: 'webfetch',
        pattern: 'https://docs.example.com/*',
        scope: 'origin',
        decidedAt: expect.any(Number)
      }
    })
  })

  it('reads a row with no scope as the narrowest one, not as a wildcard', () => {
    // A row written by another build, or edited by hand, must not be able to
    // widen itself by leaving the field out — this rule answers a permission
    // ask without asking anyone. Mutation: default the scope to `action` (or
    // infer it from the presence of a `*`) fails this.
    mkdirSync(join(agentDir, 'app-data'), { recursive: true })
    writeFileSync(
      join(agentDir, 'app-data', 'desktop.json'),
      JSON.stringify({
        permissionGrants: {
          'bash::rm -rf build/*': { action: 'bash', pattern: 'rm -rf build/*', decidedAt: 1 }
        }
      })
    )

    expect(permissionGrantService.list(agentDir)[0].scope).toBe('exact')
    expect(permissionGrantService.covers(agentDir, ask('bash', ['rm -rf build/*']))).toBe(true)
    expect(
      permissionGrantService.covers(agentDir, ask('bash', ['rm -rf build/../../Documents']))
    ).toBe(false)
  })

  it('keeps a grant per resource, so one can be revoked without the other', () => {
    // Mutation: store one row per *ask* fails this — forgetting the path the
    // user regrets would forget the one they meant to keep.
    permissionGrantService.remember(agentDir, ask('edit', ['a.txt', 'b.txt']))
    const grants = permissionGrantService.list(agentDir)
    expect(grants.map((g) => g.pattern).sort()).toEqual(['a.txt', 'b.txt'])

    permissionGrantService.forget(agentDir, grants.find((g) => g.pattern === 'a.txt')!.key)
    expect(permissionGrantService.covers(agentDir, ask('edit', ['b.txt']))).toBe(true)
    expect(permissionGrantService.covers(agentDir, ask('edit', ['a.txt']))).toBe(false)
  })

  it('leaves everything else in the file alone', () => {
    // `desktop.json` also holds the engine session ids a chat resumes from and
    // the agent's own callback token. Mutation: `write` a fresh state instead
    // of `patch` fails this — remembering a permission would silently end every
    // conversation's continuity and unlink the agent's local API.
    mkdirSync(join(agentDir, 'app-data'), { recursive: true })
    writeFileSync(
      join(agentDir, 'app-data', 'desktop.json'),
      JSON.stringify({
        agentToken: 'tok_1',
        localApiBaseUrl: 'http://127.0.0.1:9',
        sessions: { chat_1: { sessionId: 'ses_1', updatedAt: 5 } }
      })
    )

    permissionGrantService.remember(agentDir, ask('bash', ['make test']))

    const state = desktopStateService.read(agentDir)
    expect(state.agentToken).toBe('tok_1')
    expect(state.sessions.chat_1.sessionId).toBe('ses_1')
    expect(state.permissionGrants['bash::make test'].action).toBe('bash')
  })

  it('drops a row that names no action or pattern rather than showing it', () => {
    // A grant that cannot be matched must not be listed either: the agent page
    // would be offering the user a rule that never fires. This is also the
    // shape an earlier build declared and never wrote (`{granted, scope}`).
    mkdirSync(join(agentDir, 'app-data'), { recursive: true })
    writeFileSync(
      join(agentDir, 'app-data', 'desktop.json'),
      JSON.stringify({
        permissionGrants: {
          legacy: { granted: true, scope: 'always', decidedAt: 1 },
          'bash::ls': { action: 'bash', pattern: 'ls', scope: 'exact', decidedAt: 2 }
        }
      })
    )
    expect(permissionGrantService.list(agentDir).map((g) => g.key)).toEqual(['bash::ls'])
  })

  it('forgets everything on request, and does no write when there is nothing to forget', () => {
    permissionGrantService.remember(agentDir, ask('bash', ['make test']))
    permissionGrantService.forgetAll(agentDir)
    expect(permissionGrantService.list(agentDir)).toEqual([])

    // A folder that never ran must not gain a `desktop.json` because someone
    // opened the permissions card — Invariant 2 is that this file exists only
    // where the desktop actually has state to keep.
    const fresh = mkdtempSync(join(tmpdir(), 'cinna-grants-'))
    try {
      permissionGrantService.forgetAll(fresh)
      expect(() => readFileSync(join(fresh, 'app-data', 'desktop.json'))).toThrow()
    } finally {
      rmSync(fresh, { recursive: true, force: true })
    }
  })
})

/**
 * ## Mutations run, and the test each one fails
 *
 * | Mutation | Fails |
 * |---|---|
 * | `read` rethrows ENOENT | answers no for a folder that has never run |
 * | pattern stored verbatim for a URL | remembers a decision and answers the same ask from disk afterwards |
 * | one row per ask instead of per resource | keeps a grant per resource… |
 * | `write` instead of `patch` | leaves everything else in the file alone |
 * | `coerce` keeps a row with no action/pattern | drops a row that names no action or pattern… |
 * | `forgetAll` patches unconditionally | forgets everything on request… |
 */
