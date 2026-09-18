import { useEffect, useMemo, useState, useRef } from 'react'
import { useAuth } from '../context/AuthContext.jsx'
import { useApp } from '../context/AppContext.jsx'
import { loadMyPerformance, loadPerformanceForDate, currentUserId, resolvePeriodRange, loadMyShortageSummary, loadPendingApprovalBills, loadRejectedBills, loadMyApprovalSummary } from '../utils/cloudSync.js'
import { supabase } from '../utils/supabase.js'
import { BackIcon } from '../components/Icons.jsx'
import VisitsListModal from '../components/VisitsListModal.jsx'
import OrdersListModal from '../components/OrdersListModal.jsx'
import NewShopsListModal from '../components/NewShopsListModal.jsx'
import ApprovalDetailModal from '../components/ApprovalDetailModal.jsx'

function StatCard({ label, value, sub, onClick }) {
  const clickable = !!onClick
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!clickable}
      className={`rounded-2xl bg-white shadow-card border border-slate-100 p-3 text-center ${
        clickable ? 'active:bg-slate-50 active:scale-[0.98] transition-transform' : ''
      }`}
    >
      <p className="text-2xl font-bold text-brand-700">{value}</p>
      <p className="text-[11px] text-slate-500 mt-0.5">{label}</p>
      {sub != null && <p className="text-[10px] text-slate-400">{sub}</p>}
      {clickable && <p className="text-[9px] text-brand-500 mt-1 font-semibold">TAP TO VIEW</p>}
    </button>
  )
}

const PERIOD_MODES = [
  ['today', 'Today'],
  ['week', 'This Week'],
  ['month', 'This Month'],
  ['date', 'Pick a date']
]

export default function PerformancePage({ onBack, onEditOrder }) {
  const { user, profile } = useAuth()
  const { customers } = useApp()
  const [uid, setUid] = useState(null)
  const [pendingBills, setPendingBills] = useState(null)
  const [rejectedBills, setRejectedBills] = useState([])
  // Item-level approval summary for the stat card (pending/approved/rejected counts)
  const [approvalSummary, setApprovalSummary] = useState(null)
  // Realtime rejection popup — fires when Admin rejects a line while rep is on this screen
  const [rejectionPopup, setRejectionPopup] = useState(null) // { title, body } | null
  const realtimeChannelRef = useRef(null)
  const [periodMode, setPeriodMode] = useState('today') // 'today' | 'week' | 'month' | 'date'
  const [dateStr, setDateStr] = useState(() => new Date().toISOString().slice(0, 10))
  const [route, setRoute] = useState('') // '' = All routes (unchanged behaviour)
  const [dayPerf, setDayPerf] = useState(null)
  const [shortage, setShortage] = useState(null)
  const [totals, setTotals] = useState(null)
  const [error, setError] = useState(false)

  // Which drill-down modal is open, if any: 'visits' | 'orders' | 'newShops' | null
  const [openModal, setOpenModal] = useState(null)

  // Predefined route master — same source the New Customer form uses, so the
  // list stays consistent app-wide (no separate hardcoded list).
  const routes = useMemo(() => {
    const s = new Set()
    ;(customers || []).forEach((c) => c.route && s.add(c.route))
    return Array.from(s).sort()
  }, [customers])

  // Resolve the user id once, load approval data, subscribe to realtime rejections.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const id = (await currentUserId()) || user.id
      if (!cancelled) setUid(id)
      // Load this rep's bills awaiting Admin approval
      loadPendingApprovalBills({ salesRepId: id }).then((d) => { if (!cancelled) setPendingBills(d) }).catch(() => { if (!cancelled) setPendingBills([]) })
      loadRejectedBills({ salesRepId: id }).then((d) => { if (!cancelled) setRejectedBills(d) }).catch(() => { if (!cancelled) setRejectedBills([]) })
      // Item-level approval summary for the stat card
      loadMyApprovalSummary({ salesRepId: id }).then((s) => { if (!cancelled) setApprovalSummary(s) }).catch(() => {})
      try { const t = await loadMyPerformance(id); if (!cancelled) setTotals(t) } catch {}

      // Realtime: listen for price_rejection notifications addressed to this rep.
      // When Admin rejects a price-approval item from the Admin dashboard, a
      // notifyRepOfPriceRejection() call inserts a row into announcement_recipients
      // with recipient_id = this rep's uid. The realtime channel fires here, and
      // we surface a non-blocking popup so the rep knows immediately — even if they
      // are already on this screen rather than navigating in cold.
      if (realtimeChannelRef.current) {
        supabase.removeChannel(realtimeChannelRef.current)
        realtimeChannelRef.current = null
      }
      const channel = supabase
        .channel(`approval_rejection_${id}`)
        .on(
          'postgres_changes',
          {
            event: 'INSERT',
            schema: 'public',
            table: 'announcement_recipients',
            filter: `recipient_id=eq.${id}`
          },
          async (payload) => {
            // Fetch the announcement to check if it's a price_rejection
            try {
              const annId = payload.new?.announcement_id
              if (!annId) return
              const { data: ann } = await supabase
                .from('announcements')
                .select('id, title, body, notif_type')
                .eq('id', annId)
                .maybeSingle()
              if (ann && ann.notif_type === 'price_rejection') {
                setRejectionPopup({ title: ann.title || 'Price Rejected', body: ann.body || '' })
                // Refresh counts so cards update immediately
                loadPendingApprovalBills({ salesRepId: id }).then(setPendingBills).catch(() => {})
                loadRejectedBills({ salesRepId: id }).then(setRejectedBills).catch(() => {})
                loadMyApprovalSummary({ salesRepId: id }).then(setApprovalSummary).catch(() => {})
              } else if (ann && ann.notif_type === 'price_approved') {
                // Also refresh on approval notifications
                loadPendingApprovalBills({ salesRepId: id }).then(setPendingBills).catch(() => {})
                loadMyApprovalSummary({ salesRepId: id }).then(setApprovalSummary).catch(() => {})
              }
            } catch (e) { console.error('[PerformancePage] realtime ann fetch failed', e) }
          }
        )
        .subscribe()
      realtimeChannelRef.current = channel
    })()
    return () => {
      cancelled = true
      if (realtimeChannelRef.current) {
        supabase.removeChannel(realtimeChannelRef.current)
        realtimeChannelRef.current = null
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])

  // The concrete date range for the current period selection. Recomputed
  // whenever the mode or the picked date changes.
  const range = useMemo(
    () => resolvePeriodRange(periodMode, dateStr),
    [periodMode, dateStr]
  )

  // Load performance for the selected period + route. Empty route → all
  // routes (original behaviour unchanged when mode='today'/no route picked).
  useEffect(() => {
    if (!uid) return
    let active = true
    setDayPerf(null); setError(false)
    ;(async () => {
      try {
        const p = await loadPerformanceForDate(uid, dateStr, route || null, range)
        if (active) setDayPerf(p)
      } catch {
        if (active) setError(true)
      }
    })()
    return () => { active = false }
  }, [uid, dateStr, route, range])

  // Shortage summary — same identity, same period, same route as above, so it
  // always matches the numbers the rest of this screen is showing. Reuses the
  // Billing report's exact shortage definition via loadMyShortageSummary, but
  // scoped server-side to this rep. Loaded independently so a slow/failed
  // shortage fetch never blocks or breaks the existing performance cards.
  useEffect(() => {
    if (!uid) return
    let active = true
    setShortage(null)
    ;(async () => {
      try {
        const s = await loadMyShortageSummary(uid, { dateStr, route: route || null, range })
        if (active) setShortage(s)
      } catch {
        if (active) setShortage({ totalItems: 0, totalQty: 0, uniqueProducts: 0, totalLostValue: 0 })
      }
    })()
    return () => { active = false }
  }, [uid, dateStr, route, range])

  const prettyDate = new Date(`${dateStr}T00:00:00`).toLocaleDateString('en-IN', {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric'
  })
  const isToday = dateStr === new Date().toISOString().slice(0, 10)

  const periodLabel =
    periodMode === 'today' ? "Today's performance" :
    periodMode === 'week' ? 'This week' :
    periodMode === 'month' ? 'This month' :
    (isToday ? "Today's performance" : prettyDate)

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

        {/* Period selector — Today / This Week / This Month / a specific date.
            This is the SAME filter used everywhere below; no duplicate filter. */}
        <div className="rounded-2xl bg-white shadow-card border border-slate-100 p-3 mb-4">
          <label className="block text-[11px] font-semibold text-slate-400 uppercase tracking-wide mb-1.5">Period</label>
          <div className="flex gap-1.5 flex-wrap mb-2">
            {PERIOD_MODES.map(([val, label]) => (
              <button
                key={val}
                onClick={() => setPeriodMode(val)}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold ${
                  periodMode === val ? 'bg-brand-600 text-white' : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-50'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          {periodMode === 'date' && (
            <div className="flex items-center gap-2">
              <input type="date" value={dateStr} onChange={(e) => setDateStr(e.target.value)}
                className="flex-1 rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-brand-500" />
              <button onClick={() => setDateStr(new Date().toISOString().slice(0,10))}
                className={`px-3 py-2.5 rounded-xl text-sm font-semibold border ${isToday ? 'bg-brand-600 text-white border-brand-600' : 'border-slate-200 text-brand-700 hover:bg-slate-50'}`}>
                Today
              </button>
            </div>
          )}
          <p className="text-xs text-slate-500 mt-2">{periodLabel}</p>
        </div>

        {/* Route filter */}
        <div className="rounded-2xl bg-white shadow-card border border-slate-100 p-3 mb-4">
          <label className="block text-[11px] font-semibold text-slate-400 uppercase tracking-wide mb-1.5">Route</label>
          <div className="flex items-center gap-2">
            <select
              value={route}
              onChange={(e) => setRoute(e.target.value)}
              className="flex-1 rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-brand-500 bg-white"
            >
              <option value="">All routes</option>
              {routes.map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
            {route && (
              <button
                onClick={() => setRoute('')}
                className="px-3 py-2.5 rounded-xl text-sm font-semibold border border-slate-200 text-brand-700 hover:bg-slate-50"
              >
                Clear
              </button>
            )}
          </div>
          <p className="text-xs text-slate-500 mt-2">
            {route ? `Showing ${route}` : 'Showing all routes'}
          </p>
        </div>

        {error && <p className="text-center text-sm text-red-500 py-6">Could not load performance.</p>}
        {!dayPerf && !error && (
          <div className="py-10 flex justify-center"><div className="h-8 w-8 rounded-full border-4 border-brand-100 border-t-brand-600 animate-spin" /></div>
        )}

        {dayPerf && (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-2">
              <StatCard label="Orders Taken" value={dayPerf.orders} onClick={() => setOpenModal('orders')} />
              <StatCard label="Shops Visited" value={dayPerf.shops} onClick={() => setOpenModal('visits')} />
              <StatCard label="New Shops Added" value={dayPerf.newShops} onClick={() => setOpenModal('newShops')} />
              <StatCard label="Total Qty" value={dayPerf.quantity} />
            </div>
            <div className="grid grid-cols-2 gap-2 mb-4">
              <StatCard label="Order Value" value={`₹${dayPerf.orderValue.toLocaleString('en-IN')}`} />
              {/* Admin Approval Pending — shows item-level pending count.
                  Clickable whenever any approval activity exists (pending,
                  approved, or rejected items) so the rep can always review
                  and act on rejections. approvalSummary uses item-level
                  counts, not order-level, matching the spec requirement. */}
              {approvalSummary != null ? (
                <StatCard
                  label="Admin Approval Pending"
                  value={approvalSummary.pending}
                  sub={
                    approvalSummary.rejected > 0
                      ? `${approvalSummary.rejected} rejected · TAP`
                      : approvalSummary.approved > 0
                      ? `${approvalSummary.approved} approved`
                      : undefined
                  }
                  onClick={
                    (approvalSummary.pending > 0 || approvalSummary.rejected > 0 || approvalSummary.approved > 0)
                      ? () => setOpenModal('adminPending')
                      : undefined
                  }
                />
              ) : pendingBills != null ? (
                <StatCard
                  label="Admin Approval Pending"
                  value={pendingBills.length}
                  sub={rejectedBills.length > 0 ? `${rejectedBills.length} rejected` : undefined}
                  onClick={(pendingBills.length > 0 || rejectedBills.length > 0) ? () => setOpenModal('adminPending') : undefined}
                />
              ) : null}
            </div>
            <p className="text-center text-[11px] text-slate-400">
              Order Value uses the actual selling price recorded on each order. Tap a highlighted card to see the details behind it.
            </p>

            {/* Product Shortage Summary — this rep's own shortages only, for
                the SAME period + route selected above. Same data & maths as
                the Billing Team's Product Shortage report; the Billing report
                itself is untouched. */}
            <div className="mt-5">
              <div className="flex items-baseline justify-between mb-2">
                <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide">My Product Shortage</p>
                <p className="text-[11px] text-slate-400">{periodLabel}{route ? ` · ${route}` : ''}</p>
              </div>
              {shortage == null ? (
                <div className="py-6 flex justify-center"><div className="h-6 w-6 rounded-full border-4 border-brand-100 border-t-brand-600 animate-spin" /></div>
              ) : (
                <>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    <StatCard label="Shortage Items" value={shortage.totalItems} />
                    <StatCard label="Shortage Qty" value={shortage.totalQty} />
                    <StatCard label="Unique Products Short" value={shortage.uniqueProducts} />
                    <div className="rounded-2xl bg-red-50 shadow-card border border-red-200 p-3 text-center">
                      <p className="text-2xl font-bold text-red-700">₹{Math.round(shortage.totalLostValue || 0).toLocaleString('en-IN')}</p>
                      <p className="text-[11px] text-red-600 mt-0.5 font-semibold">Lost Sales Value</p>
                    </div>
                  </div>
                  <p className="text-center text-[11px] text-slate-400 mt-2">
                    Shortages recorded by the Billing Team when a product was out of stock during verification of your orders.
                  </p>
                </>
              )}
            </div>
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

        {/* PENDING BILLS — bills awaiting Admin approval before Billing */}
        {pendingBills && pendingBills.length > 0 && (
          <div className="mt-4 mx-3">
            <div className="rounded-2xl bg-amber-50 border border-amber-200 p-4">
              <p className="text-sm font-bold text-amber-800 mb-0.5">⏳ Pending Admin Approval</p>
              <p className="text-[12px] text-amber-700 mb-3">These bills have not reached Billing yet. Admin must approve them first.</p>
              <div className="space-y-2">
                {pendingBills.map(bill => (
                  <div key={bill.id} className="rounded-xl bg-white border border-amber-200 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-slate-800 truncate">{bill.shop_name}</p>
                        <p className="text-[11px] text-slate-400">{bill.order_date} · {bill.total_products} products</p>
                      </div>
                      <div className="text-right shrink-0">
                        <p className="text-sm font-bold text-slate-800">₹{Number(bill.total_value || 0).toLocaleString('en-IN')}</p>
                        <span className="text-[9px] font-bold text-amber-700 bg-amber-100 px-2 py-0.5 rounded-full uppercase">Awaiting Approval</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
        {/* REJECTED BILLS — Admin rejected, notify the rep */}
        {rejectedBills.length > 0 && (
          <div className="mt-3 mx-3">
            <div className="rounded-2xl bg-red-50 border border-red-200 p-4">
              <p className="text-sm font-bold text-red-800 mb-0.5">❌ Bill{rejectedBills.length > 1 ? 's' : ''} Rejected by Admin</p>
              <p className="text-[12px] text-red-700 mb-3">Admin rejected the following bill{rejectedBills.length > 1 ? 's' : ''}. Please review and resubmit with the correct price.</p>
              <div className="space-y-2">
                {rejectedBills.map(bill => (
                  <div key={bill.id} className="rounded-xl bg-white border border-red-200 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-slate-800 truncate">{bill.shop_name}</p>
                        <p className="text-[11px] text-slate-400">{bill.order_date} · {bill.total_products} products</p>
                      </div>
                      <div className="text-right shrink-0">
                        <p className="text-sm font-bold text-slate-800">₹{Number(bill.total_value || 0).toLocaleString('en-IN')}</p>
                        <span className="text-[9px] font-bold text-red-700 bg-red-100 px-2 py-0.5 rounded-full uppercase">Rejected</span>
                      </div>
                    </div>
                    {bill.bill_rejection_reason && (
                      <div className="mt-2 rounded-lg bg-red-50 border border-red-100 px-2.5 py-1.5">
                        <p className="text-[11px] text-red-700"><span className="font-semibold">Reason:</span> {bill.bill_rejection_reason}</p>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

      </main>

      {openModal === 'adminPending' && (
        <ApprovalDetailModal onClose={() => setOpenModal(null)} />
      )}

      {/* Realtime rejection popup — fires when Admin rejects a price while this
          rep is on the Performance page. Non-blocking; rep dismisses when ready. */}
      {rejectionPopup && (
        <div className="fixed inset-0 z-[90] bg-black/50 flex items-center justify-center px-4">
          <div className="bg-white w-full max-w-sm rounded-3xl p-5 shadow-xl">
            <p className="text-base font-bold text-red-700 mb-2">{rejectionPopup.title}</p>
            <p className="text-sm text-slate-600 whitespace-pre-line mb-4">{rejectionPopup.body}</p>
            <div className="flex gap-2">
              <button
                onClick={() => { setRejectionPopup(null); setOpenModal('adminPending') }}
                className="flex-1 rounded-xl bg-brand-600 text-white py-3 font-bold"
              >
                View Details
              </button>
              <button
                onClick={() => setRejectionPopup(null)}
                className="flex-1 rounded-xl border border-slate-200 py-3 font-semibold text-slate-600"
              >
                Dismiss
              </button>
            </div>
          </div>
        </div>
      )}
      {openModal === 'visits' && uid && (
        <VisitsListModal
          userId={uid} start={range.start} end={range.end} route={route}
          periodLabel={periodLabel} onClose={() => setOpenModal(null)}
        />
      )}
      {openModal === 'orders' && uid && (
        <OrdersListModal
          userId={uid} start={range.start} end={range.end} route={route}
          periodLabel={periodLabel} onClose={() => setOpenModal(null)}
          onEditOrder={onEditOrder ? (order) => { setOpenModal(null); onEditOrder(order) } : undefined}
        />
      )}
      {openModal === 'newShops' && uid && (
        <NewShopsListModal
          userId={uid} start={range.start} end={range.end} route={route}
          periodLabel={periodLabel} onClose={() => setOpenModal(null)}
        />
      )}
    </div>
  )
}
