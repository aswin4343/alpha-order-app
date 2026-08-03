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
    // If the is_rep_created column doesn't exist yet (older DB), retry without it
    // so the customer still saves to the cloud (name + route are what matter).
    if (String(error.message || '').toLowerCase().includes('is_rep_created')) {
      const retry = await supabase
        .from('customers')
        .insert({
          shop_name: customer.name,
          route: customer.route || '',
          category: customer.category || '',
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
    net: p.net || []
  }))
}

/**
 * REPLACE-ALL upload (admin only). Wipes the products table and inserts the
 * given list, then bumps the catalogue version so reps know to re-download.
 * Inserts in chunks to stay within request limits.
 */
export async function replaceAllCloudProducts(products) {
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
    sort_order: idx
  }))
  const chunk = 500
  for (let i = 0; i < rows.length; i += chunk) {
    const { error } = await supabase.from('products').insert(rows.slice(i, i + chunk))
    if (error) throw error
  }

  // 3. bump version
  const meta = await getCatalogueMeta()
  const nextVersion = (meta?.version || 0) + 1
  const { error: metaErr } = await supabase
    .from('catalogue_meta')
    .update({ version: nextVersion, product_count: rows.length, updated_at: new Date().toISOString() })
    .eq('id', 1)
  if (metaErr) throw metaErr

  return { count: rows.length, version: nextVersion }
}

// ---------------------------------------------------------------------------
// SALESPERSON MANAGEMENT (admin) — rename display names.
// Login id/password are unchanged; only the shown name updates.
// ---------------------------------------------------------------------------

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
export async function sendAnnouncement({ title, body, highPriority, audience, repIds }) {
  const uid = await currentUserId()
  const { data: ann, error } = await supabase
    .from('announcements')
    .insert({
      title,
      body: body || '',
      high_priority: !!highPriority,
      audience,
      created_by: uid
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
    .select('id, read_at, announcements(id, title, body, high_priority, created_at)')
    .eq('rep_id', uid)
    .order('read_at', { ascending: true, nullsFirst: true })
  if (error) throw error
  const list = (data || [])
    .filter((r) => r.announcements)
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
  const { count, error } = await supabase
    .from('announcement_recipients')
    .select('id', { count: 'exact', head: true })
    .eq('rep_id', uid)
    .is('read_at', null)
  if (error) return 0
  return count || 0
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
  let q = supabase
    .from('deliveries')
    .select('id, order_id, shop_name, route, sales_rep_name, assigned_to, assigned_at, status, created_at')
    .order('created_at', { ascending: false })
  if (routeFilter) q = q.eq('route', routeFilter)
  if (dateFilter) {
    // dateFilter is a 'YYYY-MM-DD' string — show only that day's deliveries.
    const start = new Date(`${dateFilter}T00:00:00`)
    const end = new Date(`${dateFilter}T23:59:59.999`)
    q = q.gte('created_at', start.toISOString()).lte('created_at', end.toISOString())
  }
  const { data, error } = await q
  if (error) throw error
  const deliveries = data || []

  const counts = {
    total: deliveries.length,
    pending: deliveries.filter((d) => d.status === 'pending').length,
    assigned: deliveries.filter((d) => d.status === 'assigned').length,
    in_progress: deliveries.filter((d) => d.status === 'in_progress').length,
    delivered: deliveries.filter((d) => d.status === 'delivered').length,
    partial: deliveries.filter((d) => d.status === 'partial').length,
    failed: deliveries.filter((d) => d.status === 'failed').length
  }

  // Distinct routes for the filter dropdown.
  const routes = Array.from(new Set(deliveries.map((d) => d.route).filter(Boolean))).sort()

  // Group into one entry per shop per day, attach location, sort nearest-first.
  try {
    const names = [...new Set(deliveries.map((d) => d.shop_name))]
    const locs = await fetchShopLocations(names)
    const { sortByHubDistance } = await import('./geo.js')
    const { groupDeliveriesByShopDay } = await import('./deliveryGroup.js')
    const withLoc = deliveries.map((d) => {
      const l = locs[(d.shop_name || '').toUpperCase()]
      return { ...d, latitude: l?.latitude ?? null, longitude: l?.longitude ?? null }
    })
    const grouped = groupDeliveriesByShopDay(withLoc)
    return { deliveries: sortByHubDistance(grouped), counts, routes }
  } catch (e) {
    console.error('admin grouping/sort failed', e)
    const { groupDeliveriesByShopDay } = await import('./deliveryGroup.js')
    return { deliveries: groupDeliveriesByShopDay(deliveries), counts, routes }
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

  // Seed from the order's items.
  const { data: orderItems, error: oiErr } = await supabase
    .from('order_items')
    .select('product_name, qty, unit')
    .eq('order_id', delivery.order_id)
  if (oiErr) throw oiErr

  const rows = (orderItems || []).map((oi) => ({
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
      .select('id, shop_name, route, category, created_at')
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
      .select('product_name, qty, unit')
      .eq('order_id', orderId)
    const rows = (orderItems || []).map((oi) => ({
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
  return allItems
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
