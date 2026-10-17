/**
 * Artifacts — a file or folder an agent left, published to the active
 * profile's cinna-core as a frozen, versioned copy with its own page.
 *
 * The renderer names a path only as `{agentId, path}` (a reference the
 * transcript resolved); main finds the agent's folder itself, re-checks that
 * the realpath is inside it, re-inspects at publish, and talks to core. Every
 * answer is data — a thrown code does not survive IPC.
 *
 * Named `PublishedArtifact` here because "artifact" already means a task's
 * result link (`TaskArtifact`, `DelegationArtifact`).
 */

/** Core decides it at publish: a `site` has an HTML entry and runs sandboxed; `files` is browsed. */
export type ArtifactKind = 'site' | 'files'

/** Who can open it on core. Never "public" — that is a link. */
export type ArtifactVisibility = 'private' | 'instance'

/** The dialog's "Who can see it": the two visibilities, or a public link created after publish. */
export type PublishVisibility = ArtifactVisibility | 'link'

export interface ArtifactLimits {
  maxRevisionBytes: number
  maxRevisionFiles: number
  maxFileBytes: number
}

/** Used when core's `/capabilities` cannot be read. Core's own defaults (A11). */
export const FALLBACK_ARTIFACT_LIMITS: ArtifactLimits = {
  maxRevisionBytes: 50 * 1024 * 1024,
  maxRevisionFiles: 2000,
  maxFileBytes: 25 * 1024 * 1024
}

/**
 * Whether the active profile can publish: a signed-in Cinna account whose
 * instance advertises `artifacts >= 1`. When false, no artifact surface
 * renders anywhere (A14).
 */
export interface ArtifactsSupport {
  supported: boolean
  /** The instance's own name ("Everyone on <instanceName>"). */
  instanceName?: string
  limits: ArtifactLimits
  /**
   * The origins an `/artifact/<uuid>` link in agent text may have to render
   * as this profile's card: the server's, and every frontend origin core named
   * in an artifact URL. Any other host stays a plain link.
   */
  linkOrigins?: string[]
}

export interface ArtifactPathInput {
  agentId: string
  /** The absolute realpath the transcript resolved. Re-checked in main. */
  path: string
}

export interface InspectedFile {
  /** Relative to the published path, `/`-separated. */
  path: string
  size: number
}

/** Why a path is left out (A10), as the dialog says it. */
export type ExclusionReason =
  | 'git data'
  | 'secret file'
  | 'credentials'
  | 'app data'
  | 'agent settings'
  | 'dependencies'
  | 'system file'
  | 'hidden file'
  | 'symlink'
  | 'not a file'

export interface ExcludedEntry {
  /** Relative path; a folder ends in `/` and stands for everything under it. */
  path: string
  reason: ExclusionReason
}

export interface ArtifactOverLimits {
  /** More files than `maxRevisionFiles`; the walk stopped counting. */
  files: boolean
  /** More bytes than `maxRevisionBytes`; the walk stopped counting. */
  size: boolean
  /** Files over `maxFileBytes` (the first few). */
  perFile: string[]
}

/** What publishing this path would send, from a walk that never follows a symlink. */
export interface ArtifactInspection {
  /** The file or folder name. */
  name: string
  /** Relative to the agent folder, `/`-separated (`.` for the folder itself). */
  relativePath: string
  /** The realpath inspected — what *Update* is remembered by. */
  path: string
  isFolder: boolean
  /** As core will decide it, given {@link entry}. */
  kind: ArtifactKind
  /** The HTML entry for a site; null for files. */
  entry: string | null
  /** A folder with `.html` files but no root `index.html`: the start pages the user may pick. */
  entryCandidates: string[]
  files: InspectedFile[]
  excluded: ExcludedEntry[]
  /** Bytes of {@link files}. */
  size: number
  /** Null when everything fits. */
  overLimits: ArtifactOverLimits | null
  limits: ArtifactLimits
  instanceName?: string
  /** The artifact this path was published as before, for *Update*. */
  previous: KnownArtifact | null
}

/** The local memory of a published path (A12). */
export interface KnownArtifact {
  artifactId: string
  title: string
  revision: number
  visibility: ArtifactVisibility
}

export interface PublishedArtifact {
  id: string
  title: string
  kind: ArtifactKind
  revision: number
  visibility: ArtifactVisibility
  liveLinkCount: number
  /** Core's page for it (`<frontend>/artifact/<id>`). */
  url: string
}

/** A public link, shown once: its token is never stored. */
export interface CreatedArtifactLink {
  url: string
  code?: string
}

export interface PublishArtifactInput extends ArtifactPathInput {
  title: string
  description?: string
  /** The chosen start page when the folder has no `index.html`. */
  entry?: string | null
  /** Update this artifact (a new revision) instead of publishing a new one. */
  artifactId?: string | null
  /** `keep` leaves who can see it as it is (an agent's republish; main only). */
  visibility: PublishVisibility | 'keep'
  /** Echoed on `artifacts:progress`. */
  operationId?: string
  /** Where the chat card goes: after this message of this chat, else after its newest. */
  anchor?: { chatId: string; messageId?: string | null } | null
}

export type ArtifactErrorCode =
  | 'not_supported'
  | 'invalid_input'
  | 'path_refused'
  | 'not_found'
  | 'empty'
  | 'over_limits'
  | 'read_failed'
  | 'too_large'
  | 'rejected'
  /** The artifact to update is gone on core: publish it as new. */
  | 'gone'
  | 'forbidden'
  | 'reauth_required'
  | 'request_failed'

export interface ArtifactFailure {
  ok: false
  code: ArtifactErrorCode
  message: string
}

export type ArtifactsInspectOutcome = { ok: true; inspection: ArtifactInspection } | ArtifactFailure

export type ArtifactsPublishOutcome =
  | {
      ok: true
      artifact: PublishedArtifact
      /** What core dropped (A10), beside what the desktop never sent. */
      excluded: string[]
      /** Created after publish for "Anyone with a link"; shown once, not stored. */
      link?: CreatedArtifactLink
      /** Published, but the follow-up (visibility, link) failed: said once, not an error. */
      warning?: string
      /** What this desktop sent: the files and bytes zipped, and what it left out. */
      sent?: { fileCount: number; sizeBytes: number; excluded: string[] }
      /** The realpath published (main-side callers record approvals against it). */
      sourcePath?: string
    }
  | ArtifactFailure

export interface ArtifactLinkInfo {
  id: string
  tokenPrefix: string
  label: string | null
  createdAt: string
  expiresAt: string | null
  /** Live: not revoked, not expired, not blocked. */
  live: boolean
  needsCode: boolean
}

export interface ArtifactDetail extends PublishedArtifact {
  isOwner: boolean
  ownerName: string | null
  /** Named people it is shared with (core's web page); 0 for a viewer who is not the owner. */
  grantCount: number
  /** Owner only; live ones first. */
  links: ArtifactLinkInfo[]
}

export type ArtifactsDetailOutcome = { ok: true; detail: ArtifactDetail } | ArtifactFailure
export type ArtifactsLinkOutcome = { ok: true; link: CreatedArtifactLink; detail: ArtifactDetail | null } | ArtifactFailure

/** An artifact card in a chat, anchored after a message. */
export interface ArtifactCardDto {
  id: string
  chatId: string
  messageId: string
  artifact: PublishedArtifact
}

export const ARTIFACTS_PROGRESS_CHANNEL = 'artifacts:progress'
export const ARTIFACTS_CHANGED_CHANNEL = 'artifacts:changed'
/**
 * Main's answer to "can this profile publish?" changed (supported, instance
 * name, limits or link origins) — pushed so a surface opened afterwards needs
 * no reload or window focus to see it.
 */
export const ARTIFACTS_SUPPORT_CHANGED_CHANNEL = 'artifacts:support-changed'

export interface ArtifactsSupportChangedPayload {
  profileId: string
  support: ArtifactsSupport
}

export type ArtifactsProgressPhase = 'packing' | 'uploading' | 'sharing'

export interface ArtifactsProgressPayload {
  operationId: string
  phase: ArtifactsProgressPhase
}

export interface ArtifactsChangedPayload {
  artifactId: string
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const ARTIFACT_PATH = new RegExp(`^/artifact/(${UUID})/?$`, 'i')

/**
 * The artifact id an `http(s)` URL names when its path is exactly
 * `/artifact/<uuid>` (one optional trailing slash), else null. With `origins`,
 * only a URL on one of them counts (the profile's server, or a frontend core
 * named — {@link ArtifactsSupport.linkOrigins}); without, the host is not checked.
 */
export function artifactIdFromUrl(href: string | null | undefined, origins?: readonly string[]): string | null {
  if (!href || !/^https?:\/\//i.test(href)) return null
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return null
  }
  if (origins && !origins.includes(url.origin)) return null
  const match = ARTIFACT_PATH.exec(url.pathname)
  return match ? match[1].toLowerCase() : null
}

const KIND_NAMES: Record<string, string> = {
  md: 'Markdown document',
  markdown: 'Markdown document',
  csv: 'CSV table',
  tsv: 'TSV table',
  json: 'JSON file',
  txt: 'Text file',
  log: 'Log file',
  pdf: 'PDF document',
  html: 'Web page',
  htm: 'Web page',
  svg: 'SVG image',
  png: 'Image',
  jpg: 'Image',
  jpeg: 'Image',
  gif: 'Image',
  webp: 'Image',
  sqlite: 'SQLite database',
  db: 'SQLite database',
  py: 'Python file',
  js: 'JavaScript file',
  ts: 'TypeScript file',
  yaml: 'YAML file',
  yml: 'YAML file',
  xml: 'XML file'
}

/** "Markdown document" for `report.md`; "File" when the type has no name here. */
export function fileTypeName(name: string): string {
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
  return KIND_NAMES[ext] ?? (ext ? `${ext.toUpperCase()} file` : 'File')
}

/**
 * The dialog's kind line: "Mini-site · opens index.html", "3 files",
 * "Markdown document".
 */
export function artifactKindLine(input: { isFolder: boolean; kind: ArtifactKind; entry: string | null; fileCount: number; name: string }): string {
  if (input.kind === 'site' && input.entry) {
    return input.isFolder ? `Mini-site · opens ${input.entry}` : 'Web page'
  }
  if (!input.isFolder) return fileTypeName(input.name)
  return input.fileCount === 1 ? '1 file' : `${input.fileCount.toLocaleString('en-US')} files`
}

/** Who can see it, as the card and the Share popover say it: "only you", "everyone on Acme". */
export function artifactVisibilityWords(visibility: ArtifactVisibility, instanceName?: string): string {
  return visibility === 'instance' ? `everyone on ${instanceName || 'the instance'}` : 'only you'
}

/** "1 public link", "3 public links"; empty when there are none. */
export function artifactLinkWords(liveLinkCount: number): string {
  if (liveLinkCount <= 0) return ''
  return liveLinkCount === 1 ? '1 public link' : `${liveLinkCount} public links`
}

/**
 * The card's audience: two independent facts, who can see it and how many
 * public links are live — "only you", "everyone on Acme · 2 public links".
 */
export function artifactAudience(
  artifact: Pick<PublishedArtifact, 'visibility' | 'liveLinkCount'> & { grantCount?: number },
  instanceName?: string
): string {
  const links = artifactLinkWords(artifact.liveLinkCount)
  // Grants are made on core's page; the desktop shows them, it does not edit them.
  const grants = artifact.grantCount && artifact.grantCount > 0
    ? (artifact.grantCount === 1 ? 'shared with 1 person' : `shared with ${artifact.grantCount} people`)
    : ''
  return [artifactVisibilityWords(artifact.visibility, instanceName), grants, links].filter(Boolean).join(' · ')
}

/** `12.4 MB`, `830 KB`, `120 B`. */
export function formatArtifactBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  const mb = bytes / (1024 * 1024)
  return `${mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10} MB`
}

/* ------------------------------------------------- an agent's publish (D2) */

/** The `cinna` tool an agent publishes with (`artifacts.schema.json`). */
export const ARTIFACTS_PUBLISH_TOOL = 'artifacts_publish'

/** The provider name its transcript row carries (`tool_call.toolProvider`). */
export const ARTIFACTS_PROVIDER_NAME = 'Cinna artifacts'

/** An approval's address: `art_<toolCallId>`. */
export const ARTIFACT_APPROVAL_PREFIX = 'art_'

export const ARTIFACTS_APPROVALS_CHANNEL = 'artifacts:approvals-changed'

/** What an agent asks to publish, as the approval card shows it — the same summary as the dialog. */
export interface ArtifactApprovalSummary {
  requestId: string
  chatId: string
  toolCallId: string
  agentId: string
  agentName: string
  /** The realpath, for the Edit… dialog (re-checked by main like any reference). */
  path: string
  /** Relative to the agent folder. */
  relativePath: string
  title: string
  description: string | null
  entry: string | null
  isFolder: boolean
  kind: ArtifactKind
  kindLine: string
  files: InspectedFile[]
  excluded: ExcludedEntry[]
  size: number
  limits: ArtifactLimits
  instanceName?: string
  /** "only you", or who else would see new content of an artifact already shared. */
  audience: string
  /** The artifact this would add a revision to. */
  update: KnownArtifact | null
}

/** What the user changed in Edit… before publishing an agent's request. */
export interface ArtifactApprovalEdits {
  title: string
  description?: string
  entry?: string | null
  /** Null publishes as a new artifact. */
  artifactId: string | null
  visibility: PublishVisibility
}

export interface ArtifactApprovalAnswerInput {
  requestId: string
  decision: 'publish' | 'deny'
  edits?: ArtifactApprovalEdits
}

export type ArtifactApprovalAnswer =
  | { ok: true; artifact?: PublishedArtifact; link?: CreatedArtifactLink; warning?: string }
  | ArtifactFailure

/** The result object `artifacts_publish` returns (the schema's `result`), as persisted on the tool row. */
export interface ArtifactPublishToolResult {
  artifact_id: string
  revision: number
  url: string
  kind: ArtifactKind
  file_count: number
  size_bytes: number
  excluded: string[]
}

/** The transcript's note on a republish that needed no card ("Updated rev 4"). */
export const ARTIFACT_SKIPPED_NOTE_PREFIX = 'Updated rev '

/**
 * Why an agent's publish did not happen, for the person: the agent reads its
 * own sentence in the tool result; the row also carries this note
 * (`artifact-refusal:<code>[:<reason>]`) so the transcript can say it in the
 * user's words.
 */
export type ArtifactRefusalCode = 'declined' | 'timeout' | 'cancelled' | 'refused'

export const ARTIFACT_REFUSAL_NOTE_PREFIX = 'artifact-refusal:'

export function artifactRefusalNote(code: ArtifactRefusalCode, reason?: string): string {
  return `${ARTIFACT_REFUSAL_NOTE_PREFIX}${code}${reason ? `:${reason}` : ''}`
}

/** The agent-facing sentences the provider starts each refusal with (the live transcript has no note yet). */
export const ARTIFACT_AGENT_SENTENCE = {
  declined: 'The user declined to publish ',
  timeout: 'Nobody answered the request to publish ',
  cancelled: 'The request to publish ',
  failed: 'Not published: '
} as const

/** A sentence as a clause after a dash: lower-case start, no closing full stop. */
export function asArtifactClause(text: string): string {
  const trimmed = text.trim().replace(/[.。]+$/, '')
  return /^[A-Z][a-z]/.test(trimmed) ? trimmed[0].toLowerCase() + trimmed.slice(1) : trimmed
}

/**
 * The transcript line for an agent's publish that did not happen:
 * "Not published — you declined", "… — no answer within an hour",
 * "… — <reason>". From the row's note; without one (a live row), from the
 * agent's sentence where it is one of the provider's own.
 */
export function artifactRefusalLine(note: string | null | undefined, agentText: string): string {
  if (note && note.startsWith(ARTIFACT_REFUSAL_NOTE_PREFIX)) {
    const rest = note.slice(ARTIFACT_REFUSAL_NOTE_PREFIX.length)
    const at = rest.indexOf(':')
    const code = at < 0 ? rest : rest.slice(0, at)
    const reason = at < 0 ? '' : rest.slice(at + 1)
    if (code === 'declined') return 'Not published — you declined'
    if (code === 'timeout') return 'Not published — no answer within an hour'
    if (code === 'cancelled') return 'Not published — the chat stopped before you answered'
    if (reason) return `Not published — ${reason}`
  }
  if (agentText.startsWith(ARTIFACT_AGENT_SENTENCE.declined)) return 'Not published — you declined'
  if (agentText.startsWith(ARTIFACT_AGENT_SENTENCE.timeout)) return 'Not published — no answer within an hour'
  if (agentText.startsWith(ARTIFACT_AGENT_SENTENCE.cancelled)) return 'Not published — the chat stopped before you answered'
  if (agentText.startsWith(ARTIFACT_AGENT_SENTENCE.failed)) return `Not published — ${asArtifactClause(agentText.slice(ARTIFACT_AGENT_SENTENCE.failed.length))}`
  return 'Not published — the agent’s request could not be carried out'
}

/** One file of a published revision, as core's view lists it. */
export interface ArtifactViewFile {
  path: string
  size: number
  mime: string
}

/**
 * A view capability for an artifact's current revision (core's
 * `POST /artifacts/{id}/view`). Main-side only: `contentBase` holds the
 * capability, so it never crosses IPC — the renderer gets a
 * `cinna-preview:` token instead ({@link ArtifactPreviewOpenResult}).
 */
export interface ArtifactView {
  /** `<content origin>/a/v/<cap>/`; every file is this plus its path. */
  contentBase: string
  /** The start page of a site; null for files. */
  entry: string | null
  files: ArtifactViewFile[]
  revision: number
  /** ISO time the capability stops working. */
  expiresAt: string
}

export type ArtifactsViewOutcome = { ok: true; view: ArtifactView } | ArtifactFailure

/** The in-app preview of a published artifact, served under `cinna-preview://<token>/`. */
export type ArtifactPreviewOpenResult =
  | {
      ok: true
      token: string
      /** `cinna-preview://<token>/`; a file's URL is this plus its encoded path. */
      baseUrl: string
      entry: string | null
      files: ArtifactViewFile[]
      revision: number
    }
  | ArtifactFailure

/**
 * `html-preview:read-artifact-text`: one file of an open artifact preview, read
 * by main through the token's capability, cut at `MAX_PREVIEW_BYTES`.
 */
export type ArtifactPreviewTextResult = { ok: true; text: string; truncated: boolean } | ArtifactFailure
