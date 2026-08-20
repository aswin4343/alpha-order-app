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

/**
 * Picker Bill — print-ready picking sheet for warehouse staff.
 *
 * Props:
 *   brand        - 'ALPHA TRADE LINKS' | 'ZEDGO' (drives the letterhead)
 *   shopName     - buyer/shop name
 *   route        - optional route string, shown alongside shop
 *   salesRepName - the rep who placed the order
 *   orderDate    - 'YYYY-MM-DD' or Date-parsable string
 *   orderTime    - display string, e.g. '5:42 PM' (falls back to orderDate's time)
 *   orderRef     - short reference (use orderRefFrom(orderId))
 *   items        - [{ name, mrp, unit, qty }]
 */
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
  // Split into pages of at most 5 product rows. Numbering is continuous across
  // pages (page P starts at P*5 + 1). Header/meta print on page 1 only.
  const ROWS_PER_PAGE = 5
  const pages = []
  for (let i = 0; i < all.length; i += ROWS_PER_PAGE) pages.push(all.slice(i, i + ROWS_PER_PAGE))
  if (pages.length === 0) pages.push([])

  const totQ = all.reduce((s, i) => s + (Number(i.qty) || 0), 0)
  const totF = all.reduce((s, i) => s + (Number(i.free_qty) || 0), 0)
  const totT = totQ + totF

  const Header = () => (
    <>
      {/* Letterhead — ONE brand-correct logo (never both). Page 1 only. */}
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
    <div className="bg-white warehouse-slip-root">
      <style>{`
        @media print {
          @page { size: A5 landscape; margin: 6mm; }
          html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }

          /* Escape the modal: neutralise every fixed/flex/overflow ancestor so
             the slip can paginate freely. Without this, the printable content
             is trapped inside a position:fixed, min-h-full flex container and
             the browser ignores @page size and page breaks. */
          body * { visibility: hidden !important; }
          .warehouse-slip-root, .warehouse-slip-root * { visibility: visible !important; }
          .warehouse-slip-root {
            position: absolute !important;
            left: 0 !important; top: 0 !important; right: 0 !important;
            width: 100% !important; margin: 0 !important; padding: 0 !important;
          }
          /* Any fixed/overflow modal ancestors: strip positioning + scroll so
             they don't clip or re-anchor the printed pages. */
          .wh-print-ancestor { position: static !important; overflow: visible !important; height: auto !important; min-height: 0 !important; display: block !important; background: none !important; }

          .no-print, .no-print-inline { display: none !important; }

          /* One A5 landscape sheet per page group; never split a product row. */
          .warehouse-slip-page { break-after: page; page-break-after: always; box-shadow: none !important; padding: 0 !important; margin: 0 !important; }
          .warehouse-slip-page:last-child { break-after: auto; page-break-after: auto; }
          .warehouse-slip-page table { break-inside: auto; }
          .warehouse-slip-page tr { break-inside: avoid !important; page-break-inside: avoid !important; }
          .warehouse-slip-page thead { display: table-header-group; }
        }
      `}</style>

      {pages.map((rows, p) => (
        <div key={p} className="warehouse-slip-page picker-bill-print p-4 sm:p-6 max-w-3xl mx-auto">
          {p === 0 ? <Header /> : (
            <div className="text-[10px] text-slate-400 mb-2">{company.name} · Warehouse Slip · {orderRef || ''} · page {p + 1}</div>
          )}
          <ProductTable rows={rows} startIndex={p * ROWS_PER_PAGE} />
          {p === pages.length - 1 && (
            <div className="mt-3 text-[10px] text-slate-400 text-center">
              {all.length} product line(s) · QTY {totQ} · F QTY {totF} · TOTAL QTY {totT}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
