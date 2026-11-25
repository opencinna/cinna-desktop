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
  otherProfile: 'Another Cinna profile is running this agent right now. Try again when its run has finished.',
  locked: "This agent's Cinna profile is locked. Ask the user to unlock it, then run this command again."
} as const

/**
 * The coverage and visibility reads inside one `/github/token` answer finish within this, or the
 * repository's coverage counts as unknown (the token is handed out: GitHub enforces the bounds).
 * The reads go on in the background and fill the caches for the next request.
 */
export const GITHUB_COVERAGE_DEADLINE_MS = 12_000
/**
 * The whole `/github/token` answer stays within this (a refresh may take up to
 * `GITHUB_HTTP_TIMEOUT_MS`), below the wrapper's 40 s wait, so a slow GitHub answers before curl
 * gives up.
 */
export const GITHUB_TOKEN_ROUTE_BUDGET_MS = 35_000

export interface GithubLoopbackOptions {
  coverageDeadlineMs?: number
  routeBudgetMs?: number
  now?: () => number
}

const MISSED = Symbol('missed')
/** `work`'s value, or {@link MISSED} when it has not settled within `ms` (the work itself goes on). */
function within<T>(work: Promise<T>, ms: number): Promise<T | typeof MISSED> {
  if (ms <= 0) return Promise.resolve(MISSED)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(MISSED), ms)
    timer.unref?.()
    work.then(value => { clearTimeout(timer); resolve(value) }, error => { clearTimeout(timer); reject(error) })
  })
}

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
  // Chatless only when no hold could be a chat's: every hold recorded a chatless origin.
  const chatless = origins.length > 0 && origins.every(o => !!o?.chatless) ? newest?.chatless ?? null : null
  return userId ? { userId, chatless } : null
}

const ok = (body: unknown): GithubRouteAnswer => ({ status: 200, body })
const needed = (kind: 'sign_in' | 'reconnect'): GithubRouteAnswer => ok({ needed: kind, message: GITHUB_MESSAGES[kind] })
const NEED_KINDS = new Set(['sign_in', 'reconnect', 'install', 'gh_missing'])

export function githubLoopbackRoutes(service: GithubAuthService, options: GithubLoopbackOptions = {}): Record<string, GithubRouteHandler> {
  const now = options.now ?? Date.now
  const coverageDeadlineMs = options.coverageDeadlineMs ?? GITHUB_COVERAGE_DEADLINE_MS
  const routeBudgetMs = options.routeBudgetMs ?? GITHUB_TOKEN_ROUTE_BUDGET_MS
  return {
    /**
     * `{ repo?, via? }` → a token with the commit identity, or what is needed, or a transient
     * refusal. `via`: `"git"` from git's credential helper (a push, or a fetch of a repository
     * that is not public: a public clone or fetch never asks), `"write"` for a gh command the
     * wrapper knows changes something, `"gh"` for any other gh command. Absent or anything else
     * reads as `"git"` (fail closed: an uncovered repository then needs Allow access).
     */
    '/github/token': async (agentId, body) => {
      const started = now()
      // The profile of what holds the agent now (a chat's turn, a schedule's or a command's starter).
      const holder = service.holderOf(agentId)
      if (holder && 'conflict' in holder) return ok({ unavailable: true, message: GITHUB_MESSAGES.otherProfile })
      if (holder && 'locked' in holder) return ok({ unavailable: true, message: GITHUB_MESSAGES.locked })
      const userId = holder?.userId
      if (!userId) return needed('sign_in')
      const repo = parseRepo(body.repo)
      const via = body.via === 'gh' ? 'gh' : body.via === 'write' ? 'write' : 'git'
      const result = await service.token(userId)
      if (result.kind === 'needed') return needed(result.need)
      if (result.kind === 'unavailable') return ok({ unavailable: true, message: GITHUB_MESSAGES.unavailable })
      if (repo) {
        // Coverage and visibility share one deadline; a read that misses it counts as unknown coverage.
        const deadline = Math.min(now() + coverageDeadlineMs, started + routeBudgetMs)
        const coverage = await within(service.coverageFor(userId, repo), deadline - now())
        // Unknown coverage (unreadable, or not read in time) hands the token out: GitHub enforces the bounds anyway.
        if (coverage !== MISSED && coverage && coverage.answer !== 'covered') {
          const install = ok({ needed: 'install', message: GITHUB_MESSAGES.install(repo), repo })
          // git asks only to push or to fetch a repository that is not public, and a write needs the
          // app on the repository whatever its visibility: Allow access.
          if (via !== 'gh') return install
          // A gh read of a public repository works with the token. Unknown visibility (not read in
          // time, or GitHub could not say) counts as unknown coverage: the token.
          const visibility = await within(service.visibilityFor(userId, repo), deadline - now())
          if (visibility === 'private') return install
        }
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
      // Holders of different profiles at once, or a locked profile: the token route refused, so nothing is recorded.
      if (holder && 'userId' in holder) await service.recordNeed(holder.userId, kind as 'sign_in' | 'reconnect' | 'install', body.repo, agentId, holder.chatless)
      return ok({ ok: true })
    }
  }
}
