import { createContext, useContext, useEffect, useState, useCallback } from 'react'
import { bulkPut, getAll, clearAllStores, count } from '../utils/db.js'
import seedProducts from '../data/products.json'
import seedCustomers from '../data/customers.json'

const AppContext = createContext(null)
export const useApp = () => useContext(AppContext)

const SETTINGS_KEY = 'atl_settings'
const SEEDED_KEY = 'atl_seeded_v1'

const DEFAULT_SETTINGS = {
  businessName: 'Alpha Trade Links',
  salesperson: '',
  configured: false // becomes true after first-launch setup
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

function saveSettings(s) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s))
}

// Seed data shipped in the app so it works instantly on first install.
function seedProductRecords() {
  return seedProducts.map((name, i) => ({ id: `p${i}`, name, brand: '', category: '', unit: '' }))
}
function seedCustomerRecords() {
  return seedCustomers.map((c, i) => ({
    id: `c${i}`,
    name: c.name,
    owner: '',
    phone: '',
    area: c.route || ''
  }))
}

export function AppProvider({ children }) {
  const [settings, setSettings] = useState(loadSettings)
  const [products, setProducts] = useState([])
  const [customers, setCustomers] = useState([])
  const [ready, setReady] = useState(false)

  // On first launch, seed IndexedDB from bundled data. Afterwards just load.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const seeded = localStorage.getItem(SEEDED_KEY)
        const pCount = await count('products')
        if (!seeded || pCount === 0) {
          await bulkPut('products', seedProductRecords())
          await bulkPut('customers', seedCustomerRecords())
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
        // Fall back to in-memory seed so the app is still usable.
        if (!cancelled) {
          setProducts(seedProductRecords())
          setCustomers(seedCustomerRecords())
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
      saveSettings(next)
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

  // Add a single new customer at runtime (persisted).
  const addCustomer = useCallback(
    async (customer) => {
      const rec = {
        id: `c_new_${Date.now()}`,
        name: customer.name,
        owner: customer.owner || '',
        phone: customer.phone || '',
        area: customer.area || ''
      }
      const next = [rec, ...customers]
      await bulkPut('customers', next)
      setCustomers(next)
      return rec
    },
    [customers]
  )

  const clearAll = useCallback(async () => {
    await clearAllStores()
    localStorage.removeItem(SEEDED_KEY)
    setProducts([])
    setCustomers([])
  }, [])

  const value = {
    ready,
    settings,
    updateSettings,
    products,
    customers,
    replaceProducts,
    replaceCustomers,
    addCustomer,
    clearAll
  }

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}
