import { describe, expect, it } from 'vitest'
import { formatComponentReference, ownReferencePrefix, parseComponentReference } from './componentReference'

const ID = '0f8e2c1a-3b4d-4e5f-8a9b-0c1d2e3f4a5b'

describe('parseComponentReference', () => {
  it('reads the three agent forms, with and without a skill', () => {
    expect(parseComponentReference(`cinna://component/id:${ID}/deals`)).toMatchObject({ agent: { kind: 'id', value: ID }, skill: null, name: 'deals' })
    expect(parseComponentReference('cinna://component/bundle:io.example.cinna.ab12cd34/crm-kit/deals')).toMatchObject({
      agent: { kind: 'bundle', value: 'io.example.cinna.ab12cd34' },
      skill: 'crm-kit',
      name: 'deals'
    })
    expect(parseComponentReference('cinna://component/sales-agent/deals-pipeline')).toMatchObject({ agent: { kind: 'slug', value: 'sales-agent' } })
  })

  it('lower-cases an id so two spellings are one agent', () => {
    expect(parseComponentReference(`cinna://component/id:${ID.toUpperCase()}/deals`)?.agent.value).toBe(ID)
  })

  it('never guesses a form from the shape', () => {
    expect(parseComponentReference('cinna://component/io.example.cinna.ab12cd34/deals')).toBeNull()
    expect(parseComponentReference(`cinna://component/${ID.toUpperCase()}/deals`)).toBeNull()
    expect(parseComponentReference('cinna://component/team:sales/deals')).toBeNull()
  })

  it('refuses anything that is not exactly a reference', () => {
    for (const text of [
      'cinna://component/sales-agent',
      'cinna://component/sales-agent/deals/',
      'cinna://component/sales-agent/a/b/c',
      'cinna://component/sales-agent/Deals',
      'cinna://component/sales-agent/deals?x=1',
      'cinna://component/sales-agent/../deals',
      'cinna://component/sales-agent/crm_kit/deals',
      ' cinna://component/sales-agent/deals',
      'cinna://connect/sales-agent/deals',
      'https://component/sales-agent/deals'
    ]) {
      expect(parseComponentReference(text), text).toBeNull()
    }
  })

  it('round-trips through formatComponentReference', () => {
    for (const text of [`cinna://component/id:${ID}/deals`, 'cinna://component/bundle:io.x.y/kit/deals', 'cinna://component/sales/deals']) {
      const ref = parseComponentReference(text)!
      expect(formatComponentReference(ref.agent, ref.skill, ref.name)).toBe(text)
    }
  })

  it('gives an agent the bundle prefix when it has a bundle id', () => {
    expect(ownReferencePrefix(ID, 'io.x.y')).toBe('cinna://component/bundle:io.x.y/')
    expect(ownReferencePrefix(ID, null)).toBe(`cinna://component/id:${ID}/`)
  })
})
