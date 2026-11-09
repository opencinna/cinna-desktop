import { useAmbientButtons } from './hooks/useAmbientButtons'
import { QueryClient, QueryCache, MutationCache, QueryClientProvider } from '@tanstack/react-query'
import { Sidebar } from './components/layout/Sidebar'
import { DesktopToast } from './components/ui/DesktopToast'
import { TopBar } from './components/layout/TopBar'
import { MainArea } from './components/layout/MainArea'
import { LoginScreen } from './components/auth/LoginScreen'
import { OnboardingGate } from './components/auth/OnboardingGate'
import { ReauthModal } from './components/auth/ReauthModal'
import { CatalogSetupHost } from './components/agents/CatalogSetupHost'
import { ConnectIntentModal } from './components/auth/ConnectIntentModal'
import { LocalDevConsentModal } from './components/localdev/LocalDevConsentModal'
import { AgentsHomeModal } from './components/agents/local/AgentsHomeModal'
import { SyncSetupModal } from './components/sync/SyncSetupModal'
import { LogsOverlay } from './components/logger/LogsOverlay'
import { AgentStatusOverlay } from './components/agents/AgentStatusOverlay'
import { AgentColorsProvider } from './components/agents/AgentColorsProvider'
import { FilePreviewModal } from './components/chat/FilePreviewModal'
import { TablePreviewModal } from './components/chat/TablePreviewModal'
import { ArtifactsHost } from './components/artifacts/ArtifactsHost'
import { RunScriptModal } from './components/chat/RunScriptModal'
import { useAuthStore } from './stores/auth.store'
import { useUIStore } from './stores/ui.store'
import { fetchSpeechStatus, SPEECH_STATUS_QUERY_KEY } from './components/chat/voice/useSpeechStatus'
import { fetchFinderQuickActionStatus, FINDER_QUICK_ACTION_QUERY_KEY } from './hooks/useFinderQuickAction'
import { flagReauthFromError } from './stores/reauth.store'
import { useStartup } from './hooks/useAuth'
import { useTrayIcon } from './hooks/useTrayIcon'
import { useNotificationOpenChat } from './hooks/useNotificationOpenChat'
import { useLocalAgentWatch } from './hooks/useLocalAgents'
import { useDashboardsWatch } from './hooks/useDashboards'
import { useAppSettingsWatch } from './hooks/useAppSettings'
import { useSharingWatch } from './hooks/useSharing'
import { useCatalogItemsWatch } from './hooks/useCatalog'
import { useSkillCredentialsWatch } from './hooks/useServiceCredentials'
import { useEngineWatch } from './hooks/useEngine'
import { useRuntimeSetupWatch } from './hooks/useRuntimeSetup'
import { useAppShortcuts } from './hooks/useAppShortcuts'
import { usePathMentions } from './hooks/usePathMentions'
import { useSkillLinkIntents } from './hooks/useSkillLinkIntents'
import { useChatSearchShortcut } from './components/chat/search/useChatSearchShortcut'
import { AllChatsSearch } from './components/chat/search/AllChatsSearch'
import { useSyncEvents, useSyncOnViewOpen } from './hooks/useSync'

// Any Cinna-backed query/mutation that fails with a reauth-required code
// raises the global ReauthModal — one prompt for all surfaces (catalog,
// agent status, remote sync). Inline banners still work independently.
const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error) => flagReauthFromError(error)
  }),
  mutationCache: new MutationCache({
    onError: (error) => flagReauthFromError(error)
  }),
  defaultOptions: {
    queries: {
      staleTime: 5000,
      refetchOnWindowFocus: false
    },
    // Every mutation is an IPC call to main, which does its own networking.
    // TanStack's default `online` mode pauses a mutation before it runs while
    // the browser reports offline — a local folder create then shows
    // "Creating…" until the Wi-Fi comes back.
    mutations: {
      networkMode: 'always'
    }
  }
})

// Main's speech probe, asked once at start: the composer's mic button and the
// Features row would otherwise appear a beat after their surface (ux_rules §1).
void queryClient.prefetchQuery({ queryKey: SPEECH_STATUS_QUERY_KEY, queryFn: fetchSpeechStatus })
// The same for Features → OS Integration, which exists only on macOS.
void queryClient.prefetchQuery({ queryKey: FINDER_QUICK_ACTION_QUERY_KEY, queryFn: fetchFinderQuickActionStatus })

function AuthGate({ children }: { children: React.ReactNode }): React.JSX.Element {
  const needsPassword = useAuthStore((s) => s.needsPassword)
  // `useStartup` owns the IPC call and syncs the auth store before reporting
  // `ready`, so no intermediate render can see a half-applied session.
  const { state, retry } = useStartup()

  // Don't render anything until startup state is resolved
  if (state.status === 'pending') return <div className="h-full bg-[var(--color-bg)]" />

  // Startup failed — without this the app would sit on a blank window forever.
  if (state.status === 'error') {
    return <StartupError message={state.message} onRetry={retry} />
  }

  if (needsPassword) {
    return <LoginScreen />
  }

  return <>{children}</>
}

function StartupError({
  message,
  onRetry
}: {
  message: string
  onRetry: () => void
}): React.JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 bg-[var(--color-bg)] p-8">
      <div className="text-base font-medium text-[var(--color-text)]">Startup failed</div>
      <div className="max-w-md text-center text-sm text-[var(--color-text-muted)]">{message}</div>
      <button
        onClick={onRetry}
        className="rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm text-[var(--color-on-accent)] hover:bg-[var(--color-accent-hover)]"
      >
        Retry
      </button>
    </div>
  )
}

function Shell(): React.JSX.Element {
  useAmbientButtons()
  // Drives the menu-bar tray icon (severity dot) and the popup's Start-Chat flow.
  useTrayIcon()
  // A click on an OS notification for a stopped turn opens that chat.
  useNotificationOpenChat()
  // App-level sync wiring (Cinna profiles only). `useSyncEvents` keeps the
  // note/job caches fresh from peer changes no matter which screen is open;
  // `useSyncOnViewOpen` pings the server when a screen whose contents sync is
  // opened — Notes, Jobs, or a task page.
  const isCinnaUser = useAuthStore((s) => s.currentUser?.type === 'cinna_user')
  useSyncEvents(isCinnaUser)
  useSyncOnViewOpen(isCinnaUser)
  // Folder agents are files on disk that other tools edit. Subscribing here,
  // once, means an assistant's change to a folder refreshes the Agents tab and
  // the open agent page wherever the user happens to be.
  useLocalAgentWatch()
  // Tile data that main recomputed, and components that changed with their agent's folder.
  useDashboardsWatch()
  // App settings saved by someone other than this window (Notes and Dashboards
  // gate whole surfaces on two of them).
  useAppSettingsWatch()
  // A shared agent's state and the Team library move on main's schedule (a
  // teammate shares, a fetch lands); one subscription refreshes every surface.
  useSharingWatch()
  // Catalog items that are not team sharing's (a cloud install, a skill's
  // version) move on the same schedule, under a lighter event.
  useCatalogItemsWatch()
  // Skill slots main fills in the background after a catalog skill is added or updated.
  useSkillCredentialsWatch()
  // The engine's slow transitions — a first-use download, a crash between two
  // turns — happen while nobody is watching a particular screen, so the
  // subscription is here rather than in the card that renders the state.
  useEngineWatch()
  // A runtime setup (install, sign-in) runs in main and outlives the card that
  // started it; its end re-reads the login and the agent list from here.
  useRuntimeSetupWatch()
  // ⌘N, ⇧⌘N and ⌘1–⌘9 from the application menu. Here, and not beside the
  // LogsOverlay, so the keys start nothing on the login or onboarding screens.
  useAppShortcuts()
  // Files and folders sent from Finder ("Mention in Cinna") land in the new-chat
  // composer as reference chips. Here for the same reason as the shortcuts:
  // main holds them through login and onboarding, and this takes them after.
  usePathMentions()
  // A `cinna://skill/…` link (a skill page's Open in Cinna Desktop) raises the
  // skill offer on the composer on screen. Here for the same reason: main
  // holds the link through login and onboarding, and this takes it after.
  useSkillLinkIntents()
  // ⌘F: this chat's search, or all chats when none is on screen. Here with the
  // other shortcuts, so it does nothing on the login or onboarding screens.
  useChatSearchShortcut()
  // TopBar overlays the content (absolute, inset by `pt-2`/`px-2`) so the chat
  // area can claim full window height instead of losing the bar's height. The
  // sidebar card offsets its top via CSS so it still sits below the buttons.
  // Minimal view's surfaces (main.css) key off these: `data-minimal` drives
  // them, and with Extra UI animation off they fade without sliding.
  const minimalView = useUIStore((s) => s.minimalView)
  const extraUIAnimation = useUIStore((s) => s.extraUIAnimation)
  return (
    <div
      className="h-full flex flex-col min-h-0 p-2 relative"
      data-minimal={minimalView || undefined}
      data-motion-fade={!extraUIAnimation || undefined}
    >
      <div className="flex-1 flex min-h-0 gap-2">
        <Sidebar />
        <MainArea />
      </div>
      <TopBar />
      <AllChatsSearch />
      <DesktopToast />
    </div>
  )
}

function App(): React.JSX.Element {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthGate>
        <AgentColorsProvider>
        <OnboardingGate>
          <Shell />
          {/* Inside the gate on purpose: its children render only once first
              run is over, which is exactly when the modal — rather than the
              onboarding screen's own confirm step — is the right surface for a
              deep link. Outside it, both would show the same intent at once. */}
          <ConnectIntentModal />
          {/* Opened only from the sidebar's development button, which lives
              in the shell — so it belongs inside the gate with it. */}
          <LocalDevConsentModal />
          {/* Inside the gate for the same reason as its neighbours, and for one
              of its own: during first run nothing has asked for an agent yet,
              and explaining the agents folder to someone who is still choosing
              a provider is the interruption this modal was built to remove. */}
          <AgentsHomeModal />
        </OnboardingGate>
        <LogsOverlay />
        <AgentStatusOverlay />
        <ReauthModal />
        <CatalogSetupHost />
        <SyncSetupModal />
        <FilePreviewModal />
        <TablePreviewModal />
        <ArtifactsHost />
        <RunScriptModal />
        </AgentColorsProvider>
      </AuthGate>
    </QueryClientProvider>
  )
}

export default App
