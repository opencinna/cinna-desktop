import { describe, it, expect } from 'vitest'
import { BuildBriefToolProvider } from './buildBriefToolProvider'
import { BUILD_BRIEF_PROVIDER_NAME, BUILD_BRIEF_RESULT, BUILD_BRIEF_TOOL } from '../../../shared/buildBrief'

const brief = {
  summary: 'Sorts the morning mail.',
  prompt: 'Build me an agent that sorts my inbox every weekday at 8.',
  capabilities: [{ id: 'schedules', state: 'used', note: 'weekdays at 8' }]
}

describe('BuildBriefToolProvider', () => {
  const provider = new BuildBriefToolProvider()

  it('offers the one tool under the shared names, outside any tool-call budget', () => {
    expect(provider.displayName).toBe(BUILD_BRIEF_PROVIDER_NAME)
    expect(provider.getTools().map((tool) => tool.name)).toEqual([BUILD_BRIEF_TOOL])
    expect(provider.budgetExempt()).toBe(true)
  })

  it('answers a valid brief with the stop-and-wait sentence', async () => {
    expect(await provider.callTool(BUILD_BRIEF_TOOL, brief)).toEqual({ content: BUILD_BRIEF_RESULT })
  })

  it('refuses an invalid brief with a sentence the agent can act on', async () => {
    const result = await provider.callTool(BUILD_BRIEF_TOOL, { ...brief, prompt: '' })
    expect(result.isError).toBe(true)
    expect(result.content).toContain('`prompt` must not be empty.')
    expect(result.content).toContain(`call ${BUILD_BRIEF_TOOL} again`)
  })
})
