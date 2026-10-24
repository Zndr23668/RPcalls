create table if not exists public.rpcalls_recordings (
  meeting_id text primary key check (meeting_id ~ '^[a-f0-9]{40}$'),
  title text not null default 'RPcalls meeting',
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  object_path text unique,
  content_type text,
  size_bytes bigint check (size_bytes is null or size_bytes >= 0),
  status text not null default 'recording' check (status in ('recording', 'uploading', 'saved', 'failed')),
  host_token_hash text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.rpcalls_recordings enable row level security;
revoke all on table public.rpcalls_recordings from anon, authenticated;
grant all on table public.rpcalls_recordings to service_role;

create index if not exists rpcalls_recordings_status_created_idx
  on public.rpcalls_recordings (status, created_at desc);
