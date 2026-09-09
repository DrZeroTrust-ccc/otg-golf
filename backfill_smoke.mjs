// Runs the backfill against a fake Stripe client, dry then write, and prints what landed.
import pg from "pg";
import { runBackfill } from "./dist/backfill.js";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
async function* list(items) { for (const i of items) yield i; }
const fake = {
    customers: { list: () => list([{ id: "cus_B1", object: "customer", name: "Backfill Betty", phone: "540-555-0199", email: "betty@example.com" }]) },
    subscriptions: { list: () => list([{ id: "sub_B1", object: "subscription", customer: "cus_B1", status: "trialing", trial_end: 1762642800,
                                            items: { data: [{ price: { id: "price_test_founding" }, current_period_end: 1765234800 }] } }]) },
    checkout: { sessions: {
          list: () => list([
            { id: "cs_BF1", object: "checkout.session", mode: "payment", payment_status: "paid", customer: "cus_B1", amount_total: 19900, customer_details: { name: "Backfill Betty", phone: "5405550199", email: "betty@example.com" }, metadata: { product: "winter_league_s1" } },
            { id: "cs_BF2", object: "checkout.session", mode: "payment", payment_status: "unpaid", customer: null, amount_total: 6000, customer_details: { name: "Abandoned Al", phone: "5405550100" }, metadata: { product: "opening_week_bay_hour" } },
                ]),
          listLineItems: async () => ({ data: [] }),
    } },
};
const before = (await pool.query("select count(*)::int as n from players")).rows[0].n;
console.log("DRY:", await runBackfill(fake, false));
const mid = (await pool.query("select count(*)::int as n from players")).rows[0].n;
console.log(`players before=${before} after dry=${mid} (must be equal)`);
console.log("WRITE:", await runBackfill(fake, true));
console.log("WRITE again (idempotent):", await runBackfill(fake, true));
console.table((await pool.query("select p.name, p.phone, m.tier, m.status, array_agg(t.tag order by t.tag) tags from players p left join memberships m on m.player_id=p.id left join tags t on t.player_id=p.id where p.name like 'Backfill%' group by 1,2,3,4")).rows);
console.table((await pool.query("select product, amount_cents from purchases where stripe_checkout_session_id like 'cs_BF%'")).rows);
console.table((await pool.query("select kind, count(*)::int from events where kind like 'backfill%' group by 1")).rows);
await pool.end();
