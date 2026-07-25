import { AppShell } from '@/components/layout/AppShell'
import { useTheme } from '@/hooks/use-theme'

function App() {
  useTheme()
  return <AppShell />
}

export default App
