import { useState, useRef, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'
import { ALPHA_LOGO, ZEDGO_LOGO } from '../assets/logos.js'
// (ALPHA_LOGO / ZEDGO_LOGO are used by brandLogoFor below.)

// Placeholder company letterhead details — swap in real GSTIN/FSSAI/address
// once available. Keyed by the exact `orders.brand` values already in use
// throughout the app (see BRANDS in utils/whatsapp.js).
export const COMPANY_INFO = {
  'ALPHA TRADE LINKS': {
    name: 'ALPHA TRADE LINKS',
    tagline: 'FMCG Distribution',
    address: 'Thiruvananthapuram, Kerala',
    gstin: 'GSTIN — to be added',
    fssai: null
  },
  ZEDGO: {
    name: 'ZEDGO',
    tagline: 'Restaurant Solutions',
    address: 'Thottakallu Road, Trivandrum, Kerala, Pin: 695144, Ph: 8138963360',
    gstin: '32DWSPM2017Q1Z0',
    fssai: '11320001000763'
  }
}

export function companyFor(brand) {
  return COMPANY_INFO[(brand || '').toUpperCase().trim()] || COMPANY_INFO['ALPHA TRADE LINKS']
}

/**
 * Returns the ONE correct logo for a bill, chosen by the order's brand.
 * A bill belongs to exactly one company, so exactly one logo is shown —
 * never both. ZEDGO orders get the Zedgo logo; everything else (Alpha Trade
 * Links) gets the Alpha logo. Returns { src, alt } for a single <img>.
 */
export function brandLogoFor(brand) {
  const key = (brand || '').toUpperCase().trim()
  if (key === 'ZEDGO') return { src: ZEDGO_LOGO, alt: 'Zedgo' }
  return { src: ALPHA_LOGO, alt: 'Alpha Trade Links' }
}

/** Short, stable order reference from the existing order id — no separate
 * numbering system invented, per the requirement ("use the existing Alpha
 * Flow order identification system if one already exists"). */
export function orderRefFrom(orderId) {
  return orderId ? orderId.slice(0, 8).toUpperCase() : '—'
}

function CopyableProductName({ name }) {
  const [copied, setCopied] = useState(false)
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(name)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {
      // Clipboard API unavailable — silently no-op, printed bill unaffected.
    }
  }
  return (
    <button
      type="button"
      onClick={onCopy}
      className="text-left font-semibold text-slate-800 hover:text-brand-700 active:text-brand-800"
      title="Tap to copy product name"
    >
      {name}
      {copied && <span className="ml-2 text-[10px] font-bold text-emerald-600 no-print-inline">Copied</span>}
    </button>
  )
}

// ============================================================================
// PHYSICAL PRINTING MODEL — A5 LANDSCAPE, explicit measured pages
//
// Paper: 210mm (width) x 148mm (height), landscape. Each physical A5 sheet is
// its own explicit `.print-page` — NOT relied on the browser's automatic
// content-driven pagination, per this iteration's explicit requirement.
// Instead: render every row off-screen at the REAL print width first, MEASURE
// its actual height, then greedily pack rows into successive pages up to the
// real available height, moving any row that wouldn't fully fit to the next
// page. Nothing here is a fixed row-per-page count.
//
// Page 1 gets the company header + order info; pages 2+ start directly with
// products (the header block exists in the DOM exactly once, only on page
// 1's content, so there is nothing to "turn off" for later pages). The
// product table's column-header row IS allowed to repeat on every page
// (explicitly permitted) via a plain repeated <thead>-style row — it is
// measured and budgeted for on every page.
//
// WHY A PORTAL: src/index.css has a global print rule that rescues content
// tagged `.picker-bill-print` from `body * { visibility: hidden }` by
// setting `position: absolute` on it. This component normally sits inside
// the billing modal, which uses `position: fixed inset-0` — and
// `position: fixed` ancestors are specifically designed to repeat on every
// printed page. An absolutely-positioned box inside a repeating fixed
// ancestor inherits that per-page repetition, which previously caused
// duplicated headers / blank pages. Portaling the print-only copy to a
// direct child of <body>, and overriding its position back to static,
// removes the fixed ancestor entirely so explicit multi-page output behaves
// predictably.
// ============================================================================
const PAGE_W_MM = 210
const PAGE_H_MM = 148
const PAD_X_MM = 6
const PAD_Y_MM = 5
const CONTENT_W_MM = PAGE_W_MM - PAD_X_MM * 2   // 198mm usable width
const CONTENT_H_MM = PAGE_H_MM - PAD_Y_MM * 2   // 138mm usable height per page
const SAFETY_MM = 3                              // buffer for print-vs-screen rendering differences
const PX_PER_MM = 96 / 25.4                       // CSS's fixed reference ratio — constant regardless of monitor DPI

export default function PickerBill({ brand, shopName, route, salesRepName, orderDate, orderTime, orderRef, items }) {
  const company = companyFor(brand)
  const brandLogo = brandLogoFor(brand)

  const prettyDate = (() => {
    if (!orderDate) return '—'
    const d = new Date(orderDate.length <= 10 ? `${orderDate}T00:00:00` : orderDate)
    if (isNaN(d.getTime())) return orderDate
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' })
  })()

  const all = (items || []).slice().sort((a, b) =>
    String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' })
  )
  const totQ = all.reduce((s, i) => s + (Number(i.qty) || 0), 0)
  const totF = all.reduce((s, i) => s + (Number(i.free_qty) || 0), 0)
  const totT = totQ + totF
  const summaryLine = `${all.length} product line(s) · QTY ${totQ} · F QTY ${totF} · TOTAL QTY ${totT}`

  const Header = () => (
    <>
      <div className="border-b-2 border-slate-800 pb-2 mb-3">
        <div className="flex items-center justify-between gap-3">
          <div className="text-left min-w-0">
            <h1 className="text-xl font-black tracking-wide text-slate-900 leading-tight">{company.name}</h1>
            <p className="text-xs text-slate-600">{company.tagline}</p>
            <p className="text-[11px] text-slate-500">{company.address}</p>
            <p className="text-[10px] text-slate-400">
              {company.gstin ? `GSTIN: ${company.gstin}` : ''}{company.fssai ? `  ·  FSSAI: ${company.fssai}` : ''}
            </p>
          </div>
          <img src={brandLogo.src} alt={brandLogo.alt} className="h-12 w-auto object-contain shrink-0" style={{ printColorAdjust: 'exact', WebkitPrintColorAdjust: 'exact' }} />
        </div>
      </div>
      <div className="text-center mb-3">
        <span className="inline-block px-3 py-1 rounded-full bg-slate-900 text-white text-xs font-black tracking-widest">
          WAREHOUSE SLIP
        </span>
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs mb-3 border border-slate-200 rounded-lg p-3">
        <div><span className="font-semibold text-slate-500">SHOP / BUYER:</span> <span className="font-bold text-slate-800">{shopName}{route ? `, ${route}` : ''}</span></div>
        <div><span className="font-semibold text-slate-500">ORDER REF:</span> <span className="font-bold text-slate-800">{orderRef || '—'}</span></div>
        <div><span className="font-semibold text-slate-500">SALES REPRESENTATIVE:</span> <span className="font-bold text-slate-800">{salesRepName || '—'}</span></div>
        <div><span className="font-semibold text-slate-500">DATE:</span> <span className="font-bold text-slate-800">{prettyDate}</span> {orderTime ? <span className="ml-2"><span className="font-semibold text-slate-500">TIME:</span> <span className="font-bold text-slate-800">{orderTime}</span></span> : null}</div>
      </div>
    </>
  )

  const TableHead = () => (
    <thead>
      <tr className="bg-slate-900 text-white">
        <th className="border border-slate-700 px-2 py-1.5 text-left w-8">SL</th>
        <th className="border border-slate-700 px-2 py-1.5 text-left">PRODUCT NAME</th>
        <th className="border border-slate-700 px-2 py-1.5 text-right w-16">MRP</th>
        <th className="border border-slate-700 px-2 py-1.5 text-center w-14">UNIT</th>
        <th className="border border-slate-700 px-2 py-1.5 text-center w-12">QTY</th>
        <th className="border border-slate-700 px-2 py-1.5 text-center w-12">F QTY</th>
        <th className="border border-slate-700 px-2 py-1.5 text-center w-16 text-sm font-black bg-slate-800">TOTAL QTY</th>
        <th className="border border-slate-700 px-2 py-1.5 text-center w-14">CHECK</th>
      </tr>
    </thead>
  )

  const ProductRow = ({ it, sl, innerRef }) => (
    <tr ref={innerRef} className={sl % 2 ? 'bg-white' : 'bg-slate-50'}>
      <td className="border border-slate-300 px-2 py-2 text-slate-600">{sl}</td>
      <td className="border border-slate-300 px-2 py-2 break-words"><CopyableProductName name={it.name} /></td>
      <td className="border border-slate-300 px-2 py-2 text-right text-slate-700">{it.mrp != null ? `₹${it.mrp}` : '—'}</td>
      <td className="border border-slate-300 px-2 py-2 text-center text-slate-700">{it.unit || '-'}</td>
      <td className="border border-slate-300 px-2 py-2 text-center font-bold text-slate-900">{Number(it.qty) || 0}</td>
      <td className="border border-slate-300 px-2 py-2 text-center font-bold text-emerald-700">{Number(it.free_qty) || 0}</td>
      <td className="border-2 border-slate-800 px-2 py-2 text-center text-sm font-black text-slate-900 bg-slate-100">{(Number(it.qty) || 0) + (Number(it.free_qty) || 0)}</td>
      <td className="border border-slate-300 px-2 py-2 text-center"><span className="inline-block h-5 w-5 border-2 border-slate-800 rounded-sm" /></td>
    </tr>
  )

  const ProductTable = ({ rows, startIndex }) => (
    <table className="w-full text-xs border-collapse">
      <TableHead />
      <tbody>
        {rows.map((it, j) => <ProductRow key={startIndex + j} it={it} sl={startIndex + j + 1} />)}
      </tbody>
    </table>
  )

  // --- Measurement pass ------------------------------------------------
  // Renders the header, the table's column-header row, and EVERY product row
  // off-screen at the real 198mm print width, then measures each one's
  // actual height in millimeters. This drives the pagination below — nothing
  // here is a fixed row count.
  const measureHeaderRef = useRef(null)
  const measureTheadRef = useRef(null)
  const measureSummaryRef = useRef(null)
  const measureRowRefs = useRef([])
  const [pages, setPages] = useState(null)

  useLayoutEffect(() => {
    const mm = (el) => (el ? el.getBoundingClientRect().height / PX_PER_MM : 0)
    const headerMM = mm(measureHeaderRef.current)
    const theadMM = mm(measureTheadRef.current)
    const summaryMM = mm(measureSummaryRef.current)
    const rowHeightsMM = all.map((_, i) => mm(measureRowRefs.current[i]))

    // Reserve room for the summary line on every page (not just whichever
    // turns out to be last) — a small, deliberately conservative safety
    // margin so no page ever risks overflowing its own 148mm height.
    const availFirst = CONTENT_H_MM - headerMM - theadMM - summaryMM - SAFETY_MM
    const availRest = CONTENT_H_MM - theadMM - summaryMM - SAFETY_MM

    const result = []
    let idx = 0
    let slCounter = 0
    while (idx < all.length) {
      const isFirstPage = result.length === 0
      const budget = isFirstPage ? availFirst : availRest
      const rowsForPage = []
      let used = 0
      while (idx < all.length) {
        const h = rowHeightsMM[idx] || 0
        if (used + h > budget && rowsForPage.length > 0) break
        rowsForPage.push(all[idx])
        used += h
        idx++
      }
      // Never stall: if even one row alone exceeds the budget, place it by
      // itself rather than looping forever.
      if (rowsForPage.length === 0) { rowsForPage.push(all[idx]); idx++ }
      result.push({ isFirstPage, rows: rowsForPage, startIndex: slCounter })
      slCounter += rowsForPage.length
    }
    if (result.length === 0) result.push({ isFirstPage: true, rows: [], startIndex: 0 })
    setPages(result)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    all.map((i) => `${i.name}|${i.qty}|${i.free_qty}|${i.mrp}|${i.unit}`).join(';'),
    company.name, orderRef, shopName, route, salesRepName, prettyDate, orderTime
  ])

  const MeasurementPass = () => (
    <div aria-hidden="true" style={{ position: 'absolute', top: 0, left: '-9999px', width: `${CONTENT_W_MM}mm` }}>
      <div ref={measureHeaderRef}><Header /></div>
      <table className="w-full text-xs border-collapse">
        <thead ref={measureTheadRef}>
          <tr className="bg-slate-900 text-white">
            <th className="border border-slate-700 px-2 py-1.5 text-left w-8">SL</th>
            <th className="border border-slate-700 px-2 py-1.5 text-left">PRODUCT NAME</th>
            <th className="border border-slate-700 px-2 py-1.5 text-right w-16">MRP</th>
            <th className="border border-slate-700 px-2 py-1.5 text-center w-14">UNIT</th>
            <th className="border border-slate-700 px-2 py-1.5 text-center w-12">QTY</th>
            <th className="border border-slate-700 px-2 py-1.5 text-center w-12">F QTY</th>
            <th className="border border-slate-700 px-2 py-1.5 text-center w-16 text-sm font-black bg-slate-800">TOTAL QTY</th>
            <th className="border border-slate-700 px-2 py-1.5 text-center w-14">CHECK</th>
          </tr>
        </thead>
        <tbody>
          {all.map((it, i) => (
            <ProductRow key={i} it={it} sl={i + 1} innerRef={(el) => { measureRowRefs.current[i] = el }} />
          ))}
        </tbody>
      </table>
      <div ref={measureSummaryRef} className="mt-2 text-[9px] text-center">{summaryLine}</div>
    </div>
  )

  const renderPage = (p, i, isLastPage) => (
    <div
      key={i}
      className="print-page"
      style={{
        width: `${PAGE_W_MM}mm`,
        height: `${PAGE_H_MM}mm`,
        padding: `${PAD_Y_MM}mm ${PAD_X_MM}mm`,
        boxSizing: 'border-box',
        breakAfter: isLastPage ? 'auto' : 'page',
        pageBreakAfter: isLastPage ? 'auto' : 'always',
        background: '#fff'
      }}
    >
      {p.isFirstPage && <Header />}
      <ProductTable rows={p.rows} startIndex={p.startIndex} />
      {isLastPage && <div className="mt-2 text-[9px] text-slate-400 text-center">{summaryLine}</div>}
    </div>
  )

  return (
    <div className="bg-white">
      {/* Print CSS: real A5 LANDSCAPE paper. overflow must stay visible on
          any table ancestor — overflow:hidden is a known Chromium bug that
          can make a whole table vanish from print output. */}
      <style>{`
        @media print {
          @page { size: 210mm 148mm; margin: 0; }
          .no-print-inline { display: none !important; }
          body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
          .wh-slip-root { position: static !important; overflow: visible !important; }
          .print-page tr { break-inside: avoid !important; page-break-inside: avoid !important; }
        }
      `}</style>

      {/* Hidden measurement pass — always rendered so refs stay populated. */}
      <MeasurementPass />

      {/* On-screen preview — NO rescue class, so the global print rule hides
          it during print (avoids a duplicate/ghost render alongside the
          portal copy below). */}
      {pages && (
        <div className="flex flex-col items-center gap-4 py-4 overflow-x-auto">
          {pages.map((p, i) => (
            <div key={i} className="shadow-2xl rounded-lg overflow-hidden bg-white shrink-0" style={{ width: `${PAGE_W_MM}mm` }}>
              {renderPage(p, i, i === pages.length - 1)}
            </div>
          ))}
        </div>
      )}

      {/* Print-only copy — portaled to a direct child of <body>, escaping the
          modal's `position: fixed` ancestor (see comment block above for
          why that matters for reliable multi-page output). Both the rescue
          class and the print-CSS-target class live on this SAME element. */}
      {pages && createPortal(
        <div className="picker-bill-print wh-slip-root bg-white">
          {pages.map((p, i) => renderPage(p, i, i === pages.length - 1))}
        </div>,
        document.body
      )}
    </div>
  )
}
