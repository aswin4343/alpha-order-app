import { supabase } from './supabase.js'

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
  // Match on shop name + route to avoid duplicates across reps.
  const { data: existing } = await supabase
    .from('customers')
    .select('id')
    .eq('shop_name', customer.name)
    .eq('route', customer.route || '')
    .limit(1)
    .maybeSingle()

  if (existing?.id) return existing.id

  const { data, error } = await supabase
    .from('customers')
    .insert({
      shop_name: customer.name,
      route: customer.route || '',
      category: customer.category || '',
      created_by: userId,
      is_rep_created: repCreated
    })
    .select('id')
    .single()
  if (error) {
    console.error('cloud customer insert failed', error)
    return null
  }
  return data.id
}

/** Save an order + its items. Returns the new order id (or null on failure). */
export async function saveCloudOrder({ customer, brand, userId, items, location }) {
  const cloudCustomerId = await ensureCloudCustomer(customer, userId)

  const totalProducts = items.length
  const totalQuantity = items.reduce((s, i) => s + i.qty, 0)

  const { data: order, error } = await supabase
    .from('orders')
    .insert({
      customer_id: cloudCustomerId,
      shop_name: customer.name,
      route: customer.route || '',
      brand: brand || '',
      sales_rep_id: userId,
      total_products: totalProducts,
      total_quantity: totalQuantity,
      latitude: location?.latitude ?? null,
      longitude: location?.longitude ?? null
    })
    .select('id')
    .single()

  if (error) {
    console.error('cloud order insert failed', error)
    return null
  }

  const rows = items.map((i) => ({
    order_id: order.id,
    product_name: i.name,
    qty: i.qty,
    unit: i.unit || 'Piece',
    is_addon: !!i.isAddon
  }))
  const { error: itemsErr } = await supabase.from('order_items').insert(rows)
  if (itemsErr) console.error('cloud order_items insert failed', itemsErr)

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
    .order('created_at', { ascending: false })
    .limit(10)
  if (error) {
    console.error('load previous orders failed', error)
    return []
  }
  return data || []
}

/**
 * Personal performance counts for the logged-in rep.
 * Returns orders + visits totals for today / this week / this month.
 */
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
      .select('id, total_quantity, shop_name, created_at')
      .eq('sales_rep_id', userId),
    supabase
      .from('visits')
      .select('id, created_at')
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

  const countOrders = (start) => orders.filter((o) => inRange(o.created_at, start)).length
  const countQty = (start) =>
    orders.filter((o) => inRange(o.created_at, start)).reduce((s, o) => s + (o.total_quantity || 0), 0)
  const countVisits = (start) => visits.filter((v) => inRange(v.created_at, start)).length
  const countShops = (start) =>
    new Set(orders.filter((o) => inRange(o.created_at, start)).map((o) => o.shop_name)).size
  const countNewCustomers = (start) =>
    customers.filter((c) => inRange(c.created_at, start)).length

  const block = (start) => ({
    orders: countOrders(start),
    quantity: countQty(start),
    visits: countVisits(start),
    shops: countShops(start),
    newCustomers: countNewCustomers(start)
  })

  return {
    today: block(startOfToday),
    week: block(startOfWeek),
    month: block(startOfMonth),
    totalOrders: orders.length,
    totalVisits: visits.length,
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
export async function loadAdminDashboard() {
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const dow = (now.getDay() + 6) % 7
  const startOfWeek = new Date(startOfToday)
  startOfWeek.setDate(startOfToday.getDate() - dow)
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)

  const [profilesRes, ordersRes, visitsRes, custRes] = await Promise.all([
    supabase.from('profiles').select('id, full_name, role, route').eq('role', 'salesperson'),
    supabase.from('orders').select('id, sales_rep_id, shop_name, total_quantity, created_at'),
    supabase.from('visits').select('id, sales_rep_id, created_at'),
    supabase.from('customers').select('id, created_by, created_at, is_rep_created')
  ])

  const profiles = profilesRes.data || []
  const orders = ordersRes.data || []
  const visits = visitsRes.data || []
  const customers = custRes.data || []

  const inRange = (iso, start) => new Date(iso) >= start

  const statsFor = (repId, start) => {
    const o = orders.filter((x) => x.sales_rep_id === repId && inRange(x.created_at, start))
    const v = visits.filter((x) => x.sales_rep_id === repId && inRange(x.created_at, start))
    const ns = customers.filter(
      (c) => c.created_by === repId && c.is_rep_created && inRange(c.created_at, start)
    )
    const quantity = o.reduce((s, x) => s + (x.total_quantity || 0), 0)
    const shops = new Set(o.map((x) => x.shop_name)).size
    return {
      orders: o.length,
      quantity,
      shops,
      visits: v.length,
      newShops: ns.length,
      score: combinedScore({ orders: o.length, newShops: ns.length, visits: v.length, quantity })
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
  const teamToday = reps.reduce(
    (acc, r) => ({
      orders: acc.orders + r.today.orders,
      visits: acc.visits + r.today.visits
    }),
    { orders: 0, visits: 0 }
  )

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

  return { reps, teamMonth, teamToday, activity }
}
