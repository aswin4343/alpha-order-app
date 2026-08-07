import { useEffect, useState } from 'react'
import { listSalespeople, renameSalesperson } from '../utils/cloudSync.js'
import { BackIcon } from '../components/Icons.jsx'

/**
 * Admin — rename salespeople display names. Login credentials are unchanged;
 * only the name shown on orders, the leaderboard and reports updates.
 */
export default function SalespeopleAdminPage({ onBack }) {
  const [reps, setReps] = useState(null)
  const [error, setError] = useState(false)
  const [editing, setEditing] = useState(null) // id being edited
  const [draft, setDraft] = useState('')
  const [savingId, setSavingId] = useState(null)
  const [msg, setMsg] = useState('')

  const load = async () => {
    setError(false)
    try {
      setReps(await listSalespeople())
    } catch {
      setError(true)
    }
  }
  useEffect(() => {
    load()
  }, [])

  const startEdit = (rep) => {
    setEditing(rep.id)
    setDraft(rep.full_name || '')
    setMsg('')
  }

  const save = async (rep) => {
    const name = draft.trim()
    if (!name) {
      setMsg('Name cannot be empty.')
      return
    }
    setSavingId(rep.id)
    try {
      await renameSalesperson(rep.id, name)
      setReps((prev) => prev.map((r) => (r.id === rep.id ? { ...r, full_name: name } : r)))
      setEditing(null)
      setMsg(`Renamed to "${name}".`)
    } catch (e) {
      console.error(e)
      setMsg('Could not save. Check your connection.')
    } finally {
      setSavingId(null)
    }
  }

  return (
    <div className="min-h-screen bg-slate-50 pb-10">
      <header className="sticky top-0 z-20 bg-white border-b border-slate-100 safe-top">
        <div className="mx-auto max-w-3xl px-3 py-2.5 flex items-center gap-2">
          <button
            onClick={onBack}
            className="h-10 w-10 rounded-full flex items-center justify-center text-slate-600 active:bg-slate-100"
          >
            <BackIcon className="h-6 w-6" />
          </button>
          <h1 className="text-lg font-bold text-slate-800">Salespeople</h1>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-3 pt-4">
        <p className="text-sm text-slate-500 mb-3 px-1">
          Rename any salesperson. Their login username and password stay the same — only the
          displayed name changes (on orders, leaderboard and reports).
        </p>

        {error && (
          <p className="text-center text-sm text-red-500 py-6">
            Could not load salespeople. Check your connection.
          </p>
        )}

        {!reps && !error && (
          <div className="py-16 flex justify-center">
            <div className="h-8 w-8 rounded-full border-4 border-brand-100 border-t-brand-600 animate-spin" />
          </div>
        )}

        <div className="space-y-2">
          {reps &&
            reps.map((rep) => (
              <div
                key={rep.id}
                className="rounded-2xl bg-white shadow-card border border-slate-100 p-3"
              >
                {editing === rep.id ? (
                  <div className="flex items-center gap-2">
                    <input
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      autoFocus
                      className="flex-1 rounded-xl border border-slate-200 px-3 py-2.5 outline-none focus:border-brand-500"
                      placeholder="Display name"
                    />
                    <button
                      onClick={() => save(rep)}
                      disabled={savingId === rep.id}
                      className="rounded-xl bg-brand-600 text-white px-4 py-2.5 text-sm font-semibold disabled:bg-slate-300"
                    >
                      {savingId === rep.id ? '…' : 'Save'}
                    </button>
                    <button
                      onClick={() => setEditing(null)}
                      className="rounded-xl border border-slate-200 px-3 py-2.5 text-sm text-slate-500"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center justify-between">
                    <div className="min-w-0">
                      <p className="font-semibold text-slate-800 truncate">
                        {rep.full_name || 'Unnamed'}
                      </p>
                      {rep.route && (
                        <p className="text-[11px] text-slate-400 truncate">{rep.route}</p>
                      )}
                    </div>
                    <button
                      onClick={() => startEdit(rep)}
                      className="text-sm font-semibold text-brand-600 px-3 py-1.5 rounded-lg active:bg-brand-50"
                    >
                      Rename
                    </button>
                  </div>
                )}
              </div>
            ))}
          {reps && reps.length === 0 && (
            <p className="text-center text-sm text-slate-400 py-6">No salespeople found.</p>
          )}
        </div>

        {msg && (
          <div className="rounded-xl bg-slate-100 border border-slate-200 px-3 py-2.5 mt-4">
            <p className="text-[13px] text-slate-700">{msg}</p>
          </div>
        )}
      </main>
    </div>
  )
}
