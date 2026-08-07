import { useEffect, useState } from 'react'
import { useAuth } from '../context/AuthContext.jsx'
import {
  loadDeliveryAdmin,
  enrichWithDistance,
  listDeliveryStaff,
  assignGroup,
  updateDeliveryStaff,
  bulkAssignRoute,
  loadGroupDetail,
  listPunches,
  loadDriverTracking,
  unassignGroup
} from '../utils/cloudSync.js'
import appIcon from '../assets/app_icon.png'
import ReportPanel from '../components/ReportPanel.jsx'

const STATUS_LABEL = {
  pending: 'Pending',
  assigned: 'Assigned',
  in_progress: 'In Progress',
  delivered: 'Delivered',
  partial: 'Partial',
  failed: 'Failed'
}
const STATUS_STYLE = {
  pending: 'bg-slate-100 text-slate-600',
  assigned: 'bg-blue-50 text-blue-700',
  in_progress: 'bg-amber-50 text-amber-700',
  delivered: 'bg-green-50 text-green-700',
  partial: 'bg-orange-50 text-orange-700',
  failed: 'bg-red-50 text-red-700'
}

function fmt(iso) {
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

function Stat({ label, value, tone }) {
  return (
    <div className="rounded-2xl bg-white shadow-card border border-slate-100 p-3 text-center">
      <p className={`text-2xl font-bold ${tone || 'text-brand-700'}`}>{value}</p>
      <p className="text-[11px] text-slate-500 mt-0.5">{label}</p>
    </div>
  )
}

export default function DeliveryAdminDashboard() {
  const { profile, signOut } = useAuth()
  const [data, setData] = useState(null)
  const [staff, setStaff] = useState([])
  const [routeFilter, setRouteFilter] = useState('')
  const [dateFilter, setDateFilter] = useState(() => new Date().toISOString().slice(0, 10)) // default: today
  const [tab, setTab] = useState('orders') // 'orders' | 'staff'
  const [error, setError] = useState(false)
  const [busyId, setBusyId] = useState(null)
  const [bulkOpen, setBulkOpen] = useState(false)
  const [bulkStaff, setBulkStaff] = useState('')
  const [bulkBusy, setBulkBusy] = useState(false)
  const [bulkMsg, setBulkMsg] = useState('')
  const [expandedId, setExpandedId] = useState(null)
  const [groupItems, setGroupItems] = useState({})

  const refresh = async () => {
    setError(false)
    try {
      const [d, s] = await Promise.all([
        loadDeliveryAdmin(routeFilter || undefined, dateFilter || undefined),
        listDeliveryStaff()
      ])
      // Show the dashboard immediately (fast — no location lookup yet).
      setData(d)
      setStaff(s)
      // Then add shop distances in the background and update once ready.
      enrichWithDistance(d.deliveries)
        .then((sorted) => setData((cur) => (cur ? { ...cur, deliveries: sorted } : cur)))
        .catch((e) => console.error('enrich failed', e))
    } catch (e) {
      console.error(e)
      setError(true)
    }
  }

  useEffect(() => {
    refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeFilter, dateFilter])

  const doAssign = async (group, staffId) => {
    if (!staffId) return
    setBusyId(group.id)
    try {
      if (staffId === '__none__') {
        await unassignGroup(group)
      } else {
        await assignGroup(group, staffId)
      }
      await refresh()
    } catch (e) {
      console.error(e)
    } finally {
      setBusyId(null)
    }
  }

  const toggleExpand = async (group) => {
    if (expandedId === group.id) {
      setExpandedId(null)
      return
    }
    setExpandedId(group.id)
    if (groupItems[group.id] == null) {
      try {
        const items = await loadGroupDetail(group)
        setGroupItems((prev) => ({ ...prev, [group.id]: items }))
      } catch (e) {
        console.error('load group items failed', e)
        setGroupItems((prev) => ({ ...prev, [group.id]: [] }))
      }
    }
  }

  const doBulkAssign = async () => {
    if (!bulkStaff || !routeFilter) return
    setBulkBusy(true)
    setBulkMsg('')
    try {
      const n = await bulkAssignRoute(routeFilter, bulkStaff)
      const name = staff.find((s) => s.id === bulkStaff)?.full_name || 'staff'
      setBulkMsg(`Assigned ${n} unassigned order(s) on ${routeFilter} to ${name}.`)
      await refresh()
      setTimeout(() => {
        setBulkOpen(false)
        setBulkMsg('')
        setBulkStaff('')
      }, 1400)
    } catch (e) {
      console.error(e)
      setBulkMsg('Could not bulk-assign. Try again.')
    } finally {
      setBulkBusy(false)
    }
  }

  const activeStaff = staff.filter((s) => s.active)

  return (
    <div className="min-h-screen bg-slate-50 pb-10">
      <header className="sticky top-0 z-20 bg-white border-b border-slate-100 safe-top">
        <div className="mx-auto max-w-5xl px-3 sm:px-6 py-2.5 flex items-center gap-2">
          <img src={appIcon} alt="" className="h-8 w-8 rounded-lg object-contain" />
          <div className="flex-1 min-w-0">
            <h1 className="text-base font-bold text-slate-800 leading-tight">Delivery Admin</h1>
            <p className="text-[11px] text-slate-400">{profile?.full_name || 'Delivery Admin'}</p>
          </div>
          <button onClick={refresh} className="text-xs font-semibold text-brand-600 px-2.5 py-1.5 rounded-lg active:bg-brand-50">
            Refresh
          </button>
          <button onClick={signOut} className="text-xs font-semibold text-red-600 px-2.5 py-1.5 rounded-lg active:bg-red-50">
            Sign Out
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-3 sm:px-6 pt-3">
        {error && (
          <p className="text-center text-sm text-red-500 py-6">
            Could not load. Check connection and tap Refresh.
          </p>
        )}
        {!data && !error && (
          <div className="py-16 flex justify-center">
            <div className="h-8 w-8 rounded-full border-4 border-brand-100 border-t-brand-600 animate-spin" />
          </div>
        )}

        {data && (
          <>
            {/* Counts */}
            <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 mb-4">
              <Stat label="Total" value={data.counts.total} />
              <Stat label="Pending" value={data.counts.pending} tone="text-slate-700" />
              <Stat label="Assigned" value={data.counts.assigned} tone="text-blue-700" />
              <Stat label="Delivered" value={data.counts.delivered} tone="text-green-700" />
              <Stat label="Partial" value={data.counts.partial} tone="text-orange-700" />
              <Stat label="Failed" value={data.counts.failed} tone="text-red-700" />
            </div>

            {/* Tabs */}
            <div className="flex gap-1.5 mb-3">
              {[
                ['orders', 'Orders'],
                ['staff', 'Delivery Staff'],
                ['drivers', 'Drivers'],
                ['attendance', 'Attendance']
              ].map(([k, l]) => (
                <button
                  key={k}
                  onClick={() => setTab(k)}
                  className={`flex-1 sm:flex-none sm:px-6 py-2 rounded-lg text-sm font-semibold ${
                    tab === k ? 'bg-brand-600 text-white' : 'bg-white border border-slate-200 text-slate-600'
                  }`}
                >
                  {l}
                </button>
              ))}
            </div>

            {tab === 'orders' && (
              <>
                {/* Download performance report */}
                <ReportPanel kind="delivery" />

                {/* Date filter */}
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <input
                    type="date"
                    value={dateFilter}
                    onChange={(e) => setDateFilter(e.target.value)}
                    className="rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-brand-500 bg-white"
                  />
                  <button
                    onClick={() => setDateFilter(new Date().toISOString().slice(0, 10))}
                    className="rounded-xl border border-slate-200 px-3 py-2.5 text-sm font-semibold text-slate-600 active:bg-slate-50"
                  >
                    Today
                  </button>
                  {dateFilter && (
                    <button
                      onClick={() => setDateFilter('')}
                      className="rounded-xl border border-slate-200 px-3 py-2.5 text-sm font-semibold text-red-600 active:bg-red-50"
                    >
                      Clear date
                    </button>
                  )}
                  {dateFilter && (
                    <span className="text-[12px] text-slate-500">
                      Showing {new Date(dateFilter).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
                    </span>
                  )}
                </div>

                {/* Route filter + bulk assign */}
                <div className="mb-3 flex flex-col sm:flex-row gap-2 sm:items-center">
                  <select
                    value={routeFilter}
                    onChange={(e) => setRouteFilter(e.target.value)}
                    className="w-full sm:w-64 rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-brand-500 bg-white"
                  >
                    <option value="">All routes</option>
                    {data.routes.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                  {routeFilter && activeStaff.length > 0 && (
                    <button
                      onClick={() => setBulkOpen(true)}
                      className="rounded-xl bg-brand-600 text-white px-4 py-2.5 text-sm font-semibold active:bg-brand-700 whitespace-nowrap"
                    >
                      Assign Staff to Route
                    </button>
                  )}
                </div>

                {/* Orders list */}
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
                  {data.deliveries.map((d) => {
                    const staffName = staff.find((s) => s.id === d.assigned_to)?.full_name
                    const isExpanded = expandedId === d.id
                    return (
                      <div key={d.id} className="rounded-2xl bg-white shadow-card border border-slate-100 p-3">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="font-semibold text-slate-800 truncate">
                              {d.shop_name}
                              {d.count > 1 && (
                                <span className="ml-1.5 text-[11px] text-brand-600 font-semibold">
                                  {d.count} orders
                                </span>
                              )}
                            </p>
                            <p className="text-[11px] text-slate-400 truncate">
                              {d.route || 'No route'} · Sales: {d.sales_rep_name || '—'}
                            </p>
                            {d._distanceKm != null && (
                              <p className="text-[10px] text-brand-600 font-medium mt-0.5">
                                📍 {d._distanceKm.toFixed(1)} km from hub
                              </p>
                            )}
                            <p className="text-[10px] text-slate-400 mt-0.5">{fmt(d.created_at)}</p>
                          </div>
                          <div className="flex flex-col items-end gap-1 shrink-0">
                            {d.qc_status === 'qc_pending' && (
                              <span className="text-[10px] font-semibold px-2 py-1 rounded-full bg-amber-50 text-amber-700">🟡 QC Pending</span>
                            )}
                            {d.qc_status === 'in_progress' && (
                              <span className="text-[10px] font-semibold px-2 py-1 rounded-full bg-blue-50 text-blue-700">🔵 QC In Progress</span>
                            )}
                            {d.qc_status === 'qc_verified' && (
                              <span className="text-[10px] font-semibold px-2 py-1 rounded-full bg-green-50 text-green-700">🟢 Ready</span>
                            )}
                            {d.qc_status === 'qc_returned' && (
                              <span className="text-[10px] font-semibold px-2 py-1 rounded-full bg-red-50 text-red-700">🔴 Returned</span>
                            )}
                            <span className={`text-[10px] font-semibold px-2 py-1 rounded-full ${STATUS_STYLE[d.status]}`}>
                              {STATUS_LABEL[d.status]}
                            </span>
                          </div>
                        </div>

                        <div className="mt-2.5 flex items-center gap-2">
                          <select
                            value={d.assigned_to || ''}
                            onChange={(e) => doAssign(d, e.target.value)}
                            disabled={busyId === d.id || activeStaff.length === 0}
                            className="flex-1 rounded-lg border border-slate-200 px-2.5 py-2 text-sm outline-none focus:border-brand-500 bg-white"
                          >
                            <option value="">
                              {staffName ? `Assigned: ${staffName}` : 'Assign to…'}
                            </option>
                            {activeStaff.map((s) => (
                              <option key={s.id} value={s.id}>
                                {s.full_name}
                              </option>
                            ))}
                            {d.assigned_to && <option value="__none__">— None (unassign) —</option>}
                          </select>
                          <button
                            onClick={() => toggleExpand(d)}
                            className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 active:bg-slate-50 whitespace-nowrap"
                          >
                            {isExpanded ? 'Hide' : 'View order'}
                          </button>
                          {busyId === d.id && <span className="text-xs text-slate-400">…</span>}
                        </div>

                        {/* Expanded order details */}
                        {isExpanded && (
                          <div className="mt-3 pt-3 border-t border-slate-100">
                            {groupItems[d.id] == null ? (
                              <p className="text-xs text-slate-400 py-2">Loading order…</p>
                            ) : groupItems[d.id].length === 0 ? (
                              <p className="text-xs text-slate-400 py-2">No items found.</p>
                            ) : (
                              <>
                                <p className="text-[11px] font-semibold text-slate-500 uppercase mb-1.5">
                                  Order items ({groupItems[d.id].length})
                                </p>
                                <div className="space-y-1">
                                  {groupItems[d.id].map((it) => (
                                    <div key={it.id} className="flex items-center justify-between text-[13px]">
                                      <span className="text-slate-700 truncate mr-2">{it.product_name}</span>
                                      <span className="text-slate-500 shrink-0">
                                        {it.ordered_qty} {it.unit}
                                      </span>
                                    </div>
                                  ))}
                                </div>
                                <div className="mt-2 pt-2 border-t border-slate-50 flex justify-between text-[11px] text-slate-400">
                                  <span>{groupItems[d.id].length} products</span>
                                  <span>
                                    Total qty:{' '}
                                    {groupItems[d.id].reduce((s, it) => s + (it.ordered_qty || 0), 0)}
                                  </span>
                                </div>
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })}
                  {data.deliveries.length === 0 && (
                    <p className="text-center text-sm text-slate-400 py-8">
                      No orders {routeFilter ? 'on this route' : 'yet'}.
                    </p>
                  )}
                </div>
              </>
            )}

            {tab === 'staff' && (
              <StaffManager staff={staff} onChanged={refresh} />
            )}

            {tab === 'attendance' && <AttendanceView />}

            {tab === 'drivers' && <DriversView />}
          </>
        )}
      </main>

      {/* Bulk assign modal */}
      {bulkOpen && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center px-6">
          <div className="bg-white w-full max-w-sm rounded-3xl p-5">
            <h2 className="font-bold text-slate-800 text-lg mb-1">Assign staff to route</h2>
            <p className="text-sm text-slate-600 mb-3">
              Assign all <b>unassigned</b> orders on <b>{routeFilter}</b> to one driver.
              Already-assigned orders are left unchanged.
            </p>
            <select
              value={bulkStaff}
              onChange={(e) => setBulkStaff(e.target.value)}
              className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-brand-500 bg-white mb-3"
            >
              <option value="">Select driver…</option>
              {activeStaff.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.full_name}
                </option>
              ))}
            </select>
            {bulkMsg && <p className="text-[13px] text-slate-700 mb-3">{bulkMsg}</p>}
            <div className="flex gap-2">
              <button
                onClick={() => {
                  setBulkOpen(false)
                  setBulkStaff('')
                  setBulkMsg('')
                }}
                disabled={bulkBusy}
                className="flex-1 rounded-xl border border-slate-200 py-3 font-semibold text-slate-600"
              >
                Cancel
              </button>
              <button
                onClick={doBulkAssign}
                disabled={bulkBusy || !bulkStaff}
                className="flex-1 rounded-xl bg-brand-600 text-white py-3 font-bold active:bg-brand-700 disabled:bg-slate-300"
              >
                {bulkBusy ? 'Assigning…' : 'Assign All'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// --- Delivery staff management (edit name/mobile/routes/active) ---------------
function StaffManager({ staff, onChanged }) {
  const [editing, setEditing] = useState(null)
  const [draft, setDraft] = useState({})
  const [saving, setSaving] = useState(false)

  const start = (s) => {
    setEditing(s.id)
    setDraft({
      full_name: s.full_name || '',
      mobile: s.mobile || '',
      routes: (s.assigned_routes || []).join(', '),
      active: s.active
    })
  }

  const save = async (s) => {
    setSaving(true)
    try {
      await updateDeliveryStaff(s.id, {
        full_name: draft.full_name.trim(),
        mobile: draft.mobile.trim(),
        assigned_routes: draft.routes
          .split(',')
          .map((r) => r.trim())
          .filter(Boolean),
        active: draft.active
      })
      setEditing(null)
      onChanged()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
        {staff.map((s) => (
          <div key={s.id} className="rounded-2xl bg-white shadow-card border border-slate-100 p-3">
            {editing === s.id ? (
              <div className="space-y-2">
                <input
                  value={draft.full_name}
                  onChange={(e) => setDraft({ ...draft, full_name: e.target.value })}
                  placeholder="Name"
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                />
                <input
                  value={draft.mobile}
                  onChange={(e) => setDraft({ ...draft, mobile: e.target.value })}
                  placeholder="Mobile number"
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                />
                <input
                  value={draft.routes}
                  onChange={(e) => setDraft({ ...draft, routes: e.target.value })}
                  placeholder="Routes (comma separated)"
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                />
                <label className="flex items-center gap-2 text-sm text-slate-700">
                  <input
                    type="checkbox"
                    checked={draft.active}
                    onChange={(e) => setDraft({ ...draft, active: e.target.checked })}
                    className="h-4 w-4"
                  />
                  Active (can log in and receive deliveries)
                </label>
                <div className="flex gap-2 pt-1">
                  <button
                    onClick={() => save(s)}
                    disabled={saving}
                    className="flex-1 rounded-lg bg-brand-600 text-white py-2 text-sm font-semibold disabled:bg-slate-300"
                  >
                    {saving ? 'Saving…' : 'Save'}
                  </button>
                  <button
                    onClick={() => setEditing(null)}
                    className="flex-1 rounded-lg border border-slate-200 py-2 text-sm text-slate-500"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-between">
                <div className="min-w-0">
                  <p className="font-semibold text-slate-800 truncate">
                    {s.full_name || 'Unnamed'}
                    {!s.active && <span className="ml-2 text-[10px] text-red-500">(disabled)</span>}
                  </p>
                  <p className="text-[11px] text-slate-400 truncate">
                    {s.mobile || 'No mobile'} · {(s.assigned_routes || []).join(', ') || 'No routes'}
                  </p>
                </div>
                <button
                  onClick={() => start(s)}
                  className="text-sm font-semibold text-brand-600 px-3 py-1.5 rounded-lg active:bg-brand-50"
                >
                  Edit
                </button>
              </div>
            )}
          </div>
        ))}
        {staff.length === 0 && (
          <p className="text-center text-sm text-slate-400 py-8">
            No delivery staff yet. Create a user in Supabase with role “delivery_rep”.
          </p>
        )}
      </div>
    </div>
  )
}


// --- Delivery attendance view (punch in/out + hours) -------------------------
function AttendanceView() {
  const [rows, setRows] = useState(null)
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [error, setError] = useState(false)

  const load = async () => {
    setError(false)
    setRows(null)
    try {
      const data = await listPunches(date || undefined)
      setRows(data)
    } catch (e) {
      console.error(e)
      setError(true)
    }
  }
  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date])

  const fmtTime = (iso) =>
    iso
      ? new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true })
      : '—'

  const duration = (a, b) => {
    if (!a || !b) return '—'
    const mins = Math.round((new Date(b) - new Date(a)) / 60000)
    const h = Math.floor(mins / 60)
    const m = mins % 60
    return h > 0 ? `${h}h ${m}m` : `${m}m`
  }

  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-brand-500 bg-white"
        />
        <button
          onClick={() => setDate(new Date().toISOString().slice(0, 10))}
          className="rounded-xl border border-slate-200 px-3 py-2.5 text-sm font-semibold text-slate-600 active:bg-slate-50"
        >
          Today
        </button>
        {date && (
          <button
            onClick={() => setDate('')}
            className="rounded-xl border border-slate-200 px-3 py-2.5 text-sm font-semibold text-red-600 active:bg-red-50"
          >
            All
          </button>
        )}
      </div>

      {error && <p className="text-center text-sm text-red-500 py-6">Could not load attendance.</p>}
      {!rows && !error && (
        <div className="py-10 flex justify-center">
          <div className="h-7 w-7 rounded-full border-4 border-brand-100 border-t-brand-600 animate-spin" />
        </div>
      )}

      {rows && (
        <div className="space-y-2">
          {rows.map((p) => (
            <div key={p.id} className="rounded-2xl bg-white shadow-card border border-slate-100 p-3">
              <div className="flex items-center justify-between">
                <div className="min-w-0">
                  <p className="font-semibold text-slate-800 truncate">{p.person_name}</p>
                  <p className="text-[11px] text-slate-400">
                    Vehicle: {p.vehicle} ·{' '}
                    {new Date(p.punch_in).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-sm font-bold text-brand-700">{duration(p.punch_in, p.punch_out)}</p>
                  <p className="text-[10px] text-slate-400">
                    {fmtTime(p.punch_in)} → {p.punch_out ? fmtTime(p.punch_out) : 'working…'}
                  </p>
                </div>
              </div>
            </div>
          ))}
          {rows.length === 0 && (
            <p className="text-center text-sm text-slate-400 py-8">No punch records for this date.</p>
          )}
        </div>
      )}
    </div>
  )
}


// --- Driver tracking view (last-known location + today's progress) ----------
function DriversView() {
  const [rows, setRows] = useState(null)
  const [error, setError] = useState(false)

  const load = async () => {
    setError(false)
    try {
      setRows(await loadDriverTracking())
    } catch (e) {
      console.error(e)
      setError(true)
    }
  }
  useEffect(() => {
    load()
  }, [])

  const ago = (iso) => {
    if (!iso) return 'never'
    const mins = Math.round((Date.now() - new Date(iso)) / 60000)
    if (mins < 1) return 'just now'
    if (mins < 60) return `${mins} min ago`
    const h = Math.floor(mins / 60)
    if (h < 24) return `${h}h ago`
    return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
  }
  const seenTime = (iso) =>
    iso ? new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true }) : '—'

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs text-slate-400">Last-known location · today\'s progress</p>
        <button
          onClick={load}
          className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 active:bg-slate-50"
        >
          Refresh
        </button>
      </div>

      {error && <p className="text-center text-sm text-red-500 py-6">Could not load drivers.</p>}
      {!rows && !error && (
        <div className="py-10 flex justify-center">
          <div className="h-7 w-7 rounded-full border-4 border-brand-100 border-t-brand-600 animate-spin" />
        </div>
      )}

      {rows && (
        <div className="space-y-2">
          {rows.map((d) => (
            <div key={d.id} className="rounded-2xl bg-white shadow-card border border-slate-100 p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-semibold text-slate-800 truncate">{d.name}</p>
                  <p className="text-[11px] text-slate-400">
                    📍 Last seen {ago(d.lastSeen)}{d.lastSeen ? ` · ${seenTime(d.lastSeen)}` : ''}
                  </p>
                  <p className="text-[12px] text-brand-600 font-medium mt-0.5">
                    {d.total > 0 ? `${d.done} of ${d.total} delivered today` : 'No deliveries today'}
                  </p>
                </div>
                {d.latitude != null && d.longitude != null && (
                  <a
                    href={`https://www.google.com/maps/search/?api=1&query=${d.latitude},${d.longitude}`}
                    target="_blank"
                    rel="noreferrer"
                    className="shrink-0 rounded-lg bg-brand-50 text-brand-700 text-[11px] font-semibold px-2.5 py-1.5 active:bg-brand-100"
                  >
                    📍 View
                  </a>
                )}
              </div>
              {d.total > 0 && (
                <div className="mt-2 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-brand-500"
                    style={{ width: `${Math.round((d.done / d.total) * 100)}%` }}
                  />
                </div>
              )}
            </div>
          ))}
          {rows.length === 0 && (
            <p className="text-center text-sm text-slate-400 py-8">No delivery staff found.</p>
          )}
        </div>
      )}
    </div>
  )
}
