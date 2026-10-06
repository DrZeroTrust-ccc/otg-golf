// Member number -> Stripe sync smoke test. Needs DATABASE_URL with migrations applied; no server.
import pg from "pg";
import { syncMemberNumbersToStripe } from "./dist/members.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
let fails = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name} ${extra}`); if (!ok) fails++; };
const q = async (sql, a = []) => (await pool.query(sql, a)).rows;
const run = Date.now().toString(36);

// Clear anything left from earlier runs so only this run's rows are pending.
await q("update players set member_number_stripe_at = now() where member_number_stripe_at is null");
const [a] = await q("insert into players (name, stripe_customer_id, member_number) values ('Sync A', $1, nextval('member_number_seq')) returning id, member_number", [`cus_sa_${run}`]);
const [gone] = await q("insert into players (name, stripe_customer_id, member_number) values ('Sync Gone', $1, nextval('member_number_seq')) returning id", [`cus_gone_${run}`]);
const [flaky] = await q("insert into players (name, stripe_customer_id, member_number) values ('Sync Flaky', $1, nextval('member_number_seq')) returning id", [`cus_flaky_${run}`]);
await q("insert into players (name, stripe_customer_id) values ('Not a member', $1)", [`cus_nm_${run}`]);

const calls = [];
let flakyFails = true;
const fake = { customers: { update: async (id, p) => {
  calls.push([id, p]);
  if (id.startsWith("cus_gone_")) throw Object.assign(new Error("No such customer"), { code: "resource_missing" });
  if (id.startsWith("cus_flaky_") && flakyFails) throw Object.assign(new Error("rate limited"), { code: "rate_limit" });
  return {};
} } };

const n1 = await syncMemberNumbersToStripe(fake);
const fmt = `OTG-${String(a.member_number).padStart(4, "0")}`;
check("member's number written to Stripe metadata", calls.some(([id, p]) => id === `cus_sa_${run}` && p.metadata.member_number === fmt), fmt);
check("non-member not sent to Stripe", !calls.some(([id]) => id === `cus_nm_${run}`));
check("first run synced one", n1 === 1, String(n1));
const st = async (id) => (await q("select member_number_stripe_at from players where id=$1", [id]))[0].member_number_stripe_at;
check("missing Stripe customer is not retried", (await st(gone.id)) !== null);
check("temporary failure left for retry", (await st(flaky.id)) === null);
flakyFails = false; calls.length = 0;
const n2 = await syncMemberNumbersToStripe(fake);
check("retry succeeds and nothing is sent twice", n2 === 1 && calls.length === 1 && calls[0][0] === `cus_flaky_${run}`);

await pool.end();
console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
process.exit(fails ? 1 : 0);
