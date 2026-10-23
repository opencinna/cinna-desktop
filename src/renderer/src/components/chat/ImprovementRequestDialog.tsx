import { useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Info, Loader2 } from 'lucide-react'
import { CANCEL, DialogShell, ErrorLine, FIELD_BASE, PRIMARY } from '../agents/local/sharing/ShareDialogs'
import { SettingsInfoTip } from '../settings/SettingsLayout'
import { AgentChip } from './AgentChip'
import { useAgentColor } from '../../utils/agentColors'
import { IMPROVEMENT_KEY } from '../../hooks/useImprovementRequests'
import { unwrapIpcError } from '../../utils/ipcError'
import {
  IMPROVEMENT_COMMENT_MAX,
  type ImprovementContext,
  type ImprovementRequestInput,
  type ImprovementTarget
} from '../../../../shared/improvementRequests'

/** "3 min ago" — how recently the agent's session in this chat moved. */
function sinceLabel(target: ImprovementTarget, now: number): string | null {
  if (target.lastActivityAt === null) return null
  const minutes = Math.max(0, Math.round((now - target.lastActivityAt) / 60000))
  const when = minutes < 1 ? 'just now'
    : minutes < 60 ? `${minutes} min ago`
      : minutes < 60 * 24 ? `${Math.round(minutes / 60)} h ago`
        : new Date(target.lastActivityAt).toLocaleDateString()
  return when
}

/** "Alpha · 3 min ago" — the picker tells two sessions of one chat apart by agent and recency. */
function targetLabel(target: ImprovementTarget, now: number): string {
  const since = sinceLabel(target, now)
  return since ? `${target.agentName} · ${since}` : target.agentName
}

/** The toast after sending: who has it now. */
export function improvementConfirmation(context: ImprovementContext, agentName: string): string {
  return context.isSharedExternally && context.recipientDisplay
    ? `Improvement request sent to ${context.recipientDisplay}.`
    : `Improvement request saved on your own agent ${context.targetAgentName ?? agentName}.`
}

/**
 * Improvement request: send this chat's conversation with a cloud bundle agent
 * to whoever publishes the bundle, with a note on what should change.
 *
 * **Top-anchored, sized to content.** The disclosure is one or two plain
 * lines led by an info icon — one line while the pre-flight runs ("Checking
 * who receives it…") and one line for a session that cannot be sent. The
 * recipient is their name and, when core sends it, `<email>`, in bold; the
 * agent is its regular agent chip. The pre-flight landing may
 * change the height; typing never does. The dialog is pinned by its top edge,
 * so a refusal under the buttons only lengthens it downward and closes
 * nothing. A session that cannot be sent keeps the message (it carries over to
 * another agent) and says so beside the disabled Send.
 *
 * The send itself is owned by the composer ({@link useCreateImprovementRequest}),
 * which closes this dialog and raises the confirmation on success.
 */
export function ImprovementRequestDialog({
  chatId,
  targets,
  pending,
  error,
  onSubmit,
  onTargetChange,
  onClose
}: {
  chatId: string
  /** At least one; the chat's own agent first. */
  targets: ImprovementTarget[]
  pending: boolean
  error: string | null
  onSubmit: (input: ImprovementRequestInput, confirmation: string) => void
  /** Another agent picked: a refusal about the previous one no longer applies. */
  onTargetChange?: () => void
  onClose: () => void
}): React.JSX.Element {
  const messageRef = useRef<HTMLTextAreaElement>(null)
  const [agentId, setAgentId] = useState(() => targets[0]?.agentId ?? '')
  const [comment, setComment] = useState('')
  const [includeMemory, setIncludeMemory] = useState(true)
  const [now] = useState(() => Date.now())
  const target = targets.find((t) => t.agentId === agentId) ?? targets[0]

  const contextQuery = useQuery({
    queryKey: [...IMPROVEMENT_KEY, 'context', chatId, target?.agentId],
    queryFn: async () => {
      const outcome = await window.api.improvementRequests.context(chatId, target.agentId)
      if (!outcome.ok) throw new Error(outcome.message)
      return outcome.context
    },
    enabled: !!target,
    retry: false,
    staleTime: 0
  })
  const context = contextQuery.data ?? null
  const blocked = !context || !context.eligible || comment.trim() === '' || !target
  /** Nothing to send whatever is typed: core refused, or the pre-flight failed. */
  const unsendable = contextQuery.isError || (context !== null && !context.eligible)

  const submit = (): void => {
    if (pending || blocked || !context) return
    onSubmit(
      { chatId, agentId: target.agentId, comment: comment.trim(), includeMemory },
      improvementConfirmation(context, target.agentName)
    )
  }

  const colorOf = useAgentColor()
  const label = 'block text-[11px] text-[var(--color-text-muted)] mb-1'
  const infoLine = 'flex items-start gap-2 text-xs leading-relaxed'
  const agentName = context?.targetAgentName ?? target?.agentName ?? ''
  const since = target ? sinceLabel(target, now) : null
  const recipient = context?.recipientDisplay ?? 'the bundle’s publisher'
  return (
    <DialogShell title="Improvement request" pending={pending} onDismiss={onClose} initialFocusRef={messageRef} width="w-[30rem]" align="top">
      <form
        className="min-h-0 flex-1 space-y-3 overflow-y-auto"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <div>
          <div className="flex h-7 items-center">
            {targets.length > 1 ? (
              <select
                aria-label="Agent session"
                value={target?.agentId ?? ''}
                disabled={pending}
                onChange={(event) => {
                  setAgentId(event.target.value)
                  onTargetChange?.()
                }}
                className={`w-full py-1 ${FIELD_BASE}`}
              >
                {targets.map((t) => (
                  <option key={t.agentId} value={t.agentId}>{targetLabel(t, now)}</option>
                ))}
              </select>
            ) : (
              <div className="flex min-w-0 items-center gap-2" data-improvement-agent>
                {target && <AgentChip name={target.agentName} colors={colorOf(target.agentId)} label={`Agent "${target.agentName}"`} />}
                {since && <span className="truncate text-[11px] text-[var(--color-text-muted)]">{since}</span>}
              </div>
            )}
          </div>
        </div>

        <div data-improvement-context aria-live="polite" aria-busy={contextQuery.isLoading || undefined} className="space-y-1.5">
          {contextQuery.isLoading && (
            <p className={`${infoLine} text-[var(--color-text-muted)]`}>
              <Loader2 size={14} className="mt-0.5 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden />
              Checking who receives it…
            </p>
          )}
          {contextQuery.isError && (
            <p role="alert" className={`${infoLine} text-[var(--color-danger)]`}>
              <Info size={14} className="mt-0.5 shrink-0" aria-hidden />
              {unwrapIpcError(contextQuery.error, 'Could not check this conversation.')}
            </p>
          )}
          {context && !context.eligible && (
            <p role="alert" className={`${infoLine} text-[var(--color-danger)]`}>
              <Info size={14} className="mt-0.5 shrink-0" aria-hidden />
              {context.reasonText}
            </p>
          )}
          {context && context.eligible && (
            <div className={`${infoLine} text-[var(--color-text-secondary)]`}>
              <Info size={14} className="mt-0.5 shrink-0 text-[var(--color-text-muted)]" aria-hidden />
              <div className="space-y-1">
                <p>
                  {context.isSharedExternally ? (
                    <>
                      Goes to{' '}
                      <strong data-improvement-recipient className="font-semibold text-[var(--color-text)]">
                        {recipient}{context.recipientEmail ? ` <${context.recipientEmail}>` : ''}
                      </strong>
                      , who publishes the bundle this agent was installed from.
                    </>
                  ) : (
                    <>Kept on your own agent <strong className="font-semibold text-[var(--color-text)]">{agentName}</strong> as a note for later improvements. Nothing leaves your account.</>
                  )}
                </p>
                <p>
                  {context.messageCount === 1
                    ? '1 message will be captured as it is right now.'
                    : `${context.messageCount} messages will be captured as they are right now.`}{' '}
                  Continuing the conversation afterwards won’t change what is shared.
                </p>
                {context.existingRequestCount > 0 && (
                  <p>
                    You have sent {context.existingRequestCount} {context.existingRequestCount === 1 ? 'request' : 'requests'} for this conversation before.
                  </p>
                )}
              </div>
            </div>
          )}
        </div>

        <div>
          <label htmlFor="improvement-message" className={label}>Message</label>
          <textarea
            id="improvement-message"
            ref={messageRef}
            value={comment}
            rows={5}
            required
            maxLength={IMPROVEMENT_COMMENT_MAX}
            disabled={pending}
            placeholder="What should the agent do differently?"
            onChange={(event) => setComment(event.target.value)}
            className={`w-full resize-none ${FIELD_BASE}`}
          />
        </div>

        <div className="flex items-center gap-1.5">
          <label className="flex items-center gap-2 text-xs text-[var(--color-text)]">
            <input
              type="checkbox"
              checked={includeMemory}
              disabled={pending}
              onChange={(event) => setIncludeMemory(event.target.checked)}
            />
            Include MEMORY files of this agent
          </label>
          <SettingsInfoTip label="About MEMORY files">
            <p>
              These are the agent’s notes about you, kept in its <span className="font-mono">app-data/memory</span> folder
              and added to its system prompt on every turn. Including them shows the recipient the prompt that actually ran.
            </p>
            <p>Untick to leave them out of what is shared.</p>
          </SettingsInfoTip>
        </div>

        <div className="flex items-center justify-end gap-2 pt-1">
          {unsendable && (
            <span data-improvement-unsendable className="text-[11px] text-[var(--color-text-muted)]">
              Can’t be sent
            </span>
          )}
          <button type="button" className={CANCEL} disabled={pending} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className={PRIMARY} disabled={pending || blocked} aria-busy={pending || undefined}>
            {pending && <Loader2 size={12} className="animate-spin motion-reduce:animate-none" aria-hidden />}
            {pending ? 'Sending…' : 'Send request'}
          </button>
        </div>
        <ErrorLine error={error} />
      </form>
    </DialogShell>
  )
}
