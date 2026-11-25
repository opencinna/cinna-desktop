/**
 * What a profile's agents could not do with GitHub, as rows under the composer: in memory, per
 * profile. One sign-in/reconnect need per profile (key `account`), one install need per owner
 * (key `install:<owner lowercased>`, repositories merged). Each remembers the agents that hit it.
 */
import type { GithubNeedDto } from '../../../shared/github'
import { ownerOf } from './githubCoverage'

export const ACCOUNT_NEED = 'account'
export const installNeedKey = (owner: string): string => `install:${owner.toLowerCase()}`

export function createNeedsRegistry() {
  const byProfile = new Map<string, Map<string, GithubNeedDto>>()
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
      if (!need) { needs.set(ACCOUNT_NEED, { key: ACCOUNT_NEED, kind, agentIds: agentId ? [agentId] : [] }); return true }
      const kindChanged = need.kind !== kind
      need.kind = kind
      return addAgent(need, agentId) || kindChanged
    },
    recordInstall(userId: string, repo: string, installUrl: string, agentId?: string): boolean {
      const owner = ownerOf(repo), key = installNeedKey(owner), needs = of(userId), need = needs.get(key)
      if (!need) { needs.set(key, { key, kind: 'install', owner, repos: [repo], installUrl, agentIds: agentId ? [agentId] : [] }); return true }
      let changed = false
      if (!need.repos!.some(r => r.toLowerCase() === repo.toLowerCase())) { need.repos!.push(repo); changed = true }
      if (need.installUrl !== installUrl) { need.installUrl = installUrl; changed = true }
      return addAgent(need, agentId) || changed
    },
    clearAccount(userId: string): boolean { return byProfile.get(userId)?.delete(ACCOUNT_NEED) ?? false },
    /** Drop every install need whose repositories are all covered now. */
    clearCovered(userId: string, covered: (repo: string) => boolean): boolean {
      const needs = byProfile.get(userId)
      let changed = false
      for (const [key, need] of needs ?? []) if (need.kind === 'install' && need.repos!.every(covered)) { needs!.delete(key); changed = true }
      return changed
    },
    dismiss(userId: string, key: string): boolean { return byProfile.get(userId)?.delete(key) ?? false },
    clear(userId: string): boolean { const had = (byProfile.get(userId)?.size ?? 0) > 0; byProfile.delete(userId); return had },
    list(userId: string): GithubNeedDto[] {
      return [...(byProfile.get(userId)?.values() ?? [])].map(n => ({ ...n, agentIds: [...n.agentIds], ...(n.repos ? { repos: [...n.repos] } : {}) }))
    }
  }
}
export type GithubNeedsRegistry = ReturnType<typeof createNeedsRegistry>
