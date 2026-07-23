import { useState } from 'react'
import { CopyIcon } from './Icons.jsx'

// Reasons requested for the "Visited - No Order" documentation.
export const VISIT_REASONS = [
  'Shop Closed',
  'No Requirement',
  'Out of Stock',
  'Owner Not Available',
  'Already Purchased',
  'Payment Pending',
  'Other'
]

/**
 * "Visited - No Order" panel. The rep picks a reason, then either:
 *   - Copy: copies the SHOP VISIT UPDATE text to paste anywhere, or
 *   - Save Visit (bottom bar): records it + sends via WhatsApp.
 */
export default function VisitStatus({ value, remark, onChange, onRemark, onCopy }) {
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
          {active ? '📍 Visited - No Order' : 'Mark as visit (no order)'}
        </span>
        <span className="text-xs text-brand-600 font-semibold">
          {active ? 'Change' : open ? 'Close' : 'Select'}
        </span>
      </button>

      {active && (
        <p className="text-[13px] text-amber-700 mt-1.5 font-medium">
          Reason: {value}
          {value === 'Other' && remark ? ` — ${remark}` : ''}
        </p>
      )}

      {open && (
        <div className="mt-2 space-y-1.5">
          {VISIT_REASONS.map((s) => (
            <button
              key={s}
              onClick={() => {
                onChange(value === s ? '' : s)
                if (s !== 'Other') onRemark('')
                if (s !== 'Other') setOpen(false)
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

          {value === 'Other' && (
            <input
              value={remark}
              onChange={(e) => onRemark(e.target.value)}
              placeholder="Type reason..."
              autoFocus
              className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-brand-500"
            />
          )}
        </div>
      )}

      {/* Copy button — available as soon as a reason is chosen. */}
      {active && (
        <button
          onClick={onCopy}
          className="mt-2.5 w-full flex items-center justify-center gap-2 rounded-xl border border-slate-200 py-2.5 text-sm font-semibold text-slate-700 active:bg-slate-50"
        >
          <CopyIcon className="h-4 w-4" /> Copy Visit Message
        </button>
      )}
    </div>
  )
}
