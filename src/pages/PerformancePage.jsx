import { useEffect, useState } from 'react'
import { useAuth } from '../context/AuthContext.jsx'
import { loadMyPerformance, currentUserId } from '../utils/cloudSync.js'
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

function Period({ title, data }) {
  return (
    <div className="mb-4">
      <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2 px-1">
        {title}
      </p>
      <div className="grid grid-cols-3 gap-2">
        <StatCard label="Orders" value={data.orders} />
        <StatCard label="Qty" value={data.quantity} />
        <StatCard label="Shops" value={data.shops} />
        <StatCard label="Visits" value={data.visits} />
        <StatCard label="New Shops" value={data.newCustomers} />
      </div>
    </div>
  )
}

export default function PerformancePage({ onBack }) {
  const { user, profile } = useAuth()
  const [perf, setPerf] = useState(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    let active = true
    ;(async () => {
      try {
        const uid = (await currentUserId()) || user.id
        const p = await loadMyPerformance(uid)
        if (active) setPerf(p)
      } catch {
        if (active) setError(true)
      }
    })()
    return () => {
      active = false
    }
  }, [user])

  return (
    <div className="min-h-screen bg-slate-50 pb-10">
      <header className="sticky top-0 z-20 bg-white border-b border-slate-100 safe-top">
        <div className="mx-auto max-w-md px-3 py-2.5 flex items-center gap-2">
          <button
            onClick={onBack}
            className="h-10 w-10 rounded-full flex items-center justify-center text-slate-600 active:bg-slate-100"
          >
            <BackIcon className="h-6 w-6" />
          </button>
          <h1 className="text-lg font-bold text-slate-800">My Performance</h1>
        </div>
      </header>

      <main className="mx-auto max-w-md px-3 pt-3">
        <div className="rounded-2xl bg-brand-600 text-white p-4 mb-4">
          <p className="text-sm opacity-80">Signed in as</p>
          <p className="text-xl font-bold">{profile?.full_name || 'Salesperson'}</p>
          {profile?.route && <p className="text-xs opacity-80 mt-0.5">{profile.route}</p>}
        </div>

        {error && (
          <p className="text-center text-sm text-red-500 py-6">
            Could not load performance. Check your connection.
          </p>
        )}

        {!perf && !error && (
          <div className="py-16 flex justify-center">
            <div className="h-8 w-8 rounded-full border-4 border-brand-100 border-t-brand-600 animate-spin" />
          </div>
        )}

        {perf && (
          <>
            <Period title="Today" data={perf.today} />
            <Period title="This Week" data={perf.week} />
            <Period title="This Month" data={perf.month} />

            <div className="rounded-2xl bg-white shadow-card border border-slate-100 p-4 mt-2">
              <div className="flex items-center justify-between">
                <span className="text-sm text-slate-500">All-time orders</span>
                <span className="font-bold text-slate-800">{perf.totalOrders}</span>
              </div>
              <div className="flex items-center justify-between mt-2">
                <span className="text-sm text-slate-500">All-time visits</span>
                <span className="font-bold text-slate-800">{perf.totalVisits}</span>
              </div>
              <div className="flex items-center justify-between mt-2">
                <span className="text-sm text-slate-500">All-time new shops</span>
                <span className="font-bold text-slate-800">{perf.totalNewCustomers}</span>
              </div>
            </div>
          </>
        )}

        <p className="text-center text-[11px] text-slate-400 mt-5">
          Figures update as you place orders and record visits.
        </p>
      </main>
    </div>
  )
}
