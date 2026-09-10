// SheetJS is heavy (~400KB). Load it on demand so the order screen stays light.
let _xlsx = null
export async function getXLSX() {
  if (!_xlsx) _xlsx = await import('xlsx')
  return _xlsx
}

// Normalise a header key: lowercase, remove spaces/underscores.
function norm(k) {
  return String(k || '').toLowerCase().replace(/[\s_]+/g, '')
}

// Try to find a value in a row object across several possible header names.
function pick(row, candidates) {
  const keys = Object.keys(row)
  for (const cand of candidates) {
    const target = norm(cand)
    const found = keys.find((k) => norm(k) === target)
    if (found != null && row[found] != null && String(row[found]).trim() !== '') {
      return String(row[found]).trim()
    }
  }
  return ''
}

// Read the first non-empty sheet from an xlsx/csv file into row objects.
async function readSheet(file, sheetHint) {
  const XLSX = await getXLSX()
  const buf = await file.arrayBuffer()
  const wb = XLSX.read(buf, { type: 'array' })
  let sheetName = wb.SheetNames[0]
  if (sheetHint) {
    const match = wb.SheetNames.find((n) =>
      n.toLowerCase().includes(sheetHint.toLowerCase())
    )
    if (match) sheetName = match
  }
  const ws = wb.Sheets[sheetName]
  return XLSX.utils.sheet_to_json(ws, { defval: '' })
}

// Import products. Accepts a column named ItemName / Product / Name / Product Name.
export async function importProducts(file) {
  const rows = await readSheet(file, 'product')
  const out = []
  let id = 0
  for (const row of rows) {
    const name = pick(row, ['ItemName', 'Product Name', 'Product', 'Name', 'Item'])
    if (!name) continue
    out.push({
      id: `p${id++}`,
      name,
      brand: pick(row, ['Brand']),
      category: pick(row, ['Category']),
      unit: pick(row, ['Unit'])
    })
  }
  return out
}

// Import customers. Accepts Name / Shop Name and RouteName / Area etc.
export async function importCustomers(file) {
  const rows = await readSheet(file, 'customer')
  const out = []
  let id = 0
  for (const row of rows) {
    const name = pick(row, ['Name', 'Shop Name', 'ShopName', 'Customer', 'Customer Name'])
    if (!name) continue
    out.push({
      id: `c${id++}`,
      name,
      owner: pick(row, ['Owner Name', 'Owner']),
      phone: pick(row, ['Phone', 'Mobile', 'Contact']),
      area: pick(row, ['RouteName', 'Route', 'Area', 'Location'])
    })
  }
  return out
}

// Export an array of objects to an .xlsx download.
export async function exportToExcel(records, sheetName, fileName) {
  const XLSX = await getXLSX()
  const ws = XLSX.utils.json_to_sheet(records)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, sheetName)
  XLSX.writeFile(wb, fileName)
}

// Trigger a JSON file download (used for full backup).
export function downloadJson(obj, fileName) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.click()
  URL.revokeObjectURL(url)
}

// Read a JSON file back (used for restore backup).
export async function readJsonFile(file) {
  const text = await file.text()
  return JSON.parse(text)
}

// Rich product import for admin management. Reads name + prices + scheme.
// Accepts flexible column names. Scheme via Buy/Free columns or a "6+1" text.
export async function importFullProducts(file) {
  const rows = await readSheet(file, 'product')
  // Group by product name so a product with several scheme rows becomes ONE
  // product with multiple slabs — not several duplicate product cards.
  const byName = new Map() // upperName -> product
  const order = [] // preserve first-seen order
  let id = 0

  for (const row of rows) {
    const name = pick(row, ['ItemName', 'Item Name', 'Product Name', 'Product', 'Name', 'Item'])
    if (!name) continue
    const numOrNull = (v) => {
      const s = pick(row, Array.isArray(v) ? v : [v])
      if (s === '') return null
      const n = parseFloat(s.replace(/[^0-9.]/g, ''))
      return isNaN(n) ? null : n
    }
    const mrp = numOrNull(['MRP', 'M.R.P'])
    const retail = numOrNull(['rtpAfterTax', 'RTP', 'Retail', 'Retail Price', 'RP', 'Rate'])
    const wholesale = numOrNull(['Wholesale', 'WSP', 'WP', 'Wholesale Price'])
    const base = numOrNull(['baseRate', 'Base', 'Base Rate'])
    const buy = numOrNull(['buy', 'Buy'])
    const free = numOrNull(['free', 'Free'])
    const net = numOrNull(['netAfterTax', 'Net', 'Net Rate', 'NR'])
    const gst = numOrNull(['GST', 'GST%', 'GST %', 'Tax', 'Tax %', 'Tax Rate'])
    const hsn = pick(row, ['HSN', 'HSN Code', 'HSN CODE', 'HSNCode'])
    // Packaging/conversion master data (new). Product-specific; used to convert
    // an Outer/Box order quantity into individual pieces before billing.
    const qtyInBox = numOrNull(['Quantity In Box', 'QuantityInBox', 'Qty In Box', 'Pieces Per Box'])
    const outerQty = numOrNull(['Outer Quantity', 'OuterQuantity', 'Outer Qty', 'Outers Per Box'])
    const box = numOrNull(['Box'])
    // QT = "Without Tax" flag. The Admin types "QT" (any case) in the QT column
    // to mark a product tax-free; blank = normal taxable. We also record whether
    // the QT COLUMN was present in this file at all (qtColPresent) so the merge
    // can distinguish "file doesn't carry QT info, leave it alone" (old files)
    // from "file carries QT and this row is blank, so unmark it".
    const qtRaw = pick(row, ['QT', 'Qt', 'qt', 'Without Tax', 'WithoutTax'])
    const qtColPresent = Object.keys(row).some((k) => /^\s*(qt|without\s*tax)\s*$/i.test(k))
    const isQt = /^\s*qt\s*$/i.test(String(qtRaw || '').trim())

    const key = name.trim().toUpperCase()
    let prod = byName.get(key)
    if (!prod) {
      prod = {
        id: `p${id++}`,
        name: name.trim(),
        slabs: [],
        base: base ?? null,
        mrp: mrp ?? null,
        retail: retail ?? null,
        wholesale: wholesale ?? null,
        gst: gst ?? null,
        hsn: hsn || null,
        net: [],
        // Packaging conversion master data (null when not provided).
        qty_in_box: qtyInBox ?? null,
        outer_qty: outerQty ?? null,
        box: box ?? null,
        // QT (Without Tax). is_qt is the parsed flag; _qtColPresent tells the
        // merge whether this file even had a QT column, so old files (no column)
        // never touch existing QT status.
        is_qt: isQt,
        _qtColPresent: qtColPresent
      }
      byName.set(key, prod)
      order.push(prod)
    } else {
      // Fill any missing price fields from later rows (first non-null wins).
      if (prod.mrp == null && mrp != null) prod.mrp = mrp
      if (prod.retail == null && retail != null) prod.retail = retail
      if (prod.wholesale == null && wholesale != null) prod.wholesale = wholesale
      if (prod.base == null && base != null) prod.base = base
      if (prod.gst == null && gst != null) prod.gst = gst
      if (prod.hsn == null && hsn) prod.hsn = hsn
      if (prod.qty_in_box == null && qtyInBox != null) prod.qty_in_box = qtyInBox
      if (prod.outer_qty == null && outerQty != null) prod.outer_qty = outerQty
      if (prod.box == null && box != null) prod.box = box
      // If ANY row for this product carried the QT column, that value wins for
      // the whole product (a later explicit value overrides). This lets Admin
      // both mark (QT) and unmark (blank) via the file.
      if (qtColPresent) { prod._qtColPresent = true; prod.is_qt = isQt }
    }

    // Append this row's scheme (if it has one) to the product's slab list.
    if (buy && free) {
      prod.slabs.push([buy, free])
      // Keep net aligned to slabs when a base+net is provided.
      if (net != null) prod.net.push(net)
    }
  }

  return order
}

// Export multiple sheets: sheets = [{ name, rows: [{...}] }, ...]
export async function exportMultiSheet(sheets, fileName) {
  const XLSX = await getXLSX()
  const wb = XLSX.utils.book_new()
  sheets.forEach((s) => {
    const ws = XLSX.utils.json_to_sheet(s.rows.length ? s.rows : [{ Note: 'No data' }])
    // Sheet names max 31 chars, no special chars.
    const safe = (s.name || 'Sheet').replace(/[\\/?*[\]:]/g, '').slice(0, 31) || 'Sheet'
    XLSX.utils.book_append_sheet(wb, ws, safe)
  })
  XLSX.writeFile(wb, fileName)
}

/**
 * Excel export for the Product Shortage Sales Loss report. A dedicated
 * function rather than reusing exportMultiSheet above: that function is a
 * simple json_to_sheet with no styling, used elsewhere for plain data dumps,
 * and this report has specific requirements (frozen header, auto-filter,
 * numeric currency cells, a totals row) that would be wrong to bolt onto a
 * shared helper other callers rely on staying simple. Reuses the same
 * lazy-loaded xlsx instance via getXLSX rather than importing the library a
 * second time.
 *
 * rows: [{ date, shopName, salesRepName, itemName, quantity, amount }]
 * summary: { totalItems, totalQty, uniqueProducts, totalLostValue,
 *            byProduct: [{ product, qty, amount }] } (byProduct pre-sorted
 *            by amount descending by the caller)
 */
export async function exportShortageSalesLossExcel(rows, summary, fileName) {
  const XLSX = await getXLSX()
  const wb = XLSX.utils.book_new()

  // --- Sheet 1: Shortage Sales Loss (the primary, line-level data) --------
  const header = ['DATE', 'SHOP NAME', 'SALES REP', 'ITEM (REMOVED)', 'QUANTITY', 'AMOUNT']
  const aoa = [header]
  for (const r of rows) {
    aoa.push([r.date, r.shopName, r.salesRepName, r.itemName, r.quantity, r.amount])
  }
  // Totals row at the bottom, per spec — label spans the first four columns,
  // QUANTITY and AMOUNT columns carry the actual numeric sums so a formula
  // dragged from this row (or a simple visual check) matches the KPI above.
  aoa.push(['TOTAL LOST SALES VALUE', '', '', '', summary.totalQty, summary.totalLostValue])

  const ws1 = XLSX.utils.aoa_to_sheet(aoa)

  // QUANTITY (col E) and AMOUNT (col F) as real numbers, not text, on every
  // data row plus the totals row — this is what the spec means by "usable
  // for SUM/filtering", not stored as a string with a ₹ prefix baked in.
  const lastRow = aoa.length // 1-based, includes header
  for (let r = 2; r <= lastRow; r++) {
    const qCell = ws1[`E${r}`]
    const aCell = ws1[`F${r}`]
    if (qCell) qCell.t = 'n'
    if (aCell) { aCell.t = 'n'; aCell.z = '₹#,##,##0' } // Indian grouping-style currency format
  }

  ws1['!cols'] = [
    { wch: 12 }, // DATE
    { wch: 26 }, // SHOP NAME
    { wch: 16 }, // SALES REP
    { wch: 32 }, // ITEM (REMOVED)
    { wch: 10 }, // QUANTITY
    { wch: 14 } // AMOUNT
  ]
  ws1['!freeze'] = { xSplit: 0, ySplit: 1 } // freeze header row
  ws1['!autofilter'] = { ref: `A1:F${lastRow - 1}` } // filter on data rows only, not the totals row
  XLSX.utils.book_append_sheet(wb, ws1, 'Shortage Sales Loss')

  // --- Sheet 2: Summary (KPIs + product-wise breakdown) --------------------
  const summaryAoa = [
    ['Metric', 'Value'],
    ['Total Shortage Items', summary.totalItems],
    ['Total Shortage Quantity', summary.totalQty],
    ['Unique Products Short', summary.uniqueProducts],
    ['Total Lost Sales Value', summary.totalLostValue],
    [],
    ['Product', 'Total Shortage Quantity', 'Total Lost Sales Value']
  ]
  for (const p of summary.byProduct) summaryAoa.push([p.product, p.qty, p.amount])

  const ws2 = XLSX.utils.aoa_to_sheet(summaryAoa)
  // Numeric formatting for the KPI value cells and every product-row cell.
  ws2['B2'] = { t: 'n', v: summary.totalItems }
  ws2['B3'] = { t: 'n', v: summary.totalQty }
  ws2['B4'] = { t: 'n', v: summary.uniqueProducts }
  ws2['B5'] = { t: 'n', v: summary.totalLostValue, z: '₹#,##,##0' }
  const productHeaderRow = 7 // 1-based row of the "Product | Qty | Amount" header
  for (let r = productHeaderRow + 1; r <= summaryAoa.length; r++) {
    const qCell = ws2[`B${r}`]
    const aCell = ws2[`C${r}`]
    if (qCell) qCell.t = 'n'
    if (aCell) { aCell.t = 'n'; aCell.z = '₹#,##,##0' }
  }
  ws2['!cols'] = [{ wch: 30 }, { wch: 22 }, { wch: 20 }]
  XLSX.utils.book_append_sheet(wb, ws2, 'Summary')

  XLSX.writeFile(wb, fileName)
}

/**
 * Excel export for the Billing Team's Loading Sheet. Same reasoning as
 * exportShortageSalesLossExcel above for using a dedicated function rather
 * than the shared exportMultiSheet: this needs numeric currency cells,
 * frozen header, and auto-filter, which that simpler shared helper
 * (correctly) doesn't do for its other, plainer callers.
 *
 * rows: [{ shopName, salesRepName, grandTotal, verificationStatus }]
 * SL is generated here, sequential from 1, fresh for every export — never
 * stored, so there's nothing to keep in sync across exports.
 */
export async function exportLoadingSheetExcel(rows, fileName, meta = {}) {
  const XLSX = await getXLSX()
  const wb = XLSX.utils.book_new()

  // Four-row heading section requested for the Loading Sheet export. Everything
  // below is the EXISTING table, unchanged, just shifted down by these 4 rows.
  const routeLabel = (meta.routeLabel || 'ALL ROUTES')
  const dateRangeLabel = (meta.dateRangeLabel || '')
  const HEADING_ROWS = 4
  const NUM_COLS = 5 // SL, Shop Name, Sales Rep, Grand Total, Verification Status

  const header = ['SL', 'Shop Name', 'Sales Rep', 'Grand Total', 'Verification Status']
  const aoa = [
    ['ALPHA TRADE LINKS'],
    [routeLabel],
    ['REPORT NAME: LOADING SHEET'],
    [dateRangeLabel],
    header
  ]
  rows.forEach((r, i) => {
    aoa.push([i + 1, r.shopName, r.salesRepName, r.grandTotal, r.verificationStatus])
  })

  const ws = XLSX.utils.aoa_to_sheet(aoa)

  // Merge each heading line across the full table width so it reads as a title
  // banner rather than sitting in column A only.
  ws['!merges'] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: NUM_COLS - 1 } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: NUM_COLS - 1 } },
    { s: { r: 2, c: 0 }, e: { r: 2, c: NUM_COLS - 1 } },
    { s: { r: 3, c: 0 }, e: { r: 3, c: NUM_COLS - 1 } }
  ]

  // The data table's header row is now row 5 (index 4). Grand Total is column D;
  // first data row is spreadsheet row 6. Number-format from there down.
  const firstDataRow = HEADING_ROWS + 2 // heading(4) + table header(1) => data starts at row 6
  for (let r = firstDataRow; r <= aoa.length; r++) {
    const cell = ws[`D${r}`]
    if (cell) { cell.t = 'n'; cell.z = '₹#,##,##0' }
  }

  ws['!cols'] = [
    { wch: 6 },  // SL
    { wch: 28 }, // Shop Name
    { wch: 18 }, // Sales Rep
    { wch: 14 }, // Grand Total
    { wch: 18 }  // Verification Status
  ]
  // Freeze through the table header row (now row 5) so the heading + column
  // titles stay visible while scrolling.
  ws['!freeze'] = { xSplit: 0, ySplit: HEADING_ROWS + 1 }
  // Autofilter applies to the data table only (header row 5 downward).
  ws['!autofilter'] = { ref: `A${HEADING_ROWS + 1}:E${aoa.length}` }
  XLSX.utils.book_append_sheet(wb, ws, 'Loading Sheet')

  XLSX.writeFile(wb, fileName)
}
