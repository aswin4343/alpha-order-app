import { useState } from 'react'
import { useAuth } from './context/AuthContext.jsx'
import { useApp } from './context/AppContext.jsx'
import LoginScreen from './pages/LoginScreen.jsx'
import OrderPage from './pages/OrderPage.jsx'
import OrderChangeNotifier from './components/OrderChangeNotifier.jsx'
import SettingsPage from './pages/SettingsPage.jsx'
import ReturnsPage from './pages/ReturnsPage.jsx'
import PerformancePage from './pages/PerformancePage.jsx'
import AdminDashboard from './pages/AdminDashboard.jsx'
import ProductAdminPage from './pages/ProductAdminPage.jsx'
import SalespeopleAdminPage from './pages/SalespeopleAdminPage.jsx'
import AnnouncementsAdminPage from './pages/AnnouncementsAdminPage.jsx'
import AnnouncementsPage from './pages/AnnouncementsPage.jsx'
import DeliveryAdminDashboard from './pages/DeliveryAdminDashboard.jsx'
import BillingDashboard from './pages/BillingDashboard.jsx'
import VerifiedOrdersPage from './pages/VerifiedOrdersPage.jsx'
import DeliveryRepDashboard from './pages/DeliveryRepDashboard.jsx'

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
  const [unreadTick, setUnreadTick] = useState(0)

  // Wait for auth to resolve first.
  if (loading) return <Splash />

  // Not logged in → login screen.
  if (!session) return <LoginScreen />

  // Logged in but profile/products still loading.
  if (!ready || !profile) return <Splash />

  // Admins get the dashboard; salespeople get the ordering app.
  if (profile.role === 'admin') {
    if (route === 'products') return <ProductAdminPage onBack={() => setRoute('order')} />
    if (route === 'salespeople') return <SalespeopleAdminPage onBack={() => setRoute('order')} />
    if (route === 'announce') return <AnnouncementsAdminPage onBack={() => setRoute('order')} />
    if (route === 'verified') return <VerifiedOrdersPage onBack={() => setRoute('order')} />
    return (
      <AdminDashboard
        onOpenProducts={() => setRoute('products')}
        onOpenSalespeople={() => setRoute('salespeople')}
        onOpenAnnounce={() => setRoute('announce')}
        onOpenVerified={() => setRoute('verified')}
      />
    )
  }

  // V4 Delivery roles — completely separate screens. Sales users never reach
  // here, so the existing Sales experience is unchanged (backward compatible).
  if (profile.role === 'delivery_admin') return <DeliveryAdminDashboard />
  if (profile.role === 'delivery_rep') return <DeliveryRepDashboard />
  if (profile.role === 'billing_team') return <BillingDashboard />

  const isRep = profile.role === 'salesperson'

  if (route === 'settings') return <SettingsPage onBack={() => setRoute('order')} />
  if (route === 'returns') return <ReturnsPage onBack={() => setRoute('order')} />
  if (route === 'performance') return <PerformancePage onBack={() => setRoute('order')} />
  if (route === 'announcements')
    return <AnnouncementsPage onBack={() => setRoute('order')} onChanged={() => setUnreadTick((t) => t + 1)} />

  return (
    <>
      {isRep && <OrderChangeNotifier />}
      <OrderPage
        onOpenSettings={() => setRoute('settings')}
        onOpenReturns={() => setRoute('returns')}
        onOpenPerformance={() => setRoute('performance')}
        onOpenAnnouncements={() => setRoute('announcements')}
        unreadTick={unreadTick}
      />
    </>
  )
}
