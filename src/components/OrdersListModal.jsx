import { useEffect, useState } from 'react'
import { loadOrdersList, deleteOwnOrder, updateOrderDateRoute } from '../utils/cloudSync.js'
import { CloseIcon, ThumbsUpIcon, ClockIcon } from './Icons.jsx'
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
  const [openOrderIds, setOpenOrderIds] = useState(null) // full group's order ids (original + add-ons)
  const [confirmDelete, setConfirmDelete] = useState(null) // the order pending delete confirmation
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState('')
  const [addOnOrder, setAddOnOrder] = useState(null) // the order being extended with an add-on
  const [editOrder, setEditOrder] = useState(null)   // the order whose date/route is being corrected
  const [editDate, setEditDate] = useState('')
  const [editRoute, setEditRoute] = useState('')
  const [editBusy, setEditBusy] = useState(false)
  const [editError, setEditError] = useState('')
  // 'pending' | 'verified' | null — which filtered sub-list is open
  const [statusFilter, setStatusFilter] = useState(null)

  // Derived from the SAME orders array the cards use — no new query, no new status logic.
  const pendingOrders  = (orders || []).filter((o) => o.billing_status !== 'verified')
  const verifiedOrders = (orders || []).filter((o) => o.billing_status === 'verified')
  const filteredOrders = statusFilter === 'pending'  ? pendingOrders
                       : statusFilter === 'verified' ? verifiedOrders
                       : null

  const refresh = async () => {
    try {
      const data = await loadOrdersList(userId, start, end, route || null)
      setOrders(data)
    } catch {
      setError(true); setOrders([])
    }
  }

  useEffect(() => {
    if (!userId) { setOrders([]); setError(false); return } // not logged in
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
      <div className="relative bg-white w-full sm:max-w-md rounded-t-3xl sm:rounded-3xl max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100">
          <div className="min-w-0">
            <h2 className="font-bold text-slate-800">Orders Taken</h2>
            <p className="text-xs text-slate-400">{periodLabel}</p>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {/* Pending counter — derived from the same orders array,
                so it always matches the clock-icon count below. */}
            <button
              onClick={() => orders && setStatusFilter('pending')}
              disabled={!orders}
              className="flex items-center gap-1 px-2 py-1 rounded-lg bg-amber-50 border border-amber-200 active:bg-amber-100 disabled:opacity-40"
              aria-label={`${pendingOrders.length} pending orders`}
            >
              <ClockIcon className="h-3.5 w-3.5 text-amber-500 shrink-0" />
              <span className="text-[11px] font-bold text-amber-700">{orders ? pendingOrders.length : '—'}</span>
            </button>
            {/* Verified counter */}
            <button
              onClick={() => orders && setStatusFilter('verified')}
              disabled={!orders}
              className="flex items-center gap-1 px-2 py-1 rounded-lg bg-green-50 border border-green-200 active:bg-green-100 disabled:opacity-40"
              aria-label={`${verifiedOrders.length} verified orders`}
            >
              <ThumbsUpIcon className="h-3.5 w-3.5 text-green-600 shrink-0" />
              <span className="text-[11px] font-bold text-green-700">{orders ? verifiedOrders.length : '—'}</span>
            </button>
            <button onClick={onClose} className="p-2 text-slate-400 ml-0.5" aria-label="Close">
              <CloseIcon className="h-5 w-5" />
            </button>
          </div>
        </div>

        {/* Filtered sub-list (pending or verified) — shown as an overlay inside
            the same modal. Uses the exact same card JSX as the main list and
            the same orders array, so counts and cards always match. */}
        {filteredOrders && (
          <div className="absolute inset-0 z-10 bg-white rounded-t-3xl sm:rounded-3xl flex flex-col max-h-[85vh]">
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100">
              <div>
                <h2 className="font-bold text-slate-800">
                  {statusFilter === 'pending' ? 'Pending' : 'Verified'} Orders
                  <span className="ml-1.5 text-xs font-semibold text-slate-400">({filteredOrders.length})</span>
                </h2>
                <p className="text-xs text-slate-400">{periodLabel}</p>
              </div>
              <button onClick={() => setStatusFilter(null)} className="p-2 text-slate-400" aria-label="Back to all orders">
                <CloseIcon className="h-5 w-5" />
              </button>
            </div>
            <div className="overflow-y-auto px-4 py-3 scroll-area flex-1">
              {filteredOrders.length === 0 && (
                <p className="py-10 text-center text-sm text-slate-400">
                  No {statusFilter} orders for this period.
                </p>
              )}
              {filteredOrders.map((o) => (
                <div key={o.id} className="w-full rounded-2xl border border-slate-200 mb-2.5 p-3 flex items-start gap-2">
                  <button
                    onClick={() => { setStatusFilter(null); setOpenOrderIds(o.orderIds && o.orderIds.length ? o.orderIds : [o.id]) }}
                    className="flex-1 min-w-0 text-left"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex items-center gap-1.5 min-w-0">
                        <span className="text-sm font-semibold text-slate-800 truncate">{o.shop_name}</span>
                        {o.isAddon && (
                          <span className="text-[9px] font-bold text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded shrink-0">ADD-ON</span>
                        )}
                      </span>
                      <span className="text-sm font-bold text-brand-700 shrink-0">{rupee(o.total_value)}</span>
                      {o.billing_status === 'verified' ? (
                        <ThumbsUpIcon className="h-4 w-4 text-green-600 shrink-0" />
                      ) : (
                        <ClockIcon className="h-4 w-4 text-amber-500 shrink-0" />
                      )}
                    </div>
                    <p className="text-[11px] text-slate-400 mt-0.5">
                      {o.total_products} products · {o.total_quantity} qty · {fmtDate(o.created_at)}, {fmtTime(o.created_at)}
                    </p>
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="overflow-y-auto flex-1 px-4 py-3 scroll-area">
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
                <button onClick={() => setOpenOrderIds(o.orderIds && o.orderIds.length ? o.orderIds : [o.id])} className="flex-1 min-w-0 text-left">
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-1.5 min-w-0">
                      <span className="text-sm font-semibold text-slate-800 truncate">{o.shop_name}</span>
                      {o.isAddon && (
                        <span className="text-[9px] font-bold text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded shrink-0">ADD-ON</span>
                      )}
                    </span>
                    <span className="text-sm font-bold text-brand-700 shrink-0">{rupee(o.total_value)}</span>
                    {/* Verification status — reuses the existing
                        billing_status field this card already carries (used
                        a few lines above for canDelete), so this is purely a
                        new visual reading of data already present, not a
                        new status source. billing_status only ever has two
                        stored values in this app ('pending' / 'verified');
                        "partial verified" is a separately-derived label
                        about what changed inside an already-verified order,
                        not a third value of this field, so the two-icon
                        mapping below is a complete, correct reflection of
                        it — nothing about the partial-verification logic
                        itself is touched or reinterpreted here. */}
                    {o.billing_status === 'verified' ? (
                      <ThumbsUpIcon className="h-4 w-4 text-green-600 shrink-0" role="img" aria-label="Verified" title="Verified" />
                    ) : (
                      <ClockIcon className="h-4 w-4 text-amber-500 shrink-0" role="img" aria-label="Verification Pending" title="Verification Pending" />
                    )}
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
                  {/* Edit date/route — only for pending orders (same gate as
                      delete). Opens a small modal to correct the wrong date or
                      route without creating a duplicate order. */}
                  {canDelete && (
                    <button
                      onClick={() => {
                        setEditOrder(o)
                        setEditDate(o.order_date || o.created_at?.slice(0, 10) || '')
                        setEditRoute(o.route || '')
                        setEditError('')
                      }}
                      className="h-8 w-8 rounded-lg flex items-center justify-center text-slate-500 active:bg-slate-100"
                      aria-label="Edit order date or route"
                      title="Edit date / route"
                    >
                      ✏️
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {openOrderIds && (
        <OrderSummaryModal orderId={openOrderIds} onClose={() => setOpenOrderIds(null)} />
      )}

      {addOnOrder && (
        <AddOnFlowModal
          order={addOnOrder}
          userId={userId}
          onClose={() => setAddOnOrder(null)}
          onSaved={refresh}
        />
      )}

      {editOrder && (
        <div className="fixed inset-0 z-[70] bg-black/40 flex items-end sm:items-center justify-center">
          <div className="bg-white w-full sm:max-w-sm rounded-t-3xl sm:rounded-3xl p-5">
            <p className="text-base font-bold text-slate-800 mb-0.5">Correct Date / Route</p>
            <p className="text-xs text-slate-400 mb-4 truncate">{editOrder.shop_name}</p>

            <label className="block text-xs font-semibold text-slate-600 mb-1">Order Date</label>
            <input
              type="date"
              value={editDate}
              onChange={(e) => setEditDate(e.target.value)}
              className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm mb-3 focus:outline-none focus:ring-2 focus:ring-brand-400"
            />

            <label className="block text-xs font-semibold text-slate-600 mb-1">Route</label>
            <input
              type="text"
              value={editRoute}
              onChange={(e) => setEditRoute(e.target.value)}
              placeholder="e.g. STD : KOLLAM"
              className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm mb-4 focus:outline-none focus:ring-2 focus:ring-brand-400"
            />

            {editError && <p className="text-xs text-red-600 mb-3 leading-snug">{editError}</p>}

            <div className="flex gap-2">
              <button
                onClick={() => { setEditOrder(null); setEditError('') }}
                disabled={editBusy}
                className="flex-1 rounded-xl border border-slate-200 py-3 font-semibold text-slate-600 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                disabled={editBusy || !editDate}
                onClick={async () => {
                  setEditBusy(true); setEditError('')
                  try {
                    const origDate = editOrder.order_date || editOrder.created_at?.slice(0, 10)
                    const origRoute = editOrder.route || ''
                    const newDate  = editDate !== origDate  ? editDate  : undefined
                    const newRoute = editRoute !== origRoute ? editRoute : undefined
                    if (!newDate && newRoute == null) { setEditOrder(null); return }
                    await updateOrderDateRoute(editOrder.id, { newDate, newRoute })
                    setEditOrder(null)
                    await refresh()
                  } catch (e) {
                    setEditError(e?.message || 'Could not update the order. Try again.')
                  } finally {
                    setEditBusy(false)
                  }
                }}
                className="flex-1 rounded-xl bg-brand-600 text-white py-3 font-bold active:bg-brand-700 disabled:opacity-50"
              >
                {editBusy ? 'Saving…' : 'Save Changes'}
              </button>
            </div>
          </div>
        </div>
      )}

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
