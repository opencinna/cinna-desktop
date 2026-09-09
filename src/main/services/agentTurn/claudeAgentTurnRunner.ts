/**
 * The third implementation of {@link AgentTurnRunner}: a folder agent on the
 * **Claude Agent SDK**, driving the `claude` binary already installed on this
 * machine, under that install's own login.
 *
 * ## What this is not
 *
 * It is not a second `LocalAgentTurnRunner`, and it deliberately shares nothing
 * with it below the `AgentTurnRunner` seam. There is no `engineEventBus`, no
 * `sseParser`, no durable cursor, no hole-and-heal recovery and no
 * `engineManager` — because the SDK is an async generator **in this process**.
 * There is no socket to drop, no stream to fan out to a second agent, and no
 * shared server whose restart could end somebody else's turn. Inventing a
 * common transport abstraction across the two would be manufacturing a shape
 * that only one of them has; the shared shape is `AgentTurnRunner`, one level
 * up, and that is sufficient.
 *
 * What *is* reused is everything above the transport: `RunAgentTurnInput` /
 * `RunAgentTurnResult`, `StreamPartsAccumulator`, the delta port, the session
 * stores, `turnLock`, and the never-throws contract.
 *
 * ## Everything here that is load-bearing was learned from the binary
 *
 * `docs/agents/local_agents/claude_contract.md` is the record. Four of its
 * findings are structural to this file and none is visible in the SDK's types:
 *
 * 1. **Failures are thrown, not yielded.** Both "Not logged in" and a stale
 *    `resume` come out of the async iterator as an exception, never as a
 *    `result` message. So the `try` wraps the whole iteration — otherwise
 *    `runTurn`'s never-throws contract breaks on the two most likely first-run
 *    failures, and `ipcMain.handle` drops the code off the rejection.
 * 2. **Cancellation is also a throw, and its `.name` is `'Error'`** — not
 *    `'AbortError'`. It is told apart from a real failure by
 *    `input.signal.aborted` and by nothing else.
 * 3. **`settingSources: []` does not isolate MCP servers.** Without
 *    `strictMcpConfig` the user's own connectors — Gmail, Drive, Calendar in
 *    the probe — are handed to the agent, and no Cinna surface says so.
 * 4. **A bare tool name in `allowedTools` bypasses `canUseTool` entirely**, so
 *    the two cannot both express the profile. Phase 4 owns that; this file
 *    passes no `allowedTools` at all, which is the half that has to be true
 *    before the permission wiring can mean anything.
 */

import { query } from '@anthropic-ai/claude-agent-sdk'
import type { RunAgentTurnInput, RunAgentTurnResult } from '../a2aStreamingService'
import { StreamPartsAccumulator } from '../../agents/streamPartsAccumulator'
import type { AgentStreamEvent } from '../../../shared/agentStreamEvents'
import { createLogger } from '../../logger/logger'
import type { AgentTurnRunner } from './runner'
import type { LocalAgentKind } from '../../../shared/localAgents'
import { auditClaudeEnv, buildClaudeEnv } from './claudeEnv'
import type { ClaudeAuthStatus } from './claudeAuth'
import { ClaudeMessageStream } from './claudeMessages'
import { describeEngineSkip } from '../../../shared/runtimeMessages'
import { pendingRequests } from './pendingRequests'
import { mintPermissionRequestId, toClaudePermissionRequest } from './claudePermissions'
import type { LocalPermissionRequest } from '../../../shared/localAgentRequests'

const logger = createLogger('claude-agent-turn')

/**
 * The backstop, matching the local engine's own.
 *
 * The failure it guards against is different — a generator that never yields,
 * rather than an event that never arrives — but the consequence is identical: a
 * turn that never settles holds its per-agent lock for the life of the app.
 * Generous on purpose; a real agent doing real work takes minutes, and a
 * ceiling that fires on a working turn is worse than no ceiling.
 */
export const CLAUDE_TURN_CEILING_MS = 20 * 60 * 1000

/** What the runner needs from the world, so it is drivable with no child process. */
export interface ClaudeTurnDeps {
  /** The folder agent as it is on disk right now. */
  getAgent(
    userId: string,
    agentId: string
  ): {
    name: string
    path: string
    kind: LocalAgentKind
    enabled: boolean
    readiness: string
    readinessReason: string | null
  } | null
  /** The assembled system prompt for this agent — `promptAssembly`'s answer. */
  systemPrompt(userId: string, agentId: string): string
  /** The model alias this agent's runtime resolved to, or null for the CLI's default. */
  model(userId: string, agentId: string): string | null
  /**
   * Absolute path of the `claude` this machine has, or null when there is none.
   *
   * Async because `toolDetectionService` is: it walks the login-shell `PATH`
   * (and macOS `.app` bundles) on first use and caches the answer. Resolved
   * before the lock is taken, so "there is no Claude Code here" never queues
   * behind another chat's turn.
   */
  claudePath(): Promise<string | null>
  /**
   * Whether that install is logged in, asked without running a turn.
   *
   * Free (`claude auth status` bills nothing and logs nobody in or out), and
   * answered *before* the lock is taken, for the same reason `claudePath` is:
   * "log in with `claude` in a terminal" is a sentence, not a failed turn.
   *
   * `unknown` must never block — a probe that could not answer is not evidence
   * of a logged-out install, and the thrown-error fallback below still covers
   * it. See `claudeAuth.ts`.
   */
  claudeAuth(): Promise<ClaudeAuthStatus>
  /** The login-shell environment, for {@link buildClaudeEnv}. */
  shellEnv(): Promise<NodeJS.ProcessEnv>
  /** This app's version, for the client-app identifier. */
  appVersion(): string
  /** The remembered session id for this (chat, agent), if any. */
  readSession(chatId: string, agentId: string): string | null
  /** Remember it, in both `desktop.json` and `a2a_sessions.context_id`. */
  saveSession(input: {
    chatId: string
    agentId: string
    agentDir: string
    agentKind: LocalAgentKind
    sessionId: string
  }): void
  /**
   * True when this agent folder already holds a grant covering an ask.
   *
   * Consulted **before** a block is written, so a decision the user has already
   * made never reaches the transcript a second time. Must not throw: an
   * unreadable store means "ask the user", which is the safe direction.
   */
  isGranted(agentDir: string, agentKind: LocalAgentKind, request: LocalPermissionRequest): boolean
  /** Take the per-agent lock for the streaming part of the turn. */
  withLock<T>(agentId: string, owner: string, fn: () => Promise<T>): Promise<T>
  /** The settings-scope user id that owns folder agents. */
  userId(): string
  /** The SDK entry point. Injected so the runner is testable with no binary. */
  query?: typeof query
  /** Override the turn ceiling. Tests only. */
  turnCeilingMs?: number
}

function fail(message: string, raw?: string): RunAgentTurnResult {
  return { text: '', parts: [], notices: [], error: { message, raw: raw ?? message } }
}

/**
 * True when a thrown error is the CLI reporting it has no credential.
 *
 * Substring matching, and it is not a shortcut. The SDK wraps every error
 * result identically — `Claude Code returned an error result: <text>` with
 * `errorClass: 'error_result'` — so the *only* thing separating "not logged in"
 * from "that session is gone" is the text. Readiness is answered before a turn
 * precisely so this is a fallback rather than the mechanism; when it does fire,
 * saying the useful sentence beats passing through a raw CLI string.
 */
function isNotLoggedIn(message: string): boolean {
  return /not logged in|\/login/i.test(message)
}

/** True when a thrown error is a `resume` against a session the CLI forgot. */
function isMissingSession(message: string): boolean {
  // **Only the observed wording.** This used to also match any error merely
  // mentioning a session id, which is a retry trigger the CLI can pull by
  // accident: a rate-limit or state error that happens to name the session
  // would re-run the whole turn — a second billed turn, for a failure that had
  // nothing to do with continuity. The text is the only discriminator the SDK
  // gives (every error result arrives with `errorClass: 'error_result'`), so it
  // has to be the narrow one.
  return /no conversation found/i.test(message)
}

export class ClaudeAgentTurnRunner implements AgentTurnRunner {
  constructor(private readonly deps: ClaudeTurnDeps) {}

  async runTurn(input: RunAgentTurnInput): Promise<RunAgentTurnResult> {
    const { chatId, agentId, signal } = input
    const userId = this.deps.userId()

    const agent = this.deps.getAgent(userId, agentId)
    if (!agent) return fail('This agent’s folder could not be found on disk.')
    if (!agent.enabled) {
      return fail(`“${agent.name}” is switched off. Turn it back on to chat with it.`)
    }
    if (agent.readiness === 'invalid' || agent.readiness === 'contract_too_new') {
      return fail(
        agent.readinessReason ?? 'This agent’s folder is not in a state it can be run from.'
      )
    }

    // **Readiness before the turn, not as a failed one.** "There is no Claude
    // Code on this machine" is answerable without spawning anything, and
    // answering it here means the user reads a sentence naming the remedy
    // instead of a turn that fails with the CLI's own words.
    const claudePath = await this.deps.claudePath()
    if (!claudePath) return fail(describeEngineSkip('claude_not_installed'))

    // The second rung, and the one that used to cost a turn. It is asked after
    // the path because there is nothing to ask when there is no binary, and it
    // is `unknown`-tolerant on purpose: only a definite `logged_out` stops a
    // turn. Anything else — a probe that timed out, a CLI whose output shape
    // moved — falls through to the run, where `isNotLoggedIn` still catches the
    // thrown error. A readiness check that can refuse a working engine on its
    // own uncertainty is worse than no readiness check.
    // `.catch` and not a `try`, because this sits *outside* the one below and a
    // rejection here would escape `runTurn` — the never-throws contract broken
    // by the check that exists to make turns fail less. A probe that could not
    // answer is `unknown`, which never blocks.
    const auth = await this.deps
      .claudeAuth()
      .catch((): ClaudeAuthStatus => ({
        state: 'unknown',
        authMethod: null,
        subscriptionType: null,
        email: null
      }))
    if (auth.state === 'logged_out') {
      logger.info('a Claude turn was refused: that install is not logged in', { agentId })
      return fail(describeEngineSkip('claude_not_logged_in'))
    }

    try {
      return await this.deps.withLock(agentId, 'turn', () =>
        this.stream({ input, agent, claudePath, userId, chatId, agentId, signal })
      )
    } catch (err) {
      // `turnLock.acquire` throws rather than queueing, and its message is
      // already user-facing ("This agent is busy right now…"). Letting it
      // escape would break the never-throws contract at the one place the
      // renderer has no way to recover — the port closes having posted neither
      // `done` nor `error`, and the chat streams forever.
      const message = err instanceof Error ? err.message : String(err)
      logger.warn('a Claude turn could not start', { agentId, chatId, error: message })
      return fail(message, String(err))
    }
  }

  private async stream(ctx: {
    input: RunAgentTurnInput
    agent: { name: string; path: string; kind: LocalAgentKind }
    claudePath: string
    userId: string
    chatId: string
    agentId: string
    signal: AbortSignal
  }): Promise<RunAgentTurnResult> {
    const { agent, claudePath, userId, chatId, agentId, signal } = ctx

    const stream = new ClaudeMessageStream()
    const accumulator = new StreamPartsAccumulator({
      onToolCall: ({ name, input }) => logger.info(`tool call → ${name}`, { input })
    })
    const deltaPort = {
      postMessage: (event: AgentStreamEvent): void => ctx.input.onEvent?.(event)
    }

    const env = buildClaudeEnv({
      shellEnv: await this.deps.shellEnv(),
      appVersion: this.deps.appVersion()
    })
    // Checked on the value actually being handed over, not on the function that
    // produced it. The environment is the one input whose corruption is
    // invisible in the result: a turn billed to the wrong account looks exactly
    // like a turn billed to the right one. Names only, never values.
    const leaked = auditClaudeEnv(env)
    if (leaked.length > 0) {
      logger.error('an auth-bearing variable reached a Claude agent’s environment', {
        agentId,
        names: leaked
      })
    }

    const remembered = this.deps.readSession(chatId, agentId)
    const model = this.deps.model(userId, agentId)
    const systemPrompt = this.deps.systemPrompt(userId, agentId)
    const run = this.deps.query ?? query

    // The ceiling is armed around the whole iteration rather than settling a
    // promise, because there is nothing else to settle: this loop *is* the
    // turn. Aborting the controller is what actually stops the child.
    const ceiling = new AbortController()
    const timer = setTimeout(
      () => ceiling.abort(),
      this.deps.turnCeilingMs ?? CLAUDE_TURN_CEILING_MS
    )
    timer.unref?.()
    let hitCeiling = false
    ceiling.signal.addEventListener('abort', () => {
      hitCeiling = !signal.aborted
    })
    const onAbort = (): void => ceiling.abort()
    signal.addEventListener('abort', onAbort, { once: true })

    /**
     * **A listener added to an already-aborted signal never fires**, so the
     * `onAbort` above cannot cover a stop that landed before it was attached —
     * and everything before it can await: `claudePath()` walks the login-shell
     * PATH and macOS app bundles on first use, `shellEnv()` may source a
     * profile. A cancellation in that window used to be dropped entirely. The
     * ceiling controller stayed live, the `claude` child ran the whole turn,
     * and the user's plan paid for a turn they had cancelled — while the result
     * was still reported, correctly, as "not an error", so nothing looked wrong
     * anywhere.
     *
     * Checked here rather than by aborting the controller, because there is no
     * await between this line and the `query()` call: an abort either fired the
     * listener or is visible right here, and spawning a child in order to abort
     * it still costs a process launch.
     */
    if (signal.aborted) {
      logger.info('a Claude turn was stopped before it started', { agentId, chatId })
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      return { text: '', parts: [], notices: [] }
    }

    const startedAt = Date.now()
    let sessionId: string | null = remembered
    let apiKeySource: string | null = null
    let ended: { isError: boolean; text: string } | undefined
    const kindCounts: Record<string, number> = {}

    /** Ids this turn parked on, so every exit can release them. */
    const parked = new Map<string, () => void>()

    /**
     * The permission gate.
     *
     * The promise **is** the park: awaiting it blocks the tool call, so there
     * is no out-of-band reply to post and no request id for the SDK to
     * correlate. Everything below the transcript block — `pendingRequests`, the
     * answer IPC, the park timeout and its reject path — is reused unchanged.
     *
     * Note what is not returned: `updatedPermissions`. The SDK's `suggestions`
     * would let us persist "always" into Claude Code's **own** rules, which are
     * user-global and shared with the user's personal install. *Always allow*
     * stays a `desktop.json` row and comes back here as a plain allow.
     */
    const canUseTool = async (
      toolName: string,
      toolInput: Record<string, unknown>
    ): Promise<{ behavior: 'allow'; updatedInput: Record<string, unknown> } | { behavior: 'deny'; message: string }> => {
      const request = toClaudePermissionRequest(toolName, toolInput)

      // **Answered before anything is written.** A standing grant settles the
      // ask silently: no block, no wait. A block that appeared and answered
      // itself milliseconds later would be a widget the user cannot act on, in
      // the middle of streaming text.
      let granted = false
      try {
        granted = this.deps.isGranted(agent.path, agent.kind, request)
      } catch (err) {
        // An unreadable store means "ask the user" — the safe direction.
        logger.warn('could not read this agent’s permission grants', {
          agentId,
          error: err instanceof Error ? err.message : String(err)
        })
      }
      if (granted) return { behavior: 'allow', updatedInput: toolInput }

      const requestId = mintPermissionRequestId()
      const handle = pendingRequests.register({
        requestId,
        chatId,
        agentId,
        kind: 'permission',
        // The ask travels with the registration so the answer path can scope a
        // grant to what was actually named, without a second parse.
        request
      })
      parked.set(requestId, handle.cancel)

      const asked = stream.askPermission(requestId, request)
      if (asked.message) accumulator.ingestMessage(asked.message, deltaPort)

      /** Record the decision beside the ask, then answer the SDK. */
      const settle = (
        note: string,
        answer:
          | { behavior: 'allow'; updatedInput: Record<string, unknown> }
          | { behavior: 'deny'; message: string }
      ): typeof answer => {
        const settled = stream.settlePermission(requestId, note)
        if (settled.message) accumulator.ingestMessage(settled.message, deltaPort)
        return answer
      }

      try {
        const resolution = await handle.answered

        // **`rejected` is not a user saying no.** `pendingRequests` settles
        // with it when the park times out or the turn ends underneath — and it
        // *resolves* with it rather than rejecting, so this is the real
        // expiry path, not the `catch` below. Denying is the only safe answer
        // either way, but the transcript must not record "Denied" for a
        // decision nobody made: an approval log that cannot tell a refusal from
        // an abandonment is worth very little.
        if (resolution.kind === 'rejected') {
          return settle('No answer — the request expired.', {
            behavior: 'deny',
            message: 'The request was not answered in time, so the action was not allowed.'
          })
        }
        if (resolution.kind === 'permission' && resolution.reply !== 'reject') {
          // `always` is answered by the desktop and never sent onward — the
          // grant was written beside the folder, and what the CLI is told is a
          // plain allow. The transcript says which of the two actually happened.
          return settle(
            resolution.remembered ? 'Allowed, and remembered for this agent.' : 'Allowed once.',
            { behavior: 'allow', updatedInput: toolInput }
          )
        }
        // The message is what the model receives as the tool result, verbatim —
        // observed. So it is written for the model, not for the transcript.
        return settle('Denied.', {
          behavior: 'deny',
          message: 'The person running this agent declined that action.'
        })
      } catch (err) {
        // Not the timeout — that resolves, above. This is the registry itself
        // failing, which has never been seen. Denying is the only safe answer:
        // nobody approved anything.
        logger.warn('a permission request failed to settle', {
          agentId,
          error: err instanceof Error ? err.message : String(err)
        })
        return settle('No decision was recorded.', {
          behavior: 'deny',
          message: 'The action could not be approved.'
        })
      } finally {
        parked.delete(requestId)
      }
    }

    /** One pass over the generator. Returns the error to report, or null. */
    const drain = async (resume: string | null): Promise<string | null> => {
      try {
        for await (const message of run({
          prompt: ctx.input.wireContent,
          options: {
            cwd: agent.path,
            // The user's binary, never the SDK's bundled one — see the
            // packaging note in `electron-builder.yml`. Anything else makes
            // "the unmodified CLI you installed" rhetoric rather than fact.
            pathToClaudeCodeExecutable: claudePath,
            // The folder already says what this agent is, through
            // `promptAssembly`. The `claude_code` preset is a coding
            // assistant's prompt and would talk over it.
            systemPrompt,
            ...(model ? { model } : {}),
            // **The desktop's boundary.** `settingSources: []` keeps the user's
            // own `settings.json`, `CLAUDE.md`, project skills and plugins from
            // redefining what this agent may do — a stray `CLAUDE.md` two
            // directories up rewriting an agent's behaviour is invisible in
            // every surface the user reads.
            settingSources: [],
            // …and these two are the half `settingSources` does not cover.
            // Without them the user's own MCP connectors stay attached; the
            // probe found Gmail, Drive and Calendar still there.
            strictMcpConfig: true,
            mcpServers: {},
            // Off by default. Without it the turn appears to hang until the
            // first tool call, and the translator's text path never runs.
            includePartialMessages: true,
            env,
            // **No `allowedTools`.** A bare tool name there auto-approves
            // before this callback is consulted — the SDK warns
            // `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` — so the desktop's grants
            // would be bypassed for exactly the tools a profile named.
            canUseTool,
            abortController: ceiling,
            ...(resume ? { resume } : {})
          }
        })) {
          const kind =
            typeof (message as { type?: unknown }).type === 'string'
              ? (message as { type: string }).type
              : 'unknown'
          kindCounts[kind] = (kindCounts[kind] ?? 0) + 1

          const update = stream.apply(message)
          if (update.sessionId) sessionId = update.sessionId
          if (update.apiKeySource) apiKeySource = update.apiKeySource
          if (update.message) accumulator.ingestMessage(update.message, deltaPort)
          if (update.ended) ended = update.ended
        }
        return null
      } catch (err) {
        return err instanceof Error ? err.message : String(err)
      }
    }

    try {
      let error = await drain(remembered)

      // **A remembered session is verified by use, not by a probe**, because
      // there is no endpoint to ask. A resume against a session the CLI has
      // forgotten throws, and the right response is to start a fresh one and
      // carry on without explaining — the user asked a question, not to be told
      // about our bookkeeping.
      // **Never retry a turn that already produced output.** The retry reuses
      // this turn's stream and accumulator, and a second pass arrives under
      // fresh message ids — so its parts are *appended* to the first pass's
      // rather than replacing them, and the user reads the answer twice for two
      // billed turns. A turn that has already streamed has no forgotten session
      // to blame anyway: the CLI plainly found one.
      const streamedAlready = accumulator.snapshotParts().length > 0
      if (
        error &&
        remembered &&
        !signal.aborted &&
        !streamedAlready &&
        isMissingSession(error)
      ) {
        logger.info('the remembered Claude session was gone; starting a fresh one', {
          agentId,
          chatId
        })
        sessionId = null
        error = await drain(null)
      }

      // Abort first, and the order is the point: a stop that lands mid-turn
      // would otherwise be reported to the user as an error for something they
      // did deliberately. An aborted turn is not an error anywhere else either.
      if (signal.aborted) {
        logger.info('a Claude turn was stopped by the user', { agentId, chatId })
        return this.finish(ctx, accumulator, sessionId, undefined, apiKeySource)
      }
      if (hitCeiling) {
        logger.error('a Claude turn hit the ceiling without ending', { agentId, chatId })
        return this.finish(
          ctx,
          accumulator,
          sessionId,
          'The agent stopped responding and the turn was ended.',
          apiKeySource
        )
      }
      if (error) {
        logger.warn('a Claude turn failed', { agentId, chatId, error })
        return this.finish(
          ctx,
          accumulator,
          sessionId,
          isNotLoggedIn(error) ? describeEngineSkip('claude_not_logged_in') : error,
          apiKeySource
        )
      }

      // **The panel must not assert a subscription we merely hope for.** A
      // value other than `'none'` means something reached the child that we
      // intended to strip, and the user is being billed somewhere they did not
      // choose. Every turn it happens, in the log **and in the transcript**.
      if (apiKeySource && apiKeySource !== 'none') {
        logger.warn('a Claude turn did not run on the install’s own login', {
          agentId,
          apiKeySource
        })
      }
      logger.info('Claude turn complete', {
        agentId,
        chatId,
        sessionId,
        apiKeySource,
        durationMs: Date.now() - startedAt,
        kindCounts
      })
      return this.finish(
        ctx,
        accumulator,
        sessionId,
        ended?.isError ? ended.text || 'The agent stopped with an error.' : undefined,
        apiKeySource
      )
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      // Every exit releases what this turn parked on. A request left registered
      // keeps `isPending` returning true, so a persisted block goes on
      // rendering as answerable and answering it reports success into a turn
      // that ended.
      for (const [, cancel] of parked) cancel()
      parked.clear()
    }
  }

  /**
   * One exit for every path, so a turn that failed after streaming still keeps
   * what it streamed — an error should not blank a partial answer, and the A2A
   * path behaves the same way.
   */
  private finish(
    ctx: {
      agent: { path: string; kind: LocalAgentKind }
      chatId: string
      agentId: string
    },
    accumulator: StreamPartsAccumulator,
    sessionId: string | null,
    error: string | undefined,
    /**
     * What the CLI reported it authenticated with, when a turn got that far.
     *
     * **Passed on every exit, not only the successful one.** The observation is
     * made at the init message, so a turn that reported the wrong account and
     * then failed, hit the ceiling or was cancelled has *already been billed to
     * it* — the exit path it happened to take cannot be what decides whether
     * the user is told.
     */
    apiKeySource?: string | null
  ): RunAgentTurnResult {
    if (sessionId) {
      try {
        this.deps.saveSession({
          chatId: ctx.chatId,
          agentId: ctx.agentId,
          agentDir: ctx.agent.path,
          agentKind: ctx.agent.kind,
          sessionId
        })
      } catch (err) {
        // Continuity is a convenience; losing it must not fail a turn that
        // otherwise worked.
        logger.warn('could not record the Claude session', {
          agentId: ctx.agentId,
          error: err instanceof Error ? err.message : String(err)
        })
      }
    }
    const parts = accumulator.snapshotParts()
    const answer = accumulator.answerText()
    /**
     * **A turn that did not run on the install's own login says so, where the
     * user is.**
     *
     * `apiKeySource` is the *observed* fact — what the CLI reports it
     * authenticated with — and `'none'` is a claude.ai login. Anything else
     * means something reached the child that this app intended to strip, and
     * the person is being billed on an account they did not pick in the
     * Runs-with panel. A log line alone is not enough for that: nobody reads
     * the log until they already suspect something, and the whole point is that
     * this failure otherwise looks exactly like success.
     *
     * A **notice**, not a status line, because notices are the existing channel
     * for agent-side system messages and land in the transcript beside the turn
     * they describe — the panel would say it once, about whichever turn ran
     * last, on a screen the user may not be looking at. Silence when the value
     * is `'none'` or absent: this app never asserts a subscription, it only
     * reports when the CLI says otherwise.
     */
    const notices = accumulator.snapshotNotices()
    if (apiKeySource && apiKeySource !== 'none') {
      notices.push({
        partKey: 'claude:api-key-source',
        text:
          `This turn did not run on your Claude Code login — the CLI reported “${apiKeySource}”. ` +
          'It may be billed to that account instead.'
      })
    }
    return {
      text: answer || parts.map((p) => p.text).join(''),
      parts,
      notices,
      ...(sessionId ? { contextId: sessionId } : {}),
      ...(error ? { error: { message: error, raw: error } } : {})
    }
  }
}
