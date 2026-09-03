import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import { AuthProvider } from './context/AuthContext.jsx'
import { AppProvider } from './context/AppContext.jsx'
import './index.css'

// Register the service worker (enables offline caching AND Web Push for QC).
// autoUpdate mode: a new deploy is fetched and activated on the next load,
// so users always get the latest code without a manual prompt or cache clear.
import { registerSW } from 'virtual:pwa-register'
registerSW({ immediate: true })

// Prints on every load, on every screen — a fast way to confirm whether a
// device is actually running the latest deploy or a stale cached bundle,
// without needing to navigate to any specific feature to check.
console.log('%cAlpha Flow build v79', 'color:#059669;font-weight:bold;font-size:14px')

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AuthProvider>
      <AppProvider>
        <App />
      </AppProvider>
    </AuthProvider>
  </React.StrictMode>
)
