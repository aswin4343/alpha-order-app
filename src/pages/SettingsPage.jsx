import { useRef, useState } from 'react'
import { useApp } from '../context/AppContext.jsx'
import { BackIcon, TrashIcon } from '../components/Icons.jsx'
import {
  importProducts,
  importCustomers,
  exportToExcel,
  downloadJson,
  readJsonFile
} from '../utils/excel.js'
import { ORDER_WHATSAPP_NUMBER } from '../utils/whatsapp.js'

function Section({ title, children }) {
  return (
    <div className="rounded-2xl bg-white shadow-card border border-slate-100 p-4">
      <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3">{title}</p>
      {children}
    </div>
  )
}

function FileButton({ label, accept, onFile, danger }) {
  const ref = useRef(null)
  return (
    <>
      <button
        onClick={() => ref.current?.click()}
        className={`w-full text-left py-3 px-1 font-medium ${
          danger ? 'text-red-600' : 'text-slate-700'
        }`}
      >
        {label}
      </button>
      <input
        ref={ref}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) onFile(f)
          e.target.value = ''
        }}
      />
    </>
  )
}

export default function SettingsPage({ onBack }) {
  const {
    settings,
    updateSettings,
    products,
    customers,
    replaceProducts,
    replaceCustomers,
    clearAll
  } = useApp()

  const [businessName, setBusinessName] = useState(settings.businessName)
  const [salesperson, setSalesperson] = useState(settings.salesperson)
  const [toast, setToast] = useState('')

  const flash = (msg) => {
    setToast(msg)
    setTimeout(() => setToast(''), 2500)
  }

  const saveProfile = () => {
    updateSettings({ businessName: businessName.trim() || 'Alpha Trade Links', salesperson: salesperson.trim() })
    flash('Saved')
  }

  const onImportProducts = async (file) => {
    try {
      const recs = await importProducts(file)
      if (recs.length === 0) return flash('No products found in file')
      await replaceProducts(recs)
      flash(`Imported ${recs.length} products`)
    } catch (e) {
      flash('Import failed — check file format')
    }
  }

  const onImportCustomers = async (file) => {
    try {
      const recs = await importCustomers(file)
      if (recs.length === 0) return flash('No customers found in file')
      await replaceCustomers(recs)
      flash(`Imported ${recs.length} customers`)
    } catch (e) {
      flash('Import failed — check file format')
    }
  }

  const onExportProducts = () => {
    exportToExcel(
      products.map(({ name, brand, category, unit }) => ({ ItemName: name, Brand: brand, Category: category, Unit: unit })),
      'Products',
      'ATL_products.xlsx'
    )
  }

  const onExportCustomers = () => {
    exportToExcel(
      customers.map(({ name, owner, phone, area }) => ({ Name: name, Owner: owner, Phone: phone, RouteName: area })),
      'Customers',
      'ATL_customers.xlsx'
    )
  }

  const onBackup = () => {
    downloadJson({ version: 1, settings, products, customers }, 'ATL_backup.json')
  }

  const onRestore = async (file) => {
    try {
      const data = await readJsonFile(file)
      if (data.products) await replaceProducts(data.products)
      if (data.customers) await replaceCustomers(data.customers)
      if (data.settings) updateSettings(data.settings)
      flash('Backup restored')
    } catch (e) {
      flash('Restore failed — invalid file')
    }
  }

  const onClearAll = async () => {
    if (!window.confirm('Delete ALL products and customers? This cannot be undone.')) return
    await clearAll()
    flash('All data cleared')
  }

  return (
    <div className="min-h-screen bg-slate-50 pb-10">
      <header className="sticky top-0 z-20 bg-white border-b border-slate-100 safe-top">
        <div className="mx-auto max-w-md px-3 py-2.5 flex items-center gap-2">
          <button onClick={onBack} className="h-10 w-10 rounded-full flex items-center justify-center text-slate-600 active:bg-slate-100">
            <BackIcon className="h-6 w-6" />
          </button>
          <h1 className="text-lg font-bold text-slate-800">Settings</h1>
        </div>
      </header>

      <main className="mx-auto max-w-md px-3 pt-3 space-y-3">
        <Section title="Business Profile">
          <label className="block text-sm font-medium text-slate-600 mb-1.5">Business Name</label>
          <input
            value={businessName}
            onChange={(e) => setBusinessName(e.target.value)}
            className="w-full rounded-xl border border-slate-200 px-3 py-3 outline-none focus:border-brand-500 mb-4"
          />
          <label className="block text-sm font-medium text-slate-600 mb-1.5">Salesperson Name</label>
          <input
            value={salesperson}
            onChange={(e) => setSalesperson(e.target.value)}
            placeholder="optional"
            className="w-full rounded-xl border border-slate-200 px-3 py-3 outline-none focus:border-brand-500 mb-4"
          />
          <button onClick={saveProfile} className="w-full rounded-xl bg-brand-600 text-white py-3 font-semibold active:bg-brand-700">
            Save
          </button>
          <p className="text-xs text-slate-400 mt-3">
            Orders are delivered to WhatsApp +91 90749 93560 (fixed).
          </p>
        </Section>

        <Section title="Data">
          <div className="flex items-center justify-between text-sm py-1">
            <span className="text-slate-500">Products stored</span>
            <span className="font-semibold text-slate-800">{products.length}</span>
          </div>
          <div className="flex items-center justify-between text-sm py-1 mb-2">
            <span className="text-slate-500">Customers stored</span>
            <span className="font-semibold text-slate-800">{customers.length}</span>
          </div>
          <div className="divide-y divide-slate-100">
            <FileButton label="Import Products (Excel)" accept=".xlsx,.xls,.csv" onFile={onImportProducts} />
            <FileButton label="Import Customers (Excel)" accept=".xlsx,.xls,.csv" onFile={onImportCustomers} />
            <button onClick={onExportProducts} className="w-full text-left py-3 px-1 font-medium text-slate-700">Export Products</button>
            <button onClick={onExportCustomers} className="w-full text-left py-3 px-1 font-medium text-slate-700">Export Customers</button>
          </div>
        </Section>

        <Section title="Backup">
          <div className="divide-y divide-slate-100">
            <button onClick={onBackup} className="w-full text-left py-3 px-1 font-medium text-slate-700">Export Complete Backup</button>
            <FileButton label="Import Backup" accept=".json" onFile={onRestore} />
          </div>
        </Section>

        <Section title="Danger Zone">
          <button
            onClick={onClearAll}
            className="w-full flex items-center gap-2 py-3 px-1 font-semibold text-red-600"
          >
            <TrashIcon className="h-5 w-5" /> Clear All Data
          </button>
        </Section>

        <p className="text-center text-xs text-slate-400 pt-2 pb-6">
          Alpha Trade Links · Order App v1.0
        </p>
      </main>

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-slate-900 text-white text-sm px-4 py-2.5 rounded-full shadow-pop z-50">
          {toast}
        </div>
      )}
    </div>
  )
}
