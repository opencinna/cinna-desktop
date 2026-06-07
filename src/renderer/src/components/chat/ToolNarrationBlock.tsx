import { Wrench } from 'lucide-react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { markdownComponents } from '../../utils/markdownComponents'
import { useUIStore } from '../../stores/ui.store'
import { ToolCallSummary } from './ToolCallSummary'
import { ApplyPatchBlock } from './ApplyPatchBlock'
import { parsePatch } from '../../utils/applyPatch'
import { DisclosureBlock } from './DisclosureBlock'

interface ToolNarrationBlockProps {
  content: string
  toolName?: string
  toolInput?: Record<string, unknown>
  /**
   * Slash invocation from `cinna.command_invocation` when this tool part was
   * synthesized to wrap a `/run:*` execution. Drives narration-echo
   * suppression: the backend echoes the bare invocation as the text payload,
   * which is redundant once the parent CommandToolFrame already shows it.
   */
  commandInvocation?: string
  isStreaming?: boolean
  defaultExpanded?: boolean
  animate?: boolean
  animateDelay?: number
}

export function ToolNarrationBlock({
  content,
  toolName,
  toolInput,
  commandInvocation,
  isStreaming,
  defaultExpanded,
  animate,
  animateDelay
}: ToolNarrationBlockProps): React.JSX.Element {
  const verboseMode = useUIStore((s) => s.verboseMode)
  const hasStructured = !!(toolName && toolInput)

  // OpenCode / Codex `apply_patch` gets a dedicated git-diff view instead of
  // the generic key:value tool renderer. The single parse doubles as the guard:
  // null means it isn't a (valid) patch, so fall through to the default block.
  const patchFiles =
    toolName === 'apply_patch' && toolInput ? parsePatch(toolInput.patch_text) : null
  if (patchFiles) {
    return <ApplyPatchBlock files={patchFiles} animate={animate} animateDelay={animateDelay} />
  }
  // Compact mode hides structured args in the always-visible header; the
  // expanded body still shows full detail when the user clicks through.
  const showStructuredHeader = hasStructured && verboseMode
  // Backend echoes the bare slash-command invocation (e.g. "/run:foo") as the
  // tool's narration text when the call originates from a cinna-core command.
  // The parent CommandToolFrame already shows the invocation in its header, so
  // render it here would be pure noise — suppress when content is *only* a
  // slash slug. Marker-driven when present; regex fallback covers historic
  // messages persisted before the backend added the metadata. The fallback
  // requires the `/word:word` colon-separated shape so it matches `/run:foo`
  // but NOT generic paths like `/etc/hosts` or `/usr/local/bin` that an LLM
  // might legitimately narrate as a single line.
  const isSlashCommandEcho =
    !!content &&
    ((!!commandInvocation && content.trim() === commandInvocation) ||
      /^\s*\/[\w\-]+:[\w\-.]+\s*$/.test(content))
  const showContent = !!content && !isSlashCommandEcho

  return (
    <DisclosureBlock
      icon={<Wrench size={11} className="shrink-0" />}
      header={
        showStructuredHeader ? (
          <ToolCallSummary name={toolName!} input={toolInput} variant="inline" />
        ) : toolName ? (
          <>
            <span className="font-medium">Tool: </span>
            <span className="font-mono">{toolName}</span>
          </>
        ) : (
          <span className="font-medium">Tool</span>
        )
      }
      isStreaming={isStreaming}
      defaultExpanded={defaultExpanded}
      animate={animate}
      animateDelay={animateDelay}
    >
      <div
        className="px-3 pb-2.5 pt-0 text-[12.5px] leading-relaxed
          text-[var(--color-text-secondary)] markdown-body opacity-90 space-y-2"
      >
        {hasStructured && (
          <div className="rounded border border-[var(--color-border)]/60 bg-[var(--color-bg)] p-2">
            <ToolCallSummary name={toolName!} input={toolInput} variant="block" />
          </div>
        )}
        {/* Keep the model's narration text below the structured summary so
            the user can still read any surrounding prose. */}
        {showContent && (
          <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{content}</Markdown>
        )}
      </div>
    </DisclosureBlock>
  )
}
