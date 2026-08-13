import { useState } from 'react'
import { useAuth } from '../context/AuthContext.jsx'
import AdminShell from '../components/AdminShell.jsx'
import AdminDashboard from '../pages/AdminDashboard.jsx'
import ProductAdminPage from '../pages/ProductAdminPage.jsx'
import SalespeopleAdminPage from '../pages/SalespeopleAdminPage.jsx'
import AnnouncementsAdminPage from '../pages/AnnouncementsAdminPage.jsx'
import VerifiedOrdersPage from '../pages/VerifiedOrdersPage.jsx'
import ReportPanel from '../components/ReportPanel.jsx'
import AdminBillingView from '../pages/AdminBillingView.jsx'
import AdminQcView from '../pages/AdminQcView.jsx'
import AdminDeliveryView from '../pages/AdminDeliveryView.jsx'

/**
 * Admin experience: a persistent sidebar shell (AdminShell) wrapping whichever
 * section is active. This REPLACES the old full-page-swap admin routing in
 * App.jsx, but every underlying page/component is unchanged — this file only
 * owns navigation state and slots the right content in.
 *
 * Phase C1: wires the shell to sections that already existed (Dashboard,
 * Products, Users, Reports) plus the two admin-only utility pages that were
 * reachable from the old Dashboard (Announcements, Verified Orders). Sections
 * not yet built (Sales/Orders/Billing/QC/Delivery/Customers/Settings) show as
 * "SOON" in the sidebar — Phase C2/C3.
 */
export default function AdminApp() {
  const { profile, signOut } = useAuth()
  const [section, setSection] = useState('dashboard')

  return (
    <AdminShell
      activeKey={section}
      onNavigate={setSection}
      profileName={profile?.full_name}
      onSignOut={signOut}
    >
      {section === 'dashboard' && (
        <AdminDashboard
          embedded
          onOpenProducts={() => setSection('products')}
          onOpenSalespeople={() => setSection('users')}
          onOpenAnnounce={() => setSection('announce')}
          onOpenVerified={() => setSection('verified')}
        />
      )}

      {section === 'products' && (
        <ProductAdminPage onBack={() => setSection('dashboard')} />
      )}

      {section === 'users' && (
        <SalespeopleAdminPage onBack={() => setSection('dashboard')} />
      )}

      {section === 'reports' && (
        <div className="px-3 sm:px-6 pt-4 pb-10 max-w-2xl">
          <ReportPanel kind="sales" />
          <div className="mt-4">
            <ReportPanel kind="delivery" />
          </div>
        </div>
      )}

      {/* Phase C2 — read-only visibility into Billing/QC/Delivery. These use
          the SAME data functions those teams' own dashboards use, so the
          numbers always match. No verify/assign/override actions are exposed
          here — that stays exclusively with each team's own login. */}
      {section === 'billing' && <AdminBillingView />}
      {section === 'qc' && <AdminQcView />}
      {section === 'delivery' && <AdminDeliveryView />}

      {/* Reachable via the Dashboard's existing shortcuts, not their own nav
          item yet — kept exactly as the old routing worked. */}
      {section === 'announce' && (
        <AnnouncementsAdminPage onBack={() => setSection('dashboard')} />
      )}
      {section === 'verified' && (
        <VerifiedOrdersPage onBack={() => setSection('dashboard')} />
      )}
    </AdminShell>
  )
}
