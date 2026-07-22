import { useApp } from '../context/AppContext.jsx'
import { BRANDS } from '../utils/whatsapp.js'

/**
 * Brand switch available throughout the app.
 * Only the company name in the WhatsApp header changes.
 */
export default function BrandSelector() {
  const { settings, updateSettings } = useApp()
  return (
    <select
      value={settings.brand || BRANDS[0]}
      onChange={(e) => updateSettings({ brand: e.target.value })}
      aria-label="Brand"
      className="h-9 rounded-lg border border-slate-200 bg-white px-2 text-xs font-semibold text-slate-700 outline-none focus:border-brand-500 max-w-[150px]"
    >
      {BRANDS.map((b) => (
        <option key={b} value={b}>
          {b}
        </option>
      ))}
    </select>
  )
}
