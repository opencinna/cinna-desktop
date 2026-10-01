import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from './testSupport/nodeSqlite'

/** Folder-agent MCP addons, against the real migration chain. */

const holder = vi.hoisted(() => ({ current: null as TestDatabase | null }))

vi.mock('./client', () => ({
  getDb: () => holder.current!.db,
  getRawSqlite: () => holder.current!.sqlite
}))

const { agentRepo } = await import('./agents')
const { agentMcpRepo } = await import('./agentMcp')
const { mcpProviderRepo } = await import('./mcpProviders')

const USER = '__default__'

type FolderIndexEntry = Parameters<typeof agentRepo.replaceFolderIndex>[2][number]
function folder(id: string, name = id): FolderIndexEntry {
  return { id, name, description: null, localPath: `/w/Local/${id}`, launcher: 'claude',
    remoteMetadata: { entrypoint_prompt: null, example_prompts: [], session_mode: null, ui_color_preset: null, protocol_versions: [] } }
}
function mcp(id: string, userId = USER): void {
  holder.current!.raw
    .prepare("INSERT INTO mcp_providers (id,user_id,name,transport_type,enabled,created_at) VALUES (?,?,?,'stdio',1,1)")
    .run(id, userId, id.toUpperCase())
}

beforeEach(() => {
  holder.current = createTestDatabase()
  agentRepo.replaceFolderIndex(USER, 'r1', [folder('folder:a', 'Alpha'), folder('folder:b', 'Beta')])
  mcp('m1'); mcp('m2'); mcp('other', 'someone-else')
})
afterEach(() => { holder.current?.close(); holder.current = null })

describe('agentMcpRepo', () => {
  it('attaches idempotently, lists oldest first and detaches', () => {
    expect(agentMcpRepo.attach('folder:a', 'm2')).toBe(true)
    expect(agentMcpRepo.attach('folder:a', 'm1')).toBe(true)
    expect(agentMcpRepo.attach('folder:a', 'm2')).toBe(false)
    expect(agentMcpRepo.listProviderIds(USER, 'folder:a')).toEqual(['m2', 'm1'])
    expect(agentMcpRepo.detach('folder:a', 'm2')).toBe(true)
    expect(agentMcpRepo.detach('folder:a', 'm2')).toBe(false)
    expect(agentMcpRepo.listProviderIds(USER, 'folder:a')).toEqual(['m1'])
  })

  it('lists only connectors the owner holds', () => {
    agentMcpRepo.attach('folder:a', 'm1')
    agentMcpRepo.attach('folder:a', 'other')
    expect(agentMcpRepo.listProviderIds(USER, 'folder:a')).toEqual(['m1'])
    expect(agentMcpRepo.listProviderIds('someone-else', 'folder:a')).toEqual(['other'])
  })

  it('names the agents a connector is attached to', () => {
    agentMcpRepo.attach('folder:a', 'm1')
    agentMcpRepo.attach('folder:b', 'm1')
    expect(agentMcpRepo.agentsUsing(USER, 'm1')).toEqual([{ id: 'folder:a', name: 'Alpha' }, { id: 'folder:b', name: 'Beta' }])
    expect(agentMcpRepo.agentsUsing('someone-else', 'm1')).toEqual([])
    expect(agentMcpRepo.agentIdsFor('m1').sort()).toEqual(['folder:a', 'folder:b'])
  })

  it('goes with the connector when it is deleted', () => {
    agentMcpRepo.attach('folder:a', 'm1')
    agentMcpRepo.attach('folder:a', 'm2')
    mcpProviderRepo.delete(USER, 'm1')
    expect(agentMcpRepo.listProviderIds(USER, 'folder:a')).toEqual(['m2'])
  })

  it('goes with the agent when its folder is pruned', () => {
    agentMcpRepo.attach('folder:a', 'm1')
    agentMcpRepo.attach('folder:b', 'm1')
    agentRepo.replaceFolderIndex(USER, 'r1', [folder('folder:b', 'Beta')])
    expect(agentMcpRepo.agentsUsing(USER, 'm1')).toEqual([{ id: 'folder:b', name: 'Beta' }])
  })

  it('survives a rescan of the same folder', () => {
    agentMcpRepo.attach('folder:a', 'm1')
    agentRepo.replaceFolderIndex(USER, 'r1', [folder('folder:a', 'Alpha renamed'), folder('folder:b', 'Beta')])
    agentRepo.updateFolderIndex(USER, folder('folder:a', 'Alpha'), 'r1')
    expect(agentMcpRepo.listProviderIds(USER, 'folder:a')).toEqual(['m1'])
  })

  it('follows the agent through a stamp re-key', () => {
    agentRepo.replaceFolderIndex(USER, 'r1', [folder('folder:legacy:r1:a', 'Alpha')])
    agentMcpRepo.attach('folder:legacy:r1:a', 'm1')
    const result = agentRepo.rekeyFolderRow(USER, 'folder:legacy:r1:a', 'folder:stamped')
    expect(result.repointed).toMatchObject({ agent_mcp_providers: 1 })
    expect(agentMcpRepo.listProviderIds(USER, 'folder:stamped')).toEqual(['m1'])
    expect(agentMcpRepo.listProviderIds(USER, 'folder:legacy:r1:a')).toEqual([])
  })
})
