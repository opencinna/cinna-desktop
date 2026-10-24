import { useEffect, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useQueryClient } from '@tanstack/react-query'
import { Check, ChevronLeft, ExternalLink, HelpCircle, Loader2, SquareTerminal } from 'lucide-react'
import type { AddonNextStep, AgentDirectoryEntry } from '../../../../../shared/addons/directory'
import { useConnectMcp, useMcpProviders, useUpsertMcpProvider } from '../../../hooks/useMcp'
import { ADDONS_KEY } from '../../../hooks/useAddonDirectory'
import { unwrapIpcError } from '../../../utils/ipcError'
import { documentMarkdownComponents, remarkStripHtml } from '../../../utils/markdownComponents'
import { formatEnvVars, parseEnvVars } from '../../../utils/envVars'
import { openExternalUrl } from '../../settings/CredentialRow'
import { settingsInputClass } from '../../settings/SettingsLayout'
import { ADDON_KIND } from './AddonRow'

export const PICKER_PRIMARY =
  'inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] font-medium bg-[var(--color-accent)] text-white ' +
  'transition-colors hover:bg-[var(--color-accent-hover)] disabled:cursor-not-allowed disabled:opacity-40'
export const PICKER_SECONDARY =
  'inline-flex items-center justify-center gap-1.5 rounded-md border border-[var(--color-border)] px-3 py-1.5 text-[13px] font-medium ' +
  'text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-text)] disabled:cursor-not-allowed disabled:opacity-50'
const SUBHEADING = 'mb-1 text-[12px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]'

export const PICKER_TEXT = {
  added: 'Added',
  ready: 'Ready in the next chat',
  runsCode: 'Runs code on this computer',
  needsKit: 'A cinna-agent.json: skills are pinned there, and this agent is a plain folder without one. Connectors work on it.',
  addTo: (agent: string) => `Add to ${agent}`,
  remove: (title: string, agent: string) => `Remove ${title} from ${agent}`,
  removeConfirm: (title: string, agent: string, kind: AgentDirectoryEntry['kind']) =>
    kind === 'mcp'
      ? `Remove ${title} from ${agent}? The connector stays on this computer, in Settings → MCP.`
      : `Remove ${title} from ${agent}? You can add it again from here.`,
  holdInput: 'Save or cancel first',
  notNow: 'Not now',
  finishSetup: 'Finish setup',
  turnOn: 'Turn on',
  /** An added connector whose step was put off before the directory re-read says so itself. */
  later: {
    oauth: 'Added — needs you to sign in',
    bearer: 'Added — needs an access token',
    env: 'Added — needs settings filled in',
    connect: 'Added — could not connect',
    enable: 'Added — turned off'
  } satisfies Record<AddonNextStep, string>
} as const

/**
 * A failed connect in a sentence: main's error is an SDK's or Node's
 * ("SdkError: Version negotiation probe failed: fetch failed"), kept for the
 * (?) beside it, never as the sentence itself.
 */
export function connectFailureSentence(raw: string): string {
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|EHOSTUNREACH|getaddrinfo|network|socket hang up|timed? ?out|certificate|self[- ]signed/i.test(raw)) {
    return 'It could not reach the server.'
  }
  if (/\b(400|401|403|404|405|406|415|500|502|503)\b|unauthori[sz]ed|forbidden|refused|denied|rejected/i.test(raw)) return 'The server refused the connection.'
  return 'It did not connect.'
}

/** Where one entry's Add stands in the picker; `at` orders this opening's own steps against the add. */
export type AddFlow = (
  | { phase: 'adding' | 'removing' }
  | { phase: 'idle'; error?: string }
  /** `message`: why the connector is not connected yet (a `connect` step). */
  | { phase: 'setup'; next: AddonNextStep; mcpProviderId: string; message?: string }
  | { phase: 'ready' }
) & { at?: number }

/** A need under "What it needs", without restating the heading: "Needs you to sign in" → "You to sign in". */
export function needLine(text: string): string {
  const rest = text.replace(/^needs\s+/i, '')
  return rest === text ? text : rest.charAt(0).toUpperCase() + rest.slice(1)
}

/** States the Add button cannot act on. */
export function blockedState(state: AgentDirectoryEntry['state']): boolean {
  return state === 'blocked' || state === 'preparing' || state === 'incompatible'
}

function credentialName(spec: Record<string, unknown>): string {
  for (const key of ['name', 'slot', 'service_uri', 'serviceUri', 'type']) {
    const value = spec[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return 'A credential'
}

/** "3 skills · 1 connector · hooks": a plugin's parts, one line per kind. */
function componentLines(entry: AgentDirectoryEntry): string[] {
  const c = entry.components
  if (!c) return []
  const lines: string[] = []
  const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`
  if (c.skills.length) lines.push(`${count(c.skills.length, 'skill', 'skills')}: ${c.skills.map((s) => s.name).join(', ')}`)
  if (c.mcpServers.length) lines.push(`${count(c.mcpServers.length, 'connector', 'connectors')}: ${c.mcpServers.map((s) => s.name).join(', ')}`)
  if (c.commands.length) lines.push(`${count(c.commands.length, 'command', 'commands')}: ${c.commands.join(', ')}`)
  if (c.agents.length) lines.push(`${count(c.agents.length, 'agent', 'agents')}: ${c.agents.join(', ')}`)
  if (c.hooks?.events.length) lines.push(`Hooks on ${c.hooks.events.join(', ')}`)
  if (c.lspServers.length) lines.push(`${count(c.lspServers.length, 'language server', 'language servers')}: ${c.lspServers.join(', ')}`)
  return lines
}

/**
 * One addon's detail, in the picker over its list (which stays laid out
 * underneath, so Back returns to the same scroll position): what it is, what
 * it adds and needs, who publishes it, and one primary **Add to <agent>** —
 * disabled with the reason beside it when the entry cannot be added here,
 * "Added" with Remove once it is. After an add the next step (sign in, paste
 * a key, fill settings) replaces the button in place, then "Ready in the next
 * chat". A refusal stays on this view, under the button (ux_rules rule 6).
 */
export function AddonPickerDetail({
  entry,
  agentName,
  agentKit,
  state,
  reason,
  flow,
  holdsInput = false,
  onBack,
  onAdd,
  onRemove,
  onSetupDone,
  onSetupLater,
  onStepDirty,
  onClose
}: {
  entry: AgentDirectoryEntry
  agentName: string
  agentKit: boolean
  /** The entry's state for the agent, after the picker's own gates. */
  state: AgentDirectoryEntry['state']
  reason: string | null
  flow: AddFlow
  /** A step here holds typed input: Back is disabled, as are the picker's other ways out. */
  holdsInput?: boolean
  onBack: () => void
  onAdd: () => void
  onRemove: () => void
  onSetupDone: () => void
  /** The step after this add was put off ("Not now", or it moved on): the detail reads the entry's state again. */
  onSetupLater: () => void
  /** Whether a key / settings step holds typed input, which is when the picker's ways out wait for it. */
  onStepDirty: (dirty: boolean) => void
  onClose: () => void
}): React.JSX.Element {
  const [linkError, setLinkError] = useState<string | null>(null)
  const [confirmingRemove, setConfirmingRemove] = useState(false)
  // A step put off with "Not now": the connector stays added; `later` says what it needs until the directory re-reads it.
  const [later, setLater] = useState<{ next: AddonNextStep; mcpProviderId: string } | null>(null)
  const [resting, setResting] = useState(false)
  const link = entry.origin.repositoryUrl ?? entry.origin.homepage
  const parts = componentLines(entry)
  const credentials = entry.requires.credentials
  const needsKit = !agentKit && entry.kind !== 'mcp'
  const setupNeed = state === 'addable_with_setup' ? reason : null
  const busy = flow.phase === 'adding' || flow.phase === 'removing'
  const error = flow.phase === 'idle' ? flow.error : undefined
  // An added connector that still needs a step (sign in, a key, Connect, Turn on) offers it here, as right after its add.
  const entryNeed = state === 'added' && entry.setupStep && entry.mcpProviderId ? { next: entry.setupStep, mcpProviderId: entry.mcpProviderId } : null
  const need = flow.phase === 'idle' ? (state === 'added' ? entryNeed : later) : null
  const added = state === 'added' || (flow.phase === 'idle' && later !== null)
  const needLineText = need ? (state === 'added' && reason ? reason : PICKER_TEXT.later[need.next]) : null
  const removing = flow.phase === 'removing'

  // Remove asks first, inside this card, as a skill row's Remove does on the tab (rule 13).
  const removeConfirm = confirmingRemove && (
    <div role="group" aria-label={PICKER_TEXT.remove(entry.title, agentName)} className="mt-3 border-t border-[var(--color-border)] pt-3">
      <p className="mb-2 text-[13px] text-[var(--color-text)]">{PICKER_TEXT.removeConfirm(entry.title, agentName, entry.kind)}</p>
      <div className="flex gap-2">
        <button
          type="button"
          disabled={removing}
          onClick={() => {
            setConfirmingRemove(false)
            setLater(null)
            onRemove()
          }}
          className={PICKER_SECONDARY}
        >
          Remove
        </button>
        <button type="button" disabled={removing} onClick={() => setConfirmingRemove(false)} className={PICKER_SECONDARY}>
          Cancel
        </button>
      </div>
    </div>
  )
  const removeButton = (
    <button
      type="button"
      onClick={() => setConfirmingRemove(true)}
      disabled={busy || confirmingRemove || holdsInput}
      aria-label={PICKER_TEXT.remove(entry.title, agentName)}
      className={PICKER_SECONDARY}
    >
      {removing ? <Loader2 size={14} className="animate-spin" aria-hidden /> : null}
      {removing ? 'Removing…' : 'Remove'}
    </button>
  )

  let action: React.JSX.Element
  if (flow.phase === 'setup') {
    const step = { next: flow.next, mcpProviderId: flow.mcpProviderId }
    action = (
      <SetupStep
        entry={entry}
        next={flow.next}
        mcpProviderId={flow.mcpProviderId}
        message={flow.message}
        onDone={onSetupDone}
        onDirty={onStepDirty}
        onLater={() => {
          setLater(step)
          setResting(true)
          onSetupLater()
        }}
        onMoved={onSetupLater}
      />
    )
  } else if (flow.phase === 'ready') {
    action = (
      <div className="flex items-center gap-3">
        <span role="status" className="flex items-center gap-1.5 text-[13px] text-[var(--color-success)]">
          <Check size={14} aria-hidden />
          {PICKER_TEXT.ready}
        </span>
        {/* "Done", not a second "Close" beside the header's (rule 10). */}
        <button type="button" onClick={onClose} className={PICKER_PRIMARY}>
          Done
        </button>
      </div>
    )
  } else if (need && !resting) {
    action = (
      <>
        <SetupStep
          entry={entry}
          next={need.next}
          mcpProviderId={need.mcpProviderId}
          added
          onDone={onSetupDone}
          onDirty={onStepDirty}
          onLater={() => setResting(true)}
        />
        <div className="mt-3 flex items-center gap-2">{removeButton}</div>
        {removeConfirm}
      </>
    )
  } else if (added) {
    action = (
      <>
        <div className="flex items-center gap-2">
          <button type="button" disabled aria-label={`${entry.title} added`} className={PICKER_SECONDARY}>
            <Check size={14} aria-hidden />
            {PICKER_TEXT.added}
          </button>
          {need && (
            <button type="button" onClick={() => setResting(false)} disabled={busy} className={PICKER_SECONDARY}>
              {PICKER_TEXT.finishSetup}
            </button>
          )}
          {removeButton}
        </div>
        {needLineText && (
          <p data-addon-need className="mt-2 text-[13px] text-[var(--color-text-muted)]">
            {needLineText}
          </p>
        )}
        {removeConfirm}
      </>
    )
  } else {
    const blocked = blockedState(state)
    action = (
      <div className="flex min-w-0 items-center gap-3">
        <button type="button" onClick={onAdd} disabled={blocked || busy} title={blocked && reason ? reason : undefined} className={`${PICKER_PRIMARY} shrink-0`}>
          {flow.phase === 'adding' && <Loader2 size={14} className="animate-spin" aria-hidden />}
          {flow.phase === 'adding' ? 'Adding…' : PICKER_TEXT.addTo(agentName)}
        </button>
        {blocked && reason && <span className="min-w-0 text-[13px] text-[var(--color-text-muted)]">{reason}</span>}
      </div>
    )
  }

  return (
    <div data-addon-detail={`${entry.ref.source}:${entry.ref.id}`} className="absolute inset-0 overflow-y-auto px-5 pb-5">
      <div className="flex items-start gap-2">
        <button
          type="button"
          autoFocus
          onClick={onBack}
          disabled={holdsInput}
          aria-label="Back"
          title={holdsInput ? PICKER_TEXT.holdInput : 'Back'}
          className="-ml-1.5 mt-0.5 shrink-0 rounded p-1 text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)] disabled:cursor-not-allowed disabled:opacity-40"
        >
          <ChevronLeft size={16} />
        </button>
        {/* Kind, version and source are the facts list's, below; the header is the name only. */}
        <h3 className="min-w-0 flex-1 break-words pt-0.5 text-[14px] font-semibold text-[var(--color-text)]">{entry.title}</h3>
      </div>

      <div className="mt-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-4 py-3">
        {action}
        {error && (
          <p role="alert" className="mt-2 text-[13px] text-[var(--color-danger)]">
            {error}
          </p>
        )}
      </div>

      {entry.description ? (
        <div className="markdown-body mt-4 text-[13px] leading-relaxed text-[var(--color-text-secondary)]">
          <Markdown remarkPlugins={[remarkGfm, remarkStripHtml]} components={documentMarkdownComponents}>
            {entry.description}
          </Markdown>
        </div>
      ) : (
        entry.summary && <p className="mt-4 text-[13px] text-[var(--color-text-secondary)]">{entry.summary}</p>
      )}

      {parts.length > 0 && (
        <section className="mt-4">
          <h4 className={SUBHEADING}>What it adds</h4>
          <ul className="space-y-0.5 text-[13px] text-[var(--color-text)]">
            {parts.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>
      )}

      {(credentials.length > 0 || needsKit || setupNeed) && (
        <section className="mt-4">
          <h4 className={SUBHEADING}>What it needs</h4>
          <ul className="space-y-0.5 text-[13px] text-[var(--color-text)]">
            {credentials.map((spec, index) => (
              <li key={index}>
                <code className="rounded bg-[var(--color-bg-tertiary)] px-1.5 py-px font-mono text-[12px] text-[var(--color-text-secondary)]">
                  {credentialName(spec)}
                </code>
              </li>
            ))}
            {needsKit && <li>{PICKER_TEXT.needsKit}</li>}
            {setupNeed && <li>{needLine(setupNeed)}</li>}
          </ul>
        </section>
      )}

      {entry.runsCode && (
        <p data-addon-runs-code className="mt-4 flex items-center gap-1.5 text-[13px] text-[var(--color-text)]">
          <SquareTerminal size={14} aria-hidden className="shrink-0 text-[var(--color-warning)]" />
          {PICKER_TEXT.runsCode}
        </p>
      )}

      <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
        {entry.publisher && (
          <>
            <dt className="text-[var(--color-text-muted)]">Publisher</dt>
            <dd className="min-w-0 break-words text-[var(--color-text)]">
              {entry.publisher.name}
              {entry.publisher.verified && <span className="ml-1.5 text-[12px] text-[var(--color-text-muted)]">verified</span>}
            </dd>
          </>
        )}
        {entry.version && (
          <>
            <dt className="text-[var(--color-text-muted)]">Version</dt>
            <dd className="min-w-0 break-words text-[var(--color-text)]">{entry.version}</dd>
          </>
        )}
        <dt className="text-[var(--color-text-muted)]">Kind</dt>
        <dd className="text-[var(--color-text)]">{ADDON_KIND[entry.kind].label}</dd>
        <dt className="text-[var(--color-text-muted)]">Source</dt>
        <dd className="min-w-0 break-words text-[var(--color-text)]">
          {link ? (
            <a
              href={link}
              title={link}
              onClick={(e) => {
                e.preventDefault()
                setLinkError(null)
                void openExternalUrl(link, setLinkError)
              }}
              className="inline-flex items-center gap-1 text-[var(--color-accent)] hover:underline"
            >
              {entry.origin.label}
              <ExternalLink size={12} aria-hidden />
            </a>
          ) : (
            entry.origin.label
          )}
        </dd>
      </dl>
      {linkError && (
        <p role="alert" className="mt-2 text-[13px] text-[var(--color-danger)]">
          {linkError}
        </p>
      )}
    </div>
  )
}

/**
 * The step a connector needs after its add, in place of the Add button: sign
 * in (Connect opens the browser; the step waits for the connector to say it
 * is connected), paste an access token, or fill its settings. Uses the same
 * connect and save the connector's card in Settings → MCP does. A failure
 * stays here, under the control (rule 6).
 */
function SetupStep({
  entry,
  next,
  mcpProviderId,
  message,
  added = false,
  onDone,
  onDirty,
  onLater,
  onMoved
}: {
  entry: AgentDirectoryEntry
  next: AddonNextStep
  mcpProviderId: string
  /** Why the connector did not connect (a `connect` step), from the add. */
  message?: string
  /** Shown for a connector added earlier, not as the step after this add: no "Added." in front. */
  added?: boolean
  onDone: () => void
  /** Whether the key / settings field holds typed input (non-empty, or changed from what it held). */
  onDirty: (dirty: boolean) => void
  /** "Not now" on a key / settings step: put it off; the connector stays added. */
  onLater: () => void
  /** Turned on but not connected: the step is no longer this one, and the entry's own state says which. */
  onMoved?: () => void
}): React.JSX.Element {
  const { data: providers } = useMcpProviders()
  const provider = providers?.find((p) => p.id === mcpProviderId) ?? null
  const connect = useConnectMcp()
  const upsert = useUpsertMcpProvider()
  const queryClient = useQueryClient()
  // The step acts on the connector's row (Save, Turn on): read it fresh, not from a list cached before it changed.
  useEffect(() => {
    void queryClient.invalidateQueries({ queryKey: ['mcp-providers'] })
  }, [queryClient, mcpProviderId])
  const [token, setToken] = useState('')
  const [env, setEnv] = useState(() => formatEnvVars(provider?.env))
  const initialEnv = useRef(env)
  const [error, setError] = useState<string | null>(null)
  const [asked, setAsked] = useState(false)

  // Typed input holds the picker's ways out; an empty or untouched field holds nothing (ux_rules rule 13).
  const dirty = next === 'bearer' ? token !== '' : next === 'env' ? env !== initialEnv.current : false
  useEffect(() => {
    onDirty(dirty)
    return () => onDirty(false)
  }, [dirty, onDirty])

  const connected = provider?.status === 'connected'
  useEffect(() => {
    if (connected) onDone()
  }, [connected, onDone])

  const connectNow = (): void => {
    setError(null)
    setAsked(true)
    connect
      .mutateAsync(mcpProviderId)
      .then((result) => {
        if (!result.success) setError(result.error ?? 'Could not connect.')
      })
      .catch((err) => setError(unwrapIpcError(err)))
  }

  /** Save the key or the settings on the connector, which connects it; then read where it stands. */
  const save = (patch: { bearerToken?: string; env?: Record<string, string> }): void => {
    if (!provider) return
    setError(null)
    upsert
      .mutateAsync({
        id: provider.id,
        name: provider.name,
        transportType: provider.transportType,
        command: provider.command,
        args: provider.args,
        url: provider.url,
        env: patch.env ?? provider.env,
        enabled: true,
        ...(patch.bearerToken ? { authType: 'bearer' as const, bearerToken: patch.bearerToken } : {})
      })
      .then(async () => {
        const fresh = (await window.api.mcp.list()).find((p) => p.id === provider.id)
        if (fresh?.status === 'connected') onDone()
        else setError(fresh?.error ?? 'It did not connect with that.')
      })
      .catch((err) => setError(unwrapIpcError(err)))
  }

  const failure = error && (
    <p role="alert" className="mt-2 text-[13px] text-[var(--color-danger)]">
      {error}
    </p>
  )

  const lead = added ? '' : 'Added. '

  const notNow = (
    <button type="button" onClick={onLater} disabled={upsert.isPending} className={`${PICKER_SECONDARY} shrink-0`}>
      {PICKER_TEXT.notNow}
    </button>
  )

  /** Turn the connector on, as its toggle in Settings → MCP does; the directory is read again for where it stands then. */
  const turnOn = (): void => {
    if (!provider) return
    setError(null)
    upsert
      .mutateAsync({
        id: provider.id,
        name: provider.name,
        transportType: provider.transportType,
        command: provider.command,
        args: provider.args,
        url: provider.url,
        env: provider.env,
        enabled: true
      })
      .then(async () => {
        const fresh = (await window.api.mcp.list()).find((p) => p.id === provider.id)
        await queryClient.invalidateQueries({ queryKey: ADDONS_KEY })
        if (fresh?.status === 'connected') onDone()
        else onMoved?.()
      })
      .catch((err) => setError(unwrapIpcError(err)))
  }

  if (next === 'enable') {
    return (
      <div data-addon-setup="enable">
        <p className="mb-2 text-[13px] text-[var(--color-text)]">
          {lead}
          {entry.title} is turned off on this computer.
        </p>
        <button type="button" onClick={turnOn} disabled={!provider || upsert.isPending} className={PICKER_PRIMARY}>
          {upsert.isPending && <Loader2 size={14} className="animate-spin" aria-hidden />}
          {PICKER_TEXT.turnOn}
        </button>
        {failure}
      </div>
    )
  }

  if (next === 'connect') {
    // A connect that failed for a reason that is not auth: the reason in a sentence (main's own words behind the (?)), and Connect to try again.
    const raw = error ?? provider?.error ?? message ?? null
    const reason = raw ? connectFailureSentence(raw) : 'It did not connect.'
    return (
      <div data-addon-setup="connect">
        <p className="mb-2 text-[13px] text-[var(--color-text)]">{lead}{entry.title} is not connected yet.</p>
        <div className="flex items-center gap-3">
          <button type="button" onClick={connectNow} disabled={connect.isPending} className={PICKER_PRIMARY}>
            {connect.isPending && <Loader2 size={14} className="animate-spin" aria-hidden />}
            {asked ? 'Try again' : 'Connect'}
          </button>
        </div>
        <p role="alert" className="mt-2 flex items-center gap-1.5 text-[13px] text-[var(--color-danger)]">
          {reason}
          {raw && raw !== reason && (
            <span role="img" aria-label={`Details: ${raw}`} title={raw} data-addon-error-detail className="inline-flex shrink-0 cursor-help text-[var(--color-text-muted)]">
              <HelpCircle size={13} aria-hidden />
            </span>
          )}
        </p>
      </div>
    )
  }

  if (next === 'oauth') {
    const waiting = asked && provider?.status === 'awaiting-auth'
    return (
      <div data-addon-setup="oauth">
        <p className="mb-2 text-[13px] text-[var(--color-text)]">{lead}Sign in to {entry.title} to finish.</p>
        <div className="flex items-center gap-3">
          <button type="button" onClick={connectNow} disabled={connect.isPending} className={PICKER_PRIMARY}>
            {connect.isPending && <Loader2 size={14} className="animate-spin" aria-hidden />}
            {asked ? 'Connect again' : 'Connect'}
          </button>
          {waiting && <span className="text-[13px] text-[var(--color-text-muted)]">Waiting for you to sign in in your browser…</span>}
        </div>
        {failure}
      </div>
    )
  }

  if (next === 'bearer') {
    return (
      <form
        data-addon-setup="bearer"
        onSubmit={(e) => {
          e.preventDefault()
          if (token.trim()) save({ bearerToken: token.trim() })
        }}
      >
        <label htmlFor="addon-setup-token" className="mb-1 block text-[13px] text-[var(--color-text)]">
          {lead}Paste the access token for {entry.title} to finish.
        </label>
        <div className="flex items-center gap-2">
          <input
            id="addon-setup-token"
            type="password"
            autoFocus
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="Paste the server's access token"
            className={settingsInputClass}
          />
          {notNow}
          <button type="submit" disabled={!token.trim() || !provider || upsert.isPending} className={`${PICKER_PRIMARY} shrink-0`}>
            {upsert.isPending && <Loader2 size={14} className="animate-spin" aria-hidden />}
            Save
          </button>
        </div>
        {failure}
      </form>
    )
  }

  return (
    <form
      data-addon-setup="env"
      onSubmit={(e) => {
        e.preventDefault()
        save({ env: parseEnvVars(env) })
      }}
    >
      <label htmlFor="addon-setup-env" className="mb-1 block text-[13px] text-[var(--color-text)]">
        {lead}Fill in the settings {entry.title} needs (KEY=VALUE per line) to finish.
      </label>
      <textarea
        id="addon-setup-env"
        autoFocus
        rows={3}
        value={env}
        onChange={(e) => setEnv(e.target.value)}
        placeholder="API_KEY=…"
        className={`${settingsInputClass} resize-none font-mono`}
      />
      <div className="mt-2 flex justify-end gap-2">
        {notNow}
        <button type="submit" disabled={!provider || upsert.isPending} className={PICKER_PRIMARY}>
          {upsert.isPending && <Loader2 size={14} className="animate-spin" aria-hidden />}
          Save
        </button>
      </div>
      {failure}
    </form>
  )
}
