// ===========================================================================
// ATL Flow Print Bridge — web-side client
//
// Talks to an OPTIONAL local Windows service ("ATL Flow Print Bridge") over
// loopback. Every call fails fast and silently: if the bridge is not installed,
// not running, blocked by the browser, or slow, these functions resolve to a
// benign "unavailable" result and the caller falls back to window.print().
//
// This file contains NO business logic — it knows only about health, printers,
// print jobs and status, exactly as the bridge contract defines. It never sees
// customers/orders/pricing.
//
// SECURITY / TRANSPORT NOTES (implemented on the bridge side, see the Windows
// project spec): the bridge binds to loopback only, checks a per-device token,
// and restricts CORS to the ATL Flow origin. Because the app is served over
// HTTPS, the bridge must be reachable at an https loopback origin trusted by
// the machine (or via the browser's localhost carve-out) — otherwise the
// request is blocked as mixed content and we simply fall back. That trust
// setup is a device install step, documented with the bridge.
// ===========================================================================

// Where the local bridge is expected to listen. https to avoid mixed-content
// blocking from the HTTPS app; the loopback host uses a name that resolves to
// 127.0.0.1 and is covered by the bridge's locally-trusted certificate.
// Overridable at build time without touching code.
const BRIDGE_ORIGIN =
  (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_PRINT_BRIDGE_ORIGIN) ||
  'https://atlflow-bridge.localhost:47821'

// Per-device shared secret the user pastes into ATL Flow once (stored in
// localStorage on that device only). Sent as a bearer token so the bridge can
// reject requests that don't carry it. Absence just means "no direct print".
const TOKEN_KEY = 'atlflow_print_bridge_token'

export function getBridgeToken() {
  try { return localStorage.getItem(TOKEN_KEY) || '' } catch { return '' }
}
export function setBridgeToken(v) {
  try { v ? localStorage.setItem(TOKEN_KEY, v) : localStorage.removeItem(TOKEN_KEY) } catch { /* ignore */ }
}

// Fetch with a hard timeout so a hung/absent bridge never blocks the UI.
async function bridgeFetch(path, { method = 'GET', body, timeoutMs = 1500 } = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(`${BRIDGE_ORIGIN}${path}`, {
      method,
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(getBridgeToken() ? { Authorization: `Bearer ${getBridgeToken()}` } : {})
      },
      body: body ? JSON.stringify(body) : undefined,
      // Never send cookies to the local bridge; it authenticates by token only.
      credentials: 'omit',
      mode: 'cors'
    })
    return res
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Is the bridge installed, running and responding correctly?
 * Resolves to { available: boolean, version?, error? } — never throws.
 */
export async function checkBridge() {
  try {
    const res = await bridgeFetch('/health', { timeoutMs: 1200 })
    if (!res.ok) return { available: false, error: `status ${res.status}` }
    const data = await res.json().catch(() => null)
    if (data && data.status === 'ok' && /print bridge/i.test(data.service || '')) {
      return { available: true, version: data.version || null }
    }
    return { available: false, error: 'unexpected health response' }
  } catch (e) {
    // AbortError (timeout), network error, mixed-content block, CORS — all mean
    // "no direct printing"; the caller falls back to the browser.
    return { available: false, error: e?.name || 'unreachable' }
  }
}

/** List Windows printers. Returns [] on any failure. */
export async function listPrinters() {
  try {
    const res = await bridgeFetch('/printers', { timeoutMs: 1500 })
    if (!res.ok) return []
    const data = await res.json().catch(() => null)
    return Array.isArray(data?.printers) ? data.printers : []
  } catch { return [] }
}

/**
 * Submit a print job. `pdfBase64` is the authoritative document — the bridge
 * prints it as-is and never re-renders it. `jobId` MUST be stable for a given
 * logical print so the bridge can dedupe accidental double-clicks.
 * Returns { ok, status?, error? } — never throws.
 */
export async function submitPrintJob({ jobId, printerName, copies = 1, paperSize, orientation, pdfBase64 }) {
  try {
    const res = await bridgeFetch('/print', {
      method: 'POST',
      timeoutMs: 8000,
      body: {
        jobId,
        documentType: 'warehouse-slip',
        printerName: printerName || null,
        copies,
        paperSize: paperSize || null,
        orientation: orientation || null,
        pdfBase64
      }
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      return { ok: false, error: err?.error || `status ${res.status}` }
    }
    const data = await res.json().catch(() => ({}))
    return { ok: !!data?.success, status: data?.status || 'queued', jobId: data?.jobId || jobId }
  } catch (e) {
    return { ok: false, error: e?.name || 'unreachable' }
  }
}

/** Poll a job's status. Returns a status string or null. */
export async function getJobStatus(jobId) {
  try {
    const res = await bridgeFetch(`/print/status/${encodeURIComponent(jobId)}`, { timeoutMs: 2000 })
    if (!res.ok) return null
    const data = await res.json().catch(() => null)
    return data?.status || null
  } catch { return null }
}
