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

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AuthProvider>
      <AppProvider>
        <App />
      </AppProvider>
    </AuthProvider>
  </React.StrictMode>
)
