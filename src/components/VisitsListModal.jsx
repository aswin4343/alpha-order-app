import { useEffect, useState } from 'react'
import { loadVisitsList } from '../utils/cloudSync.js'
import { CloseIcon } from './Icons.jsx'

function fmtDate(iso) {
  try { return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) } catch { return '' }
}
function fmtTime(iso) {
  try { return new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true }) } catch { return '' }
}

const statusStyle = (s) => {
  const v = (s || '').toLowerCase()
  if (v.includes('close') || v.includes('not')) return 'text-red-700 bg-red-100'
  return 'text-emerald-700 bg-emerald-100'
}

/**
 * Shop Visits drill-down: KPI -> list of visited shops -> tap a shop to
 * expand its visit details inline (status, time, remark).
 */
export default function VisitsListModal({ userId, start, end, route, periodLabel, onClose }) {
  const [visits, setVisits] = useState(null) // null = loading
  const [error, setError] = useState(false)
  const [openId, setOpenId] = useState(null)

  useEffect(() => {
    let active = true
    ;(async () => {
      try {
        const data = await loadVisitsList(userId, start, end, route || null)
        if (active) setVisits(data)
      } catch {
        if (active) { setError(true); setVisits([]) }
      }
    })()
    return () => { active = false }
  }, [userId, start, end, route])

  return (
    <div className="fixed inset-0 z-[60] bg-black/40 flex items-end sm:items-center justify-center">
      <div className="bg-white w-full sm:max-w-md rounded-t-3xl sm:rounded-3xl max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100">
          <div className="min-w-0">
            <h2 className="font-bold text-slate-800">Shop Visits</h2>
            <p className="text-xs text-slate-400">{periodLabel}</p>
          </div>
          <button onClick={onClose} className="p-2 text-slate-400" aria-label="Close">
            <CloseIcon className="h-5 w-5" />
          </button>
        </div>

        <div className="overflow-y-auto px-4 py-3 scroll-area">
          {visits === null && (
            <div className="py-10 flex justify-center">
              <div className="h-8 w-8 rounded-full border-4 border-brand-100 border-t-brand-600 animate-spin" />
            </div>
          )}
          {error && <p className="py-6 text-center text-sm text-red-500">Could not load visits.</p>}
          {visits && visits.length === 0 && !error && (
            <p className="py-10 text-center text-sm text-slate-400">No shop visits recorded for this period.</p>
          )}

          {visits && visits.map((v) => (
            <button
              key={v.id}
              onClick={() => setOpenId(openId === v.id ? null : v.id)}
              className="w-full text-left rounded-2xl border border-slate-200 mb-2.5 p-3 active:bg-slate-50"
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-slate-800">{v.shop_name}</span>
                <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${statusStyle(v.visit_status)}`}>
                  {v.visit_status || 'Visited'}
                </span>
              </div>
              <p className="text-[11px] text-slate-400 mt-0.5">
                {v.route || 'No route'} · {fmtDate(v.created_at)}, {fmtTime(v.created_at)}
              </p>
              {openId === v.id && (
                <div className="mt-2 pt-2 border-t border-slate-100 text-[12px] text-slate-600">
                  <div className="flex justify-between py-0.5"><span className="text-slate-400">Status</span><span>{v.visit_status || '—'}</span></div>
                  <div className="flex justify-between py-0.5"><span className="text-slate-400">Time</span><span>{fmtTime(v.created_at)}</span></div>
                  {v.custom_remark && (
                    <div className="mt-1.5 rounded-lg bg-slate-50 p-2 text-slate-600">{v.custom_remark}</div>
                  )}
                </div>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
