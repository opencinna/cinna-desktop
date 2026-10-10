import { describe, expect, it } from 'vitest'
import type { CatalogItem } from '../../../shared/catalogItems'
import type { LibraryAgentDto } from '../../../shared/agentSharing'
import { catalogEntryViews, type CatalogEntrySources } from './useCatalogEntries'

/**
 * The one join every catalog surface reads: the listing, the team's copies
 * and this computer's agents. The dialog, Settings → Catalog and the composer
 * picker all decide their actions from what it says, so a wrong join shows up
 * as the wrong button in three places.
 */

function item(overrides: Partial<CatalogItem>): CatalogItem {
  return {
    kind: 'agent',
    runs_on: 'cloud',
    uuid: 'uuid',
    id: 'test.core.item',
    name: 'Item',
    display_name: 'Item',
    description: null,
    publisher: null,
    maintainers: [],
    access: 'use',
    visibility: 'public',
    is_listed: true,
    latest: { revision_number: 3, version: null, published_at: '2026-10-01T00:00:00Z', published_by: null, release_notes: null },
    install_count: 0,
    my_installs: [],
    required_credential_specs: [],
    skills: [],
    desktop: null,
    skill: null,
    ...overrides
  }
}

function libraryAgent(overrides: Partial<LibraryAgentDto>): LibraryAgentDto {
  return {
    uuid: 'u',
    bundleId: 'b',
    repoId: 'r',
    slug: 'agent',
    name: 'Agent',
    description: '',
    cloneUrl: 'https://core.test/git/r.git',
    headSha: 'a',
    access: 'use',
    visibility: 'users',
    isListed: true,
    maintainers: [],
    engine: null,
    manifestId: null,
    latest: null,
    localAgentId: null,
    updateAvailable: false,
    ...overrides
  }
}

const cloudInstall = (installId: string, revision: number) => ({
  where: 'cloud' as const,
  install_id: installId,
  device_id: null,
  host_manifest_id: null,
  revision_number: revision
})

function sources(overrides: Partial<CatalogEntrySources>): CatalogEntrySources {
  return { items: [], library: [], agents: [], localAgents: [], shareStatuses: [], ...overrides }
}

describe('catalogEntryViews', () => {
  it('a cloud agent: no install, an install behind the listing, and the synced row’s own answer', () => {
    const [fresh, behind, synced] = catalogEntryViews(
      sources({
        items: [
          item({ uuid: 'c1', id: 'cloud.one' }),
          item({ uuid: 'c2', id: 'cloud.two', my_installs: [cloudInstall('inst-2', 2)] }),
          item({ uuid: 'c3', id: 'cloud.three', my_installs: [cloudInstall('inst-3', 2)] })
        ],
        agents: [
          // Synced: the server says it is current, whatever the listing's numbers.
          { id: 'remote:3', remoteTargetId: 'inst-3', remoteMetadata: { bundle_version: { update_available: false } } as never }
        ]
      })
    )
    expect(fresh.kind).toBe('cloud_agent')
    expect(fresh.cloud).toEqual({ installId: null, agentId: null, updateAvailable: false })
    expect(behind.cloud).toEqual({ installId: 'inst-2', agentId: null, updateAvailable: true })
    expect(synced.cloud).toEqual({ installId: 'inst-3', agentId: 'remote:3', updateAvailable: false })
    expect(fresh.version).toBe('Version 3')
  })

  it('a desktop agent: its team entry by uuid, or null when the team listing has none', () => {
    const [held, missing] = catalogEntryViews(
      sources({
        items: [item({ uuid: 'd1', runs_on: 'desktop' }), item({ uuid: 'd2', runs_on: 'desktop' })],
        library: [libraryAgent({ uuid: 'd1', repoId: 'r1', localAgentId: 'folder:one' })]
      })
    )
    expect(held.kind).toBe('desktop_agent')
    expect(held.desktop?.repoId).toBe('r1')
    expect(held.cloud).toBeNull()
    expect(missing.desktop).toBeNull()
  })

  it('a skill: which kit agents pin it, and why each other one cannot take it', () => {
    const [skill] = catalogEntryViews(
      sources({
        items: [item({ uuid: 'S1', kind: 'skill', runs_on: null, name: 'erp-lookup', display_name: '' })],
        localAgents: [
          { id: 'folder:b', name: 'Beta', manifestId: 'b', skills: [{ source: 'catalog', packageUuid: 's1' }] as never },
          { id: 'folder:a', name: 'Alpha', manifestId: 'a', skills: [] },
          { id: 'folder:c', name: 'Gamma', manifestId: 'c', skills: [] },
          // A bare folder holds no catalog skills, so it is no target.
          { id: 'folder:bare', name: 'Bare', manifestId: 'bare' }
        ],
        shareStatuses: [{ agentId: 'folder:c', remote: { kind: 'cinna', access: 'use' } as never }]
      })
    )
    expect(skill.kind).toBe('skill')
    expect(skill.name).toBe('erp-lookup')
    expect(skill.usedBy).toEqual(['Beta'])
    expect(skill.skillTargets).toEqual([
      { agentId: 'folder:a', name: 'Alpha', blocked: null },
      { agentId: 'folder:b', name: 'Beta', blocked: 'added' },
      { agentId: 'folder:c', name: 'Gamma', blocked: 'read_only' }
    ])
  })

  it('says checking, not addable, while the share statuses load', () => {
    const [skill] = catalogEntryViews(
      sources({
        items: [item({ uuid: 's1', kind: 'skill', runs_on: null })],
        localAgents: [{ id: 'folder:a', name: 'Alpha', manifestId: 'a', skills: [] }],
        shareStatuses: undefined
      })
    )
    expect(skill.skillTargets).toEqual([{ agentId: 'folder:a', name: 'Alpha', blocked: 'checking' }])
  })
})
