import { describe, it, expect } from 'vitest'
import { canBeCounterparty, folderAgentId, isFolderAgentId } from './localAgents'

/**
 * `canBeCounterparty` is the temporary exclusion that keeps folder agents out of
 * the two pickers that offer an agent as something to talk to, until the local
 * runner exists. It is tested here rather than through the components because
 * it is the whole of the rule — the call sites are a `filter` each — and because
 * a test that outlives the rule should fail loudly when the rule is deleted.
 */

const agent = (source: string, enabled = true): { source: string; enabled: boolean } => ({
  source,
  enabled
})

describe('canBeCounterparty', () => {
  it('excludes folder agents, which have no runner yet', () => {
    expect(canBeCounterparty(agent('folder'))).toBe(false)
  })

  it('admits the agents that can actually answer', () => {
    expect(canBeCounterparty(agent('local'))).toBe(true)
    expect(canBeCounterparty(agent('remote'))).toBe(true)
  })

  it('is independent of `enabled`, which means something else entirely', () => {
    // The pickers apply both, and they must stay separable: `enabled` is the
    // user's choice and survives rescans; this is a capability gap that will be
    // deleted. Conflating them would make a disabled agent indistinguishable
    // from an unimplemented one.
    expect(canBeCounterparty(agent('folder', false))).toBe(false)
    expect(canBeCounterparty(agent('local', false))).toBe(true)
  })
})

describe('folder agent ids', () => {
  it('round-trips the prefix', () => {
    expect(folderAgentId('abc')).toBe('folder:abc')
    expect(isFolderAgentId('folder:abc')).toBe(true)
    expect(isFolderAgentId('remote:agent:abc')).toBe(false)
    expect(isFolderAgentId('nanoid123')).toBe(false)
  })
})
