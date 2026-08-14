import { useEffect, useState } from 'react'
import { loadOrdersList } from '../utils/cloudSync.js'
import { CloseIcon } from './Icons.jsx'
import OrderSummaryModal from './OrderSummaryModal.jsx'

function fmtDate(iso) {
  try { return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) } catch { return '' }
}
function fmtTime(iso) {
  try { return new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true }) } catch { return '' }
}
const rupee = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`

/**
 * Orders Taken drill-down: KPI -> list of orders/shops -> tap a shop opens
 * the full Order Summary.
 */
export default function OrdersListModal({ userId, start, end, route, periodLabel, onClose }) {
  const [orders, setOrders] = useState(null) // null = loading
  const [error, setError] = useState(false)
  const [openOrderId, setOpenOrderId] = useState(null)

  useEffect(() => {
    let active = true
    ;(async () => {
      try {
        const data = await loadOrdersList(userId, start, end, route || null)
        if (active) setOrders(data)
      } catch {
        if (active) { setError(true); setOrders([]) }
      }
    })()
    return () => { active = false }
  }, [userId, start, end, route])

  return (
    <div className="fixed inset-0 z-[60] bg-black/40 flex items-end sm:items-center justify-center">
      <div className="bg-white w-full sm:max-w-md rounded-t-3xl sm:rounded-3xl max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100">
          <div className="min-w-0">
            <h2 className="font-bold text-slate-800">Orders Taken</h2>
            <p className="text-xs text-slate-400">{periodLabel}</p>
          </div>
          <button onClick={onClose} className="p-2 text-slate-400" aria-label="Close">
            <CloseIcon className="h-5 w-5" />
          </button>
        </div>

        <div className="overflow-y-auto px-4 py-3 scroll-area">
          {orders === null && (
            <div className="py-10 flex justify-center">
              <div className="h-8 w-8 rounded-full border-4 border-brand-100 border-t-brand-600 animate-spin" />
            </div>
          )}
          {error && <p className="py-6 text-center text-sm text-red-500">Could not load orders.</p>}
          {orders && orders.length === 0 && !error && (
            <p className="py-10 text-center text-sm text-slate-400">No orders taken for this period.</p>
          )}

          {orders && orders.map((o) => (
            <button
              key={o.id}
              onClick={() => setOpenOrderId(o.id)}
              className="w-full text-left rounded-2xl border border-slate-200 mb-2.5 p-3 active:bg-slate-50"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 min-w-0">
                  <span className="text-sm font-semibold text-slate-800 truncate">{o.shop_name}</span>
                  {o.isAddon && (
                    <span className="text-[9px] font-bold text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded shrink-0">ADD-ON</span>
                  )}
                </span>
                <span className="text-sm font-bold text-brand-700 shrink-0">{rupee(o.total_value)}</span>
              </div>
              <p className="text-[11px] text-slate-400 mt-0.5">
                {o.total_products} products · {o.total_quantity} qty · {fmtDate(o.created_at)}, {fmtTime(o.created_at)}
              </p>
            </button>
          ))}
        </div>
      </div>

      {openOrderId && (
        <OrderSummaryModal orderId={openOrderId} onClose={() => setOpenOrderId(null)} />
      )}
    </div>
  )
}
