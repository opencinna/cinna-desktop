import { useState, type ReactNode } from 'react'
import { ArrowLeftRight, KeyRound, Loader2, LogIn, Users } from 'lucide-react'
import { NoticeButton, StableLabel, type ComposerNotice } from './ComposerNoticePanel'
import { useAgentCredentialAccounts, useCredentialSetup } from '../../hooks/useServiceCredentials'
import { useCinnaReauth, useUsers } from '../../hooks/useAuth'
import { useSwitchProfile } from '../auth/useSwitchProfile'
import { useUIStore } from '../../stores/ui.store'
import { carryComposerDraft } from '../../stores/composerDraft.store'
import { unwrapIpcError } from '../../utils/ipcError'
import { accountReference, type AccountReference } from '../settings/credentialPresentation'
import { heldByUnavailableAccount, type LocalAgentDto } from '../../../../shared/localAgents'
import type { UnavailableAccountReason, UnavailableCredentialAccount } from '../../../../shared/serviceCredentials'

/**
 * One state — a Cinna account that cannot supply an agent's credentials now — told the same way on
 * every surface that meets it: the composer's row, the Finish setup slot, the agent's Credentials
 * tab and the Runs with summary. One reason-first label, the warning tone, and one action
 * ({@link UnavailableAccountButton}) wired by {@link useUnavailableAccountActions}.
 */

type Account = Pick<UnavailableCredentialAccount, 'name' | 'reason'>

/** The label when the account has a name: who (the first name, so the reason survives a narrow window), then why. */
const NAMED_LABEL: Record<UnavailableAccountReason, (name: string) => string> = {
  signed_out: (n) => `${n} is signed out`,
  locked: (n) => `${n} is locked`,
  session_expired: (n) => `${n}’s session expired`,
  removed: (n) => `${n} was removed`,
  other_profile: (n) => `${n} isn’t the current profile`,
  unknown: (n) => `${n} isn’t signed in here`
}

/** The label when nothing names the account. */
const UNNAMED_LABEL: Record<UnavailableAccountReason, string> = {
  signed_out: 'Account signed out',
  locked: 'Account locked',
  session_expired: 'Session expired',
  removed: 'Account removed',
  other_profile: 'Not the current profile',
  unknown: 'Account not signed in'
}

/** A sentence's subject when nothing names the account ("A removed account held 2 credentials."). */
const UNNAMED_SUBJECT: Record<UnavailableAccountReason, string> = {
  signed_out: 'A signed-out account holds',
  locked: 'A locked account holds',
  session_expired: 'An account whose session expired holds',
  removed: 'A removed account held',
  other_profile: 'Another profile holds',
  unknown: 'An account that isn’t signed in here holds'
}

/**
 * The state's one label, who by first name and then why: "Alice is signed out", "Alice’s session
 * expired", "Account removed" when nothing names it. Short, so the reason is what a narrow window
 * keeps; the whole account ("Name <email> host") goes in the title ({@link unavailableAccountTitle}).
 * The composer row opens with it, the Credentials tab's rows show it as their status, the Runs with
 * summary as its badge and status line.
 */
export function unavailableAccountLabel(account: Account): string {
  const first = accountFirstName(account)
  return first ? NAMED_LABEL[account.reason](first) : UNNAMED_LABEL[account.reason]
}

/** Only why, for a line whose neighbour already names the account (the Finish setup slot's status). */
const REASON_ONLY: Record<UnavailableAccountReason, string> = {
  signed_out: 'Signed out',
  locked: 'Locked',
  session_expired: 'Session expired',
  removed: 'Account removed',
  other_profile: 'Not the current profile',
  unknown: 'Not signed in here'
}

/** The reason alone: "Signed out", "Locked", "Session expired", "Account removed". */
export function unavailableAccountReason(account: Pick<UnavailableCredentialAccount, 'reason'>): string {
  return REASON_ONLY[account.reason]
}

/** The account's first name, for a button ("Switch to Alice"): the name's first word, an email's local part; null when unknown. */
export function accountFirstName(account: Pick<UnavailableCredentialAccount, 'name'>): string | null {
  const name = account.name?.trim()
  if (!name) return null
  if (!/\s/.test(name) && name.includes('@')) return name.slice(0, name.indexOf('@')) || name
  return name.split(/\s+/)[0]
}

/**
 * The account as the app names one, "Name <email> host" (ux_rules rule 13), the email dropped when it
 * would repeat the name; "a Cinna account" when no profile is known for it. For titles: a line on
 * screen names the account by its first name only.
 */
export function unavailableAccountName(account: Pick<UnavailableCredentialAccount, 'name' | 'email' | 'host'>): string {
  if (!account.name) return 'a Cinna account'
  return [account.name, account.email && account.email !== account.name ? `<${account.email}>` : null, account.host].filter(Boolean).join(' ')
}

/** A line's title: the line, then the whole account it names by first name ("… (Alice Smith <alice@corp.com> core.corp)"). */
export function unavailableAccountTitle(account: Pick<UnavailableCredentialAccount, 'name' | 'email' | 'host'>, text: string): string {
  return account.name ? `${text} (${unavailableAccountName(account)})` : text
}

/** What comes from the account, as a sentence's object: "2 credentials", "its AI credential", both. */
function heldWhat(account: Pick<UnavailableCredentialAccount, 'credentials' | 'aiCredential'>): { what: string; plural: boolean } {
  const n = account.credentials
  const credentials = n === 1 ? '1 credential' : `${n} credentials`
  if (n > 0 && account.aiCredential) return { what: `${credentials} and its AI credential`, plural: true }
  if (n > 0) return { what: credentials, plural: n !== 1 }
  return { what: 'its AI credential', plural: false }
}

/** The reason-first sentence about `what` (and whether it reads as plural). */
function reasonFirst(account: Account, what: string, plural: boolean): string {
  if (!account.name) return `${UNNAMED_SUBJECT[account.reason]} ${what}.`
  const verb = account.reason === 'removed' ? 'came' : plural ? 'come' : 'comes'
  return `${unavailableAccountLabel(account)}: ${what} ${verb} from that account.`
}

/**
 * One account's composer sentence, who and why first, then what comes from it (counts only, never
 * which credentials: an unavailable account's credential names stay hidden): "Alice is signed out:
 * 2 credentials come from that account."
 */
export function unavailableAccountSentence(account: UnavailableCredentialAccount): string {
  const { what, plural } = heldWhat(account)
  return reasonFirst(account, what, plural)
}

/** A Finish setup slot's sentence, about its one credential: "Alice is locked: its credential comes from that account." */
export function heldSlotSentence(account: UnavailableCredentialAccount | null): string {
  return account ? reasonFirst(account, 'its credential', false) : 'Its credential comes from a Cinna account that isn’t available right now.'
}

/**
 * The account's one action. The current profile whose session expired re-authenticates (re-auth only
 * ever runs on the active profile); a profile that is gone, or none known, opens Settings → User
 * Accounts; any other profile is switched to, which unlocks or signs it in on the way.
 */
export function unavailableAccountAction(account: Pick<UnavailableCredentialAccount, 'reason' | 'current' | 'userId'>): 'reauth' | 'switch' | 'accounts' {
  if (account.current && account.reason === 'session_expired') return 'reauth'
  if (account.reason === 'removed' || account.reason === 'unknown' || account.userId === null) return 'accounts'
  return 'switch'
}

/**
 * Why the account's last action did not happen, said in place of the sentence while it stands. Short,
 * so the cause is what a narrow window keeps: "Switch failed: <cause>", "Re-authentication failed:
 * <cause>". {@link accountFailureTitle} is the whole sentence.
 */
export function accountFailureSentence(account: UnavailableCredentialAccount, failure: string): string {
  const lead = unavailableAccountAction(account) === 'reauth' ? 'Re-authentication failed' : 'Switch failed'
  // A cause that is only the lead again (the re-auth fallback) is not said twice.
  return failure.trim().replace(/\.$/, '') === lead ? lead : `${lead}: ${failure}`
}

/** {@link accountFailureSentence} in full, for its title: whom it was for, then the cause. */
export function accountFailureTitle(account: UnavailableCredentialAccount, failure: string): string {
  const cause = failure.trim().replace(/\.$/, '')
  const action = unavailableAccountAction(account) === 'reauth'
    ? `Couldn’t sign in to ${unavailableAccountName(account)} again`
    : `Couldn’t switch to ${unavailableAccountName(account)}`
  return cause === 'Re-authentication failed' || cause === 'Switch failed' ? `${action}.` : `${action}: ${failure}`
}

/**
 * The account each held slot of a folder agent comes from, by slot name, for the lists that draw its
 * slots by name (the `credentials/.env` card, the Runs with "Secrets" strip). Main's setup answer
 * names it per slot; asked only while a slot is held, so an agent with none costs nothing. Null
 * until it answers, or for a slot it names no account for.
 */
export function useHeldSlotAccounts(agent: Pick<LocalAgentDto, 'id' | 'credentials'> | null): (slotName: string) => UnavailableCredentialAccount | null {
  const held = !!agent && agent.credentials.some(heldByUnavailableAccount)
  const { data } = useCredentialSetup(agent?.id ?? '', held, { listen: held })
  return (slotName) => (held ? data?.slots.find((slot) => slot.name === slotName && slot.state === 'account_unavailable')?.account ?? null : null)
}

/** A held slot's short label in such a list: the account's label ("Alice is signed out"), or "Account unavailable" before it is known. */
export function heldSlotLabel(account: UnavailableCredentialAccount | null): string {
  return account ? unavailableAccountLabel(account) : 'Account unavailable'
}

/** That label's title: the sentence, with the whole account. */
export function heldSlotTitle(account: UnavailableCredentialAccount | null): string {
  return account ? unavailableAccountTitle(account, heldSlotSentence(account)) : heldSlotSentence(null)
}

/** Settings → User Accounts, where profiles are added and signed in to. */
export function openUserAccounts(): void {
  const ui = useUIStore.getState()
  ui.setSettingsMenu('accounts')
  ui.setActiveView('settings')
}

/** The account in the standard "Name <email> host" form, when its profile's server is known. */
export function unavailableAccountReference(
  account: Pick<UnavailableCredentialAccount, 'name' | 'email' | 'userId'>,
  users: readonly { id: string; cinnaServerUrl?: string }[] | undefined
): AccountReference | null {
  const serverUrl = account.userId ? users?.find((u) => u.id === account.userId)?.cinnaServerUrl : undefined
  return account.name && serverUrl ? accountReference({ name: account.name, email: account.email, serverUrl }) : null
}

export interface AccountRowHandlers {
  switchTo: (account: UnavailableCredentialAccount) => void
  reauth: () => void
  openAccounts: () => void
  /** The account a switch is under way to, or null. */
  switching: string | null
  reauthPending: boolean
  /** Why the last action on this account did not happen, or null. */
  failure: (account: UnavailableCredentialAccount) => string | null
}

/** The props {@link UnavailableAccountButton} hands the surface's own button (NoticeButton, SettingsButton, the dialog's secondary). */
export interface AccountButtonProps {
  onClick: () => void
  title?: string
  'aria-disabled'?: boolean
  'aria-busy'?: boolean
  children: ReactNode
}

/**
 * The account's one action, the same on every surface: Re-authenticate, Switch to <first name>
 * (capped, the whole account in its title), or Open accounts. Its label never changes width while
 * it runs (ux_rules rule 1). Each surface passes its own button.
 */
export function UnavailableAccountButton({ account, actions, Button, iconSize = 12 }: {
  account: UnavailableCredentialAccount
  actions: AccountRowHandlers
  Button: (props: AccountButtonProps) => React.JSX.Element
  iconSize?: number
}): React.JSX.Element {
  const kind = unavailableAccountAction(account)
  if (kind === 'reauth') {
    const pending = actions.reauthPending
    return <Button aria-disabled={pending || undefined} aria-busy={pending} title={`Sign in to ${unavailableAccountName(account)} again`}
      onClick={() => { if (!pending) actions.reauth() }}>
      <StableLabel pending={pending} label={<><LogIn size={iconSize} aria-hidden="true" />Re-authenticate</>}
        pendingLabel={<><Loader2 size={iconSize} className="animate-spin" aria-hidden="true" />Signing in…</>} />
    </Button>
  }
  if (kind === 'accounts') {
    return <Button title="Settings → User Accounts" onClick={actions.openAccounts}>
      <span className="flex items-center gap-1"><Users size={iconSize} aria-hidden="true" />Open accounts</span>
    </Button>
  }
  const pending = actions.switching === account.key
  return <Button aria-disabled={pending || undefined} aria-busy={pending} title={`Switch to ${unavailableAccountName(account)}`}
    onClick={() => { if (!pending) actions.switchTo(account) }}>
    <StableLabel pending={pending}
      label={<><ArrowLeftRight size={iconSize} aria-hidden="true" />Switch to <span className="max-w-[5rem] truncate">{accountFirstName(account) ?? 'profile'}</span></>}
      pendingLabel={<><Loader2 size={iconSize} className="animate-spin" aria-hidden="true" />Switching…</>} />
  </Button>
}

/**
 * One unavailable account as a row of the composer's notice panel: a warning, never blocking Send
 * (as missing credentials do not), one line held one button tall with the action at its end
 * (ux_rules rules 19, 20). Who and why come first, so a narrow window cuts what comes from the
 * account, not the reason; the whole account is in the title. While an action's failure stands it
 * replaces the sentence (rules 6, 19), rather than trailing it past the cut.
 */
export function unavailableAccountNotice(account: UnavailableCredentialAccount, handlers: AccountRowHandlers): ComposerNotice {
  const failure = handlers.failure(account)
  const sentence = unavailableAccountSentence(account)
  const text = failure ? accountFailureSentence(account, failure) : sentence
  const title = failure ? accountFailureTitle(account, failure) : unavailableAccountTitle(account, sentence)
  return {
    key: `account:${account.key}`, tone: 'warning', icon: KeyRound, text, title, singleLine: true,
    action: <UnavailableAccountButton account={account} actions={handlers} Button={NoticeButton} />
  }
}

export interface UnavailableAccountActions {
  actions: AccountRowHandlers
  /** The password prompt a Switch opens; render it where the hook is owned (it portals). */
  prompt: ReactNode
  /** Forget the last action's failure (the surface closed, or turned to another agent). */
  dismissFailure: () => void
}

/**
 * Switch, Re-authenticate and Open accounts for the unavailable-account rows of one surface, owned by
 * a component that outlives the click so the password prompt and the answer are not dropped. A switch
 * that lands carries the message typed under `draftKey` (the composer's) to the profile switched to,
 * with `agentId` (the composer's folder agent) as the new-chat screen's agent pick; each action's
 * failure is kept for the account it was run for.
 */
export function useUnavailableAccountActions(options: { draftKey?: string | null; agentId?: string | null } = {}): UnavailableAccountActions {
  const { data: users } = useUsers()
  const switcher = useSwitchProfile()
  const reauth = useCinnaReauth()
  const [switchingTo, setSwitchingTo] = useState<string | null>(null)
  const [lastAction, setLastAction] = useState<{ key: string; kind: 'switch' | 'reauth' } | null>(null)
  const draftKey = options.draftKey ?? null
  const agentId = options.agentId ?? null
  const reauthFailure = reauth.error
    ? unwrapIpcError(reauth.error, 'Re-authentication failed')
    : reauth.data && !reauth.data.success ? (reauth.data.error ?? 'Re-authentication failed') : null
  const actions: AccountRowHandlers = {
    switchTo: (account) => {
      if (!account.userId || switchingTo) return
      const hasPassword = users?.find((u) => u.id === account.userId)?.hasPassword ?? true
      setSwitchingTo(account.key)
      setLastAction({ key: account.key, kind: 'switch' })
      void switcher.switchTo(account.userId, hasPassword, (userId) => {
        if (draftKey) carryComposerDraft(draftKey, userId, { agentIds: agentId ? [agentId] : undefined })
      })
        .finally(() => setSwitchingTo(null))
    },
    reauth: () => {
      if (reauth.isPending) return
      setLastAction({ key: 'reauth', kind: 'reauth' })
      reauth.mutate()
    },
    openAccounts: openUserAccounts,
    switching: switchingTo,
    reauthPending: reauth.isPending,
    failure: (account) => {
      const kind = unavailableAccountAction(account)
      if (kind === 'reauth') return lastAction?.kind === 'reauth' ? reauthFailure : null
      return kind === 'switch' && lastAction?.kind === 'switch' && lastAction.key === account.key ? switcher.error : null
    }
  }
  return { actions, prompt: switcher.prompt, dismissFailure: () => setLastAction(null) }
}

export interface AccountNotices {
  /** One row per unavailable account, once main has answered; none before. */
  rows: ComposerNotice[]
  /** Main has answered for this agent, or failed to (or there is no folder agent to ask about). */
  loaded: boolean
  /** Main's answer failed: nothing names an account, so the rows it would replace stand. */
  failed: boolean
  /** An account row already tells the agent's AI credential: the "No AI credential" row stays away. */
  aiCredentialCovered: boolean
  /** The password prompt a Switch opens; rendered by the composer (it portals). */
  prompt: ReactNode
}

/**
 * The composer's rows for the accounts a folder agent's credentials come from that cannot supply
 * them now, from main's one answer per agent. Shown only once it has loaded, so no row appears and
 * then goes (ux_rules rule 1). `draftKey` is the composer's draft, carried along by a Switch.
 */
export function useAccountNotices(folder: LocalAgentDto | null, draftKey: string | null = null): AccountNotices {
  const { data, isError } = useAgentCredentialAccounts(folder)
  const { actions, prompt } = useUnavailableAccountActions({ draftKey, agentId: folder?.id ?? null })
  const accounts = folder ? data?.accounts ?? [] : []
  return {
    rows: accounts.map((account) => unavailableAccountNotice(account, actions)),
    loaded: !folder || data !== undefined || isError,
    failed: !!folder && isError && data === undefined,
    aiCredentialCovered: accounts.some((account) => account.aiCredential),
    prompt
  }
}
