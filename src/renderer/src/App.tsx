import { useState } from 'react'
import { QueryClient, QueryCache, MutationCache, QueryClientProvider } from '@tanstack/react-query'
import { Sidebar } from './components/layout/Sidebar'
import { TopBar } from './components/layout/TopBar'
import { MainArea } from './components/layout/MainArea'
import { LoginScreen } from './components/auth/LoginScreen'
import { OnboardingScreen } from './components/auth/OnboardingScreen'
import { ReauthModal } from './components/auth/ReauthModal'
import { ConnectIntentModal } from './components/auth/ConnectIntentModal'
import { LocalDevConsentModal } from './components/localdev/LocalDevConsentModal'
import { SyncSetupModal } from './components/sync/SyncSetupModal'
import { LogsOverlay } from './components/logger/LogsOverlay'
import { AgentStatusOverlay } from './components/agents/AgentStatusOverlay'
import { FilePreviewModal } from './components/chat/FilePreviewModal'
import { useAuthStore } from './stores/auth.store'
import { flagReauthFromError } from './stores/reauth.store'
import { useProviders } from './hooks/useProviders'
import { useStartup } from './hooks/useAuth'
import { useConnectIntent } from './hooks/useConnectIntent'
import { useTrayIcon } from './hooks/useTrayIcon'
import { useLocalAgentWatch } from './hooks/useLocalAgents'
import { useEngineWatch } from './hooks/useEngine'
import { useSyncEvents, useSyncOnTabOpen } from './hooks/useSync'
import {
  consumeForceOnboarding,
  isOnboardingDismissed,
  markOnboardingDismissed
} from './constants/onboarding'

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
    }
  }
})

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
  // Drives the menu-bar tray icon (severity dot) and the popup's Start-Chat flow.
  useTrayIcon()
  // App-level sync wiring (Cinna profiles only). `useSyncEvents` keeps the
  // note/job caches fresh from peer changes no matter which screen is open;
  // `useSyncOnTabOpen` pings the server when the Notes/Jobs screen is opened.
  const isCinnaUser = useAuthStore((s) => s.currentUser?.type === 'cinna_user')
  useSyncEvents(isCinnaUser)
  useSyncOnTabOpen(isCinnaUser)
  // Folder agents are files on disk that other tools edit. Subscribing here,
  // once, means an assistant's change to a folder refreshes the Agents tab and
  // the open agent page wherever the user happens to be.
  useLocalAgentWatch()
  // The engine's slow transitions — a first-use download, a crash between two
  // turns — happen while nobody is watching a particular screen, so the
  // subscription is here rather than in the card that renders the state.
  useEngineWatch()
  // TopBar overlays the content (absolute, inset by `pt-2`/`px-2`) so the chat
  // area can claim full window height instead of losing the bar's height. The
  // sidebar card offsets its top via CSS so it still sits below the buttons.
  return (
    <div className="h-full flex flex-col min-h-0 p-2 relative">
      <div className="flex-1 flex min-h-0 gap-2">
        <Sidebar />
        <MainArea />
      </div>
      <TopBar />
    </div>
  )
}

function OnboardingGate({ children }: { children: React.ReactNode }): React.JSX.Element {
  const { data: providers, isLoading } = useProviders()
  // Consume the force-onboarding flag once per session (StrictMode-safe via
  // module-level memo in `constants/onboarding`).
  const [forced, setForced] = useState<boolean>(() => consumeForceOnboarding())
  const [dismissed, setDismissed] = useState<boolean>(() => !forced && isOnboardingDismissed())
  // Subscribed here rather than only in the modal so the gate can decide *which*
  // surface confirms a deep link. The store dedupes, so the modal reading the
  // same intent below costs nothing.
  const { intent, consume } = useConnectIntent()

  if (isLoading) return <div className="h-full bg-[var(--color-bg)]" />

  const hasProviders = (providers?.length ?? 0) > 0
  // Forced mode bypasses the dismissed flag AND the providers-count gate so
  // we can re-trigger onboarding on a fully configured install for testing.
  const onboarding = forced || !(dismissed || hasProviders)

  // A deep link on an install that is past first run gets a modal over the app
  // (rendered by `App`), not a resurrected onboarding screen — the user has an
  // account and a workspace they are looking at, and replacing it with a
  // first-run screen to answer one yes/no question would be a bigger
  // interruption than the question.
  if (!onboarding) return <>{children}</>

  return (
    <OnboardingScreen
      connectIntent={intent}
      onConnectIntentDone={consume}
      onComplete={() => {
        markOnboardingDismissed()
        setDismissed(true)
        setForced(false)
      }}
    />
  )
}

function App(): React.JSX.Element {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthGate>
        <OnboardingGate>
          <Shell />
          {/* Inside the gate on purpose: its children render only once first
              run is over, which is exactly when the modal — rather than the
              onboarding screen's own confirm step — is the right surface for a
              deep link. Outside it, both would show the same intent at once. */}
          <ConnectIntentModal />
          {/* Also inside the gate: during first run the same question is a
              step of the onboarding screen, and two surfaces asking it at once
              would be two answers racing to be recorded. */}
          <LocalDevConsentModal />
        </OnboardingGate>
        <LogsOverlay />
        <AgentStatusOverlay />
        <ReauthModal />
        <SyncSetupModal />
        <FilePreviewModal />
      </AuthGate>
    </QueryClientProvider>
  )
}

export default App
