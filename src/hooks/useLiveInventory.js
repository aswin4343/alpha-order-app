import { useEffect, useState, useRef } from 'react'
import { supabase } from '../utils/supabase.js'
import { loadInventoryMap } from '../utils/cloudSync.js'

/**
 * Live inventory map: { product_id -> inventory row }.
 *
 * Loads the current inventory once, then subscribes to realtime changes on
 * product_inventory so the caller (e.g. the sales-rep product cards) reflects
 * stock updates the Purchase Manager makes WITHOUT a manual refresh.
 *
 * Returns a Map. Products with no entry are simply absent from the map, which
 * the status helper reads as "not initialized" (never zero).
 *
 * Gracefully degrades: if realtime isn't available/authorized, it still returns
 * the initially loaded snapshot, and re-fetches on reconnect.
 */
export function useLiveInventory(enabled = true) {
  const [map, setMap] = useState(() => new Map())
  const mapRef = useRef(map)
  mapRef.current = map

  useEffect(() => {
    if (!enabled) return
    let cancelled = false

    // Initial snapshot.
    loadInventoryMap().then((m) => { if (!cancelled) setMap(m) }).catch(() => {})

    // Realtime: apply row-level changes incrementally.
    const channel = supabase
      .channel('inventory-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'product_inventory' }, (payload) => {
        if (cancelled) return
        setMap((prev) => {
          const next = new Map(prev)
          const row = payload.new && Object.keys(payload.new).length ? payload.new : null
          const oldRow = payload.old && Object.keys(payload.old).length ? payload.old : null
          if (payload.eventType === 'DELETE' && oldRow) {
            next.delete(oldRow.product_id)
          } else if (row) {
            next.set(row.product_id, row)
          }
          return next
        })
      })
      .subscribe()

    // Safety net: if the tab was backgrounded and realtime missed events,
    // re-sync when it becomes visible again.
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        loadInventoryMap().then((m) => { if (!cancelled) setMap(m) }).catch(() => {})
      }
    }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVisible)
      supabase.removeChannel(channel)
    }
  }, [enabled])

  return map
}
