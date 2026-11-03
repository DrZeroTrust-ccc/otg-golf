-- Bay booking: the bays, bookings (and staff blocks), sign-in codes and sessions, and one
-- editable settings row. Double-booking is prevented in code under a per-bay lock (bookings.ts).

create table if not exists bays (
  id         text primary key,                 -- 'bay1' .. 'bay4', 'putt'
  name       text not null,
  kind       text not null check (kind in ('sim','putt')),
  premier    boolean not null default false,
  sort       integer not null default 0,
  active     boolean not null default true
);

insert into bays (id, name, kind, premier, sort) values
  ('bay1', 'Premier Bay', 'sim', true, 1),
  ('bay2', 'Bay 2', 'sim', false, 2),
  ('bay3', 'Bay 3', 'sim', false, 3),
  ('bay4', 'Bay 4', 'sim', false, 4),
  ('putt', 'PuttView Green', 'putt', false, 5)
on conflict (id) do nothing;

create table if not exists bookings (
  id                  uuid primary key default gen_random_uuid(),
  created_at          timestamptz not null default now(),
  kind                text not null default 'booking' check (kind in ('booking','block')),
  bay_id              text not null references bays(id),
  player_id           uuid references players(id),
  starts_at           timestamptz not null,
  ends_at             timestamptz not null check (ends_at > starts_at),
  status              text not null check (status in ('pending_payment','confirmed','cancelled','expired','paid_conflict')),
  source              text not null default 'app' check (source in ('app','staff')),
  plan                text,                      -- the player's plan when they booked: founding, full, weekday or none
  guests              integer not null default 0,
  price_cents         integer not null default 0,
  note                text,
  hold_until          timestamptz,               -- pending_payment only: released after this
  stripe_checkout_id  text unique,
  stripe_payment_intent text,
  paid_cents          integer not null default 0,
  refunded_cents      integer not null default 0,
  cancelled_at        timestamptz,
  cancelled_by        text,
  reminded_at         timestamptz
);
create index if not exists bookings_bay_time_idx on bookings (bay_id, starts_at);
create index if not exists bookings_player_idx on bookings (player_id, starts_at);

-- One-time sign-in codes, sent by text or email. Only a hash of the code is kept.
create table if not exists login_codes (
  id          bigserial primary key,
  created_at  timestamptz not null default now(),
  channel     text not null check (channel in ('sms','email')),
  address     text not null,                     -- normalized phone or email
  code_hash   text not null,
  expires_at  timestamptz not null,
  attempts    integer not null default 0,
  used_at     timestamptz
);
create index if not exists login_codes_addr_idx on login_codes (address, created_at desc);

create table if not exists sessions (
  token_hash  text primary key,
  player_id   uuid not null references players(id),
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null
);

-- Booking rules and prices that staff can change without a code change. Missing keys fall back
-- to the defaults in booking_rules.ts.
create table if not exists booking_settings (
  id          integer primary key default 1 check (id = 1),
  config      jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);
insert into booking_settings (id) values (1) on conflict (id) do nothing;
