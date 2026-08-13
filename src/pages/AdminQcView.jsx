import { useEffect, useState } from 'react'
import { loadQcCounts } from '../utils/cloudSync.js'

const CARDS = [
  { key: 'pending', label: 'Pending', color: 'text-amber-600' },
  { key: 'inProgress', label: 'In Progress', color: 'text-blue-600' },
  { key: 'verifiedToday', label: 'Verified Today', color: 'text-brand-700' },
  { key: 'returned', label: 'Returned', color: 'text-red-600' }
]

/**
 * Read-only Quality Check overview for Admin. Reuses loadQcCounts — the exact
 * same function the QC team's own dashboard header uses — so these numbers
 * always match what QC staff see. No verify/override actions here.
 */
export default function AdminQcView() {
  const [counts, setCounts] = useState(null) // null = loading
  const [error, setError] = useState(false)

  const refresh = async () => {
    setError(false)
    try {
      setCounts(await loadQcCounts())
    } catch (e) {
      console.error(e)
      setError(true)
    }
  }

  useEffect(() => { refresh() }, [])

  return (
    <div className="px-3 sm:px-6 pt-4 pb-10 max-w-3xl">
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide">
          Quality Check — Read-Only Overview
        </p>
        <button onClick={refresh} className="text-xs font-semibold text-brand-600 px-2 py-1 rounded-lg active:bg-brand-50">
          ↻ Refresh
        </button>
      </div>

      {error && <p className="text-center text-sm text-red-500 py-6">Could not load QC data.</p>}
      {!counts && !error && (
        <div className="py-16 flex justify-center">
          <div className="h-8 w-8 rounded-full border-4 border-brand-100 border-t-brand-600 animate-spin" />
        </div>
      )}

      {counts && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
            {CARDS.map((c) => (
              <div key={c.key} className="rounded-2xl bg-white shadow-card border border-slate-100 p-3.5 text-center">
                <p className={`text-2xl font-bold ${c.color}`}>{counts[c.key]}</p>
                <p className="text-[11px] text-slate-500 mt-0.5">{c.label}</p>
              </div>
            ))}
          </div>

          {counts.returned > 0 && (
            <div className="rounded-2xl bg-red-50 border border-red-100 p-3.5 mb-4">
              <p className="text-sm text-red-700">
                <b>{counts.returned}</b> order{counts.returned === 1 ? '' : 's'} currently returned from QC and need attention.
              </p>
            </div>
          )}

          <p className="text-[11px] text-slate-400 mt-4 text-center">
            This is a read-only view. Product verification is done by the QC team.
          </p>
        </>
      )}
    </div>
  )
}
