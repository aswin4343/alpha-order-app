import { useEffect, useState } from 'react'
import { loadBillingReps } from '../utils/cloudSync.js'

/**
 * Read-only Billing overview for Admin. Reuses loadBillingReps — the exact
 * same aggregate the Billing team's own dashboard is built from — so the
 * numbers here are guaranteed to match what Billing staff see, not an
 * approximation. No verify/edit actions are exposed; this is visibility only.
 */
export default function AdminBillingView() {
  const [reps, setReps] = useState(null) // null = loading
  const [error, setError] = useState(false)

  const refresh = async () => {
    setError(false)
    try {
      setReps(await loadBillingReps())
    } catch (e) {
      console.error(e)
      setError(true)
    }
  }

  useEffect(() => { refresh() }, [])

  const totalPending = (reps || []).reduce((s, r) => s + r.pending, 0)
  const totalVerifiedToday = (reps || []).reduce((s, r) => s + r.verifiedToday, 0)

  return (
    <div className="px-3 sm:px-6 pt-4 pb-10 max-w-3xl">
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide">
          Billing — Read-Only Overview
        </p>
        <button onClick={refresh} className="text-xs font-semibold text-brand-600 px-2 py-1 rounded-lg active:bg-brand-50">
          ↻ Refresh
        </button>
      </div>

      {error && <p className="text-center text-sm text-red-500 py-6">Could not load billing data.</p>}
      {!reps && !error && (
        <div className="py-16 flex justify-center">
          <div className="h-8 w-8 rounded-full border-4 border-brand-100 border-t-brand-600 animate-spin" />
        </div>
      )}

      {reps && (
        <>
          <div className="grid grid-cols-2 gap-2 mb-4">
            <div className="rounded-2xl bg-white shadow-card border border-slate-100 p-3.5 text-center">
              <p className="text-2xl font-bold text-amber-600">{totalPending}</p>
              <p className="text-[11px] text-slate-500 mt-0.5">Pending Verification</p>
            </div>
            <div className="rounded-2xl bg-white shadow-card border border-slate-100 p-3.5 text-center">
              <p className="text-2xl font-bold text-brand-700">{totalVerifiedToday}</p>
              <p className="text-[11px] text-slate-500 mt-0.5">Verified Today</p>
            </div>
          </div>

          <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2 px-1">By Sales Rep</p>
          <div className="rounded-2xl bg-white shadow-card border border-slate-100 divide-y divide-slate-50">
            {reps.map((r) => (
              <div key={r.id} className="flex items-center justify-between px-3 py-2.5">
                <span className="text-sm font-medium text-slate-700">{r.name}</span>
                <div className="flex items-center gap-4 text-sm">
                  <span className="text-amber-600 font-semibold">{r.pending} pending</span>
                  <span className="text-brand-700 font-semibold">{r.verifiedToday} verified</span>
                </div>
              </div>
            ))}
            {reps.length === 0 && (
              <p className="text-center text-sm text-slate-400 py-6">No pending or recently verified orders.</p>
            )}
          </div>

          <p className="text-[11px] text-slate-400 mt-4 text-center">
            This is a read-only view. Billing verification is done by the Billing team.
          </p>
        </>
      )}
    </div>
  )
}
