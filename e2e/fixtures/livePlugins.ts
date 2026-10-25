import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import type { Locator } from '@playwright/test'
import { test, expect, type CinnaApp } from './app'
import { addAgentRoot, createFolderAgent } from './seed'
import { LIVE_ENGINE, seedLiveModel, useLiveRuntime } from './liveEngine'
import { coreApi, linkLiveCinnaProfile, liveCoreSession } from './liveCinnaLink'
import type { LiveCinnaConfig } from './liveCinna'

/**
 * Shared by the live marketplace-plugin specs (`live-marketplace-plugins`,
 * `live-plugin-commands-hooks`): core's addon directory, one kit agent on
 * the run's engine linked to the real core, its Addons tab and picker, and
 * one turn read back from the chat's rows.
 */

export const AGENT = 'Doc Desk'

export const ENGINE_ORDER = ['claude', 'opencode', 'codex', 'antigravity'] as const
export const ENGINE_LABEL: Record<(typeof ENGINE_ORDER)[number], string> = { claude: 'Claude', opencode: 'OpenCode', codex: 'Codex', antigravity: 'Antigravity' }

export interface DirectoryEntry {
  ref: { source: string; id: string }
  kind: 'skill' | 'plugin' | 'mcp'
  name: string
  title: string
  digest: string | null
  status: string
  install: { mcp?: { transport: string; url?: string | null; auth: string } } | null
}

export async function coreDirectory(config: LiveCinnaConfig, token: string): Promise<DirectoryEntry[]> {
  const listed = await coreApi(config, token, '/addons/directory')
  expect(listed.status, 'core serves /addons/directory').toBe(200)
  return listed.body.data as DirectoryEntry[]
}

export interface Turn {
  /** The chat still has a run going (`activeRunId`). */
  running: boolean
  reply: string
  errors: string[]
  tools: Array<{ toolId?: string; toolName?: string; toolInput?: unknown; text: string }>
  results: Array<{ toolId?: string; toolStream?: string; text: string }>
  /** The MCP calls Cinna's `cinna` server relayed in this turn (`tool_call` rows, `conductorBridge.ts`). */
  bridged: Array<{ toolName: string | null; toolProvider: string | null; toolError: unknown; content: string }>
}

export async function turnOf(cinna: CinnaApp, prompt: string): Promise<Turn | null> {
  return cinna.page.evaluate(async (first) => {
    for (const row of await window.api.chat.list()) {
      const chat = await window.api.chat.get(row.id)
      if (chat?.messages.find((message) => message.role === 'user')?.content !== first) continue
      const assistant = chat.messages.filter((message) => message.role === 'assistant')
      const parts = assistant.flatMap((message) => message.parts ?? [])
      return {
        running: !!chat.activeRunId,
        reply: assistant.map((message) => message.content).join('\n'),
        errors: chat.messages.filter((message) => message.role === 'error').map((message) => message.content.slice(0, 500)),
        tools: parts.filter((part) => part.kind === 'tool')
          .map((part) => ({ toolId: part.toolId, toolName: part.toolName, toolInput: part.toolInput, text: part.text })),
        results: parts.filter((part) => part.kind === 'tool_result')
          .map((part) => ({ toolId: part.toolId, toolStream: part.toolStream, text: part.text })),
        bridged: chat.messages.filter((message) => message.role === 'tool_call').map((message) => {
          const row = message as unknown as { toolName?: string | null; toolProvider?: string | null; toolError?: unknown }
          return { toolName: row.toolName ?? null, toolProvider: row.toolProvider ?? null, toolError: row.toolError ?? null, content: message.content.slice(0, 1000) }
        })
      }
    }
    return null
  }, prompt)
}

/** A tool call and its paired results, as one string. */
export function toolText(turn: Turn, tool: Turn['tools'][number]): string {
  const results = turn.results.filter((result) => tool.toolId !== undefined && result.toolId === tool.toolId)
  return [JSON.stringify(tool), ...results.map((result) => result.text)].join('\n')
}

export function manifestOf(agentPath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(agentPath, 'cinna-agent.json'), 'utf8')) as Record<string, unknown>
}

/** Every file under `root` whose path ends in `suffix`. */
export function findFiles(root: string, suffix: string): string[] {
  if (!existsSync(root)) return []
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (path.endsWith(suffix)) found.push(path)
    }
  }
  walk(root)
  return found
}

/** A kit agent on this run's engine, on a profile linked to the real core, visible to every picker. */
export async function arrangeAgent(cinna: CinnaApp, config: LiveCinnaConfig, token: string): Promise<{ id: string; path: string }> {
  await cinna.skipOnboarding()
  const model = await seedLiveModel(cinna)
  console.log(`live-marketplace-plugins model: ${model}`)
  test.info().annotations.push({ type: 'model', description: model })
  await cinna.page.evaluate(() => window.api.settings.set('autoChatTitles', false))
  const root = await addAgentRoot(cinna)
  const created = await createFolderAgent(cinna, root, AGENT, 'Answers questions about documents and templates.')
  await useLiveRuntime(cinna, created.id)
  await linkLiveCinnaProfile(cinna, config, token)
  await cinna.relaunch()
  await cinna.skipOnboarding()
  await cinna.page.evaluate(() => window.api.localAgents.rescan())
  expect((await cinna.page.evaluate(() => window.api.auth.getCurrent()))?.type).toBe('cinna_user')
  return created
}

/** Agents → the agent → Settings → Addons, and its Addons section. */
export async function openAddons(cinna: CinnaApp): Promise<Locator> {
  const page = cinna.page
  await page.getByRole('button', { name: 'Agents', exact: true }).click()
  await page.getByRole('button', { name: AGENT, exact: true }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(AGENT)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('tablist', { name: 'Agent details' }).getByRole('tab', { name: /^Addons/ }).click()
  return page
    .getByRole('tabpanel')
    .locator('section')
    .filter({ has: page.getByRole('heading', { level: 2, name: 'Addons', exact: true }) })
}

export function picker(cinna: CinnaApp): { dialog: Locator; tile: (name: string) => Locator; detail: Locator; search: Locator } {
  const dialog = cinna.page.getByRole('dialog', { name: `Addons for ${AGENT}`, exact: true })
  const list = dialog.locator('[data-addon-list] [data-addon-results]')
  return {
    dialog,
    tile: (name) => list.getByRole('button', { name, exact: true }),
    detail: dialog.locator('[data-addon-detail]'),
    search: dialog.getByRole('textbox', { name: 'Search addons', exact: true })
  }
}

/** Opens the picker, searches `query`, opens `title`'s tile; the tile's kind is checked. */
export async function openTile(cinna: CinnaApp, section: Locator, query: string, title: string, kind: string): Promise<void> {
  const { dialog, tile, search } = picker(cinna)
  await section.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(dialog).toBeVisible()
  await search.fill(query)
  await expect(tile(title)).toBeVisible({ timeout: 30_000 })
  await expect(tile(title).locator('[data-addon-kind]')).toHaveText(kind)
  await tile(title).click()
}

export interface AskOptions {
  /**
   * Answer `Allow once` to an ask whose text this accepts (at most four); any
   * other ask ends the wait as a failure. Antigravity's command asks in the
   * agent's own folder are always answered.
   */
  allow?: (askText: string) => boolean
  /** When the turn counts as settled once its run ended; default: the reply is not empty. */
  settled?: (turn: Turn) => boolean
}

/** The agent's composer, a new chat, the prompt sent; then the turn to its end. */
export async function askAgent(cinna: CinnaApp, agentPath: string, prompt: string, options: AskOptions = {}): Promise<{ turn: Turn; asks: string[] }> {
  const page = cinna.page
  await page.getByRole('button', { name: 'Agents', exact: true }).click()
  await page.getByRole('button', { name: AGENT, exact: true }).click()
  await page.getByRole('button', { name: `Start a new chat with ${AGENT}` }).click()
  const input = page.getByRole('combobox', { name: 'Type a message...', exact: true })
  await input.fill(prompt)
  await input.press('Enter')
  await expect(page.getByRole('combobox', { name: 'Send a follow-up · Esc Esc to stop', exact: true })).toBeVisible({ timeout: 30_000 })

  let turn: Turn | null = null
  const asks: string[] = []
  // Antigravity asks before every command (its default approval); answer only commands run in the agent's own folder.
  const askable = LIVE_ENGINE.name === 'antigravity'
  const ask = page.locator('div').filter({ has: page.getByText(/^The agent is asking to /) }).filter({ has: page.getByRole('button', { name: 'Allow once', exact: true }) }).last()
  let outcome = 'running'
  await expect.poll(async () => {
    if ((await ask.count()) > 0) {
      const text = await ask.innerText()
      const cwd = /"cwd":"([^"]*)"/.exec(text)?.[1] ?? ''
      const inAgent = /^The agent is asking to run a command/.test(text) && [agentPath, realpathSync(agentPath)].includes(cwd)
      const allowed = (askable && inAgent) || (options.allow?.(text) ?? false)
      if (!allowed || asks.length >= 4) return (outcome = `ask: ${text.slice(0, 500)}`)
      asks.push(text.slice(0, 500))
      await ask.getByRole('button', { name: 'Allow once', exact: true }).click()
      return (outcome = 'answered an ask')
    }
    turn = await turnOf(cinna, prompt)
    if (turn && turn.errors.length > 0) return (outcome = `error: ${turn.errors[0]}`)
    const settled = options.settled ?? ((t: Turn) => t.reply.trim() !== '')
    return (outcome = turn !== null && !turn.running && settled(turn) ? 'done' : 'running')
  }, { message: 'the turn ends, or stops on an ask or an error', timeout: 4 * 60_000, intervals: [1000] }).toMatch(/^(done|ask: |error: )/)
  expect(outcome).toBe('done')
  const settled = turn as unknown as Turn
  const summary = JSON.stringify(settled.tools.map((tool) => ({ name: tool.toolName, input: tool.toolInput, text: tool.text.slice(0, 200) }))).slice(0, 3000)
  console.log(`live-marketplace-plugins ${LIVE_ENGINE.label} tools: ${summary}`)
  console.log(`live-marketplace-plugins reply: ${JSON.stringify(settled.reply.slice(0, 300))}`)
  console.log(`live-marketplace-plugins asks: ${JSON.stringify(asks)}`)
  console.log(`live-marketplace-plugins bridged: ${JSON.stringify(settled.bridged).slice(0, 1500)}`)
  test.info().annotations.push({ type: 'tool calls', description: summary }, { type: 'reply', description: settled.reply.slice(0, 500) })
  if (!askable && !options.allow) expect(asks).toEqual([])
  return { turn: settled, asks }
}

export async function liveSession() {
  const session = await liveCoreSession()
  test.skip(!session.ok, session.ok ? '' : session.reason)
  if (!session.ok) throw new Error('unreachable')
  return session
}

