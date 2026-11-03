/**
 * `build_brief_propose` on the `cinna` MCP server: a guided first build ends
 * with one call, which the transcript draws as the brief card (Start building,
 * Keep talking). Desktop-owned; the kit knows nothing of it.
 *
 * * **Offered per chat**: only to a folder agent's own session in a chat main
 *   marked guided (`chats.guided_build`), by `conductorBridge`'s providers.
 * * **Does nothing but validate.** The card is drawn from the persisted
 *   `tool_call` row's input; the turn is not parked, the result only tells
 *   the agent to stop and wait.
 *
 * Core: no Electron.
 */

import type { ToolDefinition } from '../../llm/types'
import type { ToolExecutionResult, ToolProvider } from '../../llm/toolProvider'
import {
  BUILD_BRIEF_INPUT_SCHEMA,
  BUILD_BRIEF_PROVIDER_NAME,
  BUILD_BRIEF_RESULT,
  BUILD_BRIEF_TOOL,
  parseBuildBrief
} from '../../../shared/buildBrief'

export const BUILD_BRIEF_TOOL_DESCRIPTION =
  'Show the person the build brief that ends a guided first build: one sentence on the job, the starting build prompt in their words, and which capabilities the answers call for. They see it as a card with Start building, which opens a new building chat with the prompt. Call it once, at the end of the interview, then stop and wait; call it again only with a revision they asked for. Never put a password, token or key in it.'

export class BuildBriefToolProvider implements ToolProvider {
  readonly providerType = 'mcp' as const
  readonly displayName = BUILD_BRIEF_PROVIDER_NAME

  /** Local, instant, no outside work: never counted against a task's tool-call budget. */
  budgetExempt(): boolean {
    return true
  }

  getTools(): ToolDefinition[] {
    return [
      {
        name: BUILD_BRIEF_TOOL,
        description: BUILD_BRIEF_TOOL_DESCRIPTION,
        inputSchema: BUILD_BRIEF_INPUT_SCHEMA as unknown as Record<string, unknown>,
        mcpProviderId: 'cinna-guided-build',
        providerType: 'mcp'
      }
    ]
  }

  async callTool(name: string, input: Record<string, unknown>): Promise<ToolExecutionResult> {
    if (name !== BUILD_BRIEF_TOOL) return { content: `Unknown tool: ${name}`, isError: true }
    const parsed = parseBuildBrief(input)
    if (!parsed.ok) return { content: `The brief was not shown: ${parsed.error} Fix it and call ${BUILD_BRIEF_TOOL} again.`, isError: true }
    return { content: BUILD_BRIEF_RESULT }
  }
}
