-- 001_core.sql — Step 1 tables. Idempotent.
create extension if not exists pgcrypto;

create table if not exists players (
  id                 uuid primary key default gen_random_uuid(),
  stripe_customer_id text unique,
  name               text,
  phone              text unique,
  email              text,
  created_at         timestamptz not null default now()
);
create index if not exists players_email_idx on players (email);

create table if not exists memberships (
  id                     uuid primary key default gen_random_uuid(),
  player_id              uuid not null references players(id),
  stripe_subscription_id text unique not null,
  tier                   text not null,
  status                 text not null,
  current_period_end     timestamptz,
  trial_end              timestamptz,
  updated_at             timestamptz not null default now()
);
create index if not exists memberships_player_idx on memberships (player_id);

create table if not exists purchases (
  id                         uuid primary key default gen_random_uuid(),
  player_id                  uuid references players(id),
  stripe_checkout_session_id text unique not null,
  product                    text not null,
  amount_cents               integer not null,
  metadata                   jsonb not null default '{}'::jsonb,
  created_at                 timestamptz not null default now()
);
create index if not exists purchases_player_idx on purchases (player_id);
create index if not exists purchases_product_idx on purchases (product);

create table if not exists tags (
  player_id  uuid not null references players(id),
  tag        text not null,
  source     text not null,
  created_at timestamptz not null default now(),
  primary key (player_id, tag)
);

create table if not exists price_map (
  stripe_price_id text primary key,
  tier            text,
  product         text,
  tag             text,
  seat_cap        integer
);

create table if not exists stripe_events (
  id           text primary key,
  type         text not null,
  received_at  timestamptz not null default now(),
  processed_at timestamptz,
  error        text
);

create table if not exists events (
  id      bigserial primary key,
  at      timestamptz not null default now(),
  kind    text not null,
  payload jsonb not null
);
create index if not exists events_kind_idx on events (kind);

-- Guard rails: nothing ever updates or deletes from the two logs.
create or replace function otg_forbid() returns trigger language plpgsql as $$
begin
  raise exception 'table % is append-only', tg_table_name;
end $$;

drop trigger if exists events_append_only on events;
create trigger events_append_only
  before update or delete on events
  for each row execute function otg_forbid();
