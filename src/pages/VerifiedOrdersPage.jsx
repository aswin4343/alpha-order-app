import { useEffect, useState } from 'react'
import { loadVerifiedOrdersForAdmin } from '../utils/cloudSync.js'

export default function VerifiedOrdersPage({ onBack }) {
  const [orders, setOrders] = useState(null)
  const [error, setError] = useState(false)
  const [openId, setOpenId] = useState(null)

  const load = async () => {
    setError(false)
    try { setOrders(await loadVerifiedOrdersForAdmin(150)) }
    catch (e) { console.error(e); setError(true) }
  }
  useEffect(() => { load() }, [])

  const fmt = (iso) => iso ? new Date(iso).toLocaleString('en-IN', {
    day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true
  }) : ''

  return (
    <div className="min-h-screen bg-slate-50 pb-10">
      <header className="sticky top-0 z-20 bg-white border-b border-slate-100">
        <div className="mx-auto max-w-3xl px-3 py-2.5 flex items-center gap-2">
          <button onClick={onBack} className="h-10 w-10 rounded-full flex items-center justify-center text-slate-600 hover:bg-slate-100 text-xl">‹</button>
          <div className="min-w-0 flex-1">
            <h1 className="text-base font-bold text-slate-800">Verified Orders</h1>
            <p className="text-[11px] text-slate-400">Billing-verified, sent to delivery</p>
          </div>
          <button onClick={load} className="text-sm font-semibold text-brand-700 px-3 py-1.5 rounded-lg border border-slate-200 hover:bg-slate-50">Refresh</button>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-3 pt-4">
        {error && <p className="text-center text-sm text-red-500 py-6">Could not load.</p>}
        {!orders && !error && (
          <div className="py-10 flex justify-center"><div className="h-7 w-7 rounded-full border-4 border-brand-100 border-t-brand-600 animate-spin" /></div>
        )}
        {orders && orders.length === 0 && (
          <p className="text-center text-sm text-slate-400 py-10">No verified orders yet.</p>
        )}
        {orders && (
          <div className="space-y-2">
            {orders.map((o) => (
              <div key={o.id} className="rounded-2xl bg-white shadow-card border border-slate-100 overflow-hidden">
                <button onClick={() => setOpenId(openId === o.id ? null : o.id)}
                  className="w-full text-left p-3.5 flex items-center justify-between hover:bg-slate-50">
                  <div className="min-w-0">
                    <p className="font-semibold text-slate-800 truncate">{o.shop_name}</p>
                    <p className="text-[11px] text-slate-400 truncate">
                      {o.route || 'No route'} · {o.rep_name} · {fmt(o.verified_at)}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-[11px] text-slate-400">{o.items.length} items</span>
                    <span className="text-slate-300 text-lg">{openId === o.id ? '⌃' : '⌄'}</span>
                  </div>
                </button>
                {openId === o.id && (
                  <div className="border-t border-slate-100 p-3 bg-slate-50/50">
                    {o.items.map((it, i) => (
                      <div key={i} className="flex items-center justify-between py-1.5 text-sm">
                        <span className="text-slate-700">{it.product_name}</span>
                        <span className="text-slate-400 text-xs">{it.qty} {it.unit}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  )
}
