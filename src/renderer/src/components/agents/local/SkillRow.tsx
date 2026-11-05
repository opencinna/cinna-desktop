import { useState } from 'react'
import { ArrowUpCircle, ExternalLink, FileText, Loader2, Pencil, Replace, RotateCw, Trash2, Upload, Users } from 'lucide-react'
import type { LocalAgentSkill, LocalAgentSkillCredential } from '../../../../../shared/localAgents'
import type { MarketplaceSkillPinStatus } from '../../../../../shared/marketplaceSkills'
import { MARKETPLACE_SKILL_TEXT } from '../../../utils/marketplaceSkills'
import { CATALOG_SKILL_TEXT, SKILL_SHARE_TEXT, catalogVersionLabel } from '../../../utils/catalogItems'
import { AnimatedCollapse } from '../../ui/AnimatedCollapse'
import { CredentialStatusGlyph } from '../../settings/CredentialRow'
import type { CredentialHealth } from '../../settings/credentialPresentation'
import { SettingsBadge, SettingsButton, SettingsIconButton } from '../../settings/SettingsLayout'
import { AddonRow } from './AddonRow'
import { CopyInstallLinkButton, useSkillInstallLink } from '../CopyInstallLinkButton'

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
export type CatalogVerb = 'update' | 'ensure' | 'remove' | 'edit'

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
  /** Which confirm is open inside the card, if any; one at a time. */
  confirming: 'remove' | 'edit' | null
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
  /** Edit skill: opens its confirm; offered on a catalog pin whose package the person may edit. */
  onAskEdit: () => void
  onCancelEdit: () => void
  onEdit: () => void
}

/**
 * Get Version N on an own skill linked to a catalog package (`skill.shared`),
 * owned by the tab like the catalog rows' verbs and sharing their lock.
 * Offered only on an agent the person may change.
 */
export interface SkillSyncActions {
  /** Get (or Replace) is running on this row. */
  busy: boolean
  /** Another row's verb is running. */
  locked: boolean
  error: string | null
  /** Replace's confirm is open inside the card. */
  confirming: boolean
  /** `behind`: bring the newer version in. */
  onGet: () => void
  /** `diverged`: open the confirm; Replace keeps the folder in a backup first. */
  onAskReplace: () => void
  onCancelReplace: () => void
  onReplace: () => void
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
 * People. When its package has a newer version than the folder holds, a
 * muted line under the title says which and who shared it; on a folder
 * without unshared changes (`behind`) Get Version N brings it in, and on one
 * with them (`diverged`) Replace with Version N… opens a confirm inside the
 * card naming the backup folder the changes go to.
 *
 * A catalog row's actions are icons on the title line (rule 13): Update when
 * the catalog has a newer version, Try again when the pinned revision is not
 * on this computer, Check again on a Disconnected row with no copy here, and
 * Edit (a catalog pin whose package the person may edit: the pin becomes an
 * own copy linked to it) and Remove, each with its confirm inside the card,
 * one open at a time. Update, Edit and Remove are not shown on an agent shared
 * with the user to use only. A catalog pin's maintainer also gets Who can use,
 * which is about the package, so it is shown whatever the agent's state. A
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
  syncActions,
  marketplaceStatus
}: {
  skill: LocalAgentSkill
  revealError: string | null
  onReveal: () => void
  /** Opens the agent's Finish setting up dialog; offered on a deliverable skill with an unfilled slot. */
  onFinishSetup?: () => void
  /** Authored rows the person may share (`skill.shareable`): opens the Share dialog. */
  onShare?: () => void
  /**
   * Authored rows shared to the catalog, and catalog pins: opens Who can use,
   * offered only to a maintainer of the package (`shared.access` / `access`).
   */
  onWhoCanUse?: () => void
  catalogActions?: CatalogRowActions
  /** Authored rows linked to a package, on an agent the person may change: Get Version N and Replace. */
  syncActions?: SkillSyncActions
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
  // Copy install link (skill links, D4): a catalog pin's package, or an own skill shared to the
  // active account's catalog — never a marketplace pin or an unshared own skill.
  const installLink = useSkillInstallLink(
    skill.source === 'catalog' ? skill.packageId : skill.source === 'authored' ? skill.shared?.packageId : null
  )
  const [copyError, setCopyError] = useState<string | null>(null)
  const copyButton = installLink ? <CopyInstallLinkButton link={installLink} name={title} onError={setCopyError} /> : null
  // Try again's failure is often the very sentence the amber issue above says.
  const rowError = catalogActions?.error ?? syncActions?.error ?? null
  const actionError = rowError && !skill.issues.some((issue) => issue.message === rowError) ? rowError : null
  // A linked own skill whose package moved on: Get or Replace act on it, and their names say who shared it.
  const newer =
    !catalog && skill.shared && (skill.sync === 'behind' || skill.sync === 'diverged') && skill.latest ? skill.latest : null
  const syncDisabled = !syncActions || syncActions.busy || syncActions.locked || syncActions.confirming
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
  // A catalog pin (never a marketplace one) carries the person's access to its package from the listing.
  const pinAccess = skill.source === 'catalog' ? (skill.access ?? null) : null
  // Who can use is about the package, not the agent: offered to its maintainer whatever the agent's U9 state.
  const whoCanUse = catalog ? pinAccess === 'maintain' : skill.shared?.access === 'maintain'
  const editable = !!catalogActions && !catalogActions.readOnly && (pinAccess === 'edit' || pinAccess === 'maintain')
  // The version the copy is taken at: the package's latest, which is the pin's own when it is not behind.
  const editVersion =
    skill.updatable && typeof skill.latestRevision === 'number'
      ? catalogVersionLabel(skill.latestRevision, skill.latestVersion)
      : typeof skill.revisionNumber === 'number'
        ? catalogVersionLabel(skill.revisionNumber, skill.version)
        : null
  const verbsDisabled = !catalogActions || catalogActions.busy !== null || catalogActions.locked || catalogActions.confirming !== null
  // The pin names no URL; the status lookup brings the entry's, while it is still visible.
  const marketplaceSource = marketplace ? (marketplaceStatus?.repositoryUrl ?? null) : null
  // One place on every row (rule 13): after Share / Make editable, before Reveal / Remove.
  const whoCanUseButton =
    whoCanUse && onWhoCanUse ? (
      <SettingsIconButton onClick={onWhoCanUse} title={SKILL_SHARE_TEXT.whoCanUseAction(title)} aria-label={SKILL_SHARE_TEXT.whoCanUseAction(title)}>
        <Users size={14} />
      </SettingsIconButton>
    ) : null
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
        {newer && syncActions && skill.sync === 'behind' && (
          <SettingsIconButton
            onClick={syncActions.onGet}
            disabled={syncDisabled}
            title={SKILL_SHARE_TEXT.getVersion(skill.name, newer.revisionNumber, newer.publishedBy)}
            aria-label={SKILL_SHARE_TEXT.getVersion(skill.name, newer.revisionNumber, newer.publishedBy)}
          >
            <BusyIcon busy={syncActions.busy}>
              <ArrowUpCircle size={14} />
            </BusyIcon>
          </SettingsIconButton>
        )}
        {newer && syncActions && skill.sync === 'diverged' && (
          <SettingsIconButton
            onClick={syncActions.onAskReplace}
            disabled={syncDisabled}
            title={SKILL_SHARE_TEXT.replaceWith(skill.name, newer.revisionNumber, newer.publishedBy)}
            aria-label={SKILL_SHARE_TEXT.replaceWith(skill.name, newer.revisionNumber, newer.publishedBy)}
          >
            <BusyIcon busy={syncActions.busy}>
              <Replace size={14} />
            </BusyIcon>
          </SettingsIconButton>
        )}
        {!catalog && skill.shareable && onShare && (
          <SettingsIconButton onClick={onShare} title={shareLabel} aria-label={shareLabel}>
            <Upload size={14} />
          </SettingsIconButton>
        )}
        {!catalog && copyButton}
        {!catalog && whoCanUseButton}
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
                disabled={verbsDisabled}
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
                disabled={verbsDisabled}
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
                disabled={verbsDisabled}
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
                disabled={verbsDisabled}
                title={CATALOG_SKILL_TEXT.checkAgain(title)}
                aria-label={CATALOG_SKILL_TEXT.checkAgain(title)}
              >
                <BusyIcon busy={catalogActions.busy === 'ensure'}>
                  <RotateCw size={14} />
                </BusyIcon>
              </SettingsIconButton>
            )}
            {editable && (
              <SettingsIconButton
                onClick={catalogActions.onAskEdit}
                disabled={verbsDisabled}
                title={CATALOG_SKILL_TEXT.edit(title)}
                aria-label={CATALOG_SKILL_TEXT.edit(title)}
              >
                <BusyIcon busy={catalogActions.busy === 'edit'}>
                  <Pencil size={14} />
                </BusyIcon>
              </SettingsIconButton>
            )}
            {copyButton}
            {whoCanUseButton}
            {!catalogActions.readOnly && (
              <SettingsIconButton
                danger
                onClick={catalogActions.onAskRemove}
                disabled={verbsDisabled}
                title={CATALOG_SKILL_TEXT.remove(title)}
                aria-label={CATALOG_SKILL_TEXT.remove(title)}
              >
                <Trash2 size={14} />
              </SettingsIconButton>
            )}
          </>
        )}
        {catalog && !catalogActions && copyButton}
        {catalog && !catalogActions && whoCanUseButton}
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
      {syncActions && newer && skill.sync === 'diverged' && (
        <AnimatedCollapse open={syncActions.confirming}>
          <div
            role="group"
            aria-label={SKILL_SHARE_TEXT.replaceWith(skill.name, newer.revisionNumber)}
            className="border-t border-[var(--color-border)] px-4 py-3"
          >
            <p className="mb-3 text-[13px]">{SKILL_SHARE_TEXT.replaceConfirm(skill.name, newer.revisionNumber)}</p>
            <div className="flex gap-2">
              <SettingsButton disabled={syncActions.busy} onClick={syncActions.onReplace}>
                {syncActions.busy ? SKILL_SHARE_TEXT.replacing : SKILL_SHARE_TEXT.replaceButton}
              </SettingsButton>
              <SettingsButton disabled={syncActions.busy} onClick={syncActions.onCancelReplace}>
                {CATALOG_SKILL_TEXT.cancel}
              </SettingsButton>
            </div>
          </div>
        </AnimatedCollapse>
      )}
      {catalogActions && editable && (
        <AnimatedCollapse open={catalogActions.confirming === 'edit'}>
          <div
            role="group"
            aria-label={CATALOG_SKILL_TEXT.edit(title)}
            className="border-t border-[var(--color-border)] px-4 py-3"
          >
            <p className="mb-3 text-[13px]">{CATALOG_SKILL_TEXT.editConfirm(title, skill.name, editVersion)}</p>
            <div className="flex gap-2">
              <SettingsButton disabled={catalogActions.busy === 'edit'} onClick={catalogActions.onEdit}>
                {catalogActions.busy === 'edit' ? CATALOG_SKILL_TEXT.editing : CATALOG_SKILL_TEXT.editButton}
              </SettingsButton>
              <SettingsButton disabled={catalogActions.busy === 'edit'} onClick={catalogActions.onCancelEdit}>
                {CATALOG_SKILL_TEXT.cancel}
              </SettingsButton>
            </div>
          </div>
        </AnimatedCollapse>
      )}
      {catalogActions && (
        <AnimatedCollapse open={catalogActions.confirming === 'remove'}>
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
      {(revealError || actionError || copyError) && (
        <p role="alert" className="border-t border-[var(--color-border)] px-4 py-2 text-[13px] text-[var(--color-danger)]">
          {revealError || actionError || copyError}
        </p>
      )}
    </AddonRow>
  )
}
