import { useState, useEffect } from 'react'
import { useAuth } from '../context/AuthContext.jsx'
import { loadPendingApprovalBills, approveBill, rejectBill } from '../utils/cloudSync.js'

const APPROVE_REASONS = [
  { value: 'competitor',  label: 'Competitor Price',            needsName: true },
  { value: 'bulk',        label: 'Customer Taking Bulk Quantity' },
  { value: 'near_expiry', label: 'Product Near Expiry' },
  { value: 'others',      label: 'Others',                      needsOther: true }
]

const rupee = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`

export default function AdminBillApprovalsPage() {
  const { profile } = useAuth()
  const [bills, setBills] = useState(null)
  const [reviewing, setReviewing] = useState(null)
  const [itemPrices, setItemPrices] = useState({}) // itemId → approvedPrice
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
    // Pre-fill item prices with requested prices
    const prices = {}
    for (const item of bill.order_items || []) {
      if (item.approval_status === 'pending') {
        prices[item.id] = item.approved_price != null ? item.approved_price : item.unit_price
      }
    }
    setItemPrices(prices)
  }

  const handleApprove = async () => {
    if (!reasonType) { alert('Please select an approval reason.'); return }
    const r = APPROVE_REASONS.find(x => x.value === reasonType)
    if (r?.needsName && !competitorName.trim()) { alert('Competitor Name required.'); return }
    if (r?.needsOther && !otherReason.trim()) { alert('Reason required.'); return }
    setBusy(true)
    try {
      // Include productId so approveBill can save last_approved_price on the product
      const itemsNeedingApproval = (reviewing.order_items || []).filter(i => i.approval_status === 'pending')
      const overrides = itemsNeedingApproval.map(i => ({
        itemId: i.id,
        approvedPrice: Number(itemPrices[i.id] ?? i.unit_price),
        productId: i.product_id ?? null
      }))
      await approveBill(reviewing.id, overrides, profile, {
        reasonType, competitorName: competitorName.trim() || undefined, otherReason: otherReason.trim() || undefined
      })
      setBills(prev => (prev || []).filter(b => b.id !== reviewing.id))
      setReviewing(null)
      flash('Bill approved and sent to Billing.')
    } catch (e) { console.error(e); alert('Approval failed: ' + (e?.message || 'unknown')) }
    finally { setBusy(false) }
  }

  const handleReject = async () => {
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
    <div className="px-3 sm:px-6 pt-4 pb-10 max-w-4xl">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-lg font-bold text-slate-800">Bill Approvals</h1>
          <p className="text-[12px] text-slate-400">Bills awaiting Admin approval before reaching Billing.</p>
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
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-bold text-slate-800 truncate">{bill.shop_name}</p>
                    <p className="text-[11px] text-slate-400">{bill.profiles?.full_name} · {bill.order_date} · {bill.total_products} products</p>
                    <p className="text-sm font-semibold text-amber-700 mt-0.5">⚠ {specialItems.length} item{specialItems.length !== 1 ? 's' : ''} need approval</p>
                  </div>
                  <div className="flex gap-2 shrink-0">
                    <button onClick={() => { setRejecting(bill); setRejectReason('') }}
                      className="text-xs font-bold text-red-600 border border-red-200 rounded-lg px-3 py-1.5">Reject</button>
                    <button onClick={() => openReview(bill)}
                      className="text-xs font-bold text-white bg-emerald-600 rounded-lg px-3 py-1.5">Review & Approve</button>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Review modal */}
      {reviewing && (
        <div className="fixed inset-0 z-[200] bg-black/40 flex items-end sm:items-center justify-center px-0 sm:px-4">
          <div className="bg-white w-full sm:max-w-lg rounded-t-3xl sm:rounded-3xl max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between px-4 py-3 border-b">
              <div>
                <h2 className="font-bold text-slate-800">Review Bill</h2>
                <p className="text-xs text-slate-400">{reviewing.shop_name} · {reviewing.order_date}</p>
              </div>
              <button onClick={() => setReviewing(null)} className="text-slate-400 text-lg">✕</button>
            </div>
            <div className="overflow-y-auto flex-1 px-4 py-3 space-y-3">
              {(reviewing.order_items || []).map(item => {
                const needsApproval = item.approval_status === 'pending'
                const diff = needsApproval && item.normal_price != null
                  ? (item.unit_price - item.normal_price)
                  : null
                return (
                  <div key={item.id} className={`rounded-xl border p-3 ${needsApproval ? 'border-amber-200 bg-amber-50' : 'border-slate-100'}`}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-semibold text-slate-800 truncate">{item.product_name}</span>
                      {needsApproval && <span className="text-[10px] font-bold text-amber-700 bg-amber-100 px-2 py-0.5 rounded shrink-0">⚠ NEEDS APPROVAL</span>}
                    </div>
                    <p className="text-[11px] text-slate-500 mt-0.5">Qty {item.qty} {item.unit}</p>
                    {needsApproval && (
                      <div className="mt-2 space-y-1.5">
                        <div className="grid grid-cols-3 gap-2 text-center text-[11px]">
                          <div className="rounded-lg border border-slate-200 p-1.5">
                            <div className="font-bold text-slate-700">{rupee(item.normal_price)}</div>
                            <div className="text-slate-400">Current</div>
                          </div>
                          <div className="rounded-lg border border-purple-200 bg-purple-50 p-1.5">
                            <div className="font-bold text-purple-700">{rupee(item.unit_price)}</div>
                            <div className="text-purple-500">Requested</div>
                          </div>
                          <div className={`rounded-lg border p-1.5 ${diff != null && diff < 0 ? 'border-red-200 bg-red-50' : 'border-emerald-200 bg-emerald-50'}`}>
                            <div className={`font-bold ${diff != null && diff < 0 ? 'text-red-700' : 'text-emerald-700'}`}>{diff != null ? `${diff > 0 ? '+' : ''}₹${Math.abs(diff).toFixed(2)}` : '—'}</div>
                            <div className="text-slate-400">Diff</div>
                          </div>
                        </div>
                        <div>
                          <label className="text-[10px] font-semibold text-slate-500 uppercase">Admin Approved Price (₹)</label>
                          <input type="number" value={itemPrices[item.id] ?? ''} onChange={e => setItemPrices(p => ({ ...p, [item.id]: e.target.value }))}
                            className="w-full mt-1 rounded-lg border border-slate-200 px-2 py-1.5 text-sm outline-none focus:border-brand-500"/>
                          {itemPrices[item.id] != null && Number(itemPrices[item.id]) !== item.unit_price && (
                            <p className="text-[10px] text-amber-700 mt-0.5">Modified from ₹{item.unit_price}</p>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}

              <div>
                <p className="text-xs font-semibold text-slate-700 mb-1">Approval Reason *</p>
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
            </div>
            <div className="px-4 py-3 border-t flex gap-2">
              <button onClick={() => setReviewing(null)} className="flex-1 rounded-xl border border-slate-200 py-3 text-sm font-semibold text-slate-600">Cancel</button>
              <button onClick={handleApprove} disabled={busy}
                className="flex-1 rounded-xl bg-emerald-600 text-white py-3 text-sm font-bold disabled:bg-slate-300">
                {busy ? 'Approving…' : '✓ Approve Bill'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Reject modal */}
      {rejecting && (
        <div className="fixed inset-0 z-[200] bg-black/40 flex items-center justify-center px-4">
          <div className="bg-white w-full max-w-sm rounded-2xl p-5">
            <p className="font-bold text-slate-800 mb-1">Reject Bill?</p>
            <p className="text-sm text-slate-500 mb-3">{rejecting.shop_name}</p>
            <textarea value={rejectReason} onChange={e => setRejectReason(e.target.value)} rows={3}
              placeholder="Reason for rejection (required)"
              className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-red-400 resize-none mb-3"/>
            <div className="flex gap-2">
              <button onClick={() => setRejecting(null)} disabled={busy} className="flex-1 rounded-xl border border-slate-200 py-2.5 text-sm font-semibold text-slate-600">Cancel</button>
              <button onClick={handleReject} disabled={busy} className="flex-1 rounded-xl bg-red-600 text-white py-2.5 text-sm font-bold disabled:bg-slate-300">
                {busy ? '…' : 'Confirm Reject'}
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 bg-slate-900 text-white text-sm font-semibold px-4 py-2.5 rounded-xl shadow-lg">{toast}</div>}
    </div>
  )
}
