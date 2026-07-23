import { useState } from 'react'

export const VISIT_STATUSES = [
  'Stock Available, No Order',
  'Owner Not Available, No Order',
  'Shop Closed, No Order',
  'Next Visit, No Order',
  'Others'
]

/**
 * Visit Status selector shown under the customer.
 * When a "No Order" reason is chosen, the order becomes a recorded visit
 * instead of a product order. "Others" reveals a free-text remark.
 */
export default function VisitStatus({ value, remark, onChange, onRemark }) {
  const [open, setOpen] = useState(false)
  const active = !!value

  return (
    <div
      className={`rounded-2xl bg-white shadow-card border px-4 py-3 ${
        active ? 'border-amber-300' : 'border-slate-100'
      }`}
    >
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between"
      >
        <span className="text-sm font-medium text-slate-700">
          {active ? '📍 No-Order Visit' : 'Mark as visit (no order)'}
        </span>
        <span className="text-xs text-brand-600 font-semibold">
          {active ? 'Change' : open ? 'Close' : 'Select'}
        </span>
      </button>

      {active && (
        <p className="text-[13px] text-amber-700 mt-1.5 font-medium">{value}</p>
      )}
      {active && value === 'Others' && remark && (
        <p className="text-xs text-slate-500 mt-0.5">“{remark}”</p>
      )}

      {open && (
        <div className="mt-2 space-y-1.5">
          {VISIT_STATUSES.map((s) => (
            <button
              key={s}
              onClick={() => {
                onChange(value === s ? '' : s)
                if (s !== 'Others') onRemark('')
                if (s !== 'Others') setOpen(false)
              }}
              className={`w-full text-left px-3 py-2.5 rounded-xl text-sm border ${
                value === s
                  ? 'border-amber-300 bg-amber-50 text-amber-800 font-medium'
                  : 'border-slate-200 text-slate-600 active:bg-slate-50'
              }`}
            >
              {s}
            </button>
          ))}

          {value === 'Others' && (
            <input
              value={remark}
              onChange={(e) => onRemark(e.target.value)}
              placeholder="Type reason..."
              autoFocus
              className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-brand-500"
            />
          )}

          {active && (
            <button
              onClick={() => {
                onChange('')
                onRemark('')
                setOpen(false)
              }}
              className="w-full text-center py-2 text-sm text-slate-500 font-medium"
            >
              Clear visit status
            </button>
          )}
        </div>
      )}
    </div>
  )
}
