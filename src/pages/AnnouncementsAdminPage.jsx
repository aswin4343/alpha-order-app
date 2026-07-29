import { useEffect, useState } from 'react'
import { listSalespeople, sendAnnouncement, listSentAnnouncements } from '../utils/cloudSync.js'
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

export default function AnnouncementsAdminPage({ onBack }) {
  const [reps, setReps] = useState([])
  const [sent, setSent] = useState([])
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [highPriority, setHighPriority] = useState(false)
  const [audience, setAudience] = useState('all') // 'all' | 'selected'
  const [selected, setSelected] = useState(new Set())
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  const loadAll = async () => {
    try {
      const [r, s] = await Promise.all([listSalespeople(), listSentAnnouncements()])
      setReps(r)
      setSent(s)
    } catch (e) {
      console.error(e)
    }
  }
  useEffect(() => {
    loadAll()
  }, [])

  const toggleRep = (id) => {
    setSelected((prev) => {
      const n = new Set(prev)
      n.has(id) ? n.delete(id) : n.add(id)
      return n
    })
  }

  const send = async () => {
    setMsg('')
    if (!title.trim()) {
      setMsg('Please enter a title.')
      return
    }
    if (audience === 'selected' && selected.size === 0) {
      setMsg('Select at least one salesperson, or choose All.')
      return
    }
    setBusy(true)
    try {
      await sendAnnouncement({
        title: title.trim(),
        body: body.trim(),
        highPriority,
        audience,
        repIds: Array.from(selected)
      })
      setTitle('')
      setBody('')
      setHighPriority(false)
      setAudience('all')
      setSelected(new Set())
      setMsg('Announcement sent.')
      loadAll()
    } catch (e) {
      console.error(e)
      setMsg('Could not send. Check your connection.')
    } finally {
      setBusy(false)
    }
  }

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

      <main className="mx-auto max-w-md px-3 pt-4 space-y-4">
        {/* Compose */}
        <div className="rounded-2xl bg-white shadow-card border border-slate-100 p-4 space-y-3">
          <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide">New announcement</p>

          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Title (e.g. New Offer on Sauces)"
            className="w-full rounded-xl border border-slate-200 px-3 py-3 outline-none focus:border-brand-500"
          />
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Message (optional details)"
            rows={3}
            className="w-full rounded-xl border border-slate-200 px-3 py-3 outline-none focus:border-brand-500 resize-none"
          />

          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={highPriority}
              onChange={(e) => setHighPriority(e.target.checked)}
              className="h-4 w-4"
            />
            🔴 High priority
          </label>

          {/* Audience */}
          <div className="flex gap-1.5">
            {[
              ['all', 'All reps'],
              ['selected', 'Selected reps']
            ].map(([key, label]) => (
              <button
                key={key}
                onClick={() => setAudience(key)}
                className={`flex-1 py-2 rounded-lg text-sm font-semibold ${
                  audience === key
                    ? 'bg-brand-600 text-white'
                    : 'bg-white border border-slate-200 text-slate-600'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {audience === 'selected' && (
            <div className="space-y-1.5 max-h-48 overflow-y-auto">
              {reps.map((r) => (
                <label
                  key={r.id}
                  className="flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2.5 text-sm"
                >
                  <input
                    type="checkbox"
                    checked={selected.has(r.id)}
                    onChange={() => toggleRep(r.id)}
                    className="h-4 w-4"
                  />
                  {r.full_name || 'Unnamed'}
                </label>
              ))}
            </div>
          )}

          <button
            onClick={send}
            disabled={busy}
            className="w-full rounded-xl bg-brand-600 text-white py-3.5 font-bold active:bg-brand-700 disabled:bg-slate-200 disabled:text-slate-400"
          >
            {busy ? 'Sending…' : 'Send Announcement'}
          </button>

          {msg && <p className="text-sm text-center text-slate-600">{msg}</p>}
        </div>

        {/* Sent history */}
        <div>
          <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2 px-1">
            Sent
          </p>
          <div className="space-y-2">
            {sent.map((a) => (
              <div key={a.id} className="rounded-2xl bg-white shadow-card border border-slate-100 p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-semibold text-slate-800">
                      {a.highPriority && '🔴 '}
                      {a.title}
                    </p>
                    {a.body && <p className="text-[13px] text-slate-500 mt-0.5">{a.body}</p>}
                  </div>
                </div>
                <div className="flex items-center justify-between mt-2 text-[11px] text-slate-400">
                  <span>{fmt(a.createdAt)}</span>
                  <span>
                    Read by {a.read}/{a.total}
                  </span>
                </div>
              </div>
            ))}
            {sent.length === 0 && (
              <p className="text-center text-sm text-slate-400 py-4">No announcements sent yet.</p>
            )}
          </div>
        </div>
      </main>
    </div>
  )
}
