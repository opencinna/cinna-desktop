import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * `agentService.listCliCommands`'s folder branch — the composer `/` popup
 * and the agent page's Commands card both resolve through here
 * (`agentService.ts:481` per the plan). `agentService.ts` has a wide, heavy
 * dependency graph (electron `net`, DB repos, the keystore, the A2A client,
 * Cinna auth) that this branch never touches; everything below is mocked to
 * a stub purely so the module can be imported, and only what this branch
 * actually calls (`agentRepo.getOwned`, `localAgentService.locate`, the real
 * `getLayoutView`/`readCommandCatalog` against a real folder) does anything.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')

vi.mock('electron', () => ({
  net: { fetch: vi.fn() },
  app: {
    isPackaged: false,
    getAppPath: () => repoRoot,
    getVersion: () => '0.0.0-test',
    on: () => undefined
  }
}))
vi.mock('../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))
vi.mock('../db/users', () => ({ userRepo: { get: vi.fn() } }))
vi.mock('../security/keystore', () => ({
  encryptApiKey: vi.fn(),
  decryptApiKey: vi.fn()
}))
vi.mock('../agents/a2a-client', () => ({
  fetchAgentCard: vi.fn(),
  resolveProtocol: vi.fn(),
  AgentCardFetchError: class AgentCardFetchError extends Error {},
  A2aHttpError: class A2aHttpError extends Error {}
}))
vi.mock('../auth/cinna-tokens', () => ({ getCinnaAccessToken: vi.fn() }))
vi.mock('../auth/cinna-oauth', () => ({ CinnaReauthRequired: class CinnaReauthRequired extends Error {} }))
vi.mock('./cinna-http', () => ({ cinnaFetch: vi.fn() }))

const getOwnedImpl = vi.hoisted(() => ({
  current: null as null | ((userId: string, agentId: string) => unknown)
}))
vi.mock('../db/agents', () => ({
  agentRepo: {
    getOwned: (userId: string, agentId: string) => getOwnedImpl.current?.(userId, agentId)
  },
  agentOverrideRepo: { get: vi.fn(), set: vi.fn() }
}))

const locateImpl = vi.hoisted(() => ({
  current: null as null | ((userId: string, agentId: string) => { root: { path: string }; agentDir: string })
}))
vi.mock('./localAgents/localAgentService', () => ({
  localAgentService: {
    locate: (userId: string, agentId: string) => {
      if (!locateImpl.current) throw new Error('test bug: locateImpl not configured')
      return locateImpl.current(userId, agentId)
    }
  }
}))

const { agentService } = await import('./agentService')
const { clearContractCache } = await import('../kit/contractStore')

const USER = '__default__'
const FOLDER_AGENT_ID = 'folder:alpha'

let workshop: string
let agentDir: string

function writeCatalog(yaml: string): void {
  writeFileSync(join(agentDir, 'docs', 'CLI_COMMANDS.yaml'), yaml)
}

beforeEach(() => {
  workshop = mkdtempSync(join(tmpdir(), 'cinna-clicmds-'))
  agentDir = join(workshop, 'Local', 'alpha')
  mkdirSync(join(agentDir, 'docs'), { recursive: true })
  locateImpl.current = (_userId, agentId) => {
    if (agentId !== FOLDER_AGENT_ID) throw new Error('not found')
    return { root: { path: workshop }, agentDir }
  }
  getOwnedImpl.current = (_userId, agentId) =>
    agentId === FOLDER_AGENT_ID ? { id: FOLDER_AGENT_ID, source: 'folder' } : undefined
})

afterEach(() => {
  clearContractCache()
  rmSync(workshop, { recursive: true, force: true })
})

describe('listCliCommands — folder agent branch', () => {
  it('dispatches a folder agent to the catalog reader, never the A2A card fetch', async () => {
    writeCatalog(
      'commands:\n  - name: check\n    description: Run the checks\n    command: python scripts/check.py\n'
    )
    const commands = await agentService.listCliCommands(USER, FOLDER_AGENT_ID)
    expect(commands).toEqual([
      { slug: 'check', name: 'check', description: 'Run the checks', command: '/run:check' }
    ])
  })

  it('an unindexed agent id still throws not_found — unchanged, pre-existing behaviour', async () => {
    await expect(agentService.listCliCommands(USER, 'folder:gone')).rejects.toThrow(/not found/i)
  })

  it('returns [] rather than throwing when the row is indexed but its folder or root has gone missing', async () => {
    // The row exists (so the pre-existing not_found throw above does NOT
    // fire), but `locateImpl` only answers for `FOLDER_AGENT_ID` — anything
    // else throws, simulating a folder-index row whose folder or root moved
    // or was deleted outside the app.
    getOwnedImpl.current = (_u, agentId) =>
      agentId === 'folder:broken' ? { id: 'folder:broken', source: 'folder' } : undefined
    const commands = await agentService.listCliCommands(USER, 'folder:broken')
    expect(commands).toEqual([])
  })

  it('returns [] for an empty or missing catalog, without throwing', async () => {
    // No docs/CLI_COMMANDS.yaml written at all.
    const commands = await agentService.listCliCommands(USER, FOLDER_AGENT_ID)
    expect(commands).toEqual([])
  })

  it('every returned command is a real /run: reference, localisation aside', async () => {
    writeFileSync(join(agentDir, 'pyproject.toml'), '[project]\nname = "alpha"\n')
    writeCatalog(
      'commands:\n  - name: refresh\n    description: x\n    command: python scripts/x.py\n'
    )
    const commands = await agentService.listCliCommands(USER, FOLDER_AGENT_ID)
    // `command` is the cloud-first reference for the composer to insert, not
    // the localised form — `commandService.matchRunCommand` on the receiving
    // end matches exactly this grammar.
    expect(commands[0].command).toBe('/run:refresh')
  })
})
