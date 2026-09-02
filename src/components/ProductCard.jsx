import { memo, useState } from 'react'
import QtyStepper from './QtyStepper.jsx'
import { schemeBadge, calculateScheme, netRate } from '../utils/schemes.js'
import { availableUnits, unitOptionLabel } from '../utils/packaging.js'
import { inventoryStatus, STATUS_DOT } from '../utils/inventoryStatus.js'

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
function PriceSelector({ product, override, onOverride, lastPrice, defaultPriceType }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')

  // Selectable price options. MRP is deliberately NOT offered as a
  // selectable chip — it is already shown once as a display-only tag on the
  // card, and having it in both places was a confusing duplicate.
  //
  // The one exception is a product that has NO retail and NO wholesale price:
  // dropping MRP there would leave the selector with nothing to choose and it
  // would render nothing at all, so the rep could not price the line. In that
  // case only, MRP is kept so the product stays orderable.
  const sellingOptions = [
    { type: 'RETAIL', value: product.retail },
    { type: 'WHOLESALE', value: product.wholesale },
    // "Last Price" — this customer's most recent price for this product. Only
    // present when a last price is known (undefined = no customer selected or
    // never purchased), so it simply doesn't appear otherwise. It's a full
    // selectable option like the rest: selecting it stores priceType 'LAST' +
    // finalRate = lastPrice, which flows to Billing unchanged.
    { type: 'LAST', value: lastPrice }
  ].filter((o) => o.value != null && o.value !== '')

  const options = sellingOptions.length > 0
    ? sellingOptions
    : [{ type: 'MRP', value: product.mrp }].filter((o) => o.value != null && o.value !== '')

  if (options.length === 0) return null

  // Default selection is driven by the CUSTOMER'S CATEGORY (business rule):
  //   FMCG - WHOLESALE STORE  -> Wholesale (WP)
  //   every other / no category -> Retail (RP)
  // `defaultPriceType` carries that decision in from the selected customer.
  // Fall back gracefully if the preferred price is missing for this product:
  // preferred -> WHOLESALE -> first available. The rep can still override.
  const preferred = defaultPriceType || 'RETAIL'
  const has = (t) => options.some((o) => o.type === t)
  const defaultType = has(preferred)
    ? preferred
    : (has('WHOLESALE') ? 'WHOLESALE' : options[0].type)
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
                ? (o.type === 'LAST'
                    ? 'bg-emerald-600 border-emerald-600 text-white'
                    : 'bg-brand-600 border-brand-600 text-white')
                : (o.type === 'LAST'
                    ? 'bg-emerald-50 border-emerald-300 text-emerald-700'
                    : 'bg-slate-50 border-slate-200 text-slate-600')
            }`}
          >
            {o.type === 'WHOLESALE' ? 'WP' : o.type === 'RETAIL' ? 'RP' : o.type === 'LAST' ? 'Last' : 'MRP'} ₹{o.value}
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
function ProductCard({ product, qty, unit, onQty, onUnit, override, onOverride, lastPrice, defaultPriceType, inventory }) {
  const selected = qty > 0
  const units = availableUnits(product)
  const stockStatus = inventoryStatus(inventory)
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
      {/* Name */}
      <p className="text-[14px] leading-snug font-medium text-slate-800 break-words">
        {product.name}
      </p>

      {/* Brand + scheme + price tags, all compact */}
      <div className="flex flex-wrap items-center gap-1 mt-1.5">
        {/* Live stock status. Neutral "Stock Not Updated" when the Purchase
            Manager hasn't initialized this product — never red/orange/green,
            never shown as 0. Otherwise a small colored pill with the count. */}
        {stockStatus.state === 'NOT_INITIALIZED' ? (
          <span className="text-[10px] leading-none font-semibold text-slate-400 bg-slate-50 border border-slate-200 px-1.5 py-1 rounded-md">
            Stock Not Updated
          </span>
        ) : (
          <span className={`text-[10px] leading-none font-semibold px-1.5 py-1 rounded-md border ${
            stockStatus.state === 'OUT' ? 'text-red-700 bg-red-50 border-red-200'
              : stockStatus.state === 'LOW' ? 'text-amber-700 bg-amber-50 border-amber-200'
              : 'text-emerald-700 bg-emerald-50 border-emerald-200'
          }`}>
            {STATUS_DOT[stockStatus.state]} {stockStatus.label} · {stockStatus.stock}
          </span>
        )}

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
            {schemeOff ? (
              // Scheme OFF: the Net Rate no longer applies (there are no free
              // units to average in), so show the product's Wholesale Price
              // from the master file instead. Read-only — it is a master
              // value, not a per-order override.
              //
              // Rendered with an explicit dash when the master file has no
              // wholesale value for this product, rather than using <Tag>
              // (which hides itself when empty). Silently showing nothing made
              // it look like the feature was broken when the real cause was a
              // blank Wholesale column in the master file.
              <span className="inline-flex items-baseline gap-0.5 text-[10px] leading-none font-semibold px-1.5 py-1 rounded-md border bg-slate-50 border-slate-200 text-slate-600">
                <span className="opacity-70">WP</span>
                {product.wholesale != null && product.wholesale !== ''
                  ? <span>₹{product.wholesale}</span>
                  : <span className="text-amber-600">—</span>}
              </span>
            ) : (
              <EditableTag
                label="NR"
                value={override?.net != null ? override.net : currentNet}
                overridden={override?.net != null}
                accent
                onChange={(v) => onOverride(product.id, { net: v })}
              />
            )}
          </>
        ) : (
          <PriceSelector product={product} override={override} onOverride={onOverride} lastPrice={lastPrice} defaultPriceType={defaultPriceType} />
        )}
      </div>

      {/* Controls */}
      <div className="flex items-center justify-between gap-2 mt-2">
        <select
          value={units.includes(unit) ? unit : 'Piece'}
          onChange={(e) => onUnit(product.id, e.target.value)}
          className="h-10 max-w-[10rem] rounded-lg border border-slate-200 bg-white pl-2 pr-1 text-xs text-slate-600 outline-none focus:border-brand-500"
          aria-label="Quantity type"
        >
          {units.map((u) => (
            <option key={u} value={u}>
              {unitOptionLabel(product, u)}
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
