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
// PHYSICAL PRINTING MODEL — read before touching any of the numbers below.
//
// The Warehouse Slip prints on ONE A4 PORTRAIT sheet (210mm x 297mm), which is
// then physically CUT by hand through the exact center of the 297mm height:
//   297 / 2 = 148.5mm
// giving TWO physical slips of 210mm x 148.5mm each.
//
//   • The TOP half (0–148.5mm) is the real Warehouse Slip: full letterhead +
//     order info + as many product rows as actually fit in the space left
//     after that header.
//   • The BOTTOM half (148.5–297mm) is a CONTINUATION of the same slip — NO
//     header/logo/order-info repeats, just the product table picking up
//     exactly where the top half stopped (serial numbers continue).
//   • If an order has more products than fit in one A4 sheet's two halves,
//     it continues onto a second A4 sheet — whose FIRST half is itself a new
//     physical slip (so it gets the full header again, since after cutting it
//     may end up physically separated from the first slip), and whose SECOND
//     half is again a plain continuation.
//
// How many rows fit is NEVER hardcoded — it's computed from the ACTUAL
// rendered height of the header, the table's column-header row, and each
// product row, measured in real millimeters via a hidden off-screen pass
// (see the useLayoutEffect below) at the exact print width, so text wrapping
// behaves identically to what will actually print.
// ============================================================================
const PAGE_W_MM = 210
const PAGE_H_MM = 297
const HALF_H_MM = PAGE_H_MM / 2       // 148.5 — the physical cut boundary
const PAD_MM = 6                      // inner safe-print margin, inside each half's own box
const CONTENT_W_MM = PAGE_W_MM - PAD_MM * 2   // 198mm usable width
const CONTENT_H_MM = HALF_H_MM - PAD_MM * 2   // 136.5mm usable height PER HALF
const SAFETY_MM = 1.5                 // rounding buffer so a half is never right at the edge
// CSS's fixed reference ratio (1in = 96px = 25.4mm) — constant regardless of
// the viewer's actual monitor DPI; this is what makes measuring in mm-sized
// DOM elements a reliable stand-in for what will physically print.
const PX_PER_MM = 96 / 25.4

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
  const continuedLabel = `${company.name} · Warehouse Slip · ${orderRef || ''} · continued`
  const summaryLine = `${all.length} product line(s) · QTY ${totQ} · F QTY ${totF} · TOTAL QTY ${totT}`

  const Header = () => (
    <>
      {/* Letterhead — ONE brand-correct logo (never both). First half of each
          physical sheet only — never on a continuation half. */}
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

      {/* Order meta */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs mb-4 border border-slate-200 rounded-lg p-3">
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
      <td className="border border-slate-300 px-2 py-2"><CopyableProductName name={it.name} /></td>
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
  // Renders the header, the continuation label, the table's column-header
  // row, and EVERY product row off-screen at the real 198mm print width, then
  // measures each one's actual height in millimeters. This is what drives the
  // pagination below — nothing here is a fixed row count.
  const measureHeaderRef = useRef(null)
  const measureContRef = useRef(null)
  const measureTheadRef = useRef(null)
  const measureSummaryRef = useRef(null)
  const measureRowRefs = useRef([])
  const [halves, setHalves] = useState(null)

  useLayoutEffect(() => {
    const mm = (el) => (el ? el.getBoundingClientRect().height / PX_PER_MM : 0)
    const headerMM = mm(measureHeaderRef.current)
    const contMM = mm(measureContRef.current)
    const theadMM = mm(measureTheadRef.current)
    const summaryMM = mm(measureSummaryRef.current)
    const rowHeightsMM = all.map((_, i) => mm(measureRowRefs.current[i]))

    // Reserve room for the summary line on EVERY half (not just whichever one
    // turns out to be last) — a small, deliberately conservative safety
    // margin so the cut boundary is never at risk of being crossed.
    const availFirst = CONTENT_H_MM - headerMM - theadMM - summaryMM - SAFETY_MM
    const availCont = CONTENT_H_MM - contMM - theadMM - summaryMM - SAFETY_MM

    const result = []
    let idx = 0
    let slCounter = 0
    while (idx < all.length) {
      const isFirstOfSheet = result.length % 2 === 0
      const budget = isFirstOfSheet ? availFirst : availCont
      const rowsForHalf = []
      let used = 0
      while (idx < all.length) {
        const h = rowHeightsMM[idx] || 0
        if (used + h > budget && rowsForHalf.length > 0) break
        rowsForHalf.push(all[idx])
        used += h
        idx++
      }
      // Never stall: if even ONE row alone exceeds the budget (extremely long
      // wrapped name), place it by itself rather than looping forever.
      if (rowsForHalf.length === 0) { rowsForHalf.push(all[idx]); idx++ }
      result.push({ isFirstOfSheet, rows: rowsForHalf, startIndex: slCounter })
      slCounter += rowsForHalf.length
    }
    if (result.length === 0) result.push({ isFirstOfSheet: true, rows: [], startIndex: 0 })
    setHalves(result)
    // Re-measure whenever the actual content that affects height changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    all.map((i) => `${i.name}|${i.qty}|${i.free_qty}|${i.mrp}|${i.unit}`).join(';'),
    company.name, orderRef, shopName, route, salesRepName, prettyDate, orderTime
  ])

  const MeasurementPass = () => (
    <div aria-hidden="true" style={{ position: 'absolute', top: 0, left: '-9999px', width: `${CONTENT_W_MM}mm` }}>
      <div ref={measureHeaderRef} className="p-4 sm:p-6"><Header /></div>
      <div ref={measureContRef} className="text-[10px] text-slate-400 mb-2">{continuedLabel}</div>
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

  // --- Real output (screen preview AND print) — both driven by the SAME
  // measured `halves`, so what you preview is exactly what prints. -------
  const halvesContent = halves && (
    <>
      {halves.map((h, i) => {
        const isBottomOfSheet = i % 2 === 1
        const isLastHalf = i === halves.length - 1
        return (
          <div
            key={i}
            className="wh-half"
            style={{
              width: `${PAGE_W_MM}mm`,
              height: `${HALF_H_MM}mm`,
              padding: `${PAD_MM}mm`,
              boxSizing: 'border-box',
              overflow: 'hidden',
              breakAfter: isBottomOfSheet && !isLastHalf ? 'page' : 'auto',
              borderTop: isBottomOfSheet ? '1px dashed #94a3b8' : 'none',
              position: 'relative',
              background: '#fff'
            }}
          >
            {isBottomOfSheet && (
              <span
                className="no-print-inline"
                style={{ position: 'absolute', top: '-9px', left: '50%', transform: 'translateX(-50%)', background: '#fff', padding: '0 6px', fontSize: '9px', color: '#94a3b8' }}
              >
                ✂ cut here — 148.5mm
              </span>
            )}
            {h.isFirstOfSheet ? <Header /> : (
              <div className="text-[10px] text-slate-400 mb-2">{continuedLabel}</div>
            )}
            <ProductTable rows={h.rows} startIndex={h.startIndex} />
            {isLastHalf && (
              <div className="mt-2 text-[9px] text-slate-400 text-center">{summaryLine}</div>
            )}
          </div>
        )
      })}
    </>
  )

  return (
    <div className="bg-white">
      <style>{`
        @media print {
          @page { size: A4 portrait; margin: 0; }
          html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }

          /* PRINT ISOLATION: hide the entire app (#root) and show ONLY the
             body-level print portal — a direct child of <body>, not trapped
             inside the modal's position:fixed/overflow box, so there is no
             ghost double-paint and page-breaks apply cleanly. */
          #root { display: none !important; }
          .wh-print-portal { display: block !important; }
          .no-print, .no-print-inline { display: none !important; }

          .wh-half tr { break-inside: avoid !important; page-break-inside: avoid !important; }
          .wh-half thead { display: table-header-group; }
        }
        /* The print portal is hidden on screen; it only appears when printing. */
        .wh-print-portal { display: none; }
      `}</style>

      {/* Hidden measurement pass — always rendered so refs stay populated,
          real screen/print output only appears once heights are known. */}
      <MeasurementPass />

      {/* On-screen preview — the exact same computed halves, just with a
          visible gap + shadow between physical slips for readability
          (screen-only styling; the print copy below has zero gap and uses
          the real @page A4 portrait boundaries). */}
      {halves && (
        <div className="flex flex-col items-center gap-3 py-4 overflow-x-auto">
          {halves.map((h, i) => {
            const isBottomOfSheet = i % 2 === 1
            const isLastHalf = i === halves.length - 1
            return (
              <div key={i} className="shadow-2xl rounded-lg overflow-hidden shrink-0 bg-white" style={{ width: `${PAGE_W_MM}mm` }}>
                <div
                  style={{
                    width: `${PAGE_W_MM}mm`,
                    height: `${HALF_H_MM}mm`,
                    padding: `${PAD_MM}mm`,
                    boxSizing: 'border-box',
                    overflow: 'hidden',
                    borderTop: isBottomOfSheet ? '1px dashed #94a3b8' : 'none',
                    position: 'relative'
                  }}
                >
                  {isBottomOfSheet && (
                    <span style={{ position: 'absolute', top: '-9px', left: '50%', transform: 'translateX(-50%)', background: '#fff', padding: '0 6px', fontSize: '9px', color: '#94a3b8' }}>
                      ✂ cut here — 148.5mm
                    </span>
                  )}
                  {h.isFirstOfSheet ? <Header /> : (
                    <div className="text-[10px] text-slate-400 mb-2">{continuedLabel}</div>
                  )}
                  <ProductTable rows={h.rows} startIndex={h.startIndex} />
                  {isLastHalf && (
                    <div className="mt-2 text-[9px] text-slate-400 text-center">{summaryLine}</div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Print-only copy, portaled to <body> so print isolation is clean. */}
      {halves && createPortal(
        <div className="wh-print-portal bg-white">{halvesContent}</div>,
        document.body
      )}
    </div>
  )
}
