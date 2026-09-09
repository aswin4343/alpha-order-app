// ===========================================================================
// Warehouse Slip -> PDF
//
// Produces the authoritative PDF the Print Bridge will print. It does NOT
// re-implement the slip layout — it captures the SAME .picker-bill-print DOM
// the browser-print path already renders (the rotated, correctly-sized print
// copy portaled into <body> by PickerBill). Capturing the existing print DOM is
// what guarantees:  PDF == on-screen preview == browser print.  The bridge then
// prints this PDF verbatim, so Windows can't re-rotate or rescale it.
//
// Libraries: html2canvas (DOM -> canvas) + jsPDF (canvas -> PDF). Both are MIT
// licensed, so commercial distribution is fine.
// ===========================================================================

import jsPDF from 'jspdf'
import html2canvas from 'html2canvas'

const MM_PER_PAGE_DEFAULT = { w: 148.5, h: 210 } // rotated Warehouse Slip box

/**
 * Render the currently-mounted Warehouse Slip print DOM to a PDF.
 * Returns { pdfBase64, paperSize, orientation } or throws (caller falls back).
 *
 * We read the print container that PickerBill portals into document.body
 * (class "picker-bill-print"). Each ".print-page" inside it becomes one PDF
 * page, at the same mm dimensions the print CSS declares — so the geometry
 * matches the sheet exactly.
 */
export async function generateWarehouseSlipPdf() {
  const root = document.querySelector('.picker-bill-print')
  if (!root) throw new Error('warehouse slip print DOM not found')

  // Each printed sheet is a .print-page (already sized in mm by the component).
  // If the rotation wrapper is present, the pages live inside it; querying from
  // root finds them either way.
  const pageEls = Array.from(root.querySelectorAll('.print-page'))
  const els = pageEls.length ? pageEls : [root]

  // Page box in mm. The rotated slip prints on a 148.5 x 210 sheet (portrait
  // bounding box of the landscape content). We emit the PDF at that size so the
  // bridge/printer receive the intended dimensions and don't auto-rotate.
  const page = MM_PER_PAGE_DEFAULT
  const pdf = new jsPDF({ unit: 'mm', format: [page.w, page.h], orientation: 'portrait' })

  for (let i = 0; i < els.length; i++) {
    // Capture at higher scale for crisp text, on a white background.
    const canvas = await html2canvas(els[i], {
      scale: 2,
      backgroundColor: '#ffffff',
      useCORS: true,
      logging: false
    })
    const img = canvas.toDataURL('image/png')
    if (i > 0) pdf.addPage([page.w, page.h], 'portrait')
    // Fit the captured page image to the full mm page box (1:1 with the sheet).
    pdf.addImage(img, 'PNG', 0, 0, page.w, page.h, undefined, 'FAST')
  }

  // jsPDF can emit base64 directly (strip the data: prefix for the bridge).
  const dataUri = pdf.output('datauristring')
  const pdfBase64 = dataUri.split(',')[1] || ''
  return { pdfBase64, paperSize: 'custom-148.5x210mm', orientation: 'portrait' }
}
