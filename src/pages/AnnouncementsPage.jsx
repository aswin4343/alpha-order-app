import { useEffect, useState } from 'react'
import { loadMyAnnouncements, markAnnouncementRead } from '../utils/cloudSync.js'
import { BackIcon } from '../components/Icons.jsx'

function fmt(iso) {
  try {
    return new Date(iso).toLocaleString('en-IN', {
      day: 'numeric',
      month: 'short',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    })
  } catch {
    return ''
  }
}

export default function AnnouncementsPage({ onBack, onChanged }) {
  const [list, setList] = useState(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    let active = true
    ;(async () => {
      try {
        const items = await loadMyAnnouncements()
        if (!active) return
        setList(items)
        // Mark all unread as read on open.
        const unread = items.filter((i) => !i.readAt)
        await Promise.all(unread.map((i) => markAnnouncementRead(i.recipientId)))
        if (onChanged) onChanged()
      } catch {
        if (active) setError(true)
      }
    })()
    return () => {
      active = false
    }
  }, [])

  return (
    <div className="min-h-screen bg-slate-50 pb-10">
      <header className="sticky top-0 z-20 bg-white border-b border-slate-100 safe-top">
        <div className="mx-auto max-w-md px-3 py-2.5 flex items-center gap-2">
          <button
            onClick={onBack}
            className="h-10 w-10 rounded-full flex items-center justify-center text-slate-600 active:bg-slate-100"
          >
            <BackIcon className="h-6 w-6" />
          </button>
          <h1 className="text-lg font-bold text-slate-800">Announcements</h1>
        </div>
      </header>

      <main className="mx-auto max-w-md px-3 pt-4">
        {error && (
          <p className="text-center text-sm text-red-500 py-6">
            Could not load announcements. Check your connection.
          </p>
        )}

        {!list && !error && (
          <div className="py-16 flex justify-center">
            <div className="h-8 w-8 rounded-full border-4 border-brand-100 border-t-brand-600 animate-spin" />
          </div>
        )}

        <div className="space-y-2">
          {list &&
            list.map((a) => (
              <div
                key={a.recipientId}
                className={`rounded-2xl bg-white shadow-card border p-4 ${
                  a.highPriority ? 'border-red-200' : 'border-slate-100'
                }`}
              >
                <div className="flex items-start gap-2">
                  {!a.readAt && (
                    <span className="mt-1.5 h-2 w-2 rounded-full bg-brand-600 shrink-0" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-slate-800">
                      {a.highPriority && '🔴 '}
                      {a.title}
                    </p>
                    {a.body && <p className="text-sm text-slate-600 mt-1 whitespace-pre-wrap">{a.body}</p>}
                    <p className="text-[11px] text-slate-400 mt-2">{fmt(a.createdAt)}</p>
                  </div>
                </div>
              </div>
            ))}
          {list && list.length === 0 && (
            <p className="text-center text-sm text-slate-400 py-10">No announcements yet.</p>
          )}
        </div>
      </main>
    </div>
  )
}
