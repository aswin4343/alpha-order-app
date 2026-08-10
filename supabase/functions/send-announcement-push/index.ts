// ============================================================================
// Edge Function: send-announcement-push
//
// Triggered by the announcements AFTER INSERT trigger. Sends a Web Push to
// every subscribed sales rep so admin product/price/scheme announcements arrive
// on their phone even when the app is closed.
//
// Shares the same VAPID keys + QC_PUSH_SECRET as send-qc-push (already set via
// `supabase secrets set`). Deploy: supabase functions deploy send-announcement-push
// ============================================================================

import { createClient } from 'jsr:@supabase/supabase-js@2'
import webpush from 'npm:web-push@3.6.7'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const VAPID_PUBLIC = Deno.env.get('VAPID_PUBLIC_KEY')!
const VAPID_PRIVATE = Deno.env.get('VAPID_PRIVATE_KEY')!
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT') || 'mailto:admin@alphatradelinks.app'
const QC_PUSH_SECRET = Deno.env.get('QC_PUSH_SECRET') || ''

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE)

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } })

Deno.serve(async (req) => {
  try {
    const secret = req.headers.get('x-qc-secret') || ''
    if (!QC_PUSH_SECRET || secret !== QC_PUSH_SECRET) {
      return new Response('unauthorized', { status: 401 })
    }

    const body = await req.json().catch(() => ({}))
    const { announcement_id, title, message, audience, rep_ids } = body || {}

    // Resolve recipients.
    //   audience 'all'      → every salesperson subscription
    //   audience 'selected' → only reps in rep_ids
    let query = admin.from('push_subscriptions').select('id, subscription, user_id').eq('role', 'salesperson')
    if (audience === 'selected' && Array.isArray(rep_ids) && rep_ids.length) {
      query = query.in('user_id', rep_ids)
    }
    const { data: subs, error } = await query
    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 })
    if (!subs || subs.length === 0) {
      return new Response(JSON.stringify({ ok: true, sent: 0, note: 'no rep subscriptions' }), {
        headers: { 'Content-Type': 'application/json' }
      })
    }

    const payload = JSON.stringify({
      title: title || 'Product Update',
      body: message || 'A new product update has been posted.',
      data: {
        type: 'announcement',
        announcement_id: announcement_id || null,
        url: `/?announcement=${encodeURIComponent(announcement_id || '')}`
      }
    })

    let sent = 0
    const stale: string[] = []
    await Promise.all(
      subs.map(async (row: { id: string; subscription: unknown }) => {
        try {
          await webpush.sendNotification(row.subscription as webpush.PushSubscription, payload)
          sent++
        } catch (err) {
          const code = (err as { statusCode?: number })?.statusCode
          if (code === 404 || code === 410) stale.push(row.id)
        }
      })
    )
    if (stale.length) await admin.from('push_subscriptions').delete().in('id', stale)

    return new Response(JSON.stringify({ ok: true, sent, cleaned: stale.length }), {
      headers: { 'Content-Type': 'application/json' }
    })
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 })
  }
})
