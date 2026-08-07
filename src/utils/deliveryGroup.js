// Group deliveries by shop + calendar day. One card = one shop's orders for
// one day. Combines the underlying delivery IDs so completion can mark them all
// together. Approach 1: display/logic grouping (no DB restructure).

function dayKey(iso) {
  const d = new Date(iso)
  // Local YYYY-MM-DD
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate()
  ).padStart(2, '0')}`
}

// Choose an overall status for a shop-day group from its deliveries' statuses.
function groupStatus(statuses) {
  if (statuses.every((s) => s === 'delivered')) return 'delivered'
  if (statuses.every((s) => s === 'failed')) return 'failed'
  if (statuses.some((s) => s === 'partial')) return 'partial'
  if (statuses.some((s) => s === 'delivered' || s === 'partial')) return 'partial'
  if (statuses.some((s) => s === 'in_progress')) return 'in_progress'
  if (statuses.some((s) => s === 'assigned')) return 'assigned'
  return 'pending'
}

/**
 * Group an array of delivery rows by shop_name + day.
 * Returns one entry per shop-day with:
 *  - a stable group id, shop_name, route, day
 *  - deliveryIds: all underlying delivery ids
 *  - orderIds: all underlying order ids
 *  - status: combined status
 *  - created_at: latest order time (for sorting/date filter)
 *  - assigned_to: the assignment (from the latest delivery)
 *  - count: how many orders in the group
 * Keeps any latitude/longitude attached to the first delivery.
 */
export function groupDeliveriesByShopDay(deliveries) {
  const groups = new Map()
  const order = []
  deliveries.forEach((d) => {
    const key = `${(d.shop_name || '').toUpperCase()}__${dayKey(d.created_at)}`
    let g = groups.get(key)
    if (!g) {
      g = {
        id: key,
        shop_name: d.shop_name,
        route: d.route,
        sales_rep_name: d.sales_rep_name,
        day: dayKey(d.created_at),
        deliveryIds: [],
        orderIds: [],
        statuses: [],
        created_at: d.created_at,
        assigned_to: d.assigned_to ?? null,
        assigned_at: d.assigned_at ?? null,
        qc_status: d.qc_status ?? 'qc_verified',
        packed_by: d.packed_by ?? null,
        latitude: d.latitude ?? null,
        longitude: d.longitude ?? null,
        count: 0
      }
      groups.set(key, g)
      order.push(g)
    }
    g.deliveryIds.push(d.id)
    if (d.order_id) g.orderIds.push(d.order_id)
    g.statuses.push(d.status)
    // Group QC status: pending if any pending, else in_progress if any in progress.
    if (d.qc_status === 'qc_pending') g.qc_status = 'qc_pending'
    else if (d.qc_status === 'in_progress' && g.qc_status !== 'qc_pending') g.qc_status = 'in_progress'
    else if (d.qc_status === 'qc_returned' && !['qc_pending','in_progress'].includes(g.qc_status)) g.qc_status = 'qc_returned'
    if (d.packed_by && !g.packed_by) g.packed_by = d.packed_by
    g.count += 1
    // Keep the latest order time and its assignment.
    if (new Date(d.created_at) > new Date(g.created_at)) {
      g.created_at = d.created_at
      g.assigned_to = d.assigned_to ?? g.assigned_to
      g.assigned_at = d.assigned_at ?? g.assigned_at
    }
    // Prefer any available location.
    if (g.latitude == null && d.latitude != null) {
      g.latitude = d.latitude
      g.longitude = d.longitude
    }
  })
  order.forEach((g) => {
    g.status = groupStatus(g.statuses)
  })
  return order
}

export { dayKey }
