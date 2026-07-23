import { memo } from 'react'
import QtyStepper from './QtyStepper.jsx'
import { schemeBadge, calculateScheme, netRate } from '../utils/schemes.js'

const UNITS = ['Piece', 'Box']

/** Compact price pill. RP/WP/BR/NR keep it short on narrow screens. */
function Tag({ label, value, accent }) {
  if (value == null || value === '') return null
  return (
    <span
      className={`inline-flex items-baseline gap-0.5 text-[10px] leading-none font-semibold px-1.5 py-1 rounded-md border ${
        accent
          ? 'bg-brand-50 border-brand-200 text-brand-700'
          : 'bg-slate-50 border-slate-200 text-slate-600'
      }`}
    >
      <span className="opacity-70">{label}</span>
      <span>₹{value}</span>
    </span>
  )
}

/**
 * Product row. Scheme products show BR/NR; all others show RP/WP.
 * Layout is tuned for one-hand use on a phone.
 */
function ProductCard({ product, qty, unit, onQty, onUnit }) {
  const selected = qty > 0
  const badge = schemeBadge(product.slabs)
  const hasScheme = !!badge
  const result = selected ? calculateScheme(qty, product.slabs) : null

  const currentNet =
    result?.slab && product.base
      ? netRate(product.base, result.slab.buy, result.slab.free)
      : null

  return (
    <div
      className={`rounded-2xl bg-white shadow-card px-3 py-2.5 border ${
        selected ? 'border-brand-500' : 'border-transparent'
      }`}
    >
      {/* Name */}
      <p className="text-[14px] leading-snug font-medium text-slate-800 break-words">
        {product.name}
      </p>

      {/* Brand + scheme + price tags, all compact */}
      <div className="flex flex-wrap items-center gap-1 mt-1.5">
        {hasScheme && (
          <span className="text-[10px] leading-none font-semibold text-amber-700 bg-amber-50 border border-amber-200 px-1.5 py-1 rounded-md">
            🎁 {badge}
          </span>
        )}

        {hasScheme ? (
          <>
            <Tag label="BR" value={product.base} />
            <Tag label="NR" value={currentNet} accent />
          </>
        ) : (
          <>
            <Tag label="RP" value={product.retail} />
            <Tag label="WP" value={product.wholesale} />
          </>
        )}
      </div>

      {/* Controls */}
      <div className="flex items-center justify-between gap-2 mt-2">
        <select
          value={unit || 'Piece'}
          onChange={(e) => onUnit(product.id, e.target.value)}
          className="h-10 rounded-lg border border-slate-200 bg-white pl-2 pr-1 text-xs text-slate-600 outline-none focus:border-brand-500"
          aria-label="Quantity type"
        >
          {UNITS.map((u) => (
            <option key={u} value={u}>
              {u}
            </option>
          ))}
        </select>

        <QtyStepper qty={qty} onChange={(v) => onQty(product.id, v)} />
      </div>

      {/* Live scheme feedback */}
      {selected && hasScheme && (
        <p className="text-[11px] mt-1.5 font-medium">
          {result.free > 0 ? (
            <span className="text-brand-700">
              ✓ {result.free} free
              {result.leftover > 0 && (
                <span className="text-slate-400 font-normal"> · {result.leftover} no scheme</span>
              )}
            </span>
          ) : (
            <span className="text-slate-400">
              +{product.slabs[0][0] - qty} more → {product.slabs[0][1]} free
            </span>
          )}
        </p>
      )}
    </div>
  )
}

export default memo(ProductCard)
