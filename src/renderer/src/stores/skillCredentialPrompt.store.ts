import { create } from 'zustand'
import type { LocalAgentDto, LocalAgentSkill, LocalAgentSkillCredential } from '../../../shared/localAgents'

/**
 * The skills the composer should prompt for, per agent, after Add to agent or
 * Update: main names them once its background fill of the agent's skill slots
 * settles (`skillSlotsSettled` on `service-credentials:changed`), and the
 * composer's skill-credential row reads what each still lacks from the agent's
 * own DTO. A prompt goes on the row's ×, or once the skill is gone or its slots are all
 * filled (the composer drops it). App-session lifetime, like `finishSetup.store`; the Addons tab's
 * Skills row stays the standing hint once a prompt is dismissed.
 */
interface SkillCredentialPromptStore {
  /** Skill names to prompt for, per agent id, in the order they were raised. */
  prompts: Record<string, string[]>
  /**
   * How many times main's skill-slot fill has settled for each agent this session, bumped on every
   * `skillSlotsSettled` once the agent's DTO is re-read, whether or not anything was raised. A
   * skill-link offer that ran Add waits for it to pass the value it saw at the click.
   */
  settled: Record<string, number>
  /** Prompt for these skills of `agentId` (added to any already raised). */
  raise: (agentId: string, skills: readonly string[]) => void
  /** One settled fill: raise `skills` (those still lacking a credential) and bump the counter, in one update. */
  settle: (agentId: string, skills: readonly string[]) => void
  /** Stop prompting for these skills of `agentId` (gone from the agent, or every slot filled). */
  drop: (agentId: string, skills: readonly string[]) => void
  /** Put the agent's prompt away (the row's ×). */
  dismiss: (agentId: string) => void
}

function raised(prompts: Record<string, string[]>, agentId: string, skills: readonly string[]): Record<string, string[]> {
  if (skills.length === 0) return prompts
  return { ...prompts, [agentId]: [...new Set([...(prompts[agentId] ?? []), ...skills])] }
}

function without(prompts: Record<string, string[]>, agentId: string): Record<string, string[]> {
  const { [agentId]: _gone, ...rest } = prompts
  return rest
}

export const useSkillCredentialPromptStore = create<SkillCredentialPromptStore>((set) => ({
  prompts: {},
  settled: {},
  raise: (agentId, skills) => {
    if (skills.length === 0) return
    set((state) => ({ prompts: raised(state.prompts, agentId, skills) }))
  },
  settle: (agentId, skills) =>
    set((state) => ({
      prompts: raised(state.prompts, agentId, skills),
      settled: { ...state.settled, [agentId]: (state.settled[agentId] ?? 0) + 1 }
    })),
  drop: (agentId, skills) =>
    set((state) => {
      const current = state.prompts[agentId]
      if (!current || !skills.some((name) => current.includes(name))) return state
      const kept = current.filter((name) => !skills.includes(name))
      return { prompts: kept.length ? { ...state.prompts, [agentId]: kept } : without(state.prompts, agentId) }
    }),
  dismiss: (agentId) =>
    set((state) => (agentId in state.prompts ? { prompts: without(state.prompts, agentId) } : state))
}))

/**
 * Of the skills `names`, those on `folder` that are deliverable and still lack a credential, in the
 * order named, each with its unfilled slots: only slots the scan judged unfilled (`filled === false`;
 * not judged is not missing). What the composer's row shows, what the watcher raises, and what is
 * kept when the row prunes.
 */
export function skillsLackingCredentials(
  folder: Pick<LocalAgentDto, 'skills'>,
  names: readonly string[]
): { skill: LocalAgentSkill; missing: LocalAgentSkillCredential[] }[] {
  return names.flatMap((name) => {
    const skill = folder.skills?.find((s) => s.name === name && s.deliverable)
    const missing = skill?.credentials.filter((slot) => slot.filled === false) ?? []
    return skill && missing.length > 0 ? [{ skill, missing }] : []
  })
}
