import { useLiveRunWatch } from '../../hooks/useLiveRunWatch'
import { useUIStore } from '../../stores/ui.store'
import { ChatWorkspace } from './ChatWorkspace'
import { SettingsPage } from '../settings/SettingsPage'
import { JobDetail } from '../jobs/JobDetail'
import { JobEditPage } from '../jobs/JobEditPage'
import { CinnaTaskRunView } from '../jobs/CinnaTaskRunView'
import { NoteDetail } from '../notes/NoteDetail'
import { InboxView } from '../inbox/InboxView'
import { TaskView } from '../tasks/TaskView'
import { ExternalAgentPage } from '../agents/ExternalAgentPage'
import { LocalAgentPage } from '../agents/local/LocalAgentPage'

export function MainArea(): React.JSX.Element {
  const activeView = useUIStore((s) => s.activeView)
  useLiveRunWatch()
  switch (activeView) {
    case 'settings': return <SettingsPage />
    case 'inbox': return <InboxView />
    case 'task': return <TaskView />
    case 'job-detail': return <JobDetail />
    case 'job-edit': return <JobEditPage />
    case 'cinna-task-run': return <CinnaTaskRunView />
    case 'note-detail': return <NoteDetail />
    case 'external-agent': return <ExternalAgentPage />
    case 'local-agent': return <LocalAgentPage />
    default: return <ChatWorkspace />
  }
}
