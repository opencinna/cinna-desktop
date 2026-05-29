import './assets/main.css'

import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useAuthStore } from './stores/auth.store'
import { TrayPanel } from './components/tray/TrayPanel'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5000,
      refetchOnWindowFocus: true
    }
  }
})

// The menu bar follows the OS appearance, but the panel surface itself should
// match the app's theme — read it from the shared localStorage key (same origin
// as the main window) and stay in sync via the cross-window `storage` event.
function applyTheme(): void {
  const theme = localStorage.getItem('cinna-theme') === 'light' ? 'light' : 'dark'
  document.documentElement.setAttribute('data-theme', theme)
}

function TrayRoot(): React.JSX.Element {
  const setCurrentUser = useAuthStore((s) => s.setCurrentUser)
  const [ready, setReady] = useState(false)

  // This window has its own store instance, and it's created (hidden) at startup
  // before the user is activated — so a one-shot fetch on mount would miss the
  // login. Re-hydrate the active user every time the popup is shown (window
  // focus); the agent-status query's `refetchOnWindowFocus` then fills the data.
  useEffect(() => {
    const hydrate = (): void => {
      window.api.auth.getCurrent().then((user) => {
        setCurrentUser(
          user
            ? {
                id: user.id,
                type: user.type,
                username: user.username,
                displayName: user.displayName,
                hasPassword: user.hasPassword,
                cinnaServerUrl: user.cinnaServerUrl,
                hasCinnaTokens: user.hasCinnaTokens
              }
            : null
        )
        setReady(true)
      })
    }
    hydrate()
    window.addEventListener('focus', hydrate)
    return () => window.removeEventListener('focus', hydrate)
  }, [setCurrentUser])

  if (!ready) return <div className="h-full w-full" />
  return <TrayPanel />
}

applyTheme()
window.addEventListener('storage', (e) => {
  if (e.key === 'cinna-theme') applyTheme()
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <TrayRoot />
    </QueryClientProvider>
  </StrictMode>
)
