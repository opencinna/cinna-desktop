import { describe, it, expect } from 'vitest'
import {
  GUIDED_BUILD_TITLE,
  decideGuidedChat,
  guidedBuildSection,
  isUnbuiltKitAgent,
  type GuidedChatInput,
  type UnbuiltInput
} from './guidedBuild'

/** Exactly what the kit's scaffold leaves behind. */
const scaffold: UnbuiltInput = {
  scripts: ['README.md', 'update_status.py', 'cinna_credentials.py'],
  skills: ['README.md'],
  credentials: [],
  schedules: [],
  shared: false,
  guidedDone: false
}

describe('isUnbuiltKitAgent', () => {
  it('is true for the scaffold as it was made, caches and dotfiles included', () => {
    expect(isUnbuiltKitAgent(scaffold)).toBe(true)
    expect(isUnbuiltKitAgent({ ...scaffold, scripts: [...scaffold.scripts, '__pycache__', '.DS_Store'], skills: ['README.md', '.gitkeep'] })).toBe(true)
    // Absent folders and absent manifest arrays are none, not something built.
    expect(isUnbuiltKitAgent({ ...scaffold, scripts: [], skills: [], credentials: undefined, schedules: undefined })).toBe(true)
  })

  it('is false once anything was built', () => {
    expect(isUnbuiltKitAgent({ ...scaffold, scripts: [...scaffold.scripts, 'fetch_mail.py'] })).toBe(false)
    expect(isUnbuiltKitAgent({ ...scaffold, skills: ['README.md', 'triage'] })).toBe(false)
    expect(isUnbuiltKitAgent({ ...scaffold, credentials: [{ name: 'GMAIL' }] })).toBe(false)
    expect(isUnbuiltKitAgent({ ...scaffold, schedules: [{ name: 'daily' }] })).toBe(false)
  })

  it('is false when the guided build was done or dismissed, and for a shared or catalog agent', () => {
    expect(isUnbuiltKitAgent({ ...scaffold, guidedDone: true })).toBe(false)
    expect(isUnbuiltKitAgent({ ...scaffold, shared: true })).toBe(false)
  })
})

describe('decideGuidedChat', () => {
  const eligible: GuidedChatInput = {
    requested: true,
    settingOn: true,
    alreadyGuided: false,
    hasContent: false,
    router: 'direct',
    agentId: 'folder:a',
    attachedAgents: 0,
    agent: { unbuilt: true }
  }

  it('is true only for a requested, empty, direct chat with one unbuilt kit agent and the setting on', () => {
    expect(decideGuidedChat(eligible)).toBe(true)
  })

  it.each([
    ['not requested', { requested: false }],
    ['setting off', { settingOn: false }],
    ['already guided', { alreadyGuided: true }],
    ['something already said', { hasContent: true }],
    ['several agents', { router: 'human' }],
    ['coordinated', { router: 'coordinator' }],
    ['no agent', { agentId: null }],
    ['an agent attached beside it', { attachedAgents: 1 }],
    ['not a folder agent', { agent: null }],
    ['a built (or bare) agent', { agent: { unbuilt: false } }]
  ] as const)('is false when %s', (_label, patch) => {
    expect(decideGuidedChat({ ...eligible, ...patch } as GuidedChatInput)).toBe(false)
  })
})

describe('guidedBuildSection', () => {
  it('says what the guidance asks for, and ends with the brief tool', () => {
    const section = guidedBuildSection({ name: 'Mail helper', description: 'Mail helper' })
    expect(section.split('\n')[0]).toBe(GUIDED_BUILD_TITLE)
    for (const phrase of [
      'has not been built yet',
      'do not build, and do not edit the agent folder',
      'task rather than a job description',
      '"Build me for that", "Just try it once", "Something else"',
      'Never end a turn on a question in plain text',
      'names an area rather than a job',
      'where they manage it',
      'Name the role in the brief',
      'At most four questions, in one round',
      'recommended option marked',
      'Never ask what they already said',
      'what comes out and when it runs, skip the questions',
      'holds only what they said or chose',
      'a topic ("AI news", "my expenses") is not one',
      '`../../.cinna-kit/README.md`',
      '`guides/13-design-patterns.md` §0',
      'the Credentials tab, the Schedules tab',
      'No file names or manifest fields toward the person',
      'Never ask for a password, token or key in chat',
      'never write a plan of your own for approval',
      'call it again with the revision'
    ]) expect(section).toContain(phrase)
    expect(section.split('\n').at(-1)).toContain('`build_brief_propose`')
  })

  it('seeds the description only when it says more than the name', () => {
    expect(guidedBuildSection({ name: 'Mail helper', description: 'mail helper ' })).not.toContain('At creation')
    expect(guidedBuildSection({ name: 'Mail helper', description: null })).not.toContain('At creation')
    expect(guidedBuildSection({ name: 'Mail helper', description: 'Sorts my "work" inbox' }))
      .toContain('- At creation the person described it as: "Sorts my \\"work\\" inbox"')
  })
})
