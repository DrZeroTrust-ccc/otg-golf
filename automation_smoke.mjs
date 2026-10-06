// Automation smoke test. Start the server first (see README notes in the PR description):
//   DATABASE_URL=... STRIPE_SECRET_KEY=sk_test_fake STRIPE_WEBHOOK_SECRET="whsec_testsecret " \
//   RESEND_API_KEY=re_test RESEND_API_URL=http://localhost:3998/emails OTG_READ_KEY=k \
//   OWNER_ALERT_PHONE=+15405550100 PORT=3999 node dist/server.js
// The webhook secret above deliberately has a trailing space: the server must trim it.
import http from "node:http";
import Stripe from "stripe";
import pg from "pg";

const secret = "whsec_testsecret";
const stripe = new Stripe("sk_test_fake");
const base = "http://localhost:3999";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const now = Math.floor(Date.now() / 1000);
let fails = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name} ${extra}`); if (!ok) fails++; };
const q = async (sql, a = []) => (await pool.query(sql, a)).rows;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Fake Resend: records every email it is asked to send.
const sentEmails = [];
const fake = http.createServer((req, res) => {
  let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => {
    sentEmails.push(JSON.parse(b));
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ id: `em_${sentEmails.length}` }));
  });
}).listen(3998);

async function send(id, type, object) {
  const payload = JSON.stringify({ id, object: "event", type, data: { object }, created: now });
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret });
  const r = await fetch(`${base}/webhooks/stripe`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": header }, body: payload });
  return r.status;
}
const run = Date.now().toString(36);
const cus = `cus_auto_${run}`, sub = `sub_auto_${run}`, cs = `cs_auto_${run}`;
const email = `auto.${run}@example.com`;

// 1. Trailing whitespace in the webhook secret no longer breaks signatures.
check("signed webhook accepted despite whitespace in secret",
  (await send(`evt_c_${run}`, "customer.created", { id: cus, object: "customer", name: "Ada Member", phone: null, email })) === 200);

// 2. Two events for one brand-new customer at the same instant: neither may 500.
const cus2 = `cus_race_${run}`;
const race = await Promise.all([
  send(`evt_r1_${run}`, "customer.created", { id: cus2, object: "customer", name: "Race One", email: `race.${run}@example.com` }),
  send(`evt_r2_${run}`, "customer.updated", { id: cus2, object: "customer", name: "Race One", email: `race.${run}@example.com` }),
]);
check("simultaneous events for a new customer both succeed", race.every((s) => s === 200), race.join(","));
check("...and created exactly one player", (await q("select count(*)::int n from players where stripe_customer_id=$1", [cus2]))[0].n === 1);

// 3. New membership: owner alerted now, customer message queued but held.
await send(`evt_s_${run}`, "customer.subscription.created", { id: sub, object: "subscription", customer: cus, status: "active", created: now,
  items: { data: [{ price: { id: "price_test_full", product: "prod_VEJV0A0R1kjMB3", recurring: { interval: "year" } } }] } });
// replay with a new event id must not queue a second welcome
await send(`evt_s2_${run}`, "customer.subscription.updated", { id: sub, object: "subscription", customer: cus, status: "active", created: now,
  items: { data: [{ price: { id: "price_test_full", product: "prod_VEJV0A0R1kjMB3", recurring: { interval: "year" } } }] } });
// an old subscription (backfill / late replay) must queue nothing
await send(`evt_old_${run}`, "customer.subscription.created", { id: `${sub}_old`, object: "subscription", customer: cus, status: "active", created: now - 30 * 86400,
  items: { data: [{ price: { id: "price_test_full", product: "prod_VEJV0A0R1kjMB3" } }] } });

// 4. One-time purchase.
await send(`evt_p_${run}`, "checkout.session.completed", { id: cs, object: "checkout.session", mode: "payment", customer: null, created: now, amount_total: 6000,
  customer_details: { name: "Bo Buyer", phone: null, email: `bo.${run}@example.com` }, metadata: { product: "opening_week_bay_hour" } });

// 5. Event inquiry, JSON, from the site's origin.
const inq = await fetch(`${base}/inquiries`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json", origin: "https://otg.golf" },
  body: JSON.stringify({ name: "Eve Planner", email: `eve.${run}@example.com`, phone: "540-555-0177", package: "Half-Club", date: "Dec 12", guests: "12", message: "Holiday party" }) });
check("inquiry accepted", inq.status === 200 && (await inq.json()).ok === true);
check("inquiry CORS header for the site", inq.headers.get("access-control-allow-origin") === "https://otg.golf");
const bot = await fetch(`${base}/inquiries`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" },
  body: JSON.stringify({ name: "Bot", email: `bot.${run}@example.com`, company_website: "http://spam" }) });
check("honeypot submission silently dropped", bot.status === 200 && (await q("select count(*)::int n from inquiries where email=$1", [`bot.${run}@example.com`]))[0].n === 0);
const bad = await fetch(`${base}/inquiries`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ name: "No Contact" }) });
check("inquiry without contact details rejected", bad.status === 400);
const form = await fetch(`${base}/inquiries`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `name=Form+Fan&email=form.${run}%40example.com&message=hi` });
check("plain form post redirects back to the site", form.status === 303 && form.headers.get("location") === "https://otg.golf/events?sent=1");

await sleep(27000); // membership messages are held back 20s, then sent

const rows = await q("select dedupe_key, audience, channel, to_addr, status, last_error, body from outbox where dedupe_key like $1 order by id", [`%${run}%`]);
const inqId = (await q("select id from inquiries where email=$1", [`eve.${run}@example.com`]))[0].id;
const all = [...rows, ...(await q("select dedupe_key, audience, channel, to_addr, status, last_error, body from outbox where dedupe_key like $1 order by id", [`%${inqId}%`]))];
const by = (k) => all.filter((r) => r.dedupe_key.startsWith(k));

check("membership: one welcome email + one sms queued (replay ignored)", by(`member-welcome:${sub}:`).length === 2, String(by(`member-welcome:${sub}`).length));
check("membership: customer messages HELD while CUSTOMER_MESSAGES is off", by(`member-welcome:${sub}:`).every((r) => r.status === "held"), by(`member-welcome:${sub}`).map((r) => r.status).join(","));
check("membership: annual plan named in the welcome", by(`member-welcome:${sub}:email`)[0]?.body.includes("Full Membership (annual)"));
check("membership: owner email alert sent", by(`member-new:${sub}:email:chase@otg.golf`)[0]?.status === "sent");
check("membership: owner sms queued to OWNER_ALERT_PHONE (skipped: twilio off in test)", by(`member-new:${sub}:sms:owner`)[0]?.to_addr === "+15405550100" && by(`member-new:${sub}:sms:owner`)[0]?.status === "skipped");
check("old subscription queued nothing", by(`member-welcome:${sub}_old`).length === 0 && by(`member-new:${sub}_old`).length === 0);
check("purchase: confirmation email held, no customer sms", by(`purchase:${cs}:`).length === 1 && by(`purchase:${cs}:email`)[0].status === "held");
check("purchase: owner alert sent", by(`purchase-new:${cs}:email:chase@otg.golf`)[0]?.status === "sent");
check("inquiry: owner alert to chase@ and events@", by(`inquiry:${inqId}:email:`).filter((r) => r.status === "sent").map((r) => r.to_addr).sort().join() === "chase@otg.golf,events@otg.golf");
check("inquiry: auto-reply to the customer held", by(`inquiry-reply:${inqId}:email`)[0]?.status === "held" && by(`inquiry-reply:${inqId}:email`)[0]?.to_addr === `eve.${run}@example.com`);
const ownerMail = sentEmails.find((e) => e.subject.startsWith("Event inquiry: Eve Planner"));
check("inquiry: alert replies go to the customer and carry a handled link", ownerMail?.reply_to === `eve.${run}@example.com` && /\/inquiries\/[0-9a-f-]+\/done\?t=[0-9a-f]{32}/.test(ownerMail?.text ?? ""));
check("no email went to any customer", sentEmails.every((e) => ["chase@otg.golf", "events@otg.golf"].includes(e.to[0])), [...new Set(sentEmails.map((e) => e.to[0]))].join(","));

// 6. Handled link: GET shows a button and changes nothing; POST marks it handled; a bad token is refused.
const link = ownerMail.text.match(/http\S+\/done\?t=[0-9a-f]{32}/)[0].replace(/^https?:\/\/[^/]+/, base);
const g = await fetch(link);
check("handled link: GET does not change status", g.status === 200 && (await q("select status from inquiries where id=$1", [inqId]))[0].status === "new");
check("handled link: bad token refused", (await fetch(link.slice(0, -4) + "0000", { method: "POST" })).status === 403);
await fetch(link, { method: "POST" });
check("handled link: POST marks handled", (await q("select status from inquiries where id=$1", [inqId]))[0].status === "handled");

// 7. Keyed reads.
check("outbox list requires the key", (await fetch(`${base}/outbox`)).status === 401);
const ob = await (await fetch(`${base}/outbox?status=held`, { headers: { "X-OTG-Key": "k" } })).json();
check("outbox list shows held customer messages", ob.customer_messages_live === false && ob.messages.length >= 3);

fake.close(); await pool.end();
console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
process.exit(fails ? 1 : 0);
