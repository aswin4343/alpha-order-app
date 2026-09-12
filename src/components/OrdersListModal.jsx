import { useEffect, useState } from 'react'
import { loadOrdersList, deleteOwnOrder, updateOrderDateRoute, listAllRoutes } from '../utils/cloudSync.js'
import { CloseIcon, ThumbsUpIcon, ClockIcon } from './Icons.jsx'
import OrderSummaryModal from './OrderSummaryModal.jsx'
import AddOnFlowModal from './AddOnFlowModal.jsx'

function fmtDate(iso) {
  try { return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) } catch { return '' }
}
function fmtTime(iso) {
  try { return new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true }) } catch { return '' }
}
const rupee = (n) => `\u20B9${Number(n || 0).toLocaleString('en-IN')}`

export default function OrdersListModal({ userId, start, end, route, periodLabel, onClose, onEditOrder }) {
  const [orders, setOrders] = useState(null)
  const [error, setError] = useState(false)
  const [openOrderIds, setOpenOrderIds] = useState(null)
  const [confirmDelete, setConfirmDelete] = useState(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState('')
  const [addOnOrder, setAddOnOrder] = useState(null)
  const [editOrder, setEditOrder] = useState(null)
  const [editDate, setEditDate] = useState('')
  const [editRoute, setEditRoute] = useState('')
  const [editBusy, setEditBusy] = useState(false)
  const [editError, setEditError] = useState('')
  const [routeOptions, setRouteOptions] = useState([])
  const [statusFilter, setStatusFilter] = useState(null)

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
    if (!userId) { setOrders([]); setError(false); return }
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
    setDeleting(true); setDeleteError('')
    try {
      await deleteOwnOrder(confirmDelete.id)
      setConfirmDelete(null)
      await refresh()
    } catch (e) {
      console.error(e)
      setDeleteError(e?.message || 'Could not delete this order. Try again.')
    } finally {
      setDeleting(false)
    }
  }

  const openEdit = (o) => {
    setEditOrder(o)
    // Use IST-correct date for pre-fill so the picker shows the date the rep
    // actually sees on their calendar, not the UTC date from created_at.
    const toISTDate = (isoStr) => {
      try {
        return new Date(isoStr).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
      } catch { return isoStr?.slice(0, 10) || '' }
    }
    setEditDate(o.order_date || toISTDate(o.created_at) || '')
    setEditRoute(o.route || '')
    setEditError('')
    listAllRoutes().then(setRouteOptions).catch(() => {})
  }

  const onSaveEdit = async () => {
    setEditBusy(true); setEditError('')
    try {
      // Compute the order's current date in IST — the same calendar context
      // the rep sees and the date picker uses. created_at is a UTC timestamp;
      // slicing its first 10 chars gives the UTC date, not the IST date.
      // e.g. "2026-09-11T00:15:00Z" sliced = "2026-09-11" (UTC) but in IST
      // (UTC+5:30) that is still Sep 11 — however "2026-09-10T20:00:00Z"
      // sliced = "2026-09-10" (UTC) while in IST it is already Sep 11.
      // Using toLocaleDateString with IST timezone gives the correct IST date
      // and prevents a false "no change" match when the user selects today.
      const toISTDate = (isoStr) => {
        try {
          return new Date(isoStr).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
        } catch { return isoStr?.slice(0, 10) || '' }
      }
      const origDate  = editOrder.order_date || toISTDate(editOrder.created_at)
      const origRoute = editOrder.route || ''
      const newDate   = editDate  !== origDate  ? editDate  : undefined
      const newRoute  = editRoute !== origRoute ? editRoute : undefined
      if (!newDate && newRoute == null) { setEditOrder(null); return }
      await updateOrderDateRoute(editOrder.id, { newDate, newRoute })
      setEditOrder(null)
      await refresh()
    } catch (e) {
      setEditError(e?.message || 'Could not update the order. Try again.')
    } finally {
      setEditBusy(false)
    }
  }

  const OrderCard = ({ o, inFilteredList }) => {
    const canDelete = o.billing_status === 'pending'  // delete only for pending
    const canEdit   = true   // edit allowed on both pending AND verified orders
    const canAddon  = true   // add-on allowed on both pending AND verified orders
    return (
      <div className="w-full rounded-2xl border border-slate-200 mb-2.5 p-3 flex items-start gap-2">
        <button
          onClick={() => {
            if (inFilteredList) setStatusFilter(null)
            setOpenOrderIds(o.orderIds && o.orderIds.length ? o.orderIds : [o.id])
          }}
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
              <ThumbsUpIcon className="h-4 w-4 text-green-600 shrink-0" aria-label="Verified" />
            ) : (
              <ClockIcon className="h-4 w-4 text-amber-500 shrink-0" aria-label="Pending" />
            )}
          </div>
          <p className="text-[11px] text-slate-400 mt-0.5">
            {o.total_products} products &middot; {o.total_quantity} qty &middot; {fmtDate(o.created_at)}, {fmtTime(o.created_at)}
          </p>
        </button>
        {!inFilteredList && (
          <div className="shrink-0 flex flex-col gap-1.5 items-center">
            <button
              onClick={() => setAddOnOrder(o)}
              className="h-8 px-2.5 rounded-lg flex items-center justify-center text-[11px] font-bold text-brand-700 bg-brand-50 active:bg-brand-100"
              title="Add products to this order"
            >
              + ADD-ON
            </button>
            {/* Edit allowed on all orders; Delete only for pending */}
            <>
              <button
                onClick={() => openEdit(o)}
                className="h-8 w-8 rounded-lg flex items-center justify-center text-slate-500 active:bg-slate-100"
                title="Edit date / route"
              >
                &#9999;&#65039;
              </button>
              {canDelete && (
                <button
                  onClick={() => setConfirmDelete(o)}
                  className="h-8 w-8 rounded-lg flex items-center justify-center text-red-500 active:bg-red-50"
                  title="Delete this order"
                >
                  &#128465;
                </button>
              )}
            </>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-[60] bg-black/40 flex items-end sm:items-center justify-center">
      <div className="relative bg-white w-full sm:max-w-md rounded-t-3xl sm:rounded-3xl max-h-[85vh] flex flex-col">

        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100 shrink-0">
          <div className="min-w-0">
            <h2 className="font-bold text-slate-800">Orders Taken</h2>
            <p className="text-xs text-slate-400">{periodLabel}</p>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              onClick={() => orders && setStatusFilter('pending')}
              disabled={!orders}
              className="flex items-center gap-1 px-2 py-1 rounded-lg bg-amber-50 border border-amber-200 active:bg-amber-100 disabled:opacity-40"
            >
              <ClockIcon className="h-3.5 w-3.5 text-amber-500 shrink-0" />
              <span className="text-[11px] font-bold text-amber-700">{orders ? pendingOrders.length : '-'}</span>
            </button>
            <button
              onClick={() => orders && setStatusFilter('verified')}
              disabled={!orders}
              className="flex items-center gap-1 px-2 py-1 rounded-lg bg-green-50 border border-green-200 active:bg-green-100 disabled:opacity-40"
            >
              <ThumbsUpIcon className="h-3.5 w-3.5 text-green-600 shrink-0" />
              <span className="text-[11px] font-bold text-green-700">{orders ? verifiedOrders.length : '-'}</span>
            </button>
            <button onClick={onClose} className="p-2 text-slate-400 ml-0.5">
              <CloseIcon className="h-5 w-5" />
            </button>
          </div>
        </div>

        {/* Filtered sub-list overlay */}
        {filteredOrders && (
          <div className="absolute inset-0 z-10 bg-white rounded-t-3xl sm:rounded-3xl flex flex-col">
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100 shrink-0">
              <div>
                <h2 className="font-bold text-slate-800">
                  {statusFilter === 'pending' ? 'Pending' : 'Verified'} Orders
                  <span className="ml-1.5 text-xs font-semibold text-slate-400">({filteredOrders.length})</span>
                </h2>
                <p className="text-xs text-slate-400">{periodLabel}</p>
              </div>
              <button onClick={() => setStatusFilter(null)} className="p-2 text-slate-400">
                <CloseIcon className="h-5 w-5" />
              </button>
            </div>
            <div className="overflow-y-auto flex-1 px-4 py-3">
              {filteredOrders.length === 0 && (
                <p className="py-10 text-center text-sm text-slate-400">No {statusFilter} orders for this period.</p>
              )}
              {filteredOrders.map((o) => <OrderCard key={o.id} o={o} inFilteredList />)}
            </div>
          </div>
        )}

        {/* Main list */}
        <div className="overflow-y-auto flex-1 px-4 py-3">
          {orders === null && (
            <div className="py-10 flex justify-center">
              <div className="h-8 w-8 rounded-full border-4 border-brand-100 border-t-brand-600 animate-spin" />
            </div>
          )}
          {error && <p className="py-6 text-center text-sm text-red-500">Could not load orders.</p>}
          {orders && orders.length === 0 && !error && (
            <p className="py-10 text-center text-sm text-slate-400">No orders taken for this period.</p>
          )}
          {orders && orders.map((o) => <OrderCard key={o.id} o={o} inFilteredList={false} />)}
        </div>

      </div>

      {/* Order Summary modal */}
      {openOrderIds && (
        <OrderSummaryModal
          orderId={openOrderIds}
          onClose={() => setOpenOrderIds(null)}
          onEdit={onEditOrder ? (order) => {
            setOpenOrderIds(null)
            onEditOrder(order)
          } : undefined}
        />
      )}

      {/* Add-on modal */}
      {addOnOrder && (
        <AddOnFlowModal
          order={addOnOrder}
          userId={userId}
          onClose={() => setAddOnOrder(null)}
          onSaved={refresh}
        />
      )}

      {/* Edit date/route modal */}
      {editOrder && (
        <div className="fixed inset-0 z-[70] bg-black/40 flex items-end sm:items-center justify-center">
          <div className="bg-white w-full sm:max-w-sm rounded-t-3xl sm:rounded-3xl p-5">
            <p className="text-base font-bold text-slate-800 mb-0.5">Correct Date / Route</p>
            <p className="text-xs text-slate-400 mb-4 truncate">{editOrder.shop_name}</p>
            <label className="block text-xs font-semibold text-slate-600 mb-1">Order Date</label>
            <input type="date" value={editDate} onChange={(e) => setEditDate(e.target.value)}
              className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm mb-3 focus:outline-none focus:ring-2 focus:ring-brand-400" />
            <label className="block text-xs font-semibold text-slate-600 mb-1">Route</label>
            <select value={editRoute} onChange={(e) => setEditRoute(e.target.value)}
              className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm mb-4 focus:outline-none focus:ring-2 focus:ring-brand-400 bg-white">
              {/* Keep the current route as an option even if not in the list */}
              {editRoute && !routeOptions.includes(editRoute) && (
                <option value={editRoute}>{editRoute}</option>
              )}
              {routeOptions.map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
            {editError && <p className="text-xs text-red-600 mb-3 leading-snug">{editError}</p>}
            <div className="flex gap-2">
              <button onClick={() => { setEditOrder(null); setEditError('') }} disabled={editBusy}
                className="flex-1 rounded-xl border border-slate-200 py-3 font-semibold text-slate-600 disabled:opacity-50">
                Cancel
              </button>
              <button onClick={onSaveEdit} disabled={editBusy || !editDate}
                className="flex-1 rounded-xl bg-brand-600 text-white py-3 font-bold active:bg-brand-700 disabled:opacity-50">
                {editBusy ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirm delete modal */}
      {confirmDelete && (
        <div className="fixed inset-0 z-[70] bg-black/40 flex items-end sm:items-center justify-center">
          <div className="bg-white w-full sm:max-w-sm rounded-t-3xl sm:rounded-3xl p-5">
            <p className="text-lg font-bold text-red-700 mb-1">Delete this bill?</p>
            <p className="text-sm text-slate-500 mb-4">
              <b>{confirmDelete.shop_name}</b> &mdash; {rupee(confirmDelete.total_value)} will be marked as
              Deleted Bill and will no longer count as an active order in your performance.
            </p>
            {deleteError && <p className="text-xs text-red-600 mb-2">{deleteError}</p>}
            <div className="flex gap-2">
              <button onClick={() => setConfirmDelete(null)} disabled={deleting}
                className="flex-1 rounded-xl border border-slate-200 py-3 font-semibold text-slate-600 disabled:opacity-50">
                Cancel
              </button>
              <button onClick={onConfirmDelete} disabled={deleting}
                className="flex-1 rounded-xl bg-red-600 text-white py-3 font-bold active:bg-red-700 disabled:opacity-50">
                {deleting ? 'Deleting...' : 'Delete Bill'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}