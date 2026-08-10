import { useEffect, useState } from 'react'
import { enablePush, pushStatus, pushSupported } from '../utils/push.js'

/**
 * Small reusable "Turn on notifications" banner.
 * Shows until the device is subscribed or the user has denied permission.
 *
 * Props:
 *   role   - the role to tag the subscription with ('qc_team' | 'salesperson')
 *   label  - short description line shown in the banner
 */
export default function EnablePushBanner({ role, label }) {
  const [state, setState] = useState({ supported: pushSupported(), permission: 'default', subscribed: false })
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let active = true
    pushStatus().then((s) => { if (active) setState(s) }).catch(() => {})
    return () => { active = false }
  }, [])

  const onEnable = async () => {
    setBusy(true)
    try {
      const res = await enablePush(role)
      const s = await pushStatus()
      setState(s)
      if (!res.ok && res.reason === 'denied') {
        alert('Notifications are blocked for this site. Enable them in your browser settings to receive alerts.')
      } else if (!res.ok && res.reason === 'unsupported') {
        alert('This browser does not support notifications. On iPhone, add the app to your Home Screen first, then open it from there.')
      } else if (!res.ok) {
        // Show the real technical reason so problems can be diagnosed.
        alert('Could not enable notifications.\n\nReason: ' + (res.reason || 'unknown') + (res.detail ? ('\n' + res.detail) : ''))
      }
    } catch (e) {
      console.error(e)
      alert('Could not enable notifications on this device.\n' + ((e && e.message) ? e.message : String(e)))
    } finally {
      setBusy(false)
    }
  }

  if (!state.supported) return null
  if (state.subscribed) return null

  if (state.permission === 'denied') {
    return (
      <div className="rounded-2xl bg-amber-50 border border-amber-200 p-3">
        <p className="text-[12px] text-amber-800">
          Notifications are blocked for this site. To receive alerts, enable notifications for this app in your browser settings.
        </p>
      </div>
    )
  }

  return (
    <div className="rounded-2xl bg-blue-50 border border-blue-200 p-3 flex items-center gap-3">
      <div className="text-2xl">🔔</div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-blue-900">Turn on notifications</p>
        <p className="text-[12px] text-blue-700">{label}</p>
      </div>
      <button
        onClick={onEnable}
        disabled={busy}
        className="shrink-0 rounded-xl bg-blue-600 text-white text-sm font-bold px-3 py-2 active:bg-blue-700 disabled:bg-blue-300"
      >
        {busy ? '…' : 'Enable'}
      </button>
    </div>
  )
}
