import { useState, useMemo, useCallback, useRef, useEffect } from 'react'
import { useApp } from '../context/AppContext.jsx'
import { useSearch } from '../hooks/useSearch.js'
import { useDebounce } from '../hooks/useDebounce.js'
import CustomerPicker from '../components/CustomerPicker.jsx'
import ProductCard from '../components/ProductCard.jsx'
import OrderSummaryBar from '../components/OrderSummaryBar.jsx'
import { SearchIcon, CloseIcon, SettingsIcon } from '../components/Icons.jsx'
import { buildOrderMessage, buildWhatsappUrl } from '../utils/whatsapp.js'
import logo from '../assets/logo.png'

const getProductText = (p) => p.name

export default function OrderPage({ onOpenSettings }) {
  const { settings, products } = useApp()
  const [customer, setCustomer] = useState(null)
  const [query, setQuery] = useState('')
  // quantities: { [productId]: number }
  const [quantities, setQuantities] = useState({})

  const debounced = useDebounce(query, 120)

  // When not searching, show selected items first, then a slice of the catalog.
  const searching = debounced.trim().length > 0
  const searchResults = useSearch(products, debounced, getProductText, 80)

  const productMap = useMemo(() => {
    const m = new Map()
    products.forEach((p) => m.set(p.id, p))
    return m
  }, [products])

  // The list to render: search results when searching, otherwise
  // selected products + a bounded portion of the catalogue.
  const visibleProducts = useMemo(() => {
    if (searching) return searchResults
    const selectedIds = Object.keys(quantities).filter((id) => quantities[id] > 0)
    const selected = selectedIds.map((id) => productMap.get(id)).filter(Boolean)
    const selectedSet = new Set(selectedIds)
    const rest = products.filter((p) => !selectedSet.has(p.id)).slice(0, 60)
    return [...selected, ...rest]
  }, [searching, searchResults, quantities, productMap, products])

  const onQty = useCallback((id, val) => {
    setQuantities((prev) => {
      const next = { ...prev }
      if (val > 0) next[id] = val
      else delete next[id]
      return next
    })
  }, [])

  const selectedItems = useMemo(
    () =>
      Object.keys(quantities)
        .map((id) => ({ id, qty: quantities[id], name: productMap.get(id)?.name }))
        .filter((i) => i.name && i.qty > 0),
    [quantities, productMap]
  )

  const totalQty = selectedItems.reduce((s, i) => s + i.qty, 0)
  const canSend = customer && selectedItems.length > 0

  const handleSend = () => {
    if (!canSend) return
    const message = buildOrderMessage({
      businessName: settings.businessName,
      salesperson: settings.salesperson,
      customerName: customer.name,
      selectedItems
    })
    const url = buildWhatsappUrl(message)
    window.open(url, '_blank')
  }

  return (
    <div className="min-h-screen bg-slate-50 pb-40">
      {/* Header */}
      <header className="sticky top-0 z-20 bg-white/95 backdrop-blur border-b border-slate-100 safe-top">
        <div className="mx-auto max-w-md px-4 py-2.5 flex items-center justify-between">
          <div className="flex items-center gap-2 min-w-0">
            <img src={logo} alt="ATL" className="h-8 object-contain" />
          </div>
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
        {/* Step 1: Customer */}
        <CustomerPicker selected={customer} onSelect={setCustomer} />

        {/* Step 2: Product search */}
        <div className="flex items-center gap-2 rounded-2xl bg-white shadow-card border border-slate-100 px-4 sticky top-[57px] z-10">
          <SearchIcon className="h-5 w-5 text-slate-400 shrink-0" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search Products..."
            className="flex-1 py-3.5 text-[15px] outline-none placeholder:text-slate-400"
          />
          {query && (
            <button onClick={() => setQuery('')} className="text-slate-400 p-1">
              <CloseIcon className="h-5 w-5" />
            </button>
          )}
        </div>

        {/* Step 3: Product cards */}
        <div className="space-y-2.5">
          {!searching && selectedItems.length > 0 && (
            <p className="text-xs font-semibold text-brand-600 px-1 pt-1">
              SELECTED ({selectedItems.length})
            </p>
          )}
          {visibleProducts.map((p) => (
            <ProductCard key={p.id} product={p} qty={quantities[p.id] || 0} onQty={onQty} />
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
        productCount={selectedItems.length}
        totalQty={totalQty}
        disabled={!canSend}
        onSend={handleSend}
      />
    </div>
  )
}
