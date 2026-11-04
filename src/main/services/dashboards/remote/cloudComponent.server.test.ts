import { describe, expect, it } from 'vitest'
import { onOtherCoreServer, sameCoreServer } from './cloudComponent'

describe('core server comparison (D6)', () => {
  it('ignores case and trailing slashes', () => {
    expect(sameCoreServer('https://Cinna.Example.com/', 'https://cinna.example.com')).toBe(true)
    expect(sameCoreServer('https://a.example.com', 'https://b.example.com')).toBe(false)
  })

  it('never matches a missing side', () => {
    expect(sameCoreServer(null, 'https://a.example.com')).toBe(false)
    expect(sameCoreServer('https://a.example.com', null)).toBe(false)
  })

  it('says "another server" only when both are known and differ', () => {
    expect(onOtherCoreServer('https://a.example.com/', 'https://A.example.com')).toBe(false)
    expect(onOtherCoreServer('https://a.example.com', 'https://b.example.com')).toBe(true)
    // Signed out: a sign-in problem, not another server.
    expect(onOtherCoreServer('https://a.example.com', null)).toBe(false)
    // No backing dashboard yet.
    expect(onOtherCoreServer(null, 'https://a.example.com')).toBe(false)
  })
})
