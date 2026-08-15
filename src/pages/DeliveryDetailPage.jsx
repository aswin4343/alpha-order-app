import { useEffect, useState, useRef } from 'react'
import { useAuth } from '../context/AuthContext.jsx'
import {
  loadGroupDetail,
  saveDeliveryItem,
  completeGroup,
  startGroup,
  cancelDeliveryGroup
} from '../utils/cloudSync.js'
import { buildDeliveryReport } from '../utils/whatsapp.js'
import { uploadDeliveryPhoto } from '../utils/photoUpload.js'
import { BackIcon } from '../components/Icons.jsx'

// Fixed undelivered reasons + Other.
const REASONS = [
  'Shop Closed',
  'Customer Not Available',
  'Payment Issue',
  'Refused / Cancelled',
  'Damaged Stock',
  'Out of Stock',
  'Wrong Address',
  'Other'
]

export default function DeliveryDetailPage({ delivery, onBack, onCompleted, personName, isPunchedIn }) {
  const { profile } = useAuth()
  // `delivery` is a shop-day GROUP. Photos attach to a real delivery row, so we
  // anchor them to the group's first delivery id.
  const group = delivery
  const photoDeliveryId = group.deliveryIds ? group.deliveryIds[0] : group.id
  const [items, setItems] = useState(null)
  const [error, setError] = useState(false)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState('')
  const [completed, setCompleted] = useState(false)
  const [reportText, setReportText] = useState('')
  const [billPhoto, setBillPhoto] = useState(null)   // {url}
  const [productPhoto, setProductPhoto] = useState(null)
  const [uploading, setUploading] = useState('')
  // Refs mirror the latest values so the completion wait-loop reads fresh state.
  const uploadingRef = useRef('')
  const billRef = useRef(null)
  const productRef = useRef(null)
  useEffect(() => { uploadingRef.current = uploading }, [uploading])
  useEffect(() => { billRef.current = billPhoto }, [billPhoto])
  useEffect(() => { productRef.current = productPhoto }, [productPhoto])
  const [photoError, setPhotoError] = useState('')

  // "Bill Cancelled" flow: a typed reason, a confirm step, and a busy flag so
  // the button can't be double-tapped while the RPC is in flight.
  const [showCancel, setShowCancel] = useState(false)
  const [cancelReason, setCancelReason] = useState('')
  const [cancelling, setCancelling] = useState(false)
  const [cancelError, setCancelError] = useState('')
  const [cancelled, setCancelled] = useState(false)

  useEffect(() => {
    let active = true
    ;(async () => {
      try {
        const rows = await loadGroupDetail(group)
        if (!active) return
        setItems(rows)
        startGroup(group) // mark all in the group in-progress
        // Reload any photos already uploaded, so returning from the camera
        // (which can reload the page) doesn't lose them.
        try {
          const { loadDeliveryPhotos } = await import('../utils/photoUpload.js')
          const photos = await loadDeliveryPhotos(photoDeliveryId)
          if (active && photos) {
            const bill = photos.find((p) => p.kind === 'bill')
            const prod = photos.find((p) => p.kind === 'product')
            if (bill) setBillPhoto({ url: bill.url, kind: 'bill' })
            if (prod) setProductPhoto({ url: prod.url, kind: 'product' })
          }
        } catch (e) {
          console.error('reload photos failed', e)
        }
      } catch (e) {
        console.error(e)
        if (active) setError(true)
      }
    })()
    return () => {
      active = false
    }
  }, [group])

  const patchItem = (id, patch) => {
    let targetIds = [id]
    setItems((prev) =>
      prev.map((it) => {
        if (it.id === id) {
          // If this is a merged line, remember all underlying rows to persist to.
          if (it.itemIds && it.itemIds.length) targetIds = it.itemIds
          return { ...it, ...patch }
        }
        return it
      })
    )
    // Persist only real columns (drop UI-only keys like _reasonChoice).
    const clean = {}
    Object.keys(patch).forEach((k) => {
      if (!k.startsWith('_')) clean[k] = patch[k]
    })
    if (Object.keys(clean).length) {
      // For a merged product, update every underlying delivery_items row so all
      // the original order-lines carry the same delivered/reason state.
      targetIds.forEach((tid) =>
        saveDeliveryItem(tid, clean).catch((e) => console.error('save item failed', e))
      )
    }
  }

  const toggleDelivered = (it) => {
    if (it.delivered) {
      patchItem(it.id, { delivered: false })
    } else {
      // Mark delivered in full; clear any reason.
      patchItem(it.id, { delivered: true, delivered_qty: it.ordered_qty, reason: '' })
    }
  }

  const getLocation = () =>
    new Promise((resolve) => {
      if (!navigator.geolocation) return resolve(null)
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({ latitude: pos.coords.latitude, longitude: pos.coords.longitude }),
        () => resolve(null),
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 }
      )
    })

  // Capture a photo: show it INSTANTLY from the local file, then upload in the
  // background and swap to the cloud URL when done. kind: 'bill' | 'product'
  const onPhoto = async (kind, e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setPhotoError('')

    // 1. Instant local preview — no waiting for compression or upload.
    const localUrl = URL.createObjectURL(file)
    const localShown = { url: localUrl, kind, _local: true }
    if (kind === 'bill') setBillPhoto(localShown)
    else setProductPhoto(localShown)
    setToast(kind === 'bill' ? 'Bill photo added ✓' : 'Product photo added ✓')
    setTimeout(() => setToast(''), 2000)

    // 2. Upload in the background; swap to the cloud URL when ready.
    setUploading(kind)
    try {
      const res = await uploadDeliveryPhoto(photoDeliveryId, file, kind)
      const shown = { ...res, url: `${res.url}?t=${Date.now()}` }
      if (kind === 'bill') setBillPhoto(shown)
      else setProductPhoto(shown)
      // Free the local blob now that the cloud image is in place.
      URL.revokeObjectURL(localUrl)
    } catch (err) {
      console.error('photo upload error', err)
      const reason = err?.message || err?.error || 'Unknown error'
      // Keep the local preview visible, but warn that upload failed.
      setPhotoError(`Photo shown but upload failed (${reason}). It will need to re-upload.`)
    } finally {
      setUploading('')
    }
  }

  const hasPhoto = !!billPhoto || !!productPhoto

  // Validation: any undelivered item needs a reason.
  const ready =
    items &&
    items.length > 0 &&
    items.every((i) => i.delivered || (i.reason && i.reason.trim()))

  const finish = async () => {
    if (!ready) {
      setToast('Add a reason for each item not delivered.')
      setTimeout(() => setToast(''), 2600)
      return
    }
    if (!hasPhoto) {
      setToast('At least one photo (bill or product) is required.')
      setTimeout(() => setToast(''), 2600)
      return
    }
    if (!isPunchedIn) {
      setToast('Please Punch In first to complete a delivery.')
      setTimeout(() => setToast(''), 2600)
      return
    }
    // If a photo is still uploading in the background, wait briefly so the
    // report gets the real cloud URL (not the temporary local preview).
    if (uploading || billPhoto?._local || productPhoto?._local) {
      setToast('Finishing photo upload…')
      let waited = 0
      while ((uploadingRef.current || billRef.current?._local || productRef.current?._local) && waited < 15000) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 400))
        waited += 400
      }
      setToast('')
    }
    setBusy(true)
    try {
      const loc = await getLocation()
      const status = await completeGroup({
        group,
        items,
        note: note.trim(),
        location: loc
      })
      // Save this GPS as the shop's verified location (always overwrite latest).
      if (loc?.latitude != null) {
        try {
          const { saveShopLocation, pingDriverLocation } = await import('../utils/cloudSync.js')
          await saveShopLocation({
            shopName: group.shop_name,
            route: group.route,
            latitude: loc.latitude,
            longitude: loc.longitude
          })
          // Also update the driver's own last-known location.
          await pingDriverLocation(loc.latitude, loc.longitude)
        } catch (e) {
          console.error('save shop location failed', e)
        }
      }
      const text = buildDeliveryReport({
        delivery: group,
        items,
        note: note.trim(),
        location: loc,
        deliveredBy: personName || profile?.full_name || 'Delivery',
        status,
        photos: [billPhoto, productPhoto]
          .filter(Boolean)
          .filter((p) => !p._local) // only include uploaded (cloud) photos
          .map((p) => ({ ...p, url: p.url.split('?')[0] }))
      })
      setReportText(text)
      setCompleted(true)
    } catch (e) {
      console.error(e)
      setToast('Could not complete. Check connection.')
      setTimeout(() => setToast(''), 2600)
    } finally {
      setBusy(false)
    }
  }

  const onCancelBill = async () => {
    if (!cancelReason.trim()) {
      setCancelError('Please enter a reason.')
      return
    }
    setCancelling(true)
    setCancelError('')
    try {
      await cancelDeliveryGroup(group, cancelReason)
      setCancelled(true)
      setShowCancel(false)
    } catch (e) {
      console.error(e)
      setCancelError(e?.message || 'Could not cancel this bill. Try again.')
    } finally {
      setCancelling(false)
    }
  }

  const copyReport = async () => {
    try {
      await navigator.clipboard.writeText(reportText)
      setToast('Report copied — paste into WhatsApp')
    } catch {
      setToast('Copy failed')
    }
    setTimeout(() => setToast(''), 2600)
  }

  const deliveredCount = items ? items.filter((i) => i.delivered).length : 0

  return (
    <div className="min-h-screen bg-slate-50 pb-28">
      <header className="sticky top-0 z-20 bg-white border-b border-slate-100 safe-top">
        <div className="mx-auto max-w-3xl px-3 py-2.5 flex items-center gap-2">
          <button
            onClick={onBack}
            className="h-10 w-10 rounded-full flex items-center justify-center text-slate-600 active:bg-slate-100"
          >
            <BackIcon className="h-6 w-6" />
          </button>
          <div className="min-w-0 flex-1">
            <h1 className="text-base font-bold text-slate-800 truncate">{group.shop_name}</h1>
            <p className="text-[11px] text-slate-400 truncate">{group.route || 'No route'}{group.count > 1 ? ` · ${group.count} orders` : ''}</p>
          </div>
          {group.latitude != null && group.longitude != null ? (
            <a
              href={`https://www.google.com/maps/dir/?api=1&destination=${group.latitude},${group.longitude}`}
              target="_blank"
              rel="noreferrer"
              className="shrink-0 flex items-center gap-1 rounded-xl bg-brand-600 text-white text-xs font-semibold px-3 py-2 active:bg-brand-700"
            >
              🧭 Navigate
            </a>
          ) : null}
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-3 pt-4">
        {error && <p className="text-center text-sm text-red-500 py-6">Could not load delivery.</p>}
        {!items && !error && (
          <div className="py-16 flex justify-center">
            <div className="h-8 w-8 rounded-full border-4 border-brand-100 border-t-brand-600 animate-spin" />
          </div>
        )}

        {cancelled ? (
          <div className="space-y-4">
            <div className="rounded-2xl bg-red-50 border border-red-200 p-4 text-center">
              <p className="text-lg font-bold text-red-700">Bill Cancelled</p>
              <p className="text-sm text-red-600 mt-1">
                The Delivery Admin has been notified.
              </p>
            </div>
            <button
              onClick={onCompleted}
              className="w-full rounded-xl border border-slate-200 py-3 font-semibold text-slate-600"
            >
              Back to My Deliveries
            </button>
          </div>
        ) : completed ? (
          <div className="space-y-4">
            <div className="rounded-2xl bg-green-50 border border-green-200 p-4 text-center">
              <p className="text-lg font-bold text-green-700">Delivery Recorded ✅</p>
              <p className="text-sm text-green-600 mt-1">
                Copy the report and paste it into WhatsApp.
              </p>
            </div>
            <pre className="rounded-2xl bg-white border border-slate-200 p-3 text-[12px] text-slate-700 whitespace-pre-wrap font-sans overflow-x-hidden">
              {reportText}
            </pre>
            <button
              onClick={copyReport}
              className="w-full rounded-xl bg-brand-600 text-white py-3.5 font-bold active:bg-brand-700"
            >
              Copy Report
            </button>
            <button
              onClick={onCompleted}
              className="w-full rounded-xl border border-slate-200 py-3 font-semibold text-slate-600"
            >
              Back to My Deliveries
            </button>
            <p className="text-center text-[11px] text-slate-400">
              Proof-of-delivery photos will be added in the next update — for now attach photos
              manually in WhatsApp after pasting this report.
            </p>
          </div>
        ) : (
          items && (
            <>
              <button
                onClick={() => { setShowCancel(true); setCancelReason(''); setCancelError('') }}
                className="w-full mb-3 rounded-xl border-2 border-red-200 text-red-600 font-bold text-sm py-2.5 active:bg-red-50"
              >
                🚫 Bill Cancelled
              </button>

              <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2 px-1">
                Items to deliver ({deliveredCount}/{items.length} ticked)
              </p>
              <div className="space-y-2">
                {items.map((it) => (
                  <div
                    key={it.id}
                    className={`rounded-2xl bg-white shadow-card border p-3 ${
                      it.delivered ? 'border-green-300' : 'border-slate-100'
                    }`}
                  >
                    <label className="flex items-start gap-3 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={it.delivered}
                        onChange={() => toggleDelivered(it)}
                        className="mt-1 h-5 w-5 shrink-0"
                      />
                      <div className="min-w-0 flex-1">
                        <p className="font-semibold text-slate-800">{it.product_name}</p>
                        <p className="text-[12px] text-slate-400">
                          Ordered: {it.ordered_qty} {it.unit}
                        </p>
                      </div>
                    </label>

                    {!it.delivered && (
                      <div className="mt-2.5 pl-8 space-y-2">
                        <select
                          value={it._reasonChoice || (REASONS.includes(it.reason) ? it.reason : it.reason ? 'Other' : '')}
                          onChange={(e) => {
                            const v = e.target.value
                            if (v === 'Other') {
                              patchItem(it.id, { _reasonChoice: 'Other', reason: '' })
                            } else {
                              patchItem(it.id, { _reasonChoice: v, reason: v })
                            }
                          }}
                          className="w-full rounded-lg border border-slate-200 px-2.5 py-2 text-sm outline-none focus:border-brand-500 bg-white"
                        >
                          <option value="">Reason not delivered…</option>
                          {REASONS.map((r) => (
                            <option key={r} value={r}>
                              {r}
                            </option>
                          ))}
                        </select>
                        {it._reasonChoice === 'Other' && (
                          <input
                            value={it.reason}
                            onChange={(e) => patchItem(it.id, { reason: e.target.value })}
                            placeholder="Please specify the reason"
                            className="w-full rounded-lg border border-slate-200 px-2.5 py-2 text-sm outline-none focus:border-brand-500"
                          />
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>

              <div className="mt-4">
                <label className="block text-sm font-medium text-slate-600 mb-1.5">
                  Note (optional)
                </label>
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  rows={2}
                  placeholder="Any note about this delivery"
                  className="w-full rounded-xl border border-slate-200 px-3 py-3 outline-none focus:border-brand-500 resize-none"
                />
              </div>

              {/* Proof-of-delivery photos (camera). At least one required. */}
              <div className="mt-4">
                <p className="text-sm font-medium text-slate-600 mb-2">
                  Proof photos <span className="text-red-500">*</span>
                  <span className="text-xs text-slate-400 ml-1">(at least one)</span>
                </p>
                <div className="grid grid-cols-2 gap-2">
                  <PhotoTile
                    label="Bill Photo"
                    photo={billPhoto}
                    uploading={uploading === 'bill'}
                    onCapture={(e) => onPhoto('bill', e)}
                    inputId="bill-photo"
                  />
                  <PhotoTile
                    label="Product Photo"
                    photo={productPhoto}
                    uploading={uploading === 'product'}
                    onCapture={(e) => onPhoto('product', e)}
                    inputId="product-photo"
                  />
                </div>
                {photoError && (
                  <div className="mt-2 rounded-xl bg-red-50 border border-red-200 px-3 py-2">
                    <p className="text-[12px] text-red-700 break-words">{photoError}</p>
                  </div>
                )}
              </div>
            </>
          )
        )}
      </main>

      {!completed && items && (
        <div className="fixed bottom-0 inset-x-0 bg-white border-t border-slate-100 p-3 safe-bottom">
          <div className="mx-auto max-w-3xl">
            <button
              onClick={finish}
              disabled={busy || !ready || !hasPhoto}
              className={`w-full rounded-xl py-4 font-bold ${
                ready && hasPhoto && !busy
                  ? 'bg-brand-600 text-white active:bg-brand-700'
                  : 'bg-slate-100 text-slate-400'
              }`}
            >
              {busy ? 'Saving…' : !hasPhoto ? 'Add a photo to complete' : 'Complete Delivery'}
            </button>
          </div>
        </div>
      )}

      {toast && (
        <div className="fixed bottom-24 inset-x-0 flex justify-center px-4 z-30">
          <div className="bg-slate-800 text-white text-sm px-4 py-2.5 rounded-xl shadow-lg">
            {toast}
          </div>
        </div>
      )}

      {showCancel && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center">
          <div className="bg-white w-full sm:max-w-sm rounded-t-3xl sm:rounded-3xl p-5">
            <p className="text-lg font-bold text-red-700 mb-1">Cancel this bill?</p>
            <p className="text-sm text-slate-500 mb-4">
              This cancels the whole order for <b>{group.shop_name}</b>. The Delivery Admin will be notified.
              This cannot be undone from here.
            </p>
            <label className="block text-[11px] font-semibold text-slate-400 uppercase tracking-wide mb-1.5">
              Reason
            </label>
            <textarea
              value={cancelReason}
              onChange={(e) => { setCancelReason(e.target.value); setCancelError('') }}
              rows={3}
              placeholder="Why is this bill being cancelled?"
              className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-red-400 mb-1"
            />
            {cancelError && <p className="text-xs text-red-600 mb-2">{cancelError}</p>}
            <div className="flex gap-2 mt-3">
              <button
                onClick={() => setShowCancel(false)}
                disabled={cancelling}
                className="flex-1 rounded-xl border border-slate-200 py-3 font-semibold text-slate-600 disabled:opacity-50"
              >
                Keep Bill
              </button>
              <button
                onClick={onCancelBill}
                disabled={cancelling}
                className="flex-1 rounded-xl bg-red-600 text-white py-3 font-bold active:bg-red-700 disabled:opacity-50"
              >
                {cancelling ? 'Cancelling…' : 'Cancel Bill'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}


// A single photo capture tile. `capture="environment"` opens the rear camera
// directly on mobile; accept="image/*" ensures it's an image.
function PhotoTile({ label, photo, uploading, onCapture, inputId }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-2">
      <p className="text-[11px] font-medium text-slate-500 mb-1.5 text-center">{label}</p>
      {photo ? (
        <div className="relative">
          <img src={photo.url} alt={label} className="w-full h-28 object-cover rounded-xl" />
          {uploading && (
            <div className="absolute inset-0 bg-white/70 rounded-xl flex items-center justify-center">
              <div className="h-6 w-6 rounded-full border-2 border-brand-100 border-t-brand-600 animate-spin" />
            </div>
          )}
          <label
            htmlFor={inputId}
            className="absolute bottom-1 right-1 bg-white/90 text-brand-700 text-[10px] font-semibold px-2 py-1 rounded-lg shadow"
          >
            {uploading ? 'Uploading…' : 'Retake'}
          </label>
        </div>
      ) : (
        <label
          htmlFor={inputId}
          className="flex flex-col items-center justify-center h-28 rounded-xl border-2 border-dashed border-slate-200 text-slate-400 cursor-pointer active:bg-slate-50"
        >
          {uploading ? (
            <div className="h-6 w-6 rounded-full border-2 border-brand-100 border-t-brand-600 animate-spin" />
          ) : (
            <>
              <span className="text-2xl">📷</span>
              <span className="text-[11px] mt-1">Take photo</span>
            </>
          )}
        </label>
      )}
      <input
        id={inputId}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={onCapture}
        className="hidden"
      />
    </div>
  )
}
