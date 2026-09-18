import { useState, useEffect, useCallback, useMemo } from 'react'
import { useAuth } from '../context/AuthContext.jsx'
import AdminShell from '../components/AdminShell.jsx'
import AdminDashboard from '../pages/AdminDashboard.jsx'
import ProductAdminPage from '../pages/ProductAdminPage.jsx'
import SalespeopleAdminPage from '../pages/SalespeopleAdminPage.jsx'
import AnnouncementsAdminPage from '../pages/AnnouncementsAdminPage.jsx'
import AdminPriceApprovalReportPage from '../pages/AdminPriceApprovalReportPage.jsx'
import AdminCustomersPage from '../pages/AdminCustomersPage.jsx'
import AdminBillApprovalsPage from '../pages/AdminBillApprovalsPage.jsx'
import VerifiedOrdersPage from '../pages/VerifiedOrdersPage.jsx'
import ReportPanel from '../components/ReportPanel.jsx'
import AdminBillingView from '../pages/AdminBillingView.jsx'
import AdminQcView from '../pages/AdminQcView.jsx'
import AdminDeliveryView from '../pages/AdminDeliveryView.jsx'
import AdminApprovalsPage from '../pages/AdminApprovalsPage.jsx'
import { countPendingApprovals, loadPoSchedulesAdmin, loadVendors, updateVendor } from '../utils/cloudSync.js'
import { PRICE_APPROVAL_ENABLED } from '../utils/featureFlags.js'

/**
 * Admin experience: a persistent sidebar shell (AdminShell) wrapping whichever
 * section is active. This REPLACES the old full-page-swap admin routing in
 * App.jsx, but every underlying page/component is unchanged — this file only
 * owns navigation state and slots the right content in.
 *
 * Phase C1: wires the shell to sections that already existed (Dashboard,
 * Products, Users, Reports) plus the two admin-only utility pages that were
 * reachable from the old Dashboard (Announcements, Verified Orders). Sections
 * not yet built (Sales/Orders/Billing/QC/Delivery/Customers/Settings) show as
 * "SOON" in the sidebar — Phase C2/C3.
 */
export default function AdminApp() {
  const { profile, signOut } = useAuth()
  const [section, setSection] = useState('dashboard')

  // Shared date range for Price Approvals — drives both the sidebar badge and
  // the approvals page itself so they are always in sync. Default: last 3 IST days.
  const todayIST = useMemo(() => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }), [])
  const defaultFromIST = useMemo(() => {
    const d = new Date(todayIST); d.setDate(d.getDate() - 2); return d.toLocaleDateString('en-CA')
  }, [todayIST])
  const [approvalDateRange, setApprovalDateRange] = useState({ from: defaultFromIST, to: todayIST })

  // Live count for the sidebar badge — refreshed on mount and periodically,
  // and whenever the selected date range changes. Skipped while flag is off.
  const [approvalsCount, setApprovalsCount] = useState(0)
  useEffect(() => {
    if (!PRICE_APPROVAL_ENABLED) return
    const refresh = () => countPendingApprovals({ fromDate: approvalDateRange.from, toDate: approvalDateRange.to })
      .then(setApprovalsCount).catch(() => {})
    refresh()
    const id = setInterval(refresh, 60000)
    return () => clearInterval(id)
  }, [approvalDateRange])

  return (
    <AdminShell
      activeKey={section}
      onNavigate={setSection}
      profileName={profile?.full_name}
      onSignOut={signOut}
      badges={{ approvals: approvalsCount }}
    >
      {section === 'dashboard' && (
        <AdminDashboard
          embedded
          onOpenProducts={() => setSection('products')}
          onOpenSalespeople={() => setSection('users')}
          onOpenAnnounce={() => setSection('announce')}
          onOpenVerified={() => setSection('verified')}
        />
      )}

      {section === 'products' && (
        <ProductAdminPage onBack={() => setSection('dashboard')} />
      )}

      {section === 'users' && (
        <SalespeopleAdminPage onBack={() => setSection('dashboard')} />
      )}

      {section === 'reports' && (
        <div className="px-3 sm:px-6 pt-4 pb-10 max-w-2xl">
          <ReportPanel kind="sales" />
          <div className="mt-4">
            <ReportPanel kind="delivery" />
          </div>
        </div>
      )}
      {section === 'approval-report' && <AdminPriceApprovalReportPage />}
      {section === 'customers' && <AdminCustomersPage />}
      {section === 'bill-approvals' && <AdminBillApprovalsPage />}

      {/* Phase C2 — read-only visibility into Billing/QC/Delivery. These use
          the SAME data functions those teams' own dashboards use, so the
          numbers always match. No verify/assign/override actions are exposed
          here — that stays exclusively with each team's own login. */}
      {section === 'billing' && <AdminBillingView />}
      {section === 'qc' && <AdminQcView />}
      {section === 'delivery' && <AdminDeliveryView />}
      {section === 'approvals' && (
        <AdminApprovalsPage
          dateRange={approvalDateRange}
          onDateRangeChange={(range) => {
            setApprovalDateRange(range)
          }}
          onApprovalActioned={() => {
            // Re-count after approve/reject so the badge stays accurate
            countPendingApprovals({ fromDate: approvalDateRange.from, toDate: approvalDateRange.to })
              .then(setApprovalsCount).catch(() => {})
          }}
        />
      )}

      {section === 'purchase-orders' && <AdminPurchaseOrdersView />}

      {/* Reachable via the Dashboard's existing shortcuts, not their own nav
          item yet — kept exactly as the old routing worked. */}
      {section === 'announce' && (
        <AnnouncementsAdminPage onBack={() => setSection('dashboard')} />
      )}
      {section === 'verified' && (
        <VerifiedOrdersPage onBack={() => setSection('dashboard')} />
      )}
    </AdminShell>
  )
}

// ─── Admin Purchase Orders Monitoring View ────────────────────────────────────

const PO_STATUS_COLOR = {
  UPCOMING:    'text-slate-500',
  DUE:         'text-amber-700 font-semibold',
  NOTIFIED:    'text-blue-700',
  IN_PROGRESS: 'text-indigo-700',
  PO_GENERATED:'text-emerald-700 font-semibold',
  IGNORED:     'text-orange-700 font-semibold',
  ESCALATED:   'text-red-700 font-bold',
  RESCHEDULED: 'text-purple-700',
  COMPLETED:   'text-green-700',
}
const PO_STATUS_LABEL = {
  UPCOMING:'Upcoming', DUE:'Due Today', NOTIFIED:'Notified', IN_PROGRESS:'In Progress',
  PO_GENERATED:'PO Generated', IGNORED:'Ignored', ESCALATED:'🚨 ESCALATED',
  RESCHEDULED:'Rescheduled', COMPLETED:'Completed',
}

function AdminPurchaseOrdersView() {
  const [schedules, setSchedules] = useState([])
  const [vendors, setVendors] = useState([])
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState('')
  const [editVendor, setEditVendor] = useState(null)
  const [toast, setToast] = useState('')

  const flash = (m) => { setToast(m); setTimeout(() => setToast(''), 3000) }

  const refresh = useCallback(async () => {
    setLoading(true)
    const [sched, vend] = await Promise.all([
      loadPoSchedulesAdmin({ status: statusFilter || undefined }),
      loadVendors()
    ])
    setSchedules(sched)
    setVendors(vend)
    setLoading(false)
  }, [statusFilter])

  useEffect(() => { refresh() }, [refresh])

  const escalatedCount = schedules.filter((s) => s.status === 'ESCALATED').length
  const ignoredCount   = schedules.filter((s) => s.status === 'IGNORED').length
  const dueCount       = schedules.filter((s) => ['DUE','NOTIFIED'].includes(s.status)).length

  return (
    <div className="px-4 sm:px-6 pt-4 pb-10 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-lg font-bold text-slate-800">Purchase Order Monitoring</h2>
          <p className="text-xs text-slate-400 mt-0.5">Live view of all vendor PO schedules</p>
        </div>
        <button onClick={refresh} className="text-sm font-semibold text-brand-700 px-3 py-1.5 rounded-lg border border-slate-200 hover:bg-slate-50">
          Refresh
        </button>
      </div>

      {/* Alert banner for escalations */}
      {escalatedCount > 0 && (
        <div className="mb-4 bg-red-50 border border-red-300 rounded-2xl px-4 py-3 flex items-center gap-3">
          <span className="text-2xl">🚨</span>
          <div>
            <p className="text-sm font-bold text-red-700">{escalatedCount} vendor{escalatedCount > 1 ? 's' : ''} escalated — PM ignored for 24+ hours</p>
            <p className="text-xs text-red-500">Contact Purchase Manager immediately.</p>
          </div>
        </div>
      )}

      {/* Summary row */}
      <div className="grid grid-cols-4 gap-3 mb-5">
        {[
          { label: 'Escalated', value: escalatedCount, color: 'text-red-700', bg: 'bg-red-50', filter: 'ESCALATED' },
          { label: 'Ignored',   value: ignoredCount,   color: 'text-orange-700', bg: 'bg-orange-50', filter: 'IGNORED' },
          { label: 'Due Today', value: dueCount,        color: 'text-amber-700', bg: 'bg-amber-50', filter: 'DUE' },
          { label: 'Total POs', value: schedules.length, color: 'text-slate-700', bg: 'bg-slate-50', filter: '' },
        ].map((t) => (
          <button key={t.label} onClick={() => setStatusFilter(t.filter)}
            className={`${t.bg} rounded-2xl p-3 text-center border ${statusFilter === t.filter ? 'ring-2 ring-brand-500 border-transparent' : 'border-transparent'}`}>
            <p className={`text-2xl font-bold ${t.color}`}>{t.value}</p>
            <p className={`text-[10px] font-semibold mt-0.5 ${t.color}`}>{t.label}</p>
          </button>
        ))}
      </div>

      {/* Status filter chips */}
      <div className="flex gap-1.5 flex-wrap mb-4">
        {[['','All'], ['ESCALATED','Escalated'], ['IGNORED','Ignored'], ['DUE','Due'], ['NOTIFIED','Notified'],
          ['IN_PROGRESS','In Progress'], ['PO_GENERATED','Generated'], ['UPCOMING','Upcoming']].map(([v,l]) => (
          <button key={v} onClick={() => setStatusFilter(v)}
            className={`px-3 py-1 rounded-full text-xs font-semibold border transition ${statusFilter===v ? 'bg-brand-600 text-white border-brand-600' : 'text-slate-600 border-slate-200 hover:bg-slate-50'}`}>
            {l}
          </button>
        ))}
      </div>

      {/* Table */}
      {loading ? (
        <p className="text-center text-slate-400 text-sm py-12">Loading…</p>
      ) : (
        <div className="bg-white rounded-2xl border border-slate-100 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50">
                <th className="text-left px-4 py-2.5 text-xs font-semibold text-slate-500">Vendor</th>
                <th className="text-left px-3 py-2.5 text-xs font-semibold text-slate-500">Brand</th>
                <th className="text-left px-3 py-2.5 text-xs font-semibold text-slate-500">Effective Date</th>
                <th className="text-left px-3 py-2.5 text-xs font-semibold text-slate-500">Status</th>
                <th className="text-left px-3 py-2.5 text-xs font-semibold text-slate-500">Notified</th>
                <th className="text-left px-3 py-2.5 text-xs font-semibold text-slate-500">PO At</th>
                <th className="text-left px-3 py-2.5 text-xs font-semibold text-slate-500">Notes</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {schedules.length === 0 && (
                <tr><td colSpan={7} className="text-center text-slate-400 py-12 text-sm">No schedules found.</td></tr>
              )}
              {schedules.map((s) => (
                <tr key={s.id} className={`${s.status === 'ESCALATED' ? 'bg-red-50' : s.status === 'IGNORED' ? 'bg-orange-50/40' : ''}`}>
                  <td className="px-4 py-2.5 font-medium text-slate-800 text-xs leading-tight max-w-[180px] truncate">
                    {s.vendors?.vendor_name || '—'}
                    {s.vendors?.po_gap_days == null && <span className="ml-1 text-orange-500 text-[9px]">⚠️</span>}
                  </td>
                  <td className="px-3 py-2.5 text-xs text-slate-500">{s.vendors?.brand || '—'}</td>
                  <td className="px-3 py-2.5 text-xs text-slate-600 whitespace-nowrap">{s.effective_date || '—'}</td>
                  <td className={`px-3 py-2.5 text-xs whitespace-nowrap ${PO_STATUS_COLOR[s.status] || 'text-slate-500'}`}>
                    {PO_STATUS_LABEL[s.status] || s.status}
                  </td>
                  <td className="px-3 py-2.5 text-xs text-slate-400 whitespace-nowrap">
                    {s.notified_at ? new Date(s.notified_at).toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit' }) : '—'}
                  </td>
                  <td className="px-3 py-2.5 text-xs text-slate-400 whitespace-nowrap">
                    {s.po_generated_at ? new Date(s.po_generated_at).toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit' }) : '—'}
                  </td>
                  <td className="px-3 py-2.5 text-xs text-slate-400 max-w-[120px] truncate">{s.notes || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Vendor Config Section */}
      <div className="mt-8">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-bold text-slate-700">Vendor Configuration</h3>
          <span className="text-xs text-slate-400">{vendors.filter(v => v.config_incomplete).length} unconfigured</span>
        </div>
        <div className="bg-white rounded-2xl border border-slate-100 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50">
                <th className="text-left px-4 py-2 text-xs font-semibold text-slate-500">Vendor</th>
                <th className="text-left px-3 py-2 text-xs font-semibold text-slate-500">Brand</th>
                <th className="text-left px-3 py-2 text-xs font-semibold text-slate-500">PO Gap (days)</th>
                <th className="text-left px-3 py-2 text-xs font-semibold text-slate-500">Weekly Days</th>
                <th className="text-left px-3 py-2 text-xs font-semibold text-slate-500">Lead Time</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {vendors.map((v) => (
                <tr key={v.id} className={v.config_incomplete ? 'bg-orange-50/40' : ''}>
                  <td className="px-4 py-2 text-xs font-medium text-slate-800 max-w-[200px] truncate">
                    {v.vendor_name}
                    {v.config_incomplete && <span className="ml-1 text-orange-600 font-bold">⚠️</span>}
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-500">{v.brand || '—'}</td>
                  <td className="px-3 py-2 text-xs text-slate-600">{v.po_gap_days ?? <span className="text-orange-600 font-semibold">Not set</span>}</td>
                  <td className="px-3 py-2 text-xs text-slate-500">{v.weekly_days || '—'}</td>
                  <td className="px-3 py-2 text-xs text-slate-500">{v.lead_time_days || '—'}</td>
                  <td className="px-3 py-2 text-right">
                    <button
                      onClick={() => setEditVendor(v)}
                      className="text-[11px] font-semibold text-brand-700 px-2 py-1 rounded-lg hover:bg-brand-50"
                    >
                      Edit
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Edit Vendor Modal */}
      {editVendor && (
        <EditVendorModal
          vendor={editVendor}
          onSave={async (patch) => {
            await updateVendor(editVendor.id, patch)
            flash('Vendor updated ✅')
            setEditVendor(null)
            await refresh()
          }}
          onClose={() => setEditVendor(null)}
        />
      )}

      {toast && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 bg-slate-900 text-white text-sm font-semibold px-4 py-2.5 rounded-xl shadow-lg">
          {toast}
        </div>
      )}
    </div>
  )
}

function EditVendorModal({ vendor, onSave, onClose }) {
  const [poGap, setPoGap] = useState(vendor.po_gap_days?.toString() || '')
  const [weeklyDays, setWeeklyDays] = useState(vendor.weekly_days || '')
  const [leadTime, setLeadTime] = useState(vendor.lead_time_days || '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  async function save() {
    const gap = poGap.trim() ? parseInt(poGap.trim(), 10) : null
    if (poGap.trim() && (isNaN(gap) || gap <= 0)) { setErr('PO Gap must be a positive number'); return }
    setBusy(true)
    try {
      await onSave({
        po_gap_days:    gap,
        weekly_days:    weeklyDays.trim() || null,
        lead_time_days: leadTime.trim() || null
      })
    } catch (e) {
      setErr(e?.message || 'Save failed')
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[80] bg-black/40 flex items-end sm:items-center justify-center">
      <div className="bg-white w-full sm:max-w-sm rounded-t-3xl sm:rounded-3xl p-5">
        <h3 className="font-bold text-slate-800 mb-0.5">Edit Vendor Config</h3>
        <p className="text-xs text-slate-400 mb-4 truncate">{vendor.vendor_name}</p>

        <label className="block text-xs font-semibold text-slate-600 mb-1">PO Gap (days)</label>
        <input
          type="number"
          value={poGap}
          onChange={(e) => setPoGap(e.target.value)}
          placeholder="e.g. 14"
          className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-brand-500 mb-3"
        />

        <label className="block text-xs font-semibold text-slate-600 mb-1">Weekly Days (optional, comma-separated)</label>
        <input
          type="text"
          value={weeklyDays}
          onChange={(e) => setWeeklyDays(e.target.value)}
          placeholder="e.g. MONDAY,THURSDAY"
          className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-brand-500 mb-3"
        />

        <label className="block text-xs font-semibold text-slate-600 mb-1">Lead Time</label>
        <input
          type="text"
          value={leadTime}
          onChange={(e) => setLeadTime(e.target.value)}
          placeholder="e.g. 7-10"
          className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-brand-500 mb-4"
        />

        {err && <p className="text-xs text-red-600 mb-3">{err}</p>}

        <button
          onClick={save}
          disabled={busy}
          className="w-full rounded-xl bg-brand-600 text-white py-3 font-bold mb-2 active:bg-brand-700 disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save Changes'}
        </button>
        <button onClick={onClose} className="w-full rounded-xl border border-slate-200 text-slate-600 py-2.5 font-semibold text-sm">
          Cancel
        </button>
      </div>
    </div>
  )
}
