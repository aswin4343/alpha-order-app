import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '../context/AuthContext.jsx'
import { loadMyApprovalItems, resubmitRejectedItem, removeRejectedItemFromOrder, currentUserId } from '../utils/cloudSync.js'
import { CloseIcon } from './Icons.jsx'

const rupee = (n) => n != null ? `₹${Number(n).toLocaleString('en-IN')}` : '—'

const STATUS_LABEL = {
  pending:  { text: 'Pending',  cls: 'bg-amber-100 text-amber-800' },
  approved: { text: 'Approved', cls: 'bg-green-100 text-green-800' },
  rejected: { text: 'Rejected', cls: 'bg-red-100 text-red-800' },
}

/**
 * Full product-level approval detail modal for the Sales Rep.
 * Opened from the "Admin Approval Pending" stat card on My Performance.
 *
 * Shows every order that is awaiting (or has had) Admin price approval,
 * with each affected product line, its status, and — for rejected lines —
 * the ability to either:
 *   A) Change Price & Resubmit  →  resubmits to Admin queue at new price
 *   B) Remove Product           →  permanently excludes from the bill;
 *                                  if all remaining items then become approved,
 *                                  the bill releases to Billing automatically
 */
export default function ApprovalDetailModal({ onClose }) {
  const { user, profile } = useAuth()
  const [uid, setUid]     = useState(null)
  const [orders, setOrders] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState('')

  // For the resubmit flow: which itemId is being edited, and what price
  const [resubmitItem,  setResubmitItem]  = useState(null)  // { item, orderId }
  const [resubmitPrice, setResubmitPrice] = useState('')
  const [resubmitting,  setResubmitting]  = useState(false)
  const [resubmitError, setResubmitError] = useState('')

  // For the remove-product confirm flow
  const [removeItem,    setRemoveItem]    = useState(null)   // { item, orderId }
  const [removing,      setRemoving]      = useState(false)
  const [removeError,   setRemoveError]   = useState('')

  const reload = useCallback(async (id) => {
    if (!id) return
    setLoading(true)
    setError('')
    try {
      const data = await loadMyApprovalItems({ salesRepId: id })
      setOrders(data)
    } catch (e) {
      console.error('[ApprovalDetailModal] load failed', e)
      setError('Could not load approval details. Try again.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    ;(async () => {
      const id = (await currentUserId()) || user?.id
      setUid(id)
      await reload(id)
    })()
  }, [user, reload])

  // ── Resubmit flow ──────────────────────────────────────────────────────────
  const openResubmit = (item, orderId) => {
    setResubmitItem({ item, orderId })
    setResubmitPrice(String(item.unit_price ?? ''))
    setResubmitError('')
  }
  const closeResubmit = () => { setResubmitItem(null); setResubmitPrice(''); setResubmitError('') }

  const confirmResubmit = async () => {
    const price = parseFloat(resubmitPrice)
    if (!resubmitItem || isNaN(price) || price <= 0) {
      setResubmitError('Enter a valid price.')
      return
    }
    setResubmitting(true)
    setResubmitError('')
    try {
      await resubmitRejectedItem(resubmitItem.item.id, price, profile?.full_name, uid)
      closeResubmit()
      await reload(uid)
    } catch (e) {
      console.error('[resubmit] failed', e)
      setResubmitError('Could not resubmit. Try again.')
    } finally {
      setResubmitting(false)
    }
  }

  // ── Remove flow ─────────────────────────────────────────────────────────────
  const openRemove = (item, orderId) => {
    setRemoveItem({ item, orderId })
    setRemoveError('')
  }
  const closeRemove = () => { setRemoveItem(null); setRemoveError('') }

  const confirmRemove = async () => {
    if (!removeItem) return
    setRemoving(true)
    setRemoveError('')
    try {
      await removeRejectedItemFromOrder(removeItem.item.id, uid)
      closeRemove()
      await reload(uid)
    } catch (e) {
      console.error('[remove item] failed', e)
      setRemoveError('Could not remove product. Try again.')
    } finally {
      setRemoving(false)
    }
  }

  // ── Render helpers ─────────────────────────────────────────────────────────
  const pendingCount   = (orders || []).reduce((s, o) => s + o.items.filter((i) => i.approval_status === 'pending').length, 0)
  const rejectedCount  = (orders || []).reduce((s, o) => s + o.items.filter((i) => i.approval_status === 'rejected').length, 0)

  // ── Resubmit dialog ────────────────────────────────────────────────────────
  if (resubmitItem) {
    const { item } = resubmitItem
    return (
      <div className="fixed inset-0 z-[80] bg-black/40 flex items-end sm:items-center justify-center">
        <div className="bg-white w-full sm:max-w-sm rounded-t-3xl sm:rounded-3xl p-5">
          <h2 className="font-bold text-slate-800 mb-1">Change Price &amp; Resubmit</h2>
          <p className="text-sm text-slate-500 mb-1">{item.product_name}</p>
          {item.approval_reason && (
            <div className="rounded-lg bg-red-50 border border-red-100 px-3 py-2 mb-3">
              <p className="text-xs text-red-700"><span className="font-semibold">Rejection reason:</span> {item.approval_reason}</p>
            </div>
          )}
          <div className="mb-1">
            <p className="text-xs text-slate-400 mb-0.5">
              Normal price: {rupee(item.normal_price)} &nbsp;·&nbsp; Your price: {rupee(item.unit_price)}
            </p>
          </div>
          <label className="block text-xs font-semibold text-slate-600 mb-1">New Price (₹)</label>
          <input
            type="number"
            inputMode="decimal"
            value={resubmitPrice}
            onChange={(e) => setResubmitPrice(e.target.value)}
            className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-brand-500 mb-1"
            placeholder="Enter corrected price"
            autoFocus
          />
          {resubmitError && <p className="text-xs text-red-600 mb-2">{resubmitError}</p>}
          <p className="text-[11px] text-slate-400 mb-3">
            This will resubmit the line to Admin for approval at the new price. The original order stays in Admin Pending until Admin approves the updated price.
          </p>
          <div className="flex gap-2">
            <button onClick={closeResubmit} className="flex-1 rounded-xl border border-slate-200 py-3 font-semibold text-slate-600">
              Cancel
            </button>
            <button
              onClick={confirmResubmit}
              disabled={resubmitting}
              className="flex-1 rounded-xl bg-brand-600 text-white py-3 font-bold disabled:opacity-50"
            >
              {resubmitting ? 'Resubmitting…' : 'Resubmit'}
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ── Remove confirm dialog ──────────────────────────────────────────────────
  if (removeItem) {
    const { item } = removeItem
    return (
      <div className="fixed inset-0 z-[80] bg-black/40 flex items-end sm:items-center justify-center">
        <div className="bg-white w-full sm:max-w-sm rounded-t-3xl sm:rounded-3xl p-5">
          <h2 className="font-bold text-slate-800 mb-1">Remove Product?</h2>
          <p className="text-sm text-slate-500 mb-3">
            <span className="font-semibold text-slate-700">{item.product_name}</span> will be permanently removed from this order.
            The remaining valid products will proceed to Billing.
          </p>
          {item.approval_reason && (
            <div className="rounded-lg bg-red-50 border border-red-100 px-3 py-2 mb-3">
              <p className="text-xs text-red-700"><span className="font-semibold">Rejection reason:</span> {item.approval_reason}</p>
            </div>
          )}
          <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-4">
            ⚠️ This cannot be undone. The product will not appear in Billing for this order.
          </p>
          {removeError && <p className="text-xs text-red-600 mb-2">{removeError}</p>}
          <div className="flex gap-2">
            <button onClick={closeRemove} className="flex-1 rounded-xl border border-slate-200 py-3 font-semibold text-slate-600">
              Cancel
            </button>
            <button
              onClick={confirmRemove}
              disabled={removing}
              className="flex-1 rounded-xl bg-red-600 text-white py-3 font-bold disabled:opacity-50"
            >
              {removing ? 'Removing…' : 'Remove Product'}
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ── Main modal ─────────────────────────────────────────────────────────────
  return (
    <div className="fixed inset-0 z-[70] bg-black/40 flex items-end sm:items-center justify-center">
      <div className="bg-white w-full sm:max-w-lg rounded-t-3xl sm:rounded-3xl max-h-[92vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100">
          <div className="min-w-0">
            <h2 className="font-bold text-slate-800">Admin Approval Pending</h2>
            <p className="text-xs text-slate-400">
              {pendingCount > 0 && `${pendingCount} awaiting review`}
              {pendingCount > 0 && rejectedCount > 0 && ' · '}
              {rejectedCount > 0 && `${rejectedCount} rejected`}
            </p>
          </div>
          <button onClick={onClose} className="p-2 text-slate-400" aria-label="Close">
            <CloseIcon className="h-5 w-5" />
          </button>
        </div>

        {/* Body */}
        <div className="overflow-y-auto flex-1 px-4 py-3">
          {loading && (
            <div className="py-12 flex justify-center">
              <div className="h-8 w-8 rounded-full border-4 border-brand-100 border-t-brand-600 animate-spin" />
            </div>
          )}
          {!loading && error && (
            <p className="text-center text-sm text-red-500 py-8">{error}</p>
          )}
          {!loading && !error && (orders || []).length === 0 && (
            <div className="py-12 text-center">
              <p className="text-2xl mb-2">✅</p>
              <p className="text-sm font-semibold text-slate-700">No pending approvals</p>
              <p className="text-xs text-slate-400 mt-1">All your orders are cleared for Billing.</p>
            </div>
          )}

          {!loading && !error && (orders || []).map((order) => {
            const pendingItems  = order.items.filter((i) => i.approval_status === 'pending')
            const approvedItems = order.items.filter((i) => i.approval_status === 'approved')
            const rejectedItems = order.items.filter((i) => i.approval_status === 'rejected')

            return (
              <div key={order.id} className="mb-4 rounded-2xl border border-slate-100 overflow-hidden">
                {/* Order header */}
                <div className="bg-slate-50 px-4 py-2.5 flex items-center justify-between">
                  <div className="min-w-0">
                    <p className="font-semibold text-sm text-slate-800 truncate">{order.shop_name}</p>
                    <p className="text-[11px] text-slate-400">{order.route} · {order.order_date}</p>
                  </div>
                  <div className="text-right shrink-0 ml-2">
                    {order.bill_approval_status === 'pending' && (
                      <span className="text-[9px] font-bold text-amber-700 bg-amber-100 px-2 py-0.5 rounded-full">⏳ Pending Admin</span>
                    )}
                    {order.bill_approval_status === 'rejected' && (
                      <span className="text-[9px] font-bold text-red-700 bg-red-100 px-2 py-0.5 rounded-full">❌ Action Required</span>
                    )}
                  </div>
                </div>

                {/* Summary bar */}
                <div className="px-4 py-1.5 bg-white flex gap-3 text-[11px] border-b border-slate-50">
                  {pendingItems.length  > 0 && <span className="text-amber-700 font-semibold">{pendingItems.length} pending</span>}
                  {approvedItems.length > 0 && <span className="text-green-700 font-semibold">{approvedItems.length} approved</span>}
                  {rejectedItems.length > 0 && <span className="text-red-700 font-semibold">{rejectedItems.length} rejected</span>}
                </div>

                {/* Item rows */}
                <div className="divide-y divide-slate-50">
                  {order.items.map((item) => {
                    const st = STATUS_LABEL[item.approval_status] || STATUS_LABEL.pending
                    const isRejected = item.approval_status === 'rejected'
                    return (
                      <div key={item.id} className="px-4 py-3 bg-white">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium text-slate-800">{item.product_name}</p>
                            <p className="text-[11px] text-slate-400 mt-0.5">
                              Qty: {item.qty} {item.unit} &nbsp;·&nbsp;
                              Your Price: {rupee(item.unit_price)} &nbsp;·&nbsp;
                              Normal: {rupee(item.normal_price)}
                            </p>
                            {item.approved_price != null && item.approval_status === 'approved' && (
                              <p className="text-[11px] text-green-700 mt-0.5">Approved Price: {rupee(item.approved_price)}</p>
                            )}
                            {isRejected && item.approval_reason && (
                              <div className="mt-1 rounded-lg bg-red-50 px-2 py-1">
                                <p className="text-[11px] text-red-700"><span className="font-semibold">Reason:</span> {item.approval_reason}</p>
                              </div>
                            )}
                          </div>
                          <span className={`shrink-0 text-[9px] font-bold px-2 py-0.5 rounded-full ${st.cls}`}>{st.text}</span>
                        </div>

                        {/* Action buttons — only for rejected items */}
                        {isRejected && (
                          <div className="mt-2 flex gap-2">
                            <button
                              onClick={() => openResubmit(item, order.id)}
                              className="flex-1 rounded-xl border border-brand-300 bg-brand-50 py-2 text-xs font-bold text-brand-700 active:bg-brand-100"
                            >
                              ✏️ Change Price &amp; Resubmit
                            </button>
                            <button
                              onClick={() => openRemove(item, order.id)}
                              className="flex-1 rounded-xl border border-red-200 bg-red-50 py-2 text-xs font-bold text-red-700 active:bg-red-100"
                            >
                              🗑 Remove Product
                            </button>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
