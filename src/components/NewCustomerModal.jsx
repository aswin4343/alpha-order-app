import { useState, useMemo, useCallback, useEffect } from 'react'
import { useApp } from '../context/AppContext.jsx'
import { CloseIcon } from './Icons.jsx'
import { loadLedgerCategories } from '../utils/cloudSync.js'

/**
 * IMPORTANT: Field and inputCls are declared at MODULE scope, not inside the
 * component. If they were re-created on each render, React would treat them as
 * a new component type every keystroke, unmount the old subtree and mount a
 * fresh <input> — which drops focus and closes the mobile keyboard.
 * Keeping them out here means the same input element persists across renders.
 */
function Field({ label, required, showError, hint, children }) {
  return (
    <div className="mb-3.5">
      <label className="block text-sm font-medium text-slate-600 mb-1.5">
        {label} {required && <span className="text-red-500">*</span>}
      </label>
      {children}
      {hint && <p className="text-[11px] text-slate-400 mt-1">{hint}</p>}
      {showError && <p className="text-[11px] text-red-500 mt-1">This field is required</p>}
    </div>
  )
}

export const CREDIT_DAYS_OPTIONS = ['No Credit', '7 Days', '10 Days', '15 Days', '21 Days', '30 Days']

const inputCls = (bad) =>
  `w-full rounded-xl border px-3 py-3 outline-none text-[15px] ${
    bad ? 'border-red-300 focus:border-red-500' : 'border-slate-200 focus:border-brand-500'
  }`

/**
 * Customer Creation Module.
 *
 * Validation:
 *   Name, Area, Route, Category, Phone are required.
 *   GSTN filled -> Email becomes MANDATORY (Save disabled until valid)
 *   GSTN empty  -> Email optional
 */
const DRAFT_KEY = 'atl_new_customer_draft'

export default function NewCustomerModal({ initialName = '', onClose, onCreated }) {
  const { categories, customers, addCustomer } = useApp()

  // Restore an in-progress draft (device-local only, matches how customer
  // data already stays off the cloud in this app). Falls back to a fresh
  // form seeded with initialName if there's no draft, or the draft is stale.
  // This is a backstop for scenarios the auth-refresh fix doesn't cover
  // (e.g. a mobile browser killing a backgrounded tab to save memory, or an
  // actual page reload) — the primary fix for routine tab-switching lives in
  // AuthContext (it no longer remounts the whole app on a token refresh).
  const [f, setF] = useState(() => {
    try {
      const raw = sessionStorage.getItem(DRAFT_KEY)
      if (raw) {
        const draft = JSON.parse(raw)
        if (draft && typeof draft === 'object') return { ...draft, name: draft.name || initialName }
      }
    } catch { /* corrupt/unavailable storage — fall through to a fresh form */ }
    return {
      name: initialName,
      area: '',
      route: '',
      category: '',
      ledgerCategory: '',
      creditDays: 'No Credit',
      gstn: '',
      phone: '',
      email: ''
    }
  })
  const [touched, setTouched] = useState(false)
  const [saving, setSaving] = useState(false)
  const [ledgerCats, setLedgerCats] = useState([])

  // Load the ledger category master list from the cloud (falls back to the
  // three known values if the cloud is unreachable, so creation never blocks).
  useEffect(() => {
    let alive = true
    loadLedgerCategories().then((list) => {
      if (alive) setLedgerCats(list.length ? list : ['RETAIL-CUSTOMER', 'WHOLESALE-CUSTOMER', 'ZEDGO - EXPRESS'])
    }).catch(() => { if (alive) setLedgerCats(['RETAIL-CUSTOMER', 'WHOLESALE-CUSTOMER', 'ZEDGO - EXPRESS']) })
    return () => { alive = false }
  }, [])

  // Persist the draft on every change so it survives a killed/reloaded tab.
  useEffect(() => {
    try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify(f)) } catch { /* storage full/unavailable — non-fatal */ }
  }, [f])

  // Stable updater — does not change identity between renders.
  const set = useCallback(
    (key) => (e) => {
      const { value } = e.target
      setF((prev) => ({ ...prev, [key]: value }))
    },
    []
  )

  // Existing routes offered as suggestions so reps stay consistent.
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
    ledgerCategory: !f.ledgerCategory,
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
      // Warn if the shop couldn't be saved to the shared cloud (e.g. no signal).
      // It's saved on this phone, but other reps won't see it until it syncs.
      if (rec && rec._cloudSaved === false) {
        window.alert(
          'Customer saved on this phone, but could NOT be saved to the shared cloud ' +
            '(check internet). Other reps won\'t see it yet. It will need to sync when ' +
            'you are back online.'
        )
      }
      onCreated(rec)
      try { sessionStorage.removeItem(DRAFT_KEY) } catch { /* non-fatal */ }
    } finally {
      setSaving(false)
    }
  }

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
          <Field label="Customer Name" required showError={touched && errors.name}>
            <input
              value={f.name}
              onChange={set('name')}
              className={inputCls(touched && errors.name)}
              placeholder="Shop name"
              autoComplete="off"
              autoCapitalize="characters"
            />
          </Field>

          <Field label="Customer Area" required showError={touched && errors.area}>
            <input
              value={f.area}
              onChange={set('area')}
              className={inputCls(touched && errors.area)}
              placeholder="Area / locality"
              autoComplete="off"
            />
          </Field>

          <Field label="Route Name" required showError={touched && errors.route}>
            <input
              value={f.route}
              onChange={set('route')}
              list="route-list"
              className={inputCls(touched && errors.route)}
              placeholder="Route"
              autoComplete="off"
            />
            <datalist id="route-list">
              {routes.map((r) => (
                <option key={r} value={r} />
              ))}
            </datalist>
          </Field>

          <Field label="Customer Category" required showError={touched && errors.category}>
            <select
              value={f.category}
              onChange={set('category')}
              className={inputCls(touched && errors.category)}
            >
              <option value="">Select category</option>
              {categories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Ledger Category" required showError={touched && errors.ledgerCategory}>
            <select
              value={f.ledgerCategory}
              onChange={set('ledgerCategory')}
              className={inputCls(touched && errors.ledgerCategory)}
            >
              <option value="">Select ledger category</option>
              {ledgerCats.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Credit Days">
            <select value={f.creditDays} onChange={set('creditDays')} className={inputCls(false)}>
              {CREDIT_DAYS_OPTIONS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Phone Number" required showError={touched && errors.phone}>
            <input
              value={f.phone}
              onChange={set('phone')}
              inputMode="numeric"
              maxLength={10}
              className={inputCls(touched && errors.phone)}
              placeholder="10-digit mobile"
              autoComplete="off"
            />
          </Field>

          <Field label="GSTN Number">
            <input
              value={f.gstn}
              onChange={set('gstn')}
              className={inputCls(false)}
              placeholder="Optional"
              autoComplete="off"
              autoCapitalize="characters"
            />
          </Field>

          <Field
            label="Email Address"
            required={emailRequired}
            showError={touched && errors.email}
            hint={emailRequired ? 'Email is mandatory because GSTN is entered' : 'Optional'}
          >
            <input
              value={f.email}
              onChange={set('email')}
              type="email"
              className={inputCls(touched && errors.email)}
              placeholder={emailRequired ? 'Required with GSTN' : 'Optional'}
              autoComplete="off"
              autoCapitalize="none"
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
