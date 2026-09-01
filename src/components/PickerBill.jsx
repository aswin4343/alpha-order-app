import { useState, useRef, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'
import { ALPHA_LOGO, ZEDGO_LOGO } from '../assets/logos.js'

// NOTE: COMPANY_INFO / companyFor / brandLogoFor are NOT used by the
// Warehouse Slip itself any more — the slip now starts at the "WAREHOUSE
// SLIP" title with no company letterhead (see PRINT MODEL below). They stay
// exported because FullBill.jsx imports both companyFor and brandLogoFor for
// the customer-facing Full Bill, which is unchanged.
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
 * numbering system invented. */
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
      // Clipboard API unavailable — silently no-op, printed slip unaffected.
    }
  }
  return (
    <button
      type="button"
      onClick={onCopy}
      className="text-left font-semibold text-slate-800 hover:text-brand-700 active:text-brand-800 whitespace-nowrap"
      title="Tap to copy product name"
    >
      {name}
      {copied && <span className="ml-2 text-[10px] font-bold text-emerald-600 no-print-inline">Copied</span>}
    </button>
  )
}

// ============================================================================
// PRINT MODEL — A5 LANDSCAPE (210mm x 148mm)
//
// The slip starts at the "WAREHOUSE SLIP" title. There is deliberately NO
// company letterhead (name / address / GSTIN / FSSAI / logo) — this is an
// internal picking document, and the agreed reference layout begins at the
// title. The customer-facing Full Bill still carries the full letterhead and
// is untouched.
//
// Each physical A5 sheet is its own explicit `.print-page` box sized exactly
// 210mm x 148mm, so the slip fills the sheet rather than sitting as a small
// centred block. Padding is kept small (4mm) because @page already sets
// margin: 0 — stacking a large inner padding on top of a page margin is what
// previously left wide unused bands down both sides.
//
// PAGINATION: rows are rendered off-screen at the true print width, their
// real heights measured, then greedily packed into successive pages up to the
// genuine available height. Nothing is a fixed rows-per-page count, so a
// wrapped two-line product name simply consumes more of the budget. A row
// that would not fully fit moves whole to the next page (never split). Page 1
// carries the title + order info; later pages continue with product rows
// only. The column-header row repeats on every page for readability.
//
// WHY A PORTAL: index.css has a global print rule that hides the page
// (`body * { visibility: hidden }`) and rescues only `.picker-bill-print`,
// giving it `position: absolute`. This component renders inside the billing
// modal, which is `position: fixed` — and fixed ancestors are designed to
// repeat their contents on every printed page, which previously duplicated
// content and produced blank pages. Portaling the print copy to a direct
// child of <body> removes that ancestor entirely.
// ============================================================================
// ---------------------------------------------------------------------------
// ORIENTATION — the single switch that drives everything below (the @page
// rule, the page box dimensions, and therefore how many rows fit per page).
// Flip this one value to swap the whole slip between orientations; nothing
// else needs editing.
//   'portrait'  -> A5 portrait,  148mm wide x 210mm tall
//   'landscape' -> A5 landscape, 210mm wide x 148mm tall
const ORIENTATION = 'portrait'

const PAGE_W_MM = ORIENTATION === 'landscape' ? 210 : 148
const PAGE_H_MM = ORIENTATION === 'landscape' ? 148 : 210
const PAD_MM = 4
const CONTENT_W_MM = PAGE_W_MM - PAD_MM * 2
const CONTENT_H_MM = PAGE_H_MM - PAD_MM * 2
const SAFETY_MM = 3                            // buffer for print-vs-screen rendering differences
const PX_PER_MM = 96 / 25.4                    // CSS reference ratio, constant regardless of monitor DPI

export default function PickerBill({ shopName, route, salesRepName, orderDate, orderTime, orderRef, items }) {
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
  const summaryLine = `${all.length} product total  |  QTY ${totQ}  |  F QTY ${totF}  |  TOTAL QTY ${totT}`

  // Page-1 header: title + order info only. No company letterhead.
  const SlipHeader = () => (
    <>
      <div className="text-center mb-2">
        <span className="inline-block px-4 py-1 rounded-full bg-slate-900 text-white text-xs font-black tracking-widest">
          WAREHOUSE SLIP
        </span>
      </div>
      <div className="flex justify-between items-start gap-4 text-[11px] mb-2">
        <div className="min-w-0">
          <div><span className="font-semibold text-slate-500">SHOP / BUYER :</span> <span className="font-bold text-slate-800">{shopName}{route ? `, ${route}` : ''}</span></div>
          <div><span className="font-semibold text-slate-500">SALES REPRESENTATIVE :</span> <span className="font-bold text-slate-800">{salesRepName || '—'}</span></div>
        </div>
        <div className="text-right shrink-0">
          <div><span className="font-semibold text-slate-500">ORDER REF :</span> <span className="font-bold text-slate-800">{orderRef || '—'}</span></div>
          <div><span className="font-semibold text-slate-500">DATE :</span> <span className="font-bold text-slate-800">{prettyDate}</span>{orderTime ? <> <span className="font-semibold text-slate-500">TIME :</span> <span className="font-bold text-slate-800">{orderTime}</span></> : null}</div>
        </div>
      </div>
    </>
  )

  // Explicit column widths summing to exactly 100%, mirroring the old
  // half-page template's model (it declared every column width rather than
  // letting the table auto-size). With `table-fixed` this guarantees the
  // table can never grow wider than the page.
  // PRODUCT NAME is deliberately given the dominant share (55%) and the
  // numeric columns are trimmed to the minimum that still reads clearly,
  // because product names must stay on ONE line and therefore need every
  // millimetre of width that can be spared.
  const SlipColgroup = () => (
    <colgroup>
      <col style={{ width: '5%' }} />
      <col style={{ width: '55%' }} />
      <col style={{ width: '7%' }} />
      <col style={{ width: '8%' }} />
      <col style={{ width: '6%' }} />
      <col style={{ width: '6%' }} />
      <col style={{ width: '7%' }} />
      <col style={{ width: '6%' }} />
    </colgroup>
  )

  const HeadRow = () => (
    <tr className="bg-slate-900 text-white">
      <th className="border border-slate-700 px-1 py-1 text-center">SL</th>
      <th className="border border-slate-700 px-2 py-1 text-left">PRODUCT NAME</th>
      <th className="border border-slate-700 px-1 py-1 text-right">MRP</th>
      <th className="border border-slate-700 px-1 py-1 text-center">UNIT</th>
      <th className="border border-slate-700 px-1 py-1 text-center">QTY</th>
      <th className="border border-slate-700 px-1 py-1 text-center">F QTY</th>
      <th className="border border-slate-700 px-1 py-1 text-center bg-slate-800">TOTAL QTY</th>
      <th className="border border-slate-700 px-1 py-1 text-center">CHECK</th>
    </tr>
  )

  const ProductRow = ({ it, sl, innerRef }) => (
    <tr ref={innerRef} className={sl % 2 ? 'bg-white' : 'bg-slate-50'}>
      <td className="border border-slate-300 px-1 py-1.5 text-center text-slate-600">{sl}</td>
      <td className="wh-name border border-slate-300 px-1 py-1.5 whitespace-nowrap"><CopyableProductName name={it.name} /></td>
      <td className="border border-slate-300 px-1 py-1.5 text-right text-slate-700">{it.mrp != null ? `₹${it.mrp}` : '—'}</td>
      <td className="border border-slate-300 px-1 py-1.5 text-center text-slate-700">{it.unit || '-'}</td>
      <td className="border border-slate-300 px-1 py-1.5 text-center font-bold text-slate-900">{Number(it.qty) || 0}</td>
      <td className="border border-slate-300 px-1 py-1.5 text-center font-bold text-emerald-700">{Number(it.free_qty) || 0}</td>
      <td className="border-2 border-slate-800 px-1 py-1.5 text-center font-black text-slate-900 bg-slate-100">{(Number(it.qty) || 0) + (Number(it.free_qty) || 0)}</td>
      <td className="border border-slate-300 px-1 py-1.5 text-center"><span className="inline-block h-4 w-4 border-2 border-slate-800 rounded-sm" /></td>
    </tr>
  )

  const ProductTable = ({ rows, startIndex }) => (
    <table className="w-full text-[11px] border-collapse table-fixed">
      <SlipColgroup />
      <thead><HeadRow /></thead>
      <tbody>
        {rows.map((it, j) => <ProductRow key={startIndex + j} it={it} sl={startIndex + j + 1} />)}
      </tbody>
    </table>
  )

  // --- Measurement pass: real rendered heights at the true print width -----
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
      // Never stall: a single row taller than the budget gets its own page
      // rather than looping forever.
      if (rowsForPage.length === 0) { rowsForPage.push(all[idx]); idx++ }
      result.push({ isFirstPage, rows: rowsForPage, startIndex: slCounter })
      slCounter += rowsForPage.length
    }
    if (result.length === 0) result.push({ isFirstPage: true, rows: [], startIndex: 0 })
    setPages(result)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    all.map((i) => `${i.name}|${i.qty}|${i.free_qty}|${i.mrp}|${i.unit}`).join(';'),
    orderRef, shopName, route, salesRepName, prettyDate, orderTime
  ])

  const MeasurementPass = () => (
    <div aria-hidden="true" style={{ position: 'absolute', top: 0, left: '-9999px', width: `${CONTENT_W_MM}mm` }}>
      <div ref={measureHeaderRef}><SlipHeader /></div>
      <table className="w-full text-[11px] border-collapse table-fixed">
        <SlipColgroup />
        <thead ref={measureTheadRef}><HeadRow /></thead>
        <tbody>
          {all.map((it, i) => (
            <ProductRow key={i} it={it} sl={i + 1} innerRef={(el) => { measureRowRefs.current[i] = el }} />
          ))}
        </tbody>
      </table>
      <div ref={measureSummaryRef} className="mt-1 text-[10px] text-center">{summaryLine}</div>
    </div>
  )

  const renderPage = (p, i, isLastPage) => (
    <div
      key={i}
      className="print-page"
      style={{
        width: `${PAGE_W_MM}mm`,
        height: `${PAGE_H_MM}mm`,
        padding: `${PAD_MM}mm`,
        boxSizing: 'border-box',
        breakAfter: isLastPage ? 'auto' : 'page',
        pageBreakAfter: isLastPage ? 'auto' : 'always',
        background: '#fff',
        overflow: 'hidden'
      }}
    >
      {p.isFirstPage && <SlipHeader />}
      <ProductTable rows={p.rows} startIndex={p.startIndex} />
      {isLastPage && <div className="mt-1 text-[10px] text-slate-500 text-center">{summaryLine}</div>}
    </div>
  )

  return (
    <div className="bg-white">
      <style>{`
        @media print {
          /* Canonical named size + orientation keyword — Chrome maps this
             reliably and makes the print dialog default to the right
             orientation. Both this and the page box below come from the
             single ORIENTATION constant, so they can never disagree. */
          @page { size: A5 ${ORIENTATION}; margin: 0; }
          .no-print-inline { display: none !important; }
          body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }

          /* The on-screen copy must be removed from the print FLOW, not just
             hidden. index.css uses visibility:hidden, which still reserves
             full layout space — that reserved space was pushing the printed
             slip down the page and leaving a large empty band above it. */
          .wh-screen-copy { display: none !important; }

          /* Deliberately NOT overriding position here. index.css pins
             .picker-bill-print with position:absolute; top:0; left:0, which
             lifts it out of the flow of the hidden (but still space-taking)
             app UI and anchors it to the page's top-left corner. A previous
             version forced position:static, which cancelled that pin and let
             the slip fall back into the flow behind all that hidden content —
             the cause of the empty band above and below. Width is pinned to
             the real page width so the box is never measured against body. */
          .wh-slip-root { width: ${PAGE_W_MM}mm !important; max-width: ${PAGE_W_MM}mm !important; overflow: visible !important; }
          .print-page { width: ${PAGE_W_MM}mm !important; height: ${PAGE_H_MM}mm !important; box-shadow: none !important; border-radius: 0 !important; }
          .print-page tr { break-inside: avoid !important; page-break-inside: avoid !important; }
          /* Product names must stay on ONE line in the real print output too,
             not only in the on-screen preview — enforced explicitly here so
             no inherited or competing rule can reintroduce wrapping. */
          .print-page .wh-name, .print-page .wh-name * { white-space: nowrap !important; }
        }
      `}</style>

      <MeasurementPass />

      {/* On-screen preview — same structure and same renderPage() as the
          printed copy, so what you see is what prints. No rescue class here,
          so the global print rule hides this copy during printing and only
          the portaled copy below is printed (no ghost double-render). */}
      {pages && (
        <div className="wh-screen-copy flex flex-col items-center gap-4 py-4 overflow-x-auto">
          {pages.map((p, i) => (
            <div key={i} className="shadow-2xl rounded-lg overflow-hidden bg-white shrink-0" style={{ width: `${PAGE_W_MM}mm` }}>
              {renderPage(p, i, i === pages.length - 1)}
            </div>
          ))}
        </div>
      )}

      {/* Print-only copy, portaled out of the fixed-position modal. */}
      {pages && createPortal(
        <div className="picker-bill-print wh-slip-root bg-white">
          {pages.map((p, i) => renderPage(p, i, i === pages.length - 1))}
        </div>,
        document.body
      )}
    </div>
  )
}
