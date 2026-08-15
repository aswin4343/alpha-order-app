import { useEffect, useState, useMemo } from 'react'
import { useAuth } from '../context/AuthContext.jsx'
import { useApp } from '../context/AppContext.jsx'
import {
  loadBillingReps,
  loadBillingOrders,
  loadBillingOrderItemsFull,
  setItemAvailable,
  editItemQty,
  removeItem,
  replaceItem,
  verifyOrder,
  loadDeletedBillingOrders,
  loadBillingCounts
} from '../utils/cloudSync.js'
import appIcon from '../assets/app_icon.png'

const CHANGE_REASONS = [
  'Stock Out',
  'Product Discontinued',
  'Wrong Product Selected',
  'Alternate Brand',
  'Customer Requested Change',
  'Damaged Stock',
  'Others'
]

export default function BillingDashboard() {
  const { profile, signOut } = useAuth()
  const [reps, setReps] = useState(null)
  const [error, setError] = useState(false)
  // Restore selection from a previous session/tab-reload so progress isn't lost.
  const [selectedRep, setSelectedRep] = useState(() => {
    try { return JSON.parse(sessionStorage.getItem('billing_rep') || 'null') } catch { return null }
  })
  const [openOrder, setOpenOrder] = useState(() => {
    try { return JSON.parse(sessionStorage.getItem('billing_order') || 'null') } catch { return null }
  })

  // Save selection whenever it changes.
  useEffect(() => {
    try { sessionStorage.setItem('billing_rep', JSON.stringify(selectedRep)) } catch {}
  }, [selectedRep])
  useEffect(() => {
    try { sessionStorage.setItem('billing_order', JSON.stringify(openOrder)) } catch {}
  }, [openOrder])

  const loadReps = async () => {
    setError(false)
    try {
      setReps(await loadBillingReps())
    } catch (e) {
      console.error(e)
      setError(true)
    }
  }

  // Quiet background refresh: updates the rep list (pending counts) without
  // disturbing the staff's current view — no spinner, no closing the open order,
  // no scroll reset. Runs on an interval and when the tab regains focus.
  const quietRefreshReps = async () => {
    try {
      const fresh = await loadBillingReps()
      setReps(fresh) // just swap the data; React keeps everything else in place
    } catch (e) {
      // ignore quiet-refresh errors; the manual Refresh button still works
    }
  }

  useEffect(() => {
    loadReps()
    const interval = setInterval(quietRefreshReps, 20000) // every 20s
    const onFocus = () => quietRefreshReps()
    window.addEventListener('focus', onFocus)
    return () => {
      clearInterval(interval)
      window.removeEventListener('focus', onFocus)
    }
  }, [])

  const pickRep = (r) => {
    setSelectedRep(r)
    setOpenOrder(null)
  }

  const [showDeleted, setShowDeleted] = useState(false)

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      <header className="sticky top-0 z-20 bg-white border-b border-slate-200">
        <div className="px-4 lg:px-6 py-2.5 flex items-center gap-3">
          <img src={appIcon} alt="" className="h-9 w-9 rounded-lg" />
          <div className="min-w-0 flex-1">
            <h1 className="text-base font-bold text-slate-800 leading-tight">Billing Verification</h1>
            <p className="text-[11px] text-slate-400">{profile?.full_name || 'Billing Team'}</p>
          </div>
          <button onClick={() => setShowDeleted(true)} className="text-sm font-semibold text-slate-500 px-3 py-1.5 rounded-lg border border-slate-200 hover:bg-slate-50 hidden sm:block">
            Deleted Bills
          </button>
          <button onClick={loadReps} className="text-sm font-semibold text-brand-700 px-3 py-1.5 rounded-lg border border-slate-200 hover:bg-slate-50">Refresh</button>
          <button onClick={signOut} className="text-sm font-semibold text-red-600 px-2">Sign Out</button>
        </div>
      </header>

      <div className="flex-1 flex overflow-hidden">
        {/* Panel 1 — Reps */}
        <aside className={`${selectedRep ? 'hidden lg:flex' : 'flex'} flex-col w-full lg:w-72 xl:w-80 border-r border-slate-200 bg-white overflow-y-auto`}>
          <div className="p-3 border-b border-slate-100">
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide">Sales Reps · Pending</p>
          </div>
          {error && <p className="text-center text-sm text-red-500 py-6">Could not load.</p>}
          {!reps && !error && (
            <div className="py-10 flex justify-center"><div className="h-6 w-6 rounded-full border-4 border-brand-100 border-t-brand-600 animate-spin" /></div>
          )}
          {reps && reps.length === 0 && (
            <p className="text-center text-sm text-slate-400 py-10 px-4">No pending orders. All caught up ✓</p>
          )}
          {reps && reps.map((r) => (
            <button key={r.id} onClick={() => pickRep(r)}
              className={`text-left px-4 py-3 border-b border-slate-50 flex items-center justify-between hover:bg-slate-50 ${selectedRep?.id === r.id ? 'bg-brand-50/60 border-l-4 border-l-brand-600' : ''}`}>
              <div className="min-w-0">
                <p className="font-semibold text-slate-800 truncate">{r.name}</p>
                <p className="text-[11px] text-slate-400">{r.verifiedToday} verified today</p>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <span className="text-lg font-bold text-amber-600">{r.pending}</span>
                <span className="text-[10px] text-slate-400">pending</span>
              </div>
            </button>
          ))}
        </aside>

        {selectedRep && (
          <OrdersPanel rep={selectedRep} openOrderId={openOrder?.id}
            onBackToReps={() => { setSelectedRep(null); setOpenOrder(null); loadReps() }}
            onOpenOrder={(o) => setOpenOrder(o)} hideOnMobileWhenDetail={!!openOrder} />
        )}

        {openOrder && (
          openOrder.hasAddon ? (
            <AddonAwareDetailPanel order={openOrder}
              onBackToOrders={() => setOpenOrder(null)}
              onVerified={() => { setOpenOrder(null); loadReps() }} />
          ) : (
            <OrderDetailPanel order={openOrder}
              onBackToOrders={() => setOpenOrder(null)}
              onVerified={() => { setOpenOrder(null); loadReps() }} />
          )
        )}

        {!selectedRep && (
          <div className="hidden lg:flex flex-1 items-center justify-center text-slate-300">
            <div className="text-center"><div className="text-5xl mb-3">🧾</div>
              <p className="text-sm">Select a sales rep to review their pending orders</p></div>
          </div>
        )}
      </div>

      {showDeleted && <DeletedBillsModal onClose={() => setShowDeleted(false)} />}
    </div>
  )
}

function OrdersPanel({ rep, openOrderId, onBackToReps, onOpenOrder, hideOnMobileWhenDetail }) {
  const [orders, setOrders] = useState(null)
  const [type, setType] = useState('All')
  const [status, setStatus] = useState('pending') // 'pending' | 'verified'
  // 'today' must be the IST calendar day, not UTC — new Date().toISOString()
  // returns the UTC date, which drifts a day off for part of every evening in
  // India. This caused billing's default date filter to occasionally not
  // match what reps actually meant by "today".
  const todayIST = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
  const [dateStr, setDateStr] = useState(() => todayIST()) // default today
  const [expressRoute, setExpressRoute] = useState('') // '' = all express
  const [error, setError] = useState(false)
  const [counts, setCounts] = useState(null) // { all, express, standard, addons }

  const EXPRESS_ROUTES = ['EXP : VARKALA', 'EXP : ATTINGAL', 'EXP : KAZHAKUTTAM']

  // showSpinner=true only for the first load / filter change; quiet refreshes
  // swap data silently so the staff's scroll and open order stay put.
  const load = async (showSpinner = true) => {
    setError(false)
    if (showSpinner) setOrders(null)
    try {
      const effectiveStatus = type === 'Addons' ? 'addons' : status
      const [list, badgeCounts] = await Promise.all([
        loadBillingOrders(
          rep.id,
          type === 'EXP' ? 'EXP' : type === 'STD' ? 'STD' : undefined,
          effectiveStatus,
          dateStr || null,
          type === 'EXP' && expressRoute ? expressRoute : null
        ),
        loadBillingCounts(rep.id, dateStr || null)
      ])
      setOrders(list)
      setCounts(badgeCounts)
    }
    catch (e) { console.error(e); if (showSpinner) setError(true) }
  }
  useEffect(() => {
    load(true)
    const interval = setInterval(() => load(false), 20000) // quiet refresh
    const onFocus = () => load(false)
    window.addEventListener('focus', onFocus)
    return () => {
      clearInterval(interval)
      window.removeEventListener('focus', onFocus)
    }
    // eslint-disable-next-line
  }, [type, status, dateStr, expressRoute, rep.id])

  const fmt = (iso) => new Date(iso).toLocaleString('en-IN', { day:'numeric', month:'short', hour:'numeric', minute:'2-digit', hour12:true })

  return (
    <section className={`${hideOnMobileWhenDetail ? 'hidden lg:flex' : 'flex'} flex-col w-full lg:w-80 xl:w-96 border-r border-slate-200 bg-white overflow-y-auto`}>
      <div className="p-3 border-b border-slate-100 flex items-center gap-2">
        <button onClick={onBackToReps} className="lg:hidden h-8 w-8 rounded-full flex items-center justify-center text-slate-600 hover:bg-slate-100 text-lg">‹</button>
        <div className="min-w-0 flex-1">
          <p className="font-bold text-slate-800 truncate">{rep.name}</p>
          <p className="text-[11px] text-slate-400">
            {type === 'Addons' ? 'Add-ons pending verification' : status === 'verified' ? 'Verified today' : 'Pending orders'}
          </p>
        </div>
      </div>
      {/* Pending / Verified toggle — hidden for Add-ons (that tab is always
          "pending add-on" by definition; verified add-ons simply drop out) */}
      {type !== 'Addons' && (
        <div className="flex gap-1.5 px-3 pt-3">
          {[['pending','Pending'],['verified','Verified']].map(([val,label]) => (
            <button key={val} onClick={() => setStatus(val)}
              className={`flex-1 px-3 py-1.5 rounded-lg text-xs font-bold ${status===val ? (val==='verified' ? 'bg-green-600 text-white' : 'bg-amber-500 text-white') : 'bg-slate-50 border border-slate-200 text-slate-600 hover:bg-slate-100'}`}>
              {label}
            </button>
          ))}
        </div>
      )}
      {/* Order date filter (default today) */}
      <div className="px-3 pt-3 flex items-center gap-2">
        <input type="date" value={dateStr} onChange={(e) => setDateStr(e.target.value)}
          className="flex-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs outline-none focus:border-brand-500" />
        <button onClick={() => setDateStr(todayIST())}
          className="text-xs font-semibold text-brand-700 px-2.5 py-1.5 rounded-lg border border-slate-200 hover:bg-slate-50">Today</button>
      </div>
      <div className="grid grid-cols-4 gap-1.5 p-3 pb-2 border-b border-slate-50">
        {[['All','All',counts?.all], ['EXP','Express',counts?.express], ['STD','Standard',counts?.standard], ['Addons','Add-ons',counts?.addons]].map(([t,label,count]) => (
          <button key={t} onClick={() => { setType(t); if (t !== 'EXP') setExpressRoute(''); if (t === 'Addons') setStatus('pending') }}
            className={`px-2 py-1.5 rounded-lg text-[11px] font-semibold flex flex-col items-center gap-0.5 ${type===t ? 'bg-brand-600 text-white' : 'bg-slate-50 border border-slate-200 text-slate-600 hover:bg-slate-100'}`}>
            <span>{label}</span>
            <span className={`text-[13px] font-extrabold ${type===t ? 'text-white' : 'text-brand-600'}`}>{count ?? '–'}</span>
          </button>
        ))}
      </div>
      {/* Express route dropdown — only when Express is selected */}
      {type === 'EXP' && (
        <div className="px-3 pb-3 border-b border-slate-50">
          <select value={expressRoute} onChange={(e) => setExpressRoute(e.target.value)}
            className="w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs outline-none focus:border-brand-500 bg-white">
            <option value="">All Express Routes</option>
            {EXPRESS_ROUTES.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
      )}
      {error && <p className="text-center text-sm text-red-500 py-6">Could not load orders.</p>}
      {!orders && !error && (<div className="py-10 flex justify-center"><div className="h-6 w-6 rounded-full border-4 border-brand-100 border-t-brand-600 animate-spin" /></div>)}
      {orders && orders.length === 0 && (<p className="text-center text-sm text-slate-400 py-10 px-4">{status === 'verified' ? 'No verified orders today.' : 'No pending orders here.'}</p>)}
      {orders && orders.map((o) => (
        <button key={o.id} onClick={() => onOpenOrder({ ...o, _status: status })}
          className={`text-left px-4 py-3 border-b border-slate-50 hover:bg-slate-50 ${openOrderId===o.id ? 'bg-brand-50/60 border-l-4 border-l-brand-600' : ''}`}>
          <p className="font-semibold text-slate-800 truncate">{o.shop_name}</p>
          <p className="text-[11px] text-slate-400 truncate">{o.route || 'No route'}</p>
          <p className="text-[11px] text-slate-400 mt-0.5">
            {fmt(o.created_at)}
            {o.orderCount > 1 && (
              <span className="ml-1.5 text-brand-600 font-semibold">· {o.orderCount} orders merged</span>
            )}
            {status === 'verified' && (
              <span className="ml-1.5 text-green-600 font-semibold">✓ verified</span>
            )}
          </p>
        </button>
      ))}
    </section>
  )
}

function OrderDetailPanel({ order, onBackToOrders, onVerified, singleOrderId, embedded, onlyAddonItems }) {
  const { products } = useApp()
  const [items, setItems] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const [copied, setCopied] = useState('')
  const [editItem, setEditItem] = useState(null)   // item being qty-edited
  const [reasonModal, setReasonModal] = useState(null) // {mode:'remove'|'replace', item, newProduct?}
  const [replaceItemTarget, setReplaceItemTarget] = useState(null) // item being replaced

  // When singleOrderId is given (independent Original/Add-on verification),
  // every item/verify action is scoped to JUST that one order id — never the
  // whole group. This is what keeps the two states independent: verifying
  // here can only ever touch this one order's billing_status.
  const scopeIds = singleOrderId ? [singleOrderId] : (order.orderIds || [order.id])

  const reload = async () => {
    try { setItems(await loadBillingOrderItemsFull(scopeIds)) }
    catch (e) { console.error(e); setError(true) }
  }
  useEffect(() => { setItems(null); setError(false); reload() /* eslint-disable-next-line */ }, [order.id, singleOrderId])

  const copyProduct = (name) => {
    navigator.clipboard?.writeText(name)
    setCopied(name); setTimeout(() => setCopied(''), 1200)
  }

  const doVerify = async () => {
    const label = singleOrderId ? 'this add-on' : 'this order'
    if (!window.confirm(`Are you sure you want to verify ${label}? It will be sent to Delivery.`)) return
    setBusy(true)
    try { await verifyOrder(scopeIds); onVerified() }
    catch (e) { console.error(e); alert('Could not verify. Try again.'); setBusy(false) }
  }

  const toggleAvailable = async (it) => {
    // optimistic
    setItems((prev) => prev.map((x) => x.id === it.id ? { ...x, available: !x.available } : x))
    try { await setItemAvailable(it, !it.available) }
    catch (e) { console.error(e); reload() }
  }

  const fmt = (iso) => new Date(iso).toLocaleString('en-IN', { day:'numeric', month:'short', year:'numeric', hour:'numeric', minute:'2-digit', hour12:true })

  const activeCount = items ? items.filter((i) => !i.removed).length : 0

  // When rendering just the ADD-ON section of a group, only show the items
  // that were genuinely added on this visit (is_addon=true on the item) —
  // NOT the full item list of the order row, which also carries the
  // original items forward (a same-day repeat order re-submits everything
  // already ordered, plus the addition). Showing all of them under "ADD-ON"
  // was the exact source of the confusion: 3 unrelated original items were
  // appearing alongside the 1 real add-on with no way to tell them apart.
  const displayItems = onlyAddonItems && items
    ? items.filter((it) => it.is_addon || it._addonQty > 0)
    : items

  return (
    <section className={embedded ? 'w-full' : 'flex flex-col w-full flex-1 bg-slate-50 overflow-y-auto'}>
      {!embedded && (
        <div className="sticky top-0 bg-white border-b border-slate-200 p-4 flex items-start gap-2 z-10">
          <button onClick={onBackToOrders} className="lg:hidden h-8 w-8 rounded-full flex items-center justify-center text-slate-600 hover:bg-slate-100 text-lg mt-0.5">‹</button>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 flex-wrap">
              <h2 className="text-lg font-bold text-slate-800 truncate">{order.shop_name}</h2>
              {order.original?.is_new_customer && (
                <span className="text-[10px] font-extrabold text-blue-700 bg-blue-100 px-2 py-0.5 rounded-full shrink-0">NEW CUSTOMER</span>
              )}
            </div>
            <p className="text-xs text-slate-500 mt-0.5">{order.route || 'No route'} · {fmt(order.created_at)}</p>
          </div>
        </div>
      )}

      <div className="p-4 lg:p-6 max-w-3xl w-full mx-auto flex-1 pb-6">
        {order.original?.is_new_customer && (
          <div className="rounded-xl bg-blue-50 border border-blue-100 px-3 py-2.5 mb-3">
            <p className="text-[11px] font-bold text-blue-700 uppercase tracking-wide mb-1">New Customer — First Order</p>
            <div className="text-[12px] text-blue-900 space-y-0.5">
              {order.original.intro_phone && <p>Phone: {order.original.intro_phone}</p>}
              {order.original.intro_gstn && <p>GST: {order.original.intro_gstn}</p>}
              {order.original.intro_credit_days && <p>Credit Days: {order.original.intro_credit_days}</p>}
              {order.original.intro_email && <p>Email: {order.original.intro_email}</p>}
              {!order.original.intro_phone && !order.original.intro_gstn && !order.original.intro_email && (
                <p className="text-blue-500">No additional details entered at creation.</p>
              )}
            </div>
          </div>
        )}
        {error && <p className="text-center text-sm text-red-500 py-6">Could not load items.</p>}
        {!items && !error && (<div className="py-10 flex justify-center"><div className="h-6 w-6 rounded-full border-4 border-brand-100 border-t-brand-600 animate-spin" /></div>)}
        {items && (
          <>
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3">
              {onlyAddonItems
                ? `Added items (${displayItems.length})`
                : `Order items (${activeCount}${items.length !== activeCount ? ` · ${items.length - activeCount} removed` : ''})`}
            </p>
            {onlyAddonItems && displayItems.length === 0 && (
              <p className="text-sm text-slate-400 mb-3">No newly added items found for this add-on.</p>
            )}
            <div className="space-y-2">
              {displayItems.map((it) => (
                <div key={it.id}
                  className={`rounded-xl bg-white shadow-card border p-3 ${it.removed ? 'border-red-100 opacity-60' : it.available ? 'border-green-200' : 'border-slate-100'}`}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        {!it.removed && (
                          <input type="checkbox" checked={!!it.available} onChange={() => toggleAvailable(it)}
                            className="h-4 w-4 accent-green-600 shrink-0" title="Available" />
                        )}
                        <p className={`font-medium text-sm ${it.removed ? 'line-through text-slate-400' : 'text-slate-800'}`}>
                          {it.product_name}
                        </p>
                      </div>
                      <div className="flex items-center gap-2 mt-1 ml-6 flex-wrap">
                        <span className="text-[11px] text-slate-500">
                          Qty: <b>{it.qty}</b> {it.unit}
                          {it.original_qty != null && it.original_qty !== it.qty && (
                            <span className="text-amber-600"> (was {it.original_qty})</span>
                          )}
                        </span>
                        {it.change_type === 'replaced' && (
                          <span className="text-[10px] bg-blue-50 text-blue-600 px-1.5 py-0.5 rounded">replaced</span>
                        )}
                        {it.change_type === 'qty' && (
                          <span className="text-[10px] bg-amber-50 text-amber-600 px-1.5 py-0.5 rounded">qty edited</span>
                        )}
                        {it.removed && (
                          <span className="text-[10px] bg-red-50 text-red-600 px-1.5 py-0.5 rounded">removed</span>
                        )}
                        {it.is_special_price && (
                          <span className="text-[10px] font-bold bg-purple-50 text-purple-700 px-1.5 py-0.5 rounded">SPECIAL PRICE</span>
                        )}
                        {it.scheme_enabled === false && (
                          <span className="text-[10px] font-bold bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded">SCHEME OFF</span>
                        )}
                      </div>
                      {it.is_special_price && (
                        <p className="text-[11px] text-purple-600 ml-6 mt-0.5">
                          Normal ₹{it.normal_price} → Special ₹{it.unit_price}
                        </p>
                      )}
                      {it.change_reason && (
                        <p className="text-[10px] text-slate-400 ml-6 mt-0.5">Reason: {it.change_reason}</p>
                      )}
                    </div>
                    <button onClick={() => copyProduct(it.product_name)}
                      className="shrink-0 rounded-lg bg-slate-50 border border-slate-200 text-slate-500 px-2.5 py-1.5 text-xs hover:bg-slate-100" title="Copy product name">
                      {copied === it.product_name ? '✓' : '📋'}
                    </button>
                  </div>

                  {/* Edit actions (only for pending orders) */}
                  {!it.removed && order._status !== 'verified' && (
                    <div className="flex gap-2 mt-2.5 ml-6">
                      <button onClick={() => setEditItem(it)}
                        className="text-xs font-semibold text-brand-700 border border-brand-200 rounded-lg px-2.5 py-1 hover:bg-brand-50">Edit Qty</button>
                      <button onClick={() => setReplaceItemTarget(it)}
                        className="text-xs font-semibold text-blue-600 border border-blue-200 rounded-lg px-2.5 py-1 hover:bg-blue-50">Replace</button>
                      <button onClick={() => setReasonModal({ mode: 'remove', item: it })}
                        className="text-xs font-semibold text-red-600 border border-red-200 rounded-lg px-2.5 py-1 hover:bg-red-50">Remove</button>
                    </div>
                  )}
                </div>
              ))}
            </div>

            {/* Verify button — immediately below the last product */}
            <div className="mt-4">
              {order._status === 'verified' ? (
                <div className="w-full rounded-xl bg-green-50 border border-green-200 text-green-700 py-3 font-bold text-center">
                  ✓ Verified — sent to Delivery
                </div>
              ) : (
                <button onClick={doVerify} disabled={busy || !items}
                  className="w-full rounded-xl bg-brand-600 text-white py-3.5 font-bold hover:bg-brand-700 disabled:bg-slate-300">
                  {busy ? 'Verifying…' : '✓ Verify Order'}
                </button>
              )}
            </div>
          </>
        )}
      </div>

      {/* Qty edit modal */}
      {editItem && (
        <QtyModal item={editItem} onClose={() => setEditItem(null)}
          onSaved={() => { setEditItem(null); reload() }} />
      )}

      {/* Replace search modal */}
      {replaceItemTarget && (
        <ReplaceModal item={replaceItemTarget} products={products}
          onClose={() => setReplaceItemTarget(null)}
          onPicked={(prodName) => { setReplaceItemTarget(null); setReasonModal({ mode: 'replace', item: replaceItemTarget, newProduct: prodName }) }} />
      )}

      {/* Reason modal (remove / replace) */}
      {reasonModal && (
        <ReasonModal info={reasonModal} onClose={() => setReasonModal(null)}
          onDone={() => { setReasonModal(null); reload() }} />
      )}
    </section>
  )
}

// --- Qty edit modal ---------------------------------------------------------
function QtyModal({ item, onClose, onSaved }) {
  const [qty, setQty] = useState(String(item.qty))
  const [busy, setBusy] = useState(false)
  const save = async () => {
    const n = Number(qty)
    if (!Number.isFinite(n) || n <= 0) { alert('Enter a valid quantity.'); return }
    setBusy(true)
    try { await editItemQty(item, n, `Quantity ${item.qty} → ${n}`); onSaved() }
    catch (e) { console.error(e); alert('Could not save.'); setBusy(false) }
  }
  return (
    <Modal onClose={onClose} title="Edit Quantity">
      <p className="text-sm text-slate-600 mb-1">{item.product_name}</p>
      <p className="text-[11px] text-slate-400 mb-3">Ordered: {item.qty} {item.unit}</p>
      <input type="number" inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)}
        className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-lg font-semibold outline-none focus:border-brand-500" autoFocus />
      <div className="flex gap-2 mt-4">
        <button onClick={onClose} className="flex-1 rounded-xl border border-slate-200 py-2.5 font-semibold text-slate-600">Cancel</button>
        <button onClick={save} disabled={busy} className="flex-1 rounded-xl bg-brand-600 text-white py-2.5 font-bold disabled:bg-slate-300">
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </Modal>
  )
}

// --- Replace search modal ---------------------------------------------------
function ReplaceModal({ item, products, onClose, onPicked }) {
  const [q, setQ] = useState('')
  const results = useMemo(() => {
    const term = q.trim().toUpperCase()
    if (term.length < 2) return []
    return (products || [])
      .filter((p) => (p.name || '').toUpperCase().includes(term))
      .slice(0, 40)
  }, [q, products])
  return (
    <Modal onClose={onClose} title="Replace Product">
      <p className="text-sm text-slate-600 mb-1">Replacing: <b>{item.product_name}</b></p>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search catalogue…"
        className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-brand-500 mt-2" autoFocus />
      <div className="mt-2 max-h-72 overflow-y-auto divide-y divide-slate-50">
        {q.trim().length < 2 && <p className="text-xs text-slate-400 py-4 text-center">Type at least 2 letters.</p>}
        {q.trim().length >= 2 && results.length === 0 && <p className="text-xs text-slate-400 py-4 text-center">No products found.</p>}
        {results.map((p) => (
          <button key={p.id} onClick={() => onPicked(p.name)}
            className="w-full text-left px-2 py-2.5 text-sm text-slate-700 hover:bg-slate-50">
            {p.name}
          </button>
        ))}
      </div>
    </Modal>
  )
}

// --- Reason modal (remove / replace) ---------------------------------------
function ReasonModal({ info, onClose, onDone }) {
  const [reason, setReason] = useState('')
  const [otherText, setOtherText] = useState('')
  const [busy, setBusy] = useState(false)
  const isReplace = info.mode === 'replace'

  const save = async () => {
    const finalReason = reason === 'Others' ? (otherText.trim() || 'Others') : reason
    if (!finalReason) { alert('Please choose a reason.'); return }
    setBusy(true)
    try {
      if (isReplace) await replaceItem(info.item, info.newProduct, finalReason)
      else await removeItem(info.item, finalReason)
      onDone()
    } catch (e) { console.error(e); alert('Could not save.'); setBusy(false) }
  }

  return (
    <Modal onClose={onClose} title={isReplace ? 'Replacement Reason' : 'Removal Reason'}>
      <p className="text-sm text-slate-600 mb-1">
        {isReplace ? <>Replace <b>{info.item.product_name}</b> with <b>{info.newProduct}</b></> : <>Remove <b>{info.item.product_name}</b></>}
      </p>
      <div className="space-y-1.5 mt-3">
        {CHANGE_REASONS.map((r) => (
          <button key={r} onClick={() => setReason(r)}
            className={`w-full text-left px-3 py-2 rounded-lg text-sm border ${reason === r ? 'border-brand-500 bg-brand-50 text-brand-700 font-semibold' : 'border-slate-200 text-slate-600'}`}>
            {r}
          </button>
        ))}
      </div>
      {reason === 'Others' && (
        <input value={otherText} onChange={(e) => setOtherText(e.target.value)} placeholder="Enter reason…"
          className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-brand-500 mt-2" autoFocus />
      )}
      <div className="flex gap-2 mt-4">
        <button onClick={onClose} className="flex-1 rounded-xl border border-slate-200 py-2.5 font-semibold text-slate-600">Cancel</button>
        <button onClick={save} disabled={busy || !reason} className={`flex-1 rounded-xl py-2.5 font-bold text-white disabled:bg-slate-300 ${isReplace ? 'bg-blue-600' : 'bg-red-600'}`}>
          {busy ? 'Saving…' : isReplace ? 'Replace' : 'Remove'}
        </button>
      </div>
    </Modal>
  )
}

// --- Generic modal shell ----------------------------------------------------
function Modal({ title, children, onClose }) {
  return (
    <div className="fixed inset-0 z-50 flex items-end lg:items-center justify-center bg-black/40 p-0 lg:p-4" onClick={onClose}>
      <div className="bg-white w-full lg:max-w-md rounded-t-2xl lg:rounded-2xl p-4 lg:p-5 max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-bold text-slate-800">{title}</h3>
          <button onClick={onClose} className="h-8 w-8 rounded-full hover:bg-slate-100 text-slate-500 text-lg">×</button>
        </div>
        {children}
      </div>
    </div>
  )
}

/**
 * Read-only audit view of orders sales reps deleted after they'd already
 * reached (or were sitting in) Billing's queue. Deliberately separate from
 * the Pending/Verified rep-scoped panels — this is a global history list,
 * with no verify/edit actions exposed, matching the "read-only" requirement.
 */
function DeletedBillsModal({ onClose }) {
  const [orders, setOrders] = useState(null)
  const [error, setError] = useState(false)
  const [dateStr, setDateStr] = useState('')

  const load = async () => {
    setError(false)
    try {
      setOrders(await loadDeletedBillingOrders(dateStr || null))
    } catch (e) {
      console.error(e)
      setError(true)
    }
  }

  useEffect(() => { load() }, [dateStr]) // eslint-disable-line

  const fmt = (iso) => iso
    ? new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true })
    : '—'
  const rupee = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`

  return (
    <div className="fixed inset-0 z-[80] bg-black/40 flex items-end sm:items-center justify-center">
      <div className="bg-white w-full sm:max-w-lg rounded-t-3xl sm:rounded-3xl max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100">
          <div>
            <h2 className="font-bold text-slate-800">Deleted Bills</h2>
            <p className="text-xs text-slate-400">Read-only — deleted by sales reps, kept for history</p>
          </div>
          <button onClick={onClose} className="p-2 text-slate-400" aria-label="Close">✕</button>
        </div>
        <div className="px-4 pt-3 flex items-center gap-2">
          <input type="date" value={dateStr} onChange={(e) => setDateStr(e.target.value)}
            className="flex-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs outline-none focus:border-brand-500" />
          {dateStr && (
            <button onClick={() => setDateStr('')} className="text-xs font-semibold text-brand-700 px-2.5 py-1.5 rounded-lg border border-slate-200">
              All dates
            </button>
          )}
        </div>
        <div className="overflow-y-auto px-4 py-3 scroll-area">
          {error && <p className="text-center text-sm text-red-500 py-6">Could not load.</p>}
          {!orders && !error && (
            <div className="py-10 flex justify-center"><div className="h-6 w-6 rounded-full border-4 border-brand-100 border-t-brand-600 animate-spin" /></div>
          )}
          {orders && orders.length === 0 && !error && (
            <p className="text-center text-sm text-slate-400 py-10">No deleted bills{dateStr ? ' on this date' : ''}.</p>
          )}
          {orders && orders.map((o) => (
            <div key={o.id} className="rounded-2xl border border-red-100 bg-red-50/40 mb-2.5 p-3 opacity-80">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold text-slate-600 line-through truncate">{o.shop_name}</span>
                <span className="text-[10px] font-bold text-red-700 bg-red-100 px-2 py-0.5 rounded-full shrink-0">DELETED BILL</span>
              </div>
              <p className="text-[11px] text-slate-400 mt-0.5">
                {o.route || 'No route'} · {rupee(o.total_value)} · {o.total_quantity} qty
              </p>
              <p className="text-[11px] text-slate-400">Created {fmt(o.created_at)} · Deleted {fmt(o.deleted_at)}</p>
              {o.delete_reason && (
                <p className="text-[12px] text-slate-500 mt-1.5 bg-white/70 rounded-lg px-2 py-1.5">{o.delete_reason}</p>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

/**
 * Wraps a shop-day group that has an add-on (orderCount > 1). Shows the
 * Add-on and the Original as two INDEPENDENT sections, each with its own
 * status label and its own verify action — reusing OrderDetailPanel (scoped
 * via singleOrderId) unchanged for each, so every existing ticket/edit/
 * verify interaction keeps working exactly as it does for a normal single
 * order. Per spec: verifying one section must NEVER affect the other's
 * billing_status, and a Verified section shows fully but at reduced opacity.
 */
function AddonAwareDetailPanel({ order, onBackToOrders, onVerified }) {
  // order.addons is oldest→newest among the add-ons; per spec we treat the
  // combined "Add-on" section as verified only once ALL add-on orders in the
  // group are verified (mirrors how "Original" is a single order today —
  // most groups will have exactly one add-on order in practice).
  const original = order.original
  const addons = order.addons

  const fmt = (iso) => new Date(iso).toLocaleString('en-IN', { day:'numeric', month:'short', year:'numeric', hour:'numeric', minute:'2-digit', hour12:true })

  return (
    <section className="flex flex-col w-full flex-1 bg-slate-50 overflow-y-auto">
      <div className="sticky top-0 bg-white border-b border-slate-200 p-4 flex items-start gap-2 z-10">
        <button onClick={onBackToOrders} className="lg:hidden h-8 w-8 rounded-full flex items-center justify-center text-slate-600 hover:bg-slate-100 text-lg mt-0.5">‹</button>
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-bold text-slate-800 truncate">{order.shop_name}</h2>
          <p className="text-xs text-slate-500 mt-0.5">{order.route || 'No route'} · {addons.length} add-on{addons.length === 1 ? '' : 's'}</p>
        </div>
      </div>

      <div className="p-4 lg:p-6 max-w-3xl w-full mx-auto flex-1 pb-6 space-y-4">
        {/* ADD-ON section(s) — shown first/prominently, per spec. Each add-on
            order gets its OWN badge + status, since with more than one
            add-on they can be verified independently of each other too. */}
        {addons.map((a, i) => {
          const isVerified = a.billing_status === 'verified'
          return (
            <div key={a.id}>
              <div className="flex items-center gap-2 mb-2">
                <span className="text-[10px] font-extrabold text-amber-700 bg-amber-100 px-2 py-1 rounded-full">
                  ADD-ON{addons.length > 1 ? ` ${i + 1}/${addons.length}` : ''}
                </span>
                <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${isVerified ? 'bg-green-100 text-green-700' : 'bg-amber-50 text-amber-700'}`}>
                  {isVerified ? 'Verified' : 'Pending'}
                </span>
              </div>
              <div className={isVerified ? 'opacity-60 pointer-events-none' : ''}>
                <OrderDetailPanel
                  order={order}
                  singleOrderId={a.id}
                  onlyAddonItems
                  onBackToOrders={onBackToOrders}
                  onVerified={onVerified}
                  embedded
                />
              </div>
            </div>
          )
        })}

        <div className="border-t-2 border-dashed border-slate-200" />

        {/* ORIGINAL BILL section */}
        <div>
          <div className="flex items-center gap-2 mb-2">
            <span className="text-[10px] font-extrabold text-slate-500 bg-slate-100 px-2 py-1 rounded-full">ORIGINAL ORDER</span>
            <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${original.billing_status === 'verified' ? 'bg-green-100 text-green-700' : 'bg-amber-50 text-amber-700'}`}>
              {original.billing_status === 'verified' ? 'Verified' : 'Pending'}
            </span>
          </div>
          <div className={original.billing_status === 'verified' ? 'opacity-60 pointer-events-none' : ''}>
            <OrderDetailPanel
              order={order}
              singleOrderId={original.id}
              onBackToOrders={onBackToOrders}
              onVerified={onVerified}
              embedded
            />
          </div>
        </div>
      </div>
    </section>
  )
}
