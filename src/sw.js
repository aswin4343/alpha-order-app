// ============================================================================
// Custom service worker (injectManifest).
//
// Keeps full offline precaching (Workbox) AND adds Web Push handlers so QC
// staff receive external notifications when Billing verifies a bill — even
// when the app is in the background or fully closed (subject to the device /
// browser granting notification permission).
// ============================================================================

import { precacheAndRoute } from 'workbox-precaching'

// Injected at build time with the list of precached assets (app shell etc.).
precacheAndRoute(self.__WB_MANIFEST || [])

// Activate immediately so push works right after the first install.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

// --- Web Push: show the notification -----------------------------------------
self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = { title: 'Alpha Trade Links', body: event.data ? event.data.text() : '' }
  }

  const title = data.title || '🔔 New Quality Check Required'
  const options = {
    body: data.body || 'A bill has been verified and is ready for Quality Check.',
    icon: '/pwa-192.png',
    badge: '/pwa-192.png',
    tag: data.data && data.data.delivery_id ? `qc-${data.data.delivery_id}` : 'qc',
    renotify: true,
    requireInteraction: true, // stays until QC taps it
    data: data.data || {}
  }

  event.waitUntil(self.registration.showNotification(title, options))
})

// --- Notification click: deep-link to the relevant QC task --------------------
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const d = event.notification.data || {}
  const targetUrl = d.url || '/'

  event.waitUntil(
    (async () => {
      const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      // If a window is already open, focus it and tell the app to open the task.
      for (const client of allClients) {
        if ('focus' in client) {
          await client.focus()
          client.postMessage({ type: 'qc_open', data: d })
          return
        }
      }
      // Otherwise open a fresh window at the deep-link URL.
      if (self.clients.openWindow) {
        await self.clients.openWindow(targetUrl)
      }
    })()
  )
})
