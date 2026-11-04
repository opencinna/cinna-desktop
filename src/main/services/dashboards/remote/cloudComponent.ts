/**
 * Cloud agents and their components as the dashboards services see them (D6):
 * the profile's synced remote agents (only its own may have tiles, D6.9), the
 * server they live on, and a component as core lists it turned into the
 * `ComponentInfo` the renderer already draws.
 *
 * Core module: no Electron.
 */

import { agentRepo } from '../../../db/agents'
import { userRepo } from '../../../db/users'
import { canDevelopAgent } from '../../../../shared/agentDevelopment'
import { COMPONENT_FILE, SKILL_DASHBOARDS_DIR, defaultRefreshRule, refreshRuleOf, validateComponentSpec, type ComponentSpec } from '../componentScanner'
import {
  DASHBOARD_VIEW_KINDS,
  isTileSize,
  type CloudOrigin,
  type ComponentFinding,
  type ComponentInfo,
  type DashboardViewKind
} from '../../../../shared/dashboards'
import type { CoreComponent } from './coreDashboardsClient'

/** A synced remote agent that names a core agent. */
export interface CloudAgent {
  /** The agent row id (what the renderer names it by). */
  id: string
  name: string
  /** The core agent's id. */
  remoteTargetId: string
  /** The profile's own agent (`canDevelopAgent`): the only kind whose components go on a dashboard (D6.9). */
  owned: boolean
  /** Core's `Agent.bundle_id` (every core agent has one), for `bundle:` references. */
  bundleId: string | null
}

/** The profile's remote agents that are core agents (not app routes or identities). */
export function listCloudAgents(userId: string): CloudAgent[] {
  return agentRepo
    .listRemote(userId)
    .filter((row) => row.remoteTargetType === 'agent' && !!row.remoteTargetId)
    .map((row) => ({
      id: row.id,
      name: row.name,
      remoteTargetId: row.remoteTargetId!,
      owned: canDevelopAgent(row),
      bundleId: typeof row.remoteMetadata?.bundle_id === 'string' && row.remoteMetadata.bundle_id.trim() ? row.remoteMetadata.bundle_id.trim() : null
    }))
}

/** The profile's cloud agent with this row id (owned or not), or null. */
export function findCloudAgent(userId: string, agentId: unknown): CloudAgent | null {
  if (typeof agentId !== 'string' || !agentId) return null
  return listCloudAgents(userId).find((agent) => agent.id === agentId) ?? null
}

/** Whether two server URLs name the same Cinna server (case and trailing slashes ignored). */
export function sameCoreServer(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  return a.replace(/\/+$/, '').toLowerCase() === b.replace(/\/+$/, '').toLowerCase()
}

/**
 * A backing dashboard recorded on a server other than the profile's current
 * one. A profile with no server now (signed out) is not "another server":
 * its calls answer `reauth_required` instead.
 */
export function onOtherCoreServer(recorded: string | null | undefined, current: string | null | undefined): boolean {
  return !!recorded && !!current && !sameCoreServer(recorded, current)
}

/** The profile's Cinna server URL, trailing slash stripped, or null when it is not linked to one. */
export function profileServerUrl(userId: string): string | null {
  try {
    const user = userRepo.get(userId)
    if (!user || user.type !== 'cinna_user' || !user.cinnaServerUrl) return null
    return user.cinnaServerUrl.replace(/\/+$/, '')
  } catch {
    return null
  }
}

/** A server URL's host as the user knows it (`cinna.example.com`), for the D6.10 sentences. */
export function serverHost(url: string | null): string {
  if (!url) return 'your Cinna server'
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** A cloud component, read: what the renderer is shown, and the normalized spec when it parses here. */
export interface CloudComponent {
  info: ComponentInfo
  /** Null when `component.json` did not parse here (core's findings say why when it is invalid). */
  spec: ComponentSpec | null
  core: CoreComponent
}

/**
 * Core's description of a component → {@link CloudComponent}. `component_json`
 * is parsed by the desktop checker's own rules with no file looked at (the
 * folder is in the cloud); the findings shown are core's, and core decides
 * whether it is valid (`has_errors`).
 */
export function cloudComponentFrom(core: CoreComponent, agent: Pick<CloudAgent, 'id' | 'name'>, origin: CloudOrigin, missingCredentials: string[] = []): CloudComponent {
  const shownDir = core.skill ? `skills/${core.skill}/${SKILL_DASHBOARDS_DIR}/${core.name}` : `${SKILL_DASHBOARDS_DIR}/${core.name}`
  const raw = isRecord(core.component_json) ? core.component_json : null
  const spec = raw ? validateComponentSpec(raw, { componentDir: '', agentDir: null, shownDir, manifest: null, commandNames: null, files: false }).spec : null
  const findings: ComponentFinding[] = (Array.isArray(core.findings) ? core.findings : []).map((finding) => ({
    path: String(finding.path ?? `${shownDir}/${COMPONENT_FILE}`),
    code: String(finding.code ?? ''),
    field: typeof finding.field === 'string' ? finding.field : null,
    severity: finding.severity === 'warning' ? 'warning' : 'error',
    message: String(finding.message ?? '')
  }))
  const ordered = [...findings.filter((f) => f.severity === 'error'), ...findings.filter((f) => f.severity === 'warning')]
  const view: DashboardViewKind | null = spec?.view ?? ((DASHBOARD_VIEW_KINDS as readonly unknown[]).includes(core.view) ? (core.view as DashboardViewKind) : null)
  const info: ComponentInfo = {
    agentId: agent.id,
    manifestId: '',
    agentName: agent.name,
    name: core.name,
    skill: core.skill ?? null,
    title: spec?.title ?? (typeof core.title === 'string' && core.title.trim() ? core.title.trim() : core.name),
    description: spec?.description ?? (raw && typeof raw.description === 'string' ? raw.description.trim() : ''),
    view,
    size: spec?.size ?? (raw && isTileSize(raw.size) ? raw.size : 'm'),
    source: spec?.source ?? null,
    maxAge: spec?.maxAge ?? defaultRefreshRule().maxAge,
    refreshCommand: spec?.refreshCommand ?? null,
    params: spec?.params ?? {},
    refresh: spec ? refreshRuleOf(spec) : defaultRefreshRule(),
    prompts: spec?.prompts ?? [],
    valid: !core.has_errors,
    findings: ordered,
    missingCredentials,
    cloud: origin
  }
  return { info, spec, core }
}

/** A stored `cloud_component_json`, or null when there is none or it does not parse. */
export function parseCoreComponent(json: string | null): CoreComponent | null {
  if (!json) return null
  try {
    const value = JSON.parse(json) as unknown
    return isRecord(value) && typeof value.name === 'string' ? (value as unknown as CoreComponent) : null
  } catch {
    return null
  }
}
