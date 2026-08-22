// ============================================================================
// Inventory status — the ONE place the green/orange/red vs "Not Updated" rule
// lives, so every screen (Purchase Manager, Sales rep card, tables) agrees.
//
// THE CRITICAL RULE:
//   no inventory row (undefined/null)  -> NOT INITIALIZED  ("Stock Not Updated")
//                                         never red/orange/green, never "0".
//   initialized & stock === 0          -> OUT  (red)
//   initialized & stock <= minimum     -> LOW  (orange)
//   initialized & stock  >  minimum    -> OK   (green)
// ============================================================================

export function inventoryStatus(inv) {
  // inv is the product_inventory row, or null/undefined if never initialized.
  if (!inv || inv.inventory_initialized !== true) {
    return { state: 'NOT_INITIALIZED', label: 'Stock Not Updated', color: 'slate', stock: null }
  }
  const stock = Number(inv.current_stock) || 0
  const min = Number(inv.minimum_stock) || 0
  if (stock <= 0) return { state: 'OUT', label: 'Out of Stock', color: 'red', stock }
  if (stock <= min) return { state: 'LOW', label: 'Low Stock', color: 'orange', stock }
  return { state: 'OK', label: 'In Stock', color: 'green', stock }
}

// Tailwind classes per state for a small pill/badge.
export const STATUS_PILL = {
  NOT_INITIALIZED: 'bg-slate-100 text-slate-500 border-slate-200',
  OUT: 'bg-red-100 text-red-700 border-red-200',
  LOW: 'bg-amber-100 text-amber-700 border-amber-200',
  OK: 'bg-emerald-100 text-emerald-700 border-emerald-200'
}

export const STATUS_DOT = {
  NOT_INITIALIZED: '⚪',
  OUT: '🔴',
  LOW: '🟠',
  OK: '🟢'
}
