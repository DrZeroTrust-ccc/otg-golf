-- When each member number was copied onto the Stripe customer (metadata.member_number).
alter table players add column if not exists member_number_stripe_at timestamptz;
