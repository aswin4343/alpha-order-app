import { createContext, useContext, useEffect, useState, useCallback } from 'react'
import { bulkPut, getAll, count, addRecord } from '../utils/db.js'
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

// Downloads the cloud catalogue only when its version is newer than what we
// last cached locally. Returns the fresh product list, or null if unchanged
// or unavailable (offline / not set up yet) — in which case the local cache
// keeps working untouched.
const CAT_VERSION_KEY = 'atl_catalogue_version'

async function syncProductsFromCloud(localProducts) {
  try {
    const { getCatalogueMeta, fetchAllCloudProducts } = await import('../utils/cloudSync.js')
    const meta = await getCatalogueMeta()
    if (!meta || !meta.product_count) return null // cloud not populated yet
    const localVersion = Number(localStorage.getItem(CAT_VERSION_KEY) || 0)
    if (meta.version <= localVersion && localProducts && localProducts.length) {
      return null // already up to date
    }
    const fresh = await fetchAllCloudProducts()
    if (!fresh || !fresh.length) return null
    await bulkPut('products', fresh)
    localStorage.setItem(CAT_VERSION_KEY, String(meta.version))
    return fresh
  } catch (e) {
    console.error('product cloud sync failed (using local cache)', e)
    return null
  }
}

// Download the shared customer list and merge with local records. Local
// records (which carry full phone/GST/address) are preserved; cloud-only
// shops are added so new shops created by any rep appear for everyone.
//
// Customers are matched by NAME ALONE here (not name+route) specifically so
// that a permanent route change made on one device (or by another rep) is
// correctly picked up as an UPDATE to the existing local record, rather than
// being treated as an unrelated new shop that never overwrites the stale
// route sitting in this device's own cache. Matching by name+route was the
// original design, but a route is no longer immutable once set — it can be
// permanently changed by a rep and must then propagate to every device.
async function syncCustomersFromCloud(localCustomers) {
  try {
    const { fetchAllCloudCustomers } = await import('../utils/cloudSync.js')
    const cloud = await fetchAllCloudCustomers()
    if (!cloud || !cloud.length) return null

    const nameKey = (name) => (name || '').trim().toUpperCase()
    const byName = new Map((localCustomers || []).map((c) => [nameKey(c.name), c]))

    const additions = []
    let changed = false
    const updated = (localCustomers || []).map((c) => c) // shallow copy to mutate in place below

    cloud.forEach((cc) => {
      const k = nameKey(cc.shop_name)
      const existingLocal = byName.get(k)
      const cloudRoute = cc.route || ''

      if (!existingLocal) {
        // Genuinely new shop (from any rep/device) — add it.
        additions.push({
          id: `cloud_${cc.id}`,
          name: cc.shop_name,
          area: '',
          route: cloudRoute,
          category: cc.category || '',
          ledgerCategory: cc.ledger_category || '',
          creditDays: 'No Credit',
          gstn: '',
          phone: '',
          email: '',
          fromCloud: true
        })
        changed = true
        return
      }

      // Existing shop — bring device copy up to date for cloud-owned fields:
      // route (permanent overrides) and ledger_category (assigned centrally /
      // via migration). Local-only PII (phone/GST/etc) is preserved untouched.
      const cloudLedger = cc.ledger_category || ''
      const routeChanged = (existingLocal.route || '') !== cloudRoute
      const ledgerChanged = cloudLedger && (existingLocal.ledgerCategory || '') !== cloudLedger
      if (routeChanged || ledgerChanged) {
        const idx = updated.findIndex((u) => u.id === existingLocal.id)
        if (idx !== -1) {
          updated[idx] = {
            ...updated[idx],
            ...(routeChanged ? { route: cloudRoute } : {}),
            ...(ledgerChanged ? { ledgerCategory: cloudLedger } : {})
          }
          changed = true
        }
      }
    })

    if (!changed) return null
    const merged = [...updated, ...additions]
    await bulkPut('customers', merged)
    return merged
  } catch (e) {
    console.error('customer cloud sync failed (using local)', e)
    return null
  }
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
        // Backward compatibility: existing customers get a default credit term.
        const cFixed = c.map((x) => (x.creditDays ? x : { ...x, creditDays: 'No Credit' }))
        if (!cancelled) {
          setProducts(p)
          setCustomers(cFixed)
          setReady(true)
        }

        // Then, in the background, sync products from the cloud if the admin has
        // published a newer catalogue. Local cache keeps the app instant/offline;
        // this just refreshes it when signal is available.
        syncProductsFromCloud(p).then((fresh) => {
          if (!cancelled && fresh) setProducts(fresh)
        })

        // Also pull the shared customer list so shops created by ANY rep are
        // visible to everyone. Merge: keep local records (which hold full PII)
        // and add any cloud shops this device doesn't have yet.
        syncCustomersFromCloud(cFixed).then((merged) => {
          if (!cancelled && merged) setCustomers(merged)
        })
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
        ledgerCategory: data.ledgerCategory || '',
        creditDays: data.creditDays || 'No Credit',
        gstn: (data.gstn || '').trim(),
        phone: (data.phone || '').trim(),
        email: (data.email || '').trim()
      }
      const next = [rec, ...customers]
      await bulkPut('customers', next)
      setCustomers(next)

      // Register this genuinely new shop in the cloud right away, flagged as
      // rep-created, so it counts as a "new shop" even before its first order.
      // PII (phone/GST/email) stays local — only shop name + route + category go up.
      let cloudSaved = false
      try {
        const { currentUserId, ensureCloudCustomer } = await import('../utils/cloudSync.js')
        const uid = await currentUserId()
        if (uid) {
          const cloudId = await ensureCloudCustomer(rec, uid, true)
          cloudSaved = !!cloudId
        }
      } catch (e) {
        console.error('cloud new-customer register failed', e)
        cloudSaved = false
      }
      rec._cloudSaved = cloudSaved

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
  // Edit an existing customer (e.g. change Credit Days). Any rep may do this
  // for now; role restriction arrives with V3 admin.
  const updateCustomer = useCallback(
    async (id, patch) => {
      const next = customers.map((c) => (c.id === id ? { ...c, ...patch } : c))
      await bulkPut('customers', next)
      setCustomers(next)
    },
    [customers]
  )

  // Save a no-order customer visit locally. sales_rep_id is null until V3 login.
  const saveVisit = useCallback(async (visit) => {
    const rec = {
      id: `v_${Date.now()}`,
      customer_id: visit.customer_id,
      customer_name: visit.customer_name,
      route: visit.route || '',
      sales_rep_id: null, // assigned in V3 when reps have identities
      salesperson: visit.salesperson || '',
      visit_status: visit.visit_status,
      custom_remark: visit.custom_remark || '',
      latitude: visit.latitude ?? null,
      longitude: visit.longitude ?? null,
      created_at: new Date().toISOString()
    }
    await addRecord('visits', rec)
    return rec
  }, [])

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
    updateCustomer,
    saveVisit,
    isIntroPending,
    clearIntro
  }

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}
