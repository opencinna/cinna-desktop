/**
 * What a profile's agents could not do with GitHub, as rows under the composer: in memory, per
 * profile. One sign-in/reconnect need per profile (key `account`), one install need per owner
 * (key `install:<owner lowercased>`, repositories merged). Each remembers the agents that hit it.
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
  const addAgent = (need: GithubNeedDto, agentId?: string): boolean => {
    if (!agentId || need.agentIds.includes(agentId)) return false
    need.agentIds.push(agentId); return true
  }

  return {
    /** Sign in or reconnect. A recorded one of the other kind takes the new kind. Answers whether anything changed. */
    recordAccount(userId: string, kind: 'sign_in' | 'reconnect', agentId?: string): boolean {
      const needs = of(userId), need = needs.get(ACCOUNT_NEED)
      const wasDismissed = undismiss(userId, ACCOUNT_NEED)
      if (!need) { needs.set(ACCOUNT_NEED, { key: ACCOUNT_NEED, kind, agentIds: agentId ? [agentId] : [] }); return true }
      const kindChanged = need.kind !== kind
      need.kind = kind
      return addAgent(need, agentId) || kindChanged || wasDismissed
    },
    recordInstall(userId: string, repo: string, installUrl: string, agentId?: string): boolean {
      const owner = ownerOf(repo), key = installNeedKey(owner), needs = of(userId), need = needs.get(key)
      const wasDismissed = undismiss(userId, key)
      if (!need) { needs.set(key, { key, kind: 'install', owner, repos: [repo], installUrl, agentIds: agentId ? [agentId] : [] }); return true }
      let changed = false
      if (!need.repos!.some(r => r.toLowerCase() === repo.toLowerCase())) { need.repos!.push(repo); changed = true }
      if (need.installUrl !== installUrl) { need.installUrl = installUrl; changed = true }
      return addAgent(need, agentId) || changed || wasDismissed
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
      return [...(byProfile.get(userId)?.values() ?? [])].map(n => ({ ...n, agentIds: [...n.agentIds], ...(n.repos ? { repos: [...n.repos] } : {}) }))
    }
  }
}
export type GithubNeedsRegistry = ReturnType<typeof createNeedsRegistry>
