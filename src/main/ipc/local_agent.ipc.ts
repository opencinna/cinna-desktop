import { dialog } from 'electron'
import { userActivation } from '../auth/activation'
import { getSettingsScopeUserId } from '../auth/scope'
import { localAgentService } from '../services/localAgents/localAgentService'
import { localAgentDraftService } from '../services/localAgents/draftService'
import type { StoredPermissionGrant } from '../../shared/localAgentRequests'
import { getMainWindow } from '../index'
import { engineManager } from '../engine/engineManager'
import { LocalAgentError } from '../errors'
import { ipcHandle } from './_wrap'
import type {
  AgentRootDto,
  CreateLocalAgentInput,
  DeleteLocalAgentResult,
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
    (): { roots: AgentRootDto[]; agents: LocalAgentDto[] } => {
      userActivation.requireActivated()
      return localAgentService.list(getSettingsScopeUserId())
    }
  )

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
    async (_event, agentId: string): Promise<LocalAgentOutcome<DeleteLocalAgentResult>> => {
      userActivation.requireActivated()
      const userId = getSettingsScopeUserId()
      const outcome = await withCodeAsync(() => localAgentService.delete(userId, agentId))
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
}
