import { useEffect, useState } from 'react'
import { loadNewShopsList } from '../utils/cloudSync.js'
import { CloseIcon } from './Icons.jsx'
import CustomerActivityModal from './CustomerActivityModal.jsx'

function fmtDate(iso) {
  try { return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) } catch { return '' }
}
function fmtTime(iso) {
  try { return new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true }) } catch { return '' }
}

/**
 * New Shops Added drill-down: KPI -> list of new customers -> tap a shop
 * opens Today's Activity. Phone is intentionally never shown here — customer
 * phone numbers are never stored in the cloud (device-only, by design).
 */
export default function NewShopsListModal({ userId, start, end, route, periodLabel, onClose }) {
  const [shops, setShops] = useState(null) // null = loading
  const [error, setError] = useState(false)
  const [openCustomer, setOpenCustomer] = useState(null)

  useEffect(() => {
    let active = true
    ;(async () => {
      try {
        const data = await loadNewShopsList(userId, start, end, route || null)
        if (active) setShops(data)
      } catch {
        if (active) { setError(true); setShops([]) }
      }
    })()
    return () => { active = false }
  }, [userId, start, end, route])

  return (
    <div className="fixed inset-0 z-[60] bg-black/40 flex items-end sm:items-center justify-center">
      <div className="bg-white w-full sm:max-w-md rounded-t-3xl sm:rounded-3xl max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100">
          <div className="min-w-0">
            <h2 className="font-bold text-slate-800">New Shops Added</h2>
            <p className="text-xs text-slate-400">{periodLabel}</p>
          </div>
          <button onClick={onClose} className="p-2 text-slate-400" aria-label="Close">
            <CloseIcon className="h-5 w-5" />
          </button>
        </div>

        <div className="overflow-y-auto px-4 py-3 scroll-area">
          {shops === null && (
            <div className="py-10 flex justify-center">
              <div className="h-8 w-8 rounded-full border-4 border-brand-100 border-t-brand-600 animate-spin" />
            </div>
          )}
          {error && <p className="py-6 text-center text-sm text-red-500">Could not load new shops.</p>}
          {shops && shops.length === 0 && !error && (
            <p className="py-10 text-center text-sm text-slate-400">No new shops added for this period.</p>
          )}

          {shops && shops.map((c) => (
            <button
              key={c.id}
              onClick={() => setOpenCustomer(c)}
              className="w-full text-left rounded-2xl border border-slate-200 mb-2.5 p-3 active:bg-slate-50"
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-slate-800">{c.shop_name}</span>
                {c.category && (
                  <span className="text-[10px] font-semibold text-slate-500 bg-slate-100 px-2 py-0.5 rounded-full">{c.category}</span>
                )}
              </div>
              <p className="text-[11px] text-slate-400 mt-0.5">
                {c.route || 'No route'} · Added {fmtDate(c.created_at)}, {fmtTime(c.created_at)}
              </p>
            </button>
          ))}
        </div>
      </div>

      {openCustomer && (
        <CustomerActivityModal
          customer={openCustomer}
          userId={userId}
          onClose={() => setOpenCustomer(null)}
        />
      )}
    </div>
  )
}
