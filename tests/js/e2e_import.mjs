import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { importFullProducts } from './excel.mjs'
import { buildMergePayload, buildReplacePayload } from './catalogueImport.mjs'

const ADMIN = '00000000-0000-0000-0000-00000000000a'
const psql = (sql) => execFileSync('psql', ['-h', '/tmp', '-p', '5499', '-U', 'postgres', '-d', 'alpha', '-At', '-v', 'ON_ERROR_STOP=1'], { input: sql }).toString().trim()
const q1 = (sql) => psql(sql).split('\n').pop()
const existing = () => JSON.parse(q1(`select coalesce(json_agg(json_build_object('id',id,'name',name,'retail',retail,'wholesale',wholesale,'sell_by_piece',sell_by_piece,'sell_by_outer',sell_by_outer,'sell_by_box',sell_by_box)),'[]') from products`))
const revCount = () => Number(q1('select count(*) from product_price_revisions'))
function rpc(mode, rows, file = 'Alpha_Master_Price_List.xlsx') {
  fs.writeFileSync('/tmp/payload.json', JSON.stringify(rows))
  const t0 = Date.now()
  const out = q1(`\\set content \`cat /tmp/payload.json\`
select set_config('request.jwt.claim.sub','${ADMIN}',false);
set role authenticated;
select import_products_catalogue('${mode}', :'content'::jsonb, '${file}');`)
  return { ...JSON.parse(out), ms: Date.now() - t0 }
}
const results = []
const t = (name, ok, detail = '') => results.push([ok ? 'PASS' : 'FAIL', name, detail])
const parsed = await importFullProducts({ arrayBuffer: async () => new ArrayBuffer(0) })
const clone = () => JSON.parse(JSON.stringify(parsed))

// 1. Merge the same master file that is already live
let before = revCount()
let m = buildMergePayload(parsed, existing())
let r = rpc('merge', m.rows)
t('Merge of the unchanged master Excel → no new revision', revCount() === before, `${m.rows.length} rows sent, ${r.updated} updated, revisions ${before}→${revCount()}, ${r.ms} ms`)

// 2. Admin edits the Excel: one WSP/RTP change, one MRP-only, one GST-only, one blank RTP cell
const edited = clone()
const iPrice = edited.findIndex(p => p.retail != null && p.wholesale != null)
const iMrp = edited.findIndex((p, i) => i > iPrice && p.mrp != null && p.retail != null)
const iGst = edited.findIndex((p, i) => i > iMrp && p.gst != null)
const iBlank = edited.findIndex((p, i) => i > iGst && p.retail != null)
const priced = edited[iPrice], blankName = edited[iBlank].name, blankRetail = edited[iBlank].retail
priced.wholesale = +(priced.wholesale + 5).toFixed(2); priced.retail = +(priced.retail + 5).toFixed(2)
edited[iMrp].mrp = edited[iMrp].mrp + 10
edited[iGst].gst = edited[iGst].gst === 18 ? 12 : 18
edited[iBlank].retail = null           // blank cell in the Excel
before = revCount()
m = buildMergePayload(edited, existing())
r = rpc('merge', m.rows)
t('Merge with 1 price change → exactly 1 new revision', revCount() === before + 1 && r.price_changes.length === 1 && r.price_changes[0].product === priced.name,
  `${r.price_changes.map(c => `${c.product}: WSP ${c.wholesale_from}→${c.wholesale_to}`).join('; ')}`)
t('MRP-only and GST-only edits → no revision', !r.price_changes.some(c => c.product === edited[iMrp].name || c.product === edited[iGst].name))
t('MRP/GST edits were still saved', q1(`select (select mrp from products where name=$$${edited[iMrp].name}$$)=${edited[iMrp].mrp} and (select gst from products where name=$$${edited[iGst].name}$$)=${edited[iGst].gst}`) === 't')
t('Blank RTP cell does not wipe the stored price', Number(q1(`select retail from products where name=$$${blankName}$$`)) === blankRetail)

// 3. Same edited file uploaded again
before = revCount()
r = rpc('merge', buildMergePayload(edited, existing()).rows)
t('Same Excel uploaded again → no new revision', revCount() === before)

// The catalogue as it is live now = edited file, but Merge kept the blanked retail.
const live = JSON.parse(JSON.stringify(edited)); live[iBlank].retail = blankRetail

// 4. Replace All with the same catalogue → nothing changes
const idsBefore = q1(`select string_agg(id||'='||name, '|' order by id) from products`)
before = revCount()
r = rpc('replace', buildReplacePayload(live, existing()).rows)
t('Replace All with the same products → no revision, no add/remove', revCount() === before && r.inserted === 0 && r.deleted === 0 && r.count === parsed.length,
  `${r.count} products, ${r.ms} ms`)
t('Replace All keeps every product id (stock/history stay attached)', q1(`select string_agg(id||'='||name, '|' order by id) from products`) === idsBefore)
t('Stock row for p0 still linked', q1(`select count(*) from product_inventory i join products p on p.id=i.product_id`) === '1')

// 5. v225 bug: new product inserted near the TOP + one product removed
const withNew = JSON.parse(JSON.stringify(live))
withNew.splice(2, 0, { id: 'p2', name: 'BRAND NEW PRODUCT X', slabs: [], net: [], retail: 99, wholesale: 95, mrp: 120, gst: 18, hsn: '1111', is_qt: false })
const removed = withNew.splice(10, 1)[0]
const p2Before = q1(`select name from products where id='p2'`)
before = revCount()
r = rpc('replace', buildReplacePayload(withNew, existing()).rows)
const newId = q1(`select id from products where name='BRAND NEW PRODUCT X'`)
t('Replace All with a new product at row 3 → no id collision, upload succeeds', r.inserted === 1 && r.deleted === 1 && r.count === parsed.length, `new id ${newId}`)
t('Existing product that owned id p2 is untouched', q1(`select name from products where id='p2'`) === p2Before, p2Before)
t('Removed product is gone, its price history kept for audit', q1(`select count(*) from products where name=$$${removed.name}$$`) === '0' && Number(q1(`select count(*) from product_price_revisions where product_name=$$${removed.name}$$`)) >= 1)
t('Sort order follows the file', q1(`select string_agg(name, '|' order by sort_order) from (select name, sort_order from products order by sort_order limit 3) x`) === withNew.slice(0, 3).map(p => p.name.trim()).join('|'))
t('New product starts at revision 1 (no price-change revision for others)', revCount() === before + 1 && q1(`select price_version from products where id='${newId}'`) === '1')

// 5b. Replace All treats the file as complete: a blank RTP clears it → that IS a price change
const blanked = JSON.parse(JSON.stringify(withNew)); const bi = blanked.findIndex(p => p.retail != null && p.wholesale != null)
blanked[bi].retail = null
before = revCount()
r = rpc('replace', buildReplacePayload(blanked, existing()).rows)
t('Replace All: blank RTP clears the price → exactly 1 revision (Merge ignores blanks)', revCount() === before + 1 && r.price_changes.length === 1, r.price_changes.map(c => c.product + ' RTP ' + c.retail_from + '→' + c.retail_to).join(''))

// 6. Rejected uploads leave the catalogue untouched (all-or-nothing)
const dup = clone(); dup.push({ ...dup[0] })
const countBefore = q1('select count(*) from products'), verBefore = q1('select version from catalogue_meta')
let failedOk = false
try { rpc('replace', buildReplacePayload(dup, existing()).rows.concat([{ ...buildReplacePayload(dup, existing()).rows[0] }])) } catch { failedOk = true }
t('Upload with a duplicate product name is rejected and changes nothing', failedOk && q1('select count(*) from products') === countBefore && q1('select version from catalogue_meta') === verBefore)

for (const [s, n, d] of results) console.log(s, n, d ? `  [${d}]` : '')
const f = results.filter(x => x[0] === 'FAIL').length
console.log(`\n${results.length - f} passed, ${f} failed`)
process.exit(f ? 1 : 0)
