import { useRef, useState } from 'react'
import { Plus } from 'lucide-react'
import type { LocalAgentDto, LocalAgentSkill } from '../../../../../shared/localAgents'
import type { AddonKind } from '../../../../../shared/addons/directory'
import type { McpProviderData } from '../../../../../preload'
import { useAgentMcpProviders, useAttachAgentMcp, useDetachAgentMcp, useMcpProviders } from '../../../hooks/useMcp'
import { useOpenAgentPath } from '../../../hooks/useLocalAgents'
import { useListedShareStatus } from '../../../hooks/useSharing'
import {
  catalogSkillOutcomeMessage,
  useEnsureCatalogSkills,
  useRemoveCatalogSkill,
  useUpdateCatalogSkill
} from '../../../hooks/useCatalogSkills'
import {
  useEnsureMarketplaceSkills,
  useMarketplaceSkillStatus,
  useRemoveMarketplaceSkill,
  useUpdateMarketplaceSkill
} from '../../../hooks/useMarketplaceSkills'
import type { MarketplaceSkillPinStatus } from '../../../../../shared/marketplaceSkills'
import { unwrapIpcError } from '../../../utils/ipcError'
import { CATALOG_SKILL_TEXT, SKILL_SHARE_TEXT } from '../../../utils/catalogItems'
import { usePublishSkill } from '../../../hooks/useSkillPublish'
import type { SkillPublishInput } from '../../../../../shared/skillPublish'
import { ShareSkillDialog } from './ShareSkillDialog'
import { WhoCanUseSkillDialog } from './sharing/WhoCanUseSkillDialog'
import { MCPProviderCard } from '../../settings/MCPProviderCard'
import { SettingsButton, SettingsInfoTip, SettingsSection } from '../../settings/SettingsLayout'
import { mcpProblem } from '../../settings/mcpPresentation'
import { ADDON_KIND } from './AddonRow'
import { AddonPicker } from './AddonPicker'
import { SkillRow, needsAttention, type CatalogRowActions, type CatalogVerb } from './SkillRow'
import { PluginRow, pluginHasProblem, pluginNeedsAttention, type PluginRowActions } from './PluginRow'
import type { PluginPinStatus } from '../../../../../shared/addons/plugins'
import { DEFAULT_AGENT_ENGINE, effectiveEngine } from '../../../../../shared/engine'
import { useDefaultRuntime } from '../../../hooks/useEngine'
import {
  useAddonMcpRequirements,
  useAddonPluginStatus,
  useRemoveAddon,
  useRemoveRequirement,
  useRevealPlugin,
  useSetPluginDisabled,
  useUpdatePlugin
} from '../../../hooks/useAddonDirectory'
import type { AddonMcpRequirement, AddonRef } from '../../../../../shared/addons/directory'
import { RequirementRow, type RequirementRowActions } from './RequirementRow'

/** One row of the Addons tab's single list. */
export type AddonListItem =
  | { kind: 'skill'; key: string; title: string; skill: LocalAgentSkill }
  | { kind: 'mcp'; key: string; title: string; provider: McpProviderData }
  | { kind: 'plugin'; key: string; title: string; plugin: PluginPinStatus }
  /** A connector the manifest's `mcp_servers[]` names that this computer does not meet yet (a Connector row). */
  | { kind: 'requirement'; key: string; title: string; requirement: AddonMcpRequirement }

/** The kind a row is filtered and counted under: a manifest connector is a connector. */
export function addonItemKind(item: AddonListItem): AddonKind {
  return item.kind === 'requirement' ? 'mcp' : item.kind
}

/** The ref a plugin pin is added and removed by in the addon directory. */
export const PLUGIN_REF_SOURCE = 'core-marketplace-plugin'

/**
 * Everything the Addons tab lists, in one list: the attached connectors (in
 * attach order; a link whose connector is gone is never drawn — the delete
 * cascades, and the provider list may simply not have caught up), a kit
 * agent's skills and its pinned plugins, and the connectors its manifest
 * names (`mcp_servers[]`) that this computer does not meet yet. A connector a
 * plugin manages is drawn inside its plugin's row, never as a row of its own;
 * a manifest connector that is met is the connector's own row, and one whose
 * connector is attached already is that row too (never listed twice). The tab
 * and its badge count the same list.
 */
export function addonListItems(
  ids: readonly string[] | undefined,
  providers: readonly McpProviderData[] | undefined,
  skills: readonly LocalAgentSkill[] | undefined,
  plugins: readonly PluginPinStatus[] = [],
  requirements: readonly AddonMcpRequirement[] = []
): AddonListItem[] {
  const connectors: AddonListItem[] = (ids ?? []).flatMap((id) => {
    const provider = providers?.find((p) => p.id === id)
    return provider && !provider.managedBy ? [{ kind: 'mcp' as const, key: `mcp:${id}`, title: provider.name, provider }] : []
  })
  const pluginRows: AddonListItem[] = plugins.map((plugin) => ({ kind: 'plugin' as const, key: `plugin:${plugin.name}`, title: plugin.title || plugin.name, plugin }))
  // An own skill and a pin may share a name (an error the row shows), and so may two pins.
  const skillRows: AddonListItem[] = (skills ?? []).map((skill, index) => ({
    kind: 'skill' as const,
    key: `skill:${skill.source}:${skill.name}:${index}`,
    title: skill.source !== 'authored' && skill.title ? skill.title : skill.name,
    skill
  }))
  const shownIds = new Set(connectors.map((item) => (item.kind === 'mcp' ? item.provider.id : '')))
  const requirementRows: AddonListItem[] = requirements
    .filter((requirement) => requirement.state !== 'ready' && !(requirement.mcpProviderId && shownIds.has(requirement.mcpProviderId)))
    .map((requirement) => ({ kind: 'requirement' as const, key: `requirement:${requirement.name}`, title: requirement.name, requirement }))
  return [...connectors, ...skillRows, ...pluginRows, ...requirementRows]
}

/** Whether a row counts toward the tab badge's problems: a connector sessions run without, a skill with an issue, a plugin with a problem. */
function isProblem(item: AddonListItem, providers: readonly McpProviderData[] | undefined): boolean {
  if (item.kind === 'requirement') return true
  if (item.kind === 'plugin') return pluginHasProblem(item.plugin, providers)
  return item.kind === 'mcp' ? mcpProblem(item.provider) !== null : needsAttention(item.skill)
}

/** A kit agent's pinned plugins, once read; none while the read is out or refused. */
function pluginsOf(result: ReturnType<typeof useAddonPluginStatus>['data']): PluginPinStatus[] {
  return result?.ok ? result.plugins : []
}

/**
 * The Addons tab's count badge: everything the tab lists — attached connectors
 * and a kit agent's skills — and how many of them need attention: a connector
 * the agent's sessions are running without, or a skill with any issue (an
 * error keeps it from every engine; a warning is still worth a look). Shares
 * the tab's queries and the agent the page already holds, so it costs no
 * extra IPC. `skills` is the part of `count` that is skills.
 */
export function useAddonsBadge(
  agentId: string | null,
  agentSkills?: readonly LocalAgentSkill[]
): { count: number; problems: number; skills: number } {
  const { data: ids } = useAgentMcpProviders(agentId)
  const { data: providers } = useMcpProviders()
  // Only a kit agent pins plugins; the tab reads the same query.
  const { data: pluginStatus } = useAddonPluginStatus(agentId, { enabled: agentSkills !== undefined })
  const { data: requirements } = useAddonMcpRequirements(agentSkills !== undefined ? agentId : null)
  const items = addonListItems(ids, providers, agentSkills, pluginsOf(pluginStatus), requirements?.items)
  return {
    count: items.length,
    problems: items.filter((item) => isProblem(item, providers)).length,
    skills: items.filter((item) => item.kind === 'skill').length
  }
}

/**
 * The rows in "needs attention first, then by name" order, sorted only when
 * what is listed changes (the tab opens, an add or a remove lands, a list
 * arrives — `settled` flips once the slower reads are in) and otherwise kept:
 * a row whose state changes while the user works it stays where it is.
 */
export function useFrozenOrder(items: AddonListItem[], attention: (item: AddonListItem) => boolean, settled: boolean): AddonListItem[] {
  const frozen = useRef<{ signature: string; order: string[] } | null>(null)
  const signature = `${settled ? 1 : 0}|${items.map((item) => item.key).sort().join('\u0000')}`
  if (frozen.current?.signature !== signature) {
    const order = items
      .map((item) => ({ item, attention: attention(item) }))
      .sort((a, b) => Number(b.attention) - Number(a.attention) || a.item.title.localeCompare(b.item.title, undefined, { sensitivity: 'base' }))
      .map(({ item }) => item.key)
    frozen.current = { signature, order }
  }
  const byKey = new Map(items.map((item) => [item.key, item]))
  return frozen.current.order.flatMap((key) => byKey.get(key) ?? [])
}

/** Past this many rows the list is longer than a screen, and kind chips filter it. */
export const ADDON_FILTER_THRESHOLD = 8

const KIND_ORDER: AddonKind[] = ['skill', 'plugin', 'mcp']

const PLUGIN_TEXT = {
  updateFailed: 'The plugin could not be updated.',
  removeFailed: 'The plugin could not be removed.',
  partsFailed: 'The change could not be saved.',
  revealFailed: 'The plugin’s folder could not be shown.',
  requirementRemoveFailed: 'It could not be removed from cinna-agent.json.'
} as const

/**
 * What a local agent runs with beyond its own instructions, as one list:
 * MCP connectors and a kit agent's skills (plugins join in U3), each in the
 * same {@link AddonRow} shell, needing-attention first and then by name, and
 * one **Add** that opens the {@link AddonPicker} over every source.
 *
 * A connector listed here is the same record Settings → MCP lists, with the
 * same toggle and edit form: changing it here changes it everywhere. Detach
 * only removes the link to this agent.
 */
export function AgentAddonsTab({
  agent,
  onFinishSetup
}: {
  agent: LocalAgentDto
  /** Opens the agent's Finish setting up dialog, which the page owns. */
  onFinishSetup?: () => void
}): React.JSX.Element {
  const { data: ids, error: idsError } = useAgentMcpProviders(agent.id)
  const { data: providers } = useMcpProviders()
  // Owned here, not in the modal: an attach outlives the modal closing.
  const attach = useAttachAgentMcp()
  const detach = useDetachAgentMcp()
  const openPath = useOpenAgentPath()
  // Open, and at which entry: a manifest connector's Set up opens it straight at that entry's detail.
  const [picking, setPicking] = useState<false | { initial?: { ref: AddonRef | null; query: string } }>(false)
  // The engine the agent runs on, as the launcher decides it: a plugin's "Works with" lists it first.
  const { data: defaultRuntime } = useDefaultRuntime()
  const engine = effectiveEngine(agent.runtime, defaultRuntime?.engine ?? DEFAULT_AGENT_ENGINE)
  const [kindFilter, setKindFilter] = useState<AddonKind | 'all'>('all')
  // A failed Detach is shown in that connector's card (rule 6).
  const [detachError, setDetachError] = useState<{ id: string; message: string } | null>(null)
  // A failed reveal is shown in the card of the skill it was for (rule 6).
  const [revealError, setRevealError] = useState<{ skill: string; message: string } | null>(null)
  // Catalog rows: owned here, so a verb in flight outlives the row's re-render
  // when the rescan it causes lands (rule 5).
  const updateSkill = useUpdateCatalogSkill()
  const ensureSkills = useEnsureCatalogSkills()
  const removeSkill = useRemoveCatalogSkill()
  // Marketplace rows: the same, over their own verbs, and where each pin stands.
  const updateMarketplaceSkill = useUpdateMarketplaceSkill()
  const ensureMarketplaceSkills = useEnsureMarketplaceSkills()
  const removeMarketplaceSkill = useRemoveMarketplaceSkill()
  const marketplaceStatus = useMarketplaceSkillStatus(agent.id, agent.skills)
  const statusOf = (skill: LocalAgentSkill): MarketplaceSkillPinStatus | null => {
    const result = marketplaceStatus.data
    return result?.ok ? (result.pins.find((pin) => pin.name === skill.name) ?? null) : null
  }
  // Plugin rows: the pins' status, and their verbs owned here like the skill rows' (rule 5).
  const pluginStatus = useAddonPluginStatus(agent.id, { enabled: agent.skills !== undefined })
  // The connectors the manifest names (`mcp_servers[]`), as this computer meets them; a kit agent only.
  const requirements = useAddonMcpRequirements(agent.skills !== undefined ? agent.id : null)
  const setPluginDisabled = useSetPluginDisabled()
  const updatePlugin = useUpdatePlugin()
  const removeAddon = useRemoveAddon()
  const [pluginBusy, setPluginBusy] = useState<{ name: string; verb: 'update' | 'remove' | 'parts' } | null>(null)
  const [pluginError, setPluginError] = useState<{ name: string; message: string } | null>(null)
  const [confirmingPlugin, setConfirmingPlugin] = useState<string | null>(null)
  const revealPlugin = useRevealPlugin()
  // Manifest connectors: removing one from `mcp_servers[]`, owned here like the rows' other verbs (rule 5).
  const removeRequirement = useRemoveRequirement()
  const [requirementBusy, setRequirementBusy] = useState<string | null>(null)
  const [requirementError, setRequirementError] = useState<{ name: string; message: string } | null>(null)
  const [confirmingRequirement, setConfirmingRequirement] = useState<string | null>(null)
  const runPluginVerb = (
    name: string,
    verb: 'update' | 'remove' | 'parts',
    run: () => Promise<{ ok: true } | { ok: false; message: string }>,
    fallback: string
  ): void => {
    if (pluginBusy) return
    setPluginError(null)
    setPluginBusy({ name, verb })
    run()
      .then((result) => {
        if (!result.ok) setPluginError({ name, message: result.message || fallback })
        else if (verb === 'remove') setConfirmingPlugin(null)
      })
      .catch((err) => setPluginError({ name, message: unwrapIpcError(err, fallback) }))
      .finally(() => setPluginBusy(null))
  }
  const [skillBusy, setSkillBusy] = useState<{ name: string; verb: CatalogVerb } | null>(null)
  const [skillError, setSkillError] = useState<{ name: string; message: string } | null>(null)
  const [confirmingRemove, setConfirmingRemove] = useState<string | null>(null)
  // Share a skill: owned here, so the share outlives its dialog (rule 5); the
  // dialog closes on success only and shows a refusal itself (rule 6).
  const publishSkill = usePublishSkill()
  const [sharingSkill, setSharingSkill] = useState<string | null>(null)
  const [shareError, setShareError] = useState<string | null>(null)
  // Who can use a shared skill: the dialog owns its own write and closes on Close only.
  const [peopleOf, setPeopleOf] = useState<{ uuid: string; name: string } | null>(null)
  const sharingRow = sharingSkill ? (agent.skills ?? []).find((skill) => skill.source === 'authored' && skill.name === sharingSkill) ?? null : null
  const shareSkill = (input: SkillPublishInput): void => {
    if (publishSkill.isPending) return
    setShareError(null)
    publishSkill
      .mutateAsync(input)
      .then((result) => {
        if (result.ok) setSharingSkill((current) => (current === input.name ? null : current))
        else setShareError(result.message || SKILL_SHARE_TEXT.shareFailed)
      })
      .catch((err) => setShareError(unwrapIpcError(err, SKILL_SHARE_TEXT.shareFailed)))
  }
  // As main's `changeableFromLink`: while the share status is not read yet,
  // and on a Cinna team agent without edit or maintain (or whose access the
  // listing does not know), Update and Remove are not offered.
  const shareStatus = useListedShareStatus(agent.id)
  const readOnly =
    shareStatus === undefined ||
    (shareStatus !== null &&
      shareStatus.remote.kind === 'cinna' &&
      shareStatus.remote.access !== 'edit' &&
      shareStatus.remote.access !== 'maintain')
  const sharedEditable = !readOnly && shareStatus != null
  // A pin is the agent's to change: on a team agent shared to use only, the picker offers no skill.
  const skillBlock = shareStatus === undefined ? CATALOG_SKILL_TEXT.checkingAccess : readOnly ? CATALOG_SKILL_TEXT.canUseOnlyTitle : null

  const runSkillVerb = (
    name: string,
    verb: CatalogVerb,
    run: () => Promise<{ ok: true } | { ok: false; message: string }>,
    fallback: string
  ): void => {
    if (skillBusy) return
    setSkillError(null)
    setSkillBusy({ name, verb })
    run()
      .then((result) => {
        if (!result.ok) setSkillError({ name, message: catalogSkillOutcomeMessage(result, fallback) })
        else if (verb === 'remove') setConfirmingRemove(null)
      })
      .catch((err) => setSkillError({ name, message: unwrapIpcError(err, fallback) }))
      .finally(() => setSkillBusy(null))
  }

  const catalogActionsFor = (skill: LocalAgentSkill): CatalogRowActions => {
    // A catalog pin and a marketplace pin may share a name (an error the row shows): each row is its own.
    const key = `${skill.source}:${skill.name}`
    const fromMarketplace = skill.source === 'marketplace'
    const update = (): Promise<{ ok: true } | { ok: false; message: string }> =>
      fromMarketplace
        ? updateMarketplaceSkill.mutateAsync({ agentId: agent.id, name: skill.name })
        : updateSkill.mutateAsync({ agentId: agent.id, name: skill.name })
    const ensure = (): Promise<{ ok: true; failed: { name: string; message: string }[] } | { ok: false; message: string }> =>
      fromMarketplace ? ensureMarketplaceSkills.mutateAsync({ agentId: agent.id }) : ensureSkills.mutateAsync({ agentId: agent.id })
    const remove = (): Promise<{ ok: true } | { ok: false; message: string }> =>
      fromMarketplace
        ? removeMarketplaceSkill.mutateAsync({ agentId: agent.id, name: skill.name })
        : removeSkill.mutateAsync({ agentId: agent.id, name: skill.name })
    return {
      readOnly,
      sharedEditable,
      busy: skillBusy?.name === key ? skillBusy.verb : null,
      locked: skillBusy !== null && skillBusy.name !== key,
      error: skillError?.name === key ? skillError.message : null,
      confirming: confirmingRemove === key,
      onUpdate: () => runSkillVerb(key, 'update', update, CATALOG_SKILL_TEXT.updateFailed),
      onEnsure: () =>
        runSkillVerb(
          key,
          'ensure',
          async () => {
            const result = await ensure()
            if (!result.ok) return result
            // One fetch covers every pin; this row's answer is its own failure, if any.
            const failed = result.failed.find((failure) => failure.name === skill.name)
            return failed ? { ok: false as const, message: failed.message } : { ok: true as const }
          },
          CATALOG_SKILL_TEXT.tryAgainFailed
        ),
      onCheck: () =>
        runSkillVerb(
          key,
          'ensure',
          async () => {
            const result = await ensure()
            // This row's own refusal is its state after the rescan, not an error line.
            return result.ok ? { ok: true as const } : result
          },
          CATALOG_SKILL_TEXT.tryAgainFailed
        ),
      onAskRemove: () => {
        setSkillError(null)
        setConfirmingRemove(key)
      },
      onCancelRemove: () => setConfirmingRemove(null),
      onRemove: () => runSkillVerb(key, 'remove', remove, CATALOG_SKILL_TEXT.removeFailed)
    }
  }

  const pluginActionsFor = (plugin: PluginPinStatus): PluginRowActions => {
    const ref = { source: PLUGIN_REF_SOURCE, id: plugin.entryUuid }
    const busy = pluginBusy?.name === plugin.name ? pluginBusy.verb : null
    return {
      readOnly,
      busy,
      locked: pluginBusy !== null && busy === null,
      error: pluginError?.name === plugin.name ? pluginError.message : null,
      confirming: confirmingPlugin === plugin.name,
      onUpdate: () =>
        runPluginVerb(plugin.name, 'update', () => updatePlugin.mutateAsync({ agentId: agent.id, name: plugin.name }), PLUGIN_TEXT.updateFailed),
      onAskRemove: () => {
        setPluginError(null)
        setConfirmingPlugin(plugin.name)
      },
      onCancelRemove: () => setConfirmingPlugin(null),
      onRemove: () =>
        runPluginVerb(plugin.name, 'remove', () => removeAddon.mutateAsync({ agentId: agent.id, ref }), PLUGIN_TEXT.removeFailed),
      onSetDisabled: (disabled) =>
        runPluginVerb(
          plugin.name,
          'parts',
          () => setPluginDisabled.mutateAsync({ agentId: agent.id, name: plugin.name, disabled }),
          PLUGIN_TEXT.partsFailed
        ),
      onReveal: () => {
        setPluginError(null)
        revealPlugin
          .mutateAsync({ agentId: agent.id, name: plugin.name })
          .then((result) => {
            if (!result.ok) setPluginError({ name: plugin.name, message: result.message || PLUGIN_TEXT.revealFailed })
          })
          .catch((err) => setPluginError({ name: plugin.name, message: unwrapIpcError(err, PLUGIN_TEXT.revealFailed) }))
      }
    }
  }

  const requirementActionsFor = (requirement: AddonMcpRequirement): RequirementRowActions => ({
    readOnly,
    busy: requirementBusy === requirement.name,
    error: requirementError?.name === requirement.name ? requirementError.message : null,
    confirming: confirmingRequirement === requirement.name,
    // From its directory entry when one lists it; a custom one at Custom connector…, its name filled in.
    onSetUp: () =>
      setPicking({
        initial: {
          ref: requirement.entryRef,
          query: requirement.name,
          ...(requirement.ref === null && requirement.entryRef === null ? { custom: { name: requirement.name, transport: requirement.transport } } : {})
        }
      }),
    onAskRemove: () => {
      setRequirementError(null)
      setConfirmingRequirement(requirement.name)
    },
    onCancelRemove: () => setConfirmingRequirement(null),
    onRemove: () => {
      if (requirementBusy) return
      const name = requirement.name
      setRequirementError(null)
      setRequirementBusy(name)
      removeRequirement
        .mutateAsync({ agentId: agent.id, name })
        .then((result) => {
          if (result.ok) setConfirmingRequirement(null)
          else setRequirementError({ name, message: result.message || PLUGIN_TEXT.requirementRemoveFailed })
        })
        .catch((err) => setRequirementError({ name, message: unwrapIpcError(err, PLUGIN_TEXT.requirementRemoveFailed) }))
        .finally(() => setRequirementBusy(null))
    }
  })

  const items = addonListItems(ids, providers, agent.skills, pluginsOf(pluginStatus.data), requirements.data?.items)
  const attention = (item: AddonListItem): boolean => {
    if (item.kind === 'requirement') return true
    if (item.kind === 'mcp') return mcpProblem(item.provider) !== null
    if (item.kind === 'plugin') return pluginNeedsAttention(item.plugin, providers)
    const skill = item.skill
    if (needsAttention(skill) || skill.updatable) return true
    const status = skill.source === 'marketplace' ? statusOf(skill) : null
    return status?.state === 'update_available' || status?.state === 'unavailable'
  }
  // Needs attention first (setup, update, unavailable, not connected), then by name — decided when
  // the tab opens and when an add or a remove changes what is listed, never while the user works a
  // row: a toggle, an update or a connect does not move the row from under the pointer (rule 1).
  const sorted = useFrozenOrder(items, attention, marketplaceStatus.data !== undefined)
  const kinds = KIND_ORDER.filter((kind) => items.some((item) => addonItemKind(item) === kind))
  const filtering = items.length > ADDON_FILTER_THRESHOLD && kinds.length > 1
  const filter = filtering && kinds.includes(kindFilter as AddonKind) ? kindFilter : 'all'
  const shown = filter === 'all' ? sorted : sorted.filter((item) => addonItemKind(item) === filter)

  const skillRow = (skill: LocalAgentSkill): React.JSX.Element => (
    <SkillRow
      skill={skill}
      revealError={revealError?.skill === skill.name ? revealError.message : null}
      catalogActions={skill.source !== 'authored' ? catalogActionsFor(skill) : undefined}
      marketplaceStatus={skill.source === 'marketplace' ? statusOf(skill) : undefined}
      onFinishSetup={onFinishSetup}
      onShare={
        skill.source === 'authored'
          ? () => {
              setShareError(null)
              setSharingSkill(skill.name)
            }
          : undefined
      }
      onWhoCanUse={
        skill.source === 'authored' && skill.shared
          ? () => setPeopleOf({ uuid: skill.shared!.packageUuid, name: skill.name })
          : undefined
      }
      onReveal={() => {
        setRevealError(null)
        const missing = skill.issues.some((issue) => issue.code === 'missing_skill_md' || issue.code === 'not_a_directory')
        openPath.mutate(
          { agentId: agent.id, relPath: missing ? `skills/${skill.name}` : skill.path },
          { onError: (e) => setRevealError({ skill: skill.name, message: unwrapIpcError(e) }) }
        )
      }}
    />
  )

  return (
    <div className="space-y-4 text-[13px]">
      <SettingsSection
        title="Addons"
        info={
          <SettingsInfoTip label="About addons">
            <p>Everything this agent runs with beyond its own instructions: MCP connectors and{agent.skills ? ' skills' : ', on an agent with a cinna-agent.json, skills'}. Every session of this agent gets them — its own chats, scheduled jobs, task runs, and runs where another agent calls it.</p>
            <p className="mt-2">Connectors run in Cinna, which keeps their sign-in; the agent’s runtime reaches them through Cinna and never sees a token. A connector that is not connected when a session starts is left out of that session. Each one is also listed in Settings → MCP; Detach removes it from this agent only.</p>
            {agent.skills && (
              <>
                <p className="mt-2">A skill is a folder under <code>skills/</code> in this agent’s folder, with a <code>SKILL.md</code> whose name matches the folder and which says what the skill is for. Claude and OpenCode load skills as skills; Codex is told where each one’s SKILL.md is. A skill with an error is left out of every session until its SKILL.md is fixed.</p>
                <p className="mt-2">A skill from the catalog, or from a skills marketplace an admin connected in Cinna, is pinned in <code>cinna-agent.json</code> rather than kept in the folder. Cinna downloads the pinned version once and gives it to every session. A marketplace skill offers Update when its marketplace has a newer copy; one that is no longer available to you keeps working from the copy on this computer.</p>
                <p className="mt-2">A plugin from a marketplace is pinned the same way and brings several parts: skills, commands, hooks and connectors. Open its row to turn a part off for this agent. Its connectors are set up here, inside the plugin, and Remove takes them away with it.</p>
              </>
            )}
            <p className="mt-2">Add searches every source you may use: Cinna’s catalog and marketplaces, the connectors on this computer and the public MCP registries.</p>
          </SettingsInfoTip>
        }
        action={
          <SettingsButton onClick={() => setPicking({})} title={agent.skills ? 'Add a skill, a plugin or a connector' : 'Add a connector'}>
            <Plus size={14} />
            Add
          </SettingsButton>
        }
      >
        {filtering && (
          <div role="group" aria-label="Show addons of kind" className="flex flex-wrap gap-1.5">
            {(['all', ...kinds] as const).map((kind) => {
              const label = kind === 'all' ? 'All' : ADDON_KIND[kind].plural
              const count = kind === 'all' ? items.length : items.filter((item) => addonItemKind(item) === kind).length
              return (
                <button
                  key={kind}
                  type="button"
                  aria-pressed={filter === kind}
                  onClick={() => setKindFilter(kind)}
                  className={`rounded-full border px-2.5 py-0.5 text-[12px] font-medium transition-colors ${
                    filter === kind
                      ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/10 text-[var(--color-text)]'
                      : 'border-[var(--color-border)] text-[var(--color-text-secondary)] hover:text-[var(--color-text)]'
                  }`}
                >
                  {label} <span className="text-[var(--color-text-muted)]">{count}</span>
                </button>
              )
            })}
          </div>
        )}
        {items.length === 0 && ids !== undefined && <p className="text-[var(--color-text-muted)]">No addons yet.</p>}
        {shown.length > 0 && (
          <ul className="space-y-2">
            {shown.map((item) => (
              <li key={item.key}>
                {item.kind === 'skill' ? (
                  skillRow(item.skill)
                ) : item.kind === 'plugin' ? (
                  <PluginRow plugin={item.plugin} providers={providers} actions={pluginActionsFor(item.plugin)} />
                ) : item.kind === 'requirement' ? (
                  <RequirementRow requirement={item.requirement} actions={requirementActionsFor(item.requirement)} />
                ) : (
                  <MCPProviderCard
                    provider={item.provider}
                    detach={{
                      pending: detach.isPending && detach.variables?.mcpProviderId === item.provider.id,
                      error: detachError?.id === item.provider.id ? detachError.message : null,
                      onDetach: () => {
                        if (detach.isPending) return
                        setDetachError(null)
                        detach
                          .mutateAsync({ agentId: agent.id, mcpProviderId: item.provider.id })
                          .catch((e) => setDetachError({ id: item.provider.id, message: unwrapIpcError(e) }))
                      }
                    }}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </SettingsSection>
      {idsError && (
        <p role="alert" className="text-[var(--color-danger)]">{unwrapIpcError(idsError)}</p>
      )}
      {pluginStatus.data && !pluginStatus.data.ok && (
        <p role="alert" className="text-[var(--color-danger)]">{pluginStatus.data.message}</p>
      )}
      {sharingRow && (
        <ShareSkillDialog
          // A new dialog per skill: its preview and choices belong to that skill.
          key={sharingRow.name}
          agentId={agent.id}
          skill={sharingRow}
          pending={publishSkill.isPending}
          error={shareError}
          onShare={shareSkill}
          onCancel={() => {
            if (publishSkill.isPending) return
            setSharingSkill(null)
            setShareError(null)
          }}
        />
      )}
      {peopleOf && (
        <WhoCanUseSkillDialog
          key={peopleOf.uuid}
          itemUuid={peopleOf.uuid}
          skillName={peopleOf.name}
          onClose={() => setPeopleOf(null)}
        />
      )}
      {picking && (
        <AddonPicker
          initial={picking.initial}
          agent={{ id: agent.id, name: agent.name, kit: agent.skills !== undefined, engine }}
          skillBlock={skillBlock}
          onClose={() => setPicking(false)}
          onAttachCreated={async (mcpProviderId) => {
            await attach.mutateAsync({ agentId: agent.id, mcpProviderId })
          }}
        />
      )}
    </div>
  )
}
