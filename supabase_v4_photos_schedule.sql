-- OPTIONAL: schedule the 40-day photo cleanup to run daily.
-- Only works if the pg_cron extension is enabled
-- (Database → Extensions → search "pg_cron" → enable).
-- If you skip this, run  select public.cleanup_old_delivery_photos();  manually.

select cron.schedule(
  'cleanup-delivery-photos',
  '0 2 * * *',
  'select public.cleanup_old_delivery_photos();'
);
