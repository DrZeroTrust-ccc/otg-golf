-- Automation: an outbox of every automatic message, an email log, and event inquiries.
alter table players add column if not exists sms_consent_at timestamptz;

-- One row per message per channel per recipient. Handlers insert rows inside their transaction;
-- the dispatcher sends them after commit. dedupe_key makes every message send at most once.
create table if not exists outbox (
  id              bigserial primary key,
  created_at      timestamptz not null default now(),
  dedupe_key      text unique not null,
  audience        text not null check (audience in ('customer','owner')),
  channel         text not null check (channel in ('email','sms')),
  player_id       uuid references players(id),
  to_addr         text,                       -- null = look up the player's email/phone at send time
  subject         text,
  body            text not null,
  reply_to        text,
  status          text not null default 'pending'
                  check (status in ('pending','sending','sent','held','skipped','failed')),
  attempts        integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error      text,
  sent_at         timestamptz
);
create index if not exists outbox_pending_idx on outbox (next_attempt_at) where status = 'pending';

create table if not exists email_messages (
  id          bigserial primary key,
  at          timestamptz not null default now(),
  to_addr     text not null,
  subject     text not null,
  status      text not null,
  provider_id text,
  error       text,
  outbox_id   bigint references outbox(id)
);

create table if not exists inquiries (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  player_id   uuid references players(id),
  name        text,
  email       text,
  phone       text,
  package     text,
  event_date  text,
  guests      text,
  message     text,
  raw         jsonb not null default '{}'::jsonb,
  status      text not null default 'new' check (status in ('new','handled','spam')),
  handled_at  timestamptz,
  nudged_at   timestamptz
);
create index if not exists inquiries_status_idx on inquiries (status, created_at);
