import { RefreshCw } from 'lucide-react'
import { useIsMutating } from '@tanstack/react-query'
import { OpenCodeSettingsFields } from './OpenCodeSettingsFields'
import { CodexSettingsFields } from './CodexSettingsFields'
import { ClaudeSettingsFields } from './ClaudeSettingsFields'
import { isRuntimeToolId } from '../../../../shared/localTools'
import { useLocalAgents } from '../../hooks/useLocalAgents'
import { useClaudeBinary, useCodexBinary, useEngineBinary } from '../../hooks/useEngine'
import { codexToolCell } from './codexStatus'
import { claudeToolCell } from './claudeStatus'
import { useAppSettings } from '../../hooks/useAppSettings'
import { useLocalTools, useRefreshLocalTools } from '../../hooks/useLocalTools'
import { SettingsButton, SettingsCard, SettingsLabel, SettingsSection } from './SettingsLayout'
import { useCinnaCliUpdate, useLocalDev, useManagedLocalDevCli, useUpdateCinnaCli } from '../../hooks/useLocalDev'
import { unwrapIpcError } from '../../utils/ipcError'

/** Shared developer tools, shown in Default → Local Development. */
export function DeveloperToolsSettingsSection(): React.JSX.Element {
  const { data: tools } = useLocalTools()
  const { data: agents } = useLocalAgents()
  const { data: binary } = useEngineBinary()
  const { data: codexBinary } = useCodexBinary()
  const { data: claudeBinary } = useClaudeBinary()
  const { data: appSettings } = useAppSettings()
  const codexCell = codexToolCell(codexBinary, (appSettings?.localAgentsCodexPath ?? '').trim() !== '')
  const claudeCell = claudeToolCell(claudeBinary, (appSettings?.localAgentsClaudePath ?? '').trim() !== '')
  const refreshTools = useRefreshLocalTools()
  const managedCli = useManagedLocalDevCli()
  const cliUpdate = useCinnaCliUpdate()
  const updateCli = useUpdateCinnaCli()
  const updating = useIsMutating({ mutationKey: ['update-cinna-cli'] }) > 0
  const localDev = useLocalDev()
  const refreshing = refreshTools.isPending || cliUpdate.isFetching || managedCli.isFetching
  const contractVersion = agents?.roots.find((root) => root.isDefault)?.contractVersion ?? null
  // Runtime availability is reported beside its picker in Settings → Agents.
  const otherTools = (tools ?? []).map((tool) => tool.id === 'cinna' && managedCli.data
    ? { ...tool, available: true, version: managedCli.data.version, path: managedCli.data.path, source: 'managed' as const }
    : tool).filter(
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
          onClick={() => { refreshTools.mutate(); void cliUpdate.refetch(); void managedCli.refetch() }}
          disabled={refreshing || updating}
          title="Detect again after installing something"
          aria-label="Refresh detected tools"
        >
          <RefreshCw size={13} className={refreshing ? 'animate-spin' : undefined} />
          Refresh
        </SettingsButton>
      }
    >
      <SettingsCard>
        <div className="mb-2.5">
          <SettingsLabel
            info={
              <p>
                Installed tools and the version each one reported. Cinna CLI shows the desktop-managed copy when installed; Update installs the version advertised by your connected Cinna server. A
                row reading Not found is a tool this machine does not have — nothing here is
                installed until you request it. The runtimes an agent can run on are under Agents → Runtime.
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
                    {tool.label}{tool.id === 'cinna' && tool.source === 'managed' && <span className="ml-1 text-[11px] text-[var(--color-text-muted)]">(managed)</span>}
                  </td>
                  {/*
                    `cleanVersion` keeps an unrecognised `--version` line up
                    to 40 characters, which does not fit the column — so the
                    cell carries its own title rather than borrowing the
                    row's, which holds the path.
                  */}
                  <td className="px-2.5 py-1.5" title={tool.version ?? undefined}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      {!tool.available ? (
                        <span className="text-[var(--color-text-muted)]">Not found</span>
                      ) : tool.version ? (
                        <span className="max-w-full truncate font-mono text-[12px] text-[var(--color-text-secondary)]">
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
                      {tool.id === 'cinna' && (cliUpdate.data?.updateAvailable || updating) && (
                        <SettingsButton onClick={() => updateCli.mutate()} disabled={updating || localDev.phase === 'installing'} title={`Update the managed Cinna CLI to ${cliUpdate.data?.targetVersion ?? 'the server’s required version'}`}>
                          {updating && <RefreshCw size={13} className="animate-spin" />}
                          {updating ? 'Updating…' : 'Update'}
                        </SettingsButton>
                      )}
                    </div>
                    {tool.id === 'cinna' && cliUpdate.data?.targetVersion && <p className="mt-1 text-[11px] text-[var(--color-text-muted)]">Required by server: {cliUpdate.data.targetVersion}</p>}
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
              {/*
                The Codex **Cinna runs**, above the Codex Path field that replaces
                it — the OpenCode row's counterpart, built the same. Not the
                `codex` on PATH: that one is only what "Open in Codex" launches,
                and reporting it here would describe a binary no session uses
                (ux_rules rule 9). `unverified` is the configured path's label
                everywhere it appears.
              */}
              <tr className="border-t border-[var(--color-border)]">
                <td
                  className="truncate px-2.5 py-1.5 text-[var(--color-text)]"
                  title={codexBinary?.state === 'ready' ? codexBinary.path : undefined}
                >
                  Codex
                </td>
                <td
                  className="truncate px-2.5 py-1.5"
                  title={codexBinary?.state === 'failed' ? codexBinary.error : codexCell.text || undefined}
                >
                  <span className={codexCell.mono
                    ? 'font-mono text-[12px] text-[var(--color-text-secondary)]'
                    : 'text-[var(--color-text-muted)]'}>
                    {codexCell.text}
                  </span>
                </td>
              </tr>
              {/* The Claude Code **Cinna runs** — the Codex row's twin, for its reason. */}
              <tr className="border-t border-[var(--color-border)]">
                <td
                  className="truncate px-2.5 py-1.5 text-[var(--color-text)]"
                  title={claudeBinary?.state === 'ready' ? claudeBinary.path : undefined}
                >
                  Claude Code
                </td>
                <td
                  className="truncate px-2.5 py-1.5"
                  title={claudeBinary?.state === 'failed' ? claudeBinary.error : claudeCell.text || undefined}
                >
                  <span className={claudeCell.mono
                    ? 'font-mono text-[12px] text-[var(--color-text-secondary)]'
                    : 'text-[var(--color-text-muted)]'}>
                    {claudeCell.text}
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
        {updating && <p role="status" className="mt-2 text-[13px] text-[var(--color-text-secondary)]">{localDev.phase === 'installing' ? localDev.step : 'Updating Cinna CLI…'}</p>}
        {updateCli.isSuccess && !updating && <p role="status" className="mt-2 text-[13px] text-[var(--color-success)]">Cinna CLI updated.</p>}
        {(updateCli.error || cliUpdate.error) && <p role="alert" className="mt-2 text-[13px] text-[var(--color-danger)]">{unwrapIpcError(updateCli.error ?? cliUpdate.error, 'Could not check for Cinna CLI updates. Try Refresh.')}</p>}
        {/* A runtime's failure is said under its own path field
            (`RuntimePathField`), not here: above the fields it moved the one
            being edited (ux_rules rule 1). */}
        <OpenCodeSettingsFields />
        <CodexSettingsFields />
        <ClaudeSettingsFields />
        <div className="border-t border-[var(--color-border)] pt-2.5 text-[12px] text-[var(--color-text-muted)]">
          Kit contract {contractVersion ?? 'unknown'} · bundled with this app
        </div>
      </SettingsCard>
    </SettingsSection>
  )
}
