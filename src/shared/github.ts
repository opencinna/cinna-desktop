/**
 * GitHub repos: the OpenCinna GitHub App and the DTOs the renderer sees. Dependency-free, so the
 * renderer may import it. No token, refresh token or email ever appears in these shapes.
 */

/** The public GitHub App every Cinna profile signs in to with the device flow (no secret, no private key). */
export const OPENCINNA_APP = { clientId: 'Iv23liFC50gymAL3DTF1', slug: 'opencinna' } as const
export const OPENCINNA_INSTALL_URL = 'https://github.com/apps/opencinna/installations/new'

/** Published (audience `all`) whenever a profile's GitHub sign-in, coverage, device flow or needs change. */
export const GITHUB_CHANGED = 'github:changed'

export type GithubAccountState = 'connected' | 'expired'
/** `admin` is reserved: nothing in P1 can tell it apart (no org scopes), so it is never produced. */
export type GithubNeedKind = 'sign_in' | 'reconnect' | 'install' | 'admin'

/** One installation of the OpenCinna app the signed-in user can see. */
export interface GithubCoverage {
  installationId: number
  owner: string
  ownerType: 'User' | 'Organization'
  ownerId: number
  selection: 'all' | 'selected'
  /** `owner/repo` for a `selected` installation; empty for `all`. */
  repos: string[]
}

export interface GithubNeedDto {
  /** `account` for sign-in / reconnect, `install:<owner lowercased>` for an install. */
  key: string
  kind: GithubNeedKind
  owner?: string
  repos?: string[]
  installUrl?: string
  /** The agents whose commands hit it. */
  agentIds: string[]
}

export interface GithubDeviceFlowDto {
  userCode: string
  verificationUri: string
  /** Epoch ms. */
  expiresAt: number
  state: 'pending' | 'expired' | 'denied' | 'error'
  error?: string
}

export interface GithubStatusDto {
  account: { login: string; state: GithubAccountState; coverage: GithubCoverage[]; coverageFetchedAt: number | null } | null
  device: GithubDeviceFlowDto | null
  needs: GithubNeedDto[]
}

/** What every `github:*` IPC answers: a refusal is data, since a thrown error's code never reaches the renderer. */
export type GithubResult<T> = { ok: true; value: T } | { ok: false; error: string }

/** The two fixed github.com pages the renderer may ask main to open (never an arbitrary URL). */
export const GITHUB_URLS = {
  manage: OPENCINNA_INSTALL_URL,
  applications: 'https://github.com/settings/applications'
} as const
export type GithubUrlTarget = keyof typeof GITHUB_URLS
