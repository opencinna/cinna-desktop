import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../host/runtimeHost', () => ({
  runtimeHost: { isPackaged: false, getAppPath: () => process.cwd(), resourcesPath: '', getPath: () => '/nonexistent' }
}))
vi.mock('../../logger/logger', () => ({ createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }) }))

const { artifactsSkillDeliveryFor, artifactsSkillInfo, cinnaArtifactsSection, installArtifactsSkillGate } = await import('./artifactsSkill')
const { resolveDesktopPromptContext } = await import('../localAgents/promptAssembly')

/** An agent reads about artifacts only while the active profile's instance keeps them. */
describe('the cinna-artifacts skill gate', () => {
  afterEach(() => installArtifactsSkillGate(() => false))

  it('is closed until the artifact service opens it, and follows its answer', () => {
    expect(artifactsSkillInfo().available).toBe(false)
    installArtifactsSkillGate(() => true)
    expect(artifactsSkillInfo()).toMatchObject({ available: true, skillFile: expect.stringMatching(/skills\/cinna-artifacts\/SKILL\.md$/) })
    installArtifactsSkillGate(() => { throw new Error('boom') })
    expect(artifactsSkillInfo().available).toBe(false)
  })

  it('is a skill for Claude and OpenCode, a pointer for Codex and Antigravity, and nothing when closed', () => {
    installArtifactsSkillGate(() => true)
    expect(artifactsSkillDeliveryFor('claude')).toEqual({ kind: 'skill' })
    expect(artifactsSkillDeliveryFor('codex')).toMatchObject({ kind: 'pointer', path: expect.stringMatching(/SKILL\.md$/) })
    installArtifactsSkillGate(() => false)
    expect(artifactsSkillDeliveryFor('claude')).toBeNull()
  })

  it('reaches the system prompt only while open', () => {
    expect(resolveDesktopPromptContext('codex').artifactsSkill).toBeUndefined()
    installArtifactsSkillGate(() => true)
    const context = resolveDesktopPromptContext('codex')
    expect(context.artifactsSkill).toMatchObject({ kind: 'pointer' })
    expect(cinnaArtifactsSection(context.artifactsSkill ?? null)[0]).toMatch(/## Cinna artifacts[\s\S]*artifacts_publish[\s\S]*Read `.*SKILL\.md`/)
    expect(cinnaArtifactsSection(null)).toEqual([])
  })
})
