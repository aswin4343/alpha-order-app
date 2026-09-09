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
registerSW({
  immediate: true,
  // Intentionally do NOT call updateSW()/reload here. Leaving these callbacks
  // empty means the register helper will not auto-reload the page when an
  // update is found; the waiting worker activates on the next real navigation.
  onNeedRefresh() {},
  onOfflineReady() {},
})

// Prints on every load, on every screen — a fast way to confirm whether a
// device is actually running the latest deploy or a stale cached bundle,
// without needing to navigate to any specific feature to check.
console.log('%cAlpha Flow build v115', 'color:#059669;font-weight:bold;font-size:14px')

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AuthProvider>
      <AppProvider>
        <App />
      </AppProvider>
    </AuthProvider>
  </React.StrictMode>
)
