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
  const [selectedRep, setSelectedRep] = useState(null) // {id,name}
  const [openOrder, setOpenOrder] = useState(null) // order row

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

  // --- Order detail view ---
  if (openOrder) {
    return (
      <OrderDetail
        order={openOrder}
        onBack={() => setOpenOrder(null)}
        onVerified={() => {
          setOpenOrder(null)
          loadReps()
        }}
      />
    )
  }

  // --- Rep's pending orders list ---
  if (selectedRep) {
    return (
      <RepOrders
        rep={selectedRep}
        onBack={() => {
          setSelectedRep(null)
          loadReps()
        }}
        onOpenOrder={(o) => setOpenOrder(o)}
      />
    )
  }

  // --- Default: rep profiles with pending counts ---
  return (
    <div className="min-h-screen bg-slate-50 pb-10">
      <header className="sticky top-0 z-20 bg-white border-b border-slate-100 safe-top">
        <div className="mx-auto max-w-md px-3 py-2.5 flex items-center gap-2">
          <img src={appIcon} alt="" className="h-9 w-9 rounded-lg" />
          <div className="min-w-0 flex-1">
            <h1 className="text-base font-bold text-slate-800 leading-tight">Billing</h1>
            <p className="text-[11px] text-slate-400">{profile?.full_name || 'Billing Team'}</p>
          </div>
          <button onClick={signOut} className="text-sm font-semibold text-red-600 px-2">
            Sign Out
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-md px-3 pt-4">
        <p className="text-xs text-slate-400 mb-3">
          Tap a sales rep to verify their pending orders.
        </p>

        {error && <p className="text-center text-sm text-red-500 py-6">Could not load. Pull to retry.</p>}
        {!reps && !error && (
          <div className="py-10 flex justify-center">
            <div className="h-7 w-7 rounded-full border-4 border-brand-100 border-t-brand-600 animate-spin" />
          </div>
        )}

        {reps && (
          <div className="space-y-2">
            {reps.map((r) => (
              <button
                key={r.id}
                onClick={() => setSelectedRep(r)}
                className="w-full text-left rounded-2xl bg-white shadow-card border border-slate-100 p-3.5 active:bg-slate-50 flex items-center justify-between"
              >
                <div>
                  <p className="font-semibold text-slate-800">{r.name}</p>
                  <p className="text-[11px] text-slate-400 mt-0.5">
                    {r.verifiedToday} verified today
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xl font-bold text-amber-600">{r.pending}</span>
                  <span className="text-[11px] text-slate-400">pending</span>
                  <span className="text-slate-300 text-lg ml-1">›</span>
                </div>
              </button>
            ))}
            {reps.length === 0 && (
              <p className="text-center text-sm text-slate-400 py-10">
                No pending orders. All caught up ✓
              </p>
            )}
          </div>
        )}
      </main>
    </div>
  )
}

// --- One rep's pending orders, with EXP/STD filter --------------------------
function RepOrders({ rep, onBack, onOpenOrder }) {
  const [orders, setOrders] = useState(null)
  const [type, setType] = useState('All')
  const [error, setError] = useState(false)

  const load = async () => {
    setError(false)
    setOrders(null)
    try {
      setOrders(await loadBillingOrders(rep.id, type === 'All' ? undefined : type))
    } catch (e) {
      console.error(e)
      setError(true)
    }
  }
  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type])

  const fmt = (iso) =>
    new Date(iso).toLocaleString('en-IN', {
      day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true
    })

  return (
    <div className="min-h-screen bg-slate-50 pb-10">
      <header className="sticky top-0 z-20 bg-white border-b border-slate-100 safe-top">
        <div className="mx-auto max-w-md px-3 py-2.5 flex items-center gap-2">
          <button onClick={onBack} className="h-10 w-10 rounded-full flex items-center justify-center text-slate-600 active:bg-slate-100 text-xl">‹</button>
          <div className="min-w-0">
            <h1 className="text-base font-bold text-slate-800 truncate">{rep.name}</h1>
            <p className="text-[11px] text-slate-400">Pending orders</p>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-md px-3 pt-3">
        {/* Delivery-type filter */}
        <div className="flex gap-2 mb-3">
          {['All', 'EXP', 'STD'].map((t) => (
            <button
              key={t}
              onClick={() => setType(t)}
              className={`px-4 py-2 rounded-xl text-sm font-semibold ${
                type === t ? 'bg-brand-600 text-white' : 'bg-white border border-slate-200 text-slate-600'
              }`}
            >
              {t === 'EXP' ? 'Express' : t === 'STD' ? 'Standard' : 'All'}
            </button>
          ))}
        </div>

        {error && <p className="text-center text-sm text-red-500 py-6">Could not load orders.</p>}
        {!orders && !error && (
          <div className="py-10 flex justify-center">
            <div className="h-7 w-7 rounded-full border-4 border-brand-100 border-t-brand-600 animate-spin" />
          </div>
        )}

        {orders && (
          <div className="space-y-2">
            {orders.map((o) => (
              <button
                key={o.id}
                onClick={() => onOpenOrder(o)}
                className="w-full text-left rounded-2xl bg-white shadow-card border border-slate-100 p-3 active:bg-slate-50"
              >
                <p className="font-semibold text-slate-800 truncate">{o.shop_name}</p>
                <p className="text-[11px] text-slate-400 truncate">{o.route || 'No route'}</p>
                <p className="text-[11px] text-slate-400 mt-0.5">{fmt(o.created_at)}</p>
              </button>
            ))}
            {orders.length === 0 && (
              <p className="text-center text-sm text-slate-400 py-10">No pending orders here.</p>
            )}
          </div>
        )}
      </main>
    </div>
  )
}

// --- Order detail + Verify --------------------------------------------------
function OrderDetail({ order, onBack, onVerified }) {
  const [items, setItems] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)

  useEffect(() => {
    ;(async () => {
      try {
        setItems(await loadBillingOrderItems(order.id))
      } catch (e) {
        console.error(e)
        setError(true)
      }
    })()
  }, [order.id])

  const copyProduct = (name) => {
    navigator.clipboard?.writeText(name)
  }

  const doVerify = async () => {
    if (!window.confirm('Are you sure you want to verify this order? It will be sent to Delivery.')) return
    setBusy(true)
    try {
      await verifyOrder(order.id)
      onVerified()
    } catch (e) {
      console.error(e)
      alert('Could not verify. Try again.')
      setBusy(false)
    }
  }

  return (
    <div className="min-h-screen bg-slate-50 pb-28">
      <header className="sticky top-0 z-20 bg-white border-b border-slate-100 safe-top">
        <div className="mx-auto max-w-md px-3 py-2.5 flex items-center gap-2">
          <button onClick={onBack} className="h-10 w-10 rounded-full flex items-center justify-center text-slate-600 active:bg-slate-100 text-xl">‹</button>
          <div className="min-w-0">
            <h1 className="text-base font-bold text-slate-800 truncate">{order.shop_name}</h1>
            <p className="text-[11px] text-slate-400 truncate">{order.route || 'No route'}</p>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-md px-3 pt-4">
        {error && <p className="text-center text-sm text-red-500 py-6">Could not load items.</p>}
        {!items && !error && (
          <div className="py-10 flex justify-center">
            <div className="h-7 w-7 rounded-full border-4 border-brand-100 border-t-brand-600 animate-spin" />
          </div>
        )}

        {items && (
          <div className="space-y-2">
            <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide">
              Order items ({items.length})
            </p>
            {items.map((it) => (
              <div key={it.id} className="rounded-2xl bg-white shadow-card border border-slate-100 p-3 flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-medium text-slate-800 text-sm truncate">{it.product_name}</p>
                  <p className="text-[11px] text-slate-400">Qty: {it.qty} {it.unit}</p>
                </div>
                <button
                  onClick={() => copyProduct(it.product_name)}
                  className="shrink-0 rounded-lg bg-slate-50 border border-slate-200 text-slate-500 px-2.5 py-1.5 text-xs active:bg-slate-100"
                  title="Copy product name"
                >
                  📋
                </button>
              </div>
            ))}
          </div>
        )}
      </main>

      {/* Verify bar */}
      <div className="fixed bottom-0 inset-x-0 bg-white border-t border-slate-100 p-3 safe-bottom">
        <div className="mx-auto max-w-md">
          <button
            onClick={doVerify}
            disabled={busy || !items}
            className="w-full rounded-2xl bg-brand-600 text-white py-3.5 font-bold active:bg-brand-700 disabled:bg-slate-300"
          >
            {busy ? 'Verifying…' : '✓ Verify Order'}
          </button>
        </div>
      </div>
    </div>
  )
}
