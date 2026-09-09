import { useEffect, useMemo, useState } from 'react'
import { loadLoadingSheetData, listAllRoutes, listSalesRepsForFilter } from '../utils/cloudSync.js'
import { exportLoadingSheetExcel } from '../utils/excel.js'

function toDateInput(d) {
  const x = new Date(d)
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`
}
const fmtINR = (n) => `₹${Math.round(n || 0).toLocaleString('en-IN')}`

/**
 * Loading Sheet — Billing Team only. Additive feature: this file is new,
 * and its one integration point into the existing app is a single button
 * in BillingDashboard.jsx's header, added alongside the existing Edit
 * History / Partial Verification / Deleted Bills buttons using the exact
 * same styling and open/close pattern those already use. Nothing existing
 * was restructured to accommodate this.
 *
 * ACCESS: this component is only ever rendered from inside
 * BillingDashboard.jsx, which is itself only reachable by the billing_team
 * role (existing app-level routing/auth, unchanged here). The data function
 * it calls (loadLoadingSheetData) uses the same supabase client and query
 * pattern as every other Billing function in this file, so it is subject
 * to whatever row-level security already governs orders/order_items — no
 * new or separate permission system was introduced.
 */
export default function LoadingSheetModal({ onClose }) {
  const today = new Date()
  const [fromDate, setFromDate] = useState(toDateInput(today))
  const [toDate, setToDate] = useState(toDateInput(today))
  const [route, setRoute] = useState('')
  const [salesRepId, setSalesRepId] = useState('')
  const [routes, setRoutes] = useState([])
  const [reps, setReps] = useState([])
  const [rows, setRows] = useState(null)
  const [error, setError] = useState(false)

  // Filter option lists — loaded once. Reuses the existing route/sales-rep
  // data already used elsewhere in the app (listAllRoutes, and a small
  // dedicated profiles query mirroring how loadBillingReps itself resolves
  // rep names) rather than introducing a second source for either.
  useEffect(() => {
    listAllRoutes().then(setRoutes).catch(() => {})
    listSalesRepsForFilter().then(setReps).catch(() => {})
  }, [])

  useEffect(() => {
    let cancelled = false
    setRows(null); setError(false)
    loadLoadingSheetData({ fromDateStr: fromDate, toDateStr: toDate, route: route || null, salesRepId: salesRepId || null })
      .then((data) => { if (!cancelled) setRows(data) })
      .catch((e) => { console.error(e); if (!cancelled) setError(true) })
    return () => { cancelled = true }
  }, [fromDate, toDate, route, salesRepId])

  const grandTotalSum = useMemo(() => (rows || []).reduce((s, r) => s + r.grandTotal, 0), [rows])

  const downloadExcel = () => {
    const fileName = `Alpha_Flow_Loading_Sheet_${toDateInput(today)}.xlsx`
    // Human-readable date range for the heading, e.g. "01 Sep 2026 - 09 Sep 2026".
    const fmtDay = (s) => {
      const [y, m, d] = s.split('-').map(Number)
      const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][m - 1]
      return `${String(d).padStart(2, '0')} ${mon} ${y}`
    }
    const dateRangeLabel = fromDate === toDate ? fmtDay(fromDate) : `${fmtDay(fromDate)} - ${fmtDay(toDate)}`
    // Route label reuses the on-screen selection; blank means "All Routes"
    // (the same wording the filter dropdown shows for the no-route option).
    const routeLabel = route ? route : 'ALL ROUTES'
    // Excel download still proceeds on zero results — an empty workbook with
    // correct headers is a legitimate, explainable export, not a misleading
    // one, per the spec's own edge-case guidance.
    exportLoadingSheetExcel(rows || [], fileName, { routeLabel, dateRangeLabel })
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 overflow-y-auto">
      <div className="min-h-full flex flex-col items-center py-4 px-2">
        <div className="w-full max-w-4xl bg-white rounded-2xl shadow-2xl">
          <div className="flex items-center justify-between p-4 border-b border-slate-100">
            <h2 className="text-lg font-bold text-slate-800">Loading Sheet</h2>
            <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-xl leading-none px-2">×</button>
          </div>

          {/* Filters — Date range, Route, Sales Rep. All optional except the
              date range (defaulted to today); combine via simple AND, same
              as every other filtered list already in this app. */}
          <div className="p-4 border-b border-slate-100 grid grid-cols-1 sm:grid-cols-4 gap-2">
            <div>
              <label className="text-[11px] font-semibold text-slate-500 block mb-1">From Date</label>
              <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)}
                className="w-full rounded-lg border border-slate-200 px-2 py-2 text-sm" />
            </div>
            <div>
              <label className="text-[11px] font-semibold text-slate-500 block mb-1">To Date</label>
              <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)}
                className="w-full rounded-lg border border-slate-200 px-2 py-2 text-sm" />
            </div>
            <div>
              <label className="text-[11px] font-semibold text-slate-500 block mb-1">Route</label>
              <select value={route} onChange={(e) => setRoute(e.target.value)}
                className="w-full rounded-lg border border-slate-200 px-2 py-2 text-sm bg-white">
                <option value="">All Routes</option>
                {routes.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
            <div>
              <label className="text-[11px] font-semibold text-slate-500 block mb-1">Sales Rep</label>
              <select value={salesRepId} onChange={(e) => setSalesRepId(e.target.value)}
                className="w-full rounded-lg border border-slate-200 px-2 py-2 text-sm bg-white">
                <option value="">All Sales Reps</option>
                {reps.map((r) => <option key={r.id} value={r.id}>{r.full_name}</option>)}
              </select>
            </div>
          </div>

          <div className="p-4">
            {rows == null ? (
              <div className="py-14 flex justify-center"><div className="h-6 w-6 rounded-full border-4 border-slate-200 border-t-slate-800 animate-spin" /></div>
            ) : error ? (
              <p className="text-center text-sm text-red-600 py-10">Could not load the loading sheet.</p>
            ) : rows.length === 0 ? (
              <p className="text-center text-sm text-slate-400 py-10">No verified bills found for the selected filters.</p>
            ) : (
              <>
                <div className="flex items-center justify-between mb-3">
                  <p className="text-xs text-slate-500">{rows.length} verified order{rows.length === 1 ? '' : 's'}</p>
                  <p className="text-sm font-bold text-slate-800">Total: {fmtINR(grandTotalSum)}</p>
                </div>
                <div className="max-h-[45vh] overflow-y-auto border border-slate-100 rounded-xl">
                  <table className="w-full text-[12px] border-collapse">
                    <thead className="sticky top-0 bg-slate-900 text-white">
                      <tr>
                        <th className="px-2 py-1.5 text-left w-10">SL</th>
                        <th className="px-2 py-1.5 text-left">Shop Name</th>
                        <th className="px-2 py-1.5 text-left">Sales Rep</th>
                        <th className="px-2 py-1.5 text-right">Grand Total</th>
                        <th className="px-2 py-1.5 text-left">Verification Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r, i) => (
                        <tr key={r.orderId} className="odd:bg-white even:bg-slate-50 border-t border-slate-100">
                          <td className="px-2 py-1.5">{i + 1}</td>
                          <td className="px-2 py-1.5">{r.shopName}</td>
                          <td className="px-2 py-1.5">{r.salesRepName}</td>
                          <td className="px-2 py-1.5 text-right font-semibold">{fmtINR(r.grandTotal)}</td>
                          <td className="px-2 py-1.5">
                            <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${r.verificationStatus === 'VERIFIED' ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'}`}>
                              {r.verificationStatus}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>

          <div className="p-4 border-t border-slate-100 flex justify-end">
            <button onClick={downloadExcel} disabled={rows == null}
              className="rounded-xl bg-emerald-600 text-white px-5 py-2.5 text-sm font-bold shadow hover:bg-emerald-700 disabled:bg-slate-400">
              📊 Download Loading Sheet
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
