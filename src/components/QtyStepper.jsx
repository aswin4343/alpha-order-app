import { PlusIcon, MinusIcon } from './Icons.jsx'

// Large, touch-friendly quantity control. Qty never goes below 0.
export default function QtyStepper({ qty, onChange }) {
  const dec = () => onChange(Math.max(0, qty - 1))
  const inc = () => onChange(qty + 1)

  const handleType = (e) => {
    const v = e.target.value.replace(/[^\d]/g, '')
    onChange(v === '' ? 0 : Math.min(99999, parseInt(v, 10)))
  }

  const active = qty > 0

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={dec}
        disabled={qty === 0}
        aria-label="Decrease"
        className={`h-11 w-11 rounded-xl flex items-center justify-center transition active:scale-95 ${
          qty === 0
            ? 'bg-slate-100 text-slate-300'
            : 'bg-slate-100 text-slate-700 active:bg-slate-200'
        }`}
      >
        <MinusIcon className="h-5 w-5" />
      </button>

      <input
        type="number"
        inputMode="numeric"
        value={qty === 0 ? '' : qty}
        placeholder="0"
        onChange={handleType}
        onFocus={(e) => e.target.select()}
        className={`h-11 w-14 text-center text-lg font-semibold rounded-xl border outline-none ${
          active
            ? 'border-brand-500 text-brand-700 bg-brand-50'
            : 'border-slate-200 text-slate-500 bg-white'
        }`}
      />

      <button
        type="button"
        onClick={inc}
        aria-label="Increase"
        className="h-11 w-11 rounded-xl flex items-center justify-center bg-brand-600 text-white active:bg-brand-700 transition active:scale-95"
      >
        <PlusIcon className="h-5 w-5" />
      </button>
    </div>
  )
}
