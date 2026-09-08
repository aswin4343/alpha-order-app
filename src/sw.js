// ============================================================================
// Custom service worker (injectManifest).
//
// Keeps full offline precaching (Workbox) AND adds Web Push handlers so QC
// staff receive external notifications when Billing verifies a bill — even
// when the app is in the background or fully closed (subject to the device /
// browser granting notification permission).
// ============================================================================

import { precacheAndRoute, cleanupOutdatedCaches } from 'workbox-precaching'

// Injected at build time with the list of precached assets (app shell etc.).
precacheAndRoute(self.__WB_MANIFEST || [])
// Purge precaches from previous builds so a new deploy never serves a stale
// JS bundle (root cause of the "still showing old version" problem).
cleanupOutdatedCaches()

// Do NOT skipWaiting() automatically. Seizing control mid-session fires a
// `controllerchange`, and the PWA register helper responds by hard-reloading
// the open page — which yanked Billing out of an order the instant the window
// regained focus (e.g. right after dismissing the "verify?" confirm dialog).
// Instead, a newly-deployed worker stays in the "waiting" state and only takes
// over on the next natural full load, so it never interrupts active work.
// (The client may still ask us to skip waiting explicitly — see below.)
self.addEventListener('install', () => {
  // no skipWaiting here — let the new worker wait for a safe moment
})
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

// Allow the app to trigger activation on demand (e.g. from an explicit
// "update ready" prompt) without a page-focus doing it silently.
self.addEventListener('message', (event) => {
  if (event?.data?.type === 'SKIP_WAITING') self.skipWaiting()
})

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
