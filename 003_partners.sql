-- Partner courses: each gets a slug (used in URLs), a code (printed on cards), and its own counts.
create table if not exists partners (
  slug          text primary key,          -- 'stonewall'
  code          text unique not null,      -- 'GC-STONEWALL'
  course        text not null,
  contact_name  text,
  contact_email text,
  pro_name      text,
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);

alter table players add column if not exists partner_slug text references partners(slug);
