import { useState, useCallback } from 'react'
import { useApp } from '../context/AppContext.jsx'
import { CloseIcon } from './Icons.jsx'
import { CREDIT_DAYS_OPTIONS } from './NewCustomerModal.jsx'

const inputCls =
  'w-full rounded-xl border border-slate-200 px-3 py-3 outline-none text-[15px] focus:border-brand-500'

/**
 * Edit an existing customer. For now any rep may edit (no admin role yet);
 * role-gating arrives with V3. Credit Days is the primary field here, but
 * phone / area / category are editable too for convenience.
 */
export default function EditCustomerModal({ customer, onClose, onSaved }) {
  const { categories, updateCustomer } = useApp()
  const [f, setF] = useState({
    area: customer.area || '',
    category: customer.category || '',
    creditDays: customer.creditDays || 'No Credit',
    phone: customer.phone || '',
    email: customer.email || '',
    gstn: customer.gstn || ''
  })
  const [saving, setSaving] = useState(false)

  const set = useCallback(
    (k) => (e) => {
      const { value } = e.target
      setF((prev) => ({ ...prev, [k]: value }))
    },
    []
  )

  const save = async () => {
    setSaving(true)
    try {
      await updateCustomer(customer.id, f)
      onSaved({ ...customer, ...f })
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
          <div>
            <label className="block text-sm font-medium text-slate-600 mb-1.5">Credit Days</label>
            <select value={f.creditDays} onChange={set('creditDays')} className={inputCls}>
              {CREDIT_DAYS_OPTIONS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-600 mb-1.5">Category</label>
            <select value={f.category} onChange={set('category')} className={inputCls}>
              <option value="">Select category</option>
              {categories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-600 mb-1.5">Area</label>
            <input value={f.area} onChange={set('area')} className={inputCls} placeholder="Area" />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-600 mb-1.5">Phone</label>
            <input
              value={f.phone}
              onChange={set('phone')}
              inputMode="numeric"
              maxLength={10}
              className={inputCls}
              placeholder="10-digit mobile"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-600 mb-1.5">GSTN</label>
            <input value={f.gstn} onChange={set('gstn')} className={inputCls} placeholder="Optional" />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-600 mb-1.5">Email</label>
            <input
              value={f.email}
              onChange={set('email')}
              type="email"
              className={inputCls}
              placeholder="Optional"
            />
          </div>
        </div>

        <div className="p-4 border-t border-slate-100 safe-bottom">
          <button
            onClick={save}
            disabled={saving}
            className="w-full rounded-xl py-4 font-bold bg-brand-600 text-white active:bg-brand-700 disabled:bg-slate-100 disabled:text-slate-400"
          >
            {saving ? 'Saving…' : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  )
}
