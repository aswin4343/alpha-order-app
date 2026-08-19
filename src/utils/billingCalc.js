// ============================================================================
// Billing math — after-tax (sales rep price) → before-tax rate for invoicing.
//
// THE RULE: the sales rep's selected price is always AFTER-TAX. The line
// TOTAL (after-tax price × qty) is the source of truth and must never drift.
// Everything else (before-tax rate, taxable amount, GST amount) is derived
// FROM that total, not the other way around — this guarantees
// taxable + gst === total exactly, with no floating-point mismatch, even
// though a naive "rate × qty" recombination might be a paisa off (exactly the
// kind of drift real invoices sometimes show, which we deliberately avoid).
// ============================================================================

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100

/**
 * Reverse-calculate one order line's billing breakdown.
 * @param {number} afterTaxUnitPrice  the rep's selected/edited price (per unit, tax-inclusive)
 * @param {number} qty
 * @param {number} gstPercent         0/5/12/18/28 etc. Treated as 0 if null/undefined.
 * @returns {{ total, taxable, gstAmount, beforeTaxRate, sgst, cgst }}
 */
export function reverseGstLine(afterTaxUnitPrice, qty, gstPercent) {
  const price = Number(afterTaxUnitPrice) || 0
  const q = Number(qty) || 0
  const gst = Number(gstPercent) || 0

  // Total is the ground truth — exactly what the sales rep's price implies.
  const total = round2(price * q)

  // Taxable amount = total reverse-divided by (1 + gst/100), rounded once.
  const taxable = gst > 0 ? round2(total / (1 + gst / 100)) : total

  // GST amount = whatever's left over, so taxable + gstAmount === total ALWAYS,
  // by construction — never independently computed and re-summed.
  const gstAmount = round2(total - taxable)

  // Before-tax unit rate — DISPLAY ONLY. qty × this rate may be a paisa off
  // from `taxable` after rounding; taxable (not rate × qty) is what's used
  // everywhere else, exactly like the reference invoice's own rounding.
  const beforeTaxRate = q > 0 ? round2(taxable / q) : 0

  // Standard intra-state split (CGST = SGST = GST / 2), matching the
  // reference invoice format. No IGST handling — not required/observed.
  const half = round2(gstAmount / 2)

  return { total, taxable, gstAmount, beforeTaxRate, sgst: half, cgst: round2(gstAmount - half) }
}

/**
 * Compute the full bill breakdown for a set of order lines.
 * Each line needs: { qty, unit_price (after-tax), gst_percent }.
 * Returns per-line results plus bill-level aggregates (GST-slab summary,
 * sub total, total qty, grand total).
 */
export function computeBill(lines) {
  const computed = lines.map((l) => ({
    ...l,
    ...reverseGstLine(l.unit_price, l.qty, l.gst_percent)
  }))

  const totalQty = computed.reduce((s, l) => s + (Number(l.qty) || 0), 0)
  const subTotal = round2(computed.reduce((s, l) => s + l.taxable, 0))
  const grandTotalExact = computed.reduce((s, l) => s + l.total, 0)
  const grandTotal = Math.round(grandTotalExact) // whole-rupee total, like the reference
  const roundOff = round2(grandTotal - grandTotalExact)

  // Group by GST% for the summary box (5% / 12% / 18% / 28% rows).
  const slabMap = new Map()
  for (const l of computed) {
    const key = Number(l.gst_percent) || 0
    const s = slabMap.get(key) || { gstPercent: key, sgst: 0, cgst: 0, taxAmt: 0 }
    s.sgst = round2(s.sgst + l.sgst)
    s.cgst = round2(s.cgst + l.cgst)
    s.taxAmt = round2(s.taxAmt + l.gstAmount)
    slabMap.set(key, s)
  }
  const gstSlabs = Array.from(slabMap.values()).sort((a, b) => a.gstPercent - b.gstPercent)

  return {
    lines: computed,
    totalQty,
    subTotal,
    roundOff,
    netAmount: subTotal + gstSlabs.reduce((s, g) => s + g.taxAmt, 0),
    grandTotal,
    gstSlabs
  }
}

// ---------------------------------------------------------------------------
// Indian-style number → words (for "Amount in words" line), e.g. 6691 →
// "Six Thousand Six Hundred and Ninety One Only".
// ---------------------------------------------------------------------------
const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
  'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen']
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety']

function twoDigits(n) {
  if (n < 20) return ONES[n]
  const t = Math.floor(n / 10), o = n % 10
  return TENS[t] + (o ? ' ' + ONES[o] : '')
}
function threeDigits(n) {
  const h = Math.floor(n / 100), r = n % 100
  return (h ? ONES[h] + ' Hundred' + (r ? ' and ' : '') : '') + (r ? twoDigits(r) : '')
}

/** Convert a non-negative integer rupee amount to Indian-style words. */
export function numberToWordsIndian(num) {
  let n = Math.round(Math.abs(Number(num) || 0))
  if (n === 0) return 'Zero Only'
  const crore = Math.floor(n / 10000000); n %= 10000000
  const lakh = Math.floor(n / 100000); n %= 100000
  const thousand = Math.floor(n / 1000); n %= 1000
  const hundred = n

  const parts = []
  if (crore) parts.push(threeDigits(crore) + ' Crore')
  if (lakh) parts.push(threeDigits(lakh) + ' Lakh')
  if (thousand) parts.push(threeDigits(thousand) + ' Thousand')
  if (hundred) parts.push(threeDigits(hundred))

  return parts.join(' ') + ' Only'
}
