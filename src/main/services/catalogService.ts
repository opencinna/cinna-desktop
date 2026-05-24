/**
 * Bundles catalog proxy — forwards `/api/v1/catalog/*` and the install
 * setup-status endpoints to the active Cinna server. The desktop does NOT
 * own the install lifecycle; cinna-server is the source of truth. We only
 * project DTOs into camelCase and hide secrets, so the renderer can render
 * a "Catalog" tab that mirrors the cinna-server catalog page.
 */
import { net } from 'electron'
import { userRepo } from '../db/users'
import { getCinnaAccessToken } from '../auth/cinna-tokens'
import { CinnaReauthRequired } from '../auth/cinna-oauth'
import { CinnaApiError } from '../errors'
import { createLogger } from '../logger/logger'
import type {
  CatalogEntryDto,
  CatalogCredentialSpec,
  CatalogInstallResultDto,
  SetupStatusDto,
  SetupMissingItemDto,
  SetupCredentialSummaryDto
} from '../../shared/catalog'

const logger = createLogger('catalog-api')

interface FetchOptions {
  method?: string
  body?: unknown
}

function resolveBaseUrl(userId: string): string {
  const user = userRepo.get(userId)
  if (!user) throw new CinnaApiError('not_cinna_user', 'User not found')
  if (user.type !== 'cinna_user') {
    throw new CinnaApiError('not_cinna_user', 'Profile is not linked to Cinna')
  }
  if (!user.cinnaServerUrl) {
    throw new CinnaApiError('missing_server_url', 'Cinna server URL is not configured')
  }
  return user.cinnaServerUrl.replace(/\/$/, '')
}

async function resolveAuthHeader(userId: string): Promise<string> {
  try {
    const token = await getCinnaAccessToken(userId)
    return `Bearer ${token}`
  } catch (err) {
    if (err instanceof CinnaReauthRequired) {
      throw new CinnaApiError('reauth_required', err.message)
    }
    throw err
  }
}

async function cinnaFetch<T>(userId: string, path: string, opts: FetchOptions = {}): Promise<T> {
  const baseUrl = resolveBaseUrl(userId)
  const authHeader = await resolveAuthHeader(userId)
  const url = `${baseUrl}${path}`
  const method = opts.method ?? 'GET'

  const headers: Record<string, string> = {
    Authorization: authHeader,
    Accept: 'application/json'
  }
  let body: BodyInit | undefined
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(opts.body)
  }

  const started = Date.now()
  let response: Response
  try {
    response = await net.fetch(url, { method, headers, body })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error('network error', { url, method, error: msg, durationMs: Date.now() - started })
    throw new CinnaApiError('request_failed', msg)
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    logger.warn('request failed', { url, method, status: response.status })
    if (response.status === 401 || response.status === 403) {
      throw new CinnaApiError('reauth_required', `Cinna ${response.status}`)
    }
    throw new CinnaApiError(
      'request_failed',
      `Cinna API ${response.status}: ${text.slice(0, 200) || response.statusText}`
    )
  }
  try {
    return (await response.json()) as T
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error('invalid response', { url, method, error: msg })
    throw new CinnaApiError('invalid_response', msg)
  }
}

interface ServerCatalogEntry {
  bundle_id: string
  bundle_uuid: string
  display_name: string
  description: string | null
  publisher_handle: string | null
  publisher_name: string | null
  publisher_email: string | null
  visibility: string
  latest_version: string | null
  latest_revision_number: number | null
  latest_published_at: string | null
  install_count: number
  is_installed: boolean
  user_install_id: string | null
  required_credential_specs: Array<{
    name: string
    type: string
    description?: string | null
    provided_by?: string | null
  }>
}

interface ServerCatalogList {
  data: ServerCatalogEntry[]
  count: number
}

interface ServerSetupStatus {
  status: 'ready' | 'needs_setup' | 'publisher_broken'
  missing: Array<{
    spec_name: string
    spec_type: string
    reason: 'placeholder_empty' | 'publisher_credential_missing' | 'publisher_credential_unshared'
    is_ai?: boolean
  }>
  setup_url: string | null
}

interface ServerSetupCredentialSummary {
  id: string
  name: string
  type: string
  description: string | null
  template_private_fields?: string[]
}

function projectSpec(s: ServerCatalogEntry['required_credential_specs'][number]): CatalogCredentialSpec {
  const providedBy = s.provided_by === 'publisher' || s.provided_by === 'template'
    ? s.provided_by
    : 'user'
  return {
    name: s.name,
    type: s.type,
    description: s.description ?? null,
    providedBy
  }
}

function projectEntry(e: ServerCatalogEntry): CatalogEntryDto {
  return {
    bundleId: e.bundle_id,
    bundleUuid: e.bundle_uuid,
    displayName: e.display_name,
    description: e.description ?? null,
    publisherName: e.publisher_name ?? null,
    publisherEmail: e.publisher_email ?? null,
    publisherHandle: e.publisher_handle ?? null,
    visibility: e.visibility,
    latestVersion: e.latest_version ?? null,
    latestRevisionNumber: e.latest_revision_number ?? null,
    latestPublishedAt: e.latest_published_at ?? null,
    installCount: e.install_count,
    isInstalled: e.is_installed,
    userInstallId: e.user_install_id ?? null,
    requiredCredentialSpecs: (e.required_credential_specs ?? []).map(projectSpec)
  }
}

function projectMissing(m: ServerSetupStatus['missing'][number]): SetupMissingItemDto {
  return {
    specName: m.spec_name,
    specType: m.spec_type,
    reason: m.reason,
    isAi: Boolean(m.is_ai)
  }
}

export const catalogService = {
  async list(userId: string): Promise<CatalogEntryDto[]> {
    const body = await cinnaFetch<ServerCatalogList>(userId, '/api/v1/catalog/')
    return (body.data ?? []).map(projectEntry)
  },

  /**
   * Quick install — submits an empty payload. The server applies the same
   * defaults the install form would use unchanged (PBP → publisher_provides,
   * suggested credentials → use_existing, otherwise → skip; publisher AI
   * credentials accepted when offered).
   */
  async quickInstall(userId: string, bundleId: string): Promise<CatalogInstallResultDto> {
    const data = await cinnaFetch<Record<string, unknown>>(
      userId,
      `/api/v1/catalog/${encodeURIComponent(bundleId)}/install`,
      { method: 'POST', body: {} }
    )
    const installId = String(data.id ?? '')
    if (!installId) {
      throw new CinnaApiError('invalid_response', 'Install response missing id')
    }
    return {
      installId,
      bundleId,
      agentName: typeof data.name === 'string' ? data.name : 'Agent'
    }
  },

  async getSetupStatus(userId: string, installId: string): Promise<SetupStatusDto> {
    const body = await cinnaFetch<ServerSetupStatus>(
      userId,
      `/api/v1/agents/${encodeURIComponent(installId)}/setup-status`
    )
    return {
      status: body.status,
      missing: (body.missing ?? []).map(projectMissing),
      setupUrl: body.setup_url ?? null
    }
  },

  async getSetupCredentials(
    userId: string,
    installId: string
  ): Promise<SetupCredentialSummaryDto[]> {
    const body = await cinnaFetch<ServerSetupCredentialSummary[]>(
      userId,
      `/api/v1/agents/${encodeURIComponent(installId)}/setup-credentials`
    )
    return (body ?? []).map((c) => ({
      id: c.id,
      name: c.name,
      type: c.type,
      description: c.description ?? null,
      templatePrivateFields: c.template_private_fields ?? []
    }))
  },

  /**
   * Resolve the configured Cinna server URL so the renderer can build deep
   * links into the cinna-server frontend (e.g. /credential/{id},
   * /agent/{id}#credentials) without re-doing the user lookup.
   */
  getServerUrl(userId: string): string {
    return resolveBaseUrl(userId)
  }
}
