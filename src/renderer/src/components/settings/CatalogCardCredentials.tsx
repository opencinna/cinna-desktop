/**
 * Renders the install-context-driven sections of an expanded catalog card:
 * the "Required credentials" list with per-spec match-status icons, the AI
 * credentials sibling section, and the cross-cutting error chip + retry.
 *
 * Self-contained: owns its own React Query subscription to
 * `useInstallContext` so the parent only has to gate it via `enabled` (the
 * card's `expanded && !entry.isInstalled` predicate). For installed bundles
 * the parent passes `enabled={false}` and the rows fall back to a
 * providedBy-only classification.
 */
import { useMemo } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  FileText,
  KeyRound,
  Loader2,
  MessageCircle,
  RotateCw,
  Wrench
} from 'lucide-react'
import type {
  CatalogCredentialSpec,
  CatalogEntryDto,
  InstallContextPublisherSummaryDto,
  InstallContextSpecDto
} from '../../../../shared/catalog'
import { useInstallContext } from '../../hooks/useCatalog'

interface CatalogCardCredentialsProps {
  entry: CatalogEntryDto
  /** Gates the lazy install-context fetch; pass false for installed bundles. */
  enabled: boolean
}

const PROVIDED_BY_LABEL: Record<string, string> = {
  user: 'You provide',
  publisher: 'Shared by publisher',
  template: 'Template'
}

const BADGE_BASE =
  'shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium leading-tight'

function ProvidedByBadge({ providedBy }: { providedBy: string }): React.JSX.Element {
  const label = PROVIDED_BY_LABEL[providedBy] ?? providedBy
  let tone = 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)]'
  if (providedBy === 'publisher') {
    tone = 'bg-[var(--color-success)]/12 text-[var(--color-success)]'
  } else if (providedBy === 'template') {
    tone = 'bg-[var(--color-accent)]/10 text-[var(--color-accent)]'
  }
  return <span className={`${BADGE_BASE} ${tone}`}>{label}</span>
}

function TypeBadge({ type }: { type: string }): React.JSX.Element {
  return (
    <span
      className={`${BADGE_BASE} bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)] font-mono`}
    >
      {type}
    </span>
  )
}

/**
 * Three-state credential icon. Driven by the per-spec install-context verdict
 * when available: green check ⇒ covered (publisher row, or an existing
 * credential already matches); template ⇒ cinna-server will materialise a
 * template-derived placeholder and the installer will need to fill in private
 * fields; key ⇒ no match found, the installer will need to create a brand
 * new credential. While the context is being fetched and we haven't received
 * verdict data yet, a spinner stands in. Without install-context data we
 * fall back to a providedBy-only classification (publisher/template ⇒ green,
 * user ⇒ muted key).
 */
function CredentialIcon({
  spec,
  ctx,
  isFetching
}: {
  spec: CatalogCredentialSpec
  ctx: InstallContextSpecDto | undefined
  isFetching: boolean
}): React.JSX.Element {
  if (isFetching && !ctx) {
    return (
      <Loader2 size={11} className="animate-spin text-[var(--color-text-muted)] shrink-0" />
    )
  }
  if (ctx) {
    if (ctx.providedBy === 'publisher' || ctx.hasSuggestedMatch) {
      return (
        <CheckCircle2 size={11} className="text-[var(--color-success)] shrink-0" />
      )
    }
    if (ctx.providedBy === 'template') {
      return <FileText size={11} className="text-[var(--color-accent)] shrink-0" />
    }
    return <KeyRound size={11} className="text-[var(--color-warning)] shrink-0" />
  }
  if (spec.providedBy === 'user') {
    return <KeyRound size={11} className="text-[var(--color-text-muted)] shrink-0" />
  }
  return <CheckCircle2 size={11} className="text-[var(--color-success)] shrink-0" />
}

/**
 * Read-only mirror of cinna-core's `InstallAICredentialSection`. We only need
 * to show the user what the install would link — picking happens on the
 * server's install page for custom installs, and quick install just forwards
 * `use_publisher_ai` when offered.
 */
function AICredentialsSection({
  aiProvidedByPublisher,
  conversation,
  building,
  isFetching
}: {
  aiProvidedByPublisher: boolean
  conversation: InstallContextPublisherSummaryDto | null
  building: InstallContextPublisherSummaryDto | null
  isFetching: boolean
}): React.JSX.Element {
  if (aiProvidedByPublisher) {
    return (
      <>
        {conversation && (
          <AIPublisherRow role="Conversation" icon={MessageCircle} summary={conversation} />
        )}
        {building && (
          <AIPublisherRow role="Building" icon={Wrench} summary={building} />
        )}
        {!conversation && !building && (
          <div className="flex items-center gap-2 text-[12px] text-[var(--color-text-secondary)]">
            <CheckCircle2 size={11} className="text-[var(--color-success)] shrink-0" />
            <span>AI credentials</span>
            <span className="ml-auto">
              <ProvidedByBadge providedBy="publisher" />
            </span>
          </div>
        )}
      </>
    )
  }
  return (
    <div className="flex items-center gap-2 text-[12px] text-[var(--color-text-secondary)]">
      {isFetching ? (
        <Loader2 size={11} className="animate-spin text-[var(--color-text-muted)] shrink-0" />
      ) : (
        <KeyRound size={11} className="text-[var(--color-warning)] shrink-0" />
      )}
      <span>AI credentials</span>
      <span className="text-[var(--color-text-muted)] text-[11px]">
        your account defaults
      </span>
      <span className="ml-auto">
        <ProvidedByBadge providedBy="user" />
      </span>
    </div>
  )
}

function AIPublisherRow({
  role,
  icon: Icon,
  summary
}: {
  role: 'Conversation' | 'Building'
  icon: typeof MessageCircle
  summary: InstallContextPublisherSummaryDto
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 text-[12px] text-[var(--color-text-secondary)]">
      <CheckCircle2 size={11} className="text-[var(--color-success)] shrink-0" />
      <Icon size={11} className="text-[var(--color-text-muted)] shrink-0" />
      <span className="text-[var(--color-text-muted)]">{role}:</span>
      <span>{summary.name}</span>
      <TypeBadge type={summary.type} />
      <span className="ml-auto">
        <ProvidedByBadge providedBy="publisher" />
      </span>
    </div>
  )
}

export function CatalogCardCredentials({
  entry,
  enabled
}: CatalogCardCredentialsProps): React.JSX.Element | null {
  const installContext = useInstallContext(entry.bundleId, enabled)
  const ctxBySpec = useMemo(
    () =>
      new Map<string, InstallContextSpecDto>(
        (installContext.data?.specs ?? []).map((s) => [s.name, s])
      ),
    [installContext.data]
  )
  const installContextErrored = installContext.isError && !installContext.data

  if (
    entry.requiredCredentialSpecs.length === 0 &&
    !installContext.data &&
    !installContextErrored
  ) {
    return null
  }

  return (
    <>
      {installContextErrored && (
        <div className="flex items-center gap-1.5 text-[11px] text-[var(--color-warning)]">
          <AlertTriangle size={11} className="shrink-0" />
          <span>Couldn&rsquo;t check matching credentials — icons may be approximate</span>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              void installContext.refetch()
            }}
            className="ml-auto inline-flex items-center gap-1 text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-colors"
            aria-label="Retry checking matches"
          >
            <RotateCw size={10} />
            Retry
          </button>
        </div>
      )}

      {entry.requiredCredentialSpecs.length > 0 && (
        <div>
          <label className="flex items-center gap-1.5 text-[12px] text-[var(--color-text-muted)] mb-1">
            Required credentials ({entry.requiredCredentialSpecs.length})
            {installContext.isFetching && (
              <Loader2
                size={10}
                className="animate-spin text-[var(--color-text-muted)]"
                aria-label="Checking matching credentials"
              />
            )}
          </label>
          <div className="space-y-0.5">
            {entry.requiredCredentialSpecs.map((s) => {
              const ctx = ctxBySpec.get(s.name)
              return (
                <div
                  key={s.name}
                  className="flex items-center gap-2 text-[12px] text-[var(--color-text-secondary)]"
                >
                  <CredentialIcon
                    spec={s}
                    ctx={ctx}
                    isFetching={installContext.isFetching}
                  />
                  <span>{s.name}</span>
                  <TypeBadge type={s.type} />
                  <span className="ml-auto">
                    <ProvidedByBadge providedBy={s.providedBy} />
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/*
       * AI credentials live in a sibling section because the install binds
       * them as a separate pair (conversation + building) rather than another
       * required_credential_spec entry. Hidden when there's no install-context
       * data (installed bundle or fetch errored — the warning chip above is
       * the user's signal in the errored case).
       */}
      {installContext.data && (
        <div>
          <label className="flex items-center gap-1.5 text-[12px] text-[var(--color-text-muted)] mb-1">
            AI credentials
          </label>
          <div className="space-y-0.5">
            <AICredentialsSection
              aiProvidedByPublisher={installContext.data.aiProvidedByPublisher}
              conversation={installContext.data.aiPublisherSummaries.conversation}
              building={installContext.data.aiPublisherSummaries.building}
              isFetching={installContext.isFetching}
            />
          </div>
        </div>
      )}
    </>
  )
}
