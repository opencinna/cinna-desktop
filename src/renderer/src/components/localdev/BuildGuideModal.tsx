import { memo, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { BookOpen, FileText, X } from 'lucide-react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { DevelopmentContext } from '../../../../shared/developmentSession'
import { documentMarkdownComponents, remarkStripHtml } from '../../utils/markdownComponents'
import { useDialogChrome } from '../settings/SettingsLayout'

const GETTING_STARTED = `# Build an agent with Cinna

## Describe the outcome
Tell your assistant what the agent should do, who it helps, and which tools or data it needs. Start with an idea or ask it to explore the agents already available on your Cinna instance.

## Build together
Your local assistant uses cinna-cli and the account workspace to create, sync, and update agents. Ask questions and refine the result in the chat.

## Test and verify
Ask the assistant to test your agent and check its latest status on Cinna Core. It can inspect remote status through cinna-cli as you work.

## Context for your assistant
The session instructions and workspace Markdown documents listed here are included with the build session. The assistant can read more documentation from the workspace when needed.
`

const GuideContent = memo(function GuideContent({ content }: { content: string }): React.JSX.Element {
  return <Markdown remarkPlugins={[remarkGfm, remarkStripHtml]} components={documentMarkdownComponents}>{content}</Markdown>
})

export function BuildGuideModal({ data, onClose }: { data?: DevelopmentContext; onClose: () => void }): React.JSX.Element {
  const modal = useRef<HTMLDivElement>(null)
  const close = useRef<HTMLButtonElement>(null)
  const body = useRef<HTMLElement>(null)
  const [selected, setSelected] = useState('getting-started')
  useDialogChrome({ modalRef: modal, initialFocusRef: close, pending: false, onDismiss: onClose })
  const documents = useMemo(() => [
    { path: 'getting-started', title: 'Getting started', content: GETTING_STARTED },
    ...(data ? [
      { path: 'session-instructions', title: 'Session instructions', content: data.instructions.split('\n--- ')[0] },
      ...data.documents.map((doc) => ({ ...doc, title: doc.path }))
    ] : [])
  ], [data])
  const current = documents.find((doc) => doc.path === selected) ?? documents[0]
  return createPortal(
    <div className="fixed inset-0 z-50 flex bg-[var(--color-overlay-backdrop)] p-[5vmin] backdrop-blur-sm" onClick={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div ref={modal} role="dialog" aria-modal="true" aria-labelledby="build-guide-title" className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-overlay-panel)] shadow-2xl">
        <header className="flex items-center gap-2 border-b border-[var(--color-border)] px-5 py-4">
          <BookOpen size={16} className="text-[var(--color-accent)]" />
          <h2 id="build-guide-title" className="flex-1 text-sm font-semibold text-[var(--color-text)]">Build guide</h2>
          <button ref={close} type="button" onClick={onClose} aria-label="Close build guide" className="rounded-md p-1.5 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)]"><X size={16} /></button>
        </header>
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(120px,22%)_minmax(0,1fr)]">
          <nav aria-label="Table of contents" className="overflow-y-auto border-r border-[var(--color-border)] p-3">
            <div className="mb-3 px-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Contents</div>
            {documents.map((doc) => <button key={doc.path} type="button" aria-current={current.path === doc.path ? 'page' : undefined} onClick={() => { setSelected(doc.path); if (body.current) body.current.scrollTop = 0 }} className={`mb-1 flex w-full items-start gap-2 rounded-md px-2 py-2 text-left text-xs [overflow-wrap:anywhere] ${current.path === doc.path ? 'bg-[var(--color-accent)]/10 font-medium text-[var(--color-accent)]' : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]'}`}><FileText size={13} className="mt-0.5 shrink-0" />{doc.title}</button>)}
            {!data && <p className="px-2 py-3 text-xs text-[var(--color-text-muted)]">Workspace guides appear after setup.</p>}
          </nav>
          <main ref={body} aria-label={current.title} tabIndex={0} className="min-w-0 overflow-auto px-6 py-6 sm:px-10">
            <div className="markdown-body mx-auto max-w-3xl break-words text-[13px] leading-relaxed text-[var(--color-text)]"><GuideContent content={current.content} /></div>
          </main>
        </div>
      </div>
    </div>, document.body
  )
}
