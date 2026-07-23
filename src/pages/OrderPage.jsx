import { useState, useMemo, useCallback } from 'react'
import { useApp } from '../context/AppContext.jsx'
import { useSearch } from '../hooks/useSearch.js'
import { useDebounce } from '../hooks/useDebounce.js'
import CustomerPicker from '../components/CustomerPicker.jsx'
import ProductCard from '../components/ProductCard.jsx'
import OrderSummaryBar from '../components/OrderSummaryBar.jsx'
import BrandSelector from '../components/BrandSelector.jsx'
import { SearchIcon, CloseIcon, SettingsIcon, ReturnIcon } from '../components/Icons.jsx'
import { buildOrderMessage, buildVisitMessage, buildVisitCopyText, buildWhatsappUrl } from '../utils/whatsapp.js'
import VisitStatus from '../components/VisitStatus.jsx'
import appIcon from '../assets/app_icon.png'

const getProductText = (p) => p.name

export default function OrderPage({ onOpenSettings, onOpenReturns }) {
  const { settings, products, isIntroPending, clearIntro, saveVisit } = useApp()
  const [customer, setCustomer] = useState(null)
  const [query, setQuery] = useState('')
  const [quantities, setQuantities] = useState({}) // { id: qty }
  const [units, setUnits] = useState({}) // { id: 'Piece'|'Box' }
  const [toast, setToast] = useState('')
  const [visitStatus, setVisitStatus] = useState('')
  const [visitRemark, setVisitRemark] = useState('')

  const debounced = useDebounce(query, 120)
  const searching = debounced.trim().length > 0
  const searchResults = useSearch(products, debounced, getProductText, 80)

  const productMap = useMemo(() => {
    const m = new Map()
    products.forEach((p) => m.set(p.id, p))
    return m
  }, [products])

  const visibleProducts = useMemo(() => {
    if (searching) return searchResults
    const ids = Object.keys(quantities).filter((id) => quantities[id] > 0)
    const chosen = ids.map((id) => productMap.get(id)).filter(Boolean)
    const set = new Set(ids)
    return [...chosen, ...products.filter((p) => !set.has(p.id)).slice(0, 50)]
  }, [searching, searchResults, quantities, productMap, products])

  const onQty = useCallback((id, val) => {
    setQuantities((prev) => {
      const next = { ...prev }
      if (val > 0) next[id] = val
      else delete next[id]
      return next
    })
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
            slabs: p.slabs
          }
        })
        .filter(Boolean),
    [quantities, units, productMap]
  )

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
    setVisitStatus('')
    setVisitRemark('')
    setCustomer(c)
  }

  // A newly created customer's details ride along with their FIRST order only.
  const showIntro = !!customer && isIntroPending(customer.id)

  const message = () =>
    buildOrderMessage({
      brand: settings.brand,
      customer,
      salesperson: settings.salesperson,
      items,
      isNewCustomer: showIntro
    })

  const getLocation = () =>
    new Promise((resolve) => {
      if (!navigator.geolocation) return resolve({})
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({ latitude: pos.coords.latitude, longitude: pos.coords.longitude }),
        () => resolve({}),
        { enableHighAccuracy: false, timeout: 4000, maximumAge: 60000 }
      )
    })

  const handleVisit = async () => {
    if (!customer || !visitReady) return
    const loc = await getLocation()
    const visit = {
      customer_id: customer.id,
      customer_name: customer.name,
      route: customer.route,
      salesperson: settings.salesperson,
      visit_status: visitStatus,
      custom_remark: visitStatus === 'Other' ? visitRemark.trim() : '',
      ...loc
    }
    await saveVisit(visit)
    const msg = buildVisitMessage({
      brand: settings.brand,
      customer,
      salesperson: settings.salesperson,
      visit
    })
    window.open(buildWhatsappUrl(msg), '_blank')
    // Reset for next customer.
    setVisitStatus('')
    setVisitRemark('')
    setCustomer(null)
    setToast('Visit recorded')
    setTimeout(() => setToast(''), 2600)
  }

  const handleCopyVisit = async () => {
    if (!customer || !visitReady) return
    const text = buildVisitCopyText({
      customer,
      salesperson: settings.salesperson,
      reason: visitStatus === 'Other' ? (visitRemark.trim() || 'Other') : visitStatus
    })
    try {
      await navigator.clipboard.writeText(text)
      setToast('Visit message copied')
    } catch {
      setToast('Copy failed')
    }
    setTimeout(() => setToast(''), 2600)
  }

  const handleSend = () => {
    if (!canSend) return
    window.open(buildWhatsappUrl(message()), '_blank')
    if (showIntro) clearIntro(customer.id)
  }

  const handleCopy = async () => {
    if (!canSend) return
    try {
      await navigator.clipboard.writeText(message())
      // Copying counts as sending — otherwise the intro would repeat next time.
      if (showIntro) clearIntro(customer.id)
      setToast('Order copied — paste in WhatsApp Business')
    } catch {
      setToast('Copy failed')
    }
    setTimeout(() => setToast(''), 2600)
  }

  return (
    <div className="min-h-screen bg-slate-50 pb-44">
      <header className="sticky top-0 z-20 bg-white/95 backdrop-blur border-b border-slate-100 safe-top">
        <div className="mx-auto max-w-md px-3 py-2 flex items-center gap-2">
          <img src={appIcon} alt="" className="h-8 w-8 rounded-lg object-contain" />
          <BrandSelector />
          <div className="flex-1" />
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
