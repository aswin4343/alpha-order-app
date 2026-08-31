import { useState, useEffect, useMemo } from 'react'
import { useAuth } from '../context/AuthContext.jsx'
import { loadPendingApprovals, approveSpecialPrice, rejectSpecialPrice } from '../utils/cloudSync.js'

const REJECT_REASONS = [
  'Price too low for this customer',
  'Discount exceeds allowed limit',
  'Needs manager sign-off first',
  'Incorrect price entered',
  'Others'
]

/**
 * Every order line where a rep set a price that differs from the system
 * default (MRP/RP/WP) — flagged automatically at order creation, held out of
 * Billing's invoice until Admin decides. Approve makes it billable
 * immediately; Reject excludes it permanently with a reason.
 */
export default function AdminApprovalsPage() {
  const { profile } = useAuth()
  const [rows, setRows] = useState(null)
  const [busyId, setBusyId] = useState(null)
  const [rejecting, setRejecting] = useState(null) // item currently choosing a reject reason
  const [reason, setReason] = useState('')
  const [toast, setToast] = useState('')

  const refresh = () => { setRows(null); loadPendingApprovals().then(setRows).catch(() => setRows([])) }
  useEffect(() => { refresh() }, [])

  const flash = (m) => { setToast(m); setTimeout(() => setToast(''), 3000) }

  const groups = useMemo(() => {
    const byShop = new Map()
    for (const r of rows || []) {
      const key = r.orders?.shop_name || '—'
      if (!byShop.has(key)) byShop.set(key, [])
      byShop.get(key).push(r)
    }
    return Array.from(byShop.entries())
  }, [rows])

  const approve = async (item) => {
    setBusyId(item.id)
    try {
      await approveSpecialPrice(item.id, profile?.full_name, profile?.id)
      setRows((prev) => prev.filter((r) => r.id !== item.id))
      flash(`Approved ₹${item.unit_price} for ${item.product_name}.`)
    } catch (e) { console.error(e); alert('Could not approve.') }
    finally { setBusyId(null) }
  }

  const confirmReject = async (item) => {
    const finalReason = reason === 'Others' ? (reason.trim() || 'Others') : reason
    if (!finalReason) { alert('Please choose a reason.'); return }
    setBusyId(item.id)
    try {
      await rejectSpecialPrice(item.id, profile?.full_name, profile?.id, finalReason)
      setRows((prev) => prev.filter((r) => r.id !== item.id))
      setRejecting(null)
      flash(`Rejected ${item.product_name}.`)
    } catch (e) { console.error(e); alert('Could not reject.') }
    finally { setBusyId(null) }
  }

  return (
    <div className="px-3 sm:px-6 pt-4 pb-10 max-w-3xl">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-lg font-bold text-slate-800">Price Approvals</h1>
          <p className="text-[12px] text-slate-400">Special/custom prices awaiting sign-off. Everything else in these orders bills normally.</p>
        </div>
        <button onClick={refresh} className="text-sm font-semibold text-brand-700 px-3 py-1.5 rounded-lg border border-slate-200 hover:bg-slate-50">Refresh</button>
      </div>

      {rows == null ? (
        <div className="py-16 flex justify-center"><div className="h-6 w-6 rounded-full border-4 border-slate-200 border-t-slate-800 animate-spin" /></div>
      ) : rows.length === 0 ? (
        <div className="py-16 text-center">
          <p className="font-semibold text-slate-600">No prices waiting for approval</p>
          <p className="text-sm text-slate-400 mt-1">Every special-priced line has been decided.</p>
        </div>
      ) : (
        <div className="space-y-5">
          {groups.map(([shop, items]) => (
            <div key={shop}>
              <p className="text-[11px] font-bold text-slate-500 uppercase tracking-wide mb-1.5">
                {shop}{items[0]?.orders?.route ? `, ${items[0].orders.route}` : ''}
              </p>
              <div className="space-y-2">
                {items.map((it) => {
                  const diff = it.normal_price != null ? it.unit_price - it.normal_price : null
                  return (
                    <div key={it.id} className="rounded-2xl bg-white border border-purple-200 p-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-slate-800 truncate">{it.product_name}</p>
                          <p className="text-[11px] text-slate-400">
                            {it.sales_rep_name || '—'} · Qty {it.qty} {it.unit} · {it.orders?.order_date}
                          </p>
                        </div>
                        <span className="shrink-0 text-[10px] font-bold text-purple-700 bg-purple-50 px-2 py-1 rounded-lg">SPECIAL PRICE</span>
                      </div>

                      <div className="grid grid-cols-3 gap-2 mt-2.5 text-center">
                        <div className="rounded-lg border border-slate-200 py-1.5">
                          <div className="text-sm font-bold text-slate-800">₹{it.normal_price ?? '—'}</div>
                          <div className="text-[9px] text-slate-400 uppercase">Normal</div>
                        </div>
                        <div className="rounded-lg border border-purple-200 bg-purple-50 py-1.5">
                          <div className="text-sm font-bold text-purple-700">₹{it.unit_price}</div>
                          <div className="text-[9px] text-purple-500 uppercase">Requested</div>
                        </div>
                        <div className={`rounded-lg border py-1.5 ${diff < 0 ? 'border-red-200 bg-red-50' : 'border-emerald-200 bg-emerald-50'}`}>
                          <div className={`text-sm font-bold ${diff < 0 ? 'text-red-700' : 'text-emerald-700'}`}>{diff != null ? `${diff > 0 ? '+' : ''}₹${diff}` : '—'}</div>
                          <div className="text-[9px] text-slate-400 uppercase">Diff</div>
                        </div>
                      </div>

                      {rejecting === it.id ? (
                        <div className="mt-2.5 space-y-2">
                          <select value={reason} onChange={(e) => setReason(e.target.value)}
                            className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-sm outline-none focus:border-brand-500">
                            <option value="">Select a reason…</option>
                            {REJECT_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
                          </select>
                          <div className="flex gap-2">
                            <button onClick={() => { setRejecting(null); setReason('') }} className="flex-1 text-xs font-semibold text-slate-500 border border-slate-200 rounded-lg py-1.5">Cancel</button>
                            <button onClick={() => confirmReject(it)} disabled={busyId === it.id}
                              className="flex-1 text-xs font-bold text-white bg-red-600 rounded-lg py-1.5 disabled:bg-slate-300">
                              {busyId === it.id ? '…' : 'Confirm Reject'}
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex gap-2 mt-2.5">
                          <button onClick={() => approve(it)} disabled={busyId === it.id}
                            className="flex-1 text-xs font-bold text-white bg-emerald-600 rounded-lg py-2 disabled:bg-slate-300">
                            ✓ Approve
                          </button>
                          <button onClick={() => { setRejecting(it.id); setReason('') }} disabled={busyId === it.id}
                            className="flex-1 text-xs font-bold text-red-600 border border-red-200 rounded-lg py-2">
                            ✕ Reject
                          </button>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
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
