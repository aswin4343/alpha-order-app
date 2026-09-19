import { useState, useEffect, useCallback, useRef } from 'react'
import { useAuth } from '../context/AuthContext.jsx'
import { loadMyApprovalItems, loadMyApprovalSummary, resubmitRejectedOrder, currentUserId } from '../utils/cloudSync.js'
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
function fmtDate(iso) {
  if (!iso) return '—'
  return new Date(iso + 'T00:00:00').toLocaleDateString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric'
  })
}

const TABS = ['all', 'pending', 'approved', 'rejected']

/**
 * ORDER-LEVEL approval detail modal for the Sales Rep (v190).
 *
 * Shows approval orders grouped by their order-level status
 * (bill_approval_status on the orders table):
 *   - Pending: Admin is reviewing the full order
 *   - Approved: Admin approved — order went to Billing
 *   - Rejected: Admin rejected — rep can RESUBMIT FULL ORDER
 *
 * Resubmission opens ALL items (including normal-price ones) so the rep
 * can revise any/all prices and send the complete order back to Admin.
 * Each resubmission creates a new version (v1, v2, v3...).
 */
export default function ApprovalDetailModal({ onClose, dateFrom, dateTo }) {
  const { user, profile } = useAuth()
  const [uid, setUid]     = useState(null)
  const [orders, setOrders] = useState(null)
  const [summary, setSummary] = useState({ pending: 0, approved: 0, rejected: 0 })
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState('')
  const [activeTab, setActiveTab] = useState('pending')
  const realtimeRef = useRef(null)

  // Resubmit flow — order-level
  const [resubmitOrder, setResubmitOrder] = useState(null)   // the full order object
  const [newPrices,     setNewPrices]     = useState({})     // { [itemId]: newPrice string }
  const [resubmitting,  setResubmitting]  = useState(false)
  const [resubmitError, setResubmitError] = useState('')

  // dateFrom/dateTo come from the period picker in PerformancePage so the
  // modal shows the same date window as the stat card that was tapped.
  // When not provided (e.g. opened from elsewhere), falls back to 60-day default.
  const reload = useCallback(async (id) => {
    if (!id) return
    setLoading(true)
    setError('')
    try {
      const [data, summ] = await Promise.all([
        loadMyApprovalItems({ salesRepId: id, dateFrom, dateTo }),
        loadMyApprovalSummary({ salesRepId: id, dateFrom, dateTo })
      ])
      setOrders(data)
      setSummary(summ)
    } catch (e) {
      console.error('[ApprovalDetailModal] load failed', e)
      setError('Could not load approval details. Try again.')
    } finally {
      setLoading(false)
    }
  }, [dateFrom, dateTo])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const id = (await currentUserId()) || user?.id
      if (!cancelled) setUid(id)
      await reload(id)

      // Realtime: refresh when Admin makes a decision
      if (realtimeRef.current) supabase.removeChannel(realtimeRef.current)
      const channel = supabase
        .channel(`approval_detail_${id}`)
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'orders' },
          () => { if (!cancelled) reload(id) })
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'order_items' },
          () => { if (!cancelled) reload(id) })
        .subscribe()
      if (!cancelled) realtimeRef.current = channel
    })()
    return () => {
      cancelled = true
      if (realtimeRef.current) { supabase.removeChannel(realtimeRef.current); realtimeRef.current = null }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])

  // ── Open resubmit screen ──────────────────────────────────────────────────
  const openResubmit = (order) => {
    setResubmitOrder(order)
    // Pre-fill prices from current unit_price for each item
    const prices = {}
    for (const item of (order.items || [])) {
      prices[item.id] = String(item.unit_price ?? '')
    }
    setNewPrices(prices)
    setResubmitError('')
  }
  const closeResubmit = () => { setResubmitOrder(null); setNewPrices({}); setResubmitError('') }

  const confirmResubmit = async () => {
    if (!resubmitOrder) return
    // Collect items where rep actually changed the price
    const updates = []
    for (const item of (resubmitOrder.items || [])) {
      const entered = parseFloat(newPrices[item.id])
      const original = Number(item.unit_price ?? 0)
      if (!isNaN(entered) && entered > 0 && Math.abs(entered - original) > 0.001) {
        updates.push({ itemId: item.id, newPrice: entered })
      }
    }
    setResubmitting(true)
    setResubmitError('')
    try {
      await resubmitRejectedOrder(resubmitOrder.id, updates, profile?.full_name, uid)
      closeResubmit()
      await reload(uid)
      setActiveTab('pending') // jump to pending so they see the resubmit
    } catch (e) {
      console.error('[resubmit order]', e)
      setResubmitError(e?.message || 'Could not resubmit. Try again.')
    } finally {
      setResubmitting(false)
    }
  }

  // ── Tab filtering — order-level ────────────────────────────────────────────
  const allOrders = orders || []
  const tabCounts = {
    all:      allOrders.length,
    pending:  allOrders.filter((o) => o.bill_approval_status === 'pending').length,
    approved: allOrders.filter((o) => o.bill_approval_status === 'approved').length,
    rejected: allOrders.filter((o) => o.bill_approval_status === 'rejected').length,
  }

  const visibleOrders = activeTab === 'all'
    ? allOrders
    : allOrders.filter((o) => o.bill_approval_status === activeTab)

  // ── Resubmit screen ────────────────────────────────────────────────────────
  if (resubmitOrder) {
    const rejReason = resubmitOrder.bill_rejection_reason
    const version   = resubmitOrder.approval_version || 1
    return (
      <div className="fixed inset-0 z-[80] bg-black/40 flex items-end sm:items-center justify-center">
        <div className="bg-white w-full sm:max-w-lg rounded-t-3xl sm:rounded-3xl max-h-[95vh] flex flex-col">
          <div className="flex items-center justify-between px-4 py-3 border-b shrink-0">
            <div className="min-w-0">
              <h2 className="font-bold text-slate-800">Resubmit for Admin Approval</h2>
              <p className="text-xs text-slate-500 truncate">{resubmitOrder.shop_name} · {fmtDate(resubmitOrder.order_date)}</p>
              <p className="text-[10px] text-blue-600 font-semibold">Version {version + 1} (was v{version})</p>
            </div>
            <button onClick={closeResubmit} className="p-2 text-slate-400" aria-label="Close">
              <CloseIcon className="h-5 w-5" />
            </button>
          </div>

          {/* Rejection reason */}
          {rejReason && (
            <div className="mx-4 mt-3 rounded-xl bg-red-50 border border-red-200 px-3 py-2.5 shrink-0">
              <p className="text-xs font-semibold text-red-700 mb-0.5">Admin Rejection Reason</p>
              <p className="text-xs text-red-700">{rejReason}</p>
            </div>
          )}

          <p className="text-xs text-slate-500 mx-4 mt-2 shrink-0">
            Change any prices below. Products you don't change will keep their current price.
          </p>

          {/* Item list */}
          <div className="overflow-y-auto flex-1 px-4 py-3 space-y-3">
            {(resubmitOrder.items || []).map((item) => {
              const isSpecial = item.approval_status === 'rejected' || item.approval_status === 'pending'
              const currentPrice = newPrices[item.id] ?? String(item.unit_price ?? '')
              return (
                <div key={item.id} className={`rounded-xl border p-3 ${
                  isSpecial ? 'border-amber-200 bg-amber-50' : 'border-slate-100 bg-slate-50'
                }`}>
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-slate-800">{item.product_name}</p>
                      <p className="text-[11px] text-slate-400">Qty: {item.qty} {item.unit}</p>
                    </div>
                    {isSpecial && (
                      <span className="shrink-0 text-[9px] font-bold text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded-full">
                        CUSTOM PRICE
                      </span>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-[11px] mb-2">
                    <div className="rounded-lg border border-slate-200 bg-white p-1.5 text-center">
                      <div className="font-bold text-slate-700">{rupee(item.normal_price)}</div>
                      <div className="text-slate-400">Normal</div>
                    </div>
                    <div className="rounded-lg border border-red-200 bg-red-50 p-1.5 text-center">
                      <div className="font-bold text-red-700">{rupee(item.unit_price)}</div>
                      <div className="text-red-400">Previous</div>
                    </div>
                  </div>
                  <div>
                    <label className="text-[10px] font-semibold text-slate-500 uppercase">New Selling Price (₹)</label>
                    <input
                      type="number"
                      inputMode="decimal"
                      value={currentPrice}
                      onChange={(e) => setNewPrices((prev) => ({ ...prev, [item.id]: e.target.value }))}
                      className={`w-full mt-1 rounded-lg border px-2 py-1.5 text-sm outline-none ${
                        isSpecial ? 'border-amber-300 focus:border-brand-500' : 'border-slate-200 focus:border-brand-500'
                      }`}
                      placeholder={String(item.unit_price ?? '')}
                    />
                    {(() => {
                      const entered = parseFloat(currentPrice)
                      const original = Number(item.unit_price ?? 0)
                      if (!isNaN(entered) && Math.abs(entered - original) > 0.001) {
                        return (
                          <p className="text-[10px] text-blue-600 mt-0.5">
                            Changed: {rupee(original)} → {rupee(entered)}
                          </p>
                        )
                      }
                      return null
                    })()}
                  </div>
                </div>
              )
            })}
          </div>

          {resubmitError && <p className="text-xs text-red-600 mx-4 mb-1">{resubmitError}</p>}

          <div className="px-4 py-3 border-t flex gap-2 shrink-0">
            <button onClick={closeResubmit} className="flex-1 rounded-xl border border-slate-200 py-3 font-semibold text-slate-600">
              Cancel
            </button>
            <button
              onClick={confirmResubmit}
              disabled={resubmitting}
              className="flex-2 rounded-xl bg-brand-600 text-white px-5 py-3 font-bold disabled:opacity-50"
            >
              {resubmitting ? 'Sending…' : 'Send Full Order for Approval'}
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

        {/* Summary tiles — order-level counts */}
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
              <button key={tab} onClick={() => setActiveTab(tab)}
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
          {!loading && error && <p className="text-center text-sm text-red-500 py-8">{error}</p>}
          {!loading && !error && visibleOrders.length === 0 && (
            <div className="py-12 text-center">
              <p className="text-3xl mb-2">
                {activeTab === 'approved' ? '✅' : activeTab === 'rejected' ? '👍' : '✅'}
              </p>
              <p className="text-sm font-semibold text-slate-700">
                {activeTab === 'pending'  && 'No orders waiting for approval'}
                {activeTab === 'approved' && 'No approved orders yet'}
                {activeTab === 'rejected' && 'No rejected orders'}
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
              onResubmit={() => openResubmit(order)}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

// ── Per-order card (ORDER-LEVEL) ──────────────────────────────────────────────
function OrderApprovalCard({ order, onResubmit }) {
  const [expanded, setExpanded] = useState(false)
  const [showHistory, setShowHistory] = useState(false)

  const status     = order.bill_approval_status
  const version    = order.approval_version || 1
  const rejReason  = order.bill_rejection_reason
  const totalItems = (order.items || []).length
  const specialItems = (order.items || []).filter((i) => i.approval_status === 'pending' || i.approval_status === 'rejected').length

  const statusBadge = {
    pending:  { text: '⏳ With Admin',    cls: 'text-amber-700 bg-amber-100' },
    approved: { text: '✅ Approved',       cls: 'text-green-700 bg-green-100' },
    rejected: { text: '❌ Rejected',       cls: 'text-red-700   bg-red-100'   },
  }[status] || { text: status, cls: 'text-slate-600 bg-slate-100' }

  // Filter history to only show order-level events (product_name starts with '[ORDER')
  const orderHistory = (order.orderHistory || []).filter((h) =>
    (h.product_name || '').startsWith('[ORDER')
  )

  return (
    <div className="mb-4 rounded-2xl border border-slate-100 overflow-hidden">
      {/* Order header */}
      <div className={`px-4 py-3 ${status === 'rejected' ? 'bg-red-50' : status === 'approved' ? 'bg-green-50' : 'bg-amber-50'}`}>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <p className="font-bold text-sm text-slate-800 truncate">{order.shop_name}</p>
            <p className="text-[11px] text-slate-500">{order.route} · {fmtDate(order.order_date)}</p>
            <p className="text-[11px] text-slate-500 mt-0.5">
              {totalItems} product{totalItems !== 1 ? 's' : ''}
              {specialItems > 0 ? ` · ${specialItems} custom price${specialItems !== 1 ? 's' : ''}` : ''}
              {version > 1 && ` · Version ${version}`}
            </p>
          </div>
          <span className={`shrink-0 text-[10px] font-bold px-2 py-1 rounded-full ${statusBadge.cls}`}>
            {statusBadge.text}
          </span>
        </div>

        {/* Rejection reason */}
        {status === 'rejected' && rejReason && (
          <div className="mt-2 rounded-lg bg-red-100 border border-red-200 px-2.5 py-1.5">
            <p className="text-[11px] text-red-700">
              <span className="font-semibold">Rejected: </span>{rejReason}
            </p>
          </div>
        )}

        {/* Actions row */}
        <div className="mt-2 flex gap-2 flex-wrap">
          <button
            onClick={() => setExpanded((v) => !v)}
            className="text-[11px] font-semibold text-brand-700 underline"
          >
            {expanded ? 'Hide Products' : `View ${totalItems} Products`}
          </button>
          {orderHistory.length > 0 && (
            <button
              onClick={() => setShowHistory((v) => !v)}
              className="text-[11px] font-semibold text-slate-500 underline"
            >
              {showHistory ? 'Hide History' : `History (${orderHistory.length})`}
            </button>
          )}
        </div>
      </div>

      {/* Version history */}
      {showHistory && orderHistory.length > 0 && (
        <div className="px-4 py-3 bg-slate-50 border-b border-slate-100">
          <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide mb-1.5">Approval History</p>
          {orderHistory.map((h, idx) => {
            const decisionLabel =
              h.decision === 'approved' ? '✅ Approved' :
              h.decision === 'rejected' ? '❌ Rejected' :
              h.decision === 'resubmitted' ? '🔄 Resubmitted' : h.decision
            return (
              <div key={idx} className="text-[11px] mb-1.5 pb-1.5 border-b border-slate-100 last:border-0">
                <div className="flex items-center justify-between gap-2">
                  <span className={`font-semibold ${
                    h.decision === 'approved' ? 'text-green-700' :
                    h.decision === 'rejected' ? 'text-red-600' : 'text-blue-600'
                  }`}>
                    {h.approval_version ? `v${h.approval_version}` : ''} {decisionLabel}
                  </span>
                  <span className="text-slate-400 text-[10px]">{fmtDateTime(h.decided_at)}</span>
                </div>
                {h.decided_by && (
                  <p className="text-slate-500">By: {h.decided_by}</p>
                )}
                {h.rejection_reason && (
                  <p className="text-red-600">Reason: {h.rejection_reason}</p>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Product list (expandable) */}
      {expanded && (
        <div className="divide-y divide-slate-50">
          {(order.items || []).map((item) => (
            <div key={item.id} className="bg-white px-4 py-2.5">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-slate-800">{item.product_name}</p>
                  <div className="text-[11px] text-slate-400 mt-0.5 flex flex-wrap gap-x-2">
                    <span>Qty: {item.qty} {item.unit}</span>
                    {item.normal_price != null && <span>Normal: {rupee(item.normal_price)}</span>}
                    <span className={item.approval_status === 'rejected' ? 'text-red-600 font-semibold' : ''}>
                      Requested: {rupee(item.unit_price)}
                    </span>
                  </div>
                </div>
                {item.approval_status && (
                  <span className={`shrink-0 text-[9px] font-bold px-1.5 py-0.5 rounded-full ${
                    item.approval_status === 'approved' ? 'text-green-700 bg-green-100' :
                    item.approval_status === 'rejected' ? 'text-red-700 bg-red-100' :
                    'text-amber-700 bg-amber-100'
                  }`}>
                    {item.approval_status}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* RESUBMIT ORDER button — only for rejected orders */}
      {status === 'rejected' && (
        <div className="px-4 py-3 border-t border-red-100 bg-red-50">
          <button
            onClick={onResubmit}
            className="w-full rounded-xl bg-brand-600 text-white py-3 font-bold text-sm active:bg-brand-700"
          >
            🔄 Resubmit Full Order
          </button>
          <p className="text-[10px] text-slate-400 text-center mt-1.5">
            Opens all {totalItems} products — change any rates and send back to Admin
          </p>
        </div>
      )}
    </div>
  )
}
