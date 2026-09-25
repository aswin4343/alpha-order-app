import { supabase } from './supabase.js'
import { schemeText } from './productDiff.js'
import { calculateScheme } from './schemes.js'
import { PRICE_APPROVAL_ENABLED } from './featureFlags.js'

// Matches BillingDashboard.jsx's own definition — used below to distinguish
// "viewing the default Today tab" from "explicitly browsing a specific past
// date via the date picker". Kept as a plain local calculation rather than
// imported, since it has no other dependency.
const todayIST = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })

// Billing Dashboard "Pending" is a working view of RECENT unverified orders, not
// an archive. Orders whose order_date is older than this window drop OUT of the
// dashboard's pending list and pending counts — they are NOT deleted, hidden, or
// changed in any way, and every historical feature (Loading Sheet, Partial
// Verification, Edit History, Deleted Bills, reports) reads its own separate
// queries and is completely unaffected. Only loadBillingReps + loadBillingOrders
// (used solely by the Billing/Admin dashboards) apply this window.
const PENDING_DASHBOARD_WINDOW_DAYS = 5
// Inclusive cutoff date (YYYY-MM-DD, IST): the oldest order_date still shown.
// today − (N−1) days => a 5-day inclusive window (e.g. today Sep 9 -> Sep 5).
function pendingWindowCutoffDate() {
  const parts = todayIST().split('-').map(Number)          // [Y, M, D] in IST
  const d = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]))
  d.setUTCDate(d.getUTCDate() - (PENDING_DASHBOARD_WINDOW_DAYS - 1))
  return d.toISOString().slice(0, 10)
}

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
export async function saveCloudOrder({ customer, brand, userId, items, location, orderDate, route, isNewCustomer, introDetails, isAddon, isWholesaleCustomer, isApprovalRequest }) {
  // Populate the runtime approval cache before writing order items — this is
  // what makes the toggle take effect on the NEXT order after admin changes it.
  await isApprovalEnabled()
  const cloudCustomerId = await ensureCloudCustomer(customer, userId)
  // Per-order route: use the chosen route if provided, else the customer default.
  // NOTE: this never overwrites the customer's default route in the DB.
  const orderRoute = (route != null && route !== '') ? route : (customer.route || '')

  const totalProducts = items.length
  const totalQuantity = items.reduce((s, i) => s + i.qty, 0)


  // ---- Sell-by unit validation ------------------------------------------
  // IMPORTANT: i.unit is always 'Piece' (converted for billing).
  // We must check i.entered_unit (the rep's original selection) instead.
  try {
    for (const i of items) {
      const u = ((i.entered_unit || i.unit) || 'Piece').toLowerCase()
      const anyAllowed = i.sell_by_piece === true || i.sell_by_outer === true || i.sell_by_box === true
      const anyRestricted = i.sell_by_piece === false || i.sell_by_outer === false || i.sell_by_box === false
      const flagsManaged = anyAllowed && anyRestricted
      if (!flagsManaged) continue
      if (u === 'piece' && i.sell_by_piece === false)
        throw new Error(`${i.name} cannot be sold by Piece. Please select Outer or Box.`)
      if (u === 'outer' && i.sell_by_outer === false)
        throw new Error(`${i.name} cannot be sold by Outer. Please select a valid unit.`)
      if (u === 'box' && i.sell_by_box === false)
        throw new Error(`${i.name} cannot be sold by Box. Please select a valid unit.`)
    }
  } catch (sellByErr) {
    const msg = sellByErr.message || ''
    const isValidationError = msg.includes('cannot be sold by')
    if (isValidationError) throw sellByErr
    console.warn('sell_by validation skipped (infrastructure):', msg)
  }
  // ---- Duplicate guard --------------------------------------------------
  // Two checks:
  //
  // 1. EXACT DUPLICATE: same products & quantities already exist today for
  //    this shop. This is a double-submit (rep re-tapped Copy Order). Block it.
  //
  // 2. ONE-NORMAL-ROUTE-BILL-PER-SHOP-PER-DAY: if a non-special route order
  //    already exists today for this shop AND the new order also uses a
  //    non-special route, block it. STORE-COUNTER is exempt.
  //
  // Add-ons are intentional additions to an existing bill — they must NEVER
  // be blocked by either guard. isAddon is passed explicitly from AddOnFlowModal.
  if (!isAddon) {
  const isSpecialChannel = (r) => {
    const up = (r || '').trim().toUpperCase()
    return up === 'STORE-COUNTER'
  }
  try {
    // CRITICAL: compare against order_date (the business date the rep selected),
    // NOT created_at (the wall-clock time the order was saved).
    //
    // Using created_at caused this bug:
    //   Rep has an order for Shop A on 16/09 (created today).
    //   Rep creates a NEW order for Shop A on 17/09 (different business date).
    //   Old guard used .gte('created_at', startToday) → found the 16/09 order
    //   → wrongly blocked the 17/09 order as a "duplicate".
    //
    // The one-shop-per-day rule is: one normal-route bill per shop per BUSINESS
    // DATE. Two orders on different dates are always separate — even if both
    // were created (created_at) on the same calendar day.
    const newOrderDate = orderDate ||
      new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })

    const { data: sameDate } = await supabase
      .from('orders')
      .select('id, shop_name, route, order_date, order_items(product_name, qty)')
      .eq('sales_rep_id', userId)
      .eq('shop_name', customer.name)
      .eq('order_date', newOrderDate)   // ← business date, not wall-clock date
      .eq('hidden', false)

    // 1. EXACT DUPLICATE: same products & quantities on the SAME business date.
    //    This is a double-submit (rep re-tapped Copy Order).
    const fingerprint = (list) =>
      (list || [])
        .map((r) => `${(r.product_name || r.name || '').trim().toUpperCase()}::${r.qty}`)
        .sort()
        .join('|')
    const mine = fingerprint(items)
    const matchingOrder = (sameDate || []).find((o) => fingerprint(o.order_items) === mine)
    const isDup = !!matchingOrder
    if (isDup) {
      // APPROVAL REQUEST SPECIAL CASE: when the rep is re-submitting ONLY to
      // request Admin approval (they sent the order first via "Send", then
      // triggered the price-increase modal via "Copy" and tapped "Request Admin
      // Approval"), the duplicate guard would normally block the re-submit and
      // leave the existing order_items with approval_status=null — invisible to
      // Admin. Instead of blocking, find the existing order and promote its
      // special-priced items to approval_status='pending' so Admin can act on them.
      if (isApprovalRequest && matchingOrder) {
        const approvalEnabled = _runtimeApprovalEnabled !== false && PRICE_APPROVAL_ENABLED
        if (approvalEnabled) {
          const specialProductNames = new Set(
            items
              .filter((i) => {
                const ep = i.finalSellingPrice != null ? i.finalSellingPrice : null
                if (ep == null || i.normalPrice == null) return false
                return ep !== i.normalPrice
                  && !(i.isBoxUnit && ep >= (i.wholesaleAtOrderTime ?? ep))
                  && !(isWholesaleCustomer && i.wholesaleAtOrderTime != null && Math.abs(ep - i.wholesaleAtOrderTime) < 0.001)
              })
              .map((i) => (i.name || '').trim().toUpperCase())
          )
          if (specialProductNames.size > 0) {
            await supabase
              .from('order_items')
              .update({ approval_status: 'pending' })
              .eq('order_id', matchingOrder.id)
              .in('product_name', [...specialProductNames].map((n) =>
                // find the original-case product name for each upper-cased key
                items.find((i) => (i.name || '').trim().toUpperCase() === n)?.name || n
              ))
              .is('approval_status', null)   // only promote undecided items
            console.log('Approval request: promoted', specialProductNames.size, 'special-price item(s) to pending on order', matchingOrder.id)
          }
        }
        return matchingOrder.id  // return the existing order id so the caller can proceed normally
      }
      console.log('Duplicate order detected — skipping save.')
      return 'DUPLICATE'
    }

    // 2. ONE-NORMAL-ROUTE-BILL-PER-SHOP-PER-BUSINESS-DATE.
    //    STORE-COUNTER is exempt (always a new separate bill).
    //    A different order_date is ALWAYS a different order — no blocking.
    if (!isSpecialChannel(orderRoute)) {
      const normalRouteOnSameDate = (sameDate || []).some((o) => !isSpecialChannel(o.route))
      if (normalRouteOnSameDate) {
        // APPROVAL REQUEST: promote special-price items on ANY matching order for this
        // shop today, then return without creating a new order (same as the exact-dup path).
        if (isApprovalRequest) {
          const approvalEnabled = _runtimeApprovalEnabled !== false && PRICE_APPROVAL_ENABLED
          if (approvalEnabled) {
            const existingNormal = (sameDate || []).find((o) => !isSpecialChannel(o.route))
            if (existingNormal) {
              const specialProductNames = items
                .filter((i) => {
                  const ep = i.finalSellingPrice != null ? i.finalSellingPrice : null
                  if (ep == null || i.normalPrice == null) return false
                  return ep !== i.normalPrice
                    && !(i.isBoxUnit && ep >= (i.wholesaleAtOrderTime ?? ep))
                    && !(isWholesaleCustomer && i.wholesaleAtOrderTime != null && Math.abs(ep - i.wholesaleAtOrderTime) < 0.001)
                })
                .map((i) => i.name)
              if (specialProductNames.length > 0) {
                await supabase
                  .from('order_items')
                  .update({ approval_status: 'pending' })
                  .eq('order_id', existingNormal.id)
                  .in('product_name', specialProductNames)
                  .is('approval_status', null)
              }
              return existingNormal.id
            }
          }
        }
        console.log('Normal-route order already exists for this shop on', newOrderDate, '— blocking.')
        return 'DUPLICATE'
      }
    }
  } catch (e) {
    // If the check fails, fall through and save normally (never block a sale).
    console.error('duplicate check failed', e)
  }
  } // end if (!isAddon)

  // Order value: sum of (Final Selling Price × qty). Final Selling Price is
  // whatever the rep manually edited (any price field), or Retail Price if
  // nothing was edited — computed once in OrderPage per the exact priority
  // rule, never re-derived here with a different (and wrong) priority.
  const totalValue = items.reduce((s, i) => {
    const price = i.finalSellingPrice != null ? i.finalSellingPrice : 0
    return s + price * (i.qty || 0)
  }, 0)

  // Determine if this order needs bill-level approval gating.
  //
  // DESIGN (v199): There are TWO distinct approval concepts:
  //
  //   1. Item-level: order_items.approval_status = 'pending'
  //      Set on any item where isSpecial=true. This is the Admin notification
  //      mechanism — Admin can see and approve/reject individual items.
  //      The order still reaches Billing normally (billing_status='pending').
  //
  //   2. Bill-level: orders.billing_status = 'pending_approval'
  //      Hides the ENTIRE ORDER from Billing until Admin explicitly releases it.
  //      This should ONLY fire when the rep explicitly clicked "Request Admin
  //      Approval" (isApprovalRequest=true) — i.e. the rep KNOWS the price is
  //      non-standard and has actively invoked the approval flow.
  //
  // Previously (v189–v198): billNeedsApproval fired whenever any item had
  // isSpecial=true, regardless of whether the rep went through the approval
  // flow. This caused the bug: a rep could place an order with a special-price
  // item (e.g. last price ₹17.5 vs normal ₹18) WITHOUT clicking the approval
  // banner — the order got billing_status='pending_approval' and was COMPLETELY
  // hidden from Billing, even though the rep never intended to request approval.
  //
  // Fix (v199): billing_status='pending_approval' ONLY when isApprovalRequest=true.
  // Item-level approval_status='pending' still fires for isSpecial items, so
  // Admin still sees the price deviation and can act on it — but the order
  // reaches Billing normally, preventing the "order stuck in limbo" failure mode.
  let billNeedsApproval = false
  try {
    const approvalEnabled = await isApprovalEnabled()
    if (approvalEnabled && isApprovalRequest) {
      // Rep explicitly invoked the approval flow → gate the entire bill.
      billNeedsApproval = items.some((i) => {
        const ep = i.finalSellingPrice != null ? i.finalSellingPrice : null
        if (ep == null || i.normalPrice == null) return false
        // Exact isSpecial formula — same as order_items insert (~line 424):
        if (ep === i.normalPrice) return false
        if (i.isBoxUnit && ep >= (i.wholesaleAtOrderTime ?? ep)) return false
        if (isWholesaleCustomer && i.wholesaleAtOrderTime != null && Math.abs(ep - i.wholesaleAtOrderTime) < 0.001) return false
        return true  // ep !== normalPrice with no valid exemption → bill-level gate
      })
    }
    // When isApprovalRequest=false: individual items still get approval_status='pending'
    // (see order_items insert below) so Admin is notified — but the order reaches
    // Billing normally. This is intentional: never silently hide an order the rep
    // didn't know needed approval.
  } catch (e) {
    // Never block order saving due to approval engine errors
    console.warn('bill approval check failed (non-fatal):', e.message)
    billNeedsApproval = false
  }

  // [PRICE APPROVAL] Debug: log what is about to be saved
  const _pendingItems = items.filter((i) => {
    const ep = i.finalSellingPrice != null ? i.finalSellingPrice : null
    if (ep == null || i.normalPrice == null) return false
    const diff = ep !== i.normalPrice
    if (!diff) return false
    if (i.isBoxUnit && ep >= (i.wholesaleAtOrderTime ?? ep)) return false
    if (isWholesaleCustomer && i.wholesaleAtOrderTime != null && Math.abs(ep - i.wholesaleAtOrderTime) < 0.001) return false
    return true
  })
  if (_pendingItems.length > 0) {
    console.log('[PRICE APPROVAL] Saving order with', _pendingItems.length, 'special-price item(s):',
      _pendingItems.map(i => `${i.name}: normalPrice=₹${i.normalPrice} effectivePrice=₹${i.finalSellingPrice}`))
    console.log('[PRICE APPROVAL] billNeedsApproval:', billNeedsApproval, '| isApprovalRequest:', isApprovalRequest, '| runtimeApprovalEnabled:', _runtimeApprovalEnabled, '| PRICE_APPROVAL_ENABLED:', PRICE_APPROVAL_ENABLED)
  }

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
      // Bill-level approval (requires SQL migration 63_price_versioning.sql).
      // When not migrated, billNeedsApproval is always false (see above guard),
      // so billing_status always stays 'pending' — orders reach Billing normally.
      // billing_status: always 'pending' unless bill-level approval is active.
      // bill_approval_required column is ONLY included in insert if it already
      // exists (i.e. 63_price_versioning.sql has been run). Sending an unknown
      // column to Supabase causes a 400 error that returns null from this
      // function — which was the root cause of orders not saving.
      billing_status: billNeedsApproval ? 'pending_approval' : 'pending',
      // New-customer intro: stored ONLY on this order (never on the customer
      // record), and only when this genuinely is their first order — see
      // isIntroPending/clearIntro in AppContext, the existing "first order"
      // detection this reuses rather than duplicating.
      is_new_customer: !!isNewCustomer,
      intro_phone: isNewCustomer ? (introDetails?.phone || null) : null,
      intro_gstn: isNewCustomer ? (introDetails?.gstn || null) : null,
      intro_credit_days: isNewCustomer ? (introDetails?.creditDays || null) : null,
      intro_email: isNewCustomer ? (introDetails?.email || null) : null,
      intro_area: isNewCustomer ? (introDetails?.area || null) : null,
      intro_category: isNewCustomer ? (introDetails?.category || null) : null,
      intro_ledger_category: isNewCustomer ? (introDetails?.ledgerCategory || null) : null
    })
    .select('id')
    .single()

  if (error) {
    console.error('cloud order insert failed', error)
    throw new Error('Order could not be saved: ' + (error.message || error.code || 'database error'))
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
    // a price field happens to be populated. Three exemptions:
    //   (a) Box unit at or above wholesale → normal wholesale sale
    //   (b) Wholesale customer at exactly the wholesale price → not special
    const isSpecial = i.normalPrice != null && effectivePrice != null && effectivePrice !== i.normalPrice
      && !(i.isBoxUnit && effectivePrice >= (i.wholesaleAtOrderTime ?? effectivePrice))
      && !(isWholesaleCustomer && i.wholesaleAtOrderTime != null && Math.abs(effectivePrice - i.wholesaleAtOrderTime) < 0.001)
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
      // no workflow applies to them. Controlled by the runtime toggle in
      // Admin → Price Approvals (stored in app_settings.price_approval_enabled).
      approval_status: (_runtimeApprovalEnabled !== false && PRICE_APPROVAL_ENABLED && isSpecial) ? 'pending' : null,
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
      entered_unit: i.entered_unit ?? null,
      // Price version at the time this order was placed — used by
      // loadCustomerLastPrices to detect stale Last Prices. When the product's
      // price_version is later bumped by a price revision, any Last Price derived
      // from THIS order item will be recognised as belonging to an older version
      // and will require Admin approval before use (v193). Null-safe: items from
      // older code paths that don't carry priceVersion just store null here,
      // which is treated as "unknown version — no staleness check".
      approved_price_version: i.priceVersion ?? null
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

  let { error: itemsErr } = await supabase.from('order_items').insert(rows)

  // approval_status (migration 55) and the entered_qty/entered_unit audit
  // columns come from later migrations. If any of them is missing, Postgres
  // rejects the whole insert and the order saves with ZERO items — it would
  // then reach Billing empty, add-ons included. Strip the optional columns and
  // retry so the order is never lost over a column that only affects
  // reporting.
  if (itemsErr && /approval_status|entered_qty|entered_unit|approved_price_version/i.test(String(itemsErr.message || ''))) {
    console.warn(
      'order_items is missing approval_status/entered_qty/entered_unit/approved_price_version — run ' +
      'sql/55_price_approval.sql (and 42_product_packaging.sql and 63_price_versioning.sql). ' +
      'Saving order items without those columns for now.'
    )
    // eslint-disable-next-line no-unused-vars
    const slimRows = rows.map(({ approval_status, entered_qty, entered_unit, approved_price_version, ...keep }) => keep)
    ;({ error: itemsErr } = await supabase.from('order_items').insert(slimRows))
  }
  if (itemsErr) {
    // The order row committed but its items did NOT. Previously this only
    // logged and returned order.id, so the rep saw success while Billing later
    // found an empty order. Instead: delete the orphan order row and throw, so
    // the order fails cleanly and the rep is prompted to retry.
    console.error('cloud order_items insert failed — rolling back order', itemsErr)
    await supabase.from('orders').delete().eq('id', order.id)
    throw new Error('order_items insert failed: ' + (itemsErr.message || 'unknown error'))
  }

  // [PRICE APPROVAL] Debug: verify items were saved with correct approval_status
  if (_pendingItems.length > 0) {
    console.log('[PRICE APPROVAL] order_items inserted. Checking approval_status in DB for order', order.id)
    supabase.from('order_items').select('id, product_name, unit_price, normal_price, is_special_price, approval_status')
      .eq('order_id', order.id)
      .then(({ data: dbRows, error: dbErr }) => {
        if (dbErr) { console.error('[PRICE APPROVAL] verification query failed:', dbErr.message); return }
        const pendingInDb = (dbRows || []).filter(r => r.approval_status === 'pending')
        console.log('[PRICE APPROVAL] order', order.id, '— items in DB:', (dbRows || []).length,
          '— with approval_status=pending:', pendingInDb.length,
          pendingInDb.length === 0 ? '⚠ NONE PENDING — approval_status column may be missing (run sql/55_price_approval.sql)' : '✅')
        if (dbRows && dbRows.length > 0) {
          dbRows.forEach(r => console.log('[PRICE APPROVAL]  item:', r.product_name, '| unit_price:', r.unit_price, '| normal_price:', r.normal_price, '| is_special_price:', r.is_special_price, '| approval_status:', r.approval_status))
        }
      }).catch(() => {})
  }

  // Notify Admin if any items require price approval AND flip all orders for
  // this shop on this date to pending_approval so Billing Team cannot see them
  // until Admin decides — including the parent order already in Billing queue.
  //
  // IMPORTANT: use the same evaluatePriceApproval-based check as billNeedsApproval
  // above. Do NOT use a naive "effectivePrice !== normalPrice" check — that
  // incorrectly flags every wholesale-priced order (wholesale ≠ retail), which
  // would hide ALL orders from Billing regardless of whether Admin approval is
  // actually needed.
  if ((_runtimeApprovalEnabled !== false && PRICE_APPROVAL_ENABLED) && billNeedsApproval) {
    // Collect the items that genuinely need approval for the Admin notification
    // CRITICAL: use the exact isSpecial formula (same as order_items insert and
    // billNeedsApproval above) so this filter is ALWAYS in sync with which items
    // actually received approval_status='pending'. Previously this used
    // evaluatePriceApproval() for SQL-63 products, which could diverge.
    const approvalNeededItems = items.filter((i) => {
      const ep = i.finalSellingPrice ?? null
      if (ep == null || i.normalPrice == null) return false
      if (ep === i.normalPrice) return false
      if (i.isBoxUnit && ep >= (i.wholesaleAtOrderTime ?? ep)) return false
      if (isWholesaleCustomer && i.wholesaleAtOrderTime != null && Math.abs(ep - i.wholesaleAtOrderTime) < 0.001) return false
      return true  // isSpecial — same as order_items insert
    })
    if (approvalNeededItems.length > 0) {
      notifyAdminPriceApprovalRequired(approvalNeededItems, customer?.name || '', items[0]?.repName || '').catch(() => {})
      // Block ALL orders for this shop on this business date from Billing.
      // This covers the add-on scenario: parent order was already 'pending'
      // in Billing — now it must also be hidden until Admin approves.
      const thisOrderDate = orderDate || new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
      try {
        await supabase.from('orders')
          .update({ billing_status: 'pending_approval', bill_approval_required: true, bill_approval_status: 'pending' })
          .eq('shop_name', customer.name)
          .eq('order_date', thisOrderDate)
          .eq('hidden', false)
          .neq('billing_status', 'verified')
      } catch (e) { console.warn('pending_approval flip (non-fatal):', e) }
    }
  }

  return order.id
}
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
 * so it works whether or not the customer has a cloud customer_id yet.
 *
 * VALIDITY (per the customer-specific Last Price rules): only a SUCCESSFUL sale
 * sets a last price. That means:
 *   • the order is VERIFIED by Billing (not pending/draft/unsent, not deleted,
 *     not hidden) — a price that was only typed into an unsent order must never
 *     become the last price; and
 *   • the specific line was actually sold — a REMOVED / stock-out line is
 *     skipped, since its unit_price was never a real sale.
 * "Most recent" uses the order's verification time (billing_verified_at) when
 * present, falling back to created_at, so the newest genuine sale wins. Ordered
 * newest-first and de-duplicated per product (first/newest price per product
 * wins). No arbitrary row cap, so a product last sold long ago is still found.
 */
export async function loadCustomerLastPrices(shopName, customerId = null) {
  // Last Price = the most recent BILLING-VERIFIED selling price for this
  // customer × product combination.
  //
  // SOURCE OF TRUTH: only orders with billing_status='verified' qualify.
  // Pending, rejected, or deleted orders never update the Last Price.
  //
  // PRICE VALUE: approved_price (set by Admin when a custom price was
  // approved) takes priority over unit_price (the rep's entered price).
  // This ensures the GST-inclusive customer-facing price is always used,
  // not any internally-derived tax-exclusive amount.
  //
  // CUSTOMER MATCHING: prefer customer_id when available (stable UUID, immune
  // to shop name typos/changes). Falls back to shop_name for older rows that
  // pre-date the customer_id column.
  //
  // Route is intentionally NOT filtered — it's irrelevant to "what did we
  // last sell this product for to this customer".
  const DEBUG = true // set to false after Last Price is confirmed working
  const dbg = (...a) => DEBUG && console.log('[LastPrice]', ...a)

  // Only use customerId if it's a real Supabase UUID (8-4-4-4-12 hex).
  // Customer IDs come in three forms from AppContext:
  //   • "c0", "c42" — seed/local-only IDs (no matching UUID in Supabase)
  //   • "cloud_<uuid>" — cloud customers synced to local; strip prefix to get UUID
  //   • "<uuid>" — raw Supabase UUID (rare, but handle it)
  // Passing a non-UUID to Postgres causes a 400 "invalid input syntax for type uuid".
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  let realCustomerId = null
  if (customerId) {
    const raw = String(customerId)
    // Strip "cloud_" prefix that AppContext adds when syncing cloud customers locally
    const candidate = raw.startsWith('cloud_') ? raw.slice(6) : raw
    if (UUID_RE.test(candidate)) realCustomerId = candidate
  }

  dbg('loading for', { shopName, customerId, realCustomerId })

  if (!shopName && !realCustomerId) return {}

  // ── Helper: run one query and return { data, error } ──────────────────────
  const runQuery = async (filter) => {
    const q = supabase
      .from('orders')
      // approved_price_version: the product's price_version at the time this
      // order item was saved. Used here to detect whether the customer's Last
      // Price is stale (the product's version has since been bumped by a price
      // revision), so ProductCard can show the version-mismatch warning and
      // route the line through Admin approval.
      // unit / entered_unit: captured so Last Price is keyed per-unit (Piece vs
      // Box vs Outer have different prices; mixing them is a bug). entered_unit
      // is the rep's original selection before conversion to pieces; unit is the
      // final normalised value. We prefer entered_unit for keying.
      .select('id, shop_name, customer_id, billing_status, order_date, created_at, billing_verified_at, order_items(product_name, unit, entered_unit, unit_price, approved_price, approved_price_version, removed)')
      .eq('hidden', false)
      .eq('billing_status', 'verified')
      // Pre-sort descending so the most-recent order tends to come first over
      // the network. The authoritative sort is the in-memory re-sort below
      // (uses billing_verified_at || order_date || created_at), which handles
      // null billing_verified_at rows correctly regardless of DB ordering.
      .order('created_at', { ascending: false })
    return filter(q)
  }

  // ── Step 1: try real Supabase customer_id ─────────────────────────────────
  let data = [], error = null
  if (realCustomerId) {
    ;({ data, error } = await runQuery((q) => q.eq('customer_id', realCustomerId)))
    if (error) { console.error('[LastPrice] by customer_id failed', error); return {} }
    dbg(`customer_id query → ${(data||[]).length} verified orders`)
  }

  // ── Step 2: fall back to shop_name if customer_id found nothing ────────────
  if ((!data || data.length === 0) && shopName) {
    ;({ data, error } = await runQuery((q) => q.eq('shop_name', shopName)))
    if (error) { console.error('[LastPrice] by shop_name failed', error); return {} }
    dbg(`shop_name fallback → ${(data||[]).length} verified orders`)
  }

  // ── Step 3: if still empty, do a diagnostic query (no status filter) ───────
  if (!data || data.length === 0) {
    dbg('⚠ NO VERIFIED ORDERS FOUND — running diagnostic (all statuses)...')
    const filter = customerId
      ? (q) => q.eq('customer_id', customerId)
      : (q) => q.eq('shop_name', shopName)
    const { data: allOrders } = await filter(
      supabase
        .from('orders')
        .select('id, shop_name, customer_id, billing_status, order_date, created_at')
        .eq('hidden', false)
        .order('created_at', { ascending: false })
        .limit(10)
    )
    dbg('All orders (any status, last 10):', (allOrders || []).map((o) =>
      `id=${o.id.slice(-6)} status=${o.billing_status} date=${o.order_date}`
    ))
    dbg('→ Root cause: no orders have billing_status="verified" for this customer yet.')
    dbg('  Orders must be verified by the Billing team before LAST price appears.')
    return {}
  }

  // ── Step 4: sort by verified time and extract last price per product+unit ────
  const orders = (data || []).slice().sort((a, b) => {
    const ta = new Date(a.billing_verified_at || a.order_date || a.created_at).getTime()
    const tb = new Date(b.billing_verified_at || b.order_date || b.created_at).getTime()
    return tb - ta
  })
  dbg(`Processing ${orders.length} verified orders...`)
  // Returns {
  //   "PRODUCT NAME||Piece": { price, priceVersion, unit },
  //   "PRODUCT NAME||Box":   { price, priceVersion, unit },
  //   "PRODUCT NAME":        { price, priceVersion, unit },  // fallback with no unit (legacy)
  // }
  //
  // Keyed by BOTH product name AND unit (Piece/Box/Outer) because a Box price
  // and a Piece price are completely different values for the same product.
  // A "Piece" last price of ₹275 must not be shown when ordering by Box.
  //
  // The plain product-name key (no unit) is also set as a convenience for older
  // rows that didn't store entered_unit — it holds the most recent price
  // regardless of unit, so legacy product cards that don't pass a unit still
  // get a reasonable value.
  //
  // priceVersion = approved_price_version stored on the order_item at the time
  // the order was saved — tells us which product price_version was current when
  // this Last Price was established. If the product's current price_version no
  // longer matches, the Last Price is stale and requires Admin approval.
  const out = {}
  for (const o of orders) {
    for (const it of o.order_items || []) {
      const nameKey = (it.product_name || '').trim().toUpperCase()
      if (!nameKey) continue
      if (it.removed) continue            // removed/stock-out lines never count
      // approved_price = Admin overrode the price (custom approval flow)
      // unit_price     = what the rep entered / billing accepted as-is
      const price = it.approved_price ?? it.unit_price
      if (price == null) continue
      // entered_unit is the rep's original Piece/Box/Outer choice.
      // unit is the normalised value (same as entered_unit for non-converted orders).
      // Prefer entered_unit (what the rep saw) for the key; fall back to unit.
      const unitVal = (it.entered_unit || it.unit || 'Piece').trim()
      const unitKey = `${nameKey}||${unitVal}`
      const priceVersion = it.approved_price_version ?? null
      const entry = { price, priceVersion, unit: unitVal }
      // Per-unit key (precise): first time we see this product+unit combo wins (newest order)
      if (out[unitKey] == null) {
        out[unitKey] = entry
        dbg(`  [${unitVal}] ${nameKey} → ₹${price} (v${priceVersion ?? '?'}) (order ${o.id.slice(-6)}, date ${o.order_date})`)
      }
      // Plain name key (fallback for legacy / no-unit callers): first entry wins
      if (out[nameKey] == null) {
        out[nameKey] = entry
      }
    }
  }
  dbg(`Result: ${Object.keys(out).length} keys (including per-unit) for ${
    Object.keys(out).filter(k => !k.includes('||')).length} products`)
  return out
}

/**
 * Load per-customer price approvals for a given customer (shop).
 *
 * Returns a map: { [product_id]: { approvedPrice, approvedPriceVersion, status } }
 * Only returns the MOST RECENT 'approved' row per product+customer pair.
 *
 * Used by OrderPage to check whether a rep selecting a LAST price below retail
 * already has a valid Admin approval for this exact product + shop combination
 * (spec §7-9). Without this, the check fell back to the product-level global
 * last_approved_price — which made Shop X's approval valid for Shop Y (spec §8 bug).
 *
 * Requires SQL migration 73_customer_price_approvals.sql.
 * Falls back gracefully (returns {}) if the table doesn't exist yet.
 */
export async function loadCustomerPriceApprovals(customerId) {
  if (!customerId) return {}
  try {
    const { data, error } = await supabase
      .from('customer_price_approvals')
      .select('product_id, approved_price, approved_price_version, status')
      .eq('customer_id', customerId)
      .eq('status', 'approved')
      .order('approved_at', { ascending: false })
    if (error) {
      // Table may not exist yet — non-fatal, fall back to product-level approval
      console.warn('[loadCustomerPriceApprovals] non-fatal:', error.message)
      return {}
    }
    // Deduplicate: keep only the latest approved row per product
    const out = {}
    for (const row of (data || [])) {
      if (!out[row.product_id]) {
        out[row.product_id] = {
          approvedPrice: row.approved_price,
          approvedPriceVersion: row.approved_price_version,
          status: row.status
        }
      }
    }
    return out
  } catch (e) {
    console.warn('[loadCustomerPriceApprovals] fetch failed (non-fatal):', e.message)
    return {}
  }
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
  // order_date, when present, is now the canonical "which day does this row
  // belong to" — matching the field loadPerformanceForDate's orders query
  // filters by. Without this, an order fetched because its order_date is
  // today, but whose created_at falls on a different day (a rescheduled
  // item, an add-on dated separately, a manually backdated order), would be
  // grouped under the WRONG calendar day here — inconsistent with the query
  // that fetched it in the first place. visits rows have no order_date at
  // all, so they fall back to the original created_at-derived day, unchanged.
  const day = row.order_date || istDateStr(row.created_at)
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
  // All member order ids per visit group (original + every add-on), in the
  // order encountered. This is what lets the Order Summary load the COMPLETE
  // merged order for a customer/day instead of only the latest sub-order —
  // the group here is the existing source of truth (customer_id + day via
  // visitKey), so no new relationship is invented.
  const idsByKey = new Map()
  for (const o of orders || []) {
    const key = visitKey(o)
    addonCounts.set(key, (addonCounts.get(key) || 0) + 1)
    const arr = idsByKey.get(key) || []
    if (o.id) arr.push(o.id)
    idsByKey.set(key, arr)
  }
  return Array.from(groups.entries()).map(([key, latest]) => ({
    ...latest,
    isAddon: (addonCounts.get(key) || 1) > 1,
    addonCount: (addonCounts.get(key) || 1) - 1,
    orderIds: idsByKey.get(key) || (latest.id ? [latest.id] : [])
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
    box: p.box ?? null,
    // QT (Without Tax) flag — MUST be carried into the app's product shape, or
    // the Billing view (which reads product.is_qt to highlight QT lines) never
    // sees it even when it's set in the database. This omission was why the
    // yellow QT highlight never appeared despite correct data.
    is_qt: p.is_qt ?? false,
    sell_by_piece: p.sell_by_piece ?? true,
    sell_by_outer: p.sell_by_outer ?? false,
    sell_by_box:   p.sell_by_box   ?? false,
    // Price governance fields
    price_version:       p.price_version ?? 1,
    wholesale_threshold: p.wholesale_threshold ?? p.qty_in_box ?? null,
    last_approved_price:   p.last_approved_price ?? null,
    last_approved_version: p.last_approved_version ?? null,
    price_increased:     p.price_increased ?? false,
    // Price change tracking — used by the "PRICE CHANGED" badge on the product card
    // (spec §11-14). price_changed_at is updated by mergeUpdateCloudProducts whenever
    // retail or wholesale changes. previous_retail/previous_wholesale record what the
    // price was before the last change, for the direction indicator.
    price_changed_at:    p.price_changed_at ?? null,
    previous_retail:     p.previous_retail ?? null,
    previous_wholesale:  p.previous_wholesale ?? null
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
    is_qt: p.is_qt ?? false,
    sell_by_piece: p.sell_by_piece ?? true,
    sell_by_outer: p.sell_by_outer ?? false,
    sell_by_box:   p.sell_by_box   ?? false,
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
    // QT differs from the price fields: because it's a true/false status, a
    // blank in a file that HAS the QT column means "not QT" (unmark), not "no
    // info". So we set is_qt whenever the file carried the QT column at all
    // (_qtColPresent) — allowing both marking and unmarking. Files without the
    // column (old templates) never touch existing QT status.
    if (u._qtColPresent) patch.is_qt = !!u.is_qt
    // Selling-unit permissions: same pattern as QT — only update when the file
    // carried the SELL BY column(s). Blank = not provided, existing value kept.
    // Validate: at least one unit must be YES per product.
    if (u._sellColPresent) {
      const piece = u.sell_by_piece != null ? !!u.sell_by_piece : (target.sell_by_piece ?? true)
      const outer = u.sell_by_outer != null ? !!u.sell_by_outer : (target.sell_by_outer ?? false)
      const box   = u.sell_by_box   != null ? !!u.sell_by_box   : (target.sell_by_box   ?? false)
      if (!piece && !outer && !box) {
        // Validation error — skip this product and surface the problem
        console.warn(`Sell-by validation: ${u.name} has all units set to NO — skipped.`)
        skippedNoData++; continue
      }
      patch.sell_by_piece = piece
      patch.sell_by_outer = outer
      patch.sell_by_box   = box
    }
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
  const nowTs = new Date().toISOString()
  let adminId = null
  try { const { data: u } = await supabase.auth.getUser(); adminId = u?.user?.id || null } catch {}

  const fullRows = updates.map(({ id, patch }) => {
    const cur = byId.get(id) || {}

    // Price change detection — if retail or wholesale changed, bump price_version
    // and invalidate the last_approved_price so old approvals can't be reused.
    const newRetail = patch.retail ?? cur.retail ?? null
    const newWholesale = patch.wholesale ?? cur.wholesale ?? null
    const priceRaised =
      (newRetail != null && cur.retail != null && newRetail > cur.retail) ||
      (newWholesale != null && cur.wholesale != null && newWholesale > cur.wholesale)
    const priceChanged =
      (patch.retail != null && patch.retail !== cur.retail) ||
      (patch.wholesale != null && patch.wholesale !== cur.wholesale)

    const curVersion = Math.round(cur.price_version ?? 1)
    const nextVersion = priceChanged ? curVersion + 1 : curVersion

    return {
      id,
      name: cur.name,
      slabs: patch.slabs ?? cur.slabs ?? [],
      base: patch.base ?? cur.base ?? null,
      mrp: patch.mrp ?? cur.mrp ?? null,
      retail: newRetail,
      wholesale: newWholesale,
      net: patch.net ?? cur.net ?? [],
      gst: patch.gst ?? cur.gst ?? null,
      hsn: patch.hsn ?? cur.hsn ?? null,
      qty_in_box: patch.qty_in_box ?? cur.qty_in_box ?? null,
      outer_qty: patch.outer_qty ?? cur.outer_qty ?? null,
      box: patch.box ?? cur.box ?? null,
      is_qt: patch.is_qt ?? cur.is_qt ?? false,
      sell_by_piece: patch.sell_by_piece ?? cur.sell_by_piece ?? true,
      sell_by_outer: patch.sell_by_outer ?? cur.sell_by_outer ?? false,
      sell_by_box:   patch.sell_by_box   ?? cur.sell_by_box   ?? false,
      // Price versioning
      price_version:    nextVersion,
      price_changed_at: priceChanged ? nowTs : (cur.price_changed_at ?? null),
      price_changed_by: priceChanged ? adminId : (cur.price_changed_by ?? null),
      price_increased:  priceRaised,
      previous_retail:    priceChanged ? (cur.retail ?? null) : (cur.previous_retail ?? null),
      previous_wholesale: priceChanged ? (cur.wholesale ?? null) : (cur.previous_wholesale ?? null),
      // Wholesale threshold defaults to qty_in_box if not explicitly set
      wholesale_threshold: cur.wholesale_threshold != null
        ? Math.round(cur.wholesale_threshold)
        : (patch.qty_in_box != null ? Math.round(patch.qty_in_box) : (cur.qty_in_box != null ? Math.round(cur.qty_in_box) : null)),
      // Invalidate last_approved_price when price version bumps
      last_approved_price:   priceChanged ? null : (cur.last_approved_price ?? null),
      last_approved_version: priceChanged ? null : (cur.last_approved_version != null ? Math.round(cur.last_approved_version) : null),
      last_approved_at:      priceChanged ? null : (cur.last_approved_at ?? null),
      last_approved_by:      priceChanged ? null : (cur.last_approved_by ?? null),
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
export async function sendAnnouncement({ title, body, highPriority, audience, repIds, expiresInDays, notifType, includeBilling, refOrderId }) {
  const uid = await currentUserId()
  // Optional auto-expiry: expires_at = now + N days. Omitted → never expires
  // (preserves the original behaviour for manual announcements).
  const expiresAt =
    expiresInDays != null
      ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString()
      : null
  // Core columns that have always existed on this table.
  const baseRow = {
    title,
    body: body || '',
    high_priority: !!highPriority,
    audience,
    created_by: uid,
    expires_at: expiresAt
  }
  // Optional columns added by later migrations: notif_type (57) decides which
  // action a popup shows, ref_order_id (60) links it to a specific order.
  const optionalRow = { notif_type: notifType || null, ref_order_id: refOrderId || null }

  let ins = await supabase
    .from('announcements')
    .insert({ ...baseRow, ...optionalRow })
    .select('id')
    .single()

  // If those migrations haven't been applied, Postgres rejects the whole
  // insert for an unknown column and NO notification is created at all — the
  // popup then never appears and the failure is invisible. Retry with just the
  // core columns so the notification still reaches the user; it simply falls
  // back to the generic popup action until the migrations are run.
  if (ins.error && /notif_type|ref_order_id/i.test(String(ins.error.message || ''))) {
    console.warn(
      'announcements is missing notif_type/ref_order_id — run sql/57_announcement_notif_type.sql ' +
      'and sql/60_addon_realtime_popup.sql. Sending without them for now.'
    )
    ins = await supabase.from('announcements').insert(baseRow).select('id').single()
  }
  // 'billing' is a newer audience value (migration 57 widens the CHECK
  // constraint to allow it). If that migration hasn't been applied the insert
  // is rejected outright and no notification is created at all. Retry with
  // 'selected', which every version of this table accepts — the actual
  // targeting is done by the explicit recipient rows below, not by this
  // column, so the notification still reaches exactly the right people.
  if (ins.error && /audience|check constraint|violates/i.test(String(ins.error.message || ''))) {
    console.warn(
      "announcements rejected audience='billing' — run sql/57_announcement_notif_type.sql. " +
      "Falling back to 'selected'; recipients are unaffected."
    )
    ins = await supabase
      .from('announcements')
      .insert({ ...baseRow, audience: 'selected', ...optionalRow })
      .select('id')
      .single()
    if (ins.error && /notif_type|ref_order_id/i.test(String(ins.error.message || ''))) {
      ins = await supabase
        .from('announcements')
        .insert({ ...baseRow, audience: 'selected' })
        .select('id')
        .single()
    }
  }

  if (ins.error) {
    // Surface the most common real cause explicitly. Row-level security on a
    // blocked INSERT does not always raise an obvious error, and announcements
    // have historically only ever been written by admins — a sales rep
    // creating an add-on alert is a newer path that needs its own policy.
    console.error(
      'Creating the announcement FAILED. If this is a permissions/RLS error, ' +
      'run sql/61_announcement_insert_permission.sql — sales reps and billing ' +
      'users need INSERT rights on announcements and announcement_recipients.',
      ins.error
    )
    throw ins.error
  }
  const ann = ins.data

  // Determine recipient list.
  let targets = repIds
  if (audience === 'all') {
    // `includeBilling` widens an "all" announcement to the billing team as
    // well as sales reps — used by admin product/price updates, which billing
    // needs to see too. Recipients are stored in the same
    // announcement_recipients table keyed by user id, so billing members get
    // the existing bell badge, list and read/unread state with no separate
    // notification system. Manual announcements leave this off and keep their
    // original sales-rep-only behaviour.
    const roles = includeBilling ? ['salesperson', 'billing_team'] : ['salesperson']
    const { data: reps, error: repErr } = await supabase
      .from('profiles')
      .select('id')
      .in('role', roles)
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
  const FULL = 'id, read_at, announcements(id, title, body, high_priority, created_at, expires_at, notif_type, ref_order_id)'
  const BASE = 'id, read_at, announcements(id, title, body, high_priority, created_at, expires_at)'

  const run = (cols) =>
    supabase
      .from('announcement_recipients')
      .select(cols)
      .eq('rep_id', uid)
      .order('read_at', { ascending: true, nullsFirst: true })

  let res = await run(FULL)
  // Selecting a column that doesn't exist fails the WHOLE query, so if
  // migrations 57/60 haven't been applied the popup receives nothing at all
  // and silently never appears. Fall back to the core columns so
  // notifications still display; they just show the generic action.
  if (res.error && /notif_type|ref_order_id/i.test(String(res.error.message || ''))) {
    console.warn(
      'announcements is missing notif_type/ref_order_id — run sql/57_announcement_notif_type.sql ' +
      'and sql/60_addon_realtime_popup.sql. Loading without them for now.'
    )
    res = await run(BASE)
  }
  const { data, error } = res
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
      notifType: r.announcements.notif_type || null,
      refOrderId: r.announcements.ref_order_id || null,
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
      .select('id, shop_name, route, category, ledger_category, created_at, updated_at, is_active')
      // Most recently CHANGED row first. This matters when a shop has
      // duplicate rows: the sync treats shop_name as the identity key, so the
      // row that was edited most recently must be the one that wins. Ordering
      // by created_at alone let an older duplicate override a freshly saved
      // default route. nullsFirst:false keeps rows without updated_at last.
      .order('updated_at', { ascending: false, nullsFirst: false })
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
  const pendingCutoff = pendingWindowCutoffDate()

  const [repsRes, pendingRes, verifiedRes] = await Promise.all([
    supabase.from('profiles').select('id, full_name').eq('role', 'salesperson'),
    // Include route so we can break down by category (Express/Standard/Store Counter).
    supabase.from('orders').select('sales_rep_id, route').eq('billing_status', 'pending').eq('hidden', false).gte('order_date', pendingCutoff),
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
  const countByRoute = (rows, id, test) => rows.filter((r) => r.sales_rep_id === id && test(r.route || '')).length

  return reps
    .map((r) => ({
      id: r.id,
      name: r.full_name || 'Unnamed',
      pending: countBy(pending, r.id),
      verifiedToday: countBy(verified, r.id),
      // Per-category counts for the sidebar breakdown
      pendingExpress:      countByRoute(pending, r.id, (route) => route.toUpperCase().startsWith('EXP')),
      pendingStandard:     countByRoute(pending, r.id, (route) => route.toUpperCase().startsWith('STD')),
      pendingStoreCounter: countByRoute(pending, r.id, (route) => route.toUpperCase() === 'STORE-COUNTER'),
      pendingAddons: 0 // add-ons are grouped differently; 0 is correct here as a safe placeholder
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
    'id, shop_name, route, customer_id, total_quantity, total_value, created_at, order_date, sales_rep_id, billing_status, billing_verified_at, is_new_customer, intro_phone, intro_gstn, intro_credit_days, intro_email, intro_area, intro_category, intro_ledger_category, brand',
    (q) => {
      q = q.eq('sales_rep_id', repId).eq('hidden', false)
        // Bills requiring Admin approval use billing_status='pending_approval'
        // to keep them OUT of the Billing Team queue. Only 'pending' and
        // 'verified' bills should ever appear in the Billing view.
        .neq('billing_status', 'pending_approval')
        .order('created_at', { ascending: true }) // oldest first
      // PENDING orders must never disappear just because a day passed without
      // being verified — order_date represents WHEN an order is due, and an
      // exact-date match here meant that once "today" moved on, any order
      // FINAL: reverted back to a plain exact-date match for every date,
      // including Today. Two earlier attempts at this tried to fold overdue
      // orders INTO this count (first for every date, then only for Today),
      // but the actual requirement was different: Today needs to stay an
      // accurate, clean reflection of orders actually placed today — an
      // inflated cumulative number was itself the problem, not the fix.
      // Overdue pending orders are no longer silently lost, though — see
      // loadOverduePendingCounts below, which surfaces them as an explicit,
      // separate indicator instead of hiding inside this total.
      if (dateStr) {
        // An explicit date pick is honored for ANY day — older orders remain
        // reachable via the date picker, so no historical access is lost.
        q = q.eq('order_date', dateStr)
      } else {
        // Default view (no date chosen): limit to the recent pending window.
        // Older pending orders are not deleted/hidden in the DB — they're
        // reachable by picking their date and via all historical features.
        q = q.gte('order_date', pendingWindowCutoffDate())
      }
      return q
    }
  )
  let rows = data || []
  if (deliveryType === 'EXP') rows = rows.filter((o) => (o.route || '').toUpperCase().startsWith('EXP'))
  if (deliveryType === 'STD') rows = rows.filter((o) => (o.route || '').toUpperCase().startsWith('STD'))
  if (deliveryType === 'STORE-COUNTER') rows = rows.filter((o) => (o.route || '').toUpperCase() === 'STORE-COUNTER')
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
    const key = `${(o.shop_name || "").toUpperCase()}__${day}__${(o.route || "").toUpperCase()}`
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
export async function loadBillingCounts(repId, dateStr = null, status = 'pending') {
  const data = await fetchAllPaged(
    'orders',
    'id, shop_name, route, order_date, created_at, billing_status',
    (q) => {
      q = q.eq('sales_rep_id', repId).eq('hidden', false)
      .neq('billing_status', 'pending_approval')  // exclude bills awaiting Admin approval
      // Reverted to a plain exact-date match, same reasoning as
      // loadBillingOrders above — this badge needs to stay an accurate count
      // of the selected day specifically. Overdue orders are surfaced
      // separately now (loadOverduePendingCounts), not folded in here.
      if (dateStr) q = q.eq('order_date', dateStr)
      return q
    }
  )
  const rows = (data || []).sort((a, b) => new Date(a.created_at) - new Date(b.created_at))

  const groups = new Map()
  for (const o of rows) {
    const day = o.order_date || (o.created_at || '').slice(0, 10)
    const key = `${(o.shop_name || "").toUpperCase()}__${day}__${(o.route || "").toUpperCase()}`
    let g = groups.get(key)
    if (!g) { g = { orders: [o], route: o.route }; groups.set(key, g) }
    else g.orders.push(o)
  }

  // ROOT CAUSE of "Verified tab shows the same numbers as Pending": this
  // function used to be hardcoded to count billing_status==='pending' only,
  // with no branch for 'verified' at all and no status parameter to even
  // know which tab was being viewed. Whichever tab was selected, the SAME
  // pending-only counts came back. `status` now drives which side of
  // billing_status each bucket checks — 'pending' counts what's still
  // outstanding, 'verified' counts what's actually been completed — so the
  // two tabs can never show identical numbers again.
  const matchesStatus = (o) => o.billing_status === status

  let all = 0, express = 0, standard = 0, addons = 0, storeCounter = 0
  for (const g of groups.values()) {
    const original = g.orders[0]
    const rest = g.orders.slice(1)
    const isExpress = (g.route || '').toUpperCase().startsWith('EXP')
    const isStandard = (g.route || "").toUpperCase().startsWith("STD")
    const isStoreCounter = (g.route || "").toUpperCase() === "STORE-COUNTER"
    const originalMatches = matchesStatus(original)
    const addonMatches = rest.some(matchesStatus)

    if (originalMatches) all++
    if (addonMatches) all++

    if (originalMatches) {
      if (isExpress) express++
      if (isStandard) standard++
      if (isStoreCounter) storeCounter++
    }
    if (addonMatches) addons++
  }

  return { all, express, standard, addons, storeCounter }
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
// Billing's item columns. The OPTIONAL set was added by later migrations
// (53 = reschedule traceability, 55 = price approval). Selecting a column that
// does not exist fails the WHOLE query, which would leave Billing showing no
// items at all — including add-ons — so the loader falls back to the core set
// when those migrations have not been applied yet.
const BILLING_ITEM_COLS_CORE =
  'id, order_id, product_name, qty, unit, is_addon, available, original_qty, change_type, change_reason, original_product_name, removed, normal_price, is_special_price, scheme_enabled, unit_price, mrp, gst_percent, hsn, free_qty, price_type'
const BILLING_ITEM_COLS_FULL =
  BILLING_ITEM_COLS_CORE +
  ', rescheduled_from_item_id, rescheduled_from_date, approval_status, approved_by, approved_at, approval_reason, approved_price'

export async function loadBillingOrderItemsFull(orderIdOrIds) {
  const ids = Array.isArray(orderIdOrIds) ? orderIdOrIds : [orderIdOrIds]
  const run = (cols) =>
    supabase
      .from('order_items')
      .select(cols)
      .in('order_id', ids)
      .order('removed', { ascending: true })

  let res = await run(BILLING_ITEM_COLS_FULL)
  // A missing column fails the entire query, which previously left Billing
  // with an empty item list — add-ons included — and no visible error.
  // Fall back to the columns that have always existed.
  if (res.error && /rescheduled_from|approval_/i.test(String(res.error.message || ''))) {
    console.warn(
      'order_items is missing reschedule/approval columns — run ' +
      'sql/53_pending_orders_traceability.sql and sql/55_price_approval.sql. ' +
      'Loading billing items without them for now.'
    )
    res = await run(BILLING_ITEM_COLS_CORE)
  }
  const { data, error } = res
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
    const key = `${(it.product_name || '').trim().toUpperCase()}__${it.unit || ''}__${it.approval_status || 'null'}`
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

  // Tell the rep who owns this order, immediately. Fired here — from the
  // confirmed removal — so the alert always carries the actual product and the
  // actual reason, rather than being inferred from a later status change.
  // Each removal sends its own alert, so removing several products from one
  // order produces one alert per product and none overwrite each other.
  // Non-fatal: the removal is already committed and must not be undone by a
  // notification problem.
  try {
    await notifyRepOfRemoval({
      orderId: item.order_id,
      productName: item.product_name,
      reason,
      removedBy: audit?.editedBy || null
    })
  } catch (nErr) {
    console.error(
      'Removal notification to the sales rep FAILED (the removal itself saved fine). ' +
      'If this mentions notif_type or ref_order_id, run sql/57_announcement_notif_type.sql ' +
      'and sql/60_addon_realtime_popup.sql.',
      nErr
    )
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

  // ROOT CAUSE of "Orders Taken = 30" vs "Billing Pending = 24": this query
  // used to filter by created_at (the timestamp an order was physically
  // submitted), while Billing's queries filter by order_date (a separate,
  // rep-editable field representing which day an order is FOR/DUE — the
  // field the Order Date picker sets, the field the Add-On flow's own date
  // picker sets, and the field the Reschedule feature INTENTIONALLY moves to
  // a different day). Whenever those two dates diverge for an order — a
  // manually backdated/forward-dated order, an add-on dated differently from
  // when it was actually sent, or a rescheduled item — that order got counted
  // by this screen on the day it was SUBMITTED, while Billing counted it on
  // the day it's DUE. Nothing was lost; the two screens were answering two
  // different questions about the same order without anyone realising it.
  // Using order_date here instead makes both screens measure "orders FOR
  // this day" the same way, so they are now structurally guaranteed to
  // agree — not just usually agree except when a date differs.
  //
  // order_date is stored as a plain YYYY-MM-DD string (see saveCloudOrder),
  // so single-day lookups are a direct equality check; range lookups
  // (This Week / This Month) compare against the same string format, which
  // sorts correctly since the format is already zero-padded and
  // most-significant-first.
  const singleDay = !rangeOverride
  const rangeStartStr = rangeOverride ? rangeOverride.start.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }) : null
  const rangeEndStr = rangeOverride ? rangeOverride.end.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }) : null

  let ordersQ = supabase
    .from('orders')
    .select('id, total_quantity, total_value, shop_name, customer_id, created_at, order_date, route')
    .eq('sales_rep_id', userId)
    .eq('hidden', false)
  ordersQ = singleDay
    ? ordersQ.eq('order_date', dateStr)
    : ordersQ.gte('order_date', rangeStartStr).lte('order_date', rangeEndStr)

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
/**
 * Loading Sheet — one row per VERIFIED order, for the Billing Team to
 * export a list of what's ready for loading.
 *
 * GRAND TOTAL — the one non-obvious decision here. orders.total_value is
 * written exactly once, at order creation (see saveCloudOrder), and is
 * NEVER recalculated by removeItem / editItemQty / replaceItem — confirmed
 * by searching every write to that column in this file. So after Billing
 * removes an item or reduces a quantity during verification,
 * orders.total_value still holds the ORIGINAL sales-rep amount, not the
 * final verified one. Using it directly would reproduce exactly the bug
 * this feature explicitly warns against. The true final total is computed
 * here instead, by summing qty × unit_price across every item that is NOT
 * removed — using each item's CURRENT qty, which editItemQty does keep
 * correctly up to date even though total_value itself is not.
 *
 * VERIFICATION STATUS — reuses the same three modification signals already
 * used by removeItem / editItemQty / replaceItem (removed=true,
 * change_type='qty' with original_qty different from qty, change_type=
 * 'replaced'), rather than inventing a second, competing definition of
 * "was this order modified". An order is PARTIAL VERIFIED if ANY item
 * shows one of these; otherwise VERIFIED.
 *
 * PERMISSIONS — this uses the exact same supabase client and query pattern
 * as every other Billing function in this file, so it is subject to
 * whatever row-level security already restricts orders/order_items access
 * — no separate permission check is introduced or needed here. The one new
 * gate is on the UI side (this function is only called from a button
 * rendered inside BillingDashboard.jsx, a page only billing_team can reach).
 */
export async function loadLoadingSheetData({ fromDateStr, toDateStr, route, salesRepId }) {
  let q = supabase
    .from('orders')
    .select(`
      id, shop_name, sales_rep_id, order_date, route, billing_status, customer_id,
      order_items ( qty, unit_price, removed, change_type, original_qty )
    `)
    // UPDATE 1: previously filtered to billing_status='verified' here, which
    // is why NOT VERIFIED orders never appeared at all — they were excluded
    // before the status logic below even ran. Now every order in the
    // date/route/rep filter range comes through, and billing_status decides
    // the three-way outcome per row instead of gating the query itself.
    .eq('hidden', false)
    .gte('order_date', fromDateStr)
    .lte('order_date', toDateStr)
  if (route) q = q.eq('route', route)
  if (salesRepId) q = q.eq('sales_rep_id', salesRepId)

  const { data, error } = await q
  if (error) { console.error('load loading sheet failed', error); return [] }

  const repIds = [...new Set((data || []).map((o) => o.sales_rep_id).filter(Boolean))]
  let nameById = new Map()
  if (repIds.length) {
    const { data: reps } = await supabase.from('profiles').select('id, full_name').in('id', repIds)
    nameById = new Map((reps || []).map((r) => [r.id, r.full_name]))
  }

  // ONE SHOP PER DAY. Multiple orders for the same shop on the same date are
  // merged into a single Loading Sheet row. Grouping keys on the shop's IDENTITY
  // (customer_id), NOT its display name, so two different shops that happen to
  // share a name stay separate; older rows missing customer_id fall back to
  // shop_name::route (the same identity fallback used elsewhere in this file,
  // see the visits logic). order_date keeps different days apart, so the same
  // shop still gets one row PER DAY across a multi-day range.
  //
  // This is a PRESENTATION-level aggregation only — the underlying orders are
  // untouched; each order's own grandTotal and modified-status are computed
  // exactly as before, then combined.
  const groups = new Map()
  for (const o of data || []) {
    const items = o.order_items || []
    let grandTotal = 0
    let modified = false
    for (const i of items) {
      if (i.removed) { modified = true; continue }
      grandTotal += (Number(i.qty) || 0) * (Number(i.unit_price) || 0)
      if (i.change_type === 'replaced') modified = true
      if (i.change_type === 'qty' && i.original_qty != null && Number(i.original_qty) !== Number(i.qty)) modified = true
    }
    // Per-order three-way status — unchanged from the previous logic.
    const orderStatus = o.billing_status !== 'verified' ? 'NOT VERIFIED' : (modified ? 'PARTIAL VERIFIED' : 'VERIFIED')

    const shopIdentity = o.customer_id
      || `${(o.shop_name || '').trim().toUpperCase()}::${(o.route || '').trim().toUpperCase()}`
    const key = `${o.order_date}::${shopIdentity}`

    const g = groups.get(key)
    if (!g) {
      groups.set(key, {
        orderId: o.id,                 // representative id (first order in group)
        orderIds: [o.id],              // all underlying orders, kept traceable
        shopName: o.shop_name,
        salesRepName: nameById.get(o.sales_rep_id) || '—',
        orderDate: o.order_date,
        grandTotal,
        _statuses: [orderStatus]
      })
    } else {
      g.orderIds.push(o.id)
      g.grandTotal += grandTotal
      g._statuses.push(orderStatus)
    }
  }

  // Shop-level status priority (per requirement, and consistent with the
  // per-order rule above): PARTIAL VERIFIED if any order is partial; else NOT
  // VERIFIED if any order is still not verified; else VERIFIED (all verified).
  const rollUp = (statuses) =>
    statuses.includes('PARTIAL VERIFIED') ? 'PARTIAL VERIFIED'
    : statuses.includes('NOT VERIFIED') ? 'NOT VERIFIED'
    : 'VERIFIED'

  return [...groups.values()].map((g) => ({
    orderId: g.orderId,
    orderIds: g.orderIds,
    shopName: g.shopName,
    salesRepName: g.salesRepName,
    orderDate: g.orderDate,
    grandTotal: Math.round(g.grandTotal * 100) / 100,
    verificationStatus: rollUp(g._statuses)
  })).sort((a, b) => a.shopName.localeCompare(b.shopName))
}

/** Sales rep list for the Loading Sheet filter dropdown — a small, focused
 * query rather than reusing loadBillingReps, which also computes pending/
 * verified counts that this filter dropdown doesn't need. */
export async function listSalesRepsForFilter() {
  const { data, error } = await supabase.from('profiles').select('id, full_name').eq('role', 'salesperson').order('full_name')
  if (error) { console.error(error); return [] }
  return data || []
}

export async function listAllRoutes() {
  const { data, error } = await supabase
    .from('customers')
    .select('route')
    .not('route', 'is', null)
  if (error) { console.error(error); return [] }
  const set = new Set((data || []).map((c) => (c.route || '').trim()).filter(Boolean))
  // Special order channels are always present regardless of whether any customer
  // is already assigned to them. STORE-COUNTER existed before but depended on
  // at least one customer having that route; ON-DEMAND was never in the customer
  // table. Both are guaranteed here so they always appear in the route dropdown.
  set.add('STORE-COUNTER')
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
 * Full order summary. Accepts either a single order id (unchanged behaviour,
 * used by the New Shops -> Today's Activity path) OR an array of order ids that
 * belong to the same customer/day visit group (original + its add-ons), in
 * which case the products of every member order are MERGED into one summary.
 *
 * The group is decided upstream by consolidateOrdersByVisit (customer_id + day)
 * — the existing grouping source of truth — so this never merges unrelated
 * orders that merely share a shop name, and add-ons are never shown in place of
 * the original. Each line keeps its own is_addon flag, so the summary UI's
 * existing ADD-ON label still distinguishes later-added products. Totals are
 * summed from the member orders' own stored totals (no new pricing math). The
 * header (date/route/rep) comes from the EARLIEST member — the original order —
 * and status is the group's overall state (pending if ANY member is still
 * pending, so a pending add-on never reads as fully verified).
 */
export async function loadOrderSummary(orderIdOrIds) {
  const ids = Array.isArray(orderIdOrIds) ? [...new Set(orderIdOrIds.filter(Boolean))] : [orderIdOrIds]
  if (!ids.length) return null

  const { data: orders, error } = await supabase
    .from('orders')
    .select('id, shop_name, route, sales_rep_id, total_products, total_quantity, total_value, order_date, created_at, billing_status')
    .in('id', ids)
  if (error) throw error
  if (!orders || !orders.length) return null

  // Header order = earliest by created_at (the original), so date/route/rep
  // reflect the original order, not the latest add-on.
  const sorted = [...orders].sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
  const head = sorted[0]

  const { data: items, error: itemsErr } = await supabase
    .from('order_items')
    .select('id, product_name, qty, unit, is_addon, unit_price, scheme_applied, removed, order_id')
    .in('order_id', ids)
    .eq('removed', false)
  if (itemsErr) throw itemsErr

  // Rep display name (for the summary header).
  let repName = ''
  try {
    const { data: prof } = await supabase.from('profiles').select('full_name').eq('id', head.sales_rep_id).maybeSingle()
    repName = prof?.full_name || ''
  } catch { /* non-critical */ }

  const mergedItems = items || []
  // Totals summed from each member order's OWN stored totals — reuses the
  // existing per-order totals, no recomputation and no double counting (each
  // member order contributes exactly once).
  const total_products = orders.reduce((s, o) => s + (Number(o.total_products) || 0), 0)
  const total_quantity = orders.reduce((s, o) => s + (Number(o.total_quantity) || 0), 0)
  const total_value = orders.reduce((s, o) => s + (Number(o.total_value) || 0), 0)
  // Group status: verified only if EVERY member is verified; otherwise pending.
  const billing_status = orders.every((o) => o.billing_status === 'verified') ? 'verified' : 'pending'

  return {
    ...head,
    sales_rep_name: repName,
    items: mergedItems,
    total_products: total_products || mergedItems.length,
    total_quantity,
    total_value,
    billing_status
  }
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

/**
 * Correct the date and/or route on an order the rep created, while it is still
 * pending Billing verification. Both fields can be updated independently —
 * pass null/undefined for a field to leave it unchanged.
 *
 * One-bill-per-day: if the target date already has an ACTIVE (non-hidden,
 * non-deleted) order from this rep for this shop, the move is blocked so the
 * rep knows to use the add-on flow instead. The check is purely advisory on
 * the client; the Billing view groups by order_date so moving an order to a
 * different date is immediately reflected there.
 */

/**
 * Update an existing order's product line items in-place.
 * Reconciles: updated qty/price, removed products, newly added products.
 * Order totals are recalculated. Order ID/customer/route/date preserved.
 *
 * isApprovalRequest — when true (rep tapped "Request Admin Approval" after
 *   editing prices), this function also:
 *   1. Detects special-priced items using the SAME isSpecial formula as
 *      saveCloudOrder (ep !== normalPrice with box-unit and wholesale exemptions).
 *   2. Sets approval_status='pending' on those order_items rows.
 *   3. Promotes the order to billing_status='pending_approval',
 *      bill_approval_required=true, bill_approval_status='pending' so it
 *      appears in Admin's dashboard.
 *   4. Sends the Admin notification (same path as new orders).
 *
 * Without this, the approval flag was silently dropped for edited orders:
 * dispatchOrder passed isApprovalRequest=true only to saveCloudOrder (new
 * orders) but never forwarded it to updateCloudOrder (edit mode) — so Admin
 * never saw the request and the order flowed directly to Billing.
 */
export async function updateCloudOrder(orderId, { items, userId, isApprovalRequest = false, isWholesaleCustomer = false }) {
  if (!orderId || !items) throw new Error("orderId and items required")

  console.log('[APPROVAL] updateCloudOrder called — orderId:', orderId, '| isApprovalRequest:', isApprovalRequest, '| items:', items.length)

  const { data: existing, error: fetchErr } = await supabase.from("order_items").select("id, product_name, qty, unit_price, unit").eq("order_id", orderId).eq("removed", false)
  if (fetchErr) throw fetchErr
  const exMap = new Map((existing || []).map(e => [e.product_name.trim().toUpperCase(), e]))
  const newMap = new Map(items.map(i => [(i.name || "").trim().toUpperCase(), i]))

  // Remove products the rep deleted
  for (const e of [...exMap.values()]) {
    if (!newMap.has(e.product_name.trim().toUpperCase())) {
      // Mark removed instead of hard delete — preserves audit trail and history
      await supabase.from('order_items').update({ removed: true }).eq('id', e.id)
    }
  }

  // Upsert each item in the new set
  for (const [key, i] of newMap.entries()) {
    const ep = i.finalSellingPrice != null ? i.finalSellingPrice : null

    // isSpecial: same formula as saveCloudOrder — ep genuinely differs from
    // normalPrice, excluding box-unit wholesale sales and wholesale-customer WP sales.
    const isSpecial = i.normalPrice != null && ep != null && ep !== i.normalPrice
      && !(i.isBoxUnit && ep >= (i.wholesaleAtOrderTime ?? ep))
      && !(isWholesaleCustomer && i.wholesaleAtOrderTime != null && Math.abs(ep - i.wholesaleAtOrderTime) < 0.001)

    const approvalEnabled = _runtimeApprovalEnabled !== false && PRICE_APPROVAL_ENABLED

    // Approval status for this item:
    // - If rep requested approval AND this item is special → 'pending'
    // - If the item is NOT special → null (normal item, no approval needed)
    // - If rep did NOT request approval → preserve whatever was already set (don't regress)
    const approvalStatusForItem = (approvalEnabled && isApprovalRequest && isSpecial) ? 'pending' : null

    const ex = exMap.get(key)
    if (ex) {
      const patch = {
        qty: i.qty,
        unit: i.unit || ex.unit || "Piece",
        unit_price: ep != null ? ep : ex.unit_price,
        price_type: i.priceType || null,
        normal_price: i.normalPrice ?? null,
        // Refresh price version on update so loadCustomerLastPrices can detect
        // staleness if the product's version bumps again after this edit.
        approved_price_version: i.priceVersion ?? null
      }
      if (isApprovalRequest) {
        // Only set approval fields when rep is explicitly requesting approval —
        // a plain edit (no approval modal) must not accidentally overwrite
        // approval_status on items that are already approved/rejected.
        patch.approval_status = approvalStatusForItem
        // Clear previous admin decision fields so this is a fresh request
        if (isSpecial) {
          patch.approved_by = null
          patch.approved_by_id = null
          patch.approved_at = null
          patch.approval_reason_type = null
          patch.approval_competitor_name = null
          patch.approval_other_reason = null
          patch.approved_price = null
          patch.rejection_reason = null
        }
      }
      const { error: updErr } = await supabase.from("order_items").update(patch).eq("id", ex.id)
      if (updErr) throw updErr
    } else {
      // New product added during edit
      const insertRow = {
        order_id: orderId,
        product_name: i.name,
        qty: i.qty,
        unit: i.unit || "Piece",
        is_addon: false,
        unit_price: ep,
        price_type: i.priceType || null,
        normal_price: i.normalPrice ?? null,
        mrp: i.mrp ?? null,
        gst_percent: i.gst ?? null,
        hsn: i.hsn ?? null,
        scheme_enabled: i.schemeEnabled !== false,
        approval_status: (approvalEnabled && isApprovalRequest && isSpecial) ? 'pending' : null,
        // Price version at the time of edit — same as saveCloudOrder
        approved_price_version: i.priceVersion ?? null
      }
      const { error: insErr } = await supabase.from("order_items").insert(insertRow)
      if (insErr) throw insErr
    }
  }

  // Recalculate order totals
  const totalValue = items.reduce((s, i) => s + (i.finalSellingPrice || 0) * i.qty, 0)
  const orderPatch = {
    total_value: totalValue,
    total_products: items.length,
    total_quantity: items.reduce((s, i) => s + i.qty, 0)
  }

  // ── Approval promotion ──────────────────────────────────────────────────────
  // When the rep explicitly requests approval after editing, detect whether any
  // item is special (same isSpecial formula used above). If yes, promote the
  // order's billing/approval status so Admin can see and act on it.
  if (isApprovalRequest && (_runtimeApprovalEnabled !== false && PRICE_APPROVAL_ENABLED)) {
    const specialItems = items.filter((i) => {
      const ep = i.finalSellingPrice ?? null
      if (ep == null || i.normalPrice == null) return false
      if (ep === i.normalPrice) return false
      if (i.isBoxUnit && ep >= (i.wholesaleAtOrderTime ?? ep)) return false
      if (isWholesaleCustomer && i.wholesaleAtOrderTime != null && Math.abs(ep - i.wholesaleAtOrderTime) < 0.001) return false
      return true
    })

    console.log('[APPROVAL] updateCloudOrder — specialItems requiring approval:', specialItems.length, specialItems.map(i => `${i.name}: ₹${i.finalSellingPrice} vs normal ₹${i.normalPrice}`))

    if (specialItems.length > 0) {
      // Promote order to pending approval state — same fields saveCloudOrder sets
      orderPatch.billing_status = 'pending_approval'
      orderPatch.bill_approval_required = true
      orderPatch.bill_approval_status = 'pending'
      orderPatch.bill_rejection_reason = null

      console.log('[APPROVAL] Promoting order', orderId, 'to pending_approval for Admin review')

      // Fetch order details needed for the Admin notification (shop_name etc.)
      try {
        const { data: orderRow } = await supabase
          .from('orders')
          .select('shop_name, route, order_date, sales_rep_id')
          .eq('id', orderId)
          .maybeSingle()

        if (orderRow) {
          console.log('[APPROVAL] Sending Admin notification for edited order:', orderId, 'shop:', orderRow.shop_name)
          notifyAdminPriceApprovalRequired(
            specialItems,
            orderRow.shop_name || '',
            specialItems[0]?.repName || ''
          ).catch((e) => console.warn('[APPROVAL] Admin notification failed (non-fatal):', e))
        }
      } catch (notifErr) {
        console.warn('[APPROVAL] Could not fetch order for notification (non-fatal):', notifErr)
      }
    }
  }

  const { error: orderUpdErr } = await supabase.from("orders").update(orderPatch).eq("id", orderId)
  if (orderUpdErr) throw orderUpdErr

  console.log('[APPROVAL] updateCloudOrder complete — orderId:', orderId, '| orderPatch keys:', Object.keys(orderPatch))
  return orderId
}


/** Remove a single order item (Sales Rep side). Marks removed=true and recalculates order totals. Billing sees it gone immediately. */
export async function removeOrderItem(itemId, orderId) {
  if (!itemId || !orderId) throw new Error("itemId and orderId required")
  const { error } = await supabase.from("order_items").update({ removed: true }).eq("id", itemId)
  if (error) throw error
  try {
    const { data: remaining } = await supabase.from("order_items").select("qty, unit_price").eq("order_id", orderId).eq("removed", false)
    const totalValue = (remaining || []).reduce((s, i) => s + ((i.unit_price || 0) * i.qty), 0)
    const totalQty = (remaining || []).reduce((s, i) => s + i.qty, 0)
    const totalProducts = (remaining || []).length
    await supabase.from("orders").update({ total_value: totalValue, total_quantity: totalQty, total_products: totalProducts }).eq("id", orderId)
  } catch (e) { console.error("recalc totals (non-fatal):", e) }
}
export async function updateOrderDateRoute(orderId, { newDate, newRoute } = {}) {
  if (!newDate && newRoute == null) return   // nothing to change

  // Fetch the order's own shop/rep so we can do the same-day conflict check.
  const { data: order, error: fetchErr } = await supabase
    .from('orders')
    .select('id, shop_name, route, order_date, sales_rep_id, billing_status, hidden')
    .eq('id', orderId)
    .maybeSingle()
  if (fetchErr || !order) throw new Error('Could not load order details.')
  if (order.billing_status !== 'pending' || order.hidden)
    throw new Error('Only pending orders that have not yet been verified can be edited.')

  // Conflict check: if the new date already has a different active order for
  // this shop+rep, block the move so the rep doesn't create a confusing
  // multi-order situation for Billing. The rep should use the add-on flow
  // against that existing order instead.
  if (newDate && newDate !== order.order_date) {
    const { data: conflict } = await supabase
      .from('orders')
      .select('id')
      .eq('sales_rep_id', order.sales_rep_id)
      .eq('shop_name', order.shop_name)
      .eq('order_date', newDate)
      .eq('hidden', false)
      .neq('id', orderId)     // exclude the order itself
      .limit(1)
    if (conflict && conflict.length > 0) {
      throw new Error(
        `${order.shop_name} already has an active order on ${newDate}. ` +
        'Use the + ADD-ON button on that order instead of moving this one.'
      )
    }
  }

  const patch = {}
  if (newDate)     patch.order_date = newDate
  if (newRoute != null) patch.route = newRoute

  const { error } = await supabase.from('orders').update(patch).eq('id', orderId)
  if (error) throw error
}

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
/**
 * Update a customer's name (shop_name) in the cloud.
 * Called by reps and admins from the Edit Customer modal.
 * Only the authenticated creator or an admin may update.
 * Returns the updated customer row or throws.
 */
export async function updateCustomerName(cloudCustomerId, newName) {
  if (!cloudCustomerId) throw new Error('No customer ID provided.')
  const name = (newName || '').trim()
  if (!name) throw new Error('Customer name cannot be empty.')
  const patch = { shop_name: name }
  try { patch.updated_at = new Date().toISOString() } catch {}
  const { error } = await supabase
    .from('customers')
    .update(patch)
    .eq('id', cloudCustomerId)
  if (error) throw error
}

/**
 * Update customer details (category, ledger_category) in the cloud.
 * PII (phone/area/email/gstn/creditDays) stays local — only cloud-managed
 * fields are persisted here.
 */
export async function updateCustomerCloudFields(cloudCustomerId, { category, ledgerCategory } = {}) {
  if (!cloudCustomerId) return
  const patch = {}
  if (category != null) patch.category = category
  if (ledgerCategory != null) patch.ledger_category = ledgerCategory
  if (!Object.keys(patch).length) return
  try { patch.updated_at = new Date().toISOString() } catch {}
  const { error } = await supabase.from('customers').update(patch).eq('id', cloudCustomerId)
  if (error) throw error
}

/**
 * Load all customers for the Admin Customers page.
 * Returns rows with shop_name, route, category, ledger_category, created_at,
 * updated_at, is_active, created_by, and the creator's full_name via join.
 * Admin-only: RLS ensures only admins can list all customers.
 */
export async function loadAdminCustomers({ search, showInactive } = {}) {
  let q = supabase
    .from('customers')
    .select('id, shop_name, route, category, ledger_category, created_at, updated_at, is_active, created_by, profiles(full_name)')
    .order('created_at', { ascending: false })
    .limit(500)
  if (!showInactive) q = q.eq('is_active', true)
  if (search && search.trim()) {
    q = q.ilike('shop_name', `%${search.trim()}%`)
  }
  const { data, error } = await q
  if (error) { console.error(error); return [] }
  return (data || []).map((c) => ({
    id: c.id,
    name: c.shop_name,
    route: c.route,
    category: c.category,
    ledgerCategory: c.ledger_category,
    createdAt: c.created_at,
    updatedAt: c.updated_at,
    isActive: c.is_active !== false,
    createdByName: c.profiles?.full_name || '—'
  }))
}

/**
 * Deactivate (soft-delete) a customer. Admin only.
 * Sets is_active = false — the customer stays in the DB and all historical
 * orders remain linked, but they no longer appear in active customer lists.
 */
export async function deactivateCustomer(cloudCustomerId) {
  if (!cloudCustomerId) throw new Error('No customer ID provided.')
  const { error } = await supabase
    .from('customers')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('id', cloudCustomerId)
  if (error) throw error
}

/**
 * Reactivate a previously deactivated customer. Admin only.
 */
export async function reactivateCustomer(cloudCustomerId) {
  if (!cloudCustomerId) throw new Error('No customer ID provided.')
  const { error } = await supabase
    .from('customers')
    .update({ is_active: true, updated_at: new Date().toISOString() })
    .eq('id', cloudCustomerId)
  if (error) throw error
}

export async function updateCustomerDefaultRoute(customerCloudId, newRoute) {
  if (!customerCloudId) throw new Error('No customer record to update.')

  // updated_at is stamped explicitly as well as by migration 58's trigger, so
  // this row wins the sync's tie-break against any stale duplicate for the
  // same shop. If migration 58 hasn't been applied yet the column won't exist
  // and the write is rejected, so fall back to updating the route alone —
  // the route change is what matters and must not be blocked by a missing
  // ordering column.
  let res = await supabase
    .from('customers')
    .update({ route: newRoute, updated_at: new Date().toISOString() })
    .eq('id', customerCloudId)
    .select('id')

  if (res.error && String(res.error.message || '').toLowerCase().includes('updated_at')) {
    console.warn(
      'customers.updated_at is missing — run sql/58_customer_updated_at.sql. ' +
      'Saving the route without it; duplicate rows for this shop may still ' +
      'override it on refresh until that migration is applied.'
    )
    res = await supabase
      .from('customers')
      .update({ route: newRoute })
      .eq('id', customerCloudId)
      .select('id')
  }

  if (res.error) throw res.error

  // Never report success on a no-op. An UPDATE blocked by row-level security
  // affects zero rows WITHOUT raising an error, which previously let the app
  // show a success toast for a change that never persisted — the original
  // "route reverts after refresh" symptom.
  if (!res.data || res.data.length === 0) {
    throw new Error(
      'Default route was not saved: the update affected no rows. This is ' +
      'usually a permissions (RLS) issue — run sql/59_customer_route_permission.sql.'
    )
  }
  return res.data[0].id
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
    .is('pending_dismissed_at', null)
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
    // ROOT CAUSE of "rescheduled item vanishes from Pending but never
    // reaches Billing": saveCloudOrder's duplicate guard (added later than
    // this function) returns the string 'DUPLICATE' instead of a real order
    // id when the rescheduled order exactly matches one already placed that
    // day for this shop — no exception is thrown. This call was never
    // updated to check for that, so it went on to stamp
    // rescheduled_order_id: 'DUPLICATE' (a fake id, not a real order) on the
    // original item below, reported success, and the item disappeared from
    // Pending Orders — while no order was ever actually created. Caught
    // explicitly here now: release the claim (so the item is reschedulable
    // again) and fail loudly instead of silently.
    if (newOrderId === 'DUPLICATE') {
      throw new Error('An identical order for this shop already exists on that date. Pick a different date, or check with billing if this repeat is intentional.')
    }
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
/**
 * Product Shortage Sales Loss Report — ONE ROW PER SHORTAGE PRODUCT LINE
 * (not per order). Replaces the old order-level Partial Verification Report,
 * whose only caller was PartialVerificationReport.jsx — confirmed before
 * rewriting this function, so nothing else depends on its previous shape.
 *
 * DATA MODEL — two structurally different ways a shortage is recorded, both
 * traced from the existing billing verification code (removeItem /
 * editItemQty in this same file), not invented:
 *
 *   1. FULL REMOVAL — removeItem() sets removed=true, change_type='removed',
 *      change_reason from a fixed dropdown (Stock Out / Damaged Stock /
 *      Others). qty is left as the original ordered quantity — the whole
 *      line was rejected, so the whole qty is the shortage.
 *
 *   2. PARTIAL REDUCTION — editItemQty() reduces qty on the SAME row and
 *      records the original value in original_qty (only the first time it
 *      changes). removed stays false — the line wasn't rejected, just
 *      supplied at a lower quantity. Its reason is a free-text field typed
 *      by the billing team, not a fixed dropdown, so there is no reliable
 *      "Stock Out" flag to check here the way there is for full removals.
 *      This is treated as a stock shortage when the typed reason contains
 *      the word "stock" (case-insensitive) — the only signal the data model
 *      actually provides. This is a documented judgement call, not a
 *      guarantee: a billing team member typing an unrelated reason that
 *      happens to contain "stock", or a genuine stock-shortage reason that
 *      doesn't mention the word, would be classified against intent. If
 *      this needs to be more precise, the fix is upstream — giving
 *      editItemQty's reason field the same fixed dropdown removeItem
 *      already has — not a smarter guess here.
 *
 * DATE: filters by order_date (the day the sales rep placed the order),
 * NOT billing_verified_at (the old report's filter field) — the new
 * report's own Date column is explicitly defined as the order date, so the
 * filter must use the same field or the displayed dates and the selected
 * filter would silently disagree.
 *
 * SCOPE: only requires stockOutLines.length > 0 — NOT verifiedItems.length
 * > 0 like the old function did. That old condition would have silently
 * excluded orders that were COMPLETELY stocked out, which the new report is
 * explicitly required to include.
 *
 * AMOUNT: shortageQty × unit_price. unit_price is the sales rep's own
 * effective selling price captured per line at order time (see saveCloudOrder
 * — no separate line-total field exists to recompute from), so this is
 * already "the sales value entered by the sales rep for that line", not a
 * billing-side or master-price figure.
 *
 * DUPLICATE SAFETY: this reads directly from order_items on every call —
 * there is no separate accumulating log this appends to. Refreshing,
 * reopening a verified order for re-inspection, or regenerating the report
 * all re-derive the same rows from the same source rows, keyed by the
 * order_item's own id. The same underlying database row can never produce
 * two report lines, and nothing here writes anything — recompute this and
 * every downstream KPI is trivially freed of drift.
 */
// ---------------------------------------------------------------------------
// Shortage detection — the ONE definition of "how much of an order_item was
// short due to a stock shortage during verification". Extracted verbatim from
// loadShortageSalesLossReport so the Billing report and the Sales Rep's own
// shortage summary can never drift apart: both call this exact function.
//
//   - a line REMOVED with change_reason exactly 'Stock Out' → its whole qty
//   - a line whose qty was REDUCED (change_type='qty', original_qty > qty)
//     and whose free-text change_reason mentions "stock" → the reduced amount
//   - anything else → 0 (not a shortage)
//
// Returns a non-negative Number. Callers treat 0 as "skip this line".
// ---------------------------------------------------------------------------
export function shortageQtyForItem(i) {
  if (i.removed && i.change_reason === 'Stock Out') {
    return Number(i.qty) || 0
  }
  if (
    !i.removed &&
    i.change_type === 'qty' &&
    i.original_qty != null &&
    Number(i.original_qty) > Number(i.qty) &&
    /stock/i.test(i.change_reason || '')
  ) {
    return Number(i.original_qty) - Number(i.qty)
  }
  return 0
}

export async function loadShortageSalesLossReport(fromDateStr, toDateStr) {
  const { data, error } = await supabase
    .from('orders')
    .select(`
      id, shop_name, route, sales_rep_id, order_date,
      order_items ( id, product_name, qty, unit, unit_price, removed, change_type, change_reason, original_qty )
    `)
    .eq('billing_status', 'verified')
    .gte('order_date', fromDateStr)
    .lte('order_date', toDateStr)
  if (error) { console.error('load shortage sales loss report failed', error); return [] }

  const repIds = [...new Set((data || []).map((o) => o.sales_rep_id).filter(Boolean))]
  let nameById = new Map()
  if (repIds.length) {
    const { data: reps } = await supabase.from('profiles').select('id, full_name').in('id', repIds)
    nameById = new Map((reps || []).map((r) => [r.id, r.full_name]))
  }

  // First pass: gather every original stock-out line and its full shortage qty.
  const shortLines = []
  for (const o of data || []) {
    for (const i of o.order_items || []) {
      const shortageQty = shortageQtyForItem(i)
      if (shortageQty > 0) shortLines.push({ o, i, shortageQty })
    }
  }

  // RESOLUTION — subtract quantities already fulfilled through the existing
  // reschedule workflow. A reschedule creates a NEW order_item that points back
  // to the original short line via rescheduled_from_item_id (migration 53). That
  // fulfillment only COUNTS once Billing has verified the new order AND the new
  // line was actually delivered (not itself short again). So:
  //   resolvedQty(originalLine) = Σ qty of verified, non-short rescheduled lines
  //                               whose rescheduled_from_item_id = originalLine.id
  //   remainingShortage         = max(0, shortageQty − resolvedQty)
  // A line whose remaining is 0 is fully resolved and drops out of the ACTIVE
  // report; a partially resolved line stays with the reduced qty/value. Nothing
  // is deleted — the original short rows and their reschedule links are intact
  // for history/audit; this only changes what the ACTIVE report DERIVES.
  const resolvedByOriginId = await resolvedQtyByOriginItemId(shortLines.map((s) => s.i.id))

  const rows = []
  for (const { o, i, shortageQty } of shortLines) {
    const resolved = resolvedByOriginId.get(i.id) || 0
    const remaining = Math.max(0, shortageQty - resolved)
    if (remaining <= 0) continue   // fully resolved → no longer an active shortage

    const unitPrice = Number(i.unit_price) || 0
    rows.push({
      key: i.id,
      orderId: o.id,
      date: o.order_date,
      shopName: o.shop_name,
      route: o.route,
      salesRepName: nameById.get(o.sales_rep_id) || '—',
      itemName: i.product_name,
      quantity: remaining,
      unitPrice,
      amount: Math.round(remaining * unitPrice * 100) / 100
    })
  }

  // Newest order date first, matching the old report's convention.
  return rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
}

/**
 * Given a set of ORIGINAL stock-out order_item ids, return a Map of
 * originalItemId -> total quantity already fulfilled through the reschedule
 * workflow (verified + actually delivered rescheduled lines pointing back).
 *
 * Reuses the existing reschedule linkage (rescheduled_from_item_id, migration
 * 53). A rescheduled line counts as fulfillment ONLY when its own order is
 * billing_status='verified' AND the line itself is not a fresh shortage
 * (shortageQtyForItem === 0) — i.e. it was genuinely delivered, not short
 * again. This makes resolution product- AND quantity-level, and multi-hop safe:
 * a second reschedule that fulfills the remainder simply adds another verified
 * line pointing back to the same original id.
 */
async function resolvedQtyByOriginItemId(originItemIds) {
  const out = new Map()
  const ids = [...new Set((originItemIds || []).filter(Boolean))]
  if (!ids.length) return out

  const { data, error } = await supabase
    .from('order_items')
    .select(`
      rescheduled_from_item_id, qty, removed, change_type, change_reason, original_qty,
      orders!inner ( billing_status )
    `)
    .in('rescheduled_from_item_id', ids)
  if (error) { console.error('resolved-qty lookup failed', error); return out }

  for (const r of data || []) {
    const originId = r.rescheduled_from_item_id
    if (!originId) continue
    if (r.orders?.billing_status !== 'verified') continue   // pending reschedule ≠ resolved
    // If the rescheduled line was itself short, only the delivered portion
    // counts. Delivered = qty actually verified on this new line = its qty
    // minus any shortage on it.
    const deliveredHere = (Number(r.qty) || 0) - shortageQtyForItem(r)
    if (deliveredHere <= 0) continue
    out.set(originId, (out.get(originId) || 0) + deliveredHere)
  }
  return out
}

/**
 * Sales Rep-specific product shortage summary.
 *
 * Same shortage data and same maths as the Billing Team's Product Shortage
 * Sales Loss Report — identical shortage detection, identical amount =
 * shortageQty × unit_price, identical "verified, non-hidden orders only"
 * scope — but restricted to ONE rep's own orders.
 *
 * SECURITY: this does NOT trust a client-supplied rep id. It calls the
 * `rep_shortage_summary` SECURITY DEFINER RPC (migration 65), which derives
 * the rep from auth.uid() inside the database and has no rep-id parameter to
 * tamper with. The orders_read RLS policy is intentionally broad ("any
 * authenticated user may read", see supabase_phase3b.sql) so Billing/QC can
 * see all orders — which means a plain client-side `.eq('sales_rep_id', …)`
 * filter would NOT be a real boundary. The RPC is. (`userId` is accepted only
 * so callers read naturally and to short-circuit before the round trip; it is
 * never sent as an authority — the server ignores it.)
 *
 * Date scoping mirrors loadPerformanceForDate (this screen's own period
 * logic): a single picked day is an equality check on order_date; This Week /
 * This Month / a range pass a rangeOverride and become an order_date string
 * range (en-CA / YYYY-MM-DD). Route is the same optional equality filter used
 * elsewhere on the dashboard.
 *
 * Returns exactly the four metrics the Billing report's summary header shows:
 *   { totalItems, totalQty, uniqueProducts, totalLostValue }
 */
export async function loadMyShortageSummary(userId, { dateStr, route = null, range = null } = {}) {
  const empty = { totalItems: 0, totalQty: 0, uniqueProducts: 0, totalLostValue: 0 }
  if (!userId) return empty

  const singleDay = !range
  const fromStr = range ? range.start.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }) : null
  const toStr = range ? range.end.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }) : null

  const { data, error } = await supabase.rpc('rep_shortage_summary', {
    p_single_day: singleDay,
    p_date: singleDay ? dateStr : null,
    p_from: singleDay ? null : fromStr,
    p_to: singleDay ? null : toStr,
    p_route: route || null
  })
  if (error) {
    // The RPC is the primary (server-enforced) path. If it is UNAVAILABLE —
    // typically because migration 65/66 has not been applied yet — the summary
    // used to silently return all-zeros, which reads as "no shortages" even
    // when shortages exist. That is the 0-everywhere symptom. Rather than fail
    // silently, fall back to a client-side computation that reuses the EXACT
    // same shortage + resolution logic as the Billing report, scoped to the
    // caller's OWN session identity (auth.uid via currentUserId — NOT the
    // passed userId, which a client could tamper with). Because the filter uses
    // the un-spoofable session uid, a rep can still only ever see their own
    // figures. When the RPC exists, this branch never runs.
    console.error('load my shortage summary RPC failed; using client fallback', error)
    try {
      return await myShortageSummaryFallback({ singleDay, dateStr, fromStr, toStr, route })
    } catch (e) {
      console.error('shortage summary fallback failed', e)
      return empty
    }
  }

  // The RPC returns a single row (or none). Numeric aggregates come back as
  // strings from postgres numeric columns, so coerce explicitly.
  const row = Array.isArray(data) ? data[0] : data
  if (!row) return empty
  return {
    totalItems: Number(row.total_items) || 0,
    totalQty: Number(row.total_qty) || 0,
    uniqueProducts: Number(row.unique_products) || 0,
    totalLostValue: Number(row.total_lost_value) || 0
  }
}

/**
 * Client-side computation of the rep's OWN shortage summary — used only as a
 * fallback when the rep_shortage_summary RPC is unavailable (migration not yet
 * applied). Mirrors the RPC and the Billing report exactly:
 *   • scope: the caller's own verified, non-hidden orders in the period/route
 *   • shortage per line: shortageQtyForItem (the one shared definition)
 *   • resolution: subtract verified-rescheduled delivered qty (resolvedQtyBy…)
 *   • the four metrics: items, qty, unique products, lost value (qty×unit_price)
 *
 * SECURITY: the rep is taken from the un-spoofable SESSION identity
 * (currentUserId → auth.uid), never from a caller-supplied id, so a rep can
 * only ever compute their own figures even though orders RLS is broad.
 */
async function myShortageSummaryFallback({ singleDay, dateStr, fromStr, toStr, route }) {
  const empty = { totalItems: 0, totalQty: 0, uniqueProducts: 0, totalLostValue: 0 }
  const uid = await currentUserId()
  if (!uid) return empty

  let q = supabase
    .from('orders')
    .select(`
      id, sales_rep_id, order_date, route, hidden, billing_status,
      order_items ( id, product_name, qty, unit_price, removed, change_type, change_reason, original_qty )
    `)
    .eq('sales_rep_id', uid)          // session uid — not spoofable
    .eq('billing_status', 'verified')
    .eq('hidden', false)
  if (singleDay) q = q.eq('order_date', dateStr)
  else q = q.gte('order_date', fromStr).lte('order_date', toStr)
  if (route) q = q.eq('route', route)

  const { data, error } = await q
  if (error) throw error

  const shortLines = []
  for (const o of data || []) {
    for (const i of o.order_items || []) {
      const sQty = shortageQtyForItem(i)
      if (sQty > 0) shortLines.push({ i, sQty })
    }
  }
  const resolvedByOriginId = await resolvedQtyByOriginItemId(shortLines.map((s) => s.i.id))

  let totalItems = 0, totalQty = 0, totalLostValue = 0
  const products = new Set()
  for (const { i, sQty } of shortLines) {
    const remaining = Math.max(0, sQty - (resolvedByOriginId.get(i.id) || 0))
    if (remaining <= 0) continue
    totalItems += 1
    totalQty += remaining
    totalLostValue += Math.round(remaining * (Number(i.unit_price) || 0) * 100) / 100
    products.add(i.product_name)
  }
  return {
    totalItems,
    totalQty,
    uniqueProducts: products.size,
    totalLostValue: Math.round(totalLostValue * 100) / 100
  }
}

// ===========================================================================

/** All order lines awaiting Admin sign-off, newest first, with shop/rep context. */
/**
 * CENTRALIZED PRICE APPROVAL DECISION ENGINE
 *
 * Returns whether a given selling price requires Admin approval,
 * and why. All approval logic lives here — never duplicated in UI.
 *
 * @param {object} opts
 *   product             — product object (from AppContext/cloud)
 *   qty                 — quantity being sold (in pieces after unit conversion)
 *   selectedPrice       — the price the rep selected
 *   priceType           — 'RETAIL' | 'WHOLESALE' | 'LAST' | 'CUSTOM'
 *   isBoxUnit           — true if sold as Box unit (auto-wholesale eligible)
 *   isWholesaleCustomer — true when customer.ledgerCategory === 'WHOLESALE-CUSTOMER'.
 *                         Bypasses the per-item qty threshold check for the wholesale
 *                         price: a wholesale customer selling at exactly WP is always
 *                         valid regardless of qty, same as selling a Box unit.
 *                         Custom/non-WP prices still follow the existing approval rules.
 * @returns {object}  { approvalRequired, reason, currentPrice, lastApprovedPrice, priceVersion }
 */
export function evaluatePriceApproval({ product, qty, selectedPrice, priceType, isBoxUnit, isWholesaleCustomer }) {
  if (!product || selectedPrice == null) return { approvalRequired: false, reason: null }

  const retail    = product.retail    ?? null
  const wholesale = product.wholesale ?? null
  const threshold = product.wholesale_threshold ?? product.qty_in_box ?? null
  const priceVer  = product.price_version ?? 1
  const lastApprovedPrice   = product.last_approved_price ?? null
  const lastApprovedVersion = product.last_approved_version ?? null

  // 1. LAST APPROVED PRICE — valid only if it still belongs to the current
  //    price version. Admin-approved prices from before a price change are invalid.
  const lastApprovedValid =
    lastApprovedPrice != null &&
    lastApprovedVersion != null &&
    lastApprovedVersion === priceVer

  if (lastApprovedValid && Math.abs(selectedPrice - lastApprovedPrice) < 0.001) {
    return { approvalRequired: false, reason: null, currentPrice: retail, lastApprovedPrice, priceVersion: priceVer }
  }

  // 2. RETAIL PRICE — always valid for retail customers
  if (retail != null && Math.abs(selectedPrice - retail) < 0.001) {
    return { approvalRequired: false, reason: null, currentPrice: retail, priceVersion: priceVer }
  }

  // 3. WHOLESALE PRICE — valid (no approval needed) only when:
  //    (a) sold as Box unit (auto-wholesale eligible — unit rule, not customer rule), OR
  //    (b) customer is a Wholesale customer (ledger_category = 'WHOLESALE-CUSTOMER').
  //
  //    NOTE: qty >= threshold NO LONGER exempts retail customers from approval.
  //    A retail customer selecting wholesale price always needs Admin sign-off,
  //    regardless of quantity. The threshold exemption only applied to wholesale
  //    customers (who already get WP by default) and box-unit sales (hardware rule).
  //    Removing the threshold bypass for retail customers closes the gap where a
  //    retail shop could silently get wholesale pricing just by ordering in bulk.
  if (wholesale != null && Math.abs(selectedPrice - wholesale) < 0.001) {
    const boxUnitOk         = isBoxUnit === true
    const wholesaleCustomer = isWholesaleCustomer === true
    if (boxUnitOk || wholesaleCustomer) {
      return { approvalRequired: false, reason: null, currentPrice: retail, priceVersion: priceVer }
    }
    // Retail customer selected wholesale price — always requires Admin approval.
    return {
      approvalRequired: true,
      reason: 'WHOLESALE_PRICE_RETAIL_CUSTOMER',
      currentPrice: retail,
      lastApprovedPrice,
      priceVersion: priceVer,
      message: `Wholesale price selected for a retail customer — Admin approval required`
    }
  }

  // 4. ANY PRICE BELOW RETAIL/CURRENT — requires approval
  const currentFloor = retail ?? wholesale ?? 0
  if (selectedPrice < currentFloor - 0.001) {
    const reason = product.price_increased ? 'RECENT_PRICE_INCREASE' : 'PRICE_BELOW_CURRENT'
    return {
      approvalRequired: true,
      reason,
      currentPrice: currentFloor,
      lastApprovedPrice,
      priceVersion: priceVer,
      message: `Selected price ₹${selectedPrice} is below current authorized price ₹${currentFloor}`
    }
  }

  // 5. CUSTOM PRICE (above retail but still custom) — allow unless explicitly below floor
  return { approvalRequired: false, reason: null, currentPrice: retail, priceVersion: priceVer }
}

/**
 * Load all orders where bill_approval_required=true and bill_approval_status='pending'.
 * Used by Admin approval screen and Sales Rep pending bills view.
 */
/**
 * Load bills that were REJECTED by Admin for this Sales Rep.
 * Used by the rep's Performance page to show rejection notifications.
 */
export async function loadRejectedBills({ salesRepId } = {}) {
  if (!salesRepId) return []
  const { data, error } = await supabase
    .from('orders')
    .select(`id, shop_name, route, order_date, created_at, total_value, total_products,
             bill_approval_status, bill_rejection_reason, bill_approved_at,
             order_items(id, product_name, qty, unit, unit_price, normal_price, approval_status)`)
    .eq('sales_rep_id', salesRepId)
    .eq('bill_approval_status', 'rejected')
    .eq('hidden', false)
    .order('bill_approved_at', { ascending: false })
    .limit(20)
  if (error) { console.error(error); return [] }
  return data || []
}

export async function loadPendingApprovalBills({ salesRepId } = {}) {
  // v190: includes approval_version so Admin can see which resubmission version this is
  let q = supabase
    .from('orders')
    .select(`id, shop_name, route, order_date, created_at, total_value, total_products,
             sales_rep_id, bill_approval_status, bill_approval_required,
             profiles(full_name),
             order_items(id, product_name, qty, unit, unit_price, normal_price,
                         approval_status, approved_price, approval_reason_type, approval_other_reason, approval_competitor_name)`)
    .eq('bill_approval_required', true)
    .eq('bill_approval_status', 'pending')
    .eq('hidden', false)
    .order('created_at', { ascending: false })
  if (salesRepId) q = q.eq('sales_rep_id', salesRepId)
  const { data, error } = await q
  if (error) { console.error(error); return [] }
  return data || []
}

/**
 * Admin: approve an entire order (ORDER-LEVEL, v190).
 * Approves ALL pending items at their currently-requested prices.
 * Releases the order to Billing Team.
 * Saves last_approved_price on products for audit/future reuse.
 *
 * @param {string} orderId
 * @param {Array}  itemOverrides  IGNORED in v190 — kept for API compatibility.
 *                                All pending items approved at unit_price.
 * @param {object} adminUser      { id, full_name }
 * @param {object} reasonPayload  { reasonType, competitorName?, otherReason? }
 */
export async function approveBill(orderId, itemOverrides, adminUser, reasonPayload = {}) {
  const now = new Date().toISOString()

  // 1. Fetch the order's customer_id (for per-customer approval records)
  //    and all pending items in this order
  const [{ data: orderRow }, { data: pendingItems, error: fetchErr }] = await Promise.all([
    supabase.from('orders').select('customer_id').eq('id', orderId).maybeSingle(),
    supabase.from('order_items')
      .select('id, product_id, unit_price, qty')
      .eq('order_id', orderId)
      .eq('approval_status', 'pending')
      .neq('removed', true)
  ])
  if (fetchErr) throw fetchErr
  const customerId = orderRow?.customer_id || null

  // 2. Approve ALL pending items at their requested price (unit_price)
  if (pendingItems && pendingItems.length > 0) {
    await supabase.from('order_items').update({
      approval_status: 'approved',
      approved_by: adminUser?.full_name || null,
      approved_by_id: adminUser?.id || null,
      approved_at: now,
      approved_price: null,  // null = use unit_price (what rep requested)
      approval_reason_type: reasonPayload.reasonType || null,
      approval_competitor_name: reasonPayload.competitorName || null,
      approval_other_reason: reasonPayload.otherReason || null
    }).eq('order_id', orderId).eq('approval_status', 'pending')

    // Save approval records — both product-level (existing, for backward compat)
    // and per-customer (new, spec §8 — so Shop X's approval doesn't auto-apply to Shop Y).
    for (const item of pendingItems) {
      if (item.product_id && item.unit_price != null) {
        try {
          const { data: prod } = await supabase.from('products')
            .select('price_version').eq('id', item.product_id).maybeSingle()
          if (prod) {
            const priceVer = prod.price_version ?? 1
            // Product-level last_approved_price (backward compat — kept as fallback)
            await supabase.from('products').update({
              last_approved_price: Number(item.unit_price),
              last_approved_version: priceVer,
              last_approved_at: now,
              last_approved_by: adminUser?.id || null
            }).eq('id', item.product_id)

            // Per-customer approval (spec §8 — shop-scoped, not global)
            // Upsert: if a prior approval for this product+customer+version exists,
            // update it; otherwise insert. Use a raw upsert on the unique constraint.
            if (customerId) {
              await supabase.from('customer_price_approvals').upsert({
                product_id: item.product_id,
                customer_id: customerId,
                approved_price: Number(item.unit_price),
                approved_price_version: priceVer,
                status: 'approved',
                order_id: orderId,
                approved_by: adminUser?.id || null,
                approved_at: now
              }, {
                onConflict: 'product_id,customer_id',
                ignoreDuplicates: false
              })
            }
          }
        } catch (e) { console.error('approval records update (non-fatal):', e) }
      }
    }
  }

  // 3. Recalculate order totals from all active (non-removed) items
  try {
    const { data: remaining } = await supabase
      .from('order_items')
      .select('qty, unit_price, approved_price')
      .eq('order_id', orderId)
      .neq('removed', true)
    if (remaining) {
      const totalValue = remaining.reduce((s, i) => s + ((i.approved_price ?? i.unit_price ?? 0) * i.qty), 0)
      const totalQty = remaining.reduce((s, i) => s + i.qty, 0)
      await supabase.from('orders').update({
        total_value: Math.round(totalValue),
        total_quantity: totalQty,
        total_products: remaining.length
      }).eq('id', orderId)
    }
  } catch (e) { console.error('recalc totals (non-fatal):', e) }

  // 4. Release order to Billing Team
  const { error, data: approvedOrder } = await supabase.from('orders').update({
    bill_approval_status: 'approved',
    bill_approved_at: now,
    bill_approved_by: adminUser?.id || null,
    billing_status: 'pending'
  }).eq('id', orderId).select('shop_name, order_date').single()
  if (error) throw error

  // 5. Release sibling orders (same shop+date) that were also blocked
  if (approvedOrder?.shop_name && approvedOrder?.order_date) {
    await supabase.from('orders')
      .update({ billing_status: 'pending', bill_approval_status: 'approved', bill_approved_at: now })
      .eq('shop_name', approvedOrder.shop_name)
      .eq('order_date', approvedOrder.order_date)
      .eq('billing_status', 'pending_approval')
      .neq('id', orderId)
  }

  // 6. Audit history (non-fatal)
  try {
    const { data: ord } = await supabase.from('orders')
      .select('shop_name, route, order_date, sales_rep_id')
      .eq('id', orderId).maybeSingle()
    if (ord) {
      let repName = null
      if (ord.sales_rep_id) {
        const { data: prof } = await supabase.from('profiles').select('full_name').eq('id', ord.sales_rep_id).maybeSingle()
        repName = prof?.full_name || null
      }
      await supabase.from('price_approval_history').insert({
        order_id: orderId,
        product_name: `[ORDER APPROVED] ${ord.shop_name || '—'}`,
        shop_name: ord.shop_name, route: ord.route,
        sales_rep_name: repName, order_date: ord.order_date,
        decision: 'approved',
        decided_by: adminUser?.full_name || null,
        decided_by_id: adminUser?.id || null,
        decided_at: now,
        reason_type: reasonPayload.reasonType || null,
        competitor_name: reasonPayload.competitorName || null,
        other_reason: reasonPayload.otherReason || null
      })
    }
  } catch (e) { console.error('[approveBill] audit history (non-fatal):', e) }
}

/**
 * Admin: reject an entire bill.
 */
export async function rejectBill(orderId, adminUser, reason) {
  // ORDER-LEVEL REJECTION (v190):
  // Marks all pending items as 'rejected' but NOT removed — they stay visible
  // so the Sales Rep can see the full order and resubmit with revised prices.
  // billing_status stays 'pending_approval' so Billing never sees this order.
  // Bumps approval_version so resubmission history is tracked correctly.
  const now = new Date().toISOString()
  const { error } = await supabase.from('orders').update({
    bill_approval_status: 'rejected',
    bill_rejection_reason: reason || null,
    bill_approved_at: now,
    bill_approved_by: adminUser?.id || null,
    // billing_status stays 'pending_approval' — invisible to Billing until approved
  }).eq('id', orderId)
  if (error) throw error

  // Mark ALL pending items as rejected (not removed — rep needs to see them for resubmit)
  await supabase.from('order_items').update({
    approval_status: 'rejected',
    rejection_reason: reason || null,
    approved_by: adminUser?.full_name || null,
    approved_by_id: adminUser?.id || null,
    approved_at: now
  }).eq('order_id', orderId).eq('approval_status', 'pending')

  // Write audit history record (non-fatal)
  try {
    const { data: ord } = await supabase.from('orders')
      .select('shop_name, route, order_date, sales_rep_id')
      .eq('id', orderId).maybeSingle()
    if (ord) {
      let repName = null
      if (ord.sales_rep_id) {
        const { data: prof } = await supabase.from('profiles').select('full_name').eq('id', ord.sales_rep_id).maybeSingle()
        repName = prof?.full_name || null
      }
      await supabase.from('price_approval_history').insert({
        order_id: orderId,
        product_name: `[ORDER REJECTED] ${ord.shop_name || '—'}`,
        shop_name: ord.shop_name, route: ord.route,
        sales_rep_name: repName,
        order_date: ord.order_date,
        decision: 'rejected',
        decided_by: adminUser?.full_name || null,
        decided_by_id: adminUser?.id || null,
        decided_at: now,
        rejection_reason: reason || null
      })
    }
  } catch (e) { console.error('[rejectBill] audit history (non-fatal):', e) }
}

export async function loadPendingApprovals({ fromDate, toDate } = {}) {
  // If the admin has turned the approval workflow OFF, show nothing in the
  // pending list — even if old items have approval_status='pending'. The
  // admin explicitly chose to bypass approval; those items should not keep
  // appearing. They remain in the DB and will reappear if approval is
  // turned back ON.
  const approvalEnabled = await loadPriceApprovalEnabled()
  if (!approvalEnabled) return []

  // Date range filtering uses orders.order_date (YYYY-MM-DD string, already
  // in IST — no timezone conversion needed, no UTC boundary bugs).
  // When no range is given, defaults to last 3 IST calendar days so the
  // active queue stays focused without deleting historical data.
  const todayIST = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
  const defaultFrom = (() => {
    const d = new Date(todayIST); d.setDate(d.getDate() - 2); return d.toLocaleDateString('en-CA')
  })()
  const start = fromDate || defaultFrom
  const end   = toDate   || todayIST

  // [ADMIN PRICE APPROVALS] Debug: log query parameters
  const _nowIST = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
  const _nowTime = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false })
  console.log('[ADMIN PRICE APPROVALS] loadPendingApprovals called')
  console.log('[ADMIN PRICE APPROVALS] Selected Start Date:', start)
  console.log('[ADMIN PRICE APPROVALS] Selected End Date:', end)
  console.log('[ADMIN PRICE APPROVALS] Current IST Date/Time:', _nowIST, _nowTime)
  console.log('[ADMIN PRICE APPROVALS] Query: order_items WHERE approval_status=pending AND orders.order_date BETWEEN', start, 'AND', end)

  let q = supabase
    .from('order_items')
    .select(`
      id, product_name, qty, unit, unit_price, normal_price, price_type, edited_at,
      order_id, orders!inner ( id, shop_name, route, order_date, sales_rep_id, created_at )
    `)
    .eq('approval_status', 'pending')
    .gte('orders.order_date', start)
    .lte('orders.order_date', end)
    .order('id', { ascending: false })
  const { data, error } = await q
  if (error) {
    console.error('[ADMIN PRICE APPROVALS] Query Error:', error.message, error)
    console.error('load pending approvals failed', error)
    return []
  }
  console.log('[ADMIN PRICE APPROVALS] Returned Count:', (data || []).length, 'rows (before orders filter)')
  if (data && data.length === 0) {
    console.warn('[ADMIN PRICE APPROVALS] ⚠ NO PENDING APPROVALS FOUND for date range', start, '→', end)
    console.warn('[ADMIN PRICE APPROVALS]   Possible causes: (1) approval_status column missing (run sql/55), (2) no orders in this date range have custom prices, (3) date filter is excluding new records, (4) orders.order_date is wrong')
  } else if (data && data.length > 0) {
    console.log('[ADMIN PRICE APPROVALS] ✅ Found items:', data.map(r => `${r.product_name} (order_date: ${r.orders?.order_date}, approval_status: pending)`).join(', '))
  }
  const rows = (data || []).filter((r) => r.orders)
  const repIds = [...new Set(rows.map((r) => r.orders.sales_rep_id).filter(Boolean))]
  if (repIds.length) {
    const { data: reps } = await supabase.from('profiles').select('id, full_name').in('id', repIds)
    const nameById = new Map((reps || []).map((r) => [r.id, r.full_name]))
    rows.forEach((r) => { r.sales_rep_name = nameById.get(r.orders.sales_rep_id) || '—' })
  }

  // Fetch current MRP / Retail / Wholesale for each product so Admin can
  // see full pricing context on the approval card.
  const productNames = [...new Set(rows.map((r) => (r.product_name || '').trim()).filter(Boolean))]
  if (productNames.length) {
    const { data: prods } = await supabase
      .from('products')
      .select('name, mrp, retail, wholesale')
      .in('name', productNames)
    if (prods) {
      const priceByName = new Map(prods.map((p) => [
        (p.name || '').trim().toUpperCase(),
        { mrp: p.mrp, retail: p.retail, wholesale: p.wholesale }
      ]))
      rows.forEach((r) => {
        const key = (r.product_name || '').trim().toUpperCase()
        const pricing = priceByName.get(key)
        if (pricing) {
          r.product_mrp = pricing.mrp ?? null
          r.product_retail = pricing.retail ?? null
          r.product_wholesale = pricing.wholesale ?? null
        }
      })
    }
  }

  return rows
}

/** Just the count — cheap, for the sidebar badge.
 *  Uses the same date range as loadPendingApprovals so the badge always
 *  matches what the Admin sees in the approval list. */
export async function countPendingApprovals({ fromDate, toDate } = {}) {
  const todayIST = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
  const defaultFrom = (() => {
    const d = new Date(todayIST); d.setDate(d.getDate() - 2); return d.toLocaleDateString('en-CA')
  })()
  const start = fromDate || defaultFrom
  const end   = toDate   || todayIST

  // Need to join orders to filter by order_date — head-count with !inner join.
  console.log('[ADMIN PRICE APPROVALS] countPendingApprovals: date range', start, '→', end)
  const { data, error } = await supabase
    .from('order_items')
    .select('id, orders!inner(order_date)')
    .eq('approval_status', 'pending')
    .gte('orders.order_date', start)
    .lte('orders.order_date', end)
  if (error) {
    console.error('[ADMIN PRICE APPROVALS] countPendingApprovals Query Error:', error.message)
    console.error('count pending approvals failed', error)
    return 0
  }
  const cnt = (data || []).length
  console.log('[ADMIN PRICE APPROVALS] countPendingApprovals: badge count =', cnt)
  return cnt
}

/** Approve a special-priced line — it becomes normally billable immediately.
 *  reasonPayload: { reasonType, competitorName?, otherReason? }
 *  Also writes an immutable record to price_approval_history. */
export async function approveSpecialPrice(itemId, adminName, adminId, reasonPayload = {}) {
  const { reasonType, competitorName, otherReason, approvedPrice } = reasonPayload || {}
  const patch = {
    approval_status: 'approved',
    approved_by: adminName || null,
    approved_by_id: adminId || null,
    approved_at: new Date().toISOString(),
    approval_reason_type: reasonType || null,
    approval_competitor_name: competitorName || null,
    approval_other_reason: otherReason || null
  }
  // If admin modified the price, store it separately (unit_price = what rep
  // requested is preserved; approved_price = what admin actually allows).
  if (approvedPrice != null && !isNaN(Number(approvedPrice))) {
    patch.approved_price = Number(approvedPrice)
  }
  const { error } = await supabase
    .from('order_items')
    .update(patch)
    .eq('id', itemId)
    .eq('approval_status', 'pending') // idempotency guard
  if (error) throw error

  // ─── CRITICAL FIX (v182) ───────────────────────────────────────────────────
  // After approving this item, check whether any OTHER items in the same order
  // still have approval_status='pending'. If none remain, promote the parent
  // order from billing_status='pending_approval' → 'pending' so it becomes
  // visible to the Billing Team. Without this step the order stays permanently
  // hidden by loadBillingOrders' .neq('billing_status','pending_approval') filter.
  try {
    // Fetch the order_id for this item (and all sibling items in one query)
    const { data: siblings } = await supabase
      .from('order_items')
      .select('id, order_id, approval_status, removed, qty, unit_price, approved_price')
      .eq('id', itemId)
      .maybeSingle()
    if (siblings?.order_id) {
      const orderId = siblings.order_id
      // Count remaining pending items across the entire order
      const { count: stillPending } = await supabase
        .from('order_items')
        .select('id', { count: 'exact', head: true })
        .eq('order_id', orderId)
        .eq('approval_status', 'pending')
        .neq('removed', true)
      if ((stillPending || 0) === 0) {
        // All items resolved — recalculate totals from active (non-removed) items
        const { data: activeItems } = await supabase
          .from('order_items')
          .select('qty, unit_price, approved_price, removed')
          .eq('order_id', orderId)
        const active = (activeItems || []).filter((r) => !r.removed)
        const totalValue = active.reduce((s, r) => s + ((r.approved_price ?? r.unit_price ?? 0) * (r.qty || 0)), 0)
        const totalQty = active.reduce((s, r) => s + (r.qty || 0), 0)
        await supabase.from('orders').update({
          billing_status: 'pending',
          bill_approval_status: 'approved',
          bill_approved_at: new Date().toISOString(),
          bill_approval_required: false,
          total_value: Math.round(totalValue),
          total_quantity: totalQty,
          total_products: active.length
        })
          .eq('id', orderId)
          .eq('billing_status', 'pending_approval') // idempotency: only if still stuck
      }
    }
  } catch (transitionErr) {
    // Non-fatal: item is already approved; a stuck order is better than
    // a thrown error that makes Admin think the approval itself failed.
    console.error('[ADMIN APPROVAL] order transition to billing failed (non-fatal):', transitionErr)
  }
  // ─── END CRITICAL FIX ──────────────────────────────────────────────────────

  // Write audit history + per-customer approval cache (non-fatal if table not yet migrated)
  try {
    const { data: it } = await supabase
      .from('order_items')
      .select('id, order_id, product_id, product_name, qty, unit, unit_price, normal_price, price_type, orders(shop_name, route, order_date, sales_rep_id, customer_id)')
      .eq('id', itemId).maybeSingle()
    if (it) {
      // Resolve rep name separately (orders has sales_rep_id, not sales_rep_name)
      let repName = null
      if (it.orders?.sales_rep_id) {
        const { data: prof } = await supabase.from('profiles').select('full_name').eq('id', it.orders.sales_rep_id).maybeSingle()
        repName = prof?.full_name || null
      }

      // ─── v205 FIX: fetch product's current price_version for audit + cache ───
      // This is needed to (a) record approved_price_version in the immutable
      // history log, and (b) write the per-customer approval cache so the NEXT
      // time this rep uses "Last Price" for this shop+product the system finds a
      // valid shopApproval and skips the approval request (spec §7-9).
      let priceVer = null
      if (it.product_id) {
        try {
          const { data: prod } = await supabase
            .from('products')
            .select('price_version')
            .eq('id', it.product_id)
            .maybeSingle()
          priceVer = prod?.price_version ?? null
        } catch (_) { /* non-fatal — history insert still proceeds */ }
      }
      // ─── END v205 FIX ──────────────────────────────────────────────────────

      const finalApprovedPrice = approvedPrice != null ? Number(approvedPrice) : it.unit_price

      await supabase.from('price_approval_history').insert({
        order_item_id: it.id, order_id: it.order_id,
        product_name: it.product_name, shop_name: it.orders?.shop_name,
        route: it.orders?.route, sales_rep_name: repName,
        normal_price: it.normal_price, requested_price: it.unit_price,
        qty: it.qty, unit: it.unit, price_type: it.price_type,
        order_date: it.orders?.order_date,
        decision: 'approved', decided_by: adminName || null, decided_by_id: adminId || null,
        decided_at: new Date().toISOString(),
        reason_type: reasonType || null, competitor_name: competitorName || null,
        other_reason: otherReason || null,
        approved_price: finalApprovedPrice,
        // v205: record which price_version was current at approval time so
        // staleness can be audited even from the history table
        ...(priceVer != null ? { approved_price_version: priceVer } : {})
      })

      // ─── v205 FIX: write per-customer approval cache ────────────────────────
      // approveBill() (bill-level path) already does this; approveSpecialPrice()
      // (item-level path from AdminApprovalsPage) was missing it. Without this
      // record, ProductCard's shopApproval check finds nothing and re-prompts the
      // rep on every subsequent order for the same shop+product — even though
      // Admin already approved it. With this record, the existing
      // evaluatePriceApproval() logic correctly bypasses the prompt until the next
      // price change (spec §7-9).
      const customerId = it.orders?.customer_id
      if (customerId && it.product_id && priceVer != null) {
        try {
          const now = new Date().toISOString()
          await supabase.from('customer_price_approvals').upsert({
            product_id: it.product_id,
            customer_id: customerId,
            approved_price: finalApprovedPrice,
            approved_price_version: priceVer,
            status: 'approved',
            order_id: it.order_id,
            approved_by: adminId || null,
            approved_at: now
          }, {
            onConflict: 'product_id,customer_id',
            ignoreDuplicates: false
          })
          console.log('[ITEM APPROVAL] customer_price_approvals upserted for customer', customerId, 'product', it.product_id, 'version', priceVer)
        } catch (cpaErr) {
          console.error('[ITEM APPROVAL] customer_price_approvals upsert failed (non-fatal):', cpaErr)
        }
      }
      // ─── END v205 FIX ──────────────────────────────────────────────────────
    }
  } catch (histErr) { console.error('price_approval_history insert failed (non-fatal):', histErr) }
}

/** Reject a special-priced line — permanently excluded from billing with a reason. */
export async function rejectSpecialPrice(itemId, adminName, adminId, reason) {
  const { error } = await supabase
    .from('order_items')
    .update({
      approval_status: 'rejected',
      approved_by: adminName || null, approved_by_id: adminId || null,
      approved_at: new Date().toISOString(),
      rejection_reason: reason || null
    })
    .eq('id', itemId)
    .eq('approval_status', 'pending')
  if (error) throw error

  // ─── CRITICAL FIX (v182) ───────────────────────────────────────────────────
  // Same as approveSpecialPrice: after rejecting this item check whether any
  // sibling items are still 'pending'. If none remain, the order stays in
  // pending_approval indefinitely — promote it so the Billing Team can see
  // the approved (non-rejected) items and note the rejection.
  // NOTE: We do NOT auto-promote if ANY approved items exist alongside
  // rejected ones — the rep must explicitly remove rejected items first
  // (which then triggers removeRejectedItemFromOrder's own promotion logic).
  // We DO promote if every non-removed item is approved (rejection happened
  // but other items passed — rare edge case where all items rejected is
  // handled by the rep removing them one by one).
  try {
    const { data: refItem } = await supabase
      .from('order_items')
      .select('order_id')
      .eq('id', itemId)
      .maybeSingle()
    if (refItem?.order_id) {
      const orderId = refItem.order_id
      const { count: stillPending } = await supabase
        .from('order_items')
        .select('id', { count: 'exact', head: true })
        .eq('order_id', orderId)
        .eq('approval_status', 'pending')
        .neq('removed', true)
      // Only auto-promote if there are approved items and nothing pending
      if ((stillPending || 0) === 0) {
        const { data: allItems } = await supabase
          .from('order_items')
          .select('qty, unit_price, approved_price, removed, approval_status')
          .eq('order_id', orderId)
        const active = (allItems || []).filter((r) => !r.removed)
        const hasApproved = active.some((r) => r.approval_status === 'approved')
        if (hasApproved) {
          // At least some items approved, none pending — promote so Billing can
          // process the approved items (they'll see rejection notes on the others)
          const approvedItems = active.filter((r) => r.approval_status === 'approved')
          const totalValue = approvedItems.reduce((s, r) => s + ((r.approved_price ?? r.unit_price ?? 0) * (r.qty || 0)), 0)
          const totalQty = approvedItems.reduce((s, r) => s + (r.qty || 0), 0)
          await supabase.from('orders').update({
            billing_status: 'pending',
            bill_approval_status: 'approved',
            bill_approved_at: new Date().toISOString(),
            bill_approval_required: false,
            total_value: Math.round(totalValue),
            total_quantity: totalQty,
            total_products: approvedItems.length
          })
            .eq('id', orderId)
            .eq('billing_status', 'pending_approval')
        }
      }
    }
  } catch (transitionErr) {
    console.error('[ADMIN REJECTION] order transition to billing failed (non-fatal):', transitionErr)
  }
  // ─── END CRITICAL FIX ──────────────────────────────────────────────────────

  // Write audit history (non-fatal)
  try {
    const { data: it } = await supabase
      .from('order_items')
      .select('id, order_id, product_name, qty, unit, unit_price, normal_price, price_type, orders(shop_name, route, order_date, sales_rep_id)')
      .eq('id', itemId).maybeSingle()
    if (it) {
      let repName = null
      if (it.orders?.sales_rep_id) {
        const { data: prof } = await supabase.from('profiles').select('full_name').eq('id', it.orders.sales_rep_id).maybeSingle()
        repName = prof?.full_name || null
      }
      await supabase.from('price_approval_history').insert({
        order_item_id: it.id, order_id: it.order_id,
        product_name: it.product_name, shop_name: it.orders?.shop_name,
        route: it.orders?.route, sales_rep_name: repName,
        normal_price: it.normal_price, requested_price: it.unit_price,
        qty: it.qty, unit: it.unit, price_type: it.price_type,
        order_date: it.orders?.order_date,
        decision: 'rejected', decided_by: adminName || null, decided_by_id: adminId || null,
        decided_at: new Date().toISOString(), rejection_reason: reason || null
      })
    }
  } catch (histErr) { console.error('price_approval_history insert failed (non-fatal):', histErr) }
}

/** Load approval history for the Admin reports page. */
/** Read the current price_approval_enabled flag from the database.
 *  Falls back to the build-time constant if the column doesn't exist yet. */
export async function loadPriceApprovalEnabled() {
  try {
    const { data, error } = await supabase
      .from('app_settings')
      .select('price_approval_enabled')
      .eq('id', 1)
      .maybeSingle()
    if (error || !data) return PRICE_APPROVAL_ENABLED
    return data.price_approval_enabled ?? PRICE_APPROVAL_ENABLED
  } catch { return PRICE_APPROVAL_ENABLED }
}

/** Admin: set price_approval_enabled on/off at runtime.
 *  Also clears the module cache so the next order reflects the new setting. */
export async function setPriceApprovalEnabled(enabled) {
  const { error } = await supabase
    .from('app_settings')
    .update({ price_approval_enabled: enabled })
    .eq('id', 1)
  if (error) throw error
  _runtimeApprovalEnabled = enabled  // update cache immediately
}

// Runtime cache — populated on first saveCloudOrder call, cleared when admin
// toggles the setting. Avoids a DB round-trip on every product add.
let _runtimeApprovalEnabled = null

async function isApprovalEnabled() {
  if (_runtimeApprovalEnabled !== null) return _runtimeApprovalEnabled
  _runtimeApprovalEnabled = await loadPriceApprovalEnabled()
  return _runtimeApprovalEnabled
}

export async function loadApprovalHistory({ fromDate, toDate, repName } = {}) {
  let q = supabase.from('price_approval_history').select('*').order('created_at', { ascending: false }).limit(500)
  if (fromDate) q = q.gte('order_date', fromDate)
  if (toDate)   q = q.lte('order_date', toDate)
  if (repName)  q = q.eq('sales_rep_name', repName)
  const { data, error } = await q
  if (error) { console.error(error); return [] }
  return data || []
}

/** Notify Admin when a new order contains special-priced lines.
 *  Uses the existing sendAnnouncement infrastructure; non-fatal. */
export async function notifyAdminPriceApprovalRequired(specialItems, shopName, repName) {
  if (!PRICE_APPROVAL_ENABLED || !specialItems?.length) return
  try {
    const lines = specialItems.map((i) =>
      `• ${i.name}: ₹${i.normalPrice ?? '?'} → ₹${i.finalSellingPrice ?? '?'}`
    ).join('\n')
    await sendAnnouncement({
      title: `Price Approval Required — ${shopName}`,
      body: `${repName} is requesting a special price.\n${lines}\nGo to Admin → Price Approvals to review.`,
      highPriority: true,
      audience: 'admin',
      expiresInDays: 7,
      notifType: 'price_approval'
    })
  } catch (e) { console.error('price approval notification (non-fatal):', e) }
}

/**
 * "Delete" a pending stock-out item from the rep's Pending Orders list.
 *
 * Deliberately non-destructive — it stamps the line as dismissed rather than
 * deleting anything. The parent order is untouched (it is already verified
 * and billed; deleting it would destroy invoice data) and the original
 * "removed as Stock Out" record is preserved, so billing history and the
 * Partial Verification report stay complete. Guarded so an already-dismissed
 * or already-rescheduled line can't be dismissed again.
 */
export async function dismissPendingStockOut(itemId, repName) {
  const { error } = await supabase
    .from('order_items')
    .update({ pending_dismissed_at: new Date().toISOString(), pending_dismissed_by: repName || null })
    .eq('id', itemId)
    .is('pending_dismissed_at', null)
    .is('rescheduled_order_id', null)
  if (error) throw error
}

/**
 * Tell the billing team that a rep added products to an order that was
 * already placed, so an add-on is never missed.
 *
 * Reuses the existing announcement infrastructure rather than adding a
 * parallel one: recipients, read/unread state, the bell badge and the
 * on-entry popup all already work off announcement_recipients. Targeted
 * explicitly at billing_team user ids (audience 'billing'), tagged
 * notif_type 'addon' so the popup shows a "View Bill" action, and
 * auto-expiring so old add-on alerts don't pile up.
 *
 * Non-fatal by design — the caller must not fail an order save just because
 * the notification could not be sent.
 */
/**
 * User ids for a role, resolvable from ANY signed-in session.
 *
 * `profiles` normally restricts each user to their own row, so a sales rep
 * selecting billing users directly gets an empty list — and a notification
 * with no recipients is silently dropped. The security-definer RPC from
 * migration 62 returns just the ids regardless of the caller's role. Falls
 * back to a direct select so this still works if that migration has not been
 * applied and the table happens to be readable.
 */
async function userIdsForRole(role) {
  const rpc = await supabase.rpc('user_ids_for_role', { p_role: role })
  if (!rpc.error && Array.isArray(rpc.data)) {
    const ids = rpc.data.map((r) => (typeof r === 'string' ? r : r?.id ?? r?.user_ids_for_role)).filter(Boolean)
    if (ids.length) return ids
  }
  const { data } = await supabase.from('profiles').select('id').eq('role', role)
  return (data || []).map((r) => r.id)
}

export async function notifyBillingOfAddon({ shopName, route, addonLines, repName, orderId }) {
  // Routed through the create_addon_announcement RPC (migration 63) rather
  // than a direct table insert. That RPC is SECURITY DEFINER and validates,
  // server-side, that the caller is a sales rep, that orderId genuinely
  // belongs to them, and that the order actually contains an add-on line —
  // narrower and more robust than any RLS policy on the announcements table
  // could enforce, and it doesn't depend on that policy being configured
  // correctly at all. orderId is required for this path (the RPC's whole
  // validation model is built around a real, owned order), which is always
  // the case here since this is only ever called after saveCloudOrder
  // returns a genuine new order id.
  if (!orderId) {
    console.error('notifyBillingOfAddon called without an orderId — cannot validate ownership, notification skipped.')
    return null
  }

  const lines = (addonLines || []).filter((l) => l && l.name)
  const productSummary = lines.length
    ? lines.map((l) => `• ${l.name} — Qty ${l.qty ?? '—'} ${l.unit || ''}`.trim()).join('\n')
    : '—'

  const { data, error } = await supabase.rpc('create_addon_announcement', {
    p_order_id: orderId,
    p_shop_name: shopName || null,
    p_route: route || null,
    p_rep_name: repName || null,
    p_product_summary: productSummary
  })
  if (error) {
    console.error(
      'Add-on notification RPC failed. If this mentions "function does not exist", ' +
      'run sql/63_addon_announcement_rpc.sql.',
      error
    )
    throw error
  }
  return data // the new announcement's id, or null is never returned on success — a thrown error is how failure surfaces now
}

/**
 * Billing removed a product from an order -> tell THAT order's sales rep.
 *
 * Fired from the confirmed removal action itself (not from any status or
 * scheduling change), so the alert always carries the real product and the
 * real reason Billing entered. Targeted at the single rep who owns the order,
 * so no other rep is disturbed.
 *
 * Reuses the announcement infrastructure: recipients, read/unread state, the
 * bell list and the realtime channel all already exist, so the rep gets a live
 * popup, keeps the item in their notification list afterwards, and an
 * acknowledged alert is never shown twice. Deliberately returns null rather
 * than throwing on missing data — a notification must never fail a removal
 * that Billing already committed.
 */
// Short order reference, matching the format shown on printed slips.
// Defined locally rather than imported from a component, to keep this data
// module free of UI dependencies (and avoid a circular import).
function shortOrderRef(orderId) {
  return orderId ? String(orderId).slice(0, 8).toUpperCase() : '—'
}

export async function notifyRepOfRemoval({ orderId, productName, reason, removedBy }) {
  if (!orderId) return null
  const { data: order, error } = await supabase
    .from('orders')
    .select('id, shop_name, route, sales_rep_id')
    .eq('id', orderId)
    .single()
  if (error || !order || !order.sales_rep_id) {
    // Same silent-drop trap as the add-on lookup: if billing cannot read this
    // order row (or it carries no rep id) there is nobody to notify, and
    // returning quietly would hide that completely.
    console.error(
      'Removal notification skipped: could not resolve the order or its sales rep.',
      { orderId, error }
    )
    return null
  }

  const body = [
    `${productName || 'A product'} was removed from Order #${shortOrderRef(order.id)}.`,
    '',
    `Product: ${productName || '—'}`,
    `Reason: ${reason || '—'}`,
    `Customer: ${order.shop_name || '—'}${order.route ? `, ${order.route}` : ''}`,
    `Order: #${shortOrderRef(order.id)}`,
    removedBy ? `Removed by: ${removedBy}` : ''
  ].filter(Boolean).join('\n')

  return sendAnnouncement({
    title: 'Product Removed from Order',
    body,
    highPriority: true,
    audience: 'billing',       // targeted list below; not a broadcast
    repIds: [order.sales_rep_id],
    expiresInDays: 7,
    notifType: 'removal',
    refOrderId: order.id
  })
}

/**
 * Overdue pending orders, per sales rep — orders with order_date strictly
 * BEFORE today that are still billing_status='pending'. This is what makes
 * backlog visible without inflating the daily "Today" count: the two counts
 * are now genuinely separate numbers with separate meanings, rather than one
 * trying to serve both purposes at once.
 *
 * Kept intentionally simple (a count per rep, not a full order list) — the
 * existing date picker already lets billing open any specific past date and
 * see that day's exact orders once they know to look; this just tells them
 * WHEN they need to.
 */
export async function loadOverduePendingCounts() {
  const today = todayIST()
  const { data, error } = await supabase
    .from('orders')
    .select('sales_rep_id')
    .eq('hidden', false)
    .eq('billing_status', 'pending')
    .lt('order_date', today)
  if (error) { console.error('load overdue pending counts failed', error); return {} }
  const counts = {}
  for (const row of data || []) {
    if (!row.sales_rep_id) continue
    counts[row.sales_rep_id] = (counts[row.sales_rep_id] || 0) + 1
  }
  return counts
}

/**
 * Resolves an order id (e.g. from an announcement's ref_order_id) into the
 * rep + date needed to navigate Billing's UI to it — used by the "View
 * Bill"/"View Order" click-through from AnnouncementPopup. A small, focused
 * read; kept here rather than importing supabase directly into
 * BillingDashboard.jsx, matching how every other DB access in this app
 * goes through this module.
 */
export async function resolveOrderForNavigation(orderId) {
  const { data, error } = await supabase
    .from('orders')
    .select('id, sales_rep_id, order_date')
    .eq('id', orderId)
    .single()
  if (error || !data) return null
  const { data: rep } = await supabase.from('profiles').select('id, full_name').eq('id', data.sales_rep_id).single()
  return { orderId, repId: data.sales_rep_id, repName: rep?.full_name || '—', dateStr: data.order_date }
}

/**
 * The customer's ledger category, looked up by shop name + route — the same
 * identity pair loadCustomerLastPrices already uses. Needed so AddOnFlowModal
 * can compute the same customer-category default price type (WHOLESALE for
 * ledger WHOLESALE-CUSTOMER, else RETAIL) that OrderPage already computes
 * from its own loaded `customer` object. AddOnFlowModal only ever receives
 * an existing order (shop_name/route), not the full customer record, so this
 * is the minimal lookup needed rather than duplicating customer-loading logic.
 */
export async function loadCustomerLedgerCategory(shopName, route) {
  if (!shopName) return null
  const { data, error } = await supabase
    .from('customers')
    .select('ledger_category')
    .eq('shop_name', shopName)
    .eq('route', route || '')
    .limit(1)
    .maybeSingle()
  if (error) { console.error('load customer ledger category failed', error); return null }
  return data?.ledger_category || null
}

// ---------------------------------------------------------------------------
// Rep-facing product-level approval workflow (Admin Approval Pending feature)
// ---------------------------------------------------------------------------

/**
 * Load ALL approval-related order items for this sales rep — pending, approved,
 * and rejected. Includes bills that have been fully approved (so the APPROVED
 * tab can be populated). Also fetches price_approval_history per item for the
 * audit trail (attempt 1 → rejected → attempt 2 → approved, etc.).
 *
 * Returns items grouped by order. Each item carries:
 *   id, order_id, product_name, qty, unit, unit_price, normal_price,
 *   price_type, approval_status, approved_price, approved_by, approved_at,
 *   approval_reason, rejection_reason, and history[].
 */
/**
 * Load the Sales Rep's approval orders with ALL items (v190: ORDER-LEVEL).
 *
 * Returns every order that has bill_approval_required=true for this rep,
 * with ALL non-removed items — not just approval-status items.
 * This allows the "Resubmit Full Order" screen to show every product.
 *
 * The order_level_status is derived from orders.bill_approval_status:
 *   'pending'  — order is with Admin awaiting decision
 *   'rejected' — Admin rejected the order; rep needs to resubmit
 *   'approved' — Admin approved; order went to Billing
 */
export async function loadMyApprovalItems({ salesRepId } = {}) {
  if (!salesRepId) return []
  // v205 FIX: NO date filter — an approval order is relevant regardless of
  // when it was placed. A 90-day-old pending order is still pending; filtering
  // by date silently hides it and creates a stat card vs. modal mismatch.
  // NOTE: approval_version and bill_rejection_reason require sql/72 to be run.
  // They are fetched separately below so a missing column doesn't kill the whole query.
  const { data, error } = await supabase
    .from('orders')
    .select(`id, shop_name, route, order_date, created_at, billing_status,
             bill_approval_status, bill_approval_required, bill_approved_at,
             order_items(id, product_name, qty, unit, unit_price, normal_price, price_type,
                         approval_status, approved_price, approved_by, approved_at,
                         approval_reason_type, approval_competitor_name, approval_other_reason,
                         approval_reason, rejection_reason, removed)`)
    .eq('bill_approval_required', true)
    .eq('hidden', false)
    .eq('sales_rep_id', salesRepId)
    .order('created_at', { ascending: false })
    .limit(200)
  if (error) { console.error('[loadMyApprovalItems]', error); return [] }

  // Fetch order-level approval history from price_approval_history
  // (v190: order-level events have order_item_id = null, product_name = '[ORDER ...]')
  const allOrderIds = (data || []).map((o) => o.id)
  let orderHistoryMap = {}
  if (allOrderIds.length > 0) {
    try {
      const { data: hist } = await supabase
        .from('price_approval_history')
        .select('order_id, decision, decided_by, decided_at, rejection_reason, product_name')
        .in('order_id', allOrderIds)
        .order('decided_at', { ascending: true })
      if (hist) {
        for (const h of hist) {
          if (!orderHistoryMap[h.order_id]) orderHistoryMap[h.order_id] = []
          orderHistoryMap[h.order_id].push(h)
        }
      }
    } catch (e) { console.error('[loadMyApprovalItems] history fetch non-fatal', e) }
  }

  return (data || []).map((order) => ({
    ...order,
    // All non-removed items (including normal-price ones) for resubmit full-order view
    items: (order.order_items || []).filter((it) => !it.removed),
    // Order-level history for version display
    orderHistory: orderHistoryMap[order.id] || []
  })).filter((o) => o.items.length > 0)
}

/**
 * Returns ORDER-LEVEL counts {pending, approved, rejected} for the approval
 * summary tiles on the Sales Rep's Admin Approval view (v190: ORDER-LEVEL).
 *
 * Counts ORDERS, not items, using bill_approval_status on the orders table.
 * This matches the order-level workflow: "Rejected: 1" means one rejected
 * ORDER, not one rejected product.
 *
 * IMPORTANT: uses the IDENTICAL query strategy as loadMyApprovalItems so the
 * counts always match the lists.
 */
export async function loadMyApprovalSummary({ salesRepId } = {}) {
  if (!salesRepId) return { pending: 0, approved: 0, rejected: 0 }
  // v205 FIX: NO date filter — approval status has nothing to do with the period
  // picker. A pending order from 90 days ago is still pending; a date cutoff
  // would make the stat card and modal show 0 while the order silently rots.
  // loadPendingApprovalBills (used by the stat card fallback) also has no date
  // filter — this now matches it exactly.

  // Include order_items so we can apply the SAME existence filter that
  // loadMyApprovalItems applies: only count orders that have at least one
  // non-removed item. Without this, a pending order whose items are all
  // removed=true would be counted here but never appear in the list.
  const { data, error } = await supabase
    .from('orders')
    .select('id, bill_approval_status, order_items(id, removed)')
    .eq('bill_approval_required', true)
    .eq('hidden', false)
    .eq('sales_rep_id', salesRepId)
  if (error) { console.error('[loadMyApprovalSummary]', error); return { pending: 0, approved: 0, rejected: 0 } }

  // Mirror loadMyApprovalItems: only count orders with at least one non-removed item.
  const orders = (data || []).filter((o) =>
    (o.order_items || []).some((it) => !it.removed)
  )
  return {
    pending:  orders.filter((o) => o.bill_approval_status === 'pending').length,
    approved: orders.filter((o) => o.bill_approval_status === 'approved').length,
    rejected: orders.filter((o) => o.bill_approval_status === 'rejected').length,
  }
}

/**
 * @deprecated in v190 — use resubmitRejectedOrder() for order-level resubmission.
 * Kept for backward compatibility in case any stale references exist.
 * Delegates to resubmitRejectedOrder with the item's order_id.
 */
export async function resubmitRejectedItem(itemId, newPrice, repName, repId) {
  // Resolve order_id for this item, then delegate to order-level resubmit
  const { data: it } = await supabase
    .from('order_items')
    .select('order_id, unit_price')
    .eq('id', itemId)
    .maybeSingle()
  if (!it?.order_id) throw new Error('Item or order not found')
  // Call order-level resubmit with just this item's new price
  return resubmitRejectedOrder(it.order_id, [{ itemId, newPrice }], repName, repId)
}

/**
 * Sales Rep resubmits a FULL REJECTED ORDER with revised prices (v190).
 *
 * This is the order-level resubmission workflow:
 * - ALL rejected items in the order are reset to approval_status='pending'
 * - Each item gets its new requested price (if the rep changed it)
 * - The order's bill_approval_status resets to 'pending'
 * - approval_version is incremented (version 1 → 2 → 3...)
 * - An audit history record is written
 * - Admin sees the full order again in their queue
 *
 * @param {string} orderId       - orders.id
 * @param {Array}  priceUpdates  - [{ itemId, newPrice }] — items whose price changed
 *                                 Items not in this array keep their current unit_price
 * @param {string} repName       - for audit trail
 * @param {string} repId         - for audit trail
 */
export async function resubmitRejectedOrder(orderId, priceUpdates = [], repName, repId) {
  const now = new Date().toISOString()

  // 1. Read current order + all items for audit trail
  const { data: ord, error: ordErr } = await supabase
    .from('orders')
    .select('id, shop_name, route, order_date, bill_approval_status')
    .eq('id', orderId)
    .maybeSingle()
  if (ordErr || !ord) throw ordErr || new Error('Order not found')
  // Allow resubmit for both full order-level rejections AND orders where
  // individual items were rejected by Admin (item-level rejection via approveSpecialPrice/rejectSpecialPrice).
  // In the item-level case, bill_approval_status stays 'pending' but items have approval_status='rejected'.
  const billStatus = ord.bill_approval_status
  if (billStatus !== 'rejected' && billStatus !== 'pending') {
    throw new Error('Order cannot be resubmitted in its current state')
  }

  // 2. Apply new prices to items where the rep changed them
  const priceMap = new Map((priceUpdates || []).map((u) => [u.itemId, Number(u.newPrice)]))
  if (priceMap.size > 0) {
    for (const [itemId, price] of priceMap) {
      if (!isNaN(price) && price > 0) {
        await supabase.from('order_items')
          .update({ unit_price: price })
          .eq('id', itemId)
          .eq('order_id', orderId)  // safety: only update items in this order
      }
    }
  }

  // 3. Reset ALL rejected items (in this order) back to approval_status='pending'
  //    Clear old admin decision fields so Admin sees a fresh request
  const { error: itemErr } = await supabase.from('order_items').update({
    approval_status: 'pending',
    approved_by: null,
    approved_by_id: null,
    approved_at: null,
    approval_reason: null,
    approval_reason_type: null,
    approval_competitor_name: null,
    approval_other_reason: null,
    approved_price: null,
    rejection_reason: null
  }).eq('order_id', orderId).eq('approval_status', 'rejected').neq('removed', true)
  if (itemErr) throw itemErr

  // 4. Reset the order back to pending (clears rejection reason if it was a full rejection)
  //    For item-level-only rejections (bill_approval_status already 'pending'), this is a no-op
  //    on the status field but still clears bill_rejection_reason cleanly.
  const { error: orderErr } = await supabase.from('orders').update({
    bill_approval_status: 'pending',
    bill_rejection_reason: null,
    billing_status: 'pending_approval'  // keep hidden from Billing
  }).eq('id', orderId)
  if (orderErr) throw orderErr

  // 5. Audit trail — non-fatal
  try {
    await supabase.from('price_approval_history').insert({
      order_id: orderId,
      product_name: `[ORDER RESUBMITTED] ${ord.shop_name || '—'}`,
      shop_name: ord.shop_name, route: ord.route,
      sales_rep_name: repName || null,
      order_date: ord.order_date,
      decision: 'resubmitted',
      decided_by: repName || null, decided_by_id: repId || null,
      decided_at: now
    })
  } catch (e) { console.error('[resubmitRejectedOrder] audit history (non-fatal):', e) }
}

/**
 * Rep removes a rejected item from the order so the remaining items can
 * proceed to Billing. Marks the item as removed=true, approval_status='rejected'
 * (already is, but ensures consistency). If all items in the bill are
 * now either approved or removed, releases the bill to Billing.
 * @param {string} itemId   - order_items.id to remove
 * @param {string} repId    - for re-evaluation check
 */
export async function removeRejectedItemFromOrder(itemId, repId) {
  const { data: it, error: itErr } = await supabase
    .from('order_items')
    .select('id, order_id, product_name, qty, unit, unit_price')
    .eq('id', itemId)
    .maybeSingle()
  if (itErr || !it) throw itErr || new Error('Item not found')

  // Mark removed
  const { error } = await supabase
    .from('order_items')
    .update({ removed: true })
    .eq('id', itemId)
  if (error) throw error

  // Check if all remaining (non-removed) items for this order are approved.
  // If so, release the bill to Billing.
  const { data: remaining } = await supabase
    .from('order_items')
    .select('id, approval_status, removed, qty, unit_price, approved_price')
    .eq('order_id', it.order_id)
  const active = (remaining || []).filter((r) => !r.removed)
  const allApproved = active.length > 0 && active.every((r) => r.approval_status === 'approved' || r.approval_status == null)
  const stillPending = active.some((r) => r.approval_status === 'pending')

  if (allApproved && !stillPending) {
    // All remaining items approved — release to Billing automatically
    const now = new Date().toISOString()
    const totalValue = active.reduce((s, r) => s + ((r.approved_price ?? r.unit_price ?? 0) * r.qty), 0)
    const totalQty = active.reduce((s, r) => s + r.qty, 0)
    await supabase.from('orders').update({
      bill_approval_status: 'approved',
      bill_approved_at: now,
      billing_status: 'pending',
      total_value: Math.round(totalValue),
      total_quantity: totalQty,
      total_products: active.length
    }).eq('id', it.order_id)
  } else {
    // Still pending/rejected items — just recalculate totals
    const totalValue = active.reduce((s, r) => s + ((r.approved_price ?? r.unit_price ?? 0) * r.qty), 0)
    const totalQty = active.reduce((s, r) => s + r.qty, 0)
    await supabase.from('orders').update({
      total_value: Math.round(totalValue),
      total_quantity: totalQty,
      total_products: active.length
    }).eq('id', it.order_id)
  }
}

/**
 * Notify the sales rep when Admin rejects one of their price-approval items.
 * Called from the Admin side after rejectSpecialPrice(). Fire-and-forget.
 * @param {object} params
 * @param {string} params.orderId
 * @param {string} params.productName
 * @param {string} params.reason         - rejection reason text
 * @param {string} params.adminName      - Admin's display name
 * @param {number} params.requestedPrice - the price the rep asked for
 * @param {number} params.normalPrice    - the product's normal (RP/WP) price
 */
export async function notifyRepOfPriceRejection({ orderId, productName, reason, adminName, requestedPrice, normalPrice }) {
  if (!orderId) return null
  const { data: order, error } = await supabase
    .from('orders')
    .select('id, shop_name, route, sales_rep_id')
    .eq('id', orderId)
    .single()
  if (error || !order?.sales_rep_id) {
    console.error('[notifyRepOfPriceRejection] could not resolve order or rep', { orderId, error })
    return null
  }

  const body = [
    `${productName || 'A product'} price was rejected for ${order.shop_name || 'your order'}.`,
    '',
    `Product: ${productName || '—'}`,
    requestedPrice != null ? `Requested Price: ₹${Number(requestedPrice).toLocaleString('en-IN')}` : null,
    normalPrice != null ? `Normal Price: ₹${Number(normalPrice).toLocaleString('en-IN')}` : null,
    reason ? `Reason: ${reason}` : null,
    adminName ? `Rejected by: ${adminName}` : null,
    '',
    'Go to My Performance → Admin Approval Pending to change the price & resubmit, or remove this product.',
  ].filter((l) => l != null).join('\n')

  return sendAnnouncement({
    title: '⚠️ Price Rejected by Admin',
    body,
    highPriority: true,
    audience: 'billing',   // repIds below override who receives it
    repIds: [order.sales_rep_id],
    expiresInDays: 14,
    notifType: 'price_rejection',
    refOrderId: order.id
  })
}

// ────────────────────────────────────────────────────────────────────────────
// Purchase Order Scheduling (v181)
// ────────────────────────────────────────────────────────────────────────────

/** Load full PO dashboard data: vendors + schedule summaries. */
export async function loadPoDashboard(daysAhead = 30) {
  const { data, error } = await supabase.rpc('load_po_dashboard', { p_days_ahead: daysAhead })
  if (error) { console.error('loadPoDashboard error', error); return null }
  return data
}

/** Load ALL vendors (active + inactive) for Vendor Management. */
export async function loadVendorsAll() {
  const { data, error } = await supabase
    .from('vendors')
    .select('*')
    .order('vendor_name')
  if (error) { console.error('loadVendorsAll error', error); return [] }
  return data || []
}

/** Load vendors list with their config (for admin editing / PO workflow). */
export async function loadVendors() {
  const { data, error } = await supabase
    .from('vendors')
    .select('*')
    .eq('active', true)
    .order('vendor_name')
  if (error) { console.error('loadVendors error', error); return [] }
  return data || []
}

/** Update a vendor's PO config (admin only). */
export async function updateVendor(id, patch) {
  const { error } = await supabase
    .from('vendors')
    .update(patch)
    .eq('id', id)
  if (error) throw error
}

/**
 * Add a new vendor. Returns the created row.
 * Checks for duplicate by vendor_name (case-insensitive) before inserting.
 */
export async function addVendor(fields) {
  // Duplicate check: same vendor_name (case-insensitive) already in table
  const { data: existing } = await supabase
    .from('vendors')
    .select('id, vendor_name, active')
    .ilike('vendor_name', fields.vendor_name?.trim() || '')
    .limit(1)
  if (existing && existing.length > 0) {
    throw new Error(`Vendor "${existing[0].vendor_name}" already exists (${existing[0].active ? 'Active' : 'Inactive'}).`)
  }
  const { data, error } = await supabase
    .from('vendors')
    .insert({ ...fields, active: fields.active !== false })
    .select()
    .single()
  if (error) throw error
  return data
}

/**
 * Bulk upsert vendors from Excel import.
 * Matches on vendor_name (case-insensitive). Returns { inserted, updated, skipped }.
 * Never duplicates — uses upsert conflict on vendor_name.
 */
export async function importVendorsBulk(rows) {
  // Fetch existing vendors for duplicate detection
  const { data: existing } = await supabase.from('vendors').select('id, vendor_name')
  const existingMap = new Map((existing || []).map((v) => [
    (v.vendor_name || '').trim().toUpperCase(), v.id
  ]))

  const toInsert = []
  const toUpdate = []
  const duplicates = []

  for (const row of rows) {
    const nameKey = (row.vendor_name || '').trim().toUpperCase()
    if (!nameKey) continue
    if (existingMap.has(nameKey)) {
      const existingId = existingMap.get(nameKey)
      // Update existing — preserve id, merge new fields
      toUpdate.push({ id: existingId, ...row })
      duplicates.push(nameKey)
    } else {
      toInsert.push({ ...row, active: true })
    }
  }

  let inserted = 0
  let updated = 0

  if (toInsert.length > 0) {
    const { error } = await supabase.from('vendors').insert(toInsert)
    if (error) throw error
    inserted = toInsert.length
  }

  for (const v of toUpdate) {
    const { id, ...patch } = v
    const { error } = await supabase.from('vendors').update(patch).eq('id', id)
    if (error) console.error('importVendorsBulk update error', error)
    else updated++
  }

  return { inserted, updated, skipped: 0 }
}

/** Activate or deactivate a vendor. Does NOT delete — historical POs are preserved. */
export async function setVendorActive(id, active) {
  const { error } = await supabase
    .from('vendors')
    .update({ active, updated_at: new Date().toISOString() })
    .eq('id', id)
  if (error) throw error
}

/**
 * PM action on a PO schedule.
 * action: 'acknowledge' | 'generate' | 'ignore' | 'reschedule' | 'complete'
 */
export async function updatePoSchedule({ scheduleId, action, notes, rescheduleDate }) {
  const { data, error } = await supabase.rpc('update_po_schedule', {
    p_schedule_id:    scheduleId,
    p_action:         action,
    p_notes:          notes ?? null,
    p_reschedule_date: rescheduleDate ?? null
  })
  if (error) throw error
  return data
}

/** Load audit log for a specific schedule. */
export async function loadPoAuditLog(scheduleId, limit = 50) {
  const { data, error } = await supabase
    .from('po_audit_log')
    .select('*')
    .eq('schedule_id', scheduleId)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) { console.error('loadPoAuditLog error', error); return [] }
  return data || []
}

/** Load all PO schedules for admin monitoring view. */
export async function loadPoSchedulesAdmin({ status, from, to } = {}) {
  let q = supabase
    .from('purchase_order_schedules')
    .select(`
      id, scheduled_date, rescheduled_date, effective_date, status,
      notified_at, acknowledged_at, po_generated_at, ignored_at,
      escalated_at, completed_at, notes, created_at,
      vendors ( vendor_name, brand, po_gap_days )
    `)
    .order('effective_date', { ascending: false })
    .limit(200)
  if (status) q = q.eq('status', status)
  if (from)   q = q.gte('effective_date', from)
  if (to)     q = q.lte('effective_date', to)
  const { data, error } = await q
  if (error) { console.error('loadPoSchedulesAdmin error', error); return [] }
  return data || []
}
