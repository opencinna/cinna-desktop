import { useState } from 'react'
import { ArrowUpCircle, FileText, Loader2, Plus, RotateCw, Sparkles, Trash2 } from 'lucide-react'
import type { LocalAgentDto, LocalAgentSkill } from '../../../../../shared/localAgents'
import { useAgentMcpProviders, useAttachAgentMcp, useDetachAgentMcp, useMcpProviders } from '../../../hooks/useMcp'
import { useOpenAgentPath } from '../../../hooks/useLocalAgents'
import { useListedShareStatus } from '../../../hooks/useSharing'
import {
  catalogSkillOutcomeMessage,
  useEnsureCatalogSkills,
  useRemoveCatalogSkill,
  useUpdateCatalogSkill
} from '../../../hooks/useCatalogSkills'
import { unwrapIpcError } from '../../../utils/ipcError'
import { CATALOG_SKILL_TEXT, catalogVersionLabel } from '../../../utils/catalogItems'
import { AnimatedCollapse } from '../../ui/AnimatedCollapse'
import { MCPProviderCard } from '../../settings/MCPProviderCard'
import { CredentialStatusGlyph } from '../../settings/CredentialRow'
import type { CredentialHealth } from '../../settings/credentialPresentation'
import { SettingsBadge, SettingsButton, SettingsIconButton, SettingsInfoTip, SettingsSection } from '../../settings/SettingsLayout'
import { McpAttachModal } from './McpAttachModal'
import { mcpProblem } from '../../settings/mcpPresentation'

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
  const attached = (providers ?? []).filter((p) => ids?.includes(p.id))
  const skills = agentSkills ?? []
  return {
    count: attached.length + skills.length,
    problems: attached.filter((p) => mcpProblem(p) !== null).length + skills.filter(needsAttention).length,
    skills: skills.length
  }
}

/**
 * Whether a skill counts toward the tab's attention badge: any issue except
 * `not_downloaded`, which a catalog pin carries only until its revision is
 * fetched — transient, and its Try again is on the row itself.
 */
function needsAttention(skill: LocalAgentSkill): boolean {
  return skill.issues.some((issue) => issue.code !== 'not_downloaded')
}

/** A skill's state as the shared status glyph draws it: the first error, else the warnings, else fine. */
function skillHealth(skill: LocalAgentSkill): CredentialHealth {
  const error = skill.issues.find((issue) => issue.severity === 'error')
  if (error) return { tone: 'error', label: error.message }
  if (skill.issues.length > 0) return { tone: 'warning', label: skill.issues.map((issue) => issue.message).join(' ') }
  return { tone: 'ok', label: 'Every engine of this agent gets this skill' }
}

/** A catalog row's verb in flight. */
type CatalogVerb = 'update' | 'ensure' | 'remove'

/**
 * What a catalog row can do, and its state, owned by the tab so a verb in
 * flight outlives a re-render of the row. Absent on an authored skill.
 */
interface CatalogRowActions {
  /**
   * Update and Remove are not the user's (catalog U9): the agent is shared
   * with them to use only, its access is not known, or not read yet.
   */
  readOnly: boolean
  /** The agent is shared and the user may change it: a Remove passes on only once they share changes. */
  sharedEditable: boolean
  busy: CatalogVerb | null
  /** Another row's verb is running. */
  locked: boolean
  error: string | null
  confirming: boolean
  onUpdate: () => void
  onEnsure: () => void
  onAskRemove: () => void
  onCancelRemove: () => void
  onRemove: () => void
}

/** Whether a catalog row's revision is not on this computer, so Try again can fetch it. */
function notHere(skill: LocalAgentSkill): boolean {
  return skill.issues.some((issue) => issue.code === 'not_downloaded' || issue.code === 'download_failed')
}

function BusyIcon({ busy, children }: { busy: boolean; children: React.ReactNode }): React.JSX.Element {
  return busy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <>{children}</>
}

/** Credential slot chips drawn before the rest fold into `+N`. */
const MAX_SLOT_CHIPS = 2

/**
 * One skill: its name, where it came from, its state and a reveal of its
 * `SKILL.md` on the title line; then the description, the credential slots it
 * declares and the issues — each only when there are any — and last a reveal
 * that failed. Drawn in the connector card's shell (ux_rules rule 13).
 *
 * A catalog skill (a `catalog_skills[]` pin) is the same row: "From the
 * catalog" instead of "Authored", its pinned version — or revision, when the
 * pin states no version — muted beside the name, and no reveal, since none of
 * its files are in the folder. The title line keeps the button's height either
 * way, so a list mixing the two does not step.
 *
 * The slots sit on their own neutral "Needs" line, never beside the status
 * glyph: a ✓ followed by code is how a credential row says *connected*, and
 * nothing here checks the slots.
 *
 * A catalog row's actions are icons on the title line (rule 13): Update when
 * the catalog has a newer version, Try again when the pinned revision is not
 * on this computer, and Remove, whose confirm opens inside the card. Update
 * and Remove are not shown on an agent shared with the user to use only. A
 * verb in flight spins its icon; a refusal is the card's last line (rule 6).
 */
function SkillRow({
  skill,
  revealError,
  onReveal,
  catalogActions
}: {
  skill: LocalAgentSkill
  revealError: string | null
  onReveal: () => void
  catalogActions?: CatalogRowActions
}): React.JSX.Element {
  const catalog = skill.source === 'catalog'
  // One name per skill (rule 13): a catalog row goes by its catalog title,
  // as the catalog and the Inbox show it; the folder name is the code.
  const title = catalog && skill.title ? skill.title : skill.name
  const pinned = !catalog
    ? null
    : typeof skill.revisionNumber === 'number'
      ? catalogVersionLabel(skill.revisionNumber, skill.version)
      : skill.version
        ? `Version ${skill.version}`
        : null
  // Try again's failure is often the very sentence the amber issue above says.
  const actionError =
    catalogActions?.error && !skill.issues.some((issue) => issue.message === catalogActions.error) ? catalogActions.error : null
  const hasFile = !skill.issues.some((issue) => issue.code === 'missing_skill_md' || issue.code === 'not_a_directory')
  const shown = skill.credentials.slice(0, MAX_SLOT_CHIPS)
  const hidden = skill.credentials.length - shown.length
  const slotsTitle = skill.credentials
    .map((credential) => `${credential.slot} (${credential.type})${credential.description ? ` — ${credential.description}` : ''}`)
    .join('\n')
  return (
    <div className="overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
      <div className="flex min-h-12 items-center gap-2 px-4 py-2.5">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Sparkles size={16} aria-hidden className="shrink-0 text-[var(--color-accent)]" />
          <span
            title={title === skill.name ? skill.name : `${title} — ${skill.name}`}
            className="min-w-0 shrink truncate text-[14px] font-medium"
          >
            {title}
          </span>
          {pinned && (
            <span title={pinned} className="min-w-0 max-w-[10rem] shrink-[2] truncate text-[12px] text-[var(--color-text-muted)]">
              {pinned}
            </span>
          )}
          {catalog ? (
            <SettingsBadge title={skill.packageId ? `Pinned from the catalog as ${skill.packageId}` : 'Pinned from the catalog'}>
              From the catalog
            </SettingsBadge>
          ) : (
            <SettingsBadge title="Written in this agent’s own skills/ folder">Authored</SettingsBadge>
          )}
          <CredentialStatusGlyph health={skillHealth(skill)} />
        </div>
        {!catalog && (
          <SettingsIconButton
            onClick={onReveal}
            title={hasFile ? `Reveal ${skill.path}` : `Reveal skills/${skill.name}`}
            aria-label={hasFile ? `Reveal SKILL.md of ${skill.name}` : `Reveal the ${skill.name} folder`}
          >
            <FileText size={14} />
          </SettingsIconButton>
        )}
        {catalog && catalogActions && (
          <div className="flex shrink-0 items-center gap-1.5">
            {skill.updatable && !catalogActions.readOnly && typeof skill.latestRevision === 'number' && (
              <SettingsIconButton
                onClick={catalogActions.onUpdate}
                disabled={catalogActions.busy !== null || catalogActions.locked || catalogActions.confirming}
                title={CATALOG_SKILL_TEXT.updateTo(title, catalogVersionLabel(skill.latestRevision, skill.latestVersion))}
                aria-label={CATALOG_SKILL_TEXT.updateTo(title, catalogVersionLabel(skill.latestRevision, skill.latestVersion))}
              >
                <BusyIcon busy={catalogActions.busy === 'update'}>
                  <ArrowUpCircle size={14} />
                </BusyIcon>
              </SettingsIconButton>
            )}
            {notHere(skill) && (
              <SettingsIconButton
                onClick={catalogActions.onEnsure}
                disabled={catalogActions.busy !== null || catalogActions.locked || catalogActions.confirming}
                title={CATALOG_SKILL_TEXT.tryAgain(title)}
                aria-label={CATALOG_SKILL_TEXT.tryAgain(title)}
              >
                <BusyIcon busy={catalogActions.busy === 'ensure'}>
                  <RotateCw size={14} />
                </BusyIcon>
              </SettingsIconButton>
            )}
            {!catalogActions.readOnly && (
              <SettingsIconButton
                danger
                onClick={catalogActions.onAskRemove}
                disabled={catalogActions.busy !== null || catalogActions.locked || catalogActions.confirming}
                title={CATALOG_SKILL_TEXT.remove(title)}
                aria-label={CATALOG_SKILL_TEXT.remove(title)}
              >
                <Trash2 size={14} />
              </SettingsIconButton>
            )}
          </div>
        )}
      </div>
      {skill.description && (
        // Padding on the wrapper: a clamped box clips at its padding edge, so
        // padding on the paragraph itself shows a sliver of the third line.
        <div className="-mt-1 px-4 pb-2.5">
          <p title={skill.description} className="line-clamp-2 text-[13px] text-[var(--color-text-secondary)]">
            {skill.description}
          </p>
        </div>
      )}
      {skill.credentials.length > 0 && (
        <div
          data-skill-slots
          title={`Credentials this skill declares:\n${slotsTitle}`}
          className="-mt-1 flex min-w-0 items-center gap-1.5 px-4 pb-2.5 text-[12px]"
        >
          <span className="shrink-0 text-[var(--color-text-muted)]">Needs</span>
          {shown.map((credential) => (
            <code
              key={credential.slot}
              className="min-w-0 truncate rounded bg-[var(--color-bg-tertiary)] px-1.5 py-px font-mono text-[12px] text-[var(--color-text-secondary)]"
            >
              {credential.slot}
            </code>
          ))}
          {hidden > 0 && <span className="shrink-0 text-[var(--color-text-muted)]">+{hidden}</span>}
        </div>
      )}
      {skill.issues.length > 0 && (
        <ul className="space-y-0.5 border-t border-[var(--color-border)] px-4 py-2 text-[13px]">
          {skill.issues.map((issue, index) => (
            <li
              key={`${issue.code}:${index}`}
              className={issue.severity === 'error' ? 'text-[var(--color-danger)]' : 'text-[var(--color-warning)]'}
            >
              {issue.message}
              {issue.paths?.map((path) => (
                <code key={path} className="ml-1.5 rounded bg-[var(--color-bg-tertiary)] px-1.5 py-px font-mono text-[12px] text-[var(--color-text-secondary)]">
                  {path}
                </code>
              ))}
            </li>
          ))}
        </ul>
      )}
      {catalogActions && (
        <AnimatedCollapse open={catalogActions.confirming}>
          <div
            role="group"
            aria-label={CATALOG_SKILL_TEXT.remove(title)}
            className="border-t border-[var(--color-border)] px-4 py-3"
          >
            <p className="mb-3 text-[13px]">
              {CATALOG_SKILL_TEXT.removeConfirm(title)}
              {catalogActions.sharedEditable && ` ${CATALOG_SKILL_TEXT.removeShareHint}`}
            </p>
            <div className="flex gap-2">
              <SettingsButton disabled={catalogActions.busy === 'remove'} onClick={catalogActions.onRemove}>
                {catalogActions.busy === 'remove' ? CATALOG_SKILL_TEXT.removing : CATALOG_SKILL_TEXT.removeButton}
              </SettingsButton>
              <SettingsButton disabled={catalogActions.busy === 'remove'} onClick={catalogActions.onCancelRemove}>
                {CATALOG_SKILL_TEXT.cancel}
              </SettingsButton>
            </div>
          </div>
        </AnimatedCollapse>
      )}
      {(revealError || actionError) && (
        <p role="alert" className="border-t border-[var(--color-border)] px-4 py-2 text-[13px] text-[var(--color-danger)]">
          {revealError || actionError}
        </p>
      )}
    </div>
  )
}

/**
 * What a local agent runs with beyond its own instructions: MCP connectors,
 * and a kit agent's skills. Catalog plugins join as their own section when
 * they exist — not as an empty section now.
 *
 * A connector attached here is the same record Settings → MCP lists, drawn
 * with the same card (ux_rules rule 13): toggling, editing or reconnecting it
 * here changes it everywhere. Detach only removes the link to this agent.
 */
export function AgentAddonsTab({ agent }: { agent: LocalAgentDto }): React.JSX.Element {
  const { data: ids, error: idsError } = useAgentMcpProviders(agent.id)
  const { data: providers } = useMcpProviders()
  // Owned here, not in the modal: an attach outlives the modal closing.
  const attach = useAttachAgentMcp()
  const detach = useDetachAgentMcp()
  const openPath = useOpenAgentPath()
  const [picking, setPicking] = useState(false)
  const [error, setError] = useState('')
  // A failed reveal is shown in the card of the skill it was for (rule 6).
  const [revealError, setRevealError] = useState<{ skill: string; message: string } | null>(null)
  // Catalog rows: owned here, so a verb in flight outlives the row's re-render
  // when the rescan it causes lands (rule 5).
  const updateSkill = useUpdateCatalogSkill()
  const ensureSkills = useEnsureCatalogSkills()
  const removeSkill = useRemoveCatalogSkill()
  const [skillBusy, setSkillBusy] = useState<{ name: string; verb: CatalogVerb } | null>(null)
  const [skillError, setSkillError] = useState<{ name: string; message: string } | null>(null)
  const [confirmingRemove, setConfirmingRemove] = useState<string | null>(null)
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

  const catalogActionsFor = (skill: LocalAgentSkill): CatalogRowActions => ({
    readOnly,
    sharedEditable,
    busy: skillBusy?.name === skill.name ? skillBusy.verb : null,
    locked: skillBusy !== null && skillBusy.name !== skill.name,
    error: skillError?.name === skill.name ? skillError.message : null,
    confirming: confirmingRemove === skill.name,
    onUpdate: () =>
      runSkillVerb(skill.name, 'update', () => updateSkill.mutateAsync({ agentId: agent.id, name: skill.name }), CATALOG_SKILL_TEXT.updateFailed),
    onEnsure: () =>
      runSkillVerb(
        skill.name,
        'ensure',
        async () => {
          const result = await ensureSkills.mutateAsync({ agentId: agent.id })
          if (!result.ok) return result
          // One fetch covers every pin; this row's answer is its own failure, if any.
          const failed = result.failed.find((failure) => failure.name === skill.name)
          return failed ? { ok: false as const, message: failed.message } : { ok: true as const }
        },
        CATALOG_SKILL_TEXT.tryAgainFailed
      ),
    onAskRemove: () => {
      setSkillError(null)
      setConfirmingRemove(skill.name)
    },
    onCancelRemove: () => setConfirmingRemove(null),
    onRemove: () =>
      runSkillVerb(skill.name, 'remove', () => removeSkill.mutateAsync({ agentId: agent.id, name: skill.name }), CATALOG_SKILL_TEXT.removeFailed)
  })

  // In attach order; a link whose connector is gone is never drawn (the
  // delete cascades, and the provider list may simply not have caught up).
  const attached = (ids ?? []).flatMap((id) => providers?.find((p) => p.id === id) ?? [])

  return (
    <div className="space-y-4 text-[13px]">
      <SettingsSection
        title="MCP Connectors"
        info={
          <SettingsInfoTip label="About MCP connectors">
            <p>Every session of this agent gets the tools of the connectors attached here — its own chats, scheduled jobs, task runs, and runs where another agent calls it.</p>
            <p className="mt-2">Connectors run in Cinna, which keeps their sign-in; the agent’s runtime reaches them through Cinna and never sees a token. A connector that is not connected when a session starts is left out of that session.</p>
            <p className="mt-2">Each one is also listed in Settings → MCP. Detach removes it from this agent only.</p>
          </SettingsInfoTip>
        }
        action={
          <SettingsButton onClick={() => setPicking(true)}>
            <Plus size={14} />
            Attach
          </SettingsButton>
        }
      >
        {ids?.length === 0 && <p className="text-[var(--color-text-muted)]">No connectors attached.</p>}
        {attached.length > 0 && (
          <ul className="space-y-2">
            {attached.map((provider) => (
              <li key={provider.id}>
                <MCPProviderCard
                  provider={provider}
                  detach={{
                    disabled: detach.isPending,
                    onDetach: () => {
                      setError('')
                      detach.mutateAsync({ agentId: agent.id, mcpProviderId: provider.id })
                        .catch((e) => setError(unwrapIpcError(e)))
                    }
                  }}
                />
              </li>
            ))}
          </ul>
        )}
      </SettingsSection>
      {/* Kit agents only: a bare agent's DTO carries no `skills`. */}
      {agent.skills && (
        <SettingsSection
          title="Skills"
          info={
            <SettingsInfoTip label="About skills">
              <p>A skill is a folder under <code>skills/</code> in this agent’s folder, with a <code>SKILL.md</code> whose name matches the folder and which says what the skill is for.</p>
              <p className="mt-2">Every session of this agent can use the skills listed here as working. Claude and OpenCode load them as skills; Codex is told where each one’s SKILL.md is.</p>
              <p className="mt-2">A skill with an error is left out of every session until its SKILL.md is fixed.</p>
              <p className="mt-2">A skill from the catalog is pinned in <code>cinna-agent.json</code> rather than kept in the folder. Cinna downloads the pinned version once and gives it to every session; add one from the catalog.</p>
            </SettingsInfoTip>
          }
        >
          {agent.skills.length === 0 ? (
            <p className="text-[var(--color-text-muted)]">No skills yet.</p>
          ) : (
            <ul className="space-y-2">
              {agent.skills.map((skill, index) => (
                // An own skill and a pin may share a name (an error the row shows), and so may two pins.
                <li key={`${skill.source}:${skill.name}:${index}`}>
                  <SkillRow
                    skill={skill}
                    revealError={revealError?.skill === skill.name ? revealError.message : null}
                    catalogActions={skill.source === 'catalog' ? catalogActionsFor(skill) : undefined}
                    onReveal={() => {
                      setRevealError(null)
                      const missing = skill.issues.some((issue) => issue.code === 'missing_skill_md' || issue.code === 'not_a_directory')
                      openPath.mutate(
                        { agentId: agent.id, relPath: missing ? `skills/${skill.name}` : skill.path },
                        { onError: (e) => setRevealError({ skill: skill.name, message: unwrapIpcError(e) }) }
                      )
                    }}
                  />
                </li>
              ))}
            </ul>
          )}
        </SettingsSection>
      )}
      {(error || idsError) && (
        <p role="alert" className="text-[var(--color-danger)]">{error || unwrapIpcError(idsError)}</p>
      )}
      <McpAttachModal
        open={picking}
        attachedIds={ids ?? []}
        onClose={() => setPicking(false)}
        onAttach={async (mcpProviderId) => {
          await attach.mutateAsync({ agentId: agent.id, mcpProviderId })
        }}
      />
    </div>
  )
}
