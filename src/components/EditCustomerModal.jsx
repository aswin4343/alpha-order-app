import { useState, useCallback } from 'react'
import { useApp } from '../context/AppContext.jsx'
import { CloseIcon } from './Icons.jsx'
import { CREDIT_DAYS_OPTIONS } from './NewCustomerModal.jsx'
import { updateCustomerName, updateCustomerCloudFields } from '../utils/cloudSync.js'

const inputCls =
  'w-full rounded-xl border border-slate-200 px-3 py-3 outline-none text-[15px] focus:border-brand-500'

/**
 * Edit an existing customer. Reps can edit all fields.
 * Customer Name changes are persisted to the cloud (shop_name in customers table).
 * PII (phone/area/email/gstn/creditDays) remains local per existing architecture.
 */
export default function EditCustomerModal({ customer, onClose, onSaved }) {
  const { categories, updateCustomer } = useApp()
  const [f, setF] = useState({
    name: customer.name || '',
    area: customer.area || '',
    category: customer.category || '',
    creditDays: customer.creditDays || 'No Credit',
    phone: customer.phone || '',
    email: customer.email || '',
    gstn: customer.gstn || ''
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const set = useCallback(
    (k) => (e) => {
      const { value } = e.target
      setF((prev) => ({ ...prev, [k]: value }))
    },
    []
  )

  const save = async () => {
    if (!f.name.trim()) { setError('Customer name cannot be empty.'); return }
    setSaving(true)
    setError('')
    try {
      // 1. If name changed, persist to cloud (shop_name column)
      const nameChanged = f.name.trim() !== (customer.name || '').trim()
      const cloudId = customer.id?.startsWith('cloud_')
        ? customer.id.replace('cloud_', '')
        : customer.id
      if (nameChanged && cloudId && !cloudId.startsWith('c')) {
        await updateCustomerName(cloudId, f.name.trim())
      }
      // 2. If category changed, persist to cloud
      const catChanged = f.category !== (customer.category || '')
      if (catChanged && cloudId && !cloudId.startsWith('c')) {
        await updateCustomerCloudFields(cloudId, { category: f.category })
      }
      // 3. All fields (including PII) update local store
      const patch = { ...f, name: f.name.trim() }
      await updateCustomer(customer.id, patch)
      onSaved({ ...customer, ...patch })
    } catch (e) {
      console.error(e)
      setError(e?.message || 'Could not save changes. Please try again.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center">
      <div className="bg-white w-full sm:max-w-md rounded-t-3xl sm:rounded-3xl max-h-[92vh] flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100">
          <div className="min-w-0">
            <h2 className="font-bold text-slate-800 truncate">Edit Customer</h2>
            <p className="text-xs text-slate-400 truncate">{customer.name}</p>
          </div>
          <button onClick={onClose} className="p-2 text-slate-400" aria-label="Close">
            <CloseIcon className="h-5 w-5" />
          </button>
        </div>

        <div className="overflow-y-auto px-4 py-4 scroll-area space-y-3.5">
          {/* Customer Name — now editable */}
          <div>
            <label className="block text-sm font-medium text-slate-600 mb-1.5">Customer Name *</label>
            <input
              value={f.name}
              onChange={set('name')}
              placeholder="Customer / shop name"
              className={inputCls}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-600 mb-1.5">Credit Days</label>
            <select value={f.creditDays} onChange={set('creditDays')} className={inputCls}>
              {CREDIT_DAYS_OPTIONS.map((o) => (
                <option key={o} value={o}>{o}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-600 mb-1.5">Category</label>
            <select value={f.category} onChange={set('category')} className={inputCls}>
              <option value="">Select category</option>
              {(categories || []).map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-600 mb-1.5">Area</label>
            <input value={f.area} onChange={set('area')} placeholder="Area" className={inputCls} />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-600 mb-1.5">Phone</label>
            <input value={f.phone} onChange={set('phone')} placeholder="10-digit mobile" inputMode="numeric" className={inputCls} />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-600 mb-1.5">GSTN</label>
            <input value={f.gstn} onChange={set('gstn')} placeholder="Optional" className={inputCls} />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-600 mb-1.5">Email</label>
            <input value={f.email} onChange={set('email')} placeholder="Optional" type="email" className={inputCls} />
          </div>

          {error && <p className="text-sm text-red-600 leading-snug">{error}</p>}
        </div>

        <div className="px-4 py-3 border-t border-slate-100 shrink-0">
          <button
            onClick={save}
            disabled={saving || !f.name.trim()}
            className="w-full rounded-2xl bg-brand-600 text-white py-4 font-bold text-[15px] active:bg-brand-700 disabled:bg-slate-200 disabled:text-slate-400"
          >
            {saving ? 'Saving…' : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  )
}
