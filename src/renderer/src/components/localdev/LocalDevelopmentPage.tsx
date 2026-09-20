import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { BookOpen, SendHorizontal, Loader2, RefreshCw, FolderSync, KeyRound, MessageSquare, Settings2, TerminalSquare } from 'lucide-react'
import { useAuthStore } from '../../stores/auth.store'
import { useUIStore } from '../../stores/ui.store'
import { useLocalDevStore } from '../../stores/localDev.store'
import { useDevelopmentWorkspace, type DevelopmentAction } from '../../hooks/useDevelopmentWorkspace'
import { serverLabel } from '../../utils/agentNavigation'
import { RuntimeInstallAction } from './RuntimeInstallAction'
import { LocalDevTaskList } from './LocalDevTaskList'
import { DevelopmentRuntimeBadges } from './DevelopmentRuntimeBadges'
import { BuildGuideModal } from './BuildGuideModal'
import { DevelopmentSettings } from './DevelopmentSettings'
import { DevelopmentRecheckButton } from './DevelopmentRecheckButton'
import { ComposerWarning } from '../chat/ComposerWarning'
import { AmbientGrid } from '../ui/AmbientGrid'
import { SettingsButton } from '../settings/SettingsLayout'

const actionClass = 'ambient-button inline-flex items-center justify-center gap-2 rounded-md border border-[var(--color-border)] px-3 py-2 text-xs font-medium text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] disabled:opacity-50 transition-colors'
/** The one action that ends the state it is offered in, in the accent the rest of the app gives that. */
const primaryActionClass = 'inline-flex items-center justify-center gap-2 rounded-md bg-[var(--color-accent)] px-3 py-2 text-xs font-medium text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-50 transition-colors'
const EXAMPLES = [
  { title: 'Build a new agent', text: 'Help me build an agent that ' },
  { title: 'Improve an existing agent', text: 'Show me the agents I can build on this Cinna instance, then help me improve one.' },
  { title: 'Explore what’s possible', text: 'Explain what I can build with Cinna and help me turn my idea into an agent.' }
]

/** The footer opens here directly. Preparation creates no chat or remote agent. */
export function LocalDevelopmentPage(): React.JSX.Element {
  const user = useAuthStore((s) => s.currentUser)
  return <DevelopmentWorkspace key={user?.id ?? 'none'} />
}

function DevelopmentWorkspace(): React.JSX.Element {
  const { state, user, context, data, ready, blocker, error, busy, pending, send, repairWorkspace, reconnectWorkspace, reauthenticate, checkWorkspace, openWorkspace, openInstance } = useDevelopmentWorkspace()
  /** @see the note on the attention actions — a re-auth locks only itself. */
  const held = (action: DevelopmentAction): boolean => pending === action || (busy && pending !== 'reauth')
  const [guideOpen, setGuideOpen] = useState(false)
  const settingsOpen = useLocalDevStore((s) => s.pageMode === 'settings')
  const setSettingsOpen = (open: boolean): void => useLocalDevStore.getState().setPageMode(open ? 'settings' : 'chat')
  const openSettings = (runtime: boolean, tools = false): void => {
    if (runtime) { setSettingsOpen(true); return }
    useUIStore.getState().setSettingsMenu(tools ? 'local-dev' : 'profile-local-dev')
    useUIStore.getState().setActiveView('settings')
  }
  return (
    <div className="@container flex flex-col flex-1 min-w-0 overflow-y-auto pt-[var(--topbar-h)]">
      <header className="mx-auto flex w-full max-w-5xl shrink-0 flex-wrap items-start justify-between gap-4 px-6 py-5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-sm font-semibold text-[var(--color-text)]"><TerminalSquare size={16} className="shrink-0" /><span className="min-w-0 break-words">Agents Development{user?.cinnaServerUrl ? ` on ${serverLabel(user.cinnaServerUrl)}` : ''}</span></div>
          <div className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[11px]">
            {user?.cinnaServerUrl ? <a href={user.cinnaServerUrl} title={user.cinnaServerUrl}
              className="break-all text-[var(--color-text-secondary)] hover:text-[var(--color-accent)] hover:underline"
              onClick={(event) => {
                event.preventDefault()
                void openInstance()
              }}>{user.cinnaServerUrl.replace(/^https?:\/\//i, '').replace(/\/+$/, '')}</a>
              : <span className="text-[var(--color-text-secondary)]">No Cinna instance connected</span>}
            <span className="break-words text-[var(--color-text-muted)]">{user?.displayName}{user?.username ? ` · ${user.username}` : ''}</span>
          </div>
          <DevelopmentRuntimeBadges data={data} />
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button type="button" disabled={busy && pending !== 'reauth'} className={actionClass} onClick={() => setSettingsOpen(!settingsOpen)}>{settingsOpen ? <MessageSquare size={14} /> : <Settings2 size={14} />}{settingsOpen ? 'Start chat' : 'Settings'}</button>
          <button type="button" className={actionClass} aria-haspopup="dialog" onClick={() => setGuideOpen(true)}><BookOpen size={14} /> Build guide</button>
        </div>
      </header>
      {settingsOpen && <DevelopmentSettings data={data} onCheck={checkWorkspace} checking={context.isFetching} onOpenWorkspace={() => void openWorkspace()} onSetup={() => openSettings(false)} />}
      <div hidden={settingsOpen} className={`${settingsOpen ? 'hidden' : 'flex'} mx-auto w-full max-w-5xl flex-1 flex-col`}>
        <main className="flex flex-1 flex-col justify-center min-w-0 px-6 py-6 sm:px-8">
          <div className="mx-auto w-full max-w-2xl">
            <h1 className="text-2xl font-semibold tracking-tight text-[var(--color-text)]">What would you like to build?</h1>
            <p className="mt-2 max-w-lg text-sm leading-relaxed text-[var(--color-text-secondary)]">Describe your idea. Your local assistant will use cinna-cli to build, test, and check your agent on Cinna.</p>

            {!ready && <DevelopmentSetupNotice warning={!!blocker || state.phase === 'attention'}>
              <div className="flex items-center gap-2 text-sm font-medium text-[var(--color-text)]">
                {(state.phase === 'installing' || context.isFetching) && <Loader2 size={15} className="animate-spin" />}
                {state.phase === 'installing' ? 'Preparing your build workspace' : context.isFetching ? 'Checking your workspace and runtime' : 'Let’s get ready to build'}
              </div>
              <p className="text-sm text-[var(--color-text-secondary)]">{state.phase === 'installing' ? state.step : state.phase === 'attention' ? state.detail : blocker ?? 'Finish setup for this Cinna account. The composer will appear here when everything is ready.'}</p>
              {/* cinna-cli's own detail above ends by telling the user to open a
                  terminal, and Retry setup looks like it might do instead. Close
                  both loops here rather than letting the buttons imply it: the
                  terminal is not needed, and the obvious button cannot work.
                  The third sentence is the one consequence a user would
                  otherwise meet as a surprise — a Develop row keeps the
                  absolute path it was saved with, and that path is about to
                  become the archived copy. */}
              {state.phase === 'attention' && state.reason === 'account_mismatch' && <p className="text-xs text-[var(--color-text-muted)]">No terminal needed: Reconnect renames that folder beside the new one and sets this account up here. Retry setup cannot fix this one — it asks the server for the same account again. Agents you opened with Develop keep pointing at the old folder until you Develop them again.</p>}
              {!!state.tasks?.length && state.phase !== 'ready' && <LocalDevTaskList tasks={state.tasks} />}
              <div className="flex flex-wrap gap-2">
                {state.phase === 'attention' && <>
                  {/* Disabled while *this* action runs, and while a short local
                      one does. Never behind a re-auth: that waits on a browser
                      the user may simply have closed, and ten minutes of dead
                      buttons is a trap, not a safeguard. */}
                  {/* Ordered and weighted by what actually ends each reason. A
                      mismatched workspace is the one state whose obvious button
                      provably fails the same way, so Reconnect carries the
                      accent and Retry setup stays last — kept, because it is
                      still the escape hatch if the reason was misread. */}
                  {state.reason === 'account_mismatch' && <button type="button" disabled={held('reconnect')} className={primaryActionClass} onClick={() => void reconnectWorkspace()}><ActionIcon busy={pending === 'reconnect'}><FolderSync size={13} /></ActionIcon> Reconnect workspace</button>}
                  {(state.reason === 'account_mismatch' || state.reason === 'token_expired') && <button type="button" disabled={held('reauth')} className={actionClass} onClick={() => void reauthenticate()}><ActionIcon busy={pending === 'reauth'}><KeyRound size={13} /></ActionIcon> Re-authenticate</button>}
                  <button type="button" disabled={held('repair')} className={actionClass} onClick={() => void repairWorkspace()}><ActionIcon busy={pending === 'repair'}><RefreshCw size={13} /></ActionIcon> Retry setup</button>
                </>}
                {state.phase === 'ready' && <>
                  {data?.installTool && <RuntimeInstallAction tool={data.installTool} onDone={() => void context.refetch()} />}
                  <SettingsButton onClick={() => openSettings(!!data && data.setupTarget !== 'local-dev', true)}><Settings2 size={13} />{data && data.setupTarget !== 'local-dev' ? 'Open Runtime settings' : 'Local Development settings'}</SettingsButton>
                  <DevelopmentRecheckButton fetching={context.isFetching} onCheck={checkWorkspace} />
                </>}
                {!['ready', 'installing', 'attention'].includes(state.phase) && <button type="button" className={actionClass} onClick={() => openSettings(false)}>Set up local development</button>}
              </div>
              {state.phase === 'installing' && <p className="text-xs text-[var(--color-text-muted)]">You can leave this page. Setup continues in the background.</p>}
            </DevelopmentSetupNotice>}
            {error && <ComposerWarning role="alert" className="mt-4"><p>{error}</p></ComposerWarning>}
            {(ready || !!blocker || state.phase === 'attention') && <DevelopmentComposer profileId={user?.id ?? ''} active={!settingsOpen && ready} busy={busy} sending={pending === 'send'} blocked={!ready} onSend={send} />}
          </div>
        </main>

      </div>
      {settingsOpen && error && <p role="alert" className="mx-auto max-w-4xl px-6 text-sm text-[var(--color-danger)]">{error}</p>}
      {guideOpen && <BuildGuideModal data={data} onClose={() => setGuideOpen(false)} />}
    </div>
  )
}

/**
 * Async state on one button of several, without moving the others.
 *
 * A label that swaps to "Reconnecting…" changes that button's width, and this
 * row is `flex-wrap`: at the narrow end of the window the row re-wraps under
 * the user's own click and the composer below it jumps by a line. The icon box
 * is the same 13px either way, so the row cannot re-flow (§1) and the running
 * action is still named — by the spinner sitting on it.
 */
function ActionIcon({ busy, children }: { busy: boolean; children: React.ReactNode }): React.JSX.Element {
  return busy ? <Loader2 size={13} className="animate-spin" /> : <>{children}</>
}

function DevelopmentSetupNotice({ warning, children }: { warning: boolean; children: React.ReactNode }): React.JSX.Element {
  return warning
    ? <ComposerWarning role="alert" label="Development setup" className="mt-6"><div className="space-y-4">{children}</div></ComposerWarning>
    : <section aria-label="Development setup" role="status" className="mt-6 space-y-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-4">{children}</section>
}

/** Draft notifications stay here: typing must not rerender the workspace and its CLI guides. */
function DevelopmentComposer({ profileId, active, busy, sending, blocked, onSend }: {
  profileId: string
  active: boolean
  /** Anything is running, so nothing here may be pressed. */
  busy: boolean
  /** *This* is what is running. Repairing the workspace is not "Starting…". */
  sending: boolean
  blocked: boolean
  onSend: (message: string) => Promise<void>
}): React.JSX.Element {
  const draft = useLocalDevStore((s) => s.drafts[profileId] ?? '')
  const setDraft = (text: string): void => useLocalDevStore.getState().setDraft(profileId, text)
  const textarea = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const input = textarea.current
    if (!active || !input || document.querySelector('[role="dialog"]')) return
    input.focus()
    input.setSelectionRange(input.value.length, input.value.length)
    input.scrollTop = input.scrollHeight
  }, [active])
  useLayoutEffect(() => {
    const input = textarea.current
    if (!input) return
    input.style.height = 'auto'
    input.style.height = `${Math.min(input.scrollHeight, 180)}px`
  }, [draft])
  return (
    <>
      <form className="mt-6" onSubmit={(event) => { event.preventDefault(); if (!blocked) void onSend(draft) }}>
        <div className="ambient-grid-surface rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-input)] overflow-hidden focus-within:border-[var(--color-accent)] transition-colors [--ambient-input-tint:var(--color-border)] focus-within:[--ambient-input-tint:var(--color-accent)]">
          <AmbientGrid active={active} inputRef={textarea} />
          <label htmlFor="development-message" className="sr-only">Describe the agent you want to build</label>
          <textarea id="development-message" ref={textarea} value={draft} onChange={(event) => setDraft(event.target.value)} disabled={busy || blocked} rows={4}
            placeholder="Build an agent that…"
            className="block w-full resize-none bg-transparent px-4 py-3 text-sm leading-relaxed text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] outline-none disabled:opacity-60"
            onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (!blocked) void onSend(draft) } }} />
        </div>
        <div className="flex items-center justify-end px-1 pt-2">
          <button type="submit" disabled={busy || blocked || !draft.trim()} className="inline-flex shrink-0 items-center gap-2 rounded-lg bg-[var(--color-success)] px-3 py-1.5 text-xs font-medium text-white hover:opacity-80 disabled:opacity-20 disabled:cursor-not-allowed transition-opacity">
            {sending ? <Loader2 size={16} className="animate-spin" /> : <SendHorizontal size={16} />} {sending ? 'Starting…' : 'Start building'}
          </button>
        </div>
      </form>
      <div className="mt-6 flex flex-wrap gap-2">{EXAMPLES.map((example) => <button key={example.title} type="button" disabled={busy || blocked} className={actionClass} onClick={() => { setDraft(example.text); textarea.current?.focus() }}>{example.title}</button>)}</div>
    </>
  )
}
