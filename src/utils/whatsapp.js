// Build the exact order message format and the wa.me deep link.

// Orders are always delivered to this fixed business WhatsApp number.
export const ORDER_WHATSAPP_NUMBER = '919074993560'

// selectedItems: [{ name, qty }] with qty > 0
export function buildOrderMessage({ businessName, salesperson, customerName, selectedItems }) {
  const totalProducts = selectedItems.length
  const totalQty = selectedItems.reduce((s, i) => s + i.qty, 0)

  const lines = []
  lines.push('🛒 *NEW ORDER*')
  lines.push('')
  if (businessName) {
    lines.push(`*${businessName}*`)
    lines.push('')
  }
  lines.push('Customer:')
  lines.push(customerName || '-')
  lines.push('')
  lines.push('Items:')
  lines.push('')
  selectedItems.forEach((i) => {
    lines.push(`• ${i.name} × ${i.qty}`)
  })
  lines.push('')
  lines.push(`Total Products: ${totalProducts}`)
  lines.push(`Total Quantity: ${totalQty}`)
  if (salesperson) {
    lines.push('')
    lines.push(`Salesperson: ${salesperson}`)
  }
  lines.push('')
  lines.push('Thank you.')

  return lines.join('\n')
}

export function buildWhatsappUrl(message, number = ORDER_WHATSAPP_NUMBER) {
  return `https://wa.me/${number}?text=${encodeURIComponent(message)}`
}
