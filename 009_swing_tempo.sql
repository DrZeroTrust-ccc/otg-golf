-- Swing coaching, phase 1: tempo. A session is one player's time in the Premier bay with the
-- cameras on; each swing keeps its backswing and downswing times. No video is stored yet.

create table if not exists swing_sessions (
  id          uuid primary key default gen_random_uuid(),
  started_at  timestamptz not null default now(),
  ended_at    timestamptz,
  booking_id  uuid references bookings(id) on delete set null,
  player_id   uuid references players(id) on delete set null,
  label       text,                -- a name for walk-ins with no booking
  camera      text,                -- camera name as the bay screen saw it
  fps         numeric              -- frames per second the bay screen actually tracked
);
create index if not exists swing_sessions_started_idx on swing_sessions (started_at desc);
create index if not exists swing_sessions_player_idx on swing_sessions (player_id, started_at desc);

create table if not exists swings (
  id             uuid primary key default gen_random_uuid(),
  session_id     uuid not null references swing_sessions(id) on delete cascade,
  swung_at       timestamptz not null default now(),
  backswing_ms   integer not null check (backswing_ms between 350 and 2000),
  downswing_ms   integer not null check (downswing_ms between 120 and 700),
  ratio          numeric(4,2) not null,
  impact_source  text not null default 'sound' check (impact_source in ('sound','motion')),
  confidence     text not null default 'medium' check (confidence in ('high','medium','low'))
);
create index if not exists swings_session_idx on swings (session_id, swung_at);
