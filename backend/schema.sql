-- Run this in the Supabase SQL editor (Epic 2: Database Setup)
create table if not exists public.trips (
  id uuid primary key default gen_random_uuid(),
  client_id text not null,
  destination text not null,
  title text,
  request jsonb not null,
  itinerary jsonb not null,
  image_url text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists trips_client_idx on public.trips (client_id);
-- The backend uses the service-role key, so RLS can stay enabled with no policies.
alter table public.trips enable row level security;
