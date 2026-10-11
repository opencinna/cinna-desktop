import { describe, expect, it } from 'vitest'
import { describePermissionAction } from './localAgentRequests'

describe('describePermissionAction', () => {
  it('words every Antigravity tool kind as a verb phrase, never as the raw action', () => {
    for (const kind of ['execute', 'edit', 'delete', 'move', 'read', 'search', 'fetch', 'other']) {
      const action = `antigravity:${kind}`
      expect(describePermissionAction(action)).not.toBe(action)
    }
    expect(describePermissionAction('antigravity:execute')).toBe('run a command')
    expect(describePermissionAction('antigravity:edit')).toBe('edit a file')
  })
})
