import { useState, useCallback } from 'react'
import { useApp } from '../context/AppContext.jsx'
import { useSearch } from '../hooks/useSearch.js'
import { useDebounce } from '../hooks/useDebounce.js'
import { SearchIcon, CloseIcon, CheckIcon, PlusIcon } from './Icons.jsx'

const getCustomerText = (c) => `${c.name} ${c.area || ''}`

export default function CustomerPicker({ selected, onSelect }) {
  const { customers, addCustomer } = useApp()
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState('')

  const debounced = useDebounce(query, 100)
  const results = useSearch(customers, debounced, getCustomerText, 40)

  const choose = useCallback(
    (c) => {
      onSelect(c)
      setOpen(false)
      setQuery('')
      setAdding(false)
    },
    [onSelect]
  )

  const saveNew = async () => {
    const name = newName.trim()
    if (!name) return
    const rec = await addCustomer({ name })
    choose(rec)
    setNewName('')
  }

  // Collapsed state: show the selected customer as a chip.
  if (selected && !open) {
    return (
      <div className="flex items-center gap-3 rounded-2xl bg-white shadow-card px-4 py-3 border border-brand-500">
        <div className="h-9 w-9 rounded-full bg-brand-100 text-brand-700 flex items-center justify-center shrink-0">
          <CheckIcon className="h-5 w-5" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-slate-800 truncate">{selected.name}</p>
          {selected.area && <p className="text-xs text-slate-400 truncate">{selected.area}</p>}
        </div>
        <button
          onClick={() => setOpen(true)}
          className="text-sm font-semibold text-brand-600 px-3 py-1.5 rounded-lg active:bg-brand-50"
        >
          Change
        </button>
      </div>
    )
  }

  return (
    <div className="rounded-2xl bg-white shadow-card border border-slate-100 overflow-hidden">
      <div className="flex items-center gap-2 px-4">
        <SearchIcon className="h-5 w-5 text-slate-400 shrink-0" />
        <input
          autoFocus={open}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setAdding(false)
          }}
          onFocus={() => setOpen(true)}
          placeholder="Search Customer / Shop Name"
          className="flex-1 py-3.5 text-[15px] outline-none placeholder:text-slate-400"
        />
        {query && (
          <button onClick={() => setQuery('')} className="text-slate-400 p-1">
            <CloseIcon className="h-5 w-5" />
          </button>
        )}
      </div>

      {open && (
        <div className="border-t border-slate-100 max-h-72 overflow-y-auto scroll-area">
          {results.map((c) => (
            <button
              key={c.id}
              onClick={() => choose(c)}
              className="w-full text-left px-4 py-3 active:bg-slate-50 border-b border-slate-50"
            >
              <p className="text-[15px] font-medium text-slate-800">{c.name}</p>
              {c.area && <p className="text-xs text-slate-400 mt-0.5">{c.area}</p>}
            </button>
          ))}

          {results.length === 0 && !adding && (
            <div className="px-4 py-6 text-center text-sm text-slate-400">
              No customer found.
            </div>
          )}

          {/* Add new customer */}
          {!adding ? (
            <button
              onClick={() => {
                setAdding(true)
                setNewName(query)
              }}
              className="w-full flex items-center gap-2 px-4 py-3.5 text-brand-600 font-semibold active:bg-brand-50"
            >
              <PlusIcon className="h-5 w-5" /> Add New Customer
            </button>
          ) : (
            <div className="p-4 border-t border-slate-100 bg-slate-50">
              <input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="New shop / customer name"
                className="w-full rounded-xl border border-slate-200 px-3 py-3 outline-none focus:border-brand-500"
              />
              <div className="flex gap-2 mt-3">
                <button
                  onClick={() => setAdding(false)}
                  className="flex-1 py-2.5 rounded-xl bg-white border border-slate-200 font-medium text-slate-600"
                >
                  Cancel
                </button>
                <button
                  onClick={saveNew}
                  className="flex-1 py-2.5 rounded-xl bg-brand-600 text-white font-semibold active:bg-brand-700"
                >
                  Save & Select
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
