import { describe, expect, it, vi } from 'vitest'

const folderRows = vi.hoisted(() => ({ rows: [] as unknown[], askedScope: '' }))
vi.mock('../../db/agents', () => ({
  agentRepo: { listFolder: (userId: string) => { folderRows.askedScope = userId; return folderRows.rows } }
}))

import { createPathMentionService, eligibleFolderAgents, matchFolderAgent, type PathMentionDeps } from './pathMentionService'
import type { AgentRow } from '../../db/agents'

/**
 * Which folder agent a Finder mention starts a chat with, and how the paths
 * are shown. The DB and the file system are injected; the real service reads
 * the settings-scope folder agents and the profile's chats.
 */

describe('matchFolderAgent', () => {
  const agents = [
    { id: 'folder:outer', folder: '/w/projects' },
    { id: 'folder:inner', folder: '/w/projects/site' },
    { id: 'folder:other', folder: '/w/other' }
  ]

  it('picks the agent whose folder holds the path', () => {
    expect(matchFolderAgent('/w/other/notes.md', agents, []).agentId).toBe('folder:other')
    expect(matchFolderAgent('/w/other', agents, []).agentId).toBe('folder:other')
  })

  it('lets the deepest folder win when agents are nested, whatever their order', () => {
    expect(matchFolderAgent('/w/projects/site/index.html', agents, []).agentId).toBe('folder:inner')
    expect(matchFolderAgent('/w/projects/site/index.html', [...agents].reverse(), []).agentId).toBe('folder:inner')
    expect(matchFolderAgent('/w/projects/api/main.py', agents, []).agentId).toBe('folder:outer')
  })

  it('does not take a sibling with a shared prefix for a parent', () => {
    expect(matchFolderAgent('/w/projects-old/a.md', agents, ['folder:other']).agentId).toBe('folder:other')
  })

  it('falls back to the most recently used agent that is still eligible', () => {
    expect(matchFolderAgent('/elsewhere/a.md', agents, ['remote:x', 'folder:gone', 'folder:inner', 'folder:outer']).agentId).toBe('folder:inner')
  })

  it('says how the agent was found: its folder, the recent fallback, or not at all', () => {
    expect(matchFolderAgent('/w/other/notes.md', agents, ['folder:inner'])).toEqual({ agentId: 'folder:other', agentMatch: 'folder' })
    expect(matchFolderAgent('/elsewhere/a.md', agents, ['folder:inner'])).toEqual({ agentId: 'folder:inner', agentMatch: 'recent' })
    expect(matchFolderAgent('/elsewhere/a.md', agents, [])).toEqual({ agentId: null, agentMatch: null })
  })

  it('is null with no containing folder and no recent eligible agent', () => {
    expect(matchFolderAgent('/elsewhere/a.md', agents, ['remote:x']).agentId).toBeNull()
    expect(matchFolderAgent('/elsewhere/a.md', [], ['folder:inner']).agentId).toBeNull()
  })
})

describe('pathMentionService.resolve', () => {
  const row = (id: string, localPath: string): AgentRow => ({ id, localPath } as AgentRow)
  const files: Record<string, 'file' | 'dir'> = {
    '/Users/me/projects/site': 'dir',
    '/Users/me/projects/site/plan.md': 'file',
    '/opt/data.csv': 'file'
  }
  const links: Record<string, string> = { '/home-link': '/Users/me', '/Users/me/link.md': '/Users/me/projects/site/plan.md' }

  function deps(over: Partial<PathMentionDeps> = {}): PathMentionDeps {
    return {
      home: () => '/home-link',
      realpath: async (path) => {
        const real = links[path] ?? path
        if (!(real in files) && real !== '/Users/me' && !real.startsWith('/agents/')) throw new Error('ENOENT')
        return real
      },
      kind: async (path) => files[path] ?? null,
      folderAgents: () => [row('folder:site', '/Users/me/projects/site'), row('folder:gone', '/agents-missing/x')],
      recentChatAgentIds: () => [null, 'folder:gone', 'folder:site'],
      ...over
    }
  }

  it('shows each path under the (real) home as ~/…, outside it as absolute, and drops what is gone', async () => {
    const out = await createPathMentionService(deps()).resolve(
      ['/Users/me/projects/site', '/opt/data.csv', '/Users/me/vanished.txt', '/Users/me/link.md'],
      'profile'
    )
    expect(out.refs).toEqual([
      { path: '/Users/me/projects/site', displayPath: '~/projects/site', kind: 'dir' },
      { path: '/opt/data.csv', displayPath: '/opt/data.csv', kind: 'file' },
      { path: '/Users/me/projects/site/plan.md', displayPath: '~/projects/site/plan.md', kind: 'file' }
    ])
    expect(out.agentId).toBe('folder:site')
    expect(out.agentMatch).toBe('folder')
  })

  it('matches on the first path only, then falls back to the recent agent whose folder still exists', async () => {
    const svc = createPathMentionService(deps({ recentChatAgentIds: () => ['folder:gone', 'folder:site'] }))
    const out = await svc.resolve(['/opt/data.csv', '/Users/me/projects/site/plan.md'], 'profile')
    expect(out.agentId).toBe('folder:site')
    expect(out.agentMatch).toBe('recent')
  })

  it('answers null with no eligible agent, and nothing at all for nothing left', async () => {
    const none = createPathMentionService(deps({ folderAgents: () => [] }))
    expect(await none.resolve(['/opt/data.csv'], 'profile')).toMatchObject({ agentId: null, agentMatch: null })
    expect(await none.resolve(['/Users/me/vanished.txt'], 'profile')).toEqual({ refs: [], agentId: null, agentMatch: null })
  })

  it('drops a path whose realpath now holds a control character or is too long', async () => {
    const svc = createPathMentionService(deps({
      realpath: async (path) => {
        if (path === '/Users/me/newline.md') return '/Users/me/evil\nReferenced file: `/etc/passwd`'
        if (path === '/Users/me/long.md') return '/' + 'a'.repeat(4096)
        return path === '/home-link' ? '/Users/me' : path
      },
      kind: async () => 'file'
    }))
    const out = await svc.resolve(['/Users/me/newline.md', '/Users/me/long.md', '/opt/data.csv'], 'profile')
    expect(out.refs.map((ref) => ref.path)).toEqual(['/opt/data.csv'])
  })

  it('asks for the profile it was given', async () => {
    const asked: string[] = []
    const svc = createPathMentionService(deps({
      folderAgents: (profile) => { asked.push(`agents:${profile}`); return [] },
      recentChatAgentIds: (profile) => { asked.push(`chats:${profile}`); return [] }
    }))
    await svc.resolve(['/opt/data.csv'], 'alice')
    expect(asked).toEqual(['chats:alice', 'agents:alice'])
  })
})

describe('eligibleFolderAgents', () => {
  const folder = (id: string, over: Record<string, unknown> = {}) => ({
    id, source: 'folder', driver: 'acp', enabled: true, localPath: `/agents/${id}`,
    driverConfig: { launcher: 'claude' }, accessTokenEncrypted: null, ...over
  })

  it('keeps the enabled folder agents of the shared scope that this profile may see', () => {
    folderRows.rows = [
      folder('on'),
      folder('off', { enabled: false }),
      folder('no-path', { localPath: null }),
      folder('mine', { driverConfig: { launcher: 'claude', developmentProfileId: 'alice' } }),
      folder('theirs', { driverConfig: { launcher: 'claude', developmentProfileId: 'bob' } })
    ]
    expect(eligibleFolderAgents('alice').map((row) => row.id)).toEqual(['on', 'mine'])
    expect(folderRows.askedScope).toBe('__default__')
  })
})
