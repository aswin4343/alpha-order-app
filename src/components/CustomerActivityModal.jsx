import { useEffect, useState } from 'react'
import { loadCustomerTodayActivity } from '../utils/cloudSync.js'
import { CloseIcon } from './Icons.jsx'
import OrderSummaryModal from './OrderSummaryModal.jsx'

function fmtTime(iso) {
  try { return new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true }) } catch { return '' }
}
const rupee = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`

/**
 * New Shops -> Today's Activity: whether this customer was visited today and
 * what orders (if any) they placed today. Each order opens the full summary.
 */
export default function CustomerActivityModal({ customer, userId, onClose }) {
  const [activity, setActivity] = useState(null) // null = loading
  const [error, setError] = useState(false)
  const [openOrderId, setOpenOrderId] = useState(null)

  useEffect(() => {
    let active = true
    ;(async () => {
      try {
        const data = await loadCustomerTodayActivity(customer.id, userId)
        if (active) setActivity(data)
      } catch {
        if (active) setError(true)
      }
    })()
    return () => { active = false }
  }, [customer, userId])

  return (
    <div className="fixed inset-0 z-[65] bg-black/40 flex items-end sm:items-center justify-center">
      <div className="bg-white w-full sm:max-w-md rounded-t-3xl sm:rounded-3xl max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100">
          <div className="min-w-0">
            <h2 className="font-bold text-slate-800 truncate">{customer.shop_name}</h2>
            <p className="text-xs text-slate-400">Today's activity</p>
          </div>
          <button onClick={onClose} className="p-2 text-slate-400" aria-label="Close">
            <CloseIcon className="h-5 w-5" />
          </button>
        </div>

        <div className="overflow-y-auto px-4 py-3 scroll-area">
          {activity === null && !error && (
            <div className="py-10 flex justify-center">
              <div className="h-8 w-8 rounded-full border-4 border-brand-100 border-t-brand-600 animate-spin" />
            </div>
          )}
          {error && <p className="py-6 text-center text-sm text-red-500">Could not load activity.</p>}

          {activity && (
            <>
              <div className="rounded-2xl bg-slate-50 border border-slate-100 p-3 mb-4 text-sm">
                <div className="flex justify-between py-1"><span className="text-slate-500">Shop visit</span><span className="font-semibold text-slate-800">{activity.visitedToday ? 'Yes' : 'No'}</span></div>
                <div className="flex justify-between py-1"><span className="text-slate-500">Orders today</span><span className="font-semibold text-slate-800">{activity.ordersToday}</span></div>
                <div className="flex justify-between py-1"><span className="text-slate-500">Today's order value</span><span className="font-semibold text-slate-800">{rupee(activity.orderValueToday)}</span></div>
                {activity.lastOrderAt && (
                  <div className="flex justify-between py-1"><span className="text-slate-500">Last order</span><span className="font-semibold text-slate-800">{fmtTime(activity.lastOrderAt)}</span></div>
                )}
              </div>

              <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide mb-1.5">Today's orders</p>
              {activity.orders.length === 0 ? (
                <p className="text-sm text-slate-400 text-center py-6">No orders today.</p>
              ) : (
                activity.orders.map((o) => (
                  <button
                    key={o.id}
                    onClick={() => setOpenOrderId(o.id)}
                    className="w-full text-left rounded-2xl border border-slate-200 mb-2.5 p-3 active:bg-slate-50"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-semibold text-slate-800">{fmtTime(o.created_at)}</span>
                      <span className="text-sm font-bold text-brand-700">{rupee(o.total_value)}</span>
                    </div>
                    <p className="text-[11px] text-slate-400 mt-0.5">{o.total_products} products · {o.total_quantity} qty</p>
                  </button>
                ))
              )}
            </>
          )}
        </div>
      </div>

      {openOrderId && (
        <OrderSummaryModal orderId={openOrderId} onClose={() => setOpenOrderId(null)} />
      )}
    </div>
  )
}
