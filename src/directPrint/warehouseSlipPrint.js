// ===========================================================================
// Warehouse Slip print orchestrator (adapter)
//
// The ONE entry point the Print button calls. Implements the required fallback:
//
//   if (bridge available)  -> generate PDF -> submit to bridge (no browser UI)
//   else                   -> window.print()  (existing behaviour, unchanged)
//
// Any failure at any step falls back to window.print(), so the user can never
// lose the ability to print. No large modal — the caller shows a small toast
// from the returned result.
// ===========================================================================

import { checkBridge, submitPrintJob } from './printBridgeClient.js'
import { generateWarehouseSlipPdf } from './warehouseSlipPdf.js'

// Remember jobIds already submitted this session so an accidental double-click
// can't create a second job even before the bridge's own dedupe kicks in.
const submittedJobs = new Set()

/**
 * @param {object} opts
 * @param {string} opts.orderRef   stable reference used to build the jobId
 * @param {string} [opts.printerName]
 * @returns {Promise<{ mode:'direct'|'browser', ok:boolean, message:string }>}
 */
export async function printWarehouseSlip({ orderRef, printerName } = {}) {
  const browserFallback = (message) => {
    try { window.print() } catch { /* nothing more we can do */ }
    return { mode: 'browser', ok: true, message: message || 'Using browser print' }
  }

  // 1) Is the optional bridge there? Fast check; on "no" we behave exactly as
  //    the app does today.
  const health = await checkBridge()
  if (!health.available) return browserFallback()

  // 2) Stable jobId so repeated clicks map to ONE physical print. Includes the
  //    order ref + the day so re-printing on another day is a new job.
  const day = new Date().toISOString().slice(0, 10)
  const jobId = `warehouse-slip-${day}-${orderRef || 'unknown'}`
  if (submittedJobs.has(jobId)) {
    return { mode: 'direct', ok: true, message: 'Already sent to printer' }
  }

  // 3) Build the authoritative PDF from the existing rotated print DOM.
  let pdf
  try {
    pdf = await generateWarehouseSlipPdf()
  } catch (e) {
    return browserFallback('Could not prepare direct print — using browser print')
  }

  // 4) Submit. On any bridge error, fall back to the browser.
  const res = await submitPrintJob({
    jobId,
    printerName,
    copies: 1,
    paperSize: pdf.paperSize,
    orientation: pdf.orientation,
    pdfBase64: pdf.pdfBase64
  })
  if (!res.ok) {
    return browserFallback('Direct printing failed — using browser print')
  }

  submittedJobs.add(jobId)
  return { mode: 'direct', ok: true, message: 'Sent to printer' }
}
