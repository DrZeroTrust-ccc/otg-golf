// Sends signed, synthetic Stripe events to the local server and prints the resulting rows.
import Stripe from "stripe";
import pg from "pg";
const secret = "whsec_testsecret";
const stripe = new Stripe("sk_test_fake");
const url = "http://localhost:3999/webhooks/stripe";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function send(id, type, object, opts = {}) {
  const payload = JSON.stringify({ id, object: "event", type, data: { object }, created: Math.floor(Date.now()/1000) });
  const header = opts.badSig ? "t=1,v1=deadbeef" : stripe.webhooks.generateTestHeaderString({ payload, secret });
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": header }, body: payload });
  console.log(`${type.padEnd(32)} ${id.padEnd(14)} -> ${r.status} ${await r.text()}`);
}

await send("evt_bad", "customer.created", {}, { badSig: true });
await send("evt_1", "customer.created", { id: "cus_A", object: "customer", name: "Founder One", phone: "(540) 555-0101", email: "One@Example.com" });
await send("evt_2", "customer.subscription.created", { id: "sub_A", object: "subscription", customer: "cus_A", status: "trialing",
  trial_end: 1762642800, items: { data: [{ price: { id: "price_test_founding" }, current_period_end: 1765234800 }] } });
await send("evt_2", "customer.subscription.created", { id: "sub_A", object: "subscription", customer: "cus_A", status: "active",
  items: { data: [{ price: { id: "price_test_founding" } }] } });  // duplicate id: must be ignored
await send("evt_3", "checkout.session.completed", { id: "cs_L1", object: "checkout.session", mode: "payment", customer: null, amount_total: 19900,
  customer_details: { name: "League Guy", phone: "5405550102", email: "league@example.com" }, metadata: { product: "winter_league_s1" } });
await send("evt_4", "checkout.session.completed", { id: "cs_B1", object: "checkout.session", mode: "payment", customer: null, amount_total: 6000,
  customer_details: { name: "League Guy", phone: "540-555-0102", email: null }, metadata: { product: "opening_week_bay_hour" } });  // same phone: same player
await send("evt_5", "customer.subscription.updated", { id: "sub_Z", object: "subscription", customer: "cus_A", status: "active",
  items: { data: [{ price: { id: "price_unknown" } }] } });  // unmapped price
await send("evt_6", "invoice.payment_failed", { id: "in_1", object: "invoice", subscription: "sub_A" });
await send("evt_7", "payment_intent.succeeded", { id: "pi_1", object: "payment_intent" });  // ignored type

const q = async (sql) => (await pool.query(sql)).rows;
console.log("\nplayers:"); console.table(await q("select name, phone, email, stripe_customer_id from players order by created_at"));
console.log("memberships:"); console.table(await q("select tier, status, current_period_end::date, trial_end::date from memberships"));
console.log("purchases:"); console.table(await q("select product, amount_cents, (select name from players p where p.id=player_id) as who from purchases order by created_at"));
console.log("tags:"); console.table(await q("select (select name from players p where p.id=player_id) as who, tag from tags order by 1,2"));
console.log("stripe_events:"); console.table(await q("select id, type, processed_at is not null as processed, error from stripe_events order by received_at"));
console.log("events kinds:"); console.table(await q("select kind, count(*) from events group by kind order by kind"));
await pool.end();
