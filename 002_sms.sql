-- SMS primitive: consent state on players, and an append-only log of every message in or out.
alter table players add column if not exists sms_opt_out boolean not null default false;
alter table players add column if not exists sms_opt_out_at timestamptz;

create table if not exists sms_messages (
  id bigserial primary key,
  at timestamptz not null default now(),
  direction text not null check (direction in ('in','out')),
  phone text not null,
  player_id uuid references players(id),
  body text not null,
  twilio_sid text unique,
  status text not null,
  error text
  );

create index if not exists sms_messages_phone_idx on sms_messages (phone, at desc);
