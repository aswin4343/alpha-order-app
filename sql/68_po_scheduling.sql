-- ============================================================================
-- Migration 68: Vendor-wise Purchase Order Scheduling System
--
-- Creates:
--   1. vendors               – master table (source of truth for PO config)
--   2. purchase_order_schedules – per-cycle PO lifecycle tracking
--   3. po_audit_log          – immutable append-only event trail
--   4. pg_cron job           – daily 10:00 AM IST schedule generation
--   5. RLS policies + indexes
--
-- Seeds all 52 vendors from the vendor master spreadsheet.
-- Vendors with missing po_gap_days are flagged config_incomplete = true.
-- ============================================================================

-- ─── 1. VENDORS MASTER ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS vendors (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_name         text NOT NULL,
  brand               text,
  -- Number of calendar days between PO generations (e.g. 14, 30).
  -- NULL = not configured yet → config_incomplete flag set, no schedules created.
  po_gap_days         integer CHECK (po_gap_days IS NULL OR po_gap_days > 0),
  -- Weekly fixed-day override (e.g. 'MONDAY,THURSDAY'). When set, the next
  -- scheduled_date is the next occurrence of one of these weekdays on or after
  -- the gap-computed date (so it always lands on the vendor's actual delivery day).
  weekly_days         text,   -- comma-separated weekday names, or NULL
  -- Notification time — always 10:00 AM IST per spec; stored for auditability.
  notify_time         text NOT NULL DEFAULT '10:00',
  lead_time_days      text,   -- e.g. '7-10', informational only
  -- True when po_gap_days is NULL (missing config), so admin can see quickly.
  config_incomplete   boolean NOT NULL GENERATED ALWAYS AS (po_gap_days IS NULL) STORED,
  active              boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- Prevent duplicate vendor names
CREATE UNIQUE INDEX IF NOT EXISTS vendors_name_uq ON vendors (LOWER(TRIM(vendor_name)));

ALTER TABLE vendors ENABLE ROW LEVEL SECURITY;

-- Admin: full access
CREATE POLICY vendors_admin_all ON vendors
  FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
        AND profiles.role IN ('admin','billing')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
        AND profiles.role IN ('admin','billing')
    )
  );

-- Purchase manager + billing: read
CREATE POLICY vendors_pm_read ON vendors
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
        AND profiles.role IN ('purchase_manager','admin','billing')
    )
  );


-- ─── 2. PO SCHEDULES ────────────────────────────────────────────────────────

CREATE TYPE po_status AS ENUM (
  'UPCOMING',      -- scheduled, not yet at notification time
  'DUE',           -- today is the scheduled date, not yet notified
  'NOTIFIED',      -- 10 AM push sent, waiting for PM action
  'IN_PROGRESS',   -- PM acknowledged / opened
  'PO_GENERATED',  -- PM confirmed PO was placed
  'IGNORED',       -- PM tapped "Ignore / Remind Tomorrow" → escalation pending
  'ESCALATED',     -- ignored and escalated to Admin
  'RESCHEDULED',   -- one-time date override applied for this cycle
  'COMPLETED'      -- PO confirmed and cycle closed
);

CREATE TABLE IF NOT EXISTS purchase_order_schedules (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id           uuid NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  -- The canonical scheduled date for this cycle (YYYY-MM-DD, IST).
  scheduled_date      date NOT NULL,
  -- One-time override: if set, PM sees this date instead of scheduled_date.
  -- Returns to normal gap calculation next cycle (override does not shift baseline).
  rescheduled_date    date,
  -- Effective date = COALESCE(rescheduled_date, scheduled_date)
  effective_date      date GENERATED ALWAYS AS (
    COALESCE(rescheduled_date, scheduled_date)
  ) STORED,
  status              po_status NOT NULL DEFAULT 'UPCOMING',
  -- Timestamps (all IST-aware via timestamptz)
  notified_at         timestamptz,   -- when 10 AM push was sent
  acknowledged_at     timestamptz,   -- when PM tapped "Open" / "In Progress"
  po_generated_at     timestamptz,   -- when PM marked PO as generated
  ignored_at          timestamptz,   -- when PM tapped "Ignore"
  escalated_at        timestamptz,   -- when auto-escalation fired
  completed_at        timestamptz,
  -- Who acted
  pm_user_id          uuid REFERENCES auth.users(id),
  escalated_by        text,          -- 'system'
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  -- One schedule row per vendor per cycle date (idempotent generation)
  CONSTRAINT po_schedules_vendor_date_uq UNIQUE (vendor_id, scheduled_date)
);

CREATE INDEX IF NOT EXISTS po_schedules_vendor_id_idx ON purchase_order_schedules (vendor_id);
CREATE INDEX IF NOT EXISTS po_schedules_effective_date_idx ON purchase_order_schedules (effective_date);
CREATE INDEX IF NOT EXISTS po_schedules_status_idx ON purchase_order_schedules (status);

ALTER TABLE purchase_order_schedules ENABLE ROW LEVEL SECURITY;

CREATE POLICY po_schedules_pm_all ON purchase_order_schedules
  FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
        AND profiles.role IN ('purchase_manager','admin','billing')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
        AND profiles.role IN ('purchase_manager','admin','billing')
    )
  );


-- ─── 3. PO AUDIT LOG ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS po_audit_log (
  id            bigserial PRIMARY KEY,
  schedule_id   uuid NOT NULL REFERENCES purchase_order_schedules(id) ON DELETE CASCADE,
  vendor_id     uuid NOT NULL,
  event         text NOT NULL,        -- 'CREATED','NOTIFIED','ACKNOWLEDGED','PO_GENERATED',
                                      -- 'IGNORED','ESCALATED','RESCHEDULED','COMPLETED'
  old_status    po_status,
  new_status    po_status,
  actor         text,                 -- user_id or 'system'
  metadata      jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS po_audit_schedule_idx ON po_audit_log (schedule_id);

ALTER TABLE po_audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY po_audit_admin_read ON po_audit_log
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
        AND profiles.role IN ('admin','billing','purchase_manager')
    )
  );

-- Audit log is append-only: nobody can UPDATE or DELETE via API.
CREATE POLICY po_audit_insert_system ON po_audit_log
  FOR INSERT
  TO authenticated
  WITH CHECK (true);


-- ─── 4. HELPER: updated_at trigger ─────────────────────────────────────────

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS vendors_updated_at ON vendors;
CREATE TRIGGER vendors_updated_at
  BEFORE UPDATE ON vendors
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS po_schedules_updated_at ON purchase_order_schedules;
CREATE TRIGGER po_schedules_updated_at
  BEFORE UPDATE ON purchase_order_schedules
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ─── 5. HELPER: generate schedules for all active vendors ───────────────────

CREATE OR REPLACE FUNCTION generate_po_schedules(
  lookahead_days integer DEFAULT 60
)
RETURNS TABLE (vendor_name text, scheduled_date date, action text)
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v       vendors%ROWTYPE;
  last_po date;
  next_d  date;
  today   date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
  horizon date := today + lookahead_days;
  inserted_action text;
BEGIN
  FOR v IN SELECT * FROM vendors WHERE active = true AND po_gap_days IS NOT NULL LOOP
    -- Last actual PO date for this vendor: either the most recent completed/generated
    -- schedule_date, or (fallback) today - po_gap_days so first cycle lands today.
    SELECT COALESCE(
      MAX(s.scheduled_date),
      today - v.po_gap_days
    )
    INTO last_po
    FROM purchase_order_schedules s
    WHERE s.vendor_id = v.id
      AND s.status IN ('PO_GENERATED','COMPLETED','UPCOMING','DUE','NOTIFIED',
                       'IN_PROGRESS','IGNORED','ESCALATED','RESCHEDULED');

    -- Walk forward in po_gap_days steps until we've covered the horizon.
    next_d := last_po + v.po_gap_days;

    WHILE next_d <= horizon LOOP
      -- If vendor has weekly_days config, advance next_d to the next matching weekday
      -- on or after the computed date so the PO always lands on a vendor delivery day.
      IF v.weekly_days IS NOT NULL AND v.weekly_days <> '' THEN
        DECLARE
          day_names text[] := string_to_array(UPPER(TRIM(v.weekly_days)), ',');
          day_name  text;
          adjusted  date := next_d;
          offset    integer;
          dow_map   integer[] := ARRAY[0,1,2,3,4,5,6]; -- Sun=0..Sat=6
          -- ISO weekday for each day name
          name_dow  hstore := 'SUNDAY=>0,MONDAY=>1,TUESDAY=>2,WEDNESDAY=>3,THURSDAY=>4,FRIDAY=>5,SATURDAY=>6'::hstore;
          best_date date := NULL;
          candidate date;
          wday_num  integer;
          days_diff integer;
        BEGIN
          FOREACH day_name IN ARRAY day_names LOOP
            day_name := TRIM(day_name);
            wday_num := (name_dow -> day_name)::integer;
            -- ISO dow: Mon=1..Sun=7; convert to Sun=0..Sat=6
            days_diff := (wday_num - EXTRACT(DOW FROM next_d)::integer + 7) % 7;
            candidate := next_d + days_diff;
            IF best_date IS NULL OR candidate < best_date THEN
              best_date := candidate;
            END IF;
          END LOOP;
          adjusted := COALESCE(best_date, next_d);
          next_d := adjusted;
        END;
      END IF;

      -- Idempotent insert — skip if row already exists for this vendor+date
      INSERT INTO purchase_order_schedules (vendor_id, scheduled_date, status)
      VALUES (v.id, next_d, CASE WHEN next_d = today THEN 'DUE' ELSE 'UPCOMING' END)
      ON CONFLICT (vendor_id, scheduled_date) DO NOTHING;

      GET DIAGNOSTICS inserted_action = ROW_COUNT;

      IF inserted_action::integer > 0 THEN
        -- Audit log
        INSERT INTO po_audit_log (schedule_id, vendor_id, event, new_status, actor)
        SELECT s.id, v.id, 'CREATED',
               CASE WHEN next_d = today THEN 'DUE'::po_status ELSE 'UPCOMING'::po_status END,
               'system'
        FROM purchase_order_schedules s
        WHERE s.vendor_id = v.id AND s.scheduled_date = next_d;

        RETURN QUERY SELECT v.vendor_name, next_d, 'inserted'::text;
      ELSE
        RETURN QUERY SELECT v.vendor_name, next_d, 'skipped'::text;
      END IF;

      -- Advance: use the effective (weekday-adjusted) date as the new baseline
      -- so each subsequent cycle stays on the correct cadence.
      next_d := next_d + v.po_gap_days;
    END LOOP;
  END LOOP;
END;
$$;


-- ─── 6. HELPER: mark today's UPCOMING rows as DUE ───────────────────────────

CREATE OR REPLACE FUNCTION mark_due_schedules()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  today date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
BEGIN
  UPDATE purchase_order_schedules
  SET status = 'DUE'
  WHERE effective_date = today
    AND status = 'UPCOMING';
END;
$$;


-- ─── 7. HELPER: escalate ignored schedules (call from Edge Function) ─────────

CREATE OR REPLACE FUNCTION escalate_ignored_schedules()
RETURNS TABLE (schedule_id uuid, vendor_id uuid)
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RETURN QUERY
  UPDATE purchase_order_schedules
  SET status = 'ESCALATED',
      escalated_at = now(),
      escalated_by = 'system'
  WHERE status = 'IGNORED'
    AND ignored_at < now() - INTERVAL '24 hours'
  RETURNING id, vendor_id;
END;
$$;


-- ─── 8. RPC: PM actions (update schedule status) ────────────────────────────

-- Called by PM UI to acknowledge, generate PO, ignore, reschedule, or complete.
CREATE OR REPLACE FUNCTION update_po_schedule(
  p_schedule_id   uuid,
  p_action        text,  -- 'acknowledge'|'generate'|'ignore'|'reschedule'|'complete'
  p_notes         text DEFAULT NULL,
  p_reschedule_date date DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  s       purchase_order_schedules%ROWTYPE;
  old_st  po_status;
  new_st  po_status;
  uid     uuid := auth.uid();
BEGIN
  SELECT * INTO s FROM purchase_order_schedules WHERE id = p_schedule_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'schedule not found');
  END IF;
  old_st := s.status;

  CASE p_action
    WHEN 'acknowledge' THEN
      new_st := 'IN_PROGRESS';
      UPDATE purchase_order_schedules
      SET status = new_st, acknowledged_at = now(), pm_user_id = uid
      WHERE id = p_schedule_id;

    WHEN 'generate' THEN
      new_st := 'PO_GENERATED';
      UPDATE purchase_order_schedules
      SET status = new_st, po_generated_at = now(), pm_user_id = uid, notes = COALESCE(p_notes, notes)
      WHERE id = p_schedule_id;

    WHEN 'ignore' THEN
      new_st := 'IGNORED';
      UPDATE purchase_order_schedules
      SET status = new_st, ignored_at = now(), pm_user_id = uid, notes = COALESCE(p_notes, notes)
      WHERE id = p_schedule_id;

    WHEN 'reschedule' THEN
      IF p_reschedule_date IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'reschedule_date required');
      END IF;
      new_st := 'RESCHEDULED';
      UPDATE purchase_order_schedules
      SET status = new_st,
          rescheduled_date = p_reschedule_date,
          notes = COALESCE(p_notes, notes)
      WHERE id = p_schedule_id;

    WHEN 'complete' THEN
      new_st := 'COMPLETED';
      UPDATE purchase_order_schedules
      SET status = new_st, completed_at = now(), pm_user_id = uid, notes = COALESCE(p_notes, notes)
      WHERE id = p_schedule_id;

    ELSE
      RETURN jsonb_build_object('ok', false, 'error', 'unknown action');
  END CASE;

  -- Audit
  INSERT INTO po_audit_log (schedule_id, vendor_id, event, old_status, new_status, actor, metadata)
  VALUES (
    p_schedule_id, s.vendor_id,
    UPPER(p_action),
    old_st, new_st,
    uid::text,
    jsonb_strip_nulls(jsonb_build_object(
      'notes', p_notes,
      'reschedule_date', p_reschedule_date::text
    ))
  );

  RETURN jsonb_build_object('ok', true, 'new_status', new_st);
END;
$$;


-- ─── 9. RPC: load vendor PO dashboard data for PM ───────────────────────────

CREATE OR REPLACE FUNCTION load_po_dashboard(
  p_days_ahead integer DEFAULT 30
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  today     date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
  horizon   date := today + p_days_ahead;
  result    jsonb;
BEGIN
  SELECT jsonb_build_object(
    'vendors', (
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', v.id,
          'vendor_name', v.vendor_name,
          'brand', v.brand,
          'po_gap_days', v.po_gap_days,
          'weekly_days', v.weekly_days,
          'lead_time_days', v.lead_time_days,
          'config_incomplete', v.config_incomplete,
          'upcoming_schedule', (
            SELECT jsonb_build_object(
              'id', s.id,
              'scheduled_date', s.scheduled_date,
              'rescheduled_date', s.rescheduled_date,
              'effective_date', s.effective_date,
              'status', s.status,
              'notified_at', s.notified_at,
              'acknowledged_at', s.acknowledged_at,
              'po_generated_at', s.po_generated_at,
              'ignored_at', s.ignored_at,
              'escalated_at', s.escalated_at,
              'completed_at', s.completed_at,
              'notes', s.notes
            )
            FROM purchase_order_schedules s
            WHERE s.vendor_id = v.id
              AND s.effective_date >= today
              AND s.status NOT IN ('COMPLETED','PO_GENERATED')
            ORDER BY s.effective_date ASC
            LIMIT 1
          ),
          'last_po_date', (
            SELECT MAX(s2.effective_date)
            FROM purchase_order_schedules s2
            WHERE s2.vendor_id = v.id
              AND s2.status IN ('PO_GENERATED','COMPLETED')
          )
        )
        ORDER BY v.vendor_name
      )
      FROM vendors v WHERE v.active = true
    ),
    'summary', (
      SELECT jsonb_build_object(
        'due_today',       COUNT(*) FILTER (WHERE s.effective_date = today AND s.status IN ('DUE','NOTIFIED','IN_PROGRESS','IGNORED')),
        'upcoming_7days',  COUNT(*) FILTER (WHERE s.effective_date > today AND s.effective_date <= today + 7 AND s.status = 'UPCOMING'),
        'escalated',       COUNT(*) FILTER (WHERE s.status = 'ESCALATED'),
        'generated_today', COUNT(*) FILTER (WHERE s.effective_date = today AND s.status IN ('PO_GENERATED','COMPLETED')),
        'unconfigured',    (SELECT COUNT(*) FROM vendors WHERE config_incomplete = true AND active = true)
      )
      FROM purchase_order_schedules s
      WHERE s.effective_date BETWEEN today AND horizon
    )
  ) INTO result;

  RETURN result;
END;
$$;


-- ─── 10. SEED VENDOR DATA ───────────────────────────────────────────────────
-- All 52 vendors from VENDOR_DETAILS.xlsx.
-- Vendors with NULL po_gap are flagged automatically via config_incomplete.

INSERT INTO vendors (vendor_name, brand, po_gap_days, weekly_days, lead_time_days) VALUES
  ('ADP PROCESSED FOODS',                          'ZIPPY',         15,   NULL,                   '7-10'),
  ('AJWA AGENCY',                                  'MAGGI CUBE',    30,   NULL,                   '10-15'),
  ('AMIRTHAA DAIRY PVT LTD (FG 4)',                'AMIRTHA',       14,   'MONDAY,THURSDAY',      '1-2'),
  ('APPLE FOODS (FG 5)',                            'APPLE',         14,   NULL,                   '5-7'),
  ('ARC FOODS AND BEVERAGES',                      'HABIT',         25,   NULL,                   '4-6'),
  ('ASR FOOD PRODUCTS (FG 36)',                    'ASR',           14,   NULL,                   '1-2'),
  ('BARAMATI AGRO LTD',                            'DELICIOUS',     15,   NULL,                   '4-6'),
  ('BONUS SOAP (AB TRADERS) (FG1)',                'BONUS',         14,   'SATURDAY',             '1'),
  ('BRINDA AGENCIES (FG 7)',                       'BEST FOOD',     25,   NULL,                   '1-2'),
  ('CRAVETO FOODS',                                'CRAVETO',       35,   NULL,                   '10-14'),
  ('E P JOSEPH & COMPANY (FG 9)',                  'EPJ',           20,   NULL,                   '4-5'),
  ('FATHIMA/FASA TRADERS (HG-6,HG-7)',             'FASA',           7,   'THURSDAY',             '1'),
  ('GIGI FOODS AND BEVERAGES',                     'GIGI',          NULL, NULL,                   '8-10'),
  ('GRAIN AND GRACE PRODUCTS',                     'SAVOUREUX',     25,   NULL,                   '3-4'),
  ('GREEN TRADE LINKS (FG 16)',                    NULL,             7,   'MONDAY,THURSDAY',      '2-3'),
  ('HARSHIN ENTERPRISES',                          NULL,            14,   NULL,                   '5-7'),
  ('KENZ TRADERS PALLIMUKKU KOLLAM',               'ENERGETIC',     30,   NULL,                   '2-3'),
  ('KOLLAM AGENCIES VARKALA',                      'DALDA',         30,   NULL,                   '1'),
  ('LIFE FOODS (MUHAMMED AGENCIES)',               'LIFE',           7,   'FRIDAY',               '1'),
  ('MADATHIL TRADE LINKS',                         'NUTTOZ',        20,   NULL,                   '3-5'),
  ('MAHALEKSHMI AGENCIES PALAYAMKUNNU VARKALA',    'RASNA',         NULL, NULL,                   '2-3'),
  ('MALABAR CANNING (FG13)',                       'FRUITOMANS',    20,   NULL,                   '5-7'),
  ('MALABAR FOOD PRODUCTS (FG11)',                 'FRUITOMANS',    20,   NULL,                   '5-7'),
  ('MALABAR FRUIT PRODUCT CO (FG12)',              'FRUITOMANS',    20,   NULL,                   '5-7'),
  ('MALANAD PASSION FRUIT (FG 39)',                'MALANAD',       25,   NULL,                   '4-6'),
  ('MANI AGENCIES',                                'DABOUR',        40,   NULL,                   '1-3'),
  ('MEGHA AGENCIES - SHAKTHYS MS FOODS',           'SAKTHIS',        7,   NULL,                   '1'),
  ('METRO FOOD ERNAKULAM',                         'VEEBA',         14,   NULL,                   '2-4'),
  ('MILKY MIST (FG 19)',                           'MILKY MIST',     2,   'MONDAY,WEDNESDAY,FRIDAY', '2'),
  ('NAMRATHA STOCKISTS LLP',                       'EVEREST',       30,   NULL,                   '3'),
  ('NEW SUPER TRADERS TVM (FG 21)',                'DELMONTE',      30,   NULL,                   '1'),
  ('NOBLE JACOB INDUSTRIES (FG 22)',               'PETALS',        30,   NULL,                   '4-5'),
  ('OCEAN IMPEX (GREEN TRADE LINKS)',              'TASTOMIX',       7,   'MONDAY,THURSDAY',      '3'),
  ('PAPERLOOM INDUSTRIES (FG23)',                  NULL,            25,   NULL,                   '10-15'),
  ('PAVITHHRA KERA PRODUCTS 2024-25 (FG 34)',      'NUTSGROW',      50,   NULL,                   '7-10'),
  ('PEARL MARKETING',                              'SOBISCO',       NULL, NULL,                   '15-20'),
  ('PLASTO AGENCIES (FG 25)',                      NULL,            30,   NULL,                   '7-10'),
  ('PRASANTH ENTERPRISES',                         'PARRIS',        50,   NULL,                   '5-7'),
  ('PRIYA AGENCIES (FG 26)',                       'NESLE',         60,   NULL,                   '5-7'),
  ('RAHZAIN FOODS',                                'CORNIX',        NULL, NULL,                   '5-7'),
  ('RAMZAN FOODS',                                 'HYFUN',         30,   NULL,                   '5-7'),
  ('RB CHINESE FOOD PRODUCTS',                     'DRAGON CRAZE',  30,   NULL,                   '12-18'),
  ('ROS PRODUCTS (FG14)',                          'FRUITOMANS',    20,   NULL,                   '5-7'),
  ('SABARI DISTRIBUTION PVT LTD',                 'VICKS',         60,   NULL,                   '1-2'),
  ('SACRAMENTO VENTURES (FG 33)',                  'MALAS',         25,   NULL,                   '4-6'),
  ('SNOCAP ICE CREAM PVT LTD',                    'SKOL',          30,   NULL,                   '3-5'),
  ('SILICON VALLEY FOOD TECH',                     'MAXIMUS',       25,   NULL,                   '3-4'),
  ('THARA & COMPANY',                              'GANDOUR',       30,   NULL,                   '10-12'),
  ('THARA AGENCIES (FG 30)',                       'CINTU',         30,   NULL,                   '10-12'),
  ('TROPICANA LOGISTICS PVT LTD',                 'FUNWAVE',       10,   NULL,                   '2-3'),
  ('VAJRAM (FG 32)',                               'HUNGRITOS',      5,   NULL,                   '2-3')
ON CONFLICT (LOWER(TRIM(vendor_name))) DO NOTHING;

-- Generate initial schedule rows for the next 60 days.
SELECT * FROM generate_po_schedules(60);


-- ─── 11. pg_cron DAILY JOBS ─────────────────────────────────────────────────
-- These require pg_cron to be enabled on the Supabase project.
-- Run via: Supabase Dashboard → Extensions → pg_cron, then apply this SQL.

-- 9:50 AM IST = 4:20 AM UTC (IST is UTC+5:30)
-- Generates next-60-day schedules and marks today's DUE rows.
SELECT cron.schedule(
  'po-daily-generate',
  '20 4 * * *',  -- 09:50 IST every day
  $$
    SELECT generate_po_schedules(60);
    SELECT mark_due_schedules();
  $$
) WHERE NOT EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'po-daily-generate'
);

-- 10:00 AM IST = 4:30 AM UTC — call Edge Function to send push notifications.
-- The Edge Function handles: send push, mark NOTIFIED, escalate ignored (24h+).
SELECT cron.schedule(
  'po-daily-notify',
  '30 4 * * *',  -- 10:00 IST every day
  $$
    SELECT net.http_post(
      url := (SELECT value FROM app_settings WHERE key = 'supabase_url') || '/functions/v1/send-po-push',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-qc-secret', (SELECT value FROM app_settings WHERE key = 'qc_push_secret')
      ),
      body := '{"kind":"po_daily_notify"}'
    );
  $$
) WHERE NOT EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'po-daily-notify'
);

-- ─── End of migration 68 ────────────────────────────────────────────────────
