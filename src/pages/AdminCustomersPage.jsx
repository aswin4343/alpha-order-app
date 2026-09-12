import { useState, useEffect, useCallback } from 'react'
import { loadAdminCustomers, updateCustomerName, updateCustomerCloudFields, deactivateCustomer, reactivateCustomer } from '../utils/cloudSync.js'
import { CREDIT_DAYS_OPTIONS } from '../components/NewCustomerModal.jsx'

const inputCls = 'w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-brand-500 bg-white'

function EditModal({ customer, categories, onClose, onSaved }) {
  const [f, setF] = useState({
    name: customer.name || '',
    category: customer.category || '',
    route: customer.route || ''
  })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const set = (k) => (e) => setF(p => ({ ...p, [k]: e.target.value }))

  const save = async () => {
    if (!f.name.trim()) { setErr('Name is required.'); return }
    setBusy(true); setErr('')
    try {
      if (f.name.trim() !== customer.name) await updateCustomerName(customer.id, f.name.trim())
      if (f.category !== customer.category) await updateCustomerCloudFields(customer.id, { category: f.category })
      onSaved({ ...customer, name: f.name.trim(), category: f.category })
    } catch (e) { setErr(e?.message || 'Save failed.') }
    finally { setBusy(false) }
  }

  return (
    <div className="fixed inset-0 z-[200] bg-black/40 flex items-center justify-center px-4">
      <div className="bg-white w-full max-w-sm rounded-2xl p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-bold text-slate-800">Edit Customer</h2>
          <button onClick={onClose} className="text-slate-400 text-lg">✕</button>
        </div>
        <div className="space-y-3">
          <div>
            <label className="block text-xs font-semibold text-slate-500 mb-1">Customer Name *</label>
            <input value={f.name} onChange={set('name')} className={inputCls} />
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-500 mb-1">Category</label>
            <select value={f.category} onChange={set('category')} className={inputCls}>
              <option value="">Select category</option>
              {(categories || []).map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-500 mb-1">Route</label>
            <input value={f.route} readOnly className={`${inputCls} bg-slate-50 text-slate-500`} />
            <p className="text-[10px] text-slate-400 mt-0.5">Route is changed per-order, not here.</p>
          </div>
        </div>
        {err && <p className="text-xs text-red-600 mt-2">{err}</p>}
        <div className="flex gap-2 mt-4">
          <button onClick={onClose} className="flex-1 rounded-xl border border-slate-200 py-2.5 text-sm font-semibold text-slate-600">Cancel</button>
          <button onClick={save} disabled={busy} className="flex-1 rounded-xl bg-brand-600 text-white py-2.5 text-sm font-bold disabled:bg-slate-300">
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

function DeleteModal({ customer, onClose, onConfirm, busy }) {
  return (
    <div className="fixed inset-0 z-[200] bg-black/40 flex items-center justify-center px-4">
      <div className="bg-white w-full max-w-sm rounded-2xl p-5">
        <p className="font-bold text-slate-800 text-base mb-1">Deactivate Customer?</p>
        <p className="text-sm text-slate-500 mb-1">
          <b>{customer.name}</b> will be marked inactive and hidden from new order creation.
        </p>
        <p className="text-xs text-slate-400 mb-4">
          All existing orders and billing records remain intact. You can reactivate the customer at any time.
        </p>
        <div className="flex gap-2">
          <button onClick={onClose} disabled={busy} className="flex-1 rounded-xl border border-slate-200 py-2.5 text-sm font-semibold text-slate-600">Cancel</button>
          <button onClick={onConfirm} disabled={busy} className="flex-1 rounded-xl bg-red-600 text-white py-2.5 text-sm font-bold disabled:bg-slate-300">
            {busy ? 'Deactivating…' : 'Deactivate'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default function AdminCustomersPage() {
  const [customers, setCustomers] = useState(null)
  const [search, setSearch] = useState('')
  const [showInactive, setShowInactive] = useState(false)
  const [editing, setEditing] = useState(null)
  const [deleting, setDeleting] = useState(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [toast, setToast] = useState('')
  const categories = [] // could load from cloud if needed

  const flash = (m) => { setToast(m); setTimeout(() => setToast(''), 3000) }

  const load = useCallback(() => {
    setCustomers(null)
    loadAdminCustomers({ search: search || undefined, showInactive }).then(setCustomers).catch(() => setCustomers([]))
  }, [search, showInactive])

  useEffect(() => { load() }, [load])

  const onSaved = (updated) => {
    setCustomers(prev => (prev || []).map(c => c.id === updated.id ? updated : c))
    setEditing(null)
    flash('Customer updated successfully.')
  }

  const onDeactivate = async () => {
    if (!deleting) return
    setDeleteBusy(true)
    try {
      await deactivateCustomer(deleting.id)
      setCustomers(prev => showInactive
        ? (prev || []).map(c => c.id === deleting.id ? { ...c, isActive: false } : c)
        : (prev || []).filter(c => c.id !== deleting.id)
      )
      setDeleting(null)
      flash('Customer deactivated successfully.')
    } catch (e) { flash('Deactivation failed: ' + (e?.message || 'unknown error')) }
    finally { setDeleteBusy(false) }
  }

  const onReactivate = async (c) => {
    try {
      await reactivateCustomer(c.id)
      setCustomers(prev => (prev || []).map(x => x.id === c.id ? { ...x, isActive: true } : x))
      flash('Customer reactivated.')
    } catch (e) { flash('Reactivation failed: ' + (e?.message || '')) }
  }

  const displayed = (customers || [])

  return (
    <div className="px-3 sm:px-6 pt-4 pb-10">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <div>
          <h1 className="text-lg font-bold text-slate-800">Customers</h1>
          <p className="text-[12px] text-slate-400">{customers ? `${displayed.length} customer${displayed.length !== 1 ? 's' : ''}` : 'Loading…'}</p>
        </div>
        <button onClick={load} className="text-sm font-semibold text-brand-700 px-3 py-1.5 rounded-lg border border-slate-200 hover:bg-slate-50">Refresh</button>
      </div>

      <div className="flex flex-wrap gap-2 mb-4">
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search by name…"
          className="flex-1 min-w-[180px] rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-brand-500"
        />
        <label className="flex items-center gap-1.5 text-sm text-slate-600 cursor-pointer select-none">
          <input type="checkbox" checked={showInactive} onChange={e => setShowInactive(e.target.checked)} className="rounded" />
          Show inactive
        </label>
      </div>

      {customers === null ? (
        <div className="py-16 flex justify-center"><div className="h-6 w-6 rounded-full border-4 border-slate-200 border-t-slate-800 animate-spin"/></div>
      ) : displayed.length === 0 ? (
        <div className="py-12 text-center text-slate-400 text-sm">No customers found.</div>
      ) : (
        <div className="rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="min-w-full text-[12px] text-left">
              <thead className="bg-slate-50 text-slate-500 text-[10px] uppercase tracking-wide">
                <tr>
                  {['Customer Name','Route','Category','Created By','Created','Status','Actions'].map(h => (
                    <th key={h} className="px-3 py-2.5 font-semibold whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {displayed.map(c => (
                  <tr key={c.id} className={`hover:bg-slate-50 ${!c.isActive ? 'opacity-50' : ''}`}>
                    <td className="px-3 py-2.5 font-semibold text-slate-800 max-w-[200px]">
                      <p className="truncate">{c.name}</p>
                      <p className="text-[10px] text-slate-400 font-normal truncate">{c.id}</p>
                    </td>
                    <td className="px-3 py-2.5 text-slate-500 whitespace-nowrap">{c.route || '—'}</td>
                    <td className="px-3 py-2.5 text-slate-500">{c.category || '—'}</td>
                    <td className="px-3 py-2.5 text-slate-400 whitespace-nowrap">{c.createdByName}</td>
                    <td className="px-3 py-2.5 text-slate-400 whitespace-nowrap">
                      {c.createdAt ? new Date(c.createdAt).toLocaleDateString('en-IN', { day:'numeric', month:'short', year:'numeric' }) : '—'}
                    </td>
                    <td className="px-3 py-2.5">
                      <span className={`text-[9px] font-bold uppercase px-2 py-0.5 rounded-full ${c.isActive ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-500'}`}>
                        {c.isActive ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 whitespace-nowrap">
                      <div className="flex gap-1.5">
                        <button onClick={() => setEditing(c)}
                          className="text-[11px] font-semibold text-brand-700 border border-brand-200 rounded-lg px-2.5 py-1 hover:bg-brand-50">
                          Edit
                        </button>
                        {c.isActive ? (
                          <button onClick={() => setDeleting(c)}
                            className="text-[11px] font-semibold text-red-600 border border-red-200 rounded-lg px-2.5 py-1 hover:bg-red-50">
                            Deactivate
                          </button>
                        ) : (
                          <button onClick={() => onReactivate(c)}
                            className="text-[11px] font-semibold text-emerald-700 border border-emerald-200 rounded-lg px-2.5 py-1 hover:bg-emerald-50">
                            Reactivate
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {editing && <EditModal customer={editing} categories={categories} onClose={() => setEditing(null)} onSaved={onSaved} />}
      {deleting && <DeleteModal customer={deleting} onClose={() => setDeleting(null)} onConfirm={onDeactivate} busy={deleteBusy} />}
      {toast && <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 bg-slate-900 text-white text-sm font-semibold px-4 py-2.5 rounded-xl shadow-lg">{toast}</div>}
    </div>
  )
}
