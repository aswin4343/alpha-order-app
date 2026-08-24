-- ===========================================================================
-- 50_purchase_alert_push.sql  —  Feature 4, Half B
-- Fire an OS push (via the send-qc-push Edge Function) when a product's alert
-- flips inactive -> active (i.e. stock crosses DOWN to the reorder level).
--
-- Server-side, so it works even when no Purchase Manager dashboard is open.
-- The edge function itself checks the push_enabled toggle and targets
-- purchase_manager devices. Fire-once/reset is already handled by the
-- alert_active flag, so this trigger only sees genuine downward crossings.
--
-- PREREQUISITES (same as the existing QC push):
--   • pg_net extension enabled.
--   • app_settings holds the function URL + shared secret. We reuse the same
--     secret the QC push uses (qc_push_secret) so no new config is needed.
-- ===========================================================================

-- Ensure pg_net is available (no-op if already enabled).
create extension if not exists pg_net;

create or replace function notify_purchase_alert()
returns trigger
language plpgsql
security definer
as $$
declare
  v_url text;
  v_secret text;
  v_name text;
begin
  -- Only on a genuine inactive -> active transition.
  if coalesce(new.alert_active, false) = true
     and coalesce(old.alert_active, false) = false then

    -- Pull the function URL + shared secret from app_settings (same row the QC
    -- push uses). If not configured, silently skip (no error to the caller).
    select value into v_url from app_settings where key = 'push_function_url';
    select value into v_secret from app_settings where key = 'qc_push_secret';
    if v_url is null or v_secret is null then
      return new;
    end if;

    select name into v_name from products where id = new.product_id;

    perform net.http_post(
      url := v_url,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-qc-secret', v_secret
      ),
      body := jsonb_build_object(
        'kind', 'purchase_alert',
        'product_name', coalesce(v_name, new.product_id),
        'current_stock', new.current_stock,
        'reorder_level', new.minimum_stock
      )
    );
  end if;
  return new;
end;
$$;

drop trigger if exists trg_purchase_alert_push on product_inventory;
create trigger trg_purchase_alert_push
  after update of alert_active on product_inventory
  for each row
  execute function notify_purchase_alert();

-- NOTE: if your app_settings does not yet have 'push_function_url', set it:
--   insert into app_settings (key, value) values
--     ('push_function_url', 'https://<PROJECT_REF>.supabase.co/functions/v1/send-qc-push')
--   on conflict (key) do update set value = excluded.value;
-- (qc_push_secret already exists from the QC push setup.)

notify pgrst, 'reload schema';
