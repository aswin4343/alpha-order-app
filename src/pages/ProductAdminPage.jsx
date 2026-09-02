import { useEffect, useState } from 'react'
import { useApp } from '../context/AppContext.jsx'
import {
  getCatalogueMeta,
  replaceAllCloudProducts,
  mergeUpdateCloudProducts,
  fetchAllCloudProducts,
  sendAnnouncement
} from '../utils/cloudSync.js'
import { importFullProducts } from '../utils/excel.js'
import { diffProducts, buildAnnouncement } from '../utils/productDiff.js'
import seedProducts from '../data/products.json'
import { BackIcon } from '../components/Icons.jsx'

/**
 * Admin product/price/scheme management.
 *  - One-time migration: push the app's bundled catalogue to the cloud.
 *  - Replace-all Excel upload with a confirm-count safety net.
 */
export default function ProductAdminPage({ onBack }) {
  const { products } = useApp()
  const [meta, setMeta] = useState(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [pending, setPending] = useState(null) // {list, source}

  const loadMeta = async () => {
    try {
      setMeta(await getCatalogueMeta())
    } catch {
      setMeta(null)
    }
  }
  useEffect(() => {
    loadMeta()
  }, [])

  const cloudCount = meta?.product_count ?? 0
  const cloudVersion = meta?.version ?? 0

  // Stage a replace (from Excel or from the bundled catalogue) for confirmation.
  // `diff` (optional) carries the detected product changes so we can preview
  // them and auto-generate the announcement on confirm.
  const stage = (list, source, fileName, diff = null) => {
    setMsg('')
    if (!list || !list.length) {
      setMsg('No products found in that file.')
      return
    }
    setPending({ list, source, fileName, diff })
  }

  const onExcel = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setBusy(true)
    setMsg('Reading file…')
    try {
      const list = await importFullProducts(file)
      // Compare against the CURRENT cloud catalogue to detect actual changes.
      setMsg('Comparing with current catalogue…')
      let diff = null
      try {
        const prev = await fetchAllCloudProducts()
        diff = diffProducts(prev, list)
      } catch (cmpErr) {
        // If we can't fetch the previous list (e.g. first-ever upload), we
        // simply skip change detection — the replace still works.
        console.warn('Could not compare with previous catalogue:', cmpErr)
      }
      setMsg('')
      stage(list, `Excel file "${file.name}"`, file.name, diff)
    } catch (err) {
      console.error(err)
      setMsg('Could not read that file. Check it is a valid .xlsx.')
    } finally {
      setBusy(false)
    }
  }

  // ---- MERGE (non-destructive GST/price update) --------------------------
  // A SEPARATE flow from replace-all. Reads the same Excel format, but instead
  // of wiping the catalogue it only updates fields that have valid values,
  // product-by-product, matched by name. Nothing is deleted or blanked.
  const [mergePending, setMergePending] = useState(null) // { list, fileName, preview }

  const onMergeExcel = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setBusy(true)
    setMsg('Reading file…')
    try {
      const list = await importFullProducts(file)
      // Build a preview so the admin sees exactly what WILL and WON'T change,
      // before anything is written. This mirrors the merge function's own
      // matching logic so the counts shown are the counts applied.
      setMsg('Matching against current catalogue…')
      let preview = null
      try {
        const existing = await fetchAllCloudProducts()
        const keys = new Set(existing.map((p) => (p.name || '').trim().toUpperCase()))
        const hasVal = (v) => v !== null && v !== undefined && v !== ''
        let willUpdate = 0, gstOnly = 0, withPrice = 0, skippedNoData = 0
        const unmatched = []
        for (const u of list) {
          const key = (u.name || '').trim().toUpperCase()
          if (!key) continue
          if (!keys.has(key)) { unmatched.push(u.name); continue }
          const anyPrice = hasVal(u.mrp) || hasVal(u.retail) || hasVal(u.wholesale) || hasVal(u.base)
          const anyData = anyPrice || hasVal(u.gst) || hasVal(u.hsn) || (Array.isArray(u.slabs) && u.slabs.length > 0)
          if (!anyData) { skippedNoData++; continue }
          willUpdate++
          if (anyPrice) withPrice++
          else gstOnly++
        }
        preview = { willUpdate, withPrice, gstOnly, skippedNoData, unmatched, total: list.length }
      } catch (cmpErr) {
        console.warn('Could not build merge preview:', cmpErr)
      }
      setMsg('')
      if (!list.length) { setMsg('No products found in that file.'); return }
      setMergePending({ list, fileName: file.name, preview })
    } catch (err) {
      console.error(err)
      setMsg('Could not read that file. Check it is a valid .xlsx.')
    } finally {
      setBusy(false)
    }
  }

  const confirmMerge = async () => {
    if (!mergePending) return
    setBusy(true)
    setMsg('Merging updates… do not close this screen.')
    try {
      const res = await mergeUpdateCloudProducts(mergePending.list, mergePending.fileName)
      setMergePending(null)
      await loadMeta()
      const unmatchedNote = res.unmatched.length
        ? ` ${res.unmatched.length} product(s) in the file had no catalogue match and were ignored.`
        : ''
      const skipNote = res.skippedNoData
        ? ` ${res.skippedNoData} had no new data and were left unchanged.`
        : ''
      setMsg(`Done. ${res.updated} product(s) updated (version ${res.version}).${skipNote}${unmatchedNote} Reps get the update on next open.`)
    } catch (err) {
      console.error(err)
      setMsg('Merge failed: ' + (err.message || 'unknown error') + '. Some products may have been updated; re-running the merge is safe (it only re-applies the same values).')
    } finally {
      setBusy(false)
    }
  }

  const confirmReplace = async () => {
    if (!pending) return
    setBusy(true)
    setMsg('Uploading to cloud… do not close this screen.')
    try {
      const res = await replaceAllCloudProducts(pending.list, pending.fileName)

      // Auto-announcement: if we detected actual changes, publish ONE
      // consolidated product-update announcement to all salespeople, expiring
      // after 3 days. Never a generic "list updated" message.
      let annNote = ''
      const diff = pending.diff
      if (diff && diff.hasChanges) {
        const ann = buildAnnouncement(diff)
        if (ann) {
          try {
            await sendAnnouncement({
              title: ann.title,
              body: ann.body,
              highPriority: false,
              audience: 'all',
              expiresInDays: 3,
              notifType: 'product_update',
              // Billing needs to see price/product changes too — same
              // announcement, same read state, no separate system.
              includeBilling: true
            })
            annNote = ` ${diff.totalChanges} change(s) announced to all sales reps and the billing team (expires in 3 days).`
          } catch (annErr) {
            console.error('Announcement failed:', annErr)
            annNote = ' (Products updated, but the change announcement could not be sent — you can send one manually.)'
          }
        }
      } else if (diff && !diff.hasChanges) {
        annNote = ' No product changes detected, so no announcement was sent.'
      }

      setPending(null)
      await loadMeta()
      setMsg(`Done. ${res.count} products published (version ${res.version}). Reps will get them on next open.${annNote}`)
    } catch (err) {
      console.error(err)
      setMsg('Upload failed: ' + (err.message || 'unknown error') + '. Nothing was changed if this was the delete step; try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="min-h-screen bg-slate-50 pb-10">
      <header className="sticky top-0 z-20 bg-white border-b border-slate-100 safe-top">
        <div className="mx-auto max-w-3xl px-3 py-2.5 flex items-center gap-2">
          <button
            onClick={onBack}
            className="h-10 w-10 rounded-full flex items-center justify-center text-slate-600 active:bg-slate-100"
          >
            <BackIcon className="h-6 w-6" />
          </button>
          <h1 className="text-lg font-bold text-slate-800">Product Management</h1>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-3 pt-4 space-y-4">
        {/* Cloud status */}
        <div className="rounded-2xl bg-white shadow-card border border-slate-100 p-4">
          <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">
            Cloud Catalogue
          </p>
          {cloudCount === 0 ? (
            <p className="text-sm text-amber-700">
              Not set up yet. Run the one-time migration below to move your current{' '}
              {products.length} products to the cloud.
            </p>
          ) : (
            <div className="flex items-center justify-between">
              <div>
                <p className="text-2xl font-bold text-brand-700">{cloudCount}</p>
                <p className="text-xs text-slate-400">products live · version {cloudVersion}</p>
                {meta?.file_name && (
                  <p className="text-[11px] text-slate-500 mt-1">
                    Last upload: <b>{meta.file_name}</b>
                    {meta.uploaded_at && (
                      <> · {new Date(meta.uploaded_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}</>
                    )}
                  </p>
                )}
              </div>
              <div className="text-right text-[11px] text-slate-400">
                On this device: {products.length}
              </div>
            </div>
          )}
        </div>

        {/* One-time migration */}
        {cloudCount === 0 && (
          <div className="rounded-2xl bg-white shadow-card border border-slate-100 p-4">
            <p className="font-semibold text-slate-800 mb-1">Step 1 — Migrate current products</p>
            <p className="text-sm text-slate-500 mb-3">
              This uploads the {seedProducts.length} products currently in the app to the
              cloud, as your starting catalogue. Do this once.
            </p>
            <button
              onClick={() => stage(seedProducts, `the app's current ${seedProducts.length} products`)}
              disabled={busy}
              className="w-full rounded-xl bg-brand-600 text-white py-3 font-bold active:bg-brand-700 disabled:bg-slate-200 disabled:text-slate-400"
            >
              Migrate {seedProducts.length} products to cloud
            </button>
          </div>
        )}

        {/* Excel replace-all */}
        <div className="rounded-2xl bg-white shadow-card border border-slate-100 p-4">
          <p className="font-semibold text-slate-800 mb-1">
            {cloudCount === 0 ? 'Or upload a product Excel' : 'Update products (Excel)'}
          </p>
          <p className="text-sm text-slate-500 mb-3">
            Upload the <b>complete</b> product list. It <b>replaces</b> the entire cloud
            catalogue. Columns: Item Name, MRP, RTP/Retail, Wholesale, Base, Buy, Free, Net.
          </p>
          <label className="block">
            <span className="sr-only">Choose Excel file</span>
            <input
              type="file"
              accept=".xlsx,.xls,.csv"
              onChange={onExcel}
              disabled={busy}
              className="block w-full text-sm text-slate-600 file:mr-3 file:py-2.5 file:px-4 file:rounded-xl file:border-0 file:bg-brand-50 file:text-brand-700 file:font-semibold"
            />
          </label>
        </div>

        {/* Non-destructive merge update (only once a catalogue exists) */}
        {cloudCount > 0 && (
          <div className="rounded-2xl bg-white shadow-card border border-green-200 p-4">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-[10px] font-extrabold text-green-700 bg-green-100 px-2 py-0.5 rounded-full">SAFE</span>
              <p className="font-semibold text-slate-800">Merge GST / Price update (Excel)</p>
            </div>
            <p className="text-sm text-slate-500 mb-3">
              Adds or updates <b>only</b> the MRP / price / GST% / HSN values found in the file,
              matched to existing products by name. It <b>never deletes</b> anything and
              <b> never blanks</b> a value. Products not in the file, or with no new data, are
              left exactly as they are. Use this to fill in GST/prices without replacing the
              whole catalogue.
            </p>
            <label className="block">
              <span className="sr-only">Choose Excel file to merge</span>
              <input
                type="file"
                accept=".xlsx,.xls,.csv"
                onChange={onMergeExcel}
                disabled={busy}
                className="block w-full text-sm text-slate-600 file:mr-3 file:py-2.5 file:px-4 file:rounded-xl file:border-0 file:bg-green-50 file:text-green-700 file:font-semibold"
              />
            </label>
          </div>
        )}

        {msg && (
          <div className="rounded-xl bg-slate-100 border border-slate-200 px-3 py-2.5">
            <p className="text-[13px] text-slate-700">{msg}</p>
          </div>
        )}

        <p className="text-center text-[11px] text-slate-400">
          Reps download the latest catalogue automatically when they next open the app with
          internet. Offline, they keep using the last downloaded copy.
        </p>
      </main>

      {/* Confirm replace safety net */}
      {pending && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center px-6">
          <div className="bg-white w-full max-w-sm rounded-3xl p-5">
            <h2 className="font-bold text-slate-800 text-lg mb-1">Confirm replace</h2>
            <p className="text-sm text-slate-600 mb-1">
              This will <b>replace all</b> {cloudCount} cloud products with{' '}
              <b>{pending.list.length}</b> products from {pending.source}.
            </p>
            {cloudCount > 0 && pending.list.length < cloudCount * 0.8 && (
              <p className="text-sm text-red-600 mb-2">
                ⚠️ The new list is much smaller ({pending.list.length} vs {cloudCount}).
                Make sure you uploaded the complete list.
              </p>
            )}

            {/* Detected changes preview (Excel uploads only). */}
            {pending.diff && (
              <div className="mb-3 rounded-xl bg-slate-50 border border-slate-200 p-3 max-h-56 overflow-y-auto">
                {pending.diff.hasChanges ? (
                  <>
                    <p className="text-[12px] font-semibold text-slate-700 mb-1.5">
                      {pending.diff.totalChanges} change(s) detected — reps will be notified:
                    </p>
                    <ul className="text-[12px] text-slate-600 space-y-0.5">
                      {pending.diff.priceUp.map((c) => (
                        <li key={`pu-${c.name}`}>🔺 <b>{c.name}</b> ₹{c.oldPrice} → ₹{c.newPrice}</li>
                      ))}
                      {pending.diff.priceDown.map((c) => (
                        <li key={`pd-${c.name}`}>🔻 <b>{c.name}</b> ₹{c.oldPrice} → ₹{c.newPrice}</li>
                      ))}
                      {pending.diff.schemeChanged.map((c) => (
                        <li key={`sc-${c.name}`}>🎁 <b>{c.name}</b> scheme updated</li>
                      ))}
                      {pending.diff.added.map((c) => (
                        <li key={`ad-${c.name}`}>🟢 <b>{c.name}</b> new product</li>
                      ))}
                      {pending.diff.removed.map((c) => (
                        <li key={`rm-${c.name}`}>⛔ <b>{c.name}</b> removed</li>
                      ))}
                    </ul>
                    <p className="text-[11px] text-slate-400 mt-2">
                      An announcement will be sent to all sales reps and the billing team, and auto-expire in 3 days.
                    </p>
                  </>
                ) : (
                  <p className="text-[12px] text-slate-500">
                    No product changes detected vs the current catalogue — no announcement will be sent.
                  </p>
                )}
              </div>
            )}

            <p className="text-xs text-slate-400 mb-4">
              Reps will receive this updated catalogue on their next open.
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setPending(null)}
                disabled={busy}
                className="flex-1 rounded-xl border border-slate-200 py-3 font-semibold text-slate-600"
              >
                Cancel
              </button>
              <button
                onClick={confirmReplace}
                disabled={busy}
                className="flex-1 rounded-xl bg-brand-600 text-white py-3 font-bold active:bg-brand-700 disabled:bg-slate-300"
              >
                {busy ? 'Working…' : 'Replace all'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirm merge (non-destructive) */}
      {mergePending && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center px-6">
          <div className="bg-white w-full max-w-sm rounded-3xl p-5">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-[10px] font-extrabold text-green-700 bg-green-100 px-2 py-0.5 rounded-full">SAFE MERGE</span>
              <h2 className="font-bold text-slate-800 text-lg">Confirm update</h2>
            </div>
            {mergePending.preview ? (
              <div className="mb-3 rounded-xl bg-slate-50 border border-slate-200 p-3 text-[13px] text-slate-700 space-y-1">
                <p>✅ <b>{mergePending.preview.willUpdate}</b> product(s) will be updated.</p>
                <p className="text-[12px] text-slate-500 ml-5">
                  {mergePending.preview.withPrice} with price data · {mergePending.preview.gstOnly} GST/HSN only (price still blank)
                </p>
                {mergePending.preview.skippedNoData > 0 && (
                  <p>➖ <b>{mergePending.preview.skippedNoData}</b> in the file have no new data — left unchanged.</p>
                )}
                {mergePending.preview.unmatched.length > 0 && (
                  <p>⚠️ <b>{mergePending.preview.unmatched.length}</b> in the file don't match any product — ignored.</p>
                )}
                <p className="text-[12px] text-green-700 mt-1.5 font-semibold">
                  Nothing is deleted. No existing value is blanked.
                </p>
              </div>
            ) : (
              <p className="text-sm text-slate-600 mb-3">
                This will merge values from <b>{mergePending.fileName}</b> into the existing
                catalogue. Nothing is deleted.
              </p>
            )}

            {mergePending.preview && mergePending.preview.unmatched.length > 0 && (
              <details className="mb-3">
                <summary className="text-[12px] text-slate-500 cursor-pointer">
                  Show {mergePending.preview.unmatched.length} unmatched name(s)
                </summary>
                <ul className="mt-1.5 max-h-32 overflow-y-auto text-[11px] text-slate-500 space-y-0.5">
                  {mergePending.preview.unmatched.map((n) => <li key={n}>• {n}</li>)}
                </ul>
              </details>
            )}

            <div className="flex gap-2">
              <button
                onClick={() => setMergePending(null)}
                disabled={busy}
                className="flex-1 rounded-xl border border-slate-200 py-3 font-semibold text-slate-600"
              >
                Cancel
              </button>
              <button
                onClick={confirmMerge}
                disabled={busy}
                className="flex-1 rounded-xl bg-green-600 text-white py-3 font-bold active:bg-green-700 disabled:bg-slate-300"
              >
                {busy ? 'Merging…' : 'Apply update'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
