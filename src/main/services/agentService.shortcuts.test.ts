vi.mock('../host/runtimeHost', async () => {
  const { createDesktopHost } = await import('../host/desktop/runtimeHost')
  return { runtimeHost: createDesktopHost() }
})
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTestDatabase, type TestDatabase } from '../db/testSupport/nodeSqlite'

/**
 * ⌘1–⌘9 bindings, through the service and the real repo on a real database
 * with the production migrations: a digit per agent, an agent per digit, a
 * taken digit moves, each profile keeps its own, and nothing outside 1–9 gets
 * in. See `testSupport/nodeSqlite.ts` for why it is not `better-sqlite3`.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')

vi.mock('electron', () => ({
  net: { fetch: vi.fn() },
  app: { isPackaged: false, getAppPath: () => repoRoot, getVersion: () => '0.0.0-test', on: () => undefined }
}))
vi.mock('../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))
vi.mock('../security/keystore', () => ({ encryptApiKey: vi.fn(), decryptApiKey: vi.fn() }))
vi.mock('../agents/a2a-client', () => ({
  fetchAgentCard: vi.fn(),
  resolveProtocol: vi.fn(),
  AgentCardFetchError: class AgentCardFetchError extends Error {},
  A2aHttpError: class A2aHttpError extends Error {}
}))
vi.mock('../auth/cinna-tokens', () => ({ getCinnaAccessToken: vi.fn() }))
vi.mock('../auth/cinna-oauth', () => ({ CinnaReauthRequired: class CinnaReauthRequired extends Error {} }))
vi.mock('./cinna-http', () => ({ cinnaFetch: vi.fn() }))
vi.mock('./localAgents/localAgentService', () => ({ localAgentService: {} }))
vi.mock('./agentReadinessService', () => ({
  agentReadinessService: { peek: vi.fn(), kick: vi.fn(), forget: vi.fn() }
}))

const holder = vi.hoisted(() => ({ current: null as TestDatabase | null }))
vi.mock('../db/client', () => ({
  getDb: () => {
    if (!holder.current) throw new Error('test database not initialised')
    return holder.current.db
  },
  getRawSqlite: () => {
    if (!holder.current) throw new Error('test database not initialised')
    return holder.current.sqlite
  }
}))

const { agentService } = await import('./agentService')
const { agentRepo, agentShortcutRepo } = await import('../db/agents')
const { userRepo } = await import('../db/users')

const DEFAULT = '__default__'
const ALICE = 'alice'
const BOB = 'bob'

function folder(id: string): Parameters<typeof agentRepo.replaceFolderIndex>[2][number] {
  return {
    id,
    name: id,
    description: null,
    localPath: `/w/Local/${id}`,
    remoteMetadata: {
      entrypoint_prompt: null,
      example_prompts: [],
      session_mode: null,
      ui_color_preset: null,
      protocol_versions: []
    },
    launcher: 'opencode'
  }
}

const A = 'folder:a'
const B = 'folder:b'
const C = 'folder:c'

function bindings(profile: string): Array<[number, string]> {
  return agentService.listShortcuts(profile).map((b) => [b.slot, b.agentId])
}

beforeEach(() => {
  holder.current = createTestDatabase()
  agentRepo.replaceFolderIndex(DEFAULT, 'r1', [folder(A), folder(B), folder(C)])
})

afterEach(() => {
  holder.current?.close()
  holder.current = null
})

describe('agent shortcuts', () => {
  it('binds an agent to a digit', () => {
    agentService.setShortcut(DEFAULT, ALICE, A, 3)
    expect(bindings(ALICE)).toEqual([[3, A]])
  })

  it('moves a taken digit to the agent that chose it', () => {
    agentService.setShortcut(DEFAULT, ALICE, A, 2)
    agentService.setShortcut(DEFAULT, ALICE, B, 5)
    agentService.setShortcut(DEFAULT, ALICE, B, 2)
    expect(bindings(ALICE)).toEqual([[2, B]])
  })

  it('keeps one digit per agent: a new digit replaces the old one', () => {
    agentService.setShortcut(DEFAULT, ALICE, A, 1)
    agentService.setShortcut(DEFAULT, ALICE, A, 7)
    expect(bindings(ALICE)).toEqual([[7, A]])
  })

  it('clears a binding with null, leaving the others', () => {
    agentService.setShortcut(DEFAULT, ALICE, A, 1)
    agentService.setShortcut(DEFAULT, ALICE, B, 2)
    agentService.setShortcut(DEFAULT, ALICE, A, null)
    expect(bindings(ALICE)).toEqual([[2, B]])
  })

  it('clears the binding of an agent that no longer exists', () => {
    agentShortcutRepo.set(ALICE, 'folder:gone', 4)
    agentService.setShortcut(DEFAULT, ALICE, 'folder:gone', null)
    expect(bindings(ALICE)).toEqual([])
  })

  it('keeps each profile’s bindings to itself', () => {
    agentService.setShortcut(DEFAULT, ALICE, A, 1)
    agentService.setShortcut(DEFAULT, BOB, B, 1)
    agentService.setShortcut(DEFAULT, BOB, C, 2)
    expect(bindings(ALICE)).toEqual([[1, A]])
    expect(bindings(BOB)).toEqual([[1, B], [2, C]])
  })

  it('rejects a digit outside 1–9 and leaves the binding alone', () => {
    agentService.setShortcut(DEFAULT, ALICE, A, 3)
    for (const slot of [0, 10, -1, 1.5, Number.NaN]) {
      expect(() => agentService.setShortcut(DEFAULT, ALICE, A, slot)).toThrow(
        expect.objectContaining({ code: 'invalid_shortcut' })
      )
    }
    expect(bindings(ALICE)).toEqual([[3, A]])
  })

  it('refuses to bind an agent it cannot find', () => {
    expect(() => agentService.setShortcut(DEFAULT, ALICE, 'folder:nope', 1)).toThrow(
      expect.objectContaining({ code: 'not_found' })
    )
    expect(bindings(ALICE)).toEqual([])
  })

  it('follows a folder agent whose id is stamped, for every profile', () => {
    agentService.setShortcut(DEFAULT, ALICE, A, 1)
    agentService.setShortcut(DEFAULT, BOB, A, 4)
    agentRepo.rekeyFolderRow(DEFAULT, A, 'folder:stamped')
    expect(bindings(ALICE)).toEqual([[1, 'folder:stamped']])
    expect(bindings(BOB)).toEqual([[4, 'folder:stamped']])
  })

  it('releases the digit in every profile when the agent is deleted', () => {
    const local = agentRepo.create(DEFAULT, { name: 'Local A2A', protocol: 'a2a' })
    agentService.setShortcut(DEFAULT, ALICE, local.id, 2)
    agentService.setShortcut(DEFAULT, BOB, local.id, 5)
    agentService.setShortcut(DEFAULT, BOB, A, 1)
    agentService.delete(DEFAULT, local.id)
    expect(bindings(ALICE)).toEqual([])
    expect(bindings(BOB)).toEqual([[1, A]])
  })

  it('goes with the profile when the profile is deleted', () => {
    agentService.setShortcut(DEFAULT, ALICE, A, 1)
    agentService.setShortcut(DEFAULT, BOB, B, 1)
    userRepo.deleteWithCascade(ALICE)
    expect(bindings(ALICE)).toEqual([])
    expect(bindings(BOB)).toEqual([[1, B]])
  })
})
