import { useEffect, useState } from 'react'
import { loadMyAnnouncements, markAnnouncementRead } from '../utils/cloudSync.js'

/**
 * Shows an unread announcement as a popup when the user enters the app.
 *
 * Deliberately built on the EXISTING announcement infrastructure rather than a
 * parallel one: recipients, targeting and the read/unread state all already
 * live in `announcement_recipients`, and the bell icon already reads from the
 * same place. This component only adds the on-entry popup layer — the bell
 * item is untouched and remains available afterwards.
 *
 * Read state is what stops it repeating: an announcement is marked read only
 * when the user actually presses OK, never merely because it was created or
 * displayed, so acknowledging it once prevents it appearing on later logins
 * while leaving it in the notification list.
 *
 * Used by both sales reps and the billing team — the underlying query is
 * keyed on the signed-in user id, not on role.
 */
export default function AnnouncementPopup() {
  const [item, setItem] = useState(null)
  const [expanded, setExpanded] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    // Checks on mount, then every 30s, and whenever the tab regains focus.
    // Mount-only was not enough: a billing user sitting on an already-open
    // dashboard would never see an add-on alert until they happened to
    // reload. Polling mirrors how OrderChangeNotifier already works for reps.
    const check = () => {
      loadMyAnnouncements()
        .then((list) => {
          if (cancelled) return
          const unread = (list || []).find((a) => !a.readAt)
          // Only raise a popup when one isn't already showing, so an alert
          // arriving mid-read can't replace what the user is looking at.
          if (unread) setItem((cur) => cur || unread)
        })
        .catch(() => {})
    }
    check()
    const id = setInterval(check, 30000)
    const onFocus = () => check()
    window.addEventListener('focus', onFocus)
    return () => {
      cancelled = true
      clearInterval(id)
      window.removeEventListener('focus', onFocus)
    }
  }, [])

  if (!item) return null

  // Addon alerts get "View Bill"; product/price updates get "View Changes".
  const isAddon = item.notifType === 'addon'
  const primaryLabel = isAddon ? 'View Bill' : 'View Changes'

  const acknowledge = async () => {
    setBusy(true)
    try {
      await markAnnouncementRead(item.recipientId)
    } catch (e) {
      // Non-fatal: dismiss either way so the user is never stuck behind it.
      console.error('could not mark announcement read', e)
    } finally {
      setBusy(false)
      setItem(null)
    }
  }

  return (
    <div className="fixed inset-0 z-[60] bg-black/50 flex items-end sm:items-center justify-center p-3">
      <div className="bg-white w-full sm:max-w-md rounded-2xl shadow-2xl overflow-hidden">
        <div className="p-4 border-b border-slate-100">
          <p className="text-base font-bold text-slate-800">🔔 {item.title}</p>
        </div>

        <div className="p-4 max-h-[50vh] overflow-y-auto">
          <p className="text-sm text-slate-700 whitespace-pre-wrap">
            {expanded ? item.body : (item.body || '').split('\n').slice(0, 3).join('\n')}
          </p>
          {!expanded && (item.body || '').split('\n').length > 3 && (
            <p className="text-[11px] text-slate-400 mt-1">…</p>
          )}
        </div>

        <div className="flex gap-2 p-3 border-t border-slate-100">
          <button
            onClick={() => setExpanded(true)}
            disabled={expanded}
            className="flex-1 min-w-0 rounded-xl border border-brand-200 bg-brand-50 text-brand-700 text-sm font-bold py-2.5 disabled:opacity-40"
          >
            {primaryLabel}
          </button>
          <button
            onClick={acknowledge}
            disabled={busy}
            className="flex-1 min-w-0 rounded-xl bg-slate-900 text-white text-sm font-bold py-2.5 disabled:bg-slate-400"
          >
            {busy ? '…' : 'OK'}
          </button>
        </div>
      </div>
    </div>
  )
}
