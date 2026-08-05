import { useEffect, useState } from 'react'
import { useAuth } from '../context/AuthContext.jsx'
import {
  loadBillingReps,
  loadBillingOrders,
  loadBillingOrderItems,
  verifyOrder
} from '../utils/cloudSync.js'
import appIcon from '../assets/app_icon.png'

export default function BillingDashboard() {
  const { profile, signOut } = useAuth()
  const [reps, setReps] = useState(null)
  const [error, setError] = useState(false)
  const [selectedRep, setSelectedRep] = useState(null)
  const [openOrder, setOpenOrder] = useState(null)

  const loadReps = async () => {
    setError(false)
    try {
      setReps(await loadBillingReps())
    } catch (e) {
      console.error(e)
      setError(true)
    }
  }
  useEffect(() => {
    loadReps()
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

  const load = async () => {
    setError(false); setOrders(null)
    try { setOrders(await loadBillingOrders(rep.id, type === 'All' ? undefined : type)) }
    catch (e) { console.error(e); setError(true) }
  }
  useEffect(() => { load() /* eslint-disable-next-line */ }, [type, rep.id])

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
          <p className="text-[11px] text-slate-400 mt-0.5">{fmt(o.created_at)}</p>
        </button>
      ))}
    </section>
  )
}

function OrderDetailPanel({ order, onBackToOrders, onVerified }) {
  const [items, setItems] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const [copied, setCopied] = useState('')

  useEffect(() => {
    setItems(null)
    ;(async () => {
      try { setItems(await loadBillingOrderItems(order.id)) }
      catch (e) { console.error(e); setError(true) }
    })()
  }, [order.id])

  const copyProduct = (name) => {
    navigator.clipboard?.writeText(name)
    setCopied(name); setTimeout(() => setCopied(''), 1200)
  }
  const doVerify = async () => {
    if (!window.confirm('Are you sure you want to verify this order? It will be sent to Delivery.')) return
    setBusy(true)
    try { await verifyOrder(order.id); onVerified() }
    catch (e) { console.error(e); alert('Could not verify. Try again.'); setBusy(false) }
  }
  const fmt = (iso) => new Date(iso).toLocaleString('en-IN', { day:'numeric', month:'short', year:'numeric', hour:'numeric', minute:'2-digit', hour12:true })

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
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3">Order items ({items.length})</p>
            <div className="space-y-2">
              {items.map((it) => (
                <div key={it.id} className="rounded-xl bg-white shadow-card border border-slate-100 p-3 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium text-slate-800 text-sm">{it.product_name}</p>
                    <p className="text-[11px] text-slate-400 mt-0.5">Qty: {it.qty} {it.unit}</p>
                  </div>
                  <button onClick={() => copyProduct(it.product_name)}
                    className="shrink-0 rounded-lg bg-slate-50 border border-slate-200 text-slate-500 px-3 py-1.5 text-xs hover:bg-slate-100" title="Copy product name">
                    {copied === it.product_name ? '✓ Copied' : '📋 Copy'}
                  </button>
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
    </section>
  )
}
