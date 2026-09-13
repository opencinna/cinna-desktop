import { Link2 } from 'lucide-react'
import { useAddManagedCliToPath, useManagedLocalDevCli } from '../../hooks/useLocalDev'
import { SettingsButton, SettingsInfoTip } from './SettingsLayout'
import { DeveloperToolsSettingsSection } from './DeveloperToolsSettingsSection'

/** Desktop-owned tools and terminal integration, shared across profiles. */
export function LocalDevSettingsSection(): React.JSX.Element {
  const { data: managedCli, isPending, isError } = useManagedLocalDevCli()
  const addToPath = useAddManagedCliToPath()
  const result = addToPath.data
  const pathResult = result ? {
    ok: result.ok,
    text: result.ok
      ? result.path
        ? `Linked. cinna is now at ${result.path} — open a new terminal for it to be found.`
        : 'Linked. Open a new terminal for it to be found.'
      : result.reason ?? 'The link could not be created.'
  } : null

  return (
    <div className="space-y-6">
      <section>
        <SectionTitle
          info={
            <SettingsInfoTip label="About desktop local development tools">
              <p>
                Cinna Desktop manages its own development tools for all profiles. Account
                workspaces, setup and consent are under Profile → Local Development.
              </p>
            </SettingsInfoTip>
          }
        >
          Desktop tools
        </SectionTitle>
        <Card>
          <div className="space-y-3">
            {managedCli ? (
              <>
                <Field label="cinna-cli" value={managedCli.version ?? 'Unknown'} />
                <Field label="Desktop App Cinna-CLI managed binary" value={managedCli.path} />
              </>
            ) : (
              <Line>
                {isPending
                  ? 'Checking installed tools…'
                  : isError
                    ? 'Could not read installed tools. Try reopening this page.'
                    : 'The managed cinna-cli is not installed. Set it up under Profile → Local Development.'}
              </Line>
            )}
          </div>
        </Card>
      </section>

      {managedCli && (
        <section>
          <SectionTitle>Your terminal</SectionTitle>
          <Card>
            <div className="space-y-2">
              <div className="text-[14px] font-medium text-[var(--color-text)]">
                Add <span className="font-mono">cinna</span> to my PATH
              </div>
              <p className="text-[13px] text-[var(--color-text-muted)] leading-relaxed">
                Links the managed cinna-cli into <span className="font-mono">~/.local/bin</span> so
                you can run <span className="font-mono">cinna</span> in your own terminal. This is
                only for you — Cinna Desktop always uses its own copy and does not need the link.
              </p>
              <Actions>
                <SettingsButton onClick={() => addToPath.mutate()} disabled={addToPath.isPending}>
                  <Link2 size={13} /> Add to PATH
                </SettingsButton>
              </Actions>
              {pathResult && (
                <div
                  className={`text-[13px] leading-relaxed break-words ${
                    pathResult.ok
                      ? 'text-[var(--color-text-secondary)]'
                      : 'text-[var(--color-danger)]'
                  }`}
                >
                  {pathResult.text}
                </div>
              )}
            </div>
          </Card>
        </section>
      )}

      <DeveloperToolsSettingsSection />
    </div>
  )
}

function SectionTitle({
  children,
  info
}: {
  children: React.ReactNode
  info?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="mb-2 flex min-h-[26px] items-center gap-1.5">
      <h2 className="text-[14px] font-semibold text-[var(--color-text-muted)] uppercase tracking-wider">
        {children}
      </h2>
      {info}
    </div>
  )
}

function Card({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
      {children}
    </div>
  )
}

function Line({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <p className="text-[13px] text-[var(--color-text-muted)] leading-relaxed">{children}</p>
}

function Actions({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="flex flex-wrap items-center gap-2 pt-0.5">{children}</div>
}

function Field({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
      <span className="text-[13px] text-[var(--color-text-muted)]">{label}</span>
      <span className="font-mono text-[12px] text-[var(--color-text-secondary)] break-all">
        {value}
      </span>
    </div>
  )
}
