create extension if not exists pgcrypto;

create table if not exists public.solicitudes (
  id uuid primary key default gen_random_uuid(),
  submission_id text unique not null,
  created_at timestamptz not null default now(),
  nombre text not null,
  municipio text not null,
  telefono text not null,
  maquina text not null,
  capacidad text not null,
  tipo text[] not null default '{}',
  red text,
  fuente text,
  experiencia text,
  score integer not null default 0,
  qualifies_for_direct_whatsapp boolean not null default false,
  pdf_url text,
  status text not null default 'nuevo',
  notes text,
  assigned_to text,
  follow_up_at timestamptz,
  last_contacted_at timestamptz
);

alter table public.solicitudes add column if not exists status text not null default 'nuevo';
alter table public.solicitudes add column if not exists notes text;
alter table public.solicitudes add column if not exists assigned_to text;
alter table public.solicitudes add column if not exists follow_up_at timestamptz;
alter table public.solicitudes add column if not exists last_contacted_at timestamptz;

create index if not exists solicitudes_created_at_idx on public.solicitudes (created_at desc);
create index if not exists solicitudes_status_idx on public.solicitudes (status);
create index if not exists solicitudes_follow_up_at_idx on public.solicitudes (follow_up_at);
