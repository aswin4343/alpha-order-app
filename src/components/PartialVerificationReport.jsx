import { useEffect, useMemo, useState } from 'react'
import { loadPartialVerifications } from '../utils/cloudSync.js'

function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x }
function endOfDay(d) { const x = new Date(d); x.setHours(23, 59, 59, 999); return x }
function toDateInput(d) {
  const x = new Date(d)
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`
}

/**
 * Partial Verification Report — orders where SOME products were verified and
 * SOME were removed as Stock Out. Built fresh (this report did not exist
 * before). Uses the same date-filter UX as the Edit Audit Report, and prints
 * via a dedicated window (the AuditReport blank-PDF bug was caused by
 * printing from inside a position:fixed modal — a fresh window has no such
 * ancestor to fight, so this is built that way from the start).
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

  useEffect(() => {
    let cancelled = false
    setRows(null); setError(false)
    loadPartialVerifications(range[0].toISOString(), range[1].toISOString())
      .then((data) => { if (!cancelled) setRows(data) })
      .catch((e) => { console.error(e); if (!cancelled) setError(true) })
    return () => { cancelled = true }
  }, [range])

  const summary = useMemo(() => {
    const r = rows || []
    const shops = new Set()
    let stockOutQty = 0, verifiedQty = 0
    for (const o of r) {
      shops.add(o.shop_name)
      stockOutQty += o.stockOutItems.reduce((s, i) => s + (Number(i.qty) || 0), 0)
      verifiedQty += o.verifiedItems.reduce((s, i) => s + (Number(i.qty) || 0), 0)
    }
    return { orders: r.length, shops: shops.size, stockOutQty, verifiedQty }
  }, [rows])

  const rangeLabel = (() => {
    const f = range[0].toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' })
    const t = range[1].toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' })
    return f === t ? f : `${f} — ${t}`
  })()

  const fmtDate = (iso) => iso ? new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—'
  const fmtTime = (iso) => iso ? new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true }) : '—'

  const sheet = (
    <div id="partial-verif-sheet" className="pv-print bg-white w-full max-w-6xl rounded-2xl shadow-2xl p-5 sm:p-6 mx-auto">
      <div className="text-center border-b-2 border-slate-800 pb-2 mb-3">
        <h1 className="text-lg font-black tracking-wide text-slate-900">ALPHA FLOW</h1>
        <p className="text-sm font-bold text-slate-700">Partial Verification Report</p>
        <p className="text-[11px] text-slate-500">Period: {rangeLabel}</p>
        <p className="text-[10px] text-slate-400">Generated: {new Date().toLocaleString('en-GB')}</p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4 text-center">
        {[
          ['Partial Orders', summary.orders],
          ['Shops', summary.shops],
          ['Verified Qty', summary.verifiedQty],
          ['Stock-Out Qty', summary.stockOutQty]
        ].map(([label, val]) => (
          <div key={label} className="rounded-lg border border-slate-200 py-2">
            <div className="text-lg font-black text-slate-900">{val}</div>
            <div className="text-[10px] text-slate-500 uppercase tracking-wide">{label}</div>
          </div>
        ))}
      </div>

      {rows == null ? (
        <div className="py-16 flex justify-center"><div className="h-6 w-6 rounded-full border-4 border-slate-200 border-t-slate-800 animate-spin" /></div>
      ) : error ? (
        <p className="text-center text-sm text-red-600 py-10">Could not load partial verification records.</p>
      ) : rows.length === 0 ? (
        <p className="text-center text-sm text-slate-400 py-10">No partial verifications in this period.</p>
      ) : (
        <table className="w-full text-[11px] border-collapse">
          <thead>
            <tr className="bg-slate-900 text-white">
              <th className="border border-slate-700 px-1.5 py-1 text-left">Date</th>
              <th className="border border-slate-700 px-1.5 py-1 text-left">Time</th>
              <th className="border border-slate-700 px-1.5 py-1 text-left">Shop / Buyer</th>
              <th className="border border-slate-700 px-1.5 py-1 text-left">Order Ref</th>
              <th className="border border-slate-700 px-1.5 py-1 text-left">Sales Rep</th>
              <th className="border border-slate-700 px-1.5 py-1 text-left">Verified Products</th>
              <th className="border border-slate-700 px-1.5 py-1 text-left">Stock-Out Products</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((o) => (
              <tr key={o.id} className="odd:bg-white even:bg-slate-50 align-top">
                <td className="border border-slate-300 px-1.5 py-1 whitespace-nowrap">{fmtDate(o.billing_verified_at)}</td>
                <td className="border border-slate-300 px-1.5 py-1 whitespace-nowrap">{fmtTime(o.billing_verified_at)}</td>
                <td className="border border-slate-300 px-1.5 py-1 break-words max-w-[140px]">{o.shop_name || '—'}{o.route ? `, ${o.route}` : ''}</td>
                <td className="border border-slate-300 px-1.5 py-1 whitespace-nowrap font-mono">{(o.id || '').slice(0, 8).toUpperCase()}</td>
                <td className="border border-slate-300 px-1.5 py-1">{o.sales_rep_name || '—'}</td>
                <td className="border border-slate-300 px-1.5 py-1 break-words max-w-[220px]">
                  {o.verifiedItems.map((i) => `${i.product_name} (${i.qty})`).join(', ')}
                </td>
                <td className="border border-slate-300 px-1.5 py-1 break-words max-w-[220px] text-red-700 font-medium">
                  {o.stockOutItems.map((i) => `${i.product_name} (${i.qty})`).join(', ')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <p className="text-[9px] text-slate-400 text-center mt-3">
        Orders with at least one verified product AND at least one Stock-Out removal. {rows ? `${rows.length} record(s).` : ''}
      </p>
    </div>
  )

  // Print via a dedicated window. The PREVIOUS version copied <link> tags by
  // reference — but a fresh window opened with window.open('', ...) has no
  // URL (it's about:blank), so a root-relative href like "/assets/index.css"
  // has no origin to resolve against and silently fails to load, producing a
  // blank page. Fix: fetch the ACTUAL CSS text and embed it directly, so the
  // print window has zero dependency on resolving any path.
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
      <title>Partial Verification Report</title>
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
          // A REAL page load (this is a blob: URL, not document.write into
          // about:blank) so window.onload fires reliably here, unlike the
          // previous approach — this is what fixes the blank print PREVIEW
          // pane (Chromium's print pipeline doesn't reliably preview pages
          // synthesized via document.write into an empty popup).
          window.onload = function () { try { window.print() } catch (e) {} };
        </script>
      </body></html>`
    // A blob: URL gives the window a real, navigable document instead of
    // about:blank — this is what makes Chromium's print preview render
    // correctly instead of coming out blank.
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
