import { RefreshCw } from 'lucide-react'
import { OpenCodeSettingsFields } from './OpenCodeSettingsFields'
import { isRuntimeToolId } from '../../../../shared/localTools'
import { useLocalAgents } from '../../hooks/useLocalAgents'
import { useEngineBinary } from '../../hooks/useEngine'
import { useLocalTools, useRefreshLocalTools } from '../../hooks/useLocalTools'
import { SettingsButton, SettingsCard, SettingsLabel, SettingsSection } from './SettingsLayout'

/** Globally detected tools, shown in Settings → Local Development. */
export function DeveloperToolsSettingsSection(): React.JSX.Element {
  const { data: tools } = useLocalTools()
  const { data: agents } = useLocalAgents()
  const { data: binary } = useEngineBinary()
  const refreshTools = useRefreshLocalTools()
  const contractVersion = agents?.roots.find((root) => root.isDefault)?.contractVersion ?? null
  // Runtime availability is reported beside its picker in Settings → Agents.
  const otherTools = (tools ?? []).filter(
    (tool) => !isRuntimeToolId(tool.id) && tool.id !== 'opencode'
  )

  const version = binary?.state === 'ready'
    ? binary.version ?? 'Unknown'
    : binary?.state === 'failed'
      ? 'Unavailable'
      : binary?.state === 'resolving'
        ? 'Checking…'
        : 'Not checked yet'

  return (
    <SettingsSection
      title="Developer Tools"
      action={
        <SettingsButton
          onClick={() => refreshTools.mutate()}
          disabled={refreshTools.isPending}
          title="Detect again after installing something"
          aria-label="Refresh detected tools"
        >
          <RefreshCw size={13} className={refreshTools.isPending ? 'animate-spin' : undefined} />
          Refresh
        </SettingsButton>
      }
    >
      <SettingsCard>
        <div className="mb-2.5">
          <SettingsLabel
            info={
              <p>
                What else Cinna found installed globally, and the version each one reported. A
                row reading Not found is a tool this machine does not have — nothing here is
                installed for you. The runtimes an agent can run on are under Agents → Runtime.
              </p>
            }
          >
            Detected on this machine
          </SettingsLabel>
        </div>
        {/*
          A table, not chips. Chips could only say "present", so a user
          checking *which* Claude Code or which uv the desktop had picked up
          had to leave and ask a terminal. Every tool is listed, installed or
          not, because "is it detected?" is the question and an absent chip
          was indistinguishable from a tool Cinna does not know about.
        */}
        <div className="overflow-hidden rounded-md border border-[var(--color-border)]">
          <table className="w-full table-fixed border-collapse text-[13px]">
            <thead>
              <tr className="bg-[var(--color-bg-secondary)] text-[var(--color-text-muted)]">
                <th className="w-[45%] px-2.5 py-1.5 text-left font-medium">Tool</th>
                <th className="px-2.5 py-1.5 text-left font-medium">Version</th>
              </tr>
            </thead>
            <tbody>
              {otherTools.map((tool) => (
                <tr key={tool.id} className="border-t border-[var(--color-border)]">
                  <td className="truncate px-2.5 py-1.5 text-[var(--color-text)]" title={tool.path ?? undefined}>
                    {tool.label}
                  </td>
                  {/*
                    `cleanVersion` keeps an unrecognised `--version` line up
                    to 40 characters, which does not fit the column — so the
                    cell carries its own title rather than borrowing the
                    row's, which holds the path.
                  */}
                  <td className="truncate px-2.5 py-1.5" title={tool.version ?? undefined}>
                    {!tool.available ? (
                      <span className="text-[var(--color-text-muted)]">Not found</span>
                    ) : tool.version ? (
                      <span className="font-mono text-[12px] text-[var(--color-text-secondary)]">
                        {tool.version}
                      </span>
                    ) : (
                      // Installed, but nothing to ask or nothing usable came
                      // back — an `.app` with no CLI shim, or a probe that
                      // failed. Not the same answer as Not found, and the
                      // table must not blur the two.
                      <span className="text-[var(--color-text-muted)]">
                        {tool.source === 'app-bundle' ? 'Installed (app)' : 'Installed'}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
              <tr className="border-t border-[var(--color-border)]">
                <td
                  className="truncate px-2.5 py-1.5 text-[var(--color-text)]"
                  title={binary?.state === 'ready' ? binary.path : undefined}
                >
                  OpenCode
                </td>
                <td
                  className="truncate px-2.5 py-1.5"
                  title={binary?.state === 'failed' ? binary.error : version}
                >
                  <span className={binary?.state === 'ready' && binary.version
                    ? 'font-mono text-[12px] text-[var(--color-text-secondary)]'
                    : 'text-[var(--color-text-muted)]'}>
                    {version}
                  </span>
                </td>
              </tr>
              {otherTools.length === 0 && (
                <tr>
                  <td colSpan={2} className="px-2.5 py-2 text-[var(--color-text-muted)]">
                    Detecting…
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {binary?.state === 'failed' && (
          <p className="mt-1.5 text-[13px] text-[var(--color-danger)]">{binary.error}</p>
        )}
        <OpenCodeSettingsFields />
        <div className="border-t border-[var(--color-border)] pt-2.5 text-[12px] text-[var(--color-text-muted)]">
          Kit contract {contractVersion ?? 'unknown'} · bundled with this app
        </div>
      </SettingsCard>
    </SettingsSection>
  )
}
