import { calculateScheme } from './schemes.js'

// All orders and credit notes are delivered to this number.
export const ORDER_WHATSAPP_NUMBER = '919747076361'

// Brand options available throughout the app. Default is the first.
export const BRANDS = ['ALPHA TRADE LINKS', 'ZEDGO']

// Item numbering: bold numbers, consistent for any list length.
function itemNumber(i) {
  return `*${i + 1}.*`
}

const RULE = '\u2501'.repeat(20)
const TOP = '\u2554' + '\u2550'.repeat(17) + '\u2557'
const BOT = '\u255A' + '\u2550'.repeat(17) + '\u255D'
const EQ = '\u2550'.repeat(20)

/**
 * Build the order message in the boxed, easy-to-read layout.
 * items: [{ name, brand, qty, unit, slabs }]
 */
// Map a customer's saved Credit Days into the order's payment terms line.
function creditTerms(customer) {
  const cd = customer?.creditDays
  if (!cd || cd === 'No Credit') return 'Cash'
  return `${cd} Credit`
}

export function buildOrderMessage({ brand, customer, salesperson, items, isNewCustomer = false, location = null }) {
  const L = []
  L.push(TOP)
  L.push('\uD83D\uDED2  *NEW ORDER RECEIVED*')
  L.push(`\uD83C\uDFE2 *${brand || BRANDS[0]}*`)
  L.push(BOT)

  // One-time registration block for a newly created customer.
  // Empty optional fields are omitted entirely.
  if (isNewCustomer) {
    L.push('\uD83C\uDD95 *NEW CUSTOMER*')
    L.push(RULE)
    L.push(`*Customer Name:* ${customer?.name || '-'}`)
    if (customer?.phone) L.push(`*Phone:* ${customer.phone}`)
    if (customer?.gstn) L.push(`*GST:* ${customer.gstn}`)
    if (customer?.email) L.push(`*Email:* ${customer.email}`)
    if (customer?.area) L.push(`*Address:* ${customer.area}`)
    if (customer?.route) L.push(`*Route:* ${customer.route}`)
    if (customer?.category) L.push(`*Category:* ${customer.category}`)
    L.push(`*Credit Terms:* ${creditTerms(customer)}`)
    L.push('')
  }

  // On a first order the details above already cover this, so skip the repeat.
  if (!isNewCustomer) {
    L.push('*CUSTOMER DETAILS*')
    L.push(RULE)
    L.push(`*Customer:* ${customer?.name || '-'}`)
    if (customer?.category) L.push(`*Category:* ${customer.category}`)
    if (customer?.route) L.push(`*Route:* ${customer.route}`)
    L.push(`*Credit Terms:* ${creditTerms(customer)}`)
  }

  // Render one item's lines (name, qty, scheme if qualifying).
  const pushItem = (i, idx) => {
    L.push(`${itemNumber(idx)} ${i.name}`)
    const unit = i.unit && i.unit !== 'Piece' ? ` ${i.unit}` : ''
    L.push(`   \u279C Qty: *${i.qty}*${unit}`)
    // Show the special price only when the rep overrode it for this order.
    // Show the special price(s) the rep set for this order, labelled correctly.
    if (i.retailOverridden && i.retail != null) {
      L.push(`   \uD83D\uDCB0 Special Retail: *\u20B9${i.retail}*`)
    }
    if (i.wholesaleOverridden && i.wholesale != null) {
      L.push(`   \uD83D\uDCB0 Special Wholesale: *\u20B9${i.wholesale}*`)
    }
    const res = calculateScheme(i.qty, i.slabs)
    if (res.free > 0 && res.slab) {
      L.push(
        `   \uD83C\uDF81 Scheme: Buy ${res.slab.buy} Get ${res.slab.free} Free (*${res.free} Free*)`
      )
    }
  }

  const addons = items.filter((i) => i.isAddon)
  const originals = items.filter((i) => !i.isAddon)

  if (addons.length > 0) {
    // Rep loaded a previous order and added extras — split the two clearly so
    // the office knows the ORIGINAL was already sent and only ADD-ONS are new.
    L.push('\uD83D\uDCE6 *ORIGINAL ORDER*')
    L.push(RULE)
    originals.forEach((i, idx) => pushItem(i, idx))
    L.push(RULE)
    L.push('\u2795 *ADD-ONS* (newly added)')
    L.push(RULE)
    addons.forEach((i, idx) => pushItem(i, idx))
  } else {
    L.push('\uD83D\uDCE6 *ORDER ITEMS*')
    L.push(RULE)
    items.forEach((i, idx) => pushItem(i, idx))
  }

  L.push(RULE)
  L.push('*ORDER SUMMARY*')
  L.push(RULE)
  if (salesperson) L.push(`\uD83D\uDC68\u200D\uD83D\uDCBC *Salesperson:* ${salesperson}`)
  L.push(locationLine(location))
  L.push(EQ)
  L.push('\u2705 Please process this order.')
  L.push(EQ)
  return L.join('\n')
}

// Consistent GPS line used by orders, credit notes and visits.
// Prints a Google Maps link when coordinates exist, else a clear stamp so
// missing locations are visible for accountability.
export function locationLine(location) {
  if (location && location.latitude != null && location.longitude != null) {
    return `\uD83D\uDCCD Current Location:\nhttps://maps.google.com/?q=${location.latitude},${location.longitude}`
  }
  return '\uD83D\uDCCD Current Location: Not captured'
}

/**
 * Build the credit note (customer return) message in the same boxed layout.
 * lines: [{ name, brand, mrp, qty, reason }]
 */
export function buildCreditNoteMessage({ brand, customer, salesperson, lines, location = null }) {
  const totalQty = lines.reduce((s, l) => s + Number(l.qty || 0), 0)
  const L = []
  L.push(TOP)
  L.push('\uD83D\uDD04  *CREDIT NOTE*')
  L.push(`\uD83C\uDFE2 *${brand || BRANDS[0]}*`)
  L.push(BOT)

  L.push('*CUSTOMER DETAILS*')
  L.push(RULE)
  L.push(`*Customer:* ${customer?.name || '-'}`)
  if (customer?.category) L.push(`*Category:* ${customer.category}`)
  if (customer?.route) L.push(`*Route:* ${customer.route}`)

  L.push('\uD83D\uDCE6 *RETURN ITEMS*')
  L.push(RULE)
  lines.forEach((l, idx) => {
    L.push(`${itemNumber(idx)} ${l.name}`)
    L.push(`   \u279C MRP: *\u20B9${l.mrp}*  |  Qty: *${l.qty}*`)
    L.push(`   \u279C Reason: *${l.reason}*`)
  })

  L.push(RULE)
  L.push('\uD83D\uDCCA *RETURN SUMMARY*')
  L.push(RULE)
  L.push(`\uD83D\uDCE6 Total Products : *${lines.length}*`)
  L.push(`\uD83D\uDD22 Total Quantity : *${totalQty}*`)
  if (salesperson) L.push(`\uD83D\uDC68\u200D\uD83D\uDCBC *Salesperson:* ${salesperson}`)
  L.push(locationLine(location))
  L.push(EQ)
  L.push('\u2705 Please process this credit note.')
  L.push(EQ)
  return L.join('\n')
}

/**
 * Build the no-order visit report message.
 * visit: { visit_status, custom_remark, latitude, longitude }
 */
export function buildVisitMessage({ brand, customer, salesperson, visit }) {
  const L = []
  L.push(TOP)
  L.push('\uD83D\uDCCD  *CUSTOMER VISIT - NO ORDER*')
  L.push(`\uD83C\uDFE2 *${brand || BRANDS[0]}*`)
  L.push(BOT)
  L.push('*CUSTOMER DETAILS*')
  L.push(RULE)
  L.push(`*Customer:* ${customer?.name || '-'}`)
  if (customer?.category) L.push(`*Category:* ${customer.category}`)
  if (customer?.route) L.push(`*Route:* ${customer.route}`)
  L.push('\uD83D\uDCDD *VISIT STATUS*')
  L.push(RULE)
  L.push(`*Status:* ${visit.visit_status}`)
  if (visit.custom_remark) L.push(`*Remark:* ${visit.custom_remark}`)
  if (visit.latitude != null && visit.longitude != null) {
    L.push(`*Location:* https://maps.google.com/?q=${visit.latitude},${visit.longitude}`)
  }
  const now = new Date()
  L.push(`*Time:* ${now.toLocaleString('en-IN')}`)
  if (salesperson) {
    L.push('')
    L.push(`\uD83D\uDC68\u200D\uD83D\uDCBC *Salesperson:* ${salesperson}`)
  }
  L.push(EQ)
  L.push('\u2705 Visit recorded.')
  L.push(EQ)
  return L.join('\n')
}

/**
 * Plain "SHOP VISIT UPDATE" text for the Copy button. Uses the exact
 * layout requested for quick pasting into WhatsApp or any app.
 */
export function buildVisitCopyText({ customer, salesperson, reason }) {
  const d = new Date()
  const dd = String(d.getDate()).padStart(2, '0')
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const yyyy = d.getFullYear()
  const L = []
  L.push('\uD83D\uDCCD SHOP VISIT UPDATE')
  L.push('')
  L.push(`Customer: ${customer?.name || ''}`)
  L.push(`Route: ${customer?.route || ''}`)
  L.push(`Date: ${dd}-${mm}-${yyyy}`)
  L.push('')
  L.push('Status: Visited - No Order')
  L.push('')
  L.push(`Reason: ${reason || '____________________'}`)
  L.push('')
  L.push(`Sales Executive: ${salesperson || '____________________'}`)
  return L.join('\n')
}

export function buildWhatsappUrl(message, number = ORDER_WHATSAPP_NUMBER) {
  return `https://wa.me/${number}?text=${encodeURIComponent(message)}`
}

// Delivery completion report — copyable text. Photo links are pasted
// separately by the rep (photos handled in Phase 4C).
export function buildDeliveryReport({ delivery, items, note, location, deliveredBy, status, photos }) {
  const L = []
  L.push(TOP)
  L.push('\uD83D\uDE9A  *DELIVERY REPORT*')
  L.push(`\uD83C\uDFE2 *${BRANDS[0]}*`)
  L.push(BOT)
  L.push('*DELIVERY DETAILS*')
  L.push(RULE)
  L.push(`*Shop:* ${delivery.shop_name}`)
  if (delivery.route) L.push(`*Route:* ${delivery.route}`)
  const statusLabel =
    status === 'delivered' ? '\u2705 Fully Delivered'
      : status === 'partial' ? '\u26A0\uFE0F Partially Delivered'
      : '\u274C Not Delivered'
  L.push(`*Status:* ${statusLabel}`)
  L.push('\uD83D\uDCE6 *ITEMS*')
  L.push(RULE)
  items.forEach((i, idx) => {
    const mark = i.delivered ? '\u2705' : '\u274C'
    const qty =
      i.delivered && i.delivered_qty != null && i.delivered_qty !== i.ordered_qty
        ? `${i.delivered_qty}/${i.ordered_qty}`
        : `${i.ordered_qty}`
    const unit = i.unit && i.unit !== 'Piece' ? ` ${i.unit}` : ''
    L.push(`${mark} ${idx + 1}. ${i.product_name} — *${qty}*${unit}`)
    if (!i.delivered && i.reason) L.push(`     \u2192 ${i.reason}`)
  })
  if (note) {
    L.push('\uD83D\uDCDD *NOTE*')
    L.push(RULE)
    L.push(note)
  }
  L.push(locationLine(location))
  if (deliveredBy) {
    L.push('')
    L.push(`\uD83D\uDE9A *Delivered by:* ${deliveredBy}`)
  }
  if (photos && photos.length) {
    L.push('\uD83D\uDCF7 *PROOF PHOTOS*')
    L.push(RULE)
    photos.forEach((ph) => {
      const label = ph.kind === 'bill' ? 'Bill' : 'Product'
      L.push(`${label}: ${ph.url}`)
    })
  }
  const now = new Date()
  L.push(`*Time:* ${now.toLocaleString('en-IN')}`)
  L.push(EQ)
  return L.join('\n')
}
