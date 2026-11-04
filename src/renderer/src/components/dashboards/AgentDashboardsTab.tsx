import { useState } from 'react'
import { FolderOpen } from 'lucide-react'
import type { ComponentInfo, ComponentPlacement } from '../../../../shared/dashboards'
import type { LocalAgentDto } from '../../../../shared/localAgents'
import { useAddTile, useCloudComponents, useComponents, usePlacements } from '../../hooks/useDashboards'
import { useOpenAgentPath } from '../../hooks/useLocalAgents'
import { unwrapIpcError } from '../../utils/ipcError'
import { useCapabilities } from '../../hooks/useCapabilities'
import { SettingsBadge, SettingsButton, SettingsInfoTip, SettingsSection } from '../settings/SettingsLayout'
import { AddToDashboardDialog } from './AddToDashboardDialog'
import { ComponentPreviewDialog } from './ComponentPreview'
import { CloudRefusal, ComponentFindings, MissingCredentials, PlacementsLine, VIEW_LABELS, placementsOf, useCinnaServerName } from './componentParts'

/** The agent's own components first, then each skill's under its name (README D15). */
function groupBySkill(list: ComponentInfo[]): { skill: string | null; components: ComponentInfo[] }[] {
  const groups = new Map<string | null, ComponentInfo[]>()
  for (const component of list) {
    const skill = component.skill ?? null
    groups.set(skill, [...(groups.get(skill) ?? []), component])
  }
  const skills = [...groups.keys()].filter((skill): skill is string => skill !== null).sort()
  return [
    ...(groups.has(null) ? [{ skill: null, components: groups.get(null)! }] : []),
    ...skills.map((skill) => ({ skill, components: groups.get(skill)! }))
  ]
}

/**
 * One component: title and view, Preview / Add to dashboard…, its
 * description, where it is placed, and what its check found (errors, then
 * warnings). A component that needs a credential the agent has not attached
 * says which instead of offering to run.
 */
function ComponentRow({
  component,
  placements,
  needsId,
  onPreview,
  onAdd
}: {
  component: ComponentInfo
  placements: ComponentPlacement[]
  needsId: boolean
  onPreview: () => void
  onAdd: () => void
}): React.JSX.Element {
  const blocked = component.missingCredentials.length > 0
  const runnable = component.valid && !blocked
  // Off, Dashboards keeps the agent's components listed but offers no way to
  // put one on a dashboard (ux rule 15).
  const dashboardsOn = useCapabilities().dashboardsEnabled
  return (
    <div data-component={component.name} className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-[14px] font-medium text-[var(--color-text)]">{component.title}</h3>
            {component.view && <SettingsBadge>{VIEW_LABELS[component.view]}</SettingsBadge>}
          </div>
          {/* A cloud component's folder is in the agent's environment on the server, not on this computer (ux rule 9). */}
          <p className="mt-0.5 font-mono text-[12px] text-[var(--color-text-muted)]">{component.cloud ? component.name : `dashboards/${component.name}/`}</p>
        </div>
        {/* Preview and Add only for a component that can run, as on its chat card (ux rule 13). */}
        {runnable && (
          <div className="flex shrink-0 items-center gap-2">
            <SettingsButton onClick={onPreview} aria-label={`Preview ${component.title}`}>
              Preview
            </SettingsButton>
            {dashboardsOn && (
              <SettingsButton
                onClick={onAdd}
                disabled={needsId}
                aria-label={`Add ${component.title} to a dashboard`}
                title={needsId ? 'This agent needs an id first' : undefined}
              >
                Add to dashboard…
              </SettingsButton>
            )}
          </div>
        )}
      </div>
      {component.description && <p className="mt-2 text-[13px] text-[var(--color-text-secondary)]">{component.description}</p>}
      {component.valid && <div className="mt-2"><PlacementsLine placements={placements} scale="settings" /></div>}
      {/* On the agent's own page: no link back to it. */}
      {blocked && <div className="mt-2"><MissingCredentials component={component} scale="settings" link={false} /></div>}
      {component.findings.length > 0 && <div className="mt-2"><ComponentFindings component={component} scale="settings" /></div>}
      {needsId && runnable && (
        <p className="mt-2 text-[12px] text-[var(--color-text-secondary)]">This agent needs an id first: stamp its identity on the Folder tab.</p>
      )}
    </div>
  )
}

/** The components, the agent's own first and then each skill's under its name. */
function ComponentGroups({
  list,
  placements,
  needsId,
  onPreview,
  onAdd
}: {
  list: ComponentInfo[]
  placements: ComponentPlacement[]
  needsId: boolean
  onPreview: (component: ComponentInfo) => void
  onAdd: (component: ComponentInfo) => void
}): React.JSX.Element {
  return (
    <>
      {groupBySkill(list).map((group) => (
        <div key={group.skill ?? ''} className="space-y-3" data-component-group={group.skill ?? undefined}>
          {group.skill && (
            <h3 className="text-[12px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">From skill {group.skill}</h3>
          )}
          {group.components.map((component) => (
            <ComponentRow
              key={`${component.skill ?? ''}/${component.name}`}
              component={component}
              placements={placementsOf(component, placements)}
              needsId={needsId}
              onPreview={() => onPreview(component)}
              onAdd={() => onAdd(component)}
            />
          ))}
        </div>
      ))}
    </>
  )
}

/**
 * A kit agent's components (`dashboards/<name>/`, and those its skills ship):
 * what each is, whether it is valid (with its findings), where it is placed,
 * and Add to dashboard… / Preview. Built like the tabs beside it (Tasks, Schedules): one titled
 * `SettingsSection`, the explanation behind the (?), the 14/13/12 scale.
 * Listing runs nothing; Preview and Add run the source once, on the click.
 */
export function AgentDashboardsTab({ agent }: { agent: LocalAgentDto }): React.JSX.Element {
  const components = useComponents(agent.id)
  const placements = usePlacements(agent.id)
  const addTile = useAddTile()
  const openPath = useOpenAgentPath()
  const [adding, setAdding] = useState<ComponentInfo | null>(null)
  const [previewing, setPreviewing] = useState<ComponentInfo | null>(null)
  const needsId = !agent.manifestId

  const list = components.data ?? []

  return (
    <SettingsSection
      title="Components"
      info={
        <SettingsInfoTip label="About components">
          A component is a view this agent built in its folder, under dashboards/&lt;name&gt;/: a component.json, and an endpoint
          script or a page when it needs one. Put it on a dashboard and it stays live from this folder — when the agent changes the
          component, every tile showing it changes too.
        </SettingsInfoTip>
      }
      action={
        <SettingsButton onClick={() => openPath.mutate({ agentId: agent.id, relPath: 'dashboards' })} title="Show the dashboards folder">
          <FolderOpen size={13} aria-hidden="true" />
          Open folder
        </SettingsButton>
      }
    >
      {components.isPending ? (
        <p className="text-[13px] text-[var(--color-text-muted)]">Loading…</p>
      ) : components.isError ? (
        <p role="alert" className="text-[13px] text-[var(--color-danger)]">{unwrapIpcError(components.error, 'The components could not be read.')}</p>
      ) : list.length === 0 ? (
        <p className="text-[13px] text-[var(--color-text-muted)]">
          No components yet. Ask {agent.name} for a view you can keep on a dashboard, and it builds one in dashboards/ in its folder.
        </p>
      ) : (
        <ComponentGroups list={list} placements={placements.data ?? []} needsId={needsId} onPreview={setPreviewing} onAdd={setAdding} />
      )}
      {openPath.isError && <p role="alert" className="text-[13px] text-[var(--color-danger)]">{unwrapIpcError(openPath.error, 'The folder could not be opened.')}</p>}
      {adding && <AddToDashboardDialog component={adding} addTile={addTile} onClose={() => setAdding(null)} />}
      {previewing && <ComponentPreviewDialog component={previewing} onClose={() => setPreviewing(null)} />}
    </SettingsSection>
  )
}

/**
 * A cloud agent's components (D6.8), for the profile's own cloud agents: read
 * from its Cinna server, which wakes nothing, with the same rows, Preview and
 * Add to dashboard… as a folder agent's tab. While the list loads, or when
 * the server did not answer or wants a new sign-in, the section holds one
 * line that says so, at the height of the empty state.
 */
export function CloudAgentDashboardsTab({ agent }: { agent: { id: string; name: string } }): React.JSX.Element {
  const components = useCloudComponents(agent.id)
  const addTile = useAddTile()
  const server = useCinnaServerName()
  const [adding, setAdding] = useState<ComponentInfo | null>(null)
  const [previewing, setPreviewing] = useState<ComponentInfo | null>(null)
  const outcome = components.data
  const list = outcome?.ok ? outcome.components : []

  return (
    <SettingsSection
      title="Components"
      info={
        <SettingsInfoTip label="About components">
          A component is a view this agent built in its environment on {server}. Put it on a dashboard and it stays live: when the agent
          changes the component, every tile showing it changes too. Its data is computed on the server.
        </SettingsInfoTip>
      }
    >
      {components.isPending ? (
        <p className="text-[13px] text-[var(--color-text-muted)]">Loading…</p>
      ) : components.isError ? (
        <p role="alert" className="text-[13px] text-[var(--color-danger)]">{unwrapIpcError(components.error, 'The components could not be read.')}</p>
      ) : outcome && !outcome.ok ? (
        <CloudRefusal
          code={outcome.code}
          message={outcome.message}
          names={{ agent: agent.name, server }}
          onRetry={() => void components.refetch()}
          retrying={components.isFetching}
          className="text-[13px]"
          tone={outcome.code === 'unreachable' || outcome.code === 'reauth_required' ? 'quiet' : 'danger'}
        />
      ) : list.length === 0 ? (
        <p className="text-[13px] text-[var(--color-text-muted)]">
          No components yet. Ask {agent.name} for a view you can keep on a dashboard, and it builds one in its environment.
        </p>
      ) : (
        <ComponentGroups list={list} placements={outcome?.ok ? outcome.placements : []} needsId={false} onPreview={setPreviewing} onAdd={setAdding} />
      )}
      {adding && <AddToDashboardDialog component={adding} addTile={addTile} onClose={() => setAdding(null)} />}
      {previewing && <ComponentPreviewDialog component={previewing} onClose={() => setPreviewing(null)} />}
    </SettingsSection>
  )
}
