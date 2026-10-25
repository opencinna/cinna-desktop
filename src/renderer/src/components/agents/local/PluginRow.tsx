import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ArrowUpCircle, FolderOpen, Loader2, Trash2 } from 'lucide-react'
import type { McpProviderData } from '../../../../../preload'
import type { AddonNextStep } from '../../../../../shared/addons/directory'
import type { PluginDisabledInput, PluginPinStatus, PluginServerStatus } from '../../../../../shared/addons/plugins'
import { MARKETPLACE_SKILL_TEXT } from '../../../utils/marketplaceSkills'
import { AnimatedCollapse } from '../../ui/AnimatedCollapse'
import { CredentialStatusGlyph } from '../../settings/CredentialRow'
import type { CredentialHealth } from '../../settings/credentialPresentation'
import { mcpHealth } from '../../settings/mcpPresentation'
import { SettingsBadge, SettingsButton, SettingsIconButton, SettingsSwitch } from '../../settings/SettingsLayout'
import { AddonRow } from './AddonRow'
import { EMPTY_SETUP_DRAFT, SetupStep, type SetupDraft } from './AddonPickerDetail'
import { ADDONS_KEY } from '../../../hooks/useAddonDirectory'

export const PLUGIN_ROW_TEXT = {
  unavailable: 'No longer available to you',
  hooksBlocked: 'Blocked by your admin',
  updateTo: (plugin: string, version: string | null | undefined) =>
    version ? `Update ${plugin} to version ${version}` : `Update ${plugin} to the marketplace’s latest copy`,
  remove: (plugin: string) => `Remove ${plugin}`,
  reveal: (plugin: string) => `Show the files of ${plugin}`,
  agentsDetail: 'Run by Claude',
  removeConfirm: (plugin: string) =>
    `Remove ${plugin} from this agent? It stays in its marketplace; you can add it again. Its skills, commands, hooks and connectors stop being available to this agent in new chats.`,
  removeButton: 'Remove',
  removing: 'Removing…',
  cancel: 'Cancel',
  setUp: 'Set up',
  /** A managed connector's step, as a sentence on its line. */
  need: {
    oauth: 'Needs you to sign in',
    bearer: 'Needs an access token',
    env: 'Needs settings filled in',
    connect: 'Not connected',
    enable: 'Turned off on this computer'
  } satisfies Record<AddonNextStep, string>,
  connectorNeeds: (server: string, need: string) => `${server}: ${need.charAt(0).toLowerCase()}${need.slice(1)}`,
  ok: 'Every part of it reaches this agent'
} as const

const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/**
 * "1 skill · 2 agents · 3 hook events · 1 connector · 2 commands": what the
 * plugin carries, every part counted. A plugin whose hooks file registers no
 * event (or an agents folder main could not name) still says the part as a
 * word ("hooks", "agents"), never "0 hook events".
 */
export function pluginSummary(plugin: PluginPinStatus): string {
  const parts: string[] = []
  if (plugin.skills.length) parts.push(count(plugin.skills.length, 'skill', 'skills'))
  if (plugin.agents.length) parts.push(count(plugin.agents.length, 'agent', 'agents'))
  else if (plugin.hasAgents) parts.push('agents')
  if (plugin.hookEvents.length) parts.push(count(plugin.hookEvents.length, 'hook event', 'hook events'))
  else if (plugin.hasHooks) parts.push('hooks')
  if (plugin.mcpServers.length) parts.push(count(plugin.mcpServers.length, 'connector', 'connectors'))
  if (plugin.commands.length) parts.push(count(plugin.commands.length, 'command', 'commands'))
  return parts.join(' · ')
}

/** One of the row's lines under the summary; `part`: it is a connector's, which its own line says when the row is open. */
export interface PluginIssue {
  tone: 'error' | 'warning'
  text: string
  part?: boolean
}

/**
 * The plugin's problems, most serious first: what its warning lines say, and
 * what the glyph sums up. Partly compatible is not one: it is a fact of the
 * engine, said in a muted line of its own ({@link pluginFact}).
 */
export function pluginIssues(plugin: PluginPinStatus, providers?: readonly McpProviderData[]): PluginIssue[] {
  const issues: PluginIssue[] = []
  if (plugin.cache === 'failed') issues.push({ tone: 'error', text: plugin.cacheMessage ?? 'The copy on this computer could not be used.' })
  if (plugin.availability === 'unavailable') issues.push({ tone: 'warning', text: PLUGIN_ROW_TEXT.unavailable })
  for (const server of plugin.mcpServers) {
    if (server.disabled) continue
    if (server.blocked) issues.push({ tone: 'warning', part: true, text: PLUGIN_ROW_TEXT.connectorNeeds(server.name, server.blocked) })
    else if (server.setup) issues.push({ tone: 'warning', part: true, text: PLUGIN_ROW_TEXT.connectorNeeds(server.name, PLUGIN_ROW_TEXT.need[server.setup]) })
    else {
      const failed = connectorFailure(server, providers)
      // Refused with the plugin's own cache sentence (its files changed): said once, on the plugin's line above.
      if (failed && !(plugin.cache === 'failed' && failed === plugin.cacheMessage)) issues.push({ tone: 'error', part: true, text: PLUGIN_ROW_TEXT.connectorNeeds(server.name, failed) })
    }
  }
  if (plugin.compatibility.level === 'incompatible') issues.push({ tone: 'warning', text: plugin.compatibility.reason })
  return issues
}

/** A managed connector that is on, needs no step, and whose last connect failed: what its line says; null otherwise. */
function connectorFailure(server: PluginPinStatus['mcpServers'][number], providers: readonly McpProviderData[] | undefined): string | null {
  const provider = server.mcpProviderId ? providers?.find((p) => p.id === server.mcpProviderId) : undefined
  if (!provider) return null
  const health = mcpHealth(provider)
  return health.tone === 'error' ? health.label : null
}

/** What this engine leaves out of a partly compatible plugin, as a muted fact; null otherwise. */
export function pluginFact(plugin: PluginPinStatus): string | null {
  return plugin.compatibility.level === 'partly_compatible' ? plugin.compatibility.reason : null
}

/**
 * Whether the plugin counts toward the tab badge's problems: its copy here
 * cannot be used, it is no longer available, or a connector of it that is on
 * needs a step, is blocked, or failed to connect. Partly compatible is a fact of the engine, not
 * something to fix, and does not count.
 */
export function pluginHasProblem(plugin: PluginPinStatus, providers?: readonly McpProviderData[]): boolean {
  return (
    plugin.availability === 'unavailable' ||
    plugin.cache === 'failed' ||
    plugin.mcpServers.some((server) => !server.disabled && (!!server.blocked || !!server.setup || connectorFailure(server, providers) !== null))
  )
}

/** Whether the row goes to the top of the list: a problem, or an Update waiting. */
export function pluginNeedsAttention(plugin: PluginPinStatus, providers?: readonly McpProviderData[]): boolean {
  return plugin.availability === 'update_available' || pluginHasProblem(plugin, providers)
}

function pluginHealth(issues: readonly PluginIssue[], plugin: PluginPinStatus): CredentialHealth {
  const error = issues.find((issue) => issue.tone === 'error')
  if (error) return { tone: 'error', label: error.text }
  if (issues.length > 0) return { tone: 'warning', label: issues.map((issue) => issue.text).join('. ') }
  // Partly compatible is healthy: the glyph says what this engine takes, without a warning.
  return { tone: 'ok', label: pluginFact(plugin) ?? PLUGIN_ROW_TEXT.ok }
}

/** What a plugin row can do, owned by the tab so a verb in flight outlives the row's re-render. */
export interface PluginRowActions {
  /** Update and Remove are not the user's: the agent is shared with them to use only, or its access is not read yet. */
  readOnly: boolean
  busy: 'update' | 'remove' | 'parts' | null
  /** Another row's verb is running. */
  locked: boolean
  error: string | null
  confirming: boolean
  onUpdate: () => void
  onAskRemove: () => void
  onCancelRemove: () => void
  onRemove: () => void
  /** Write the pin's `disabled` (each key given replaces the pin's own). */
  onSetDisabled: (disabled: PluginDisabledInput) => void
  /** Show the plugin's copy on this computer in the file manager; a refusal is the row's {@link error}. */
  onReveal: () => void
}

/** A nested connector's in-place form: open or not, and what is typed in it — kept by the row, above its collapse. */
interface ConnectorSetup {
  open: boolean
  draft: SetupDraft
}

const CLOSED_SETUP: ConnectorSetup = { open: false, draft: EMPTY_SETUP_DRAFT }

const noop = (): void => undefined

/** One part of an expanded plugin: its name, what it says, and its switch. */
function PartLine({
  id,
  label,
  detail,
  glyph,
  checked,
  disabled,
  title,
  onToggle,
  children
}: {
  id: string
  label: React.ReactNode
  detail?: React.ReactNode
  glyph?: React.ReactNode
  checked: boolean
  disabled: boolean
  title: string
  onToggle: () => void
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <li className="py-1.5">
      <div className="flex min-h-7 items-center gap-2">
        {glyph}
        <label htmlFor={id} className="min-w-0 shrink truncate text-[13px] text-[var(--color-text)]">
          {label}
        </label>
        {detail && <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--color-text-muted)]">{detail}</span>}
        {!detail && <span className="flex-1" />}
        <SettingsSwitch id={id} checked={checked} disabled={disabled} onToggle={onToggle} title={title} />
      </div>
      {children}
    </li>
  )
}

/** A managed connector's line: its state, what it needs, and — for a value or a key — the form in place. */
function ConnectorPart({
  pluginName,
  server,
  provider,
  disabled,
  setup,
  onSetup,
  onToggle
}: {
  pluginName: string
  server: PluginServerStatus
  provider: McpProviderData | null
  disabled: boolean
  /** Its form, kept by the row so a collapse loses nothing typed. */
  setup: ConnectorSetup
  onSetup: (setup: ConnectorSetup) => void
  onToggle: () => void
}): React.JSX.Element {
  const queryClient = useQueryClient()
  const close = (): void => onSetup(CLOSED_SETUP)
  // Done: the plugin's status (and the directory) say where the connector stands now.
  const done = (): void => {
    close()
    void queryClient.invalidateQueries({ queryKey: ADDONS_KEY })
  }
  const on = !server.disabled
  const step = on && !server.blocked ? server.setup : undefined
  // A step the form can take here: values, a key, or Turn on. A sign-in or a connect is Settings → MCP's.
  const formStep = step === 'env' || step === 'bearer' || step === 'enable' ? step : undefined
  const need = server.blocked ?? (step ? PLUGIN_ROW_TEXT.need[step] : null)
  const health: CredentialHealth | null = !on
    ? null
    : server.blocked
      ? { tone: 'warning', label: server.blocked }
      : step
        ? { tone: 'warning', label: PLUGIN_ROW_TEXT.need[step] }
        : provider
          ? mcpHealth(provider)
          : null
  const id = `plugin-${pluginName}-mcp-${server.name}`
  return (
    <PartLine
      id={id}
      label={server.name}
      glyph={health ? <CredentialStatusGlyph health={health} size={12} /> : <span className="w-3 shrink-0" />}
      detail={
        need ? (
          <span className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 truncate" title={need}>{need}</span>
            {formStep && server.mcpProviderId && !setup.open && (
              <button
                type="button"
                onClick={() => onSetup({ ...setup, open: true })}
                aria-label={`Set up ${server.name}`}
                className="shrink-0 font-medium text-[var(--color-accent)] underline-offset-2 hover:underline"
              >
                {PLUGIN_ROW_TEXT.setUp}
              </button>
            )}
          </span>
        ) : (
          server.transport === 'stdio' ? 'Runs on this computer' : 'Remote server'
        )
      }
      checked={on}
      disabled={disabled}
      title={on ? `Turn ${server.name} off for this agent` : `Turn ${server.name} on for this agent`}
      onToggle={onToggle}
    >
      {setup.open && formStep && server.mcpProviderId && (
        <div data-plugin-setup={server.name} className="mt-2 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2.5">
          <SetupStep
            title={server.name}
            next={formStep}
            mcpProviderId={server.mcpProviderId}
            added
            draft={setup.draft}
            onDraftChange={(draft) => onSetup({ ...setup, draft })}
            onDone={done}
            onDirty={noop}
            onLater={() => onSetup({ ...setup, open: false })}
            onMoved={done}
          />
        </div>
      )}
    </PartLine>
  )
}

/**
 * One pinned marketplace plugin on the Addons tab, in the {@link AddonRow}
 * shell every addon shares (ux_rules rule 13): the kind, its title, its
 * version, the marketplace badge and the status glyph, with Update (when the
 * marketplace has a newer snapshot), Reveal (its copy on this computer) and
 * Remove as icon actions. A line says what it carries ("2 skills · 3 hook
 * events · 1 connector"), and its problems follow — no longer available, a
 * connector that needs a value, a copy on this computer that was changed —
 * below the parts when it is open, so a switch never moves when a line goes.
 * A connector's own problem is its line inside the open row, not a second
 * one under it.
 *
 * Expanded, each part has its switch, which writes the pin's `disabled`:
 * every skill, every managed connector — nested here, never a row of its own,
 * with the in-place form for a value or a key it still needs, whose input
 * outlives a collapse — and the hooks, whose switch is disabled with "Blocked
 * by your admin" when the admin forbids plugin hooks. Commands and agents are
 * listed; they have no switch of their own.
 */
export function PluginRow({
  plugin,
  providers,
  actions
}: {
  plugin: PluginPinStatus
  /** Settings → MCP's connectors, for each managed connector's live state. */
  providers: readonly McpProviderData[] | undefined
  actions: PluginRowActions
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [setups, setSetups] = useState<Record<string, ConnectorSetup>>({})
  const title = plugin.title || plugin.name
  const issues = pluginIssues(plugin, providers)
  // Open, a connector says its own problem on its line: the row does not say it again.
  const shownIssues = expanded ? issues.filter((issue) => !issue.part) : issues
  const fact = pluginFact(plugin)
  const summary = pluginSummary(plugin)
  const update = plugin.availability === 'update_available'
  const partsLocked = actions.busy !== null || actions.locked || actions.readOnly
  const offSkills = plugin.skills.filter((skill) => skill.disabled).map((skill) => skill.name)
  const offServers = plugin.mcpServers.filter((server) => server.disabled).map((server) => server.name)
  const toggled = (list: string[], name: string): string[] => (list.includes(name) ? list.filter((item) => item !== name) : [...list, name])
  const adminHooks = plugin.hooksBlockedByPolicy

  return (
    <AddonRow
      kind="plugin"
      title={title}
      version={plugin.version ? MARKETPLACE_SKILL_TEXT.version(plugin.version) : null}
      dataAttributes={{ 'data-plugin-row': plugin.name, 'data-plugin-availability': plugin.availability }}
      source={
        <SettingsBadge title={MARKETPLACE_SKILL_TEXT.fromTitle(plugin.marketplaceName)}>{MARKETPLACE_SKILL_TEXT.from(plugin.marketplaceName)}</SettingsBadge>
      }
      status={<CredentialStatusGlyph health={pluginHealth(issues, plugin)} />}
      expandable={{ expanded, onToggle: () => setExpanded((open) => !open) }}
      actions={
        <>
          {!actions.readOnly && update && (
            <SettingsIconButton
              onClick={actions.onUpdate}
              disabled={actions.busy !== null || actions.locked || actions.confirming}
              title={PLUGIN_ROW_TEXT.updateTo(title, plugin.latestVersion)}
              aria-label={PLUGIN_ROW_TEXT.updateTo(title, plugin.latestVersion)}
            >
              {actions.busy === 'update' ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <ArrowUpCircle size={14} />}
            </SettingsIconButton>
          )}
          {plugin.cache === 'ready' && (
            <SettingsIconButton onClick={actions.onReveal} title={PLUGIN_ROW_TEXT.reveal(title)} aria-label={PLUGIN_ROW_TEXT.reveal(title)}>
              <FolderOpen size={14} />
            </SettingsIconButton>
          )}
          {!actions.readOnly && (
            <SettingsIconButton
              danger
              onClick={actions.onAskRemove}
              disabled={actions.busy !== null || actions.locked || actions.confirming}
              title={PLUGIN_ROW_TEXT.remove(title)}
              aria-label={PLUGIN_ROW_TEXT.remove(title)}
            >
              <Trash2 size={14} />
            </SettingsIconButton>
          )}
        </>
      }
    >
      {(summary || fact) && (
        <div className="-mt-1 px-4 pb-2.5">
          {summary && (
            <p data-plugin-summary className="truncate text-[13px] text-[var(--color-text-secondary)]">
              {summary}
            </p>
          )}
          {fact && (
            <p data-plugin-fact className="truncate text-[13px] text-[var(--color-text-muted)]" title={fact}>
              {fact}
            </p>
          )}
        </div>
      )}
      <AnimatedCollapse open={expanded}>
        <div data-plugin-parts className="space-y-2 border-t border-[var(--color-border)] px-4 py-2.5">
          {plugin.skills.length > 0 && (
            <section aria-label={`Skills of ${title}`}>
              <h4 className="text-[12px] font-medium text-[var(--color-text-muted)]">Skills</h4>
              <ul>
                {plugin.skills.map((skill) => (
                  <PartLine
                    key={skill.name}
                    id={`plugin-${plugin.name}-skill-${skill.name}`}
                    label={skill.name}
                    detail={!skill.disabled && skill.reason ? <span className="text-[var(--color-warning)]" title={skill.reason}>{skill.reason}</span> : undefined}
                    checked={!skill.disabled}
                    disabled={partsLocked}
                    title={skill.disabled ? `Turn ${skill.name} on for this agent` : `Turn ${skill.name} off for this agent`}
                    onToggle={() => actions.onSetDisabled({ skills: toggled(offSkills, skill.name) })}
                  />
                ))}
              </ul>
            </section>
          )}
          {plugin.mcpServers.length > 0 && (
            <section aria-label={`Connectors of ${title}`}>
              <h4 className="text-[12px] font-medium text-[var(--color-text-muted)]">Connectors</h4>
              <ul>
                {plugin.mcpServers.map((server) => (
                  <ConnectorPart
                    key={server.name}
                    pluginName={plugin.name}
                    server={server}
                    provider={providers?.find((p) => p.id === server.mcpProviderId) ?? null}
                    disabled={partsLocked}
                    setup={setups[server.name] ?? CLOSED_SETUP}
                    onSetup={(setup) => setSetups((all) => ({ ...all, [server.name]: setup }))}
                    onToggle={() => actions.onSetDisabled({ mcpServers: toggled(offServers, server.name) })}
                  />
                ))}
              </ul>
            </section>
          )}
          {plugin.commands.length > 0 && (
            <p className="text-[13px] text-[var(--color-text)]">
              <span className="mr-1.5 text-[12px] font-medium text-[var(--color-text-muted)]">Commands</span>
              {plugin.commands.map((command, index) => (
                <span key={command}>
                  {index > 0 && ', '}
                  <code className="rounded bg-[var(--color-bg-tertiary)] px-1.5 py-px font-mono text-[12px] text-[var(--color-text-secondary)]">/{command}</code>
                </span>
              ))}
            </p>
          )}
          {plugin.hasAgents && (
            <p data-plugin-agents className="text-[13px] text-[var(--color-text)]">
              <span className="mr-1.5 text-[12px] font-medium text-[var(--color-text-muted)]">Agents</span>
              {plugin.agents.map((agent, index) => (
                <span key={agent}>
                  {index > 0 && ', '}
                  <code className="rounded bg-[var(--color-bg-tertiary)] px-1.5 py-px font-mono text-[12px] text-[var(--color-text-secondary)]">{agent}</code>
                </span>
              ))}
              <span className={`${plugin.agents.length ? 'ml-1.5 ' : ''}whitespace-nowrap text-[12px] text-[var(--color-text-muted)]`}>{PLUGIN_ROW_TEXT.agentsDetail}</span>
            </p>
          )}
          {plugin.hasHooks && (
            <section aria-label={`Hooks of ${title}`}>
              <ul>
                <PartLine
                  id={`plugin-${plugin.name}-hooks`}
                  label="Hooks"
                  detail={adminHooks ? PLUGIN_ROW_TEXT.hooksBlocked : !plugin.hooksDisabled && plugin.hooksReason ? plugin.hooksReason : undefined}
                  checked={!plugin.hooksDisabled && !adminHooks}
                  disabled={partsLocked || adminHooks}
                  title={adminHooks ? PLUGIN_ROW_TEXT.hooksBlocked : plugin.hooksDisabled ? `Turn the hooks of ${title} on` : `Turn the hooks of ${title} off`}
                  onToggle={() => actions.onSetDisabled({ hooks: !plugin.hooksDisabled })}
                >
                  {plugin.hookEvents.length > 0 && (
                    <p data-plugin-hook-events title={plugin.hookEvents.join(', ')} className="truncate pl-0.5 text-[12px] text-[var(--color-text-muted)]">
                      {plugin.hookEvents.join(', ')}
                    </p>
                  )}
                </PartLine>
              </ul>
            </section>
          )}
        </div>
      </AnimatedCollapse>
      {shownIssues.length > 0 && (
        <ul data-plugin-issues className="space-y-0.5 border-t border-[var(--color-border)] px-4 py-2 text-[13px]">
          {shownIssues.map((issue) => (
            <li key={issue.text} className={issue.tone === 'error' ? 'text-[var(--color-danger)]' : 'text-[var(--color-warning)]'}>
              {issue.text}
            </li>
          ))}
        </ul>
      )}
      <AnimatedCollapse open={actions.confirming}>
        <div role="group" aria-label={PLUGIN_ROW_TEXT.remove(title)} className="border-t border-[var(--color-border)] px-4 py-3">
          <p className="mb-3 text-[13px]">{PLUGIN_ROW_TEXT.removeConfirm(title)}</p>
          <div className="flex gap-2">
            <SettingsButton disabled={actions.busy === 'remove'} onClick={actions.onRemove}>
              {actions.busy === 'remove' ? PLUGIN_ROW_TEXT.removing : PLUGIN_ROW_TEXT.removeButton}
            </SettingsButton>
            <SettingsButton disabled={actions.busy === 'remove'} onClick={actions.onCancelRemove}>
              {PLUGIN_ROW_TEXT.cancel}
            </SettingsButton>
          </div>
        </div>
      </AnimatedCollapse>
      {actions.error && (
        <p role="alert" className="border-t border-[var(--color-border)] px-4 py-2 text-[13px] text-[var(--color-danger)]">
          {actions.error}
        </p>
      )}
    </AddonRow>
  )
}
