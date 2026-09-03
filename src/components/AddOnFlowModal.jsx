import { useState, useMemo, useCallback } from 'react'
import { useApp } from '../context/AppContext.jsx'
import { useAuth } from '../context/AuthContext.jsx'
import { saveCloudOrder, currentUserId, notifyBillingOfAddon } from '../utils/cloudSync.js'
import { buildAddOnMessage } from '../utils/whatsapp.js'
import { useSearch } from '../hooks/useSearch.js'
import { useDebounce } from '../hooks/useDebounce.js'
import ProductCard from './ProductCard.jsx'
import { CloseIcon } from './Icons.jsx'

const rupee = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`

/**
 * Dedicated "add products to an existing order" flow — reached from the
 * ADD-ON button on an Orders Taken card. Deliberately does NOT reload the
 * original order into the normal cart: the rep only ever sees and edits the
 * NEW products being added here. Reuses ProductCard (the same search-result
 * row used on the main order screen) so pricing overrides and the per-line
 * scheme toggle work identically to normal ordering — no separate logic to
 * keep in sync.
 *
 * On submit, this calls saveCloudOrder with ONLY the newly selected items,
 * flagged isAddon: true — a new order row that groups with the original via
 * the app's existing same-shop/same-day grouping (consolidateOrdersByVisit),
 * exactly like reopening a previous order already does today. The original
 * order's own row/items are never touched, so nothing is overwritten.
 */
export default function AddOnFlowModal({ order, userId, onClose, onSaved }) {
  const { products, settings } = useApp()
  const { profile } = useAuth()

  const [query, setQuery] = useState('')
  const debouncedQuery = useDebounce(query, 150)
  const [quantities, setQuantities] = useState({})
  const [units, setUnits] = useState({})
  const [priceOverrides, setPriceOverrides] = useState({})
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [done, setDone] = useState(false)

  const results = useSearch(products || [], debouncedQuery, (p) => p.name, 40)

  const onQty = useCallback((id, val) => {
    setQuantities((prev) => {
      const next = { ...prev }
      if (val <= 0) delete next[id]
      else next[id] = val
      return next
    })
  }, [])
  const onUnit = useCallback((id, val) => {
    setUnits((prev) => ({ ...prev, [id]: val }))
  }, [])
  const onOverride = useCallback((id, patch) => {
    setPriceOverrides((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }))
  }, [])

  // The NEW items only — built exactly like OrderPage's own items, including
  // the same Final Selling Price rule (manual edit wins, else Retail) and the
  // same per-line scheme toggle, so an add-on is billed identically to a
  // normal order line.
  const productMap = useMemo(() => new Map((products || []).map((p) => [p.id, p])), [products])
  const items = useMemo(() =>
    Object.keys(quantities).map((id) => {
      const p = productMap.get(id)
      if (!p) return null
      const qty = quantities[id]
      return {
        id,
        name: p.name,
        qty,
        unit: units[id] || 'Piece',
        slabs: p.slabs,
        isAddon: true, // every line here is, by definition, an add-on
        retail: priceOverrides[id]?.retail != null ? priceOverrides[id].retail : p.retail,
        wholesale: priceOverrides[id]?.wholesale != null ? priceOverrides[id].wholesale : p.wholesale,
        base: priceOverrides[id]?.base != null ? priceOverrides[id].base : p.base,
        netOverride: priceOverrides[id]?.net != null ? priceOverrides[id].net : null,
        finalSellingPrice:
          priceOverrides[id]?.net != null ? priceOverrides[id].net :
          priceOverrides[id]?.base != null ? priceOverrides[id].base :
          priceOverrides[id]?.wholesale != null ? priceOverrides[id].wholesale :
          priceOverrides[id]?.retail != null ? priceOverrides[id].retail :
          (p.retail != null ? p.retail : null),
        normalPrice: p.retail != null ? p.retail : null,
        schemeEnabled: priceOverrides[id]?.schemeEnabled !== false
      }
    }).filter(Boolean),
    [quantities, units, productMap, priceOverrides]
  )

  const totalQty = items.reduce((s, i) => s + i.qty, 0)
  const totalValue = items.reduce((s, i) => s + (i.finalSellingPrice || 0) * i.qty, 0)

  const [copyFailed, setCopyFailed] = useState(false)
  // Visible diagnostic for the Billing-alert step (build v77).
  const [notifyNote, setNotifyNote] = useState('')

  const onSubmit = async () => {
    if (items.length === 0) return
    setSaving(true)
    setSaveError('')
    try {
      const uid = (await currentUserId()) || userId
      const addOnDate = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
      const savedOrderId = await saveCloudOrder({
        customer: { name: order.shop_name, route: order.route },
        brand: settings?.brand,
        userId: uid,
        items,
        location: null,
        orderDate: addOnDate,
        route: order.route
      })

      // Tell Billing immediately that a product was added to an existing
      // order. This is THE add-on path — it calls saveCloudOrder directly, so
      // it never passed through the notification hook that lives in
      // OrderPage's dispatch flow, which is why no add-on alert was ever
      // created. Fire-and-forget: the add-on is already saved and must never
      // be rolled back over a notification.
      try {
        const ann = await notifyBillingOfAddon({
          shopName: order.shop_name,
          route: order.route,
          addonLines: items.map((i) => ({ name: i.name, qty: i.qty, unit: i.unit || 'Piece' })),
          repName: profile?.full_name || '—',
          orderId: savedOrderId
        })
        // notifyBillingOfAddon returns null when it gives up early (e.g. no
        // billing recipients could be resolved). That used to be invisible —
        // console-only — which is why this failure went unexplained for so
        // long. Surface it on screen instead so it can be diagnosed from the
        // phone without opening developer tools.
        if (!ann) {
          setNotifyNote('Add-on saved, but the Billing alert was not created (no recipients resolved).')
        } else {
          setNotifyNote('')
        }
      } catch (nErr) {
        console.error('Add-on notification to billing FAILED (the add-on itself saved fine).', nErr)
        setNotifyNote(`Add-on saved, but the Billing alert failed: ${nErr?.message || nErr}`)
      }
      // "Send Add-On" both saves AND copies — a WhatsApp-ready message
      // listing ONLY the add-on items just sent, headed "ADD-ON", never the
      // original order's products.
      try {
        const text = buildAddOnMessage({
          brand: settings?.brand,
          customer: { name: order.shop_name, route: order.route },
          salesperson: profile?.full_name,
          items,
          orderDate: addOnDate
        })
        await navigator.clipboard.writeText(text)
      } catch (e) {
        console.error('add-on message copy failed', e)
        setCopyFailed(true)
      }
      setDone(true)
      onSaved?.()
    } catch (e) {
      console.error('add-on save failed', e)
      setSaveError('Could not save the add-on. Try again.')
    } finally {
      setSaving(false)
    }
  }

  if (done) {
    const retryCopy = async () => {
      try {
        const text = buildAddOnMessage({
          brand: settings?.brand,
          customer: { name: order.shop_name, route: order.route },
          salesperson: profile?.full_name,
          items,
          orderDate: new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
        })
        await navigator.clipboard.writeText(text)
        setCopyFailed(false)
      } catch (e) {
        console.error('retry copy failed', e)
      }
    }
    return (
      <div className="fixed inset-0 z-[70] bg-black/40 flex items-end sm:items-center justify-center">
        <div className="bg-white w-full sm:max-w-sm rounded-t-3xl sm:rounded-3xl p-5 text-center">
          <p className="text-lg font-bold text-brand-700 mb-1">Add-On Sent ✅</p>
          <p className="text-sm text-slate-500 mb-4">
            {items.length} product{items.length === 1 ? '' : 's'} added to {order.shop_name}'s order
            {copyFailed ? '.' : ' — message copied, ready to paste.'} The original order was not changed.
          </p>
          {copyFailed && (
            <button onClick={retryCopy} className="w-full rounded-xl border border-slate-200 py-3 font-semibold text-slate-600 mb-2">
              Copy Add-On Message
            </button>
          )}
          <button onClick={onClose} className="w-full rounded-xl bg-brand-600 text-white py-3 font-bold active:bg-brand-700">
            Done
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-[70] bg-black/40 flex items-end sm:items-center justify-center">
      <div className="bg-white w-full sm:max-w-lg rounded-t-3xl sm:rounded-3xl max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100">
          <div className="min-w-0">
            <h2 className="font-bold text-slate-800">Add-On</h2>
            <p className="text-xs text-slate-400 truncate">{order.shop_name} — original order stays as-is</p>
          </div>
          <button onClick={onClose} className="p-2 text-slate-400" aria-label="Close">
            <CloseIcon className="h-5 w-5" />
          </button>
        </div>

        <div className="px-4 py-3 border-b border-slate-100">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search products to add…"
            autoFocus
            className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-brand-500"
          />
        </div>

        <div className="overflow-y-auto px-4 py-3 scroll-area flex-1">
          {results.map((p) => (
            <div key={p.id} className="mb-2">
              <ProductCard
                product={p}
                qty={quantities[p.id] || 0}
                unit={units[p.id] || 'Piece'}
                onQty={onQty}
                onUnit={onUnit}
                override={priceOverrides[p.id]}
                onOverride={onOverride}
              />
            </div>
          ))}
          {debouncedQuery && results.length === 0 && (
            <p className="text-sm text-slate-400 text-center py-8">No products found.</p>
          )}
        </div>

        {items.length > 0 && (
          <div className="border-t border-slate-100 p-4">
            <div className="flex items-center justify-between mb-2 text-sm">
              <span className="text-slate-500">{items.length} product{items.length === 1 ? '' : 's'} · {totalQty} qty</span>
              <span className="font-bold text-brand-700">{rupee(totalValue)}</span>
            </div>
            {saveError && <p className="text-xs text-red-600 mb-2">{saveError}</p>}
            {/* Billing-alert diagnostic. The add-on itself is already saved by
                this point; this only reports whether the notification to
                Billing was created, so a silent failure is visible on the
                device instead of console-only. */}
            {notifyNote && <p className="text-xs text-amber-700 mb-2">{notifyNote}</p>}
            <p className="text-[10px] text-slate-400 mb-1">build v77</p>
            <button
              onClick={onSubmit}
              disabled={saving}
              className="w-full rounded-xl bg-brand-600 text-white py-3.5 font-bold active:bg-brand-700 disabled:opacity-50"
            >
              {saving ? 'Sending…' : `Send Add-On (${items.length})`}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
