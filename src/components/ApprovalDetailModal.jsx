import { useState, useEffect, useCallback, useRef } from 'react'
import { useAuth } from '../context/AuthContext.jsx'
import { loadMyApprovalItems, loadMyApprovalSummary, resubmitRejectedOrder, removeRejectedItemFromOrder, sendRemainingItemsToBilling, currentUserId } from '../utils/cloudSync.js'
import { supabase } from '../utils/supabase.js'
import { CloseIcon } from './Icons.jsx'
import AddOnFlowModal from './AddOnFlowModal.jsx'

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

  // Item-removal state (within the resubmit screen)
  // removedItemIds — set of item IDs the rep has removed from the order (optimistic UI)
  const [removedItemIds,   setRemovedItemIds]   = useState(new Set())
  const [removingItemId,   setRemovingItemId]   = useState(null)   // which item is mid-removal
  const [sendingToBilling, setSendingToBilling] = useState(false)
  const [sentToBilling,    setSentToBilling]    = useState(false)  // show success state

  // ADD-ON flow — for approved orders: rep can add more products to the same billing order
  const [addOnOrder, setAddOnOrder] = useState(null)

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
    setRemovedItemIds(new Set())
    setRemovingItemId(null)
    setSendingToBilling(false)
    setSentToBilling(false)
  }
  const closeResubmit = () => {
    setResubmitOrder(null)
    setNewPrices({})
    setResubmitError('')
    setRemovedItemIds(new Set())
    setRemovingItemId(null)
    setSendingToBilling(false)
    setSentToBilling(false)
  }

  const confirmResubmit = async () => {
    if (!resubmitOrder) return
    // Only resubmit items that are not locally removed
    const updates = []
    for (const item of (resubmitOrder.items || [])) {
      if (removedItemIds.has(item.id)) continue  // skip removed items
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

  // ── Remove rejected item from order ───────────────────────────────────────
  const handleRemoveItem = async (itemId) => {
    if (!resubmitOrder || removingItemId) return
    setRemovingItemId(itemId)
    setResubmitError('')
    try {
      await removeRejectedItemFromOrder(itemId, uid, profile?.full_name)
      // Optimistically add to removed set
      setRemovedItemIds((prev) => new Set([...prev, itemId]))
    } catch (e) {
      console.error('[removeRejectedItem]', e)
      setResubmitError(e?.message || 'Could not remove item. Try again.')
    } finally {
      setRemovingItemId(null)
    }
  }

  // ── Send remaining valid items directly to Billing ────────────────────────
  const handleSendToBilling = async () => {
    if (!resubmitOrder) return
    setSendingToBilling(true)
    setResubmitError('')
    try {
      await sendRemainingItemsToBilling(resubmitOrder.id, profile?.full_name, uid)
      setSentToBilling(true)
      await reload(uid)
      // Auto-close after a brief success display
      setTimeout(() => { closeResubmit(); setActiveTab('approved') }, 2000)
    } catch (e) {
      console.error('[sendToBilling]', e)
      setResubmitError(e?.message || 'Could not send to Billing. Try again.')
      setSendingToBilling(false)
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

  // ── ADD-ON flow (approved orders) ─────────────────────────────────────────
  if (addOnOrder) {
    return (
      <AddOnFlowModal
        order={addOnOrder}
        userId={uid}
        onClose={() => setAddOnOrder(null)}
        onSaved={() => { setAddOnOrder(null); reload(uid) }}
      />
    )
  }

  // ── Resubmit screen ────────────────────────────────────────────────────────
  if (resubmitOrder) {
    const rejReason = resubmitOrder.bill_rejection_reason
    const version   = resubmitOrder.approval_version || 1

    // Compute per-item visible state
    const allItems = (resubmitOrder.items || [])
    // Active = not removed in DB (item.removed=false) AND not removed this session
    const activeItems = allItems.filter((i) => !removedItemIds.has(i.id))
    const removedCount = removedItemIds.size

    // Approval state of each remaining item
    const pendingItems  = activeItems.filter((i) => i.approval_status === 'pending')
    const rejectedItems = activeItems.filter((i) => i.approval_status === 'rejected')
    const needsApproval = pendingItems.length > 0 || rejectedItems.length > 0

    // Can send to billing: has items, none pending/rejected
    const canSendToBilling = activeItems.length > 0 && !needsApproval
    // Can resubmit: has at least one pending/rejected item remaining
    const canResubmitToAdmin = pendingItems.length > 0 || rejectedItems.length > 0

    return (
      <div className="fixed inset-0 z-[80] bg-black/40 flex items-end sm:items-center justify-center">
        <div className="bg-white w-full sm:max-w-lg rounded-t-3xl sm:rounded-3xl max-h-[95vh] flex flex-col">
          <div className="flex items-center justify-between px-4 py-3 border-b shrink-0">
            <div className="min-w-0">
              <h2 className="font-bold text-slate-800">
                {sentToBilling ? '✅ Sent to Billing' : canSendToBilling ? 'Send to Billing Team' : 'Resubmit for Admin Approval'}
              </h2>
              <p className="text-xs text-slate-500 truncate">{resubmitOrder.shop_name} · {fmtDate(resubmitOrder.order_date)}</p>
              {!sentToBilling && canResubmitToAdmin && (
                <p className="text-[10px] text-blue-600 font-semibold">Version {version + 1} (was v{version})</p>
              )}
            </div>
            <button onClick={closeResubmit} className="p-2 text-slate-400" aria-label="Close">
              <CloseIcon className="h-5 w-5" />
            </button>
          </div>

          {/* Success: sent to billing */}
          {sentToBilling && (
            <div className="flex-1 flex flex-col items-center justify-center px-4 py-12 text-center">
              <p className="text-5xl mb-3">🎉</p>
              <p className="font-bold text-green-700 text-lg mb-1">Order sent to Billing Team!</p>
              <p className="text-sm text-slate-500">{activeItems.length} product{activeItems.length !== 1 ? 's' : ''} are now with Billing.</p>
              {removedCount > 0 && (
                <p className="text-xs text-slate-400 mt-1">{removedCount} rejected product{removedCount !== 1 ? 's were' : ' was'} removed from this order.</p>
              )}
            </div>
          )}

          {!sentToBilling && (
            <>
              {/* Rejection reason */}
              {rejReason && (
                <div className="mx-4 mt-3 rounded-xl bg-red-50 border border-red-200 px-3 py-2.5 shrink-0">
                  <p className="text-xs font-semibold text-red-700 mb-0.5">Admin Rejection Reason</p>
                  <p className="text-xs text-red-700">{rejReason}</p>
                </div>
              )}

              {/* Context message */}
              {canSendToBilling ? (
                <div className="mx-4 mt-2 rounded-xl bg-green-50 border border-green-200 px-3 py-2 shrink-0">
                  <p className="text-xs text-green-700 font-semibold">
                    ✅ All remaining products are valid — ready to send directly to Billing Team.
                  </p>
                  {removedCount > 0 && (
                    <p className="text-[10px] text-green-600 mt-0.5">
                      {removedCount} rejected product{removedCount !== 1 ? 's' : ''} removed from this order.
                    </p>
                  )}
                </div>
              ) : activeItems.length === 0 ? (
                <div className="mx-4 mt-2 rounded-xl bg-slate-50 border border-slate-200 px-3 py-2 shrink-0">
                  <p className="text-xs text-slate-600 font-semibold">
                    ⚠️ No products remaining in this order.
                  </p>
                  <p className="text-[10px] text-slate-400 mt-0.5">All products have been removed. Nothing to send to Billing.</p>
                </div>
              ) : (
                <p className="text-xs text-slate-500 mx-4 mt-2 shrink-0">
                  Remove rejected products or change prices and resubmit for Admin approval.
                </p>
              )}

              {/* Item list */}
              <div className="overflow-y-auto flex-1 px-4 py-3 space-y-3">
                {/* Removed items (greyed out, shown for context) */}
                {allItems.filter((i) => removedItemIds.has(i.id)).map((item) => (
                  <div key={item.id} className="rounded-xl border border-slate-100 bg-slate-50 p-3 opacity-50">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-slate-400 line-through">{item.product_name}</p>
                        <p className="text-[11px] text-slate-300">Qty: {item.qty} {item.unit}</p>
                      </div>
                      <span className="shrink-0 text-[9px] font-bold text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded-full">
                        REMOVED
                      </span>
                    </div>
                  </div>
                ))}

                {/* Active items */}
                {activeItems.map((item) => {
                  const isRejected  = item.approval_status === 'rejected'
                  const isPending   = item.approval_status === 'pending'
                  const isSpecial   = isRejected || isPending
                  const isNormal    = !isSpecial
                  const currentPrice = newPrices[item.id] ?? String(item.unit_price ?? '')
                  const isBeingRemoved = removingItemId === item.id

                  return (
                    <div key={item.id} className={`rounded-xl border p-3 ${
                      isRejected ? 'border-red-200 bg-red-50' :
                      isPending  ? 'border-amber-200 bg-amber-50' :
                      'border-slate-100 bg-slate-50'
                    }`}>
                      <div className="flex items-start justify-between gap-2 mb-2">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-semibold text-slate-800">{item.product_name}</p>
                          <p className="text-[11px] text-slate-400">Qty: {item.qty} {item.unit}</p>
                        </div>
                        <div className="flex flex-col items-end gap-1 shrink-0">
                          {isRejected && (
                            <span className="text-[9px] font-bold text-red-700 bg-red-100 px-1.5 py-0.5 rounded-full">
                              REJECTED
                            </span>
                          )}
                          {isPending && (
                            <span className="text-[9px] font-bold text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded-full">
                              PENDING
                            </span>
                          )}
                          {isNormal && (
                            <span className="text-[9px] font-bold text-green-700 bg-green-100 px-1.5 py-0.5 rounded-full">
                              NORMAL
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-2 text-[11px] mb-2">
                        <div className="rounded-lg border border-slate-200 bg-white p-1.5 text-center">
                          <div className="font-bold text-slate-700">{rupee(item.normal_price)}</div>
                          <div className="text-slate-400">Normal</div>
                        </div>
                        <div className={`rounded-lg border p-1.5 text-center ${isRejected ? 'border-red-200 bg-red-50' : 'border-slate-200 bg-white'}`}>
                          <div className={`font-bold ${isRejected ? 'text-red-700' : 'text-slate-700'}`}>{rupee(item.unit_price)}</div>
                          <div className={isRejected ? 'text-red-400' : 'text-slate-400'}>Previous</div>
                        </div>
                      </div>

                      {/* Rejected: show Remove button prominently + optional price edit */}
                      {isRejected && (
                        <div className="space-y-2">
                          <button
                            onClick={() => handleRemoveItem(item.id)}
                            disabled={isBeingRemoved || !!removingItemId}
                            className="w-full rounded-lg bg-red-600 text-white py-2 text-xs font-bold active:bg-red-700 disabled:opacity-50 flex items-center justify-center gap-1.5"
                          >
                            {isBeingRemoved ? (
                              <><span className="h-3 w-3 rounded-full border-2 border-white/30 border-t-white animate-spin inline-block" /> Removing…</>
                            ) : (
                              '🗑 Remove from Order'
                            )}
                          </button>
                          <details className="text-[10px]">
                            <summary className="text-slate-400 cursor-pointer select-none">Or edit price &amp; resubmit instead</summary>
                            <div className="mt-1.5">
                              <label className="text-[10px] font-semibold text-slate-500 uppercase">New Selling Price (₹)</label>
                              <input
                                type="number"
                                inputMode="decimal"
                                value={currentPrice}
                                onChange={(e) => setNewPrices((prev) => ({ ...prev, [item.id]: e.target.value }))}
                                className="w-full mt-1 rounded-lg border border-red-300 focus:border-brand-500 px-2 py-1.5 text-sm outline-none"
                                placeholder={String(item.unit_price ?? '')}
                              />
                              {(() => {
                                const entered = parseFloat(currentPrice)
                                const original = Number(item.unit_price ?? 0)
                                if (!isNaN(entered) && Math.abs(entered - original) > 0.001) {
                                  return <p className="text-[10px] text-blue-600 mt-0.5">Changed: {rupee(original)} → {rupee(entered)}</p>
                                }
                                return null
                              })()}
                            </div>
                          </details>
                        </div>
                      )}

                      {/* Pending: show price edit (resubmit only) */}
                      {isPending && (
                        <div>
                          <label className="text-[10px] font-semibold text-slate-500 uppercase">New Selling Price (₹)</label>
                          <input
                            type="number"
                            inputMode="decimal"
                            value={currentPrice}
                            onChange={(e) => setNewPrices((prev) => ({ ...prev, [item.id]: e.target.value }))}
                            className="w-full mt-1 rounded-lg border border-amber-300 focus:border-brand-500 px-2 py-1.5 text-sm outline-none"
                            placeholder={String(item.unit_price ?? '')}
                          />
                          {(() => {
                            const entered = parseFloat(currentPrice)
                            const original = Number(item.unit_price ?? 0)
                            if (!isNaN(entered) && Math.abs(entered - original) > 0.001) {
                              return <p className="text-[10px] text-blue-600 mt-0.5">Changed: {rupee(original)} → {rupee(entered)}</p>
                            }
                            return null
                          })()}
                        </div>
                      )}

                      {/* Normal: price edit still available */}
                      {isNormal && (
                        <div>
                          <label className="text-[10px] font-semibold text-slate-500 uppercase">New Selling Price (₹)</label>
                          <input
                            type="number"
                            inputMode="decimal"
                            value={currentPrice}
                            onChange={(e) => setNewPrices((prev) => ({ ...prev, [item.id]: e.target.value }))}
                            className="w-full mt-1 rounded-lg border border-slate-200 focus:border-brand-500 px-2 py-1.5 text-sm outline-none"
                            placeholder={String(item.unit_price ?? '')}
                          />
                          {(() => {
                            const entered = parseFloat(currentPrice)
                            const original = Number(item.unit_price ?? 0)
                            if (!isNaN(entered) && Math.abs(entered - original) > 0.001) {
                              return <p className="text-[10px] text-blue-600 mt-0.5">Changed: {rupee(original)} → {rupee(entered)}</p>
                            }
                            return null
                          })()}
                        </div>
                      )}
                    </div>
                  )
                })}

                {activeItems.length === 0 && (
                  <div className="py-8 text-center">
                    <p className="text-3xl mb-2">📭</p>
                    <p className="text-sm font-semibold text-slate-500">No products remaining</p>
                    <p className="text-xs text-slate-400 mt-1">All products were removed from this order.</p>
                  </div>
                )}
              </div>

              {resubmitError && <p className="text-xs text-red-600 mx-4 mb-1 shrink-0">{resubmitError}</p>}

              <div className="px-4 py-3 border-t flex flex-col gap-2 shrink-0">
                {/* Primary action: Send to Billing (when all remaining valid) */}
                {canSendToBilling && (
                  <button
                    onClick={handleSendToBilling}
                    disabled={sendingToBilling}
                    className="w-full rounded-xl bg-green-600 text-white py-3 font-bold text-sm active:bg-green-700 disabled:opacity-50"
                  >
                    {sendingToBilling ? 'Sending to Billing…' : '✅ Send to Billing Team'}
                  </button>
                )}

                {/* Primary action: Resubmit to Admin (when pending/rejected items remain) */}
                {canResubmitToAdmin && (
                  <button
                    onClick={confirmResubmit}
                    disabled={resubmitting}
                    className="w-full rounded-xl bg-brand-600 text-white py-3 font-bold text-sm active:bg-brand-700 disabled:opacity-50"
                  >
                    {resubmitting ? 'Sending…' : 'Send for Admin Approval'}
                  </button>
                )}

                {/* When no action is possible (all removed, nothing to bill) */}
                {!canSendToBilling && !canResubmitToAdmin && activeItems.length === 0 && (
                  <p className="text-center text-xs text-slate-400 py-1">
                    No products remaining — nothing to submit.
                  </p>
                )}

                <button onClick={closeResubmit} className="w-full rounded-xl border border-slate-200 py-2.5 font-semibold text-slate-600 text-sm">
                  Cancel
                </button>
              </div>
            </>
          )}
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
              onAddOn={() => setAddOnOrder(order)}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

// ── Per-order card (ORDER-LEVEL) ──────────────────────────────────────────────
function OrderApprovalCard({ order, onResubmit, onAddOn }) {
  const [expanded, setExpanded] = useState(false)
  const [showHistory, setShowHistory] = useState(false)

  const status     = order.bill_approval_status
  const version    = order.approval_version || 1
  const rejReason  = order.bill_rejection_reason
  const totalItems = (order.items || []).length
  const specialItems = (order.items || []).filter((i) => i.approval_status === 'pending' || i.approval_status === 'rejected').length

  // Detect item-level rejections on a still-pending order (admin rejected specific
  // items but hasn't closed the whole bill yet). Rep should be able to resubmit.
  const hasItemRejections = (order.items || []).some((i) => i.approval_status === 'rejected')
  const canResubmit = status === 'rejected' || (status === 'pending' && hasItemRejections)

  const statusBadge = {
    pending:  { text: hasItemRejections ? '⚠️ Partial Rejection' : '⏳ With Admin',
                cls:  hasItemRejections ? 'text-red-700 bg-red-100' : 'text-amber-700 bg-amber-100' },
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

        {/* Rejection reason (order-level rejection) */}
        {status === 'rejected' && rejReason && (
          <div className="mt-2 rounded-lg bg-red-100 border border-red-200 px-2.5 py-1.5">
            <p className="text-[11px] text-red-700">
              <span className="font-semibold">Rejected: </span>{rejReason}
            </p>
          </div>
        )}
        {/* Item-level rejections on a pending order */}
        {status === 'pending' && hasItemRejections && (
          <div className="mt-2 rounded-lg bg-red-100 border border-red-200 px-2.5 py-1.5">
            <p className="text-[11px] text-red-700">
              <span className="font-semibold">⚠️ Some items were rejected by Admin.</span>{' '}
              You can remove rejected items and send the rest to Billing, or revise prices and resubmit.
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

      {/* RESUBMIT ORDER button — for rejected orders OR pending orders with item-level rejections */}
      {canResubmit && (
        <div className="px-4 py-3 border-t border-red-100 bg-red-50">
          <button
            onClick={onResubmit}
            className="w-full rounded-xl bg-brand-600 text-white py-3 font-bold text-sm active:bg-brand-700"
          >
            🔄 Review &amp; Resubmit Order
          </button>
          <p className="text-[10px] text-slate-400 text-center mt-1.5">
            Remove rejected items or change prices — then send to Billing or Admin
          </p>
        </div>
      )}

      {/* ADD-ON button — only for approved orders */}
      {status === 'approved' && onAddOn && (
        <div className="px-4 py-3 border-t border-green-100 bg-green-50">
          <button
            onClick={onAddOn}
            className="w-full rounded-xl bg-green-600 text-white py-3 font-bold text-sm active:bg-green-700"
          >
            ➕ Add Products to This Order
          </button>
          <p className="text-[10px] text-slate-400 text-center mt-1.5">
            Add more products to the same billing order for {order.shop_name}
          </p>
        </div>
      )}
    </div>
  )
}
