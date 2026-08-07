import { useEffect, useState } from 'react'
import { useAuth } from '../context/AuthContext.jsx'
import { loadMyPerformance, loadPerformanceForDate, currentUserId } from '../utils/cloudSync.js'
import { BackIcon } from '../components/Icons.jsx'

function StatCard({ label, value, sub }) {
  return (
    <div className="rounded-2xl bg-white shadow-card border border-slate-100 p-3 text-center">
      <p className="text-2xl font-bold text-brand-700">{value}</p>
      <p className="text-[11px] text-slate-500 mt-0.5">{label}</p>
      {sub != null && <p className="text-[10px] text-slate-400">{sub}</p>}
    </div>
  )
}

export default function PerformancePage({ onBack }) {
  const { user, profile } = useAuth()
  const [uid, setUid] = useState(null)
  const [dateStr, setDateStr] = useState(() => new Date().toISOString().slice(0, 10))
  const [dayPerf, setDayPerf] = useState(null)
  const [totals, setTotals] = useState(null)
  const [error, setError] = useState(false)

  // Resolve the user id once.
  useEffect(() => {
    (async () => {
      const id = (await currentUserId()) || user.id
      setUid(id)
      try { setTotals(await loadMyPerformance(id)) } catch {}
    })()
  }, [user])

  // Load performance for the selected date (updates instantly on date change).
  useEffect(() => {
    if (!uid) return
    let active = true
    setDayPerf(null); setError(false)
    ;(async () => {
      try {
        const p = await loadPerformanceForDate(uid, dateStr)
        if (active) setDayPerf(p)
      } catch {
        if (active) setError(true)
      }
    })()
    return () => { active = false }
  }, [uid, dateStr])

  const prettyDate = new Date(`${dateStr}T00:00:00`).toLocaleDateString('en-IN', {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric'
  })
  const isToday = dateStr === new Date().toISOString().slice(0, 10)

  return (
    <div className="min-h-screen bg-slate-50 pb-10">
      <header className="sticky top-0 z-20 bg-white border-b border-slate-100 safe-top">
        <div className="mx-auto max-w-2xl px-3 py-2.5 flex items-center gap-2">
          <button onClick={onBack} className="h-10 w-10 rounded-full flex items-center justify-center text-slate-600 active:bg-slate-100">
            <BackIcon className="h-6 w-6" />
          </button>
          <h1 className="text-lg font-bold text-slate-800">My Performance</h1>
        </div>
      </header>

      <main className="mx-auto max-w-2xl px-3 pt-3">
        <div className="rounded-2xl bg-brand-600 text-white p-4 mb-4">
          <p className="text-sm opacity-80">Signed in as</p>
          <p className="text-xl font-bold">{profile?.full_name || 'Salesperson'}</p>
          {profile?.route && <p className="text-xs opacity-80 mt-0.5">{profile.route}</p>}
        </div>

        {/* Date picker */}
        <div className="rounded-2xl bg-white shadow-card border border-slate-100 p-3 mb-4">
          <label className="block text-[11px] font-semibold text-slate-400 uppercase tracking-wide mb-1.5">Performance date</label>
          <div className="flex items-center gap-2">
            <input type="date" value={dateStr} onChange={(e) => setDateStr(e.target.value)}
              className="flex-1 rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-brand-500" />
            <button onClick={() => setDateStr(new Date().toISOString().slice(0,10))}
              className={`px-3 py-2.5 rounded-xl text-sm font-semibold border ${isToday ? 'bg-brand-600 text-white border-brand-600' : 'border-slate-200 text-brand-700 hover:bg-slate-50'}`}>
              Today
            </button>
          </div>
          <p className="text-xs text-slate-500 mt-2">{isToday ? "Today's performance" : prettyDate}</p>
        </div>

        {error && <p className="text-center text-sm text-red-500 py-6">Could not load performance.</p>}
        {!dayPerf && !error && (
          <div className="py-10 flex justify-center"><div className="h-8 w-8 rounded-full border-4 border-brand-100 border-t-brand-600 animate-spin" /></div>
        )}

        {dayPerf && (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
              <StatCard label="Orders Taken" value={dayPerf.orders} />
              <StatCard label="Shops Visited" value={dayPerf.shops} />
              <StatCard label="Total Qty" value={dayPerf.quantity} />
              <StatCard label="Order Value" value={`₹${dayPerf.orderValue.toLocaleString('en-IN')}`} />
            </div>
            <p className="text-center text-[11px] text-slate-400">
              Order Value uses the actual selling price recorded on each order.
            </p>
          </>
        )}

        {totals && (
          <div className="rounded-2xl bg-white shadow-card border border-slate-100 p-4 mt-5">
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">All-time</p>
            <div className="flex items-center justify-between"><span className="text-sm text-slate-500">Orders</span><span className="font-bold text-slate-800">{totals.totalOrders}</span></div>
            <div className="flex items-center justify-between mt-2"><span className="text-sm text-slate-500">Visits</span><span className="font-bold text-slate-800">{totals.totalVisits}</span></div>
            <div className="flex items-center justify-between mt-2"><span className="text-sm text-slate-500">New shops</span><span className="font-bold text-slate-800">{totals.totalNewCustomers}</span></div>
          </div>
        )}
      </main>
    </div>
  )
}
