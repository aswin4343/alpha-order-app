import { useState } from 'react'
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
// PHYSICAL PRINTING MODEL
//
// The Warehouse Slip prints on ONE A4 PORTRAIT sheet, which is then
// physically cut by hand through the exact center of its height, giving two
// 210mm x 148.5mm physical slips:
//   • The TOP half is the real Warehouse Slip: full letterhead + order info
//     + as many product rows as fit in the remaining space.
//   • The BOTTOM half is a CONTINUATION — no header/logo/order-info repeats,
//     just the product table picking up where the top half stopped (serial
//     numbers continue).
//   • A long order continues onto additional A4 sheets; each new sheet's
//     first half gets the full header again (it may end up physically
//     separated from the first slip after cutting), its second half is again
//     a plain continuation.
//
// ARCHITECTURE NOTE: this deliberately mirrors FullBill.jsx's proven-working
// print approach — a single synchronous render, Tailwind classes only, no
// @page override, no DOM-measurement effects. An earlier version computed
// exact row-fitting from real measured DOM heights (via useLayoutEffect +
// refs + an off-screen measurement pass), which produced a completely blank
// print/PDF across repeated attempts in both Brave and Chrome, while
// FullBill's simple synchronous/class-based rendering always printed
// correctly. Rather than keep patching within that fragile two-pass
// architecture, this uses a conservative, FIXED per-half row budget —
// computed once as a plain constant, not measured — with row-level
// `break-inside: avoid` as a safety net so a row can never be visually split
// even if a particular product name wraps onto two lines. This trades a
// little packing precision for the same reliability FullBill already has.
// ============================================================================
const ROWS_FIRST_HALF = 5          // header eats real space; fewer rows fit
const ROWS_CONTINUATION_HALF = 10  // no header — more room for rows

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

  // Synchronous pagination — a plain function of props, computed during
  // render (no effects, no measurement, no state). Halves alternate
  // first-of-sheet (full header) / continuation (compact label), exactly
  // like before; only HOW the row count per half is decided has changed.
  const halves = []
  {
    let idx = 0
    let slCounter = 0
    if (all.length === 0) {
      halves.push({ isFirstOfSheet: true, rows: [], startIndex: 0 })
    }
    while (idx < all.length) {
      const isFirstOfSheet = halves.length % 2 === 0
      const budget = isFirstOfSheet ? ROWS_FIRST_HALF : ROWS_CONTINUATION_HALF
      const rows = all.slice(idx, idx + budget)
      halves.push({ isFirstOfSheet, rows, startIndex: slCounter })
      idx += rows.length
      slCounter += rows.length
    }
  }
  const sheets = []
  for (let i = 0; i < halves.length; i += 2) sheets.push([halves[i], halves[i + 1]].filter(Boolean))

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

  const ProductTable = ({ rows, startIndex }) => (
    <table className="w-full text-xs border-collapse">
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
      <tbody>
        {rows.map((it, j) => {
          const sl = startIndex + j + 1
          return (
            <tr key={sl} className={sl % 2 ? 'bg-white' : 'bg-slate-50'}>
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
        })}
      </tbody>
    </table>
  )

  return (
    <div className="bg-white">
      {/* Print CSS mirrors FullBill.jsx exactly: no @page override (the
          browser's own print dialog handles paper size/orientation, same as
          every other bill in this app), just color-adjust + hiding
          screen-only decoration + keeping rows intact across a page break. */}
      <style>{`
        @media print {
          .no-print-inline { display: none !important; }
          body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
          .wh-sheet { box-shadow: none !important; }
          .wh-sheet tr { break-inside: avoid !important; page-break-inside: avoid !important; }
          .wh-sheet thead { display: table-header-group; }
        }
      `}</style>

      <div className="flex flex-col items-center gap-4 py-4">
        {sheets.map((pair, sheetIdx) => (
          <div key={sheetIdx} className="wh-sheet shadow-2xl rounded-lg overflow-hidden bg-white w-full max-w-[210mm] mx-auto">
            {pair.map((h, j) => {
              const globalIndex = sheetIdx * 2 + j
              const isBottomOfSheet = globalIndex % 2 === 1
              const isLastHalfOverall = globalIndex === halves.length - 1
              return (
                <div
                  key={j}
                  className={`p-4 sm:p-6 ${isBottomOfSheet ? 'border-t border-dashed border-slate-400 relative' : ''}`}
                >
                  {isBottomOfSheet && (
                    <span className="no-print-inline absolute -top-2 left-1/2 -translate-x-1/2 bg-white px-2 text-[9px] text-slate-400">
                      ✂ cut here
                    </span>
                  )}
                  {h.isFirstOfSheet ? <Header /> : (
                    <div className="text-[10px] text-slate-400 mb-2">{continuedLabel}</div>
                  )}
                  <ProductTable rows={h.rows} startIndex={h.startIndex} />
                  {isLastHalfOverall && (
                    <div className="mt-3 text-[10px] text-slate-400 text-center">
                      {summaryLine}
                      <span className="ml-2 opacity-60">· build v50</span>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}
