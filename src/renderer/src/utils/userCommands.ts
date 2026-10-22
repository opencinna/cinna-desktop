import { useEffect, useState } from 'react'
import { useComposerAttachTargetStore } from '../stores/composerAttachTarget.store'
import { composerDraftKey } from '../stores/composerDraft.store'
import { useAuthStore } from '../stores/auth.store'
import { uploadComposerFiles } from './composerUpload'
import { unwrapIpcError } from './ipcError'

type AgentData = Awaited<ReturnType<typeof window.api.agents.list>>[number]

/**
 * Whether a message's agent may have its commands run here (D1): a local
 * agent with a folder on this computer — a folder agent, or the
 * local-development build session's workspace. Remote and cinna-core agents,
 * a chat runtime, a custom launcher and a websocket engine are not. Main
 * checks again at run time.
 */
export function agentRunsCommands(agent: AgentData | undefined | null): boolean {
  if (!agent || agent.driver !== 'acp' || agent.conductor || agent.acpTransport === 'websocket') return false
  // Only a folder agent's row carries a folder path.
  return !!agent.localPath || agent.development === true
}

/** The language of a fenced block's `code` (`language-bash` → `bash`), or null. */
export function fenceLanguage(code: Element | null): string | null {
  const match = code?.className.match(/(?:^|\s)language-([\w+-]+)/)
  return match ? match[1].toLowerCase() : null
}

/**
 * Add a run's output to the chat's composer as a text file: main writes the
 * formatted output, and the draft takes it the way it takes a dropped file
 * (same draft, same scope as the composer). Answers an error to show, or null.
 */
export async function addCommandOutputToComposer(chatId: string, itemId: string): Promise<string | null> {
  try {
    const file = await window.api.userCommands.outputFile(chatId, itemId)
    if (!file.ok) return file.reason
    const target = useComposerAttachTargetStore.getState().targets[chatId]
    const key = target?.draftKey ?? composerDraftKey(useAuthStore.getState().currentUser?.id, `chat:${chatId}`)
    await uploadComposerFiles({ key, chatId, scope: target?.scope ?? 'local', paths: [file.path] })
    return null
  } catch (error) {
    return unwrapIpcError(error, 'The output could not be added to the message.')
  }
}

let homeDir: string | null = null
let homeLoad: Promise<string | null> | null = null

/** Fetch the home folder once (the menu primes it when it offers a command). */
export function primeHomeDir(): Promise<string | null> {
  if (homeDir !== null) return Promise.resolve(homeDir)
  homeLoad ??= Promise.resolve()
    .then(() => window.api.userCommands.home())
    .then((home) => { homeDir = typeof home === 'string' && home !== '' ? home : null; return homeDir })
    .catch(() => { homeLoad = null; return null })
  return homeLoad
}

/** The home folder for {@link homeDisplayPath}; null until it is known. */
export function useHomeDir(): string | null {
  const [home, setHome] = useState(homeDir)
  useEffect(() => {
    if (home !== null) return
    let live = true
    void primeHomeDir().then((value) => { if (live && value !== null) setHome(value) })
    return () => { live = false }
  }, [home])
  return home
}

/** Tests only. */
export function resetHomeDirForTests(): void {
  homeDir = null
  homeLoad = null
}
