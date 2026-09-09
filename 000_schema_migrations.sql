create table if not exists schema_migrations (
  filename   text primary key,
  applied_at timestamptz not null default now()
);
