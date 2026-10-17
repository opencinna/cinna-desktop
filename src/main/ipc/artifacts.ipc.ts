import { userActivation } from '../auth/activation'
import { getProfileScopeUserId } from '../auth/scope'
import { artifactApprovals, artifactService } from '../services/artifacts/artifactService'
import type {
  ArtifactApprovalAnswer,
  ArtifactApprovalEdits,
  ArtifactApprovalSummary,
  ArtifactCardDto,
  PublishedArtifact,
  ArtifactsDetailOutcome,
  ArtifactsInspectOutcome,
  ArtifactsLinkOutcome,
  ArtifactsPublishOutcome,
  ArtifactsSupport
} from '../../shared/artifacts'
import { ipcHandle } from './_wrap'

/**
 * Artifacts (publish a file or folder to the profile's cinna-core, and share
 * it). Thin: activation gate, delegate. Every payload is untrusted — the
 * service re-validates the shape, finds the agent's folder itself and
 * re-checks that the path is inside it — and every answer, refusals
 * included, is data (`src/shared/artifacts.ts`).
 */
export function registerArtifactHandlers(): void {
  ipcHandle('artifacts:support', (): Promise<ArtifactsSupport> => {
    userActivation.requireActivated()
    return artifactService.support()
  })

  ipcHandle('artifacts:inspect', (_event, input: unknown): Promise<ArtifactsInspectOutcome> => {
    userActivation.requireActivated()
    return artifactService.inspect(input)
  })

  ipcHandle('artifacts:publish', (_event, input: unknown): Promise<ArtifactsPublishOutcome> => {
    userActivation.requireActivated()
    return artifactService.publish(input)
  })

  ipcHandle('artifacts:cards', (_event, chatId: unknown): ArtifactCardDto[] => {
    userActivation.requireActivated()
    return artifactService.cards(chatId)
  })

  ipcHandle('artifacts:detail', (_event, artifactId: unknown): Promise<ArtifactsDetailOutcome> => {
    userActivation.requireActivated()
    return artifactService.detail(artifactId)
  })

  ipcHandle('artifacts:set-visibility', (_event, input?: { artifactId?: unknown; visibility?: unknown }): Promise<ArtifactsDetailOutcome> => {
    userActivation.requireActivated()
    return artifactService.setVisibility(input?.artifactId, input?.visibility)
  })

  ipcHandle('artifacts:create-link', (_event, input?: { artifactId?: unknown; withCode?: unknown }): Promise<ArtifactsLinkOutcome> => {
    userActivation.requireActivated()
    return artifactService.createLink(input?.artifactId, { withCode: input?.withCode === true })
  })

  /** One artifact from the local memory (an agent's published tool call renders its card from it). */
  ipcHandle('artifacts:local', (_event, artifactId: unknown): PublishedArtifact | null => {
    userActivation.requireActivated()
    return artifactService.local(artifactId)
  })

  /** A chat's pending agent publishes, for the approval card. */
  ipcHandle('artifacts:approvals', (_event, chatId: unknown): ArtifactApprovalSummary[] => {
    userActivation.requireActivated()
    return typeof chatId === 'string' ? artifactApprovals.list(getProfileScopeUserId(), chatId) : []
  })

  /** Publish or deny an agent's request; `edits` are Edit…'s choices. Only the active profile's. */
  ipcHandle('artifacts:answer-approval', (_event, input?: { requestId?: unknown; decision?: unknown; edits?: unknown }): Promise<ArtifactApprovalAnswer> => {
    userActivation.requireActivated()
    const requestId = typeof input?.requestId === 'string' ? input.requestId : ''
    const decision = input?.decision === 'publish' || input?.decision === 'deny' ? input.decision : null
    if (!requestId || !decision) return Promise.resolve({ ok: false, code: 'invalid_input', message: 'Choose Publish or Deny.' })
    return artifactApprovals.answer(getProfileScopeUserId(), requestId, decision, editsOf(input?.edits))
  })

  ipcHandle('artifacts:revoke-link', (_event, input?: { artifactId?: unknown; linkId?: unknown }): Promise<ArtifactsDetailOutcome> => {
    userActivation.requireActivated()
    return artifactService.revokeLink(input?.artifactId, input?.linkId)
  })
}

/** Edit…'s choices, field by field; the publish validates them again. */
function editsOf(value: unknown): ArtifactApprovalEdits | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  const visibility = raw.visibility === 'instance' || raw.visibility === 'link' ? raw.visibility : 'private'
  return {
    title: typeof raw.title === 'string' ? raw.title : '',
    ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
    entry: typeof raw.entry === 'string' && raw.entry ? raw.entry : null,
    artifactId: typeof raw.artifactId === 'string' && raw.artifactId ? raw.artifactId : null,
    visibility
  }
}
