import { useState, useMemo } from 'react'
import { useApp } from '../context/AppContext.jsx'
import { CloseIcon } from './Icons.jsx'

/**
 * Customer Creation Module.
 *
 * Validation:
 *   Name, Area, Route, Category, Phone are required.
 *   GSTN filled  -> Email becomes MANDATORY (Save stays disabled until entered)
 *   GSTN empty   -> Email optional
 */
export default function NewCustomerModal({ initialName = '', onClose, onCreated }) {
  const { categories, customers, addCustomer } = useApp()

  const [f, setF] = useState({
    name: initialName,
    area: '',
    route: '',
    category: '',
    gstn: '',
    phone: '',
    email: ''
  })
  const [touched, setTouched] = useState(false)
  const [saving, setSaving] = useState(false)

  const set = (k) => (e) => setF((p) => ({ ...p, [k]: e.target.value }))

  // Existing routes, offered as suggestions so reps stay consistent.
  const routes = useMemo(() => {
    const s = new Set()
    customers.forEach((c) => c.route && s.add(c.route))
    return Array.from(s).sort()
  }, [customers])

  const gstnFilled = f.gstn.trim().length > 0
  const emailRequired = gstnFilled
  const emailOk = !emailRequired || /\S+@\S+\.\S+/.test(f.email.trim())

  const errors = {
    name: !f.name.trim(),
    area: !f.area.trim(),
    route: !f.route.trim(),
    category: !f.category,
    phone: !/^\d{10}$/.test(f.phone.replace(/\D/g, '')),
    email: !emailOk
  }
  const canSave = !Object.values(errors).some(Boolean) && !saving

  const save = async () => {
    setTouched(true)
    if (!canSave) return
    setSaving(true)
    try {
      const rec = await addCustomer(f)
      onCreated(rec)
    } finally {
      setSaving(false)
    }
  }

  const Field = ({ label, required, error, children, hint }) => (
    <div className="mb-3.5">
      <label className="block text-sm font-medium text-slate-600 mb-1.5">
        {label} {required && <span className="text-red-500">*</span>}
      </label>
      {children}
      {hint && <p className="text-[11px] text-slate-400 mt-1">{hint}</p>}
      {touched && error && (
        <p className="text-[11px] text-red-500 mt-1">This field is required</p>
      )}
    </div>
  )

  const inputCls = (bad) =>
    `w-full rounded-xl border px-3 py-3 outline-none text-[15px] ${
      touched && bad ? 'border-red-300 focus:border-red-500' : 'border-slate-200 focus:border-brand-500'
    }`

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center">
      <div className="bg-white w-full sm:max-w-md rounded-t-3xl sm:rounded-3xl max-h-[92vh] flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100">
          <h2 className="font-bold text-slate-800">New Customer</h2>
          <button onClick={onClose} className="p-2 text-slate-400" aria-label="Close">
            <CloseIcon className="h-5 w-5" />
          </button>
        </div>

        <div className="overflow-y-auto px-4 py-4 scroll-area">
          <Field label="Customer Name" required error={errors.name}>
            <input value={f.name} onChange={set('name')} className={inputCls(errors.name)} placeholder="Shop name" />
          </Field>

          <Field label="Customer Area" required error={errors.area}>
            <input value={f.area} onChange={set('area')} className={inputCls(errors.area)} placeholder="Area / locality" />
          </Field>

          <Field label="Route Name" required error={errors.route}>
            <input
              value={f.route}
              onChange={set('route')}
              list="route-list"
              className={inputCls(errors.route)}
              placeholder="Route"
            />
            <datalist id="route-list">
              {routes.map((r) => (
                <option key={r} value={r} />
              ))}
            </datalist>
          </Field>

          <Field label="Customer Category" required error={errors.category}>
            <select value={f.category} onChange={set('category')} className={inputCls(errors.category)}>
              <option value="">Select category</option>
              {categories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Phone Number" required error={errors.phone}>
            <input
              value={f.phone}
              onChange={set('phone')}
              inputMode="numeric"
              maxLength={10}
              className={inputCls(errors.phone)}
              placeholder="10-digit mobile"
            />
          </Field>

          <Field label="GSTN Number">
            <input
              value={f.gstn}
              onChange={set('gstn')}
              className={inputCls(false)}
              placeholder="Optional"
            />
          </Field>

          <Field
            label="Email Address"
            required={emailRequired}
            error={errors.email}
            hint={emailRequired ? 'Email is mandatory because GSTN is entered' : 'Optional'}
          >
            <input
              value={f.email}
              onChange={set('email')}
              type="email"
              className={inputCls(errors.email)}
              placeholder={emailRequired ? 'Required with GSTN' : 'Optional'}
            />
          </Field>
        </div>

        <div className="p-4 border-t border-slate-100 safe-bottom">
          <button
            onClick={save}
            disabled={!canSave}
            className={`w-full rounded-xl py-4 font-bold ${
              canSave ? 'bg-brand-600 text-white active:bg-brand-700' : 'bg-slate-100 text-slate-400'
            }`}
          >
            {saving ? 'Saving…' : 'Save Customer'}
          </button>
        </div>
      </div>
    </div>
  )
}
