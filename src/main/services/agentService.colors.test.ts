vi.mock('../host/runtimeHost', async () => {
  const { createDesktopHost } = await import('../host/desktop/runtimeHost')
  return { runtimeHost: createDesktopHost() }
})
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTestDatabase, type TestDatabase } from '../db/testSupport/nodeSqlite'

/**
 * Agent color presets, through the service and the real repo on a real
 * database with the production migrations: one color per agent, None clears
 * it, each profile keeps its own, and only listed preset ids get in. See
 * `testSupport/nodeSqlite.ts` for why it is not `better-sqlite3`.
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
const { agentRepo, agentColorRepo } = await import('../db/agents')
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

function colors(profile: string): Array<[string, string]> {
  return agentService
    .listColors(profile)
    .map((c): [string, string] => [c.agentId, c.preset])
    .sort((x, y) => x[0].localeCompare(y[0]))
}

beforeEach(() => {
  holder.current = createTestDatabase()
  agentRepo.replaceFolderIndex(DEFAULT, 'r1', [folder(A), folder(B)])
})

afterEach(() => {
  holder.current?.close()
  holder.current = null
})

describe('agent colors', () => {
  it('gives an agent a color', () => {
    agentService.setColor(DEFAULT, ALICE, A, 'teal')
    expect(colors(ALICE)).toEqual([[A, 'teal']])
  })

  it('replaces the color an agent already has', () => {
    agentService.setColor(DEFAULT, ALICE, A, 'teal')
    agentService.setColor(DEFAULT, ALICE, A, 'rose')
    expect(colors(ALICE)).toEqual([[A, 'rose']])
  })

  it('lets two agents share a color', () => {
    agentService.setColor(DEFAULT, ALICE, A, 'sky')
    agentService.setColor(DEFAULT, ALICE, B, 'sky')
    expect(colors(ALICE)).toEqual([[A, 'sky'], [B, 'sky']])
  })

  it('clears a color back to None with null, leaving the others', () => {
    agentService.setColor(DEFAULT, ALICE, A, 'teal')
    agentService.setColor(DEFAULT, ALICE, B, 'honey')
    agentService.setColor(DEFAULT, ALICE, A, null)
    expect(colors(ALICE)).toEqual([[B, 'honey']])
  })

  it('clears the color of an agent that no longer exists', () => {
    agentColorRepo.set(ALICE, 'folder:gone', 'mint')
    agentService.setColor(DEFAULT, ALICE, 'folder:gone', null)
    expect(colors(ALICE)).toEqual([])
  })

  it('keeps each profile’s colors to itself', () => {
    agentService.setColor(DEFAULT, ALICE, A, 'teal')
    agentService.setColor(DEFAULT, BOB, A, 'orchid')
    agentService.setColor(DEFAULT, BOB, B, 'sand')
    expect(colors(ALICE)).toEqual([[A, 'teal']])
    expect(colors(BOB)).toEqual([[A, 'orchid'], [B, 'sand']])
  })

  it('rejects a preset that is not listed and leaves the color alone', () => {
    agentService.setColor(DEFAULT, ALICE, A, 'teal')
    for (const preset of ['', 'Teal', 'red', '#E07A93', 'indigo']) {
      expect(() => agentService.setColor(DEFAULT, ALICE, A, preset)).toThrow(
        expect.objectContaining({ code: 'invalid_color' })
      )
    }
    expect(colors(ALICE)).toEqual([[A, 'teal']])
  })

  it('refuses to color an agent it cannot find', () => {
    expect(() => agentService.setColor(DEFAULT, ALICE, 'folder:nope', 'teal')).toThrow(
      expect.objectContaining({ code: 'not_found' })
    )
    expect(colors(ALICE)).toEqual([])
  })

  it('follows a folder agent whose id is stamped, for every profile', () => {
    agentService.setColor(DEFAULT, ALICE, A, 'teal')
    agentService.setColor(DEFAULT, BOB, A, 'rose')
    agentRepo.rekeyFolderRow(DEFAULT, A, 'folder:stamped')
    expect(colors(ALICE)).toEqual([['folder:stamped', 'teal']])
    expect(colors(BOB)).toEqual([['folder:stamped', 'rose']])
  })

  it('drops the color in every profile when the agent is deleted', () => {
    const local = agentRepo.create(DEFAULT, { name: 'Local A2A', protocol: 'a2a' })
    agentService.setColor(DEFAULT, ALICE, local.id, 'teal')
    agentService.setColor(DEFAULT, BOB, local.id, 'rose')
    agentService.setColor(DEFAULT, BOB, A, 'sky')
    agentService.delete(DEFAULT, local.id)
    expect(colors(ALICE)).toEqual([])
    expect(colors(BOB)).toEqual([[A, 'sky']])
  })

  it('goes with the profile when the profile is deleted', () => {
    agentService.setColor(DEFAULT, ALICE, A, 'teal')
    agentService.setColor(DEFAULT, BOB, B, 'rose')
    userRepo.deleteWithCascade(ALICE)
    expect(colors(ALICE)).toEqual([])
    expect(colors(BOB)).toEqual([[B, 'rose']])
  })
})
