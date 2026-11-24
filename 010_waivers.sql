-- Waivers: one row per signature. A player signs once per waiver version; a new version (new
-- wording) means everyone signs again. Rows are never changed or deleted, so the record of who
-- agreed to what, and when, stays intact.

create table if not exists waivers (
  id           uuid primary key default gen_random_uuid(),
  player_id    uuid not null references players(id),
  version      text not null,                -- WAIVER_VERSION in waiver.ts at the time of signing
  text_sha256  text not null,                -- hash of the exact wording they saw
  signed_name  text not null,                -- the name they typed as their signature
  signed_at    timestamptz not null default now(),
  ip           text,
  user_agent   text
);
create index if not exists waivers_player_idx on waivers (player_id, version);

drop trigger if exists waivers_append_only on waivers;
create trigger waivers_append_only
  before update or delete on waivers
  for each row execute function otg_forbid();
