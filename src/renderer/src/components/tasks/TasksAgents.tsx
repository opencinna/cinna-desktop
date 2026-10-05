import { useEffect, useState } from 'react'
import type { AgentData } from '../../../../preload'
import { useOpenAgentPage } from '../../hooks/useOpenAgentPage'
import { taskStatusCategory, type TaskStatus, type TaskStatusCategory } from '../../../../shared/taskStatus'
import { AgentTypeIcon } from '../agents/AgentTypeIcon'
import { AnimatedCollapse } from '../ui/AnimatedCollapse'
import { TaskRow } from './TaskRow'
import { TaskStatusIcon } from './TaskStatusIcon'
import { useTaskRowsInPlace } from './useTaskRowsInPlace'
import type { TaskAgentCard } from './tasksViewModel'

/** How many rows a card shows until Show more. */
const CARD_PAGE = 6

/** The open categories a card header counts, in the list's order; Backlog and Done are not counted. */
const COUNTED: readonly { category: TaskStatusCategory; status: TaskStatus; word: string }[] = [
  { category: 'waiting', status: 'blocked', word: 'waiting' },
  { category: 'active', status: 'in_progress', word: 'in progress' },
  { category: 'ready', status: 'open', word: 'ready' }
]

/**
 * The Tasks view's **Agents** layout, its default: the team first, the work
 * inside it. One card per agent with a task to show (`agentCards` decides
 * which, in what order), on a plain frosted-glass surface (`.app-glass-card`):
 * the agent's colour is its icon's, as everywhere else, not the card's. Its
 * tasks are the rows every task list uses (`ux_rules.md` §13), and its name
 * opens the agent's page.
 *
 * A card's rows hold the order first seen (`useTaskRowsInPlace`), so a poll
 * grows a card at its foot and moves no row inside it. The grid itself does
 * reflow: a card that grows lowers the cards under it, as a list section does
 * the sections under it, and a card comes and goes with its agent's tasks. The caller remounts this (a `key`) when a filter changes what was
 * seen.
 */
export function TasksAgents({ cards, agents }: {
  cards: readonly TaskAgentCard[]
  /** The agents list, read once by the view rather than once per card. */
  agents: readonly AgentData[] | undefined
}): React.JSX.Element {
  return (
    <div className="@container">
      <ul className="m-0 grid list-none grid-cols-1 items-start gap-3 p-0 @2xl:grid-cols-2 @6xl:grid-cols-3">
        {cards.map((card) => (
          <li key={card.key}>
            <TasksAgentCard card={card} agent={card.agentId ? agents?.find((entry) => entry.id === card.agentId) : undefined} />
          </li>
        ))}
      </ul>
    </div>
  )
}

function TasksAgentCard({ card, agent }: {
  card: TaskAgentCard
  agent: AgentData | undefined
}): React.JSX.Element {
  const openAgentPage = useOpenAgentPage()
  // The first-seen order only; the card pages itself (Show more / Show less), not as the lists do.
  const { ordered } = useTaskRowsInPlace(card.tasks, CARD_PAGE)
  const [open, setOpen] = useState(false)
  // Open only while there is a second page: a card that fell to six rows and
  // later gains a seventh starts folded again, with Show more, not Show less.
  const expanded = open && ordered.length > CARD_PAGE
  useEffect(() => { if (open && ordered.length <= CARD_PAGE) setOpen(false) }, [open, ordered.length])
  const counts = COUNTED
    .map(({ category, status, word }) => ({ status, word, n: ordered.filter((task) => taskStatusCategory(task.status) === category).length }))
    .filter(({ n }) => n > 0)
  return (
    <section aria-label={card.name} className="app-glass-card overflow-hidden rounded-lg border">
      <header className="flex items-center gap-2 px-3 pb-1.5 pt-2.5">
        {agent && <AgentTypeIcon agent={agent} agentId={agent.id} size={14} />}
        <h2 className="flex min-w-0 flex-1 text-[14px] font-medium text-[var(--color-text)]">
          {agent ? (
            // Underlined, not only on hover: the name is a way to the agent's page (§11).
            <button type="button" onClick={() => openAgentPage(agent)} title={`Open ${card.name}`}
              className="min-w-0 truncate text-left underline decoration-[var(--color-border)] underline-offset-4 transition-colors hover:decoration-[var(--color-text-muted)]">
              {card.name}
            </button>
          ) : (
            <span className="truncate" title={card.name}>{card.name}</span>
          )}
        </h2>
        {/*
          Open work as the rows' own glyphs and a count, the sentence in the
          tooltip and the accessible name (§13); else the total.
        */}
        {counts.length > 0 ? (
          <span className="flex shrink-0 items-center gap-2" role="img"
            aria-label={counts.map(({ word, n }) => `${n} ${word}`).join(', ')}
            title={counts.map(({ word, n }) => `${n} ${word}`).join(', ')}>
            {counts.map(({ status, n }) => (
              <span key={status} className="flex items-center gap-1 text-[11px] tabular-nums text-[var(--color-text-muted)]">
                <TaskStatusIcon status={status} size={12} />
                {n}
              </span>
            ))}
          </span>
        ) : (
          // The total as a bare number in a badge; the words stay in its name and tooltip.
          <span role="img" aria-label={`${ordered.length} ${ordered.length === 1 ? 'task' : 'tasks'}`}
            title={`${ordered.length} ${ordered.length === 1 ? 'task' : 'tasks'}`}
            className="inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full bg-[var(--color-bg-hover)] px-1.5 text-[11px] tabular-nums text-[var(--color-text-muted)]">
            {ordered.length}
          </span>
        )}
      </header>
      <div className="px-1 pb-2">
        <ul className="m-0 list-none p-0">
          {ordered.slice(0, CARD_PAGE).map((task) => (
            <li key={task.id}>
              <TaskRow task={task} />
            </li>
          ))}
        </ul>
        {/* The rest slides open below the first page, flush with it: one list to the eye. */}
        <AnimatedCollapse open={expanded}>
          <ul className="m-0 list-none p-0">
            {ordered.slice(CARD_PAGE).map((task) => (
              <li key={task.id}>
                <TaskRow task={task} />
              </li>
            ))}
          </ul>
        </AnimatedCollapse>
        {/*
          One unbroken list: Show more opens the rest in place, animated, and
          becomes Show less at its foot. Centred and quiet — secondary text, not the
          accent, so it does not outshout the rows, and not the muted grey of
          their times (§11).
        */}
        {ordered.length > CARD_PAGE && (
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setOpen(!expanded)}
            className="mx-auto mt-0.5 block rounded px-2 text-[12px] text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)]"
          >
            {expanded ? 'Show less' : 'Show more tasks'}
          </button>
        )}
      </div>
    </section>
  )
}
