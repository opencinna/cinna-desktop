import { useMemo } from 'react'
import type { UseQueryResult } from '@tanstack/react-query'
import { useCatalogItems } from './useCatalog'
import { useAgents } from './useAgents'
import { useLocalAgents } from './useLocalAgents'
import { useShareStatuses, useTeamLibrary } from './useSharing'
import type { CatalogItem, CatalogItemsListing } from '../../../shared/catalogItems'
import type { AgentShareStatus, LibraryAgentDto, LibraryListingDto } from '../../../shared/agentSharing'
import type { LocalAgentDto } from '../../../shared/localAgents'
import type { CatalogEntryView } from '../components/agents/CatalogItemViews'
import type { CatalogSkillTarget } from '../components/agents/CatalogSkillAddMenu'
import {
  catalogCredentialSpecs,
  catalogItemKind,
  catalogItemName,
  catalogItemPeople,
  catalogVersionLabel,
  cloudInstallOf,
  skillHostManifestIds
} from '../utils/catalogItems'

type AgentRow = Awaited<ReturnType<typeof window.api.agents.list>>[number]

/** What {@link catalogEntryViews} joins: the listing and this computer's side of each item. */
export interface CatalogEntrySources {
  items: CatalogItem[]
  /** The team-sharing entries, each with this computer's copy of a desktop agent. */
  library: LibraryAgentDto[]
  agents: Pick<AgentRow, 'id' | 'remoteTargetId' | 'remoteMetadata'>[]
  localAgents: Pick<LocalAgentDto, 'id' | 'name' | 'manifestId' | 'skills'>[]
  /** Undefined while the statuses load: a skill's targets then say `checking`. */
  shareStatuses: Pick<AgentShareStatus, 'agentId' | 'remote'>[] | undefined
}

/**
 * Every catalog item as the catalog shows it, joined from the listing, the
 * team's copies and the agent rows: a cloud agent's install and whether it is
 * behind, a desktop agent's team entry, and which of this computer's agents
 * pin a skill or could take it.
 */
export function catalogEntryViews({
  items,
  library,
  agents,
  localAgents,
  shareStatuses
}: CatalogEntrySources): CatalogEntryView[] {
  const libraryByUuid = new Map<string, LibraryAgentDto>(library.map((agent) => [agent.uuid, agent]))
  const agentByInstall = new Map<string, CatalogEntrySources['agents'][number]>()
  for (const agent of agents) if (agent.remoteTargetId) agentByInstall.set(agent.remoteTargetId, agent)
  const localByManifest = new Map<string, { id: string; name: string }>()
  for (const agent of localAgents) {
    if (agent.manifestId) localByManifest.set(agent.manifestId.toLowerCase(), { id: agent.id, name: agent.name })
  }
  // As main's `changeableFromLink`: a Cinna team agent counts only with
  // edit or maintain; access the listing does not know is not a yes.
  const readOnly = new Set(
    (shareStatuses ?? [])
      .filter((status) => status.remote.kind === 'cinna' && status.remote.access !== 'edit' && status.remote.access !== 'maintain')
      .map((status) => status.agentId)
  )
  // Kit agents only: a bare folder has no cinna-agent.json to pin a skill in,
  // and its DTO carries no `skills`.
  const kitAgents = localAgents.filter((agent) => agent.skills !== undefined)
  const pinsPackage = (agent: (typeof kitAgents)[number], uuid: string): boolean =>
    (agent.skills ?? []).some(
      (skill) => skill.source === 'catalog' && (skill.packageUuid ?? '').toLowerCase() === uuid.toLowerCase()
    )
  /**
   * The agents that pin a skill. An agent on this computer counts by its
   * own pins alone — they move the moment an add or a Remove lands, before
   * the report reaches core. The server's local installs count only for a
   * manifest id no agent here has (another device's copy is not listed;
   * one of ours that core still holds after a Remove is not either).
   */
  const usedByOf = (item: CatalogItem): string[] => {
    const byId = new Map<string, string>()
    for (const id of skillHostManifestIds(item)) {
      const agent = localByManifest.get(id)
      if (agent && !kitAgents.some((kit) => kit.id === agent.id)) byId.set(agent.id, agent.name)
    }
    for (const agent of kitAgents) if (pinsPackage(agent, item.uuid)) byId.set(agent.id, agent.name)
    return [...byId.values()]
  }
  const targetsOf = (item: CatalogItem): CatalogSkillTarget[] =>
    kitAgents
      .map((agent): CatalogSkillTarget => ({
        agentId: agent.id,
        name: agent.name,
        blocked: pinsPackage(agent, item.uuid)
          ? 'added'
          : shareStatuses === undefined
            ? 'checking'
            : readOnly.has(agent.id)
              ? 'read_only'
              : null
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
  return items.map((item: CatalogItem): CatalogEntryView => {
    const kind = catalogItemKind(item)
    const latest = item.latest
    let cloud: CatalogEntryView['cloud'] = null
    if (kind === 'cloud_agent') {
      const install = cloudInstallOf(item, (installId) => agentByInstall.has(installId))
      const installId = install?.install_id ?? null
      const row = installId ? agentByInstall.get(installId) : undefined
      // The server's own answer, once the agent has synced; the listing's numbers before that.
      const bundleVersion = row?.remoteMetadata?.bundle_version
      const updateAvailable = bundleVersion
        ? Boolean(bundleVersion.update_available)
        : !!latest && install?.revision_number != null && install.revision_number < latest.revision_number
      cloud = { installId, agentId: row?.id ?? null, updateAvailable: installId !== null && updateAvailable }
    }
    return {
      item,
      kind,
      name: catalogItemName(item),
      people: catalogItemPeople(item),
      version: latest ? catalogVersionLabel(latest.revision_number, latest.version) : null,
      specs: catalogCredentialSpecs(item),
      cloud,
      desktop: kind === 'desktop_agent' ? (libraryByUuid.get(item.uuid) ?? null) : null,
      usedBy: kind === 'skill' ? usedByOf(item) : [],
      skillTargets: kind === 'skill' ? targetsOf(item) : []
    }
  })
}

export interface CatalogEntries {
  /** Main's cached listing: loading, failure and Refresh state for the surface. */
  catalog: UseQueryResult<CatalogItemsListing | null>
  /** The team-sharing listing the desktop agents' copies come from; Refresh re-reads it too. */
  teamLibrary: UseQueryResult<LibraryListingDto | null>
  views: CatalogEntryView[]
}

/**
 * The catalog's items as every surface lists them — the catalog dialog,
 * Settings → Catalog and the composer picker — from main's one cached
 * `GET /catalog/items` and this computer's agents. `refresh` is a surface
 * opening because the user wants the catalog as it is now (the dialog,
 * Settings); the picker reads what is cached.
 */
export function useCatalogEntries(options: { refresh?: boolean } = {}): CatalogEntries {
  const catalog = useCatalogItems({ refresh: options.refresh === true })
  const teamLibrary = useTeamLibrary()
  const { data: agents } = useAgents()
  const { data: localAgents } = useLocalAgents()
  // Which of this computer's agents are shared with the user to use only (Add to agent…).
  const { data: shareStatuses } = useShareStatuses()
  const views = useMemo(
    () =>
      catalogEntryViews({
        items: catalog.data?.items ?? [],
        library: teamLibrary.data?.agents ?? [],
        agents: agents ?? [],
        localAgents: localAgents?.agents ?? [],
        shareStatuses
      }),
    [catalog.data, teamLibrary.data, agents, localAgents, shareStatuses]
  )
  return { catalog, teamLibrary, views }
}
