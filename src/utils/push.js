// ============================================================================
// Client-side Web Push helper.
//
// Handles: permission request, subscribing to push via the service worker,
// and persisting the subscription to Supabase. Used by QC staff so they get
// external notifications when Billing verifies a bill.
// ============================================================================

import { savePushSubscription, removePushSubscription } from './cloudSync.js'

// Public VAPID key (safe to ship in the client). The matching PRIVATE key lives
// only in the Supabase Edge Function's secrets.
export const VAPID_PUBLIC_KEY =
  'BKuLlftaYk3AOuZUmloHuTCcwsLTGMcA4fKRGbxktfIVWoZeG3rVvBZb2JGoRuDY_ueEMFoOWh1QxLe81hhSHZQ'

export function pushSupported() {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  )
}

// Convert the base64url VAPID key to the Uint8Array the PushManager expects.
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  const output = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i)
  return output
}

async function getRegistration() {
  if (!('serviceWorker' in navigator)) return null

  // First, try to get an already-active registration immediately.
  const existing = await navigator.serviceWorker.getRegistration()
  if (existing) return existing

  // Otherwise, actively register the service worker ourselves. Relying only on
  // navigator.serviceWorker.ready can hang forever if nothing ever registers
  // (which is exactly what caused "Could not enable" with permission granted).
  try {
    const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' })
    // Give it a moment to become active, but never hang indefinitely.
    await Promise.race([
      navigator.serviceWorker.ready,
      new Promise((resolve) => setTimeout(resolve, 8000))
    ])
    return reg || (await navigator.serviceWorker.getRegistration())
  } catch (e) {
    console.error('SW registration failed:', e)
    return null
  }
}

/**
 * Ask permission (if needed) and subscribe this device to push, then persist
 * the subscription for the given role. Returns { ok, reason, detail }.
 */
export async function enablePush(role) {
  if (!pushSupported()) return { ok: false, reason: 'unsupported' }

  let permission = Notification.permission
  if (permission === 'default') {
    permission = await Notification.requestPermission()
  }
  if (permission !== 'granted') return { ok: false, reason: 'denied' }

  try {
    const reg = await getRegistration()
    if (!reg) return { ok: false, reason: 'no-sw', detail: 'Service worker did not register.' }
    if (!reg.pushManager) {
      return { ok: false, reason: 'no-pushmanager', detail: 'PushManager unavailable on this browser.' }
    }

    let sub = await reg.pushManager.getSubscription()
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
      })
    }

    await savePushSubscription(sub, role)
    return { ok: true }
  } catch (e) {
    // Surface the real reason so we can diagnose instead of a generic message.
    console.error('enablePush failed:', e)
    return { ok: false, reason: 'error', detail: (e && e.message) ? e.message : String(e) }
  }
}

/** Unsubscribe this device and remove the stored subscription. */
export async function disablePush() {
  if (!pushSupported()) return
  const reg = await getRegistration()
  if (!reg) return
  const sub = await reg.pushManager.getSubscription()
  if (sub) {
    const endpoint = sub.endpoint
    try { await sub.unsubscribe() } catch {}
    await removePushSubscription(endpoint)
  }
}

/** Current permission + subscription status (for a settings toggle). */
export async function pushStatus() {
  if (!pushSupported()) return { supported: false, permission: 'unsupported', subscribed: false }
  const reg = await getRegistration()
  const sub = reg ? await reg.pushManager.getSubscription() : null
  return {
    supported: true,
    permission: Notification.permission,
    subscribed: !!sub
  }
}
