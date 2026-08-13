import { supabase } from './supabase.js'
import { schemeText } from './productDiff.js'

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
export async function saveCloudOrder({ customer, brand, userId, items, location, orderDate, route }) {
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

  // Order value: sum of (effective price × qty). Uses the item's retail (or its
  // override if set), then base, then net; 0 when no price is known.
  const totalValue = items.reduce((s, i) => {
    const price =
      (i.retail != null ? i.retail : null) ??
      (i.base != null ? i.base : null) ??
      (i.netOverride != null ? i.netOverride : null) ??
      0
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
      order_date: orderDate || new Date().toISOString().slice(0, 10),
      latitude: location?.latitude ?? null,
      longitude: location?.longitude ?? null
    })
    .select('id')
    .single()

  if (error) {
    console.error('cloud order insert failed', error)
    return null
  }

  const rows = items.map((i) => {
    // Effective price actually used for this item (same priority as totalValue
    // above), and a human-readable scheme snapshot — captured AT ORDER TIME so
    // future price/scheme changes never rewrite what this order summary shows.
    const effectivePrice =
      (i.retail != null ? i.retail : null) ??
      (i.base != null ? i.base : null) ??
      (i.netOverride != null ? i.netOverride : null) ??
      null
    const schemeSnapshot = schemeText(i)
    return {
      order_id: order.id,
      product_name: i.name,
      qty: i.qty,
      unit: i.unit || 'Piece',
      is_addon: !!i.isAddon,
      unit_price: effectivePrice,
      scheme_applied: schemeSnapshot === 'No scheme' ? null : schemeSnapshot
    }
  })
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
      .eq('sales_rep_id', userId)
      .eq('hidden', false),
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
    supabase
      .from('orders')
      .select('id, sales_rep_id, shop_name, total_quantity, created_at')
      .eq('hidden', false)
      .gte('created_at', startOfMonth.toISOString())
      .order('created_at', { ascending: false })
      .limit(5000),
    supabase
      .from('visits')
      .select('id, sales_rep_id, created_at')
      .gte('created_at', startOfMonth.toISOString())
      .order('created_at', { ascending: false })
      .limit(5000),
    supabase
      .from('customers')
      .select('id, created_by, created_at, is_rep_created')
      .gte('created_at', startOfMonth.toISOString())
      .order('created_at', { ascending: false })
      .limit(5000)
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
  let q = supabase
    .from('deliveries')
    .select('id, order_id, shop_name, route, sales_rep_name, assigned_to, assigned_at, status, qc_status, packed_by, created_at')
    .neq('status', 'cancelled') // hide soft-deleted duplicate deliveries
    .order('created_at', { ascending: false })
    .limit(1500) // safety cap so the dashboard never tries to load everything
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
    failed: groups.filter((d) => d.status === 'failed').length
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

  const [profilesRes, ordersRes, visitsRes, custRes] = await Promise.all([
    supabase.from('profiles').select('id, full_name').eq('role', 'salesperson'),
    withRange(supabase.from('orders').select('id, sales_rep_id, total_quantity, total_value, shop_name, created_at').eq('hidden', false)),
    withRange(supabase.from('visits').select('id, sales_rep_id, created_at')),
    withRange(supabase.from('customers').select('id, created_by, is_rep_created, created_at'))
  ])

  const profiles = profilesRes.data || []
  const orders = ordersRes.data || []
  const visits = visitsRes.data || []
  const customers = custRes.data || []

  const reps = profiles.map((p) => {
    const o = orders.filter((x) => x.sales_rep_id === p.id)
    const v = visits.filter((x) => x.sales_rep_id === p.id)
    const ns = customers.filter((c) => c.created_by === p.id && c.is_rep_created)
    return {
      Salesperson: p.full_name || 'Unnamed',
      Orders: o.length,
      Quantity: o.reduce((s, x) => s + (x.total_quantity || 0), 0),
      'Order Value (Rs)': o.reduce((s, x) => s + (x.total_value || 0), 0),
      'New Shops': ns.length,
      Visits: v.length
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

  const [staffRes, delRes, punchRes] = await Promise.all([
    supabase.from('profiles').select('id, full_name').eq('role', 'delivery_rep'),
    withRange(
      supabase.from('deliveries').select('id, assigned_to, status, completed_at').neq('status', 'cancelled'),
      'completed_at'
    ),
    withRange(
      supabase.from('delivery_punches').select('rep_id, person_name, punch_in, punch_out'),
      'punch_in'
    )
  ])

  const staff = staffRes.data || []
  const dels = (delRes.data || []).filter((d) => d.completed_at) // only completed in range
  const punches = punchRes.data || []

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
export async function loadBillingOrders(repId, deliveryType, status = 'pending', dateStr = null, expressRoute = null) {
  let q = supabase
    .from('orders')
    .select('id, shop_name, route, total_quantity, created_at, order_date, sales_rep_id')
    .eq('sales_rep_id', repId)
    .eq('billing_status', status)
    .eq('hidden', false)
    .order('created_at', { ascending: false })
  // Filter by the chosen order date (order_date) when provided.
  if (dateStr) {
    q = q.eq('order_date', dateStr)
  }
  // For verified without an explicit date, limit to today's verifications.
  if (status === 'verified' && !dateStr) {
    const startToday = new Date(); startToday.setHours(0, 0, 0, 0)
    q = q.gte('billing_verified_at', startToday.toISOString())
  }
  const { data, error } = await q
  if (error) throw error
  let rows = data || []
  if (deliveryType === 'EXP') rows = rows.filter((o) => (o.route || '').toUpperCase().startsWith('EXP'))
  if (deliveryType === 'STD') rows = rows.filter((o) => (o.route || '').toUpperCase().startsWith('STD'))
  // Express route sub-filter (e.g. only "EXP : VARKALA").
  if (expressRoute) {
    const want = expressRoute.toUpperCase().replace(/\s+/g, '')
    rows = rows.filter((o) => (o.route || '').toUpperCase().replace(/\s+/g, '').includes(want))
  }

  // Group into ONE card per shop per day. Multiple orders (incl. add-ons) for
  // the same shop on the same day merge — keep all order ids for the detail view.
  const groups = new Map()
  const order = []
  for (const o of rows) {
    const day = o.order_date || (o.created_at || '').slice(0, 10) // prefer chosen order date
    const key = `${(o.shop_name || '').toUpperCase()}__${day}`
    let g = groups.get(key)
    if (!g) {
      g = {
        id: o.id,               // primary id (most recent, since sorted desc)
        orderIds: [o.id],
        shop_name: o.shop_name,
        route: o.route,
        created_at: o.created_at, // latest order time (first seen = newest)
        orderCount: 1
      }
      groups.set(key, g)
      order.push(g)
    } else {
      g.orderIds.push(o.id)
      g.orderCount += 1
    }
  }
  return order
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
    .select('id, order_id, product_name, qty, unit, is_addon, available, original_qty, change_type, change_reason, original_product_name, removed')
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

/** Edit a product's quantity (keeps original_qty the first time it changes). */
export async function editItemQty(item, newQty, reason) {
  const ids = idsOf(item)
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
}

/** Remove a product from the order (mandatory reason). Keeps the row for audit. */
export async function removeItem(item, reason) {
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
}

/** Replace a product with another (mandatory reason). Keeps original name for audit. */
export async function replaceItem(item, newProductName, reason) {
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
    .select('id, total_quantity, total_value, shop_name, created_at, route')
    .eq('sales_rep_id', userId)
    .eq('hidden', false)
    .gte('created_at', start.toISOString())
    .lte('created_at', end.toISOString())

  let visitsQ = supabase
    .from('visits')
    .select('id, shop_name, created_at, route')
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
  const uniqueShops = new Set([
    ...orders.map((o) => (o.shop_name || '').toUpperCase()),
    ...visits.map((v) => (v.shop_name || '').toUpperCase())
  ])

  return {
    orders: orders.length,
    quantity: orders.reduce((s, o) => s + (o.total_quantity || 0), 0),
    shops: uniqueShops.size,
    visits: visits.length,
    orderValue: orders.reduce((s, o) => s + (o.total_value || 0), 0),
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

/** Shop Visits list for the drill-down (real visit rows, not a derived count). */
export async function loadVisitsList(userId, start, end, route = null) {
  let q = supabase
    .from('visits')
    .select('id, shop_name, route, visit_status, custom_remark, created_at, customer_id')
    .eq('sales_rep_id', userId)
    .gte('created_at', start.toISOString())
    .lte('created_at', end.toISOString())
    .order('created_at', { ascending: false })
  if (route) q = q.eq('route', route)
  const { data, error } = await q
  if (error) throw error
  return data || []
}

/** Orders Taken list for the drill-down (order header + item count/qty/value). */
export async function loadOrdersList(userId, start, end, route = null) {
  let q = supabase
    .from('orders')
    .select('id, shop_name, route, total_products, total_quantity, total_value, created_at, billing_status')
    .eq('sales_rep_id', userId)
    .eq('hidden', false)
    .gte('created_at', start.toISOString())
    .lte('created_at', end.toISOString())
    .order('created_at', { ascending: false })
  if (route) q = q.eq('route', route)
  const { data, error } = await q
  if (error) throw error
  return data || []
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
  let q = supabase
    .from('customers')
    .select('id, shop_name, route, category, created_at')
    .eq('created_by', userId)
    .eq('is_rep_created', true)
    .gte('created_at', start.toISOString())
    .lte('created_at', end.toISOString())
    .order('created_at', { ascending: false })
  if (route) q = q.eq('route', route)
  const { data, error } = await q
  if (error) throw error
  return data || []
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
  return {
    visitedToday: (visitRes.data || []).length > 0,
    ordersToday: orders.length,
    orderValueToday: orders.reduce((s, o) => s + (o.total_value || 0), 0),
    lastOrderAt: orders[0]?.created_at || null,
    orders
  }
}
