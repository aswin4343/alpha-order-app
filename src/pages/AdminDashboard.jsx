import { useEffect, useState } from 'react'
import { useAuth } from '../context/AuthContext.jsx'
import { loadAdminDashboard } from '../utils/cloudSync.js'
import appIcon from '../assets/app_icon.png'

const PERIODS = [
  { key: 'today', label: 'Today' },
  { key: 'week', label: 'This Week' },
  { key: 'month', label: 'This Month' }
]

function fmtTime(iso) {
  try {
    return new Date(iso).toLocaleString('en-IN', {
      day: 'numeric',
      month: 'short',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    })
  } catch {
    return ''
  }
}

function TeamStat({ label, value }) {
  return (
    <div className="rounded-2xl bg-white shadow-card border border-slate-100 p-3 text-center">
      <p className="text-2xl font-bold text-brand-700">{value}</p>
      <p className="text-[11px] text-slate-500 mt-0.5">{label}</p>
    </div>
  )
}

export default function AdminDashboard({ onOpenProducts }) {
  const { profile, signOut } = useAuth()
  const [data, setData] = useState(null)
  const [error, setError] = useState(false)
  const [period, setPeriod] = useState('today')
  const [selectedRep, setSelectedRep] = useState(null)

  const refresh = async () => {
    setError(false)
    try {
      const d = await loadAdminDashboard()
      setData(d)
    } catch (e) {
      console.error(e)
      setError(true)
    }
  }

  useEffect(() => {
    refresh()
  }, [])

  const reps = data
    ? [...data.reps].sort((a, b) => b[period].score - a[period].score)
    : []

  return (
    <div className="min-h-screen bg-slate-50 pb-10">
      <header className="sticky top-0 z-20 bg-white border-b border-slate-100 safe-top">
        <div className="mx-auto max-w-md px-3 py-2.5 flex items-center gap-2">
          <img src={appIcon} alt="" className="h-8 w-8 rounded-lg object-contain" />
          <div className="flex-1 min-w-0">
            <h1 className="text-base font-bold text-slate-800 leading-tight">Admin Dashboard</h1>
            <p className="text-[11px] text-slate-400">{profile?.full_name || 'Administrator'}</p>
          </div>
          <button
            onClick={refresh}
            className="text-xs font-semibold text-brand-600 px-2.5 py-1.5 rounded-lg active:bg-brand-50"
          >
            Refresh
          </button>
          <button
            onClick={signOut}
            className="text-xs font-semibold text-red-600 px-2.5 py-1.5 rounded-lg active:bg-red-50"
          >
            Sign Out
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-md px-3 pt-3">
        {error && (
          <p className="text-center text-sm text-red-500 py-6">
            Could not load dashboard. Check your connection and try Refresh.
          </p>
        )}

        {!data && !error && (
          <div className="py-16 flex justify-center">
            <div className="h-8 w-8 rounded-full border-4 border-brand-100 border-t-brand-600 animate-spin" />
          </div>
        )}

        {data && (
          <>
            {/* Team snapshot */}
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2 px-1">
              Team — This Month
            </p>
            <div className="grid grid-cols-4 gap-2 mb-4">
              <TeamStat label="Orders" value={data.teamMonth.orders} />
              <TeamStat label="Qty" value={data.teamMonth.quantity} />
              <TeamStat label="Visits" value={data.teamMonth.visits} />
              <TeamStat label="New Shops" value={data.teamMonth.newShops} />
            </div>
            <p className="text-[11px] text-slate-400 mb-4 px-1">
              Today: {data.teamToday.orders} orders · {data.teamToday.visits} visits
            </p>

            {/* Management tools */}
            <button
              onClick={onOpenProducts}
              className="w-full rounded-2xl bg-white shadow-card border border-slate-100 p-3 mb-4 flex items-center justify-between active:bg-slate-50"
            >
              <span className="flex items-center gap-2 text-sm font-semibold text-slate-700">
                📦 Product & Price Management
              </span>
              <span className="text-slate-300">›</span>
            </button>

            {/* Period toggle */}
            <div className="flex gap-1.5 mb-3">
              {PERIODS.map((p) => (
                <button
                  key={p.key}
                  onClick={() => setPeriod(p.key)}
                  className={`flex-1 py-2 rounded-lg text-sm font-semibold ${
                    period === p.key
                      ? 'bg-brand-600 text-white'
                      : 'bg-white border border-slate-200 text-slate-600'
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>

            {/* Leaderboard */}
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2 px-1">
              Leaderboard ({PERIODS.find((p) => p.key === period).label})
            </p>
            <div className="space-y-2 mb-6">
              {reps.map((rep, idx) => {
                const s = rep[period]
                const medal = ['🥇', '🥈', '🥉'][idx] || `${idx + 1}.`
                return (
                  <button
                    key={rep.id}
                    onClick={() => setSelectedRep(selectedRep === rep.id ? null : rep.id)}
                    className={`w-full text-left rounded-2xl bg-white shadow-card border p-3 ${
                      selectedRep === rep.id ? 'border-brand-500' : 'border-transparent'
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <span className="text-lg w-7 text-center">{medal}</span>
                      <div className="flex-1 min-w-0">
                        <p className="font-semibold text-slate-800 truncate">{rep.name}</p>
                        {rep.route && (
                          <p className="text-[11px] text-slate-400 truncate">{rep.route}</p>
                        )}
                      </div>
                      <div className="text-right">
                        <p className="text-lg font-bold text-brand-700">{s.score}</p>
                        <p className="text-[10px] text-slate-400">score</p>
                      </div>
                    </div>

                    {/* Drill-down detail */}
                    {selectedRep === rep.id && (
                      <div className="grid grid-cols-5 gap-1.5 mt-3 pt-3 border-t border-slate-100">
                        {[
                          ['Orders', s.orders],
                          ['Qty', s.quantity],
                          ['Shops', s.shops],
                          ['Visits', s.visits],
                          ['New', s.newShops]
                        ].map(([l, v]) => (
                          <div key={l} className="text-center">
                            <p className="text-sm font-bold text-slate-800">{v}</p>
                            <p className="text-[9px] text-slate-400">{l}</p>
                          </div>
                        ))}
                      </div>
                    )}
                  </button>
                )
              })}
              {reps.length === 0 && (
                <p className="text-center text-sm text-slate-400 py-6">No salespeople yet.</p>
              )}
            </div>

            {/* Recent activity */}
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2 px-1">
              Recent Activity
            </p>
            <div className="rounded-2xl bg-white shadow-card border border-slate-100 divide-y divide-slate-50">
              {data.activity.map((a, i) => (
                <div key={i} className="flex items-center gap-2 px-3 py-2.5">
                  <span className="text-base">{a.type === 'order' ? '🛒' : '📍'}</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-slate-700 truncate">
                      <span className="font-semibold">{a.rep}</span>{' '}
                      {a.type === 'order' ? (
                        <>ordered from {a.shop} <span className="text-slate-400">({a.qty} qty)</span></>
                      ) : (
                        'recorded a no-order visit'
                      )}
                    </p>
                    <p className="text-[10px] text-slate-400">{fmtTime(a.at)}</p>
                  </div>
                </div>
              ))}
              {data.activity.length === 0 && (
                <p className="text-center text-sm text-slate-400 py-6">No activity yet.</p>
              )}
            </div>

            <p className="text-center text-[11px] text-slate-400 mt-5">
              Score = orders×10 + new shops×15 + visits×2 + qty÷10
            </p>
          </>
        )}
      </main>
    </div>
  )
}
