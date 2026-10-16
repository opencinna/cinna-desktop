import { describe, it, expect } from 'vitest'
import { folderAgentId, folderReadinessBlocksTurn, isFolderAgentId, missingCredentialsReason } from './localAgents'

describe('folder agent ids', () => {
  it('round-trips the prefix', () => {
    expect(folderAgentId('abc')).toBe('folder:abc')
    expect(isFolderAgentId('folder:abc')).toBe(true)
    expect(isFolderAgentId('remote:agent:abc')).toBe(false)
    expect(isFolderAgentId('nanoid123')).toBe(false)
  })
})

describe('folderReadinessBlocksTurn', () => {
  const errors = (...codes: string[]) => ({ errors: codes.map((code) => ({ code })) })

  it('blocks a contract this build does not understand', () => {
    expect(folderReadinessBlocksTurn({ readiness: 'contract_too_new', identity: 'manifest', validation: errors() })).toBe(true)
  })

  it('blocks an unparseable manifest and a duplicate id', () => {
    expect(folderReadinessBlocksTurn({ readiness: 'invalid', identity: 'unresolved', validation: errors('manifest.unparseable') })).toBe(true)
    expect(folderReadinessBlocksTurn({ readiness: 'invalid', identity: 'manifest', validation: errors('manifest.slug.mismatch', 'manifest.id.duplicate') })).toBe(true)
  })

  it('does not block a folder whose only problem is validation findings', () => {
    expect(folderReadinessBlocksTurn({ readiness: 'invalid', identity: 'manifest', validation: errors('manifest.slug.mismatch') })).toBe(false)
    expect(folderReadinessBlocksTurn({ readiness: 'invalid', identity: 'legacy', validation: errors('manifest.id.missing') })).toBe(false)
    // An `invalid` with no findings attached (an unreadable command) still runs.
    expect(folderReadinessBlocksTurn({ readiness: 'invalid' })).toBe(false)
  })

  it('never blocks a ready folder or one missing credentials', () => {
    expect(folderReadinessBlocksTurn({ readiness: 'ok' })).toBe(false)
    expect(folderReadinessBlocksTurn({ readiness: 'credentials_needed', identity: 'unresolved' })).toBe(false)
  })
})

describe('missingCredentialsReason', () => {
  it('names every missing slot', () => {
    expect(missingCredentialsReason([{ name: 'Odoo' }, { name: 'Slack' }])).toBe(
      'Add the credentials for Odoo, Slack by attaching them or configuring credentials/.env.'
    )
  })
})
