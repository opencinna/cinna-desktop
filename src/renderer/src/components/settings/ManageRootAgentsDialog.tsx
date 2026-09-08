import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Loader2 } from 'lucide-react'
import type { AgentRootDto, DiscoveredBareAgent } from '../../../../shared/localAgents'
import { useAddAgentFolder, useManageRootAgents } from '../../hooks/useLocalAgents'
import { unwrapIpcError } from '../../utils/ipcError'
import { useDialogChrome } from './SettingsLayout'

/**
 * Choose which of a registered folder's agents are in the list.
 *
 * Replaces the "13 agents in this folder are not in the list — Add them" row.
 * That row could only do the two extremes: all of them, or none. The set the
 * user actually wants is somewhere in between often enough that the only way
 * to reach it was the adopt dialog, which meant re-picking the folder in an OS
 * file dialog to change one tick.
 *
 * **It is the adopt dialog's own selection step, reached by root id.**
 * `local-agent:root-manage` records the registered folder as the pending pick,
 * so the save below is the ordinary `folderAdd` re-selection: the list sent is
 * the *whole* set the user wants, and a folder left out of it leaves the list
 * exactly as ⋯ → Remove from the list would. Nothing on disk is touched either
 * way.
 */
export function ManageRootAgentsDialog({
  root,
  onClose
}: {
  root: AgentRootDto
  onClose: () => void
}): React.JSX.Element {
  const modalRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const manage = useManageRootAgents()
  const save = useAddAgentFolder()
  const [found, setFound] = useState<DiscoveredBareAgent[] | null>(null)
  const [path, setPath] = useState<string | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)

  /**
   * Read the folder once, on open.
   *
   * `manage` is a mutation, so this cannot be a render-time query — and it must
   * not re-run, because each call re-records the pending pick in main.
   */
  useEffect(() => {
    manage.mutate(root.id, {
      onSuccess: (result) => {
        if (result.cancelled) {
          setError('That folder could not be read.')
          return
        }
        setFound(result.found)
        setPath(result.path)
        setTruncated(result.truncated)
        // Ticked = in the list today. `addedElsewhere` rows are ticked and
        // locked below: this folder's selection cannot speak for another root.
        setChecked(new Set(result.found.filter((a) => a.alreadyAdded).map((a) => a.relPath)))
        if (result.refusal) setError(result.refusal)
      },
      onError: (err) => setError(unwrapIpcError(err, 'That folder could not be read.'))
    })
    // Once, for this root.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root.id])

  useDialogChrome({ modalRef, initialFocusRef: closeRef, pending: save.isPending, onDismiss: onClose })

  const locked = useMemo(
    () => new Set((found ?? []).filter((a) => a.addedElsewhere).map((a) => a.relPath)),
    [found]
  )

  const toggle = (relPath: string): void => {
    if (locked.has(relPath)) return
    setError(null)
    setChecked((current) => {
      const next = new Set(current)
      if (next.has(relPath)) next.delete(relPath)
      else next.add(relPath)
      return next
    })
  }

  /** Re-record the pending pick and re-read the folder. */
  const reload = (): void => {
    manage.mutate(root.id, {
      onSuccess: (result) => {
        if (result.cancelled) return
        setFound(result.found)
        setPath(result.path)
        setTruncated(result.truncated)
        setChecked(new Set(result.found.filter((a) => a.alreadyAdded).map((a) => a.relPath)))
      }
    })
  }

  const commit = (): void => {
    if (!path) return
    setError(null)
    save.mutate(
      // Locked rows are in the list and this dialog may not take them out, so
      // they go back in the selection whether or not they were rendered as the
      // user's own choice.
      { path, relPaths: [...new Set([...checked, ...locked])] },
      {
        onSuccess: () => onClose(),
        onError: (err) => {
          setError(unwrapIpcError(err, 'That selection could not be saved.'))
          /*
            `addAgentFolder` clears main's pending pick on the branch where the
            folder indexed nothing — it went missing between opening this dialog
            and saving. Without re-recording it, a second Save fails with
            "Choose the folder again — this one was not the last one picked",
            a sentence written for the OS-picker flow and shown here to a user
            who chose no folder. Re-reading also refreshes the list, which is
            what the failure was about (ux_rules rule 6: the surface stays
            usable).
          */
          reload()
        }
      }
    )
  }

  /** In the list now but unticked — the part of a save that cannot be undone. */
  const leaving = (found ?? []).filter((a) => a.alreadyAdded && !checked.has(a.relPath))
  const joining = (found ?? []).filter((a) => !a.alreadyAdded && checked.has(a.relPath))
  const selectedCount = checked.size

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/25">
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="manage-root-agents-title"
        className="app-popover-surface flex max-h-[80vh] w-[32rem] flex-col rounded-lg border border-[var(--color-border)] shadow-xl"
      >
        <div className="border-b border-[var(--color-border)] px-5 py-4">
          <div id="manage-root-agents-title" className="text-[14px] font-medium text-[var(--color-text)]">
            Manage agents
          </div>
          {/*
            Unticking is the same act as ⋯ → Remove from the list: the `agents`
            row is dropped and `job_agents` cascades with it. Two sibling
            surfaces state that in full — the Forget confirm and the agent's own
            Remove dialog — and this one can do it to several agents at once
            from a single Save, so it must not say less than either
            (ux_rules rule 5).
          */}
          <p className="mt-0.5 text-[13px] leading-relaxed text-[var(--color-text-muted)]">
            Which agents in <span className="font-mono text-[12px]">{root.label}</span> are in your
            list. Unticking one takes it out of the app — its folder stays on disk, but chats can no
            longer reach it and any job set up with it loses that agent.
          </p>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
          {manage.isPending || found === null ? (
            <div className="flex items-center gap-2 py-6 text-[13px] text-[var(--color-text-muted)]">
              <Loader2 size={14} className="animate-spin" />
              Reading the folder…
            </div>
          ) : found.length === 0 ? (
            <p className="py-6 text-[13px] text-[var(--color-text-muted)]">
              No <code className="font-mono">AGENT.md</code> folders were found here.
            </p>
          ) : (
            <div className="space-y-1">
              {found.map((agent) => {
                const isLocked = locked.has(agent.relPath)
                return (
                  <label
                    key={agent.relPath}
                    title={isLocked ? 'This agent belongs to a different agents folder.' : agent.path}
                    className={`flex items-start gap-2.5 rounded-md border border-transparent px-2 py-1.5 ${
                      isLocked
                        ? 'cursor-not-allowed opacity-60'
                        : 'cursor-pointer hover:border-[var(--color-border)] hover:bg-[var(--color-bg-hover)]'
                    }`}
                  >
                    <input
                      type="checkbox"
                      className="mt-1 accent-[var(--color-accent)]"
                      checked={isLocked || checked.has(agent.relPath)}
                      disabled={isLocked || save.isPending}
                      onChange={() => toggle(agent.relPath)}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] text-[var(--color-text)]">
                        {agent.name}
                      </span>
                      <span className="block truncate font-mono text-[12px] text-[var(--color-text-muted)]">
                        {agent.relPath === '.' ? root.label : agent.relPath}
                      </span>
                    </span>
                  </label>
                )
              })}
            </div>
          )}

          {truncated && (
            <p className="mt-2 text-[13px] leading-relaxed text-[var(--color-text-muted)]">
              This is the first {found?.length ?? 0} found — the folder holds more than this screen
              walks.
            </p>
          )}
        </div>

        <div className="border-t border-[var(--color-border)] px-5 py-4">
          {/* Reserved, so a refusal does not move the buttons (ux_rules rule 1). */}
          <div role="alert" className="min-h-[3.25rem] text-[13px] leading-relaxed text-[var(--color-danger)]">
            {error}
          </div>
          <div className="flex items-center gap-2">
            {/*
              The count alone said "2 of 5 selected", which is true whether the
              save adds three or removes three. Naming the *leaving* agents is
              the half that cannot be undone, so it is the half the footer
              states.
            */}
            <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--color-text-muted)]">
              {found === null ? (
                ''
              ) : leaving.length > 0 ? (
                <span className="text-[var(--color-warning)]">
                  {leaving.length} agent{leaving.length === 1 ? '' : 's'} will leave the list
                </span>
              ) : (
                `${selectedCount} of ${found.length} selected${
                  joining.length > 0 ? ` · ${joining.length} to add` : ''
                }`
              )}
            </span>
            <button
              ref={closeRef}
              type="button"
              onClick={onClose}
              disabled={save.isPending}
              className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-[13px] font-medium
                text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text)]
                disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={commit}
              disabled={save.isPending || found === null || found.length === 0}
              className="min-w-[6.5rem] rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-[13px]
                font-medium text-white transition-colors hover:bg-[var(--color-accent-hover)]
                disabled:opacity-50"
            >
              {save.isPending ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}
