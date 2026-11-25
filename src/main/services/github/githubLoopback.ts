/**
 * The GitHub routes of the loopback token endpoint (`serviceCredentials/tokenServer.ts`), registered
 * by the hub. The listener has already checked Host and Origin, the agent's bearer, that a turn,
 * kit command or scheduled run holds the agent, the body size and that the body is a JSON object.
 *
 * Every string value in these answers is free of `"`, `\` and newlines: the POSIX `gh` wrapper reads
 * them with sed. Every non-token answer means "try the user's own gh login first".
 *
 * Core module: no Electron.
 */
import type { GithubAgentHolder, GithubAuthService, GithubHolderConflict } from './githubAuthService'
import type { HoldOrigin } from '../localAgents/turnLock'
import { parseRepo } from './githubCoverage'
import { plainText } from './githubApi'

export interface GithubRouteAnswer { status: number; body: unknown }
export type GithubRouteHandler = (agentId: string, body: Record<string, unknown>) => Promise<GithubRouteAnswer>

export const GITHUB_MESSAGES = {
  sign_in: "GitHub isn't connected. Ask the user to click Sign in to GitHub under the message box, then run this command again.",
  reconnect: 'The GitHub sign-in has expired. Ask the user to click Reconnect GitHub under the message box, then run this command again.',
  install: (repo: string): string => `Cinna's GitHub app can't reach ${repo} yet. Ask the user to click Allow access under the message box, then run this command again.`,
  unavailable: 'GitHub could not be reached to refresh the sign-in. Try again in a moment.',
  otherProfile: 'Another Cinna profile is running this agent right now. Try again when its run has finished.'
} as const

/**
 * Whom an agent's loopback request works for, from the origins its shared holds recorded, oldest
 * first (`turnLock.sharedOrigins`). Each hold works for the profile it recorded (the profile a
 * chat's turn runs for, the starter of a kit command, the owner of a schedule), a hold that
 * recorded none for the profile active now. Folder agents are shared by every profile, so a profile
 * switch mid-turn must not hand the turn the new profile's GitHub account; and holds working for
 * different profiles at once are a conflict, never a guess, since one bearer serves them all.
 * Otherwise the newest hold answers, and its `chatless` says whether no chat shows that run.
 */
export function githubHolderOf(origins: Array<HoldOrigin | null>, activeProfile: () => string | null): GithubAgentHolder | GithubHolderConflict | null {
  const newest = origins.at(-1) ?? null
  const profiles = new Set(origins.length ? origins.map(o => o?.userId || activeProfile()) : [activeProfile()])
  if (profiles.size > 1) return { conflict: true }
  const userId = [...profiles][0]
  return userId ? { userId, chatless: newest?.chatless ?? null } : null
}

const ok = (body: unknown): GithubRouteAnswer => ({ status: 200, body })
const needed = (kind: 'sign_in' | 'reconnect'): GithubRouteAnswer => ok({ needed: kind, message: GITHUB_MESSAGES[kind] })
const NEED_KINDS = new Set(['sign_in', 'reconnect', 'install', 'gh_missing'])

export function githubLoopbackRoutes(service: GithubAuthService): Record<string, GithubRouteHandler> {
  return {
    /** `{ repo? }` → a token with the commit identity, or what is needed, or a transient refusal. */
    '/github/token': async (agentId, body) => {
      // The profile of what holds the agent now (a chat's turn, a schedule's or a command's starter).
      const holder = service.holderOf(agentId)
      if (holder && 'conflict' in holder) return ok({ unavailable: true, message: GITHUB_MESSAGES.otherProfile })
      const userId = holder?.userId
      if (!userId) return needed('sign_in')
      const repo = parseRepo(body.repo)
      const result = await service.token(userId, agentId)
      if (result.kind === 'needed') return needed(result.need)
      if (result.kind === 'unavailable') return ok({ unavailable: true, message: GITHUB_MESSAGES.unavailable })
      if (repo) {
        const coverage = await service.coverageFor(userId, repo)
        // Unknown coverage (the installations could not be read) hands the token out: GitHub enforces the bounds anyway.
        if (coverage && coverage.answer !== 'covered') return ok({ needed: 'install', message: GITHUB_MESSAGES.install(repo), repo })
      }
      const { grant } = result
      return ok({ token: grant.token, expires_at: grant.expiresAt === null ? null : Math.floor(grant.expiresAt / 1000), login: grant.login, name: plainText(grant.name) || grant.login, email: grant.email })
    },
    /**
     * `{ kind, repo? }`: nothing could authenticate (not even the user's own gh login). `gh_missing`
     * (a token but no gh) answers `{ ok, installing }`: whether a managed gh install is running.
     */
    '/github/needed': async (agentId, body) => {
      const kind = body.kind
      if (typeof kind !== 'string' || !NEED_KINDS.has(kind)) {
        return { status: 422, body: { detail: { code: 'invalid_request', message: 'Expected {"kind": "sign_in" | "reconnect" | "install" | "gh_missing", "repo"?: "owner/repo"}.' } } }
      }
      if (kind === 'gh_missing') return ok({ ok: true, installing: await service.ghMissing(agentId) })
      // Recorded under the same profile the token route answered for, so the row lands in its chats.
      const holder = service.holderOf(agentId)
      // Holders of different profiles at once: the token route refused, so nothing is recorded.
      if (holder && !('conflict' in holder)) await service.recordNeed(holder.userId, kind as 'sign_in' | 'reconnect' | 'install', body.repo, agentId, holder.chatless)
      return ok({ ok: true })
    }
  }
}
