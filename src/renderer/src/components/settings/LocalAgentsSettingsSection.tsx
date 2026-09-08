import { useEffect, useState } from 'react'
import { FolderOpen, FolderPlus, GitBranch, ListChecks, RefreshCw, X } from 'lucide-react'
import { isCredentialUsable } from '../../../../shared/credentials'
import {
  useAddAgentRoot,
  useLocalAgents,
  useRemoveAgentRoot,
  useRescanLocalAgents
} from '../../hooks/useLocalAgents'
import {
  useDefaultTool,
  useLocalTools,
  useOpenIn,
  useRefreshLocalTools,
  useSetDefaultTool
} from '../../hooks/useLocalTools'
import { isLocalToolId } from '../../../../shared/localTools'
import { useProviders } from '../../hooks/useProviders'
import { useDefaultChatMode } from '../../hooks/useChatModes'
import { ManageRootAgentsDialog } from './ManageRootAgentsDialog'
import { RootRepositoryDialog } from './RootRepositoryDialog'
import { useEngineState, useStartEngine } from '../../hooks/useEngine'
import { useAppSettings, useSetAppSetting } from '../../hooks/useAppSettings'
import { unwrapIpcError } from '../../utils/ipcError'
import { ForgetAgentRootDialog } from './ForgetAgentRootDialog'
import {
  SettingsAddButton,
  SettingsBadge,
  SettingsButton,
  SettingsCard,
  SettingsHint,
  SettingsIconButton,
  SettingsLabel,
  SettingsRow,
  SettingsRows,
  SettingsSection,
  SettingsStatusRow,
  settingsInputClass
} from './SettingsLayout'

/**
 * Settings → Local Agents.
 *
 * Machine-local, so it belongs in the Default group rather than the profile
 * one: the agents home follows the machine, not whoever is signed in. Three
 * things live here that the agent page cannot show — where the folders are,
 * which kit contract they resolve, and whether this machine has what a folder
 * agent needs to run at all.
 *
 * **Three titled sections, not a stack of cards.** This screen used to be four
 * unlabelled cards and a loose button — folders, a Readiness list, an Engine
 * path box, a Developer tools box — with the readiness of the engine in one
 * card while the path that decides *which* binary starts sat in another, two
 * rows down. Each fact now sits in the section that holds the control which
 * changes it:
 *
 *   • **Agent Folders** — where the folders are, and what is in them.
 *   • **Engine Settings** — whether the engine runs, which credential agents
 *     spend by default, and which binary runs them.
 *   • **Developer Tools** — what this machine has, and what opens an agent.
 *
 * **A folder row is a summary line and a row of controls.** Everything that
 * used to unfold *under* a row — the "N agents are not in the list / Add them"
 * pair, the branch line with its own Check and Update — is now a button in
 * that row opening a dialog. Two reasons. Those blocks were the reason the row
 * needed reserved heights and two-line clamps at all: each was a thing that
 * appeared, or grew, in answer to a click, directly above the rows below it.
 * And neither could express what the user actually wanted — "Add them" put
 * back all of the agents or none, and the branch line had three facts and two
 * controls in a slot that clipped at the 800px minimum window.
 */
export function LocalAgentsSettingsSection(): React.JSX.Element {
  const { data, isLoading } = useLocalAgents()
  const { data: tools } = useLocalTools()
  const { data: providers } = useProviders()
  const { data: defaultMode } = useDefaultChatMode()
  const addRoot = useAddAgentRoot()
  /**
   * The root whose Forget confirm is open. Held here rather than in the row,
   * so the dialog's mutation and the state that closes it both outlive the
   * dialog — a `mutate`-level `onSuccess` would be dropped by the unmount that
   * closing causes (ux_rules rule 5).
   */
  const [forgetting, setForgetting] = useState<string | null>(null)
  /** The root whose Manage agents / Repository dialog is open, if either is. */
  const [managing, setManaging] = useState<string | null>(null)
  const [inspecting, setInspecting] = useState<string | null>(null)
  const removeRoot = useRemoveAgentRoot({ onSuccess: () => setForgetting(null) })
  const rescan = useRescanLocalAgents()
  const refreshTools = useRefreshLocalTools()
  const openIn = useOpenIn()
  const { data: engine } = useEngineState()
  const startEngine = useStartEngine()
  const { data: appSettings } = useAppSettings()
  const setAppSetting = useSetAppSetting()
  const { tool: defaultTool, launchable } = useDefaultTool()
  const setDefaultTool = useSetDefaultTool()
  /**
   * A failed row action is reported **on that row**, in the line that already
   * holds the folder's summary — not in one shared message under the Add
   * button three rows below, which is where the user did not act and which
   * pushed the next section down by 32px when it appeared (ux_rules rules 1
   * and 6).
   */
  const [rowError, setRowError] = useState<{ rootId: string; message: string } | null>(null)
  const [addError, setAddError] = useState<string | null>(null)

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
          setEnginePathError(unwrapIpcError(err, 'That engine path could not be saved.'))
          setEnginePath(savedEnginePath)
        }
      }
    )
  }

  const roots = data?.roots ?? []
  const contractVersion = roots.find((root) => root.isDefault)?.contractVersion ?? null

  /**
   * Credentials that could actually run an agent — the shared predicate, which
   * `runtimeService.isUsable` and the "Runs with" panel also call.
   *
   * It used to be written out here as `hasApiKey && !unsupported`: an Anthropic
   * OAuth token managed by an account has `hasApiKey: true` and cannot make an
   * API call, so filtering on the key alone offered it as a normal choice and
   * every agent pinned to it failed at the first turn. That reasoning still
   * holds and now lives in `shared/credentials`, together with the case this
   * copy got wrong — a keyless credential has no key and runs agents perfectly
   * well, so a hand-written `hasApiKey` left Ollama out of this picker while the
   * engine was quite willing to run on it.
   *
   * A provider that is not usable is left out of the picker rather than offered
   * and then warned about; the warning below is for a pin that has *become*
   * unusable, which is a different situation from choosing one that never was.
   */
  const usableProviders = (providers ?? []).filter(isCredentialUsable)
  const pinnedId = appSettings?.localAgentsDefaultCredentialId ?? ''
  const pinnedCredential = pinnedId
    ? ((providers ?? []).find((provider) => provider.id === pinnedId) ?? null)
    : null
  const pinnedMissing = pinnedId !== '' && pinnedCredential === null

  /**
   * Not running is **neutral**, not a warning.
   *
   * `localDeps.ensureEngineRunning` (`src/main/services/agentTurn/index.ts`)
   * starts the engine at the top of a local turn, so a machine that has simply
   * not started it yet is in a state that resolves itself the moment anyone
   * chats with a folder agent. Greeting every visit with an amber triangle over
   * a state nobody has to act on is the healthy state wearing an alarm, and it
   * teaches the user to skip the triangle for `failed`, which is the one that
   * does need them (ux_rules rules 2 and 12).
   */
  const engineTone: 'ok' | 'warning' | 'neutral' =
    engine?.status === 'running' ? 'ok' : engine?.status === 'failed' ? 'warning' : 'neutral'
  const engineDetail =
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
            : 'Not running — chatting with a folder agent starts it. Cinna uses an opencode on your PATH if you have one, and downloads a verified copy if you do not.'

  const forgettingRoot = roots.find((root) => root.id === forgetting) ?? null
  const managingRoot = roots.find((root) => root.id === managing) ?? null
  const inspectingRoot = roots.find((root) => root.id === inspecting) ?? null

  return (
    <div className="space-y-6">
      {forgettingRoot && (
        <ForgetAgentRootDialog
          root={forgettingRoot}
          remove={removeRoot}
          onCancel={() => setForgetting(null)}
        />
      )}
      {managingRoot && (
        <ManageRootAgentsDialog root={managingRoot} onClose={() => setManaging(null)} />
      )}
      {inspectingRoot && (
        <RootRepositoryDialog root={inspectingRoot} onClose={() => setInspecting(null)} />
      )}
      <SettingsSection
        title="Agent Folders"
        action={
          <SettingsButton
            onClick={() => rescan.mutate(undefined)}
            disabled={rescan.isPending}
            title="Re-read every agent folder"
            aria-label="Rescan agent folders"
          >
            <RefreshCw size={13} className={rescan.isPending ? 'animate-spin' : undefined} />
            Rescan
          </SettingsButton>
        }
      >
        <SettingsRows>
          {isLoading ? (
            <SettingsRow>
              <SettingsHint>Loading…</SettingsHint>
            </SettingsRow>
          ) : (
            roots.map((root) => {
              /**
               * One line, fixed by construction rather than by how long the
               * sentence happens to be. `line-clamp-2` here grew the row by
               * 19.5px for anything over ~65 characters at the 800px minimum —
               * no message reaches that today, but the guarantee was the length
               * of the copy rather than the shape of the box (ux_rules rule 1).
               * The full text stays reachable in `title`.
               */
              const summary = !root.exists
                ? 'This folder is missing from disk.'
                : root.kind === 'external'
                  ? // No kit contract here, and saying which one it "resolves"
                    // would be a version number that governs nothing in this
                    // folder. "Not a kit folder" is a property of the folder
                    // that is true; "read only", which this said first, is one
                    // that is not — the agent page edits `AGENT.md` in place.
                    //
                    // "(the first found)" is said here too, because the scan
                    // side is the worse half: after adoption a capped root
                    // stays capped, so an agent added to the repository later
                    // never appears and no rescan fixes it.
                    `${root.agentCount} agent${root.agentCount === 1 ? '' : 's'}${
                      root.truncated ? ' (the first found)' : ''
                    } · not a kit folder`
                  : `${root.agentCount} agent${root.agentCount === 1 ? '' : 's'} · kit contract ${root.contractVersion}`
              /*
                A **badge**, not an appended clause. As `· Git tracked folder`
                on the summary line it left 4px of headroom at the 800px
                minimum — `12 agents · kit contract 1.1.0 · Git tracked folder`
                already overflowed — and it was the tail, so it was the first
                thing to be cut. The row's other folder properties (Home, Added
                folder) are badges beside the label for exactly this reason, and
                this is one of them.
              */
              const rowMessage = rowError?.rootId === root.id ? rowError.message : null

              return (
              <SettingsRow key={root.id}>
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-[14px] font-medium text-[var(--color-text)]">
                        {root.label}
                      </span>
                      {root.isDefault && <SettingsBadge>Home</SettingsBadge>}
                      {/*
                        Not "read only", which this claimed first. Cinna
                        installs nothing here — no templates, no `.cinna-kit/`,
                        no `app-data/` — but the agent page's Instructions card
                        is a live editor over `AGENT.md`, so a folder the user
                        edits there *is* written to. Promising otherwise leaves
                        them with a modified working tree in a repository they
                        may share, and — since a dirty tree refuses a
                        fast-forward — a blocked Update two rows below, with
                        neither surface admitting the two are connected.
                      */}
                      {root.kind === 'external' && (
                        <SettingsBadge title="Cinna installs nothing here. The only file it writes is an agent's AGENT.md, and only when you edit it on the agent's page.">
                          Added folder
                        </SettingsBadge>
                      )}
                      {root.exists && root.isGitRepo && (
                        <SettingsBadge title="This folder is inside a git working tree. Open Repository for its remote, branches and updates.">
                          Git
                        </SettingsBadge>
                      )}
                    </div>
                    <div
                      className="mt-0.5 truncate font-mono text-[12px] text-[var(--color-text-muted)]"
                      title={root.path}
                    >
                      {root.path}
                    </div>
                    <div
                      className={`mt-0.5 truncate text-[13px] ${
                        rowMessage ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-muted)]'
                      }`}
                      title={rowMessage ?? summary}
                    >
                      {rowMessage ?? summary}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {/*
                      Only for a root whose agents are individually choosable.
                      A workshop root's folders are kit agents the scanner owns;
                      there is no selection to manage.
                    */}
                    {root.kind === 'external' && root.exists && (
                      <SettingsIconButton
                        onClick={() => {
                          setRowError(null)
                          setManaging(root.id)
                        }}
                        title="Choose which of this folder's agents are in the list"
                        aria-label={`Manage agents in ${root.label}`}
                      >
                        <ListChecks size={15} />
                      </SettingsIconButton>
                    )}
                    {root.isGitRepo && root.exists && (
                      <SettingsIconButton
                        onClick={() => {
                          setRowError(null)
                          setInspecting(root.id)
                        }}
                        title="Remote, branches and updates for this repository"
                        aria-label={`Repository for ${root.label}`}
                      >
                        <GitBranch size={15} />
                      </SettingsIconButton>
                    )}
                    <SettingsIconButton
                      onClick={() => {
                        setRowError(null)
                        openIn.mutate(
                          { folder: root.path, action: 'reveal' },
                          {
                            onError: (err) =>
                              setRowError({
                                rootId: root.id,
                                message: unwrapIpcError(err, 'Could not open that folder.')
                              })
                          }
                        )
                      }}
                      title="Reveal this folder"
                      aria-label={`Reveal ${root.label}`}
                    >
                      <FolderOpen size={15} />
                    </SettingsIconButton>
                    {!root.isDefault && (
                      <SettingsIconButton
                        danger
                        // Not reachable while another root's removal runs. The
                        // overlay stops the mouse but not the keyboard, and
                        // Enter here swapped the open confirm to this root
                        // mid-flight — so the dialog naming one folder closed
                        // on the success of another (ux_rules rule 5).
                        disabled={removeRoot.isPending}
                        onClick={() => {
                          setRowError(null)
                          setForgetting(root.id)
                        }}
                        title="Forget this folder (the files stay on disk)"
                        aria-label={`Forget ${root.label}`}
                      >
                        <X size={15} />
                      </SettingsIconButton>
                    )}
                  </div>
                </div>
                {/*
                  The hidden-agent count stays as a *statement* — an agent the
                  user removed, or never ticked when adopting, is still on disk
                  and a rescan keeps skipping it, so a one-way door with nothing
                  on screen saying it was taken is the thing to avoid. What went
                  is the "Add them" button beside it: it could only do all or
                  nothing, and the set the user wants is usually neither. Manage
                  agents, in the controls row above, is where the set is chosen.

                  "not in the list", not "removed from the list": the same
                  hidden state carries two histories, because "not chosen" and
                  "removed" have to be one state or the next rescan re-adds the
                  unticked ones. Adopting 1 of 15 otherwise reported "14 agents
                  removed from the list" about agents that were never in it.
                */}
                {root.hiddenAgentCount > 0 && (
                  <div className="mt-1.5 text-[13px] text-[var(--color-text-muted)]">
                    {root.hiddenAgentCount} agent{root.hiddenAgentCount === 1 ? '' : 's'} in this
                    folder {root.hiddenAgentCount === 1 ? 'is' : 'are'} not in the list — choose
                    which ones with Manage agents above.
                  </div>
                )}
              </SettingsRow>
              )
            })
          )}
        </SettingsRows>

        <SettingsAddButton
          onClick={() => {
            setAddError(null)
            addRoot.mutate(undefined, {
              onError: (err) => setAddError(unwrapIpcError(err, 'Could not add that folder.'))
            })
          }}
          disabled={addRoot.isPending}
        >
          <FolderPlus size={14} />
          Add an agents folder
        </SettingsAddButton>

        {addError && <p className="text-[13px] text-[var(--color-danger)]">{addError}</p>}

      </SettingsSection>

      <SettingsSection title="Engine Settings">
        <SettingsCard>
          {/*
            An indicator, not a control.
            `localDeps.ensureEngineRunning` starts the engine at the top of
            every local turn, so Start was a button for doing by hand what
            chatting with a folder agent does anyway — and Stop was a way to
            switch off something the next message switches back on. What the
            user needs from this row is whether the engine is up and which
            binary it is; that is what is left.
          */}
          <SettingsStatusRow
            tone={engineTone}
            label="Local engine"
            detail={engineDetail}
            action={
              /*
                Only on `failed`. Not running resolves itself — the next turn
                calls `ensureEngineRunning` — but a start that failed does not,
                and removing the Start button took the retry with it, leaving an
                amber row with nothing to press (ux_rules rule 12: give the
                status row the control that resolves it).
              */
              engine?.status === 'failed' ? (
                <SettingsButton
                  onClick={() => startEngine.mutate()}
                  disabled={startEngine.isPending}
                >
                  {startEngine.isPending ? 'Starting…' : 'Try again'}
                </SettingsButton>
              ) : undefined
            }
          />
        </SettingsCard>

        <SettingsCard>
          <SettingsLabel htmlFor="local-agents-default-credential">
            Default AI credential
          </SettingsLabel>
          <SettingsHint className="mt-0.5 mb-2">
            Which credential folder agents run on when they do not name one of their own. This is a
            setting of <em>this machine</em>: leave it on the default chat mode and agents follow
            whatever your chats use, or pin one here to keep agent work on a particular key without
            changing what your chats do.
          </SettingsHint>
          <select
            id="local-agents-default-credential"
            value={appSettings?.localAgentsDefaultCredentialId ?? ''}
            onChange={(event) =>
              setAppSetting.mutate({
                key: 'localAgentsDefaultCredentialId',
                value: event.target.value
              })
            }
            // Credential names run long — the control is 379px at the 800px
            // minimum and a 58-character name is cut mid-word with no ellipsis.
            title={pinnedCredential?.name ?? defaultMode?.name ?? undefined}
            className={settingsInputClass}
          >
            <option value="">
              {defaultMode?.name ? `Default chat mode (${defaultMode.name})` : 'Default chat mode'}
            </option>
            {/*
              A pinned credential that is no longer offered — its key was
              removed, or it turned out to be unsupported — still needs an
              option, or the select matches nothing, renders blank, and says
              "nothing is pinned" over a pin that is in force.
            */}
            {pinnedCredential && !usableProviders.some((p) => p.id === pinnedCredential.id) && (
              <option value={pinnedCredential.id}>{pinnedCredential.name}</option>
            )}
            {usableProviders.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.name}
              </option>
            ))}
          </select>
          {/*
            The consequence, in a slot that is always there — the same shape as
            the engine path's message below (ux_rules rule 1). A pinned
            credential that has since lost its key would otherwise fail at the
            first turn with nothing here having said so.
          */}
          {/*
            Two lines of the 13px leading: both warnings here wrap at the 800px
            minimum, and a one-line slot moved everything below by 19.875px when
            the user cleared the warning by using the control (ux_rules rule 1).
          */}
          <div className="mt-1.5 min-h-[2.5rem]">
            {pinnedCredential && !isCredentialUsable(pinnedCredential) ? (
              /*
                Not "agents fall back to your default chat mode" — they do not.
                `resolveDefault` falls through to the chat mode only when the
                pinned id resolves to no provider at all; a provider that exists
                but cannot make a call is returned *as* the runtime, with a
                reason. Saying otherwise told the user their agents were safely
                running on the chat mode while every turn was about to fail.
              */
              <p className="text-[13px] text-[var(--color-warning)]">
                {pinnedCredential.name} has no API key this app can use. Agents pinned to it will
                not run until it does — pick another credential here, or add a key to it.
              </p>
            ) : pinnedMissing ? (
              <p className="text-[13px] text-[var(--color-warning)]">
                The credential pinned here is no longer on this machine. Agents are using your
                default chat mode.
              </p>
            ) : null}
          </div>
        </SettingsCard>

        <SettingsCard>
          <SettingsLabel htmlFor="local-agents-engine-path">Engine path</SettingsLabel>
          {/*
            The hint sits above the field, and every message the field can
            produce sits below it in a slot that is always there: a save error
            or the restart note used to appear under the input and push the
            Developer tools card down as the user typed (ux_rules rule 1).
          */}
          <SettingsHint className="mt-0.5 mb-2">
            Point Cinna at a specific <code className="font-mono">opencode</code> executable. An
            absolute path, and it overrides both your PATH and the copy Cinna downloads. Leave it
            empty for the normal behaviour. Whether the file exists is checked when the engine
            starts, not here.
          </SettingsHint>
          <input
            id="local-agents-engine-path"
            type="text"
            value={enginePath}
            spellCheck={false}
            /* Just the path. The "leave empty" half is in the hint above, and at
               the 800px minimum window the full sentence measured 462px in a
               399px box — it fit at the old 11px and does not at 13px, so the
               instruction was the half that got cut (ux_rules rule 7). */
            placeholder="/usr/local/bin/opencode"
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
            className={`${settingsInputClass} font-mono`}
          />
          <div className="mt-1.5 min-h-[1.125rem]">
            {enginePathError ? (
              <p className="text-[13px] text-[var(--color-danger)]">{enginePathError}</p>
            ) : enginePathPending ? (
              <p className="text-[13px] text-[var(--color-warning)]">
                The engine is still running the previous binary. It will use this path the next time
                it starts.
              </p>
            ) : null}
          </div>
        </SettingsCard>
      </SettingsSection>

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
          <div className="text-[14px] font-medium text-[var(--color-text)]">
            Detected on this machine
          </div>
          <SettingsHint className="mt-0.5 mb-2.5">
            What Cinna found installed globally, and the version each one reported. A row reading
            Not found is a tool this machine does not have — nothing here is installed for you.
          </SettingsHint>
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
                {(tools ?? []).map((tool) => (
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
                {(tools ?? []).length === 0 && (
                  <tr>
                    <td colSpan={2} className="px-2.5 py-2 text-[var(--color-text-muted)]">
                      Detecting…
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="mt-3 border-t border-[var(--color-border)] pt-2.5 text-[12px] text-[var(--color-text-muted)]">
            Kit contract {contractVersion ?? 'unknown'} · bundled with this app
          </div>
        </SettingsCard>

        <SettingsCard>
          <SettingsLabel htmlFor="local-agents-default-tool">Open agents with</SettingsLabel>
          <SettingsHint className="mt-0.5 mb-2">
            The agent page&apos;s Open-in button uses this tool. Picking a different one from its
            menu makes that the default instead.
          </SettingsHint>
          <select
            id="local-agents-default-tool"
            value={defaultTool?.id ?? ''}
            onChange={(event) => {
              const next = event.target.value
              setDefaultTool(isLocalToolId(next) ? next : null)
            }}
            className={settingsInputClass}
          >
            <option value="">Ask each time</option>
            {launchable.map((tool) => (
              <option key={tool.id} value={tool.id}>
                {tool.label}
              </option>
            ))}
          </select>
          <label
            className={`mt-2.5 flex items-start gap-2 text-[13px] leading-relaxed ${
              defaultTool ? 'text-[var(--color-text-secondary)]' : 'text-[var(--color-text-muted)]'
            }`}
          >
            <input
              type="checkbox"
              checked={appSettings?.localAgentsAutoOpen === true}
              disabled={!defaultTool}
              onChange={(event) =>
                setAppSetting.mutate({ key: 'localAgentsAutoOpen', value: event.target.checked })
              }
              className="mt-0.5 accent-[var(--color-accent)]"
            />
            Open a new agent there right after creating it, without asking
          </label>
        </SettingsCard>
      </SettingsSection>
    </div>
  )
}
