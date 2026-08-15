import { useEffect, useState } from 'react'
import { useAuth } from '../context/AuthContext.jsx'
import { loadAdminDashboard, loadSalesTrend, loadTopProducts, listAllRoutes, listSalespeople } from '../utils/cloudSync.js'
import ReportPanel from '../components/ReportPanel.jsx'
import SalesTrendChart from '../components/SalesTrendChart.jsx'
import TopProductsChart from '../components/TopProductsChart.jsx'
import appIcon from '../assets/app_icon.png'

const PERIODS = [
  { key: 'today', label: 'Today' },
  { key: 'week', label: 'This Week' },
  { key: 'month', label: 'This Month' }
]

// Order-status pipeline stages, in order, with the color used consistently
// across the donut and its legend. Colors are the brand green plus a small
// set of complementary accents so each stage reads distinctly at a glance.
const STATUS_STAGES = [
  { key: 'pendingBilling', label: 'Pending Billing', color: '#f59e0b' },
  { key: 'qcPending', label: 'QC Pending', color: '#f97316' },
  { key: 'qcInProgress', label: 'QC In Progress', color: '#3b82f6' },
  { key: 'readyForDelivery', label: 'Ready for Delivery', color: '#8b5cf6' },
  { key: 'delivered', label: 'Delivered', color: '#059669' }
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

function fmtRupee(n) {
  return `₹${Number(n || 0).toLocaleString('en-IN')}`
}

function TeamStat({ label, value, accent }) {
  return (
    <div className="rounded-2xl bg-white shadow-card border border-slate-100 p-3.5 text-center">
      <p className={`text-2xl font-bold ${accent || 'text-brand-700'}`}>{value}</p>
      <p className="text-[11px] text-slate-500 mt-0.5">{label}</p>
    </div>
  )
}

// Lightweight SVG donut — no external chart library needed. Renders a ring
// made of one arc per non-zero stage, plus a centered total.
function StatusDonut({ stages, total }) {
  const size = 132
  const stroke = 16
  const r = (size - stroke) / 2
  const cx = size / 2
  const cy = size / 2
  const circumference = 2 * Math.PI * r

  let offset = 0
  const arcs = stages
    .filter((s) => s.value > 0)
    .map((s) => {
      const frac = total > 0 ? s.value / total : 0
      const dash = frac * circumference
      const arc = (
        <circle
          key={s.key}
          cx={cx}
          cy={cy}
          r={r}
          fill="none"
          stroke={s.color}
          strokeWidth={stroke}
          strokeDasharray={`${dash} ${circumference - dash}`}
          strokeDashoffset={-offset}
          transform={`rotate(-90 ${cx} ${cy})`}
          strokeLinecap={stages.filter((x) => x.value > 0).length === 1 ? 'butt' : 'round'}
        />
      )
      offset += dash
      return arc
    })

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="#f1f5f9" strokeWidth={stroke} />
      {arcs}
      <text x={cx} y={cy - 3} textAnchor="middle" className="fill-slate-800" style={{ fontSize: 22, fontWeight: 700 }}>
        {total}
      </text>
      <text x={cx} y={cy + 14} textAnchor="middle" className="fill-slate-400" style={{ fontSize: 9.5 }}>
        Total
      </text>
    </svg>
  )
}


export default function AdminDashboard({ onOpenProducts, onOpenSalespeople, onOpenAnnounce, onOpenVerified, embedded }) {
  const { profile, signOut } = useAuth()
  const [data, setData] = useState(null)
  const [error, setError] = useState(false)
  const [period, setPeriod] = useState('today')
  const [selectedRep, setSelectedRep] = useState(null)

  // Sales Trend + Top Products share one custom date range, adjustable by the
  // admin. Defaults to the last 30 days (same as the original fixed window)
  // so behaviour is unchanged until someone picks a different range.
  const defaultTo = new Date().toISOString().slice(0, 10)
  const defaultFrom = (() => {
    const d = new Date()
    d.setDate(d.getDate() - 29)
    return d.toISOString().slice(0, 10)
  })()
  const [chartFrom, setChartFrom] = useState(defaultFrom)
  const [chartTo, setChartTo] = useState(defaultTo)
  const [trend, setTrend] = useState(null)
  const [topProducts, setTopProducts] = useState(null)
  const [chartError, setChartError] = useState(false)

  // Route + Sales Rep filters for the product analytics (Sales Trend + Top
  // Selling Products) — combinable with each other and with the date range.
  // '' means "All" for both, matching the existing behaviour when unset.
  const [chartRoute, setChartRoute] = useState('')
  const [chartRepId, setChartRepId] = useState('')
  const [routeOptions, setRouteOptions] = useState([])
  const [repOptions, setRepOptions] = useState([])

  useEffect(() => {
    listAllRoutes().then(setRouteOptions).catch(() => {})
    listSalespeople().then(setRepOptions).catch(() => {})
  }, [])

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

  // Charts reload whenever the shared date range OR the route/rep filter
  // changes — independently of the main dashboard call, so adjusting a
  // filter never blocks/reloads the KPIs or leaderboard above.
  const refreshCharts = async () => {
    setChartError(false)
    try {
      const [t, p] = await Promise.all([
        loadSalesTrend(chartFrom, chartTo, chartRoute || null, chartRepId || null),
        loadTopProducts(chartFrom, chartTo, chartRoute || null, chartRepId || null)
      ])
      setTrend(t)
      setTopProducts(p)
    } catch (e) {
      console.error(e)
      setChartError(true)
    }
  }

  useEffect(() => {
    refresh()
  }, [])

  useEffect(() => {
    refreshCharts()
    // eslint-disable-next-line
  }, [chartFrom, chartTo, chartRoute, chartRepId])

  const reps = data
    ? [...data.reps].sort((a, b) => b[period].score - a[period].score)
    : []

  const content = (
    <>
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
          <div className="flex items-center justify-between mb-2 px-1">
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide">
              Team — This Month
            </p>
            <button
              onClick={refresh}
              className="text-xs font-semibold text-brand-600 px-2 py-1 rounded-lg active:bg-brand-50"
            >
              ↻ Refresh
            </button>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 mb-4">
            <TeamStat label="Orders" value={data.teamMonth.orders} />
            <TeamStat label="Revenue" value={fmtRupee(data.teamRevenue)} accent="text-brand-700" />
            <TeamStat label="Qty" value={data.teamMonth.quantity} />
            <TeamStat label="Visits" value={data.teamMonth.visits} />
            <TeamStat label="New Shops" value={data.teamMonth.newShops} />
          </div>
          <p className="text-[11px] text-slate-400 mb-4 px-1">
            Today: {data.teamToday.orders} orders · {data.teamToday.visits} visits
          </p>

          {/* Order Status pipeline */}
          <div className="rounded-2xl bg-white shadow-card border border-slate-100 p-4 mb-4">
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3">
              Order Status — This Month
            </p>
            <div className="flex items-center gap-5 flex-wrap sm:flex-nowrap">
                <div className="shrink-0 mx-auto sm:mx-0">
                  <StatusDonut
                    stages={STATUS_STAGES.map((s) => ({ ...s, value: data.orderStatus[s.key] }))}
                    total={data.orderStatusTotal}
                  />
                </div>
                <div className="flex-1 min-w-[180px] space-y-2 w-full">
                  {STATUS_STAGES.map((s) => (
                    <div key={s.key} className="flex items-center justify-between text-sm">
                      <span className="flex items-center gap-2 text-slate-600">
                        <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ background: s.color }} />
                        {s.label}
                      </span>
                      <span className="font-semibold text-slate-800">
                        {data.orderStatus[s.key]}
                        <span className="text-slate-400 font-normal ml-1">
                          ({data.orderStatusTotal > 0 ? Math.round((data.orderStatus[s.key] / data.orderStatusTotal) * 100) : 0}%)
                        </span>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Sales Trend + Top Products — share one adjustable date range */}
            <div className="rounded-2xl bg-white shadow-card border border-slate-100 p-4 mb-2">
              <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">
                Chart Range
              </p>
              <div className="flex items-center gap-2 flex-wrap mb-2">
                <input
                  type="date" value={chartFrom} max={chartTo}
                  onChange={(e) => setChartFrom(e.target.value)}
                  className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm outline-none focus:border-brand-500"
                />
                <span className="text-slate-400 text-sm">to</span>
                <input
                  type="date" value={chartTo} min={chartFrom} max={defaultTo}
                  onChange={(e) => setChartTo(e.target.value)}
                  className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm outline-none focus:border-brand-500"
                />
              </div>
              <div className="flex gap-1.5 flex-wrap">
                {[
                  ['7', '7 Days', 6],
                  ['30', '30 Days', 29],
                  ['90', '90 Days', 89]
                ].map(([key, label, back]) => (
                  <button
                    key={key}
                    onClick={() => {
                      const to = new Date().toISOString().slice(0, 10)
                      const from = new Date(); from.setDate(from.getDate() - back)
                      setChartFrom(from.toISOString().slice(0, 10)); setChartTo(to)
                    }}
                    className="px-2.5 py-1 rounded-lg text-xs font-semibold bg-white border border-slate-200 text-slate-600 hover:bg-slate-50"
                  >
                    Last {label}
                  </button>
                ))}
                <button
                  onClick={() => {
                    const now = new Date()
                    setChartFrom(new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10))
                    setChartTo(now.toISOString().slice(0, 10))
                  }}
                  className="px-2.5 py-1 rounded-lg text-xs font-semibold bg-white border border-slate-200 text-slate-600 hover:bg-slate-50"
                >
                  This Month
                </button>
              </div>

              {/* Route + Sales Rep filters — combinable with each other and
                  with the date range above. Both default to "All". */}
              <div className="flex items-center gap-2 flex-wrap mt-3 pt-3 border-t border-slate-100">
                <div className="flex-1 min-w-[160px]">
                  <label className="block text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-1">Route</label>
                  <select
                    value={chartRoute}
                    onChange={(e) => setChartRoute(e.target.value)}
                    className="w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm outline-none focus:border-brand-500 bg-white"
                  >
                    <option value="">All Routes</option>
                    {routeOptions.map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>
                </div>
                <div className="flex-1 min-w-[160px]">
                  <label className="block text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-1">Sales Representative</label>
                  <select
                    value={chartRepId}
                    onChange={(e) => setChartRepId(e.target.value)}
                    className="w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm outline-none focus:border-brand-500 bg-white"
                  >
                    <option value="">All Representatives</option>
                    {repOptions.map((r) => <option key={r.id} value={r.id}>{r.full_name}</option>)}
                  </select>
                </div>
                {(chartRoute || chartRepId) && (
                  <button
                    onClick={() => { setChartRoute(''); setChartRepId('') }}
                    className="self-end px-2.5 py-1.5 rounded-lg text-xs font-semibold text-brand-700 border border-slate-200 hover:bg-slate-50"
                  >
                    Clear
                  </button>
                )}
              </div>
              {(chartRoute || chartRepId) && (
                <p className="text-[11px] text-slate-400 mt-2">
                  Showing: {chartRoute || 'All routes'} · {repOptions.find((r) => r.id === chartRepId)?.full_name || 'All representatives'}
                </p>
              )}
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-2 mb-4">
              <div className="rounded-2xl bg-white shadow-card border border-slate-100 p-4">
                <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3">
                  Sales Trend
                </p>
                {chartError && <p className="text-sm text-red-500 text-center py-8">Could not load trend.</p>}
                {!trend && !chartError && (
                  <div className="py-12 flex justify-center">
                    <div className="h-6 w-6 rounded-full border-4 border-brand-100 border-t-brand-600 animate-spin" />
                  </div>
                )}
                {trend && !chartError && <SalesTrendChart data={trend} />}
              </div>
              <div className="rounded-2xl bg-white shadow-card border border-slate-100 p-4">
                <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3">
                  Top Selling Products
                </p>
                {chartError && <p className="text-sm text-red-500 text-center py-8">Could not load products.</p>}
                {!topProducts && !chartError && (
                  <div className="py-12 flex justify-center">
                    <div className="h-6 w-6 rounded-full border-4 border-brand-100 border-t-brand-600 animate-spin" />
                  </div>
                )}
                {topProducts && !chartError && (
                  <TopProductsChart
                    byQty={topProducts.byQty}
                    byOrders={topProducts.byOrders}
                    totalQty={topProducts.totalQty}
                    totalOrders={topProducts.totalOrders}
                  />
                )}
              </div>
            </div>

            {/* Management tools — row on desktop, stacked on mobile */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
              <button
                onClick={onOpenProducts}
                className="rounded-2xl bg-white shadow-card border border-slate-100 p-3 flex items-center justify-between active:bg-slate-50"
              >
                <span className="flex items-center gap-2 text-sm font-semibold text-slate-700">
                  📦 Product & Price
                </span>
                <span className="text-slate-300">›</span>
              </button>
              <button
                onClick={onOpenSalespeople}
                className="rounded-2xl bg-white shadow-card border border-slate-100 p-3 flex items-center justify-between active:bg-slate-50"
              >
                <span className="flex items-center gap-2 text-sm font-semibold text-slate-700">
                  👥 Salespeople
                </span>
                <span className="text-slate-300">›</span>
              </button>
              <button
                onClick={onOpenAnnounce}
                className="rounded-2xl bg-white shadow-card border border-slate-100 p-3 flex items-center justify-between active:bg-slate-50"
              >
                <span className="flex items-center gap-2 text-sm font-semibold text-slate-700">
                  📢 Announcement
                </span>
                <span className="text-slate-300">›</span>
              </button>
              <button
                onClick={onOpenVerified}
                className="rounded-2xl bg-white shadow-card border border-slate-100 p-3 flex items-center justify-between active:bg-slate-50"
              >
                <span className="flex items-center gap-2 text-sm font-semibold text-slate-700">
                  ✅ Verified Orders
                </span>
                <span className="text-slate-300">›</span>
              </button>
            </div>

            {/* Download performance report */}
            <ReportPanel kind="sales" />

            {/* Two-column layout on desktop: leaderboard | activity */}
            <div className="lg:grid lg:grid-cols-2 lg:gap-6">
            <div>
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

            </div>{/* end leaderboard column */}

            <div>
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

            </div>{/* end activity column */}
            </div>{/* end two-column grid */}

          <p className="text-center text-[11px] text-slate-400 mt-5">
            Score = orders×10 + new shops×15 + visits×2 + qty÷10
          </p>
        </>
      )}
    </>
  )

  if (embedded) {
    return <div className="px-3 sm:px-6 pt-3 pb-10">{content}</div>
  }

  return (
    <div className="min-h-screen bg-slate-50 pb-10">
      <header className="sticky top-0 z-20 bg-white border-b border-slate-100 safe-top">
        <div className="mx-auto max-w-5xl px-3 sm:px-6 py-2.5 flex items-center gap-2">
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
      <main className="mx-auto max-w-5xl px-3 sm:px-6 pt-3">{content}</main>
    </div>
  )
}
