import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import { AuthProvider } from './context/AuthContext.jsx'
import { AppProvider } from './context/AppContext.jsx'
import './index.css'

// Register the service worker (enables offline caching AND Web Push for QC).
//
// A new deploy is still fetched and pre-cached in the background, but it is NO
// LONGER activated mid-session: the previous setup hard-reloaded the open page
// the moment a new worker took control, which happened whenever the window
// regained focus (e.g. right after dismissing the native "verify?" confirm),
// throwing Billing out of the order they were verifying. We now let the new
// worker sit in "waiting" and take over only on the next natural full load —
// so users still get fresh code promptly, without any surprise page refresh.
import { registerSW } from 'virtual:pwa-register'

// When a new service worker is installed and ready, show a small non-intrusive
// "Update available" banner the user can tap when convenient. This avoids both
// failure modes: (a) silent stale cache — users stuck on old builds indefinitely
// without knowing, and (b) forced mid-session reload — Billing yanked out of an
// order when the window regained focus. The user sees the banner and taps it
// whenever it's safe to refresh.
let _swUpdateSW = null
const _swUpdateAvailableEvent = new Event('sw-update-available')
const _updateSW = registerSW({
  immediate: true,
  onNeedRefresh() {
    // New SW is installed and waiting. Notify the app so it can show a banner.
    _swUpdateSW = _updateSW
    window.dispatchEvent(_swUpdateAvailableEvent)
  },
  onOfflineReady() {},
})
// Expose so the banner component can call it.
window.__swUpdate = () => _updateSW && _updateSW(true)

// Prints on every load, on every screen — a fast way to confirm whether a
// device is actually running the latest deploy or a stale cached bundle,
// without needing to navigate to any specific feature to check.
console.log('%cAlpha Flow build v142', 'color:#059669;font-weight:bold;font-size:14px')

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AuthProvider>
      <AppProvider>
        <App />
      </AppProvider>
    </AuthProvider>
  </React.StrictMode>
)
