import { describe, expect, it } from 'vitest'
import type { LocalAgentSkill } from '../../../shared/localAgents'
import { autoMatch, slotCandidates } from './slotMatch'
import { collectSkillSlots, judgeSkillRows, judgeSkillSlot, skillSlotSpec, slotClaimed } from './skillSlots'

const skill = (name: string, credentials: { slot: string; type?: string; description?: string | null }[], over: Partial<LocalAgentSkill> = {}): LocalAgentSkill => ({
  name, description: '', version: null, source: 'authored', path: '', deliverable: true, issues: [],
  credentials: credentials.map((c) => ({ slot: c.slot, type: c.type ?? 'api_token', description: c.description ?? null })), ...over
})
const attached = (id: string, type: string, serviceUri: string | null, state = 'ready') => ({ id, type, serviceUri, state })
type Rec = { id: string; name: string; type: string; serviceUri: string | null; relation: 'owned' | 'shared'; localUseAllowed: boolean; keyStatus: string | null }
const rec = (id: string, over: Partial<Rec> = {}): Rec => ({ id, name: id, type: 'api_token', serviceUri: null, relation: 'shared', localUseAllowed: true, keyStatus: null, ...over })

describe('collecting skill slots', () => {
  it('keys by slot and type, across own and catalog skills, deliverable only, in first-seen order', () => {
    const slots = collectSkillSlots([
      skill('a', [{ slot: 'erp-api', description: 'ERP read key' }, { slot: 'erp-api', type: 'odoo' }]),
      skill('b', [{ slot: 'erp-api' }], { source: 'catalog', packageUuid: 'p1', revisionNumber: 2 }),
      skill('c', [{ slot: 'erp-api' }], { source: 'catalog', packageUuid: 'p1', revisionNumber: 2 }),
      skill('broken', [{ slot: 'never' }], { deliverable: false }),
      skill('unpinned', [{ slot: 'erp-api' }], { source: 'catalog', packageUuid: 'p9', revisionNumber: null })
    ])
    expect(slots).toEqual([
      { slot: 'erp-api', type: 'api_token', skills: ['a', 'b', 'c', 'unpinned'], description: 'ERP read key', catalog: [{ packageUuid: 'p1', revisionNumber: 2 }] },
      { slot: 'erp-api', type: 'odoo', skills: ['a'], description: null, catalog: [] }
    ])
    expect(collectSkillSlots(undefined)).toEqual([])
  })
})

describe('the strict match', () => {
  const slot = { slot: 'erp-api', type: 'api_token' }

  it('offers and auto-attaches only records of the type whose Service URI is the slot', () => {
    const records = [rec('named', { name: 'erp-api' }), rec('other-type', { serviceUri: 'erp-api', type: 'odoo' }), rec('ok', { serviceUri: 'erp-api' })]
    expect(autoMatch(skillSlotSpec(slot), records)?.id).toBe('ok')
    expect(slotCandidates(skillSlotSpec(slot), records).map((r) => r.id)).toEqual(['ok'])
    expect(autoMatch(skillSlotSpec(slot), records.slice(0, 2))).toBeNull()
  })

  it('fills a slot only with a ready attachment of its type and Service URI, and names a wrong-typed one', () => {
    expect(judgeSkillSlot(slot, [attached('x', 'api_token', 'erp-api')])).toMatchObject({ filled: true, attachment: { id: 'x' }, typeMismatch: null })
    expect(judgeSkillSlot(slot, [attached('x', 'api_token', 'erp-api', 'expired'), attached('y', 'api_token', 'erp-api')])).toMatchObject({ filled: true, attachment: { id: 'y' } })
    expect(judgeSkillSlot(slot, [attached('x', 'api_token', 'erp-api', 'incomplete')])).toMatchObject({ filled: false, attachment: { id: 'x' } })
    expect(judgeSkillSlot(slot, [attached('m', 'odoo', 'erp-api')])).toMatchObject({ filled: false, attachment: null, typeMismatch: { id: 'm' } })
    expect(judgeSkillSlot(slot, [attached('n', 'api_token', null)])).toMatchObject({ filled: false, attachment: null, typeMismatch: null })
  })

  it('treats any attachment with the slot as the user’s choice', () => {
    expect(slotClaimed(slot, [{ serviceUri: 'erp-api' }])).toBe(true)
    expect(slotClaimed(slot, [{ serviceUri: 'erp' }, { serviceUri: null }])).toBe(false)
  })

  it('marks each declared slot of the scanned rows filled or not', () => {
    const rows = judgeSkillRows([skill('a', [{ slot: 'erp-api' }, { slot: 'crm', type: 'odoo' }])], [attached('x', 'api_token', 'erp-api'), attached('y', 'api_token', 'crm')])
    expect(rows[0].credentials).toEqual([
      { slot: 'erp-api', type: 'api_token', description: null, filled: true, attachment: { credentialId: 'x', state: 'ready' } },
      { slot: 'crm', type: 'odoo', description: null, filled: false, attachment: null }
    ])
  })
})
