import { useCallback, useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { PackagePlus } from 'lucide-react'
import { NoticeButton, StableLabel } from './ComposerNoticePanel'
import type { ComposerNotice } from './ComposerNoticePanel'
import { NEW_CHAT_KEY, offerShowsOn, useSkillLinkOfferStore, type SkillLinkOffer } from '../../stores/skillLinkOffer.store'
import { refreshAfterSkillChange } from '../../hooks/useCatalogSkills'
import { composerKeyOnScreen } from '../../hooks/useSkillLinkIntents'
import { startAgentChat } from '../../utils/startAgentChat'
import { useAuthStore } from '../../stores/auth.store'
import { useSkillCredentialPromptStore } from '../../stores/skillCredentialPrompt.store'
import { useLogin } from '../../hooks/useAuth'
import { catalogCredentialSpecs } from '../../utils/catalogItems'
import { unwrapIpcError } from '../../utils/ipcError'
import type { SkillLinkResolution, SkillLinkSkill, SkillLinkTargetRefusal } from '../../../../shared/skillLink'

/**
 * The skill-link offer as a composer notice row (plans: skill links, D3).
 *
 * An offer, not a problem: the `accent` tone, so a panel holding only this row
 * never reads as an error. One truncated line — the sentence on the left, the
 * actions and the × at its end, as on every row — at one button's height
 * whether or not it holds buttons, and with labels that keep their width while
 * they run, so the row does not grow, shrink or reflow as the lookup answers,
 * the composer's agent changes, or Add runs (ux_rules rule 1). Nothing installs
 * without the click: the row is the confirm step (L6).
 */

type AgentLike = { id: string; name: string } | null

export interface SkillLinkNoticeHandlers {
  /** New agent with this skill: the new-agent flow with the pin queued. */
  onNewAgent: (skill: SkillLinkSkill, offer: SkillLinkOffer) => void
}

function hostOf(origin: string | null): string | null {
  if (!origin) return null
  try {
    return new URL(origin).host
  } catch {
    return null
  }
}

function versionText(skill: SkillLinkSkill): string {
  return skill.versionLabel ? `Version ${skill.revisionNumber} (${skill.versionLabel})` : `Version ${skill.revisionNumber}`
}

function refusalText(verdict: SkillLinkTargetRefusal, agentName: string | null, skill: SkillLinkSkill): string {
  const agent = agentName ?? 'This agent'
  switch (verdict) {
    case 'no_agent': return 'Pick one agent to add it to, or make a new one.'
    case 'not_kit_agent': return `${agent} can’t hold catalog skills.`
    case 'read_only': return `${agent} is shared with you to use, so its skills can’t be changed here.`
    case 'access_unknown': return `Can’t tell whether you may change ${agent}.`
    case 'clash': return `${agent} already has a skill named ${skill.name}.`
  }
}

function SkillDetails({ skill }: { skill: SkillLinkSkill }): React.JSX.Element {
  const needs = catalogCredentialSpecs({ required_credential_specs: skill.requiredCredentialSpecs })
    .filter((spec) => spec.providedBy === 'user')
  return (
    <div className="space-y-1 text-[11px] leading-snug text-[var(--color-text-secondary)]">
      {skill.description && <p className="break-words">{skill.description}</p>}
      {needs.length > 0 && (
        <p>
          <span className="font-medium text-[var(--color-text)]">Needs </span>
          {needs.map((spec) => spec.description || spec.name).join(', ')}
        </p>
      )}
      {!skill.description && needs.length === 0 && <p>No description, and no credentials to set up.</p>}
    </div>
  )
}

/** A package id as the folder findings draw code (`FindingText`). */
function PackageCode({ id }: { id: string }): React.JSX.Element {
  return <code className="rounded bg-[var(--color-bg-tertiary)] px-1 font-mono text-[10.5px] text-[var(--color-text)]">{id}</code>
}

/** The server's host as a link to its origin, opened outside the app; the full origin is its tooltip. */
function HostLink({ host, origin }: { host: string; origin: string }): React.JSX.Element {
  return (
    <a href={origin} title={origin}
      className="text-[var(--color-accent)] hover:text-[var(--color-accent-hover)] hover:underline"
      onClick={(event) => {
        event.preventDefault()
        void window.api.system.openExternal(origin)
      }}>{host}</a>
  )
}

/**
 * The offer row for this composer, or null when there is no offer for it.
 * `chatKey` is the composer's (`skillLinkChatKey(chatId)`); `target` the agent
 * it sends straight to (the composer's `directTarget`).
 */
export function useSkillLinkNotice(chatKey: string, target: AgentLike, handlers: SkillLinkNoticeHandlers): ComposerNotice | null {
  const offer = useSkillLinkOfferStore((s) => s.offer)
  const dismiss = useSkillLinkOfferStore((s) => s.dismiss)
  const moveTo = useSkillLinkOfferStore((s) => s.moveTo)
  const startSettling = useSkillLinkOfferStore((s) => s.startSettling)
  const profileId = useAuthStore((s) => s.currentUser?.id ?? null)
  const login = useLogin()
  const queryClient = useQueryClient()
  // A chat switch putting the offer away is one App-level rule
  // (`useSkillLinkIntents`), not this composer's: the start screen's composer
  // and a chat's are separate instances, and neither sees the other's key.
  const mine = offerShowsOn(offer, chatKey) ? offer : null
  // After Add or Update the row waits for main's fill of the skill's slots; once the agent's settle
  // counter passes the click's value it is gone in this very render, so the credential prompt that
  // may follow takes its place without the panel changing height in between (ux_rules rule 1).
  const settling = mine?.settling ?? null
  const settledPast = useSkillCredentialPromptStore((s) => settling !== null && (s.settled[settling.agentId] ?? 0) > settling.since)
  useEffect(() => {
    if (settledPast && mine) dismiss(mine.id)
  }, [settledPast, mine, dismiss])

  const [adding, setAdding] = useState(false)
  const [switching, setSwitching] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  // A new offer starts clean, except for the error it was raised with.
  const offerId = mine?.id ?? null
  useEffect(() => {
    setActionError(useSkillLinkOfferStore.getState().offer?.addError ?? null)
    setAdding(false)
    setSwitching(false)
  }, [offerId])

  const agentId = target?.id ?? null
  const query = useQuery({
    queryKey: ['skill-link', offerId, profileId, mine?.link.origin ?? null, mine?.link.packageId ?? null, agentId],
    queryFn: (): Promise<SkillLinkResolution> =>
      window.api.skillLinks.resolve({ origin: mine!.link.origin, packageId: mine!.link.packageId, agentId }),
    enabled: mine !== null,
    // The agent (or, after Switch, the profile) changing re-asks; the row
    // keeps the last answer meanwhile, with its actions held, instead of
    // falling back to the lookup line. Only for the same offer: a new link
    // starts at the lookup line, never on the previous link's skill.
    placeholderData: (previous, previousQuery) => (previousQuery?.queryKey[1] === offerId ? previous : undefined),
    staleTime: Infinity,
    gcTime: 0,
    retry: false
  })

  const onAdd = useCallback(async (packageUuid: string, title: string): Promise<void> => {
    if (!mine || !agentId) return
    // Read at the click: main's fill may settle before Add's answer arrives.
    const since = useSkillCredentialPromptStore.getState().settled[agentId] ?? 0
    setAdding(true)
    setActionError(null)
    try {
      const result = await window.api.catalogSkills.add(agentId, packageUuid)
      if (result.ok) {
        // The re-reads every other Add runs: the Addons rows, the catalog's pill, Finish setup.
        refreshAfterSkillChange(queryClient, agentId)
        // The row stays, checking its credentials, until main's fill settles; a slot it cannot fill
        // is then prompted for by the composer's skill-credential row in its place.
        startSettling(mine.id, { agentId, since, title })
        return
      }
      setActionError(result.message)
    } catch (err) {
      setActionError(unwrapIpcError(err, 'The skill could not be added.'))
    } finally {
      setAdding(false)
    }
  }, [mine, agentId, startSettling, queryClient])

  const onUpdate = useCallback(async (name: string, title: string): Promise<void> => {
    if (!mine || !agentId) return
    const since = useSkillCredentialPromptStore.getState().settled[agentId] ?? 0
    setAdding(true)
    setActionError(null)
    try {
      const result = await window.api.catalogSkills.update(agentId, name)
      if (result.ok) {
        refreshAfterSkillChange(queryClient, agentId)
        startSettling(mine.id, { agentId, since, title })
        return
      }
      setActionError(result.message)
    } catch (err) {
      setActionError(unwrapIpcError(err, 'The skill could not be updated.'))
    } finally {
      setAdding(false)
    }
  }, [mine, agentId, startSettling, queryClient])

  const onSwitch = useCallback(async (profile: string): Promise<void> => {
    if (!mine) return
    const from = mine.pendingFrom ?? mine.chatKey
    const id = mine.id
    // Only this offer moves: a newer link raised meanwhile stays where it is.
    const settle = (key: string): void => {
      if (useSkillLinkOfferStore.getState().offer?.id === id) moveTo(key)
    }
    setActionError(null)
    setSwitching(true)
    // Switching lands on the start screen; the offer goes with it and resolves
    // again there. Pending until the login answers, so the row stays here too
    // (with Switching…) and a failure has nothing to bring back.
    moveTo(NEW_CHAT_KEY, { from })
    try {
      const result = await login.mutateAsync({ userId: profile })
      if (!result.success) {
        settle(from)
        setActionError('That account needs its password. Switch to it from the account menu.')
      } else {
        // The login lands on the start screen in the chat view; elsewhere (a
        // dashboard's chat panel) no composer has that key, so open a new
        // chat first, as a deep link does, or the row would vanish.
        if (useSkillLinkOfferStore.getState().offer?.id === id && composerKeyOnScreen() === null) startAgentChat(null)
        settle(composerKeyOnScreen() ?? NEW_CHAT_KEY)
      }
    } catch (err) {
      settle(from)
      setActionError(unwrapIpcError(err, 'Could not switch accounts.'))
    } finally {
      setSwitching(false)
    }
  }, [mine, moveTo, login])

  if (!mine) return null

  const linkHost = hostOf(mine.link.origin) ?? 'your server'
  const base = {
    key: 'skill-link',
    tone: 'accent' as const,
    icon: PackagePlus,
    // The sentence swaps as the lookup answers; it never grows a second line. `title` holds all of it.
    singleLine: true,
    onDismiss: () => dismiss(mine.id),
    dismissLabel: 'Dismiss skill link'
  }
  /**
   * The line's text and tooltip: the sentence, then a muted note where there
   * is one. An action's error takes the line's place, in the danger colour,
   * beside the button that raised it; the sentence stays in the tooltip.
   */
  const line = (sentence: React.ReactNode, sentenceText: string, note: string | null = null, error: string | null = actionError): Pick<ComposerNotice, 'text' | 'title'> => {
    if (error) return { text: <span role="alert" className="text-[var(--color-danger)]">{error}</span>, title: `${error} ${sentenceText}` }
    return {
      text: note ? <>{sentence} <span className="text-[var(--color-text-secondary)]">{note}</span></> : sentence,
      title: note ? `${sentenceText} ${note}` : sentenceText
    }
  }

  if (settling) {
    if (settledPast) return null
    const text = `Added ${settling.title}. Checking its credentials…`
    return { ...base, ...line(<span className="text-[var(--color-text-secondary)]">{text}</span>, text, null, null) }
  }

  const answer = query.data
  if (!answer) {
    const text = query.isError
      ? `Couldn’t look up ${mine.link.packageId} on ${linkHost}.`
      : `Looking up ${mine.link.packageId} on ${linkHost}…`
    return query.isError
      ? {
          ...base,
          ...line(<>Couldn’t look up <PackageCode id={mine.link.packageId} /> on {linkHost}.</>, text),
          action: <NoticeButton onClick={() => void query.refetch()}>Try again</NoticeButton>
        }
      : { ...base, ...line(<>Looking up <PackageCode id={mine.link.packageId} /> on {linkHost}…</>, text, 'Nothing is added until you choose.', null) }
  }

  // The answer on screen is the last one while the next is asked: nothing acts on it meanwhile.
  const holding = query.isPlaceholderData || query.isFetching
  const newAgentButton = (skill: SkillLinkSkill): React.ReactNode => (
    <NoticeButton aria-label="New agent with this skill" aria-disabled={holding || adding || undefined}
      onClick={() => { if (!holding && !adding) handlers.onNewAgent(skill, mine) }}>New agent with this skill</NoticeButton>
  )
  const details = (skill: SkillLinkSkill): Partial<ComposerNotice> => ({ details: <SkillDetails skill={skill} />, detailsLabel: 'Details' })

  switch (answer.state) {
    case 'ok': {
      const { skill, target: verdict } = answer
      const facts = `${skill.title} · ${versionText(skill)}${skill.publisher ? ` · by ${skill.publisher}` : ''} on `
      const account = answer.serverGiven ? '' : ' · your current account'
      const text = `${facts}${answer.host}${account}`
      // While the next answer is asked (the composer's agent changed), the
      // previous one names the previous agent: the label follows the
      // composer, and the previous refusal is not said of the new agent.
      const refusal = verdict.verdict === 'ok' || holding ? null : refusalText(verdict.verdict, verdict.agentName, skill)
      // A refusal says why Add is off where it is read: after the title, in place of the facts,
      // which a truncated line would otherwise cut it from. The facts stay in the tooltip.
      const agentName = holding ? target?.name ?? null : verdict.agentName ?? target?.name ?? null
      const label = agentName && (holding || verdict.verdict !== 'no_agent') ? `Add to ${agentName}` : 'Add to agent'
      const disabled = (verdict.verdict !== 'ok') || holding || adding
      return {
        ...base,
        ...details(skill),
        ...(refusal
          ? line(<><span className="font-medium">{skill.title}</span> · <span className="text-[var(--color-text-secondary)]">{refusal}</span></>, `${skill.title} · ${refusal} ${text}`)
          : line(<><span className="font-medium">{skill.title}</span>{facts.slice(skill.title.length)}<HostLink host={answer.host} origin={answer.origin} />{account}</>, text)),
        action: <>
          {/* Disabled, it is not the first choice: the secondary style, fainter (not while Adding…, which is this button at work). */}
          <NoticeButton className={disabled && !adding ? 'aria-disabled:!opacity-50' : 'composer-notice-button-primary'} aria-disabled={disabled || undefined}
            aria-label={label} title={refusal ?? undefined}
            onClick={() => { if (!disabled) void onAdd(skill.packageUuid, skill.title) }}>
            <StableLabel label={label} pending={adding} pendingLabel="Adding…" />
          </NoticeButton>
          {newAgentButton(skill)}
        </>
      }
    }
    case 'already_added': {
      const { skill, target: pinned } = answer
      const onAgent = pinned.agentName || target?.name || 'this agent'
      const text = `${skill.title} is already on ${onAgent}${pinned.pinnedRevision !== null ? ` (Version ${pinned.pinnedRevision})` : ''}`
      return {
        ...base,
        ...details(skill),
        ...line(text, text),
        action: <>
          {pinned.behind && (
            <NoticeButton className="composer-notice-button-primary" aria-disabled={holding || adding || undefined}
              aria-label={`Update to Version ${skill.revisionNumber}`} onClick={() => { if (!holding && !adding) void onUpdate(pinned.pinName, skill.title) }}>
              <StableLabel label={`Update to Version ${skill.revisionNumber}`} pending={adding} pendingLabel="Updating…" />
            </NoticeButton>
          )}
          {newAgentButton(skill)}
        </>
      }
    }
    case 'other_profile': {
      const what = answer.title ?? mine.link.packageId
      const text = `${what} is on ${answer.host}, not your current account.`
      const pending = switching || login.isPending
      const held = pending || holding
      return {
        ...base,
        ...line(text, text),
        action: <NoticeButton aria-disabled={held || undefined} aria-label={`Switch to ${answer.profileName}`} onClick={() => { if (!held) void onSwitch(answer.profileId) }}>
          <StableLabel label={`Switch to ${answer.profileName}`} pending={pending} pendingLabel="Switching…" />
        </NoticeButton>
      }
    }
    case 'not_connected': {
      const origin = answer.origin
      const text = answer.host
        ? `This skill is on ${answer.host}. Connect to it first.`
        : 'This skill link doesn’t say which server it is on. Sign in to a Cinna account first.'
      return {
        ...base,
        ...line(text, text, origin ? null : 'Paste a link that names its server.'),
        action: origin
          ? <NoticeButton aria-disabled={holding || undefined} onClick={() => {
              if (holding) return
              // The connect confirm step, through the same funnel as a clicked connect link.
              void window.api.connect.deliverPasted(`cinna://connect?server=${encodeURIComponent(origin)}`)
            }}>Connect…</NoticeButton>
          : undefined
      }
    }
    case 'no_access': {
      const text = `You don’t have access to this skill on ${answer.host}.`
      return { ...base, ...line(text, text, 'Ask whoever shared it.') }
    }
    case 'offline': {
      const text = `Couldn’t reach ${answer.host} to look this skill up.`
      return {
        ...base,
        ...line(text, text),
        action: <NoticeButton aria-disabled={query.isFetching || undefined} onClick={() => { if (!query.isFetching) void query.refetch() }}>
          <StableLabel label="Try again" pending={query.isFetching} pendingLabel="Trying…" />
        </NoticeButton>
      }
    }
    case 'reauth_required': {
      // Main raised the app-wide sign-in prompt with this answer; Try again once signed in.
      const text = `Sign in to ${answer.host} again to look this skill up.`
      return {
        ...base,
        ...line(text, text),
        action: <NoticeButton aria-disabled={query.isFetching || undefined} onClick={() => { if (!query.isFetching) void query.refetch() }}>
          <StableLabel label="Try again" pending={query.isFetching} pendingLabel="Trying…" />
        </NoticeButton>
      }
    }
  }
}
