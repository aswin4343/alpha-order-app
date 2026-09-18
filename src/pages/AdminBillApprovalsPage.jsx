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
function fmtDate(iso) {
  if (!iso) return '—'
  return new Date(iso + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}

/**
 * Admin Bill Approvals — ORDER-LEVEL workflow (v190).
 *
 * Admin sees the FULL ORDER (all products, all prices).
 * Admin either APPROVES the entire order or REJECTS the entire order.
 *
 * APPROVE → all pending items approved at requested prices → released to Billing.
 * REJECT  → all pending items rejected (NOT removed) → rep notified → rep can resubmit.
 *
 * This replaces the per-item decision UI. The approval unit is the full order.
 */
export default function AdminBillApprovalsPage() {
  const { profile } = useAuth()
  const [bills, setBills] = useState(null)
  const [reviewing, setReviewing] = useState(null)  // bill being APPROVED
  const [reasonType, setReasonType] = useState('')
  const [competitorName, setCompetitorName] = useState('')
  const [otherReason, setOtherReason] = useState('')
  const [rejecting, setRejecting] = useState(null)  // bill being REJECTED
  const [rejectReason, setRejectReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState('')

  const flash = (m) => { setToast(m); setTimeout(() => setToast(''), 4000) }
  const refresh = () => { setBills(null); loadPendingApprovalBills().then(setBills).catch(() => setBills([])) }
  useEffect(() => { refresh() }, [])

  // ── Approve entire order ──────────────────────────────────────────────────
  const openApprove = (bill) => {
    setReviewing(bill)
    setReasonType('')
    setCompetitorName('')
    setOtherReason('')
  }

  const handleApprove = async () => {
    if (!reasonType) { alert('Please select an approval reason.'); return }
    const r = APPROVE_REASONS.find(x => x.value === reasonType)
    if (r?.needsName && !competitorName.trim()) { alert('Competitor Name required.'); return }
    if (r?.needsOther && !otherReason.trim()) { alert('Reason required.'); return }
    setBusy(true)
    try {
      // ORDER-LEVEL: pass empty itemOverrides — approveBill approves all pending
      // items at their requested price automatically
      await approveBill(reviewing.id, [], profile, {
        reasonType,
        competitorName: competitorName.trim() || undefined,
        otherReason: otherReason.trim() || undefined
      })
      setBills(prev => (prev || []).filter(b => b.id !== reviewing.id))
      setReviewing(null)
      flash(`✅ Order approved — sent to Billing Team.`)
    } catch (e) { console.error(e); alert('Failed: ' + (e?.message || 'unknown')) }
    finally { setBusy(false) }
  }

  // ── Reject entire order ───────────────────────────────────────────────────
  const openReject = (bill) => { setRejecting(bill); setRejectReason('') }

  const handleReject = async () => {
    if (!rejectReason.trim()) { alert('Please enter a rejection reason.'); return }
    setBusy(true)
    try {
      await rejectBill(rejecting.id, profile, rejectReason)
      setBills(prev => (prev || []).filter(b => b.id !== rejecting.id))

      // Notify the sales rep — fire-and-forget
      const pendingItems = (rejecting.order_items || []).filter(i => i.approval_status === 'pending')
      for (const item of pendingItems) {
        notifyRepOfPriceRejection({
          orderId: rejecting.id,
          productName: item.product_name,
          reason: rejectReason,
          adminName: profile?.full_name,
          requestedPrice: item.unit_price,
          normalPrice: item.normal_price
        }).catch((e) => console.error('[notifyRep] rejection notification failed (non-fatal)', e))
      }

      setRejecting(null)
      flash('❌ Order rejected. Rep has been notified and can resubmit.')
    } catch (e) { console.error(e); alert('Rejection failed: ' + (e?.message || 'unknown')) }
    finally { setBusy(false) }
  }

  return (
    <div className="px-3 sm:px-6 pt-4 pb-10 max-w-3xl">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-lg font-bold text-slate-800">Order Approvals</h1>
          <p className="text-[12px] text-slate-400">Review the full order, then approve or reject it. Rep can resubmit rejected orders.</p>
        </div>
        <button onClick={refresh} className="text-sm font-semibold text-brand-700 px-3 py-1.5 rounded-lg border border-slate-200 hover:bg-slate-50">
          Refresh
        </button>
      </div>

      {bills === null ? (
        <div className="py-16 flex justify-center"><div className="h-6 w-6 rounded-full border-4 border-slate-200 border-t-slate-800 animate-spin"/></div>
      ) : bills.length === 0 ? (
        <div className="py-16 text-center">
          <p className="font-semibold text-slate-600">No orders awaiting approval</p>
          <p className="text-sm text-slate-400 mt-1">All orders are either approved, rejected, or no approval requests exist.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {bills.map(bill => {
            const allItems     = (bill.order_items || [])
            const specialItems = allItems.filter(i => i.approval_status === 'pending')
            const version      = bill.approval_version || 1
            return (
              <div key={bill.id} className="rounded-2xl bg-white border border-amber-200 p-4">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-bold text-slate-800 truncate">{bill.shop_name}</p>
                      {version > 1 && (
                        <span className="text-[10px] font-bold text-blue-600 bg-blue-50 px-1.5 py-0.5 rounded-full">v{version}</span>
                      )}
                    </div>
                    <p className="text-[11px] text-slate-400">
                      {bill.profiles?.full_name} · {fmtDate(bill.order_date)} · {allItems.length} products
                    </p>
                    <p className="text-sm font-semibold text-amber-700 mt-0.5">
                      ⚠ {specialItems.length} product{specialItems.length !== 1 ? 's' : ''} with custom price{specialItems.length !== 1 ? 's' : ''}
                    </p>
                    {/* Show special-price items at a glance */}
                    <div className="mt-1.5 space-y-0.5">
                      {specialItems.map(item => (
                        <p key={item.id} className="text-[11px] text-slate-600">
                          · {item.product_name} — requested {rupee(item.unit_price)}, normal {rupee(item.normal_price)}
                        </p>
                      ))}
                    </div>
                  </div>
                  <div className="flex flex-col gap-2 shrink-0">
                    <button
                      onClick={() => openApprove(bill)}
                      className="text-xs font-bold text-white bg-emerald-600 rounded-lg px-3 py-1.5"
                    >
                      ✓ Approve Order
                    </button>
                    <button
                      onClick={() => openReject(bill)}
                      className="text-xs font-bold text-red-600 border border-red-200 rounded-lg px-3 py-1.5"
                    >
                      ✕ Reject Order
                    </button>
                  </div>
                </div>

                {/* All products (collapsed by default) — button to expand */}
                <ExpandableProductList items={allItems} />
              </div>
            )
          })}
        </div>
      )}

      {/* Approve order modal */}
      {reviewing && (
        <div className="fixed inset-0 z-[200] bg-black/40 flex items-end sm:items-center justify-center px-0 sm:px-4">
          <div className="bg-white w-full sm:max-w-xl rounded-t-3xl sm:rounded-3xl max-h-[95vh] flex flex-col">
            <div className="flex items-center justify-between px-4 py-3 border-b shrink-0">
              <div>
                <h2 className="font-bold text-slate-800">Approve Full Order</h2>
                <p className="text-xs text-slate-400">{reviewing.shop_name} · {fmtDate(reviewing.order_date)}</p>
              </div>
              <button onClick={() => setReviewing(null)} className="text-slate-400 text-xl px-2">✕</button>
            </div>

            <div className="overflow-y-auto flex-1 px-4 py-3">
              {/* ALL products summary for Admin to see full order */}
              <p className="text-xs font-semibold text-slate-700 mb-2">Full Order ({(reviewing.order_items || []).length} products)</p>
              <div className="space-y-2 mb-4">
                {(reviewing.order_items || []).map(item => {
                  const needsApproval = item.approval_status === 'pending'
                  const diff = needsApproval && item.normal_price != null
                    ? (item.unit_price - item.normal_price) : null
                  return (
                    <div key={item.id} className={`rounded-xl border p-3 ${
                      needsApproval ? 'border-amber-200 bg-amber-50' : 'border-slate-100 bg-slate-50'
                    }`}>
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <span className="text-sm font-semibold text-slate-800">{item.product_name}</span>
                          <p className="text-[11px] text-slate-400 mt-0.5">Qty {item.qty} {item.unit}</p>
                        </div>
                        {needsApproval ? (
                          <span className="shrink-0 text-[9px] font-bold text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded">CUSTOM</span>
                        ) : (
                          <span className="shrink-0 text-[9px] font-bold text-emerald-700 bg-emerald-100 px-1.5 py-0.5 rounded">OK</span>
                        )}
                      </div>
                      {needsApproval && (
                        <div className="mt-2 grid grid-cols-3 gap-1.5 text-center text-[11px]">
                          <div className="rounded border border-slate-200 bg-white p-1.5">
                            <div className="font-bold text-slate-700">{rupee(item.normal_price)}</div>
                            <div className="text-slate-400">Normal</div>
                          </div>
                          <div className="rounded border border-purple-200 bg-purple-50 p-1.5">
                            <div className="font-bold text-purple-700">{rupee(item.unit_price)}</div>
                            <div className="text-purple-500">Requested</div>
                          </div>
                          <div className={`rounded border p-1.5 ${diff != null && diff < 0 ? 'border-red-200 bg-red-50' : 'border-slate-100'}`}>
                            <div className={`font-bold ${diff != null && diff < 0 ? 'text-red-700' : 'text-slate-600'}`}>
                              {diff != null ? `${diff > 0 ? '+' : ''}₹${Math.abs(diff).toFixed(2)}` : '—'}
                            </div>
                            <div className="text-slate-400">Diff</div>
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>

              {/* Approval reason */}
              <div>
                <p className="text-xs font-semibold text-slate-700 mb-1">Approval Reason *</p>
                <select
                  value={reasonType}
                  onChange={e => { setReasonType(e.target.value); setCompetitorName(''); setOtherReason('') }}
                  className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-sm outline-none bg-white"
                >
                  <option value="">Select reason…</option>
                  {APPROVE_REASONS.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                </select>
                {reasonType === 'competitor' && (
                  <input value={competitorName} onChange={e => setCompetitorName(e.target.value)}
                    placeholder="Competitor Name *"
                    className="w-full mt-2 rounded-lg border border-slate-200 px-2 py-1.5 text-sm outline-none"/>
                )}
                {reasonType === 'others' && (
                  <input value={otherReason} onChange={e => setOtherReason(e.target.value)}
                    placeholder="Reason *"
                    className="w-full mt-2 rounded-lg border border-slate-200 px-2 py-1.5 text-sm outline-none"/>
                )}
              </div>

              <div className="mt-3 rounded-xl bg-emerald-50 border border-emerald-200 px-3 py-2.5 text-[11px] text-emerald-800">
                Approving will accept all {(reviewing.order_items || []).filter(i => i.approval_status === 'pending').length} custom-priced
                product{(reviewing.order_items || []).filter(i => i.approval_status === 'pending').length !== 1 ? 's' : ''} at
                their requested prices and release the full order to Billing.
              </div>
            </div>

            <div className="px-4 py-3 border-t flex gap-2 shrink-0">
              <button onClick={() => setReviewing(null)} className="flex-1 rounded-xl border border-slate-200 py-3 text-sm font-semibold text-slate-600">Cancel</button>
              <button onClick={handleApprove} disabled={busy}
                className="flex-2 rounded-xl bg-emerald-600 text-white px-6 py-3 text-sm font-bold disabled:bg-slate-300">
                {busy ? 'Approving…' : '✓ Approve Full Order → Billing'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Reject order modal */}
      {rejecting && (
        <div className="fixed inset-0 z-[200] bg-black/40 flex items-center justify-center px-4">
          <div className="bg-white w-full max-w-sm rounded-2xl p-5">
            <p className="font-bold text-slate-800 mb-1">Reject Full Order?</p>
            <p className="text-sm text-slate-500 mb-3">
              {rejecting.shop_name} · {fmtDate(rejecting.order_date)}<br />
              The Sales Rep will be notified and can resubmit the full order with revised prices.
            </p>
            <textarea
              value={rejectReason}
              onChange={e => setRejectReason(e.target.value)}
              rows={3}
              placeholder="Reason for rejection (required — rep will see this)"
              className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-red-400 resize-none mb-3"
            />
            <div className="flex gap-2">
              <button onClick={() => setRejecting(null)} disabled={busy} className="flex-1 rounded-xl border border-slate-200 py-2.5 text-sm font-semibold text-slate-600">Cancel</button>
              <button onClick={handleReject} disabled={busy} className="flex-1 rounded-xl bg-red-600 text-white py-2.5 text-sm font-bold disabled:bg-slate-300">
                {busy ? '…' : '✕ Reject Order'}
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 bg-slate-900 text-white text-sm font-semibold px-4 py-2.5 rounded-xl shadow-lg">
          {toast}
        </div>
      )}
    </div>
  )
}

// ── Expandable full product list ──────────────────────────────────────────────
function ExpandableProductList({ items }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="mt-3">
      <button
        onClick={() => setOpen(v => !v)}
        className="text-[11px] text-brand-700 font-semibold underline"
      >
        {open ? 'Hide full order' : `View full order (${items.length} products)`}
      </button>
      {open && (
        <div className="mt-2 space-y-1.5">
          {items.map(item => (
            <div key={item.id} className={`rounded-lg px-3 py-2 text-[11px] flex items-start justify-between gap-2 ${
              item.approval_status === 'pending' ? 'bg-amber-50 border border-amber-100' : 'bg-slate-50'
            }`}>
              <div>
                <span className="font-semibold text-slate-700">{item.product_name}</span>
                <span className="text-slate-400 ml-2">Qty {item.qty} {item.unit}</span>
              </div>
              <div className="text-right shrink-0">
                <span className={item.approval_status === 'pending' ? 'font-bold text-amber-700' : 'text-slate-600'}>
                  {rupee(item.unit_price)}
                </span>
                {item.approval_status === 'pending' && item.normal_price != null && (
                  <div className="text-slate-400">normal {rupee(item.normal_price)}</div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
