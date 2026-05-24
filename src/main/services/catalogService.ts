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
  InstallContextDto,
  InstallContextPublisherSummaryDto,
  InstallContextSpecDto,
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

/**
 * Best-effort extraction of a human-readable error message from a cinna-server
 * response body. FastAPI surfaces failures as `{ detail: "<message>" }`, our
 * own handlers sometimes use `{ message: "..." }`; everything else falls back
 * to the raw body slice so we never accidentally suppress server-supplied
 * context.
 */
function extractErrorDetail(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) return ''
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>
      const detail = parsed.detail
      if (typeof detail === 'string' && detail) return detail
      const message = parsed.message
      if (typeof message === 'string' && message) return message
    } catch {
      // JSON-shaped but not valid JSON; fall through to raw text.
    }
  }
  return trimmed.slice(0, 200)
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
    const detail = extractErrorDetail(text) || response.statusText
    throw new CinnaApiError('request_failed', `Cinna API ${response.status}: ${detail}`)
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

interface ServerInstallContextSpec {
  name: string
  type: string
  description?: string | null
  provided_by?: 'user' | 'publisher' | 'template'
  suggested_credential_id?: string | null
  suggested_credential_name?: string | null
  template_private_fields?: string[]
}

interface ServerInstallContextPublisherSummary {
  name: string
  type: string
}

interface ServerInstallContextAIPublisherSummaries {
  conversation?: ServerInstallContextPublisherSummary | null
  building?: ServerInstallContextPublisherSummary | null
}

interface ServerInstallContext {
  ai_provided_by_publisher: boolean
  ai_publisher_credential_summaries?: ServerInstallContextAIPublisherSummaries | null
  service_specs: ServerInstallContextSpec[]
}

function projectPublisherSummary(
  s: ServerInstallContextPublisherSummary | null | undefined
): InstallContextPublisherSummaryDto | null {
  if (!s || typeof s.name !== 'string' || typeof s.type !== 'string') return null
  return { name: s.name, type: s.type }
}

/**
 * Shared between `quickInstall` (consumes the raw shape to build the install
 * body) and `getInstallContext` (re-projects it into the public DTO). Kept
 * private so the renderer never sees `suggested_credential_id` UUIDs — only
 * the `hasSuggestedMatch` boolean reaches the IPC boundary.
 */
async function fetchServerInstallContext(
  userId: string,
  bundleId: string
): Promise<ServerInstallContext> {
  return cinnaFetch<ServerInstallContext>(
    userId,
    `/api/v1/catalog/${encodeURIComponent(bundleId)}/install-context`
  )
}

function projectInstallContextSpec(s: ServerInstallContextSpec): InstallContextSpecDto {
  const providedBy =
    s.provided_by === 'publisher' || s.provided_by === 'template' ? s.provided_by : 'user'
  return {
    name: s.name,
    type: s.type,
    providedBy,
    hasSuggestedMatch: Boolean(s.suggested_credential_id),
    templatePrivateFields: s.template_private_fields ?? []
  }
}

type CredentialSelection =
  | { mode: 'publisher_provides' }
  | { mode: 'use_existing'; credential_id: string }
  | { mode: 'skip' }

interface AICredentialSelections {
  conversation_credential_id: string | null
  building_credential_id: string | null
  use_publisher_ai: boolean
}

interface InstallRequestBody {
  credentials: Record<string, CredentialSelection> | null
  ai_credential_selections: AICredentialSelections | null
}

/**
 * Mirrors `frontend/src/components/Install/useQuickInstall.ts` in cinna-core:
 * for each spec in the install context, pick the default the install form
 * would submit unchanged — PBP → `publisher_provides`, PBU/PBT with a server
 * auto-prefill suggestion → `use_existing` (linking the user's existing
 * credential), otherwise → `skip`. Without this the server would skip
 * everything and materialise fresh placeholder/template rows even when the
 * installer already owns a matching credential.
 */
function buildDefaultCredentialsPayload(
  context: ServerInstallContext,
  bundleId: string
): Record<string, CredentialSelection> | null {
  const payload: Record<string, CredentialSelection> = {}
  for (const spec of context.service_specs) {
    // Bundle-author / cinna-core invariant: spec names are unique per
    // revision. Log a warning if the invariant breaks so we notice instead
    // of silently overwriting one selection with another.
    if (payload[spec.name]) {
      logger.warn('duplicate spec name in install-context', { bundleId, name: spec.name })
    }
    if (spec.provided_by === 'publisher') {
      payload[spec.name] = { mode: 'publisher_provides' }
    } else if (spec.suggested_credential_id) {
      payload[spec.name] = {
        mode: 'use_existing',
        credential_id: spec.suggested_credential_id
      }
    } else {
      payload[spec.name] = { mode: 'skip' }
    }
  }
  return Object.keys(payload).length > 0 ? payload : null
}

function buildDefaultAISelections(
  context: ServerInstallContext
): AICredentialSelections | null {
  if (!context.ai_provided_by_publisher) return null
  return {
    conversation_credential_id: null,
    building_credential_id: null,
    use_publisher_ai: true
  }
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
   * Quick install — two-step flow mirroring cinna-core's frontend
   * `useQuickInstall` hook:
   *   1. GET /catalog/{bundleId}/install-context — server runs the
   *      auto-prefill matcher and returns `suggested_credential_id` for
   *      every PBU/PBT spec that matches one of the installer's existing
   *      or shared credentials.
   *   2. POST /catalog/{bundleId}/install with a constructed body that
   *      links those suggestions as `use_existing` (instead of materialising
   *      duplicates), forwards `publisher_provides` for PBP specs, and
   *      forwards `use_publisher_ai` when the bundle offers it.
   * The empty-body shortcut we used before told the server "skip
   * everything", which created a fresh placeholder/template row even when
   * the installer already owned a matching credential.
   */
  async quickInstall(userId: string, bundleId: string): Promise<CatalogInstallResultDto> {
    try {
      const context = await fetchServerInstallContext(userId, bundleId)
      const credentials = buildDefaultCredentialsPayload(context, bundleId)
      const aiCredentialSelections = buildDefaultAISelections(context)
      // Count-only summary — no credential UUIDs / names cross the log
      // boundary. Lets us trace from a user report ("wrong credential got
      // linked") back to the exact payload shape the desktop submitted.
      const selections = Object.values(credentials ?? {})
      logger.info('quick install start', {
        bundleId,
        specCount: context.service_specs.length,
        useExistingCount: selections.filter((s) => s.mode === 'use_existing').length,
        publisherProvidesCount: selections.filter((s) => s.mode === 'publisher_provides').length,
        skipCount: selections.filter((s) => s.mode === 'skip').length,
        usePublisherAi: aiCredentialSelections?.use_publisher_ai ?? false
      })
      const body: InstallRequestBody = {
        credentials,
        ai_credential_selections: aiCredentialSelections
      }
      const data = await cinnaFetch<Record<string, unknown>>(
        userId,
        `/api/v1/catalog/${encodeURIComponent(bundleId)}/install`,
        { method: 'POST', body }
      )
      const installId = String(data.id ?? '')
      if (!installId) {
        throw new CinnaApiError('invalid_response', 'Install response missing id')
      }
      const agentName = typeof data.name === 'string' ? data.name : 'Agent'
      logger.info('quick install done', { bundleId, installId, agentName })
      return { installId, bundleId, agentName }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const code = err instanceof CinnaApiError ? err.code : undefined
      logger.error('quick install failed', { bundleId, code, error: message })
      throw err
    }
  },

  /**
   * Per-bundle install preview surfaced to the renderer's catalog card so
   * each required-credential row can render the right affordance: "already
   * covered" (publisher-shared, or your existing credential matches), "fill
   * template fields on next visit" (template spec with no matching
   * credential), or "you'll provide this" (user spec with no match). The
   * matcher itself runs on cinna-server; the desktop only forwards the
   * per-spec verdict — never the matched credential's UUID.
   */
  async getInstallContext(userId: string, bundleId: string): Promise<InstallContextDto> {
    const context = await fetchServerInstallContext(userId, bundleId)
    const aiSummaries = context.ai_publisher_credential_summaries ?? {}
    return {
      specs: (context.service_specs ?? []).map(projectInstallContextSpec),
      aiProvidedByPublisher: Boolean(context.ai_provided_by_publisher),
      aiPublisherSummaries: {
        conversation: projectPublisherSummary(aiSummaries.conversation),
        building: projectPublisherSummary(aiSummaries.building)
      }
    }
  },

  /**
   * Uninstall — POST /api/v1/agents/{install_id}/uninstall. Server contract
   * (see `workflow-runner-core/backend/app/api/routes/installs.py`):
   *   - Returns `{ status: 'uninstalled' }` on success
   *   - Stops the environment and removes the Agent row; per-user app-data
   *     volumes are preserved (re-attached automatically on reinstall)
   *   - Rejects publisher installs with HTTP 400 — surfaced to the renderer
   *     as `CinnaApiError('request_failed', ...)` with the server's message
   *
   * The mutation hook layers `useRefreshCatalogState()` on top so the
   * catalog card flips back to uninstalled and the remote-agent sync drops
   * the row without waiting for the periodic tick.
   */
  async uninstall(userId: string, installId: string): Promise<void> {
    logger.info('uninstall start', { installId })
    try {
      await cinnaFetch<Record<string, unknown>>(
        userId,
        `/api/v1/agents/${encodeURIComponent(installId)}/uninstall`,
        { method: 'POST', body: {} }
      )
      logger.info('uninstall done', { installId })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const code = err instanceof CinnaApiError ? err.code : undefined
      logger.error('uninstall failed', { installId, code, error: message })
      throw err
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
