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
  // vite-plugin-pwa registers the SW; wait for it to be ready.
  if (!('serviceWorker' in navigator)) return null
  return navigator.serviceWorker.ready
}

/**
 * Ask permission (if needed) and subscribe this device to push, then persist
 * the subscription for the given role. Returns { ok, reason }.
 */
export async function enablePush(role) {
  if (!pushSupported()) return { ok: false, reason: 'unsupported' }

  let permission = Notification.permission
  if (permission === 'default') {
    permission = await Notification.requestPermission()
  }
  if (permission !== 'granted') return { ok: false, reason: 'denied' }

  const reg = await getRegistration()
  if (!reg) return { ok: false, reason: 'no-sw' }

  let sub = await reg.pushManager.getSubscription()
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
    })
  }

  await savePushSubscription(sub, role)
  return { ok: true }
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
