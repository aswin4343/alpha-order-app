import { useEffect, useMemo, useState } from 'react'
import { loadBillingAudit } from '../utils/cloudSync.js'

// Local date helpers — build day boundaries in the user's local timezone, then
// convert to ISO for the query (stored created_at is timestamptz/UTC).
function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x }
function endOfDay(d) { const x = new Date(d); x.setHours(23, 59, 59, 999); return x }
function toDateInput(d) {
  const x = new Date(d)
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`
}

const ACTION_STYLE = {
  'QUANTITY EDITED': 'bg-amber-100 text-amber-700',
  'PRODUCT REPLACED': 'bg-blue-100 text-blue-700',
  'PRODUCT REMOVED': 'bg-red-100 text-red-700'
}

/**
 * Billing Edit / Audit Report — immutable log of every Billing Team change.
 * Filter by Today / Yesterday / custom single date / date range. Download a
 * structured PDF via the browser print dialog (consistent with the bills,
 * no extra dependency). The print CSS below isolates just the report.
 */
export default function AuditReport({ onClose }) {
  const today = new Date()
  const [preset, setPreset] = useState('today') // today | yesterday | date | range
  const [fromDate, setFromDate] = useState(toDateInput(today))
  const [toDate, setToDate] = useState(toDateInput(today))
  const [rows, setRows] = useState(null)
  const [error, setError] = useState(false)

  // Resolve the active [from,to] window from the preset/inputs.
  const range = useMemo(() => {
    if (preset === 'today') return [startOfDay(today), endOfDay(today)]
    if (preset === 'yesterday') {
      const y = new Date(today); y.setDate(y.getDate() - 1)
      return [startOfDay(y), endOfDay(y)]
    }
    if (preset === 'date') return [startOfDay(fromDate), endOfDay(fromDate)]
    // range
    return [startOfDay(fromDate), endOfDay(toDate)]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset, fromDate, toDate])

  useEffect(() => {
    let cancelled = false
    setRows(null); setError(false)
    loadBillingAudit(range[0].toISOString(), range[1].toISOString())
      .then((data) => { if (!cancelled) setRows(data) })
      .catch((e) => { console.error(e); if (!cancelled) setError(true) })
    return () => { cancelled = true }
  }, [range])

  // Summary counts for the header/PDF.
  const summary = useMemo(() => {
    const r = rows || []
    const orders = new Set(), shops = new Set()
    let qty = 0, repl = 0, rem = 0
    for (const x of r) {
      if (x.order_id) orders.add(x.order_id)
      if (x.shop_name) shops.add(x.shop_name)
      if (x.action_type === 'QUANTITY EDITED') qty++
      else if (x.action_type === 'PRODUCT REPLACED') repl++
      else if (x.action_type === 'PRODUCT REMOVED') rem++
    }
    return { total: r.length, qty, repl, rem, orders: orders.size, shops: shops.size }
  }, [rows])

  const rangeLabel = (() => {
    const f = range[0].toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' })
    const t = range[1].toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' })
    return f === t ? f : `${f} — ${t}`
  })()

  const fmtDate = (iso) => new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' })
  const fmtTime = (iso) => new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true })

  // Print via a dedicated window. A fresh window has no modal wrapper, no
  // #root, and no competing print stylesheets from other components — which is
  // what made the in-page approaches print blank. We serialise the already-
  // rendered report node into a minimal HTML document and print that.
  // Fetch the actual CSS TEXT and embed it directly — copying <link> tags by
  // reference doesn't work because a fresh window.open('', ...) has no URL
  // (about:blank), so a root-relative href has no origin to resolve against
  // and silently fails to load, producing a blank page.
  const printReport = async () => {
    const node = document.getElementById('audit-report-sheet')
    if (!node) { window.print(); return }

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
      <title>Billing Edit Audit Report</title>
      <base href="${window.location.origin}/">
      <style>${linkedCss}\n${inlineStyleText}</style>
      <style>
        @page { size: A4 landscape; margin: 10mm; }
        html,body{margin:0;padding:0;background:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
        .audit-print{box-shadow:none!important;border-radius:0!important;max-width:none!important;}
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
    // A blob: URL gives the window a REAL, navigable document instead of
    // about:blank — this is what makes Chromium's print PREVIEW render
    // correctly instead of coming out blank (document.write into an empty
    // popup does not reliably support print preview, even though the page
    // itself displays fine on screen).
    const blob = new Blob([html], { type: 'text/html' })
    const blobUrl = URL.createObjectURL(blob)
    const w = window.open(blobUrl, '_blank', 'width=1100,height=800')
    if (!w) { alert('Please allow pop-ups to download the report.'); return }
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60000)
  }
  const sheet = (
    <div id="audit-report-sheet" className="audit-print bg-white w-full max-w-6xl rounded-2xl shadow-2xl p-5 sm:p-6 mx-auto">
      <div className="text-center border-b-2 border-slate-800 pb-2 mb-3">
        <h1 className="text-lg font-black tracking-wide text-slate-900">ALPHA FLOW</h1>
        <p className="text-sm font-bold text-slate-700">Billing Verification — Edit Audit Report</p>
        <p className="text-[11px] text-slate-500">Period: {rangeLabel}</p>
        <p className="text-[10px] text-slate-400">Generated: {new Date().toLocaleString('en-GB')}</p>
      </div>

      <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 mb-4 text-center">
        {[
          ['Total Edits', summary.total],
          ['Qty Edits', summary.qty],
          ['Replacements', summary.repl],
          ['Removals', summary.rem],
          ['Orders', summary.orders],
          ['Shops', summary.shops]
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
        <p className="text-center text-sm text-red-600 py-10">Could not load the audit records.</p>
      ) : rows.length === 0 ? (
        <p className="text-center text-sm text-slate-400 py-10">No billing edits in this period.</p>
      ) : (
        <table className="w-full text-[11px] border-collapse">
          <thead>
            <tr className="bg-slate-900 text-white">
              <th className="border border-slate-700 px-1.5 py-1 text-left">Date</th>
              <th className="border border-slate-700 px-1.5 py-1 text-left">Time</th>
              <th className="border border-slate-700 px-1.5 py-1 text-left">Shop / Buyer</th>
              <th className="border border-slate-700 px-1.5 py-1 text-left">Order Ref</th>
              <th className="border border-slate-700 px-1.5 py-1 text-left">Sales Rep</th>
              <th className="border border-slate-700 px-1.5 py-1 text-left">Product</th>
              <th className="border border-slate-700 px-1.5 py-1 text-left">Action</th>
              <th className="border border-slate-700 px-1.5 py-1 text-center">Orig Qty</th>
              <th className="border border-slate-700 px-1.5 py-1 text-center">New Qty</th>
              <th className="border border-slate-700 px-1.5 py-1 text-left">Replacement</th>
              <th className="border border-slate-700 px-1.5 py-1 text-left">Reason</th>
              <th className="border border-slate-700 px-1.5 py-1 text-left">Edited By</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="odd:bg-white even:bg-slate-50 align-top">
                <td className="border border-slate-300 px-1.5 py-1 whitespace-nowrap">{fmtDate(r.created_at)}</td>
                <td className="border border-slate-300 px-1.5 py-1 whitespace-nowrap">{fmtTime(r.created_at)}</td>
                <td className="border border-slate-300 px-1.5 py-1 break-words max-w-[140px]">{r.shop_name || '—'}{r.route ? `, ${r.route}` : ''}</td>
                <td className="border border-slate-300 px-1.5 py-1 whitespace-nowrap font-mono">{r.order_ref || '—'}</td>
                <td className="border border-slate-300 px-1.5 py-1">{r.sales_rep_name || '—'}</td>
                <td className="border border-slate-300 px-1.5 py-1 break-words max-w-[160px]">
                  {r.original_product_name && r.original_product_name !== r.product_name
                    ? <span>{r.original_product_name}</span>
                    : <span>{r.product_name || '—'}</span>}
                </td>
                <td className="border border-slate-300 px-1.5 py-1 whitespace-nowrap">
                  <span className={`inline-block px-1.5 py-0.5 rounded text-[9px] font-bold ${ACTION_STYLE[r.action_type] || 'bg-slate-100 text-slate-600'}`}>{r.action_type}</span>
                </td>
                <td className="border border-slate-300 px-1.5 py-1 text-center font-semibold">{r.original_qty ?? '—'}</td>
                <td className="border border-slate-300 px-1.5 py-1 text-center font-semibold">{r.new_qty ?? '—'}</td>
                <td className="border border-slate-300 px-1.5 py-1 break-words max-w-[160px]">{r.replacement_product_name || '—'}</td>
                <td className="border border-slate-300 px-1.5 py-1 break-words max-w-[180px]">{r.reason || '—'}</td>
                <td className="border border-slate-300 px-1.5 py-1 break-words max-w-[110px]">{r.edited_by || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <p className="text-[9px] text-slate-400 text-center mt-3">
        Immutable billing audit — every modification is a permanent record. {rows ? `${rows.length} record(s).` : ''}
      </p>
    </div>
  )

  return (
    <div className="fixed inset-0 z-50 bg-black/50 overflow-y-auto">
      <style>{`
        @media print {
          /* Printing happens in a dedicated window (see printReport), so the
             in-page report never needs to print itself. Hiding it here prevents
             a stray Ctrl+P on the dashboard from producing a broken page. */
          .no-print, .no-print * { display: none !important; }
        }
      `}</style>

      <div className="min-h-full flex flex-col items-center py-4 px-2">
        {/* Toolbar (not printed) */}
        <div className="no-print w-full max-w-6xl flex flex-wrap items-center gap-2 mb-3">
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

        {/* Report sheet */}
        {sheet}
      </div>
    </div>
  )
}
