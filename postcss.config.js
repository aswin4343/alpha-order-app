import { useState } from 'react'
import { useApp } from '../context/AppContext.jsx'
import appIcon from '../assets/app_icon.png'

// Shown once on first launch to capture business details.
// The WhatsApp delivery number is fixed in the app, so it is not asked here.
export default function SetupScreen() {
  const { settings, updateSettings } = useApp()
  const [businessName, setBusinessName] = useState(settings.businessName || 'Alpha Trade Links')
  const [salesperson, setSalesperson] = useState(settings.salesperson || '')

  const save = () => {
    updateSettings({
      businessName: businessName.trim() || 'Alpha Trade Links',
      salesperson: salesperson.trim(),
      configured: true
    })
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-6 bg-white">
      <div className="w-full max-w-sm">
        <img src={appIcon} alt="Alpha Trade Links" className="h-24 w-24 rounded-3xl object-contain mx-auto mb-6" />
        <h1 className="text-xl font-bold text-slate-800 text-center">Welcome</h1>
        <p className="text-sm text-slate-500 text-center mt-1 mb-8">
          Set up your details to start taking orders.
        </p>

        <label className="block text-sm font-medium text-slate-600 mb-1.5">Business Name</label>
        <input
          value={businessName}
          onChange={(e) => setBusinessName(e.target.value)}
          className="w-full rounded-xl border border-slate-200 px-4 py-3.5 outline-none focus:border-brand-500 mb-5"
          placeholder="Business name"
        />

        <label className="block text-sm font-medium text-slate-600 mb-1.5">
          Salesperson Name <span className="text-slate-400 font-normal">(optional)</span>
        </label>
        <input
          value={salesperson}
          onChange={(e) => setSalesperson(e.target.value)}
          className="w-full rounded-xl border border-slate-200 px-4 py-3.5 outline-none focus:border-brand-500 mb-8"
          placeholder="Your name"
        />

        <button
          onClick={save}
          className="w-full rounded-xl bg-brand-600 text-white py-4 font-bold active:bg-brand-700"
        >
          Get Started
        </button>

        <p className="text-xs text-slate-400 text-center mt-4">
          Orders are sent to your configured business WhatsApp.
        </p>
      </div>
    </div>
  )
}
