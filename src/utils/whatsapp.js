import { schemeBadge } from './schemes.js'

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
export function buildOrderMessage({ brand, customer, salesperson, items }) {
  const totalProducts = items.length
  const totalQty = items.reduce((s, i) => s + i.qty, 0)

  const L = []
  L.push(TOP)
  L.push('\uD83D\uDED2  *NEW ORDER RECEIVED*')
  L.push(`\uD83C\uDFE2 *${brand || BRANDS[0]}*`)
  L.push(BOT)

  L.push('*CUSTOMER DETAILS*')
  L.push(RULE)
  L.push(`*Customer:* ${customer?.name || '-'}`)
  if (customer?.category) L.push(`*Category:* ${customer.category}`)
  if (customer?.route) L.push(`*Route:* ${customer.route}`)

  L.push('\uD83D\uDCE6 *ORDER ITEMS*')
  L.push(RULE)
  items.forEach((i, idx) => {
    L.push(`${itemNumber(idx)} ${i.name}`)
    const unit = i.unit && i.unit !== 'Piece' ? ` ${i.unit}` : ''
    let qtyLine = `   \u279C Qty: *${i.qty}*${unit}`
    const badge = schemeBadge(i.slabs)
    if (badge) qtyLine += `  |  Scheme: ${badge}`
    L.push(qtyLine)
  })

  L.push(RULE)
  L.push('\uD83D\uDCCA *ORDER SUMMARY*')
  L.push(RULE)
  L.push(`\uD83D\uDCE6 Total Products : *${totalProducts}*`)
  L.push(`\uD83D\uDD22 Total Quantity : *${totalQty}*`)
  if (salesperson) L.push(`\uD83D\uDC68\u200D\uD83D\uDCBC *Salesperson:* ${salesperson}`)
  L.push(EQ)
  L.push('\u2705 Please process this order.')
  L.push(EQ)
  return L.join('\n')
}

/**
 * Build the credit note (customer return) message in the same boxed layout.
 * lines: [{ name, brand, mrp, qty, reason }]
 */
export function buildCreditNoteMessage({ brand, customer, salesperson, lines }) {
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
  L.push(EQ)
  L.push('\u2705 Please process this credit note.')
  L.push(EQ)
  return L.join('\n')
}

export function buildWhatsappUrl(message, number = ORDER_WHATSAPP_NUMBER) {
  return `https://wa.me/${number}?text=${encodeURIComponent(message)}`
}
