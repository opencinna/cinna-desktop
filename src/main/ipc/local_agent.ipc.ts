import { dialog, type OpenDialogOptions } from 'electron'
import { userActivation } from '../auth/activation'
import { getSettingsScopeUserId } from '../auth/scope'
import { localAgentService } from '../services/localAgents/localAgentService'
import { runtimeService } from '../services/localAgents/runtimeService'
import { providerService } from '../services/providerService'
import { localAgentDraftService } from '../services/localAgents/draftService'
import { agentsHomeService } from '../services/localAgents/agentsHomeService'
import { homeAccessService } from '../services/localAgents/homeAccessService'
import { appSettingsService } from '../services/appSettingsService'
import { gitService } from '../services/localAgents/gitService'
import type { GitDetail, GitStatus, GitUpdateResult } from '../../shared/agentGit'
import type { StoredPermissionGrant } from '../../shared/localAgentRequests'
import { getMainWindow } from '../index'
import { engineManager } from '../engine/engineManager'
import { LocalAgentError } from '../errors'
import { ipcHandle } from './_wrap'
import type {
  AddAgentFolderInput,
  AgentCredentialBinding,
  AddAgentFolderResult,
  AgentRootDto,
  AgentsHomeAccess,
  AgentsHomeState,
  CreateLocalAgentInput,
  DeleteLocalAgentInput,
  DeleteLocalAgentResult,
  PickAgentFolderResult,
  DraftLocalAgentResult,
  LocalAgentDocDto,
  LocalAgentDto,
  ReadLocalAgentDocInput,
  LocalAgentValidation,
  OpenLocalAgentCredentialsResult,
  OpenLocalAgentPathInput,
  RescanResult,
  UpdateLocalAgentFieldInput
} from '../../shared/localAgents'
import type { LocalAgentOutcome } from '../../shared/localAgents'
import type { LocalAgentRuntimeInput } from '../../shared/engine'
import { localAgentFailure } from '../../shared/localAgents'
import { DomainError } from '../errors'

/**
 * Run a handler whose **failure code the renderer acts on**, returning the code
 * in the payload instead of throwing it.
 *
 * Electron drops every own property of a thrown error, `code` included, so a
 * handler that throws `KitError('manifest_modified')` reaches the page as an
 * anonymous `Error` — and the reload prompt, which exists precisely to catch
 * that code, never fires. The preload bridge rebuilds a rejected error from
 * this shape, so callers are unchanged and the code survives.
 */
function withCode<T>(fn: () => T): LocalAgentOutcome<T> {
  try {
    return { ok: true, value: fn() }
  } catch (err) {
    if (err instanceof DomainError) return localAgentFailure(err)
    throw err
  }
}

/** {@link withCode} for a handler that awaits — the trash call is async. */
async function withCodeAsync<T>(fn: () => Promise<T>): Promise<LocalAgentOutcome<T>> {
  try {
    return { ok: true, value: await fn() }
  } catch (err) {
    if (err instanceof DomainError) return localAgentFailure(err)
    throw err
  }
}

/**
 * Folder agents: the roots they live in, the folders themselves, and the
 * in-place edits the agent page makes.
 *
 * Thin controllers throughout — activation gate, scope, delegate. Folder agents
 * are machine-local and follow every profile, so they live in the **settings
 * scope** (`getSettingsScopeUserId()`), exactly like locally-registered A2A
 * agents. There is no per-profile variant to resolve.
 *
 * **Paths never arrive from the renderer as trusted input.** `:root-add` asks
 * the user with a native directory picker rather than accepting a string, which
 * is the same reasoning `pathGuard` applies to the file domain: a path the user
 * chose in an OS dialog is trustworthy, one the renderer typed is not. Every
 * other path parameter is agent-relative and re-resolved inside its folder by
 * `localAgentService`.
 */
export function registerLocalAgentHandlers(): void {
  // Composition root for the feature: hands Phase 4's "open in…" guard the real
  // roots and gives the folder watcher its scanner callbacks. Must run before
  // any handler below, and before `local-tools:open-in` can succeed.
  localAgentService.configure(getSettingsScopeUserId)

  ipcHandle(
    'local-agent:list',
    (): { roots: AgentRootDto[]; agents: LocalAgentDto[]; homeAccess: AgentsHomeAccess } => {
      userActivation.requireActivated()
      return localAgentService.list(getSettingsScopeUserId())
    }
  )

  /**
   * Where the agents home is, and whether it can be used yet.
   *
   * Deliberately **not** activation-gated: the onboarding copy names this folder
   * before there is an activated user to gate on. And on a fresh install it
   * touches no files, which is what lets the modal ask about the folder without
   * the asking being the write it is explaining — see `homePath.ts` for the
   * exact shape of that guarantee.
   */
  ipcHandle('local-agent:home-state', (): AgentsHomeState => {
    return homeAccessService.state(getSettingsScopeUserId())
  })

  /**
   * Create the agents home now that the user has been shown what it is for.
   *
   * The macOS Documents prompt lands during this call — which is why it is a
   * call of its own, made from a button the user pressed, rather than a side
   * effect of whichever screen happened to ask where the agents live.
   */
  ipcHandle('local-agent:home-grant', async (): Promise<AgentsHomeState> => {
    userActivation.requireActivated()
    return agentsHomeService.prepare(getSettingsScopeUserId())
  })

  /**
   * Move the agents home somewhere else and create it there.
   *
   * The recovery from a refused Documents folder, and the only way to change
   * the home at all. The path comes from the OS picker for the same reason
   * `:root-add`'s does — a folder the user chose in a system dialog is
   * trustworthy, a string the renderer supplied is not — and choosing it in
   * that dialog is also what grants access to it, so the folder that follows a
   * refusal never raises a second prompt.
   */
  ipcHandle(
    'local-agent:home-choose',
    async (): Promise<{ cancelled: true } | { cancelled: false; state: AgentsHomeState }> => {
      userActivation.requireActivated()
      const win = getMainWindow()
      const options: OpenDialogOptions = {
        title: 'Choose where to keep your agents',
        properties: ['openDirectory', 'createDirectory'],
        buttonLabel: 'Keep agents here'
      }
      const result = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options)
      const picked = result.filePaths[0]
      if (result.canceled || !picked) return { cancelled: true }

      // Through the settings service, so the picked folder faces the same path
      // rules as a value typed into the store — the picker can reach `/` and
      // the user's home itself, and neither may become a folder this app
      // scaffolds into.
      //
      // `prepare` reads the setting to know which folder to make, so the value
      // has to move first — but a folder that could not be created must not
      // stay the configured home. Left there, the next `ensureHome` takes its
      // "the home moved" branch and repoints the home root at a folder that
      // does not exist. So: move it, try it, and put it back if it did not work.
      const previous = appSettingsService.getAll().localAgentsHome
      appSettingsService.set('localAgentsHome', picked)
      let state: AgentsHomeState
      try {
        state = await agentsHomeService.prepare(getSettingsScopeUserId())
      } catch (err) {
        appSettingsService.set('localAgentsHome', previous)
        throw err
      }
      if (state.access !== 'ready') {
        appSettingsService.set('localAgentsHome', previous)
        // Thrown rather than returned. A folder the user chose in a system
        // dialog and could not be written to is a failure of *that* click, and
        // it belongs in the dialog's message slot beside the button they
        // pressed — not as a new state describing a home that has just been
        // rolled back underneath it.
        throw new LocalAgentError(
          'home_access_denied',
          `Cinna could not create an agents folder in ${picked}. Pick another one.`
        )
      }
      return { cancelled: false, state }
    }
  )

  /**
   * Which credential each folder agent would run on, resolved.
   *
   * Its own handler rather than a field on `local-agent:list`, because the two
   * change on different clocks: the agent list is the scanner's cache and moves
   * when a folder does, while a binding moves when the *credential* list moves —
   * a toggle in Settings, a new default chat mode — and neither event rescans
   * the other. Folded into the DTO, a credential switched off would leave every
   * sidebar row still claiming the runtime it had before the switch.
   *
   * Synchronous and local: `resolve` reads the manifest reference already parsed
   * into the DTO, the app settings and the default chat mode. The empty model
   * list is deliberate — no catalogue is needed to answer *which credential*,
   * and passing one would mean a network round trip per credential on a call the
   * sidebar makes.
   */
  ipcHandle('local-agent:credential-bindings', (): AgentCredentialBinding[] => {
    userActivation.requireActivated()
    const providers = providerService.listMerged()
    return localAgentService.list(getSettingsScopeUserId()).agents.map((agent) => ({
      agentId: agent.id,
      agentName: agent.name,
      credentialId: runtimeService.resolve(agent.runtime, providers).credentialId
    }))
  })

  ipcHandle('local-agent:get', (_event, agentId: string): LocalAgentOutcome<LocalAgentDto> => {
    userActivation.requireActivated()
    // Coded because `not_found` is a *routine* destination, not a fault: a
    // folder that lost an id fight has no index row, and the page has to say
    // that rather than "your folder is missing", which sends the user looking
    // for the wrong problem.
    return withCode(() => localAgentService.get(getSettingsScopeUserId(), agentId))
  })

  ipcHandle('local-agent:create', (_event, data: CreateLocalAgentInput): LocalAgentDto => {
    userActivation.requireActivated()
    return localAgentService.create(getSettingsScopeUserId(), data)
  })

  /**
   * Draft the prompts for a freshly scaffolded agent with one AI call.
   *
   * Separate from `:create` on purpose: the folder must exist the instant the
   * user asks for it, and this call can take half a minute. It is also the one
   * handler here that resolves nothing when there is no AI credential — it
   * reports `skipped` rather than failing, because a machine with no model
   * configured is a supported state, not an error.
   */
  ipcHandle('local-agent:draft', (_event, agentId: string): Promise<DraftLocalAgentResult> => {
    userActivation.requireActivated()
    return localAgentDraftService.draft(getSettingsScopeUserId(), agentId)
  })

  ipcHandle(
    'local-agent:update-field',
    (_event, data: UpdateLocalAgentFieldInput): LocalAgentOutcome<LocalAgentDto> => {
      userActivation.requireActivated()
      // Coded, because three of its refusals drive different behaviour:
      // `manifest_modified` / `file_modified` raise the reload prompt, and
      // `turn_in_progress` keeps the text and retries. Told apart only by code.
      const outcome = withCode(() =>
        localAgentService.updateField(getSettingsScopeUserId(), data)
      )
      // A saved runtime or a reworded prompt changes what the engine would run,
      // so reconcile — but never block the save on it. `applyConfigChange` is a
      // no-op when the generated bytes are identical, which is the common case
      // for an edit to a field the engine does not read.
      if (outcome.ok) {
        void engineManager.applyConfigChange(getSettingsScopeUserId())
      }
      return outcome
    }
  )

  /**
   * Trash the folder and drop the row. Coded, because `turn_in_progress` is
   * the one refusal the page has to explain rather than report: the agent is
   * mid-turn, and the folder is still there.
   */
  ipcHandle(
    'local-agent:delete',
    async (
      _event,
      input: DeleteLocalAgentInput
    ): Promise<LocalAgentOutcome<DeleteLocalAgentResult>> => {
      userActivation.requireActivated()
      const userId = getSettingsScopeUserId()
      const outcome = await withCodeAsync(() => localAgentService.delete(userId, input))
      // The engine's config lists every folder agent; one fewer is a change.
      if (outcome.ok) void engineManager.applyConfigChange(userId)
      return outcome
    }
  )

  ipcHandle('local-agent:rescan', (_event, rootId?: string): RescanResult[] => {
    userActivation.requireActivated()
    return localAgentService.rescan(getSettingsScopeUserId(), rootId)
  })

  /** One prompt document, text and stamp from the same read. */
  ipcHandle(
    'local-agent:read-doc',
    (_event, data: ReadLocalAgentDocInput): LocalAgentDocDto => {
      userActivation.requireActivated()
      return localAgentService.readDoc(
        getSettingsScopeUserId(),
        data?.agentId,
        data?.prompt
      )
    }
  )

  /**
   * The init prompt for one agent folder — what the user pastes into an
   * assistant the desktop cannot launch. Read-only: it resolves the folder from
   * the index row and looks for an entry document, and writes nothing.
   */
  ipcHandle('local-agent:init-prompt', (_event, agentId: string): string => {
    userActivation.requireActivated()
    return localAgentService.initPrompt(getSettingsScopeUserId(), agentId)
  })

  ipcHandle('local-agent:validate', (_event, agentId: string): LocalAgentValidation => {
    userActivation.requireActivated()
    return localAgentService.validate(getSettingsScopeUserId(), agentId)
  })

  ipcHandle('local-agent:open-path', (_event, data: OpenLocalAgentPathInput) => {
    userActivation.requireActivated()
    localAgentService.openPath(getSettingsScopeUserId(), data)
    return { success: true as const }
  })

  /**
   * Open the agent's `credentials/.env` for editing, creating it when it is not
   * there yet. Separate from `open-path` because it writes: the path is fixed
   * in main, never sent by the renderer.
   */
  ipcHandle(
    'local-agent:open-credentials',
    (_event, agentId: string): Promise<OpenLocalAgentCredentialsResult> => {
      userActivation.requireActivated()
      return localAgentService.openCredentials(getSettingsScopeUserId(), agentId)
    }
  )

  /**
   * The standing permission grants for one agent, and the two ways to revoke
   * them.
   *
   * The folder path is derived in main from the agent id, never sent by the
   * renderer — the same rule `open-credentials` follows, and for the same
   * reason: these handlers read and write a file inside an agent folder, and
   * the only proof that folder is the caller's is the ownership check
   * `localAgentService.locate` performs on the id.
   *
   * Each mutation answers with the list that is left, so the card does not have
   * to refetch to stop showing a row the user just removed.
   */
  ipcHandle('local-agent:grants-list', (_event, agentId: string): StoredPermissionGrant[] => {
    userActivation.requireActivated()
    return localAgentService.listPermissionGrants(getSettingsScopeUserId(), agentId)
  })

  ipcHandle(
    'local-agent:grant-forget',
    (_event, data?: { agentId: string; key: string }): StoredPermissionGrant[] => {
      userActivation.requireActivated()
      // `data?.` like its siblings: a payload that never arrived should fail as
      // `not_found` from the service, with the code the renderer knows, rather
      // than as a `TypeError` the bridge flattens into an anonymous Error.
      return localAgentService.forgetPermissionGrant(
        getSettingsScopeUserId(),
        data?.agentId as string,
        data?.key as string
      )
    }
  )

  ipcHandle('local-agent:grants-clear', (_event, agentId: string): StoredPermissionGrant[] => {
    userActivation.requireActivated()
    return localAgentService.forgetAllPermissionGrants(getSettingsScopeUserId(), agentId)
  })

  ipcHandle('local-agent:roots-list', (): AgentRootDto[] => {
    userActivation.requireActivated()
    return localAgentService.listRoots(getSettingsScopeUserId())
  })

  /**
   * Adopt an existing folder as an extra agents root. The path comes from the
   * OS directory picker, never from the renderer: nothing this handler accepts
   * can name a folder the user did not select. `cancelled` is a normal outcome,
   * not an error.
   */
  ipcHandle(
    'local-agent:root-add',
    async (): Promise<{ cancelled: true } | { cancelled: false; root: AgentRootDto }> => {
      userActivation.requireActivated()
      const win = getMainWindow()
      const result = win
        ? await dialog.showOpenDialog(win, {
            title: 'Choose an agents folder',
            properties: ['openDirectory', 'createDirectory'],
            buttonLabel: 'Use this folder'
          })
        : await dialog.showOpenDialog({
            title: 'Choose an agents folder',
            properties: ['openDirectory', 'createDirectory'],
            buttonLabel: 'Use this folder'
          })
      const picked = result.filePaths[0]
      if (result.canceled || !picked) return { cancelled: true }

      // Adopting a root installs the workshop template files into it. Ask
      // before doing that alongside content the user already has there — and
      // ask natively, in main, so the prompt cannot be skipped by whatever
      // called this channel.
      if (localAgentService.needsAdoptionConfirmation(picked)) {
        const confirm = await dialog.showMessageBox({
          type: 'question',
          buttons: ['Add agents folder', 'Cancel'],
          defaultId: 0,
          cancelId: 1,
          message: 'Set this folder up as an agents folder?',
          detail:
            'It already contains files. Cinna will add AGENTS.md, CLAUDE.md, README.md, .gitignore and a .cinna-kit folder, and will not change anything already there.'
        })
        if (confirm.response !== 0) return { cancelled: true }
      }

      return {
        cancelled: false,
        root: localAgentService.addRoot(getSettingsScopeUserId(), picked)
      }
    }
  )

  ipcHandle('local-agent:root-remove', (_event, rootId: string) => {
    userActivation.requireActivated()
    if (typeof rootId !== 'string' || rootId === '') {
      throw new LocalAgentError('root_not_found', 'That agents folder is not registered.')
    }
    return localAgentService.removeRoot(getSettingsScopeUserId(), rootId)
  })

  /**
   * Ask the user for a folder and report what is in it. **Nothing is
   * registered and nothing is written** — this is the preview half of adopting
   * a folder, so the user sees the fifteen agents that were found before
   * anything happens.
   *
   * The path is chosen in a native dialog here, the same rule `:root-add`
   * keeps: a path the user picked in an OS dialog is trustworthy, one the
   * renderer typed is not. The service records what was picked so the
   * `:folder-add` that follows can be checked against it.
   */
  ipcHandle('local-agent:folder-pick', async (): Promise<PickAgentFolderResult> => {
    userActivation.requireActivated()
    const win = getMainWindow()
    const options = {
      title: 'Choose an agent folder',
      properties: ['openDirectory' as const],
      buttonLabel: 'Use this folder'
    }
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    const picked = result.filePaths[0]
    if (result.canceled || !picked) return { cancelled: true }
    return localAgentService.pickedAgentFolder(getSettingsScopeUserId(), picked)
  })

  /**
   * Re-open the agent list of a root **already registered**, without a picker.
   *
   * Settings' Manage agents needs exactly what the adopt dialog shows — every
   * `AGENT.md` folder under the root, with the ones currently in the list
   * ticked — for a folder the user chose once already. Making them re-pick it
   * in an OS dialog to change one tick is the round trip this removes.
   *
   * **The renderer sends a root id, never a path.** The path comes out of the
   * user's own root row, so the rule that a renderer may not name a folder the
   * user did not choose is kept: this call cannot reach a directory that is not
   * already registered to them, and the `:folder-add` that follows needs no new
   * code path.
   *
   * What it *does* change is how a `pendingPick` comes to exist. `:folder-pick`
   * can only create one with a person standing at a native dialog; this creates
   * one from an id, with no human in the loop — so a compromised renderer can
   * pair it with `:folder-add` and empty a registered root's agent list without
   * the user touching anything. Bounded on purpose: the root must already be
   * registered, nothing on disk is touched, the same dialog puts the agents
   * back, and that renderer already has `:root-remove`, which is strictly
   * worse. Said plainly here rather than left as "no new trust", which is what
   * this comment claimed first and is not true.
   */
  ipcHandle('local-agent:root-manage', (_event, rootId: string): PickAgentFolderResult => {
    userActivation.requireActivated()
    const userId = getSettingsScopeUserId()
    if (typeof rootId !== 'string' || rootId === '') {
      throw new LocalAgentError('root_not_found', 'That agents folder is not registered.')
    }
    // Through the root row, never a renderer-supplied path — the same rule
    // `:git-status` keeps for the same reason.
    const root = agentsHomeService.requireNamedRoot(userId, rootId)
    return localAgentService.pickedAgentFolder(userId, root.path)
  })

  /** A root's repository, in the detail the folder's Repository dialog shows. */
  ipcHandle(
    'local-agent:git-detail',
    async (_event, input: { rootId: string; fetch?: boolean }): Promise<GitDetail> => {
      userActivation.requireActivated()
      const root = agentsHomeService.requireNamedRoot(getSettingsScopeUserId(), input?.rootId)
      return gitService.readGitDetail(root.path, input?.fetch === true)
    }
  )

  /** Register the folder the user just previewed, with the agents they ticked. */
  ipcHandle(
    'local-agent:folder-add',
    (_event, input: AddAgentFolderInput): LocalAgentOutcome<AddAgentFolderResult> => {
      userActivation.requireActivated()
      const userId = getSettingsScopeUserId()
      // Coded: `invalid_path` (the pick went stale) and `invalid_input` (nothing
      // ticked) are both things the dialog explains in place and recovers from,
      // not failures that should close it.
      const outcome = withCode(() => localAgentService.addAgentFolder(userId, input))
      // New agents in the engine's catalogue.
      if (outcome.ok) void engineManager.applyConfigChange(userId)
      return outcome
    }
  )

  /** Rename a bare agent. Kit agents rename through `:update-field`. */
  ipcHandle(
    'local-agent:rename',
    (
      _event,
      input: { agentId: string; name: string | null }
    ): LocalAgentOutcome<LocalAgentDto> => {
      userActivation.requireActivated()
      const userId = getSettingsScopeUserId()
      const outcome = withCode(() =>
        localAgentService.renameAgent(userId, input?.agentId ?? '', input?.name ?? null)
      )
      // The name is the OpenCode agent key's readable half, so the engine's
      // config genuinely changed.
      if (outcome.ok) void engineManager.applyConfigChange(userId)
      return outcome
    }
  )

  /**
   * Save which credential and model a bare agent runs on.
   *
   * Kit agents save their runtime through `:update-field`, which is a stamped
   * write into `cinna-agent.json`. A bare folder has no manifest and is never
   * written into, so its choice lands in that agent's state under `userData`
   * and needs a channel of its own — the stamp the other channel requires would
   * name a file this write does not touch.
   */
  ipcHandle(
    'local-agent:set-runtime',
    (
      _event,
      input: { agentId: string; runtime: LocalAgentRuntimeInput }
    ): LocalAgentOutcome<LocalAgentDto> => {
      userActivation.requireActivated()
      const userId = getSettingsScopeUserId()
      // Coded, like the manifest path: `turn_in_progress` is a state the panel
      // explains and retries, not a failure.
      const outcome = withCode(() =>
        localAgentService.setBareRuntime(userId, input?.agentId ?? '', input?.runtime)
      )
      // The engine's config names each agent's provider and model, so this is
      // exactly the change `applyConfigChange` exists for.
      if (outcome.ok) void engineManager.applyConfigChange(userId)
      return outcome
    }
  )

  /**
   * The git state of one registered root.
   *
   * `fetch` is the caller's choice because it is a network round trip: the
   * settings screen renders the cached counts on open and fetches only when the
   * user asks it to check.
   */
  ipcHandle(
    'local-agent:git-status',
    async (_event, input: { rootId: string; fetch?: boolean }): Promise<GitStatus> => {
      userActivation.requireActivated()
      // Through the root row, never a renderer-supplied path: this spawns a
      // subprocess with a working directory, and the only directories it may
      // ever run in are ones the user registered.
      const root = agentsHomeService.requireNamedRoot(getSettingsScopeUserId(), input?.rootId)
      return gitService.readGitStatus(root.path, input?.fetch === true)
    }
  )

  /**
   * Fast-forward one root, then rescan it.
   *
   * The rescan is the point: a pull that adds an agent folder, removes one, or
   * rewrites an `AGENT.md` has to be visible without the user knowing to press
   * Rescan. The watcher would get there eventually, but a pull rewrites many
   * files at once and the debounce is not a promise.
   */
  ipcHandle('local-agent:git-update', async (_event, rootId: string): Promise<GitUpdateResult> => {
    userActivation.requireActivated()
    const userId = getSettingsScopeUserId()
    const root = agentsHomeService.requireNamedRoot(userId, rootId)
    const result = await gitService.updateGitRepo(root.path)
    if (result.updated) {
      localAgentService.rescan(userId, root.id)
      void engineManager.applyConfigChange(userId)
    }
    return result
  })
}
