import { useState, useEffect } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Sidebar } from './components/layout/Sidebar'
import { TopBar } from './components/layout/TopBar'
import { MainArea } from './components/layout/MainArea'
import { LoginScreen } from './components/auth/LoginScreen'
import { LogsOverlay } from './components/logger/LogsOverlay'
import { AgentStatusOverlay } from './components/agents/AgentStatusOverlay'
import { useAuthStore } from './stores/auth.store'

const queryClient = new QueryClient({
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

function App(): React.JSX.Element {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthGate>
        <Shell />
        <LogsOverlay />
        <AgentStatusOverlay />
      </AuthGate>
    </QueryClientProvider>
  )
}

export default App
