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
  verifyOrder
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

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      <header className="sticky top-0 z-20 bg-white border-b border-slate-200">
        <div className="px-4 lg:px-6 py-2.5 flex items-center gap-3">
          <img src={appIcon} alt="" className="h-9 w-9 rounded-lg" />
          <div className="min-w-0 flex-1">
            <h1 className="text-base font-bold text-slate-800 leading-tight">Billing Verification</h1>
            <p className="text-[11px] text-slate-400">{profile?.full_name || 'Billing Team'}</p>
          </div>
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
          <OrderDetailPanel order={openOrder}
            onBackToOrders={() => setOpenOrder(null)}
            onVerified={() => { setOpenOrder(null); loadReps() }} />
        )}

        {!selectedRep && (
          <div className="hidden lg:flex flex-1 items-center justify-center text-slate-300">
            <div className="text-center"><div className="text-5xl mb-3">🧾</div>
              <p className="text-sm">Select a sales rep to review their pending orders</p></div>
          </div>
        )}
      </div>
    </div>
  )
}

function OrdersPanel({ rep, openOrderId, onBackToReps, onOpenOrder, hideOnMobileWhenDetail }) {
  const [orders, setOrders] = useState(null)
  const [type, setType] = useState('All')
  const [error, setError] = useState(false)

  // showSpinner=true only for the first load / filter change; quiet refreshes
  // swap data silently so the staff's scroll and open order stay put.
  const load = async (showSpinner = true) => {
    setError(false)
    if (showSpinner) setOrders(null)
    try { setOrders(await loadBillingOrders(rep.id, type === 'All' ? undefined : type)) }
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
  }, [type, rep.id])

  const fmt = (iso) => new Date(iso).toLocaleString('en-IN', { day:'numeric', month:'short', hour:'numeric', minute:'2-digit', hour12:true })

  return (
    <section className={`${hideOnMobileWhenDetail ? 'hidden lg:flex' : 'flex'} flex-col w-full lg:w-80 xl:w-96 border-r border-slate-200 bg-white overflow-y-auto`}>
      <div className="p-3 border-b border-slate-100 flex items-center gap-2">
        <button onClick={onBackToReps} className="lg:hidden h-8 w-8 rounded-full flex items-center justify-center text-slate-600 hover:bg-slate-100 text-lg">‹</button>
        <div className="min-w-0 flex-1">
          <p className="font-bold text-slate-800 truncate">{rep.name}</p>
          <p className="text-[11px] text-slate-400">Pending orders</p>
        </div>
      </div>
      <div className="flex gap-1.5 p-3 border-b border-slate-50">
        {['All','EXP','STD'].map((t) => (
          <button key={t} onClick={() => setType(t)}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold ${type===t ? 'bg-brand-600 text-white' : 'bg-slate-50 border border-slate-200 text-slate-600 hover:bg-slate-100'}`}>
            {t==='EXP' ? 'Express' : t==='STD' ? 'Standard' : 'All'}
          </button>
        ))}
      </div>
      {error && <p className="text-center text-sm text-red-500 py-6">Could not load orders.</p>}
      {!orders && !error && (<div className="py-10 flex justify-center"><div className="h-6 w-6 rounded-full border-4 border-brand-100 border-t-brand-600 animate-spin" /></div>)}
      {orders && orders.length === 0 && (<p className="text-center text-sm text-slate-400 py-10 px-4">No pending orders here.</p>)}
      {orders && orders.map((o) => (
        <button key={o.id} onClick={() => onOpenOrder(o)}
          className={`text-left px-4 py-3 border-b border-slate-50 hover:bg-slate-50 ${openOrderId===o.id ? 'bg-brand-50/60 border-l-4 border-l-brand-600' : ''}`}>
          <p className="font-semibold text-slate-800 truncate">{o.shop_name}</p>
          <p className="text-[11px] text-slate-400 truncate">{o.route || 'No route'}</p>
          <p className="text-[11px] text-slate-400 mt-0.5">
            {fmt(o.created_at)}
            {o.orderCount > 1 && (
              <span className="ml-1.5 text-brand-600 font-semibold">· {o.orderCount} orders merged</span>
            )}
          </p>
        </button>
      ))}
    </section>
  )
}

function OrderDetailPanel({ order, onBackToOrders, onVerified }) {
  const { products } = useApp()
  const [items, setItems] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const [copied, setCopied] = useState('')
  const [editItem, setEditItem] = useState(null)   // item being qty-edited
  const [reasonModal, setReasonModal] = useState(null) // {mode:'remove'|'replace', item, newProduct?}
  const [replaceItemTarget, setReplaceItemTarget] = useState(null) // item being replaced

  const reload = async () => {
    try { setItems(await loadBillingOrderItemsFull(order.orderIds || order.id)) }
    catch (e) { console.error(e); setError(true) }
  }
  useEffect(() => { setItems(null); setError(false); reload() /* eslint-disable-next-line */ }, [order.id])

  const copyProduct = (name) => {
    navigator.clipboard?.writeText(name)
    setCopied(name); setTimeout(() => setCopied(''), 1200)
  }

  const doVerify = async () => {
    if (!window.confirm('Are you sure you want to verify this order? It will be sent to Delivery.')) return
    setBusy(true)
    try { await verifyOrder(order.orderIds || order.id); onVerified() }
    catch (e) { console.error(e); alert('Could not verify. Try again.'); setBusy(false) }
  }

  const toggleAvailable = async (it) => {
    // optimistic
    setItems((prev) => prev.map((x) => x.id === it.id ? { ...x, available: !x.available } : x))
    try { await setItemAvailable(it.id, !it.available) }
    catch (e) { console.error(e); reload() }
  }

  const fmt = (iso) => new Date(iso).toLocaleString('en-IN', { day:'numeric', month:'short', year:'numeric', hour:'numeric', minute:'2-digit', hour12:true })

  const activeCount = items ? items.filter((i) => !i.removed).length : 0

  return (
    <section className="flex flex-col w-full flex-1 bg-slate-50 overflow-y-auto">
      <div className="sticky top-0 bg-white border-b border-slate-200 p-4 flex items-start gap-2 z-10">
        <button onClick={onBackToOrders} className="lg:hidden h-8 w-8 rounded-full flex items-center justify-center text-slate-600 hover:bg-slate-100 text-lg mt-0.5">‹</button>
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-bold text-slate-800 truncate">{order.shop_name}</h2>
          <p className="text-xs text-slate-500 mt-0.5">{order.route || 'No route'} · {fmt(order.created_at)}</p>
        </div>
      </div>

      <div className="p-4 lg:p-6 max-w-3xl w-full mx-auto flex-1 pb-28">
        {error && <p className="text-center text-sm text-red-500 py-6">Could not load items.</p>}
        {!items && !error && (<div className="py-10 flex justify-center"><div className="h-6 w-6 rounded-full border-4 border-brand-100 border-t-brand-600 animate-spin" /></div>)}
        {items && (
          <>
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3">
              Order items ({activeCount}{items.length !== activeCount ? ` · ${items.length - activeCount} removed` : ''})
            </p>
            <div className="space-y-2">
              {items.map((it) => (
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
                      </div>
                      {it.change_reason && (
                        <p className="text-[10px] text-slate-400 ml-6 mt-0.5">Reason: {it.change_reason}</p>
                      )}
                    </div>
                    <button onClick={() => copyProduct(it.product_name)}
                      className="shrink-0 rounded-lg bg-slate-50 border border-slate-200 text-slate-500 px-2.5 py-1.5 text-xs hover:bg-slate-100" title="Copy product name">
                      {copied === it.product_name ? '✓' : '📋'}
                    </button>
                  </div>

                  {/* Edit actions */}
                  {!it.removed && (
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
          </>
        )}
      </div>

      <div className="sticky bottom-0 bg-white border-t border-slate-200 p-3">
        <div className="max-w-3xl mx-auto flex lg:justify-center">
          <button onClick={doVerify} disabled={busy || !items}
            className="w-full lg:w-auto lg:px-12 rounded-xl bg-brand-600 text-white py-3 font-bold hover:bg-brand-700 disabled:bg-slate-300">
            {busy ? 'Verifying…' : '✓ Verify Order'}
          </button>
        </div>
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
