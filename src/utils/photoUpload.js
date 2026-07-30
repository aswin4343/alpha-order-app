import { supabase } from './supabase.js'

const BUCKET = 'delivery-photos'

/**
 * Compress an image File to a JPEG blob under ~roughly maxWidth px and given
 * quality. Keeps proof-of-delivery photos small (~200-400KB) so uploads are
 * fast and storage lasts. Runs entirely on-device via canvas.
 */
export function compressImage(file, maxWidth = 1280, quality = 0.7) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      URL.revokeObjectURL(url)
      const scale = Math.min(1, maxWidth / img.width)
      const w = Math.round(img.width * scale)
      const h = Math.round(img.height * scale)
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')
      ctx.drawImage(img, 0, 0, w, h)
      canvas.toBlob(
        (blob) => {
          if (blob) resolve(blob)
          else reject(new Error('Compression failed'))
        },
        'image/jpeg',
        quality
      )
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('Could not read image'))
    }
    img.src = url
  })
}

/**
 * Compress + upload a single delivery photo. Returns { path, url }.
 * kind: 'bill' | 'product'
 */
export async function uploadDeliveryPhoto(deliveryId, file, kind) {
  const blob = await compressImage(file)
  const stamp = Date.now()
  const path = `${deliveryId}/${kind}_${stamp}.jpg`

  const { error: upErr } = await supabase.storage
    .from(BUCKET)
    .upload(path, blob, { contentType: 'image/jpeg', upsert: false })
  if (upErr) throw upErr

  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path)
  const url = data.publicUrl

  // Record it against the delivery.
  const { error: recErr } = await supabase.from('delivery_photos').insert({
    delivery_id: deliveryId,
    kind,
    path,
    url
  })
  if (recErr) throw recErr

  return { path, url, kind }
}

/** Load a delivery's photos. */
export async function loadDeliveryPhotos(deliveryId) {
  const { data, error } = await supabase
    .from('delivery_photos')
    .select('id, kind, url, created_at')
    .eq('delivery_id', deliveryId)
    .order('created_at', { ascending: true })
  if (error) return []
  return data || []
}
