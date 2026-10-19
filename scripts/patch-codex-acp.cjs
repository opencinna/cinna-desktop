const { readFileSync, writeFileSync, renameSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { createHash } = require('node:crypto')
const policy = require('../src/main/agents/drivers/acp/codexAdapterPatch.json')

// The reviewed patch of the pinned `@agentclientprotocol/codex-acp`
// `dist/index.js`, five edits. The user's Codex executable is never modified.
//
// 1. MCP merge. The adapter discards explicit per-server restrictions whenever
//    an ACP client injects a server. Preserve those entries, then let the
//    explicit session descriptor win (and enable it).
// 2. Session instructions. `_meta.cinna.systemPrompt` becomes the thread's
//    `developerInstructions` on start and on both resume paths (`session/load`
//    and `session/resume` share `this.resumeThread`), so fresh utility sessions
//    share a process without inheriting a chat's prompt. Upstream sets
//    `developerInstructions` itself only from AIR's `customInstructions`, which
//    Cinna never sends; on thread start its spread comes after ours.
// 3. AIR client off. Cinna declares `_meta.jetbrains.air` (acpActivity.ts
//    `airClientMeta`) only to negotiate the `asyncTasks` capability. From 2.0
//    the adapter also reads that declaration as "this client is the JetBrains
//    AIR UI" and reshapes what it sends for AIR's renderer: a command's output
//    stops streaming (no `_meta.terminal_output_delta` unless the client
//    declares it) and arrives elsewhere than `rawOutput.formatted_output`,
//    repeated `tool_call_update`s are thinned to what changed, permission asks,
//    questions, modes, commands and message chunks gain AIR-only `_meta`.
//    Cinna is not AIR and reads the plain shapes, so `isAirClient` answers
//    false. Every AIR-UI decision reads that one function (directly, or through
//    `ClientCapabilities.airClient`); the negotiated AIR capabilities
//    (`asyncTasks`, `nativeSubagentSessions`, …) are read by
//    `clientSupportsAirCapability` from the raw `clientCapabilities`, so they
//    stay as negotiated.
// 4. Whole command output at the end. 2.x streams a command's output as
//    `_meta.terminal_output_delta` fragments only, and the CLI never streams
//    what a command prints before its first output poll; once anything
//    streamed, the adapter does not resend the whole output. So the completing
//    update's `rawOutput` carries `{ exit_code, formatted_output }` (the
//    item's `aggregatedOutput`) for every command, terminal or not, as 1.11.0
//    did; the desktop stores that, not the fragments.
// 5. Cancel stops the subagents too. `session/cancel` interrupts only the root
//    thread's turn; a subagent thread spawned by a collaboration call
//    (`spawn_agent`) runs on, its commands with it, and nothing on the wire
//    says so (watched live on CLI 0.162.1: a child's 60 s sleep outlived the
//    Stop). So `cancel` then interrupts the in-progress turn of every thread
//    the adapter's `CodexSubagentSubscriptions` discovered under the session,
//    at any depth — its latest turn read with `thread/turns/list`, since a
//    child's `turn/started` can reach the client before it subscribes — and
//    terminates the thread's background terminals: an interrupted turn leaves
//    its running commands alive as such (the root's are reported as async
//    tasks the user can stop; a subagent's are not reported at all).
const original = '"mcp_servers": Object.fromEntries(serversToConfigure.map((mcp) => [mcp.name, this.createMcpSeverConfig(mcp.server)]))'
const replacement = '"mcp_servers": { ...configWithWorkspaceRoots.mcp_servers, ...Object.fromEntries(serversToConfigure.map((mcp) => [mcp.name, { enabled: true, ...this.createMcpSeverConfig(mcp.server) }])) }'
const instructions = '\n      ...(typeof request._meta?.cinna?.systemPrompt === "string" ? { developerInstructions: request._meta.cinna.systemPrompt } : {}),'
const instructionAnchors = [
  ['const response = await this.codexClient.threadStart({', 1],
  ['const response = await this.resumeThread({', 2]
]
const airClientAnchor = `function isAirClient(capabilities) {
  const meta3 = asRecord(capabilities?._meta);
  const jetbrains = asRecord(meta3[JETBRAINS_META_KEY]);
  const air = jetbrains[AIR_META_KEY];
  return air !== null && typeof air === "object" && !Array.isArray(air);
}
`
const airClientOff = `function isAirClient(capabilities) {
  // Cinna Desktop (scripts/patch-codex-acp.cjs): not the AIR UI; keep the plain shapes.
  return false;
}
`
const commandEndAnchor = `  commandEndRawOutput(end) {
    return end.terminal ? void 0 : { exit_code: end.exitCode };
  }
`
const commandEndWhole = `  commandEndRawOutput(end) {
    // Cinna Desktop (scripts/patch-codex-acp.cjs): the whole output, which the fragments can miss the head of.
    return { exit_code: end.exitCode, formatted_output: end.output };
  }
`
const childrenAnchor = `  rootAttributed(event, rootSessionId) {
    if (typeof event.params.threadId !== "string") return event;
`
const interruptChildren = `  // Cinna Desktop (scripts/patch-codex-acp.cjs): a cancel stops the session's subagents too, at any depth.
  async interruptChildren(rootSessionId) {
    const children = [...(this.sessions.get(rootSessionId)?.children ?? [])];
    await Promise.all(children.map(async (threadId) => {
      try {
        const turn = (await this.client.threadTurnsList({ threadId, cursor: null, limit: 1, sortDirection: "desc", itemsView: "notLoaded" })).data[0];
        if (turn?.status === "inProgress") await this.client.turnInterrupt({ threadId, turnId: turn.id });
      } catch (err) {
        logger.error("Cancel - subagent turnInterrupt failed", err);
      }
      // Its own step: a thread whose turn cannot be read or interrupted still has its commands ended.
      try {
        let cursor = null;
        do {
          const listed = await this.client.threadBackgroundTerminalsList({ threadId, cursor });
          await Promise.all(listed.data.map((terminal) => this.client.threadBackgroundTerminalsTerminate({ threadId, processId: terminal.processId })));
          cursor = listed.nextCursor;
        } while (cursor);
      } catch (err) {
        logger.error("Cancel - subagent background terminals terminate failed", err);
      }
    }));
  }
`
const cancelAnchor = `    await this.interruptSessionTurn(sessionState, "Cancel", false);
  }
};
`
const cancelChildren = `    await this.interruptSessionTurn(sessionState, "Cancel", false);
    // Cinna Desktop (scripts/patch-codex-acp.cjs): and every subagent thread under the session.
    await this.codexAcpClient.subagents.interruptChildren(params.sessionId);
  }
};
`
// Edit 5 as first reviewed: the turn interrupt and the terminal kill in one `try`. Kept to reverse it.
const sharedTryInterruptChildren = `  // Cinna Desktop (scripts/patch-codex-acp.cjs): a cancel stops the session's subagents too, at any depth.
  async interruptChildren(rootSessionId) {
    const children = [...(this.sessions.get(rootSessionId)?.children ?? [])];
    await Promise.all(children.map(async (threadId) => {
      try {
        const turn = (await this.client.threadTurnsList({ threadId, cursor: null, limit: 1, sortDirection: "desc", itemsView: "notLoaded" })).data[0];
        if (turn?.status === "inProgress") await this.client.turnInterrupt({ threadId, turnId: turn.id });
        let cursor = null;
        do {
          const listed = await this.client.threadBackgroundTerminalsList({ threadId, cursor });
          await Promise.all(listed.data.map((terminal) => this.client.threadBackgroundTerminalsTerminate({ threadId, processId: terminal.processId })));
          cursor = listed.nextCursor;
        } while (cursor);
      } catch (err) {
        logger.error("Cancel - subagent turnInterrupt failed", err);
      }
    }));
  }
`
const digest = (content) => createHash('sha256').update(content).digest('hex')

/**
 * Earlier reviewed patches of the same pinned adapter, by the digest of the
 * file they produced, each with the exact reversal of its replacements. An
 * existing checkout carrying one is restored to the original (verified by
 * digest) and patched again; anything else is still refused.
 */
const earlierPatches = {
  // Edits 1-4, before cancel stopped the subagents.
  ca1f79d5ea308f092753a24140ac182dac5af0c8f52e43132ca265f8fa5922fa: (content) => {
    if (content.split(instructions).length !== 4 || content.split(replacement).length !== 2 ||
      content.split(airClientOff).length !== 2 || content.split(commandEndWhole).length !== 2) return null
    return content.replaceAll(instructions, '').replace(replacement, () => original)
      .replace(airClientOff, () => airClientAnchor).replace(commandEndWhole, () => commandEndAnchor)
  },
  // Edits 1-5, when one failing step of a subagent's cancel skipped the kill of its background terminals.
  e37c968c758bad2e3b0e8c6d4762dd04824b941deca2a2d871b1e2a2854f63fd: (content) => {
    if (content.split(instructions).length !== 4 || content.split(replacement).length !== 2 || content.split(airClientOff).length !== 2 ||
      content.split(commandEndWhole).length !== 2 || content.split(sharedTryInterruptChildren).length !== 2 || content.split(cancelChildren).length !== 2) return null
    return content.replaceAll(instructions, '').replace(replacement, () => original)
      .replace(airClientOff, () => airClientAnchor).replace(commandEndWhole, () => commandEndAnchor)
      .replace(sharedTryInterruptChildren, () => '').replace(cancelChildren, () => cancelAnchor)
  }
}

function adapter(root) {
  const directory = join(root, 'node_modules/@agentclientprotocol/codex-acp')
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
  if (manifest.version !== policy.version) throw new Error('Codex ACP patch needs review for this adapter version')
  return join(directory, 'dist/index.js')
}

function verifyCodexAcpPatch(root) {
  if (digest(readFileSync(adapter(root))) !== policy.patchedSha256) {
    throw new Error('Codex ACP patch (MCP merge, session instructions, AIR client off, whole command output, subagent cancel) is missing or changed')
  }
}

function patchCodexAcp(root) {
  const path = adapter(root)
  let content = readFileSync(path, 'utf8')
  if (digest(content) === policy.patchedSha256) return
  const unpatch = earlierPatches[digest(content)]
  if (unpatch) {
    const restored = unpatch(content)
    if (restored === null || digest(restored) !== policy.originalSha256) {
      throw new Error('Codex ACP earlier patch could not be reversed to the reviewed pinned adapter; refusing to patch')
    }
    content = restored
  }
  if (digest(content) !== policy.originalSha256 || content.split(original).length !== 2) {
    throw new Error('Codex ACP source differs from the reviewed pinned adapter; refusing to patch')
  }
  let patched = content.replace(original, () => replacement)
  for (const [anchor, count] of instructionAnchors) {
    if (patched.split(anchor).length !== count + 1) throw new Error('Codex ACP session-instruction patch target changed')
    patched = patched.replaceAll(anchor, () => anchor + instructions)
  }
  if (patched.split(airClientAnchor).length !== 2) throw new Error('Codex ACP AIR-client patch target changed')
  patched = patched.replace(airClientAnchor, () => airClientOff)
  if (patched.split(commandEndAnchor).length !== 2) throw new Error('Codex ACP command-output patch target changed')
  patched = patched.replace(commandEndAnchor, () => commandEndWhole)
  if (patched.split(childrenAnchor).length !== 2 || patched.split(cancelAnchor).length !== 2) throw new Error('Codex ACP subagent-cancel patch target changed')
  patched = patched.replace(childrenAnchor, () => interruptChildren + childrenAnchor).replace(cancelAnchor, () => cancelChildren)
  if (digest(patched) !== policy.patchedSha256) throw new Error('Codex ACP patch output does not match reviewed content')
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, patched, { mode: 0o644 })
  renameSync(temporary, path)
  verifyCodexAcpPatch(root)
}

module.exports = {
  patchCodexAcp, verifyCodexAcpPatch, original, replacement, instructions, instructionAnchors, airClientAnchor, airClientOff, commandEndAnchor, commandEndWhole,
  childrenAnchor, interruptChildren, cancelAnchor, cancelChildren, sharedTryInterruptChildren
}
if (require.main === module) patchCodexAcp(resolve(__dirname, '..'))
