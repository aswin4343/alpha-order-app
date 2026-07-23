import { useState, useCallback } from 'react'
import { useApp } from '../context/AppContext.jsx'
import { useSearch } from '../hooks/useSearch.js'
import { useDebounce } from '../hooks/useDebounce.js'
import { SearchIcon, CloseIcon, CheckIcon, PlusIcon } from './Icons.jsx'
import NewCustomerModal from './NewCustomerModal.jsx'
import EditCustomerModal from './EditCustomerModal.jsx'

const getCustomerText = (c) => `${c.name} ${c.route || ''} ${c.area || ''}`

export default function CustomerPicker({ selected, onSelect }) {
  const { customers } = useApp()
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [showNew, setShowNew] = useState(false)
  const [showEdit, setShowEdit] = useState(false)

  const debounced = useDebounce(query, 100)
  const results = useSearch(customers, debounced, getCustomerText, 40)

  const choose = useCallback(
    (c) => {
      onSelect(c)
      setOpen(false)
      setQuery('')
    },
    [onSelect]
  )

  // Collapsed: show the chosen customer with route.
  if (selected && !open) {
    return (
      <>
      <div className="flex items-center gap-3 rounded-2xl bg-white shadow-card px-4 py-3 border border-brand-500">
        <div className="h-9 w-9 rounded-full bg-brand-100 text-brand-700 flex items-center justify-center shrink-0">
          <CheckIcon className="h-5 w-5" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-slate-800 truncate">{selected.name}</p>
          {selected.route && (
            <p className="text-xs text-slate-400 truncate">{selected.route}</p>
          )}
          <div className="flex flex-wrap gap-1 mt-1">
            {selected.category && (
              <span className="text-[10px] text-slate-500 bg-slate-100 px-1.5 py-0.5 rounded">
                {selected.category}
              </span>
            )}
            <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
              selected.creditDays && selected.creditDays !== 'No Credit'
                ? 'bg-amber-50 text-amber-700 border border-amber-200'
                : 'bg-slate-100 text-slate-500'
            }`}>
              Credit: {selected.creditDays || 'No Credit'}
            </span>
          </div>
        </div>
        <div className="flex flex-col gap-1 shrink-0">
          <button
            onClick={() => setOpen(true)}
            className="text-sm font-semibold text-brand-600 px-3 py-1.5 rounded-lg active:bg-brand-50"
          >
            Change
          </button>
          <button
            onClick={() => setShowEdit(true)}
            className="text-xs font-medium text-slate-500 px-3 py-1 rounded-lg active:bg-slate-100"
          >
            Edit
          </button>
        </div>
      </div>

      {showEdit && (
        <EditCustomerModal
          customer={selected}
          onClose={() => setShowEdit(false)}
          onSaved={(rec) => {
            setShowEdit(false)
            onSelect(rec)
          }}
        />
      )}
      </>
    )
  }

  return (
    <>
      <div className="rounded-2xl bg-white shadow-card border border-slate-100 overflow-hidden">
        <div className="flex items-center gap-2 px-4">
          <SearchIcon className="h-5 w-5 text-slate-400 shrink-0" />
          <input
            autoFocus={open}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => setOpen(true)}
            placeholder="Search Customer / Shop Name"
            className="flex-1 py-3.5 text-[15px] outline-none placeholder:text-slate-400"
          />
          {query && (
            <button onClick={() => setQuery('')} className="text-slate-400 p-1" aria-label="Clear">
              <CloseIcon className="h-5 w-5" />
            </button>
          )}
          <button
            onClick={() => setShowNew(true)}
            aria-label="Add new customer"
            className="h-9 w-9 rounded-full bg-brand-600 text-white flex items-center justify-center shrink-0 active:bg-brand-700"
          >
            <PlusIcon className="h-5 w-5" />
          </button>
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
                {(c.route || c.area) && (
                  <p className="text-xs text-slate-400 mt-0.5">
                    {[c.route, c.area].filter(Boolean).join(' · ')}
                  </p>
                )}
              </button>
            ))}

            {results.length === 0 && (
              <div className="px-4 py-6 text-center text-sm text-slate-400">
                No customer found.
              </div>
            )}

            <button
              onClick={() => setShowNew(true)}
              className="w-full flex items-center gap-2 px-4 py-3.5 text-brand-600 font-semibold active:bg-brand-50"
            >
              <PlusIcon className="h-5 w-5" /> Add New Customer
            </button>
          </div>
        )}
      </div>

      {showNew && (
        <NewCustomerModal
          initialName={query}
          onClose={() => setShowNew(false)}
          onCreated={(rec) => {
            setShowNew(false)
            choose(rec)
          }}
        />
      )}
    </>
  )
}
