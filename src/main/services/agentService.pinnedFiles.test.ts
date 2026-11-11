vi.mock('../host/runtimeHost', async () => {
  const { createDesktopHost } = await import('../host/desktop/runtimeHost')
  return { runtimeHost: createDesktopHost() }
})
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTestDatabase, type TestDatabase } from '../db/testSupport/nodeSqlite'

/**
 * Pinned files follow their agent and their profile: through a folder agent's
 * id being stamped, the agent being deleted, and the profile being deleted —
 * on the real repo and a real database with the production migrations.
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
const { agentRepo, agentPinnedFileRepo } = await import('../db/agents')
const { userRepo } = await import('../db/users')

const DEFAULT = '__default__'
const ALICE = 'alice'
const BOB = 'bob'
const A = 'folder:a'

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

const paths = (profile: string, agentId: string): string[] =>
  agentPinnedFileRepo.list(profile, agentId).map((row) => row.path)

beforeEach(() => {
  holder.current = createTestDatabase()
  agentRepo.replaceFolderIndex(DEFAULT, 'r1', [folder(A)])
})

afterEach(() => {
  holder.current?.close()
  holder.current = null
})

describe('pinned files housekeeping', () => {
  it('follows a folder agent whose id is stamped, for every profile', () => {
    agentPinnedFileRepo.add(ALICE, A, 'plan.md', true)
    agentPinnedFileRepo.add(BOB, A, '/elsewhere/notes.md', false)
    const result = agentRepo.rekeyFolderRow(DEFAULT, A, 'folder:stamped')
    expect(result.repointed.agent_pinned_files).toBe(2)
    expect(paths(ALICE, A)).toEqual([])
    expect(paths(ALICE, 'folder:stamped')).toEqual(['plan.md'])
    expect(paths(BOB, 'folder:stamped')).toEqual(['/elsewhere/notes.md'])
  })

  it('drops the pins in every profile when the agent is deleted, and only its own', () => {
    const local = agentRepo.create(DEFAULT, { name: 'Local A2A', protocol: 'a2a' })
    agentPinnedFileRepo.add(ALICE, local.id, '/x/one.md', false)
    agentPinnedFileRepo.add(BOB, local.id, '/x/two.md', false)
    agentPinnedFileRepo.add(BOB, A, 'keep.md', true)
    agentService.delete(DEFAULT, local.id)
    expect(paths(ALICE, local.id)).toEqual([])
    expect(paths(BOB, local.id)).toEqual([])
    expect(paths(BOB, A)).toEqual(['keep.md'])
  })

  it('goes with the profile when the profile is deleted', () => {
    agentPinnedFileRepo.add(ALICE, A, 'plan.md', true)
    agentPinnedFileRepo.add(BOB, A, 'main.py', true)
    userRepo.deleteWithCascade(ALICE)
    expect(paths(ALICE, A)).toEqual([])
    expect(paths(BOB, A)).toEqual(['main.py'])
  })
})
