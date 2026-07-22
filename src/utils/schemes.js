// ---------------------------------------------------------------------------
// SCHEME ENGINE
//
// Business rules (strict — do not "improve" the offer for the customer):
//
//   1. A scheme slab qualifies only if purchased qty >= that slab's Buy qty.
//   2. Among all qualifying slabs, use ONLY the one with the highest Buy qty
//      (the best matching slab). Slabs are never combined.
//   3. Within that slab, apply it repeatedly:
//         Free = FLOOR(qty / slabBuy) * slabFree
//   4. Leftover quantity is discarded — never carried into another slab.
//
// Worked example for slabs [{buy:6,free:1}, {buy:12,free:3}]:
//      qty 5      -> 0   (nothing qualifies)
//      qty 6..11  -> 1   (slab 6:  FLOOR(q/6)*1  == 1)
//      qty 12..23 -> 3   (slab 12: FLOOR(q/12)*3 == 3)
//      qty 24..35 -> 6   (slab 12: FLOOR(q/12)*3 == 6)
//      qty 36     -> 9
// ---------------------------------------------------------------------------

/**
 * Pick the highest qualifying slab for a quantity.
 * @param {number} qty
 * @param {Array<[number, number]>} slabs - array of [buy, free] pairs
 * @returns {{buy:number, free:number}|null}
 */
export function selectSlab(qty, slabs) {
  if (!slabs || slabs.length === 0 || qty <= 0) return null
  let best = null
  for (const [buy, free] of slabs) {
    if (qty >= buy) {
      if (!best || buy > best.buy) best = { buy, free }
    }
  }
  return best
}

/**
 * Calculate free quantity for a purchased quantity.
 * Returns full detail so the UI can explain the result to the rep.
 */
export function calculateScheme(qty, slabs) {
  const slab = selectSlab(qty, slabs)
  if (!slab) {
    return { free: 0, slab: null, groups: 0, leftover: qty }
  }
  const groups = Math.floor(qty / slab.buy)
  const free = groups * slab.free
  const leftover = qty - groups * slab.buy
  return { free, slab, groups, leftover }
}

/**
 * Human-readable badge listing every slab a product offers.
 * e.g. "6+1 · 12+3"
 */
export function schemeBadge(slabs) {
  if (!slabs || slabs.length === 0) return ''
  return slabs
    .slice()
    .sort((a, b) => a[0] - b[0])
    .map(([buy, free]) => `${buy}+${free}`)
    .join(' · ')
}

/**
 * Net rate for a given slab: effective per-unit price after free goods.
 *   net = base * buy / (buy + free)
 */
export function netRate(base, buy, free) {
  if (!base || !buy) return null
  return Math.round(((base * buy) / (buy + free)) * 100) / 100
}
