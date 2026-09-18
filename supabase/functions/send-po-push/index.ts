// ============================================================================
// Edge Function: send-po-push
//
// Called daily at 10:00 AM IST via pg_cron (job: po-daily-notify).
// Also callable on-demand (from admin UI) for testing.
//
// On each invocation:
//   1. Generate/refresh schedules for the next 60 days (idempotent)
//   2. Mark today's UPCOMING rows as DUE
//   3. Find all DUE/NOTIFIED rows for today and send push to purchase_manager devices
//   4. Mark sent rows as NOTIFIED (with timestamp)
//   5. Escalate any IGNORED rows older than 24 hours → ESCALATED status + admin push
//
// Env vars (same as send-qc-push, already set):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY,
//   VAPID_SUBJECT, QC_PUSH_SECRET
// ============================================================================

import { createClient } from 'jsr:@supabase/supabase-js@2'
import webpush from 'npm:web-push@3.6.7'

const SUPABASE_URL   = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const VAPID_PUBLIC   = Deno.env.get('VAPID_PUBLIC_KEY')!
const VAPID_PRIVATE  = Deno.env.get('VAPID_PRIVATE_KEY')!
const VAPID_SUBJECT  = Deno.env.get('VAPID_SUBJECT') || 'mailto:admin@alphatradelinks.app'
const QC_PUSH_SECRET = Deno.env.get('QC_PUSH_SECRET') || ''

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE)

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false }
})

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Send a single Web Push payload to all subscriptions for a given role. */
async function pushToRole(role: string, payload: string): Promise<{ sent: number; cleaned: number }> {
  const { data: subs, error } = await admin
    .from('push_subscriptions')
    .select('id, subscription')
    .eq('role', role)

  if (error || !subs || subs.length === 0) return { sent: 0, cleaned: 0 }

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

  if (stale.length) {
    await admin.from('push_subscriptions').delete().in('id', stale)
  }

  return { sent, cleaned: stale.length }
}

/** Log an event in po_audit_log. */
async function auditLog(
  scheduleId: string,
  vendorId: string,
  event: string,
  oldStatus: string,
  newStatus: string,
  metadata?: Record<string, unknown>
) {
  await admin.from('po_audit_log').insert({
    schedule_id: scheduleId,
    vendor_id:   vendorId,
    event,
    old_status:  oldStatus,
    new_status:  newStatus,
    actor:       'system',
    metadata:    metadata || null
  })
}

// ─── Main handler ────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  try {
    // Authorization: same shared secret as send-qc-push
    const secret = req.headers.get('x-qc-secret') || ''
    if (!QC_PUSH_SECRET || secret !== QC_PUSH_SECRET) {
      return new Response('unauthorized', { status: 401 })
    }

    const body = await req.json().catch(() => ({}))
    const kind: string = body?.kind || 'po_daily_notify'

    // ── Step 1 & 2: generate schedules + mark DUE (server-side, idempotent) ──
    await admin.rpc('generate_po_schedules', { lookahead_days: 60 })
    await admin.rpc('mark_due_schedules')

    // ── Step 3: today's IST date ─────────────────────────────────────────────
    const todayIST = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })

    // ── Step 4: find schedules due for today that haven't been fully handled ─
    const { data: dueSchedules } = await admin
      .from('purchase_order_schedules')
      .select(`
        id,
        vendor_id,
        scheduled_date,
        rescheduled_date,
        effective_date,
        status,
        notified_at,
        vendors ( vendor_name, brand, po_gap_days, lead_time_days )
      `)
      .eq('effective_date', todayIST)
      .in('status', ['DUE', 'NOTIFIED', 'IN_PROGRESS'])  // include already-notified for re-ping
      .order('vendor_name')

    const toNotify = (dueSchedules || []).filter(
      (s: { status: string; notified_at: string | null }) =>
        s.status === 'DUE' || (s.status === 'NOTIFIED' && !s.notified_at)
    )

    // ── Step 5: send push for each unnotified DUE schedule ──────────────────
    let notifySent = 0
    for (const s of toNotify) {
      const vendor = (s as { vendors?: { vendor_name?: string; brand?: string; lead_time_days?: string } }).vendors || {}
      const vendorName = vendor?.vendor_name || 'Unknown Vendor'
      const brand      = vendor?.brand || ''
      const leadTime   = vendor?.lead_time_days || ''

      const payload = JSON.stringify({
        title: '📦 Purchase Order Due Today',
        body:  `${vendorName}${brand ? ` (${brand})` : ''}` +
               `\nPO required today.${leadTime ? ` Lead time: ${leadTime} days.` : ''}` +
               `\nTap to open Purchase Orders.`,
        data: {
          type:        'po_reminder',
          schedule_id: s.id,
          vendor_id:   s.vendor_id,
          vendor_name: vendorName,
          url:         '/?po_due=1'
        }
      })

      const { sent } = await pushToRole('purchase_manager', payload)
      notifySent += sent

      // Mark as NOTIFIED
      await admin
        .from('purchase_order_schedules')
        .update({ status: 'NOTIFIED', notified_at: new Date().toISOString() })
        .eq('id', s.id)

      await auditLog(s.id, s.vendor_id, 'NOTIFIED', s.status, 'NOTIFIED', { push_sent: sent })
    }

    // ── Step 6: escalate IGNORED schedules (ignored > 24h ago) ───────────────
    const { data: escalated } = await admin.rpc('escalate_ignored_schedules')
    const escalatedRows = escalated || []

    for (const row of escalatedRows as { schedule_id: string; vendor_id: string }[]) {
      // Fetch vendor name for the admin push
      const { data: sched } = await admin
        .from('purchase_order_schedules')
        .select('scheduled_date, vendors(vendor_name, brand)')
        .eq('id', row.schedule_id)
        .maybeSingle()

      const vname = (sched as { vendors?: { vendor_name?: string } } | null)?.vendors?.vendor_name || 'A vendor'

      const adminPayload = JSON.stringify({
        title: '🚨 PO Escalation Alert',
        body:  `${vname}: Purchase Order was ignored by PM for 24+ hours.\nImmediate action required.`,
        data: {
          type:        'po_escalation',
          schedule_id: row.schedule_id,
          vendor_id:   row.vendor_id,
          url:         '/admin?section=purchase-orders'
        }
      })

      // Push to admin/billing role
      await pushToRole('billing', adminPayload)

      await auditLog(row.schedule_id, row.vendor_id, 'ESCALATED', 'IGNORED', 'ESCALATED')
    }

    // ── Step 7: return summary ───────────────────────────────────────────────
    return new Response(
      JSON.stringify({
        ok:             true,
        kind,
        date:           todayIST,
        due_found:      dueSchedules?.length ?? 0,
        notified_sent:  notifySent,
        escalated:      escalatedRows.length
      }),
      { headers: { 'Content-Type': 'application/json' } }
    )

  } catch (e) {
    console.error('send-po-push error:', e)
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 })
  }
})
