/**
 * `artifacts_publish` on the `cinna` MCP server (artifacts D2): a folder agent
 * publishes a file or folder from its own folder, held on a desktop approval.
 *
 * * **Offered** only to a folder agent's own session, and only while the
 *   active profile's instance keeps artifacts (the support main last read).
 * * **The session** is checked like the task tools' (`validateSession`): an
 *   activated app, the profile it was opened under, a chat that answers to
 *   this agent, an enabled agent. The agent's folder comes from that check,
 *   never from the call.
 * * **No card for its own artifacts.** `cinna` tools are allowed silently by
 *   every engine, so the provider decides; {@link agentArtifactPolicy} is the
 *   one place that does (A8). A new artifact is published private, reaching
 *   only its owner; republishing an artifact this agent published updates it
 *   for whoever the owner already shared it with — the user chose that over a
 *   card on every update. Anything the call cannot be sure of asks, on the
 *   approval card.
 * * **Never shares.** The tool takes no visibility and no links; a new
 *   artifact is private, and a republish leaves who can see it as the user
 *   left it. Sharing stays the person's.
 * * **The result** is exactly the schema's object; a refusal is a sentence
 *   the agent can act on, and the row also carries a note in the user's
 *   words (`artifactRefusalNote`) for the transcript.
 *
 * Core: no Electron.
 */

import type { ToolDefinition } from '../../llm/types'
import type { ToolCallOptions, ToolExecutionResult, ToolProvider } from '../../llm/toolProvider'
import type { RunEvent } from '../../../shared/runEvents'
import type { MessagePart } from '../../../shared/messageParts'
import type { RunScope } from '../runExecutionService'
import type { PublishedArtifactRow } from '../../db/publishedArtifacts'
import type { ArtifactService } from './publishService'
import { overLimitsMessage, PATH_OUTSIDE_MESSAGE } from './publishService'
import type { ArtifactApprovals } from './artifactApprovals'
import {
  ARTIFACT_AGENT_SENTENCE,
  ARTIFACT_APPROVAL_PREFIX,
  ARTIFACT_SKIPPED_NOTE_PREFIX,
  artifactRefusalNote,
  asArtifactClause,
  ARTIFACTS_PROVIDER_NAME,
  ARTIFACTS_PUBLISH_TOOL,
  artifactAudience,
  artifactKindLine,
  formatArtifactBytes,
  type ArtifactApprovalEdits,
  type ArtifactApprovalSummary,
  type ArtifactDetail,
  type ArtifactInspection,
  type ArtifactRefusalCode,
  type ArtifactPublishToolResult,
  type ArtifactsPublishOutcome
} from '../../../shared/artifacts'

/** The tool exactly as `artifacts.schema.json` states it (`artifactsProtocolParity.test.ts`). */
export const ARTIFACTS_TOOL_SCHEMAS = {
  [ARTIFACTS_PUBLISH_TOOL]: {
    description:
      'Publish a file or folder from your workspace as an artifact: a page your owner opens in Cinna to read a report, browse files or run a small self-contained dashboard. A folder with `index.html` at its root (or the `entry` you name) becomes a site; a single `.md`, `.csv`, `.pdf`, image or `.html` is fine on its own. Publishing the same `path` again adds a revision to the same artifact instead of creating a new one; pass `artifact_id` to update a specific artifact you published before. The result is private to your owner. Sites run sandboxed: relative paths only, every library bundled into the folder (no CDN), no localStorage/sessionStorage/IndexedDB/cookies, no `new Worker(url)`. Paths the platform never publishes (`.env`, keys, `credentials/`, `.git/`, `node_modules/`) are dropped and listed in `excluded`.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['path', 'title'],
      properties: {
        path: {
          type: 'string',
          minLength: 1,
          maxLength: 1024,
          description: 'A file or folder, relative to the workspace root. Build what you publish under `artifacts/<name>/` (`artifacts/q3-dashboard`, `artifacts/summary.md`).'
        },
        title: { type: 'string', minLength: 1, maxLength: 200, description: 'What a person sees in their artifact list.' },
        description: { type: 'string', maxLength: 2000, description: 'One or two sentences on what this shows and where the data came from.' },
        entry: {
          type: 'string',
          maxLength: 1024,
          description: "The HTML page to open first, relative to the folder. Defaults to the folder's root `index.html`."
        },
        artifact_id: {
          type: 'string',
          minLength: 1,
          maxLength: 64,
          description: 'Republish into this artifact (an id from an earlier result). Omit to create, or to update the artifact this same `path` was published to.'
        }
      }
    }
  }
} as const

/** Whose session this is. The same shape as the task tools' `DelegationSession`. */
export interface ArtifactToolSession {
  scope: RunScope
  chatId: string
  agentId: string
}

/** Core's current sharing of an artifact, as the policy and the card need it. */
export type ArtifactSharingNow = Pick<ArtifactDetail, 'isOwner' | 'visibility' | 'liveLinkCount' | 'grantCount'>

/**
 * A8, in one place: may this call publish without asking the user?
 *
 * * No local row: a new artifact, published private — it reaches nobody but
 *   its owner.
 * * A row this agent published (by its own call, or by the person's Publish…
 *   from this agent's chat — `row.agentId` is the folder it came from): core
 *   is read fresh (`readNow`). Still the user's own → publish, keeping who
 *   can see it, whatever that is: the user chose that a republish updates the
 *   artifact for whoever they already shared it with. Deleted on core
 *   (`'gone'`) → publish as a new private artifact. A failed read, nothing,
 *   or not the owner → ask.
 * * Another agent's row (reachable only by `artifact_id`) → ask.
 *
 * Sharing itself stays the person's: the tool cannot set visibility or links.
 */
export async function agentArtifactPolicy(input: {
  row: Pick<PublishedArtifactRow, 'agentId'> | null
  agentId: string
  readNow: () => Promise<ArtifactSharingNow | 'gone' | null>
}): Promise<'publish' | 'ask'> {
  const { row } = input
  if (!row) return 'publish'
  if (row.agentId !== input.agentId) return 'ask'
  let now: ArtifactSharingNow | 'gone' | null
  try {
    now = await input.readNow()
  } catch {
    return 'ask'
  }
  if (now === 'gone') return 'publish'
  return now?.isOwner === true ? 'publish' : 'ask'
}

export interface ArtifactToolDeps {
  /** `validateSession`: throws a sentence when this session may not act. */
  validate(session: ArtifactToolSession): { agentName: string; agentDir: string }
  service: Pick<ArtifactService, 'supportedNow' | 'serverOf' | 'inspect' | 'publish' | 'detail'>
  repo: {
    get(profileUserId: string, serverUrl: string, artifactId: string): PublishedArtifactRow | null
    findBySource(profileUserId: string, serverUrl: string, sourcePath: string): PublishedArtifactRow | null
  }
  approvals: ArtifactApprovals
}

const FIELDS = Object.keys(ARTIFACTS_TOOL_SCHEMAS[ARTIFACTS_PUBLISH_TOOL].inputSchema.properties)

/**
 * Error results are thrown as the agent's sentence; `callTool` returns them
 * as `isError`, with a note saying the same in the user's words.
 */
class Refusal extends Error {
  constructor(
    agentText: string,
    readonly userReason: string = 'the agent’s request was not one it can make',
    readonly code: ArtifactRefusalCode = 'refused'
  ) {
    super(agentText)
  }
}

function stringField(input: Record<string, unknown>, key: string, min: number, max: number, optional: boolean): string | undefined {
  const value = input[key]
  if (value === undefined && optional) return undefined
  if (typeof value !== 'string' || value.length < min || value.length > max || (min > 0 && !value.trim())) {
    throw new Refusal(`\`${key}\` must be ${min > 0 ? 'nonempty ' : ''}text of at most ${max} characters.`, 'the agent’s request was malformed')
  }
  return value
}

export class ArtifactToolProvider implements ToolProvider {
  readonly providerType = 'mcp' as const
  readonly displayName = ARTIFACTS_PROVIDER_NAME

  constructor(private readonly session: ArtifactToolSession, private readonly deps: ArtifactToolDeps) {}

  /** The approval's `needs_input` belongs to the root turn, where the Inbox records it. */
  eventSink(_toolCallId: string, publish: (event: RunEvent) => void): (event: RunEvent) => void {
    return publish
  }

  getTools(): ToolDefinition[] {
    return Object.entries(ARTIFACTS_TOOL_SCHEMAS).map(([name, schema]) => ({
      name,
      description: schema.description,
      inputSchema: schema.inputSchema as unknown as Record<string, unknown>,
      mcpProviderId: 'cinna-artifacts',
      providerType: 'mcp'
    }))
  }

  async callTool(name: string, input: Record<string, unknown>, options: ToolCallOptions = {}): Promise<ToolExecutionResult> {
    try {
      return await this.publishCall(name, input, options)
    } catch (error) {
      if (error instanceof Refusal) {
        return { content: error.message, isError: true, parts: [{ kind: 'notice', text: artifactRefusalNote(error.code, error.userReason) }] }
      }
      throw error
    }
  }

  private async publishCall(name: string, input: Record<string, unknown>, options: ToolCallOptions): Promise<ToolExecutionResult> {
    const signal = options.signal
    signal?.throwIfAborted()
    if (name !== ARTIFACTS_PUBLISH_TOOL) throw new Refusal('This tool is not offered to this session.', 'this chat cannot publish')
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Refusal('The tool arguments must be an object.', 'the agent’s request was malformed')
    const unknown = Object.keys(input).filter((key) => !FIELDS.includes(key))
    if (unknown.length > 0) {
      throw new Refusal(
        `Unknown argument ${unknown.map((key) => `\`${key}\``).join(', ')}: artifacts_publish takes ${FIELDS.join(', ')}. An agent publishes privately; the user shares.`,
        'the agent asked for something only you can choose'
      )
    }
    const path = stringField(input, 'path', 1, 1024, false)!
    const title = stringField(input, 'title', 1, 200, false)!.trim()
    const description = stringField(input, 'description', 0, 2000, true)?.trim() || undefined
    const entry = stringField(input, 'entry', 0, 1024, true) || undefined
    const artifactId = stringField(input, 'artifact_id', 1, 64, true)

    let checked: { agentName: string; agentDir: string }
    try {
      checked = this.deps.validate(this.session)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'This session cannot publish.'
      throw new Refusal(message, asArtifactClause(message))
    }
    const profile = this.session.scope.profileUserId
    const { agentId } = this.session
    const support = this.deps.service.supportedNow(profile)
    const server = this.deps.service.serverOf(profile)
    if (!support.supported || !server) {
      throw new Refusal('Publishing artifacts is not available: the user’s Cinna account does not keep artifacts.', 'your Cinna account does not keep artifacts')
    }
    // The session's profile, not whichever is active now: what is read, sent and remembered is that account's.
    const call = { agentDir: checked.agentDir, profileUserId: profile }

    const inspected = await this.deps.service.inspect({ agentId, path, ...(entry ? { entry } : {}) }, call)
    signal?.throwIfAborted()
    if (!inspected.ok) {
      if (inspected.code === 'path_refused') {
        if (inspected.message !== PATH_OUTSIDE_MESSAGE) throw new Refusal(`\`${path}\`: ${inspected.message} Publish a file or folder outside it.`, asArtifactClause(inspected.message))
        throw new Refusal(
          `\`${path}\` is outside your workspace folder. Only files and folders inside it can be published; give a path relative to the workspace root.`,
          `${path} is outside the agent’s folder`
        )
      }
      if (inspected.code === 'not_found') throw new Refusal(`\`${path}\` does not exist in your workspace folder.`, `${path} is not in the agent’s folder`)
      throw new Refusal(inspected.message, asArtifactClause(inspected.message))
    }
    const inspection = inspected.inspection
    if (entry && inspection.entry !== entry) {
      const offered = inspection.entryCandidates.length ? ` Pages there: ${inspection.entryCandidates.join(', ')}.` : ''
      throw new Refusal(`\`entry\` \`${entry}\` is not an .html file in \`${path}\`.${offered}`, `${entry} is not a page in ${path}`)
    }
    if (inspection.files.length === 0) {
      const dropped = inspection.excluded.map((item) => `${item.path} (${item.reason})`).join(', ')
      throw new Refusal(
        `Nothing to publish in \`${path}\`: every file is one the platform never publishes${dropped ? ` — ${dropped}` : ''}.`,
        `every file in ${path} is one that is never published`
      )
    }
    if (inspection.overLimits) {
      const over = overLimitsMessage(inspection.overLimits, inspection.limits)
      throw new Refusal(`${over} Nothing was published; publish a smaller folder.`, asArtifactClause(over))
    }

    let target: PublishedArtifactRow | null
    if (artifactId !== undefined) {
      target = this.deps.repo.get(profile, server, artifactId.toLowerCase())
      if (!target) {
        throw new Refusal(
          `\`artifact_id\` ${artifactId} is not an artifact published from this computer for this account. Omit it to publish \`${path}\` as a new artifact or update the one it was published to.`,
          'the artifact the agent named was not published from this computer'
        )
      }
    } else {
      target = this.deps.repo.findBySource(profile, server, inspection.path)
    }

    // Private for a new artifact; a republish leaves who can see it as the user left it.
    const publish = (edits?: ArtifactApprovalEdits): Promise<ArtifactsPublishOutcome> =>
      this.deps.service.publish(
        edits
          ? { agentId, path: inspection.path, title: edits.title, description: edits.description, entry: edits.entry ?? null, artifactId: edits.artifactId, visibility: edits.visibility }
          : { agentId, path: inspection.path, title, description, entry: entry ?? null, artifactId: target?.artifactId ?? null, visibility: target ? 'keep' : 'private' },
        call
      )

    const known = target
    // What core said just now: the card describes it, not the local row, which
    // misses sharing done on core's page. A 404 means the artifact was deleted
    // there; the request then becomes a new private artifact, not an update.
    let fresh: ArtifactDetail | null = null
    let gone = false
    const decision = await agentArtifactPolicy({
      row: known,
      agentId,
      readNow: async () => {
        if (!known) return null
        const read = await this.deps.service.detail(known.artifactId, call)
        if (read.ok) fresh = read.detail
        else if (read.code === 'gone') gone = true
        return read.ok ? read.detail : gone ? 'gone' : null
      }
    })
    signal?.throwIfAborted()
    if (gone) target = null
    if (decision === 'publish') {
      // `target` is read inside `publish`: a gone artifact goes out as a new private one.
      const result = await publish()
      if (!result.ok) throw new Refusal(`${ARTIFACT_AGENT_SENTENCE.failed}${result.message}`, asArtifactClause(result.message))
      // A republish says so in the transcript; a new artifact's card speaks for itself.
      if (!target) return { content: toolResult(result) }
      const note: MessagePart = { kind: 'notice', text: `${ARTIFACT_SKIPPED_NOTE_PREFIX}${result.artifact.revision}` }
      return { content: toolResult(result), parts: [note] }
    }

    const requestId = `${ARTIFACT_APPROVAL_PREFIX}${options.toolCallId ?? ''}`
    if (!options.toolCallId) throw new Refusal('This call has no identity to wait on; try again.', 'the request could not wait for your answer')
    const summary = summaryOf({ requestId, session: this.session, toolCallId: options.toolCallId, agentName: checked.agentName, title, description, inspection, target, fresh, instanceName: support.instanceName })
    const publishLine = `${checked.agentName} wants to publish “${title}” — ${inspection.files.length === 1 ? '1 file' : `${inspection.files.length} files`}, ${formatArtifactBytes(inspection.size)}, visible to ${summary.audience}.`
    options.onEvent?.({
      type: 'needs_input',
      requestId,
      resume: 'reply',
      request: {
        kind: 'question',
        questions: [{
          header: 'Publish artifact',
          question: publishLine,
          multiSelect: false,
          options: [{ label: 'Publish', description: `Publish it to ${support.instanceName || 'Cinna'}` }, { label: 'Deny', description: 'Do not publish it' }]
        }]
      }
    })
    const outcome = await this.deps.approvals.open({ summary, profileUserId: profile, publish }, signal)
    options.onEvent?.({
      type: 'input_resolved',
      requestId,
      resolution: outcome.kind === 'published' ? { kind: 'question', answers: [['Publish']] }
        : outcome.kind === 'denied' ? { kind: 'question', answers: [['Deny']] }
          : { kind: 'rejected' }
    })
    switch (outcome.kind) {
      case 'published':
        return { content: toolResult(outcome.result) }
      case 'denied':
        throw new Refusal(`${ARTIFACT_AGENT_SENTENCE.declined}${path}; do not retry unless they ask.`, 'you declined', 'declined')
      case 'timeout':
        throw new Refusal(
          `${ARTIFACT_AGENT_SENTENCE.timeout}${path} within an hour, so it was not published. Ask the user before trying again.`,
          'no answer within an hour',
          'timeout'
        )
      default:
        throw new Refusal(
          `${ARTIFACT_AGENT_SENTENCE.cancelled}${path} was cancelled before the user answered, so it was not published.`,
          'the chat stopped before you answered',
          'cancelled'
        )
    }
  }
}

/** Exactly the schema's result object. */
function toolResult(result: Extract<ArtifactsPublishOutcome, { ok: true }>): ArtifactPublishToolResult {
  return {
    artifact_id: result.artifact.id,
    revision: result.artifact.revision,
    url: result.artifact.url,
    kind: result.artifact.kind,
    file_count: result.sent?.fileCount ?? 0,
    size_bytes: result.sent?.sizeBytes ?? 0,
    excluded: [...new Set([...(result.sent?.excluded ?? []), ...result.excluded])]
  }
}

function summaryOf(input: {
  requestId: string
  session: ArtifactToolSession
  toolCallId: string
  agentName: string
  title: string
  description: string | undefined
  inspection: ArtifactInspection
  target: PublishedArtifactRow | null
  /** Core's state read just before asking; preferred over the local row. */
  fresh?: ArtifactDetail | null
  instanceName?: string
}): ArtifactApprovalSummary {
  const { inspection, target } = input
  return {
    requestId: input.requestId,
    chatId: input.session.chatId,
    toolCallId: input.toolCallId,
    agentId: input.session.agentId,
    agentName: input.agentName,
    path: inspection.path,
    relativePath: inspection.relativePath,
    title: input.title,
    description: input.description ?? null,
    entry: inspection.entry,
    isFolder: inspection.isFolder,
    kind: inspection.kind,
    kindLine: artifactKindLine({ isFolder: inspection.isFolder, kind: inspection.kind, entry: inspection.entry, fileCount: inspection.files.length, name: inspection.name }),
    files: inspection.files,
    excluded: inspection.excluded,
    size: inspection.size,
    limits: inspection.limits,
    ...(input.instanceName ? { instanceName: input.instanceName } : {}),
    audience: target ? artifactAudience(input.fresh ?? target, input.instanceName) : 'only you',
    update: target
      ? {
          artifactId: target.artifactId,
          title: input.fresh?.title ?? target.title,
          revision: input.fresh?.revision ?? target.revision,
          visibility: input.fresh?.visibility ?? target.visibility
        }
      : null
  }
}
