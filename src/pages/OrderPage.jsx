import { useState, useMemo, useCallback, useEffect } from 'react'
import { useApp } from '../context/AppContext.jsx'
import { useAuth } from '../context/AuthContext.jsx'
import { saveCloudOrder, currentUserId, countUnreadAnnouncements } from '../utils/cloudSync.js'
import PreviousOrdersModal from '../components/PreviousOrdersModal.jsx'
import { useSearch } from '../hooks/useSearch.js'
import { useDebounce } from '../hooks/useDebounce.js'
import CustomerPicker from '../components/CustomerPicker.jsx'
import ProductCard from '../components/ProductCard.jsx'
import OrderSummaryBar from '../components/OrderSummaryBar.jsx'
import BrandSelector from '../components/BrandSelector.jsx'
import { SearchIcon, CloseIcon, SettingsIcon, ReturnIcon, ChartIcon, BellIcon } from '../components/Icons.jsx'
import { buildOrderMessage, buildVisitMessage, buildWhatsappUrl } from '../utils/whatsapp.js'
import VisitStatus from '../components/VisitStatus.jsx'
import appIcon from '../assets/app_icon.png'

const getProductText = (p) => p.name

// ---- Working-session persistence (survives background reloads) ----
const SESSION_KEY = 'atl_order_session_v1'

function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY)
    if (!raw) return null
    const s = JSON.parse(raw)
    // Only restore if there is actual work in progress.
    const hasWork =
      s &&
      (s.customer ||
        (s.quantities && Object.keys(s.quantities).length) ||
        s.visitStatus)
    return hasWork ? s : null
  } catch {
    return null
  }
}

function saveSession(state) {
  try {
    const hasWork =
      state.customer ||
      (state.quantities && Object.keys(state.quantities).length) ||
      state.visitStatus
    if (hasWork) {
      localStorage.setItem(SESSION_KEY, JSON.stringify(state))
    } else {
      localStorage.removeItem(SESSION_KEY)
    }
  } catch {
    /* storage full or unavailable — ignore */
  }
}

function clearSession() {
  try {
    localStorage.removeItem(SESSION_KEY)
  } catch {
    /* ignore */
  }
}

export default function OrderPage({ onOpenSettings, onOpenReturns, onOpenPerformance, onOpenAnnouncements, unreadTick }) {
  const { settings, products, isIntroPending, clearIntro, saveVisit } = useApp()
  const { user, profile } = useAuth()

  // Restore any in-progress order that was interrupted (app switch, background
  // reload, screen lock). Mobile browsers often discard the page in the
  // background, so we persist the working session and rehydrate it here.
  const saved = loadSession()

  const [customer, setCustomer] = useState(saved?.customer ?? null)
  const [query, setQuery] = useState('')
  const [quantities, setQuantities] = useState(saved?.quantities ?? {}) // { id: qty }
  const [units, setUnits] = useState(saved?.units ?? {}) // { id: 'Piece'|'Box' }
  // One-time price overrides for THIS order only: { id: { retail?, wholesale? } }
  // Cleared on reset / new order / customer switch — never touches the DB.
  const [priceOverrides, setPriceOverrides] = useState(saved?.priceOverrides ?? {})
  const [toast, setToast] = useState('')
  const [visitStatus, setVisitStatus] = useState(saved?.visitStatus ?? '')
  const [visitRemark, setVisitRemark] = useState(saved?.visitRemark ?? '')
  const [gpsBusy, setGpsBusy] = useState(false)
  const [gpsFailed, setGpsFailed] = useState(false)
  const [unread, setUnread] = useState(0)
  const [showPrevOrders, setShowPrevOrders] = useState(false)
  // Product ids that came from a loaded previous order (the "original").
  // Anything ordered on top of these becomes an ADD-ON in the message.
  const [originalIds, setOriginalIds] = useState(
    saved?.originalIds ? new Set(saved.originalIds) : null
  )

  // Continuously persist the working session so nothing is lost if the browser
  // reloads the page after returning from another app.
  useEffect(() => {
    saveSession({
      customer,
      quantities,
      units,
      visitStatus,
      visitRemark,
      originalIds: originalIds ? Array.from(originalIds) : null,
      priceOverrides
    })
  }, [customer, quantities, units, visitStatus, visitRemark, originalIds, priceOverrides])

  const debounced = useDebounce(query, 120)
  const searching = debounced.trim().length > 0

  // Merge any products that share the same name into a single entry, combining
  // their scheme slabs. This guarantees a product appears only ONCE even if the
  // catalogue stored its schemes as separate rows/products. Prices come from the
  // first entry that has them; slabs are concatenated (de-duplicated).
  const groupedProducts = useMemo(() => {
    const byName = new Map()
    const order = []
    products.forEach((p) => {
      const key = (p.name || '').trim().toUpperCase()
      let g = byName.get(key)
      if (!g) {
        g = {
          ...p,
          slabs: Array.isArray(p.slabs) ? [...p.slabs] : [],
          net: Array.isArray(p.net) ? [...p.net] : []
        }
        byName.set(key, g)
        order.push(g)
      } else {
        // Merge schemes from this duplicate into the existing card.
        if (Array.isArray(p.slabs)) {
          p.slabs.forEach((slab, idx) => {
            const dup = g.slabs.some((s) => s[0] === slab[0] && s[1] === slab[1])
            if (!dup) {
              g.slabs.push(slab)
              if (Array.isArray(p.net) && p.net[idx] != null) g.net.push(p.net[idx])
            }
          })
        }
        // Fill any missing prices from the duplicate.
        if (g.mrp == null && p.mrp != null) g.mrp = p.mrp
        if (g.retail == null && p.retail != null) g.retail = p.retail
        if (g.wholesale == null && p.wholesale != null) g.wholesale = p.wholesale
        if (g.base == null && p.base != null) g.base = p.base
      }
    })
    // Keep slabs sorted by buy quantity for a tidy badge.
    order.forEach((g) => g.slabs.sort((a, b) => a[0] - b[0]))
    return order
  }, [products])

  // Search over the GROUPED list so results also show one card per product.
  const searchResults = useSearch(groupedProducts, debounced, getProductText, 80)

  // Lookup by exact product name (for reloading previous orders).
  const productByName = useMemo(() => {
    const m = new Map()
    groupedProducts.forEach((p) => m.set(p.name.toUpperCase(), p))
    return m
  }, [groupedProducts])

  const productMap = useMemo(() => {
    const m = new Map()
    groupedProducts.forEach((p) => m.set(p.id, p))
    return m
  }, [groupedProducts])

  const visibleProducts = useMemo(() => {
    if (searching) return searchResults
    const ids = Object.keys(quantities).filter((id) => quantities[id] > 0)
    const chosen = ids.map((id) => productMap.get(id)).filter(Boolean)
    const set = new Set(ids)
    return [...chosen, ...groupedProducts.filter((p) => !set.has(p.id)).slice(0, 50)]
  }, [searching, searchResults, quantities, productMap, groupedProducts])

  // Load a previous cloud order into the current cart. Items whose products
  // still exist are added; missing ones are counted for a small notice.
  const loadPreviousOrder = useCallback(
    (order) => {
      const nextQ = {}
      const nextU = {}
      let missing = 0
      ;(order.order_items || []).forEach((it) => {
        const prod = productByName.get((it.product_name || '').toUpperCase())
        if (prod) {
          nextQ[prod.id] = (nextQ[prod.id] || 0) + it.qty
          nextU[prod.id] = it.unit || 'Piece'
        } else {
          missing += 1
        }
      })
      setQuantities(nextQ)
      setUnits(nextU)
      setOriginalIds(new Set(Object.keys(nextQ)))
      setShowPrevOrders(false)
      const loaded = Object.keys(nextQ).length
      setToast(
        missing > 0
          ? `Loaded ${loaded} item(s); ${missing} no longer in catalogue`
          : `Loaded ${loaded} item(s) — edit or add more, then send`
      )
      setTimeout(() => setToast(''), 3200)
    },
    [productByName]
  )

  const onQty = useCallback((id, val) => {
    setQuantities((prev) => {
      const next = { ...prev }
      if (val > 0) next[id] = val
      else delete next[id]
      return next
    })
  }, [])


  const onOverride = useCallback((id, patch) => {
    setPriceOverrides((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }))
  }, [])

  const onUnit = useCallback((id, val) => {
    setUnits((prev) => ({ ...prev, [id]: val }))
  }, [])

  const items = useMemo(
    () =>
      Object.keys(quantities)
        .map((id) => {
          const p = productMap.get(id)
          if (!p) return null
          return {
            id,
            name: p.name,
            qty: quantities[id],
            unit: units[id] || 'Piece',
            slabs: p.slabs,
            // Add-on = added after loading a previous order.
            isAddon: originalIds ? !originalIds.has(id) : false,
            retail: priceOverrides[id]?.retail != null ? priceOverrides[id].retail : p.retail,
            wholesale: priceOverrides[id]?.wholesale != null ? priceOverrides[id].wholesale : p.wholesale,
            base: priceOverrides[id]?.base != null ? priceOverrides[id].base : p.base,
            netOverride: priceOverrides[id]?.net != null ? priceOverrides[id].net : null,
            retailOverridden: priceOverrides[id]?.retail != null,
            wholesaleOverridden: priceOverrides[id]?.wholesale != null,
            baseOverridden: priceOverrides[id]?.base != null,
            netOverridden: priceOverrides[id]?.net != null,
            priceOverridden:
              priceOverrides[id]?.retail != null ||
              priceOverrides[id]?.wholesale != null ||
              priceOverrides[id]?.base != null ||
              priceOverrides[id]?.net != null
          }
        })
        .filter(Boolean),
    [quantities, units, productMap, originalIds, priceOverrides]
  )

  // Only treat as an add-on order if a previous order was loaded AND at least
  // one new item was added on top of it.
  const hasAddons = !!originalIds && items.some((i) => i.isAddon)

  const totalQty = items.reduce((s, i) => s + i.qty, 0)
  const isVisit = !!visitStatus
  // "Others" needs a remark before it can be saved.
  const visitReady = isVisit && (visitStatus !== 'Other' || visitRemark.trim().length > 0)
  const canSend = customer && items.length > 0

  /**
   * Changing customer clears the in-progress order so items never carry
   * over to the next shop. Confirm first if there is unsent work.
   */
  const handleSelectCustomer = (c) => {
    if (customer && c?.id !== customer.id && items.length > 0) {
      const ok = window.confirm(
        `Switching customer will clear ${items.length} item(s) from this order. Continue?`
      )
      if (!ok) return
    }
    setQuantities({})
    setUnits({})
    setPriceOverrides({})
    setOriginalIds(null)
    setVisitStatus('')
    setVisitRemark('')
    setCustomer(c)
    // Offer to reload this shop's previous orders (cloud lookup).
    if (c) setShowPrevOrders(true)
  }

  // A newly created customer's details ride along with their FIRST order only.
  const showIntro = !!customer && isIntroPending(customer.id)

  const message = (location) =>
    buildOrderMessage({
      brand: settings.brand,
      customer,
      salesperson: profile?.full_name || settings.salesperson,
      items,
      isNewCustomer: showIntro,
      location
    })

  useEffect(() => {
    let active = true
    countUnreadAnnouncements().then((n) => {
      if (active) setUnread(n)
    })
    return () => {
      active = false
    }
  }, [unreadTick])

  const getLocation = () =>
    new Promise((resolve) => {
      if (!navigator.geolocation) return resolve({})
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({ latitude: pos.coords.latitude, longitude: pos.coords.longitude }),
        () => resolve({}),
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 }
      )
    })

  const handleVisit = async () => {
    if (!customer || !visitReady) return
    const loc = await getLocation()
    const visit = {
      customer_id: customer.id,
      customer_name: customer.name,
      route: customer.route,
      salesperson: profile?.full_name || settings.salesperson,
      visit_status: visitStatus,
      custom_remark: visitStatus === 'Other' ? visitRemark.trim() : '',
      ...loc
    }
    await saveVisit(visit)
    // Also persist to cloud (rep-attributed). Fresh id at save time.
    try {
      const uid = (await currentUserId()) || user.id
      await import('../utils/cloudSync.js').then((m) =>
        m.saveCloudVisit({
          customer,
          userId: uid,
          visitStatus,
          remark: visit.custom_remark,
          location: loc
        })
      )
    } catch (e) {
      console.error('cloud visit save failed', e)
    }
    const msg = buildVisitMessage({
      brand: settings.brand,
      customer,
      salesperson: profile?.full_name || settings.salesperson,
      visit
    })
    window.open(buildWhatsappUrl(msg), '_blank')
    // Reset for next customer.
    setVisitStatus('')
    setVisitRemark('')
    setCustomer(null)
    clearSession()
    setToast('Visit recorded')
    setTimeout(() => setToast(''), 2600)
  }

  const handleCopyVisit = async () => {
    if (!customer || !visitReady) return
    // Capture GPS and build the SAME message as Save Visit (with location line).
    const loc = await getLocation()
    const visit = {
      visit_status: visitStatus,
      custom_remark: visitStatus === 'Other' ? visitRemark.trim() : '',
      ...loc
    }
    const text = buildVisitMessage({
      brand: settings.brand,
      customer,
      salesperson: profile?.full_name || settings.salesperson,
      visit
    })
    try {
      await navigator.clipboard.writeText(text)
      setToast(loc?.latitude != null ? 'Visit copied' : 'Copied — location not captured')
    } catch {
      setToast('Copy failed')
    }
    setTimeout(() => setToast(''), 2600)
  }

  // Every order attempts to capture current GPS. Soft policy: if it fails we
  // warn and let the rep retry, but never block the sale. A failed capture is
  // stamped 'Not captured' in the message for accountability.
  const dispatchOrder = async (viaCopy) => {
    if (!canSend) return
    setGpsBusy(true)
    setToast('Getting location…')
    const loc = await getLocation()
    setGpsBusy(false)
    setToast('')
    const ok = loc && loc.latitude != null
    setGpsFailed(!ok)
    const text = message(ok ? loc : null)

    // Persist the order to Supabase (rep-attributed; PII stays local).
    // Use the FRESH authenticated id at save time to avoid stale attribution.
    try {
      const uid = (await currentUserId()) || user.id
      await saveCloudOrder({
        customer,
        brand: settings.brand,
        userId: uid,
        items,
        location: ok ? loc : null
      })
    } catch (e) {
      console.error('cloud order save failed', e)
    }
    if (viaCopy) {
      try {
        await navigator.clipboard.writeText(text)
        setToast(ok ? 'Order copied' : 'Copied — location not captured')
      } catch {
        setToast('Copy failed')
      }
      setTimeout(() => setToast(''), 2600)
    } else {
      window.open(buildWhatsappUrl(text), '_blank')
    }
    if (showIntro) clearIntro(customer.id)
    // Order has been dispatched — the working session is no longer "unsaved".
    clearSession()
  }

  const handleSend = () => dispatchOrder(false)

  const handleCopy = () => dispatchOrder(true)

  return (
    <div className="min-h-screen bg-slate-50 pb-44">
      <header className="sticky top-0 z-20 bg-white/95 backdrop-blur border-b border-slate-100 safe-top">
        <div className="mx-auto max-w-md px-3 py-2 flex items-center gap-2">
          <img src={appIcon} alt="" className="h-8 w-8 rounded-lg object-contain" />
          <BrandSelector />
          <div className="flex-1" />
          <button
            onClick={onOpenAnnouncements}
            aria-label="Announcements"
            className="relative h-10 w-10 rounded-full flex items-center justify-center text-slate-500 active:bg-slate-100"
          >
            <BellIcon className="h-6 w-6" />
            {unread > 0 && (
              <span className="absolute top-1 right-1 min-w-[16px] h-4 px-1 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center">
                {unread > 9 ? '9+' : unread}
              </span>
            )}
          </button>
          <button
            onClick={onOpenPerformance}
            aria-label="My performance"
            className="h-10 w-10 rounded-full flex items-center justify-center text-slate-500 active:bg-slate-100"
          >
            <ChartIcon className="h-6 w-6" />
          </button>
          <button
            onClick={onOpenReturns}
            aria-label="Customer returns"
            className="flex items-center gap-1 h-10 px-2.5 rounded-lg text-slate-600 border border-slate-200 active:bg-slate-100"
          >
            <ReturnIcon className="h-5 w-5" />
            <span className="text-xs font-semibold">Return</span>
          </button>
          <button
            onClick={onOpenSettings}
            aria-label="Settings"
            className="h-10 w-10 rounded-full flex items-center justify-center text-slate-500 active:bg-slate-100"
          >
            <SettingsIcon className="h-6 w-6" />
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-md px-3 pt-3 space-y-3">
        <CustomerPicker selected={customer} onSelect={handleSelectCustomer} />

        {showIntro && (
          <div className="rounded-xl bg-blue-50 border border-blue-200 px-3 py-2">
            <p className="text-[12px] text-blue-800 font-medium">
              🆕 New customer — their details will be included with this first order.
            </p>
          </div>
        )}

        {originalIds && (
          <div className="rounded-xl bg-indigo-50 border border-indigo-200 px-3 py-2">
            <p className="text-[12px] text-indigo-800 font-medium">
              📋 Editing a loaded order. New items you add will be sent under an <b>ADD-ONS</b> section.
            </p>
          </div>
        )}

        {gpsFailed && (
          <div className="rounded-xl bg-amber-50 border border-amber-200 px-3 py-2 flex items-center justify-between gap-2">
            <p className="text-[12px] text-amber-800 font-medium">
              📍 Location not captured. Enable GPS and resend for accurate tracking.
            </p>
          </div>
        )}

        {customer && (
          <VisitStatus
            value={visitStatus}
            remark={visitRemark}
            onChange={setVisitStatus}
            onRemark={setVisitRemark}
            onCopy={handleCopyVisit}
          />
        )}

        <div className="flex items-center gap-2 rounded-2xl bg-white shadow-card border border-slate-100 px-4 sticky top-[52px] z-10">
          <SearchIcon className="h-5 w-5 text-slate-400 shrink-0" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search Products..."
            className="flex-1 py-3.5 text-[15px] outline-none placeholder:text-slate-400"
          />
          {query && (
            <button onClick={() => setQuery('')} className="text-slate-400 p-1" aria-label="Clear">
              <CloseIcon className="h-5 w-5" />
            </button>
          )}
        </div>

        <div className="space-y-2.5">
          {!searching && items.length > 0 && (
            <p className="text-xs font-semibold text-brand-600 px-1 pt-1">
              SELECTED ({items.length})
            </p>
          )}

          {visibleProducts.map((p) => (
            <ProductCard
              key={p.id}
              product={p}
              qty={quantities[p.id] || 0}
              override={priceOverrides[p.id]}
              onOverride={onOverride}
              unit={units[p.id] || 'Piece'}
              onQty={onQty}
              onUnit={onUnit}
            />
          ))}

          {searching && searchResults.length === 0 && (
            <div className="text-center text-slate-400 py-10 text-sm">
              No products match “{debounced}”.
            </div>
          )}

          {!searching && (
            <p className="text-center text-xs text-slate-400 py-4">
              Search above to find any of {products.length} products.
            </p>
          )}
        </div>
      </main>

      {showPrevOrders && customer && (
        <PreviousOrdersModal
          customer={customer}
          onClose={() => setShowPrevOrders(false)}
          onLoad={loadPreviousOrder}
        />
      )}

      <OrderSummaryBar
        customer={customer}
        productCount={items.length}
        totalQty={totalQty}
        disabled={!canSend}
        onSend={handleSend}
        onCopy={handleCopy}
        isVisit={isVisit}
        visitReady={visitReady}
        onSaveVisit={handleVisit}
      />


      {toast && (
        <div className="fixed bottom-44 left-1/2 -translate-x-1/2 bg-slate-900 text-white text-sm px-4 py-2.5 rounded-full shadow-pop z-50">
          {toast}
        </div>
      )}
    </div>
  )
}
