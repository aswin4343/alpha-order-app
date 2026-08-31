import { useState } from 'react'
import appIcon from '../assets/app_icon.png'
import { PRICE_APPROVAL_ENABLED } from '../utils/featureFlags.js'

// Nav item definitions. `key` matches AdminApp's route state.
// Items not yet built (Phase C2/C3) are flagged `soon` and show a small
// badge instead of being clickable, so the full nav is visible from day one
// without dead links. Price Approvals is fully built but paused (the team
// needs time to adjust their workflow first) — same `soon` treatment while
// PRICE_APPROVAL_ENABLED is false; flipping that flag brings it straight back.
const NAV_ITEMS = [
  { key: 'dashboard', label: 'Dashboard', icon: '📊' },
  { key: 'sales', label: 'Sales', icon: '🧑‍💼', soon: true },
  { key: 'orders', label: 'Orders', icon: '🛒', soon: true },
  { key: 'billing', label: 'Billing', icon: '🧾' },
  { key: 'approvals', label: 'Price Approvals', icon: '🛡️', soon: !PRICE_APPROVAL_ENABLED },
  { key: 'qc', label: 'Quality Check', icon: '✅' },
  { key: 'delivery', label: 'Delivery', icon: '🚚' },
  { key: 'customers', label: 'Customers', icon: '🏪', soon: true },
  { key: 'products', label: 'Products', icon: '📦' },
  { key: 'reports', label: 'Reports', icon: '📈' },
  { key: 'users', label: 'Users', icon: '👥' },
  { key: 'settings', label: 'Settings', icon: '⚙️', soon: true }
]

/**
 * Persistent Admin shell: sidebar (desktop) / bottom-accessible drawer
 * (mobile) + a slim top bar, wrapping whichever section is active.
 *
 * This does NOT change any existing page's data loading or logic — it only
 * supplies the surrounding navigation chrome. Each section renders via the
 * `children` passed in by AdminApp for the current route.
 */
export default function AdminShell({ activeKey, onNavigate, profileName, onSignOut, badges, children }) {
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const activeItem = NAV_ITEMS.find((n) => n.key === activeKey)

  const NavList = ({ onItemClick }) => (
    <nav className="flex-1 overflow-y-auto py-2">
      {NAV_ITEMS.map((item) => {
        const isActive = item.key === activeKey
        const count = badges?.[item.key]
        return (
          <button
            key={item.key}
            disabled={item.soon}
            onClick={() => {
              onNavigate(item.key)
              onItemClick?.()
            }}
            className={`w-full flex items-center gap-3 px-4 py-2.5 text-sm font-medium text-left transition-colors ${
              isActive
                ? 'bg-brand-50 text-brand-700 border-r-2 border-brand-600'
                : item.soon
                ? 'text-slate-300 cursor-default'
                : 'text-slate-600 hover:bg-slate-50'
            }`}
          >
            <span className="text-base leading-none">{item.icon}</span>
            <span className="flex-1">{item.label}</span>
            {item.soon && (
              <span className="text-[9px] font-semibold text-slate-300 bg-slate-100 px-1.5 py-0.5 rounded">SOON</span>
            )}
            {!item.soon && count > 0 && (
              <span className="min-w-[18px] h-[18px] px-1 rounded-full bg-amber-500 text-white text-[10px] font-bold flex items-center justify-center">
                {count > 99 ? '99+' : count}
              </span>
            )}
          </button>
        )
      })}
    </nav>
  )

  return (
    <div className="min-h-screen bg-slate-50 flex">
      {/* Desktop sidebar */}
      <aside className="hidden lg:flex lg:flex-col w-60 shrink-0 bg-white border-r border-slate-100 h-screen sticky top-0">
        <div className="flex items-center gap-2 px-4 py-4 border-b border-slate-100">
          <img src={appIcon} alt="" className="h-8 w-8 rounded-lg object-contain" />
          <div className="min-w-0">
            <p className="text-sm font-bold text-slate-800 leading-tight truncate">Alpha Trade Links</p>
            <p className="text-[10px] text-slate-400">Admin</p>
          </div>
        </div>
        <NavList />
        <div className="p-3 border-t border-slate-100">
          <p className="text-[11px] text-slate-400 truncate px-1 mb-1.5">{profileName || 'Administrator'}</p>
          <button
            onClick={onSignOut}
            className="w-full text-xs font-semibold text-red-600 px-2.5 py-2 rounded-lg hover:bg-red-50 text-center"
          >
            Sign Out
          </button>
        </div>
      </aside>

      {/* Mobile nav drawer */}
      {mobileNavOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setMobileNavOpen(false)} />
          <div className="absolute inset-y-0 left-0 w-64 bg-white flex flex-col safe-top safe-bottom">
            <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-100">
              <img src={appIcon} alt="" className="h-8 w-8 rounded-lg object-contain" />
              <p className="text-sm font-bold text-slate-800">Alpha Trade Links</p>
            </div>
            <NavList onItemClick={() => setMobileNavOpen(false)} />
            <div className="p-3 border-t border-slate-100">
              <button
                onClick={onSignOut}
                className="w-full text-xs font-semibold text-red-600 px-2.5 py-2 rounded-lg hover:bg-red-50"
              >
                Sign Out
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Main column */}
      <div className="flex-1 min-w-0">
        <header className="sticky top-0 z-20 bg-white border-b border-slate-100 safe-top">
          <div className="px-3 sm:px-6 py-2.5 flex items-center gap-2">
            <button
              onClick={() => setMobileNavOpen(true)}
              className="lg:hidden h-9 w-9 rounded-lg flex items-center justify-center text-slate-600 active:bg-slate-100"
              aria-label="Open menu"
            >
              ☰
            </button>
            <h1 className="text-base font-bold text-slate-800 leading-tight flex-1">
              {activeItem?.label || 'Admin'}
            </h1>
            <button
              onClick={onSignOut}
              className="lg:hidden text-xs font-semibold text-red-600 px-2.5 py-1.5 rounded-lg active:bg-red-50"
            >
              Sign Out
            </button>
          </div>
        </header>

        <main>{children}</main>
      </div>
    </div>
  )
}
