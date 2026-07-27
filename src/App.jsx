import { useState } from 'react'
import { useAuth } from './context/AuthContext.jsx'
import { useApp } from './context/AppContext.jsx'
import LoginScreen from './pages/LoginScreen.jsx'
import OrderPage from './pages/OrderPage.jsx'
import SettingsPage from './pages/SettingsPage.jsx'
import ReturnsPage from './pages/ReturnsPage.jsx'
import PerformancePage from './pages/PerformancePage.jsx'
import AdminDashboard from './pages/AdminDashboard.jsx'
import ProductAdminPage from './pages/ProductAdminPage.jsx'

function Splash() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-white">
      <div className="h-10 w-10 rounded-full border-4 border-brand-100 border-t-brand-600 animate-spin" />
    </div>
  )
}

export default function App() {
  const { loading, session, profile } = useAuth()
  const { ready } = useApp()
  const [route, setRoute] = useState('order')

  // Wait for auth to resolve first.
  if (loading) return <Splash />

  // Not logged in → login screen.
  if (!session) return <LoginScreen />

  // Logged in but profile/products still loading.
  if (!ready || !profile) return <Splash />

  // Admins get the dashboard; salespeople get the ordering app.
  if (profile.role === 'admin') {
    if (route === 'products') return <ProductAdminPage onBack={() => setRoute('order')} />
    return <AdminDashboard onOpenProducts={() => setRoute('products')} />
  }

  if (route === 'settings') return <SettingsPage onBack={() => setRoute('order')} />
  if (route === 'returns') return <ReturnsPage onBack={() => setRoute('order')} />
  if (route === 'performance') return <PerformancePage onBack={() => setRoute('order')} />

  return (
    <OrderPage
      onOpenSettings={() => setRoute('settings')}
      onOpenReturns={() => setRoute('returns')}
      onOpenPerformance={() => setRoute('performance')}
    />
  )
}
