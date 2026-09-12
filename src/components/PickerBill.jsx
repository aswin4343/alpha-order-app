import { useState } from 'react'
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
// PRINT MODEL — A5 PORTRAIT (148mm × 210mm)
//
// Physical paper: A5 sheet. Content renders at 148mm wide × 210mm tall.
// This is the original orientation from the first working version of the app.
// A later update switched this to Landscape (210×148.5mm); this restores it.

const ORIENTATION = 'portrait'
const PAGE_W_MM = 148   // portrait width
const PAGE_H_MM = 210   // portrait height
const PAD_MM = 2

// Hard cap on rows per printed page. Pagination is done on the DATA (chunk the
// product array), never by measuring rendered heights and never by letting CSS
// decide where to break. The previous measurement-based approach is what made
// products vanish: it could assign more rows to a page than physically fitted,
// and the page box had a fixed height with overflow:hidden, so the surplus rows
// were silently clipped and never printed (SL 14-19 disappeared exactly this
// way). Chunking the array guarantees every row is rendered exactly once.
const ROWS_PER_PAGE = 10

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
      {/* Ink-saving: plain bold black text on white, no filled shape at
          all — a dark pill/banner behind the title was flagged explicitly
          as unacceptable ink usage. Kept compact (mb-1, not mb-2) so it
          costs minimal vertical space, leaving more room for product rows. */}
      <div className="text-center mb-1">
        <span className="font-black text-slate-900 text-base tracking-widest">WAREHOUSE SLIP</span>
      </div>
      <div className="flex justify-between items-start gap-4 text-[13px] mb-2">
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
    // Ink-saving design: no dark fill anywhere — white background, black
    // bold text, thin borders only. A large filled header/cell burns
    // noticeably more printer ink across every single page of every slip,
    // which matters at this print volume; borders alone are enough to
    // separate the header row visually.
    <tr className="font-bold text-slate-900">
      <th className="border border-slate-800 px-1 py-1 text-center">SL</th>
      <th className="border border-slate-800 px-2 py-1 text-left">PRODUCT NAME</th>
      <th className="border border-slate-800 px-1 py-1 text-right">MRP</th>
      <th className="border border-slate-800 px-1 py-1 text-center">UNIT</th>
      <th className="border border-slate-800 px-1 py-1 text-center">QTY</th>
      <th className="border border-slate-800 px-1 py-1 text-center">F QTY</th>
      <th className="border border-slate-800 px-1 py-1 text-center">TOTAL QTY</th>
      <th className="border border-slate-800 px-1 py-1 text-center">CHECK</th>
    </tr>
  )

  const ProductRow = ({ it, sl, innerRef }) => (
    // Row striping removed for the same reason — alternating a light grey
    // fill across every other row of every page adds up in ink over a full
    // print run. Borders alone still keep rows readable.
    <tr ref={innerRef}>
      <td className="border border-slate-300 px-1 py-1.5 text-center text-slate-600">{sl}</td>
      <td className="wh-name border border-slate-300 px-1 py-1.5 whitespace-nowrap"><CopyableProductName name={it.name} /></td>
      <td className="border border-slate-300 px-1 py-1.5 text-right text-slate-700">{it.mrp != null ? `₹${it.mrp}` : '—'}</td>
      <td className="border border-slate-300 px-1 py-1.5 text-center text-slate-700">{it.unit || '-'}</td>
      <td className="border border-slate-300 px-1 py-1.5 text-center font-bold text-slate-900">{Number(it.qty) || 0}</td>
      <td className="border border-slate-300 px-1 py-1.5 text-center font-bold text-slate-900">{Number(it.free_qty) || 0}</td>
      <td className="border-2 border-slate-800 px-1 py-1.5 text-center font-black text-slate-900">{(Number(it.qty) || 0) + (Number(it.free_qty) || 0)}</td>
      <td className="border border-slate-300 px-1 py-1.5 text-center"><span className="inline-block h-4 w-4 border-2 border-slate-800 rounded-sm" /></td>
    </tr>
  )

  const ProductTable = ({ rows, startIndex }) => (
    <table className="w-full text-[13px] border-collapse table-fixed">
      <SlipColgroup />
      <thead><HeadRow /></thead>
      <tbody>
        {rows.map((it, j) => <ProductRow key={startIndex + j} it={it} sl={startIndex + j + 1} />)}
      </tbody>
    </table>
  )

  // Chunk the product array into fixed pages of ROWS_PER_PAGE. Pure data
  // operation, computed during render — no effects, no measuring, no state.
  // Page count is exactly Math.ceil(total / ROWS_PER_PAGE).
  const pages = []
  for (let i = 0; i < all.length; i += ROWS_PER_PAGE) {
    pages.push({ rows: all.slice(i, i + ROWS_PER_PAGE), startIndex: i, isFirstPage: i === 0 })
  }
  // A slip with no products still shows one page (header + empty table).
  if (pages.length === 0) pages.push({ rows: [], startIndex: 0, isFirstPage: true })

  const renderPage = (p, i, isLastPage) => (
    <div
      key={i}
      className="print-page"
      style={{
        width: `${PAGE_W_MM}mm`,
        // Deliberately NO fixed height and NO overflow:hidden. A fixed page
        // height forces the box to fill the sheet even when it holds only a
        // few rows, which is how stray blank sheets were being produced, and
        // overflow:hidden is what silently clipped surplus rows. Height is now
        // driven by content; the explicit page break below is what separates
        // one printed sheet from the next.
        padding: `${PAD_MM}mm`,
        boxSizing: 'border-box',
        breakAfter: isLastPage ? 'auto' : 'page',
        pageBreakAfter: isLastPage ? 'auto' : 'always',
        breakInside: 'avoid',
        pageBreakInside: 'avoid',
        background: '#fff'
      }}
    >
      {p.isFirstPage && <SlipHeader />}
      <ProductTable rows={p.rows} startIndex={p.startIndex} />
      {isLastPage && <div className="mt-1 text-[11px] text-slate-500 text-center">{summaryLine}</div>}
    </div>
  )

  return (
    <div className="bg-white">
      <style>{`
        @media print {
          /* A5 Portrait: 148mm wide × 210mm tall. Restored to original orientation. */
          @page { size: ${PAGE_W_MM}mm ${PAGE_H_MM}mm; margin: 0; }
          html, body { margin: 0 !important; padding: 0 !important; }
          .no-print-inline { display: none !important; }
          body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
          .wh-screen-copy { display: none !important; }
          .picker-bill-print { width: ${PAGE_W_MM}mm !important; max-width: ${PAGE_W_MM}mm !important; overflow: visible !important; }
          .wh-slip-root { width: ${PAGE_W_MM}mm !important; max-width: ${PAGE_W_MM}mm !important; overflow: visible !important; }
          .print-page { width: ${PAGE_W_MM}mm !important; box-shadow: none !important; border-radius: 0 !important; }
          .print-page tr { break-inside: avoid !important; page-break-inside: avoid !important; }
          .print-page .wh-name, .print-page .wh-name * { white-space: nowrap !important; }
        }
      `}</style>

      {/* On-screen preview — same renderPage() as the printed copy.
          Content renders at 148mm × 210mm (portrait). Preview = print. */}
      <div className="wh-screen-copy flex flex-col items-center gap-4 py-4 overflow-auto">
        {pages.map((p, i) => (
          <div key={i} className="shadow-2xl rounded-lg overflow-hidden bg-white shrink-0">
            {renderPage(p, i, i === pages.length - 1)}
          </div>
        ))}
      </div>

      {/* Print-only copy portaled to body. No rotation wrapper — the @page
          CSS declares 210mm×148.5mm so the browser tells the driver "landscape"
          without any transform. index.css pins this with position:absolute;
          top:0; left:0 which seats it at the sheet's top-left. */}
      {createPortal(
        <div className="picker-bill-print bg-white">
          <div className="wh-slip-root bg-white" style={{ width: `${PAGE_W_MM}mm` }}>
            {pages.map((p, i) => renderPage(p, i, i === pages.length - 1))}
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}
