// SheetJS is heavy (~400KB). Load it on demand so the order screen stays light.
let _xlsx = null
async function getXLSX() {
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
        net: []
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
