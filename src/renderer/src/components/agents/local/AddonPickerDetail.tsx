import { Fragment, useCallback, useEffect, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useQueryClient } from '@tanstack/react-query'
import { Check, ChevronLeft, ExternalLink, HelpCircle, Loader2, SquareTerminal } from 'lucide-react'
import type { AddonNextStep, AgentDirectoryEntry } from '../../../../../shared/addons/directory'
import { useConnectMcp, useMcpProviders, useUpsertMcpProvider } from '../../../hooks/useMcp'
import { ADDONS_KEY, useAddonPluginStatus, useRecheckRuntimes } from '../../../hooks/useAddonDirectory'
import type { AgentEngine } from '../../../../../shared/engine'
import { engineDetails, type AddonPart } from '../../../../../shared/addons/engineSupport'
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
  /** A plugin's connectors the add started, not up yet: an `npx -y` / `uvx` server downloads on its first start. */
  starting: 'Starting… the first start downloads the server',
  runsCode: 'Runs code on this computer',
  needsKit: 'A cinna-agent.json: skills are pinned there, and this agent is a plain folder without one. Connectors work on it.',
  addTo: (agent: string) => `Add to ${agent}`,
  /** A plugin that runs code: the button itself carries the consent (no extra dialog). */
  addRunsCode: 'Add — runs code on this computer',
  checkAgain: 'Check again',
  checking: 'Checking…',
  /** Check again found the runtime still missing; found, the detail moves on by itself. */
  stillMissing: (runtime: 'node' | 'docker') =>
    `Still no ${RUNTIME_LABEL[runtime]}. If you just installed it, try again in a moment.`,
  /** The plugin's status could not be read right after its add. */
  pluginSetupFailed: 'Added, but what its connectors need could not be read. Open the plugin on the Addons tab to finish.',
  /** A plugin added, still finding which of its connectors needs a step. */
  pluginSetupReading: 'Added. Checking what its connectors need…',
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
  /** A plugin added whose connectors need a step: which one, the plugin's status says. */
  | { phase: 'pluginSetup'; next: AddonNextStep }
  | { phase: 'idle'; error?: string }
  /** `message`: why the connector is not connected yet (a `connect` step). */
  | { phase: 'setup'; next: AddonNextStep; mcpProviderId: string; message?: string }
  /** Added; the connectors its add started (`mcpProviderIds`) are not up yet. */
  | { phase: 'starting'; mcpProviderIds: string[] }
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

const RUNTIME_LABEL = { node: 'Node.js', python: 'Python', docker: 'Docker' } as const

/** Lowercase plural nouns for "Works with": "skills and connectors only". */
const PART_NOUNS: Record<AddonPart, string> = {
  skills: 'skills',
  mcpServers: 'connectors',
  commands: 'commands',
  agents: 'agents',
  hooks: 'hooks',
  lspServers: 'language servers'
}

function joinNouns(nouns: string[]): string {
  return nouns.length <= 1 ? nouns.join('') : `${nouns.slice(0, -1).join(', ')} and ${nouns[nouns.length - 1]}`
}

/**
 * A plugin's "Works with", one line per engine, the agent's own first (from
 * the shared matrix): "Claude: everything", "Codex: skills and connectors
 * only", "Antigravity: none of it".
 */
export function worksWithLines(entry: AgentDirectoryEntry, agentEngine: AgentEngine | null): Array<{ engine: AgentEngine; label: string; text: string }> {
  if (entry.kind !== 'plugin' || !entry.components) return []
  return engineDetails(entry.components, null, agentEngine).map((detail) => ({
    engine: detail.engine,
    label: detail.label,
    text:
      detail.level === 'compatible'
        ? 'everything'
        : detail.level === 'incompatible'
          ? 'none of it'
          : `${joinNouns(detail.supported.map((part) => PART_NOUNS[part]))} only`
  }))
}

/** What a plugin needs on this computer, from its connectors: Node.js, Docker, values or a sign-in. */
export function pluginNeeds(entry: AgentDirectoryEntry): Array<{ key: string; text: string; code?: string[] }> {
  if (entry.kind !== 'plugin' || !entry.components) return []
  const servers = entry.components.mcpServers
  const needs: Array<{ key: string; text: string; code?: string[] }> = []
  if (servers.some((s) => s.runtime === 'node')) needs.push({ key: 'node', text: 'Node.js on this computer' })
  if (servers.some((s) => s.runtime === 'docker')) needs.push({ key: 'docker', text: 'Docker on this computer' })
  for (const s of servers) {
    if (s.auth === 'env' || (s.auth === 'bearer' && s.env.length > 0)) {
      needs.push({ key: `env:${s.name}`, text: `Values for ${s.name}`, ...(s.env.length ? { code: s.env.map((e) => e.name) } : {}) })
    } else if (s.auth === 'bearer') needs.push({ key: `bearer:${s.name}`, text: `An access token for ${s.name}` })
    else if (s.auth === 'oauth') needs.push({ key: `oauth:${s.name}`, text: `You to sign in to ${s.name}` })
  }
  return needs
}

/** Where to get the runtime a blocked plugin or directory connector says it lacks, from main's sentence. */
export function runtimeLink(reason: string | null): RuntimeLink | null {
  if (!reason) return null
  if (/Node\.js/.test(reason)) return { runtime: 'node', href: 'https://nodejs.org', label: 'nodejs.org' }
  if (/Docker/.test(reason)) return { runtime: 'docker', href: 'https://www.docker.com', label: 'docker.com' }
  return null
}

export interface RuntimeLink {
  runtime: 'node' | 'docker'
  href: string
  label: string
}

/** "3 skills · 1 connector · hooks": a plugin's parts, one line per kind. */
function componentLines(entry: AgentDirectoryEntry): string[] {
  const c = entry.components
  if (!c) return []
  const lines: string[] = []
  const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`
  if (c.skills.length) lines.push(`${count(c.skills.length, 'skill', 'skills')}: ${c.skills.map((s) => s.name).join(', ')}`)
  if (c.mcpServers.length) {
    const server = (s: (typeof c.mcpServers)[number]): string => (s.runtime ? `${s.name} (${RUNTIME_LABEL[s.runtime]})` : s.name)
    lines.push(`${count(c.mcpServers.length, 'connector', 'connectors')}: ${c.mcpServers.map(server).join(', ')}`)
  }
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
  agentId,
  agentName,
  agentKit,
  agentEngine = null,
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
  agentId: string
  agentName: string
  agentKit: boolean
  /** The engine the agent runs on: "Works with" lists it first. */
  agentEngine?: AgentEngine | null
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
  const worksWith = worksWithLines(entry, agentEngine)
  // A runtime the blocked plugin or directory connector lacks is said once, beside its Add, with where to get it and
  // a Check again; not again under What it needs (a connector's needs list never names a runtime).
  const missingRuntime = state === 'blocked' ? runtimeLink(reason) : null
  const needs = pluginNeeds(entry).filter((need) => need.key !== missingRuntime?.runtime)
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
  if (flow.phase === 'pluginSetup') {
    action = <PluginSetup agentId={agentId} entryUuid={entry.ref.id} onDone={onSetupDone} onDirty={onStepDirty} onLater={onSetupLater} />
  } else if (flow.phase === 'setup') {
    const step = { next: flow.next, mcpProviderId: flow.mcpProviderId }
    action = (
      <SetupStep
        title={entry.title}
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
  } else if (flow.phase === 'starting') {
    action = (
      <StartingStep
        title={entry.title}
        mcpProviderIds={flow.mcpProviderIds}
        onDone={onSetupDone}
        onDirty={onStepDirty}
        onLater={onSetupLater}
        onClose={onClose}
      />
    )
  } else if (flow.phase === 'ready') {
    action = <ReadyLine onClose={onClose} />
  } else if (need && !resting) {
    action = (
      <>
        <SetupStep
          title={entry.title}
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
    const runtime = missingRuntime
    // Partly compatible still adds; the sentence says what this engine leaves out.
    const sentence = (blocked || state === 'partly_compatible') && reason ? reason : null
    action = (
      <>
        <div className="flex min-w-0 items-center gap-3">
          <button type="button" onClick={onAdd} disabled={blocked || busy} title={blocked && reason ? reason : undefined} className={`${PICKER_PRIMARY} shrink-0`}>
            {flow.phase === 'adding' && <Loader2 size={14} className="animate-spin" aria-hidden />}
            {flow.phase === 'adding' ? 'Adding…' : entry.kind === 'plugin' && entry.runsCode ? PICKER_TEXT.addRunsCode : PICKER_TEXT.addTo(agentName)}
          </button>
          {sentence && <span data-addon-state-reason className="min-w-0 text-[13px] text-[var(--color-text-muted)]">{sentence}</span>}
        </div>
        {runtime && <RuntimeHelp link={runtime} onLinkError={setLinkError} />}
      </>
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

      {worksWith.length > 0 && (
        <section className="mt-4" data-addon-works-with>
          <h4 className={SUBHEADING}>Works with</h4>
          <ul className="space-y-0.5 text-[13px] text-[var(--color-text)]">
            {worksWith.map((line) => (
              <li key={line.engine} data-engine={line.engine}>
                <span className="font-medium">{line.label}</span>: {line.text}
              </li>
            ))}
          </ul>
        </section>
      )}

      {(credentials.length > 0 || needsKit || setupNeed || needs.length > 0) && (
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
            {needs.map((need) => (
              <li key={need.key}>
                {need.text}
                {need.code?.map((name) => (
                  <code key={name} className="ml-1.5 rounded bg-[var(--color-bg-tertiary)] px-1.5 py-px font-mono text-[12px] text-[var(--color-text-secondary)]">
                    {name}
                  </code>
                ))}
              </li>
            ))}
            {needsKit && <li>{PICKER_TEXT.needsKit}</li>}
            {setupNeed && <li>{needLine(setupNeed)}</li>}
          </ul>
        </section>
      )}

      {/* A plugin's Add button carries it already ("Add — runs code on this computer"). */}
      {entry.runsCode && entry.kind !== 'plugin' && (
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
 * What a key or settings step holds typed: the token, the KEY=VALUE text
 * (`undefined` while untouched, so it follows the connector's row), and one
 * value per named setting of a connector whose values main keeps to itself
 * (`envSlots`). A caller whose step can unmount (a plugin row's collapse)
 * keeps it, so nothing typed is lost.
 */
export interface SetupDraft {
  token: string
  env?: string
  slots: Record<string, string>
}

export const EMPTY_SETUP_DRAFT: SetupDraft = { token: '', slots: {} }

/** The placeholder of a setting whose value main keeps: blank keeps it. */
export const ENV_SLOT_SAVED = 'Saved — leave blank to keep it'

/**
 * One password field per setting of a connector whose values main keeps to
 * itself (`envSlots`): never a stored value, only whether there is one ("Saved
 * — leave blank to keep it"); a field left empty keeps the stored value. Used
 * by the picker's settings step and by the connector's card in Settings → MCP.
 */
export function EnvSlotFields({
  idPrefix,
  slots,
  values,
  autoFocus = false,
  stacked = false,
  onChange
}: {
  /** Each name above its field, as the Settings → MCP card lays out its other fields; else a name column beside them. */
  stacked?: boolean
  /** Prefix of each input's id (`<prefix>-<NAME>`), unique to the surface that shows it. */
  idPrefix: string
  slots: ReadonlyArray<{ name: string; hasValue: boolean }>
  values: Record<string, string>
  /** Focus the first field when it appears. */
  autoFocus?: boolean
  onChange: (values: Record<string, string>) => void
}): React.JSX.Element {
  return (
    <div className={stacked ? 'space-y-1.5' : 'grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1.5'}>
      {slots.map((slot, index) => (
        <Fragment key={slot.name}>
          <label
            htmlFor={`${idPrefix}-${slot.name}`}
            className={`font-mono text-[12px] text-[var(--color-text-secondary)]${stacked ? ' -mb-1 block break-all' : ''}`}
          >
            {slot.name}
          </label>
          <input
            id={`${idPrefix}-${slot.name}`}
            type="password"
            autoFocus={autoFocus && index === 0}
            value={values[slot.name] ?? ''}
            onChange={(e) => onChange({ ...values, [slot.name]: e.target.value })}
            placeholder={slot.hasValue ? ENV_SLOT_SAVED : 'Value'}
            className={settingsInputClass}
          />
        </Fragment>
      ))}
    </div>
  )
}

/**
 * The step a connector needs after its add, in place of the Add button: sign
 * in (Connect opens the browser; the step waits for the connector to say it
 * is connected), paste an access token, or fill its settings. Uses the same
 * connect and save the connector's card in Settings → MCP does. A failure
 * stays here, under the control (rule 6).
 *
 * A connector whose values main keeps to itself (a plugin's, or one made from
 * a directory entry: `envSlots`) asks one field per name, never showing a
 * stored value; a field left empty keeps the one stored.
 */
export function SetupStep({
  title,
  next,
  mcpProviderId,
  message,
  added = false,
  draft,
  onDraftChange,
  onDone,
  onDirty,
  onLater,
  onMoved
}: {
  /** The connector's name, as the sentences say it. */
  title: string
  next: AddonNextStep
  mcpProviderId: string
  /** Why the connector did not connect (a `connect` step), from the add. */
  message?: string
  /** Shown for a connector added earlier, not as the step after this add: no "Added." in front. */
  added?: boolean
  /** What is typed, kept by the caller (with {@link onDraftChange}); the step keeps its own otherwise. */
  draft?: SetupDraft
  onDraftChange?: (draft: SetupDraft) => void
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
  const [ownDraft, setOwnDraft] = useState<SetupDraft>(EMPTY_SETUP_DRAFT)
  const current = draft ?? ownDraft
  const setDraft = (patch: Partial<SetupDraft>): void => (onDraftChange ?? setOwnDraft)({ ...current, ...patch })
  const token = current.token
  // The connector's names to fill in (a plugin's `LEDGER_TOKEN=`) arrive with its row; untouched, the field follows it.
  const storedEnv = formatEnvVars(provider?.env)
  const env = current.env ?? storedEnv
  const slots = provider?.envSlots ?? []
  const [error, setError] = useState<string | null>(null)
  const [asked, setAsked] = useState(false)

  // Typed input holds the picker's ways out; an empty or untouched field holds nothing (ux_rules rule 13).
  const dirty =
    next === 'bearer'
      ? token !== ''
      : next === 'env'
        ? slots.length > 0
          ? Object.values(current.slots).some((value) => value !== '')
          : env !== storedEnv
        : false
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
          {title} is turned off on this computer.
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
        <p className="mb-2 text-[13px] text-[var(--color-text)]">{lead}{title} is not connected yet.</p>
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
        <p className="mb-2 text-[13px] text-[var(--color-text)]">{lead}Sign in to {title} to finish.</p>
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
          {lead}Paste the access token for {title} to finish.
        </label>
        <div className="flex items-center gap-2">
          <input
            id="addon-setup-token"
            type="password"
            autoFocus
            value={token}
            onChange={(e) => setDraft({ token: e.target.value })}
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

  if (slots.length > 0) {
    // One field per name; a stored value is never shown, and a field left empty keeps it.
    return (
      <form
        data-addon-setup="env"
        aria-label={`Settings for ${title}`}
        onSubmit={(e) => {
          e.preventDefault()
          save({ env: Object.fromEntries(slots.map((slot) => [slot.name, current.slots[slot.name] ?? ''])) })
        }}
      >
        <p className="mb-1.5 text-[13px] text-[var(--color-text)]">
          {lead}Fill in the settings {title} needs to finish.
        </p>
        <EnvSlotFields
          idPrefix="addon-setup-env"
          slots={slots}
          values={current.slots}
          autoFocus
          onChange={(values) => setDraft({ slots: values })}
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

  return (
    <form
      data-addon-setup="env"
      onSubmit={(e) => {
        e.preventDefault()
        save({ env: parseEnvVars(env) })
      }}
    >
      <label htmlFor="addon-setup-env" className="mb-1 block text-[13px] text-[var(--color-text)]">
        {lead}Fill in the settings {title} needs (KEY=VALUE per line) to finish.
      </label>
      <textarea
        id="addon-setup-env"
        autoFocus
        rows={3}
        value={env}
        onChange={(e) => setDraft({ env: e.target.value })}
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

/**
 * Main's sentence for a missing runtime is above; this is where to get it and
 * how to say it is there now: Check again looks for Node.js and Docker again
 * and reads the directory again, so Add turns on without restarting the app.
 */
function RuntimeHelp({ link, onLinkError }: { link: RuntimeLink; onLinkError: (message: string | null) => void }): React.JSX.Element {
  const recheck = useRecheckRuntimes()
  // The last answer stays while the next check runs: the line does not come and go under the button.
  const stillMissing = recheck.data?.ok === true && !recheck.data[link.runtime]
  const failed = recheck.error ? unwrapIpcError(recheck.error) : null
  return (
    <div className="mt-2 text-[13px]">
      <div className="flex items-center gap-3">
        <a
          href={link.href}
          title={link.href}
          onClick={(e) => {
            e.preventDefault()
            onLinkError(null)
            void openExternalUrl(link.href, onLinkError)
          }}
          className="inline-flex items-center gap-1 font-medium text-[var(--color-accent)] hover:underline"
        >
          {link.label}
          <ExternalLink size={12} aria-hidden />
        </a>
        <button type="button" onClick={() => recheck.mutate()} disabled={recheck.isPending} className={PICKER_SECONDARY}>
          {recheck.isPending && <Loader2 size={14} className="animate-spin" aria-hidden />}
          {recheck.isPending ? PICKER_TEXT.checking : PICKER_TEXT.checkAgain}
        </button>
      </div>
      {(stillMissing || failed) && (
        <p role="status" data-addon-recheck className={`mt-2 ${failed ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-muted)]'}`}>
          {failed ?? PICKER_TEXT.stillMissing(link.runtime)}
        </p>
      )}
    </div>
  )
}

/**
 * After a plugin's add, its connectors' steps in place, one at a time: the
 * plugin's status names each managed connector and what it still needs
 * (values, a key, Turn on). Each step is the connector's own form; when none
 * is left, the plugin is ready in the next chat.
 */
/** "Ready in the next chat" and Done; "Starting…" in the same place while the add's connectors come up. */
function ReadyLine({ onClose, starting = false }: { onClose: () => void; starting?: boolean }): React.JSX.Element {
  // Done sits at the right edge, apart from the text: it never moves when "Starting…" turns into "Ready" (ux_rules rule 1).
  return (
    <div data-addon-ready-line className="flex items-center justify-between gap-3">
      {starting ? (
        <span role="status" data-addon-starting className="flex items-center gap-1.5 text-[13px] text-[var(--color-text-muted)]">
          <Loader2 size={14} className="animate-spin" aria-hidden />
          {PICKER_TEXT.starting}
        </span>
      ) : (
        <span role="status" className="flex items-center gap-1.5 text-[13px] text-[var(--color-success)]">
          <Check size={14} aria-hidden />
          {PICKER_TEXT.ready}
        </span>
      )}
      {/* "Done", not a second "Close" beside the header's (rule 10); closing never stops the start. */}
      <button type="button" onClick={onClose} className={`${PICKER_PRIMARY} shrink-0`}>
        Done
      </button>
    </div>
  )
}

/** How often the Starting step re-reads its connectors: a cancelled connect sends no status of its own. */
export const STARTING_POLL_MS = 2_000

const noop = (): void => {}

/**
 * The connectors a plugin's add started, until they are up: "Starting…" in
 * place of "Ready in the next chat", which follows once every one is
 * connected. One that fails — or whose connect ended without coming up
 * (cancelled: `disconnected`, no connect in flight) — shows the connect step
 * with its sentence and Connect.
 */
function StartingStep({
  title,
  mcpProviderIds,
  onDone,
  onDirty,
  onLater,
  onClose
}: {
  title: string
  mcpProviderIds: string[]
  onDone: () => void
  onDirty: (dirty: boolean) => void
  onLater: () => void
  onClose: () => void
}): React.JSX.Element {
  const { data: providers } = useMcpProviders()
  const queryClient = useQueryClient()
  // A connect that ended before this opened is read fresh, not from a list cached before the add.
  useEffect(() => {
    void queryClient.invalidateQueries({ queryKey: ['mcp-providers'] })
  }, [queryClient])
  const mine = mcpProviderIds.map((id) => providers?.find((provider) => provider.id === id) ?? null)
  // A connector not in the list yet (read before the add made it) is still starting.
  const allUp = mine.every((provider) => provider?.status === 'connected')
  useEffect(() => {
    if (allUp) onDone()
  }, [allUp, onDone])
  const failed =
    mine.find((provider) => provider?.status === 'error') ??
    mine.find((provider) => provider !== null && provider.status === 'disconnected' && !provider.connecting) ??
    null
  // Re-read while waiting: a connect that was cancelled publishes no status change.
  const waiting = !allUp && !failed
  useEffect(() => {
    if (!waiting) return
    const timer = window.setInterval(() => void queryClient.invalidateQueries({ queryKey: ['mcp-providers'] }), STARTING_POLL_MS)
    return () => window.clearInterval(timer)
  }, [waiting, queryClient])
  if (failed) {
    return (
      <SetupStep
        key={failed.id}
        title={mcpProviderIds.length > 1 ? failed.name : title}
        next="connect"
        mcpProviderId={failed.id}
        message={failed.error ?? undefined}
        onDone={noop}
        onDirty={onDirty}
        onLater={onLater}
      />
    )
  }
  return <ReadyLine onClose={onClose} starting />
}

function PluginSetup({
  agentId,
  entryUuid,
  onDone,
  onDirty,
  onLater
}: {
  agentId: string
  entryUuid: string
  onDone: () => void
  onDirty: (dirty: boolean) => void
  onLater: () => void
}): React.JSX.Element {
  const status = useAddonPluginStatus(agentId)
  const { refetch } = status
  // Stable: the step calls it from an effect each time it sees its connector connected.
  const reread = useCallback(() => void refetch(), [refetch])
  const plugin = status.data?.ok ? status.data.plugins.find((p) => p.entryUuid.toLowerCase() === entryUuid.toLowerCase()) : undefined
  const pending = plugin?.mcpServers.filter((server) => !server.disabled && !server.blocked && server.setup && server.mcpProviderId) ?? []
  const first = pending[0]
  const read = status.data !== undefined && !status.isFetching
  useEffect(() => {
    if (read && plugin && pending.length === 0) onDone()
  }, [read, plugin, pending.length, onDone])
  // Read, and refused or without this plugin: there is nothing to wait for. Main's sentence, and the way out.
  const refused = read && !plugin ? (status.data?.ok === false ? status.data.message : PICKER_TEXT.pluginSetupFailed) : status.error ? unwrapIpcError(status.error) : null
  if (refused) {
    return (
      <div data-addon-setup="plugin-refused">
        <p role="alert" className="mb-2 text-[13px] text-[var(--color-danger)]">
          {refused}
        </p>
        <button type="button" onClick={onLater} className={PICKER_SECONDARY}>
          {PICKER_TEXT.notNow}
        </button>
      </div>
    )
  }
  if (!first || !first.setup || !first.mcpProviderId) {
    return (
      <p role="status" className="flex items-center gap-1.5 text-[13px] text-[var(--color-text-muted)]">
        <Loader2 size={14} className="animate-spin" aria-hidden />
        {PICKER_TEXT.pluginSetupReading}
      </p>
    )
  }
  return (
    <SetupStep
      key={first.mcpProviderId}
      title={first.name}
      next={first.setup}
      mcpProviderId={first.mcpProviderId}
      onDone={reread}
      onDirty={onDirty}
      onLater={onLater}
      onMoved={reread}
    />
  )
}
