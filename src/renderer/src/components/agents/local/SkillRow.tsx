import { ArrowUpCircle, ExternalLink, FileText, Loader2, RotateCw, Share2, Trash2, Users } from 'lucide-react'
import type { LocalAgentSkill, LocalAgentSkillCredential } from '../../../../../shared/localAgents'
import type { MarketplaceSkillPinStatus } from '../../../../../shared/marketplaceSkills'
import { MARKETPLACE_SKILL_TEXT } from '../../../utils/marketplaceSkills'
import { CATALOG_SKILL_TEXT, SKILL_SHARE_TEXT, catalogVersionLabel } from '../../../utils/catalogItems'
import { AnimatedCollapse } from '../../ui/AnimatedCollapse'
import { CredentialStatusGlyph } from '../../settings/CredentialRow'
import type { CredentialHealth } from '../../settings/credentialPresentation'
import { SettingsBadge, SettingsButton, SettingsIconButton } from '../../settings/SettingsLayout'
import { AddonRow } from './AddonRow'

/**
 * Whether a skill counts toward the tab's attention badge: any issue except
 * `not_downloaded`, which a catalog pin carries only until its revision is
 * fetched — transient, and its Try again is on the row itself; or, on a
 * deliverable skill, a declared slot no ready attachment fills — the badge
 * and the row's Finish setup are how that warning is announced, never a banner.
 */
export function needsAttention(skill: LocalAgentSkill): boolean {
  return (
    skill.issues.some((issue) => issue.code !== 'not_downloaded') ||
    (skill.deliverable && skill.credentials.some((credential) => credential.filled === false))
  )
}

/** A skill's state as the shared status glyph draws it: the first error, else the warnings, else fine. */
function skillHealth(skill: LocalAgentSkill): CredentialHealth {
  const error = skill.issues.find((issue) => issue.severity === 'error')
  if (error) return { tone: 'error', label: error.message }
  if (skill.issues.length > 0) return { tone: 'warning', label: skill.issues.map((issue) => issue.message).join(' ') }
  return { tone: 'ok', label: 'Every engine of this agent gets this skill' }
}

/** A catalog row's verb in flight. */
export type CatalogVerb = 'update' | 'ensure' | 'remove'

/**
 * What a catalog row can do, and its state, owned by the tab so a verb in
 * flight outlives a re-render of the row. Absent on an authored skill.
 */
export interface CatalogRowActions {
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
  /**
   * Check again on a not-cached Disconnected row: the same fetch as Try
   * again, but the row's own refusal is no error line — on a 404 the row
   * simply stays Disconnected; any other failure becomes the row's issue.
   */
  onCheck: () => void
  onAskRemove: () => void
  onCancelRemove: () => void
  onRemove: () => void
}

/** Whether a catalog row's revision is not on this computer, so Try again can fetch it. */
function notHere(skill: LocalAgentSkill): boolean {
  return skill.issues.some((issue) => issue.code === 'not_downloaded' || issue.code === 'download_failed')
}

/**
 * Whether a catalog row is Disconnected with no copy on this computer (no
 * path): its download was refused as not available, and Check again asks once
 * more — access may have come back. A cached Disconnected copy keeps working,
 * so it gets no Check again.
 */
function disconnectedNotHere(skill: LocalAgentSkill): boolean {
  return !skill.path && skill.issues.some((issue) => issue.code === 'catalog_disconnected')
}

function BusyIcon({ busy, children }: { busy: boolean; children: React.ReactNode }): React.JSX.Element {
  return busy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <>{children}</>
}

/** Credential slot chips drawn before the rest fold into `+N`. */
const MAX_SLOT_CHIPS = 2

/**
 * A declared slot's state as the shared status glyph draws it, from the scan's
 * `filled` (a ready attachment of its type whose Service URI is the slot).
 * Null where the scan did not judge it. Never an error: an unfilled skill slot
 * is a warning, and never blocks the agent.
 */
function slotHealth(credential: LocalAgentSkillCredential): CredentialHealth | null {
  if (credential.filled === undefined) return null
  if (credential.filled) return { tone: 'ok', label: `A credential for ${credential.slot} is attached` }
  if (credential.attachment) return { tone: 'warning', label: `The credential attached for ${credential.slot} is not ready` }
  return { tone: 'warning', label: `No credential for ${credential.slot} is attached yet` }
}

/**
 * One skill: its name, where it came from, its state and a reveal of its
 * `SKILL.md` on the title line; then the description, the credential slots it
 * declares and the issues — each only when there are any — and last a reveal
 * that failed. Drawn in the {@link AddonRow} shell every addon shares (ux_rules rule 13).
 *
 * A catalog skill (a `catalog_skills[]` pin) is the same row: "From the
 * catalog" instead of "Authored", its pinned version — or revision, when the
 * pin states no version — muted beside the name, and no reveal, since none of
 * its files are in the folder. The title line keeps the button's height either
 * way, so a list mixing the two does not step.
 *
 * The slots sit on their own neutral "Needs" line, never beside the skill's
 * status glyph. Each chip wears its own glyph once the scan judged it — a ✓
 * where a ready attachment fills it, a triangle where none does — as a
 * credential row says *connected* (rule 13). A deliverable skill with an
 * unfilled slot ends the line with Finish setup, which lists exactly those.
 *
 * An authored skill shared to the catalog shows, to a maintainer of its
 * package (the listing's access), a Who can use icon that opens the skill's
 * People.
 *
 * A catalog row's actions are icons on the title line (rule 13): Update when
 * the catalog has a newer version, Try again when the pinned revision is not
 * on this computer, Check again on a Disconnected row with no copy here, and
 * Remove, whose confirm opens inside the card. Update
 * and Remove are not shown on an agent shared with the user to use only. A
 * verb in flight spins its icon; a refusal is the card's last line (rule 6).
 */
export function SkillRow({
  skill: scanned,
  revealError,
  onReveal,
  onShare,
  onWhoCanUse,
  onFinishSetup,
  catalogActions,
  marketplaceStatus
}: {
  skill: LocalAgentSkill
  revealError: string | null
  onReveal: () => void
  /** Opens the agent's Finish setting up dialog; offered on a deliverable skill with an unfilled slot. */
  onFinishSetup?: () => void
  /** Authored rows the person may share (`skill.shareable`): opens the Share dialog. */
  onShare?: () => void
  /** Authored rows shared to the catalog: opens Who can use, offered only to a maintainer of the package. */
  onWhoCanUse?: () => void
  catalogActions?: CatalogRowActions
  /** Marketplace rows: where the pin stands against its marketplace, once read. */
  marketplaceStatus?: MarketplaceSkillPinStatus | null
}): React.JSX.Element {
  const marketplace = scanned.source === 'marketplace'
  // An entry no longer visible is a warning on the row, never an error: the cached copy is still delivered.
  const skill: LocalAgentSkill =
    marketplace && marketplaceStatus?.state === 'unavailable'
      ? { ...scanned, issues: [...scanned.issues, { code: 'marketplace_unavailable', message: MARKETPLACE_SKILL_TEXT.unavailable, severity: 'warning' }] }
      : scanned
  // A pinned row — catalog or marketplace — has no files in the folder: no reveal, the pin's actions instead.
  const catalog = skill.source === 'catalog' || marketplace
  // One name per skill (rule 13): a catalog row goes by its catalog title,
  // as the catalog and the Inbox show it; the folder name is the code.
  const title = catalog && skill.title ? skill.title : skill.name
  // An own skill shared to the active account's catalog shows its version as a
  // pin does, with a Shared badge (rule 13: a badge, not a dotted sub-line).
  const sharedVersion = !catalog && skill.shared ? catalogVersionLabel(skill.shared.revisionNumber, null) : null
  const shareLabel = skill.shared ? SKILL_SHARE_TEXT.shareNewVersion(skill.name) : SKILL_SHARE_TEXT.share(skill.name)
  const pinned = !catalog
    ? null
    : marketplace
      ? skill.version
        ? MARKETPLACE_SKILL_TEXT.version(skill.version)
        : null
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
    .map((credential) => {
      const state = credential.filled === undefined ? '' : credential.filled ? ' · attached' : ' · not attached'
      return `${credential.slot} (${credential.type})${state}${credential.description ? ` — ${credential.description}` : ''}`
    })
    .join('\n')
  const finishSetup =
    onFinishSetup && skill.deliverable && skill.credentials.some((credential) => credential.filled === false) ? onFinishSetup : null
  const marketplaceUpdate = marketplace && marketplaceStatus?.state === 'update_available' ? marketplaceStatus : null
  // The pin names no URL; the status lookup brings the entry's, while it is still visible.
  const marketplaceSource = marketplace ? (marketplaceStatus?.repositoryUrl ?? null) : null
  return (
    <AddonRow
      kind="skill"
      title={title}
      titleTooltip={title === skill.name ? skill.name : `${title} — ${skill.name}`}
      version={pinned ?? sharedVersion}
      dataAttributes={{
        'data-skill-row': skill.name,
        'data-skill-source': skill.source,
        ...(marketplace ? { 'data-marketplace-skill': skill.entryUuid ?? '', 'data-marketplace-skill-state': marketplaceStatus?.state ?? 'unknown' } : {})
      }}
      source={
        <>
          {sharedVersion && (
            <SettingsBadge title={SKILL_SHARE_TEXT.sharedFactTitle(skill.shared?.packageId ?? '')}>{SKILL_SHARE_TEXT.sharedBadge}</SettingsBadge>
          )}
          {marketplace ? (
            <SettingsBadge title={MARKETPLACE_SKILL_TEXT.fromTitle(skill.marketplaceName ?? '')}>
              {MARKETPLACE_SKILL_TEXT.from(skill.marketplaceName ?? '')}
            </SettingsBadge>
          ) : catalog ? (
            <SettingsBadge title={skill.packageId ? `Pinned from the catalog as ${skill.packageId}` : 'Pinned from the catalog'}>
              From the catalog
            </SettingsBadge>
          ) : (
            <SettingsBadge title="Written in this agent’s own skills/ folder">Authored</SettingsBadge>
          )}
        </>
      }
      status={<CredentialStatusGlyph health={skillHealth(skill)} />}
      actions={
        <>
        {!catalog && skill.shareable && onShare && (
          <SettingsIconButton onClick={onShare} title={shareLabel} aria-label={shareLabel}>
            <Share2 size={14} />
          </SettingsIconButton>
        )}
        {!catalog && skill.shared?.access === 'maintain' && onWhoCanUse && (
          <SettingsIconButton
            onClick={onWhoCanUse}
            title={SKILL_SHARE_TEXT.whoCanUseAction(skill.name)}
            aria-label={SKILL_SHARE_TEXT.whoCanUseAction(skill.name)}
          >
            <Users size={14} />
          </SettingsIconButton>
        )}
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
          <>
            {marketplaceSource && (
              <SettingsIconButton
                onClick={() => void window.api.system.openExternal(marketplaceSource)}
                title={MARKETPLACE_SKILL_TEXT.openRepository}
                aria-label={MARKETPLACE_SKILL_TEXT.openRepositoryLabel(title)}
              >
                <ExternalLink size={14} />
              </SettingsIconButton>
            )}
            {marketplaceUpdate && !catalogActions.readOnly && (
              <SettingsIconButton
                onClick={catalogActions.onUpdate}
                disabled={catalogActions.busy !== null || catalogActions.locked || catalogActions.confirming}
                title={MARKETPLACE_SKILL_TEXT.updateTo(title, marketplaceUpdate.latestVersion)}
                aria-label={MARKETPLACE_SKILL_TEXT.updateTo(title, marketplaceUpdate.latestVersion)}
              >
                <BusyIcon busy={catalogActions.busy === 'update'}>
                  <ArrowUpCircle size={14} />
                </BusyIcon>
              </SettingsIconButton>
            )}
            {!marketplace && skill.updatable && !catalogActions.readOnly && typeof skill.latestRevision === 'number' && (
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
            {disconnectedNotHere(skill) && (
              <SettingsIconButton
                onClick={catalogActions.onCheck}
                disabled={catalogActions.busy !== null || catalogActions.locked || catalogActions.confirming}
                title={CATALOG_SKILL_TEXT.checkAgain(title)}
                aria-label={CATALOG_SKILL_TEXT.checkAgain(title)}
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
          </>
        )}
        </>
      }
    >
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
          {shown.map((credential) => {
            const health = slotHealth(credential)
            return (
              <span key={credential.slot} className="flex min-w-0 items-center gap-1">
                {health && <CredentialStatusGlyph health={health} size={12} />}
                <code className="min-w-0 truncate rounded bg-[var(--color-bg-tertiary)] px-1.5 py-px font-mono text-[12px] text-[var(--color-text-secondary)]">
                  {credential.slot}
                </code>
              </span>
            )
          })}
          {hidden > 0 && <span className="shrink-0 text-[var(--color-text-muted)]">+{hidden}</span>}
          {finishSetup && (
            <button
              type="button"
              onClick={finishSetup}
              title={`Attach the credentials ${skill.name} needs`}
              className="ml-auto shrink-0 font-medium text-[var(--color-accent)] underline-offset-2 hover:underline"
            >
              Finish setup
            </button>
          )}
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
              {marketplace ? MARKETPLACE_SKILL_TEXT.removeConfirm(title) : CATALOG_SKILL_TEXT.removeConfirm(title)}
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
    </AddonRow>
  )
}
