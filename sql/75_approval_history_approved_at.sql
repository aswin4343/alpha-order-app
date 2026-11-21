-- =============================================================================
-- 75_approval_history_approved_at.sql                         (Alpha Flow v229)
--
-- Adds price_approval_history.approved_at — the exact moment the Admin
-- approved the request, taken from the DATABASE SERVER clock.
--
--   Request Date  = when the Sales Rep submitted the request (order_date) — unchanged
--   Approved At   = when the Admin clicked Approve (this column)
--
-- Rules (enforced by trigger, the app cannot override them):
--   • INSERT with decision = 'approved'          → approved_at = server now()
--   • UPDATE that turns a row into 'approved'    → approved_at = server now()
--     (only if it has no approved_at yet)
--   • Once set, approved_at never changes again — any client value is ignored,
--     so unrelated edits (reason, price, re-saves) can never overwrite it.
--   • Rejected rows keep approved_at = NULL.
--   • Existing rows are NOT backfilled: their real server-side approval time
--     was never recorded, so the app shows "—" for them.
--
-- Additive and safe to re-run. Rollback: drop the trigger + function at the
-- bottom of this file (the column can stay).
-- =============================================================================

begin;

do $$
declare v_missing text;
begin
  select string_agg(v.c, ', ') into v_missing
  from (values ('id'), ('decision')) as v(c)
  where not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'price_approval_history' and column_name = v.c);
  if v_missing is not null then
    raise exception 'Migration 75 aborted — price_approval_history is missing: %. Nothing was changed.', v_missing;
  end if;
end $$;

alter table public.price_approval_history
  add column if not exists approved_at timestamptz;

comment on column public.price_approval_history.approved_at is
  'Server time the Admin approved this request. Set once by trigger price_approval_history_approved_at; never overwritten. NULL for rejected rows and for rows approved before migration 75.';

create or replace function public.trg_price_approval_history_approved_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if TG_OP = 'INSERT' then
    NEW.approved_at := case when NEW.decision = 'approved' then now() else null end;
    return NEW;
  end if;

  -- UPDATE: an existing approval time is permanent.
  if OLD.approved_at is not null then
    NEW.approved_at := OLD.approved_at;
  elsif NEW.decision = 'approved' and OLD.decision is distinct from 'approved' then
    NEW.approved_at := now();          -- this update IS the approval (e.g. rejected → approved)
  else
    NEW.approved_at := null;           -- no fabricated times for old / unapproved rows
  end if;
  return NEW;
end;
$$;

drop trigger if exists price_approval_history_approved_at on public.price_approval_history;
create trigger price_approval_history_approved_at
  before insert or update on public.price_approval_history
  for each row execute function public.trg_price_approval_history_approved_at();

commit;

notify pgrst, 'reload schema';

-- ROLLBACK (only if ever needed):
--   drop trigger if exists price_approval_history_approved_at on public.price_approval_history;
--   drop function if exists public.trg_price_approval_history_approved_at();
