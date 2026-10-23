/**
 * A provider's error, read out of the text an agent turn failed with.
 *
 * An engine that calls a model provider itself (Antigravity, OpenCode, …)
 * reports the provider's refusal as a single string: a prefix of its own and
 * then the provider's JSON body, pasted in verbatim —
 * `Internal error: Provider request failed with HTTP 429: [{ "error": { … } }]`.
 * Shown as is, that blob was the whole one-line headline of the error bubble.
 *
 * This finds the JSON, recognises the three shapes the providers answer in
 * (Google RPC, OpenAI, Anthropic) and returns what a person should read: a short
 * title from the status, and the provider's own message in full. Anything it
 * does not recognise is `null`, and the caller keeps the text as it was.
 *
 * Pure and shared: main uses it when it saves the error row, and the renderer
 * uses it on rows saved before main did.
 */

export interface ProviderErrorLink {
  url: string
  description?: string
}

export interface ProviderErrorView {
  /** Short headline from the status, e.g. `Quota or rate limit exceeded (429)`. */
  title: string
  /** The provider's message, verbatim and in full. */
  message: string
  /** HTTP status, from the body's numeric `code` or the prefix's `HTTP NNN`. */
  status?: number
  /** Whole seconds, rounded up, from a Google `RetryInfo.retryDelay`. */
  retryAfterSec?: number
  /** From a Google `Help` detail; http(s) only. */
  links?: ProviderErrorLink[]
}

interface EmbeddedJson {
  prefix: string
  value: unknown
  suffix: string
}

const CLOSER: Record<string, string> = { '{': '}', '[': ']' }

/** The first JSON object or array in `text`, with what surrounds it. */
function findEmbeddedJson(text: string): EmbeddedJson | null {
  const start = text.search(/[{[]/)
  if (start < 0) return null
  const prefix = text.slice(0, start)
  const rest = text.slice(start)
  try {
    return { prefix, value: JSON.parse(rest), suffix: '' }
  } catch {
    // Trailing text after the body: try up to the last matching closer.
  }
  const end = rest.lastIndexOf(CLOSER[rest[0]])
  if (end <= 0) return null
  try {
    return { prefix, value: JSON.parse(rest.slice(0, end + 1)), suffix: rest.slice(end + 1) }
  } catch {
    return null
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function unwrap(value: unknown): unknown {
  return Array.isArray(value) && value.length === 1 ? value[0] : value
}

type Category = 'rate' | 'auth' | 'denied' | 'not_found' | 'bad_request' | 'overloaded' | 'server'

/** Provider status strings and error types, by what they mean to the user. */
const CATEGORY_OF_NAME: Record<string, Category> = {
  resource_exhausted: 'rate',
  rate_limit_error: 'rate',
  rate_limit_exceeded: 'rate',
  insufficient_quota: 'rate',
  unauthenticated: 'auth',
  authentication_error: 'auth',
  invalid_api_key: 'auth',
  permission_denied: 'denied',
  permission_error: 'denied',
  not_found: 'not_found',
  not_found_error: 'not_found',
  model_not_found: 'not_found',
  invalid_argument: 'bad_request',
  invalid_request_error: 'bad_request',
  failed_precondition: 'bad_request',
  unavailable: 'overloaded',
  overloaded_error: 'overloaded',
  internal: 'server',
  api_error: 'server',
  server_error: 'server'
}

function categoryOfStatus(status: number): Category | null {
  if (status === 429) return 'rate'
  if (status === 401) return 'auth'
  if (status === 403) return 'denied'
  if (status === 404) return 'not_found'
  if (status === 400 || status === 422) return 'bad_request'
  if (status === 503 || status === 529) return 'overloaded'
  if (status >= 500 && status <= 599) return 'server'
  return null
}

const TITLE_OF: Record<Category, string> = {
  rate: 'Quota or rate limit exceeded',
  auth: 'Provider rejected the credentials',
  denied: 'Provider denied access',
  not_found: 'Model or endpoint not found',
  bad_request: 'Provider rejected the request',
  overloaded: 'Provider is unavailable or overloaded',
  server: 'Provider service error'
}

/** The category a status or one of the provider's status/type names gives, if any. */
function categoryOf(status: number | undefined, names: unknown[]): Category | null {
  const byStatus = status !== undefined ? categoryOfStatus(status) : null
  if (byStatus) return byStatus
  for (const name of names) {
    if (typeof name !== 'string') continue
    const found = CATEGORY_OF_NAME[name.toLowerCase()]
    if (found) return found
  }
  return null
}

function titleOf(status: number | undefined, category: Category | null): string {
  const base = category ? TITLE_OF[category] : 'Provider error'
  return status !== undefined ? `${base} (${status})` : base
}

function isHttpStatus(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 100 && n <= 599
}

/** `"33s"` / `"33.5s"` → whole seconds, rounded up. */
function secondsOf(delay: unknown): number | undefined {
  if (typeof delay !== 'string') return undefined
  const m = /^\s*(\d+(?:\.\d+)?)s\s*$/.exec(delay)
  if (!m) return undefined
  const sec = Math.ceil(Number(m[1]))
  return Number.isFinite(sec) && sec > 0 ? sec : undefined
}

function isWebUrl(url: unknown): url is string {
  if (typeof url !== 'string') return false
  try {
    const p = new URL(url).protocol
    return p === 'http:' || p === 'https:'
  } catch {
    return false
  }
}

/** Google RPC `details`: the retry delay and the help links. */
function readDetails(details: unknown): Pick<ProviderErrorView, 'retryAfterSec' | 'links'> {
  const out: Pick<ProviderErrorView, 'retryAfterSec' | 'links'> = {}
  if (!Array.isArray(details)) return out
  const links: ProviderErrorLink[] = []
  for (const d of details) {
    if (!isRecord(d) || typeof d['@type'] !== 'string') continue
    const type = d['@type']
    if (type.endsWith('google.rpc.RetryInfo') && out.retryAfterSec === undefined) {
      out.retryAfterSec = secondsOf(d.retryDelay)
    } else if (type.endsWith('google.rpc.Help') && Array.isArray(d.links)) {
      for (const l of d.links) {
        if (!isRecord(l) || !isWebUrl(l.url)) continue
        links.push(typeof l.description === 'string' && l.description
          ? { url: l.url, description: l.description }
          : { url: l.url })
      }
    }
  }
  if (out.retryAfterSec === undefined) delete out.retryAfterSec
  if (links.length > 0) out.links = links
  return out
}

/**
 * What a provider said, if `text` carries a provider's error body; `null` when
 * it does not, and the caller shows `text` as it is.
 */
export function describeProviderError(text: string): ProviderErrorView | null {
  if (typeof text !== 'string' || !text) return null
  const found = findEmbeddedJson(text)
  if (!found) return null
  const body = unwrap(found.value)
  if (!isRecord(body) || !isRecord(body.error)) return null
  const error = body.error
  if (typeof error.message !== 'string' || !error.message.trim()) return null

  const prefixStatus = /HTTP (\d{3})\b/.exec(found.prefix)
  const status = isHttpStatus(error.code)
    ? error.code
    : prefixStatus ? Number(prefixStatus[1]) : undefined

  // Google: `status` (RESOURCE_EXHAUSTED). OpenAI: `code` / `type`.
  // Anthropic: `error.type` (rate_limit_error).
  const category = categoryOf(status, [error.status, error.code, error.type])
  // `{"error":{"message":…}}` is also what a JSON-RPC peer (an MCP server's
  // -32601) or a tool's own failure looks like. Without an HTTP status or a
  // provider's status/type name, it is not a provider's answer.
  if (status === undefined && !category) return null
  return {
    title: titleOf(status, category),
    message: error.message.trim(),
    ...(status !== undefined ? { status } : {}),
    ...readDetails(error.details)
  }
}

/**
 * The same text for a Details panel: the prefix on its own line, then the body
 * indented. `null` when `text` carries no JSON, or the body cannot be
 * re-printed (nesting deep enough to overflow the stack) — the caller then
 * keeps the text as it was.
 */
export function formatProviderErrorDetail(text: string): string | null {
  if (typeof text !== 'string' || !text) return null
  try {
    const found = findEmbeddedJson(text)
    if (!found) return null
    return [found.prefix.trim(), JSON.stringify(found.value, null, 2), found.suffix.trim()]
      .filter((s) => s.length > 0)
      .join('\n')
  } catch {
    return null
  }
}
