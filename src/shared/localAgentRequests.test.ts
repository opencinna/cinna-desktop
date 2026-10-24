import { describe, expect, it } from 'vitest'
import { describePermissionAction, parsePermissionRequest } from './localAgentRequests'

describe('describePermissionAction', () => {
  it("words OpenCode's skill ask as a verb phrase", () => {
    expect(describePermissionAction('skill')).toBe('load a skill')
  })

  it('words every Antigravity tool kind as a verb phrase, never as the raw action', () => {
    for (const kind of ['execute', 'edit', 'delete', 'move', 'read', 'search', 'fetch', 'other']) {
      const action = `antigravity:${kind}`
      expect(describePermissionAction(action)).not.toBe(action)
    }
    expect(describePermissionAction('antigravity:execute')).toBe('run a command')
    expect(describePermissionAction('antigravity:edit')).toBe('edit a file')
  })
})

describe('parsePermissionRequest', () => {
  it('keeps a chat runtime’s grant scope, so a block re-read from history still says "this chat"', () => {
    // Mutation: drop `rememberScope` from the parse and a reloaded block says "this agent".
    expect(parsePermissionRequest({ action: 'Bash', resources: ['ls'], rememberScope: 'chat' })).toMatchObject({ rememberScope: 'chat' })
    expect(parsePermissionRequest({ action: 'Bash', resources: ['ls'], rememberScope: 'agent' })).not.toHaveProperty('rememberScope')
    expect(parsePermissionRequest({ action: 'Bash', resources: ['ls'] })).not.toHaveProperty('rememberScope')
  })
})
