import { supabase } from './supabase.js'

// ---------------------------------------------------------------------------
// Cloud sync helpers for Phase 3A.
// Privacy: only shop_name + route go to the cloud for customers — never the
// phone / GST / address, which stay in local IndexedDB on the device.
// ---------------------------------------------------------------------------

/** Ensure a cloud customer row exists for this shop; returns its cloud id. */
export async function ensureCloudCustomer(customer, userId) {
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
      created_by: userId
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

  const [ordersRes, visitsRes] = await Promise.all([
    supabase
      .from('orders')
      .select('id, total_quantity, shop_name, created_at')
      .eq('sales_rep_id', userId),
    supabase
      .from('visits')
      .select('id, created_at')
      .eq('sales_rep_id', userId)
  ])

  const orders = ordersRes.data || []
  const visits = visitsRes.data || []

  const inRange = (iso, start) => new Date(iso) >= start

  const countOrders = (start) => orders.filter((o) => inRange(o.created_at, start)).length
  const countQty = (start) =>
    orders.filter((o) => inRange(o.created_at, start)).reduce((s, o) => s + (o.total_quantity || 0), 0)
  const countVisits = (start) => visits.filter((v) => inRange(v.created_at, start)).length
  const countShops = (start) =>
    new Set(orders.filter((o) => inRange(o.created_at, start)).map((o) => o.shop_name)).size

  const block = (start) => ({
    orders: countOrders(start),
    quantity: countQty(start),
    visits: countVisits(start),
    shops: countShops(start)
  })

  return {
    today: block(startOfToday),
    week: block(startOfWeek),
    month: block(startOfMonth),
    totalOrders: orders.length,
    totalVisits: visits.length
  }
}
