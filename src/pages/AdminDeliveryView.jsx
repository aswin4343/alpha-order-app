import { useEffect, useState } from 'react'
import { loadDeliveryCounts } from '../utils/cloudSync.js'

const CARDS = [
  { key: 'pending', label: 'Pending', color: 'text-amber-600' },
  { key: 'assigned', label: 'Assigned', color: 'text-blue-600' },
  { key: 'inProgress', label: 'In Progress', color: 'text-purple-600' },
  { key: 'delivered', label: 'Delivered', color: 'text-brand-700' },
  { key: 'partial', label: 'Partial', color: 'text-amber-700' },
  { key: 'failed', label: 'Failed', color: 'text-red-600' }
]

/**
 * Read-only Delivery overview for Admin. Uses lightweight status counts
 * (loadDeliveryCounts) rather than the full delivery/tracking data the
 * Delivery Admin's own working dashboard loads — this view is for visibility,
 * not for assigning routes or drivers, so it stays fast and simple.
 */
export default function AdminDeliveryView() {
  const [counts, setCounts] = useState(null) // null = loading
  const [error, setError] = useState(false)

  const refresh = async () => {
    setError(false)
    try {
      setCounts(await loadDeliveryCounts())
    } catch (e) {
      console.error(e)
      setError(true)
    }
  }

  useEffect(() => { refresh() }, [])

  const totalActive = counts
    ? counts.pending + counts.assigned + counts.inProgress
    : 0

  return (
    <div className="px-3 sm:px-6 pt-4 pb-10 max-w-3xl">
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide">
          Delivery — Read-Only Overview
        </p>
        <button onClick={refresh} className="text-xs font-semibold text-brand-600 px-2 py-1 rounded-lg active:bg-brand-50">
          ↻ Refresh
        </button>
      </div>

      {error && <p className="text-center text-sm text-red-500 py-6">Could not load delivery data.</p>}
      {!counts && !error && (
        <div className="py-16 flex justify-center">
          <div className="h-8 w-8 rounded-full border-4 border-brand-100 border-t-brand-600 animate-spin" />
        </div>
      )}

      {counts && (
        <>
          <div className="rounded-2xl bg-white shadow-card border border-slate-100 p-3.5 text-center mb-4">
            <p className="text-2xl font-bold text-brand-700">{totalActive}</p>
            <p className="text-[11px] text-slate-500 mt-0.5">Active Deliveries (not yet delivered)</p>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mb-4">
            {CARDS.map((c) => (
              <div key={c.key} className="rounded-2xl bg-white shadow-card border border-slate-100 p-3.5 text-center">
                <p className={`text-2xl font-bold ${c.color}`}>{counts[c.key]}</p>
                <p className="text-[11px] text-slate-500 mt-0.5">{c.label}</p>
              </div>
            ))}
          </div>

          {counts.failed > 0 && (
            <div className="rounded-2xl bg-red-50 border border-red-100 p-3.5 mb-4">
              <p className="text-sm text-red-700">
                <b>{counts.failed}</b> failed deliver{counts.failed === 1 ? 'y needs' : 'ies need'} attention.
              </p>
            </div>
          )}

          <p className="text-[11px] text-slate-400 mt-4 text-center">
            This is a read-only view. Assigning routes and drivers is done by Delivery Admin.
          </p>
        </>
      )}
    </div>
  )
}
