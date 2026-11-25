/**
 * What a profile's agents could not do with GitHub, as rows under the composer: in memory, per
 * profile. One sign-in/reconnect need per profile (key `account`), one install need per owner
 * (key `install:<owner lowercased>`, repositories merged). Each remembers the agents that hit it.
 *
 * Agents that hit a need from a run no chat shows (`chatless`) are listed apart, in
 * `chatlessAgentIds`: that need is also an Inbox item and an agent-page row.
 *
 * The keys the user dismissed are remembered too (`dismissedKeys`), so the renderer can tell a row
 * the user closed from one that resolved: recording the same need again takes its key off the list,
 * and sign-out (`clear`) empties it.
 */
import type { GithubNeedDto } from '../../../shared/github'
import { ownerOf } from './githubCoverage'

export const ACCOUNT_NEED = 'account'
export const installNeedKey = (owner: string): string => `install:${owner.toLowerCase()}`

export function createNeedsRegistry() {
  const byProfile = new Map<string, Map<string, GithubNeedDto>>()
  const dismissedBy = new Map<string, Set<string>>()
  /** The key is recorded again: no longer dismissed. Answers whether it was. */
  const undismiss = (userId: string, key: string): boolean => dismissedBy.get(userId)?.delete(key) ?? false
  const of = (userId: string): Map<string, GithubNeedDto> => {
    let needs = byProfile.get(userId)
    if (!needs) { needs = new Map(); byProfile.set(userId, needs) }
    return needs
  }
  const addAgent = (need: GithubNeedDto, agentId?: string, chatless = false): boolean => {
    if (!agentId) return false
    let changed = false
    if (!need.agentIds.includes(agentId)) { need.agentIds.push(agentId); changed = true }
    if (chatless && !need.chatlessAgentIds!.includes(agentId)) { need.chatlessAgentIds!.push(agentId); changed = true }
    return changed
  }
  const firstAgents = (agentId?: string, chatless = false) => ({
    agentIds: agentId ? [agentId] : [], chatlessAgentIds: agentId && chatless ? [agentId] : []
  })

  return {
    /**
     * Sign in or reconnect. A recorded one of the other kind takes the new kind. `chatless`: the
     * agent hit it from a run no chat shows. Answers whether anything changed.
     */
    recordAccount(userId: string, kind: 'sign_in' | 'reconnect', agentId?: string, chatless = false): boolean {
      const needs = of(userId), need = needs.get(ACCOUNT_NEED)
      const wasDismissed = undismiss(userId, ACCOUNT_NEED)
      if (!need) { needs.set(ACCOUNT_NEED, { key: ACCOUNT_NEED, kind, ...firstAgents(agentId, chatless) }); return true }
      const kindChanged = need.kind !== kind
      need.kind = kind
      return addAgent(need, agentId, chatless) || kindChanged || wasDismissed
    },
    recordInstall(userId: string, repo: string, installUrl: string, agentId?: string, chatless = false): boolean {
      const owner = ownerOf(repo), key = installNeedKey(owner), needs = of(userId), need = needs.get(key)
      const wasDismissed = undismiss(userId, key)
      if (!need) { needs.set(key, { key, kind: 'install', owner, repos: [repo], installUrl, ...firstAgents(agentId, chatless) }); return true }
      let changed = false
      if (!need.repos!.some(r => r.toLowerCase() === repo.toLowerCase())) { need.repos!.push(repo); changed = true }
      if (need.installUrl !== installUrl) { need.installUrl = installUrl; changed = true }
      return addAgent(need, agentId, chatless) || changed || wasDismissed
    },
    clearAccount(userId: string): boolean { return byProfile.get(userId)?.delete(ACCOUNT_NEED) ?? false },
    /** Drop every install need whose repositories are all covered now. */
    clearCovered(userId: string, covered: (repo: string) => boolean): boolean {
      const needs = byProfile.get(userId)
      let changed = false
      for (const [key, need] of needs ?? []) if (need.kind === 'install' && need.repos!.every(covered)) { needs!.delete(key); changed = true }
      return changed
    },
    /** Drop the need and remember its key as dismissed. Answers whether anything changed. */
    dismiss(userId: string, key: string): boolean {
      const removed = byProfile.get(userId)?.delete(key) ?? false
      // The key comes from the renderer: only a need key's shape is remembered.
      if (key !== ACCOUNT_NEED && !/^install:\S{1,100}$/.test(key)) return removed
      let keys = dismissedBy.get(userId)
      if (!keys) { keys = new Set(); dismissedBy.set(userId, keys) }
      const added = !keys.has(key)
      keys.add(key)
      return removed || added
    },
    /** Sign-out or profile removal: every need and every dismissed key go. */
    clear(userId: string): boolean {
      const had = (byProfile.get(userId)?.size ?? 0) > 0 || (dismissedBy.get(userId)?.size ?? 0) > 0
      byProfile.delete(userId)
      dismissedBy.delete(userId)
      return had
    },
    dismissedKeys(userId: string): string[] { return [...(dismissedBy.get(userId) ?? [])] },
    list(userId: string): GithubNeedDto[] {
      // `chatlessAgentIds` only when a run no chat shows hit the need.
      return [...(byProfile.get(userId)?.values() ?? [])].map(({ chatlessAgentIds, ...n }) => ({
        ...n, agentIds: [...n.agentIds], ...(chatlessAgentIds?.length ? { chatlessAgentIds: [...chatlessAgentIds] } : {}), ...(n.repos ? { repos: [...n.repos] } : {})
      }))
    }
  }
}
export type GithubNeedsRegistry = ReturnType<typeof createNeedsRegistry>
