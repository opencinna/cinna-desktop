import { useEffect, useId, useState } from 'react'
import { ChevronLeft, Download, ExternalLink, Loader2, PackageX, RefreshCw } from 'lucide-react'
import type { CatalogItem } from '../../../../shared/catalogItems'
import type { CatalogCredentialSpec } from '../../../../shared/catalog'
import type { LibraryAgentDto } from '../../../../shared/agentSharing'
import { isUnsettledClick } from '../../hooks/useSettleGuard'
import { useCatalogItemDetail, useCatalogServerUrl } from '../../hooks/useCatalog'
import { unwrapIpcError } from '../../utils/ipcError'
import { CATALOG_SKILL_TEXT, CATALOG_TEXT, catalogDateLabel, catalogVersionLabel, type CatalogItemKind } from '../../utils/catalogItems'
import { CatalogCardCredentials } from '../settings/CatalogCardCredentials'
import { CatalogUninstallModal } from '../settings/CatalogUninstallModal'
import { SettingsIconButton } from '../settings/SettingsLayout'
import { CATALOG_KIND_ICON, CatalogKindBadge } from './CatalogKindBadge'
import { CatalogSkillAddMenu, type CatalogSkillTarget } from './CatalogSkillAddMenu'
import { sizedButton, useCatalogSurface, useCatalogType } from './catalogSurface'

/**
 * The tile, the detail and the action of one catalog item, the same for every
 * kind (ux_rules rule 13): only the action differs — Get / Update / Open for
 * an agent of either kind, Add to agent… for a skill.
 */

export const PRIMARY =
  'inline-flex min-w-[5.5rem] items-center justify-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-medium ' +
  'bg-[var(--color-accent)] text-white transition-colors hover:bg-[var(--color-accent-hover)] ' +
  'disabled:cursor-not-allowed disabled:opacity-40'
export const SECONDARY =
  'inline-flex items-center justify-center gap-1 rounded-md border border-[var(--color-border)] px-2.5 py-1 ' +
  'text-[11px] font-medium text-[var(--color-text)] transition-colors hover:bg-[var(--color-bg-hover)] ' +
  'disabled:cursor-not-allowed disabled:opacity-50'
/** The version chip beside the kind badge — on a tile, the detail and the picker's catalog card. */
export const CHIP =
  'shrink-0 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-1 py-px text-[var(--color-text-muted)]'
const ICON_BUTTON =
  'shrink-0 rounded p-1 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)] ' +
  'disabled:cursor-not-allowed disabled:opacity-50'

/** Get and Update of desktop agents, run by the dialog's parent. */
export interface DesktopAgentActions {
  /** Repository whose Get is running. */
  gettingRepoId: string | null
  /** Local agent whose Update is running. */
  updatingAgentId: string | null
  /** The last refusal, and the tile it belongs to. */
  error: { repoId: string; message: string } | null
  onGet: (repoId: string) => void
  onUpdate: (agent: LibraryAgentDto) => void
  /** Open a local agent's page. */
  onOpenLocal: (agentId: string) => void
}

/** Update of cloud agents (apply the latest version to the install), run by the dialog's parent. */
export interface CloudUpdateActions {
  /** Install whose update is running. */
  updatingInstallId: string | null
  /** The last failure, and the install it belongs to. */
  error: { installId: string; message: string } | null
  onUpdate: (installId: string) => void
}

/** Removing the caller's install of a cloud agent from Cinna, run by the parent. */
export interface CloudUninstallActions {
  /** Install whose removal is running. */
  uninstallingInstallId: string | null
  /** The last failure, and the install it belongs to. */
  error: { installId: string; message: string } | null
  /** `onUninstalled` runs once the removal lands, if the caller is still there. */
  onUninstall: (installId: string, onUninstalled: () => void) => void
  /** Forget the last failure: the confirm was dismissed. */
  clearError: () => void
}

/** What the dialog knows about one item, joined from the listing, the team's copies and the agent rows. */
export interface CatalogEntryView {
  item: CatalogItem
  kind: CatalogItemKind
  name: string
  people: string | null
  version: string | null
  specs: CatalogCredentialSpec[]
  /** Cloud agent: the caller's install, the agent row it synced into, and whether it is behind. */
  cloud: { installId: string | null; agentId: string | null; updateAvailable: boolean } | null
  /** Desktop agent: the team-sharing entry with this computer's copy; null when there is none to act on. */
  desktop: LibraryAgentDto | null
  /** Skill: the names of this computer's agents that pin it. */
  usedBy: string[]
  /** Skill: the user's kit agents, each with why it cannot take the skill, for Add to agent…. */
  skillTargets: CatalogSkillTarget[]
}

/** The cloud-agent install's own parts of the dialog's props. */
export interface CloudInstallActions {
  installingBundleId: string | null
  onInstall: (bundleId: string) => void
  onOpen: (agentId: string) => void
}

/**
 * The green fact beside an item's action: Installed, or how many agents have
 * a skill. `yields` lets it truncate (full text in its tooltip) so a narrow
 * tile gives way on the pill, never on the button beside it.
 */
function InstalledPill({ text, yields = false }: { text: string; yields?: boolean }): React.JSX.Element {
  const type = useCatalogType()
  return (
    <span
      title={yields ? text : undefined}
      className={`${yields ? 'min-w-0 truncate' : 'shrink-0'} rounded bg-[var(--color-success)]/12 px-1.5 py-px ${type.meta} font-medium text-[var(--color-success)]`}
    >
      {text}
    </span>
  )
}

interface ItemActionProps {
  view: CatalogEntryView
  install: CloudInstallActions
  cloudUpdate: CloudUpdateActions | undefined
  desktop: DesktopAgentActions | undefined
  /** False right after the detail opened: a pointer click is then ignored. */
  settled: boolean
}

/**
 * Whether {@link CatalogItemAction} renders anything for this item: a tile
 * without one has no footer. A skill always (Add to agent…); a desktop agent
 * only with its team entry and the parent's actions.
 */
export function hasCatalogAction(view: CatalogEntryView, desktop: DesktopAgentActions | undefined): boolean {
  if (view.kind === 'skill') return true
  if (view.kind === 'desktop_agent') return view.desktop !== null && desktop !== undefined
  return true
}

/**
 * The action by kind, in the catalog's words (Get / Update / Open). A cloud
 * agent: Get (the quick install), then Open once it has synced, with Update
 * beside it while its install is behind; *Installed* only in the moment
 * between the install and its sync, when there is nothing to Open yet. A
 * desktop agent: Get, then Open, with Update while the team has moved past
 * this computer's copy. A skill: Add to agent…, with how many of the user's
 * agents already have it beside it.
 */
export function CatalogItemAction({ view, install, cloudUpdate, desktop, settled }: ItemActionProps): React.JSX.Element | null {
  const type = useCatalogType()
  const primary = sizedButton(PRIMARY, type)
  const secondary = sizedButton(SECONDARY, type)
  const guard = (run: () => void) => (event: React.MouseEvent) => {
    if (!isUnsettledClick(settled, event)) run()
  }
  if (view.kind === 'skill') {
    return (
      <>
        {view.usedBy.length > 0 && <InstalledPill text={CATALOG_SKILL_TEXT.inAgents(view.usedBy.length)} yields />}
        <CatalogSkillAddMenu
          skillName={view.name}
          packageUuid={view.item.uuid}
          targets={view.skillTargets}
          settled={settled}
        />
      </>
    )
  }
  if (view.kind === 'desktop_agent') {
    const agent = view.desktop
    if (!agent || !desktop) return null
    const localId = agent.localAgentId
    if (localId) {
      const updating = desktop.updatingAgentId === localId
      return (
        <>
          {agent.updateAvailable ? (
            <button
              type="button"
              disabled={desktop.updatingAgentId !== null}
              aria-busy={updating}
              onClick={guard(() => desktop.onUpdate(agent))}
              className={primary}
            >
              {updating && <Loader2 size={11} className="animate-spin" aria-hidden="true" />}
              {updating ? CATALOG_TEXT.updating : CATALOG_TEXT.update}
            </button>
          ) : null}
          <button type="button" onClick={guard(() => desktop.onOpenLocal(localId))} className={secondary}>
            {CATALOG_TEXT.open}
          </button>
        </>
      )
    }
    const getting = desktop.gettingRepoId === agent.repoId
    return (
      <button
        type="button"
        disabled={desktop.gettingRepoId !== null}
        aria-busy={getting}
        onClick={guard(() => desktop.onGet(agent.repoId))}
        className={primary}
      >
        {getting ? (
          <Loader2 size={11} className="animate-spin" aria-hidden="true" />
        ) : (
          <Download size={11} aria-hidden="true" />
        )}
        {getting ? CATALOG_TEXT.getting : CATALOG_TEXT.get}
      </button>
    )
  }
  const cloud = view.cloud
  if (cloud?.installId) {
    const installId = cloud.installId
    const agentId = cloud.agentId
    const updating = cloudUpdate?.updatingInstallId === installId
    const canUpdate = cloud.updateAvailable && cloudUpdate !== undefined
    if (!canUpdate && !agentId) return <InstalledPill text={CATALOG_TEXT.installed} />
    return (
      <>
        {canUpdate ? (
          <button
            type="button"
            disabled={cloudUpdate?.updatingInstallId != null}
            aria-busy={updating}
            onClick={guard(() => cloudUpdate?.onUpdate(installId))}
            className={primary}
          >
            {updating && <Loader2 size={11} className="animate-spin" aria-hidden="true" />}
            {updating ? CATALOG_TEXT.updating : CATALOG_TEXT.update}
          </button>
        ) : null}
        {agentId && (
          <button type="button" onClick={guard(() => install.onOpen(agentId))} className={secondary}>
            {CATALOG_TEXT.open}
          </button>
        )}
      </>
    )
  }
  const installing = install.installingBundleId === view.item.id
  const anyInstalling = install.installingBundleId !== null
  return (
    <button
      type="button"
      disabled={anyInstalling}
      aria-busy={installing}
      title={anyInstalling && !installing ? CATALOG_TEXT.anotherGetting : undefined}
      onClick={guard(() => install.onInstall(view.item.id))}
      className={primary}
    >
      {installing ? (
        <Loader2 size={11} className="animate-spin" aria-hidden="true" />
      ) : (
        <Download size={11} aria-hidden="true" />
      )}
      {installing ? CATALOG_TEXT.getting : CATALOG_TEXT.get}
    </button>
  )
}

/** The item's kind glyph in its accent well — a tile's (and the picker's catalog card's) or the detail's. */
export function KindIcon({ kind, size }: { kind: CatalogItemKind; size: 'tile' | 'detail' }): React.JSX.Element {
  const Icon = CATALOG_KIND_ICON[kind]
  return size === 'tile' ? (
    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[var(--color-accent)]/10 text-[var(--color-accent)]">
      <Icon size={14} aria-hidden="true" />
    </span>
  ) : (
    <span className="mr-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--color-accent)]/10 text-[var(--color-accent)]">
      <Icon size={18} aria-hidden="true" />
    </span>
  )
}

/** "Needs …": the credentials an item asks for, on a tile and the picker's catalog card. */
export function needsLine(specs: CatalogCredentialSpec[]): string | null {
  return specs.length > 0 ? CATALOG_TEXT.needs(specs.map((spec) => spec.name).join(', ')) : null
}

/**
 * One item in the grid. The body and the action are siblings, not a button
 * inside a button; the body is named by the item's name alone and opens the
 * detail. The name has its line to itself; the version sits beside the kind
 * badge, and wraps under it when the tile is too narrow for both. Who stands
 * behind the item has its own line, so a long badge and version never squeeze
 * it. A tile without an action has no footer. An error renders last in the
 * tile, so it never moves the button that caused it (ux_rules rules 1 and 6).
 */
export function CatalogItemTile({
  view,
  action,
  error,
  onSelect
}: {
  view: CatalogEntryView
  action: React.JSX.Element | null
  error: string | null
  onSelect: () => void
}): React.JSX.Element {
  const nameId = useId()
  const descriptionId = useId()
  const type = useCatalogType()
  const needs = needsLine(view.specs)
  return (
    <div
      role="group"
      aria-label={view.name}
      data-catalog-item={view.item.uuid}
      className="flex flex-col rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]/40 transition-colors hover:border-[var(--color-accent)]/30"
    >
      <button
        type="button"
        onClick={onSelect}
        aria-labelledby={nameId}
        aria-describedby={view.item.description ? descriptionId : undefined}
        className="flex flex-1 flex-col gap-1 rounded-t-lg p-3 text-left"
      >
        <span className="flex w-full min-w-0 items-center gap-2">
          <KindIcon kind={view.kind} size="tile" />
          <span id={nameId} title={view.name} className={`min-w-0 flex-1 truncate ${type.name} font-medium text-[var(--color-text)]`}>
            {view.name}
          </span>
        </span>
        <span className="flex w-full min-w-0 flex-wrap items-center gap-1.5">
          <CatalogKindBadge kind={view.kind} />
          {view.version && <span className={`${CHIP} ${type.meta}`}>{view.version}</span>}
        </span>
        {view.people && (
          <span className={`block w-full truncate ${type.meta} text-[var(--color-text-muted)]`} title={CATALOG_TEXT.by(view.people)}>
            {CATALOG_TEXT.by(view.people)}
          </span>
        )}
        {view.item.description && (
          <span id={descriptionId} className={`line-clamp-3 ${type.body} leading-relaxed text-[var(--color-text-secondary)]`}>
            {view.item.description}
          </span>
        )}
        {needs && (
          <span className={`block w-full truncate ${type.meta} text-[var(--color-text-muted)]`} title={needs}>
            {needs}
          </span>
        )}
      </button>
      {action && (
        <div className="flex items-center justify-end gap-1.5 border-t border-[var(--color-border)] px-3 py-2">{action}</div>
      )}
      {error && (
        <div role="alert" className={`px-3 pb-2 ${type.meta} text-[var(--color-danger)]`}>
          {error}
        </div>
      )}
    </div>
  )
}

/**
 * One item's detail — in the dialog a layer over the grid, under Settings in
 * the grid's place: what the tile says at full length, its credential slots,
 * and its versions read when it opens. Who stands behind it is the
 * Maintainers (or Shared by) row, not a header line. An installed cloud agent
 * also offers its page on the Cinna server and, given `uninstall`, removing
 * the install.
 */
export function CatalogItemDetailView({
  view,
  action,
  error,
  onBack,
  uninstall,
  settled = true
}: {
  view: CatalogEntryView
  action: React.JSX.Element | null
  error: string | null
  onBack: () => void
  uninstall?: CloudUninstallActions
  /** False right after the detail opened: a pointer click on its notes' Show more is then ignored. */
  settled?: boolean
}): React.JSX.Element {
  const { item } = view
  const type = useCatalogType()
  const surface = useCatalogSurface()
  const installId = view.kind === 'cloud_agent' ? (view.cloud?.installId ?? null) : null
  return (
    <div
      className={
        surface === 'dialog'
          ? 'absolute inset-0 space-y-3 overflow-y-auto bg-[var(--color-bg-secondary)] px-5 pb-5'
          : 'space-y-3'
      }
    >
      <div className="flex items-start gap-2">
        <button
          type="button"
          autoFocus
          onClick={onBack}
          aria-label={CATALOG_TEXT.back}
          title={CATALOG_TEXT.back}
          className="-ml-1.5 mt-1.5 shrink-0 rounded p-1 text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)]"
        >
          <ChevronLeft size={16} />
        </button>
        <KindIcon kind={view.kind} size="detail" />
        <div className="min-w-0 flex-1">
          <h3 className={`break-words ${type.heading} font-semibold text-[var(--color-text)]`}>{view.name}</h3>
          <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-1.5">
            <CatalogKindBadge kind={view.kind} />
            {view.version && <span className={`${CHIP} ${type.meta}`}>{view.version}</span>}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {action}
          {/* Keyed by the install: a confirm belongs to the install it was opened on. */}
          {installId && <CloudInstallControls key={installId} name={view.name} installId={installId} uninstall={uninstall} />}
        </div>
      </div>
      {error && (
        <div role="alert" className={`${type.meta} text-[var(--color-danger)]`}>
          {error}
        </div>
      )}
      {item.description && (
        <p className={`whitespace-pre-wrap ${type.text} leading-relaxed text-[var(--color-text-secondary)]`}>
          {item.description}
        </p>
      )}
      <dl className={`grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 ${type.body}`}>
        {view.people && (
          <>
            <dt className="text-[var(--color-text-muted)]">
              {item.maintainers?.length ? CATALOG_TEXT.maintainersLabel : CATALOG_TEXT.publisherLabel}
            </dt>
            <dd className="min-w-0 break-words text-[var(--color-text)]">{view.people}</dd>
          </>
        )}
        {view.kind === 'skill' && view.usedBy.length > 0 && (
          <>
            <dt className="text-[var(--color-text-muted)]">{CATALOG_TEXT.usedByLabel}</dt>
            <dd className="min-w-0 break-words text-[var(--color-text)]">{view.usedBy.join(', ')}</dd>
          </>
        )}
        <dt className="text-[var(--color-text-muted)]">{CATALOG_TEXT.usersLabel}</dt>
        <dd className="text-[var(--color-text)]">{item.install_count ?? 0}</dd>
        <dt className="text-[var(--color-text-muted)]">{CATALOG_TEXT.catalogIdLabel}</dt>
        <dd className="min-w-0">
          <span className={`inline-block max-w-full truncate rounded bg-[var(--color-bg)] px-1.5 py-0.5 align-middle font-mono ${type.meta} text-[var(--color-text-secondary)]`}>
            {item.id}
          </span>
        </dd>
      </dl>
      <div className="space-y-2">
        <CatalogCardCredentials
          entry={{ bundleId: item.id, requiredCredentialSpecs: view.specs }}
          // What a cloud install would link is only checkable before it is installed.
          enabled={view.kind === 'cloud_agent' && !view.cloud?.installId}
          compact={surface === 'dialog'}
        />
      </div>
      <CatalogVersions uuid={item.uuid} settled={settled} />
    </div>
  )
}

/**
 * An installed cloud agent's occasional actions, as icons beside its action:
 * its page on the Cinna server, and Uninstall behind a confirm that says the
 * App Data is kept (ux_rules rule 5). The removal runs in the parent; the
 * confirm stays open, and undismissable, until it lands, and a failure shows
 * inside it. It closes when the removal succeeds, not when the listing stops
 * naming the install — that follows a re-read, and may name another install.
 */
function CloudInstallControls({
  name,
  installId,
  uninstall
}: {
  name: string
  installId: string
  uninstall: CloudUninstallActions | undefined
}): React.JSX.Element {
  const serverUrl = useCatalogServerUrl()
  const surface = useCatalogSurface()
  const [confirming, setConfirming] = useState(false)
  const pending = uninstall?.uninstallingInstallId === installId
  const clearError = uninstall?.clearError
  const close = (): void => {
    if (pending) return
    setConfirming(false)
    clearError?.()
  }
  // Escape closes the confirm, not the catalog dialog's detail under it: the
  // dialog listens on window in the bubble phase, after this.
  useEffect(() => {
    if (!confirming) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopImmediatePropagation()
      if (pending) return
      setConfirming(false)
      clearError?.()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [confirming, pending, clearError])
  const href = serverUrl.data ? `${serverUrl.data.replace(/\/$/, '')}/agent/${installId}` : null
  const openUninstall = (): void => {
    uninstall?.clearError()
    setConfirming(true)
  }
  // Under Settings these are its row icon buttons (ux_rules rule 13); the dialog keeps its bare icons.
  const settings = surface === 'settings'
  return (
    <>
      {href &&
        (settings ? (
          <SettingsIconButton
            onClick={() => void window.api.system.openExternal(href)}
            title={CATALOG_TEXT.openInCinna}
            aria-label={CATALOG_TEXT.openInCinnaLabel(name)}
          >
            <ExternalLink size={14} aria-hidden="true" />
          </SettingsIconButton>
        ) : (
          <button
            type="button"
            onClick={() => void window.api.system.openExternal(href)}
            title={CATALOG_TEXT.openInCinna}
            aria-label={CATALOG_TEXT.openInCinnaLabel(name)}
            className={ICON_BUTTON}
          >
            <ExternalLink size={13} aria-hidden="true" />
          </button>
        ))}
      {uninstall &&
        (settings ? (
          <SettingsIconButton
            onClick={openUninstall}
            title={CATALOG_TEXT.uninstall}
            aria-label={CATALOG_TEXT.uninstallLabel(name)}
            danger
          >
            <PackageX size={14} aria-hidden="true" />
          </SettingsIconButton>
        ) : (
          <button
            type="button"
            onClick={openUninstall}
            title={CATALOG_TEXT.uninstall}
            aria-label={CATALOG_TEXT.uninstallLabel(name)}
            className={`${ICON_BUTTON} hover:text-[var(--color-danger)]`}
          >
            <PackageX size={13} aria-hidden="true" />
          </button>
        ))}
      {confirming && uninstall && (
        <CatalogUninstallModal
          agentName={name}
          pending={pending}
          errorMessage={uninstall.error?.installId === installId ? uninstall.error.message : null}
          onConfirm={() => uninstall.onUninstall(installId, () => setConfirming(false))}
          onClose={close}
        />
      )}
    </>
  )
}

/** Notes past this many characters or lines start clamped, with Show more. */
const LONG_NOTES_CHARS = 240
const LONG_NOTES_LINES = 3

function ReleaseNotes({ text, settled }: { text: string; settled: boolean }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const type = useCatalogType()
  const long = text.length > LONG_NOTES_CHARS || text.split('\n').length > LONG_NOTES_LINES
  return (
    <div>
      <p
        className={`whitespace-pre-wrap ${type.body} leading-relaxed text-[var(--color-text-secondary)] ${
          long && !open ? 'line-clamp-3' : ''
        }`}
      >
        {text}
      </p>
      {long && (
        <button
          type="button"
          // The first version's toggle can open under the pointer that clicked the tile.
          onClick={(event) => {
            if (!isUnsettledClick(settled, event)) setOpen((value) => !value)
          }}
          aria-expanded={open}
          className={`mt-0.5 ${type.body} font-medium text-[var(--color-accent)] transition-colors hover:text-[var(--color-accent-hover)]`}
        >
          {open ? CATALOG_TEXT.showLess : CATALOG_TEXT.showMore}
        </button>
      )}
    </div>
  )
}

/**
 * The item's versions, newest first, read when the detail opens. Loading and
 * a failure stay in this section — the detail and the dialog stay open
 * (ux_rules rule 6).
 */
function CatalogVersions({ uuid, settled }: { uuid: string; settled: boolean }): React.JSX.Element {
  const detail = useCatalogItemDetail(uuid)
  const headingId = useId()
  const type = useCatalogType()
  const revisions = detail.data?.revisions ?? []
  return (
    <section aria-labelledby={headingId} className="space-y-2">
      <h4 id={headingId} className={`${type.subheading} text-[var(--color-text-muted)]`}>
        {CATALOG_TEXT.versionsHeading}
      </h4>
      {detail.isLoading ? (
        <div className={`flex items-center gap-1.5 ${type.body} text-[var(--color-text-muted)]`}>
          <Loader2 size={11} className="animate-spin" aria-hidden="true" />
          {CATALOG_TEXT.versionsLoading}
        </div>
      ) : detail.isError && !detail.data ? (
        <div role="alert" className={`flex flex-wrap items-center gap-2 ${type.body} text-[var(--color-danger)]`}>
          <span>
            {CATALOG_TEXT.versionsFailed} {unwrapIpcError(detail.error, '')}
          </span>
          <button
            type="button"
            onClick={() => void detail.refetch()}
            disabled={detail.isFetching}
            className={sizedButton(SECONDARY, type)}
          >
            <RefreshCw size={10} className={detail.isFetching ? 'animate-spin' : ''} aria-hidden="true" />
            {CATALOG_TEXT.retry}
          </button>
        </div>
      ) : revisions.length === 0 ? (
        <div className={`${type.body} text-[var(--color-text-muted)]`}>{CATALOG_TEXT.versionsEmpty}</div>
      ) : (
        <ol className="space-y-2">
          {revisions.map((revision) => {
            const date = catalogDateLabel(revision.published_at)
            const by = revision.published_by?.display_name
            return (
              <li
                key={revision.revision_number}
                className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)]/40 px-2.5 py-2"
              >
                <div className={`flex min-w-0 items-baseline gap-2 ${type.body}`}>
                  <span className="shrink-0 font-medium text-[var(--color-text)]">
                    {catalogVersionLabel(revision.revision_number, revision.version)}
                  </span>
                  {by && <span className="min-w-0 truncate text-[var(--color-text-muted)]">{CATALOG_TEXT.sharedBy(by)}</span>}
                  {date && <span className="ml-auto shrink-0 text-[var(--color-text-muted)]">{date}</span>}
                </div>
                {revision.release_notes?.trim() && <ReleaseNotes text={revision.release_notes.trim()} settled={settled} />}
              </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}
