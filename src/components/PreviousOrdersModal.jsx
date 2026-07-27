import { useState, useEffect } from 'react'
import { loadPreviousOrders } from '../utils/cloudSync.js'
import { CloseIcon } from './Icons.jsx'

// Format an ISO date as "24 Jul, 3:40 pm".
function fmt(iso) {
  try {
    const d = new Date(iso)
    return d.toLocaleString('en-IN', {
      day: 'numeric',
      month: 'short',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    })
  } catch {
    return ''
  }
}

/**
 * Shows a customer's recent orders (any rep) so the current rep can reload one
 * into the cart. Appears after a repeat customer is selected.
 */
export default function PreviousOrdersModal({ customer, onClose, onLoad }) {
  const [orders, setOrders] = useState(null) // null = loading
  const [error, setError] = useState(false)

  useEffect(() => {
    let active = true
    ;(async () => {
      try {
        const data = await loadPreviousOrders(customer.name, customer.route || '')
        if (active) setOrders(data)
      } catch {
        if (active) {
          setError(true)
          setOrders([])
        }
      }
    })()
    return () => {
      active = false
    }
  }, [customer])

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center">
      <div className="bg-white w-full sm:max-w-md rounded-t-3xl sm:rounded-3xl max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100">
          <div className="min-w-0">
            <h2 className="font-bold text-slate-800">Previous Orders</h2>
            <p className="text-xs text-slate-400 truncate">{customer.name}</p>
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

          {orders && orders.length === 0 && (
            <p className="py-10 text-center text-sm text-slate-400">
              No previous orders found for this shop.
            </p>
          )}

          {orders &&
            orders.map((o, idx) => (
              <div
                key={o.id}
                className={`rounded-2xl border mb-2.5 p-3 ${
                  idx === 0 ? 'border-brand-500 bg-brand-50/40' : 'border-slate-200'
                }`}
              >
                <div className="flex items-center justify-between mb-1.5">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-slate-800">{fmt(o.created_at)}</span>
                    {idx === 0 && (
                      <span className="text-[10px] font-semibold text-brand-700 bg-brand-100 px-1.5 py-0.5 rounded">
                        LATEST
                      </span>
                    )}
                  </div>
                  <span className="text-[11px] text-slate-400">
                    {o.total_products} items · {o.total_quantity} qty
                  </span>
                </div>

                <p className="text-[12px] text-slate-500 leading-snug mb-2 line-clamp-2">
                  {(o.order_items || [])
                    .map((i) => `${i.product_name} ×${i.qty}`)
                    .join(', ')}
                </p>

                <button
                  onClick={() => onLoad(o)}
                  className="w-full rounded-xl bg-brand-600 text-white py-2.5 text-sm font-semibold active:bg-brand-700"
                >
                  Load this order
                </button>
              </div>
            ))}
        </div>

        <div className="p-3 border-t border-slate-100 safe-bottom">
          <button
            onClick={onClose}
            className="w-full rounded-xl border border-slate-200 py-3 font-medium text-slate-600 active:bg-slate-50"
          >
            Start fresh order
          </button>
        </div>
      </div>
    </div>
  )
}
