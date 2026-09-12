import { useEffect, useState } from 'react'
import { loadOrderSummary, removeOrderItem } from '../utils/cloudSync.js'
import { CloseIcon } from './Icons.jsx'

function fmt(iso) {
  try {
    return new Date(iso).toLocaleString('en-IN', {
      day: 'numeric', month: 'short', year: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true
    })
  } catch { return '' }
}

const rupee = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`

export default function OrderSummaryModal({ orderId, onClose, onEdit }) {
  const [order, setOrder] = useState(null)
  const [error, setError] = useState(false)
  const [removingId, setRemovingId] = useState(null)
  const [confirmRemove, setConfirmRemove] = useState(null) // item to confirm remove

  const load = async () => {
    setOrder(null); setError(false)
    try {
      const data = await loadOrderSummary(orderId)
      setOrder(data)
    } catch { setError(true) }
  }

  useEffect(() => {
    let active = true
    setOrder(null); setError(false)
    ;(async () => {
      try {
        const data = await loadOrderSummary(orderId)
        if (active) setOrder(data)
      } catch { if (active) setError(true) }
    })()
    return () => { active = false }
  }, [orderId])

  const handleRemove = async (item) => {
    setRemovingId(item.id)
    try {
      // Find the order_id for this item — items now carry order_id
      const oid = item.order_id || (Array.isArray(orderId) ? orderId[0] : orderId)
      await removeOrderItem(item.id, oid)
      setConfirmRemove(null)
      await load()
    } catch (e) {
      console.error(e)
      alert('Could not remove item: ' + (e?.message || 'unknown error'))
    } finally { setRemovingId(null) }
  }

  const isPending = order?.billing_status === 'pending'

  return (
    <div className="fixed inset-0 z-[60] bg-black/40 flex items-end sm:items-center justify-center">
      <div className="bg-white w-full sm:max-w-md rounded-t-3xl sm:rounded-3xl max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100">
          <div className="min-w-0">
            <h2 className="font-bold text-slate-800">Order Summary</h2>
            {order && <p className="text-xs text-slate-400 truncate">{order.shop_name}</p>}
          </div>
          <button onClick={onClose} className="p-2 text-slate-400" aria-label="Close">
            <CloseIcon className="h-5 w-5" />
          </button>
        </div>

        <div className="overflow-y-auto px-4 py-3 scroll-area">
          {order === null && !error && (
            <div className="py-10 flex justify-center">
              <div className="h-8 w-8 rounded-full border-4 border-brand-100 border-t-brand-600 animate-spin" />
            </div>
          )}
          {error && <p className="py-10 text-center text-sm text-red-500">Could not load this order.</p>}

          {order && (
            <>
              <div className="rounded-2xl bg-slate-50 border border-slate-100 p-3 mb-3 text-sm">
                <div className="flex justify-between py-0.5"><span className="text-slate-500">Date &amp; time</span><span className="font-medium text-slate-800">{fmt(order.created_at)}</span></div>
                <div className="flex justify-between py-0.5"><span className="text-slate-500">Route</span><span className="font-medium text-slate-800">{order.route || '—'}</span></div>
                {order.sales_rep_name && (
                  <div className="flex justify-between py-0.5"><span className="text-slate-500">Sales rep</span><span className="font-medium text-slate-800">{order.sales_rep_name}</span></div>
                )}
                <div className="flex justify-between py-0.5"><span className="text-slate-500">Status</span><span className="font-medium text-slate-800 capitalize">{order.billing_status || 'pending'}</span></div>
              </div>

              <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide mb-1.5">
                Products ({(order.items || []).length})
                {isPending && <span className="ml-1 text-brand-500 normal-case font-normal">· tap × to remove</span>}
              </p>
              <div className="space-y-2 mb-3">
                {(order.items || []).map((it) => (
                  <div key={it.id} className="rounded-xl border border-slate-200 p-2.5 flex items-start gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium text-slate-800 truncate">{it.product_name}</span>
                        <span className="text-sm text-slate-600 shrink-0">×{it.qty} {it.unit}</span>
                      </div>
                      {(it.unit_price != null || it.scheme_applied) && (
                        <div className="flex items-center justify-between mt-1 text-[11px] text-slate-400">
                          <span>{it.scheme_applied || ''}</span>
                          {it.unit_price != null && <span>{rupee(it.unit_price)} / unit</span>}
                        </div>
                      )}
                      {it.is_addon && (
                        <span className="inline-block mt-1 text-[10px] font-semibold text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded">ADD-ON</span>
                      )}
                    </div>
                    {/* Remove button — pending orders only */}
                    {isPending && (
                      <button
                        onClick={() => setConfirmRemove(it)}
                        disabled={!!removingId}
                        className="shrink-0 h-7 w-7 rounded-lg flex items-center justify-center text-red-400 hover:bg-red-50 active:bg-red-100 disabled:opacity-30 mt-0.5"
                        title="Remove this product"
                      >
                        ✕
                      </button>
                    )}
                  </div>
                ))}
                {(!order.items || order.items.length === 0) && (
                  <p className="text-sm text-slate-400 text-center py-4">No product lines found for this order.</p>
                )}
              </div>

              <div className="rounded-2xl bg-brand-50 border border-brand-100 p-3 flex items-center justify-between">
                <span className="text-sm text-slate-600">Total qty: <b className="text-slate-800">{order.total_quantity}</b></span>
                <span className="text-base font-bold text-brand-700">{rupee(order.total_value)}</span>
              </div>

              {onEdit && isPending && (
                <button
                  onClick={() => onEdit(order)}
                  className="mt-3 w-full rounded-2xl border border-brand-200 bg-white py-2.5 text-sm font-semibold text-brand-700 active:bg-brand-50"
                >
                  ✏️ Edit Order
                </button>
              )}
            </>
          )}
        </div>

        {/* Confirm remove dialog */}
        {confirmRemove && (
          <div className="fixed inset-0 z-[70] bg-black/40 flex items-center justify-center px-4">
            <div className="bg-white w-full max-w-sm rounded-2xl p-5">
              <p className="font-bold text-slate-800 mb-1">Remove this product?</p>
              <p className="text-sm text-slate-500 mb-4">
                <b>{confirmRemove.product_name}</b> ×{confirmRemove.qty} will be removed from this order.
                Billing Team will see it gone immediately.
              </p>
              <div className="flex gap-2">
                <button onClick={() => setConfirmRemove(null)} disabled={!!removingId}
                  className="flex-1 rounded-xl border border-slate-200 py-2.5 text-sm font-semibold text-slate-600 disabled:opacity-50">
                  Cancel
                </button>
                <button onClick={() => handleRemove(confirmRemove)} disabled={!!removingId}
                  className="flex-1 rounded-xl bg-red-600 text-white py-2.5 text-sm font-bold active:bg-red-700 disabled:opacity-50">
                  {removingId === confirmRemove.id ? 'Removing…' : 'Remove'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

