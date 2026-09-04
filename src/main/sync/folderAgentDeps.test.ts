import { describe, it, expect, vi } from 'vitest'
import { agentIdentityKey, agentRowToDescriptor } from './identity'
import { derivePattern } from '../../shared/commPattern'
import type { AgentRow } from '../db/agents'
import type { JobDepDescriptor } from '../../shared/sync'

// `resolvers.ts` reaches Electron through the logger (`logger → src/main/index`
// — the inversion this project has tracked as open debt since Phase 6), and
// through `db/client` for `app.getPath`. Neither is exercised by
// `manifestNeedsSetup`, which is pure map lookups over an index the caller
// hands it, so both are stubbed rather than stood up.
vi.mock('../logger/logger', () => ({
  createLogger: () => ({
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined
  })
}))
vi.mock('../db/client', () => ({
  getDb: () => {
    throw new Error('no database in this test')
  },
  getRawSqlite: () => {
    throw new Error('no database in this test')
  }
}))

const { manifestNeedsSetup } = await import('./resolvers')
type ResolveIndex = Awaited<ReturnType<typeof import('./resolvers').buildResolveIndex>>

/**
 * A job that depends on a folder agent, crossing devices.
 *
 * `agents` is not a synced collection: agents cross only as the portable
 * dependency descriptors a job carries. A folder agent has `cardUrl` and
 * `endpointUrl` both null, so `agentRowToDescriptor` used to fall through to
 * `if (!cardUrl) return null`, and `buildJobManifest`'s `if (desc) remember(desc)`
 * then dropped the dependency from the manifest **entirely** rather than
 * carrying it as unresolvable.
 *
 * The consequence was not "the job will not resolve on the second device". It
 * was worse and quieter: the peer rebuilt the job from a deps list with no
 * agent in it, `manifestNeedsSetup` answered `false` — the job presented as
 * fully set up — and the run called `derivePattern([], [])`, which returns
 * `'AI'`. **The job ran as a plain-LLM job with the agent silently missing, and
 * reported success.** That is what the first test here pins, in that order: the
 * pattern first, because a wrong pattern is the damage and the descriptor is
 * only the mechanism.
 */

function folderRow(over: Partial<AgentRow> = {}): AgentRow {
  return {
    id: 'folder:6f1a-uuid',
    userId: '__default__',
    name: 'Invoice Checker',
    description: null,
    protocol: 'local-folder',
    cardUrl: null,
    endpointUrl: null,
    protocolInterfaceUrl: null,
    protocolInterfaceVersion: null,
    accessTokenEncrypted: null,
    cardData: null,
    skills: null,
    enabled: true,
    source: 'folder',
    remoteTargetType: null,
    remoteTargetId: null,
    remoteMetadata: null,
    localPath: '/w/Local/invoice-checker',
    localRootId: 'r1',
    createdBySync: false,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...over
  } as unknown as AgentRow
}

/**
 * The descriptor a device with the agent emits for it. A function rather than a
 * module-level const on purpose: built at import time, a regression that makes
 * `agentRowToDescriptor` return null again fails the whole *file* to collect,
 * and a suite that cannot load says nothing about which claim broke.
 */
function folderDescriptor(): Extract<JobDepDescriptor, { kind: 'agent'; source: 'folder' }> {
  const d = agentRowToDescriptor(folderRow())
  if (!d || d.source !== 'folder') {
    throw new Error('a folder row produced no folder descriptor')
  }
  return d
}

function index(over: Partial<ResolveIndex> = {}): ResolveIndex {
  return {
    mcp: new Map(),
    localAgent: new Map(),
    remoteAgent: new Set(),
    folderAgent: new Map(),
    modeNames: new Set(),
    hasDefaultMode: false,
    ...over
  }
}

/** What `collections.ts` apply does with one agent descriptor and no MCPs. */
function patternFor(descriptors: Array<JobDepDescriptor | null>): string {
  const agentIds = descriptors.filter((d) => d !== null).map((_, i) => `resolved-${i}`)
  return derivePattern(agentIds, [])
}

describe('a job dependency on a folder agent', () => {
  it('reaches the peer as a dependency instead of turning the job into a plain-LLM run', () => {
    const descriptors = [agentRowToDescriptor(folderRow())]
    // The damage first: with the dependency dropped this was 'AI', and the run
    // went ahead with no agent and no complaint.
    expect(patternFor(descriptors)).toBe('A2A')
    expect(descriptors[0]).not.toBeNull()
    expect(descriptors[0]).toEqual({
      kind: 'agent',
      source: 'folder',
      manifestId: '6f1a-uuid',
      name: 'Invoice Checker'
    })
  })

  it('builds the descriptor from a row whose card and endpoint URLs are both null', () => {
    // The exact shape the old `cardUrl ?? endpointUrl` fallback rejected. A
    // folder agent is run by the local engine; it has no URL of any kind, and
    // never will.
    const row = folderRow({ cardUrl: null, endpointUrl: null } as Partial<AgentRow>)
    expect(agentRowToDescriptor(row)).not.toBeNull()
  })

  it('keys on the manifest id, distinctly from a local agent with the same string', () => {
    expect(agentIdentityKey(folderDescriptor())).toBe('folder|6f1a-uuid')
    expect(agentIdentityKey({ kind: 'agent', source: 'local', cardUrl: '6f1a-uuid' })).not.toBe(
      agentIdentityKey(folderDescriptor())
    )
  })

  it('refuses a folder row whose id carries no manifest id', () => {
    // Nothing should produce such a row — `folder:` alone is not an id the
    // scanner emits — but the descriptor is the last place to catch it, and an
    // empty key would collide with every other malformed row.
    expect(agentRowToDescriptor(folderRow({ id: 'folder:' } as Partial<AgentRow>))).toBeNull()
  })
})

describe('manifestNeedsSetup for a folder dependency', () => {
  const key = (): string => agentIdentityKey(folderDescriptor())

  it('says the job is ready on a device that has the folder agent enabled', () => {
    // The regression this guards is not hypothetical: `agentIdentityKey` takes
    // the whole agent union, so a folder descriptor left to fall through to the
    // `local` arm typechecks, then looks itself up in `idx.localAgent` under a
    // `folder|…` key that map can never hold — and the job reports "needs
    // setup" on the very machine the agent lives on.
    const idx = index({ folderAgent: new Map([[key(), true]]) })
    expect(manifestNeedsSetup({ modeName: null, deps: [folderDescriptor()] }, idx)).toBe(false)
  })

  it('says the job needs setup on a device without that workshop', () => {
    expect(manifestNeedsSetup({ modeName: null, deps: [folderDescriptor()] }, index())).toBe(true)
  })

  it('says the job needs setup when the agent is present but switched off', () => {
    const idx = index({ folderAgent: new Map([[key(), false]]) })
    expect(manifestNeedsSetup({ modeName: null, deps: [folderDescriptor()] }, idx)).toBe(true)
  })

  it('does not accept a local agent indexed under the same raw string', () => {
    // Cross-family collision: the two maps are keyed by `agentIdentityKey`, and
    // the prefixes are what keep a card URL and a manifest id apart.
    const idx = index({ localAgent: new Map([['local|6f1a-uuid', true]]) })
    expect(manifestNeedsSetup({ modeName: null, deps: [folderDescriptor()] }, idx)).toBe(true)
  })
})
