import { useEffect, useState, useMemo } from 'react'
import { useAuth } from '../context/AuthContext.jsx'
import {
  loadQcDeliveries, loadQcCounts, loadQcItemsWithState, saveQcItemState,
  markQcInProgress, qcVerifyGroup, PACKING_STAFF, QC_ERROR_TYPES, updateMyName,
  loadQcDeliveryById
} from '../utils/cloudSync.js'
import { enablePush, pushStatus, pushSupported } from '../utils/push.js'
import appIcon from '../assets/app_icon.png'

const CHECKLIST = [
  { key: 'product', label: 'Product Checked' },
  { key: 'quantity', label: 'Quantity Checked' },
  { key: 'packaging', label: 'Packaging Checked' },
  { key: 'damage', label: 'Damage Checked' },
  { key: 'expiry', label: 'Expiry Checked' },
  { key: 'batch', label: 'Batch Checked (if applicable)' }
]
const REQUIRED = ['product', 'quantity', 'packaging', 'damage', 'expiry']

const QC_TABS = [
  ['qc_pending', '🟡 Pending'],
  ['in_progress', '🔵 In Progress'],
  ['qc_verified', '🟢 Verified'],
  ['qc_returned', '🔴 Returned']
]

export default function QcDashboard() {
  const { profile, signOut, refreshProfile } = useAuth()
  const [tab, setTab] = useState('qc_pending')
  const [qcDate, setQcDate] = useState('') // '' = all dates (unchanged default)
  const [counts, setCounts] = useState({ pending: 0, inProgress: 0, verifiedToday: 0, returned: 0 })
  const [list, setList] = useState(null)
  const [error, setError] = useState(false)
  const [open, setOpenRaw] = useState(() => {
    // Restore the order the QC user was working on (survives tab switch/reload).
    try { return JSON.parse(sessionStorage.getItem('qc_open_delivery') || 'null') } catch { return null }
  })
  const setOpen = (d) => {
    setOpenRaw(d)
    try {
      if (d) sessionStorage.setItem('qc_open_delivery', JSON.stringify(d))
      else sessionStorage.removeItem('qc_open_delivery')
    } catch {}
  }

  // First-login name prompt: if the QC user's name is empty or still the
  // default email-based placeholder (e.g. "qc1"), ask them to enter it.
  const needsName = (() => {
    const n = (profile?.full_name || '').trim().toLowerCase()
    return !n || /^qc\d*$/.test(n)
  })()
  const [showNamePrompt, setShowNamePrompt] = useState(false)
  useEffect(() => { if (needsName) setShowNamePrompt(true) }, [needsName])

  // --- Push notifications: show an enable banner until subscribed/denied. ----
  const [push, setPush] = useState({ supported: pushSupported(), permission: 'default', subscribed: false })
  const [pushBusy, setPushBusy] = useState(false)
  useEffect(() => {
    let active = true
    pushStatus().then((s) => { if (active) setPush(s) }).catch(() => {})
    return () => { active = false }
  }, [])
  const onEnablePush = async () => {
    setPushBusy(true)
    try {
      const res = await enablePush('qc_team')
      const s = await pushStatus()
      setPush(s)
      if (!res.ok && res.reason === 'denied') {
        alert('Notifications are blocked for this site. Enable them in your browser settings to receive QC alerts.')
      } else if (!res.ok && res.reason === 'unsupported') {
        alert('This browser does not support notifications. On iPhone, add the app to your Home Screen first, then open it from there.')
      } else if (!res.ok) {
        alert('Could not enable notifications.\n\nReason: ' + (res.reason || 'unknown') + (res.detail ? ('\n' + res.detail) : ''))
      }
    } catch (e) {
      console.error(e)
      alert('Could not enable notifications on this device.\n' + ((e && e.message) ? e.message : String(e)))
    } finally {
      setPushBusy(false)
    }
  }

  // --- Deep-link: open a specific delivery from a push notification. ----------
  // Handles BOTH the ?qc_delivery= URL param (cold open) and the SW postMessage
  // (app already open). Defined here so both paths reuse it.
  const openDeliveryById = async (id) => {
    if (!id) return
    try {
      const d = await loadQcDeliveryById(id)
      if (d) setOpen(d)
    } catch (e) { console.error('deep-link open failed', e) }
  }
  useEffect(() => {
    // Cold-open deep link.
    try {
      const params = new URLSearchParams(window.location.search)
      const id = params.get('qc_delivery')
      if (id) {
        openDeliveryById(id)
        // Clean the URL so a refresh doesn't reopen it.
        const url = new URL(window.location.href)
        url.searchParams.delete('qc_delivery')
        window.history.replaceState({}, '', url.toString())
      }
    } catch {}
    // Live deep link while app is open.
    const onMsg = (event) => {
      const msg = event.data
      if (msg && msg.type === 'qc_open' && msg.data && msg.data.delivery_id) {
        openDeliveryById(msg.data.delivery_id)
      }
    }
    if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message', onMsg)
    return () => {
      if ('serviceWorker' in navigator) navigator.serviceWorker.removeEventListener('message', onMsg)
    }
    // eslint-disable-next-line
  }, [])

  const refresh = async (showSpinner = true) => {
    setError(false)
    if (showSpinner) setList(null)
    try {
      const [items, c] = await Promise.all([loadQcDeliveries(tab, qcDate || null), loadQcCounts()])
      setList(items); setCounts(c)
    } catch (e) { console.error(e); if (showSpinner) setError(true) }
  }
  useEffect(() => {
    refresh(true)
    const iv = setInterval(() => refresh(false), 20000)
    const onFocus = () => refresh(false)
    window.addEventListener('focus', onFocus)
    return () => { clearInterval(iv); window.removeEventListener('focus', onFocus) }
    // eslint-disable-next-line
  }, [tab, qcDate])

  if (open) {
    return <QcDetail delivery={open} qcUser={profile}
      onBack={() => { setOpen(null); refresh(true) }}
      onDone={() => { setOpen(null); refresh(true) }} />
  }

  return (
    <div className="min-h-screen bg-slate-50 pb-10">
      <header className="sticky top-0 z-20 bg-white border-b border-slate-200">
        <div className="mx-auto max-w-4xl px-3 sm:px-6 py-2.5 flex items-center gap-2">
          <img src={appIcon} alt="" className="h-9 w-9 rounded-lg" />
          <div className="min-w-0 flex-1">
            <h1 className="text-base font-bold text-slate-800">Quality Control</h1>
            <button onClick={() => setShowNamePrompt(true)} className="text-[11px] text-slate-400 hover:text-brand-600">
              {profile?.full_name && !needsName ? profile.full_name : 'Set your name'} ✎
            </button>
          </div>
          <button onClick={() => refresh(true)} className="text-sm font-semibold text-brand-700 px-3 py-1.5 rounded-lg border border-slate-200 hover:bg-slate-50">Refresh</button>
          <button onClick={signOut} className="text-sm font-semibold text-red-600 px-2">Sign Out</button>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-3 sm:px-6 pt-4">
        {/* Enable push notifications banner (until subscribed or denied). */}
        {push.supported && !push.subscribed && push.permission !== 'denied' && (
          <div className="mb-4 rounded-2xl bg-blue-50 border border-blue-200 p-3 flex items-center gap-3">
            <div className="text-2xl">🔔</div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-blue-900">Turn on QC alerts</p>
              <p className="text-[12px] text-blue-700">Get notified the moment Billing verifies a bill — even when the app is closed.</p>
            </div>
            <button onClick={onEnablePush} disabled={pushBusy}
              className="shrink-0 rounded-xl bg-blue-600 text-white text-sm font-bold px-3 py-2 active:bg-blue-700 disabled:bg-blue-300">
              {pushBusy ? '…' : 'Enable'}
            </button>
          </div>
        )}
        {push.supported && push.permission === 'denied' && (
          <div className="mb-4 rounded-2xl bg-amber-50 border border-amber-200 p-3">
            <p className="text-[12px] text-amber-800">
              Notifications are blocked for this site. To receive QC alerts, enable notifications for this app in your browser settings.
            </p>
          </div>
        )}

        <div className="grid grid-cols-4 gap-2 mb-4">
          <Stat label="Pending" value={counts.pending} color="text-amber-600" />
          <Stat label="In Progress" value={counts.inProgress} color="text-blue-600" />
          <Stat label="Verified Today" value={counts.verifiedToday} color="text-green-600" />
          <Stat label="Returned" value={counts.returned} color="text-red-600" />
        </div>

        <div className="flex gap-1.5 mb-3 flex-wrap">
          {QC_TABS.map(([val, label]) => (
            <button key={val} onClick={() => setTab(val)}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold ${tab===val ? 'bg-brand-600 text-white' : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-50'}`}>
              {label}
            </button>
          ))}
        </div>

        {/* Date filter */}
        <div className="flex items-center gap-2 mb-3 flex-wrap">
          <input
            type="date"
            value={qcDate}
            onChange={(e) => setQcDate(e.target.value)}
            className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm outline-none focus:border-brand-500 bg-white"
          />
          <button
            onClick={() => setQcDate(new Date().toISOString().slice(0, 10))}
            className="px-3 py-1.5 rounded-lg text-xs font-bold bg-white border border-slate-200 text-slate-600 hover:bg-slate-50">
            Today
          </button>
          {qcDate && (
            <button
              onClick={() => setQcDate('')}
              className="px-3 py-1.5 rounded-lg text-xs font-bold text-brand-700 border border-slate-200 hover:bg-slate-50">
              Clear
            </button>
          )}
          <span className="text-xs text-slate-400">
            {qcDate ? `Showing ${qcDate}${tab === 'qc_verified' ? ' (verified)' : ''}` : 'Showing all dates'}
          </span>
        </div>

        {error && <p className="text-center text-sm text-red-500 py-6">Could not load.</p>}
        {!list && !error && (<div className="py-10 flex justify-center"><div className="h-7 w-7 rounded-full border-4 border-brand-100 border-t-brand-600 animate-spin" /></div>)}
        {list && list.length === 0 && (<p className="text-center text-sm text-slate-400 py-10">Nothing here.</p>)}
        {list && (
          <div className="space-y-2 lg:space-y-0 lg:grid lg:grid-cols-2 lg:gap-2">
            {list.map((d) => (
              <button key={d.id} onClick={() => setOpen(d)}
                className="w-full text-left rounded-2xl bg-white shadow-card border border-slate-100 p-3.5 hover:bg-slate-50">
                <div className="flex items-center justify-between gap-2">
                  <p className="font-semibold text-slate-800 truncate">{d.shop_name}</p>
                  <QcBadge status={d.qc_status} />
                </div>
                <p className="text-[11px] text-slate-400 truncate mt-0.5">{d.route || 'No route'} · {d.sales_rep_name || ''}</p>
                <p className="text-[10px] text-slate-400 mt-0.5">Billing: {fmtTime(d.created_at)}</p>
                {d.packed_by && <p className="text-[11px] text-slate-500 mt-0.5">Packed by: <b>{d.packed_by}</b></p>}
              </button>
            ))}
          </div>
        )}
      </main>

      {showNamePrompt && (
        <NamePrompt
          current={needsName ? '' : (profile?.full_name || '')}
          mandatory={needsName}
          onClose={() => { if (!needsName) setShowNamePrompt(false) }}
          onSaved={async (name) => {
            await updateMyName(name)
            await refreshProfile()
            setShowNamePrompt(false)
          }}
        />
      )}
    </div>
  )
}

function NamePrompt({ current, mandatory, onClose, onSaved }) {
  const [name, setName] = useState(current || '')
  const [busy, setBusy] = useState(false)
  const save = async () => {
    if (!name.trim()) { alert('Please enter your name.'); return }
    setBusy(true)
    try { await onSaved(name.trim()) }
    catch (e) { console.error(e); alert('Could not save. Try again.'); setBusy(false) }
  }
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white w-full max-w-sm rounded-2xl p-5">
        <h3 className="font-bold text-slate-800 text-lg mb-1">{mandatory ? 'Welcome! What\u2019s your name?' : 'Edit your name'}</h3>
        <p className="text-sm text-slate-500 mb-3">
          {mandatory
            ? 'Enter your name so your QC work is tracked correctly in reports.'
            : 'Update the name shown on your QC activity.'}
        </p>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" autoFocus
          onKeyDown={(e) => e.key === 'Enter' && save()}
          className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-brand-500 mb-4" />
        <div className="flex gap-2">
          {!mandatory && (
            <button onClick={onClose} className="flex-1 rounded-xl border border-slate-200 py-2.5 font-semibold text-slate-600">Cancel</button>
          )}
          <button onClick={save} disabled={busy} className="flex-1 rounded-xl bg-brand-600 text-white py-2.5 font-bold disabled:bg-slate-300">
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

function Stat({ label, value, color }) {
  return (
    <div className="rounded-2xl bg-white shadow-card border border-slate-100 p-3 text-center">
      <p className={`text-xl font-bold ${color}`}>{value}</p>
      <p className="text-[10px] text-slate-500 mt-0.5">{label}</p>
    </div>
  )
}

function QcBadge({ status }) {
  const map = {
    qc_pending: ['🟡 Pending', 'bg-amber-50 text-amber-700'],
    in_progress: ['🔵 In Progress', 'bg-blue-50 text-blue-700'],
    qc_verified: ['🟢 Verified', 'bg-green-50 text-green-700'],
    qc_returned: ['🔴 Returned', 'bg-red-50 text-red-700']
  }
  const [text, cls] = map[status] || ['', '']
  return <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full shrink-0 ${cls}`}>{text}</span>
}

function fmtTime(iso) {
  return iso ? new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true }) : ''
}

// --- QC detail: per-product verification, auto-save, resume -----------------
function QcDetail({ delivery, qcUser, onBack, onDone }) {
  const [items, setItems] = useState(null)
  const [packedBy, setPackedBy] = useState(delivery.packed_by || '')
  const [checks, setChecks] = useState({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const [errorModal, setErrorModal] = useState(null) // item being error-reported
  const isVerified = delivery.qc_status === 'qc_verified'

  useEffect(() => {
    (async () => {
      try { setItems(await loadQcItemsWithState(delivery)) }
      catch (e) { console.error(e); setError(true) }
    })()
  }, [delivery])

  // Progress: a product is "processed" when verified OR an error was reported.
  const processed = useMemo(() => (items || []).filter((i) => i.qc_state === 'verified' || i.qc_state === 'error').length, [items])
  const total = items?.length || 0
  const pct = total ? Math.round((processed / total) * 100) : 0
  const allProcessed = total > 0 && processed === total

  const allRequiredChecked = REQUIRED.every((k) => checks[k])
  const canVerify = !!packedBy && allProcessed && allRequiredChecked && !isVerified

  // Update one item locally + auto-save to DB, and mark delivery in-progress.
  const patchItem = async (item, patch) => {
    setItems((cur) => cur.map((x) => x.id === item.id ? { ...x, ...patch } : x))
    try {
      await saveQcItemState(item.id, { ...patch, qc_packed_by: packedBy || item.qc_packed_by || null })
      await markQcInProgress(delivery)
    } catch (e) { console.error('auto-save failed', e) }
  }

  const verifyProduct = (item) => patchItem(item, { qc_state: 'verified', qc_error_type: null })
  const unverifyProduct = (item) => patchItem(item, { qc_state: 'pending' })

  const doVerify = async () => {
    if (!canVerify) return
    setBusy(true)
    try { await qcVerifyGroup(delivery, packedBy, checks); onDone() }
    catch (e) { console.error(e); alert('Could not verify. Try again.'); setBusy(false) }
  }

  return (
    <div className="min-h-screen bg-slate-50 pb-10">
      <header className="sticky top-0 z-20 bg-white border-b border-slate-200">
        <div className="mx-auto max-w-2xl px-3 sm:px-6 py-2.5 flex items-center gap-2">
          <button onClick={onBack} className="h-10 w-10 rounded-full flex items-center justify-center text-slate-600 hover:bg-slate-100 text-xl">‹</button>
          <div className="min-w-0 flex-1">
            <h1 className="text-base font-bold text-slate-800 truncate">{delivery.shop_name}</h1>
            <p className="text-[11px] text-slate-400 truncate">{delivery.route || 'No route'} · {delivery.sales_rep_name || ''}</p>
          </div>
          <QcBadge status={isVerified ? 'qc_verified' : (processed > 0 ? 'in_progress' : 'qc_pending')} />
        </div>
        {/* Progress bar */}
        {total > 0 && (
          <div className="mx-auto max-w-2xl px-3 sm:px-6 pb-2">
            <div className="flex items-center justify-between text-[11px] text-slate-500 mb-1">
              <span>Verified Products: {processed} / {total}</span>
              <span className="font-semibold">{pct}% Completed</span>
            </div>
            <div className="h-2 rounded-full bg-slate-100 overflow-hidden">
              <div className="h-full bg-brand-500 transition-all" style={{ width: `${pct}%` }} />
            </div>
          </div>
        )}
      </header>

      <main className="mx-auto max-w-2xl px-3 sm:px-6 pt-4">
        {/* Packed By */}
        <div className="rounded-2xl bg-white shadow-card border border-slate-100 p-3 mb-3">
          <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wide mb-1.5">Packed By *</label>
          <select value={packedBy} onChange={(e) => setPackedBy(e.target.value)} disabled={isVerified}
            className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-brand-500 bg-white">
            <option value="">Select packing staff…</option>
            {PACKING_STAFF.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>

        <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Products</p>
        {error && <p className="text-center text-sm text-red-500 py-4">Could not load items.</p>}
        {!items && !error && (<div className="py-8 flex justify-center"><div className="h-6 w-6 rounded-full border-4 border-brand-100 border-t-brand-600 animate-spin" /></div>)}
        {items && (
          <div className="space-y-2 mb-4">
            {items.map((it) => (
              <div key={it.id} className={`rounded-xl bg-white border p-3 ${it.qc_state === 'verified' ? 'border-green-200' : it.qc_state === 'error' ? 'border-amber-200' : 'border-slate-100'}`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-slate-800">{it.product_name}</p>
                    <div className="mt-1 inline-flex items-center gap-1.5 rounded-lg bg-brand-50 border border-brand-200 px-2.5 py-1">
                      <span className="text-[10px] font-semibold text-brand-600 uppercase">Qty</span>
                      <span className="text-base font-extrabold text-brand-800">{it.ordered_qty}</span>
                      <span className="text-xs font-semibold text-brand-600">{it.unit}</span>
                    </div>
                    {it.qc_state === 'error' && (
                      <p className="text-[11px] text-amber-600 mt-0.5">⚠ {it.qc_error_type}{it.qc_remarks ? ` — ${it.qc_remarks}` : ''}</p>
                    )}
                  </div>
                  <StateChip state={it.qc_state} />
                </div>
                {!isVerified && (
                  <div className="flex gap-2 mt-2.5">
                    {it.qc_state === 'verified' ? (
                      <button onClick={() => unverifyProduct(it)}
                        className="text-xs font-semibold text-slate-500 border border-slate-200 rounded-lg px-2.5 py-1 hover:bg-slate-50">Undo</button>
                    ) : (
                      <button onClick={() => verifyProduct(it)}
                        className="text-xs font-semibold text-green-700 border border-green-200 rounded-lg px-2.5 py-1 hover:bg-green-50">✓ Verify</button>
                    )}
                    <button onClick={() => setErrorModal(it)}
                      className="text-xs font-semibold text-amber-700 border border-amber-200 rounded-lg px-2.5 py-1 hover:bg-amber-50">⚠ Report Error</button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Checklist + verify */}
        {!isVerified && (
          <>
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">QC Checklist</p>
            <div className="rounded-2xl bg-white shadow-card border border-slate-100 p-2 mb-4">
              {CHECKLIST.map((c) => (
                <label key={c.key} className="flex items-center gap-3 px-2 py-2.5 cursor-pointer">
                  <input type="checkbox" checked={!!checks[c.key]}
                    onChange={(e) => setChecks((cur) => ({ ...cur, [c.key]: e.target.checked }))}
                    className="h-5 w-5 accent-brand-600" />
                  <span className="text-sm text-slate-700">{c.label}</span>
                  {REQUIRED.includes(c.key) && <span className="text-[10px] text-red-400 ml-auto">required</span>}
                </label>
              ))}
            </div>

            <button onClick={doVerify} disabled={!canVerify || busy}
              className="w-full rounded-2xl bg-brand-600 text-white py-3.5 font-bold hover:bg-brand-700 disabled:bg-slate-300">
              {busy ? 'Verifying…' : '✓ QC Verify — Ready for Delivery'}
            </button>
            {!canVerify && !busy && (
              <p className="text-center text-[11px] text-slate-400 mt-2">
                {!allProcessed ? `${total - processed} product(s) still pending` : !packedBy ? 'Select who packed this order' : 'Complete all required checks'} to verify.
              </p>
            )}
          </>
        )}
        {isVerified && (
          <div className="rounded-2xl bg-green-50 border border-green-200 text-green-700 py-3 font-bold text-center">
            ✓ QC Verified — Ready for Delivery{delivery.packed_by ? ` · Packed by ${delivery.packed_by}` : ''}
          </div>
        )}
      </main>

      {errorModal && (
        <ErrorModal item={errorModal} onClose={() => setErrorModal(null)}
          onSave={async (errType, remarks) => {
            await patchItem(errorModal, { qc_state: 'error', qc_error_type: errType, qc_remarks: remarks })
            setErrorModal(null)
          }} />
      )}
    </div>
  )
}

function StateChip({ state }) {
  if (state === 'verified') return <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-green-50 text-green-700 shrink-0">✓ Verified</span>
  if (state === 'error') return <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 shrink-0">⚠ Error</span>
  return <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 shrink-0">⏳ Pending</span>
}

function ErrorModal({ item, onClose, onSave }) {
  const [errType, setErrType] = useState(item.qc_error_type || '')
  const [remarks, setRemarks] = useState(item.qc_remarks || '')
  const [busy, setBusy] = useState(false)
  const save = async () => {
    if (!errType) { alert('Select an error type.'); return }
    setBusy(true)
    try { await onSave(errType, remarks.trim()) }
    catch (e) { console.error(e); alert('Could not save.'); setBusy(false) }
  }
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 p-0 sm:p-4" onClick={onClose}>
      <div className="bg-white w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl p-4 max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <h3 className="font-bold text-slate-800 mb-1">Report Error</h3>
        <p className="text-sm text-slate-500 mb-3">{item.product_name}</p>
        <label className="block text-xs font-semibold text-slate-400 mb-1">Error Type</label>
        <select value={errType} onChange={(e) => setErrType(e.target.value)}
          className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-brand-500 bg-white mb-3">
          <option value="">Select…</option>
          {QC_ERROR_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <label className="block text-xs font-semibold text-slate-400 mb-1">Remarks</label>
        <textarea value={remarks} onChange={(e) => setRemarks(e.target.value)} rows={3}
          className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-brand-500 mb-4" placeholder="Optional details…" />
        <div className="flex gap-2">
          <button onClick={onClose} className="flex-1 rounded-xl border border-slate-200 py-2.5 font-semibold text-slate-600">Cancel</button>
          <button onClick={save} disabled={busy} className="flex-1 rounded-xl bg-amber-500 text-white py-2.5 font-bold disabled:bg-slate-300">
            {busy ? 'Saving…' : 'Save Error'}
          </button>
        </div>
      </div>
    </div>
  )
}
