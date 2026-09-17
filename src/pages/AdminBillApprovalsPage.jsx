import { useState, useEffect } from 'react'
import { useAuth } from '../context/AuthContext.jsx'
import { loadPendingApprovalBills, approveBill, rejectBill, notifyRepOfPriceRejection } from '../utils/cloudSync.js'

const APPROVE_REASONS = [
  { value: 'competitor',  label: 'Competitor Price',            needsName: true },
  { value: 'bulk',        label: 'Customer Taking Bulk Quantity' },
  { value: 'near_expiry', label: 'Product Near Expiry' },
  { value: 'others',      label: 'Others',                      needsOther: true }
]

const rupee = (n) => n != null ? `₹${Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'

export default function AdminBillApprovalsPage() {
  const { profile } = useAuth()
  const [bills, setBills] = useState(null)
  // Per-item decision state: { [itemId]: { action: 'approve'|'reject', approvedPrice, rejectReason } }
  const [itemDecisions, setItemDecisions] = useState({})
  const [reviewing, setReviewing] = useState(null)
  const [reasonType, setReasonType] = useState('')
  const [competitorName, setCompetitorName] = useState('')
  const [otherReason, setOtherReason] = useState('')
  const [rejectReason, setRejectReason] = useState('')
  const [rejecting, setRejecting] = useState(null)
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState('')

  const flash = (m) => { setToast(m); setTimeout(() => setToast(''), 3500) }
  const refresh = () => { setBills(null); loadPendingApprovalBills().then(setBills).catch(() => setBills([])) }
  useEffect(() => { refresh() }, [])

  const openReview = (bill) => {
    setReviewing(bill)
    setReasonType(''); setCompetitorName(''); setOtherReason('')
    // Pre-fill: all pending items default to "approve at requested price"
    const decisions = {}
    for (const item of bill.order_items || []) {
      if (item.approval_status === 'pending') {
        decisions[item.id] = { action: 'approve', approvedPrice: item.unit_price, rejectReason: '' }
      }
    }
    setItemDecisions(decisions)
  }

  const setItemAction = (itemId, action) => {
    setItemDecisions(prev => ({ ...prev, [itemId]: { ...prev[itemId], action } }))
  }
  const setItemPrice = (itemId, price) => {
    setItemDecisions(prev => ({ ...prev, [itemId]: { ...prev[itemId], approvedPrice: price } }))
  }
  const setItemRejectReason = (itemId, reason) => {
    setItemDecisions(prev => ({ ...prev, [itemId]: { ...prev[itemId], rejectReason: reason } }))
  }

  const handleFinalize = async () => {
    if (!reasonType) { alert('Please select an approval reason.'); return }
    const r = APPROVE_REASONS.find(x => x.value === reasonType)
    if (r?.needsName && !competitorName.trim()) { alert('Competitor Name required.'); return }
    if (r?.needsOther && !otherReason.trim()) { alert('Reason required.'); return }

    // Validate all items have a decision
    const pendingItems = (reviewing.order_items || []).filter(i => i.approval_status === 'pending')
    for (const item of pendingItems) {
      const d = itemDecisions[item.id]
      if (!d) { alert(`Please make a decision for ${item.product_name}`); return }
      if (d.action === 'reject' && !d.rejectReason?.trim()) {
        alert(`Please enter a rejection reason for ${item.product_name}`); return
      }
    }

    setBusy(true)
    try {
      const approvedItems = pendingItems
        .filter(i => itemDecisions[i.id]?.action === 'approve')
        .map(i => ({
          itemId: i.id,
          approvedPrice: Number(itemDecisions[i.id].approvedPrice ?? i.unit_price),
          productId: i.product_id ?? null
        }))

      const rejectedItems = pendingItems
        .filter(i => itemDecisions[i.id]?.action === 'reject')
        .map(i => ({
          itemId: i.id,
          rejectReason: itemDecisions[i.id].rejectReason
        }))

      // Pass both approved and rejected items to approveBill for atomic processing
      await approveBill(reviewing.id, approvedItems, profile, {
        reasonType, competitorName: competitorName.trim() || undefined,
        otherReason: otherReason.trim() || undefined,
        rejectedItems  // approveBill will mark these as removed+rejected
      })

      setBills(prev => (prev || []).filter(b => b.id !== reviewing.id))
      setReviewing(null)
      const aCount = approvedItems.length, rCount = rejectedItems.length
      flash(`Done: ${aCount} approved, ${rCount} rejected. Bill sent to Billing.`)

      // Notify the sales rep about each rejected item — fire-and-forget.
      // The bill is already committed; notification failure must not roll it back.
      if (rejectedItems.length > 0) {
        for (const ri of rejectedItems) {
          // Find the original item data for context (product name, prices)
          const origItem = (reviewing.order_items || []).find((i) => i.id === ri.itemId)
          if (!origItem) continue
          notifyRepOfPriceRejection({
            orderId: reviewing.id,
            productName: origItem.product_name,
            reason: ri.rejectReason || 'Rejected by Admin',
            adminName: profile?.full_name,
            requestedPrice: origItem.unit_price,
            normalPrice: origItem.normal_price
          }).catch((e) => console.error('[notifyRep] bill-rejection notification failed (non-fatal)', e))
        }
      }
    } catch (e) { console.error(e); alert('Failed: ' + (e?.message || 'unknown')) }
    finally { setBusy(false) }
  }

  const handleRejectBill = async () => {
    if (!rejectReason.trim()) { alert('Please enter a rejection reason.'); return }
    setBusy(true)
    try {
      await rejectBill(rejecting.id, profile, rejectReason)
      setBills(prev => (prev || []).filter(b => b.id !== rejecting.id))
      setRejecting(null)
      flash('Bill rejected.')
    } catch (e) { alert('Rejection failed.') }
    finally { setBusy(false) }
  }

  return (
    <div className="px-3 sm:px-6 pt-4 pb-10 max-w-3xl">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-lg font-bold text-slate-800">Bill Approvals</h1>
          <p className="text-[12px] text-slate-400">Bills awaiting Admin approval — decide each product individually.</p>
        </div>
        <button onClick={refresh} className="text-sm font-semibold text-brand-700 px-3 py-1.5 rounded-lg border border-slate-200 hover:bg-slate-50">Refresh</button>
      </div>

      {bills === null ? (
        <div className="py-16 flex justify-center"><div className="h-6 w-6 rounded-full border-4 border-slate-200 border-t-slate-800 animate-spin"/></div>
      ) : bills.length === 0 ? (
        <div className="py-16 text-center">
          <p className="font-semibold text-slate-600">No bills awaiting approval</p>
          <p className="text-sm text-slate-400 mt-1">All bills are either approved or no approval requests exist.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {bills.map(bill => {
            const specialItems = (bill.order_items || []).filter(i => i.approval_status === 'pending')
            return (
              <div key={bill.id} className="rounded-2xl bg-white border border-amber-200 p-4">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <p className="font-bold text-slate-800 truncate">{bill.shop_name}</p>
                    <p className="text-[11px] text-slate-400">{bill.profiles?.full_name} · {bill.order_date} · {bill.total_products} products</p>
                    <p className="text-sm font-semibold text-amber-700 mt-0.5">
                      ⚠ {specialItems.length} item{specialItems.length !== 1 ? 's' : ''} need price approval
                    </p>
                    {/* List the products needing approval at-a-glance */}
                    <div className="mt-1.5 space-y-0.5">
                      {specialItems.map(item => (
                        <p key={item.id} className="text-[11px] text-slate-600">
                          · {item.product_name} — requested {rupee(item.unit_price)}, current {rupee(item.normal_price)}
                        </p>
                      ))}
                    </div>
                  </div>
                  <div className="flex gap-2 shrink-0">
                    <button onClick={() => { setRejecting(bill); setRejectReason('') }}
                      className="text-xs font-bold text-red-600 border border-red-200 rounded-lg px-3 py-1.5">
                      Reject All
                    </button>
                    <button onClick={() => openReview(bill)}
                      className="text-xs font-bold text-white bg-emerald-600 rounded-lg px-3 py-1.5">
                      Review Items
                    </button>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Per-item review modal */}
      {reviewing && (
        <div className="fixed inset-0 z-[200] bg-black/40 flex items-end sm:items-center justify-center px-0 sm:px-4">
          <div className="bg-white w-full sm:max-w-xl rounded-t-3xl sm:rounded-3xl max-h-[95vh] flex flex-col">
            <div className="flex items-center justify-between px-4 py-3 border-b shrink-0">
              <div>
                <h2 className="font-bold text-slate-800">Review Bill — {reviewing.shop_name}</h2>
                <p className="text-xs text-slate-400">{reviewing.order_date} · Decide each product individually</p>
              </div>
              <button onClick={() => setReviewing(null)} className="text-slate-400 text-xl px-2">✕</button>
            </div>

            <div className="overflow-y-auto flex-1 px-4 py-3 space-y-3">
              {(reviewing.order_items || []).map(item => {
                const needsApproval = item.approval_status === 'pending'
                const decision = itemDecisions[item.id]
                const diff = needsApproval && item.normal_price != null
                  ? (item.unit_price - item.normal_price) : null

                return (
                  <div key={item.id} className={`rounded-xl border p-3 ${
                    !needsApproval ? 'border-slate-100 bg-slate-50/50 opacity-60' :
                    decision?.action === 'reject' ? 'border-red-200 bg-red-50' :
                    'border-amber-200 bg-amber-50'
                  }`}>
                    <div className="flex items-start justify-between gap-2 flex-wrap">
                      <div className="min-w-0">
                        <span className="text-sm font-semibold text-slate-800">{item.product_name}</span>
                        <p className="text-[11px] text-slate-400 mt-0.5">Qty {item.qty} {item.unit}</p>
                      </div>
                      {needsApproval ? (
                        <span className="shrink-0 text-[10px] font-bold text-amber-700 bg-amber-100 px-2 py-0.5 rounded">⚠ NEEDS DECISION</span>
                      ) : (
                        <span className="shrink-0 text-[10px] font-bold text-emerald-700 bg-emerald-100 px-2 py-0.5 rounded">✓ OK</span>
                      )}
                    </div>

                    {needsApproval && (
                      <div className="mt-2.5 space-y-2.5">
                        {/* Price comparison */}
                        <div className="grid grid-cols-3 gap-2 text-center text-[11px]">
                          <div className="rounded-lg border border-slate-200 bg-white p-1.5">
                            <div className="font-bold text-slate-700">{rupee(item.normal_price)}</div>
                            <div className="text-slate-400">Current</div>
                          </div>
                          <div className="rounded-lg border border-purple-200 bg-purple-50 p-1.5">
                            <div className="font-bold text-purple-700">{rupee(item.unit_price)}</div>
                            <div className="text-purple-500">Requested</div>
                          </div>
                          <div className={`rounded-lg border p-1.5 ${diff != null && diff < 0 ? 'border-red-200 bg-red-50' : 'border-slate-100'}`}>
                            <div className={`font-bold ${diff != null && diff < 0 ? 'text-red-700' : 'text-slate-600'}`}>
                              {diff != null ? `${diff > 0 ? '+' : ''}₹${Math.abs(diff).toFixed(2)}` : '—'}
                            </div>
                            <div className="text-slate-400">Diff</div>
                          </div>
                        </div>

                        {/* Decision buttons */}
                        <div className="flex gap-2">
                          <button
                            onClick={() => setItemAction(item.id, 'approve')}
                            className={`flex-1 rounded-lg py-2 text-[11px] font-bold border transition ${
                              decision?.action === 'approve'
                                ? 'bg-emerald-600 text-white border-emerald-600'
                                : 'bg-white text-emerald-700 border-emerald-300'
                            }`}
                          >✓ Approve</button>
                          <button
                            onClick={() => setItemAction(item.id, 'reject')}
                            className={`flex-1 rounded-lg py-2 text-[11px] font-bold border transition ${
                              decision?.action === 'reject'
                                ? 'bg-red-600 text-white border-red-600'
                                : 'bg-white text-red-600 border-red-300'
                            }`}
                          >✕ Reject</button>
                        </div>

                        {/* Approved price input */}
                        {decision?.action === 'approve' && (
                          <div>
                            <label className="text-[10px] font-semibold text-slate-500 uppercase">Admin Approved Price (₹)</label>
                            <input
                              type="number"
                              value={decision.approvedPrice ?? ''}
                              onChange={e => setItemPrice(item.id, e.target.value)}
                              className="w-full mt-1 rounded-lg border border-slate-200 px-2 py-1.5 text-sm outline-none focus:border-brand-500"
                            />
                            {decision.approvedPrice != null &&
                             Number(decision.approvedPrice) !== item.unit_price && (
                              <p className="text-[10px] text-amber-700 mt-0.5">
                                Modified from ₹{item.unit_price} — Billing will receive ₹{decision.approvedPrice}
                              </p>
                            )}
                          </div>
                        )}

                        {/* Rejection reason */}
                        {decision?.action === 'reject' && (
                          <div>
                            <label className="text-[10px] font-semibold text-slate-500 uppercase">Rejection Reason *</label>
                            <input
                              type="text"
                              value={decision.rejectReason ?? ''}
                              onChange={e => setItemRejectReason(item.id, e.target.value)}
                              placeholder="Why is this price not approved?"
                              className="w-full mt-1 rounded-lg border border-red-200 px-2 py-1.5 text-sm outline-none focus:border-red-400"
                            />
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}

              {/* Overall reason */}
              <div>
                <p className="text-xs font-semibold text-slate-700 mb-1">Overall Approval Reason *</p>
                <select value={reasonType} onChange={e => { setReasonType(e.target.value); setCompetitorName(''); setOtherReason('') }}
                  className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-sm outline-none bg-white">
                  <option value="">Select reason…</option>
                  {APPROVE_REASONS.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                </select>
                {reasonType === 'competitor' && (
                  <input value={competitorName} onChange={e => setCompetitorName(e.target.value)} placeholder="Competitor Name *"
                    className="w-full mt-2 rounded-lg border border-slate-200 px-2 py-1.5 text-sm outline-none"/>
                )}
                {reasonType === 'others' && (
                  <input value={otherReason} onChange={e => setOtherReason(e.target.value)} placeholder="Reason *"
                    className="w-full mt-2 rounded-lg border border-slate-200 px-2 py-1.5 text-sm outline-none"/>
                )}
              </div>

              {/* Summary of decisions */}
              {Object.keys(itemDecisions).length > 0 && (
                <div className="rounded-xl bg-slate-50 border border-slate-200 p-3 text-[11px]">
                  <p className="font-semibold text-slate-700 mb-1">Decision Summary</p>
                  {Object.entries(itemDecisions).map(([id, d]) => {
                    const item = (reviewing.order_items || []).find(i => i.id === id)
                    if (!item) return null
                    return (
                      <p key={id} className={d.action === 'reject' ? 'text-red-600' : 'text-emerald-700'}>
                        {d.action === 'approve' ? '✓' : '✕'} {item.product_name}
                        {d.action === 'approve' && d.approvedPrice !== item.unit_price
                          ? ` → ₹${d.approvedPrice} (modified)` : ''}
                      </p>
                    )
                  })}
                  {(() => {
                    const rejected = Object.values(itemDecisions).filter(d => d.action === 'reject').length
                    const total = reviewing.order_items?.length ?? 0
                    const remaining = total - rejected
                    if (rejected > 0) return (
                      <p className="text-slate-500 mt-1 border-t border-slate-200 pt-1">
                        {rejected} product{rejected > 1 ? 's' : ''} will be REMOVED · {remaining} product{remaining !== 1 ? 's' : ''} will reach Billing
                      </p>
                    )
                  })()}
                </div>
              )}
            </div>

            <div className="px-4 py-3 border-t flex gap-2 shrink-0">
              <button onClick={() => setReviewing(null)} className="flex-1 rounded-xl border border-slate-200 py-3 text-sm font-semibold text-slate-600">Cancel</button>
              <button onClick={handleFinalize} disabled={busy}
                className="flex-2 rounded-xl bg-emerald-600 text-white px-6 py-3 text-sm font-bold disabled:bg-slate-300">
                {busy ? 'Processing…' : 'Finalize & Release to Billing'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Reject whole bill modal */}
      {rejecting && (
        <div className="fixed inset-0 z-[200] bg-black/40 flex items-center justify-center px-4">
          <div className="bg-white w-full max-w-sm rounded-2xl p-5">
            <p className="font-bold text-slate-800 mb-1">Reject Entire Bill?</p>
            <p className="text-sm text-slate-500 mb-3">{rejecting.shop_name} — all products will be removed and the bill will not reach Billing.</p>
            <textarea value={rejectReason} onChange={e => setRejectReason(e.target.value)} rows={3}
              placeholder="Reason for rejection (required)"
              className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-red-400 resize-none mb-3"/>
            <div className="flex gap-2">
              <button onClick={() => setRejecting(null)} disabled={busy} className="flex-1 rounded-xl border border-slate-200 py-2.5 text-sm font-semibold text-slate-600">Cancel</button>
              <button onClick={handleRejectBill} disabled={busy} className="flex-1 rounded-xl bg-red-600 text-white py-2.5 text-sm font-bold disabled:bg-slate-300">
                {busy ? '…' : 'Reject All'}
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 bg-slate-900 text-white text-sm font-semibold px-4 py-2.5 rounded-xl shadow-lg">{toast}</div>}
    </div>
  )
}
