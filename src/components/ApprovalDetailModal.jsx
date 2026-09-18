import { useState, useEffect, useCallback, useRef } from 'react'
import { useAuth } from '../context/AuthContext.jsx'
import { loadMyApprovalItems, loadMyApprovalSummary, resubmitRejectedItem, removeRejectedItemFromOrder, currentUserId } from '../utils/cloudSync.js'
import { supabase } from '../utils/supabase.js'
import { CloseIcon } from './Icons.jsx'

const rupee = (n) => n != null ? `₹${Number(n).toLocaleString('en-IN')}` : '—'

function fmtDateTime(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true,
    timeZone: 'Asia/Kolkata'
  })
}

const STATUS_META = {
  pending:  { label: 'Pending',  badge: 'bg-amber-100 text-amber-800', icon: '🟠' },
  approved: { label: 'Approved', badge: 'bg-green-100 text-green-800',  icon: '🟢' },
  rejected: { label: 'Rejected', badge: 'bg-red-100 text-red-800',     icon: '❌' },
}

const TABS = ['all', 'pending', 'approved', 'rejected']

/**
 * Full product-level approval detail modal for the Sales Rep.
 * Opened from the "Admin Approval Pending" stat card on My Performance.
 *
 * Shows ALL approval requests (pending/approved/rejected) with:
 * - Summary tiles at top (item counts by status)
 * - Tabs: ALL | PENDING | APPROVED | REJECTED
 * - Per-item approval history (attempts, reasons)
 * - Change Price & Resubmit for rejected items
 * - Remove Product for rejected items
 * - Realtime updates when Admin makes a decision
 */
export default function ApprovalDetailModal({ onClose }) {
  const { user, profile } = useAuth()
  const [uid, setUid]     = useState(null)
  const [orders, setOrders] = useState(null)
  const [summary, setSummary] = useState({ pending: 0, approved: 0, rejected: 0 })
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState('')
  const [activeTab, setActiveTab] = useState('pending') // start on PENDING tab
  const realtimeRef = useRef(null)

  // Resubmit flow
  const [resubmitItem,  setResubmitItem]  = useState(null)
  const [resubmitPrice, setResubmitPrice] = useState('')
  const [resubmitting,  setResubmitting]  = useState(false)
  const [resubmitError, setResubmitError] = useState('')

  // Remove flow
  const [removeItem,  setRemoveItem]  = useState(null)
  const [removing,    setRemoving]    = useState(false)
  const [removeError, setRemoveError] = useState('')

  const reload = useCallback(async (id) => {
    if (!id) return
    setLoading(true)
    setError('')
    try {
      const [data, summ] = await Promise.all([
        loadMyApprovalItems({ salesRepId: id }),
        loadMyApprovalSummary({ salesRepId: id })
      ])
      setOrders(data)
      setSummary(summ)
    } catch (e) {
      console.error('[ApprovalDetailModal] load failed', e)
      setError('Could not load approval details. Try again.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const id = (await currentUserId()) || user?.id
      if (!cancelled) setUid(id)
      await reload(id)

      // Realtime: listen for any order_items change for this rep's orders.
      // When Admin approves/rejects, we refresh automatically so the rep
      // sees the updated status without manual refresh.
      if (realtimeRef.current) supabase.removeChannel(realtimeRef.current)
      const channel = supabase
        .channel(`approval_detail_${id}`)
        .on(
          'postgres_changes',
          { event: 'UPDATE', schema: 'public', table: 'order_items' },
          () => { if (!cancelled) reload(id) }
        )
        .on(
          'postgres_changes',
          { event: 'UPDATE', schema: 'public', table: 'orders' },
          () => { if (!cancelled) reload(id) }
        )
        .subscribe()
      if (!cancelled) realtimeRef.current = channel
    })()
    return () => {
      cancelled = true
      if (realtimeRef.current) {
        supabase.removeChannel(realtimeRef.current)
        realtimeRef.current = null
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])

  // ── Resubmit flow ──────────────────────────────────────────────────────────
  const openResubmit = (item) => {
    setResubmitItem(item)
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
      await resubmitRejectedItem(resubmitItem.id, price, profile?.full_name, uid)
      closeResubmit()
      await reload(uid)
      setActiveTab('pending') // jump to pending so they see the resubmit
    } catch (e) {
      console.error('[resubmit]', e)
      setResubmitError('Could not resubmit. Try again.')
    } finally {
      setResubmitting(false)
    }
  }

  // ── Remove flow ─────────────────────────────────────────────────────────────
  const openRemove  = (item) => { setRemoveItem(item); setRemoveError('') }
  const closeRemove = () => { setRemoveItem(null); setRemoveError('') }

  const confirmRemove = async () => {
    if (!removeItem) return
    setRemoving(true)
    setRemoveError('')
    try {
      await removeRejectedItemFromOrder(removeItem.id, uid)
      closeRemove()
      await reload(uid)
    } catch (e) {
      console.error('[remove item]', e)
      setRemoveError('Could not remove product. Try again.')
    } finally {
      setRemoving(false)
    }
  }

  // ── Tab filtering ──────────────────────────────────────────────────────────
  // Flatten all items across all orders for tab counting
  const allItems = (orders || []).flatMap((o) =>
    o.items.map((it) => ({ ...it, _shopName: o.shop_name, _route: o.route, _orderDate: o.order_date, _orderId: o.id, _billStatus: o.bill_approval_status }))
  )
  const tabCounts = {
    all:      allItems.length,
    pending:  allItems.filter((i) => i.approval_status === 'pending').length,
    approved: allItems.filter((i) => i.approval_status === 'approved').length,
    rejected: allItems.filter((i) => i.approval_status === 'rejected').length,
  }

  // Filter orders for the active tab — an order shows if it has at least
  // one item matching the tab filter.
  // allItems (unfiltered) goes in _allItems so OrderApprovalCard header badges
  // can show counts across ALL statuses regardless of the active tab.
  const visibleOrders = (orders || []).map((order) => ({
    ...order,
    _allItems: order.items,   // full list — for header badge counts
    items: activeTab === 'all'
      ? order.items
      : order.items.filter((it) => it.approval_status === activeTab)
  })).filter((o) => o.items.length > 0)

  // ── Resubmit dialog ────────────────────────────────────────────────────────
  if (resubmitItem) {
    return (
      <div className="fixed inset-0 z-[80] bg-black/40 flex items-end sm:items-center justify-center">
        <div className="bg-white w-full sm:max-w-sm rounded-t-3xl sm:rounded-3xl p-5">
          <h2 className="font-bold text-slate-800 mb-1">Change Price &amp; Resubmit</h2>
          <p className="text-sm text-slate-600 mb-3">{resubmitItem.product_name}</p>

          {/* Rejection reason */}
          {(resubmitItem.rejection_reason || resubmitItem.approval_reason) && (
            <div className="rounded-xl bg-red-50 border border-red-100 px-3 py-2.5 mb-3">
              <p className="text-xs font-semibold text-red-700 mb-0.5">Admin Rejection Reason</p>
              <p className="text-xs text-red-700">{resubmitItem.rejection_reason || resubmitItem.approval_reason}</p>
            </div>
          )}

          {/* Price context */}
          <div className="rounded-xl bg-slate-50 border border-slate-100 px-3 py-2.5 mb-3">
            <div className="flex justify-between text-xs">
              <span className="text-slate-500">Normal Price</span>
              <span className="font-semibold text-slate-700">{rupee(resubmitItem.normal_price)}</span>
            </div>
            <div className="flex justify-between text-xs mt-1">
              <span className="text-slate-500">Your Previous Price</span>
              <span className="font-semibold text-red-700">{rupee(resubmitItem.unit_price)}</span>
            </div>
          </div>

          <label className="block text-xs font-semibold text-slate-600 mb-1.5">New Selling Price (₹)</label>
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
          <p className="text-[11px] text-slate-400 mb-4">
            This resubmits the item at the new price. Admin will see it as Pending again.
            The original order is not duplicated.
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
              {resubmitting ? 'Resubmitting…' : 'Resubmit for Approval'}
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ── Remove confirm dialog ──────────────────────────────────────────────────
  if (removeItem) {
    return (
      <div className="fixed inset-0 z-[80] bg-black/40 flex items-end sm:items-center justify-center">
        <div className="bg-white w-full sm:max-w-sm rounded-t-3xl sm:rounded-3xl p-5">
          <h2 className="font-bold text-slate-800 mb-1">Remove Product?</h2>
          <p className="text-sm text-slate-500 mb-3">
            <span className="font-semibold text-slate-700">{removeItem.product_name}</span> will be permanently
            removed from this order. The remaining approved products will continue to Billing.
          </p>
          {(removeItem.rejection_reason || removeItem.approval_reason) && (
            <div className="rounded-xl bg-red-50 border border-red-100 px-3 py-2 mb-3">
              <p className="text-xs text-red-700"><span className="font-semibold">Rejection reason:</span> {removeItem.rejection_reason || removeItem.approval_reason}</p>
            </div>
          )}
          <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 mb-4">
            ⚠️ This cannot be undone.
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
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100 shrink-0">
          <h2 className="font-bold text-slate-800">Admin Approval</h2>
          <button onClick={onClose} className="p-2 text-slate-400" aria-label="Close">
            <CloseIcon className="h-5 w-5" />
          </button>
        </div>

        {/* Summary tiles */}
        {!loading && !error && (
          <div className="grid grid-cols-3 gap-2 px-4 py-3 border-b border-slate-100 shrink-0">
            <button
              onClick={() => setActiveTab('pending')}
              className={`rounded-xl p-2.5 text-center transition-colors ${activeTab === 'pending' ? 'bg-amber-100 ring-2 ring-amber-400' : 'bg-amber-50 hover:bg-amber-100'}`}
            >
              <p className="text-xl font-bold text-amber-700">{summary.pending}</p>
              <p className="text-[10px] font-semibold text-amber-700 uppercase tracking-wide">Pending</p>
            </button>
            <button
              onClick={() => setActiveTab('approved')}
              className={`rounded-xl p-2.5 text-center transition-colors ${activeTab === 'approved' ? 'bg-green-100 ring-2 ring-green-400' : 'bg-green-50 hover:bg-green-100'}`}
            >
              <p className="text-xl font-bold text-green-700">{summary.approved}</p>
              <p className="text-[10px] font-semibold text-green-700 uppercase tracking-wide">Approved</p>
            </button>
            <button
              onClick={() => setActiveTab('rejected')}
              className={`rounded-xl p-2.5 text-center transition-colors ${activeTab === 'rejected' ? 'bg-red-100 ring-2 ring-red-400' : 'bg-red-50 hover:bg-red-100'}`}
            >
              <p className="text-xl font-bold text-red-700">{summary.rejected}</p>
              <p className="text-[10px] font-semibold text-red-700 uppercase tracking-wide">Rejected</p>
            </button>
          </div>
        )}

        {/* Tabs */}
        <div className="flex border-b border-slate-100 shrink-0 px-2">
          {TABS.map((tab) => {
            const count = tabCounts[tab] ?? 0
            const isActive = activeTab === tab
            return (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`flex-1 py-2.5 text-xs font-semibold capitalize transition-colors relative ${
                  isActive ? 'text-brand-700' : 'text-slate-400 hover:text-slate-600'
                }`}
              >
                {tab} {count > 0 && <span className="text-[9px] opacity-70">({count})</span>}
                {isActive && <span className="absolute bottom-0 left-1 right-1 h-0.5 bg-brand-600 rounded-full" />}
              </button>
            )
          })}
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
          {!loading && !error && visibleOrders.length === 0 && (
            <div className="py-12 text-center">
              <p className="text-3xl mb-2">
                {activeTab === 'approved' ? '✅' : activeTab === 'rejected' ? '👍' : '✅'}
              </p>
              <p className="text-sm font-semibold text-slate-700">
                {activeTab === 'pending'  && 'No items waiting for approval'}
                {activeTab === 'approved' && 'No approved items yet'}
                {activeTab === 'rejected' && 'No rejected items'}
                {activeTab === 'all'      && 'No approval records found'}
              </p>
              {activeTab === 'pending' && (
                <p className="text-xs text-slate-400 mt-1">All your orders are cleared for Billing.</p>
              )}
            </div>
          )}

          {!loading && !error && visibleOrders.map((order) => (
            <OrderApprovalCard
              key={order.id}
              order={order}
              activeTab={activeTab}
              onResubmit={openResubmit}
              onRemove={openRemove}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

// ── Per-order card ────────────────────────────────────────────────────────────
function OrderApprovalCard({ order, activeTab, onResubmit, onRemove }) {
  // Header badge counts use _allItems (all approval items for this order,
  // regardless of active tab) so the "2 pending / 1 rejected" summary always
  // shows the full picture even when the tab is filtering to just one status.
  // _allItems is set by the visibleOrders mapping in the parent component.
  const allOrderItems = (order._allItems || order.items || [])
  const pendingCount  = allOrderItems.filter((i) => i.approval_status === 'pending').length
  const approvedCount = allOrderItems.filter((i) => i.approval_status === 'approved').length
  const rejectedCount = allOrderItems.filter((i) => i.approval_status === 'rejected').length

  return (
    <div className="mb-4 rounded-2xl border border-slate-100 overflow-hidden">
      {/* Order header */}
      <div className="bg-slate-50 px-4 py-2.5 flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="font-bold text-sm text-slate-800 truncate">{order.shop_name}</p>
          <p className="text-[11px] text-slate-400">{order.route} · {order.order_date}</p>
          <div className="flex gap-2 mt-1">
            {pendingCount  > 0 && <span className="text-[9px] font-bold text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded-full">{pendingCount} pending</span>}
            {approvedCount > 0 && <span className="text-[9px] font-bold text-green-700 bg-green-100 px-1.5 py-0.5 rounded-full">{approvedCount} approved</span>}
            {rejectedCount > 0 && <span className="text-[9px] font-bold text-red-700 bg-red-100 px-1.5 py-0.5 rounded-full">{rejectedCount} rejected</span>}
          </div>
        </div>
        <div className="shrink-0 text-right">
          {order.billing_status === 'pending' && order.bill_approval_status === 'approved' && (
            <span className="text-[9px] font-bold text-green-700 bg-green-100 px-2 py-0.5 rounded-full block">✅ Sent to Billing</span>
          )}
          {order.billing_status === 'pending_approval' && (
            <span className="text-[9px] font-bold text-amber-700 bg-amber-100 px-2 py-0.5 rounded-full block">⏳ With Admin</span>
          )}
        </div>
      </div>

      {/* Item rows */}
      <div className="divide-y divide-slate-50">
        {order.items.map((item) => (
          <ApprovalItemRow
            key={item.id}
            item={item}
            onResubmit={() => onResubmit(item)}
            onRemove={() => onRemove(item)}
          />
        ))}
      </div>
    </div>
  )
}

// ── Per-item row ──────────────────────────────────────────────────────────────
function ApprovalItemRow({ item, onResubmit, onRemove }) {
  const [showHistory, setShowHistory] = useState(false)
  const meta = STATUS_META[item.approval_status] || STATUS_META.pending
  const isRejected  = item.approval_status === 'rejected'
  const isApproved  = item.approval_status === 'approved'
  const rejReason   = item.rejection_reason || item.approval_reason_other_reason || item.approval_other_reason

  return (
    <div className="bg-white px-4 py-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-slate-800">{item.product_name}</p>
          <div className="text-[11px] text-slate-400 mt-0.5 flex flex-wrap gap-x-2">
            <span>Qty: {item.qty} {item.unit}</span>
            <span>Normal: {rupee(item.normal_price)}</span>
            <span className={isRejected ? 'text-red-600 font-semibold' : ''}>
              Requested: {rupee(item.unit_price)}
            </span>
            {isApproved && item.approved_price != null && (
              <span className="text-green-700 font-semibold">Approved at: {rupee(item.approved_price)}</span>
            )}
          </div>

          {/* Timestamps */}
          {item.approved_at && (
            <p className="text-[10px] text-slate-400 mt-0.5">
              {isApproved ? '✅ Approved' : isRejected ? '❌ Rejected' : 'Decided'}: {fmtDateTime(item.approved_at)}
              {item.approved_by ? ` by ${item.approved_by}` : ''}
            </p>
          )}

          {/* Rejection reason */}
          {isRejected && rejReason && (
            <div className="mt-1.5 rounded-lg bg-red-50 border border-red-100 px-2.5 py-1.5">
              <p className="text-[11px] text-red-700">
                <span className="font-semibold">Reason: </span>{rejReason}
              </p>
            </div>
          )}
          {isRejected && item.approval_reason_type && (
            <p className="text-[10px] text-red-500 mt-0.5">Type: {item.approval_reason_type}</p>
          )}

          {/* Competitor info if applicable */}
          {isApproved && item.approval_competitor_name && (
            <p className="text-[10px] text-slate-400 mt-0.5">Approved due to competitor: {item.approval_competitor_name}</p>
          )}
        </div>

        {/* Status badge */}
        <div className="shrink-0 flex flex-col items-end gap-1">
          <span className={`text-[9px] font-bold px-2 py-0.5 rounded-full ${meta.badge}`}>
            {meta.icon} {meta.label}
          </span>
          {(item.history || []).length > 1 && (
            <button
              onClick={() => setShowHistory((v) => !v)}
              className="text-[9px] text-brand-600 underline"
            >
              {showHistory ? 'Hide' : `History (${item.history.length})`}
            </button>
          )}
        </div>
      </div>

      {/* Approval History — multiple attempts */}
      {showHistory && (item.history || []).length > 0 && (
        <div className="mt-2 rounded-xl bg-slate-50 border border-slate-100 px-3 py-2 space-y-1.5">
          <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide">Approval History</p>
          {item.history.map((h, idx) => (
            <div key={idx} className="text-[11px]">
              <span className="font-semibold text-slate-600">
                Attempt {idx + 1}:
              </span>{' '}
              <span className={h.decision === 'approved' ? 'text-green-700' : h.decision === 'rejected' ? 'text-red-600' : 'text-amber-700'}>
                {rupee(h.requested_price)}
                {h.approved_price != null && h.decision === 'approved' ? ` → approved at ${rupee(h.approved_price)}` : ''}
              </span>{' '}
              <span className="text-slate-400">· {fmtDateTime(h.decided_at)}</span>
              {h.rejection_reason && (
                <p className="text-red-600 text-[10px] ml-12">↳ {h.rejection_reason}</p>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Action buttons — only for rejected items */}
      {isRejected && (
        <div className="mt-2.5 flex gap-2">
          <button
            onClick={onResubmit}
            className="flex-1 rounded-xl border border-brand-300 bg-brand-50 py-2.5 text-xs font-bold text-brand-700 active:bg-brand-100"
          >
            ✏️ Change Price &amp; Resubmit
          </button>
          <button
            onClick={onRemove}
            className="flex-1 rounded-xl border border-red-200 bg-red-50 py-2.5 text-xs font-bold text-red-700 active:bg-red-100"
          >
            🗑 Remove Product
          </button>
        </div>
      )}

      {/* Pending — show submitted timestamp */}
      {item.approval_status === 'pending' && (
        <p className="text-[10px] text-amber-600 mt-1.5">🟠 Waiting for Admin to review</p>
      )}
    </div>
  )
}
