-- ============================================================================
-- Alpha Trade Links V4 — Phase 4B: delivery execution
-- Per-product delivery checklist + completion details.
--
-- Run in Supabase → SQL Editor → New query → paste → Run.
-- ============================================================================

-- Per-product delivery status for a delivery.
create table if not exists public.delivery_items (
  id uuid primary key default gen_random_uuid(),
  delivery_id uuid references public.deliveries(id) on delete cascade,
  product_name text not null,
  ordered_qty int not null default 0,
  unit text default 'Piece',
  delivered boolean not null default false,
  delivered_qty int,                       -- how many actually delivered
  reason text default '',                  -- if not (fully) delivered
  created_at timestamptz not null default now()
);
create index if not exists delivery_items_delivery_idx on public.delivery_items(delivery_id);

-- Completion details recorded when a rep finishes a delivery.
alter table public.deliveries
  add column if not exists completed_at timestamptz,
  add column if not exists completion_note text,
  add column if not exists latitude double precision,
  add column if not exists longitude double precision;

alter table public.delivery_items enable row level security;

-- Delivery admin: full access.
drop policy if exists ditems_admin on public.delivery_items;
create policy ditems_admin on public.delivery_items
  for all using ( public.is_delivery_admin() ) with check ( public.is_delivery_admin() );

-- Sales admin oversight (read).
drop policy if exists ditems_salesadmin on public.delivery_items;
create policy ditems_salesadmin on public.delivery_items
  for select using ( public.is_admin() );

-- Delivery rep: read + write items for deliveries assigned to them.
drop policy if exists ditems_rep_read on public.delivery_items;
create policy ditems_rep_read on public.delivery_items
  for select using (
    exists (select 1 from public.deliveries d
            where d.id = delivery_id and d.assigned_to = auth.uid())
  );

drop policy if exists ditems_rep_write on public.delivery_items;
create policy ditems_rep_write on public.delivery_items
  for all using (
    exists (select 1 from public.deliveries d
            where d.id = delivery_id and d.assigned_to = auth.uid())
  ) with check (
    exists (select 1 from public.deliveries d
            where d.id = delivery_id and d.assigned_to = auth.uid())
  );

-- Done.
