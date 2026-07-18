// Lightweight IndexedDB wrapper (no external deps).
// Stores large datasets: products & customers. Settings live in localStorage.

const DB_NAME = 'atl_order_db'
const DB_VERSION = 1
const STORES = ['products', 'customers']

let dbPromise = null

function openDB() {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      STORES.forEach((name) => {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, { keyPath: 'id' })
        }
      })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

function tx(store, mode) {
  return openDB().then((db) => db.transaction(store, mode).objectStore(store))
}

// Replace the entire contents of a store with a fresh array of records.
export async function bulkPut(store, records) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, 'readwrite')
    const os = t.objectStore(store)
    os.clear()
    records.forEach((r) => os.put(r))
    t.oncomplete = () => resolve(records.length)
    t.onerror = () => reject(t.error)
  })
}

export async function getAll(store) {
  const os = await tx(store, 'readonly')
  return new Promise((resolve, reject) => {
    const req = os.getAll()
    req.onsuccess = () => resolve(req.result || [])
    req.onerror = () => reject(req.error)
  })
}

export async function count(store) {
  const os = await tx(store, 'readonly')
  return new Promise((resolve, reject) => {
    const req = os.count()
    req.onsuccess = () => resolve(req.result || 0)
    req.onerror = () => reject(req.error)
  })
}

export async function clearStore(store) {
  const os = await tx(store, 'readwrite')
  return new Promise((resolve, reject) => {
    const req = os.clear()
    req.onsuccess = () => resolve(true)
    req.onerror = () => reject(req.error)
  })
}

export async function clearAllStores() {
  await Promise.all(STORES.map((s) => clearStore(s)))
}
