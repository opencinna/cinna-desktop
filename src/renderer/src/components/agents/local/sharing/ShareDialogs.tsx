import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Loader2 } from 'lucide-react'
import { useDialogChrome } from '../../../settings/SettingsLayout'
import { unwrapIpcError } from '../../../../utils/ipcError'
import { unwrapCatalogOutcome } from '../../../../../../shared/catalog'
import type { ShareWithTeamDraft } from '../../../../../../shared/agentSharing'
import { SHARE_UI_TEXT } from '../../../../utils/shareText'

/**
 * The three sharing dialogs: Share changes, the two-button conflict (plan S8)
 * and Share with the team.
 *
 * None of them owns its action. The mutation lives in the component that opens
 * the dialog and outlives it — the status line, the ⋯ menu — so a result that
 * closes this dialog or opens the next one is a hook-level callback, which
 * TanStack runs even after the dialog has gone (ux_rules rule 5). Each closes
 * on success only and cannot be dismissed while its action runs; a refusal
 * renders under the field, last in the dialog, moving nothing above it.
 */

const PRIMARY =
  'inline-flex min-w-[6rem] items-center justify-center gap-1.5 rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-xs font-medium text-white ' +
  'transition-colors hover:bg-[var(--color-accent-hover)] disabled:cursor-not-allowed disabled:opacity-50'
const SECONDARY =
  'inline-flex items-center justify-center gap-1.5 rounded-md border border-[var(--color-border)] px-3 py-1.5 text-xs font-medium ' +
  'text-[var(--color-text)] transition-colors hover:bg-[var(--color-bg-hover)] disabled:cursor-not-allowed disabled:opacity-50'
const CANCEL =
  'rounded-md px-3 py-1.5 text-xs font-medium text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text-secondary)] disabled:opacity-50'
const FIELD =
  'w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-2.5 py-1.5 text-xs text-[var(--color-text)] ' +
  'placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-accent)] focus:outline-none disabled:opacity-60'

function DialogShell({
  title,
  pending,
  onDismiss,
  initialFocusRef,
  children
}: {
  title: string
  pending: boolean
  onDismiss: () => void
  initialFocusRef: React.RefObject<HTMLElement | null>
  children: ReactNode
}): React.JSX.Element {
  const modalRef = useRef<HTMLDivElement>(null)
  useDialogChrome({ modalRef, initialFocusRef, pending, onDismiss })
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/25">
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        // The accessible name is the visible heading (ux_rules rule 10).
        aria-label={title}
        className="app-popover-surface w-[28rem] space-y-3 rounded-lg border border-[var(--color-border)] p-5 shadow-xl"
      >
        <div className="text-sm font-medium text-[var(--color-text)]">{title}</div>
        {children}
      </div>
    </div>,
    document.body
  )
}

function ErrorLine({ error }: { error: string | null }): React.JSX.Element | null {
  if (!error) return null
  return (
    <p role="alert" className="text-[11px] leading-relaxed text-[var(--color-danger)]">
      {error}
    </p>
  )
}

/**
 * Share changes: one field for what changed, pre-filled by an AI summary.
 *
 * The field is there and editable from the first frame, with "Writing a
 * summary…" as its placeholder; the draft fills it only if the user has not
 * typed, so a slow summary never overwrites their words.
 */
export function ShareChangesDialog({
  agentId,
  pending,
  error,
  onShare,
  onCancel
}: {
  agentId: string
  pending: boolean
  error: string | null
  onShare: (message: string) => void
  onCancel: () => void
}): React.JSX.Element {
  const fieldRef = useRef<HTMLTextAreaElement>(null)
  const [message, setMessage] = useState('')
  const [drafting, setDrafting] = useState(true)
  const touched = useRef(false)

  useEffect(() => {
    let cancelled = false
    void window.api.sharing
      .draftMessage(agentId)
      .then((outcome) => {
        if (cancelled) return
        const draft = unwrapCatalogOutcome(outcome)
        if (!touched.current && draft) setMessage(draft)
      })
      // No summary is no loss: the field is the user's either way.
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setDrafting(false)
      })
    return () => {
      cancelled = true
    }
  }, [agentId])

  const submit = (): void => {
    if (pending) return
    onShare(message.trim())
  }

  return (
    <DialogShell
      title={SHARE_UI_TEXT.shareChangesTitle}
      pending={pending}
      onDismiss={onCancel}
      initialFocusRef={fieldRef}
    >
      <label className="block space-y-1">
        <span className="block text-[11px] text-[var(--color-text-muted)]">{SHARE_UI_TEXT.shareChangesLabel}</span>
        <textarea
          ref={fieldRef}
          rows={4}
          value={message}
          disabled={pending}
          placeholder={drafting ? SHARE_UI_TEXT.shareChangesPlaceholder : SHARE_UI_TEXT.shareChangesEmptyPlaceholder}
          onChange={(event) => {
            touched.current = true
            setMessage(event.target.value)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault()
              submit()
            }
          }}
          className={`${FIELD} resize-none`}
        />
      </label>
      <ErrorLine error={error} />
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} disabled={pending} className={CANCEL}>
          {SHARE_UI_TEXT.cancel}
        </button>
        <button type="button" onClick={submit} disabled={pending} aria-busy={pending} className={PRIMARY}>
          {pending ? (
            <>
              <Loader2 size={11} className="animate-spin" aria-hidden="true" />
              {SHARE_UI_TEXT.sharing}
            </>
          ) : (
            SHARE_UI_TEXT.share
          )}
        </button>
      </div>
    </DialogShell>
  )
}

/**
 * The team changed this agent too (plan S8): two buttons, never a diff view.
 * The recoverable choice — keep working, share later — takes focus.
 */
export function ShareConflictDialog({
  pending,
  error,
  onUseTeamVersion,
  onKeepMine
}: {
  pending: boolean
  error: string | null
  onUseTeamVersion: () => void
  onKeepMine: () => void
}): React.JSX.Element {
  const keepRef = useRef<HTMLButtonElement>(null)
  return (
    <DialogShell title={SHARE_UI_TEXT.conflictTitle} pending={pending} onDismiss={onKeepMine} initialFocusRef={keepRef}>
      <p className="text-xs leading-relaxed text-[var(--color-text-secondary)]">{SHARE_UI_TEXT.conflictBody}</p>
      <ErrorLine error={error} />
      <div className="flex flex-col items-stretch gap-2">
        <button type="button" onClick={onUseTeamVersion} disabled={pending} aria-busy={pending} className={PRIMARY}>
          {pending ? (
            <>
              <Loader2 size={11} className="animate-spin" aria-hidden="true" />
              {SHARE_UI_TEXT.usingTeamVersion}
            </>
          ) : (
            SHARE_UI_TEXT.useTeamVersion
          )}
        </button>
        <button ref={keepRef} type="button" onClick={onKeepMine} disabled={pending} className={SECONDARY}>
          {SHARE_UI_TEXT.keepMine}
        </button>
      </div>
    </DialogShell>
  )
}

/**
 * Share with the team: name and description, pre-filled from the manifest.
 * The fields are there from the first frame; the draft fills each one the
 * user has not typed into.
 */
export function ShareWithTeamDialog({
  agentId,
  pending,
  error,
  onShare,
  onCancel
}: {
  agentId: string
  pending: boolean
  error: string | null
  onShare: (input: ShareWithTeamDraft) => void
  onCancel: () => void
}): React.JSX.Element {
  const nameRef = useRef<HTMLInputElement>(null)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [loading, setLoading] = useState(true)
  const [draftError, setDraftError] = useState<string | null>(null)
  const touched = useRef({ name: false, description: false })

  useEffect(() => {
    let cancelled = false
    void window.api.sharing
      .shareWithTeamDraft(agentId)
      .then((outcome) => {
        if (cancelled) return
        const draft = unwrapCatalogOutcome(outcome)
        if (!touched.current.name) setName(draft.name)
        if (!touched.current.description) setDescription(draft.description)
      })
      .catch((err) => {
        if (!cancelled) setDraftError(unwrapIpcError(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [agentId])

  const submit = (): void => {
    if (pending || name.trim() === '') return
    onShare({ name: name.trim(), description: description.trim() })
  }

  return (
    <DialogShell title={SHARE_UI_TEXT.shareWithTeamTitle} pending={pending} onDismiss={onCancel} initialFocusRef={nameRef}>
      <p className="text-xs leading-relaxed text-[var(--color-text-secondary)]">{SHARE_UI_TEXT.shareWithTeamBody}</p>
      <label className="block space-y-1">
        <span className="block text-[11px] text-[var(--color-text-muted)]">{SHARE_UI_TEXT.nameLabel}</span>
        <input
          ref={nameRef}
          type="text"
          value={name}
          disabled={pending}
          placeholder={loading ? SHARE_UI_TEXT.loadingDraft : undefined}
          onChange={(event) => {
            touched.current.name = true
            setName(event.target.value)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              submit()
            }
          }}
          className={FIELD}
        />
      </label>
      <label className="block space-y-1">
        <span className="block text-[11px] text-[var(--color-text-muted)]">{SHARE_UI_TEXT.descriptionLabel}</span>
        <textarea
          rows={3}
          value={description}
          disabled={pending}
          placeholder={loading ? SHARE_UI_TEXT.loadingDraft : undefined}
          onChange={(event) => {
            touched.current.description = true
            setDescription(event.target.value)
          }}
          className={`${FIELD} resize-none`}
        />
      </label>
      <ErrorLine error={error ?? draftError} />
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} disabled={pending} className={CANCEL}>
          {SHARE_UI_TEXT.cancel}
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={pending || name.trim() === ''}
          aria-busy={pending}
          className={PRIMARY}
        >
          {pending ? (
            <>
              <Loader2 size={11} className="animate-spin" aria-hidden="true" />
              {SHARE_UI_TEXT.sharing}
            </>
          ) : (
            SHARE_UI_TEXT.share
          )}
        </button>
      </div>
    </DialogShell>
  )
}
