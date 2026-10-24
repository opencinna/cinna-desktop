import { Trash2 } from 'lucide-react'
import type { AddonMcpRequirement } from '../../../../../shared/addons/directory'
import { CredentialStatusGlyph } from '../../settings/CredentialRow'
import { SettingsBadge, SettingsButton, SettingsIconButton } from '../../settings/SettingsLayout'
import { AnimatedCollapse } from '../../ui/AnimatedCollapse'
import { AddonRow } from './AddonRow'

export const REQUIREMENT_TEXT = {
  badge: 'In cinna-agent.json',
  badgeTitle: 'This agent’s cinna-agent.json lists this connector (mcp_servers)',
  needsSetup: 'Needs setup',
  needsSetupLine: 'Needs setup on this computer',
  unavailable: 'Not available to you',
  setUp: 'Set up',
  setUpLabel: (name: string) => `Set up ${name}`,
  remove: (name: string) => `Remove ${name} from cinna-agent.json`,
  removeConfirm: (name: string) =>
    `Remove ${name} from this agent’s cinna-agent.json? The agent stops asking for it; a connector on this computer stays in Settings → MCP.`,
  removeButton: 'Remove',
  removing: 'Removing…',
  cancel: 'Cancel'
} as const

/** What a requirement row can do, owned by the tab so a remove in flight outlives the row (rule 5). */
export interface RequirementRowActions {
  /** The manifest is not the user's to change (a team agent shared to use only, or access not read yet). */
  readOnly: boolean
  busy: boolean
  error: string | null
  confirming: boolean
  onSetUp: () => void
  onAskRemove: () => void
  onCancelRemove: () => void
  onRemove: () => void
}

/**
 * A connector the agent's manifest names (`mcp_servers[]`) that this
 * computer does not meet yet, as a Connector row of the Addons tab (unified
 * addons D6): "Needs setup" with main's reason when it gives one, whose Set
 * up opens the picker straight at the entry to add it from — or, for a
 * custom connector no directory lists, at Custom connector… with its name
 * filled in. One that no source the account may use lists any more says why.
 * An unavailable or custom one can be removed from the manifest (the trash,
 * which asks first inside the card). A met requirement is never this row: it
 * is its connector's own row.
 */
export function RequirementRow({ requirement, actions }: { requirement: AddonMcpRequirement; actions: RequirementRowActions }): React.JSX.Element {
  const unavailable = requirement.state === 'unavailable'
  const custom = requirement.ref === null
  const line = requirement.reason ?? (unavailable ? REQUIREMENT_TEXT.unavailable : REQUIREMENT_TEXT.needsSetupLine)
  const removable = !actions.readOnly && (unavailable || custom)
  const removeLabel = REQUIREMENT_TEXT.remove(requirement.name)
  return (
    <AddonRow
      kind="mcp"
      title={requirement.name}
      source={<SettingsBadge title={REQUIREMENT_TEXT.badgeTitle}>{REQUIREMENT_TEXT.badge}</SettingsBadge>}
      status={<CredentialStatusGlyph health={{ tone: 'warning', label: unavailable ? line : REQUIREMENT_TEXT.needsSetup }} />}
      dataAttributes={{ 'data-mcp-requirement': requirement.name, 'data-mcp-requirement-state': requirement.state }}
      actions={
        removable && (
          <SettingsIconButton danger onClick={actions.onAskRemove} disabled={actions.busy || actions.confirming} title={removeLabel} aria-label={removeLabel}>
            <Trash2 size={14} />
          </SettingsIconButton>
        )
      }
    >
      <div className="-mt-1 flex min-w-0 items-center gap-1.5 px-4 pb-2.5 text-[13px]">
        <span className="min-w-0 truncate text-[var(--color-warning)]" title={line}>
          {line}
        </span>
        {!unavailable && (
          <button
            type="button"
            onClick={actions.onSetUp}
            aria-label={REQUIREMENT_TEXT.setUpLabel(requirement.name)}
            className="ml-auto shrink-0 font-medium text-[var(--color-accent)] underline-offset-2 hover:underline"
          >
            {REQUIREMENT_TEXT.setUp}
          </button>
        )}
      </div>
      <AnimatedCollapse open={actions.confirming}>
        <div role="group" aria-label={removeLabel} className="border-t border-[var(--color-border)] px-4 py-3">
          <p className="mb-3 text-[13px]">{REQUIREMENT_TEXT.removeConfirm(requirement.name)}</p>
          <div className="flex gap-2">
            <SettingsButton disabled={actions.busy} onClick={actions.onRemove}>
              {actions.busy ? REQUIREMENT_TEXT.removing : REQUIREMENT_TEXT.removeButton}
            </SettingsButton>
            <SettingsButton disabled={actions.busy} onClick={actions.onCancelRemove}>
              {REQUIREMENT_TEXT.cancel}
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
