import { useState } from 'react'
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
// PHYSICAL PRINTING MODEL — A5 portrait, browser-paginated
//
// The Warehouse Slip prints directly on real A5 paper (148mm x 210mm
// portrait) via `@page { size: A5 portrait }`. This is ONE continuous
// document — the company header appears once, at the top, followed by a
// single uninterrupted product table. `break-inside: avoid` on each row is
// the only pagination-related rule — a row that doesn't fully fit flows
// whole onto the next page instead of being cut. The header is a normal,
// single block above the table (not a repeating <thead>, never duplicated in
// the DOM) — it can only appear once. The table's own column-header row is
// allowed to repeat via `display: table-header-group`.
//
// WHY THIS IS RENDERED VIA A PORTAL: src/index.css has a global print rule
// (`body * { visibility: hidden }`) that rescues only content tagged
// `.picker-bill-print`, by setting `position: absolute` on it. This
// component normally sits inside the billing modal, which uses
// `position: fixed inset-0` — and `position: fixed` ancestors are
// specifically designed to repeat on every printed page (the same mechanism
// used for print letterheads/footers elsewhere). An absolutely-positioned
// box living inside a repeating fixed ancestor inherits that per-page
// repetition, which was duplicating the company header on page 2+. Portaling
// the print-only copy to a direct child of <body> removes the fixed ancestor
// entirely, so normal multi-page content flow works reliably. The on-screen
// copy (inside the modal) intentionally does NOT carry the rescue class, so
// the global rule correctly hides it during print — no ghost double-render.
// ============================================================================

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

  // The inner content (header + table + summary) — built once, used inside
  // BOTH the on-screen wrapper and the portaled print wrapper below, so the
  // two can never drift apart.
  const innerContent = (
    <>
      {/* Letterhead — appears ONCE, above the table, never repeated. */}
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

      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs mb-4 border border-slate-200 rounded-lg p-3">
        <div><span className="font-semibold text-slate-500">SHOP / BUYER:</span> <span className="font-bold text-slate-800">{shopName}{route ? `, ${route}` : ''}</span></div>
        <div><span className="font-semibold text-slate-500">ORDER REF:</span> <span className="font-bold text-slate-800">{orderRef || '—'}</span></div>
        <div><span className="font-semibold text-slate-500">SALES REPRESENTATIVE:</span> <span className="font-bold text-slate-800">{salesRepName || '—'}</span></div>
        <div><span className="font-semibold text-slate-500">DATE:</span> <span className="font-bold text-slate-800">{prettyDate}</span> {orderTime ? <span className="ml-2"><span className="font-semibold text-slate-500">TIME:</span> <span className="font-bold text-slate-800">{orderTime}</span></span> : null}</div>
      </div>

      {/* ONE continuous table — the browser paginates this naturally when
          printed on A5; no product-count-based logic here at all. */}
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
          {all.map((it, idx) => {
            const sl = idx + 1
            return (
              <tr key={sl} className={sl % 2 ? 'bg-white' : 'bg-slate-50'}>
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
          })}
        </tbody>
      </table>

      <div className="mt-3 text-[10px] text-slate-400 text-center">{summaryLine}</div>
    </>
  )

  return (
    <div className="bg-white">
      {/* Print CSS: real A5 portrait paper, printer-safe margins, content
          allowed to use the full A5 width, rows never split across a page
          break, product names wrap instead of cropping. overflow must be
          reset to visible for print — overflow:hidden on an ancestor of a
          <table> is a known Chromium bug that can make the whole table
          vanish from print output. */}
      <style>{`
        @media print {
          @page { size: A5 portrait; margin: 6mm; }
          .no-print-inline { display: none !important; }
          body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
          .wh-slip-print {
            box-shadow: none !important;
            overflow: visible !important;
            border-radius: 0 !important;
            width: 100% !important;
            max-width: none !important;
            margin: 0 !important;
            padding: 2mm !important;
          }
          .wh-slip-print tr { break-inside: avoid !important; page-break-inside: avoid !important; }
          .wh-slip-print thead { display: table-header-group; }
        }
      `}</style>

      {/* On-screen copy — NO rescue class, so the global print rule hides it
          during print (avoids a duplicate/ghost render alongside the portal
          copy below). */}
      <div className="wh-slip-print shadow-2xl rounded-lg overflow-hidden bg-white w-full max-w-2xl mx-auto p-4 sm:p-6">
        {innerContent}
      </div>

      {/* Print-only copy — portaled to a direct child of <body>, escaping the
          modal's `position: fixed` ancestor (see comment block above the
          component for why that matters). Both the rescue class and the
          print-CSS-target class live on this SAME element, since the global
          rule's `position: absolute` and this component's own print
          overrides both need to apply to the one box that's actually
          printed. */}
      {createPortal(
        <div className="picker-bill-print wh-slip-print bg-white p-4 sm:p-6">
          {innerContent}
        </div>,
        document.body
      )}
    </div>
  )
}
