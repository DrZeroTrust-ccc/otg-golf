-- Booking part 2: check-in, no-shows (with an optional fee and strikes), guest passes and
-- early-access requests.

alter table bookings drop constraint if exists bookings_status_check;
alter table bookings add constraint bookings_status_check
  check (status in ('pending_payment','confirmed','cancelled','expired','paid_conflict','no_show','requested','declined'));

alter table bookings add column if not exists checked_in_at     timestamptz;
alter table bookings add column if not exists checked_in_by     text;          -- 'qr' or 'staff'
alter table bookings add column if not exists no_show_at        timestamptz;
alter table bookings add column if not exists no_show_waived    boolean not null default false;
alter table bookings add column if not exists no_show_fee_cents integer not null default 0;
alter table bookings add column if not exists no_show_invoice_item text;       -- Stripe invoice item id, so a waived fee can be removed
alter table bookings add column if not exists late_cancel       boolean not null default false;
alter table bookings add column if not exists guest_passes_used integer not null default 0;
alter table bookings add column if not exists guest_fee_cents   integer not null default 0;
alter table bookings add column if not exists early             boolean not null default false;

-- The front-desk QR code carries this code, so only someone standing at the desk can check in.
-- Kept apart from config so editing the rules on the staff screen can't wipe it.
alter table booking_settings add column if not exists checkin_code text;
update booking_settings set checkin_code = substr(md5(random()::text || clock_timestamp()::text), 1, 10)
 where id = 1 and checkin_code is null;
