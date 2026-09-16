import { memo, useState } from 'react'
import QtyStepper from './QtyStepper.jsx'
import { schemeBadge, calculateScheme, netRate } from '../utils/schemes.js'
import { availableUnits, unitOptionLabel, toPieces } from '../utils/packaging.js'
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
 * Editable BOX·WP tag — same click-to-edit / pencil-icon interaction as
 * EditableTag, but deliberately does NOT hide when there's no price to show.
 * A product with no master wholesale value still needs to be orderable when
 * BOX is selected, so this shows "—" and stays clickable rather than
 * disappearing, matching the read-only fallback already used elsewhere for
 * a missing wholesale value.
 */
function EditableBoxTag({ value, overridden, onChange }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')

  const start = () => {
    setDraft(value != null ? String(value) : '')
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
        <span className="opacity-70">BOX · WP</span>
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
      title="Tap to set a custom price for this box order"
      className={`inline-flex items-baseline gap-0.5 text-[10px] leading-none font-semibold px-1.5 py-1 rounded-md border ${
        overridden ? 'bg-amber-50 border-amber-300 text-amber-800' : 'bg-brand-50 border-brand-200 text-brand-700'
      }`}
    >
      <span className="opacity-70">BOX · WP</span>
      {value != null ? <span>₹{value}{overridden && <span className="ml-0.5">•</span>}</span> : <span className="text-amber-600">—</span>}
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
function PriceSelector({ product, override, onOverride, lastPrice, defaultPriceType, onRemoveProduct }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  // Warning modal state: shown when rep selects LAST price but the official
  // price has changed since that last price was created (spec 61).
  const [showLastPriceWarning, setShowLastPriceWarning] = useState(false)

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

  // Default selection: the customer's own LAST price for this product wins when
  // one exists (a real prior sale to this exact customer), matching the
  // requirement that the default price equals the persistent last price. When
  // there is NO last price (never bought before / no customer), fall back to
  // the existing business rule — the customer's CATEGORY:
  //   FMCG - WHOLESALE STORE  -> Wholesale (WP)
  //   every other / no category -> Retail (RP)
  // then WHOLESALE, then first available. The rep can still override any of it.
  const preferred = defaultPriceType || 'RETAIL'
  const has = (t) => options.some((o) => o.type === t)
  const defaultType = has('LAST')
    ? 'LAST'
    : (has(preferred) ? preferred : (has('WHOLESALE') ? 'WHOLESALE' : options[0].type))
  const activeType = override?.priceType || defaultType
  const isCustom = activeType === 'CUSTOM'
  const activeOption = options.find((o) => o.type === activeType)
  const finalRate = isCustom
    ? (override?.finalRate ?? activeOption?.value)
    : (activeOption?.value ?? options[0].value)

  const selectType = (type) => {
    // When rep selects LAST price and the product's official price has changed
    // since that last price was set, show the two-option warning (spec 61).
    if (type === 'LAST' && lastPrice != null && product.price_increased) {
      const currentFloor = product.retail ?? product.wholesale ?? null
      const lastApprovedValid = product.last_approved_price != null &&
        product.last_approved_version === (product.price_version ?? 1) &&
        Math.abs(product.last_approved_price - lastPrice) < 0.01
      if (currentFloor != null && lastPrice < currentFloor - 0.001 && !lastApprovedValid) {
        setShowLastPriceWarning(true)
        return
      }
    }
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
    <>
    <div className="flex flex-wrap items-center gap-1">
      {options.map((o) => {
        const isActive = !isCustom && activeType === o.type
        // Show amber ⚠ on LAST chip only when it genuinely needs approval:
        // - price has increased since last order, AND
        // - lastPrice is below current floor, AND
        // - there's no existing valid Admin-approved price for current version
        const lastApprovedValid = product.last_approved_price != null &&
          product.last_approved_version != null &&
          product.last_approved_version === (product.price_version ?? 1) &&
          Math.abs(product.last_approved_price - (lastPrice ?? 0)) < 0.01
        const lastPriceNeedsApproval = o.type === 'LAST' && lastPrice != null &&
          product.price_increased &&
          (product.retail ?? product.wholesale ?? 0) > lastPrice + 0.001 &&
          !lastApprovedValid
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
                : (lastPriceNeedsApproval
                    ? 'bg-amber-50 border-amber-300 text-amber-800'
                    : o.type === 'LAST'
                    ? 'bg-emerald-50 border-emerald-300 text-emerald-700'
                    : 'bg-slate-50 border-slate-200 text-slate-600')
            }`}
          >
            {o.type === 'WHOLESALE' ? 'WP' : o.type === 'RETAIL' ? 'RP' : o.type === 'LAST' ? 'Last' : 'MRP'} ₹{o.value}
            {lastPriceNeedsApproval && ' ⚠'}
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

    {/* ── Last Price Warning Modal (spec §17-24) ──────────────────────────
        Fires when rep taps LAST chip and the official price has increased.
        Three choices: Remove product, Send for Admin Approval, or Cancel. */}
    {showLastPriceWarning && (
      <div className="fixed inset-0 z-[100] bg-black/50 flex items-end sm:items-center justify-center px-0 sm:px-4">
        <div className="bg-white w-full sm:max-w-sm rounded-t-3xl sm:rounded-3xl p-5 shadow-2xl">
          <div className="text-center mb-4">
            <div className="text-3xl mb-2">⚠️</div>
            <p className="font-bold text-slate-800 text-base">Price Updated</p>
            <p className="text-sm text-slate-500 mt-0.5">This product's price has increased</p>
          </div>

          <p className="font-semibold text-slate-700 text-sm text-center mb-3 truncate px-2">{product.name}</p>

          <div className="rounded-xl bg-amber-50 border border-amber-200 p-3 text-sm mb-4 space-y-1.5">
            <div className="flex justify-between items-center">
              <span className="text-slate-500">Your Selected Price</span>
              <span className="font-bold text-purple-700">₹{lastPrice}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-slate-500">Current Authorized Price</span>
              <span className="font-bold text-slate-800">₹{product.retail ?? product.wholesale ?? '—'}</span>
            </div>
            <div className="flex justify-between items-center border-t border-amber-200 pt-1.5 mt-1">
              <span className="text-slate-500">Difference</span>
              <span className="font-bold text-red-700">
                ₹{Math.abs((product.retail ?? product.wholesale ?? 0) - lastPrice).toFixed(2)} Below Current Price
              </span>
            </div>
          </div>

          <div className="space-y-2.5">
            <button
              onClick={() => {
                setShowLastPriceWarning(false)
                onRemoveProduct?.()
              }}
              className="w-full rounded-2xl border-2 border-slate-200 py-3 text-sm font-bold text-slate-700 active:bg-slate-50"
            >
              Remove Product &amp; Continue
            </button>
            <button
              onClick={() => {
                setShowLastPriceWarning(false)
                // Apply LAST price — evaluatePriceApproval at saveCloudOrder
                // time will detect it's below floor and set bill for Admin approval.
                const opt = options.find((o) => o.type === 'LAST')
                onOverride(product.id, { priceType: 'LAST', finalRate: opt?.value ?? lastPrice })
              }}
              className="w-full rounded-2xl bg-amber-500 text-white py-3 text-sm font-bold active:bg-amber-600"
            >
              Send for Admin Approval
            </button>
            <button
              onClick={() => setShowLastPriceWarning(false)}
              className="w-full text-sm text-slate-400 py-1.5 hover:text-slate-600"
            >
              Cancel — Go Back to Edit
            </button>
          </div>
        </div>
      </div>
    )}
    </>
  )
}

/**
 * Product row. Scheme products show BR/NR; all others show RP/WP.
 * Layout is tuned for one-hand use on a phone.
 */
function ProductCard({ product, qty, unit, onQty, onUnit, override, onOverride, lastPrice, defaultPriceType, inventory, onRemoveProduct }) {
  const selected = qty > 0
  const units = availableUnits(product)
  const stockStatus = inventoryStatus(inventory)
  const badge = schemeBadge(product.slabs)
  const hasScheme = !!badge
  // Defaults ON (per spec) — only OFF when the rep has explicitly toggled it
  // for this order/line. This never touches the product's own configured
  // scheme; it's purely a per-order-line exception held in `override`.
  const schemeOff = override?.schemeEnabled === false

  // BOX selected: this line bills at the master Wholesale Price regardless of
  // customer category (see the rate tags below and the matching rule in
  // OrderPage's finalSellingPrice).
  const boxSelected = unit === 'Box'

  // Scheme must be calculated on the PIECES actually ordered, not on the raw
  // entered number. Entering 1 Box of a 24-piece product with a 6+1 scheme is
  // 24 pieces -> 4 free, but calculating on the entered "1" would find no
  // scheme at all. The order itself already converts to pieces before saving,
  // so computing on the entered value here made the card disagree with what
  // was actually billed.
  const pieces = selected ? toPieces(product, qty, unit) : 0
  const result = selected && !schemeOff ? calculateScheme(pieces, product.slabs) : null

  // The rate the scheme works on top of: WP when Box is selected, otherwise
  // the product's base rate. This keeps the displayed Net Rate consistent with
  // the price the line will actually bill at.
  const rateBasis = boxSelected ? (override?.boxRate != null ? override.boxRate : product.wholesale) : product.base
  const currentNet =
    result?.slab && rateBasis != null && rateBasis !== ''
      ? netRate(rateBasis, result.slab.buy, result.slab.free)
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
            {boxSelected ? (
              // BOX on a scheme product: the line bills at the master
              // Wholesale Price, so show that as the rate basis rather than
              // the editable base rate. Now editable (pencil icon) — a
              // custom value writes to its OWN dedicated override (boxRate),
              // deliberately kept separate from the Piece-based finalRate
              // override the normal price selector uses. If it reused
              // finalRate, a custom Box price would leak into Piece pricing
              // the moment the rep switched the unit back, since nothing
              // clears that override on a unit change — boxRate is only ever
              // consulted while Box is selected, so switching back to Piece
              // cleanly reverts to normal pricing with no cross-contamination.
              // The NR tag below still reflects this same WP (custom or
              // master) as its rate basis, and the scheme's free quantity is
              // still calculated on the converted pieces — so what the card
              // shows and what the order bills keep agreeing.
              <EditableBoxTag
                value={override?.boxRate != null ? override.boxRate : product.wholesale}
                overridden={override?.boxRate != null}
                onChange={(v) => onOverride(product.id, { boxRate: v })}
              />
            ) : (
              <EditableTag
                label="BR"
                value={override?.base != null ? override.base : product.base}
                overridden={override?.base != null}
                onChange={(v) => onOverride(product.id, { base: v })}
              />
            )}
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
        ) : unit === 'Box' ? (
          // BOX selected: this line bills at the master Wholesale Price
          // regardless of customer category. Now editable (pencil icon) —
          // writes to its own dedicated boxRate override, kept separate from
          // the Piece-based finalRate override (see the scheme-branch
          // comment above for why: reusing finalRate would leak a custom
          // Box price into Piece pricing after switching units back).
          // Choosing Piece again brings the selector — and the customer's
          // normal pricing — straight back; boxRate is simply not consulted
          // once unit != Box.
          <EditableBoxTag
            value={override?.boxRate != null ? override.boxRate : product.wholesale}
            overridden={override?.boxRate != null}
            onChange={(v) => onOverride(product.id, { boxRate: v })}
          />
        ) : (
          <PriceSelector product={product} override={override} onOverride={onOverride} lastPrice={lastPrice} defaultPriceType={defaultPriceType} onRemoveProduct={onRemoveProduct} />
        )}
      </div>

      {/* ── Price Change Indicator ────────────────────────────────────────── */}
      {/* Shows when Admin has uploaded a new price via Excel and the official
          retail or wholesale price changed. Uses price_increased + previous_*
          fields stored during mergeUpdateCloudProducts — no extra query. */}
      {(() => {
        // Determine which applicable price changed
        const prevRetail    = product.previous_retail    ?? null
        const prevWholesale = product.previous_wholesale ?? null
        const curRetail     = product.retail ?? null
        const curWholesale  = product.wholesale ?? null
        const retailChanged    = prevRetail    != null && curRetail    != null && Math.abs(curRetail    - prevRetail)    > 0.001
        const wholesaleChanged = prevWholesale != null && curWholesale != null && Math.abs(curWholesale - prevWholesale) > 0.001
        const priceChanged = retailChanged || wholesaleChanged

        // % difference between current applicable price and last order price
        const applicablePrice = curRetail ?? curWholesale
        const pctRaw = (lastPrice != null && applicablePrice != null && lastPrice > 0)
          ? ((applicablePrice - lastPrice) / lastPrice) * 100
          : null
        // Round to 2 dp, strip trailing zeros
        const fmtPct = (n) => {
          const abs = Math.abs(n)
          if (abs < 0.01) return null
          const s = abs % 1 === 0 ? abs.toFixed(0) : abs.toFixed(2).replace(/\.?0+$/, '')
          return (n > 0 ? '+' : '-') + s + '%'
        }
        const pctStr = pctRaw != null ? fmtPct(pctRaw) : null
        const pctUp  = pctRaw != null && pctRaw > 0.01
        const pctDown = pctRaw != null && pctRaw < -0.01

        if (!priceChanged && !pctStr) return null

        return (
          <div className="mt-1.5 flex flex-wrap gap-1.5 items-center">
            {priceChanged && (
              <span
                className={`inline-flex items-center gap-1 text-[10px] leading-none font-bold px-1.5 py-1 rounded-md border ${
                  product.price_increased
                    ? 'text-red-700 bg-red-50 border-red-200'
                    : 'text-emerald-700 bg-emerald-50 border-emerald-200'
                }`}
                title={[
                  'Official price changed',
                  retailChanged    ? `Retail: ₹${prevRetail} → ₹${curRetail}` : '',
                  wholesaleChanged ? `Wholesale: ₹${prevWholesale} → ₹${curWholesale}` : ''
                ].filter(Boolean).join('\n')}
              >
                {product.price_increased ? '↑' : '↓'} PRICE {product.price_increased ? 'RAISED' : 'LOWERED'}
              </span>
            )}
            {pctStr && lastPrice != null && (
              <span
                className={`inline-flex items-center gap-0.5 text-[10px] leading-none font-semibold px-1.5 py-1 rounded-md border ${
                  pctUp   ? 'text-red-600 bg-red-50 border-red-200'
                  : pctDown ? 'text-emerald-700 bg-emerald-50 border-emerald-200'
                  : 'text-slate-500 bg-slate-50 border-slate-200'
                }`}
                title={`Last order price: ₹${lastPrice}  •  Current: ₹${applicablePrice}`}
              >
                {pctUp ? '↑' : pctDown ? '↓' : ''}
                {pctStr} from last order (₹{lastPrice})
              </span>
            )}
          </div>
        )
      })()}

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
