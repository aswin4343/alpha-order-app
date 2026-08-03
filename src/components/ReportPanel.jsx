import { useState } from 'react'
import { buildSalesReport, buildDeliveryReport } from '../utils/cloudSync.js'
import { exportMultiSheet } from '../utils/excel.js'

// Quick-range helpers.
function todayStr() {
  return new Date().toISOString().slice(0, 10)
}
function monthStart() {
  const d = new Date()
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10)
}

/**
 * Download performance report as Excel. kind = 'sales' | 'delivery'.
 * One file, one sheet per rep (detailed), for the chosen date range.
 */
export default function ReportPanel({ kind }) {
  const [from, setFrom] = useState(todayStr())
  const [to, setTo] = useState(todayStr())
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  const setToday = () => {
    setFrom(todayStr())
    setTo(todayStr())
  }
  const setThisMonth = () => {
    setFrom(monthStart())
    setTo(todayStr())
  }

  const download = async () => {
    setBusy(true)
    setMsg('')
    try {
      const rows =
        kind === 'sales' ? await buildSalesReport(from, to) : await buildDeliveryReport(from, to)
      if (!rows.length) {
        setMsg('No data for this range.')
        setBusy(false)
        return
      }
      // One sheet per rep (detailed): each rep's single-row summary on its own
      // sheet, plus an "All" overview sheet.
      const nameKey = kind === 'sales' ? 'Salesperson' : 'Delivery Staff'
      const sheets = [{ name: 'All', rows }]
      rows.forEach((r) => {
        sheets.push({ name: String(r[nameKey] || 'Rep'), rows: [r] })
      })
      const label = kind === 'sales' ? 'Sales' : 'Delivery'
      const fileName = `Alpha_${label}_Report_${from}_to_${to}.xlsx`
      await exportMultiSheet(sheets, fileName)
      setMsg('Report downloaded.')
    } catch (e) {
      console.error(e)
      setMsg('Could not generate report.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-2xl bg-white shadow-card border border-slate-100 p-3 mb-4">
      <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">
        📥 {kind === 'sales' ? 'Sales' : 'Delivery'} Performance Report (Excel)
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-[12px] text-slate-500">From</label>
        <input
          type="date"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          className="rounded-lg border border-slate-200 px-2.5 py-2 text-sm outline-none focus:border-brand-500 bg-white"
        />
        <label className="text-[12px] text-slate-500">To</label>
        <input
          type="date"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          className="rounded-lg border border-slate-200 px-2.5 py-2 text-sm outline-none focus:border-brand-500 bg-white"
        />
        <button
          onClick={setToday}
          className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 active:bg-slate-50"
        >
          Today
        </button>
        <button
          onClick={setThisMonth}
          className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 active:bg-slate-50"
        >
          This Month
        </button>
        <button
          onClick={download}
          disabled={busy}
          className="rounded-lg bg-brand-600 text-white px-4 py-2 text-sm font-semibold active:bg-brand-700 disabled:bg-slate-300"
        >
          {busy ? 'Generating…' : 'Download Excel'}
        </button>
      </div>
      {msg && <p className="text-[12px] text-slate-500 mt-2">{msg}</p>}
    </div>
  )
}
