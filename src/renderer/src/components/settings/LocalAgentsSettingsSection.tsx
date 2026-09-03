import { canDraftWithDefaultMode } from '../../utils/localAgents'
import { useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, FolderOpen, FolderPlus, RefreshCw, X } from 'lucide-react'
import {
  useAddAgentRoot,
  useLocalAgents,
  useRemoveAgentRoot,
  useRescanLocalAgents
} from '../../hooks/useLocalAgents'
import { useLocalTools, useOpenIn, useRefreshLocalTools } from '../../hooks/useLocalTools'
import { useProviders } from '../../hooks/useProviders'
import { useDefaultChatMode } from '../../hooks/useChatModes'
import { useEngineState, useStartEngine, useStopEngine } from '../../hooks/useEngine'
import { useAppSettings, useSetAppSetting } from '../../hooks/useAppSettings'

/**
 * Settings → Local Agents.
 *
 * Machine-local, so it belongs in the Default group rather than the profile
 * one: the agents home follows the machine, not whoever is signed in. Three
 * things live here that the agent page cannot show — where the folders are,
 * which kit contract they resolve, and whether this machine has what a folder
 * agent needs to run at all.
 */
export function LocalAgentsSettingsSection(): React.JSX.Element {
  const { data, isLoading } = useLocalAgents()
  const { data: tools } = useLocalTools()
  const { data: providers } = useProviders()
  const { data: defaultMode } = useDefaultChatMode()
  const addRoot = useAddAgentRoot()
  const removeRoot = useRemoveAgentRoot()
  const rescan = useRescanLocalAgents()
  const refreshTools = useRefreshLocalTools()
  const openIn = useOpenIn()
  const { data: engine } = useEngineState()
  const startEngine = useStartEngine()
  const stopEngine = useStopEngine()
  const { data: appSettings } = useAppSettings()
  const setAppSetting = useSetAppSetting()
  const [error, setError] = useState<string | null>(null)

  const savedEnginePath = appSettings?.localAgentsEnginePath ?? ''
  const [enginePath, setEnginePath] = useState(savedEnginePath)
  const [enginePathError, setEnginePathError] = useState<string | null>(null)
  /**
   * The field follows the saved value until the user types in it.
   *
   * Without this it is empty on the first render — the settings query has not
   * resolved yet — and stays empty afterwards, so a user with a path already
   * set sees a blank box and reasonably concludes nothing is configured.
   */
  useEffect(() => {
    setEnginePath((current) => (current === '' ? savedEnginePath : current))
  }, [savedEnginePath])

  /**
   * A saved path only takes effect on the **next** start: the resolved binary
   * is cached across starts, and the running process is the old one either way.
   * Saying so beats leaving the user to wonder why the version line did not
   * move.
   */
  const enginePathPending =
    savedEnginePath !== (engine?.binaryPath ?? '') &&
    savedEnginePath !== '' &&
    engine?.status === 'running'

  const commitEnginePath = (): void => {
    const next = enginePath.trim()
    if (next === savedEnginePath) return
    setEnginePathError(null)
    setAppSetting.mutate(
      { key: 'localAgentsEnginePath', value: next },
      {
        onError: (err) => {
          setEnginePathError(
            err instanceof Error ? err.message : 'That engine path could not be saved.'
          )
          setEnginePath(savedEnginePath)
        }
      }
    )
  }

  const roots = data?.roots ?? []
  const agents = data?.agents ?? []
  const needAttention = agents.filter((agent) => agent.readiness !== 'ok')
  const contractVersion = roots.find((root) => root.isDefault)?.contractVersion ?? null
  const canDraft = canDraftWithDefaultMode(defaultMode, providers)
  const detected = (tools ?? []).filter((tool) => tool.available)

  const cardClass =
    'rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] overflow-hidden'
  const rowButton =
    'p-1 rounded transition-colors text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'

  const engineBusy =
    engine?.status === 'installing' || engine?.status === 'starting' || startEngine.isPending

  const readiness: {
    ok: boolean
    label: string
    detail: string
    action?: React.ReactNode
  }[] = [
    {
      ok: canDraft,
      label: 'AI credential',
      detail: canDraft
        ? `Drafting and running use your default chat mode${
            defaultMode?.name ? ` (${defaultMode.name})` : ''
          }.`
        : defaultMode
          ? `Your default chat mode${
              defaultMode.name ? ` (${defaultMode.name})` : ''
            } has no usable API key. Add one in Settings → AI Credentials, or point the mode at a provider that has one. New agents are still created either way — their prompts are just not drafted for you.`
          : 'Add a credential in Settings → AI Credentials and set a default chat mode. Without one, new agents are still created — their prompts are just not drafted for you.'
    },
    {
      ok: engine?.status === 'running',
      label: 'Local engine',
      detail:
        engine?.status === 'running'
          ? `Running${engine.version ? ` — opencode ${engine.version}` : ''}${
              engine.binarySource === 'path'
                ? ', your own installation'
                : engine.binarySource === 'configured'
                  ? ', the path set under Engine path below'
                  : ', downloaded by Cinna'
            }.`
          : engine?.status === 'installing'
            ? 'Downloading the engine. This happens once and takes about a minute.'
            : engine?.status === 'starting'
              ? 'Starting…'
              : engine?.status === 'failed'
                ? (engine.error ?? 'The engine could not start.')
                : 'Not running. Start it to chat with a folder agent — Cinna uses an opencode on your PATH if you have one, and downloads a verified copy if you do not.',
      action: (
        <button
          type="button"
          onClick={() => (engine?.status === 'running' ? stopEngine : startEngine).mutate()}
          disabled={engineBusy || stopEngine.isPending}
          className="shrink-0 rounded-md bg-[var(--color-bg-tertiary)] px-2 py-1 text-[10px] font-medium
            text-[var(--color-text)] transition-colors hover:bg-[var(--color-bg-hover)]
            disabled:cursor-not-allowed disabled:opacity-40"
        >
          {engineBusy || stopEngine.isPending
            ? 'Working…'
            : engine?.status === 'running'
              ? 'Stop engine'
              : 'Start engine'}
        </button>
      )
    },
    {
      ok: needAttention.length === 0,
      label: 'Agents',
      detail:
        agents.length === 0
          ? 'No agents yet. Create one from the Agents tab.'
          : needAttention.length === 0
            ? `${agents.length} agent${agents.length === 1 ? '' : 's'}, all valid.`
            : `${needAttention.length} of ${agents.length} need attention: ${needAttention
                .map((agent) => agent.name)
                .join(', ')}.`
    }
  ]

  return (
    <div className="space-y-3">
      <div className={cardClass}>
        <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-4 py-2.5">
          <h2 className="text-xs font-medium text-[var(--color-text)]">Agents folders</h2>
          <div className="flex-1" />
          <button
            type="button"
            onClick={() => rescan.mutate(undefined)}
            disabled={rescan.isPending}
            className={rowButton}
            title="Re-read every agents folder"
            aria-label="Rescan agents folders"
          >
            <RefreshCw size={14} />
          </button>
        </div>
        <div className="divide-y divide-[var(--color-border)]">
          {isLoading ? (
            <div className="px-4 py-3 text-[10px] text-[var(--color-text-muted)]">Loading…</div>
          ) : (
            roots.map((root) => (
              <div key={root.id} className="flex items-center gap-2 px-4 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 text-xs text-[var(--color-text)]">
                    {root.label}
                    {root.isDefault && (
                      <span className="rounded bg-[var(--color-bg-tertiary)] px-1 py-px text-[9px] text-[var(--color-text-muted)]">
                        Home
                      </span>
                    )}
                  </div>
                  <div className="truncate font-mono text-[10px] text-[var(--color-text-muted)]">
                    {root.path}
                  </div>
                  <div className="text-[10px] text-[var(--color-text-muted)]">
                    {root.exists
                      ? `${root.agentCount} agent${root.agentCount === 1 ? '' : 's'} · kit contract ${root.contractVersion}`
                      : 'This folder is missing from disk.'}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setError(null)
                    openIn.mutate(
                      { folder: root.path, action: 'reveal' },
                      {
                        onError: (err) =>
                          setError(err instanceof Error ? err.message : 'Could not open that.')
                      }
                    )
                  }}
                  className={rowButton}
                  title="Reveal this folder"
                  aria-label={`Reveal ${root.label}`}
                >
                  <FolderOpen size={14} />
                </button>
                {!root.isDefault && (
                  <button
                    type="button"
                    onClick={() => {
                      setError(null)
                      removeRoot.mutate(root.id, {
                        onError: (err) =>
                          setError(err instanceof Error ? err.message : 'Could not remove that.')
                      })
                    }}
                    className="rounded p-1 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-danger)]/20 hover:text-[var(--color-danger)]"
                    title="Forget this folder (the files stay on disk)"
                    aria-label={`Forget ${root.label}`}
                  >
                    <X size={14} />
                  </button>
                )}
              </div>
            ))
          )}
        </div>
      </div>

      <button
        type="button"
        onClick={() => {
          setError(null)
          addRoot.mutate(undefined, {
            onError: (err) =>
              setError(err instanceof Error ? err.message : 'Could not add that folder.')
          })
        }}
        disabled={addRoot.isPending}
        className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed
          border-[var(--color-border)] px-3 py-2.5 text-xs text-[var(--color-text-muted)]
          transition-colors hover:border-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]
          disabled:opacity-50"
      >
        <FolderPlus size={14} />
        Add an agents folder
      </button>

      {error && <div className="text-[10px] text-[var(--color-danger)]">{error}</div>}

      <div className={cardClass}>
        <div className="border-b border-[var(--color-border)] px-4 py-2.5">
          <h2 className="text-xs font-medium text-[var(--color-text)]">Readiness</h2>
        </div>
        <ul className="divide-y divide-[var(--color-border)]">
          {readiness.map((item) => (
            <li key={item.label} className="flex items-start gap-2 px-4 py-2.5">
              {item.ok ? (
                <CheckCircle2 size={13} className="mt-px shrink-0 text-[var(--color-success)]" />
              ) : (
                <AlertTriangle size={13} className="mt-px shrink-0 text-[var(--color-warning)]" />
              )}
              <div className="min-w-0 flex-1">
                <div className="text-xs text-[var(--color-text)]">{item.label}</div>
                <div className="text-[10px] text-[var(--color-text-muted)]">{item.detail}</div>
              </div>
              {item.action}
            </li>
          ))}
        </ul>
      </div>

      <div className={cardClass}>
        <div className="border-b border-[var(--color-border)] px-4 py-2.5">
          <h2 className="text-xs font-medium text-[var(--color-text)]">Engine path</h2>
        </div>
        <div className="px-4 py-2.5">
          <input
            type="text"
            value={enginePath}
            spellCheck={false}
            placeholder="/usr/local/bin/opencode — leave empty to let Cinna find one"
            onChange={(event) => setEnginePath(event.target.value)}
            onBlur={commitEnginePath}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur()
              if (event.key === 'Escape') {
                setEnginePath(savedEnginePath)
                setEnginePathError(null)
                event.currentTarget.blur()
              }
            }}
            className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)]
              px-2 py-1 font-mono text-[11px] text-[var(--color-text)]
              focus:border-[var(--color-accent)] focus:outline-none"
            aria-label="Path to the opencode executable"
          />
          <div className="mt-1.5 text-[10px] text-[var(--color-text-muted)]">
            Point Cinna at a specific <code>opencode</code> executable. An absolute path, and it
            overrides both your PATH and the copy Cinna downloads. Leave it empty for the normal
            behaviour. Whether the file exists is checked when the engine starts, not here.
          </div>
          {enginePathError && (
            <div className="mt-1.5 text-[10px] text-[var(--color-danger)]">{enginePathError}</div>
          )}
          {enginePathPending && (
            <div className="mt-1.5 text-[10px] text-[var(--color-warning)]">
              The engine is still running the previous binary. Stop and start it above to use this
              path.
            </div>
          )}
        </div>
      </div>

      <div className={cardClass}>
        <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-4 py-2.5">
          <h2 className="text-xs font-medium text-[var(--color-text)]">Developer tools</h2>
          <div className="flex-1" />
          <button
            type="button"
            onClick={() => refreshTools.mutate()}
            disabled={refreshTools.isPending}
            className={rowButton}
            title="Detect again after installing something"
            aria-label="Refresh detected tools"
          >
            <RefreshCw size={14} />
          </button>
        </div>
        <div className="px-4 py-2.5">
          {detected.length === 0 ? (
            <div className="text-[10px] italic text-[var(--color-text-muted)]">
              Nothing detected on this machine yet. Install a coding assistant or editor, then
              Refresh.
            </div>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {detected.map((tool) => (
                <span
                  key={tool.id}
                  title={tool.path ?? undefined}
                  className="rounded bg-[var(--color-bg-tertiary)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-secondary)]"
                >
                  {tool.label}
                </span>
              ))}
            </div>
          )}
          <div className="mt-2 text-[10px] text-[var(--color-text-muted)]">
            Kit contract {contractVersion ?? 'unknown'} · bundled with this app
          </div>
        </div>
      </div>
    </div>
  )
}
