import { supabase } from './supabase.js'
import { schemeText } from './productDiff.js'
import { calculateScheme } from './schemes.js'
import { PRICE_APPROVAL_ENABLED } from './featureFlags.js'

/**
 * Always fetch the CURRENT authenticated user id straight from Supabase at the
 * moment of saving. Never rely on a possibly-stale id held in React state —
 * that was causing visits/orders to be attributed to the previous rep after a
 * user switch. This is the source of truth.
 */
export async function currentUserId() {
  const { data } = await supabase.auth.getUser()
  return data?.user?.id ?? null
}

// ---------------------------------------------------------------------------
// Cloud sync helpers for Phase 3A.
// Privacy: only shop_name + route go to the cloud for customers — never the
// phone / GST / address, which stay in local IndexedDB on the device.
// ---------------------------------------------------------------------------

/** Ensure a cloud customer row exists for this shop; returns its cloud id. */
export async function ensureCloudCustomer(customer, userId, repCreated = false) {
  // Match on shop name + route first (the existing, widely-used identity key
  // in this app). If that fails, fall back to shop name ALONE before ever
  // creating a new row — a customer's route can now change permanently (see
  // updateCustomerDefaultRoute), and if the caller's local `customer.route`
  // is even briefly stale after such a change, a shop_name+route lookup can
  // legitimately miss the row that already has the new route. Without this
  // fallback, that miss would create a duplicate customer record instead of
  // finding and reusing the one that already exists — exactly what "each
  // customer can have only one active/default route" requires we prevent.
  const { data: existing } = await supabase
    .from('customers')
    .select('id')
    .eq('shop_name', customer.name)
    .eq('route', customer.route || '')
    .limit(1)
    .maybeSingle()

  if (existing?.id) return existing.id

  const { data: byNameOnly } = await supabase
    .from('customers')
    .select('id')
    .eq('shop_name', customer.name)
    .limit(2) // only need to know if there's 0, 1, or "more than 1"

  // Only trust this fallback when the shop name is UNAMBIGUOUS (exactly one
  // customer with this name, regardless of route) — if two different real
  // shops happen to share a name on different routes, guessing which one is
  // "the" match could wrongly merge them. In that ambiguous case, fall
  // through to the normal insert path exactly as before this fix.
  if (byNameOnly?.length === 1) return byNameOnly[0].id

  const { data, error } = await supabase
    .from('customers')
    .insert({
      shop_name: customer.name,
      route: customer.route || '',
      category: customer.category || '',
      ledger_category: customer.ledgerCategory || null,
      created_by: userId,
      is_rep_created: repCreated
    })
    .select('id')
    .single()
  if (error) {
    // If the is_rep_created column doesn't exist yet (older DB), retry without it
    // so the customer still saves to the cloud (name + route are what matter).
    if (String(error.message || '').toLowerCase().includes('is_rep_created')) {
      const retry = await supabase
        .from('customers')
        .insert({
          shop_name: customer.name,
          route: customer.route || '',
          category: customer.category || '',
          ledger_category: customer.ledgerCategory || null,
          created_by: userId
        })
        .select('id')
        .single()
      if (!retry.error) return retry.data.id
      console.error('cloud customer insert failed (retry)', retry.error)
      throw retry.error
    }
    console.error('cloud customer insert failed', error)
    throw error
  }
  return data.id
}

/** Save an order + its items. Returns the new order id (or null on failure). */
export async function saveCloudOrder({ customer, brand, userId, items, location, orderDate, route, isNewCustomer, introDetails }) {
  const cloudCustomerId = await ensureCloudCustomer(customer, userId)
  // Per-order route: use the chosen route if provided, else the customer default.
  // NOTE: this never overwrites the customer's default route in the DB.
  const orderRoute = (route != null && route !== '') ? route : (customer.route || '')

  const totalProducts = items.length
  const totalQuantity = items.reduce((s, i) => s + i.qty, 0)

  // ---- Duplicate guard --------------------------------------------------
  // If an identical order already exists TODAY for this shop (same products &
  // quantities), skip saving — this order is a double-submit. Any difference
  // (product added/removed or qty changed) makes it a legitimate new order.
  try {
    const startToday = new Date(); startToday.setHours(0, 0, 0, 0)
    const { data: todays } = await supabase
      .from('orders')
      .select('id, shop_name, created_at, order_items(product_name, qty)')
      .eq('sales_rep_id', userId)
      .eq('shop_name', customer.name)
      .gte('created_at', startToday.toISOString())
    const fingerprint = (list) =>
      (list || [])
        .map((r) => `${(r.product_name || r.name || '').trim().toUpperCase()}::${r.qty}`)
        .sort()
        .join('|')
    const mine = fingerprint(items)
    const isDup = (todays || []).some((o) => fingerprint(o.order_items) === mine)
    if (isDup) {
      console.log('Duplicate order detected — skipping save.')
      return null
    }
  } catch (e) {
    // If the check fails, fall through and save normally (never block a sale).
    console.error('duplicate check failed', e)
  }

  // Order value: sum of (Final Selling Price × qty). Final Selling Price is
  // whatever the rep manually edited (any price field), or Retail Price if
  // nothing was edited — computed once in OrderPage per the exact priority
  // rule, never re-derived here with a different (and wrong) priority.
  const totalValue = items.reduce((s, i) => {
    const price = i.finalSellingPrice != null ? i.finalSellingPrice : 0
    return s + price * (i.qty || 0)
  }, 0)

  const { data: order, error } = await supabase
    .from('orders')
    .insert({
      customer_id: cloudCustomerId,
      shop_name: customer.name,
      route: orderRoute,
      brand: brand || '',
      sales_rep_id: userId,
      total_products: totalProducts,
      total_quantity: totalQuantity,
      total_value: Math.round(totalValue),
      order_date: orderDate || new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }),
      latitude: location?.latitude ?? null,
      longitude: location?.longitude ?? null,
      // New-customer intro: stored ONLY on this order (never on the customer
      // record), and only when this genuinely is their first order — see
      // isIntroPending/clearIntro in AppContext, the existing "first order"
      // detection this reuses rather than duplicating.
      is_new_customer: !!isNewCustomer,
      intro_phone: isNewCustomer ? (introDetails?.phone || null) : null,
      intro_gstn: isNewCustomer ? (introDetails?.gstn || null) : null,
      intro_credit_days: isNewCustomer ? (introDetails?.creditDays || null) : null,
      intro_email: isNewCustomer ? (introDetails?.email || null) : null
    })
    .select('id')
    .single()

  if (error) {
    console.error('cloud order insert failed', error)
    return null
  }

  // Build the item rows. This is wrapped in try/catch because it runs AFTER
  // the orders row is already committed — if anything here throws (e.g. a
  // malformed item), we must NOT leave an orphan order with no items. Any
  // failure rolls back the order row and re-throws so the caller can tell the
  // rep the order did not save, instead of silently producing an empty order
  // that only surfaces later in Billing as "0 items".
  let rows
  try {
    rows = items.map((i) => {
    // Final Selling Price — see the exact priority rule computed once in
    // OrderPage: manually edited price (any field) wins; otherwise Retail
    // Price. Captured AT ORDER TIME so future product price/scheme changes
    // never rewrite what this order summary shows.
    const effectivePrice = i.finalSellingPrice != null ? i.finalSellingPrice : null
    // Special Price: only true when the Final Selling Price genuinely
    // differs from the product's Default Retail Price — never just because
    // a price field happens to be populated.
    const isSpecial = i.normalPrice != null && effectivePrice != null && effectivePrice !== i.normalPrice
    const schemeSnapshot = i.schemeEnabled === false ? null : schemeText(i)
    // The ACTUAL free quantity that applied to this order line, captured NOW
    // — never recomputed later from the product's current slabs, which can
    // change. Without this, an invoice generated after the product's scheme
    // changes (or the product is edited) would show the WRONG free quantity
    // for an old order. Respects the per-line Scheme Off toggle: off means
    // zero free units, exactly like every other scheme-aware calculation in
    // this app already does.
    const schemeResult = i.schemeEnabled === false ? { free: 0 } : calculateScheme(i.qty, i.slabs)
    return {
      order_id: order.id,
      product_name: i.name,
      qty: i.qty,
      unit: i.unit || 'Piece',
      is_addon: !!i.isAddon,
      unit_price: effectivePrice,
      scheme_applied: schemeSnapshot === 'No scheme' ? null : schemeSnapshot,
      normal_price: i.normalPrice ?? null,
      is_special_price: isSpecial,
      // Admin approval gate (spec: ANY deviation from MRP/RP/WP requires
      // sign-off; ONLY this line is held, the rest of the order is unaffected
      // and proceeds through Billing normally). Ordinary lines get null —
      // no workflow applies to them. Paused via PRICE_APPROVAL_ENABLED — see
      // utils/featureFlags.js for why and how to re-enable.
      approval_status: (PRICE_APPROVAL_ENABLED && isSpecial) ? 'pending' : null,
      scheme_enabled: i.schemeEnabled !== false,
      // Selected Price Type (WHOLESALE | RETAIL | MRP | CUSTOM) alongside the
      // Final Rate above (unit_price) — stored together so Billing/invoicing
      // never needs to re-derive which price type was actually charged.
      price_type: i.priceType || null,
      // Real free quantity for THIS order line, frozen at order time — the
      // invoice's FQTY column reads this directly, never recalculated later.
      free_qty: schemeResult.free || 0,
      // Billing snapshot — MRP/GST%/HSN as they were on the product when this
      // order was placed. Never re-derived from the live catalogue later, so
      // a subsequent price/GST update never rewrites an already-placed order's
      // bill (same reasoning as normal_price/scheme_applied above).
      mrp: i.mrp ?? null,
      gst_percent: i.gst ?? null,
      hsn: i.hsn ?? null,
      // Audit trail of what the rep actually typed before conversion to pieces
      // (spec: retain original entry). qty above is ALWAYS pieces; these two
      // record e.g. "3 Outer" that produced it. Null-safe for old callers.
      entered_qty: i.entered_qty ?? null,
      entered_unit: i.entered_unit ?? null
    }
    })
  } catch (buildErr) {
    // Building the item rows threw AFTER the order was committed. Roll back
    // the orphan order row so it can never appear in Billing with 0 items,
    // then re-throw so the caller shows the rep a real failure.
    console.error('cloud order_items build failed — rolling back order', buildErr)
    await supabase.from('orders').delete().eq('id', order.id)
    throw buildErr
  }

  const { error: itemsErr } = await supabase.from('order_items').insert(rows)
  if (itemsErr) {
    // The order row committed but its items did NOT. Previously this only
    // logged and returned order.id, so the rep saw success while Billing later
    // found an empty order. Instead: delete the orphan order row and throw, so
    // the order fails cleanly and the rep is prompted to retry.
    console.error('cloud order_items insert failed — rolling back order', itemsErr)
    await supabase.from('orders').delete().eq('id', order.id)
    throw new Error('order_items insert failed: ' + (itemsErr.message || 'unknown error'))
  }

  return order.id
}

/** Save a no-order visit. */
export async function saveCloudVisit({ customer, userId, visitStatus, remark, location }) {
  const cloudCustomerId = await ensureCloudCustomer(customer, userId)
  const { error } = await supabase.from('visits').insert({
    customer_id: cloudCustomerId,
    shop_name: customer.name,
    route: customer.route || '',
    sales_rep_id: userId,
    visit_status: visitStatus,
    custom_remark: remark || '',
    latitude: location?.latitude ?? null,
    longitude: location?.longitude ?? null
  })
  if (error) console.error('cloud visit insert failed', error)
}

/** Load a customer's previous orders (latest first) for the repeat-order loader. */
export async function loadPreviousOrders(shopName, route) {
  const { data, error } = await supabase
    .from('orders')
    .select('id, created_at, total_products, total_quantity, order_items(product_name, qty, unit)')
    .eq('shop_name', shopName)
    .eq('route', route || '')
    .eq('hidden', false)
    .order('created_at', { ascending: false })
    .limit(20)
  if (error) {
    console.error('load previous orders failed', error)
    return []
  }
  // Hide same-day identical duplicates: same day + same products & quantities
  // = a double-submit, show only the first (latest). Any difference is kept.
  const seen = new Set()
  const out = []
  for (const o of data || []) {
    const day = (o.created_at || '').slice(0, 10)
    const fp =
      day +
      '::' +
      (o.order_items || [])
        .map((r) => `${(r.product_name || '').trim().toUpperCase()}::${r.qty}`)
        .sort()
        .join('|')
    if (seen.has(fp)) continue
    seen.add(fp)
    out.push(o)
  }
  return out.slice(0, 10)
}

/**
 * Customer-specific "last sold price" map, for the price-consistency indicator
 * on product cards.
 *
 * Returns an object: { [PRODUCT_NAME_UPPERCASED]: lastUnitPrice } holding the
 * most-recent price this specific customer was charged for each product they've
 * bought before. Used only as a reference badge ("Last ₹705") — it never
 * changes the rep's price selection.
 *
 * Keyed by shop_name + route (the same identity key loadPreviousOrders uses),
 * so it works whether or not the customer has a cloud customer_id yet. Counts
 * ANY past order to this customer (admin choice), excluding hidden/deleted ones.
 * "Most recent" = latest order created_at; when a product appears in multiple
 * orders, the newest order's unit_price wins.
 */
export async function loadCustomerLastPrices(shopName, route) {
  if (!shopName) return {}
  const { data, error } = await supabase
    .from('orders')
    .select('created_at, order_items(product_name, unit_price)')
    .eq('shop_name', shopName)
    .eq('route', route || '')
    .eq('hidden', false)
    .order('created_at', { ascending: false })
    .limit(50)
  if (error) {
    console.error('load customer last prices failed', error)
    return {}
  }
  // Orders come newest-first. Walk them in that order and take the FIRST
  // (i.e. most recent) unit_price we see for each product; later/older orders
  // don't overwrite it. Skip rows with no usable price.
  const out = {}
  for (const o of data || []) {
    for (const it of o.order_items || []) {
      const key = (it.product_name || '').trim().toUpperCase()
      if (!key) continue
      if (out[key] != null) continue // already have a newer price for this product
      if (it.unit_price == null) continue
      out[key] = it.unit_price
    }
  }
  return out
}

/**
 * Personal performance counts for the logged-in rep.
 * Returns orders + visits totals for today / this week / this month.
 */
// ===========================================================================
// CANONICAL VISIT / ORDER-TAKEN CALCULATION — single source of truth.
//
// Business rule: a "visit" is a unique (sales_rep, customer, calendar_date)
// combination — it doesn't matter whether that visit resulted in an order or
// not, and it doesn't matter how many order rows or add-ons happened that
// day at that shop; it is still exactly ONE visit.
//
//   VISITS        = unique shop-days from ORDERS (hidden=false) UNION unique
//                    shop-days from no-order VISITS rows.
//   ORDERS TAKEN   = unique shop-days from ORDERS alone.
//
// Because "Orders Taken" is built from a subset of the same underlying keys
// that make up "Visits", `ordersTaken <= visits` holds by construction — not
// by clamping the result afterwards. Every screen (Sales Rep Performance,
// Admin Dashboard, Excel exports) MUST go through these two functions rather
// than counting raw rows, so numbers can never disagree across the app.
//
// Falls back to `${shop_name}::${route}` as the identity key on the rare
// row that's missing customer_id (older data), so nothing is silently
// dropped from the count.
// ===========================================================================

function visitKey(row) {
  // Convert to the IST calendar date, not the raw UTC date — an order placed
  // at 12:30 AM IST is UTC-previous-day, and naively slicing the ISO string
  // would silently group it under the wrong day.
  const day = istDateStr(row.created_at)
  const who = row.customer_id || `${(row.shop_name || '').trim().toUpperCase()}::${(row.route || '').trim().toUpperCase()}`
  return `${who}::${day}`
}

/** ISO timestamp -> 'YYYY-MM-DD' in Asia/Kolkata (IST, UTC+5:30). */
function istDateStr(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  // en-CA gives YYYY-MM-DD directly, formatted in the target timezone.
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
}

/** Unique shop-day keys from orders alone — this IS "Orders Taken". */
export function getUniqueOrderVisits(orders) {
  return new Set((orders || []).map(visitKey))
}

/** Unique shop-day keys from orders UNION no-order visits — this IS "Visits". */
export function getUniqueShopVisits(orders, noOrderVisits) {
  const keys = getUniqueOrderVisits(orders)
  for (const v of noOrderVisits || []) keys.add(visitKey(v))
  return keys
}

/**
 * Group order rows by shop-day (same canonical key as getUniqueOrderVisits),
 * and reduce each group to ONE consolidated entry: the LATEST row's
 * quantity/value (since a same-day repeat order re-submits the full item
 * list including everything already ordered — the latest row's totals are
 * already cumulative, not incremental), plus an isAddon flag when more than
 * one row exists in the group. This is the single source of truth for any
 * screen listing "orders" — dashboards, modals, Excel exports — so a shop
 * visited twice in one day for one add-on never appears as two entries or
 * has its value double-counted.
 */
export function consolidateOrdersByVisit(orders) {
  const groups = new Map()
  for (const o of orders || []) {
    const key = visitKey(o)
    const g = groups.get(key)
    if (!g || new Date(o.created_at) > new Date(g.created_at)) {
      groups.set(key, o)
    }
  }
  const addonCounts = new Map()
  for (const o of orders || []) {
    const key = visitKey(o)
    addonCounts.set(key, (addonCounts.get(key) || 0) + 1)
  }
  return Array.from(groups.entries()).map(([key, latest]) => ({
    ...latest,
    isAddon: (addonCounts.get(key) || 1) > 1,
    addonCount: (addonCounts.get(key) || 1) - 1
  }))
}

export async function loadMyPerformance(userId) {
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  // Week starts Monday.
  const dow = (now.getDay() + 6) % 7
  const startOfWeek = new Date(startOfToday)
  startOfWeek.setDate(startOfToday.getDate() - dow)
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)

  const [ordersRes, visitsRes, custRes] = await Promise.all([
    supabase
      .from('orders')
      .select('id, total_quantity, shop_name, route, customer_id, created_at')
      .eq('sales_rep_id', userId)
      .eq('hidden', false),
    supabase
      .from('visits')
      .select('id, shop_name, route, customer_id, created_at')
      .eq('sales_rep_id', userId),
    supabase
      .from('customers')
      .select('id, created_at')
      .eq('created_by', userId)
      .eq('is_rep_created', true)
  ])

  const orders = ordersRes.data || []
  const visits = visitsRes.data || []
  const customers = custRes.data || []

  const inRange = (iso, start) => new Date(iso) >= start

  const countOrders = (start) => {
    const inR = orders.filter((o) => inRange(o.created_at, start))
    return getUniqueOrderVisits(inR).size
  }
  const countQty = (start) => {
    const inR = orders.filter((o) => inRange(o.created_at, start))
    return consolidateOrdersByVisit(inR).reduce((s, o) => s + (o.total_quantity || 0), 0)
  }
  const countVisits = (start) => {
    const oInR = orders.filter((o) => inRange(o.created_at, start))
    const vInR = visits.filter((v) => inRange(v.created_at, start))
    return getUniqueShopVisits(oInR, vInR).size
  }
  const countNewCustomers = (start) =>
    customers.filter((c) => inRange(c.created_at, start)).length

  const block = (start) => ({
    orders: countOrders(start),
    quantity: countQty(start),
    visits: countVisits(start),
    // "shops" kept as an alias of the canonical visit count (unique shops
    // visited, order or not) — some older callers expect this field name.
    shops: countVisits(start),
    newCustomers: countNewCustomers(start)
  })

  return {
    today: block(startOfToday),
    week: block(startOfWeek),
    month: block(startOfMonth),
    totalOrders: getUniqueOrderVisits(orders).size,
    totalVisits: getUniqueShopVisits(orders, visits).size,
    totalNewCustomers: customers.length
  }
}

// ---------------------------------------------------------------------------
// ADMIN DASHBOARD queries (only usable by the admin account — RLS lets admin
// read all rows via the is_admin() policy from Phase 3A).
// ---------------------------------------------------------------------------

// Combined performance score. Tunable weights.
export const SCORE_WEIGHTS = { orders: 10, newShops: 15, visits: 2, qtyDivisor: 10 }

export function combinedScore({ orders, newShops, visits, quantity }) {
  const w = SCORE_WEIGHTS
  return Math.round(
    orders * w.orders + newShops * w.newShops + visits * w.visits + quantity / w.qtyDivisor
  )
}

/**
 * Pull everything the admin dashboard needs in a few queries, then aggregate
 * in JS. Returns per-rep stats for today/week/month + recent activity.
 */
// Supabase/PostgREST caps any single response at 1000 rows by default
// (server-side, regardless of a client .limit() above that) — this silently
// truncates instead of erroring, which is exactly what caused the Admin
// Dashboard to freeze at "1000 orders" even as more came in. This helper
// pages through in 1000-row chunks so callers always get the true full set,
// matching the pattern already used for fetchAllCloudProducts.
async function fetchAllPaged(table, selectCols, applyFilters, pageSize = 1000) {
  let from = 0
  let all = []
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let q = supabase.from(table).select(selectCols).range(from, from + pageSize - 1)
    if (applyFilters) q = applyFilters(q)
    const { data, error } = await q
    if (error) throw error
    all = all.concat(data || [])
    if (!data || data.length < pageSize) break
    from += pageSize
  }
  return all
}

export async function loadAdminDashboard() {
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const dow = (now.getDay() + 6) % 7
  const startOfWeek = new Date(startOfToday)
  startOfWeek.setDate(startOfToday.getDate() - dow)
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)

  const [profilesRes, orders, visits, customers, deliveries] = await Promise.all([
    supabase.from('profiles').select('id, full_name, role, route').eq('role', 'salesperson'),
    fetchAllPaged(
      'orders',
      'id, sales_rep_id, shop_name, customer_id, total_quantity, total_value, billing_status, created_at',
      (q) => q.eq('hidden', false).gte('created_at', startOfMonth.toISOString()).order('created_at', { ascending: false })
    ),
    fetchAllPaged(
      'visits',
      'id, sales_rep_id, shop_name, customer_id, created_at',
      (q) => q.gte('created_at', startOfMonth.toISOString()).order('created_at', { ascending: false })
    ),
    fetchAllPaged(
      'customers',
      'id, created_by, created_at, is_rep_created',
      (q) => q.gte('created_at', startOfMonth.toISOString()).order('created_at', { ascending: false })
    ),
    // Delivery-stage rows for this month, used to build the Order Status
    // pipeline (QC pending/in progress, ready for delivery, delivered).
    fetchAllPaged(
      'deliveries',
      'id, order_id, status, qc_status, created_at',
      (q) => q.gte('created_at', startOfMonth.toISOString()).neq('status', 'cancelled')
    )
  ])

  const profiles = profilesRes.data || []

  const inRange = (iso, start) => new Date(iso) >= start

  const statsFor = (repId, start) => {
    const o = orders.filter((x) => x.sales_rep_id === repId && inRange(x.created_at, start))
    const v = visits.filter((x) => x.sales_rep_id === repId && inRange(x.created_at, start))
    const ns = customers.filter(
      (c) => c.created_by === repId && c.is_rep_created && inRange(c.created_at, start)
    )
    const quantity = consolidateOrdersByVisit(o).reduce((s, x) => s + (x.total_quantity || 0), 0)
    // Canonical counts (see getUniqueShopVisits/getUniqueOrderVisits):
    // "orders" = unique shops that placed an order this period (not raw
    // order rows), "visits" = all unique shops visited, order or not.
    const orderVisitKeys = getUniqueOrderVisits(o)
    const allVisitKeys = getUniqueShopVisits(o, v)
    const ordersTaken = orderVisitKeys.size
    const totalVisits = allVisitKeys.size
    return {
      orders: ordersTaken,
      quantity,
      shops: totalVisits, // alias kept for existing consumers of `.shops`
      visits: totalVisits,
      newShops: ns.length,
      score: combinedScore({ orders: ordersTaken, newShops: ns.length, visits: totalVisits, quantity })
    }
  }

  const reps = profiles.map((p) => ({
    id: p.id,
    name: p.full_name || 'Unnamed',
    route: p.route || '',
    today: statsFor(p.id, startOfToday),
    week: statsFor(p.id, startOfWeek),
    month: statsFor(p.id, startOfMonth)
  }))

  // Team totals (this month)
  const teamMonth = reps.reduce(
    (acc, r) => ({
      orders: acc.orders + r.month.orders,
      quantity: acc.quantity + r.month.quantity,
      visits: acc.visits + r.month.visits,
      newShops: acc.newShops + r.month.newShops
    }),
    { orders: 0, quantity: 0, visits: 0, newShops: 0 }
  )
  // Revenue is computed from this month's orders using the same total_value
  // already stored per order — but consolidated PER REP first (visitKey does
  // not include sales_rep_id, so consolidating the combined multi-rep list
  // directly would incorrectly merge two different reps' same-day orders to
  // the same shop into one entry). Grouping by rep first keeps that safe.
  const ordersByRep = new Map()
  for (const o of orders) {
    if (!ordersByRep.has(o.sales_rep_id)) ordersByRep.set(o.sales_rep_id, [])
    ordersByRep.get(o.sales_rep_id).push(o)
  }
  const teamRevenue = Array.from(ordersByRep.values())
    .flatMap((repOrders) => consolidateOrdersByVisit(repOrders))
    .reduce((s, o) => s + (o.total_value || 0), 0)

  const teamToday = reps.reduce(
    (acc, r) => ({
      orders: acc.orders + r.today.orders,
      visits: acc.visits + r.today.visits
    }),
    { orders: 0, visits: 0 }
  )

  // Order Status pipeline — classify every order this month into exactly one
  // real stage, using data that already exists (billing_status on orders,
  // qc_status/status on its matching delivery row). No fabricated numbers.
  const deliveryByOrder = new Map(deliveries.map((d) => [d.order_id, d]))
  const orderStatus = { pendingBilling: 0, qcPending: 0, qcInProgress: 0, readyForDelivery: 0, delivered: 0 }
  for (const o of orders) {
    if (o.billing_status !== 'verified') {
      orderStatus.pendingBilling++
      continue
    }
    const d = deliveryByOrder.get(o.id)
    if (!d) {
      // Verified but no delivery record yet — effectively awaiting QC pickup.
      orderStatus.qcPending++
    } else if (d.status === 'delivered') {
      orderStatus.delivered++
    } else if (d.qc_status === 'qc_verified') {
      orderStatus.readyForDelivery++
    } else if (d.qc_status === 'qc_pending') {
      // Distinguish "not started" from "someone opened it" using status.
      orderStatus[d.status === 'in_progress' ? 'qcInProgress' : 'qcPending']++
    } else {
      orderStatus.qcInProgress++
    }
  }
  const orderStatusTotal = orders.length

  // Recent activity feed (last 15 orders + visits merged, newest first)
  const repName = (id) => profiles.find((p) => p.id === id)?.full_name || 'Unknown'
  const activity = [
    ...orders.map((o) => ({
      type: 'order',
      rep: repName(o.sales_rep_id),
      shop: o.shop_name,
      qty: o.total_quantity,
      at: o.created_at
    })),
    ...visits.map((v) => ({
      type: 'visit',
      rep: repName(v.sales_rep_id),
      shop: '',
      at: v.created_at
    }))
  ]
    .sort((a, b) => new Date(b.at) - new Date(a.at))
    .slice(0, 15)

  return { reps, teamMonth, teamToday, teamRevenue, orderStatus, orderStatusTotal, activity }
}

/**
 * Daily sales trend for the last N days (default 30): orders count + revenue
 * per calendar day. Uses order_date (already indexed) so the query stays
 * cheap regardless of catalogue size.
 */
/**
 * Daily sales trend for a custom date range: orders count + revenue per
 * calendar day. Uses order_date (already indexed) so the query stays cheap.
 * `from`/`to` are 'YYYY-MM-DD' strings, inclusive.
 */
export async function loadSalesTrend(from, to, route = null, salesRepId = null) {
  const start = new Date(`${from}T00:00:00`)
  const end = new Date(`${to}T00:00:00`)
  const dayCount = Math.max(1, Math.round((end - start) / 86400000) + 1)

  const data = await fetchAllPaged(
    'orders',
    'order_date, total_value',
    (q) => {
      q = q.eq('hidden', false).gte('order_date', from).lte('order_date', to)
      if (route) q = q.eq('route', route)
      if (salesRepId) q = q.eq('sales_rep_id', salesRepId)
      return q
    }
  )

  // Build one bucket per day in the window, even days with zero orders, so
  // the line chart has a continuous, evenly-spaced x-axis. Capped at a
  // sensible size so an accidentally huge range can't hang the browser.
  const cappedDays = Math.min(dayCount, 366)
  const byDay = new Map()
  for (let i = 0; i < cappedDays; i++) {
    const d = new Date(start)
    d.setDate(start.getDate() + i)
    const key = d.toISOString().slice(0, 10)
    byDay.set(key, { date: key, orders: 0, revenue: 0 })
  }
  for (const o of data || []) {
    const bucket = byDay.get(o.order_date)
    if (bucket) {
      bucket.orders += 1
      bucket.revenue += o.total_value || 0
    }
  }
  return Array.from(byDay.values())
}

/**
 * Every product sold in a custom date range, ranked two ways: by total
 * quantity sold, and by number of distinct orders containing it. Returns the
 * FULL list (not truncated) so the caller can show a compact top-N view with
 * the rest expandable — nothing is hidden.
 * `from`/`to` are 'YYYY-MM-DD' strings, inclusive.
 */
export async function loadTopProducts(from, to, route = null, salesRepId = null) {
  const orders = await fetchAllPaged(
    'orders',
    'id',
    (q) => {
      q = q.eq('hidden', false).gte('order_date', from).lte('order_date', to)
      if (route) q = q.eq('route', route)
      if (salesRepId) q = q.eq('sales_rep_id', salesRepId)
      return q
    }
  )
  const ids = orders.map((o) => o.id)
  if (ids.length === 0) return { byQty: [], byOrders: [], totalQty: 0, totalOrders: 0 }

  // Supabase/PostgREST .in() has a practical size limit — chunk the order ids
  // AND page each chunk's result (an order can have many line items, so even
  // 500 orders' worth of items could exceed the 1000-row response cap).
  const chunks = []
  for (let i = 0; i < ids.length; i += 500) chunks.push(ids.slice(i, i + 500))

  const qtyByProduct = new Map()
  const ordersByProduct = new Map() // product -> Set(order_id), for a true distinct-order count

  for (const chunk of chunks) {
    // eslint-disable-next-line no-await-in-loop
    const items = await fetchAllPaged(
      'order_items',
      'order_id, product_name, qty',
      (q) => q.in('order_id', chunk)
    )
    for (const it of items) {
      const key = it.product_name
      qtyByProduct.set(key, (qtyByProduct.get(key) || 0) + (it.qty || 0))
      if (!ordersByProduct.has(key)) ordersByProduct.set(key, new Set())
      ordersByProduct.get(key).add(it.order_id)
    }
  }

  const names = Array.from(qtyByProduct.keys())
  const totalQty = Array.from(qtyByProduct.values()).reduce((s, v) => s + v, 0)
  const totalOrders = ids.length

  const rows = names.map((name) => ({
    name,
    qty: qtyByProduct.get(name) || 0,
    orderCount: ordersByProduct.get(name)?.size || 0
  }))

  const byQty = [...rows].sort((a, b) => b.qty - a.qty)
  const byOrders = [...rows].sort((a, b) => b.orderCount - a.orderCount)

  return { byQty, byOrders, totalQty, totalOrders }
}

// ---------------------------------------------------------------------------
// PRODUCTS — cloud catalogue (admin-managed, rep-downloaded)
// ---------------------------------------------------------------------------

/** Read the catalogue meta (version + count). */
export async function getCatalogueMeta() {
  const { data, error } = await supabase
    .from('catalogue_meta')
    .select('*')
    .eq('id', 1)
    .maybeSingle()
  if (error) return null
  return data
}

/** Fetch ALL products from the cloud (paged to be safe over 1000). */
export async function fetchAllCloudProducts() {
  const pageSize = 1000
  let from = 0
  let all = []
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { data, error } = await supabase
      .from('products')
      .select('*')
      .order('sort_order', { ascending: true })
      .range(from, from + pageSize - 1)
    if (error) throw error
    all = all.concat(data || [])
    if (!data || data.length < pageSize) break
    from += pageSize
  }
  // Normalise back to the app's product shape.
  return all.map((p) => ({
    id: p.id,
    name: p.name,
    slabs: p.slabs || [],
    base: p.base,
    mrp: p.mrp,
    retail: p.retail,
    wholesale: p.wholesale,
    net: p.net || [],
    gst: p.gst,
    hsn: p.hsn,
    qty_in_box: p.qty_in_box ?? null,
    outer_qty: p.outer_qty ?? null,
    box: p.box ?? null
  }))
}

/**
 * REPLACE-ALL upload (admin only). Wipes the products table and inserts the
 * given list, then bumps the catalogue version so reps know to re-download.
 * Inserts in chunks to stay within request limits.
 */
export async function replaceAllCloudProducts(products, fileName) {
  // 1. delete everything
  const { error: delErr } = await supabase.from('products').delete().neq('id', '')
  if (delErr) throw delErr

  // 2. insert in chunks
  const rows = products.map((p, idx) => ({
    id: p.id || `p${idx}`,
    name: p.name,
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
    sort_order: idx
  }))
  const chunk = 500
  for (let i = 0; i < rows.length; i += chunk) {
    const { error } = await supabase.from('products').insert(rows.slice(i, i + chunk))
    if (error) throw error
  }

  // 3. bump version + record the uploaded file name and time
  const meta = await getCatalogueMeta()
  const nextVersion = (meta?.version || 0) + 1
  const { error: metaErr } = await supabase
    .from('catalogue_meta')
    .update({
      version: nextVersion,
      product_count: rows.length,
      file_name: fileName || null,
      uploaded_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
    .eq('id', 1)
  if (metaErr) throw metaErr

  return { count: rows.length, version: nextVersion }
}

/**
 * NON-DESTRUCTIVE MERGE upload (admin only).
 *
 * Unlike replaceAllCloudProducts (which wipes and re-inserts the whole table),
 * this matches the uploaded products against the EXISTING catalogue by name and
 * updates ONLY the fields the Excel provides a valid value for. It never
 * deletes a product, never blanks an existing value, and never invents data.
 *
 * Per-product rules (implementing the admin spec exactly):
 *  • Match key = product name, trimmed + upper-cased (same key used everywhere
 *    else in the app).
 *  • For each matched product, a field is updated ONLY when the Excel has a
 *    genuinely valid (non-null) value for it. A blank Excel cell leaves the
 *    existing value exactly as it was — it never overwrites with null.
 *  • Products in the Excel with NO valid data at all → skipped (untouched).
 *  • Products in the catalogue but NOT in the Excel → untouched.
 *  • Products in the Excel with NO name-match in the catalogue → ignored
 *    (reported back so the admin can review near-miss names). Never inserted.
 *  • GST%/HSN are applied even when a product still has no price — this is
 *    intentional (admin decision): it lets GST attach now, and the product
 *    simply keeps behaving as before until a price is also confirmed.
 *
 * Returns a summary: { updated, skippedNoData, unmatched:[names], version }.
 */
export async function mergeUpdateCloudProducts(uploadedList, fileName) {
  // 1. Fetch the current live catalogue (all pages).
  const existing = await fetchAllCloudProducts()
  const byKey = new Map()
  for (const p of existing) {
    byKey.set((p.name || '').trim().toUpperCase(), p)
  }

  // 2. Walk the uploaded list; build a targeted update for each match.
  const updates = []          // { id, patch }
  const unmatched = []        // Excel names with no catalogue match
  let skippedNoData = 0

  const hasVal = (v) => v !== null && v !== undefined && v !== ''

  for (const u of uploadedList) {
    const key = (u.name || '').trim().toUpperCase()
    if (!key) continue
    const target = byKey.get(key)
    if (!target) { unmatched.push(u.name); continue }

    // Only include fields the Excel actually provides. Never write a null over
    // an existing value.
    const patch = {}
    if (hasVal(u.mrp)) patch.mrp = u.mrp
    if (hasVal(u.retail)) patch.retail = u.retail
    if (hasVal(u.wholesale)) patch.wholesale = u.wholesale
    if (hasVal(u.base)) patch.base = u.base
    if (hasVal(u.gst)) patch.gst = u.gst
    if (hasVal(u.hsn)) patch.hsn = u.hsn
    // Packaging conversion master data (new). Merged like prices: only a valid
    // value overwrites; blanks are ignored so existing data is never wiped.
    if (hasVal(u.qty_in_box)) patch.qty_in_box = u.qty_in_box
    if (hasVal(u.outer_qty)) patch.outer_qty = u.outer_qty
    if (hasVal(u.box)) patch.box = u.box
    // Scheme slabs: only replace when the Excel genuinely carried scheme rows
    // for this product (non-empty). An empty slabs array means "no scheme info
    // in this file" — NOT "clear the existing scheme".
    if (Array.isArray(u.slabs) && u.slabs.length > 0) {
      patch.slabs = u.slabs
      if (Array.isArray(u.net) && u.net.length > 0) patch.net = u.net
    }

    if (Object.keys(patch).length === 0) { skippedNoData++; continue }
    updates.push({ id: target.id, patch })
  }

  // 3. Apply updates in BATCHES via upsert, instead of one round-trip per
  //    product (which made 800+ sequential network calls and took minutes).
  //    Each patch is merged onto the product's EXISTING full row first, so the
  //    upsert re-writes the same values for untouched columns and only the
  //    patched fields actually change — nothing is blanked. Chunked to stay
  //    within request limits; ~800 rows becomes a couple of calls, seconds not
  //    minutes.
  const byId = new Map(existing.map((p) => [p.id, p]))
  const fullRows = updates.map(({ id, patch }) => {
    const cur = byId.get(id) || {}
    return {
      id,
      name: cur.name,
      slabs: patch.slabs ?? cur.slabs ?? [],
      base: patch.base ?? cur.base ?? null,
      mrp: patch.mrp ?? cur.mrp ?? null,
      retail: patch.retail ?? cur.retail ?? null,
      wholesale: patch.wholesale ?? cur.wholesale ?? null,
      net: patch.net ?? cur.net ?? [],
      gst: patch.gst ?? cur.gst ?? null,
      hsn: patch.hsn ?? cur.hsn ?? null,
      qty_in_box: patch.qty_in_box ?? cur.qty_in_box ?? null,
      outer_qty: patch.outer_qty ?? cur.outer_qty ?? null,
      box: patch.box ?? cur.box ?? null,
      sort_order: cur.sort_order ?? null
    }
  })
  let updated = 0
  const CHUNK = 500
  for (let i = 0; i < fullRows.length; i += CHUNK) {
    const slice = fullRows.slice(i, i + CHUNK)
    const { error } = await supabase.from('products').upsert(slice, { onConflict: 'id' })
    if (error) {
      console.error('merge upsert batch failed', error)
      throw new Error('Merge failed while updating products: ' + (error.message || 'unknown'))
    }
    updated += slice.length
  }

  // 4. Bump catalogue version so reps re-download the enriched data.
  const meta = await getCatalogueMeta()
  const nextVersion = (meta?.version || 0) + 1
  const { error: metaErr } = await supabase
    .from('catalogue_meta')
    .update({
      version: nextVersion,
      file_name: fileName ? `${fileName} (merge)` : null,
      uploaded_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
    .eq('id', 1)
  if (metaErr) throw metaErr

  return { updated, skippedNoData, unmatched, version: nextVersion }
}

/** List all salespeople (admin only). */
export async function listSalespeople() {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, full_name, role, route')
    .eq('role', 'salesperson')
    .order('full_name', { ascending: true })
  if (error) throw error
  return data || []
}

/** Rename a salesperson's display name (admin only). */
export async function renameSalesperson(id, newName) {
  const { error } = await supabase
    .from('profiles')
    .update({ full_name: newName })
    .eq('id', id)
  if (error) throw error
}

// ---------------------------------------------------------------------------
// ANNOUNCEMENTS (in-app notifications)
// ---------------------------------------------------------------------------

/** Admin: send an announcement to all reps or a selected list. */
export async function sendAnnouncement({ title, body, highPriority, audience, repIds, expiresInDays, notifType }) {
  const uid = await currentUserId()
  // Optional auto-expiry: expires_at = now + N days. Omitted → never expires
  // (preserves the original behaviour for manual announcements).
  const expiresAt =
    expiresInDays != null
      ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString()
      : null
  const { data: ann, error } = await supabase
    .from('announcements')
    .insert({
      title,
      body: body || '',
      high_priority: !!highPriority,
      audience,
      created_by: uid,
      expires_at: expiresAt,
      notif_type: notifType || null
    })
    .select('id')
    .single()
  if (error) throw error

  // Determine recipient list.
  let targets = repIds
  if (audience === 'all') {
    const { data: reps, error: repErr } = await supabase
      .from('profiles')
      .select('id')
      .eq('role', 'salesperson')
    if (repErr) throw repErr
    targets = (reps || []).map((r) => r.id)
  }

  if (targets && targets.length) {
    const rows = targets.map((rid) => ({ announcement_id: ann.id, rep_id: rid }))
    const { error: rErr } = await supabase.from('announcement_recipients').insert(rows)
    if (rErr) throw rErr
  }
  return ann.id
}

/** Admin: list sent announcements (newest first) with recipient + read counts. */
export async function listSentAnnouncements() {
  const { data, error } = await supabase
    .from('announcements')
    .select('id, title, body, high_priority, audience, created_at, announcement_recipients(read_at)')
    .order('created_at', { ascending: false })
    .limit(50)
  if (error) throw error
  return (data || []).map((a) => {
    const rcpts = a.announcement_recipients || []
    return {
      id: a.id,
      title: a.title,
      body: a.body,
      highPriority: a.high_priority,
      audience: a.audience,
      createdAt: a.created_at,
      total: rcpts.length,
      read: rcpts.filter((r) => r.read_at).length
    }
  })
}

/** Rep: fetch my announcements (newest first) with my read status. */
export async function loadMyAnnouncements() {
  const uid = await currentUserId()
  const { data, error } = await supabase
    .from('announcement_recipients')
    .select('id, read_at, announcements(id, title, body, high_priority, created_at, expires_at)')
    .eq('rep_id', uid)
    .order('read_at', { ascending: true, nullsFirst: true })
  if (error) throw error
  const now = Date.now()
  const list = (data || [])
    .filter((r) => r.announcements)
    // Hide expired announcements (expires_at in the past). NULL = never expires.
    .filter((r) => !r.announcements.expires_at || new Date(r.announcements.expires_at).getTime() > now)
    .map((r) => ({
      recipientId: r.id,
      readAt: r.read_at,
      id: r.announcements.id,
      title: r.announcements.title,
      body: r.announcements.body,
      highPriority: r.announcements.high_priority,
      createdAt: r.announcements.created_at
    }))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
  return list
}

/** Rep: how many unread announcements (for the bell badge). */
export async function countUnreadAnnouncements() {
  const uid = await currentUserId()
  if (!uid) return 0
  // Join to announcements so we can exclude expired ones from the unread badge.
  const { data, error } = await supabase
    .from('announcement_recipients')
    .select('id, announcements(expires_at)')
    .eq('rep_id', uid)
    .is('read_at', null)
  if (error) return 0
  const now = Date.now()
  return (data || []).filter(
    (r) => r.announcements && (!r.announcements.expires_at || new Date(r.announcements.expires_at).getTime() > now)
  ).length
}

/** Rep: mark one announcement as read. */
export async function markAnnouncementRead(recipientId) {
  const { error } = await supabase
    .from('announcement_recipients')
    .update({ read_at: new Date().toISOString() })
    .eq('id', recipientId)
  if (error) console.error('mark read failed', error)
}

// ===========================================================================
// V4 DELIVERY MODULE — Phase 4A (foundation: admin view, staff, assignment)
// ===========================================================================

/** Delivery Admin: dashboard counts + all deliveries (optionally by route). */
export async function loadDeliveryAdmin(routeFilter, dateFilter) {
  const deliveries = await fetchAllPaged(
    'deliveries',
    'id, order_id, shop_name, route, sales_rep_name, assigned_to, assigned_at, status, qc_status, packed_by, created_at, cancel_reason, cancelled_by, cancelled_at',
    (q) => {
      // Historically, status='cancelled' was also used to hide soft-deleted
      // duplicate deliveries (no cancel_reason on those). We want the NEW
      // "Bill Cancelled" rows (which always have a cancel_reason) to stay
      // visible to Delivery Admin as a record, while still hiding the old
      // duplicate-cleanup rows exactly as before.
      q = q.or('status.neq.cancelled,cancel_reason.not.is.null').order('created_at', { ascending: false })
      if (routeFilter) q = q.eq('route', routeFilter)
      if (dateFilter) {
        // dateFilter is a 'YYYY-MM-DD' string — show only that day's deliveries.
        const start = new Date(`${dateFilter}T00:00:00`)
        const end = new Date(`${dateFilter}T23:59:59.999`)
        q = q.gte('created_at', start.toISOString()).lte('created_at', end.toISOString())
      }
      return q
    }
  )

  // Distinct routes for the filter dropdown.
  const routes = Array.from(new Set(deliveries.map((d) => d.route).filter(Boolean))).sort()

  // Group by shop+day and return IMMEDIATELY (no location fetch here, so the
  // dashboard shows fast). Distances are added separately via enrichWithDistance.
  const { groupDeliveriesByShopDay } = await import('./deliveryGroup.js')
  const grouped = groupDeliveriesByShopDay(deliveries)
  const counts = countByGroupStatus(grouped)
  return { deliveries: grouped, counts, routes }
}

/**
 * Enrich already-loaded grouped deliveries with shop locations + distance
 * sorting. Called AFTER the dashboard is shown, so the heavy location lookup
 * never blocks the initial render. Returns a new sorted array (or the input
 * unchanged on failure).
 */
export async function enrichWithDistance(grouped) {
  try {
    const names = [...new Set(grouped.map((d) => d.shop_name))]
    const locs = await fetchShopLocations(names)
    const { sortByHubDistance } = await import('./geo.js')
    const withLoc = grouped.map((d) => {
      const l = locs[(d.shop_name || '').toUpperCase()]
      return { ...d, latitude: l?.latitude ?? null, longitude: l?.longitude ?? null }
    })
    return sortByHubDistance(withLoc)
  } catch (e) {
    console.error('distance enrich failed', e)
    return grouped
  }
}

// Count grouped deliveries by their combined status (matches the cards shown).
function countByGroupStatus(groups) {
  return {
    total: groups.length,
    pending: groups.filter((d) => d.status === 'pending').length,
    assigned: groups.filter((d) => d.status === 'assigned').length,
    in_progress: groups.filter((d) => d.status === 'in_progress').length,
    delivered: groups.filter((d) => d.status === 'delivered').length,
    partial: groups.filter((d) => d.status === 'partial').length,
    failed: groups.filter((d) => d.status === 'failed').length,
    cancelled: groups.filter((d) => d.status === 'cancelled').length
  }
}

/** List delivery staff (reps). */
export async function listDeliveryStaff() {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, full_name, mobile, assigned_routes, active, role')
    .eq('role', 'delivery_rep')
    .order('full_name', { ascending: true })
  if (error) throw error
  return data || []
}

/** Edit delivery staff details (name, mobile, routes, active). */
export async function updateDeliveryStaff(id, patch) {
  const { error } = await supabase.from('profiles').update(patch).eq('id', id)
  if (error) throw error
}

/** Assign a delivery to a staff member. */
export async function assignDelivery(deliveryId, staffId) {
  const { error } = await supabase
    .from('deliveries')
    .update({
      assigned_to: staffId,
      assigned_at: new Date().toISOString(),
      status: 'assigned',
      updated_at: new Date().toISOString()
    })
    .eq('id', deliveryId)
  if (error) throw error
}

// ===========================================================================
// V4 DELIVERY — Phase 4B (rep execution: checklist + completion)
// ===========================================================================

/**
 * Load a delivery's products for the checklist. Seeds delivery_items from the
 * order's order_items on first open (so the rep sees exactly what to deliver).
 */
export async function loadDeliveryDetail(delivery) {
  // Already seeded?
  const { data: existing, error: exErr } = await supabase
    .from('delivery_items')
    .select('*')
    .eq('delivery_id', delivery.id)
    .order('created_at', { ascending: true })
  if (exErr) throw exErr

  if (existing && existing.length) return existing

  // Seed from the order's items (exclude products billing removed).
  const { data: orderItems, error: oiErr } = await supabase
    .from('order_items')
    .select('product_name, qty, unit, removed')
    .eq('order_id', delivery.order_id)
  if (oiErr) throw oiErr

  const rows = (orderItems || [])
    .filter((oi) => !oi.removed)
    .map((oi) => ({
      delivery_id: delivery.id,
      product_name: oi.product_name,
      ordered_qty: oi.qty,
      unit: oi.unit || 'Piece',
      delivered: false,
      delivered_qty: null,
      reason: ''
    }))
  if (rows.length) {
    const { data: inserted, error: insErr } = await supabase
      .from('delivery_items')
      .insert(rows)
      .select('*')
    if (insErr) throw insErr
    return inserted
  }
  return []
}

/** Save the checklist state for one delivery item. */
export async function saveDeliveryItem(itemId, patch) {
  const { error } = await supabase.from('delivery_items').update(patch).eq('id', itemId)
  if (error) throw error
}

/**
 * Complete a delivery. Determines overall status from the items:
 *  - all delivered → 'delivered'
 *  - none delivered → 'failed'
 *  - some → 'partial'
 */
export async function completeDelivery({ deliveryId, items, note, location }) {
  const anyDelivered = items.some((i) => i.delivered)
  const allDelivered = items.every((i) => i.delivered)
  const status = allDelivered ? 'delivered' : anyDelivered ? 'partial' : 'failed'

  const { error } = await supabase
    .from('deliveries')
    .update({
      status,
      completion_note: note || '',
      completed_at: new Date().toISOString(),
      latitude: location?.latitude ?? null,
      longitude: location?.longitude ?? null,
      updated_at: new Date().toISOString()
    })
    .eq('id', deliveryId)
  if (error) throw error
  return status
}

/** Mark a delivery as in-progress (rep opened/started it). */
export async function startDelivery(deliveryId) {
  await supabase
    .from('deliveries')
    .update({ status: 'in_progress', updated_at: new Date().toISOString() })
    .eq('id', deliveryId)
    .eq('status', 'assigned') // only bump from assigned
}

/**
 * Fetch all shared customers from the cloud (shop name + route + category).
 * Reps download these so new shops created by any rep are visible to everyone.
 * PII (phone/GST/address) is NOT in the cloud, so downloaded shops have only
 * the shared fields; locally-created ones keep their full details on-device.
 */
export async function fetchAllCloudCustomers() {
  const pageSize = 1000
  let from = 0
  let all = []
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { data, error } = await supabase
      .from('customers')
      .select('id, shop_name, route, category, ledger_category, created_at')
      .order('created_at', { ascending: false })
      .range(from, from + pageSize - 1)
    if (error) throw error
    all = all.concat(data || [])
    if (!data || data.length < pageSize) break
    from += pageSize
  }
  return all
}

/**
 * Bulk-assign all UNASSIGNED deliveries on a given route to one staff member.
 * Only affects pending/unassigned orders — already-assigned ones are left as-is
 * so the admin's individual choices aren't overwritten.
 */
export async function bulkAssignRoute(route, staffId) {
  const { data, error } = await supabase
    .from('deliveries')
    .update({
      assigned_to: staffId,
      assigned_at: new Date().toISOString(),
      status: 'assigned',
      updated_at: new Date().toISOString()
    })
    .eq('route', route)
    .is('assigned_to', null)
    .select('id')
  if (error) throw error
  return data ? data.length : 0
}

// ===========================================================================
// V4 DELIVERY — Phase 4C part 2: shop location (verified via delivery)
// ===========================================================================

/**
 * Save the delivered GPS location to the shop's customer master record.
 * ALWAYS overwrites with the latest (one location per shop). Matches the
 * customer by the delivery's shop_name + route (that's what the cloud stores).
 */
export async function saveShopLocation({ shopName, route, latitude, longitude }) {
  if (latitude == null || longitude == null) return
  // Find the customer row by shop name (+ route if available).
  let q = supabase.from('customers').select('id, first_verified_date').ilike('shop_name', shopName)
  if (route) q = q.eq('route', route)
  const { data: matches, error } = await q.limit(1)
  if (error) {
    console.error('shop location lookup failed', error)
    return
  }
  const now = new Date().toISOString()
  if (matches && matches.length) {
    const c = matches[0]
    const patch = {
      shop_latitude: latitude,
      shop_longitude: longitude,
      location_verified: true,
      last_delivery_date: now
    }
    if (!c.first_verified_date) patch.first_verified_date = now
    const { error: upErr } = await supabase.from('customers').update(patch).eq('id', c.id)
    if (upErr) console.error('shop location update failed', upErr)
  }
}

/** Fetch verified locations for a set of shop names (for admin distance view). */
export async function fetchShopLocations(shopNames) {
  if (!shopNames || !shopNames.length) return {}
  const { data, error } = await supabase
    .from('customers')
    .select('shop_name, route, shop_latitude, shop_longitude, location_verified')
    .in('shop_name', shopNames)
  if (error) return {}
  const map = {}
  ;(data || []).forEach((c) => {
    map[(c.shop_name || '').toUpperCase()] = {
      latitude: c.shop_latitude,
      longitude: c.shop_longitude,
      verified: c.location_verified
    }
  })
  return map
}

// ===========================================================================
// V4 DELIVERY — Shop+Day GROUP detail & completion (Approach 1)
// A "group" bundles all deliveries for one shop on one day.
// ===========================================================================

/**
 * Load combined items for a shop-day group. Seeds delivery_items for each
 * underlying delivery from its order (if not already seeded), then merges items
 * across all the group's deliveries. Same product across orders is combined by
 * summing ordered_qty (keeps one checklist line per product).
 */
export async function loadGroupDetail(group) {
  const allItems = []
  for (const deliveryId of group.deliveryIds) {
    // Seeded already?
    const { data: existing } = await supabase
      .from('delivery_items')
      .select('*')
      .eq('delivery_id', deliveryId)
      .order('created_at', { ascending: true })
    if (existing && existing.length) {
      allItems.push(...existing)
      continue
    }
    // Seed from the matching order. Find the order_id for this delivery.
    const { data: delRow } = await supabase
      .from('deliveries')
      .select('order_id')
      .eq('id', deliveryId)
      .maybeSingle()
    const orderId = delRow?.order_id
    if (!orderId) continue
    const { data: orderItems } = await supabase
      .from('order_items')
      .select('product_name, qty, unit, removed')
      .eq('order_id', orderId)
    const rows = (orderItems || [])
      .filter((oi) => !oi.removed)
      .map((oi) => ({
        delivery_id: deliveryId,
        product_name: oi.product_name,
        ordered_qty: oi.qty,
        unit: oi.unit || 'Piece',
        delivered: false,
        delivered_qty: null,
        reason: ''
      }))
    if (rows.length) {
      const { data: inserted } = await supabase.from('delivery_items').insert(rows).select('*')
      if (inserted) allItems.push(...inserted)
    }
  }

  // Merge duplicate products (same name) into ONE line with summed quantity.
  // Keep the list of underlying item ids so ticking the merged line updates all.
  const merged = new Map()
  const order = []
  for (const it of allItems) {
    const key = (it.product_name || '').trim().toUpperCase()
    let m = merged.get(key)
    if (!m) {
      m = {
        ...it,
        ordered_qty: it.ordered_qty || 0,
        itemIds: [it.id],
        // 'delivered' is true only if ALL underlying rows are delivered.
        delivered: !!it.delivered
      }
      merged.set(key, m)
      order.push(m)
    } else {
      m.ordered_qty += it.ordered_qty || 0
      m.itemIds.push(it.id)
      m.delivered = m.delivered && !!it.delivered
      // Keep a reason if any underlying row has one.
      if (!m.reason && it.reason) m.reason = it.reason
    }
  }
  return order
}

/** Mark all deliveries in a group as in-progress. */
export async function startGroup(group) {
  await supabase
    .from('deliveries')
    .update({ status: 'in_progress', updated_at: new Date().toISOString() })
    .in('id', group.deliveryIds)
    .eq('status', 'assigned')
}

/**
 * Complete a whole shop-day group: set the combined status on ALL its
 * deliveries, stamp completion note + location. Returns the status.
 */
export async function completeGroup({ group, items, note, location }) {
  const anyDelivered = items.some((i) => i.delivered)
  const allDelivered = items.every((i) => i.delivered)
  const status = allDelivered ? 'delivered' : anyDelivered ? 'partial' : 'failed'

  const { error } = await supabase
    .from('deliveries')
    .update({
      status,
      completion_note: note || '',
      completed_at: new Date().toISOString(),
      latitude: location?.latitude ?? null,
      longitude: location?.longitude ?? null,
      updated_at: new Date().toISOString()
    })
    .in('id', group.deliveryIds)
  if (error) throw error
  return status
}

/** Assign all deliveries in a group to a staff member. */
export async function assignGroup(group, staffId) {
  const { error } = await supabase
    .from('deliveries')
    .update({
      assigned_to: staffId,
      assigned_at: new Date().toISOString(),
      status: 'assigned',
      updated_at: new Date().toISOString()
    })
    .in('id', group.deliveryIds)
  if (error) throw error
}

// ===========================================================================
// V4 DELIVERY — Part 2: Punch In / Out (attendance)
// ===========================================================================

/** Current open punch (punched in, not yet out) for this rep, if any. */
export async function getOpenPunch() {
  const uid = await currentUserId()
  if (!uid) return null
  const { data, error } = await supabase
    .from('delivery_punches')
    .select('*')
    .eq('rep_id', uid)
    .is('punch_out', null)
    .order('punch_in', { ascending: false })
    .limit(1)
  if (error) return null
  return data && data.length ? data[0] : null
}

/** Punch in with the person's name. Returns the new punch row. */
export async function punchIn(personName) {
  const uid = await currentUserId()
  const { data, error } = await supabase
    .from('delivery_punches')
    .insert({ rep_id: uid, person_name: personName, punch_in: new Date().toISOString() })
    .select('*')
    .single()
  if (error) throw error
  return data
}

/** Punch out an open punch. */
export async function punchOut(punchId) {
  const { error } = await supabase
    .from('delivery_punches')
    .update({ punch_out: new Date().toISOString() })
    .eq('id', punchId)
  if (error) throw error
}

/** Admin: list punches (optionally for a specific date YYYY-MM-DD). */
export async function listPunches(dateFilter) {
  let q = supabase
    .from('delivery_punches')
    .select('id, rep_id, person_name, punch_in, punch_out')
    .order('punch_in', { ascending: false })
    .limit(200)
  if (dateFilter) {
    const start = new Date(`${dateFilter}T00:00:00`).toISOString()
    const end = new Date(`${dateFilter}T23:59:59.999`).toISOString()
    q = q.gte('punch_in', start).lte('punch_in', end)
  }
  const { data, error } = await q
  if (error) throw error
  // Attach the vehicle/login name.
  const repIds = [...new Set((data || []).map((p) => p.rep_id).filter(Boolean))]
  let repNames = {}
  if (repIds.length) {
    const { data: profs } = await supabase
      .from('profiles')
      .select('id, full_name')
      .in('id', repIds)
    ;(profs || []).forEach((p) => (repNames[p.id] = p.full_name))
  }
  return (data || []).map((p) => ({
    ...p,
    vehicle: repNames[p.rep_id] || '—'
  }))
}

// ===========================================================================
// V4 — Performance reports (Excel export data)
// ===========================================================================

function rangeBounds(from, to) {
  const start = from ? new Date(`${from}T00:00:00`).toISOString() : null
  const end = to ? new Date(`${to}T23:59:59.999`).toISOString() : null
  return { start, end }
}

/**
 * Sales performance per rep for a date range. Returns
 * { reps: [{ name, orders, quantity, value, newShops, visits }] }.
 * Order value is computed from stored order totals when available.
 */
export async function buildSalesReport(from, to) {
  const { start, end } = rangeBounds(from, to)
  const withRange = (q, col = 'created_at') => {
    if (start) q = q.gte(col, start)
    if (end) q = q.lte(col, end)
    return q
  }

  const [profilesRes, orders, visits, customers] = await Promise.all([
    supabase.from('profiles').select('id, full_name').eq('role', 'salesperson'),
    fetchAllPaged('orders', 'id, sales_rep_id, shop_name, route, customer_id, total_quantity, total_value, created_at', (q) => withRange(q.eq('hidden', false))),
    fetchAllPaged('visits', 'id, sales_rep_id, shop_name, route, customer_id, created_at', (q) => withRange(q)),
    fetchAllPaged('customers', 'id, created_by, is_rep_created, created_at', (q) => withRange(q))
  ])

  const profiles = profilesRes.data || []

  // This report MUST agree with the Sales Rep Performance Dashboard and the
  // Admin Dashboard for the same rep/period — all three go through the same
  // canonical getUniqueOrderVisits/getUniqueShopVisits functions, so numbers
  // can never disagree between the screen and the exported Excel file.
  const reps = profiles.map((p) => {
    const o = orders.filter((x) => x.sales_rep_id === p.id)
    const v = visits.filter((x) => x.sales_rep_id === p.id)
    const ns = customers.filter((c) => c.created_by === p.id && c.is_rep_created)
    const ordersTaken = getUniqueOrderVisits(o).size
    const totalVisits = getUniqueShopVisits(o, v).size
    // Validation per spec §14: Visits must never be less than Orders Taken —
    // this holds by construction here, but assert it explicitly so a future
    // change to the key logic can't silently reintroduce the bug.
    if (totalVisits < ordersTaken) {
      console.error(`Sales report invariant violated for ${p.full_name}: visits(${totalVisits}) < orders(${ordersTaken})`)
    }
    return {
      Salesperson: p.full_name || 'Unnamed',
      Orders: ordersTaken,
      Quantity: consolidateOrdersByVisit(o).reduce((s, x) => s + (x.total_quantity || 0), 0),
      'Order Value (Rs)': consolidateOrdersByVisit(o).reduce((s, x) => s + (x.total_value || 0), 0),
      'New Shops': ns.length,
      Visits: totalVisits
    }
  })
  return reps
}

/**
 * Delivery performance per staff for a date range. Returns rows with
 * deliveries done / partial / failed and working hours (from punches).
 */
export async function buildDeliveryReport(from, to) {
  const { start, end } = rangeBounds(from, to)
  const withRange = (q, col) => {
    if (start) q = q.gte(col, start)
    if (end) q = q.lte(col, end)
    return q
  }

  const [staffRes, delsRaw, punches] = await Promise.all([
    supabase.from('profiles').select('id, full_name').eq('role', 'delivery_rep'),
    fetchAllPaged(
      'deliveries', 'id, assigned_to, status, completed_at',
      (q) => withRange(q.neq('status', 'cancelled'), 'completed_at')
    ),
    fetchAllPaged(
      'delivery_punches', 'rep_id, person_name, punch_in, punch_out',
      (q) => withRange(q, 'punch_in')
    )
  ])

  const staff = staffRes.data || []
  const dels = delsRaw.filter((d) => d.completed_at) // only completed in range

  const rows = staff.map((s) => {
    const mine = dels.filter((d) => d.assigned_to === s.id)
    const done = mine.filter((d) => d.status === 'delivered').length
    const partial = mine.filter((d) => d.status === 'partial').length
    const failed = mine.filter((d) => d.status === 'failed').length
    // Sum working minutes from completed punches.
    const myPunches = punches.filter((p) => p.rep_id === s.id && p.punch_out)
    const mins = myPunches.reduce(
      (sum, p) => sum + Math.max(0, Math.round((new Date(p.punch_out) - new Date(p.punch_in)) / 60000)),
      0
    )
    const hours = Math.floor(mins / 60)
    const rem = mins % 60
    return {
      'Delivery Staff': s.full_name || 'Unnamed',
      'Deliveries Done': done,
      Partial: partial,
      Failed: failed,
      'Working Hours': `${hours}h ${rem}m`
    }
  })
  return rows
}

// ===========================================================================
// V4 DELIVERY — Part 5: lightweight driver tracking (last-known location)
// ===========================================================================

/**
 * Update the current delivery rep's last-known location. Called on delivery
 * completion and app open. Silent no-op if not logged in or no coords.
 */
export async function pingDriverLocation(latitude, longitude) {
  if (latitude == null || longitude == null) return
  const uid = await currentUserId()
  if (!uid) return
  const { error } = await supabase
    .from('profiles')
    .update({
      last_latitude: latitude,
      last_longitude: longitude,
      last_seen_at: new Date().toISOString()
    })
    .eq('id', uid)
  if (error) console.error('driver location ping failed', error)
}

/**
 * Admin: driver tracking overview. For each delivery rep, returns their
 * last-known location/time and today's progress (delivered / total assigned).
 */
export async function loadDriverTracking() {
  const staffRes = await supabase
    .from('profiles')
    .select('id, full_name, active, last_latitude, last_longitude, last_seen_at')
    .eq('role', 'delivery_rep')
  const staff = staffRes.data || []

  // Today's deliveries per driver.
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  const delRes = await supabase
    .from('deliveries')
    .select('assigned_to, status, created_at')
    .gte('created_at', start.toISOString())
  const dels = delRes.data || []

  return staff.map((s) => {
    const mine = dels.filter((d) => d.assigned_to === s.id)
    const done = mine.filter((d) => d.status === 'delivered' || d.status === 'partial' || d.status === 'failed').length
    return {
      id: s.id,
      name: s.full_name || 'Unnamed',
      active: s.active,
      latitude: s.last_latitude,
      longitude: s.last_longitude,
      lastSeen: s.last_seen_at,
      total: mine.length,
      done
    }
  })
}

/** Unassign all deliveries in a group (set back to pending, no driver). */
export async function unassignGroup(group) {
  const { error } = await supabase
    .from('deliveries')
    .update({
      assigned_to: null,
      assigned_at: null,
      status: 'pending',
      updated_at: new Date().toISOString()
    })
    .in('id', group.deliveryIds)
  if (error) throw error
}

// ===========================================================================
// V4 BILLING MODULE — Phase 1
// ===========================================================================

/**
 * Billing dashboard: sales reps with their pending-order counts (+ verified
 * today). Reps with zero pending are still shown if they have any orders today.
 */
export async function loadBillingReps() {
  const startToday = new Date()
  startToday.setHours(0, 0, 0, 0)

  const [repsRes, pendingRes, verifiedRes] = await Promise.all([
    supabase.from('profiles').select('id, full_name').eq('role', 'salesperson'),
    supabase.from('orders').select('sales_rep_id').eq('billing_status', 'pending').eq('hidden', false),
    supabase
      .from('orders')
      .select('sales_rep_id')
      .eq('billing_status', 'verified')
      .eq('hidden', false)
      .gte('billing_verified_at', startToday.toISOString())
  ])

  const reps = repsRes.data || []
  const pending = pendingRes.data || []
  const verified = verifiedRes.data || []

  const countBy = (rows, id) => rows.filter((r) => r.sales_rep_id === id).length

  return reps
    .map((r) => ({
      id: r.id,
      name: r.full_name || 'Unnamed',
      pending: countBy(pending, r.id),
      verifiedToday: countBy(verified, r.id)
    }))
    .filter((r) => r.pending > 0 || r.verifiedToday > 0)
    .sort((a, b) => b.pending - a.pending)
}

/** Pending orders for one rep (filtered by delivery type, date, express route). */
/**
 * Billing's order list for a rep. Each shop-day "card" can bundle more than
 * one order row (an add-on = a second, later order to the same shop the same
 * day). Each order in a group keeps its OWN independent billing_status —
 * verifying the original never verifies the add-on, and vice versa. `orders`
 * on each group is sorted oldest→newest so `orders[0]` is unambiguously the
 * ORIGINAL and any entries after it are ADD-ONS, in the order they occurred.
 */
export async function loadBillingOrders(repId, deliveryType, status = 'pending', dateStr = null, expressRoute = null) {
  // NOTE: we intentionally do NOT filter by billing_status here anymore —
  // each group needs to see every order's status to classify correctly (a
  // group can have its original Verified while its add-on is Pending, or the
  // reverse). Filtering happens after grouping, based on the tab selected.
  const data = await fetchAllPaged(
    'orders',
    'id, shop_name, route, total_quantity, total_value, created_at, order_date, sales_rep_id, billing_status, billing_verified_at, is_new_customer, intro_phone, intro_gstn, intro_credit_days, intro_email, brand',
    (q) => {
      q = q.eq('sales_rep_id', repId).eq('hidden', false).order('created_at', { ascending: true }) // oldest first
      if (dateStr) q = q.eq('order_date', dateStr)
      return q
    }
  )
  let rows = data || []
  if (deliveryType === 'EXP') rows = rows.filter((o) => (o.route || '').toUpperCase().startsWith('EXP'))
  if (deliveryType === 'STD') rows = rows.filter((o) => (o.route || '').toUpperCase().startsWith('STD'))
  if (expressRoute) {
    const want = expressRoute.toUpperCase().replace(/\s+/g, '')
    rows = rows.filter((o) => (o.route || '').toUpperCase().replace(/\s+/g, '').includes(want))
  }

  // Group into one card per shop per day. `orders` is oldest→newest, so
  // orders[0] = ORIGINAL, orders[1..] = ADD-ONS in the order they happened.
  const groups = new Map()
  const order = []
  for (const o of rows) {
    const day = o.order_date || (o.created_at || '').slice(0, 10)
    const key = `${(o.shop_name || '').toUpperCase()}__${day}`
    let g = groups.get(key)
    if (!g) {
      g = {
        id: o.id,
        orderIds: [o.id],
        orders: [o], // oldest → newest; orders[0] is the ORIGINAL
        shop_name: o.shop_name,
        route: o.route,
        brand: o.brand,
        created_at: o.created_at,
        orderCount: 1
      }
      groups.set(key, g)
      order.push(g)
    } else {
      g.orderIds.push(o.id)
      g.orders.push(o)
      g.orderCount += 1
      g.created_at = o.created_at // keep the latest timestamp for display/sort
    }
  }

  // Derive each group's classification for filtering:
  //   original      = orders[0]
  //   addons        = orders[1..]  (each independently pending/verified)
  //   hasAddon      = orderCount > 1
  //   addonPending  = any add-on still billing_status='pending'
  for (const g of order) {
    g.original = g.orders[0]
    g.addons = g.orders.slice(1)
    g.hasAddon = g.orderCount > 1
    g.addonPending = g.addons.some((a) => a.billing_status === 'pending')
    g.addonAllVerified = g.hasAddon && g.addons.every((a) => a.billing_status === 'verified')
  }

  // Apply the requested status/tab filter AFTER classification.
  let filtered = order
  if (status === 'addons') {
    // Add-ons tab: groups that have at least one add-on still pending.
    filtered = order.filter((g) => g.hasAddon && g.addonPending)
  } else if (status === 'pending') {
    // Existing Pending tab: unchanged meaning — the ORIGINAL order is
    // pending. (An add-on's own pending state is tracked separately, in the
    // new Add-ons tab, per the "don't change Express/Standard" requirement.)
    filtered = order.filter((g) => g.original.billing_status === 'pending')
  } else if (status === 'verified') {
    // Preserves the existing behaviour: with no explicit date chosen, the
    // Verified tab defaults to today's verifications only (not all-time).
    const startToday = new Date(); startToday.setHours(0, 0, 0, 0)
    filtered = order.filter((g) => {
      if (g.original.billing_status !== 'verified') return false
      if (dateStr) return true // an explicit date was chosen — show all verified that day
      return g.original.billing_verified_at && new Date(g.original.billing_verified_at) >= startToday
    })
  }

  return filtered.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
}

/**
 * Count-only summary for the four Billing filter badges (All / Express /
 * Standard / Add-ons), for a rep + date. Mirrors loadBillingOrders' grouping
 * and classification exactly, so badge counts always match what the tabs
 * actually show — computed from ONE shared fetch to avoid drift between the
 * counts and the lists.
 */
export async function loadBillingCounts(repId, dateStr = null) {
  const data = await fetchAllPaged(
    'orders',
    'id, shop_name, route, order_date, created_at, billing_status',
    (q) => {
      q = q.eq('sales_rep_id', repId).eq('hidden', false)
      if (dateStr) q = q.eq('order_date', dateStr)
      return q
    }
  )
  const rows = (data || []).sort((a, b) => new Date(a.created_at) - new Date(b.created_at))

  const groups = new Map()
  for (const o of rows) {
    const day = o.order_date || (o.created_at || '').slice(0, 10)
    const key = `${(o.shop_name || '').toUpperCase()}__${day}`
    let g = groups.get(key)
    if (!g) { g = { orders: [o], route: o.route }; groups.set(key, g) }
    else g.orders.push(o)
  }

  let all = 0, express = 0, standard = 0, addons = 0
  for (const g of groups.values()) {
    const original = g.orders[0]
    const rest = g.orders.slice(1)
    const isExpress = (g.route || '').toUpperCase().startsWith('EXP')
    const isStandard = (g.route || '').toUpperCase().startsWith('STD')
    const originalPending = original.billing_status === 'pending'
    const addonPending = rest.some((a) => a.billing_status === 'pending')

    // "All" = distinct verification WORK ITEMS still pending: the original
    // (if pending) counts once, and — if it has a pending add-on — that adds
    // ONE more (not one per add-on order row), matching "do not simply add
    // all counts together" / "avoid double counting" from the spec.
    if (originalPending) all++
    if (addonPending) all++

    if (originalPending) {
      if (isExpress) express++
      if (isStandard) standard++
    }
    if (addonPending) addons++
  }

  return { all, express, standard, addons }
}

/** Full item list for one order (for the billing detail view). */
export async function loadBillingOrderItems(orderId) {
  const { data, error } = await supabase
    .from('order_items')
    .select('id, product_name, qty, unit')
    .eq('order_id', orderId)
  if (error) throw error
  return data || []
}

/** Verify an order (or all orders in a shop-day group) → creates deliveries. */
export async function verifyOrder(orderIdOrIds, notes) {
  const ids = Array.isArray(orderIdOrIds) ? orderIdOrIds : [orderIdOrIds]
  for (const id of ids) {
    // eslint-disable-next-line no-await-in-loop
    const { error } = await supabase.rpc('verify_order_to_delivery', {
      p_order_id: id,
      p_notes: notes || null
    })
    if (error) throw error

    // Confirmed sale -> deduct stock atomically for this order's items.
    // Idempotent (per-order marker) and non-blocking: a deduction hiccup must
    // NOT undo a successful verification, so we log rather than throw. Only
    // initialized products are affected; uninitialized ones are skipped inside
    // the DB function.
    try {
      // eslint-disable-next-line no-await-in-loop
      const { error: dErr } = await supabase.rpc('deduct_order_stock', { p_order_id: id })
      if (dErr) console.error('stock deduction failed for order', id, dErr)
    } catch (e) {
      console.error('stock deduction threw for order', id, e)
    }
  }
}

// ===========================================================================
// V4 BILLING MODULE — Phase 2 (product verification & editing)
// ===========================================================================

/** Load order items with the Phase 2 edit fields for the billing detail view.
 *  Accepts a single order id OR an array of ids (a shop-day group). */
export async function loadBillingOrderItemsFull(orderIdOrIds) {
  const ids = Array.isArray(orderIdOrIds) ? orderIdOrIds : [orderIdOrIds]
  const { data, error } = await supabase
    .from('order_items')
    .select('id, order_id, product_name, qty, unit, is_addon, available, original_qty, change_type, change_reason, original_product_name, removed, normal_price, is_special_price, scheme_enabled, unit_price, mrp, gst_percent, hsn, free_qty, price_type, rescheduled_from_item_id, rescheduled_from_date, approval_status, approved_by, approved_at, approval_reason')
    .in('order_id', ids)
    .order('removed', { ascending: true })
  if (error) throw error
  const items = data || []

  // Merge the same product across merged orders:
  //   • Duplicate (non-add-on) copies collapse into ONE, keeping the original
  //     quantity (3 duplicate orders of ×1 → ×1, not ×3).
  //   • Genuine ADD-ON quantities are SUMMED on top (base ×1 + add-on ×2 → ×3).
  // Removed/edited items are kept as-is (not merged) so their state is visible.
  const merged = new Map()
  const passthrough = []
  const order = []

  for (const it of items) {
    // Don't merge items billing has already edited/removed — keep them distinct.
    if (it.removed || it.change_type) {
      passthrough.push(it)
      continue
    }
    const key = `${(it.product_name || '').trim().toUpperCase()}__${it.unit || ''}`
    let m = merged.get(key)
    if (!m) {
      m = { ...it, itemIds: [it.id], _baseQty: it.is_addon ? 0 : it.qty, _addonQty: it.is_addon ? it.qty : 0 }
      merged.set(key, m)
      order.push(m)
    } else {
      m.itemIds.push(it.id)
      if (it.is_addon) {
        m._addonQty += it.qty            // add-ons accumulate
      } else {
        // another duplicate base copy — keep original qty (take the max, they're equal)
        m._baseQty = Math.max(m._baseQty, it.qty)
      }
    }
  }

  // Finalize merged rows: qty = one base qty + summed add-ons.
  const mergedRows = order.map((m) => ({
    ...m,
    qty: (m._baseQty || 0) + (m._addonQty || 0)
  }))

  return [...mergedRows, ...passthrough]
}

/** Toggle a product's Available (verified) state. */
export async function setItemAvailable(itemOrId, available) {
  const ids = idsOf(itemOrId)
  const { error } = await supabase
    .from('order_items')
    .update({ available, edited_at: new Date().toISOString() })
    .in('id', ids)
  if (error) throw error
}

// Resolve the underlying order_item id(s) — a merged product carries itemIds.
function idsOf(itemOrId) {
  if (typeof itemOrId === 'string') return [itemOrId]
  if (itemOrId?.itemIds?.length) return itemOrId.itemIds
  return [itemOrId.id]
}

/**
 * Append ONE immutable audit record for a billing modification.
 * Never updates/deletes — each call is a permanent row. Failures are logged
 * but do NOT block the edit itself (the edit is the primary action; a missing
 * audit row is better than a blocked verification). Callers pass an `audit`
 * context object with order/shop/rep/user info gathered in the UI.
 */
export async function logBillingAudit(rec) {
  try {
    const { error } = await supabase.from('billing_audit_log').insert({
      order_id: rec.orderId ?? null,
      order_item_id: rec.orderItemId ?? null,
      order_ref: rec.orderRef ?? null,
      shop_name: rec.shopName ?? null,
      route: rec.route ?? null,
      sales_rep_name: rec.salesRepName ?? null,
      edited_by: rec.editedBy ?? null,
      edited_by_id: rec.editedById ?? null,
      action_type: rec.actionType,
      product_name: rec.productName ?? null,
      original_product_name: rec.originalProductName ?? null,
      replacement_product_name: rec.replacementProductName ?? null,
      original_qty: rec.originalQty ?? null,
      new_qty: rec.newQty ?? null,
      reason: rec.reason
    })
    if (error) console.error('billing audit log insert failed', error)
  } catch (e) {
    console.error('billing audit log threw', e)
  }
}

/** Load billing audit records within a date range (inclusive), newest first. */
export async function loadBillingAudit(fromISO, toISO) {
  let q = supabase.from('billing_audit_log').select('*').order('created_at', { ascending: false })
  if (fromISO) q = q.gte('created_at', fromISO)
  if (toISO) q = q.lte('created_at', toISO)
  const { data, error } = await q
  if (error) { console.error('load billing audit failed', error); return [] }
  return data || []
}

/** Edit a product's quantity (keeps original_qty the first time it changes). */
export async function editItemQty(item, newQty, reason, audit) {
  const ids = idsOf(item)
  const originalQty = item.original_qty != null ? item.original_qty : item.qty
  const patch = {
    qty: newQty,
    change_type: 'qty',
    change_reason: reason || null,
    edited_at: new Date().toISOString()
  }
  if (item.original_qty == null) patch.original_qty = item.qty
  // Apply to the first underlying row; collapse the rest to 0 so the merged
  // total equals exactly the edited quantity (no leftover duplicate qty).
  const [first, ...rest] = ids
  const { error } = await supabase.from('order_items').update(patch).eq('id', first)
  if (error) throw error
  if (rest.length) {
    await supabase.from('order_items')
      .update({ qty: 0, change_type: 'qty', edited_at: new Date().toISOString() })
      .in('id', rest)
  }
  // Immutable audit — logs the qty BEFORE this edit → the new qty. A later edit
  // appends its own row (5->4 after 6->5), never overwriting this one.
  if (audit) {
    await logBillingAudit({
      ...audit,
      orderItemId: first,
      actionType: 'QUANTITY EDITED',
      productName: item.product_name,
      originalQty: item.qty,
      newQty,
      reason: reason || audit.reason || '—'
    })
  }
}

/** Remove a product from the order (mandatory reason). Keeps the row for audit. */
export async function removeItem(item, reason, audit) {
  const ids = idsOf(item)
  const patch = {
    removed: true,
    available: false,
    change_type: 'removed',
    change_reason: reason,
    edited_at: new Date().toISOString()
  }
  if (item.original_qty == null) patch.original_qty = item.qty
  const { error } = await supabase.from('order_items').update(patch).in('id', ids)
  if (error) throw error
  if (audit) {
    await logBillingAudit({
      ...audit,
      orderItemId: ids[0],
      actionType: 'PRODUCT REMOVED',
      productName: item.product_name,
      originalQty: item.qty,
      newQty: 0,
      reason: reason || '—'
    })
  }
}

/** Replace a product with another (mandatory reason). Keeps original name for audit. */
export async function replaceItem(item, newProductName, reason, audit) {
  const ids = idsOf(item)
  const patch = {
    product_name: newProductName,
    original_product_name: item.original_product_name || item.product_name,
    change_type: 'replaced',
    change_reason: reason,
    available: true,
    edited_at: new Date().toISOString()
  }
  // Replace the first row; remove the duplicate copies so it shows once.
  const [first, ...rest] = ids
  const { error } = await supabase.from('order_items').update(patch).eq('id', first)
  if (error) throw error
  if (rest.length) {
    await supabase.from('order_items')
      .update({ removed: true, available: false, change_type: 'removed', change_reason: 'Merged duplicate', edited_at: new Date().toISOString() })
      .in('id', rest)
  }
  if (audit) {
    await logBillingAudit({
      ...audit,
      orderItemId: first,
      actionType: 'PRODUCT REPLACED',
      productName: newProductName,
      originalProductName: item.original_product_name || item.product_name,
      replacementProductName: newProductName,
      originalQty: item.qty,
      newQty: item.qty,
      reason: reason || '—'
    })
  }
}

// ===========================================================================
// V4 BILLING MODULE — Phase 3 (rep notifications)
// ===========================================================================

/** Unread order-edit notifications for the logged-in sales rep. */
export async function loadMyNotifications() {
  const { data: auth } = await supabase.auth.getUser()
  const uid = auth?.user?.id
  if (!uid) return []
  const { data, error } = await supabase
    .from('order_notifications')
    .select('id, order_id, shop_name, changes, changed_by, created_at, read')
    .eq('sales_rep_id', uid)
    .eq('read', false)
    .order('created_at', { ascending: false })
  if (error) { console.error('notif load failed', error); return [] }
  return data || []
}

/** Mark a notification read (after the rep views/dismisses it). */
export async function markNotificationRead(id) {
  const { error } = await supabase
    .from('order_notifications')
    .update({ read: true })
    .eq('id', id)
  if (error) console.error('notif mark read failed', error)
}

/** Admin: recent billing-verified orders with rep name + products (for the
 *  Admin "Verified Orders" tab). Shows shop, rep, and product list. */
export async function loadVerifiedOrdersForAdmin(limit = 100) {
  const { data, error } = await supabase
    .from('orders')
    .select('id, shop_name, route, sales_rep_id, billing_verified_at, order_items(product_name, qty, unit, removed)')
    .eq('billing_status', 'verified')
    .eq('hidden', false)
    .order('billing_verified_at', { ascending: false })
    .limit(limit)
  if (error) throw error
  const orders = data || []
  // Attach rep names.
  const repIds = [...new Set(orders.map((o) => o.sales_rep_id).filter(Boolean))]
  let names = {}
  if (repIds.length) {
    const { data: profs } = await supabase.from('profiles').select('id, full_name').in('id', repIds)
    ;(profs || []).forEach((p) => { names[p.id] = p.full_name })
  }
  return orders.map((o) => ({
    id: o.id,
    shop_name: o.shop_name,
    route: o.route,
    rep_name: names[o.sales_rep_id] || 'Unknown',
    verified_at: o.billing_verified_at,
    items: (o.order_items || []).filter((it) => !it.removed)
  }))
}

/** List active salespeople (id + name) for pickers like the Returns rep dropdown. */
export async function listActiveSalespeople() {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, full_name')
    .eq('role', 'salesperson')
    .order('full_name', { ascending: true })
  if (error) { console.error(error); return [] }
  return data || []
}

/** Performance for a specific date (YYYY-MM-DD) for the logged-in rep.
 *  Order Value uses the actual selling price saved on each order (total_value),
 *  never MRP, never recalculated from the current product master. */
export async function loadPerformanceForDate(userId, dateStr, route = null, rangeOverride = null) {
  const start = rangeOverride ? rangeOverride.start : new Date(`${dateStr}T00:00:00`)
  const end = rangeOverride ? rangeOverride.end : new Date(`${dateStr}T23:59:59.999`)

  // Base queries (date-scoped). When a route is supplied, we additionally
  // constrain by the per-order / per-visit route column. When it is null the
  // queries are IDENTICAL to the original date-only behaviour.
  let ordersQ = supabase
    .from('orders')
    .select('id, total_quantity, total_value, shop_name, customer_id, created_at, route')
    .eq('sales_rep_id', userId)
    .eq('hidden', false)
    .gte('created_at', start.toISOString())
    .lte('created_at', end.toISOString())

  let visitsQ = supabase
    .from('visits')
    .select('id, shop_name, customer_id, created_at, route')
    .eq('sales_rep_id', userId)
    .gte('created_at', start.toISOString())
    .lte('created_at', end.toISOString())

  if (route) {
    ordersQ = ordersQ.eq('route', route)
    visitsQ = visitsQ.eq('route', route)
  }

  let newShopsQ = supabase
    .from('customers')
    .select('id', { count: 'exact', head: true })
    .eq('created_by', userId)
    .eq('is_rep_created', true)
    .gte('created_at', start.toISOString())
    .lte('created_at', end.toISOString())
  if (route) newShopsQ = newShopsQ.eq('route', route)

  const [ordersRes, visitsRes, newShopsRes] = await Promise.all([ordersQ, visitsQ, newShopsQ])

  const orders = ordersRes.data || []
  const visits = visitsRes.data || []

  // Canonical counts — see getUniqueShopVisits/getUniqueOrderVisits. "orders"
  // here means UNIQUE shops that placed an order (not raw order rows — a
  // shop with two separate orders the same day is still one "order taken"
  // visit), and "shops" means all unique shops visited, order or not.
  const orderVisitKeys = getUniqueOrderVisits(orders)
  const allVisitKeys = getUniqueShopVisits(orders, visits)

  // Consolidated (one row per shop-day, latest values) — used for quantity
  // and order value so a same-day add-on order is never double-counted. The
  // latest order for a shop-day already includes everything from earlier
  // orders that same day (reps re-submit the full item list on repeat visits
  // to a shop), so summing raw rows would overstate both qty and value.
  const consolidated = consolidateOrdersByVisit(orders)

  return {
    orders: orderVisitKeys.size,
    quantity: consolidated.reduce((s, o) => s + (o.total_quantity || 0), 0),
    shops: allVisitKeys.size,
    visits: allVisitKeys.size, // alias — "Visits" IS "Shops Visited", same canonical number
    orderValue: consolidated.reduce((s, o) => s + (o.total_value || 0), 0),
    newShops: newShopsRes.count || 0
  }
}

/** Distinct active routes across customers (for the per-order route dropdown). */
export async function listAllRoutes() {
  const { data, error } = await supabase
    .from('customers')
    .select('route')
    .not('route', 'is', null)
  if (error) { console.error(error); return [] }
  const set = new Set((data || []).map((c) => (c.route || '').trim()).filter(Boolean))
  return [...set].sort()
}

// ===========================================================================
// V4 QC MODULE — Phase 1
// ===========================================================================

export const PACKING_STAFF = ['Aswin', 'Rashmi', 'Sathi', 'Bindu', 'Jishnu (Achu)', 'Shivan']

/** QC dashboard counts + list, filtered by qc_status. */
export async function loadQcDeliveries(qcStatus = 'qc_pending', dateStr = null) {
  let q = supabase
    .from('deliveries')
    .select('id, order_id, shop_name, route, sales_rep_name, status, qc_status, packed_by, created_at, qc_verified_at')
    .eq('qc_status', qcStatus)
    .neq('status', 'cancelled')

  // Optional date filter. When a date is supplied, restrict to that calendar
  // day. For the Verified tab we filter on qc_verified_at (when QC actually
  // verified it); for all other tabs we filter on created_at (when it arrived).
  if (dateStr) {
    const start = new Date(`${dateStr}T00:00:00`).toISOString()
    const end = new Date(`${dateStr}T23:59:59.999`).toISOString()
    const dateField = qcStatus === 'qc_verified' ? 'qc_verified_at' : 'created_at'
    q = q.gte(dateField, start).lte(dateField, end)
  }

  const { data, error } = await q
    .order('created_at', { ascending: false })
    .limit(500)
  if (error) throw error
  return data || []
}

/** QC dashboard summary counts. */
export async function loadQcCounts() {
  const startToday = new Date(); startToday.setHours(0, 0, 0, 0)
  const [pending, inProgress, verifiedToday, returned] = await Promise.all([
    supabase.from('deliveries').select('id', { count: 'exact', head: true }).eq('qc_status', 'qc_pending').neq('status', 'cancelled'),
    supabase.from('deliveries').select('id', { count: 'exact', head: true }).eq('qc_status', 'in_progress').neq('status', 'cancelled'),
    supabase.from('deliveries').select('id', { count: 'exact', head: true }).eq('qc_status', 'qc_verified').gte('qc_verified_at', startToday.toISOString()),
    supabase.from('deliveries').select('id', { count: 'exact', head: true }).eq('qc_status', 'qc_returned').neq('status', 'cancelled')
  ])
  return {
    pending: pending.count || 0,
    inProgress: inProgress.count || 0,
    verifiedToday: verifiedToday.count || 0,
    returned: returned.count || 0
  }
}

/**
 * Lightweight delivery status counts for the Admin read-only overview.
 * Deliberately count-only (head:true), unlike loadDeliveryAdmin which pulls
 * full delivery rows for the real Delivery Admin working dashboard — this
 * avoids fetching route/tracking data we don't need just to show a summary.
 */
export async function loadDeliveryCounts() {
  const [pending, assigned, inProgress, delivered, partial, failed] = await Promise.all([
    supabase.from('deliveries').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
    supabase.from('deliveries').select('id', { count: 'exact', head: true }).eq('status', 'assigned'),
    supabase.from('deliveries').select('id', { count: 'exact', head: true }).eq('status', 'in_progress'),
    supabase.from('deliveries').select('id', { count: 'exact', head: true }).eq('status', 'delivered'),
    supabase.from('deliveries').select('id', { count: 'exact', head: true }).eq('status', 'partial'),
    supabase.from('deliveries').select('id', { count: 'exact', head: true }).eq('status', 'failed')
  ])
  return {
    pending: pending.count || 0,
    assigned: assigned.count || 0,
    inProgress: inProgress.count || 0,
    delivered: delivered.count || 0,
    partial: partial.count || 0,
    failed: failed.count || 0
  }
}

/** Load a delivery's items for QC checking (reuses the group loader shape). */
export async function loadQcDeliveryItems(delivery) {
  return await loadGroupDetail(delivery)
}

/** QC verify: requires packed_by + checklist → sets Ready for Delivery. */
export async function qcVerifyDelivery(deliveryId, packedBy, checklist) {
  const { error } = await supabase.rpc('qc_verify_delivery', {
    p_delivery_id: deliveryId,
    p_packed_by: packedBy,
    p_checklist: checklist || null
  })
  if (error) throw error
}

// --- QC per-product verification (auto-save + resume) ----------------------

const QC_ERROR_TYPES = [
  'Wrong Product', 'Wrong Quantity', 'Missing Item', 'Extra Item',
  'Damaged Product', 'Expired Product', 'Wrong Batch',
  'Wrong MRP', 'Loose Packing', 'Other'
]
export { QC_ERROR_TYPES }

/** Load delivery items WITH their saved QC state (for resume). Seeds items first. */
export async function loadQcItemsWithState(delivery) {
  const ids = delivery.deliveryIds || [delivery.id]

  // Read existing delivery_items for this delivery.
  const readItems = async () => {
    const { data, error } = await supabase
      .from('delivery_items')
      .select('id, delivery_id, product_name, ordered_qty, unit, qc_state, qc_error_type, qc_remarks, qc_packed_by')
      .in('delivery_id', ids)
      .order('product_name', { ascending: true })
    if (error) throw error
    return data || []
  }

  let items = await readItems()
  if (items.length > 0) return items

  // None yet — seed from each delivery's order items (exclude removed).
  for (const deliveryId of ids) {
    // eslint-disable-next-line no-await-in-loop
    const { data: del } = await supabase
      .from('deliveries')
      .select('id, order_id')
      .eq('id', deliveryId)
      .single()
    if (!del?.order_id) continue
    // eslint-disable-next-line no-await-in-loop
    const { data: orderItems } = await supabase
      .from('order_items')
      .select('product_name, qty, unit, removed')
      .eq('order_id', del.order_id)
    const rows = (orderItems || [])
      .filter((oi) => !oi.removed)
      .map((oi) => ({
        delivery_id: deliveryId,
        product_name: oi.product_name,
        ordered_qty: oi.qty,
        unit: oi.unit || 'Piece',
        delivered: false,
        delivered_qty: null,
        reason: ''
      }))
    if (rows.length) {
      // eslint-disable-next-line no-await-in-loop
      await supabase.from('delivery_items').insert(rows)
    }
  }

  // Read again after seeding.
  return await readItems()
}

/** Auto-save one product's QC state immediately. */
export async function saveQcItemState(itemId, patch) {
  const row = { ...patch, qc_checked_at: new Date().toISOString() }
  const { error } = await supabase.from('delivery_items').update(row).eq('id', itemId)
  if (error) throw error
}

/** Mark the delivery(ies) as in-progress (called when QC first touches an item). */
export async function markQcInProgress(delivery) {
  const ids = delivery.deliveryIds || [delivery.id]
  for (const id of ids) {
    // eslint-disable-next-line no-await-in-loop
    await supabase.rpc('qc_mark_in_progress', { p_delivery_id: id })
  }
}

/** Verify all deliveries in a group (Ready for Delivery) with packed_by. */
export async function qcVerifyGroup(delivery, packedBy, checklist) {
  const ids = delivery.deliveryIds || [delivery.id]
  for (const id of ids) {
    // eslint-disable-next-line no-await-in-loop
    const { error } = await supabase.rpc('qc_verify_delivery', {
      p_delivery_id: id, p_packed_by: packedBy, p_checklist: checklist || null
    })
    if (error) throw error
  }
}

/** Update the logged-in user's own display name (used by QC first-login prompt). */
export async function updateMyName(newName) {
  const { data: auth } = await supabase.auth.getUser()
  const uid = auth?.user?.id
  if (!uid) throw new Error('not signed in')
  const { error } = await supabase.from('profiles').update({ full_name: newName.trim() }).eq('id', uid)
  if (error) throw error
}

// ===========================================================================
// WEB PUSH (QC external notifications) — subscription storage
// ===========================================================================

/** Save (upsert) a browser push subscription for the current user. */
export async function savePushSubscription(subscription, role) {
  const uid = await currentUserId()
  if (!uid) throw new Error('not signed in')
  const sub = subscription.toJSON ? subscription.toJSON() : subscription
  const { error } = await supabase
    .from('push_subscriptions')
    .upsert(
      {
        user_id: uid,
        endpoint: sub.endpoint,
        subscription: sub,
        role: role || null,
        updated_at: new Date().toISOString()
      },
      { onConflict: 'endpoint' }
    )
  if (error) throw error
}

/** Remove a push subscription by endpoint (on unsubscribe). */
export async function removePushSubscription(endpoint) {
  if (!endpoint) return
  const { error } = await supabase.from('push_subscriptions').delete().eq('endpoint', endpoint)
  if (error) console.error('removePushSubscription failed', error)
}

/** Load ONE delivery by id (for QC deep-linking from a push notification). */
export async function loadQcDeliveryById(deliveryId) {
  if (!deliveryId) return null
  const { data, error } = await supabase
    .from('deliveries')
    .select('id, order_id, shop_name, route, sales_rep_name, status, qc_status, packed_by, created_at, qc_verified_at')
    .eq('id', deliveryId)
    .maybeSingle()
  if (error) throw error
  return data || null
}

// ===========================================================================
// PERFORMANCE DRILL-DOWN (Shop Visits / Orders Taken / New Shops Added)
// All functions below are strictly scoped to the given userId (the logged-in
// rep) — RLS enforces this server-side too, but we always filter explicitly
// to match the existing query style and keep intent obvious.
// ===========================================================================

// Turn a period selection into a concrete [start, end] Date range.
// mode: 'today' | 'week' | 'month' | 'date'  (date uses dateStr as the day)
export function resolvePeriodRange(mode, dateStr) {
  const now = new Date()
  if (mode === 'date' && dateStr) {
    return {
      start: new Date(`${dateStr}T00:00:00`),
      end: new Date(`${dateStr}T23:59:59.999`)
    }
  }
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  if (mode === 'week') {
    const dow = (now.getDay() + 6) % 7 // Monday-start, matches loadMyPerformance
    const start = new Date(startOfToday)
    start.setDate(startOfToday.getDate() - dow)
    return { start, end: now }
  }
  if (mode === 'month') {
    return { start: new Date(now.getFullYear(), now.getMonth(), 1), end: now }
  }
  // default: today
  return { start: startOfToday, end: now }
}

/**
 * Shop Visits list for the drill-down — the union of shops that placed an
 * order AND shops with an explicit "mark as visit (no order)" row, one
 * consolidated entry per shop-day, matching exactly what the Shops Visited
 * KPI counts (getUniqueShopVisits). Each entry is labelled ORDER, ADD-ON, or
 * NO ORDER so it's clear why a shop appears without necessarily having an
 * order value.
 */
export async function loadVisitsList(userId, start, end, route = null) {
  const [orders, visits] = await Promise.all([
    fetchAllPaged(
      'orders',
      'id, shop_name, route, customer_id, total_value, created_at',
      (q) => {
        q = q.eq('sales_rep_id', userId).eq('hidden', false).gte('created_at', start.toISOString()).lte('created_at', end.toISOString())
        if (route) q = q.eq('route', route)
        return q
      }
    ),
    fetchAllPaged(
      'visits',
      'id, shop_name, route, visit_status, custom_remark, created_at, customer_id',
      (q) => {
        q = q.eq('sales_rep_id', userId).gte('created_at', start.toISOString()).lte('created_at', end.toISOString())
        if (route) q = q.eq('route', route)
        return q
      }
    )
  ])

  // Consolidate orders to one (latest) row per shop-day first, so a shop with
  // an add-on order doesn't appear twice, and so we know which shop-days
  // already have an order (those take priority — an order visit is still
  // just one visit, even if a no-order "mark as visit" row also exists that
  // day, e.g. the rep marked no-order then came back and ordered).
  const consolidatedOrders = consolidateOrdersByVisit(orders)
  const orderKeys = new Set(consolidatedOrders.map(visitKey))

  const orderEntries = consolidatedOrders.map((o) => ({
    key: visitKey(o),
    shop_name: o.shop_name,
    route: o.route,
    customer_id: o.customer_id,
    created_at: o.created_at,
    total_value: o.total_value,
    status: o.isAddon ? 'ADD-ON' : 'ORDER'
  }))

  // No-order visits: only include shop-days that DON'T already have an order
  // that day (an order supersedes a no-order mark for the same shop-day).
  const seenNoOrder = new Set()
  const noOrderEntries = []
  for (const v of visits) {
    const key = visitKey(v)
    if (orderKeys.has(key) || seenNoOrder.has(key)) continue
    seenNoOrder.add(key)
    noOrderEntries.push({
      key,
      shop_name: v.shop_name,
      route: v.route,
      customer_id: v.customer_id,
      created_at: v.created_at,
      total_value: null,
      status: 'NO ORDER',
      remark: v.custom_remark
    })
  }

  return [...orderEntries, ...noOrderEntries].sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
}

/** Orders Taken list for the drill-down (order header + item count/qty/value).
 *  Consolidated: a shop visited twice in one day (e.g. an add-on order) shows
 *  as ONE entry with the latest/final totals, tagged isAddon. */
export async function loadOrdersList(userId, start, end, route = null) {
  const raw = await fetchAllPaged(
    'orders',
    'id, shop_name, route, customer_id, total_products, total_quantity, total_value, created_at, billing_status',
    (q) => {
      q = q.eq('sales_rep_id', userId).eq('hidden', false).gte('created_at', start.toISOString()).lte('created_at', end.toISOString()).order('created_at', { ascending: false })
      if (route) q = q.eq('route', route)
      return q
    }
  )
  return consolidateOrdersByVisit(raw).sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
}

/**
 * Full order summary for one order (used by both the Orders Taken drill-down
 * and the New Shops -> Today's Activity -> order click path).
 * Returns product lines with qty/unit; unit_price/scheme are included ONLY
 * when present (new orders going forward) — never fabricated for old orders.
 */
export async function loadOrderSummary(orderId) {
  const { data: order, error } = await supabase
    .from('orders')
    .select('id, shop_name, route, sales_rep_id, total_products, total_quantity, total_value, order_date, created_at, billing_status')
    .eq('id', orderId)
    .maybeSingle()
  if (error) throw error
  if (!order) return null

  const { data: items, error: itemsErr } = await supabase
    .from('order_items')
    .select('id, product_name, qty, unit, is_addon, unit_price, scheme_applied')
    .eq('order_id', orderId)
  if (itemsErr) throw itemsErr

  // Rep display name (for the summary header).
  let repName = ''
  try {
    const { data: prof } = await supabase.from('profiles').select('full_name').eq('id', order.sales_rep_id).maybeSingle()
    repName = prof?.full_name || ''
  } catch { /* non-critical */ }

  return { ...order, sales_rep_name: repName, items: items || [] }
}

/** New Shops Added list — customers this rep created in the period. No phone
 * (customer phone is intentionally never stored in the cloud — device-only). */
export async function loadNewShopsList(userId, start, end, route = null) {
  return await fetchAllPaged(
    'customers',
    'id, shop_name, route, category, created_at',
    (q) => {
      q = q.eq('created_by', userId).eq('is_rep_created', true).gte('created_at', start.toISOString()).lte('created_at', end.toISOString()).order('created_at', { ascending: false })
      if (route) q = q.eq('route', route)
      return q
    }
  )
}

/**
 * "Today's Activity" for one customer: was this specific customer visited
 * today, and what orders (if any) did they place today. "Today" here means
 * the calendar day the caller passes in (usually actual today).
 */
export async function loadCustomerTodayActivity(customerId, userId) {
  const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0)
  const endOfToday = new Date(); endOfToday.setHours(23, 59, 59, 999)

  const [visitRes, ordersRes] = await Promise.all([
    supabase
      .from('visits')
      .select('id, created_at, visit_status')
      .eq('customer_id', customerId)
      .eq('sales_rep_id', userId)
      .gte('created_at', startOfToday.toISOString())
      .lte('created_at', endOfToday.toISOString())
      .order('created_at', { ascending: false })
      .limit(1),
    supabase
      .from('orders')
      .select('id, total_products, total_quantity, total_value, created_at')
      .eq('customer_id', customerId)
      .eq('sales_rep_id', userId)
      .eq('hidden', false)
      .gte('created_at', startOfToday.toISOString())
      .lte('created_at', endOfToday.toISOString())
      .order('created_at', { ascending: false })
  ])

  const orders = ordersRes.data || []
  const consolidated = consolidateOrdersByVisit(orders)
  return {
    visitedToday: (visitRes.data || []).length > 0,
    // ordersToday reflects unique order-taking visits (0 or 1 for "today" scoped
    // to one customer), not raw row count — a same-day add-on order is still
    // one order-taking visit, consistent with Orders Taken everywhere else.
    ordersToday: consolidated.length,
    orderValueToday: consolidated.reduce((s, o) => s + (o.total_value || 0), 0),
    lastOrderAt: orders[0]?.created_at || null,
    orders: consolidated
  }
}

// ===========================================================================
// BILL CANCELLED (Delivery Rep) + Delivery Admin notifications
// ===========================================================================

/**
 * Cancel an entire shop-day delivery group (all rows in group.deliveryIds)
 * with a required typed reason. Server-side RPC enforces: only the assigned
 * rep can cancel, and only while not yet delivered/cancelled — so this can't
 * be bypassed by tampering with the client.
 */
export async function cancelDeliveryGroup(group, reason) {
  const trimmed = (reason || '').trim()
  if (!trimmed) throw new Error('A reason is required to cancel a bill.')
  const { error } = await supabase.rpc('cancel_delivery_group', {
    p_delivery_ids: group.deliveryIds || [group.id],
    p_reason: trimmed
  })
  if (error) throw error
}

/** Delivery Admin's notification inbox (cancelled bills, newest first). */
export async function loadDeliveryAdminNotifications() {
  const { data, error } = await supabase
    .from('delivery_admin_notifications')
    .select('id, delivery_id, shop_name, route, reason, cancelled_by_name, created_at, read')
    .order('created_at', { ascending: false })
    .limit(100)
  if (error) throw error
  return data || []
}

/** Count of unread Delivery Admin notifications, for a bell badge. */
export async function countUnreadDeliveryAdminNotifications() {
  const { count, error } = await supabase
    .from('delivery_admin_notifications')
    .select('id', { count: 'exact', head: true })
    .eq('read', false)
  if (error) return 0
  return count || 0
}

/** Mark one Delivery Admin notification as read. */
export async function markDeliveryAdminNotificationRead(id) {
  const { error } = await supabase
    .from('delivery_admin_notifications')
    .update({ read: true })
    .eq('id', id)
  if (error) throw error
}

// ===========================================================================
// SALES REP: delete own order (any time while still billing_status='pending')
// ===========================================================================

/** Delete an order the current rep created. Server-side enforces ownership
 *  and that it hasn't been verified by Billing yet. */
export async function deleteOwnOrder(orderId, reason = null) {
  const { error } = await supabase.rpc('delete_own_order', {
    p_order_id: orderId,
    p_reason: reason || null
  })
  if (error) throw error
}

/**
 * Billing's "Deleted" tab — read-only history of orders a rep deleted after
 * they'd already reached (or were sitting in) Billing's queue. Deliberately
 * queries hidden=true + billing_status='deleted' (the one intentional
 * exception to the hidden=false filter used everywhere else), grouped the
 * same way as the Pending/Verified tabs for a consistent one-card-per-shop
 * view.
 */
export async function loadDeletedBillingOrders(dateStr = null) {
  const data = await fetchAllPaged(
    'orders',
    'id, shop_name, route, total_quantity, total_value, created_at, order_date, sales_rep_id, deleted_at, delete_reason',
    (q) => {
      q = q.eq('billing_status', 'deleted').eq('hidden', true).order('deleted_at', { ascending: false })
      if (dateStr) q = q.eq('order_date', dateStr)
      return q
    }
  )
  return data
}

/**
 * Items for a shop-day group, split by which underlying order they belong
 * to — used ONLY by the independent Original/Add-on verification view. Does
 * NOT merge across orders (unlike loadBillingOrderItemsFull, which is used
 * for the normal single-verify-action detail view and merges duplicate
 * product lines across the whole group by design — a different, existing
 * concern this function intentionally leaves untouched).
 */
export async function loadBillingItemsByOrder(orderIds) {
  const { data, error } = await supabase
    .from('order_items')
    .select('id, order_id, product_name, qty, unit, available, removed, change_type')
    .in('order_id', orderIds)
    .order('removed', { ascending: true })
  if (error) throw error
  const byOrder = new Map()
  for (const it of data || []) {
    if (!byOrder.has(it.order_id)) byOrder.set(it.order_id, [])
    byOrder.get(it.order_id).push(it)
  }
  return byOrder // Map<order_id, items[]>
}

/**
 * Permanently change a customer's default route in the cloud. This is a rare,
 * explicit action (confirmed by the rep) — NOT the normal per-order route
 * override, which stays purely local to that one order and never touches
 * this. Historical orders are untouched: each order already stores its own
 * route independently (route column on `orders`), so changing the customer's
 * default here can never retroactively alter what an old order shows.
 */
export async function updateCustomerDefaultRoute(customerCloudId, newRoute) {
  if (!customerCloudId) return
  const { error } = await supabase
    .from('customers')
    .update({ route: newRoute })
    .eq('id', customerCloudId)
  if (error) throw error
}

// ===========================================================================
// INVENTORY (Purchase Manager module — Phase 1)
// ===========================================================================

/** Fetch all inventory rows as a Map<product_id, invRow>. */
export async function loadInventoryMap() {
  const { data, error } = await supabase.from('product_inventory').select('*')
  if (error) { console.error('load inventory failed', error); return new Map() }
  return new Map((data || []).map((r) => [r.product_id, r]))
}

/** Fetch a single product's inventory row (or null if not initialized). */
export async function loadProductInventory(productId) {
  const { data, error } = await supabase
    .from('product_inventory').select('*').eq('product_id', productId).maybeSingle()
  if (error) { console.error('load product inventory failed', error); return null }
  return data || null
}

/**
 * Apply a stock change atomically via the DB function (init / receive / adjust).
 * qty is signed. Returns { applied, previous_stock, current_stock, reason }.
 */
export async function applyStockChange({ productId, productName, txnType, qty, reference, userName, userId, minStock, allowNegative }) {
  const { data, error } = await supabase.rpc('apply_stock_change', {
    p_product_id: productId,
    p_product_name: productName ?? null,
    p_txn_type: txnType,
    p_qty: qty,
    p_reference: reference ?? null,
    p_user_name: userName ?? null,
    p_user_id: userId ?? null,
    p_min_stock: minStock ?? null,
    p_allow_negative: allowNegative ?? false
  })
  if (error) { console.error('apply_stock_change failed', error); throw error }
  return data
}

/** Record a purchase/receipt row (history). Does NOT change stock by itself. */
export async function recordPurchase(rec) {
  const total = (rec.qty != null && rec.purchasePrice != null) ? rec.qty * rec.purchasePrice : null
  const { error } = await supabase.from('purchases').insert({
    product_id: rec.productId,
    product_name: rec.productName ?? null,
    brand: rec.brand ?? null,
    qty: rec.qty,
    purchase_price: rec.purchasePrice ?? null,
    total_value: total,
    supplier: rec.supplier ?? null,
    reference: rec.reference ?? null,
    added_by: rec.addedBy ?? null,
    added_by_id: rec.addedById ?? null
  })
  if (error) console.error('record purchase failed', error)
}

/** Update just the minimum stock level for an initialized product. */
export async function setMinimumStock(productId, minStock) {
  const { error } = await supabase
    .from('product_inventory').update({ minimum_stock: minStock }).eq('product_id', productId)
  if (error) throw error
}

/** Recent inventory transactions (optionally for one product). */
export async function loadInventoryTransactions(productId, limit = 100) {
  let q = supabase.from('inventory_transactions').select('*').order('created_at', { ascending: false }).limit(limit)
  if (productId) q = q.eq('product_id', productId)
  const { data, error } = await q
  if (error) { console.error('load inventory txns failed', error); return [] }
  return data || []
}

// ===========================================================================
// INVENTORY — Phase 4: consumption analysis, reorder alerts, recommendations
// ===========================================================================

/**
 * Aggregate the last 60 days of CONFIRMED (billing-verified) sales per product.
 * Returns Map<PRODUCT_NAME_UPPER, { last30, prev30, total60 }> in pieces.
 * Only verified orders count as real consumption (spec: confirmed sales only).
 */
export async function loadConsumption60d() {
  const now = Date.now()
  const from = new Date(now - 60 * 24 * 60 * 60 * 1000).toISOString()
  const mid = now - 30 * 24 * 60 * 60 * 1000
  const { data, error } = await supabase
    .from('orders')
    .select('billing_verified_at, order_items(product_name, qty, removed)')
    .eq('billing_status', 'verified')
    .gte('billing_verified_at', from)
  if (error) { console.error('load consumption failed', error); return new Map() }

  const map = new Map()
  for (const o of data || []) {
    const t = o.billing_verified_at ? new Date(o.billing_verified_at).getTime() : 0
    const recent = t >= mid
    for (const it of o.order_items || []) {
      if (it.removed) continue
      const key = (it.product_name || '').trim().toUpperCase()
      if (!key) continue
      const q = Number(it.qty) || 0
      if (q <= 0) continue
      const cur = map.get(key) || { last30: 0, prev30: 0, total60: 0 }
      cur.total60 += q
      if (recent) cur.last30 += q; else cur.prev30 += q
      map.set(key, cur)
    }
  }
  return map
}

/**
 * Build a per-product analysis row combining inventory + consumption.
 * `products` is the catalogue, `invMap` from loadInventoryMap, `consMap` from
 * loadConsumption60d. Returns rows only for INITIALIZED products (others have
 * no meaningful stock coverage). Recommendation is only produced when there is
 * enough history; otherwise reason = 'insufficient_history'.
 */
export function buildInventoryAnalysis(products, invMap, consMap) {
  const rows = []
  for (const p of products) {
    const inv = invMap.get(p.id)
    if (!inv || !inv.inventory_initialized) continue
    const cons = consMap.get((p.name || '').trim().toUpperCase()) || { last30: 0, prev30: 0, total60: 0 }
    const stock = Number(inv.current_stock) || 0
    const min = Number(inv.minimum_stock) || 0
    const avgMonthly = cons.total60 / 2                 // pieces/month over 60d
    const avgWeekly = cons.total60 / (60 / 7)
    const coverageDays = avgMonthly > 0 ? Math.round((stock / avgMonthly) * 30) : null
    const trend = cons.prev30 === 0
      ? (cons.last30 > 0 ? 'up' : 'flat')
      : (cons.last30 > cons.prev30 * 1.15 ? 'up' : cons.last30 < cons.prev30 * 0.85 ? 'down' : 'flat')

    // Recommendation: target ~1 month cover above minimum, buy the gap.
    // Only recommend when there's real recent history to base it on.
    let recommendedPurchase = null
    let recommendReason = null
    if (cons.total60 > 0) {
      const target = Math.max(Math.ceil(avgMonthly) + min, min)
      const buy = Math.max(0, target - stock)
      recommendedPurchase = buy
      recommendReason = 'Based on recent two-month consumption and current stock.'
    } else {
      recommendReason = 'insufficient_history'
    }

    rows.push({
      product: p, inv, stock, min,
      last30: cons.last30, prev30: cons.prev30, total60: cons.total60,
      avgMonthly: Math.round(avgMonthly * 10) / 10,
      avgWeekly: Math.round(avgWeekly * 10) / 10,
      coverageDays, trend,
      recommendedPurchase, recommendReason
    })
  }
  return rows
}

/** Recent purchase history rows (newest first). */
export async function loadPurchases(limit = 200) {
  const { data, error } = await supabase
    .from('purchases').select('*').order('created_at', { ascending: false }).limit(limit)
  if (error) { console.error('load purchases failed', error); return [] }
  return data || []
}

// ===========================================================================
// LEDGER CATEGORY (customer attribute)
// ===========================================================================

/** Load the ledger category master list (names only), ordered. */
export async function loadLedgerCategories() {
  const { data, error } = await supabase
    .from('ledger_categories').select('name, sort_order').order('sort_order', { ascending: true })
  if (error) { console.error('load ledger categories failed', error); return [] }
  return (data || []).map((r) => r.name)
}

// ===========================================================================
// PURCHASE ALERTS (Feature 4, Half A) — push toggle only; alert STATE is
// maintained in the DB by apply_stock_change.
// ===========================================================================

/** Read whether purchase-stock PUSH alerts are enabled. */
export async function loadPurchaseAlertPushEnabled() {
  const { data, error } = await supabase
    .from('purchase_alert_settings').select('push_enabled').eq('id', 1).maybeSingle()
  if (error) { console.error('load purchase alert setting failed', error); return true }
  return data ? !!data.push_enabled : true
}

/** Enable/disable purchase-stock PUSH alerts (dashboard alerts stay on). */
export async function setPurchaseAlertPushEnabled(enabled) {
  const { error } = await supabase
    .from('purchase_alert_settings').update({ push_enabled: enabled, updated_at: new Date().toISOString() }).eq('id', 1)
  if (error) throw error
}

// ===========================================================================
// PENDING ORDERS / RESCHEDULING (Stock Out removals)
// ===========================================================================

/**
 * All of THIS rep's stock-out removals that haven't been rescheduled yet.
 * Only reason EXACTLY 'Stock Out' counts (not other removal reasons). Includes
 * the parent order's shop/route/date/brand so the UI can group by original
 * order date and the reschedule action has everything it needs.
 */
export async function loadPendingStockOuts(repId) {
  const { data, error } = await supabase
    .from('order_items')
    .select(`
      id, product_name, qty, unit, edited_at, order_id, mrp, gst_percent, hsn,
      unit_price, normal_price, is_special_price, price_type, scheme_enabled, free_qty,
      rescheduled_to_date, rescheduled_order_id, rescheduled_is_addon,
      orders!inner ( id, shop_name, route, order_date, brand, sales_rep_id, hidden )
    `)
    .eq('removed', true)
    .eq('change_reason', 'Stock Out')
    .is('rescheduled_order_id', null)
    .eq('orders.sales_rep_id', repId)
    .eq('orders.hidden', false)
    .order('edited_at', { ascending: false })
  if (error) { console.error('load pending stock-outs failed', error); return [] }
  return (data || []).filter((r) => r.orders) // inner join guard
}

/**
 * Reschedule ONE stock-out item to a future date. Creates a normal new order
 * for that date (reusing saveCloudOrder — the same path AddOnFlowModal uses),
 * carrying over the EXACT pricing/scheme snapshot already captured on the
 * original line (never recomputed, so the customer's originally-quoted price
 * is preserved). Billing's existing shop+order_date grouping automatically
 * shows it as an add-on if the customer already has an order that date.
 *
 * Idempotent: claims the source row first (conditional update on
 * rescheduled_order_id IS NULL); if another click already claimed it, this
 * aborts without creating a duplicate order.
 */
export async function rescheduleStockOutItem({ item, targetDate, repId, repName, brand }) {
  const parentOrder = item.orders
  if (!parentOrder) throw new Error('Original order not found for this item.')

  // Detect whether the customer already has an order for the target date —
  // purely to label the outcome for the UI (Billing's grouping works either
  // way regardless of this check).
  const { data: existing } = await supabase
    .from('orders')
    .select('id')
    .eq('sales_rep_id', repId)
    .eq('shop_name', parentOrder.shop_name)
    .eq('order_date', targetDate)
    .eq('hidden', false)
    .limit(1)
  const willBeAddon = !!(existing && existing.length)

  // Claim the source row FIRST so a double-click / concurrent reschedule can
  // never create two orders for the same stock-out line.
  const claimStamp = new Date().toISOString()
  const { data: claimed, error: claimErr } = await supabase
    .from('order_items')
    .update({ rescheduled_at: claimStamp, rescheduled_by: repName || null })
    .eq('id', item.id)
    .is('rescheduled_order_id', null)
    .select('id')
  if (claimErr) throw claimErr
  if (!claimed || claimed.length === 0) {
    throw new Error('This item was already rescheduled.')
  }

  // Rebuild the single order item, reusing the EXACT price snapshot already
  // captured on the original stock-out line (not recomputed).
  const rescheduledItem = {
    id: item.id, // harmless placeholder; saveCloudOrder generates its own row
    name: item.product_name,
    qty: item.qty,
    unit: item.unit || 'Piece',
    isAddon: willBeAddon,
    mrp: item.mrp,
    gst: item.gst_percent,
    hsn: item.hsn,
    priceType: item.price_type,
    finalSellingPrice: item.unit_price,
    normalPrice: item.normal_price,
    schemeEnabled: item.scheme_enabled !== false
  }

  let newOrderId
  try {
    newOrderId = await saveCloudOrder({
      customer: { name: parentOrder.shop_name, route: parentOrder.route || '', category: '' },
      brand: brand || parentOrder.brand,
      userId: repId,
      items: [rescheduledItem],
      orderDate: targetDate,
      route: parentOrder.route || ''
    })
  } catch (e) {
    // Release the claim so the item is reschedulable again after a failure.
    await supabase.from('order_items').update({ rescheduled_at: null, rescheduled_by: null }).eq('id', item.id)
    throw e
  }

  const { error: finalErr } = await supabase
    .from('order_items')
    .update({
      rescheduled_to_date: targetDate,
      rescheduled_order_id: newOrderId,
      rescheduled_is_addon: willBeAddon
    })
    .eq('id', item.id)
  if (finalErr) console.error('failed to record reschedule link (order was still created)', finalErr)

  // saveCloudOrder recomputes free_qty from scheme slabs, which we didn't
  // carry over (they're not part of the removed-line snapshot). Overwrite it
  // with the EXACT free_qty the customer was originally promised, so a
  // reschedule can never silently change what they were quoted. While we're
  // touching the new row, also stamp the back-reference (Phase 3): Billing
  // can now see, on the NEW order, exactly which original stock-out line and
  // date this item traces back to — full two-way traceability.
  const newRowPatch = { rescheduled_from_item_id: item.id, rescheduled_from_order_id: parentOrder.id, rescheduled_from_date: parentOrder.order_date || null }
  if (item.free_qty != null) newRowPatch.free_qty = item.free_qty
  const { error: fqErr } = await supabase
    .from('order_items')
    .update(newRowPatch)
    .eq('order_id', newOrderId)
    .eq('product_name', item.product_name)
  if (fqErr) console.error('failed to stamp reschedule traceability on new item', fqErr)

  return { newOrderId, isAddon: willBeAddon }
}

// ===========================================================================
// PARTIAL VERIFICATION REPORT (Billing)
// ===========================================================================

/**
 * Orders that were PARTIALLY verified within a date range: verification is
 * complete (billing_status='verified') AND at least one line was removed for
 * reason exactly 'Stock Out'. Returns each order with its verified items and
 * its stock-out items separated, plus enough identifying info (shop, route,
 * sales rep, order ref) per spec. Filtered by billing_verified_at, matching
 * how the rest of Billing's date-based views work.
 */
export async function loadPartialVerifications(fromISO, toISO) {
  const { data, error } = await supabase
    .from('orders')
    .select(`
      id, shop_name, route, sales_rep_id, billing_verified_at, order_date,
      order_items ( id, product_name, qty, unit, removed, change_reason )
    `)
    .eq('billing_status', 'verified')
    .gte('billing_verified_at', fromISO)
    .lte('billing_verified_at', toISO)
  if (error) { console.error('load partial verifications failed', error); return [] }

  const partial = (data || [])
    .map((o) => {
      const items = o.order_items || []
      const stockOut = items.filter((i) => i.removed && i.change_reason === 'Stock Out')
      const verified = items.filter((i) => !i.removed)
      return { ...o, stockOutItems: stockOut, verifiedItems: verified }
    })
    .filter((o) => o.stockOutItems.length > 0 && o.verifiedItems.length > 0)

  // Attach rep display names in one batch (small, bounded list).
  const repIds = [...new Set(partial.map((o) => o.sales_rep_id).filter(Boolean))]
  if (repIds.length) {
    const { data: reps } = await supabase.from('profiles').select('id, full_name').in('id', repIds)
    const nameById = new Map((reps || []).map((r) => [r.id, r.full_name]))
    partial.forEach((o) => { o.sales_rep_name = nameById.get(o.sales_rep_id) || '—' })
  }

  return partial.sort((a, b) => new Date(b.billing_verified_at) - new Date(a.billing_verified_at))
}

// ===========================================================================
// PRICE APPROVAL (Admin) — every special/custom-priced order line
// ===========================================================================

/** All order lines awaiting Admin sign-off, newest first, with shop/rep context. */
export async function loadPendingApprovals() {
  const { data, error } = await supabase
    .from('order_items')
    .select(`
      id, product_name, qty, unit, unit_price, normal_price, price_type, edited_at,
      order_id, orders!inner ( id, shop_name, route, order_date, sales_rep_id, created_at )
    `)
    .eq('approval_status', 'pending')
    .order('id', { ascending: false })
  if (error) { console.error('load pending approvals failed', error); return [] }
  const rows = (data || []).filter((r) => r.orders)
  const repIds = [...new Set(rows.map((r) => r.orders.sales_rep_id).filter(Boolean))]
  if (repIds.length) {
    const { data: reps } = await supabase.from('profiles').select('id, full_name').in('id', repIds)
    const nameById = new Map((reps || []).map((r) => [r.id, r.full_name]))
    rows.forEach((r) => { r.sales_rep_name = nameById.get(r.orders.sales_rep_id) || '—' })
  }
  return rows
}

/** Just the count — cheap, for the sidebar badge. */
export async function countPendingApprovals() {
  const { count, error } = await supabase
    .from('order_items')
    .select('id', { count: 'exact', head: true })
    .eq('approval_status', 'pending')
  if (error) { console.error('count pending approvals failed', error); return 0 }
  return count || 0
}

/** Approve a special-priced line — it becomes normally billable immediately. */
export async function approveSpecialPrice(itemId, adminName, adminId) {
  const { error } = await supabase
    .from('order_items')
    .update({ approval_status: 'approved', approved_by: adminName || null, approved_by_id: adminId || null, approved_at: new Date().toISOString() })
    .eq('id', itemId)
    .eq('approval_status', 'pending') // idempotency guard
  if (error) throw error
}

/** Reject a special-priced line — permanently excluded from billing with a reason. */
export async function rejectSpecialPrice(itemId, adminName, adminId, reason) {
  const { error } = await supabase
    .from('order_items')
    .update({ approval_status: 'rejected', approved_by: adminName || null, approved_by_id: adminId || null, approved_at: new Date().toISOString(), approval_reason: reason || null })
    .eq('id', itemId)
    .eq('approval_status', 'pending')
  if (error) throw error
}
