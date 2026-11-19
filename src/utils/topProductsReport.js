// =============================================================================
// Top Selling Products report — aggregation (v228). Pure; unit-tested in Node.
//
// Counting rules match the dashboard's Top Selling Products card
// (loadTopProducts): every line of every non-hidden order in the range, qty in
// pieces, "orders" = distinct orders containing the product. On top of that the
// report adds value, shops, the sales-rep breakdown, and shows removed /
// stock-out quantity separately so nothing is hidden.
// =============================================================================

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100

/**
 * orders: [{ id, sales_rep_id, customer_id, shop_name }]
 * items:  [{ order_id, product_name, qty, unit_price, approved_price, removed }]
 * repNames: { [sales_rep_id]: full_name }
 */
export function buildTopProductsReport(orders, items, repNames = {}) {
  const orderById = new Map((orders || []).map((o) => [o.id, o]))
  const repLabel = (id) => (id ? (repNames[id] || 'Unknown rep') : 'No rep')
  const shopKey = (o) => (o.customer_id ? `c:${o.customer_id}` : `s:${(o.shop_name || '').trim().toUpperCase()}`)

  const newAgg = () => ({ qty: 0, removedQty: 0, value: 0, orders: new Set(), shops: new Set() })
  const add = (agg, it, o) => {
    const qty = Number(it.qty) || 0
    agg.qty += qty
    if (it.removed) agg.removedQty += qty
    else agg.value += qty * (Number(it.approved_price ?? it.unit_price) || 0)
    agg.orders.add(o.id)
    agg.shops.add(shopKey(o))
  }

  const byProduct = new Map()      // name -> agg
  const byProductRep = new Map()   // name -> Map(repId -> agg)
  const byRep = new Map()          // repId -> { agg, products: Map(name -> qty) }

  for (const it of items || []) {
    const o = orderById.get(it.order_id)
    if (!o) continue
    const name = (it.product_name || '').trim()
    if (!name) continue
    const rep = o.sales_rep_id || null

    if (!byProduct.has(name)) byProduct.set(name, newAgg())
    add(byProduct.get(name), it, o)

    if (!byProductRep.has(name)) byProductRep.set(name, new Map())
    const pr = byProductRep.get(name)
    if (!pr.has(rep)) pr.set(rep, newAgg())
    add(pr.get(rep), it, o)

    if (!byRep.has(rep)) byRep.set(rep, { agg: newAgg(), products: new Map() })
    const rr = byRep.get(rep)
    add(rr.agg, it, o)
    rr.products.set(name, (rr.products.get(name) || 0) + (Number(it.qty) || 0))
  }

  const flat = (agg) => ({
    qty: agg.qty, removedQty: agg.removedQty, value: r2(agg.value),
    orderCount: agg.orders.size, shopCount: agg.shops.size
  })
  const byQtyDesc = (a, b) => b.qty - a.qty || b.orderCount - a.orderCount || a.name.localeCompare(b.name)

  const products = [...byProduct.entries()]
    .map(([name, agg]) => {
      const reps = [...byProductRep.get(name).entries()]
        .map(([repId, a]) => ({ repId, repName: repLabel(repId), ...flat(a) }))
        .sort((a, b) => b.qty - a.qty || b.orderCount - a.orderCount || a.repName.localeCompare(b.repName))
      return { name, ...flat(agg), reps, topRep: reps[0]?.repName || '', repCount: reps.length }
    })
    .sort(byQtyDesc)
    .map((p, i) => ({ rank: i + 1, ...p }))

  const reps = [...byRep.entries()]
    .map(([repId, { agg, products: pq }]) => {
      const top = [...pq.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]
      return {
        repId, repName: repLabel(repId), ...flat(agg),
        productCount: pq.size, topProduct: top ? top[0] : '', topProductQty: top ? top[1] : 0
      }
    })
    .sort((a, b) => b.qty - a.qty || a.repName.localeCompare(b.repName))

  const totals = {
    orders: new Set((items || []).map((i) => i.order_id).filter((id) => orderById.has(id))).size,
    products: products.length,
    qty: products.reduce((s, p) => s + p.qty, 0),
    removedQty: products.reduce((s, p) => s + p.removedQty, 0),
    value: r2(products.reduce((s, p) => s + p.value, 0))
  }
  return { products, reps, totals }
}
