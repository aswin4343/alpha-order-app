import { useEffect, useState } from 'react'
import { loadMyNotifications, markNotificationRead } from '../utils/cloudSync.js'

/**
 * Watches for billing-edit notifications for the logged-in rep and shows them
 * one popup per order. Polls on an interval + when the tab regains focus, so a
 * notification appears live (on auto-refresh) while the rep has the app open.
 */
export default function OrderChangeNotifier() {
  const [queue, setQueue] = useState([]) // unread notifications
  const [showChanges, setShowChanges] = useState(false)

  const poll = async () => {
    try {
      const list = await loadMyNotifications()
      if (list.length) {
        setQueue((cur) => {
          // merge, avoid duplicates by id
          const seen = new Set(cur.map((n) => n.id))
          const merged = [...cur]
          list.forEach((n) => { if (!seen.has(n.id)) merged.push(n) })
          return merged
        })
      }
    } catch (e) {
      // ignore; will retry next poll
    }
  }

  useEffect(() => {
    poll()
    const interval = setInterval(poll, 20000)
    const onFocus = () => poll()
    window.addEventListener('focus', onFocus)
    return () => {
      clearInterval(interval)
      window.removeEventListener('focus', onFocus)
    }
  }, [])

  const current = queue[0]
  if (!current) return null

  const dismiss = async () => {
    await markNotificationRead(current.id)
    setShowChanges(false)
    setQueue((cur) => cur.slice(1)) // next notification, if any
  }

  const changes = Array.isArray(current.changes) ? current.changes : []
  const fmt = (iso) =>
    new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true })

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white w-full max-w-sm rounded-2xl overflow-hidden shadow-xl">
        <div className="bg-amber-500 px-4 py-3">
          <p className="text-white font-bold text-base">📋 Order Updated by Billing</p>
        </div>
        <div className="p-4">
          <p className="text-sm text-slate-800 font-semibold">{current.shop_name}</p>
          <p className="text-[11px] text-slate-400 mb-3">{fmt(current.created_at)}</p>

          {!showChanges ? (
            <p className="text-sm text-slate-600">
              The Billing Team has updated your order
              {changes.length ? ` — ${changes.length} change${changes.length > 1 ? 's' : ''}.` : '.'}
            </p>
          ) : (
            <div className="space-y-1.5 mt-1">
              {changes.map((c, i) => (
                <div key={i} className="text-sm text-slate-700 bg-slate-50 rounded-lg px-3 py-2 border border-slate-100">
                  {c}
                  {/* Stock-Out removals are also trackable/reschedulable — say so
                      right where the rep sees the change, without needing the
                      underlying notification trigger to know about this feature. */}
                  {String(c).toLowerCase().includes('stock out') && (
                    <p className="text-[11px] text-amber-700 mt-1">
                      It has been added to Pending Orders and can be rescheduled.
                    </p>
                  )}
                </div>
              ))}
              {changes.length === 0 && <p className="text-sm text-slate-400">No detailed changes recorded.</p>}
            </div>
          )}

          <p className="text-[11px] text-slate-400 mt-3">Changed by: {current.changed_by || 'Billing Team'}</p>

          <div className="flex gap-2 mt-4">
            {!showChanges && changes.length > 0 && (
              <button
                onClick={() => setShowChanges(true)}
                className="flex-1 rounded-xl border border-brand-300 text-brand-700 py-2.5 font-semibold"
              >
                View Changes
              </button>
            )}
            <button
              onClick={dismiss}
              className="flex-1 rounded-xl bg-brand-600 text-white py-2.5 font-bold"
            >
              OK
            </button>
          </div>
          {queue.length > 1 && (
            <p className="text-[11px] text-center text-slate-400 mt-2">
              {queue.length - 1} more update{queue.length - 1 > 1 ? 's' : ''} after this
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
