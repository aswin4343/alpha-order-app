import { useState, useMemo } from 'react'
import { rescheduleStockOutItem } from '../utils/cloudSync.js'
import { CloseIcon } from './Icons.jsx'

const istDateStr = (iso) =>
  new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
const prettyDate = (dateStr) => {
  if (!dateStr) return '—'
  const d = new Date(dateStr.length <= 10 ? `${dateStr}T00:00:00` : dateStr)
  if (isNaN(d.getTime())) return dateStr
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
}
// Today's date in IST, used as the <input type="date"> min bound.
const todayStr = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })

/**
 * Sales-side Pending Orders: every Stock-Out removal from this rep's orders
 * that hasn't been rescheduled yet, grouped by the ORIGINAL order date so a
 * rep can see "what's pending from which day" at a glance. One-click
 * reschedule creates a real new order for the chosen date — the app's
 * existing Billing grouping (same shop + date) automatically treats it as an
 * add-on if that customer already has an order that day.
 */
export default function PendingOrdersModal({ items, repId, repName, onClose, onRescheduled }) {
  const [dateFor, setDateFor] = useState(null)   // item.id currently choosing a date for
  const [pickedDate, setPickedDate] = useState('')
  const [busyId, setBusyId] = useState(null)
  const [result, setResult] = useState(null)     // { itemId, isAddon } — success banner

  const groups = useMemo(() => {
    const byDay = new Map()
    for (const it of items) {
      const day = it.orders?.order_date || istDateStr(it.edited_at)
      if (!byDay.has(day)) byDay.set(day, [])
      byDay.get(day).push(it)
    }
    return Array.from(byDay.entries()).sort((a, b) => (a[0] < b[0] ? 1 : -1))
  }, [items])

  const startReschedule = (item) => {
    setDateFor(item.id)
    setPickedDate('')
    setResult(null)
  }

  const confirmReschedule = async (item) => {
    if (!pickedDate) return
    setBusyId(item.id)
    try {
      const res = await rescheduleStockOutItem({
        item, targetDate: pickedDate, repId, repName, brand: item.orders?.brand
      })
      setResult({ itemId: item.id, isAddon: res.isAddon })
      setDateFor(null)
      onRescheduled?.(item.id)
    } catch (e) {
      console.error(e)
      alert(e.message || 'Could not reschedule this item.')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center">
      <div className="bg-white w-full sm:max-w-lg sm:rounded-3xl rounded-t-3xl max-h-[88vh] flex flex-col">
        <div className="flex items-center justify-between p-4 border-b border-slate-100">
          <div>
            <h2 className="font-bold text-slate-800 text-lg">Pending Orders</h2>
            <p className="text-[11px] text-slate-400">Stock-out products you can reschedule</p>
          </div>
          <button onClick={onClose} className="h-9 w-9 rounded-full flex items-center justify-center text-slate-500 hover:bg-slate-100">
            <CloseIcon className="h-5 w-5" />
          </button>
        </div>

        <div className="overflow-y-auto p-3 space-y-4">
          {groups.length === 0 && (
            <p className="text-center text-sm text-slate-400 py-10">No pending stock-out items. 🎉</p>
          )}

          {groups.map(([day, dayItems]) => (
            <div key={day}>
              <p className="text-[11px] font-bold text-slate-500 uppercase tracking-wide mb-1.5">
                {prettyDate(day)}
              </p>
              <div className="space-y-2">
                {dayItems.map((it) => (
                  <div key={it.id} className="rounded-2xl border border-amber-200 bg-amber-50/60 p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-slate-800 truncate">{it.product_name}</p>
                        <p className="text-[11px] text-slate-500">
                          {it.orders?.shop_name}{it.orders?.route ? `, ${it.orders.route}` : ''}
                        </p>
                        <p className="text-[11px] text-slate-400 mt-0.5">
                          Qty {it.qty} {it.unit || ''} · Stock-out {prettyDate(istDateStr(it.edited_at))}
                        </p>
                      </div>
                      <span className="shrink-0 text-[10px] font-bold text-red-700 bg-red-100 px-2 py-1 rounded-lg">Stock Out</span>
                    </div>

                    {result?.itemId === it.id ? (
                      <p className="text-xs font-semibold text-emerald-700 mt-2">
                        ✓ Rescheduled — {result.isAddon ? 'added to the existing order for that date.' : 'a new order was created for that date.'}
                      </p>
                    ) : dateFor === it.id ? (
                      <div className="flex items-center gap-2 mt-2">
                        <input
                          type="date"
                          min={todayStr()}
                          value={pickedDate}
                          onChange={(e) => setPickedDate(e.target.value)}
                          className="flex-1 rounded-lg border border-slate-200 px-2 py-1.5 text-sm outline-none focus:border-brand-500"
                        />
                        <button
                          onClick={() => confirmReschedule(it)}
                          disabled={!pickedDate || busyId === it.id}
                          className="rounded-lg bg-brand-600 text-white text-xs font-bold px-3 py-1.5 disabled:bg-slate-300"
                        >
                          {busyId === it.id ? '…' : 'Confirm'}
                        </button>
                        <button onClick={() => setDateFor(null)} className="text-xs font-semibold text-slate-500 px-2">Cancel</button>
                      </div>
                    ) : (
                      <button
                        onClick={() => startReschedule(it)}
                        className="mt-2 w-full rounded-lg bg-white border border-amber-300 text-amber-800 text-xs font-bold py-2"
                      >
                        Reschedule
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
