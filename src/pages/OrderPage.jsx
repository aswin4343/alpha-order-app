import { useState, useMemo, useCallback, useEffect } from 'react'
import { useApp } from '../context/AppContext.jsx'
import { useAuth } from '../context/AuthContext.jsx'
import { saveCloudOrder, currentUserId, countUnreadAnnouncements, listAllRoutes, ensureCloudCustomer, updateCustomerDefaultRoute } from '../utils/cloudSync.js'
import PreviousOrdersModal from '../components/PreviousOrdersModal.jsx'
import OrderSummaryModal from '../components/OrderSummaryModal.jsx'
import { useSearch } from '../hooks/useSearch.js'
import { useDebounce } from '../hooks/useDebounce.js'
import CustomerPicker from '../components/CustomerPicker.jsx'
import ProductCard from '../components/ProductCard.jsx'
import OrderSummaryBar from '../components/OrderSummaryBar.jsx'
import BrandSelector from '../components/BrandSelector.jsx'
import { SearchIcon, CloseIcon, SettingsIcon, ReturnIcon, ChartIcon, BellIcon } from '../components/Icons.jsx'
import { buildOrderMessage, buildVisitMessage, buildWhatsappUrl } from '../utils/whatsapp.js'
import VisitStatus from '../components/VisitStatus.jsx'
import EnablePushBanner from '../components/EnablePushBanner.jsx'
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
  const { settings, products, isIntroPending, clearIntro, saveVisit, updateCustomer } = useApp()
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
  const [sending, setSending] = useState(false) // blocks double-submit
  const [visitBusy, setVisitBusy] = useState(false) // blocks double-tap on Copy/Save Visit
  const [gpsFailed, setGpsFailed] = useState(false)
  // #1 Order date — always defaults to TODAY (in IST, not UTC — a rep working
  // late evening should not get tomorrow's date, and vice versa near
  // midnight). The rep can still deliberately pick a different date.
  //
  // A restored draft's own orderDate is only honoured if it's from TODAY —
  // if the rep is resuming a draft from an earlier day (e.g. the app reloaded
  // after being left open overnight), silently keeping yesterday's (or an
  // older) date caused real orders to get filed under the wrong day without
  // the rep noticing. Snapping back to today is the safer default; the rep
  // can still change it deliberately either way.
  const todayIST = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
  const [orderDate, setOrderDate] = useState(() => {
    const today = todayIST()
    return saved?.orderDate === today ? saved.orderDate : today
  })
  // #2 Per-order route override — null means use the customer's default route.
  const [routeOverride, setRouteOverride] = useState(saved?.routeOverride ?? null)
  // "Make this the customer's default route" — a rare, explicit action,
  // separate from the normal per-order route override above. Confirmed via a
  // popup before anything permanent changes; never touches historical orders,
  // since each order already stores its own route independently.
  const [showMakeDefaultConfirm, setShowMakeDefaultConfirm] = useState(false)
  const [makingDefault, setMakingDefault] = useState(false)
  const [allRoutes, setAllRoutes] = useState([])
  const [unread, setUnread] = useState(0)
  const [showPrevOrders, setShowPrevOrders] = useState(false)
  // Product ids that came from a loaded previous order, mapped to their
  // ORIGINAL quantity (not just presence/absence). This is what lets an
  // increased quantity on an already-present product (e.g. 5 -> 6) be split
  // into "5 original + 1 add-on" instead of silently becoming one merged
  // quantity of 6 with no add-on record at all — which was the real bug:
  // a Set only ever answered "is this product new to the order", never
  // "did this product's quantity increase since the original".
  const [originalQtyById, setOriginalQtyById] = useState(() => {
    if (!saved?.originalQtyById) return null
    return new Map(Object.entries(saved.originalQtyById).map(([k, v]) => [k, Number(v)]))
  })

  // Deep-link from a "Billing edited your order" push notification
  // (?order=<id>) — opens the exact order summary directly.
  const [deepLinkOrderId, setDeepLinkOrderId] = useState(null)
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search)
      const id = params.get('order')
      if (id) {
        setDeepLinkOrderId(id)
        const url = new URL(window.location.href)
        url.searchParams.delete('order')
        window.history.replaceState({}, '', url.toString())
      }
    } catch {}
    const onMsg = (event) => {
      const msg = event.data
      if (msg && msg.type === 'qc_open' && msg.data?.type === 'billing_edit' && msg.data?.order_id) {
        setDeepLinkOrderId(msg.data.order_id)
      }
    }
    if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message', onMsg)
    return () => {
      if ('serviceWorker' in navigator) navigator.serviceWorker.removeEventListener('message', onMsg)
    }
  }, [])

  // Continuously persist the working session so nothing is lost if the browser
  // reloads the page after returning from another app.
  useEffect(() => {
    saveSession({
      customer,
      quantities,
      units,
      visitStatus,
      visitRemark,
      originalQtyById: originalQtyById ? Object.fromEntries(originalQtyById) : null,
      priceOverrides,
      orderDate,
      routeOverride
    })
  }, [customer, quantities, units, visitStatus, visitRemark, originalQtyById, priceOverrides, orderDate, routeOverride])

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
      setOriginalQtyById(new Map(Object.entries(nextQ).map(([id, qty]) => [id, qty])))
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

  // Permanent route change — rare, explicit, confirmed. Updates the cloud
  // customer row's default route, then the local cache, so every future
  // order (from any device) starts from the new default. The CURRENT order
  // keeps using routeOverride exactly as already selected — this never
  // resets it, it only makes that same choice the customer's new default.
  const onConfirmMakeDefaultRoute = useCallback(async () => {
    if (!customer || !routeOverride) return
    setMakingDefault(true)
    try {
      const uid = (await currentUserId()) || user.id
      // Resolve the customer's CURRENT cloud row (matched on their existing
      // shop_name + route) before changing it, so we update the right row.
      const cloudId = await ensureCloudCustomer(customer, uid)
      await updateCustomerDefaultRoute(cloudId, routeOverride)
      // Keep the local device cache in sync so this rep's own customer list
      // reflects the new default immediately too.
      await updateCustomer(customer.id, { route: routeOverride })
      setCustomer((c) => (c ? { ...c, route: routeOverride } : c))
      setToast(`Default route updated to ${routeOverride}`)
    } catch (e) {
      console.error('make default route failed', e)
      setToast('Could not update default route. Try again.')
    } finally {
      setMakingDefault(false)
      setShowMakeDefaultConfirm(false)
    }
  }, [customer, routeOverride, user, updateCustomer])

  const onUnit = useCallback((id, val) => {
    setUnits((prev) => ({ ...prev, [id]: val }))
  }, [])

  const items = useMemo(
    () =>
      Object.keys(quantities)
        .flatMap((id) => {
          const p = productMap.get(id)
          if (!p) return []
          const qty = quantities[id]
          const unit = units[id] || 'Piece'
          const priceFields = {
            slabs: p.slabs,
            retail: priceOverrides[id]?.retail != null ? priceOverrides[id].retail : p.retail,
            wholesale: priceOverrides[id]?.wholesale != null ? priceOverrides[id].wholesale : p.wholesale,
            base: priceOverrides[id]?.base != null ? priceOverrides[id].base : p.base,
            netOverride: priceOverrides[id]?.net != null ? priceOverrides[id].net : null,
            retailOverridden: priceOverrides[id]?.retail != null,
            wholesaleOverridden: priceOverrides[id]?.wholesale != null,
            baseOverridden: priceOverrides[id]?.base != null,
            netOverridden: priceOverrides[id]?.net != null,
            // Billing snapshot fields — MRP, GST% and HSN are captured from the
            // product AT ORDER TIME (never re-derived later), same reasoning as
            // normalPrice/schemeSnapshot above: the catalogue can change after
            // the order is placed, but the bill must reflect what applied then.
            mrp: p.mrp ?? null,
            gst: p.gst ?? null,
            hsn: p.hsn ?? null,
            priceOverridden:
              priceOverrides[id]?.retail != null ||
              priceOverrides[id]?.wholesale != null ||
              priceOverrides[id]?.base != null ||
              priceOverrides[id]?.net != null,
            // Selected Price Type + Final Selling Rate — the click-to-select
            // MRP/Retail/Wholesale/Custom control on the product card
            // (PriceSelector) is the primary source for any non-scheme
            // product: it always sets BOTH priceType and finalRate together,
            // and defaults to WHOLESALE (not Retail) per this feature's
            // explicit requirement. Scheme products (BR/NR editable tags)
            // don't go through PriceSelector at all, so they fall back to the
            // older base/net/wholesale/retail chain, unaffected by this change.
            priceType: priceOverrides[id]?.priceType || (priceOverrides[id]
              ? null // legacy override present (base/net/etc, e.g. a scheme product) — no explicit type
              : (p.wholesale != null ? 'WHOLESALE' : p.retail != null ? 'RETAIL' : p.mrp != null ? 'MRP' : null)),
            finalSellingPrice:
              priceOverrides[id]?.finalRate != null ? priceOverrides[id].finalRate :
              priceOverrides[id]?.net != null ? priceOverrides[id].net :
              priceOverrides[id]?.base != null ? priceOverrides[id].base :
              priceOverrides[id]?.wholesale != null ? priceOverrides[id].wholesale :
              priceOverrides[id]?.retail != null ? priceOverrides[id].retail :
              // No selection made at all yet (shouldn't normally happen once
              // PriceSelector renders, but keeps old behaviour as a fallback):
              // Wholesale first, matching the new default, then Retail.
              (p.wholesale != null ? p.wholesale : p.retail != null ? p.retail : null),
            // The price the system would use with NO selection at all — i.e.
            // the true default (Wholesale-first, per this feature). This is
            // what Billing's SPECIAL PRICE detection compares against now;
            // it must NOT stay hardcoded to Retail, or every ordinary order
            // using the new Wholesale default would be falsely flagged as a
            // special price the moment this feature shipped.
            normalPrice: p.wholesale != null ? p.wholesale : p.retail != null ? p.retail : null,
            // Per-line scheme exception — defaults true (ON), only ever set
            // false when the rep explicitly toggles it for this order/line.
            schemeEnabled: priceOverrides[id]?.schemeEnabled !== false
          }

          const originalQty = originalQtyById?.get(id)

          if (originalQty == null) {
            // Product was never part of the loaded previous order at all —
            // a genuinely brand-new product. Whole line is the add-on (or,
            // if no previous order was loaded, just a normal line).
            return [{ id, name: p.name, qty, unit, isAddon: !!originalQtyById, ...priceFields }]
          }

          if (qty > originalQty) {
            // Quantity increased on a product that was already in the
            // original order — split into an unchanged ORIGINAL line and a
            // separate ADD-ON line for just the delta. This is what keeps
            // "5 original + 1 add-on" from silently becoming "6", and keeps
            // the add-on's delta out of the original's scheme calculation.
            return [
              { id, name: p.name, qty: originalQty, unit, isAddon: false, ...priceFields },
              { id: `${id}__addon`, baseId: id, name: p.name, qty: qty - originalQty, unit, isAddon: true, ...priceFields }
            ]
          }

          // Quantity unchanged or reduced from the original — not an add-on.
          return [{ id, name: p.name, qty, unit, isAddon: false, ...priceFields }]
        }),
    [quantities, units, productMap, originalQtyById, priceOverrides]
  )

  // Only treat as an add-on order if a previous order was loaded AND at least
  // one new item was added on top of it.
  const hasAddons = !!originalQtyById && items.some((i) => i.isAddon)

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
    setOriginalQtyById(null)
    setVisitStatus('')
    setVisitRemark('')
    setCustomer(c)
    setRouteOverride(c?.route ?? null) // per-order route resets to the new customer's default
    // Offer to reload this shop's previous orders (cloud lookup).
    if (c) setShowPrevOrders(true)
  }

  // A newly created customer's details ride along with their FIRST order only.
  const showIntro = !!customer && isIntroPending(customer.id)

  const message = (location) =>
    buildOrderMessage({
      brand: settings.brand,
      customer: { ...customer, route: (routeOverride ?? customer?.route) || '' },
      salesperson: profile?.full_name || settings.salesperson,
      items,
      isNewCustomer: showIntro,
      location,
      orderDate
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

  // Deep-link: open the announcements screen when the rep taps a product-update
  // push (either cold-open ?announcement= or a live SW message while app open).
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search)
      if (params.get('announcement') && onOpenAnnouncements) {
        onOpenAnnouncements()
        const url = new URL(window.location.href)
        url.searchParams.delete('announcement')
        window.history.replaceState({}, '', url.toString())
      }
    } catch {}
    const onMsg = (event) => {
      const msg = event.data
      if (msg && msg.type === 'qc_open' && msg.data && msg.data.type === 'announcement' && onOpenAnnouncements) {
        onOpenAnnouncements()
      }
    }
    if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message', onMsg)
    return () => {
      if ('serviceWorker' in navigator) navigator.serviceWorker.removeEventListener('message', onMsg)
    }
    // eslint-disable-next-line
  }, [])

  // Load all active routes once for the per-order route dropdown.
  useEffect(() => {
    listAllRoutes().then(setAllRoutes).catch(() => {})
  }, [])

  const getLocation = () =>
    new Promise((resolve) => {
      if (!navigator.geolocation) return resolve({})
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({ latitude: pos.coords.latitude, longitude: pos.coords.longitude }),
        () => resolve({}),
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 }
      )
    })

  // Shared by "Save Visit" and "Copy Visit Message" — persists the visit both
  // locally and to the cloud (rep-attributed). Previously only the Save Visit
  // button did this; Copy silently never saved anything at all, meaning a
  // rep who used Copy (without ALSO tapping Save) had that real field visit
  // vanish — not counted anywhere. Both actions must always save first.
  const persistVisit = async (visitStatusVal, remarkVal, loc) => {
    const visit = {
      customer_id: customer.id,
      customer_name: customer.name,
      route: customer.route,
      salesperson: profile?.full_name || settings.salesperson,
      visit_status: visitStatusVal,
      custom_remark: remarkVal,
      ...loc
    }
    await saveVisit(visit)
    try {
      const uid = (await currentUserId()) || user.id
      const cloud = await import('../utils/cloudSync.js')
      await cloud.saveCloudVisit({
        customer,
        userId: uid,
        visitStatus: visitStatusVal,
        remark: remarkVal,
        location: loc
      })
    } catch (e) {
      console.error('cloud visit save failed', e)
    }
    return visit
  }

  const handleVisit = async () => {
    if (!customer || !visitReady) return
    if (visitBusy) return // already saving — ignore double-tap
    setVisitBusy(true)
    try {
      const loc = await getLocation()
      const remark = visitStatus === 'Other' ? visitRemark.trim() : ''
      const visit = await persistVisit(visitStatus, remark, loc)
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
    } finally {
      setVisitBusy(false)
    }
  }

  // Tracks whether THIS visit (for the customer currently on screen) has
  // already been persisted this session — so tapping Copy a second time (to
  // re-copy the message, e.g. if the paste didn't work) never creates a
  // second visit row. Cleared whenever the customer/reason changes.
  const [visitAlreadySaved, setVisitAlreadySaved] = useState(false)
  useEffect(() => { setVisitAlreadySaved(false) }, [customer?.id, visitStatus, visitRemark])

  const handleCopyVisit = async () => {
    if (!customer || !visitReady) return
    if (visitBusy) return // already saving — ignore double-tap
    setVisitBusy(true)
    try {
      // Capture GPS and build the SAME message as Save Visit (with location line).
      const loc = await getLocation()
      const remark = visitStatus === 'Other' ? visitRemark.trim() : ''
      let visit
      if (visitAlreadySaved) {
        // Already saved (e.g. an earlier tap on Copy) — just rebuild the
        // message for re-copying, without inserting another visit row.
        visit = { visit_status: visitStatus, custom_remark: remark, ...loc }
      } else {
        try {
          visit = await persistVisit(visitStatus, remark, loc)
          setVisitAlreadySaved(true)
        } catch (e) {
          console.error('visit save (via copy) failed', e)
          visit = { visit_status: visitStatus, custom_remark: remark, ...loc }
        }
      }
      const text = buildVisitMessage({
        brand: settings.brand,
        customer,
        salesperson: profile?.full_name || settings.salesperson,
        visit
      })
      try {
        await navigator.clipboard.writeText(text)
        setToast(loc?.latitude != null ? 'Visit saved & copied' : 'Visit saved — location not captured')
      } catch {
        setToast(visitAlreadySaved ? 'Copy failed' : 'Could not save or copy — try again')
      }
      setTimeout(() => setToast(''), 2600)
    } finally {
      setVisitBusy(false)
    }
  }

  // Every order attempts to capture current GPS. Soft policy: if it fails we
  // warn and let the rep retry, but never block the sale. A failed capture is
  // stamped 'Not captured' in the message for accountability.
  const dispatchOrder = async (viaCopy) => {
    if (!canSend) return
    if (sending) return // already sending — ignore double-tap
    setSending(true)
    try {
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
      //
      // CRITICAL: if the save fails we must NOT pretend the order went through.
      // Previously this caught the error, logged it, and then carried on to
      // copy/open WhatsApp and clear the session — so the rep saw "Order
      // copied"/WhatsApp opened and believed it saved, while the database had
      // an empty (or missing) order. Billing then found "0 items" days later.
      // Now: on failure we STOP here, keep the order on screen so nothing is
      // lost, and tell the rep to retry.
      try {
        const uid = (await currentUserId()) || user.id
        await saveCloudOrder({
          customer,
          brand: settings.brand,
          userId: uid,
          items,
          location: ok ? loc : null,
          orderDate,
          route: routeOverride,
          // The customer's first order only — this is what makes Billing's
          // NEW CUSTOMER tag and the one-time intro details appear. Reuses
          // the SAME first-order detection (isIntroPending) already driving
          // the WhatsApp intro message, so there's one source of truth for
          // "is this genuinely their first order" — not two competing ones.
          isNewCustomer: showIntro,
          introDetails: showIntro
            ? { phone: customer.phone, gstn: customer.gstn, creditDays: customer.creditDays, email: customer.email }
            : null
        })
      } catch (e) {
        console.error('cloud order save failed', e)
        // Abort the whole dispatch: do not copy, do not open WhatsApp, do not
        // clear the session. Surface a clear, persistent error so the rep knows
        // the order was NOT saved and can try again with everything intact.
        setToast('⚠ Order NOT saved — please try again')
        setTimeout(() => setToast(''), 5000)
        setSending(false)
        return
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
    } finally {
      setSending(false)
    }
  }

  const handleSend = () => dispatchOrder(false)

  const handleCopy = () => dispatchOrder(true)

  return (
    <div className="min-h-screen bg-slate-50 pb-44">
      <header className="sticky top-0 z-20 bg-white/95 backdrop-blur border-b border-slate-100 safe-top">
        <div className="mx-auto max-w-3xl px-3 py-2 flex items-center gap-2">
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

      <main className="mx-auto max-w-3xl px-3 pt-3 space-y-3">
        <EnablePushBanner
          role="salesperson"
          label="Get product & price updates instantly — even when the app is closed."
        />
        <CustomerPicker selected={customer} onSelect={handleSelectCustomer} />

        {customer && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {/* #1 Order date — default today, optional change, future allowed */}
            <div className="rounded-xl bg-white border border-slate-200 px-3 py-2">
              <label className="block text-[11px] font-semibold text-slate-400 mb-1">📅 Order Date</label>
              <input type="date" value={orderDate} onChange={(e) => setOrderDate(e.target.value)}
                className="w-full text-sm outline-none bg-transparent" />
            </div>
            {/* #2 Route — default customer's route, changeable for this order only */}
            <div className="rounded-xl bg-white border border-slate-200 px-3 py-2">
              <label className="block text-[11px] font-semibold text-slate-400 mb-1">🛣️ Route (this order)</label>
              <select
                value={routeOverride ?? customer.route ?? ''}
                onChange={(e) => setRouteOverride(e.target.value)}
                className="w-full text-sm outline-none bg-transparent"
              >
                {/* Keep the customer's default and current selection present */}
                {customer.route && !allRoutes.includes(customer.route) && (
                  <option value={customer.route}>{customer.route}</option>
                )}
                {allRoutes.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
              {/* Only shown when the order's route genuinely differs from the
                  customer's current default — keeps the normal ordering flow
                  clean, and makes a permanent change an intentional, rare,
                  secondary action rather than something that can happen by
                  just picking a different route for one order. */}
              {routeOverride && routeOverride !== customer.route && (
                <button
                  type="button"
                  onClick={() => setShowMakeDefaultConfirm(true)}
                  className="mt-1.5 text-[11px] font-semibold text-brand-600 hover:text-brand-700"
                >
                  ↻ Make this the customer's default route
                </button>
              )}
            </div>
          </div>
        )}

        {showIntro && (
          <div className="rounded-xl bg-blue-50 border border-blue-200 px-3 py-2">
            <p className="text-[12px] text-blue-800 font-medium">
              🆕 New customer — their details will be included with this first order.
            </p>
          </div>
        )}

        {originalQtyById && (
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

      {deepLinkOrderId && (
        <OrderSummaryModal orderId={deepLinkOrderId} onClose={() => setDeepLinkOrderId(null)} />
      )}

      {showMakeDefaultConfirm && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center">
          <div className="bg-white w-full sm:max-w-sm rounded-t-3xl sm:rounded-3xl p-5">
            <p className="text-lg font-bold text-slate-800 mb-1">Make Route Permanent?</p>
            <p className="text-sm text-slate-500 mb-4">
              Are you sure you want to change this customer's default route to{' '}
              <b className="text-slate-700">{routeOverride}</b>? This route will be used automatically
              for this customer in future orders. Past orders will keep the route they already had.
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setShowMakeDefaultConfirm(false)}
                disabled={makingDefault}
                className="flex-1 rounded-xl border border-slate-200 py-3 font-semibold text-slate-600 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={onConfirmMakeDefaultRoute}
                disabled={makingDefault}
                className="flex-1 rounded-xl bg-brand-600 text-white py-3 font-bold active:bg-brand-700 disabled:opacity-50"
              >
                {makingDefault ? 'Updating…' : 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
