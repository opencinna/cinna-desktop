import { useEffect, useRef, useState } from 'react'
import { TaskConcurrencySetting } from './TaskConcurrencySetting'
import { FolderOpen, FolderPlus, GitBranch, ListChecks, RefreshCw, X } from 'lucide-react'
import { isCredentialActive, isCredentialUsable } from '../../../../shared/credentials'
import { credentialOptionLabel } from '../../utils/credentialLabel'
import {
  useAddAgentRoot,
  useAgentsHome,
  useLocalAgents,
  useRemoveAgentRoot,
  useRescanLocalAgents
} from '../../hooks/useLocalAgents'
import {
  useDefaultTool,
  useInstallRuntimeTool,
  useLocalTools,
  useOpenIn,
  useRefreshLocalTools,
  useSetDefaultTool,
  useToolInstallPlans
} from '../../hooks/useLocalTools'
import {
  isLocalToolId,
  isRuntimeToolId,
  type RuntimeToolId
} from '../../../../shared/localTools'
import {
  DEFAULT_AGENT_ENGINE,
  isAgentEngine,
  type AgentEngine
} from '../../../../shared/engine'
import { useProviders } from '../../hooks/useProviders'
import { useDefaultChatMode } from '../../hooks/useChatModes'
import { ManageRootAgentsDialog } from './ManageRootAgentsDialog'
import { RootRepositoryDialog } from './RootRepositoryDialog'
import { useEngineBinary, useResolveEngineBinary } from '../../hooks/useEngine'
import { useAppSettings, useSetAppSetting } from '../../hooks/useAppSettings'
import { unwrapIpcError } from '../../utils/ipcError'
import { useAgentsHomeStore } from '../../stores/agentsHome.store'
import { ForgetAgentRootDialog } from './ForgetAgentRootDialog'
import { InstallRuntimeDialog } from './InstallRuntimeDialog'
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
  SettingsInfoTip,
  SettingsSection,
  settingsInputClass
} from './SettingsLayout'
import { RUNTIME_CHOICES, RuntimeChoiceButtons } from './RuntimeChoiceButtons'

/**
 * The runtimes this screen reports, in the order it reports them, and what each
 * row says about itself.
 *
 * A table rather than three hand-written blocks, because every row has to say
 * the same *kinds* of thing — what it is, whether it is here, what having it
 * buys — and three blocks of JSX is how one of them quietly stops doing that.
 *
 * The copy is the short form on purpose: the detail column is two reserved
 * lines at the 800px minimum and a third would move every row under it
 * (ux_rules rules 1 and 7).
 *
 * `codex` is listed and installable but is **not** a runtime here, and the row
 * says so in its own words rather than by being absent. This build has no Codex
 * launcher — nothing has run one to measure its command line or its
 * capabilities — so offering it in the Default Runtime picker would be an
 * option that fails after the click (rule 4). Installing it still buys the user
 * something real: Codex is one of the tools an agent folder can be opened in.
 */
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
 *   • **Runtime** — what an agent that names nothing runs on, which runtimes
 *     this machine has, and the binary behind the AI-credentials one.
 *   • **Developer Tools** — what else this machine has, and what opens an agent.
 *
 * **Runtime was "Engine Settings".** The old name was the implementation's:
 * there was one engine, and its path was the only thing to set. There are two
 * runtimes now and the user chooses between them, so the section is named after
 * the choice — and the three rows that report whether this machine *has* each
 * runtime moved up out of the Developer Tools table, because a fact belongs in
 * the section holding the control it feeds (ux_rules rule 12).
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
  /**
   * The home's own state, not the actionable question the sidebar asks. This
   * screen reports where the agents folder is whether or not other roots make
   * the app usable without it — that is what it is for.
   */
  const homeAccess = data?.homeAccess
  const { data: home } = useAgentsHome()
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
  const { data: binary } = useEngineBinary()
  const resolveBinary = useResolveEngineBinary()
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
  /**
   * The runtime whose install confirm is open, and what the last attempt said.
   *
   * Both live here rather than in the dialog, for the reason the Forget confirm
   * above does: the mutation and the state that closes it have to outlive the
   * dialog, or the success handler that closes it is dropped by the unmount it
   * causes (ux_rules rule 5). The failure is kept out here too — a failed
   * install must leave the dialog open with its sentence beside the button that
   * was pressed (rule 6), and the sentence arrives after the mutation settles.
   */
  const [installing, setInstalling] = useState<RuntimeToolId | null>(null)
  const [installFailure, setInstallFailure] = useState<string | null>(null)
  const { data: installPlans } = useToolInstallPlans()
  const install = useInstallRuntimeTool({
    onDone: (result) => {
      // Success closes; a failure keeps the dialog and shows what the installer
      // said. Main returns both as a resolved value — only a broken bridge
      // rejects — so the branch is here rather than in an error handler.
      if (result.state !== 'done') {
        setInstallFailure(result.error)
        return
      }
      setInstalling(null)
      /**
       * **Installing it is choosing it.** The button the user pressed was the
       * runtime they want their agents on; stopping at "it is now installed"
       * would leave them to find the same button again and press it a second
       * time for the thing they had already asked for.
       *
       * Except where this build cannot run agents on it — `engine: null`, which
       * is Codex today. That install is still worth making (Cinna opens agent
       * folders in it), and selecting a runtime no launcher exists for would
       * break every agent that names none.
       */
      const choice = RUNTIME_CHOICES.find((candidate) => candidate.id === result.id)
      if (choice?.engine) {
        setAppSetting.mutate({ key: 'localAgentsDefaultEngine', value: choice.engine })
      }
    }
  })
  /**
   * The runtime this machine is set to, or null while nothing has decided yet.
   *
   * Null covers two moments and deliberately renders the same in both: the
   * settings query in flight, and the first launch before `lockIfUnset` has
   * written its answer. Neither is a state to make a claim in — no button is
   * selected, and the line under them says nothing — because the alternative is
   * showing one selection and replacing it a moment later (ux_rules rule 1).
   */
  const selectedRuntime: AgentEngine | null = isAgentEngine(
    appSettings?.localAgentsDefaultEngine ?? ''
  )
    ? (appSettings?.localAgentsDefaultEngine as AgentEngine)
    : null
  const onOpenCode = selectedRuntime === DEFAULT_AGENT_ENGINE
  const claudeTool = (tools ?? []).find((tool) => tool.id === 'claude' && tool.available)
  const installingPlan =
    installing !== null
      ? ((installPlans ?? []).find((plan) => plan.id === installing) ?? null)
      : null

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
   * A saved path is not what the row above is describing yet.
   *
   * The resolution is memoised per configured path, so a change takes effect
   * the next time something asks — the next turn, or *Try again* — and until
   * then the row still names the binary that was found for the old path.
   * Saying so beats leaving the user to wonder why the version line did not
   * move. (Under the shared engine this also meant "the running process is
   * still the old one"; there is no shared process now, and each agent's child
   * is replaced on its next turn because the path feeds the launch spec's key.)
   */
  const enginePathPending =
    savedEnginePath !== '' &&
    binary?.state === 'ready' &&
    savedEnginePath !== binary.path

  /**
   * Set by Escape just before it blurs the field. `onBlur` runs `commitEnginePath`
   * synchronously, in the same closure — with the value the user was typing,
   * not the one `setEnginePath(savedEnginePath)` has only just scheduled — so
   * without this Escape *saved* the half-typed path it was meant to throw away.
   */
  const discardingRef = useRef(false)
  const commitEnginePath = (): void => {
    if (discardingRef.current) {
      discardingRef.current = false
      return
    }
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
   * A provider that cannot run is left out of the picker rather than offered and
   * then warned about; the warnings below are for a pin that has *become*
   * unrunnable, which is a different situation from choosing one that never was.
   *
   * "Cannot run" now includes **switched off**, and that is not cosmetic: since
   * `collectEngineProviders` stopped handing the engine a disabled credential,
   * pinning one here stops every folder agent that does not name its own — so
   * offering it would be offering the user a setting whose only effect is to
   * break their agents at the next turn.
   */
  const activeProviders = (providers ?? []).filter(isCredentialActive)
  const pinnedId = appSettings?.localAgentsDefaultCredentialId ?? ''
  const pinnedCredential = pinnedId
    ? ((providers ?? []).find((provider) => provider.id === pinnedId) ?? null)
    : null
  const pinnedMissing = pinnedId !== '' && pinnedCredential === null

  /**
   * **What the selected runtime is doing**, as one line and one tone.
   *
   * Only the selected one. A machine running Claude Agent has an `opencode`
   * binary state too, and reporting it there would be a fact about something
   * this machine is not using (ux_rules rule 9) — worse, it would be the only
   * *red* thing on a screen whose agents are all fine.
   *
   * **Not resolved yet is muted, not a warning.** The ACP launcher resolves a
   * binary at the top of a local turn, so a machine that has simply not looked
   * yet is in a state that resolves itself the moment anyone chats with a folder
   * agent. Greeting every visit with an alarm over a state nobody has to act on
   * is the healthy state wearing a siren, and it teaches the user to skip the
   * one that does need them — `failed`, a path they typed or a download that
   * could not reach the network (rules 2 and 12).
   *
   * Silent while nothing can answer: the settings query in flight, the first
   * launch before the runtime is locked, detection still running. The claim
   * waits rather than being made and retracted.
   */
  const runtimeStatus: { text: string; tone: 'muted' | 'warning' | 'danger' } = ((): {
    text: string
    tone: 'muted' | 'warning' | 'danger'
  } => {
    /**
     * **A failed install outranks everything**, and it is here rather than only
     * in the dialog because the dialog can be closed while the install runs.
     * A failure that arrived after that would otherwise be reported nowhere at
     * all — silent failure being the worst outcome (ux_rules rule 6). While the
     * dialog *is* open it owns the message, and this slot stays out of it.
     */
    if (installFailure && installingPlan === null) {
      return { text: installFailure, tone: 'danger' }
    }
    if (selectedRuntime === null) return { text: '', tone: 'muted' }
    if (onOpenCode) {
      return {
        // One line each at the 800px minimum (rule 12). Where the binary comes
        // from when nothing is configured is the OpenCode path tip's to say.
        text:
          binary?.state === 'ready'
            ? `Ready — opencode ${binary.version ?? 'installed'}${
                binary.source === 'path'
                  ? ', your own installation'
                  : binary.source === 'configured'
                    ? ', from the OpenCode path below'
                    : ', downloaded by Cinna'
              }.`
            : binary?.state === 'resolving'
              ? 'Downloading OpenCode — once only, about a minute.'
              : binary?.state === 'failed'
                ? binary.error
                : 'Not resolved yet — the next agent chat resolves it.',
        tone: binary?.state === 'failed' ? 'danger' : 'muted'
      }
    }
    // Detection in flight is not "not installed": saying so would put the full
    // warning on screen for half a second on a machine that has Claude Code.
    if (tools === undefined) return { text: '', tone: 'muted' }
    if (!claudeTool) {
      return {
        // "Agents on it": the ones that name no runtime of their own, which is
        // what the tip beside this control says the setting governs. Installing
        // it is the button above, so the line does not repeat the remedy.
        text: 'Claude Code not found — agents on it cannot run.',
        tone: 'warning'
      }
    }
    return {
      // The version, because it is the fact that makes the line diagnosable, and
      // "no API key", because that is the reason a user chose this runtime.
      text: `Claude Code ${claudeTool.version ?? 'installed'} — your Claude login, no API key spent.`,
      tone: 'muted'
    }
  })()

  /**
   * Everything the Runtime section does **not** report.
   *
   * The three assistants moved up there, with versions and an install button,
   * because "is Claude Code installed" is the fact the Default Runtime is
   * derived from and it belongs beside that control (ux_rules rule 12). Leaving
   * them here as well would be one fact on two surfaces, free to disagree while
   * a refresh is in flight — and the two lists refresh from the same call.
   *
   * `opencode` goes with them: it is the binary behind the AI-credentials
   * runtime, which that section's last row reports in far more detail than a
   * version cell could.
   */
  const otherTools = (tools ?? []).filter(
    (tool) => !isRuntimeToolId(tool.id) && tool.id !== 'opencode'
  )

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
      {installingPlan && (
        <InstallRuntimeDialog
          plan={installingPlan}
          // Whether this build can put agents on it once it is there. The same
          // table the buttons are built from answers it, so the dialog cannot
          // promise a selection the click will not make.
          willSelect={
            RUNTIME_CHOICES.find((choice) => choice.id === installingPlan.id)?.engine !== null &&
            RUNTIME_CHOICES.some((choice) => choice.id === installingPlan.id)
          }
          install={install}
          failure={installFailure}
          onCancel={() => {
            setInstalling(null)
            setInstallFailure(null)
          }}
        />
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
            <>
            {homeAccess && homeAccess !== 'ready' && (
            /**
             * The home is missing from the list below, not the list itself —
             * a folder the user adopted is still there and still theirs. This
             * row is the home's place in it until it exists, and it is where a
             * user who dismissed the folder question, or whose Documents folder
             * macOS refused, comes to finish it. The row carries the button
             * that resolves what it reports (ux_rules rule 12).
             */
            <SettingsRow className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                {/* The label carries the *state*, not the section title said a
                    second time — this is the only row in this state, directly
                    under a heading that already reads "Agent Folders"
                    (ux_rules rule 7). */}
                <SettingsLabel>
                  {homeAccess !== 'denied'
                    ? 'No agents folder yet'
                    : home?.guarded
                      ? 'macOS did not allow that folder'
                      : 'That folder could not be written to'}
                </SettingsLabel>
                {/* Wrapping, not truncated. The path is the row's only fact,
                    and at the 800px minimum window `truncate` cut it mid-folder
                    — on the refused branch the folder name itself was gone
                    (ux_rules rule 7). */}
                <SettingsHint className="break-all">{home?.path ?? ''}</SettingsHint>
              </div>
              <SettingsButton
                onClick={() => useAgentsHomeStore.getState().reopen(homeAccess)}
                // The visible name, in full: an accessible name that does not
                // contain it leaves "click Set up" with nothing to match
                // (ux_rules rule 10). And neither branch may borrow the modal's
                // "Choose folder…", which opens the OS picker one click later.
                aria-label={homeAccess === 'denied' ? 'Pick another folder' : 'Set up the agents folder'}
              >
                <FolderPlus size={13} />
                {homeAccess === 'denied' ? 'Pick another folder' : 'Set up'}
              </SettingsButton>
            </SettingsRow>
            )}
            {roots.map((root) => {
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
            })}
            </>
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

      {/*
        **Runtime**, and it absorbed what used to be "Engine Settings".

        The old name was the implementation's: there was one engine, and its
        path was the only thing to set. There are two runtimes now and the user
        picks between them, so the section is named after the choice (ux_rules
        rule 12). The **Default AI credential** card moved in here too, from the
        place it had ended up — outside every section, between this one's
        closing tag and Developer Tools — and is now what it always was: the key
        the OpenCode runner spends.

        **The prose is behind `(?)` tips.** This screen is read once and used
        many times; three explanatory paragraphs above three controls pushed the
        controls below the fold on every visit after the first (rule 2 — a page
        is a control surface first). What stays on the surface is everything
        that *changes*: which runtime is selected, which are installed, and every
        warning about this machine — as a one-line status that is filled in
        every state, or rendered only while it applies, last in its card.
      */}
      <SettingsSection
        title="Runtime"
        info={
          <SettingsInfoTip label="About the Runtime section">
            <p>
              A folder agent runs on a <strong>runtime</strong>: a program on this machine that
              drives the model, calls the tools and asks you for permission. Cinna knows two —
              your own Claude Code, and OpenCode, which it downloads and verifies for itself.
            </p>
            <p>
              An agent whose folder names a runtime always gets that one. Everything on this
              screen is about the agents that name none.
            </p>
          </SettingsInfoTip>
        }
        action={
          <SettingsButton
            onClick={() => refreshTools.mutate()}
            disabled={refreshTools.isPending}
            title="Look again after installing a runtime"
            // Not "Refresh detected tools", which is the Developer Tools
            // section's button: two controls on one surface may not announce
            // themselves identically (ux_rules rule 10). They do the same work
            // — one detection pass — and each is named for its own section.
            aria-label="Refresh detected runtimes"
          >
            <RefreshCw size={13} className={refreshTools.isPending ? 'animate-spin' : undefined} />
            Refresh
          </SettingsButton>
        }
      >
        <SettingsCard>
          <div className="flex items-center gap-1.5">
            <SettingsLabel>Default runtime</SettingsLabel>
            <SettingsInfoTip label="About the default runtime">
              <p>
                What a folder agent runs on when its own folder names nothing. An agent that names
                a runtime, or a credential, keeps it — nothing here moves an agent off what its
                file says.
              </p>
              <p>
                Cinna picks this once, on the first launch that can answer: the first runtime found
                on this machine wins, so a new install runs agents before you configure anything.
                After that it stays where it is — installing another CLI later does not move your
                agents — and this is where you change it.
              </p>
              <p>
                A runtime you do not have yet is still a button: pressing it installs that tool,
                with its own installer and after showing you the command, and then puts your agents
                on it.
              </p>
            </SettingsInfoTip>
          </div>
          <RuntimeChoiceButtons
            selected={selectedRuntime}
            tools={tools}
            installing={install.isPending ? (install.variables ?? null) : null}
            onSelect={(engine) =>
              setAppSetting.mutate({ key: 'localAgentsDefaultEngine', value: engine })
            }
            onInstall={(tool) => {
              setInstallFailure(null)
              setInstalling(tool)
            }}
          />
          {/*
            **What the selected runtime is doing**, in a slot exactly one line
            high. Reserved because it is filled in every settled state — a
            healthy machine reads which binary was found — and one line because
            every sentence above is written to fit at the 800px minimum
            (ux_rules rules 1 and 12).

            The slot is `min-h-[1lh]` on the element that carries the text size
            and leading, and the `<p>` inherits both: the reservation is then
            the line by definition, where a rem value beside a 13px × relaxed
            line was 18px under a 21px line and let the cards below move 3px
            when the text landed. The two messages main composes (a failed
            install, a failed resolve) are the only ones that may run longer,
            and they truncate with the full text in `title` rather than wrap,
            the way the folder rows above do. Only the selected runtime is
            reported: the OpenCode binary's state is not a fact about a machine
            running Claude Agent (rule 9).
          */}
          <div className="mt-2 flex min-h-[1lh] items-start gap-3 text-[13px] leading-relaxed">
            <p
              className={`min-w-0 flex-1 truncate ${
                runtimeStatus.tone === 'warning'
                  ? 'text-[var(--color-warning)]'
                  : runtimeStatus.tone === 'danger'
                    ? 'text-[var(--color-danger)]'
                    : 'text-[var(--color-text-muted)]'
              }`}
              title={runtimeStatus.text || undefined}
            >
              {runtimeStatus.text}
            </p>
            {/*
              *Try again* belongs to the one state that does not resolve itself
              — a binary this machine could not get (rule 12: give the status
              the control that resolves it). `|| isPending` is not belt and
              braces: pressing it moves the state to `resolving`, so a condition
              naming only `failed` would unmount the control on click.

              A text action at the line's own size, not a bordered button: a
              29px button arriving in a 21px line grew the row and moved the
              cards below (rule 1). Accent-coloured and weighted so it does not
              read as more of the sentence beside it (rule 11).
            */}
            {onOpenCode && (binary?.state === 'failed' || resolveBinary.isPending) && (
              <button
                type="button"
                onClick={() => resolveBinary.mutate()}
                disabled={resolveBinary.isPending}
                className="shrink-0 text-[13px] font-medium text-[var(--color-accent)] hover:underline disabled:opacity-50 disabled:no-underline"
              >
                {resolveBinary.isPending ? 'Looking…' : 'Try again'}
              </button>
            )}
          </div>

          {/*
            A divider, not a second card: this is the same question one rung
            down — which key the OpenCode runner spends — and a card of its own
            said it was unrelated to the picker above it.
          */}
          <div className="mt-3 border-t border-[var(--color-border)] pt-3">
            <div className="flex items-center gap-1.5">
              <SettingsLabel htmlFor="local-agents-default-credential">
                Credential OpenCode runs on
              </SettingsLabel>
              <SettingsInfoTip label="About the credential OpenCode runs on">
                <p>
                  OpenCode is the runtime; an AI credential is what pays for its turns. This is the
                  one it spends for agents that name no credential of their own.
                </p>
                <p>
                  A setting of <em>this machine</em>: leave it on the default chat mode and agents
                  follow whatever your chats use, or pin one here to keep agent work on a
                  particular key without changing what your chats do.
                </p>
                <p>
                  It applies to any agent running on OpenCode — including one you put there
                  yourself on its own page — whether or not OpenCode is the default runtime above.
                </p>
              </SettingsInfoTip>
            </div>
            <select
              id="local-agents-default-credential"
              value={appSettings?.localAgentsDefaultCredentialId ?? ''}
              onChange={(event) =>
                setAppSetting.mutate({
                  key: 'localAgentsDefaultCredentialId',
                  value: event.target.value
                })
              }
              // Credential names run long — the control is 426px at the 800px
              // minimum and a 65-character name is cut mid-word with no ellipsis.
              title={pinnedCredential?.name ?? defaultMode?.name ?? undefined}
              className={`${settingsInputClass} mt-1.5`}
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
              {pinnedCredential && !activeProviders.some((p) => p.id === pinnedCredential.id) && (
                <option value={pinnedCredential.id}>
                  {credentialOptionLabel(pinnedCredential)}
                </option>
              )}
              {activeProviders.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.name}
                </option>
              ))}
            </select>
            {/*
              Rendered only when one applies, last in the card, and one line at
              the 800px minimum. Nothing is reserved for it: a slot that is
              empty in the healthy state is padding, not a reservation, and it
              read as a card with the wrong bottom edge (ux_rules rules 1 and
              12). Being last, its arrival lengthens the card and moves nothing
              the user is about to click. The name is the user's and can be any
              length, so it is the part that truncates (full name in `title`);
              the sentence that says what to do about it never is.
            */}
            {pinnedCredential && !isCredentialUsable(pinnedCredential) ? (
              /*
                Not "agents fall back to your default chat mode" — they do not.
                `resolveDefault` falls through to the chat mode only when the
                pinned id resolves to no provider at all; a provider that exists
                but cannot make a call is returned *as* the runtime, with a
                reason. Saying otherwise told the user their agents were safely
                running on the chat mode while every turn was about to fail.
              */
              <p className="mt-1.5 flex gap-1 text-[13px] text-[var(--color-warning)]">
                <span className="min-w-0 truncate" title={pinnedCredential.name}>
                  {pinnedCredential.name}
                </span>
                {/* Not the visual gap: flex drops whitespace-only nodes and `gap-1`
                    spaces the spans. The space keeps the text one sentence for
                    screen readers and getByText; keep both. */}
                {' '}
                <span className="shrink-0">
                  has no usable API key — agents pinned to it will not run.
                </span>
              </p>
            ) : pinnedCredential && !pinnedCredential.enabled ? (
              <p className="mt-1.5 flex gap-1 text-[13px] text-[var(--color-warning)]">
                <span className="min-w-0 truncate" title={pinnedCredential.name}>
                  {pinnedCredential.name}
                </span>{' '}
                <span className="shrink-0">is switched off — agents pinned to it will not run.</span>
              </p>
            ) : pinnedMissing ? (
              <p className="mt-1.5 text-[13px] text-[var(--color-warning)]">
                Pinned credential is gone — agents use your default chat mode.
              </p>
            ) : null}
          </div>
        </SettingsCard>

        <SettingsCard>
          <div className="flex items-center gap-1.5">
            <SettingsLabel htmlFor="local-agents-engine-path">OpenCode path</SettingsLabel>
            <SettingsInfoTip label="About the OpenCode path">
              <p>
                Point Cinna at a specific <code className="font-mono">opencode</code> executable.
                An absolute path, and it overrides both your <code className="font-mono">PATH</code>{' '}
                and the copy Cinna downloads. Leave it empty for the normal behaviour: Cinna uses an{' '}
                <code className="font-mono">opencode</code> on your PATH if you have one, and
                downloads a verified copy if you do not.
              </p>
              <p>
                Whether the file exists is checked the next time an agent runs — or when you press
                Try again above — not here.
              </p>
            </SettingsInfoTip>
          </div>
          <input
            id="local-agents-engine-path"
            type="text"
            value={enginePath}
            spellCheck={false}
            placeholder="/usr/local/bin/opencode"
            onChange={(event) => setEnginePath(event.target.value)}
            onBlur={commitEnginePath}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur()
              if (event.key === 'Escape') {
                setEnginePath(savedEnginePath)
                setEnginePathError(null)
                discardingRef.current = true
                event.currentTarget.blur()
              }
            }}
            className={`${settingsInputClass} mt-1.5 font-mono`}
          />
          {/* Every message this field can produce, below it and last in the
              card, rendered only while it exists: both are consequences of an
              action, so their arrival lengthens the card under the control and
              moves nothing above it. An always-present slot was empty in the
              healthy state, which is padding, not a reservation (ux_rules
              rules 1 and 12). */}
          {enginePathError ? (
            <p className="mt-1.5 text-[13px] text-[var(--color-danger)]">{enginePathError}</p>
          ) : enginePathPending ? (
            <p className="mt-1.5 text-[13px] text-[var(--color-warning)]">
              Used from the next agent run. The status above is still the old path.
            </p>
          ) : null}
        </SettingsCard>

        {/* How many turns may run at once, whichever runtime runs them. */}
        <TaskConcurrencySetting />
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
          <div className="mb-2.5">
            <SettingsLabel
              info={
                <p>
                  What else Cinna found installed globally, and the version each one reported. A
                  row reading Not found is a tool this machine does not have — nothing here is
                  installed for you. The runtimes an agent can run on are in the Runtime section
                  above.
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
          <div className="mt-3 border-t border-[var(--color-border)] pt-2.5 text-[12px] text-[var(--color-text-muted)]">
            Kit contract {contractVersion ?? 'unknown'} · bundled with this app
          </div>
        </SettingsCard>

        <SettingsCard>
          <SettingsLabel
            htmlFor="local-agents-default-tool"
            info={
              <p>
                The agent page&apos;s Open-in button uses this tool. Picking a different one from
                its menu makes that the default instead.
              </p>
            }
          >
            Open agents with
          </SettingsLabel>
          <select
            id="local-agents-default-tool"
            value={defaultTool?.id ?? ''}
            onChange={(event) => {
              const next = event.target.value
              setDefaultTool(isLocalToolId(next) ? next : null)
            }}
            className={`${settingsInputClass} mt-1.5`}
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
