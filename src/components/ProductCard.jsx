import { memo, useState } from 'react'
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
 * Editable price pill: shows the value with a pencil. Tapping the pencil turns
 * it into an input for a ONE-TIME override (this order only). An overridden
 * value is shown in an accent colour with a small dot.
 */
function EditableTag({ label, value, overridden, onChange, accent }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  if (value == null || value === '') return null

  const start = () => {
    setDraft(String(value))
    setEditing(true)
  }
  const commit = () => {
    const n = parseFloat(String(draft).replace(/[^0-9.]/g, ''))
    if (!isNaN(n) && n > 0) onChange(n)
    setEditing(false)
  }

  if (editing) {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-md border bg-white border-brand-300">
        <span className="opacity-70">{label}</span>
        <input
          autoFocus
          type="number"
          inputMode="decimal"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === 'Enter' && commit()}
          className="w-12 text-[11px] outline-none border-b border-brand-300"
        />
      </span>
    )
  }

  return (
    <button
      type="button"
      onClick={start}
      className={`inline-flex items-baseline gap-0.5 text-[10px] leading-none font-semibold px-1.5 py-1 rounded-md border ${
        overridden
          ? 'bg-amber-50 border-amber-300 text-amber-800'
          : accent
          ? 'bg-brand-50 border-brand-200 text-brand-700'
          : 'bg-slate-50 border-slate-200 text-slate-600'
      }`}
    >
      <span className="opacity-70">{label}</span>
      <span>
        ₹{value}
        {overridden && <span className="ml-0.5">•</span>}
      </span>
      <span className="ml-0.5 opacity-60">✏️</span>
    </button>
  )
}

/**
 * Click-to-select selling price: MRP / Retail / Wholesale, one always active
 * (Wholesale by default — per spec section 1). Tapping a pill selects that
 * price type as the Final Selling Rate for this order line; tapping the
 * pencil lets the rep type a one-off CUSTOM rate instead. This never touches
 * the product's own MRP/Retail/Wholesale master values — only the order
 * line's own priceType + finalRate (stored in `override`), so the master
 * catalogue is completely unaffected by a rep's per-order choice.
 */
function PriceSelector({ product, override, onOverride }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')

  const options = [
    { type: 'MRP', value: product.mrp },
    { type: 'RETAIL', value: product.retail },
    { type: 'WHOLESALE', value: product.wholesale }
  ].filter((o) => o.value != null && o.value !== '')

  if (options.length === 0) return null

  // Default selection: WHOLESALE if available, else whatever's first —
  // matches "Wholesale Price should be the default selected selling price".
  const defaultType = options.some((o) => o.type === 'WHOLESALE') ? 'WHOLESALE' : options[0].type
  const activeType = override?.priceType || defaultType
  const isCustom = activeType === 'CUSTOM'
  const activeOption = options.find((o) => o.type === activeType)
  const finalRate = isCustom
    ? (override?.finalRate ?? activeOption?.value)
    : (activeOption?.value ?? options[0].value)

  const selectType = (type) => {
    const opt = options.find((o) => o.type === type)
    onOverride(product.id, { priceType: type, finalRate: opt?.value ?? null })
  }
  const startEdit = () => {
    setDraft(String(finalRate ?? ''))
    setEditing(true)
  }
  const commitEdit = () => {
    const n = parseFloat(String(draft).replace(/[^0-9.]/g, ''))
    if (!isNaN(n) && n > 0) onOverride(product.id, { priceType: 'CUSTOM', finalRate: n })
    setEditing(false)
  }

  if (editing) {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-1 rounded-md border bg-white border-brand-300">
        <span className="opacity-70">₹</span>
        <input
          autoFocus
          type="number"
          inputMode="decimal"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitEdit}
          onKeyDown={(e) => e.key === 'Enter' && commitEdit()}
          className="w-14 text-[11px] outline-none border-b border-brand-300"
        />
      </span>
    )
  }

  return (
    <div className="flex flex-wrap items-center gap-1">
      {options.map((o) => {
        const isActive = !isCustom && activeType === o.type
        return (
          <button
            key={o.type}
            type="button"
            onClick={() => selectType(o.type)}
            className={`text-[10px] leading-none font-semibold px-1.5 py-1 rounded-md border ${
              isActive
                ? 'bg-brand-600 border-brand-600 text-white'
                : 'bg-slate-50 border-slate-200 text-slate-600'
            }`}
          >
            {o.type === 'WHOLESALE' ? 'WP' : o.type === 'RETAIL' ? 'RP' : 'MRP'} ₹{o.value}
          </button>
        )
      })}
      <button
        type="button"
        onClick={startEdit}
        className={`text-[10px] leading-none font-semibold px-1.5 py-1 rounded-md border ${
          isCustom
            ? 'bg-amber-50 border-amber-300 text-amber-800'
            : 'bg-white border-dashed border-slate-300 text-slate-400'
        }`}
      >
        {isCustom ? `✎ ₹${finalRate}` : '✎ Custom'}
      </button>
    </div>
  )
}

/**
 * Product row. Scheme products show BR/NR; all others show RP/WP.
 * Layout is tuned for one-hand use on a phone.
 */
function ProductCard({ product, qty, unit, onQty, onUnit, override, onOverride, lastPrice }) {
  const selected = qty > 0
  const badge = schemeBadge(product.slabs)
  const hasScheme = !!badge
  // Defaults ON (per spec) — only OFF when the rep has explicitly toggled it
  // for this order/line. This never touches the product's own configured
  // scheme; it's purely a per-order-line exception held in `override`.
  const schemeOff = override?.schemeEnabled === false
  const result = selected && !schemeOff ? calculateScheme(qty, product.slabs) : null

  // Effective prices: use a one-time override if the rep set one for this order.
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
      {/* Name + customer-specific last-sold-price reference badge.
          The badge is INFORMATION ONLY — it shows what this customer last paid
          for this product, to help reps keep pricing consistent. It never
          changes the selected price. Shown only when a price is known for this
          customer+product (undefined = no customer selected or never bought). */}
      <div className="flex items-start justify-between gap-2">
        <p className="text-[14px] leading-snug font-medium text-slate-800 break-words min-w-0">
          {product.name}
        </p>
        {lastPrice != null && (
          <span
            title="Last price this customer paid for this product"
            className="shrink-0 text-[10px] leading-none font-semibold text-slate-500 bg-slate-100 border border-slate-200 px-1.5 py-1 rounded-md whitespace-nowrap"
          >
            Last ₹{lastPrice}
          </span>
        )}
      </div>

      {/* Brand + scheme + price tags, all compact */}
      <div className="flex flex-wrap items-center gap-1 mt-1.5">
        {hasScheme && (
          <span className="text-[10px] leading-none font-semibold text-amber-700 bg-amber-50 border border-amber-200 px-1.5 py-1 rounded-md">
            🎁 {badge}
          </span>
        )}

        {/* MRP — shown only when a value exists (no placeholder otherwise). */}
        <Tag label="MRP" value={product.mrp} />

        {hasScheme ? (
          <>
            <EditableTag
              label="BR"
              value={override?.base != null ? override.base : product.base}
              overridden={override?.base != null}
              onChange={(v) => onOverride(product.id, { base: v })}
            />
            <EditableTag
              label="NR"
              value={override?.net != null ? override.net : currentNet}
              overridden={override?.net != null}
              accent
              onChange={(v) => onOverride(product.id, { net: v })}
            />
          </>
        ) : (
          <PriceSelector product={product} override={override} onOverride={onOverride} />
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

      {/* Live scheme feedback + per-order Scheme ON/OFF toggle */}
      {selected && hasScheme && (
        <div className="flex items-center justify-between mt-1.5">
          <p className="text-[11px] font-medium">
            {schemeOff ? (
              <span className="text-slate-400">Scheme off — {qty} only, no free qty</span>
            ) : result.free > 0 ? (
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
          <button
            type="button"
            onClick={() => onOverride(product.id, { schemeEnabled: schemeOff })}
            className={`shrink-0 text-[10px] font-bold px-2 py-1 rounded-full ${
              schemeOff ? 'bg-slate-100 text-slate-500' : 'bg-brand-50 text-brand-700'
            }`}
          >
            Scheme: {schemeOff ? 'OFF' : 'ON'}
          </button>
        </div>
      )}
    </div>
  )
}

export default memo(ProductCard)
