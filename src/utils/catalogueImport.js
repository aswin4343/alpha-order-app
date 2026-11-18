// =============================================================================
// Excel catalogue import — payload builders (v227). Pure; unit-tested in Node.
//
// The rows built here are sent to the database function
// import_products_catalogue (migration 74), which applies the whole upload in
// ONE transaction, matches products by name on the server, and decides price
// revisions itself. These builders therefore never send price_version,
// price_changed_at, last_approved_* or any other revision field.
// =============================================================================

export const nameKey = (n) => (n || '').trim().toUpperCase()
const hasVal = (v) => v !== null && v !== undefined && v !== ''

/**
 * REPLACE ALL: the uploaded list becomes the whole catalogue, in file order.
 * Existing products keep their id (matched by name) so stock, order history
 * and approvals stay attached. New products carry their Excel id only as a
 * hint — the server assigns a collision-free id if it is taken.
 */
export function buildReplacePayload(uploadedList, existingProducts) {
  const byKey = new Map((existingProducts || []).map((p) => [nameKey(p.name), p]))
  const rows = []
  const seen = new Set()
  for (const p of uploadedList || []) {
    const key = nameKey(p.name)
    if (!key || seen.has(key)) continue
    seen.add(key)
    const cur = byKey.get(key)
    rows.push({
      id: cur ? cur.id : (p.id || null),
      name: (p.name || '').trim(),
      slabs: p.slabs || [],
      base: p.base ?? null,
      mrp: p.mrp ?? null,
      retail: p.retail ?? null,
      wholesale: p.wholesale ?? null,
      net: p.net || [],
      gst: p.gst ?? null,
      hsn: p.hsn || null,
      qty_in_box: p.qty_in_box ?? null,
      outer_qty: p.outer_qty ?? null,
      box: p.box ?? null,
      is_qt: p.is_qt ?? false,
      sell_by_piece: p.sell_by_piece ?? true,
      sell_by_outer: p.sell_by_outer ?? false,
      sell_by_box: p.sell_by_box ?? false
    })
  }
  return { rows }
}

/**
 * MERGE: only products already in the catalogue, only fields the Excel has a
 * valid value for. Never deletes, never blanks, never inserts. (Rules are the
 * same as the previous mergeUpdateCloudProducts.)
 * Returns { rows: [{ id, name, ...changedFields }], unmatched: [names], skippedNoData }
 */
export function buildMergePayload(uploadedList, existingProducts) {
  const byKey = new Map((existingProducts || []).map((p) => [nameKey(p.name), p]))
  const rows = []
  const unmatched = []
  let skippedNoData = 0
  const seen = new Set()

  for (const u of uploadedList || []) {
    const key = nameKey(u.name)
    if (!key || seen.has(key)) continue
    seen.add(key)
    const target = byKey.get(key)
    if (!target) { unmatched.push(u.name); continue }

    const patch = {}
    if (hasVal(u.mrp)) patch.mrp = u.mrp
    if (hasVal(u.retail)) patch.retail = u.retail
    if (hasVal(u.wholesale)) patch.wholesale = u.wholesale
    if (hasVal(u.base)) patch.base = u.base
    if (hasVal(u.gst)) patch.gst = u.gst
    if (hasVal(u.hsn)) patch.hsn = u.hsn
    if (hasVal(u.qty_in_box)) patch.qty_in_box = u.qty_in_box
    if (hasVal(u.outer_qty)) patch.outer_qty = u.outer_qty
    if (hasVal(u.box)) patch.box = u.box
    // QT is a yes/no status: a blank in a file that HAS the QT column = unmark.
    if (u._qtColPresent) patch.is_qt = !!u.is_qt
    // Selling units: only when the file carried the SELL BY columns.
    if (u._sellColPresent) {
      const piece = u.sell_by_piece != null ? !!u.sell_by_piece : (target.sell_by_piece ?? true)
      const outer = u.sell_by_outer != null ? !!u.sell_by_outer : (target.sell_by_outer ?? false)
      const box   = u.sell_by_box   != null ? !!u.sell_by_box   : (target.sell_by_box   ?? false)
      if (!piece && !outer && !box) {
        console.warn(`Sell-by validation: ${u.name} has all units set to NO — skipped.`)
        skippedNoData++; continue
      }
      patch.sell_by_piece = piece
      patch.sell_by_outer = outer
      patch.sell_by_box   = box
    }
    // Scheme slabs: only replace when the file genuinely carried scheme rows.
    if (Array.isArray(u.slabs) && u.slabs.length > 0) {
      patch.slabs = u.slabs
      if (Array.isArray(u.net) && u.net.length > 0) patch.net = u.net
    }

    if (Object.keys(patch).length === 0) { skippedNoData++; continue }
    rows.push({ id: target.id, name: target.name, ...patch })
  }
  return { rows, unmatched, skippedNoData }
}

/** Which products' applicable (retail / wholesale) price this upload changes — for display only. */
export function previewPriceChanges(rows, existingProducts) {
  const byId = new Map((existingProducts || []).map((p) => [p.id, p]))
  const cents = (v) => (v == null || v === '' ? null : Math.round(Number(v) * 100))
  const out = []
  for (const r of rows || []) {
    const cur = byId.get(r.id)
    if (!cur) continue
    const rc = 'retail' in r && cents(r.retail) !== cents(cur.retail)
    const wc = 'wholesale' in r && cents(r.wholesale) !== cents(cur.wholesale)
    if (rc || wc) out.push(cur.name)
  }
  return out
}
