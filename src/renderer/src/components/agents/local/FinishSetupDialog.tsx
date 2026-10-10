import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, CheckCircle2, Circle, Loader2 } from 'lucide-react'
import type { CredentialSetupOption, CredentialSetupSkillSlot, CredentialSetupSlot } from '../../../../../shared/serviceCredentials'
import { unwrapLocalAgentOutcome } from '../../../../../shared/localAgents'
import { credentialResult, useCredentialSetup } from '../../../hooks/useServiceCredentials'
import { LOCAL_AGENTS_KEY, localAgentKey } from '../../../hooks/useLocalAgents'
import { autoAttachedKey, useFinishSetupStore } from '../../../stores/finishSetup.store'
import { unwrapIpcError } from '../../../utils/ipcError'
import { CredentialRow } from '../../settings/CredentialRow'
import { credentialHealth, credentialOwnership } from '../../settings/credentialPresentation'
import { CANCEL, DialogShell, FIELD_BASE, PRIMARY, SECONDARY } from './sharing/ShareDialogs'

/**
 * Finish setting up a folder agent that arrived without its credentials — a
 * Get from the team library, or an Update that added a slot. Only the
 * manifest's slots travel; values and attachments never do.
 *
 * One row per slot, in the scanner's own verdict (`setupState` restates it):
 * connected (its matching attachment is ready), set on this computer (no
 * attachment, and `credentials/.env` fills it the way the kit reads it: every
 * declared name, or for a slot without `fields` any name under its prefix), or
 * missing — with the
 * attachment that stopped counting, the active account's records that fit, and
 * a row per `.env` name. A slot that declares no `fields` has no names to ask
 * for — the kit reads any `<prefix><FIELD>` — so it offers its records and
 * Open credentials/.env instead. Nothing here blocks the agent: Finish later
 * and Done both close, and a missing credential stays the page's warning.
 *
 * Below them, the slots the agent's skills declare (U11), each "needed by"
 * its skills: filled only by an attached record of its type whose Service URI
 * is the slot, so they offer records and no `.env` names. Opening the dialog
 * asks main to fill them where exactly one record fits (after Core's
 * `provision-local`); they never decide whether the dialog opens by itself.
 *
 * The dialog's top is pinned, so a row that changes moves only what is below
 * it; the slot list scrolls inside a dialog no taller than the window, and the
 * footer reserves the line a refusal takes, so neither moves the buttons;
 * every `.env` name keeps its row (a saved one reads Set); and while anything
 * typed is unsaved, only the footer's buttons close it.
 */

export type FinishSetupStatus = 'Connected automatically' | 'Connected' | 'Set on this computer' | 'Missing' | 'Optional'

export function finishSetupStatus(slot: CredentialSetupSlot, autoAttached: readonly string[]): FinishSetupStatus {
  if (slot.state === 'connected') return autoAttached.includes(slot.name) ? 'Connected automatically' : 'Connected'
  if (slot.state === 'env') return 'Set on this computer'
  return slot.optional ? 'Optional' : 'Missing'
}

/** A skill slot's status: never `.env`, and remembered under `skill:<slot>` when attached without asking. */
export function skillSlotStatus(slot: CredentialSetupSkillSlot, autoAttached: readonly string[]): FinishSetupStatus {
  if (slot.state === 'connected') return autoAttached.includes(autoAttachedKey({ slot: slot.slot, skill: true })) ? 'Connected automatically' : 'Connected'
  return 'Missing'
}

/** A skill slot drawn by the agent slot's row: records only, no `.env` names. */
function asSlotRow(slot: CredentialSetupSkillSlot): CredentialSetupSlot {
  return { name: slot.slot, type: slot.type, optional: false, envPrefix: null, state: slot.state, attached: slot.attached, expectedKeys: [], presentKeys: [], options: slot.options }
}

/** Who needs a skill slot, in one line. */
function neededBy(slot: CredentialSetupSkillSlot): string {
  const names = slot.skills.join(', ')
  return `Needed by ${slot.skills.length === 1 ? 'skill' : 'skills'} ${names} · ${slot.type}`
}

/** Why nothing is offered for a missing skill slot, in one line. */
function skillSlotNote(slot: CredentialSetupSkillSlot): string {
  if (slot.typeMismatch) return `${slot.typeMismatch.name} has this Service URI but is a ${slot.typeMismatch.type} credential, not ${slot.type}.`
  if (slot.provision === 'not_allowed_locally') return 'The publisher provides it, but not for use on this computer.'
  if (slot.provision === 'not_shareable') return 'The publisher provides it, but cannot share it with you.'
  return `Nothing in your account fits it: it needs a credential of type ${slot.type} whose Service URI is ${slot.slot}.`
}

/** The `.env` names a slot shows rows for: none once an attachment satisfies it, or when it declares no `fields`. */
function keysOf(slot: CredentialSetupSlot): string[] {
  return slot.state === 'connected' ? [] : slot.expectedKeys
}

function nonEmpty(drafts: Record<string, string>, keys: readonly string[]): Record<string, string> {
  return Object.fromEntries(keys.filter((key) => (drafts[key] ?? '').trim() !== '').map((key) => [key, drafts[key]]))
}

export interface FinishSetup {
  /** Open the dialog for the page's agent. */
  open: () => void
  /** Rendered by the page in both modes (it portals). */
  dialog: ReactNode
}

/**
 * The dialog and its two writes, owned by the agent page so a mode switch
 * neither closes it nor drops a write's result (ux_rules rule 5). Shown while
 * the user opened it or a team library action asked for it (see
 * `finishSetup.store`), until it is closed.
 */
export function useFinishSetup(agentId: string | null, agentName: string): FinishSetup {
  const queryClient = useQueryClient()
  const [openedHere, setOpenedHere] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** What Open credentials/.env did, when it says more than "opened": shown where an error would be. */
  const [notice, setNotice] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  /** Done is saving what was typed; it closes when that lands. */
  const [finishing, setFinishing] = useState(false)
  const requested = useFinishSetupStore((s) => agentId !== null && s.pending.includes(agentId))
  const autoAttached = useFinishSetupStore((s) => (agentId ? s.autoAttached[agentId] : undefined))

  // A dialog opened by hand, and anything typed into it, belongs to the agent it was opened for.
  useEffect(() => {
    setOpenedHere(false)
    setError(null)
    setNotice(null)
    setDrafts({})
    setFinishing(false)
  }, [agentId])

  const refresh = (id: string): Promise<unknown> =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['service-credentials'] }),
      queryClient.invalidateQueries({ queryKey: localAgentKey(id) }),
      queryClient.invalidateQueries({ queryKey: LOCAL_AGENTS_KEY })
    ])
  const attach = useMutation({
    mutationFn: async ({ id, option }: { id: string; option: CredentialSetupOption }) =>
      credentialResult(await window.api.serviceCredentials.attach(id, option.group, option.ref)),
    onSuccess: (_result, { id }) => refresh(id)
  })
  const save = useMutation({
    mutationFn: async ({ id, values }: { id: string; values: Record<string, string> }) =>
      unwrapLocalAgentOutcome(await window.api.localAgents.setEnvValues(id, values)),
    onSuccess: async (_result, { id, values }) => {
      setDrafts((current) => Object.fromEntries(Object.entries(current).filter(([key]) => !(key in values))))
      await refresh(id)
    }
  })
  // `useOpenAgentCredentials`'s call, owned here so its result lands in this dialog's footer line.
  const openEnv = useMutation({ mutationFn: (id: string) => window.api.localAgents.openCredentials(id) })
  /**
   * Opening the dialog asks main to fill the skill slots one record fits (after `provision-local`).
   * Owned here, so its answer lands even if the dialog closed meanwhile; once per opening.
   */
  const skills = useMutation({
    mutationFn: async (id: string) => credentialResult(await window.api.serviceCredentials.setupSkills(id)),
    onSuccess: async (items, id) => {
      useFinishSetupStore.getState().remember(id, items)
      if (items.length > 0) await refresh(id)
    }
  })
  const shown = agentId !== null && (openedHere || requested)
  const askedFor = useRef<string | null>(null)
  useEffect(() => {
    if (!shown) {
      askedFor.current = null
      return
    }
    if (askedFor.current === agentId) return
    askedFor.current = agentId
    // Best effort: nothing to report when it fails; the rows still offer what fits.
    skills.mutate(agentId, { onError: () => undefined })
    // `skills.mutate` is stable enough for this; only the opening decides.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown, agentId])
  const busy = attach.isPending || save.isPending
  const unsaved = Object.values(drafts).some((value) => value !== '')

  const close = (): void => {
    if (agentId) useFinishSetupStore.getState().clear(agentId)
    setOpenedHere(false)
    setError(null)
    setNotice(null)
    setDrafts({})
    setFinishing(false)
  }
  const report = (next: string | null, nextNotice: string | null = null): void => {
    setError(next)
    setNotice(nextNotice)
  }

  const dialog =
    agentId && (openedHere || requested) ? (
      <FinishSetupDialog
        agentId={agentId}
        name={agentName}
        autoAttached={autoAttached ?? []}
        drafts={drafts}
        onDraft={(key, value) => setDrafts((current) => ({ ...current, [key]: value }))}
        error={error}
        notice={notice}
        busy={busy}
        unsaved={unsaved}
        attachingRef={attach.isPending ? attach.variables?.option.ref ?? null : null}
        savingKeys={save.isPending && !finishing ? Object.keys(save.variables?.values ?? {}) : []}
        finishing={save.isPending && finishing}
        onUse={(option) => {
          if (busy) return
          report(null)
          attach.mutate({ id: agentId, option }, { onError: (err) => report(unwrapIpcError(err)) })
        }}
        opening={openEnv.isPending}
        onOpenEnv={() => {
          if (openEnv.isPending) return
          report(null)
          openEnv.mutate(agentId, {
            onSuccess: (result) =>
              report(null, result.revealed ? 'Nothing here opens .env, so credentials/.env was shown in the file manager.' : null),
            onError: (err) => report(unwrapIpcError(err, 'credentials/.env could not be opened.'))
          })
        }}
        onSave={(keys, onSaved) => {
          const values = nonEmpty(drafts, keys)
          if (busy || Object.keys(values).length === 0) return
          report(null)
          save.mutate({ id: agentId, values }, { onSuccess: onSaved, onError: (err) => report(unwrapIpcError(err)) })
        }}
        onDone={(keys) => {
          if (busy) return
          // What was typed and not yet saved is saved first; a refusal keeps the dialog open.
          const values = nonEmpty(drafts, keys)
          if (Object.keys(values).length === 0) {
            close()
            return
          }
          report(null)
          setFinishing(true)
          save.mutate(
            { id: agentId, values },
            {
              onSuccess: close,
              onError: (err) => {
                setFinishing(false)
                report(unwrapIpcError(err))
              }
            }
          )
        }}
        onLater={close}
      />
    ) : null

  return {
    open: () => {
      report(null)
      setOpenedHere(true)
    },
    dialog
  }
}

function StatusMark({ status }: { status: FinishSetupStatus }): React.JSX.Element {
  const ok = status === 'Connected automatically' || status === 'Connected' || status === 'Set on this computer'
  const Icon = ok ? CheckCircle2 : status === 'Missing' ? AlertTriangle : Circle
  const tone = ok
    ? 'text-[var(--color-severity-ok-text)]'
    : status === 'Missing'
      ? 'text-[var(--color-severity-warning-text)]'
      : 'text-[var(--color-text-muted)]'
  return (
    <span className={`flex shrink-0 items-center gap-1 text-[11px] ${tone}`}>
      <Icon size={12} aria-hidden="true" />
      {status}
    </span>
  )
}

export function FinishSetupDialog({
  agentId,
  name,
  autoAttached,
  drafts,
  onDraft,
  error,
  notice,
  busy,
  unsaved,
  attachingRef,
  savingKeys,
  finishing,
  opening,
  onUse,
  onOpenEnv,
  onSave,
  onDone,
  onLater
}: {
  agentId: string
  name: string
  autoAttached: readonly string[]
  drafts: Record<string, string>
  onDraft: (key: string, value: string) => void
  error: string | null
  /** A note that is not an error (Open credentials/.env revealed the file instead). */
  notice: string | null
  busy: boolean
  /** Something typed is not saved: the backdrop and Escape then close nothing. */
  unsaved: boolean
  attachingRef: string | null
  savingKeys: readonly string[]
  /** Done is saving what was typed before it closes. */
  finishing: boolean
  /** Open credentials/.env is running. */
  opening: boolean
  onUse: (option: CredentialSetupOption) => void
  onOpenEnv: () => void
  onSave: (keys: string[], onSaved: () => void) => void
  onDone: (keys: string[]) => void
  onLater: () => void
}): React.JSX.Element {
  const laterRef = useRef<HTMLButtonElement>(null)
  const setup = useCredentialSetup(agentId)
  const slots = setup.data?.slots ?? []
  const skillSlots = setup.data?.skillSlots ?? []
  const allKeys = slots.flatMap(keysOf)
  const shownError = error ?? (setup.error ? unwrapIpcError(setup.error) : null)

  return (
    <DialogShell
      title={`Finish setting up ${name}`}
      pending={busy}
      onDismiss={unsaved ? () => undefined : onLater}
      initialFocusRef={laterRef}
      width="w-[36rem]"
      align="top"
    >
      <p className="text-[11px] leading-relaxed text-[var(--color-text-secondary)]">
        Credentials never travel with a shared agent. Connect each one here to run it on this computer.
      </p>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto">
        {setup.isLoading && (
          <div className="flex h-5 items-center gap-1.5 text-[11px] text-[var(--color-text-muted)]">
            <Loader2 size={12} className="animate-spin" aria-hidden="true" />
            Reading this agent’s credentials…
          </div>
        )}
        {slots.map((slot) => (
          <SlotRow
            key={slot.name}
            slot={slot}
            status={finishSetupStatus(slot, autoAttached)}
            drafts={drafts}
            onDraft={onDraft}
            busy={busy}
            attachingRef={attachingRef}
            saving={savingKeys.some((key) => slot.expectedKeys.includes(key))}
            onUse={onUse}
            opening={opening}
            onOpenEnv={onOpenEnv}
            onSave={onSave}
          />
        ))}
        {skillSlots.length > 0 && (
          <div className="space-y-2 pt-1">
            <div className="text-[11px] leading-relaxed text-[var(--color-text-secondary)]">
              <span className="font-medium text-[var(--color-text)]">Skills</span> find these by Service URI. A missing one does not stop the agent; the skill fails when it needs it.
            </div>
            {skillSlots.map((skillSlot) => (
              <SlotRow
                key={`${skillSlot.type}:${skillSlot.slot}`}
                testId={`finish-setup-skill-slot-${skillSlot.slot}`}
                detail={neededBy(skillSlot)}
                emptyNote={skillSlotNote(skillSlot)}
                slot={asSlotRow(skillSlot)}
                status={skillSlotStatus(skillSlot, autoAttached)}
                drafts={drafts}
                onDraft={onDraft}
                busy={busy}
                attachingRef={attachingRef}
                saving={false}
                onUse={onUse}
                opening={opening}
                onOpenEnv={onOpenEnv}
                onSave={onSave}
              />
            ))}
          </div>
        )}
      </div>
      {/* Two lines are reserved beside the buttons, so a refusal never grows the dialog or moves them. */}
      <div className="flex h-9 shrink-0 items-center gap-3">
        <div className="min-w-0 flex-1">
          {shownError ? (
            <p role="alert" title={shownError} className="line-clamp-2 text-[11px] leading-[1.125rem] text-[var(--color-danger)]">
              {shownError}
            </p>
          ) : notice ? (
            <p role="status" title={notice} className="line-clamp-2 text-[11px] leading-[1.125rem] text-[var(--color-text-secondary)]">
              {notice}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 gap-2">
          <button ref={laterRef} type="button" className={CANCEL} disabled={busy} onClick={onLater}>
            Finish later
          </button>
          <button type="button" className={PRIMARY} disabled={busy} onClick={() => onDone(allKeys)}>
            {finishing ? <Loader2 size={13} className="animate-spin" aria-label="Saving" /> : 'Done'}
          </button>
        </div>
      </div>
    </DialogShell>
  )
}

/**
 * A `.env` name with its field part legible: the prefix is dimmed and gives
 * way first, so `ACME_PORTAL_LOGIN` and `ACME_PORTAL_PASSWORD` stay apart at
 * the narrowest window. The full name is the tooltip.
 */
function KeyName({ name, prefix }: { name: string; prefix: string | null }): React.JSX.Element {
  const split = prefix && name.startsWith(prefix) && name.length > prefix.length
  return (
    <span className="flex w-44 shrink-0 font-mono text-[11px]" title={name}>
      {split ? (
        <>
          <span className="min-w-0 truncate text-[var(--color-text-muted)]">{prefix}</span>
          <span className="shrink-0 text-[var(--color-text)]">{name.slice(prefix.length)}</span>
        </>
      ) : (
        <span className="min-w-0 truncate text-[var(--color-text)]">{name}</span>
      )}
    </span>
  )
}

function SlotRow({
  slot,
  testId,
  detail,
  emptyNote,
  status,
  drafts,
  onDraft,
  busy,
  attachingRef,
  saving,
  onUse,
  opening,
  onOpenEnv,
  onSave
}: {
  slot: CredentialSetupSlot
  /** Defaults to `finish-setup-slot-<name>`. */
  testId?: string
  /** One line under the name (a skill slot's "Needed by …"). */
  detail?: string
  /** What a missing slot with nothing to offer says; defaults to the agent slot's sentence. */
  emptyNote?: string
  status: FinishSetupStatus
  drafts: Record<string, string>
  onDraft: (key: string, value: string) => void
  busy: boolean
  attachingRef: string | null
  saving: boolean
  onUse: (option: CredentialSetupOption) => void
  opening: boolean
  onOpenEnv: () => void
  onSave: (keys: string[], onSaved: () => void) => void
}): React.JSX.Element {
  const rowRef = useRef<HTMLDivElement>(null)
  const keys = keysOf(slot)
  /** No `fields`: the kit reads any `<prefix><FIELD>`, so there is no name to ask for. */
  const fieldless = slot.state !== 'connected' && slot.expectedKeys.length === 0 && slot.envPrefix !== null
  /** Set names the user chose to replace: they show a field again until saved or cancelled. */
  const [replacing, setReplacing] = useState<string[]>([])
  /**
   * Bumped once a save has landed and the slot was read again: focus then
   * stays in this row — its next empty field, else its first Replace.
   */
  const [saved, setSaved] = useState(0)
  /** Where focus goes once the element it names mounts: a Replace's field, or a Cancel's Replace. */
  const focusNext = useRef<string | null>(null)
  const focusOnMount = (id: string) => (el: HTMLElement | null): void => {
    if (el && focusNext.current === id) {
      focusNext.current = null
      el.focus()
    }
  }
  const editable = keys.filter((key) => !slot.presentKeys.includes(key) || replacing.includes(key))
  const canSave = editable.some((key) => (drafts[key] ?? '').trim() !== '')

  useEffect(() => {
    if (saved === 0 || !rowRef.current) return
    const empty = [...rowRef.current.querySelectorAll<HTMLInputElement>('input[type="password"]')].find((input) => input.value === '')
    ;(empty ?? rowRef.current.querySelector<HTMLElement>('[data-replace]'))?.focus()
  }, [saved])

  const save = (): void =>
    onSave(editable, () => {
      setReplacing([])
      setSaved((count) => count + 1)
    })
  const replace = (key: string): void => {
    focusNext.current = `field:${key}`
    setReplacing((current) => [...current, key])
  }
  const cancel = (key: string): void => {
    focusNext.current = `replace:${key}`
    onDraft(key, '')
    setReplacing((current) => current.filter((k) => k !== key))
  }

  return (
    <div
      ref={rowRef}
      data-testid={testId ?? `finish-setup-slot-${slot.name}`}
      className="space-y-1.5 rounded-md border border-[var(--color-border)] px-3 py-2"
    >
      <div className="flex h-5 items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-[var(--color-text)]" title={slot.name}>
          {slot.name}
        </span>
        <StatusMark status={status} />
      </div>
      {detail && (
        <div className="h-4 truncate text-[11px] leading-4 text-[var(--color-text-muted)]" title={detail}>
          {detail}
        </div>
      )}

      {slot.attached && (
        <CredentialRow
          compact
          name={slot.attached.credential.name}
          type={slot.attached.credential.type}
          serviceUri={slot.attached.credential.serviceUri}
          health={credentialHealth(slot.attached.credential, slot.attached.state)}
          ownership={credentialOwnership(slot.attached.credential)}
        />
      )}

      {slot.options.map((option) => (
        <CredentialRow
          compact
          key={`${option.group}:${option.ref}`}
          name={option.credential.name}
          type={option.credential.type}
          serviceUri={option.credential.serviceUri}
          health={credentialHealth(option.credential)}
          ownership={credentialOwnership(option.credential)}
          actions={
            <button
              type="button"
              className={`${SECONDARY} min-w-[5rem] !py-1`}
              title={`Use ${option.credential.name}`}
              aria-disabled={busy}
              onClick={() => onUse(option)}
            >
              {attachingRef === option.ref ? (
                <Loader2 size={12} className="animate-spin" aria-label="Connecting" />
              ) : (
                'Use this'
              )}
            </button>
          }
        />
      ))}

      {(keys.length > 0 || fieldless) && slot.options.length > 0 && (
        <div className="h-5 text-[11px] leading-5 text-[var(--color-text-muted)]">or enter it on this computer</div>
      )}

      {keys.length > 0 && (
        <>
          {keys.map((key) =>
            editable.includes(key) ? (
              <div key={key} className="flex h-8 items-center gap-2">
                <label className="flex min-w-0 flex-1 items-center gap-2">
                  <KeyName name={key} prefix={slot.envPrefix} />
                  <input
                    ref={focusOnMount(`field:${key}`)}
                    type="password"
                    aria-label={key}
                    autoComplete="off"
                    spellCheck={false}
                    value={drafts[key] ?? ''}
                    // Read-only, not disabled, while a write runs: a disabled field drops focus to the page.
                    readOnly={busy}
                    onChange={(event) => onDraft(key, event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && canSave) save()
                    }}
                    className={`min-w-0 flex-1 ${FIELD_BASE} !py-1`}
                  />
                </label>
                {replacing.includes(key) && slot.presentKeys.includes(key) && (
                  <button
                    type="button"
                    className={`${CANCEL} min-w-[5rem] !py-1`}
                    title={`Keep the saved ${key}`}
                    aria-disabled={busy}
                    onClick={() => {
                      if (!busy) cancel(key)
                    }}
                  >
                    Cancel
                  </button>
                )}
              </div>
            ) : (
              <div key={key} className="flex h-8 items-center gap-2">
                <KeyName name={key} prefix={slot.envPrefix} />
                <span className="flex min-w-0 flex-1 items-center gap-1 text-[11px] text-[var(--color-text-secondary)]">
                  <CheckCircle2 size={12} aria-hidden="true" className="text-[var(--color-severity-ok-text)]" />
                  Set
                </span>
                <button
                  ref={focusOnMount(`replace:${key}`)}
                  type="button"
                  data-replace
                  className={`${SECONDARY} min-w-[5rem] !py-1`}
                  title={`Replace ${key}`}
                  onClick={() => replace(key)}
                >
                  Replace
                </button>
              </div>
            )
          )}
          {/* Only while a name is editable; it comes and goes with Replace, Cancel and a save, never with typing. */}
          {editable.length > 0 && (
            <div className="flex justify-end">
              <button
                type="button"
                className={`${SECONDARY} min-w-[5rem] !py-1`}
                disabled={!canSave}
                aria-disabled={busy}
                onClick={() => {
                  if (!busy) save()
                }}
              >
                {saving ? <Loader2 size={12} className="animate-spin" aria-label="Saving" /> : 'Save'}
              </button>
            </div>
          )}
        </>
      )}

      {fieldless && (
        <div className="flex h-8 items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--color-text-secondary)]" title={`${slot.envPrefix}<FIELD>`}>
            Set <code className="font-mono">{slot.envPrefix}…</code> names in credentials/.env
          </span>
          <button
            type="button"
            className={`${SECONDARY} !py-1`}
            aria-disabled={opening}
            onClick={onOpenEnv}
          >
            Open credentials/.env
          </button>
        </div>
      )}

      {slot.state === 'missing' && !slot.attached && slot.options.length === 0 && keys.length === 0 && !fieldless && (
        <div className="h-5 truncate text-[11px] leading-5 text-[var(--color-text-muted)]" title={emptyNote}>
          {emptyNote ?? 'Nothing in your account fits it. Attach one on the Credentials tab.'}
        </div>
      )}
    </div>
  )
}
