import { useEffect, useState } from 'react'
import { loadMyAnnouncements, markAnnouncementRead, currentUserId } from '../utils/cloudSync.js'
import { supabase } from '../utils/supabase.js'

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
    const check = () => {
      loadMyAnnouncements()
        .then((list) => {
          if (cancelled) return
          const unread = (list || []).find((a) => !a.readAt)
          // Only raise a popup when one isn't already showing, so an alert
          // arriving mid-read can't replace what the user is looking at.
          // Read state lives in announcement_recipients, so an acknowledged
          // item is never re-shown — that is what dedupes across refreshes,
          // reconnects and multiple tabs.
          if (unread) setItem((cur) => cur || unread)
        })
        .catch(() => {})
    }
    check()

    // REALTIME: a row is inserted into announcement_recipients for each
    // targeted user the moment a Sales Rep's add-on is recorded, so listening
    // for inserts on THIS user's rows makes the popup appear immediately —
    // no refresh, no waiting for the next poll. Filtered server-side by
    // rep_id so a user is never woken by someone else's notification.
    let channel = null
    currentUserId()
      .then((uid) => {
        if (!uid || cancelled) return
        channel = supabase
          .channel(`announcement_recipients:${uid}`)
          .on(
            'postgres_changes',
            { event: 'INSERT', schema: 'public', table: 'announcement_recipients', filter: `rep_id=eq.${uid}` },
            () => check()
          )
          .subscribe()
      })
      .catch(() => {})

    // Poll + focus check remain as a safety net only: realtime can drop out
    // on flaky mobile networks, and this guarantees the alert still surfaces.
    const id = setInterval(check, 30000)
    const onFocus = () => check()
    window.addEventListener('focus', onFocus)
    return () => {
      cancelled = true
      clearInterval(id)
      window.removeEventListener('focus', onFocus)
      if (channel) supabase.removeChannel(channel)
    }
  }, [])

  if (!item) return null

  // Action label follows the notification type: add-ons open the bill,
  // removals open the affected order, product/price updates show the changes.
  // Falls back to "View Changes" when notif_type is unavailable (migration 57
  // not yet applied), so the popup still works rather than breaking.
  const primaryLabel =
    item.notifType === 'addon' ? 'View Bill'
      : item.notifType === 'removal' ? 'View Order'
        : 'View Changes'

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
