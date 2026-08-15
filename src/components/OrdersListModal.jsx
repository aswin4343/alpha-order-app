import { useEffect, useState } from 'react'
import { loadOrdersList, deleteOwnOrder } from '../utils/cloudSync.js'
import { CloseIcon } from './Icons.jsx'
import OrderSummaryModal from './OrderSummaryModal.jsx'
import AddOnFlowModal from './AddOnFlowModal.jsx'

function fmtDate(iso) {
  try { return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) } catch { return '' }
}
function fmtTime(iso) {
  try { return new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true }) } catch { return '' }
}
const rupee = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`

/**
 * Orders Taken drill-down: KPI -> list of orders/shops -> tap a shop opens
 * the full Order Summary. Orders still pending Billing verification show a
 * delete icon — the rep can remove their own mistake at any time, but once
 * Billing verifies an order it's locked in and the icon disappears.
 */
export default function OrdersListModal({ userId, start, end, route, periodLabel, onClose }) {
  const [orders, setOrders] = useState(null) // null = loading
  const [error, setError] = useState(false)
  const [openOrderId, setOpenOrderId] = useState(null)
  const [confirmDelete, setConfirmDelete] = useState(null) // the order pending delete confirmation
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState('')
  const [addOnOrder, setAddOnOrder] = useState(null) // the order being extended with an add-on

  const refresh = async () => {
    try {
      const data = await loadOrdersList(userId, start, end, route || null)
      setOrders(data)
    } catch {
      setError(true); setOrders([])
    }
  }

  useEffect(() => {
    let active = true
    setOrders(null); setError(false)
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

  const onConfirmDelete = async () => {
    if (!confirmDelete) return
    setDeleting(true)
    setDeleteError('')
    try {
      await deleteOwnOrder(confirmDelete.id)
      setConfirmDelete(null)
      await refresh() // reload so the count/list stay accurate immediately
    } catch (e) {
      console.error(e)
      setDeleteError(e?.message || 'Could not delete this order. Try again.')
    } finally {
      setDeleting(false)
    }
  }

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

          {orders && orders.map((o) => {
            const canDelete = o.billing_status === 'pending'
            return (
              <div
                key={o.id}
                className="w-full rounded-2xl border border-slate-200 mb-2.5 p-3 flex items-start gap-2"
              >
                <button onClick={() => setOpenOrderId(o.id)} className="flex-1 min-w-0 text-left">
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
                <div className="shrink-0 flex flex-col gap-1.5 items-center">
                  <button
                    onClick={() => setAddOnOrder(o)}
                    className="h-8 px-2.5 rounded-lg flex items-center justify-center text-[11px] font-bold text-brand-700 bg-brand-50 active:bg-brand-100"
                    aria-label="Add products to this order"
                    title="Add products to this order"
                  >
                    + ADD-ON
                  </button>
                  {canDelete && (
                    <button
                      onClick={() => setConfirmDelete(o)}
                      className="h-8 w-8 rounded-lg flex items-center justify-center text-red-500 active:bg-red-50"
                      aria-label="Delete this order"
                      title="Delete this order"
                    >
                      🗑
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {openOrderId && (
        <OrderSummaryModal orderId={openOrderId} onClose={() => setOpenOrderId(null)} />
      )}

      {addOnOrder && (
        <AddOnFlowModal
          order={addOnOrder}
          userId={userId}
          onClose={() => setAddOnOrder(null)}
          onSaved={refresh}
        />
      )}

      {confirmDelete && (
        <div className="fixed inset-0 z-[70] bg-black/40 flex items-end sm:items-center justify-center">
          <div className="bg-white w-full sm:max-w-sm rounded-t-3xl sm:rounded-3xl p-5">
            <p className="text-lg font-bold text-red-700 mb-1">Delete this bill?</p>
            <p className="text-sm text-slate-500 mb-4">
              <b>{confirmDelete.shop_name}</b> — {rupee(confirmDelete.total_value)} will be marked as
              Deleted Bill and will no longer count as an active order in your performance.
            </p>
            {deleteError && <p className="text-xs text-red-600 mb-2">{deleteError}</p>}
            <div className="flex gap-2">
              <button
                onClick={() => setConfirmDelete(null)}
                disabled={deleting}
                className="flex-1 rounded-xl border border-slate-200 py-3 font-semibold text-slate-600 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={onConfirmDelete}
                disabled={deleting}
                className="flex-1 rounded-xl bg-red-600 text-white py-3 font-bold active:bg-red-700 disabled:opacity-50"
              >
                {deleting ? 'Deleting…' : 'Delete Bill'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
