import { useRef, useState } from 'react'
import { useApp } from '../context/AppContext.jsx'
import { BackIcon } from '../components/Icons.jsx'
import { BRANDS, ORDER_WHATSAPP_NUMBER } from '../utils/whatsapp.js'
import {
  importProducts,
  importCustomers,
  exportToExcel,
  downloadJson,
  readJsonFile
} from '../utils/excel.js'

function Section({ title, children }) {
  return (
    <div className="rounded-2xl bg-white shadow-card border border-slate-100 p-4">
      <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3">{title}</p>
      {children}
    </div>
  )
}

function FileButton({ label, accept, onFile }) {
  const ref = useRef(null)
  return (
    <>
      <button onClick={() => ref.current?.click()} className="w-full text-left py-3 px-1 font-medium text-slate-700">
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
    settings, updateSettings, products, customers,
    replaceProducts, replaceCustomers
  } = useApp()

  const [businessName, setBusinessName] = useState(settings.businessName)
  const [salesperson, setSalesperson] = useState(settings.salesperson)
  const [toast, setToast] = useState('')

  const flash = (m) => { setToast(m); setTimeout(() => setToast(''), 2500) }

  const saveProfile = () => {
    updateSettings({
      businessName: businessName.trim() || 'Alpha Trade Links',
      salesperson: salesperson.trim()
    })
    flash('Saved')
  }

  const onImportProducts = async (file) => {
    try {
      const recs = await importProducts(file)
      if (!recs.length) return flash('No products found in file')
      await replaceProducts(recs.map((r) => ({ ...r, slabs: [], base: null, mrp: null })))
      flash(`Imported ${recs.length} products`)
    } catch { flash('Import failed — check file format') }
  }

  const onImportCustomers = async (file) => {
    try {
      const recs = await importCustomers(file)
      if (!recs.length) return flash('No customers found in file')
      await replaceCustomers(recs)
      flash(`Imported ${recs.length} customers`)
    } catch { flash('Import failed — check file format') }
  }

  const onRestore = async (file) => {
    try {
      const d = await readJsonFile(file)
      if (d.products) await replaceProducts(d.products)
      if (d.customers) await replaceCustomers(d.customers)
      if (d.settings) updateSettings(d.settings)
      flash('Backup restored')
    } catch { flash('Restore failed — invalid file') }
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
          <input value={businessName} onChange={(e) => setBusinessName(e.target.value)}
            className="w-full rounded-xl border border-slate-200 px-3 py-3 outline-none focus:border-brand-500 mb-4" />

          <label className="block text-sm font-medium text-slate-600 mb-1.5">Salesperson Name</label>
          <input value={salesperson} onChange={(e) => setSalesperson(e.target.value)} placeholder="optional"
            className="w-full rounded-xl border border-slate-200 px-3 py-3 outline-none focus:border-brand-500 mb-4" />

          <label className="block text-sm font-medium text-slate-600 mb-1.5">Default Brand</label>
          <select value={settings.brand} onChange={(e) => updateSettings({ brand: e.target.value })}
            className="w-full rounded-xl border border-slate-200 px-3 py-3 outline-none focus:border-brand-500 mb-4">
            {BRANDS.map((b) => <option key={b} value={b}>{b}</option>)}
          </select>

          <button onClick={saveProfile} className="w-full rounded-xl bg-brand-600 text-white py-3 font-semibold active:bg-brand-700">
            Save
          </button>
          <p className="text-xs text-slate-400 mt-3">
            Orders are delivered to WhatsApp +91 97470 76361 (fixed).
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
            <button onClick={() => exportToExcel(
              products.map((p) => ({ ItemName: p.name, Brand: p.brand })), 'Products', 'ATL_products.xlsx')}
              className="w-full text-left py-3 px-1 font-medium text-slate-700">Export Products</button>
            <button onClick={() => exportToExcel(
              customers.map((c) => ({ Name: c.name, RouteName: c.route, Area: c.area,
                Category: c.category, GSTN: c.gstn, Phone: c.phone, Email: c.email })),
              'Customers', 'ATL_customers.xlsx')}
              className="w-full text-left py-3 px-1 font-medium text-slate-700">Export Customers</button>
          </div>
        </Section>

        <Section title="Backup">
          <div className="divide-y divide-slate-100">
            <button onClick={() => downloadJson({ version: 2, settings, products, customers }, 'ATL_backup.json')}
              className="w-full text-left py-3 px-1 font-medium text-slate-700">Export Complete Backup</button>
            <FileButton label="Import Backup" accept=".json" onFile={onRestore} />
          </div>
        </Section>

        <Section title="Price tag meanings">
          <div className="grid grid-cols-2 gap-2 text-sm">
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-semibold px-1.5 py-1 rounded-md border bg-slate-50 border-slate-200 text-slate-600">RP</span>
              <span className="text-slate-600">Retail Price</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-semibold px-1.5 py-1 rounded-md border bg-slate-50 border-slate-200 text-slate-600">WP</span>
              <span className="text-slate-600">Wholesale Price</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-semibold px-1.5 py-1 rounded-md border bg-slate-50 border-slate-200 text-slate-600">BR</span>
              <span className="text-slate-600">Base Rate</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-semibold px-1.5 py-1 rounded-md border bg-brand-50 border-brand-200 text-brand-700">NR</span>
              <span className="text-slate-600">Net Rate</span>
            </div>
          </div>
          <p className="text-xs text-slate-400 mt-3">
            Prices are for sales executives only \u2014 they never appear in the WhatsApp message.
          </p>
        </Section>

        <Section title="WhatsApp Business tip">
          <p className="text-sm text-slate-600 leading-relaxed">
            To make orders open in <strong>WhatsApp Business</strong> instead of your
            personal WhatsApp: on Android go to <strong>Settings → Apps → WhatsApp →
            Open by default → Clear defaults</strong>. Next time you tap SEND ORDER,
            choose WhatsApp Business and select <strong>Always</strong>.
          </p>
          <p className="text-sm text-slate-600 mt-2">
            You can also use the <strong>Copy</strong> button next to SEND ORDER and
            paste the message into WhatsApp Business yourself.
          </p>
        </Section>

        <p className="text-center text-xs text-slate-400 pt-2 pb-6">
          Alpha Trade Links · Order App v2.0
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
