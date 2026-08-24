// ============================================================================
// Edge Function: send-qc-push
//
// Triggered by the deliveries AFTER INSERT trigger (i.e. when Billing verifies
// a bill). Sends a Web Push notification to every subscribed QC device.
//
// Env vars (set via `supabase secrets set`):
//   SUPABASE_URL            - project URL (auto-provided in Edge runtime)
//   SUPABASE_SERVICE_ROLE_KEY - service role key (auto-provided)
//   VAPID_PUBLIC_KEY        - your VAPID public key
//   VAPID_PRIVATE_KEY       - your VAPID private key
//   VAPID_SUBJECT           - "mailto:you@example.com"
//   QC_PUSH_SECRET          - shared secret matching app_settings.qc_push_secret
//
// Deploy: supabase functions deploy send-qc-push
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

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false }
})

Deno.serve(async (req) => {
  try {
    // Authorize: the DB trigger sends x-qc-secret. Reject anything else.
    const secret = req.headers.get('x-qc-secret') || ''
    if (!QC_PUSH_SECRET || secret !== QC_PUSH_SECRET) {
      return new Response('unauthorized', { status: 401 })
    }

    const body = await req.json().catch(() => ({}))
    const {
      kind, // 'qc' (default) | 'announcement' | 'billing_edit'
      delivery_id, order_id, shop_name, bill_no, verified_by, route,
      ann_title, ann_body,
      // billing_edit-specific:
      sales_rep_id, change_summary,
      // purchase_alert-specific:
      product_name, current_stock, reorder_level
    } = body || {}

    const isAnnouncement = kind === 'announcement'
    const isBillingEdit = kind === 'billing_edit'
    const isPurchaseAlert = kind === 'purchase_alert'

    // Choose recipients + message based on the kind of event.
    // - QC alert        → push to qc_team devices.
    // - Announcement    → push to ALL salesperson devices.
    // - Billing edit    → push to ONE specific rep's device(s) only.
    // - Purchase alert  → push to purchase_manager devices, but ONLY if the
    //   purchase-stock push toggle is enabled (dashboard alerts are separate).
    let subs, subsError
    if (isBillingEdit) {
      if (!sales_rep_id) {
        return new Response(JSON.stringify({ ok: true, sent: 0, note: 'no sales_rep_id provided' }), {
          headers: { 'Content-Type': 'application/json' }
        })
      }
      const res = await admin.from('push_subscriptions').select('id, subscription').eq('user_id', sales_rep_id)
      subs = res.data; subsError = res.error
    } else if (isPurchaseAlert) {
      // Respect the PM's push toggle. If disabled, do nothing (the dashboard
      // list still shows the product as needing purchase).
      const { data: setting } = await admin
        .from('purchase_alert_settings').select('push_enabled').eq('id', 1).maybeSingle()
      if (setting && setting.push_enabled === false) {
        return new Response(JSON.stringify({ ok: true, sent: 0, note: 'push disabled' }), {
          headers: { 'Content-Type': 'application/json' }
        })
      }
      const res = await admin.from('push_subscriptions').select('id, subscription').eq('role', 'purchase_manager')
      subs = res.data; subsError = res.error
    } else {
      const targetRole = isAnnouncement ? 'salesperson' : 'qc_team'
      const res = await admin.from('push_subscriptions').select('id, subscription').eq('role', targetRole)
      subs = res.data; subsError = res.error
    }
    const error = subsError

    if (error) {
      return new Response(JSON.stringify({ error: error.message }), { status: 500 })
    }
    if (!subs || subs.length === 0) {
      return new Response(JSON.stringify({ ok: true, sent: 0, note: isBillingEdit ? 'rep has no subscribed devices' : 'no subscriptions' }), {
        headers: { 'Content-Type': 'application/json' }
      })
    }

    const payload = isPurchaseAlert
      ? JSON.stringify({
          title: '🔔 Purchase Order Required',
          body:
            `${product_name || 'A product'} has reached its stock limit.\n` +
            `Current Stock: ${current_stock ?? '-'} | Limit: ${reorder_level ?? '-'}\n` +
            `Please place a Purchase Order.`,
          data: {
            type: 'purchase_alert',
            product_name: product_name || '',
            url: `/?purchase_reorder=1`
          }
        })
      : isBillingEdit
      ? JSON.stringify({
          title: '🔔 Order Updated',
          body: (change_summary || `${shop_name || 'Your order'} was updated by Billing.`).slice(0, 240),
          data: {
            type: 'billing_edit',
            order_id: order_id || null,
            shop_name: shop_name || '',
            url: `/?order=${encodeURIComponent(order_id || '')}`
          }
        })
      : isAnnouncement
      ? JSON.stringify({
          title: ann_title || '📢 Product Update',
          // Keep the push body short; full text lives in the in-app announcement.
          body: (ann_body || 'Product / price updates have been posted. Tap to view.').slice(0, 240),
          data: {
            type: 'announcement',
            url: `/?announcement=1`
          }
        })
      : JSON.stringify({
          title: '🔔 New Quality Check Required',
          body:
            `A bill has been verified and is ready for Quality Check.\n` +
            `Shop: ${shop_name || '-'}\n` +
            `Bill No: ${bill_no || '-'}\n` +
            `Verified By: ${verified_by || '-'}`,
          data: {
            type: 'qc_new',
            delivery_id: delivery_id || null,
            order_id: order_id || null,
            shop_name: shop_name || '',
            route: route || '',
            url: `/?qc_delivery=${encodeURIComponent(delivery_id || '')}`
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
          // 404/410 → subscription expired; mark for cleanup.
          const code = (err as { statusCode?: number })?.statusCode
          if (code === 404 || code === 410) stale.push(row.id)
        }
      })
    )

    // Clean up dead subscriptions so we don't keep retrying them.
    if (stale.length) {
      await admin.from('push_subscriptions').delete().in('id', stale)
    }

    return new Response(JSON.stringify({ ok: true, sent, cleaned: stale.length }), {
      headers: { 'Content-Type': 'application/json' }
    })
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 })
  }
})
