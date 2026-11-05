import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * New agent with this skill: the dialog opens at its name step with the skill
 * queued, the offer is put away, and once the agent exists its add runs from
 * here — a refusal raises the offer again on the new agent's composer, and the
 * agent stays.
 */

const add = vi.fn()
window.api = { catalogSkills: { add } } as never

const { QueryClient } = await import('@tanstack/react-query')
const { addSkillToCreatedAgent, closeAddAgentDialog, openNewAgentWithSkill } = await import('./skillLinkNewAgent')
const { LOCAL_AGENTS_KEY, localAgentKey } = await import('../../hooks/useLocalAgents')
let queryClient: InstanceType<typeof QueryClient>
const { useUIStore } = await import('../../stores/ui.store')
const { NEW_CHAT_KEY, useSkillLinkOfferStore } = await import('../../stores/skillLinkOffer.store')

const LINK = { origin: 'https://cinna.test', packageId: 'test.erp', form: 'https' as const, serverGiven: true }
const SKILL = {
  packageUuid: 'uuid-1',
  packageId: 'test.erp',
  title: 'ERP lookup',
  name: 'erp-lookup',
  revisionNumber: 3,
  versionLabel: null,
  publisher: null,
  description: null,
  requiredCredentialSpecs: []
}
const QUEUED = { packageUuid: 'uuid-1', title: 'ERP lookup', link: LINK }

beforeEach(() => {
  queryClient = new QueryClient()
  add.mockReset()
  useSkillLinkOfferStore.setState({ offer: null })
  useUIStore.setState({ sidebarTab: 'chats', addAgentDialog: null, newAgentSkill: null })
})

describe('openNewAgentWithSkill', () => {
  it('queues the skill, opens Add an agent at its name step on the Agents tab, and puts the offer away', () => {
    useSkillLinkOfferStore.getState().raise(LINK, 'chat-1')
    const offer = useSkillLinkOfferStore.getState().offer!
    openNewAgentWithSkill(SKILL, offer)
    expect(useUIStore.getState()).toMatchObject({ sidebarTab: 'agents', addAgentDialog: 'name', newAgentSkill: QUEUED })
    expect(useSkillLinkOfferStore.getState().offer).toBeNull()
  })

  it('closing the dialog without creating forgets the skill (the list’s unmount closes it the same way)', () => {
    openNewAgentWithSkill(SKILL, { id: 1, link: LINK, chatKey: 'new' })
    useUIStore.getState().setAddAgentDialog(null)
    expect(useUIStore.getState().newAgentSkill).toBeNull()
  })

  it('Cancel raises the offer again on the composer it came from, and puts the sidebar tab back', () => {
    useSkillLinkOfferStore.getState().raise(LINK, 'chat-1')
    const before = useSkillLinkOfferStore.getState().offer!
    openNewAgentWithSkill(SKILL, before)
    closeAddAgentDialog({ restoreTab: true })
    expect(useSkillLinkOfferStore.getState().offer).toMatchObject({ link: LINK, chatKey: 'chat-1' })
    expect(useSkillLinkOfferStore.getState().offer!.id).not.toBe(before.id)
    expect(useUIStore.getState()).toMatchObject({ sidebarTab: 'chats', addAgentDialog: null, newAgentSkill: null })
  })

  it('the list going away raises it again but leaves the tab; a tab that was Agents already stays', () => {
    useUIStore.setState({ sidebarTab: 'agents' })
    useSkillLinkOfferStore.getState().raise(LINK, 'new')
    openNewAgentWithSkill(SKILL, useSkillLinkOfferStore.getState().offer!)
    useUIStore.setState({ sidebarTab: 'notes' })
    closeAddAgentDialog()
    expect(useSkillLinkOfferStore.getState().offer?.chatKey).toBe('new')
    expect(useUIStore.getState().sidebarTab).toBe('notes')
  })

  it('a close after Create (the queue already taken) raises nothing', () => {
    openNewAgentWithSkill(SKILL, { id: 1, link: LINK, chatKey: 'chat-1' })
    useUIStore.getState().setNewAgentSkill(null)
    closeAddAgentDialog({ restoreTab: true })
    expect(useSkillLinkOfferStore.getState().offer).toBeNull()
    expect(useUIStore.getState().sidebarTab).toBe('agents')
  })

  it('a step change inside the open dialog keeps it', () => {
    openNewAgentWithSkill(SKILL, { id: 1, link: LINK, chatKey: 'new' })
    useUIStore.getState().setAddAgentDialog('choose')
    expect(useUIStore.getState().newAgentSkill).toEqual({ ...QUEUED, chatKey: 'new', previousSidebarTab: 'chats' })
  })
})

describe('addSkillToCreatedAgent', () => {
  it('adds the queued skill to the new agent, re-reads its rows, and raises nothing when it lands', async () => {
    add.mockResolvedValue({ ok: true, name: 'erp-lookup', revisionNumber: 3 })
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    await addSkillToCreatedAgent('folder:new', QUEUED, queryClient)
    expect(add).toHaveBeenCalledWith('folder:new', 'uuid-1')
    expect(useSkillLinkOfferStore.getState().offer).toBeNull()
    expect(invalidate).toHaveBeenCalledWith({ queryKey: LOCAL_AGENTS_KEY })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: localAgentKey('folder:new') })
  })

  it('raises the offer again on the new agent’s composer with Add’s refusal', async () => {
    add.mockResolvedValue({ ok: false, code: 'download_failed', message: 'The skill could not be downloaded.' })
    await addSkillToCreatedAgent('folder:new', QUEUED, queryClient)
    expect(useSkillLinkOfferStore.getState().offer).toMatchObject({ link: LINK, chatKey: NEW_CHAT_KEY, addError: 'The skill could not be downloaded.' })
  })

  it('a thrown add is a refusal too, never an unhandled rejection', async () => {
    add.mockRejectedValue(new Error('boom'))
    await addSkillToCreatedAgent('folder:new', QUEUED, queryClient)
    expect(useSkillLinkOfferStore.getState().offer?.addError).toBeTruthy()
  })
})
