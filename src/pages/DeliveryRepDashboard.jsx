import { useEffect, useState } from 'react'
import { useAuth } from '../context/AuthContext.jsx'
import { supabase } from '../utils/supabase.js'
import appIcon from '../assets/app_icon.png'
import DeliveryDetailPage from './DeliveryDetailPage.jsx'

/**
 * Delivery Rep dashboard — Phase 4A shows their assigned orders (read-only).
 * The full delivery workflow (checklist, photos, GPS, completion) arrives in
 * Phase 4B/4C.
 */
export default function DeliveryRepDashboard() {
  const { profile, signOut } = useAuth()
  const [list, setList] = useState(null)
  const [error, setError] = useState(false)
  // Persist which delivery is open, so returning from the camera (which can
  // reload the page in the background) restores the delivery detail screen
  // instead of dropping the rep back to the list and losing their photo.
  const [selected, setSelected] = useState(null)
  // Attendance: current open punch (null = punched out).
  const [punch, setPunch] = useState(null)
  const [punchLoaded, setPunchLoaded] = useState(false)
  const [dateFilter, setDateFilter] = useState(() => new Date().toISOString().slice(0, 10))

  // Load current punch state on mount.
  useEffect(() => {
    ;(async () => {
      try {
        const { getOpenPunch } = await import('../utils/cloudSync.js')
        const p = await getOpenPunch()
        setPunch(p)
      } catch (e) {
        console.error(e)
      } finally {
        setPunchLoaded(true)
      }
    })()

    // Ping last-known location on app open (best-effort, silent if denied).
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        async (pos) => {
          try {
            const { pingDriverLocation } = await import('../utils/cloudSync.js')
            await pingDriverLocation(pos.coords.latitude, pos.coords.longitude)
          } catch (e) {
            console.error('ping failed', e)
          }
        },
        () => {}, // ignore denial
        { enableHighAccuracy: false, timeout: 8000, maximumAge: 60000 }
      )
    }
  }, [])

  const doPunchIn = async () => {
    const name = window.prompt('Enter your name to punch in:')
    if (!name || !name.trim()) return
    try {
      const { punchIn } = await import('../utils/cloudSync.js')
      const p = await punchIn(name.trim())
      setPunch(p)
    } catch (e) {
      console.error(e)
      alert('Could not punch in. Check your connection.')
    }
  }

  const doPunchOut = async () => {
    if (!punch) return
    if (!window.confirm('Punch out now? Your working session will be recorded.')) return
    try {
      const { punchOut } = await import('../utils/cloudSync.js')
      await punchOut(punch.id)
      setPunch(null)
    } catch (e) {
      console.error(e)
      alert('Could not punch out. Check your connection.')
    }
  }

  const openDelivery = (d) => {
    setSelected(d)
    try {
      localStorage.setItem('atl_open_delivery', JSON.stringify(d))
    } catch {
      /* ignore */
    }
  }
  const closeDelivery = () => {
    setSelected(null)
    try {
      localStorage.removeItem('atl_open_delivery')
    } catch {
      /* ignore */
    }
  }

  const load = async () => {
    try {
      const { data, error } = await supabase
        .from('deliveries')
        .select('id, order_id, shop_name, route, sales_rep_name, status, created_at')
        .order('created_at', { ascending: false })
      if (error) throw error
      const deliveries = data || []

      // Group into one card per shop per day (combined orders).
      const { groupDeliveriesByShopDay } = await import('../utils/deliveryGroup.js')

      // Fetch each shop's verified location, attach it, and sort nearest-to-hub
      // first. Shops without a location yet fall to the end.
      try {
        const { fetchShopLocations } = await import('../utils/cloudSync.js')
        const { sortByHubDistance } = await import('../utils/geo.js')
        const names = [...new Set(deliveries.map((d) => d.shop_name))]
        const locs = await fetchShopLocations(names)
        const withLoc = deliveries.map((d) => {
          const l = locs[(d.shop_name || '').toUpperCase()]
          return { ...d, latitude: l?.latitude ?? null, longitude: l?.longitude ?? null }
        })
        const grouped = groupDeliveriesByShopDay(withLoc)
        setList(sortByHubDistance(grouped))
      } catch (e) {
        console.error('distance sort failed, showing grouped unsorted', e)
        setList(groupDeliveriesByShopDay(deliveries))
      }
    } catch {
      setError(true)
    }
  }

  useEffect(() => {
    load()
    // Restore an open delivery if we were mid-delivery before a reload.
    try {
      const raw = localStorage.getItem('atl_open_delivery')
      if (raw) setSelected(JSON.parse(raw))
    } catch {
      /* ignore */
    }
  }, [])

  // Show the detail screen when a delivery is opened.
  if (selected) {
    return (
      <DeliveryDetailPage
        delivery={selected}
        personName={punch?.person_name || null}
        isPunchedIn={!!punch}
        onBack={closeDelivery}
        onCompleted={() => {
          closeDelivery()
          load()
        }}
      />
    )
  }

  return (
    <div className="min-h-screen bg-slate-50 pb-10">
      <header className="sticky top-0 z-20 bg-white border-b border-slate-100 safe-top">
        <div className="mx-auto max-w-3xl px-3 py-2.5 flex items-center gap-2">
          <img src={appIcon} alt="" className="h-8 w-8 rounded-lg object-contain" />
          <div className="flex-1 min-w-0">
            <h1 className="text-base font-bold text-slate-800 leading-tight">My Deliveries</h1>
            <p className="text-[11px] text-slate-400">{profile?.full_name || 'Delivery'}</p>
          </div>
          <button onClick={signOut} className="text-xs font-semibold text-red-600 px-2.5 py-1.5 rounded-lg active:bg-red-50">
            Sign Out
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-3 pt-3">
        {/* Punch In / Out */}
        {punchLoaded && (
          <div className={`rounded-2xl border p-3 mb-3 ${punch ? 'bg-green-50 border-green-200' : 'bg-amber-50 border-amber-200'}`}>
            {punch ? (
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-green-800 truncate">
                    Punched in: {punch.person_name}
                  </p>
                  <p className="text-[11px] text-green-600">
                    Since {new Date(punch.punch_in).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true })}
                  </p>
                </div>
                <button
                  onClick={doPunchOut}
                  className="shrink-0 rounded-xl bg-red-600 text-white text-sm font-semibold px-4 py-2 active:bg-red-700"
                >
                  Punch Out
                </button>
              </div>
            ) : (
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium text-amber-800">
                  Punch in to start delivering
                </p>
                <button
                  onClick={doPunchIn}
                  className="shrink-0 rounded-xl bg-brand-600 text-white text-sm font-semibold px-4 py-2 active:bg-brand-700"
                >
                  Punch In
                </button>
              </div>
            )}
          </div>
        )}

        {/* Date filter */}
        <div className="flex items-center gap-2 mb-3">
          <input
            type="date"
            value={dateFilter}
            onChange={(e) => setDateFilter(e.target.value)}
            className="rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-brand-500 bg-white"
          />
          <button
            onClick={() => setDateFilter(new Date().toISOString().slice(0, 10))}
            className="rounded-xl border border-slate-200 px-3 py-2 text-sm font-semibold text-slate-600 active:bg-slate-50"
          >
            Today
          </button>
          {dateFilter && (
            <button
              onClick={() => setDateFilter('')}
              className="rounded-xl border border-slate-200 px-3 py-2 text-sm font-semibold text-red-600 active:bg-red-50"
            >
              All
            </button>
          )}
        </div>

        {error && (
          <p className="text-center text-sm text-red-500 py-6">Could not load deliveries.</p>
        )}
        {!list && !error && (
          <div className="py-16 flex justify-center">
            <div className="h-8 w-8 rounded-full border-4 border-brand-100 border-t-brand-600 animate-spin" />
          </div>
        )}
        {list && list.length === 0 && (
          <p className="text-center text-sm text-slate-400 py-10">
            No deliveries assigned to you yet.
          </p>
        )}
        <div className="space-y-2 lg:space-y-0 lg:grid lg:grid-cols-2 lg:gap-2">
          {list &&
            list
              .filter((d) => !dateFilter || d.day === dateFilter)
              .map((d) => (
              <div
                key={d.id}
                onClick={() => openDelivery(d)}
                className="w-full text-left rounded-2xl bg-white shadow-card border border-slate-100 p-3 active:bg-slate-50 cursor-pointer"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-semibold text-slate-800 truncate">{d.shop_name}</p>
                    <p className="text-[11px] text-slate-400 truncate">
                      {d.route || 'No route'} · Sales: {d.sales_rep_name || '—'}
                      {d.count > 1 && (
                        <span className="ml-1 text-brand-600 font-semibold">
                          · {d.count} orders
                        </span>
                      )}
                    </p>
                    {d._distanceKm != null ? (
                      <p className="text-[11px] text-brand-600 font-medium mt-0.5">
                        📍 {d._distanceKm.toFixed(1)} km from hub
                      </p>
                    ) : (
                      <p className="text-[11px] text-slate-400 mt-0.5">
                        📍 Location not captured yet
                      </p>
                    )}
                    <span className={`inline-block mt-1.5 text-[10px] font-semibold px-2 py-0.5 rounded-full ${
                      d.status === 'delivered' ? 'bg-green-50 text-green-700'
                        : d.status === 'partial' ? 'bg-orange-50 text-orange-700'
                        : d.status === 'failed' ? 'bg-red-50 text-red-700'
                        : d.status === 'in_progress' ? 'bg-amber-50 text-amber-700'
                        : 'bg-blue-50 text-blue-700'
                    }`}>
                      {d.status}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {d.latitude != null && d.longitude != null && (
                      <a
                        href={`https://www.google.com/maps/dir/?api=1&destination=${d.latitude},${d.longitude}`}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="flex items-center gap-1 rounded-lg bg-brand-50 text-brand-700 text-[11px] font-semibold px-2.5 py-1.5 active:bg-brand-100"
                      >
                        🧭 Navigate
                      </a>
                    )}
                    <span className="text-slate-300 text-xl">›</span>
                  </div>
                </div>
              </div>
            ))}
        </div>
        <p className="text-center text-[11px] text-slate-400 mt-6">
          Tap a delivery to view items and complete it. Proof-of-delivery photos come next.
        </p>
      </main>
    </div>
  )
}
