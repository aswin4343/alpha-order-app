import { useState } from 'react'
import { computeBill, numberToWordsIndian } from '../utils/billingCalc.js'
import { companyFor } from './PickerBill.jsx'
import { ALPHA_LOGO, ZEDGO_LOGO } from '../assets/logos.js'

const rupee = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

function CopyableName({ name }) {
  const [copied, setCopied] = useState(false)
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(name)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {}
  }
  return (
    <button type="button" onClick={onCopy} className="text-left hover:text-brand-700 active:text-brand-800" title="Tap to copy product name">
      {name}
      {copied && <span className="ml-1.5 text-[9px] font-bold text-emerald-600 no-print-inline">Copied</span>}
    </button>
  )
}

/**
 * Full Bill — the Billing Team's internal working view of a shop's order,
 * following the reference invoice format (SL/HSN/Description/MRP/Unit/Qty/
 * Rate/Dis/FQTY/Taxable/GST%/Total + GST-slab summary). This is NOT a legal
 * customer invoice — no sequential invoice numbering, internal viewing only
 * (per explicit requirement). The sales rep's price is always AFTER-TAX; the
 * before-tax rate/taxable/GST breakdown shown here are derived from it via
 * billingCalc.js, never independently recomputed.
 *
 * Props:
 *   brand, shopName, route, salesRepName, orderDate, orderRef — same as PickerBill
 *   items — [{ name, hsn, mrp, unit, qty, unit_price, gst_percent }]
 */
export default function FullBill({ brand, shopName, route, salesRepName, orderDate, orderRef, items }) {
  const company = companyFor(brand)
  const bill = computeBill(items || [])

  const prettyDate = (() => {
    if (!orderDate) return '—'
    const d = new Date(orderDate.length <= 10 ? `${orderDate}T00:00:00` : orderDate)
    if (isNaN(d.getTime())) return orderDate
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' })
  })()
  const prettyTime = (() => {
    if (!orderDate) return null
    const d = new Date(orderDate.length <= 10 ? `${orderDate}T00:00:00` : orderDate)
    if (isNaN(d.getTime())) return null
    return d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true })
  })()

  return (
    <div className="bg-white">
      <style>{`
        @media print {
          .no-print-inline { display: none !important; }
          body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
          .full-bill-print { padding: 0 !important; box-shadow: none !important; }
        }
      `}</style>

      <div className="full-bill-print p-4 sm:p-6 max-w-4xl mx-auto text-[12px]">
        {/* Letterhead — Alpha logo left, Zedgo right, name centered. Logos keep
            aspect ratio (fixed height, auto width) and are base64-embedded so
            they print/PDF reliably. */}
        <div className="border-b-2 border-slate-800 pb-2 mb-2">
          <div className="flex items-center justify-between gap-3">
            <img src={ALPHA_LOGO} alt="Alpha Trade Links" className="h-10 w-auto object-contain shrink-0" style={{ printColorAdjust: 'exact', WebkitPrintColorAdjust: 'exact' }} />
            <div className="text-center min-w-0">
              <h1 className="text-xl font-black tracking-wide text-slate-900 leading-tight">{company.name}</h1>
              <p className="text-xs text-slate-600">{company.tagline}</p>
              <p className="text-[11px] text-slate-500">{company.address}</p>
              <p className="text-[10px] text-slate-400">
                {company.gstin ? `GSTIN: ${company.gstin}` : ''}{company.fssai ? `  ·  FSSAI: ${company.fssai}` : ''}
              </p>
            </div>
            <img src={ZEDGO_LOGO} alt="Zedgo" className="h-10 w-auto object-contain shrink-0" style={{ printColorAdjust: 'exact', WebkitPrintColorAdjust: 'exact' }} />
          </div>
        </div>

        <div className="text-center mb-2">
          <span className="inline-block px-3 py-1 rounded-full bg-slate-900 text-white text-xs font-black tracking-widest">
            BILLING VIEW — INTERNAL ONLY
          </span>
        </div>

        {/* Order meta */}
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] mb-3 border border-slate-200 rounded-lg p-3">
          <div><span className="font-semibold text-slate-500">BUYER:</span> <span className="font-bold text-slate-800">{shopName}{route ? `, ${route}` : ''}</span></div>
          <div><span className="font-semibold text-slate-500">REF:</span> <span className="font-bold text-slate-800">{orderRef || '—'}</span></div>
          <div><span className="font-semibold text-slate-500">SALES REP:</span> <span className="font-bold text-slate-800">{salesRepName || '—'}</span></div>
          <div>
            <span className="font-semibold text-slate-500">DATE:</span> <span className="font-bold text-slate-800">{prettyDate}</span>
            {prettyTime && <span className="ml-2"><span className="font-semibold text-slate-500">TIME:</span> <span className="font-bold text-slate-800">{prettyTime}</span></span>}
          </div>
        </div>

        {/* Product table */}
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[11px] min-w-[720px]">
            <thead>
              <tr className="bg-slate-900 text-white">
                <th className="border border-slate-700 px-1.5 py-1.5 text-left">SL</th>
                <th className="border border-slate-700 px-1.5 py-1.5 text-left">HSN</th>
                <th className="border border-slate-700 px-1.5 py-1.5 text-left">DESCRIPTION</th>
                <th className="border border-slate-700 px-1.5 py-1.5 text-right">MRP</th>
                <th className="border border-slate-700 px-1.5 py-1.5 text-center">UNIT</th>
                <th className="border border-slate-700 px-1.5 py-1.5 text-center">QTY</th>
                <th className="border border-slate-700 px-1.5 py-1.5 text-right">RATE</th>
                <th className="border border-slate-700 px-1.5 py-1.5 text-center">FQTY</th>
                <th className="border border-slate-700 px-1.5 py-1.5 text-right">TAXABLE</th>
                <th className="border border-slate-700 px-1.5 py-1.5 text-center">GST%</th>
                <th className="border border-slate-700 px-1.5 py-1.5 text-right">TOTAL</th>
              </tr>
            </thead>
            <tbody>
              {bill.lines.map((l, idx) => (
                <tr key={idx} className={idx % 2 ? 'bg-slate-50' : 'bg-white'}>
                  <td className="border border-slate-300 px-1.5 py-1.5 text-slate-600">{idx + 1}</td>
                  <td className="border border-slate-300 px-1.5 py-1.5 text-slate-500">{l.hsn || '—'}</td>
                  <td className="border border-slate-300 px-1.5 py-1.5 font-medium text-slate-800">
                    <CopyableName name={l.name} />
                  </td>
                  <td className="border border-slate-300 px-1.5 py-1.5 text-right text-slate-600">{l.mrp != null ? rupee(l.mrp) : '—'}</td>
                  <td className="border border-slate-300 px-1.5 py-1.5 text-center text-slate-600">{l.unit || '-'}</td>
                  <td className="border border-slate-300 px-1.5 py-1.5 text-center font-semibold text-slate-800">{l.qty}</td>
                  <td className="border border-slate-300 px-1.5 py-1.5 text-right text-slate-600">{rupee(l.beforeTaxRate)}</td>
                  <td className="border border-slate-300 px-1.5 py-1.5 text-center text-slate-500">{l.free_qty || 0}</td>
                  <td className="border border-slate-300 px-1.5 py-1.5 text-right text-slate-700">{rupee(l.taxable)}</td>
                  <td className="border border-slate-300 px-1.5 py-1.5 text-center text-slate-600">{l.gst_percent ?? 0}</td>
                  <td className="border border-slate-300 px-1.5 py-1.5 text-right font-bold text-slate-900">{rupee(l.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* GST slab summary + totals */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
          <div className="border border-slate-200 rounded-lg overflow-hidden">
            <table className="w-full text-[11px] border-collapse">
              <thead>
                <tr className="bg-slate-100 text-slate-600">
                  <th className="border border-slate-200 px-2 py-1.5 text-left">GST %</th>
                  <th className="border border-slate-200 px-2 py-1.5 text-right">SGST</th>
                  <th className="border border-slate-200 px-2 py-1.5 text-right">CGST</th>
                  <th className="border border-slate-200 px-2 py-1.5 text-right">TAX AMT</th>
                </tr>
              </thead>
              <tbody>
                {bill.gstSlabs.map((s) => (
                  <tr key={s.gstPercent}>
                    <td className="border border-slate-200 px-2 py-1.5">{s.gstPercent}%</td>
                    <td className="border border-slate-200 px-2 py-1.5 text-right">{rupee(s.sgst)}</td>
                    <td className="border border-slate-200 px-2 py-1.5 text-right">{rupee(s.cgst)}</td>
                    <td className="border border-slate-200 px-2 py-1.5 text-right">{rupee(s.taxAmt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="border border-slate-200 rounded-lg p-3 text-[11px] space-y-1">
            <div className="flex justify-between"><span className="text-slate-500">Sub total</span><span className="font-semibold text-slate-800">{rupee(bill.subTotal)}</span></div>
            <div className="flex justify-between"><span className="text-slate-500">Total GST</span><span className="font-semibold text-slate-800">{rupee(bill.gstSlabs.reduce((s, g) => s + g.taxAmt, 0))}</span></div>
            <div className="flex justify-between"><span className="text-slate-500">Round off</span><span className="font-semibold text-slate-800">{rupee(bill.roundOff)}</span></div>
            <div className="flex justify-between"><span className="text-slate-500">Total qty</span><span className="font-semibold text-slate-800">{bill.totalQty}</span></div>
            <div className="flex justify-between pt-1.5 mt-1.5 border-t border-slate-200 text-sm">
              <span className="font-bold text-slate-800">TOTAL</span>
              <span className="font-black text-slate-900">{rupee(bill.grandTotal)}</span>
            </div>
          </div>
        </div>

        <p className="text-[11px] text-slate-500 mt-3 italic">
          {numberToWordsIndian(bill.grandTotal)}
        </p>

        <p className="text-center text-[10px] text-slate-400 mt-4">
          Internal billing view only — not a customer invoice.
        </p>
      </div>
    </div>
  )
}
