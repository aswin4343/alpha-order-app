import { useState, useEffect, useMemo, useCallback } from 'react'
import { useAuth } from '../context/AuthContext.jsx'
import { useApp } from '../context/AppContext.jsx'
import {
  loadInventoryMap, applyStockChange, recordPurchase, setMinimumStock,
  loadConsumption60d, buildInventoryAnalysis,
  loadInventoryTransactions, loadPurchases,
  loadPurchaseAlertPushEnabled, setPurchaseAlertPushEnabled
} from '../utils/cloudSync.js'
import { inventoryStatus, STATUS_PILL, STATUS_DOT } from '../utils/inventoryStatus.js'
import EnablePushBanner from '../components/EnablePushBanner.jsx'
import appIcon from '../assets/app_icon.png'

const brandOf = (p) => (p.name || '').split(/[\s-]/)[0] || '—'

export default function PurchaseManagerDashboard() {
  const { profile, signOut } = useAuth()
  const { products } = useApp()
  const [invMap, setInvMap] = useState(new Map())
  const [consMap, setConsMap] = useState(new Map())
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState('add')          // add | inventory | reorder | analysis
  const [toast, setToast] = useState('')

  const refresh = useCallback(async () => {
    setLoading(true)
    const [inv, cons] = await Promise.all([loadInventoryMap(), loadConsumption60d()])
    setInvMap(inv)
    setConsMap(cons)
    setLoading(false)
  }, [])
  useEffect(() => { refresh() }, [refresh])

  const analysis = useMemo(
    () => buildInventoryAnalysis(products, invMap, consMap),
    [products, invMap, consMap]
  )

  const flash = (m) => { setToast(m); setTimeout(() => setToast(''), 3500) }

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      <header className="sticky top-0 z-20 bg-white border-b border-slate-200">
        <div className="px-4 lg:px-6 py-2.5 flex items-center gap-3">
          <img src={appIcon} alt="" className="h-9 w-9 rounded-lg" />
          <div className="min-w-0 flex-1">
            <h1 className="text-base font-bold text-slate-800 leading-tight">Inventory · Purchase Manager</h1>
            <p className="text-[11px] text-slate-400">{profile?.full_name || 'Purchase Manager'}</p>
          </div>
          <button onClick={refresh} className="text-sm font-semibold text-brand-700 px-3 py-1.5 rounded-lg border border-slate-200 hover:bg-slate-50">Refresh</button>
          <button onClick={signOut} className="text-sm font-semibold text-red-600 px-2">Sign Out</button>
        </div>
        <div className="px-4 lg:px-6 flex gap-1 -mb-px overflow-x-auto">
          {[['add', 'Add Stock'], ['inventory', 'Inventory'], ['table', 'Inventory Table'], ['reorder', 'Reorder Alerts'], ['analysis', 'Consumption'], ['history', 'Stock History'], ['purchases', 'Purchases']].map(([k, label]) => (
            <button key={k} onClick={() => setTab(k)}
              className={`px-4 py-2 text-sm font-semibold border-b-2 whitespace-nowrap ${tab === k ? 'border-brand-600 text-brand-700' : 'border-transparent text-slate-500 hover:text-slate-700'}`}>
              {label}
            </button>
          ))}
        </div>
      </header>

      <main className="flex-1 px-4 lg:px-6 py-4 max-w-6xl w-full mx-auto">
        <div className="mb-3">
          <EnablePushBanner role="purchase_manager" label="Get purchase &amp; stock alerts instantly — even when the app is closed." />
        </div>
        {tab === 'add' && (
          <AddStock products={products} invMap={invMap} profile={profile}
            onDone={async (msg) => { await refresh(); flash(msg) }} />
        )}
        {tab === 'inventory' && (
          <InventoryList products={products} invMap={invMap} loading={loading}
            onMinSaved={async (msg) => { await refresh(); flash(msg) }} />
        )}
        {tab === 'table' && <InventoryTable analysis={analysis} products={products} invMap={invMap} loading={loading} />}
        {tab === 'reorder' && <ReorderAlerts analysis={analysis} loading={loading} />}
        {tab === 'analysis' && <ConsumptionView analysis={analysis} loading={loading} />}
        {tab === 'history' && <StockHistory />}
        {tab === 'purchases' && <PurchaseHistory />}
      </main>

      {toast && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 bg-slate-900 text-white text-sm font-semibold px-4 py-2.5 rounded-xl shadow-lg">
          {toast}
        </div>
      )}
    </div>
  )
}

// --- Add Stock / Purchase Entry ---------------------------------------------
function AddStock({ products, invMap, profile, onDone }) {
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState(null)     // product
  const [qty, setQty] = useState('')
  const [minStock, setMinStock] = useState('')
  const [supplier, setSupplier] = useState('')
  const [price, setPrice] = useState('')
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)

  const results = useMemo(() => {
    const q = query.trim().toUpperCase()
    if (!q) return []
    return products.filter((p) => (p.name || '').toUpperCase().includes(q)).slice(0, 20)
  }, [query, products])

  const inv = picked ? invMap.get(picked.id) : null
  const isInit = !!inv && inv.inventory_initialized
  const prevStock = isInit ? Number(inv.current_stock) || 0 : null
  const addQty = Number(qty)
  const resultStock = isInit ? (prevStock + (addQty || 0)) : (addQty || 0)

  const reset = () => { setPicked(null); setQty(''); setMinStock(''); setSupplier(''); setPrice(''); setConfirm(false); setQuery('') }

  const save = async () => {
    setBusy(true)
    try {
      // INITIAL when never initialized, otherwise RECEIVED (adds to existing).
      const txnType = isInit ? 'RECEIVED' : 'INITIAL'
      const res = await applyStockChange({
        productId: picked.id,
        productName: picked.name,
        txnType,
        qty: addQty,
        reference: supplier ? `Supplier: ${supplier}` : 'Stock entry',
        userName: profile?.full_name || 'Purchase Manager',
        userId: profile?.id || null,
        minStock: (!isInit && minStock !== '') ? Number(minStock) : null
      })
      if (!res?.applied) { alert('Could not save stock. ' + (res?.reason || '')); setBusy(false); return }
      await recordPurchase({
        productId: picked.id, productName: picked.name, brand: brandOf(picked),
        qty: addQty, purchasePrice: price !== '' ? Number(price) : null,
        supplier: supplier || null, addedBy: profile?.full_name || 'Purchase Manager', addedById: profile?.id || null
      })
      const label = isInit
        ? `Added ${addQty} to ${picked.name}. New stock ${res.current_stock}.`
        : `Initialized ${picked.name} at ${res.current_stock} units.`
      reset()
      onDone(label)
    } catch (e) {
      console.error(e); alert('Could not save stock.'); setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      {/* Product search */}
      <div className="rounded-2xl bg-white border border-slate-200 p-4">
        <label className="block text-[11px] font-semibold text-slate-500 mb-1.5 uppercase tracking-wide">Product</label>
        {picked ? (
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="font-semibold text-slate-800 truncate">{picked.name}</p>
              <p className="text-[11px] text-slate-400">{brandOf(picked)}</p>
            </div>
            <button onClick={reset} className="text-xs font-semibold text-slate-500 px-3 py-1.5 rounded-lg border border-slate-200">Change</button>
          </div>
        ) : (
          <>
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search product…" autoFocus
              className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-brand-500" />
            {results.length > 0 && (
              <div className="mt-2 max-h-64 overflow-y-auto rounded-xl border border-slate-100 divide-y divide-slate-100">
                {results.map((p) => {
                  const st = inventoryStatus(invMap.get(p.id))
                  return (
                    <button key={p.id} onClick={() => setPicked(p)}
                      className="w-full text-left px-3 py-2.5 hover:bg-slate-50 flex items-center justify-between gap-2">
                      <span className="text-sm text-slate-700 truncate">{p.name}</span>
                      <span className={`shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded border ${STATUS_PILL[st.state]}`}>
                        {st.state === 'NOT_INITIALIZED' ? 'Not Updated' : `${st.stock}`}
                      </span>
                    </button>
                  )
                })}
              </div>
            )}
          </>
        )}
      </div>

      {picked && (
        <div className="rounded-2xl bg-white border border-slate-200 p-4 space-y-3">
          {/* Current state */}
          <div className="flex items-center justify-between">
            <span className="text-sm text-slate-500">Current stock</span>
            {isInit
              ? <span className="font-bold text-slate-800">{prevStock} units</span>
              : <span className="text-xs font-semibold text-slate-500 bg-slate-100 border border-slate-200 px-2 py-1 rounded">Not Updated</span>}
          </div>

          <div>
            <label className="block text-[11px] font-semibold text-slate-500 mb-1">{isInit ? 'Quantity received' : 'Initial stock quantity'}</label>
            <input type="number" inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)}
              className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-lg font-semibold outline-none focus:border-brand-500" placeholder="0" />
          </div>

          {!isInit && (
            <div>
              <label className="block text-[11px] font-semibold text-slate-500 mb-1">Minimum stock level (optional)</label>
              <input type="number" inputMode="numeric" value={minStock} onChange={(e) => setMinStock(e.target.value)}
                className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-brand-500" placeholder="e.g. 20" />
            </div>
          )}

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-[11px] font-semibold text-slate-500 mb-1">Supplier (optional)</label>
              <input value={supplier} onChange={(e) => setSupplier(e.target.value)}
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-brand-500" />
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-slate-500 mb-1">Unit price (optional)</label>
              <input type="number" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)}
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-brand-500" />
            </div>
          </div>

          {/* Resulting stock preview */}
          {addQty > 0 && (
            <div className="rounded-xl bg-emerald-50 border border-emerald-200 p-3 text-sm text-emerald-800">
              After saving: <b>{isInit ? `${prevStock} + ${addQty} = ${resultStock}` : resultStock} units</b>
            </div>
          )}

          <button disabled={!(addQty > 0)} onClick={() => setConfirm(true)}
            className="w-full rounded-xl bg-brand-600 text-white py-3 font-bold disabled:bg-slate-300">
            {isInit ? 'Add Stock' : 'Initialize Stock'}
          </button>
        </div>
      )}

      {/* Confirm dialog */}
      {confirm && picked && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center px-6">
          <div className="bg-white w-full max-w-sm rounded-3xl p-5">
            <h2 className="font-bold text-slate-800 text-lg mb-3">Confirm stock entry</h2>
            <dl className="text-sm space-y-1.5 mb-4">
              <div className="flex justify-between"><dt className="text-slate-500">Product</dt><dd className="font-semibold text-slate-800 text-right ml-4">{picked.name}</dd></div>
              <div className="flex justify-between"><dt className="text-slate-500">Existing stock</dt><dd className="font-semibold text-slate-800">{isInit ? `${prevStock} units` : 'Not Updated'}</dd></div>
              <div className="flex justify-between"><dt className="text-slate-500">Quantity {isInit ? 'added' : 'entered'}</dt><dd className="font-semibold text-slate-800">{addQty} units</dd></div>
              <div className="flex justify-between border-t border-slate-100 pt-1.5"><dt className="text-slate-500">Resulting stock</dt><dd className="font-black text-emerald-700">{resultStock} units</dd></div>
            </dl>
            <div className="flex gap-2">
              <button onClick={() => setConfirm(false)} disabled={busy} className="flex-1 rounded-xl border border-slate-200 py-2.5 font-semibold text-slate-600">Cancel</button>
              <button onClick={save} disabled={busy} className="flex-1 rounded-xl bg-emerald-600 text-white py-2.5 font-bold disabled:bg-slate-300">{busy ? 'Saving…' : 'Confirm'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// --- Inventory list ---------------------------------------------------------
function InventoryList({ products, invMap, loading, onMinSaved }) {
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState('all')  // all | initialized | not
  const [editMin, setEditMin] = useState(null) // { product, value }

  const rows = useMemo(() => {
    const query = q.trim().toUpperCase()
    return products
      .filter((p) => !query || (p.name || '').toUpperCase().includes(query))
      .map((p) => ({ p, inv: invMap.get(p.id), st: inventoryStatus(invMap.get(p.id)) }))
      .filter(({ st }) => filter === 'all' || (filter === 'initialized' ? st.state !== 'NOT_INITIALIZED' : st.state === 'NOT_INITIALIZED'))
      .slice(0, 300)
  }, [products, invMap, q, filter])

  const initializedCount = useMemo(() => [...invMap.values()].filter((i) => i.inventory_initialized).length, [invMap])

  const saveMin = async () => {
    if (!editMin) return
    try { await setMinimumStock(editMin.product.id, Number(editMin.value) || 0); setEditMin(null); onMinSaved('Minimum stock updated.') }
    catch (e) { console.error(e); alert('Could not save.') }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search inventory…"
          className="flex-1 min-w-[200px] rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-brand-500 bg-white" />
        <div className="flex gap-1 bg-white rounded-xl border border-slate-200 p-1">
          {[['all', 'All'], ['initialized', 'Tracked'], ['not', 'Not Updated']].map(([k, l]) => (
            <button key={k} onClick={() => setFilter(k)}
              className={`text-xs font-semibold px-3 py-1.5 rounded-lg ${filter === k ? 'bg-brand-600 text-white' : 'text-slate-600'}`}>{l}</button>
          ))}
        </div>
      </div>
      <p className="text-[11px] text-slate-400">{initializedCount} product(s) inventory-tracked · {products.length} total in catalogue</p>

      {loading ? (
        <div className="py-16 flex justify-center"><div className="h-6 w-6 rounded-full border-4 border-slate-200 border-t-slate-800 animate-spin" /></div>
      ) : (
        <div className="rounded-2xl bg-white border border-slate-200 overflow-hidden">
          <div className="divide-y divide-slate-100">
            {rows.map(({ p, inv, st }) => (
              <div key={p.id} className="flex items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-slate-800 truncate">{p.name}</p>
                  <p className="text-[11px] text-slate-400">{brandOf(p)}</p>
                </div>
                {st.state === 'NOT_INITIALIZED' ? (
                  <span className="text-[11px] font-semibold text-slate-500 bg-slate-100 border border-slate-200 px-2 py-1 rounded-lg whitespace-nowrap">Stock Not Updated</span>
                ) : (
                  <div className="flex items-center gap-2">
                    <span className={`text-[11px] font-semibold px-2 py-1 rounded-lg border ${STATUS_PILL[st.state]} whitespace-nowrap`}>
                      {STATUS_DOT[st.state]} {st.stock} · min {inv.minimum_stock}
                    </span>
                    <button onClick={() => setEditMin({ product: p, value: String(inv.minimum_stock ?? '') })}
                      className="text-[11px] font-semibold text-brand-700 px-2 py-1 rounded-lg border border-slate-200">Min</button>
                  </div>
                )}
              </div>
            ))}
            {rows.length === 0 && <p className="text-center text-sm text-slate-400 py-10">No products match.</p>}
          </div>
        </div>
      )}

      {editMin && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center px-6">
          <div className="bg-white w-full max-w-xs rounded-3xl p-5">
            <h2 className="font-bold text-slate-800 mb-1">Minimum stock level</h2>
            <p className="text-[11px] text-slate-400 mb-3 truncate">{editMin.product.name}</p>
            <input type="number" inputMode="numeric" value={editMin.value} autoFocus
              onChange={(e) => setEditMin({ ...editMin, value: e.target.value })}
              className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-lg font-semibold outline-none focus:border-brand-500" />
            <div className="flex gap-2 mt-4">
              <button onClick={() => setEditMin(null)} className="flex-1 rounded-xl border border-slate-200 py-2.5 font-semibold text-slate-600">Cancel</button>
              <button onClick={saveMin} className="flex-1 rounded-xl bg-brand-600 text-white py-2.5 font-bold">Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// --- Reorder Alerts ---------------------------------------------------------
// Only initialized products appear. Priority: Out of Stock, then Low Stock.
function ReorderAlerts({ analysis, loading }) {
  const [pushOn, setPushOn] = useState(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => { loadPurchaseAlertPushEnabled().then(setPushOn).catch(() => setPushOn(true)) }, [])

  const togglePush = async () => {
    const next = !pushOn
    setSaving(true)
    try { await setPurchaseAlertPushEnabled(next); setPushOn(next) }
    catch { alert('Could not update setting.') }
    finally { setSaving(false) }
  }

  const alerts = analysis
    .filter((r) => r.stock <= 0 || r.stock <= r.min)
    .sort((a, b) => {
      const ao = a.stock <= 0 ? 0 : 1, bo = b.stock <= 0 ? 0 : 1
      if (ao !== bo) return ao - bo
      return (a.stock - a.min) - (b.stock - b.min)
    })

  return (
    <div className="space-y-3">
      {/* Push toggle — dashboard alerts always show; this only gates OS push. */}
      <div className="rounded-2xl bg-white border border-slate-200 p-4 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="font-semibold text-slate-800 text-sm">Purchase Stock Push Alerts</p>
          <p className="text-[11px] text-slate-400">Send device notifications when a product hits its reorder level. The list below always shows regardless.</p>
        </div>
        <button onClick={togglePush} disabled={pushOn === null || saving}
          className={`shrink-0 relative h-7 w-12 rounded-full transition ${pushOn ? 'bg-emerald-500' : 'bg-slate-300'}`}>
          <span className={`absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition ${pushOn ? 'left-[22px]' : 'left-0.5'}`} />
        </button>
      </div>

      {loading ? <Spinner /> : alerts.length === 0 ? (
        <Empty title="No reorder alerts" body="All tracked products are above their reorder level." />
      ) : (
        <div className="space-y-2">
          {alerts.map((r) => {
            const out = r.stock <= 0
            return (
              <div key={r.product.id} className={`rounded-2xl bg-white border p-4 ${out ? 'border-red-200' : 'border-amber-200'}`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-semibold text-slate-800 truncate">{r.product.name}</p>
                    <p className="text-[11px] text-slate-400">{(r.product.name || '').split(/[\s-]/)[0]}</p>
                  </div>
                  <span className={`shrink-0 text-[10px] font-bold px-2 py-1 rounded-lg ${out ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'}`}>
                    {out ? '🔴 Out of Stock' : '🟠 Below Reorder Level'}
                  </span>
                </div>
                <div className="grid grid-cols-4 gap-2 mt-3 text-center">
                  <Stat label="Current" value={r.stock} />
                  <Stat label="Reorder Lvl" value={r.min} />
                  <Stat label="30d sales" value={r.last30} />
                  <Stat label="Buy" value={r.recommendedPurchase ?? '—'} accent />
                </div>
                {r.recommendReason && r.recommendReason !== 'insufficient_history' && (
                  <p className="text-[11px] text-slate-400 mt-2">{r.recommendReason}</p>
                )}
                {r.recommendReason === 'insufficient_history' && (
                  <p className="text-[11px] text-slate-400 mt-2">Insufficient sales history for a recommendation.</p>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// --- Consumption / analysis -------------------------------------------------
function ConsumptionView({ analysis, loading }) {
  const [q, setQ] = useState('')
  if (loading) return <Spinner />
  const rows = analysis
    .filter((r) => !q.trim() || (r.product.name || '').toUpperCase().includes(q.trim().toUpperCase()))
    .sort((a, b) => b.total60 - a.total60)
  if (analysis.length === 0) {
    return <Empty title="No tracked products yet" body="Initialize stock for products to see consumption analysis." />
  }
  return (
    <div className="space-y-3">
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search tracked products…"
        className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-brand-500 bg-white" />
      <div className="space-y-2">
        {rows.map((r) => (
          <div key={r.product.id} className="rounded-2xl bg-white border border-slate-200 p-4">
            <div className="flex items-start justify-between gap-2">
              <p className="font-semibold text-slate-800 truncate">{r.product.name}</p>
              <span className="text-[10px] font-semibold text-slate-500">
                {r.trend === 'up' ? '📈 Rising' : r.trend === 'down' ? '📉 Falling' : '➖ Steady'}
              </span>
            </div>
            <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 mt-3 text-center">
              <Stat label="Last 30d" value={r.last30} />
              <Stat label="Prev 30d" value={r.prev30} />
              <Stat label="60d total" value={r.total60} />
              <Stat label="Avg/mo" value={r.avgMonthly} />
              <Stat label="Stock" value={r.stock} />
              <Stat label="Cover" value={r.coverageDays != null ? `${r.coverageDays}d` : '—'} />
            </div>
            {r.recommendedPurchase != null && r.recommendedPurchase > 0 && (
              <div className="mt-3 rounded-xl bg-brand-50 border border-brand-100 p-2.5 text-sm text-brand-800">
                Recommended purchase: <b>{r.recommendedPurchase} units</b>
                <span className="block text-[11px] text-brand-600/80 mt-0.5">{r.recommendReason}</span>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

function Stat({ label, value, accent }) {
  return (
    <div className={`rounded-lg border py-1.5 ${accent ? 'border-brand-200 bg-brand-50' : 'border-slate-200'}`}>
      <div className={`text-sm font-bold ${accent ? 'text-brand-700' : 'text-slate-800'}`}>{value}</div>
      <div className="text-[9px] text-slate-400 uppercase tracking-wide">{label}</div>
    </div>
  )
}
function Spinner() {
  return <div className="py-16 flex justify-center"><div className="h-6 w-6 rounded-full border-4 border-slate-200 border-t-slate-800 animate-spin" /></div>
}
function Empty({ title, body }) {
  return (
    <div className="py-16 text-center">
      <p className="font-semibold text-slate-600">{title}</p>
      <p className="text-sm text-slate-400 mt-1">{body}</p>
    </div>
  )
}

// --- Full inventory table ---------------------------------------------------
function InventoryTable({ analysis, products, invMap, loading }) {
  const [q, setQ] = useState('')
  const [statusF, setStatusF] = useState('all')  // all | tracked | not | reorder

  const analysisByName = useMemo(() => {
    const m = new Map()
    for (const r of analysis) m.set(r.product.id, r)
    return m
  }, [analysis])

  const rows = useMemo(() => {
    const query = q.trim().toUpperCase()
    return products
      .filter((p) => !query || (p.name || '').toUpperCase().includes(query))
      .map((p) => {
        const inv = invMap.get(p.id)
        const st = inventoryStatus(inv)
        const a = analysisByName.get(p.id)
        return { p, inv, st, a }
      })
      .filter(({ st }) => {
        if (statusF === 'all') return true
        if (statusF === 'tracked') return st.state !== 'NOT_INITIALIZED'
        if (statusF === 'not') return st.state === 'NOT_INITIALIZED'
        if (statusF === 'reorder') return st.state === 'OUT' || st.state === 'LOW'
        return true
      })
      .slice(0, 400)
  }, [products, invMap, analysisByName, q, statusF])

  if (loading) return <Spinner />
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…"
          className="flex-1 min-w-[180px] rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-brand-500 bg-white" />
        <div className="flex gap-1 bg-white rounded-xl border border-slate-200 p-1">
          {[['all', 'All'], ['tracked', 'Tracked'], ['not', 'Not Updated'], ['reorder', 'Reorder']].map(([k, l]) => (
            <button key={k} onClick={() => setStatusF(k)}
              className={`text-xs font-semibold px-3 py-1.5 rounded-lg ${statusF === k ? 'bg-brand-600 text-white' : 'text-slate-600'}`}>{l}</button>
          ))}
        </div>
      </div>
      <div className="rounded-2xl bg-white border border-slate-200 overflow-x-auto">
        <table className="w-full text-[11px] border-collapse min-w-[820px]">
          <thead>
            <tr className="bg-slate-900 text-white text-left">
              <th className="px-2 py-2">Product</th>
              <th className="px-2 py-2">Brand</th>
              <th className="px-2 py-2 text-center">Status</th>
              <th className="px-2 py-2 text-center">Stock</th>
              <th className="px-2 py-2 text-center">Min</th>
              <th className="px-2 py-2 text-center">30d Sales</th>
              <th className="px-2 py-2 text-center">Avg/mo</th>
              <th className="px-2 py-2 text-center">Last Purchase</th>
              <th className="px-2 py-2 text-center">Rec. Buy</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ p, inv, st, a }) => (
              <tr key={p.id} className="border-t border-slate-100 align-top">
                <td className="px-2 py-2 font-medium text-slate-800 max-w-[220px] break-words">{p.name}</td>
                <td className="px-2 py-2 text-slate-500">{(p.name || '').split(/[\s-]/)[0]}</td>
                <td className="px-2 py-2 text-center">
                  {st.state === 'NOT_INITIALIZED'
                    ? <span className="text-[9px] font-semibold text-slate-500 bg-slate-100 border border-slate-200 px-1.5 py-0.5 rounded">Not Updated</span>
                    : <span className={`text-[9px] font-semibold px-1.5 py-0.5 rounded border ${STATUS_PILL[st.state]}`}>{STATUS_DOT[st.state]} {st.label}</span>}
                </td>
                <td className="px-2 py-2 text-center font-bold">{st.state === 'NOT_INITIALIZED' ? '—' : st.stock}</td>
                <td className="px-2 py-2 text-center">{inv ? inv.minimum_stock : '—'}</td>
                <td className="px-2 py-2 text-center">{a ? a.last30 : '—'}</td>
                <td className="px-2 py-2 text-center">{a ? a.avgMonthly : '—'}</td>
                <td className="px-2 py-2 text-center whitespace-nowrap">{inv?.last_purchase_date ? new Date(inv.last_purchase_date).toLocaleDateString('en-GB') : '—'}</td>
                <td className="px-2 py-2 text-center font-bold text-brand-700">{a && a.recommendedPurchase != null ? a.recommendedPurchase : '—'}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={9} className="text-center text-slate-400 py-8">No products match.</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-slate-400">Showing {rows.length} product(s).</p>
    </div>
  )
}

const TXN_LABEL = {
  INITIAL: 'Initial Stock', RECEIVED: 'Stock Received', SALE: 'Sales Deduction',
  SALE_RETURN: 'Sales Return', ADJUSTMENT: 'Adjustment', DAMAGED: 'Damaged', CORRECTION: 'Correction'
}

// --- Stock history ----------------------------------------------------------
function StockHistory() {
  const [rows, setRows] = useState(null)
  const [q, setQ] = useState('')
  useEffect(() => { loadInventoryTransactions(null, 300).then(setRows).catch(() => setRows([])) }, [])
  if (rows == null) return <Spinner />
  const filtered = rows.filter((r) => !q.trim() || (r.product_name || '').toUpperCase().includes(q.trim().toUpperCase()))
  if (rows.length === 0) return <Empty title="No stock movements yet" body="Stock entries and sales deductions will appear here." />
  return (
    <div className="space-y-3">
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search product…"
        className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-brand-500 bg-white" />
      <div className="rounded-2xl bg-white border border-slate-200 overflow-x-auto">
        <table className="w-full text-[11px] border-collapse min-w-[720px]">
          <thead><tr className="bg-slate-900 text-white text-left">
            <th className="px-2 py-2">Date / Time</th><th className="px-2 py-2">Product</th><th className="px-2 py-2">Type</th>
            <th className="px-2 py-2 text-center">Qty</th><th className="px-2 py-2 text-center">Prev</th><th className="px-2 py-2 text-center">New</th>
            <th className="px-2 py-2">Reference</th><th className="px-2 py-2">By</th>
          </tr></thead>
          <tbody>
            {filtered.map((r) => (
              <tr key={r.id} className="border-t border-slate-100">
                <td className="px-2 py-2 whitespace-nowrap">{new Date(r.created_at).toLocaleString('en-GB')}</td>
                <td className="px-2 py-2 max-w-[200px] break-words">{r.product_name}</td>
                <td className="px-2 py-2 whitespace-nowrap">{TXN_LABEL[r.txn_type] || r.txn_type}</td>
                <td className={`px-2 py-2 text-center font-bold ${Number(r.qty) < 0 ? 'text-red-600' : 'text-emerald-700'}`}>{Number(r.qty) > 0 ? '+' : ''}{r.qty}</td>
                <td className="px-2 py-2 text-center text-slate-500">{r.previous_stock ?? '—'}</td>
                <td className="px-2 py-2 text-center font-semibold">{r.updated_stock ?? '—'}</td>
                <td className="px-2 py-2 text-slate-500 max-w-[160px] break-words">{r.reference || '—'}</td>
                <td className="px-2 py-2 text-slate-500">{r.user_name || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// --- Purchase history -------------------------------------------------------
function PurchaseHistory() {
  const [rows, setRows] = useState(null)
  useEffect(() => { loadPurchases(200).then(setRows).catch(() => setRows([])) }, [])
  if (rows == null) return <Spinner />
  if (rows.length === 0) return <Empty title="No purchases yet" body="Stock you receive will be recorded here." />
  return (
    <div className="rounded-2xl bg-white border border-slate-200 overflow-x-auto">
      <table className="w-full text-[11px] border-collapse min-w-[720px]">
        <thead><tr className="bg-slate-900 text-white text-left">
          <th className="px-2 py-2">Date</th><th className="px-2 py-2">Product</th><th className="px-2 py-2">Brand</th>
          <th className="px-2 py-2 text-center">Qty</th><th className="px-2 py-2 text-center">Unit ₹</th><th className="px-2 py-2 text-center">Total ₹</th>
          <th className="px-2 py-2">Supplier</th><th className="px-2 py-2">By</th>
        </tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-t border-slate-100">
              <td className="px-2 py-2 whitespace-nowrap">{new Date(r.created_at).toLocaleDateString('en-GB')}</td>
              <td className="px-2 py-2 max-w-[200px] break-words">{r.product_name}</td>
              <td className="px-2 py-2 text-slate-500">{r.brand || '—'}</td>
              <td className="px-2 py-2 text-center font-bold">{r.qty}</td>
              <td className="px-2 py-2 text-center">{r.purchase_price != null ? `₹${r.purchase_price}` : '—'}</td>
              <td className="px-2 py-2 text-center">{r.total_value != null ? `₹${r.total_value}` : '—'}</td>
              <td className="px-2 py-2 text-slate-500">{r.supplier || '—'}</td>
              <td className="px-2 py-2 text-slate-500">{r.added_by || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
