import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from './testSupport/nodeSqlite'
const holder = vi.hoisted(() => ({ current: null as TestDatabase | null }))
vi.mock('./client', () => ({ getDb: () => holder.current!.db, getRawSqlite: () => holder.current!.sqlite }))
const { credentialAccountRepo, credentialRefRepo } = await import('./credentialAccounts')
beforeEach(() => { holder.current = createTestDatabase() })
afterEach(() => { holder.current?.close() })

describe('credential account records', () => {
  it('keeps each account key’s references apart from the key→profile map, replaces them whole, and drops an emptied row', () => {
    credentialAccountRepo.set('aaaa', { userId: 'u1', name: 'Alice', email: 'a@x', serverUrl: 'http://core' })
    credentialRefRepo.set('aaaa', new Map([['r1', { type: 'api_token', serviceUri: 'acme-api', name: 'Acme' }], ['r2', { type: 'odoo', serviceUri: null, name: 'ERP' }]]))
    credentialRefRepo.set('bbbb', new Map([['r3', { type: 'api_token', serviceUri: 'x', name: 'X' }]]))
    expect([...credentialAccountRepo.list().keys()]).toEqual(['aaaa'])
    expect(Object.fromEntries([...credentialRefRepo.list()].map(([k, v]) => [k, Object.fromEntries(v)]))).toEqual({
      aaaa: { r1: { type: 'api_token', serviceUri: 'acme-api', name: 'Acme' }, r2: { type: 'odoo', serviceUri: null, name: 'ERP' } },
      bbbb: { r3: { type: 'api_token', serviceUri: 'x', name: 'X' } }
    })
    credentialRefRepo.set('aaaa', new Map([['r2', { type: 'odoo', serviceUri: null, name: 'ERP' }]]))
    credentialRefRepo.set('bbbb', new Map())
    expect([...credentialRefRepo.list()].map(([k, v]) => [k, [...v.keys()]])).toEqual([['aaaa', ['r2']]])
    expect(credentialAccountRepo.list().get('aaaa')).toMatchObject({ userId: 'u1' })
  })

  it('forgets one account key’s name and leaves the rest', () => {
    credentialAccountRepo.set('aaaa', { userId: 'u1', name: 'Alice', email: 'a@x', serverUrl: 'http://core' })
    credentialAccountRepo.set('bbbb', { userId: 'u2', name: 'Bob', email: 'b@x', serverUrl: 'http://core' })
    credentialRefRepo.set('aaaa', new Map([['r1', { type: 'api_token', serviceUri: null, name: 'A' }]]))
    credentialAccountRepo.remove('aaaa')
    credentialAccountRepo.remove('missing')
    expect([...credentialAccountRepo.list().keys()]).toEqual(['bbbb'])
    expect([...credentialRefRepo.list().keys()]).toEqual(['aaaa'])
  })
})
