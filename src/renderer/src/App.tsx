import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { TitleBar } from './components/layout/TitleBar'
import { Sidebar } from './components/layout/Sidebar'
import { MainArea } from './components/layout/MainArea'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5000,
      refetchOnWindowFocus: false
    }
  }
})

function App(): React.JSX.Element {
  return (
    <QueryClientProvider client={queryClient}>
      <div className="h-full flex flex-col">
        <TitleBar />
        <div className="flex-1 flex overflow-hidden">
          <Sidebar />
          <MainArea />
        </div>
      </div>
    </QueryClientProvider>
  )
}

export default App
