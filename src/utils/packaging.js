// ============================================================================
// Product packaging / unit conversion.
//
// A product may be ordered in Piece, Outer, or Box. Billing ALWAYS receives
// individual pieces, so the rep's entered (qty, unit) is converted to pieces
// using THIS product's own packaging data — never a global constant.
//
// Master data (from the Admin Excel, per product):
//   qty_in_box  = total individual pieces in one box   (Pieces Per Box)
//   outer_qty   = number of outer units inside one box
//   box         = 1 (box unit; informational)
//
// Derived:
//   Pieces Per Box   = qty_in_box
//   Pieces Per Outer = qty_in_box / outer_qty
//
// SAFETY: a unit is only offered when its conversion is valid and > 0. Missing
// or zero data means that unit is NOT available (never guessed), so a wrong
// quantity can never reach Billing.
// ============================================================================

const num = (v) => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** Pieces in one box, or null if unknown/invalid. */
export function piecesPerBox(product) {
  const q = num(product?.qty_in_box)
  return q != null && q > 0 ? q : null
}

/** Pieces in one outer, or null if unknown/invalid. */
export function piecesPerOuter(product) {
  const q = num(product?.qty_in_box)
  const o = num(product?.outer_qty)
  if (q == null || q <= 0) return null
  if (o == null || o <= 0) return null
  return q / o
}

/** Outers in one box, or null if unknown/invalid. */
export function outersPerBox(product) {
  const o = num(product?.outer_qty)
  return o != null && o > 0 ? o : null
}

/**
 * Which units this product can be ordered in.
 *
 * If the product carries sell_by_* permission flags (from Admin Master File),
 * those are the authoritative source. If the flags are absent (old data before
 * migration), falls back to the previous logic: Piece always allowed, Outer/Box
 * only when their conversion data is present.
 *
 * Priority for default unit (first in the returned array):
 *   Piece → Outer → Box
 */
export function availableUnits(product) {
  // Flags are "managed" only when at least one unit is explicitly ALLOWED (true)
  // AND at least one is explicitly BLOCKED (false). If only restrictions exist
  // with no allowances (e.g. sell_by_piece=false, sell_by_outer=false/missing),
  // the data is incomplete — fall back to the safe legacy behaviour.
  const anyAllowed = product?.sell_by_piece === true || product?.sell_by_outer === true || product?.sell_by_box === true
  const anyRestricted = product?.sell_by_piece === false || product?.sell_by_outer === false || product?.sell_by_box === false
  const flagsManaged = anyAllowed && anyRestricted

  if (flagsManaged) {
    const units = []
    if (product.sell_by_piece !== false) units.push('Piece')
    if (product.sell_by_outer === true && piecesPerOuter(product) != null) units.push('Outer')
    if (product.sell_by_box   === true && piecesPerBox(product) != null)   units.push('Box')
    return units.length > 0 ? units : ['Piece']
  }

  // Legacy path: flags not properly configured — original behaviour
  const units = ['Piece']
  if (piecesPerOuter(product) != null) units.push('Outer')
  if (piecesPerBox(product) != null) units.push('Box')
  return units
}

/**
 * Convert an entered (qty, unit) into individual pieces for this product.
 * Returns a whole number of pieces, or null if the unit's conversion is
 * unavailable (caller must then refuse to send that line).
 */
export function toPieces(product, qty, unit) {
  const n = num(qty)
  if (n == null) return null
  const u = (unit || 'Piece').toLowerCase()
  if (u === 'piece') return n
  if (u === 'outer') {
    const per = piecesPerOuter(product)
    return per == null ? null : Math.round(n * per)
  }
  if (u === 'box') {
    const per = piecesPerBox(product)
    return per == null ? null : Math.round(n * per)
  }
  return null
}

/**
 * Compact human-readable packaging summary for the product card, e.g.
 * "1 Box = 50 Outers = 2000 Pieces · 1 Outer = 40 Pieces". Returns '' when no
 * packaging data exists (card then shows nothing extra).
 */
export function packagingSummary(product) {
  const ppb = piecesPerBox(product)
  const ppo = piecesPerOuter(product)
  const opb = outersPerBox(product)
  const parts = []
  if (ppb != null) {
    parts.push(opb != null
      ? `1 Box = ${fmt(opb)} Outers = ${fmt(ppb)} Pieces`
      : `1 Box = ${fmt(ppb)} Pieces`)
  }
  if (ppo != null) parts.push(`1 Outer = ${fmt(ppo)} Pieces`)
  return parts.join(' · ')
}

function fmt(n) {
  // Trim trailing .0 but keep fractional pieces-per-outer if any.
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100)
}

/**
 * Inline label for a single unit option in the (native) dropdown, e.g.
 *   Piece  -> "Piece"
 *   Outer  -> "Outer (1 = 40 pcs)"
 *   Box    -> "Box (1 = 2000 pcs)"
 * Conversion is product-specific; falls back to the bare unit name when no
 * conversion is available (shouldn't happen, since unavailable units aren't
 * offered). Kept to ONE line because native <option> can't render two lines.
 */
export function unitOptionLabel(product, unit) {
  const u = (unit || 'Piece')
  if (u === 'Piece') return 'Piece'
  if (u === 'Outer') {
    const per = piecesPerOuter(product)
    return per != null ? `Outer (1 = ${fmt(per)} pcs)` : 'Outer'
  }
  if (u === 'Box') {
    const per = piecesPerBox(product)
    return per != null ? `Box (1 = ${fmt(per)} pcs)` : 'Box'
  }
  return u
}
