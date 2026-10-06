// Member number notice smoke test. Needs DATABASE_URL with migrations applied; no server.
import pg from "pg";
import { queueMemberNumberNotices } from "./dist/members.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
let fails = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name} ${extra}`); if (!ok) fails++; };
const q = async (sql, a = []) => (await pool.query(sql, a)).rows;
const run = Date.now().toString(36);
const fmt = (n) => `OTG-${String(n).padStart(4, "0")}`;

// Earlier runs' members already have a notice; mark any others so only this run's are eligible.
await q(`insert into outbox (dedupe_key, audience, channel, player_id, body, status)
         select 'member-number:' || id || ':email', 'customer', 'email', id, 'x', 'sent' from players
          where member_number is not null on conflict do nothing`);
const member = async (name, status = "trialing") => {
  const [p] = await q("insert into players (name, email, member_number) values ($1, $2, nextval('member_number_seq')) returning id, member_number", [name, `${name.replace(/\W/g, "")}.${run}@example.com`]);
  await q("insert into memberships (player_id, stripe_subscription_id, tier, status) values ($1, $2, 'founding', $3)", [p.id, `sub_${name.replace(/\W/g, "")}_${run}`, status]);
  return p;
};
const early = await member("Early Bird");                  // joined before numbers: no welcome at all
const heldW = await member("Held Welcome");                // welcome held while messages were off
const gotIt = await member("Got It");                      // welcome already sent with the number
const lapsed = await member("Lapsed", "canceled");
await q("insert into outbox (dedupe_key, audience, channel, player_id, body, status) values ($1,'customer','email',$2,'Welcome, no number','held')", [`member-welcome:h_${run}:email`, heldW.id]);
await q("insert into outbox (dedupe_key, audience, channel, player_id, body, status) values ($1,'customer','email',$2,$3,'sent')", [`member-welcome:g_${run}:email`, gotIt.id, `Your member number is ${fmt(gotIt.member_number)}.`]);

const keyOf = (p) => `member-number:${p.id}:email`;
const has = async (p) => (await q("select body from outbox where dedupe_key = $1", [keyOf(p)]))[0];

process.env.CUSTOMER_MESSAGES = "";
check("nothing queued while customer messages are off", (await queueMemberNumberNotices()) === 0);
process.env.CUSTOMER_MESSAGES = "on";
await queueMemberNumberNotices();
const e = await has(early);
check("member with no welcome gets a notice with their number", e?.body.includes(fmt(early.member_number)) && e.body.includes("Founding Membership"), fmt(early.member_number));
check("member whose welcome was held gets a notice", !!(await has(heldW)));
check("member whose welcome carried the number gets nothing", !(await has(gotIt)));
check("lapsed member gets nothing", !(await has(lapsed)));
check("second run queues nothing new", (await queueMemberNumberNotices()) === 0);

await pool.end();
console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
process.exit(fails ? 1 : 0);
