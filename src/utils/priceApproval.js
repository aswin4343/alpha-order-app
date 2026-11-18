// =============================================================================
// Shop-specific price approval + Last Price validity — pure helpers (v227).
//
// BUSINESS RULE
//   One Product + One Shop + One Master Price Revision + One Approved Price
//   = One reusable approval permission.
//
// The DATABASE is the authority (migration 74: shop_price_approvals +
// order_items trigger). These helpers only decide what the rep SEES, so the
// screen agrees with what the server will enforce. They never grant anything
// on their own — a line the server does not recognise is still sent to Admin.
//
// No React, no Supabase — safe to unit-test in plain Node.
// =============================================================================

/** Rupees → integer paise. Avoids floating-point comparisons (28 vs 28.000001). */
export function toPaise(v) {
  if (v == null || v === '') return null
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[^0-9.-]/g, ''))
  if (!Number.isFinite(n)) return null
  return Math.round(n * 100)
}

/** Exact currency equality to the paisa. */
export function samePrice(a, b) {
  const pa = toPaise(a)
  const pb = toPaise(b)
  return pa != null && pb != null && pa === pb
}

/**
 * Build a lookup from shop_price_approvals rows for ONE customer.
 * rows: [{ product_id, price_revision_id, revision_number, approved_price, status }]
 * Returns Map<product_id, Array<{ paise, price, revisionId, revisionNumber }>>
 */
export function buildShopApprovalIndex(rows) {
  const index = new Map()
  for (const r of rows || []) {
    if (!r || r.status !== 'approved' || r.product_id == null) continue
    const paise = toPaise(r.approved_price)
    if (paise == null) continue
    const list = index.get(r.product_id) || []
    list.push({
      paise,
      price: paise / 100,
      revisionId: r.price_revision_id ?? null,
      revisionNumber: r.revision_number ?? null
    })
    index.set(r.product_id, list)
  }
  return index
}

/** Does this approval belong to the product's CURRENT master price revision? */
function isCurrentRevision(entry, product) {
  if (!entry || !product) return false
  // Prefer the exact revision id; fall back to the revision number for a
  // catalogue cached before migration 74 added current_price_revision_id.
  if (entry.revisionId != null && product.current_price_revision_id != null) {
    return String(entry.revisionId) === String(product.current_price_revision_id)
  }
  return entry.revisionNumber != null && product.price_version != null &&
    Number(entry.revisionNumber) === Number(product.price_version)
}

/** All approved prices for this shop + product at the current revision (rupees, ascending). */
export function approvedPricesFor(index, product) {
  if (!index || !product) return []
  const list = index.get(product.id) || []
  const seen = new Set()
  const out = []
  for (const e of list) {
    if (!isCurrentRevision(e, product) || seen.has(e.paise)) continue
    seen.add(e.paise)
    out.push(e.price)
  }
  return out.sort((a, b) => a - b)
}

/** Is `price` approved for this shop + product at the current revision? */
export function isShopApproved(index, product, price) {
  const p = toPaise(price)
  if (p == null) return false
  return approvedPricesFor(index, product).some((v) => toPaise(v) === p)
}

/** Same check when the caller already has the approvedPricesFor() list. */
export function priceInList(approvedPrices, price) {
  const p = toPaise(price)
  return p != null && (approvedPrices || []).some((v) => toPaise(v) === p)
}

/**
 * Is a Last Price entry still usable for this product?
 *   entry: { price, priceVersion, verifiedAt } from loadCustomerLastPrices
 * Rule: a master price revision resets Last Price. The entry is valid only
 * when it was established at the product's CURRENT revision. An entry with no
 * recorded revision is valid only if the product's price has not changed
 * since that sale — otherwise there is not enough information, so it is hidden.
 */
export function isLastPriceCurrent(entry, product) {
  if (!entry || entry.price == null || !product) return false
  if (entry.priceVersion != null && product.price_version != null) {
    return Number(entry.priceVersion) === Number(product.price_version)
  }
  if (!product.price_changed_at) return true
  if (!entry.verifiedAt) return false
  return new Date(entry.verifiedAt).getTime() > new Date(product.price_changed_at).getTime()
}

/**
 * The Last Price entry the rep may use for this product + unit, or null.
 * lastPrices is the map from loadCustomerLastPrices ("NAME||Unit" and "NAME"
 * keys). An entry from an older master price revision is treated as absent:
 * after a price change the Last Price option simply disappears and the card
 * falls back to the customer's current default price.
 */
export function currentLastPriceEntry(lastPrices, product, unit) {
  if (!lastPrices || !product) return null
  const nameKey = (product.name || '').trim().toUpperCase()
  const u = (unit || 'Piece').trim()
  const raw = lastPrices[`${nameKey}||${u}`] ?? lastPrices[nameKey]
  if (raw == null) return null
  const entry = typeof raw === 'number' ? { price: raw, priceVersion: null, verifiedAt: null } : raw
  return isLastPriceCurrent(entry, product) ? entry : null
}

/** The customer's default price floor (same order as OrderPage.defaultPriceValueFor). */
export function customerFloor(product, defaultPriceType) {
  if (!product) return null
  const order = defaultPriceType === 'WHOLESALE'
    ? ['wholesale', 'retail', 'mrp']
    : ['retail', 'wholesale', 'mrp']
  for (const k of order) if (product[k] != null && product[k] !== '') return Number(product[k])
  return null
}

/**
 * Does this price need Admin approval for this customer (ignoring approvals)?
 * Mirrors the server rule in trg_order_items_price_guard:
 *   below the customer's floor → approval, except Box at/above wholesale.
 */
export function needsApprovalBelowFloor({ product, price, defaultPriceType, isBoxUnit }) {
  const floor = customerFloor(product, defaultPriceType)
  const p = toPaise(price)
  const f = toPaise(floor)
  if (p == null || f == null || p >= f) return false
  const w = toPaise(product?.wholesale)
  if (isBoxUnit && w != null && p >= w) return false
  return true
}
