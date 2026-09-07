import { useEffect, useMemo, useState } from 'react'
import { loadShortageSalesLossReport } from '../utils/cloudSync.js'
import { exportShortageSalesLossExcel } from '../utils/excel.js'

function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x }
function endOfDay(d) { const x = new Date(d); x.setHours(23, 59, 59, 999); return x }
function toDateInput(d) {
  const x = new Date(d)
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`
}
const fmtINR = (n) => `₹${Math.round(n || 0).toLocaleString('en-IN')}`
const fmtDateDDMMYYYY = (dateStr) => {
  if (!dateStr) return '—'
  const [y, m, d] = dateStr.split('-')
  return `${d}/${m}/${y}`
}

/**
 * Product Shortage Sales Loss Report.
 *
 * Replaces the old order-level Partial Verification Report (which listed
 * verified vs stock-out products per order, with no quantity or sales-value
 * breakdown) with a line-level report answering the actual business
 * question: how much sales revenue is lost to stock shortages, and which
 * products are responsible.
 *
 * The date-filter UI (Today / Yesterday / Custom Date / Date Range) and the
 * print-via-dedicated-window mechanism are carried over unchanged from the
 * previous version of this component — both already worked correctly and
 * neither is specific to the old report's data shape.
 */
export default function PartialVerificationReport({ onClose }) {
  const today = new Date()
  const [preset, setPreset] = useState('today')
  const [fromDate, setFromDate] = useState(toDateInput(today))
  const [toDate, setToDate] = useState(toDateInput(today))
  const [rows, setRows] = useState(null)
  const [error, setError] = useState(false)

  const range = useMemo(() => {
    if (preset === 'today') return [startOfDay(today), endOfDay(today)]
    if (preset === 'yesterday') {
      const y = new Date(today); y.setDate(y.getDate() - 1)
      return [startOfDay(y), endOfDay(y)]
    }
    if (preset === 'date') return [startOfDay(fromDate), endOfDay(fromDate)]
    return [startOfDay(fromDate), endOfDay(toDate)]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset, fromDate, toDate])

  // order_date is a plain YYYY-MM-DD string (see saveCloudOrder), so the
  // report's query needs the same string form, not an ISO timestamp — this
  // is the one place the old ISO-based range needs converting.
  const fromDateStr = useMemo(() => toDateInput(range[0]), [range])
  const toDateStr = useMemo(() => toDateInput(range[1]), [range])

  useEffect(() => {
    let cancelled = false
    setRows(null); setError(false)
    loadShortageSalesLossReport(fromDateStr, toDateStr)
      .then((data) => { if (!cancelled) setRows(data) })
      .catch((e) => { console.error(e); if (!cancelled) setError(true) })
    return () => { cancelled = true }
  }, [fromDateStr, toDateStr])

  // KPIs and the product-wise breakdown are both derived from the exact same
  // `rows` the table renders — the same array powers the on-screen summary,
  // the table, and (below) the Excel export, so none of the three can ever
  // disagree about which dataset they're summarising.
  const summary = useMemo(() => {
    const r = rows || []
    const products = new Map() // name -> { qty, amount }
    let totalQty = 0, totalLostValue = 0
    for (const row of r) {
      totalQty += row.quantity
      totalLostValue += row.amount
      const p = products.get(row.itemName) || { product: row.itemName, qty: 0, amount: 0 }
      p.qty += row.quantity
      p.amount += row.amount
      products.set(row.itemName, p)
    }
    const byProduct = Array.from(products.values()).sort((a, b) => b.amount - a.amount)
    return {
      totalItems: r.length,
      totalQty,
      uniqueProducts: products.size,
      totalLostValue,
      byProduct
    }
  }, [rows])

  const rangeLabel = (() => {
    const f = range[0].toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' })
    const t = range[1].toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' })
    return f === t ? f : `${f} — ${t}`
  })()

  const downloadExcel = () => {
    const excelRows = (rows || []).map((r) => ({
      date: fmtDateDDMMYYYY(r.date),
      shopName: r.shopName,
      salesRepName: r.salesRepName,
      itemName: r.itemName,
      quantity: r.quantity,
      amount: r.amount
    }))
    const fileName = `Alpha_Flow_Shortage_Sales_Loss_Report_${toDateInput(today)}.xlsx`
    exportShortageSalesLossExcel(excelRows, summary, fileName)
  }

  const sheet = (
    <div id="partial-verif-sheet" className="pv-print bg-white w-full max-w-6xl rounded-2xl shadow-2xl p-5 sm:p-6 mx-auto">
      <div className="text-center border-b-2 border-slate-800 pb-2 mb-3">
        <h1 className="text-lg font-black tracking-wide text-slate-900">ALPHA FLOW</h1>
        <p className="text-sm font-bold text-slate-700">Product Shortage — Sales Loss Report</p>
        <p className="text-[11px] text-slate-500">Period: {rangeLabel}</p>
        <p className="text-[10px] text-slate-400">Generated: {new Date().toLocaleString('en-GB')}</p>
      </div>

      {/* KPI summary. Lost Sales Value is the primary metric per spec —
          visually the most prominent card, not just one of four equal ones. */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4 text-center">
        <div className="rounded-lg border border-slate-200 py-2">
          <div className="text-lg font-black text-slate-900">{summary.totalItems}</div>
          <div className="text-[10px] text-slate-500 uppercase tracking-wide">Shortage Items</div>
        </div>
        <div className="rounded-lg border border-slate-200 py-2">
          <div className="text-lg font-black text-slate-900">{summary.totalQty}</div>
          <div className="text-[10px] text-slate-500 uppercase tracking-wide">Shortage Qty</div>
        </div>
        <div className="rounded-lg border border-slate-200 py-2">
          <div className="text-lg font-black text-slate-900">{summary.uniqueProducts}</div>
          <div className="text-[10px] text-slate-500 uppercase tracking-wide">Unique Products Short</div>
        </div>
        <div className="rounded-lg border-2 border-red-300 bg-red-50 py-2">
          <div className="text-xl font-black text-red-700">{fmtINR(summary.totalLostValue)}</div>
          <div className="text-[10px] text-red-600 uppercase tracking-wide font-bold">Lost Sales Value</div>
        </div>
      </div>

      {rows == null ? (
        <div className="py-16 flex justify-center"><div className="h-6 w-6 rounded-full border-4 border-slate-200 border-t-slate-800 animate-spin" /></div>
      ) : error ? (
        <p className="text-center text-sm text-red-600 py-10">Could not load the shortage sales loss report.</p>
      ) : rows.length === 0 ? (
        <p className="text-center text-sm text-slate-400 py-10">No product shortages found for the selected period.</p>
      ) : (
        <>
          <table className="w-full text-[11px] border-collapse mb-5">
            <thead>
              <tr className="bg-slate-900 text-white">
                <th className="border border-slate-700 px-1.5 py-1 text-left">Date</th>
                <th className="border border-slate-700 px-1.5 py-1 text-left">Shop Name</th>
                <th className="border border-slate-700 px-1.5 py-1 text-left">Sales Rep</th>
                <th className="border border-slate-700 px-1.5 py-1 text-left">Item (Removed)</th>
                <th className="border border-slate-700 px-1.5 py-1 text-right">Quantity</th>
                <th className="border border-slate-700 px-1.5 py-1 text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} className="odd:bg-white even:bg-slate-50">
                  <td className="border border-slate-300 px-1.5 py-1 whitespace-nowrap">{fmtDateDDMMYYYY(r.date)}</td>
                  <td className="border border-slate-300 px-1.5 py-1 break-words max-w-[160px]">{r.shopName || '—'}{r.route ? `, ${r.route}` : ''}</td>
                  <td className="border border-slate-300 px-1.5 py-1">{r.salesRepName || '—'}</td>
                  <td className="border border-slate-300 px-1.5 py-1 break-words max-w-[220px] font-medium text-red-700">{r.itemName}</td>
                  <td className="border border-slate-300 px-1.5 py-1 text-right font-semibold">{r.quantity}</td>
                  <td className="border border-slate-300 px-1.5 py-1 text-right font-bold">{fmtINR(r.amount)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-red-50 font-black">
                <td colSpan={4} className="border border-slate-300 px-1.5 py-1.5 text-right">TOTAL LOST SALES VALUE</td>
                <td className="border border-slate-300 px-1.5 py-1.5 text-right">{summary.totalQty}</td>
                <td className="border border-slate-300 px-1.5 py-1.5 text-right text-red-700">{fmtINR(summary.totalLostValue)}</td>
              </tr>
            </tfoot>
          </table>

          {/* Product-wise shortage analysis — sorted by lost value
              descending, so the single highest-impact product is always
              the first row. Kept as a compact secondary table per spec
              ("if adding this would make the report unnecessarily complex,
              prioritise the Excel export and the main KPI") — this version
              is short enough not to crowd the primary table above it. */}
          <div className="mb-2">
            <p className="text-xs font-bold text-slate-700 mb-1">Product Shortage Loss (highest impact first)</p>
            <table className="w-full text-[11px] border-collapse">
              <thead>
                <tr className="bg-slate-700 text-white">
                  <th className="border border-slate-600 px-1.5 py-1 text-left">Product</th>
                  <th className="border border-slate-600 px-1.5 py-1 text-right">Shortage Qty</th>
                  <th className="border border-slate-600 px-1.5 py-1 text-right">Lost Sales</th>
                </tr>
              </thead>
              <tbody>
                {summary.byProduct.map((p) => (
                  <tr key={p.product} className="odd:bg-white even:bg-slate-50">
                    <td className="border border-slate-300 px-1.5 py-1">{p.product}</td>
                    <td className="border border-slate-300 px-1.5 py-1 text-right">{p.qty}</td>
                    <td className="border border-slate-300 px-1.5 py-1 text-right font-bold text-red-700">{fmtINR(p.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <p className="text-[9px] text-slate-400 text-center mt-3">
        One row per shortage product line — a partial shortage shows only the unavailable quantity, not the full order. {rows ? `${rows.length} record(s).` : ''}
      </p>
    </div>
  )

  // Print via a dedicated window — unchanged from the previous version of
  // this component, which already fixed the blank-print-preview bug (fetch
  // CSS text directly rather than relying on a relative <link> href that
  // has no origin to resolve against in a blank popup window).
  const printReport = async () => {
    const node = document.getElementById('partial-verif-sheet')
    if (!node) return

    const cssLinks = Array.from(document.querySelectorAll('link[rel="stylesheet"]'))
    const inlineStyleText = Array.from(document.querySelectorAll('style')).map((s) => s.textContent).join('\n')
    let linkedCss = ''
    try {
      const texts = await Promise.all(cssLinks.map(async (link) => {
        try {
          const url = new URL(link.getAttribute('href'), window.location.href).href
          const res = await fetch(url)
          return res.ok ? await res.text() : ''
        } catch { return '' }
      }))
      linkedCss = texts.join('\n')
    } catch { /* proceed with whatever we have */ }

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
      <title>Product Shortage Sales Loss Report</title>
      <base href="${window.location.origin}/">
      <style>${linkedCss}\n${inlineStyleText}</style>
      <style>
        @page { size: A4 landscape; margin: 10mm; }
        html,body{margin:0;padding:0;background:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
        .pv-print{box-shadow:none!important;border-radius:0!important;max-width:none!important;}
        table{font-size:9px!important;}
        tr{break-inside:avoid;}
        .rpt-print-btn{position:fixed;top:12px;right:12px;z-index:999;background:#0f172a;color:#fff;
          border:none;border-radius:10px;padding:10px 16px;font-weight:700;font-size:14px;cursor:pointer;
          box-shadow:0 4px 12px rgba(0,0,0,.25);}
        @media print { .rpt-print-btn{ display:none !important; } }
      </style></head><body>
        <button class="rpt-print-btn" onclick="window.print()">🖨️ Print / Save as PDF</button>
        ${node.outerHTML}
        <script>
          window.onload = function () { try { window.print() } catch (e) {} };
        </script>
      </body></html>`
    const blob = new Blob([html], { type: 'text/html' })
    const blobUrl = URL.createObjectURL(blob)
    const w = window.open(blobUrl, '_blank', 'width=1100,height=800')
    if (!w) { alert('Please allow pop-ups to download the report.'); return }
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60000)
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 overflow-y-auto">
      <div className="min-h-full flex flex-col items-center py-4 px-2">
        <div className="w-full max-w-6xl flex flex-wrap items-center gap-2 mb-3">
          <button onClick={onClose} className="rounded-xl bg-white px-4 py-2 text-sm font-bold text-slate-700 shadow hover:bg-slate-50">← Close</button>
          <div className="flex-1" />
          <div className="flex items-center gap-1 bg-white rounded-xl p-1 shadow">
            {['today', 'yesterday', 'date', 'range'].map((p) => (
              <button key={p} onClick={() => setPreset(p)}
                className={`text-xs font-semibold px-3 py-1.5 rounded-lg capitalize ${preset === p ? 'bg-brand-600 text-white' : 'text-slate-600 hover:bg-slate-50'}`}>
                {p === 'date' ? 'Custom Date' : p === 'range' ? 'Date Range' : p}
              </button>
            ))}
          </div>
          {preset === 'date' && (
            <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)}
              className="rounded-xl border border-slate-200 px-3 py-2 text-sm shadow bg-white" />
          )}
          {preset === 'range' && (
            <div className="flex items-center gap-1">
              <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)}
                className="rounded-xl border border-slate-200 px-2 py-2 text-sm shadow bg-white" />
              <span className="text-slate-400 text-xs">to</span>
              <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)}
                className="rounded-xl border border-slate-200 px-2 py-2 text-sm shadow bg-white" />
            </div>
          )}
          <button onClick={downloadExcel} disabled={!rows}
            className="rounded-xl bg-emerald-600 text-white px-5 py-2.5 text-sm font-bold shadow hover:bg-emerald-700 disabled:bg-slate-400">
            📊 Download Excel
          </button>
          <button onClick={printReport} disabled={!rows || rows.length === 0}
            className="rounded-xl bg-slate-900 text-white px-5 py-2.5 text-sm font-bold shadow hover:bg-slate-800 disabled:bg-slate-400">
            📄 Download PDF Report
          </button>
        </div>

        {sheet}
      </div>
    </div>
  )
}
