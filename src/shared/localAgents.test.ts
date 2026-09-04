import { describe, it, expect } from 'vitest'
import { folderAgentId, isFolderAgentId } from './localAgents'

describe('folder agent ids', () => {
  it('round-trips the prefix', () => {
    expect(folderAgentId('abc')).toBe('folder:abc')
    expect(isFolderAgentId('folder:abc')).toBe(true)
    expect(isFolderAgentId('remote:agent:abc')).toBe(false)
    expect(isFolderAgentId('nanoid123')).toBe(false)
  })
})
