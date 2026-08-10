-- ============================================================================
-- Alpha Trade Links V6 — Admin announcement → sales-rep external push
--
-- When an announcement is created (admin product/price/scheme update, or any
-- manual announcement to reps), push it to all subscribed sales reps so it
-- arrives on their phone even when the app is closed.
--
-- Reuses the existing push infrastructure (VAPID keys + QC_PUSH_SECRET). You
-- must deploy the `send-announcement-push` Edge Function and set its URL below.
-- Run in Supabase → SQL Editor AFTER deploying the function.
-- ============================================================================

-- 1. Store the announcement-push function URL alongside the QC one.
alter table public.app_settings
  add column if not exists announcement_push_function_url text;

-- 2. Trigger function: on announcement insert, ping the Edge Function.
--    Wrapped defensively so a push failure can never block announcement creation.
create or replace function public.notify_reps_on_announcement()
returns trigger language plpgsql security definer set search_path = public, extensions as $$
declare
  s record;
  rep_ids uuid[];
begin
  select * into s from public.app_settings where id = 1;
  if s.announcement_push_function_url is null or length(s.announcement_push_function_url) = 0 then
    return new; -- not configured yet
  end if;

  -- For 'selected' audience, gather the explicit recipient rep ids (the app has
  -- just inserted them into announcement_recipients within the same transaction).
  if new.audience = 'selected' then
    select array_agg(rep_id) into rep_ids
    from public.announcement_recipients
    where announcement_id = new.id;
  end if;

  perform net.http_post(
    url := s.announcement_push_function_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-qc-secret', coalesce(s.qc_push_secret, '')
    ),
    body := jsonb_build_object(
      'announcement_id', new.id,
      'title', coalesce(new.title, 'Product Update'),
      'message', coalesce(new.body, ''),
      'audience', new.audience,
      'rep_ids', coalesce(rep_ids, array[]::uuid[])
    )
  );
  return new;
exception when others then
  raise warning 'notify_reps_on_announcement failed: %', sqlerrm;
  return new;
end;
$$;

-- 3. Fire AFTER INSERT. We use a CONSTRAINT TRIGGER deferred to the end of the
--    transaction so that, for 'selected' audiences, the recipient rows the app
--    inserts right after the announcement are already visible when we read them.
drop trigger if exists trg_notify_reps_on_announcement on public.announcements;
create constraint trigger trg_notify_reps_on_announcement
  after insert on public.announcements
  deferrable initially deferred
  for each row execute function public.notify_reps_on_announcement();

-- Done. (Deploy send-announcement-push + set app_settings.announcement_push_function_url.)
