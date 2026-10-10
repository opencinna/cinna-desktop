/**
 * The Inbox's "Update available" for cloud agents: a synced agent installed
 * from the catalog whose install is behind, and that the server does not
 * update by itself. Who published the version comes from the cached listing.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const rows = vi.hoisted(() => ({ list: [] as unknown[] }))
const cached = vi.hoisted(() => ({ listing: null as unknown }))

vi.mock('../db/agents', () => ({ agentRepo: { listRemote: () => rows.list } }))
vi.mock('../auth/scope', () => ({ getProfileScopeUserId: () => 'p-cinna' }))
vi.mock('./libraryService', () => ({ libraryService: { cached: () => cached.listing } }))
vi.mock('../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

const { cloudUpdateItems } = await import('./cloudUpdateNotices')

function row(id: string, bundleVersion: Record<string, unknown> | null, remoteTargetId: string | null = `i-${id}`): unknown {
  return {
    id,
    name: `Agent ${id}`,
    remoteTargetId,
    remoteMetadata: bundleVersion ? { bundle_version: bundleVersion } : {}
  }
}

const behind = (mode: string | null = 'manual'): Record<string, unknown> => ({
  installed_revision_number: 1,
  installed_version: null,
  latest_revision_number: 3,
  latest_version: '1.2.0',
  update_available: true,
  update_mode: mode,
  last_update_status: null
})

beforeEach(() => {
  rows.list = []
  cached.listing = null
})

describe('cloudUpdateItems', () => {
  it('lists an install that is behind and updated by hand, with Version N', () => {
    rows.list = [row('a', behind())]
    expect(cloudUpdateItems()).toEqual([
      {
        kind: 'update_available',
        target: 'cloud_agent',
        agentId: 'a',
        agentName: 'Agent a',
        installId: 'i-a',
        version: 3,
        versionLabel: '1.2.0',
        changedBy: null,
        changedAt: null
      }
    ])
  })

  it('leaves out an install the server updates by itself, one that is current, and a row without an install', () => {
    rows.list = [
      row('auto', behind('automatic')),
      row('current', { ...behind(), update_available: false }),
      row('plain', null),
      row('orphan', behind(), null)
    ]
    expect(cloudUpdateItems()).toEqual([])
  })

  it('names who published the version, and when, from the listing item that holds the install', () => {
    rows.list = [row('a', behind())]
    cached.listing = {
      items: [
        { uuid: 'other', my_installs: [], latest: null },
        {
          kind: 'agent',
          runs_on: 'cloud',
          uuid: 'u-a',
          my_installs: [{ where: 'cloud', install_id: 'i-a', revision_number: 1 }],
          latest: { revision_number: 3, published_at: '2026-10-08T10:00:00Z', published_by: { user_id: 'x', display_name: 'Anna' } }
        }
      ]
    }
    const [item] = cloudUpdateItems()
    expect(item).toMatchObject({ changedBy: 'Anna', changedAt: new Date('2026-10-08T10:00:00Z') })
  })

  it('takes the publisher from the cloud agent holding the install, never from a skill linked to it', () => {
    rows.list = [row('a', behind())]
    const latest = (name: string) => ({
      revision_number: 3,
      version: null,
      published_at: '2026-10-08T10:00:00Z',
      published_by: { user_id: name, display_name: name }
    })
    const skill = {
      kind: 'skill',
      runs_on: null,
      uuid: 'u-skill',
      // A skill linked to the agent carries the agent's install id.
      my_installs: [{ where: 'cloud', install_id: 'i-a', revision_number: 1 }],
      latest: latest('Skill author')
    }
    const agent = {
      kind: 'agent',
      runs_on: 'cloud',
      uuid: 'u-a',
      my_installs: [{ where: 'cloud', install_id: 'i-a', revision_number: 1 }],
      latest: latest('Anna')
    }
    cached.listing = { items: [skill, agent] }
    expect(cloudUpdateItems()[0]).toMatchObject({ changedBy: 'Anna' })
    // Without the agent in the listing, the skill names nobody.
    cached.listing = { items: [skill] }
    expect(cloudUpdateItems()[0]).toMatchObject({ changedBy: null, changedAt: null })
  })

  it('is empty, not a failed Inbox, when the read throws', () => {
    rows.list = null as never
    expect(cloudUpdateItems()).toEqual([])
  })
})
