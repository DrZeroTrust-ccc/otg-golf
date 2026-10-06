-- Member numbers: every player with a live membership gets a permanent, sequential number
-- (shown as OTG-0001). Assigned once, never reused, kept if the membership later lapses.
create sequence if not exists member_number_seq;
alter table players add column if not exists member_number integer unique;
alter table players add column if not exists member_number_at timestamptz;

-- Number the members who joined before this existed, in the order they became players.
update players p set member_number = n.num, member_number_at = now()
  from (
    select id, nextval('member_number_seq') as num
      from (select pl.id from players pl
             where pl.member_number is null
               and exists (select 1 from memberships m where m.player_id = pl.id and m.status in ('trialing','active','past_due'))
             order by pl.created_at, pl.id) ordered
  ) n
 where p.id = n.id;
