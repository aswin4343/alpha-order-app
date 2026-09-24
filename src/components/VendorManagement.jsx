// ============================================================================
// VendorManagement.jsx
//
// Full vendor master CRUD for the Purchase Manager.
// Features:
//   - Vendor list with Active/Inactive filter and search
//   - Add Vendor (manual form)
//   - Edit Vendor
//   - Activate / Deactivate (no deletion)
//   - Excel upload (.xlsx / .xls) with preview, duplicate detection, bulk import
//
// Column mapping from VENDOR_DETAILS.xlsx:
//   VENDOR NAME      → vendor_name
//   WEEKLY           → weekly_days  (comma-separated order days)
//   PO GENERATION GAP → po_gap_days
//   TIME             → preferred_time
//   BRAND            → brand
//   LEAD TIME        → lead_time_days (stored as text, e.g. "5-7")
// ============================================================================

import { useState, useEffect, useMemo, useRef } from 'react'
import * as XLSX from 'xlsx'
import {
  loadVendorsAll, addVendor, updateVendor, setVendorActive, importVendorsBulk
} from '../utils/cloudSync.js'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function normalizeHeader(h) {
  return (h || '').toString().trim().toUpperCase().replace(/\s+/g, ' ')
}

// Map the Excel column headers (from VENDOR_DETAILS.xlsx and reasonable variants)
// to internal field names.
const HEADER_MAP = {
  'VENDOR NAME':        'vendor_name',
  'VENDOR NAME ':       'vendor_name',
  'NAME':               'vendor_name',
  'WEEKLY':             'weekly_days',
  'WEEKLY ':            'weekly_days',
  'WEEKLY DAYS':        'weekly_days',
  'ORDER DAYS':         'weekly_days',
  'PO GENERATION GAP':  'po_gap_days',
  'PO GAP':             'po_gap_days',
  'GAP':                'po_gap_days',
  'LEAD TIME':          'lead_time_days',
  'LEAD TIME DAYS':     'lead_time_days',
  'BRAND':              'brand',
  'BRAND ':             'brand',
  'TIME':               'preferred_time',
  'ORDER TIME':         'preferred_time',
  'SL.NO':              '_sl',
  'SL NO':              '_sl',
  'S.NO':               '_sl',
}

function mapHeaders(rawHeaders) {
  return rawHeaders.map((h) => HEADER_MAP[normalizeHeader(h)] || null)
}

function parseExcel(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = (e) => {
      try {
        const wb = XLSX.read(e.target.result, { type: 'array' })
        const ws = wb.Sheets[wb.SheetNames[0]]
        // Find the header row (first row with ≥ 3 non-null cells)
        const range = XLSX.utils.decode_range(ws['!ref'] || 'A1:A1')
        let headerRow = -1
        let fieldMap = []
        for (let r = range.s.r; r <= Math.min(range.e.r, 20); r++) {
          const cells = []
          for (let c = range.s.c; c <= range.e.c; c++) {
            const cell = ws[XLSX.utils.encode_cell({ r, c })]
            cells.push(cell ? cell.v : null)
          }
          const mapped = mapHeaders(cells)
          const namedCols = mapped.filter(Boolean).length
          if (namedCols >= 2) {
            headerRow = r
            fieldMap = mapped
            break
          }
        }
        if (headerRow === -1) {
          return reject(new Error('Could not find a recognizable header row. Expected columns: VENDOR NAME, BRAND, PO GENERATION GAP, LEAD TIME, WEEKLY.'))
        }
        const rows = []
        for (let r = headerRow + 1; r <= range.e.r; r++) {
          const obj = {}
          for (let c = range.s.c; c <= range.e.c; c++) {
            const field = fieldMap[c - range.s.c]
            if (!field || field === '_sl') continue
            const cell = ws[XLSX.utils.encode_cell({ r, c })]
            obj[field] = cell ? (cell.v ?? null) : null
          }
          // Skip rows with no vendor name
          if (!obj.vendor_name || !String(obj.vendor_name).trim()) continue
          // Normalise
          obj.vendor_name   = String(obj.vendor_name).trim()
          obj.brand         = obj.brand    ? String(obj.brand).trim()    : null
          obj.weekly_days   = obj.weekly_days ? String(obj.weekly_days).trim() : null
          obj.preferred_time = obj.preferred_time ? String(obj.preferred_time).trim() : null
          obj.lead_time_days = obj.lead_time_days ? String(obj.lead_time_days).trim() : null
          obj.po_gap_days   = obj.po_gap_days != null ? (parseInt(obj.po_gap_days) || null) : null
          rows.push(obj)
        }
        resolve(rows)
      } catch (err) {
        reject(err)
      }
    }
    reader.onerror = () => reject(new Error('File read failed'))
    reader.readAsArrayBuffer(file)
  })
}

function validate(row, existingNames) {
  const errors = []
  if (!row.vendor_name?.trim()) errors.push('Missing vendor name')
  return errors
}

// ─── Blank vendor form ────────────────────────────────────────────────────────

const BLANK = {
  vendor_name: '', brand: '', weekly_days: '', po_gap_days: '',
  lead_time_days: '', preferred_time: '', contact_person: '',
  phone: '', email: '', address: '', gst_number: '',
  payment_terms: '', credit_days: '', active: true
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function Spinner() {
  return <div className="py-16 text-center text-slate-400 text-sm">Loading vendors…</div>
}

function VendorForm({ initial, onSave, onCancel, title, busy }) {
  const [form, setForm] = useState({ ...BLANK, ...initial })
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }))

  const field = (label, key, type = 'text', hint = '') => (
    <div>
      <label className="block text-[11px] font-semibold text-slate-500 mb-1 uppercase tracking-wide">{label}</label>
      <input
        type={type}
        value={form[key] ?? ''}
        onChange={(e) => set(key, e.target.value)}
        className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-brand-500"
        placeholder={hint}
      />
    </div>
  )

  return (
    <div className="fixed inset-0 z-[90] bg-black/40 flex items-end sm:items-center justify-center">
      <div className="bg-white w-full sm:max-w-lg rounded-t-3xl sm:rounded-3xl p-5 max-h-[90vh] overflow-y-auto">
        <h3 className="font-bold text-slate-800 text-base mb-4">{title}</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="sm:col-span-2">
            {field('Vendor Name *', 'vendor_name', 'text', 'e.g. MILKY MIST (FG 19)')}
          </div>
          {field('Brand', 'brand', 'text', 'e.g. MILKY MIST')}
          {field('PO Gap (days)', 'po_gap_days', 'number', 'e.g. 14')}
          {field('Lead Time', 'lead_time_days', 'text', 'e.g. 2-3')}
          {field('Weekly Order Days', 'weekly_days', 'text', 'e.g. MONDAY, THURSDAY')}
          {field('Preferred Time', 'preferred_time', 'text', 'e.g. 10.00AM')}
          {field('Contact Person', 'contact_person', 'text')}
          {field('Phone', 'phone', 'tel')}
          {field('Email', 'email', 'email')}
          {field('GST Number', 'gst_number', 'text')}
          {field('Payment Terms', 'payment_terms', 'text', 'e.g. Net 30')}
          {field('Credit Days', 'credit_days', 'number')}
          <div className="sm:col-span-2">
            <label className="block text-[11px] font-semibold text-slate-500 mb-1 uppercase tracking-wide">Address</label>
            <textarea
              value={form.address ?? ''}
              onChange={(e) => set('address', e.target.value)}
              rows={2}
              className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-brand-500 resize-none"
            />
          </div>
          <div className="sm:col-span-2 flex items-center gap-2">
            <input
              type="checkbox"
              id="v-active"
              checked={form.active !== false}
              onChange={(e) => set('active', e.target.checked)}
              className="w-4 h-4 accent-brand-600"
            />
            <label htmlFor="v-active" className="text-sm font-semibold text-slate-700">Active</label>
          </div>
        </div>

        <div className="flex gap-2 mt-5">
          <button
            onClick={() => onSave(form)}
            disabled={busy || !form.vendor_name?.trim()}
            className="flex-1 rounded-xl bg-brand-600 text-white py-3 font-bold active:bg-brand-700 disabled:opacity-50"
          >
            {busy ? 'Saving…' : 'Save Vendor'}
          </button>
          <button
            onClick={onCancel}
            className="rounded-xl border border-slate-200 text-slate-600 py-3 px-4 font-semibold text-sm"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Excel import preview ─────────────────────────────────────────────────────

function ImportPreview({ rows, existing, onConfirm, onCancel, busy }) {
  const existingNames = useMemo(
    () => new Map((existing || []).map((v) => [(v.vendor_name || '').trim().toUpperCase(), v])),
    [existing]
  )

  const annotated = useMemo(() => rows.map((row) => {
    const key = (row.vendor_name || '').trim().toUpperCase()
    const errors = validate(row, existingNames)
    const duplicate = existingNames.has(key)
    return { ...row, _errors: errors, _duplicate: duplicate, _valid: errors.length === 0 }
  }), [rows, existingNames])

  const newCount   = annotated.filter((r) => r._valid && !r._duplicate).length
  const dupCount   = annotated.filter((r) => r._duplicate).length
  const invalidCount = annotated.filter((r) => !r._valid).length

  return (
    <div className="fixed inset-0 z-[90] bg-black/40 flex items-center justify-center px-3">
      <div className="bg-white w-full max-w-3xl rounded-3xl p-5 max-h-[90vh] flex flex-col">
        <h3 className="font-bold text-slate-800 text-base mb-1">Vendor Import Preview</h3>
        <div className="flex gap-4 mb-3 text-[12px] text-slate-600">
          <span>Total: <b>{annotated.length}</b></span>
          <span className="text-emerald-700">New: <b>{newCount}</b></span>
          <span className="text-blue-700">Existing (will update): <b>{dupCount}</b></span>
          <span className="text-red-600">Invalid: <b>{invalidCount}</b></span>
        </div>

        <div className="overflow-auto flex-1 rounded-xl border border-slate-200">
          <table className="w-full text-[11px] border-collapse min-w-[560px]">
            <thead>
              <tr className="bg-slate-900 text-white text-left sticky top-0">
                <th className="px-2 py-2">Vendor Name</th>
                <th className="px-2 py-2">Brand</th>
                <th className="px-2 py-2 text-center">Gap</th>
                <th className="px-2 py-2">Lead Time</th>
                <th className="px-2 py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {annotated.map((r, i) => (
                <tr key={i} className={`border-t border-slate-100 ${!r._valid ? 'bg-red-50' : r._duplicate ? 'bg-blue-50' : ''}`}>
                  <td className="px-2 py-1.5 font-medium">{r.vendor_name}</td>
                  <td className="px-2 py-1.5 text-slate-500">{r.brand || '—'}</td>
                  <td className="px-2 py-1.5 text-center">{r.po_gap_days ?? '—'}</td>
                  <td className="px-2 py-1.5 text-slate-500">{r.lead_time_days || '—'}</td>
                  <td className="px-2 py-1.5">
                    {!r._valid
                      ? <span className="text-red-600 font-semibold">⚠ {r._errors.join(', ')}</span>
                      : r._duplicate
                      ? <span className="text-blue-700 font-semibold">↻ Update existing</span>
                      : <span className="text-emerald-700 font-semibold">✓ New</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="flex gap-2 mt-4">
          <button
            onClick={() => onConfirm(annotated.filter((r) => r._valid))}
            disabled={busy || newCount + dupCount === 0}
            className="flex-1 rounded-xl bg-brand-600 text-white py-3 font-bold disabled:opacity-50"
          >
            {busy ? 'Importing…' : `Import ${newCount} New + ${dupCount} Updates`}
          </button>
          <button
            onClick={onCancel}
            className="rounded-xl border border-slate-200 text-slate-600 py-3 px-4 font-semibold text-sm"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Main VendorManagement component ─────────────────────────────────────────

export default function VendorManagement() {
  const [vendors, setVendors]     = useState(null)
  const [filter, setFilter]       = useState('active') // active | inactive | all
  const [query, setQuery]         = useState('')
  const [modal, setModal]         = useState(null)     // null | 'add' | { edit: vendor }
  const [importRows, setImportRows] = useState(null)   // parsed excel rows for preview
  const [busy, setBusy]           = useState(false)
  const [toast, setToast]         = useState('')
  const fileRef = useRef()

  const load = async () => {
    setVendors(null)
    const data = await loadVendorsAll()
    setVendors(data)
  }
  useEffect(() => { load() }, [])

  const flash = (msg) => { setToast(msg); setTimeout(() => setToast(''), 3500) }

  // ── Filtered / searched list ──
  const displayed = useMemo(() => {
    if (!vendors) return []
    const q = query.trim().toUpperCase()
    return vendors.filter((v) => {
      if (filter === 'active'   && !v.active) return false
      if (filter === 'inactive' && v.active)  return false
      if (!q) return true
      return (
        (v.vendor_name || '').toUpperCase().includes(q) ||
        (v.brand       || '').toUpperCase().includes(q) ||
        (v.contact_person || '').toUpperCase().includes(q) ||
        (v.phone       || '').toUpperCase().includes(q) ||
        (String(v.id   || '')).includes(q)
      )
    })
  }, [vendors, filter, query])

  // ── Add vendor ──
  const handleAdd = async (form) => {
    setBusy(true)
    try {
      const payload = {
        vendor_name:    form.vendor_name.trim(),
        brand:          form.brand?.trim() || null,
        weekly_days:    form.weekly_days?.trim() || null,
        po_gap_days:    form.po_gap_days !== '' ? parseInt(form.po_gap_days) || null : null,
        lead_time_days: form.lead_time_days?.trim() || null,
        preferred_time: form.preferred_time?.trim() || null,
        contact_person: form.contact_person?.trim() || null,
        phone:          form.phone?.trim() || null,
        email:          form.email?.trim() || null,
        address:        form.address?.trim() || null,
        gst_number:     form.gst_number?.trim() || null,
        payment_terms:  form.payment_terms?.trim() || null,
        credit_days:    form.credit_days !== '' ? parseInt(form.credit_days) || null : null,
        active:         form.active !== false,
      }
      await addVendor(payload)
      await load()
      setModal(null)
      flash('Vendor added ✅')
    } catch (e) {
      alert(e?.message || 'Could not add vendor')
    } finally {
      setBusy(false)
    }
  }

  // ── Edit vendor ──
  const handleEdit = async (form) => {
    setBusy(true)
    try {
      const payload = {
        vendor_name:    form.vendor_name.trim(),
        brand:          form.brand?.trim() || null,
        weekly_days:    form.weekly_days?.trim() || null,
        po_gap_days:    form.po_gap_days !== '' ? parseInt(form.po_gap_days) || null : null,
        lead_time_days: form.lead_time_days?.trim() || null,
        preferred_time: form.preferred_time?.trim() || null,
        contact_person: form.contact_person?.trim() || null,
        phone:          form.phone?.trim() || null,
        email:          form.email?.trim() || null,
        address:        form.address?.trim() || null,
        gst_number:     form.gst_number?.trim() || null,
        payment_terms:  form.payment_terms?.trim() || null,
        credit_days:    form.credit_days !== '' ? parseInt(form.credit_days) || null : null,
        active:         form.active !== false,
        updated_at:     new Date().toISOString(),
      }
      await updateVendor(modal.edit.id, payload)
      await load()
      setModal(null)
      flash('Vendor updated ✅')
    } catch (e) {
      alert(e?.message || 'Could not update vendor')
    } finally {
      setBusy(false)
    }
  }

  // ── Activate / Deactivate ──
  const toggleActive = async (v) => {
    const msg = v.active
      ? `Deactivate "${v.vendor_name}"? Historical POs will be preserved.`
      : `Reactivate "${v.vendor_name}"?`
    if (!window.confirm(msg)) return
    try {
      await setVendorActive(v.id, !v.active)
      await load()
      flash(v.active ? 'Vendor deactivated' : 'Vendor reactivated ✅')
    } catch (e) {
      alert(e?.message || 'Could not update vendor status')
    }
  }

  // ── Excel upload ──
  const handleFileChange = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    fileRef.current.value = ''
    try {
      const rows = await parseExcel(file)
      if (rows.length === 0) { alert('No vendor rows found in the file.'); return }
      setImportRows(rows)
    } catch (err) {
      alert('Could not read Excel file: ' + (err?.message || String(err)))
    }
  }

  const handleImportConfirm = async (validRows) => {
    setBusy(true)
    try {
      const result = await importVendorsBulk(validRows)
      await load()
      setImportRows(null)
      flash(`Import complete — ${result.inserted} added, ${result.updated} updated ✅`)
    } catch (e) {
      alert('Import failed: ' + (e?.message || String(e)))
    } finally {
      setBusy(false)
    }
  }

  if (!vendors) return <Spinner />

  const counts = {
    all:      vendors.length,
    active:   vendors.filter((v) => v.active).length,
    inactive: vendors.filter((v) => !v.active).length,
  }

  return (
    <div className="space-y-4">
      {/* Header row: title + action buttons */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <h2 className="font-bold text-slate-800 text-base">Vendor Management</h2>
          <p className="text-[11px] text-slate-400">{counts.active} active · {counts.inactive} inactive vendors</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => fileRef.current?.click()}
            className="rounded-xl border border-brand-300 text-brand-700 text-sm font-semibold px-3 py-2 hover:bg-brand-50"
          >
            📤 Upload Excel
          </button>
          <button
            onClick={() => setModal('add')}
            className="rounded-xl bg-brand-600 text-white text-sm font-bold px-3 py-2"
          >
            + Add Vendor
          </button>
          <input ref={fileRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={handleFileChange} />
        </div>
      </div>

      {/* Search + filter */}
      <div className="flex gap-2 flex-wrap items-center">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search vendor name, brand, phone…"
          className="flex-1 min-w-[180px] rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-brand-500 bg-white"
        />
        {[['active', `Active (${counts.active})`], ['inactive', `Inactive (${counts.inactive})`], ['all', `All (${counts.all})`]].map(([k, l]) => (
          <button key={k} onClick={() => setFilter(k)}
            className={`px-3 py-1.5 rounded-full text-xs font-semibold border transition ${filter === k ? 'bg-brand-600 text-white border-brand-600' : 'text-slate-600 border-slate-200 hover:bg-slate-50'}`}>
            {l}
          </button>
        ))}
      </div>

      {/* Vendor list */}
      {displayed.length === 0 ? (
        <div className="py-12 text-center text-slate-400 text-sm">
          {query ? 'No vendors match your search.' : filter === 'inactive' ? 'No inactive vendors.' : 'No vendors yet. Upload Excel or add manually.'}
        </div>
      ) : (
        <div className="space-y-2">
          {displayed.map((v) => (
            <div
              key={v.id}
              className={`bg-white rounded-2xl border p-4 flex items-start gap-3 ${v.active ? 'border-slate-100' : 'border-slate-200 opacity-60'}`}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="font-semibold text-slate-800 text-sm leading-tight">{v.vendor_name}</p>
                  {v.brand && (
                    <span className="text-[10px] text-slate-500 bg-slate-100 px-1.5 py-0.5 rounded font-medium">{v.brand}</span>
                  )}
                  {!v.active && (
                    <span className="text-[10px] text-orange-700 bg-orange-50 border border-orange-200 px-1.5 py-0.5 rounded font-semibold">Inactive</span>
                  )}
                </div>
                <div className="flex items-center gap-3 mt-1 flex-wrap text-[11px] text-slate-400">
                  {v.po_gap_days   && <span>Every {v.po_gap_days}d</span>}
                  {v.weekly_days   && <span>📅 {v.weekly_days}</span>}
                  {v.lead_time_days && <span>Lead: {v.lead_time_days}</span>}
                  {v.phone         && <span>📞 {v.phone}</span>}
                  {v.contact_person && <span>👤 {v.contact_person}</span>}
                </div>
              </div>
              <div className="flex gap-1.5 shrink-0">
                <button
                  onClick={() => setModal({ edit: v })}
                  className="text-[11px] font-semibold text-slate-600 px-2.5 py-1.5 rounded-lg border border-slate-200 hover:bg-slate-50"
                >
                  Edit
                </button>
                <button
                  onClick={() => toggleActive(v)}
                  className={`text-[11px] font-semibold px-2.5 py-1.5 rounded-lg border ${
                    v.active
                      ? 'text-red-600 border-red-200 hover:bg-red-50'
                      : 'text-emerald-700 border-emerald-200 hover:bg-emerald-50'
                  }`}
                >
                  {v.active ? 'Deactivate' : 'Reactivate'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add modal */}
      {modal === 'add' && (
        <VendorForm
          title="Add New Vendor"
          initial={BLANK}
          onSave={handleAdd}
          onCancel={() => setModal(null)}
          busy={busy}
        />
      )}

      {/* Edit modal */}
      {modal?.edit && (
        <VendorForm
          title={`Edit — ${modal.edit.vendor_name}`}
          initial={{
            ...BLANK,
            ...modal.edit,
            po_gap_days:   modal.edit.po_gap_days  ?? '',
            credit_days:   modal.edit.credit_days  ?? '',
          }}
          onSave={handleEdit}
          onCancel={() => setModal(null)}
          busy={busy}
        />
      )}

      {/* Import preview */}
      {importRows && (
        <ImportPreview
          rows={importRows}
          existing={vendors}
          onConfirm={handleImportConfirm}
          onCancel={() => setImportRows(null)}
          busy={busy}
        />
      )}

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 bg-slate-900 text-white text-sm font-semibold px-4 py-2.5 rounded-xl shadow-lg pointer-events-none">
          {toast}
        </div>
      )}
    </div>
  )
}
