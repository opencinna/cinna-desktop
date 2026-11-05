import { beforeEach, describe, expect, it } from 'vitest'
import { useSkillCredentialPromptStore } from './skillCredentialPrompt.store'

describe('skillCredentialPrompt.store', () => {
  beforeEach(() => useSkillCredentialPromptStore.setState({ prompts: {}, settled: {} }))

  it('raises skills per agent, keeping the first order and each name once', () => {
    const { raise } = useSkillCredentialPromptStore.getState()
    raise('folder:a', ['erp'])
    raise('folder:a', ['crm', 'erp'])
    raise('folder:b', ['mail'])
    raise('folder:c', [])
    expect(useSkillCredentialPromptStore.getState().prompts).toEqual({ 'folder:a': ['erp', 'crm'], 'folder:b': ['mail'] })
  })

  it('dismisses one agent’s prompt only, and a dismissal of nothing changes nothing', () => {
    const { raise, dismiss } = useSkillCredentialPromptStore.getState()
    raise('folder:a', ['erp'])
    raise('folder:b', ['mail'])
    dismiss('folder:a')
    expect(useSkillCredentialPromptStore.getState().prompts).toEqual({ 'folder:b': ['mail'] })
    const before = useSkillCredentialPromptStore.getState().prompts
    dismiss('folder:none')
    expect(useSkillCredentialPromptStore.getState().prompts).toBe(before)
    // Raised again after a dismissal (another Add), it comes back.
    raise('folder:a', ['erp'])
    expect(useSkillCredentialPromptStore.getState().prompts['folder:a']).toEqual(['erp'])
  })

  it('counts every settled fill per agent, raising what it names in the same update', () => {
    const { settle } = useSkillCredentialPromptStore.getState()
    settle('folder:a', [])
    expect(useSkillCredentialPromptStore.getState()).toMatchObject({ prompts: {}, settled: { 'folder:a': 1 } })
    settle('folder:a', ['erp'])
    settle('folder:b', ['mail'])
    expect(useSkillCredentialPromptStore.getState()).toMatchObject({
      prompts: { 'folder:a': ['erp'], 'folder:b': ['mail'] },
      settled: { 'folder:a': 2, 'folder:b': 1 }
    })
  })

  it('drops named skills only, and the agent once none is left', () => {
    const { raise, drop } = useSkillCredentialPromptStore.getState()
    raise('folder:a', ['erp', 'crm'])
    const before = useSkillCredentialPromptStore.getState().prompts
    drop('folder:a', ['other'])
    drop('folder:none', ['erp'])
    expect(useSkillCredentialPromptStore.getState().prompts).toBe(before)
    drop('folder:a', ['erp'])
    expect(useSkillCredentialPromptStore.getState().prompts).toEqual({ 'folder:a': ['crm'] })
    drop('folder:a', ['crm'])
    expect(useSkillCredentialPromptStore.getState().prompts).toEqual({})
  })
})
