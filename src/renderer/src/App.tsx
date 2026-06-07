import { useState, useEffect } from 'react'
import { QueryClient, QueryCache, MutationCache, QueryClientProvider } from '@tanstack/react-query'
import { Sidebar } from './components/layout/Sidebar'
import { TopBar } from './components/layout/TopBar'
import { MainArea } from './components/layout/MainArea'
import { LoginScreen } from './components/auth/LoginScreen'
import { OnboardingScreen } from './components/auth/OnboardingScreen'
import { ReauthModal } from './components/auth/ReauthModal'
import { SyncSetupModal } from './components/sync/SyncSetupModal'
import { LogsOverlay } from './components/logger/LogsOverlay'
import { AgentStatusOverlay } from './components/agents/AgentStatusOverlay'
import { FilePreviewModal } from './components/chat/FilePreviewModal'
import { useAuthStore } from './stores/auth.store'
import { flagReauthFromError } from './stores/reauth.store'
import { useProviders } from './hooks/useProviders'
import { useTrayIcon } from './hooks/useTrayIcon'
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
  const setCurrentUser = useAuthStore((s) => s.setCurrentUser)
  const setNeedsPassword = useAuthStore((s) => s.setNeedsPassword)
  const setPendingUserId = useAuthStore((s) => s.setPendingUserId)
  const [ready, setReady] = useState(false)

  // On mount, ask main process for startup auth state
  useEffect(() => {
    window.api.auth.getStartup().then((startup) => {
      if (startup.needsLogin && startup.pendingUser) {
        // Last user has a password — show login screen
        setPendingUserId(startup.pendingUser.id)
        setNeedsPassword(true)
      } else if (startup.user) {
        // Default or passwordless user — activate immediately
        setCurrentUser({
          id: startup.user.id,
          type: startup.user.type,
          username: startup.user.username,
          displayName: startup.user.displayName,
          hasPassword: startup.user.hasPassword
        })
      }
      setReady(true)
    })
  }, [setCurrentUser, setNeedsPassword, setPendingUserId])

  // Don't render anything until startup state is resolved
  if (!ready) return <div className="h-full bg-[var(--color-bg)]" />

  if (needsPassword) {
    return <LoginScreen />
  }

  return <>{children}</>
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

  if (isLoading) return <div className="h-full bg-[var(--color-bg)]" />

  const hasProviders = (providers?.length ?? 0) > 0
  // Forced mode bypasses the dismissed flag AND the providers-count gate so
  // we can re-trigger onboarding on a fully configured install for testing.
  if (!forced && (dismissed || hasProviders)) return <>{children}</>

  return (
    <OnboardingScreen
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
