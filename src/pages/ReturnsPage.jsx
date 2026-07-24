import { useState, useMemo } from 'react'
import { useApp } from '../context/AppContext.jsx'
import { useSearch } from '../hooks/useSearch.js'
import { useDebounce } from '../hooks/useDebounce.js'
import CustomerPicker from '../components/CustomerPicker.jsx'
import BrandSelector from '../components/BrandSelector.jsx'
import { BackIcon, PlusIcon, CloseIcon, WhatsAppIcon, SearchIcon, CopyIcon } from '../components/Icons.jsx'
import { buildCreditNoteMessage, buildWhatsappUrl } from '../utils/whatsapp.js'

const REASONS = ['Expired', 'Damaged']
const getProductText = (p) => `${p.name} ${p.brand || ''}`

/** One return line: product picker + MRP + qty + reason. */
function ReturnLine({ line, index, onChange, onRemove, products }) {
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const debounced = useDebounce(q, 120)
  const results = useSearch(products, debounced, getProductText, 30)

  return (
    <div className="rounded-2xl bg-white shadow-card border border-slate-100 p-4 mb-3">
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs font-semibold text-slate-400">PRODUCT {index + 1}</p>
        <button onClick={() => onRemove(line.key)} className="text-slate-400 p-1" aria-label="Remove">
          <CloseIcon className="h-4 w-4" />
        </button>
      </div>

      {line.name ? (
        <button
          onClick={() => { onChange(line.key, { name: '' }); setOpen(true) }}
          className="w-full text-left rounded-xl border border-brand-500 bg-brand-50 px-3 py-2.5 mb-3"
        >
          <p className="text-sm font-medium text-slate-800">{line.name}</p>
          <p className="text-[11px] text-brand-700">Tap to change</p>
        </button>
      ) : (
        <div className="mb-3">
          <div className="flex items-center gap-2 rounded-xl border border-slate-200 px-3">
            <SearchIcon className="h-4 w-4 text-slate-400" />
            <input
              value={q}
              onChange={(e) => { setQ(e.target.value); setOpen(true) }}
              onFocus={() => setOpen(true)}
              placeholder="Search product..."
              className="flex-1 py-2.5 text-sm outline-none"
            />
          </div>
          {open && q && (
            <div className="mt-1 max-h-44 overflow-y-auto rounded-xl border border-slate-100 scroll-area">
              {results.map((p) => (
                <button
                  key={p.id}
                  onClick={() => {
                    onChange(line.key, { name: p.name, mrp: line.mrp || (p.mrp ?? '') })
                    setOpen(false); setQ('')
                  }}
                  className="w-full text-left px-3 py-2.5 text-sm active:bg-slate-50 border-b border-slate-50"
                >
                  {p.name}
                </button>
              ))}
              {results.length === 0 && (
                <p className="px-3 py-3 text-sm text-slate-400">No match</p>
              )}
            </div>
          )}
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 mb-3">
        <div>
          <label className="block text-xs text-slate-500 mb-1">MRP (per piece)</label>
          <input
            value={line.mrp}
            onChange={(e) => onChange(line.key, { mrp: e.target.value.replace(/[^\d.]/g, '') })}
            inputMode="decimal"
            placeholder="₹"
            className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-brand-500"
          />
        </div>
        <div>
          <label className="block text-xs text-slate-500 mb-1">Quantity</label>
          <input
            value={line.qty}
            onChange={(e) => onChange(line.key, { qty: e.target.value.replace(/[^\d]/g, '') })}
            inputMode="numeric"
            placeholder="0"
            className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-brand-500"
          />
        </div>
      </div>

      <label className="block text-xs text-slate-500 mb-1">Reason</label>
      <select
        value={line.reason}
        onChange={(e) => onChange(line.key, { reason: e.target.value })}
        className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-brand-500"
      >
        <option value="">Select reason</option>
        {REASONS.map((r) => (
          <option key={r} value={r}>{r}</option>
        ))}
      </select>
    </div>
  )
}

export default function ReturnsPage({ onBack }) {
  const { settings, products } = useApp()
  const [customer, setCustomer] = useState(null)
  const [lines, setLines] = useState([
    { key: 1, name: '', mrp: '', qty: '', reason: '' }
  ])
  const [toast, setToast] = useState('')

  const update = (key, patch) =>
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)))

  const addLine = () =>
    setLines((prev) => [...prev, { key: Date.now(), name: '', mrp: '', qty: '', reason: '' }])

  const removeLine = (key) =>
    setLines((prev) => (prev.length === 1 ? prev : prev.filter((l) => l.key !== key)))

  const valid = useMemo(
    () =>
      customer &&
      lines.length > 0 &&
      lines.every((l) => l.name && l.mrp && Number(l.qty) > 0 && l.reason),
    [customer, lines]
  )

  const message = (location) =>
    buildCreditNoteMessage({
      brand: settings.brand,
      customer,
      salesperson: settings.salesperson,
      lines: lines.map((l) => ({ name: l.name, mrp: l.mrp, qty: l.qty, reason: l.reason })),
      location
    })

  const getLocation = () =>
    new Promise((resolve) => {
      if (!navigator.geolocation) return resolve(null)
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({ latitude: pos.coords.latitude, longitude: pos.coords.longitude }),
        () => resolve(null),
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 }
      )
    })

  const send = async () => {
    if (!valid) return
    const loc = await getLocation()
    window.open(buildWhatsappUrl(message(loc)), '_blank')
  }

  // Copy lets the rep paste into WhatsApp Business manually.
  const copy = async () => {
    if (!valid) return
    try {
      const loc = await getLocation()
      await navigator.clipboard.writeText(message(loc))
      setToast('Credit note copied — paste in WhatsApp Business')
    } catch {
      setToast('Copy failed')
    }
    setTimeout(() => setToast(''), 2600)
  }

  return (
    <div className="min-h-screen bg-slate-50 pb-32">
      <header className="sticky top-0 z-20 bg-white border-b border-slate-100 safe-top">
        <div className="mx-auto max-w-md px-3 py-2 flex items-center gap-2">
          <button onClick={onBack} className="h-10 w-10 rounded-full flex items-center justify-center text-slate-600 active:bg-slate-100">
            <BackIcon className="h-6 w-6" />
          </button>
          <h1 className="text-lg font-bold text-slate-800">Customer Return</h1>
          <div className="flex-1" />
          <BrandSelector />
        </div>
      </header>

      <main className="mx-auto max-w-md px-3 pt-3">
        <CustomerPicker selected={customer} onSelect={setCustomer} />

        <p className="text-xs font-semibold text-slate-400 mt-4 mb-2 px-1">RETURN ITEMS</p>

        {lines.map((l, i) => (
          <ReturnLine
            key={l.key}
            line={l}
            index={i}
            onChange={update}
            onRemove={removeLine}
            products={products}
          />
        ))}

        <button
          onClick={addLine}
          className="w-full flex items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-slate-200 py-3.5 text-brand-600 font-semibold active:bg-brand-50"
        >
          <PlusIcon className="h-5 w-5" /> Add Product
        </button>
      </main>

      <div className="fixed bottom-0 left-0 right-0 z-30">
        <div className="mx-auto max-w-md px-3 pb-3 safe-bottom">
          <div className="flex gap-2">
            <button
              onClick={copy}
              disabled={!valid}
              aria-label="Copy credit note"
              className={`h-[56px] w-[56px] shrink-0 rounded-xl flex items-center justify-center border bg-white shadow-pop ${
                valid ? 'border-slate-200 text-slate-600 active:bg-slate-50' : 'border-slate-100 text-slate-300'
              }`}
            >
              <CopyIcon className="h-5 w-5" />
            </button>
            <button
              onClick={send}
              disabled={!valid}
              className={`flex-1 flex items-center justify-center gap-2 rounded-xl py-4 font-bold shadow-pop ${
                valid ? 'bg-brand-600 text-white active:bg-brand-700' : 'bg-slate-200 text-slate-400'
              }`}
            >
              <WhatsAppIcon className="h-6 w-6" />
              SEND CREDIT NOTE
            </button>
          </div>
        </div>
      </div>

      {toast && (
        <div className="fixed bottom-24 left-1/2 -translate-x-1/2 bg-slate-900 text-white text-sm px-4 py-2.5 rounded-full shadow-pop z-50">
          {toast}
        </div>
      )}
    </div>
  )
}
