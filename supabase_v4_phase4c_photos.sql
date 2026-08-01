-- ============================================================================
-- Alpha Trade Links V4 — Phase 4C (part 1): Proof-of-delivery photos
-- PRE-REQUISITE: create a PUBLIC Storage bucket named  delivery-photos
-- Safe to re-run.
-- ============================================================================

create table if not exists public.delivery_photos (
  id uuid primary key default gen_random_uuid(),
  delivery_id uuid references public.deliveries(id) on delete cascade,
  kind text not null default 'product' check (kind in ('bill','product')),
  path text not null,
  url text not null,
  created_at timestamptz not null default now()
);
create index if not exists delivery_photos_delivery_idx on public.delivery_photos(delivery_id);

alter table public.delivery_photos enable row level security;

drop policy if exists dphotos_admin on public.delivery_photos;
create policy dphotos_admin on public.delivery_photos
  for all using ( public.is_delivery_admin() ) with check ( public.is_delivery_admin() );

drop policy if exists dphotos_salesadmin on public.delivery_photos;
create policy dphotos_salesadmin on public.delivery_photos
  for select using ( public.is_admin() );

drop policy if exists dphotos_rep_read on public.delivery_photos;
create policy dphotos_rep_read on public.delivery_photos
  for select using (
    exists (select 1 from public.deliveries d
            where d.id = delivery_id and d.assigned_to = auth.uid())
  );

drop policy if exists dphotos_rep_insert on public.delivery_photos;
create policy dphotos_rep_insert on public.delivery_photos
  for insert with check (
    exists (select 1 from public.deliveries d
            where d.id = delivery_id and d.assigned_to = auth.uid())
  );

-- Storage bucket access policies (on storage.objects).
drop policy if exists "delivery photos upload" on storage.objects;
create policy "delivery photos upload" on storage.objects
  for insert to authenticated
  with check ( bucket_id = 'delivery-photos' and public.is_delivery() );

drop policy if exists "delivery photos read" on storage.objects;
create policy "delivery photos read" on storage.objects
  for select to authenticated
  using ( bucket_id = 'delivery-photos' );

-- Auto-delete photos older than 40 days (function only; scheduling is separate).
create or replace function public.cleanup_old_delivery_photos()
returns void language plpgsql security definer set search_path = public, storage as $func$
declare
  old_path text;
begin
  for old_path in
    select path from public.delivery_photos where created_at < now() - interval '40 days'
  loop
    delete from storage.objects
      where bucket_id = 'delivery-photos' and name = old_path;
  end loop;
  delete from public.delivery_photos where created_at < now() - interval '40 days';
end;
$func$;

-- Done. Photos work now.
-- (Optional auto-schedule is in a SEPARATE script: supabase_v4_photos_schedule.sql)
