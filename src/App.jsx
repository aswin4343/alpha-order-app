import { useState } from 'react'
import { useApp } from './context/AppContext.jsx'
import SetupScreen from './pages/SetupScreen.jsx'
import OrderPage from './pages/OrderPage.jsx'
import SettingsPage from './pages/SettingsPage.jsx'

export default function App() {
  const { ready, settings } = useApp()
  const [route, setRoute] = useState('order') // 'order' | 'settings'

  // Simple splash while IndexedDB seeds/loads.
  if (!ready) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-white">
        <div className="h-10 w-10 rounded-full border-4 border-brand-100 border-t-brand-600 animate-spin" />
      </div>
    )
  }

  // First launch: capture business details.
  if (!settings.configured) {
    return <SetupScreen />
  }

  if (route === 'settings') {
    return <SettingsPage onBack={() => setRoute('order')} />
  }

  return <OrderPage onOpenSettings={() => setRoute('settings')} />
}
