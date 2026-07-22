import { createContext, useContext, useEffect, useState, useCallback } from 'react'
import { bulkPut, getAll, count } from '../utils/db.js'
import seedProducts from '../data/products.json'
import seedCustomers from '../data/customers.json'
import categories from '../data/categories.json'
import { BRANDS } from '../utils/whatsapp.js'

const AppContext = createContext(null)
export const useApp = () => useContext(AppContext)

const SETTINGS_KEY = 'atl_settings_v2'
const SEEDED_KEY = 'atl_seeded_v2'
// Customers created in-app whose details have NOT yet been sent with an order.
const PENDING_INTRO_KEY = 'atl_pending_intro_v2'

const DEFAULT_SETTINGS = {
  businessName: 'Alpha Trade Links',
  salesperson: '',
  brand: BRANDS[0],
  configured: false
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) }
  } catch (e) {
    /* ignore */
  }
  return { ...DEFAULT_SETTINGS }
}

function loadPendingIntro() {
  try {
    const raw = localStorage.getItem(PENDING_INTRO_KEY)
    if (raw) return new Set(JSON.parse(raw))
  } catch (e) {
    /* ignore */
  }
  return new Set()
}

function savePendingIntro(set) {
  localStorage.setItem(PENDING_INTRO_KEY, JSON.stringify(Array.from(set)))
}

export function AppProvider({ children }) {
  const [settings, setSettings] = useState(loadSettings)
  // Set of customer ids awaiting their one-time "NEW CUSTOMER" block.
  const [pendingIntro, setPendingIntro] = useState(loadPendingIntro)
  const [products, setProducts] = useState([])
  const [customers, setCustomers] = useState([])
  const [ready, setReady] = useState(false)

  // Seed IndexedDB from the bundled data on first launch.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const seeded = localStorage.getItem(SEEDED_KEY)
        const pCount = await count('products')
        if (!seeded || pCount === 0) {
          await bulkPut('products', seedProducts)
          await bulkPut('customers', seedCustomers)
          localStorage.setItem(SEEDED_KEY, '1')
        }
        const [p, c] = await Promise.all([getAll('products'), getAll('customers')])
        if (!cancelled) {
          setProducts(p)
          setCustomers(c)
          setReady(true)
        }
      } catch (e) {
        console.error('Init failed', e)
        if (!cancelled) {
          setProducts(seedProducts)
          setCustomers(seedCustomers)
          setReady(true)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const updateSettings = useCallback((patch) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch }
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(next))
      return next
    })
  }, [])

  const replaceProducts = useCallback(async (records) => {
    await bulkPut('products', records)
    setProducts(records)
  }, [])

  const replaceCustomers = useCallback(async (records) => {
    await bulkPut('customers', records)
    setCustomers(records)
  }, [])

  // Create a new customer from the Customer Creation module.
  const addCustomer = useCallback(
    async (data) => {
      const rec = {
        id: `c_new_${Date.now()}`,
        name: data.name.trim(),
        area: (data.area || '').trim(),
        route: (data.route || '').trim(),
        category: data.category || '',
        gstn: (data.gstn || '').trim(),
        phone: (data.phone || '').trim(),
        email: (data.email || '').trim()
      }
      const next = [rec, ...customers]
      await bulkPut('customers', next)
      setCustomers(next)

      // Queue this customer's details to ride along with their first order.
      setPendingIntro((prev) => {
        const s = new Set(prev)
        s.add(rec.id)
        savePendingIntro(s)
        return s
      })
      return rec
    },
    [customers]
  )

  /** True only until the customer's first order has been sent. */
  const isIntroPending = useCallback((id) => pendingIntro.has(id), [pendingIntro])

  /**
   * Called immediately after an order is dispatched. Persists synchronously to
   * localStorage so the intro can never be sent twice, even if the app is
   * closed or reloaded right after sending.
   */
  const clearIntro = useCallback((id) => {
    setPendingIntro((prev) => {
      if (!prev.has(id)) return prev
      const s = new Set(prev)
      s.delete(id)
      savePendingIntro(s)
      return s
    })
  }, [])

  const value = {
    ready,
    settings,
    updateSettings,
    products,
    customers,
    categories,
    replaceProducts,
    replaceCustomers,
    addCustomer,
    isIntroPending,
    clearIntro
  }

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}
