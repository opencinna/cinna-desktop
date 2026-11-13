import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, CheckCircle2, Circle, Loader2 } from 'lucide-react'
import type { CredentialSetupOption, CredentialSetupSkillSlot, CredentialSetupSlot, ServiceCredentialDto, SlotOAuthAction } from '../../../../../shared/serviceCredentials'
import { unwrapLocalAgentOutcome } from '../../../../../shared/localAgents'
import { credentialResult, useCredentialSetup } from '../../../hooks/useServiceCredentials'
import { useSlotAuthorize, type SlotAuthorizeState } from '../../../hooks/useSlotAuthorize'
import { LOCAL_AGENTS_KEY, localAgentKey } from '../../../hooks/useLocalAgents'
import { autoAttachedKey, useFinishSetupStore } from '../../../stores/finishSetup.store'
import { unwrapIpcError } from '../../../utils/ipcError'
import { CredentialRow } from '../../settings/CredentialRow'
import { credentialHealth, credentialOwnership } from '../../settings/credentialPresentation'
import { CANCEL, DIALOG_TEXT, DialogFooter, DialogShell, FIELD_BASE, PRIMARY, SECONDARY } from './sharing/ShareDialogs'

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
 *
 * A missing Google OAuth slot (agent or skill) ends in an authorize line of
 * its own, one height in every state: Authorize (or Reconnect) starts main's
 * `authorizeSlot`, the line then waits for the browser with Reopen browser and
 * Cancel, and a failure's reason goes under it, last in the card. The slot
 * turns Connected through the scan once main attached the record; the dialog
 * stays open.
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
  return { name: slot.slot, type: slot.type, optional: false, envPrefix: null, state: slot.state, attached: slot.attached, expectedKeys: [], presentKeys: [], options: slot.options, notReady: slot.notReady, oauth: slot.oauth }
}

/** A not-ready record that fits a Google slot and that only its owner can reconnect: its note stays beside Authorize. */
function sharedNotReadyNote(dto: ServiceCredentialDto | null): string | null {
  return dto && dto.relation === 'shared' ? notReadyNote(dto) : null
}

/** What an agent slot's row says when nothing usable is offered; null when Authorize says it instead. */
function agentSlotNote(slot: CredentialSetupSlot): string | null | undefined {
  return slot.oauth ? sharedNotReadyNote(slot.notReady) : notReadyNote(slot.notReady) ?? undefined
}

/** Who needs a skill slot, in one line. */
function neededBy(slot: CredentialSetupSkillSlot): string {
  const names = slot.skills.join(', ')
  return `Needed by ${slot.skills.length === 1 ? 'skill' : 'skills'} ${names} · ${slot.type}`
}

/**
 * A record that fits the slot but would not be ready once attached, so it is not offered: why, in
 * one line. Null when there is none.
 */
export function notReadyNote(dto: ServiceCredentialDto | null): string | null {
  if (!dto) return null
  if (dto.oauthStatus === 'pending_authorization' || dto.oauthStatus === 'reauth_required') return `${dto.name} fits it, but its Google access has to be reconnected first.`
  if (dto.keyBlocked) return `${dto.name} fits it, but this computer refused its address as unsafe.`
  return dto.origin === 'local'
    ? `${dto.name} fits it, but some of its values are missing. Fill them in Settings → Credentials.`
    : `${dto.name} fits it, but some of its values are missing. Fill them in on Cinna.`
}

/**
 * Why nothing is offered for a missing skill slot, in one line. Beside Authorize only what it does not
 * answer: a record of another type, what the publisher said, a record kept off this computer, a shared
 * record whose owner must reconnect it; null otherwise.
 */
function skillSlotNote(slot: CredentialSetupSkillSlot): string | null {
  if (slot.typeMismatch) return `${slot.typeMismatch.name} has this Service URI but is a ${slot.typeMismatch.type} credential, not ${slot.type}.`
  if (slot.provision === 'not_allowed_locally') return 'The publisher provides it, but not for use on this computer.'
  if (slot.provision === 'not_shareable') return 'The publisher provides it, but cannot share it with you.'
  if (slot.notLocal) {
    const owner = slot.notLocal.ownerEmail
    return owner
      ? `${slot.notLocal.name} is shared with you, but not for use on this computer. ${owner} can turn on Allow local use.`
      : `${slot.notLocal.name} is shared with you, but not for use on this computer.`
  }
  if (slot.oauth) return sharedNotReadyNote(slot.notReady)
  return notReadyNote(slot.notReady) ?? `None of your credentials fits it: it needs a credential of type ${slot.type} whose Service URI is ${slot.slot}.`
}

/** An offered record by its group and ref: a local record's id and Core's id share no namespace. */
function optionKey(option: CredentialSetupOption): string {
  return `${option.group}:${option.ref}`
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

export interface FinishSetupOptions {
  /**
   * Whether a team library action's request (`finishSetup.store`'s `pending`)
   * opens this instance too. On by default: the agent page answers those. A
   * second surface for the same agent (the composer's notice panel) turns it
   * off, so one request does not open two dialogs; it opens only when clicked.
   */
  followRequests?: boolean
}

/**
 * The dialog and its two writes, owned by the agent page so a mode switch
 * neither closes it nor drops a write's result (ux_rules rule 5). Shown while
 * the user opened it or a team library action asked for it (see
 * `finishSetup.store`), until it is closed.
 */
export function useFinishSetup(agentId: string | null, agentName: string, options: FinishSetupOptions = {}): FinishSetup {
  const followRequests = options.followRequests ?? true
  const queryClient = useQueryClient()
  const [openedHere, setOpenedHere] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** What Open credentials/.env did, when it says more than "opened": shown where an error would be. */
  const [notice, setNotice] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  /** Done is saving what was typed; it closes when that lands. */
  const [finishing, setFinishing] = useState(false)
  const requested = useFinishSetupStore((s) => followRequests && agentId !== null && s.pending.includes(agentId))
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
    // A request is the page's to answer; an instance that does not follow them leaves it alone.
    if (agentId && followRequests) useFinishSetupStore.getState().clear(agentId)
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
        attachingKey={attach.isPending && attach.variables ? optionKey(attach.variables.option) : null}
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
    <span className={`flex shrink-0 items-center gap-1 text-[13px] ${tone}`}>
      <Icon size={14} aria-hidden="true" />
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
  attachingKey,
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
  attachingKey: string | null
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
  const google = useSlotAuthorize(agentId)
  const oauthAccount = setup.data?.oauthAccount ?? false
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
      <p className={DIALOG_TEXT}>
        Credentials never travel with a shared agent. Connect each one here to run it on this computer.
      </p>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto">
        {setup.isLoading && (
          <div className="flex h-[1lh] items-center gap-1.5 text-[13px] text-[var(--color-text-muted)]">
            <Loader2 size={13} className="animate-spin" aria-hidden="true" />
            Reading this agent’s credentials…
          </div>
        )}
        {slots.map((slot) => (
          <SlotRow
            key={slot.name}
            slot={slot}
            emptyNote={agentSlotNote(slot)}
            authorize={slot.oauth ? { action: slot.oauth, account: oauthAccount, state: google.stateOf(slot.name),
              onAuthorize: () => google.authorize(slot.name), onReopen: () => google.reopen(slot.name), onCancel: () => google.cancel(slot.name) } : null}
            status={finishSetupStatus(slot, autoAttached)}
            drafts={drafts}
            onDraft={onDraft}
            busy={busy}
            attachingKey={attachingKey}
            saving={savingKeys.some((key) => slot.expectedKeys.includes(key))}
            onUse={onUse}
            opening={opening}
            onOpenEnv={onOpenEnv}
            onSave={onSave}
          />
        ))}
        {skillSlots.length > 0 && (
          <div className="space-y-2 pt-1">
            <div className={DIALOG_TEXT}>
              <span className="font-medium text-[var(--color-text)]">Skills</span> find these by Service URI. A missing one does not stop the agent; the skill fails when it needs it.
            </div>
            {skillSlots.map((skillSlot) => (
              <SlotRow
                key={`${skillSlot.type}:${skillSlot.slot}`}
                testId={`finish-setup-skill-slot-${skillSlot.slot}`}
                detail={neededBy(skillSlot)}
                emptyNote={skillSlotNote(skillSlot)}
                slot={asSlotRow(skillSlot)}
                authorize={skillSlot.oauth ? { action: skillSlot.oauth, account: oauthAccount, state: google.stateOf(`skill:${skillSlot.slot}`),
                  onAuthorize: () => google.authorize(`skill:${skillSlot.slot}`), onReopen: () => google.reopen(`skill:${skillSlot.slot}`), onCancel: () => google.cancel(`skill:${skillSlot.slot}`) } : null}
                status={skillSlotStatus(skillSlot, autoAttached)}
                drafts={drafts}
                onDraft={onDraft}
                busy={busy}
                attachingKey={attachingKey}
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
      {/* The shared footer: a refusal or notice goes under the buttons, and the scrolling list above gives up the room. */}
      <DialogFooter error={shownError} notice={notice}>
        <button ref={laterRef} type="button" className={CANCEL} disabled={busy} onClick={onLater}>
          Finish later
        </button>
        <button type="button" className={PRIMARY} disabled={busy} onClick={() => onDone(allKeys)}>
          {finishing ? <Loader2 size={14} className="animate-spin" aria-label="Saving" /> : 'Done'}
        </button>
      </DialogFooter>
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
    <span className="flex w-48 shrink-0 font-mono text-[12px]" title={name}>
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

/** A missing Google OAuth slot's authorize line, as the dialog wires it. */
interface AuthorizeProps {
  action: SlotOAuthAction
  /** The active profile has a Cinna account to create the record in. */
  account: boolean
  state: SlotAuthorizeState
  onAuthorize: () => void
  onReopen: () => void
  onCancel: () => void
}

/**
 * The authorize line's height: a `CredentialRow`'s, which is what replaces it when the slot turns
 * Connected in place — its `py-2.5`, one 14px line at the body's 1.5 leading, and its 1px borders —
 * so the card keeps its height through the change (rule 1). Set at 14px so `1.5em` is that line.
 */
const AUTHORIZE_LINE = 'flex h-[calc(1.25rem+1.5em+2px)] items-center gap-2 text-[14px]'
const BLOCKED = 'Finish the other Google sign-in first.'

/**
 * One line, one height in every state, so the row never changes height while the sign-in runs (rule 1):
 * Authorize (Reconnect for an expired grant), then the wait for the browser, then Authorize again. Always
 * secondary: Done is the dialog's one primary. While waiting, Cancel sits left of Reopen browser, so the
 * Authorize that follows a Cancel lands where Reopen browser was and a double click on Cancel restarts nothing.
 */
function AuthorizeLine({ authorize, offered }: { authorize: AuthorizeProps; offered: boolean }): React.JSX.Element {
  const { action, account, state } = authorize
  const label = action === 'reconnect' ? 'Reconnect' : 'Authorize'
  if (!account) {
    return (
      <div data-testid="authorize-line" className={`${AUTHORIZE_LINE} text-[var(--color-text-muted)]`}>
        <span className="text-[13px]">Sign in to Cinna to authorize it.</span>
      </div>
    )
  }
  if (state.phase === 'waiting') {
    return (
      <div data-testid="authorize-line" className={AUTHORIZE_LINE}>
        <span className="flex min-w-0 flex-1 items-center gap-1.5 text-[13px] text-[var(--color-text-secondary)]">
          <Loader2 size={13} className="shrink-0 animate-spin" aria-hidden="true" />
          <span className="truncate">Finish in your browser…</span>
        </span>
        <button type="button" className={`${CANCEL} !py-1`} onClick={authorize.onCancel}>Cancel</button>
        <button type="button" className={`${SECONDARY} !py-1`} onClick={authorize.onReopen}>Reopen browser</button>
      </div>
    )
  }
  const blocked = state.phase === 'blocked'
  const sentence = blocked ? BLOCKED : offered ? 'or connect another Google account'
    : action === 'reconnect' ? 'Its Google access expired. Sign in again to reconnect it.' : 'Sign in with Google to connect it.'
  return (
    <div data-testid="authorize-line" className={AUTHORIZE_LINE}>
      <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--color-text-muted)]" title={sentence}>{sentence}</span>
      <button
        type="button"
        className={`${SECONDARY} min-w-[5.5rem] !py-1 ${blocked ? 'cursor-not-allowed opacity-50' : ''}`}
        aria-disabled={blocked || state.phase === 'starting' || undefined}
        title={blocked ? BLOCKED : undefined}
        onClick={() => {
          if (!blocked && state.phase !== 'starting') authorize.onAuthorize()
        }}
      >
        {state.phase === 'starting' ? <Loader2 size={13} className="animate-spin" aria-label="Opening the browser" /> : label}
      </button>
    </div>
  )
}

function SlotRow({
  slot,
  testId,
  detail,
  emptyNote,
  authorize = null,
  status,
  drafts,
  onDraft,
  busy,
  attachingKey,
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
  /** What a missing slot with nothing to offer says; defaults to the agent slot's sentence, and null says nothing. */
  emptyNote?: string | null
  /** A missing Google OAuth slot's authorize line; null for any other slot. */
  authorize?: AuthorizeProps | null
  status: FinishSetupStatus
  drafts: Record<string, string>
  onDraft: (key: string, value: string) => void
  busy: boolean
  attachingKey: string | null
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
      <div className="flex h-6 items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-[var(--color-text)]" title={slot.name}>
          {slot.name}
        </span>
        <StatusMark status={status} />
      </div>
      {detail && (
        <div className="h-5 truncate text-[13px] leading-5 text-[var(--color-text-muted)]" title={detail}>
          {detail}
        </div>
      )}

      {slot.attached && (
        <CredentialRow
          name={slot.attached.credential.name}
          type={slot.attached.credential.type}
          serviceUri={slot.attached.credential.serviceUri}
          health={credentialHealth(slot.attached.credential, slot.attached.state)}
          ownership={credentialOwnership(slot.attached.credential)}
        />
      )}

      {slot.options.map((option) => (
        <CredentialRow
          key={optionKey(option)}
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
              {attachingKey === optionKey(option) ? (
                <Loader2 size={13} className="animate-spin" aria-label="Connecting" />
              ) : (
                'Use this'
              )}
            </button>
          }
        />
      ))}

      {(keys.length > 0 || fieldless) && slot.options.length > 0 && (
        <div className="h-5 text-[13px] leading-5 text-[var(--color-text-muted)]">or enter it on this computer</div>
      )}

      {keys.length > 0 && (
        <>
          {keys.map((key) =>
            editable.includes(key) ? (
              <div key={key} className="flex h-9 items-center gap-2">
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
              <div key={key} className="flex h-9 items-center gap-2">
                <KeyName name={key} prefix={slot.envPrefix} />
                <span className="flex min-w-0 flex-1 items-center gap-1 text-[13px] text-[var(--color-text-secondary)]">
                  <CheckCircle2 size={14} aria-hidden="true" className="text-[var(--color-severity-ok-text)]" />
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
                {saving ? <Loader2 size={13} className="animate-spin" aria-label="Saving" /> : 'Save'}
              </button>
            </div>
          )}
        </>
      )}

      {fieldless && (
        <div className="flex h-9 items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--color-text-secondary)]" title={`${slot.envPrefix}<FIELD>`}>
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

      {slot.state === 'missing' && !slot.attached && slot.options.length === 0 && keys.length === 0 && !fieldless && emptyNote !== null && (
        <div className="h-5 truncate text-[13px] leading-5 text-[var(--color-text-muted)]" title={emptyNote}>
          {emptyNote ?? 'None of your credentials fits it. Attach one on the Credentials tab.'}
        </div>
      )}

      {authorize && slot.state === 'missing' && <AuthorizeLine authorize={authorize} offered={slot.options.length > 0} />}
      {/* Only when there is one, last in the card: it lengthens the card and moves nothing above it (rule 1). */}
      {authorize && slot.state === 'missing' && authorize.account && authorize.state.error && (
        <p role="alert" className="text-[13px] text-[var(--color-danger)]">{authorize.state.error}</p>
      )}
    </div>
  )
}
