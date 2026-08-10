-- ============================================================================
-- Alpha Trade Links V6 — Sales-rep external push for announcements
--
-- When an announcement is created (product/price/scheme update from an Excel
-- upload, OR any manual admin announcement to 'all'), fire an external Web Push
-- to every subscribed SALESPERSON device — even when their app is closed.
--
-- Reuses the SAME send-qc-push Edge Function (now handles kind='announcement')
-- and the SAME push_subscriptions table + app_settings config you already set
-- up for QC. Nothing about the QC flow changes.
--
-- PREREQUISITES (already done during QC setup):
--   • supabase_v4_qc_push.sql has been run (push_subscriptions, app_settings).
--   • app_settings.qc_push_function_url + qc_push_secret are populated.
--   • The send-qc-push Edge Function is deployed (redeploy after this update so
--     it includes the announcement branch — see SETUP doc).
--
-- Run in Supabase → SQL Editor. Additive and safe.
-- ============================================================================

create or replace function public.notify_reps_on_announcement()
returns trigger language plpgsql security definer set search_path = public, extensions as $$
declare
  s record;
begin
  select * into s from public.app_settings where id = 1;
  if s.qc_push_function_url is null or length(s.qc_push_function_url) = 0 then
    return new; -- push not configured; do nothing
  end if;

  -- Only broadcast pushes for 'all'-audience announcements. (Selected-audience
  -- ones are rare and targeted; they still appear in-app via the bell.)
  if coalesce(new.audience, 'all') <> 'all' then
    return new;
  end if;

  perform net.http_post(
    url := s.qc_push_function_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-qc-secret', coalesce(s.qc_push_secret, '')
    ),
    body := jsonb_build_object(
      'kind', 'announcement',
      'ann_title', coalesce(new.title, 'Product Update'),
      'ann_body', coalesce(new.body, '')
    )
  );
  return new;
exception when others then
  -- Never let a push failure block creating the announcement.
  raise warning 'notify_reps_on_announcement failed: %', sqlerrm;
  return new;
end;
$$;

drop trigger if exists trg_notify_reps_on_announcement on public.announcements;
create trigger trg_notify_reps_on_announcement
  after insert on public.announcements
  for each row execute function public.notify_reps_on_announcement();

-- Done. (Redeploy the send-qc-push Edge Function so it includes the
-- kind='announcement' branch, then test by sending an announcement.)
