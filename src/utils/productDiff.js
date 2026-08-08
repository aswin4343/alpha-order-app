// ============================================================================
// Product-update detection + predefined announcement builder.
//
// Compares the PREVIOUS cloud catalogue against a NEWLY uploaded product list
// and reports the actual changes (added / removed / price up / price down /
// scheme changed), then formats a single consolidated "Product Update"
// announcement using the predefined message templates.
//
// Pure functions, no I/O — easy to reason about and test.
// ============================================================================

// A product's representative selling price. Products carry several price
// fields; we compare on the first one that is present, in a stable priority so
// the same field is compared on both sides. Retail is the rep-facing price, so
// it leads; then wholesale, MRP, base.
export function repPrice(p) {
  if (!p) return null
  const candidates = [p.retail, p.wholesale, p.mrp, p.base]
  for (const v of candidates) {
    if (v != null && !Number.isNaN(Number(v))) return Number(v)
  }
  return null
}

// Normalise a product name into a stable comparison key.
function nameKey(name) {
  return (name || '').trim().toUpperCase()
}

// Turn a slabs array ([[buy, free], ...]) into a human-readable scheme string.
// Empty / missing → "No scheme".
export function schemeText(p) {
  const slabs = (p && p.slabs) || []
  if (!slabs.length) return 'No scheme'
  return slabs
    .filter((s) => Array.isArray(s) && s.length >= 2)
    .map(([buy, free]) => `Buy ${buy} Get ${free} Free`)
    .join(', ') || 'No scheme'
}

// Canonical scheme signature for equality checks (order-independent).
function schemeSig(p) {
  const slabs = (p && p.slabs) || []
  return slabs
    .filter((s) => Array.isArray(s) && s.length >= 2)
    .map(([b, f]) => `${b}+${f}`)
    .sort()
    .join('|')
}

/**
 * Diff two product lists.
 * @param {Array} prev  previous cloud products
 * @param {Array} next  newly uploaded products
 * @returns {{
 *   added:   Array<{name}>,
 *   removed: Array<{name}>,
 *   priceUp: Array<{name, oldPrice, newPrice}>,
 *   priceDown: Array<{name, oldPrice, newPrice}>,
 *   schemeChanged: Array<{name, oldScheme, newScheme}>,
 *   hasChanges: boolean,
 *   totalChanges: number
 * }}
 */
export function diffProducts(prev, next) {
  const prevMap = new Map()
  ;(prev || []).forEach((p) => prevMap.set(nameKey(p.name), p))
  const nextMap = new Map()
  ;(next || []).forEach((p) => nextMap.set(nameKey(p.name), p))

  const added = []
  const removed = []
  const priceUp = []
  const priceDown = []
  const schemeChanged = []

  // Added + changed: walk the new list.
  for (const [key, np] of nextMap) {
    const op = prevMap.get(key)
    if (!op) {
      added.push({ name: np.name })
      continue
    }
    // Price change.
    const oldP = repPrice(op)
    const newP = repPrice(np)
    if (oldP != null && newP != null && oldP !== newP) {
      if (newP > oldP) priceUp.push({ name: np.name, oldPrice: oldP, newPrice: newP })
      else priceDown.push({ name: np.name, oldPrice: oldP, newPrice: newP })
    }
    // Scheme change.
    if (schemeSig(op) !== schemeSig(np)) {
      schemeChanged.push({ name: np.name, oldScheme: schemeText(op), newScheme: schemeText(np) })
    }
  }

  // Removed: in prev but not in next.
  for (const [key, op] of prevMap) {
    if (!nextMap.has(key)) removed.push({ name: op.name })
  }

  const totalChanges =
    added.length + removed.length + priceUp.length + priceDown.length + schemeChanged.length

  return {
    added,
    removed,
    priceUp,
    priceDown,
    schemeChanged,
    hasChanges: totalChanges > 0,
    totalChanges
  }
}

const rupee = (n) => `₹${Number(n).toLocaleString('en-IN')}`

// Build the individual predefined lines (used for the detailed body).
function detailLines(diff) {
  const lines = []
  diff.priceUp.forEach((c) =>
    lines.push(`The price of ${c.name} has been increased from ${rupee(c.oldPrice)} to ${rupee(c.newPrice)}.`)
  )
  diff.priceDown.forEach((c) =>
    lines.push(`The price of ${c.name} has been reduced from ${rupee(c.oldPrice)} to ${rupee(c.newPrice)}.`)
  )
  diff.schemeChanged.forEach((c) =>
    lines.push(`The scheme for ${c.name} has been updated. Previous: ${c.oldScheme}. New: ${c.newScheme}.`)
  )
  diff.added.forEach((c) =>
    lines.push(`A new product ${c.name} has been added to the product list.`)
  )
  diff.removed.forEach((c) =>
    lines.push(`${c.name} has been removed from the product list. Please do not take new orders for this product.`)
  )
  return lines
}

// Short one-line summary per change (used for the consolidated bullet list).
function summaryLines(diff) {
  const lines = []
  diff.priceUp.forEach((c) => lines.push(`• ${c.name} — Price Increased (${rupee(c.oldPrice)} → ${rupee(c.newPrice)})`))
  diff.priceDown.forEach((c) => lines.push(`• ${c.name} — Price Decreased (${rupee(c.oldPrice)} → ${rupee(c.newPrice)})`))
  diff.schemeChanged.forEach((c) => lines.push(`• ${c.name} — Scheme Updated`))
  diff.added.forEach((c) => lines.push(`• ${c.name} — New Product Added`))
  diff.removed.forEach((c) => lines.push(`• ${c.name} — Product Removed`))
  return lines
}

/**
 * Build the announcement {title, body} from a diff.
 *
 * - Single change → the exact predefined message for that change type.
 * - Multiple changes → one consolidated structured "Product Update" message.
 * Returns null when there are no changes (caller should send nothing).
 */
export function buildAnnouncement(diff) {
  if (!diff || !diff.hasChanges) return null

  if (diff.totalChanges === 1) {
    const [line] = detailLines(diff)
    let title = 'Product Update'
    if (diff.priceUp.length) title = 'Price Increase'
    else if (diff.priceDown.length) title = 'Price Reduction'
    else if (diff.schemeChanged.length) title = 'Scheme Update'
    else if (diff.added.length) title = 'New Product Added'
    else if (diff.removed.length) title = 'Product Removed'
    return {
      title,
      body: `Dear Team,\n\n${line}\n\nPlease take note before taking orders.`
    }
  }

  const body =
    'Dear Team,\n\nThe following product updates have been made:\n\n' +
    summaryLines(diff).join('\n') +
    '\n\nPlease take note of these changes before taking orders.'
  return { title: 'Product Update', body }
}
