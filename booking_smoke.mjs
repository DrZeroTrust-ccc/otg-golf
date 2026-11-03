// Bay booking smoke test. Start the server first:
//   DATABASE_URL=... STRIPE_SECRET_KEY=sk_test_fake STRIPE_WEBHOOK_SECRET=whsec_testsecret \
//   STRIPE_API_BASE=http://localhost:3997 BOOKING_TEST_CODES=on OTG_READ_KEY=k \
//   RESEND_API_KEY=re_test RESEND_API_URL=http://localhost:3996/emails PORT=3999 node dist/server.js
// then: DATABASE_URL=... node booking_smoke.mjs
import http from "node:http";
import Stripe from "stripe";
import pg from "pg";
import * as R from "./dist/booking_rules.js";

const base = "http://localhost:3999";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = async (sql, a = []) => (await pool.query(sql, a)).rows;
let fails = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name} ${extra}`); if (!ok) fails++; };
const run = Date.now().toString(36);

// ---- pure rules -----------------------------------------------------------------
const S = R.mergeSettings({});
check("Mon 3pm is Off-peak", R.bandAt(S, "2026-11-09", 15 * 60) === "offpeak");
check("Mon 4pm is Standard", R.bandAt(S, "2026-11-09", 16 * 60) === "standard");
check("Sat 2pm is Standard", R.bandAt(S, "2026-11-14", 14 * 60) === "standard");
check("Fri 7pm is Prime", R.bandAt(S, "2026-11-13", 19 * 60) === "prime");
check("a holiday is Prime all day", R.bandAt(R.mergeSettings({ holidays: ["2026-11-10"] }), "2026-11-10", 11 * 60) === "prime");
check("non-member 1h Fri 7pm on Bay 2 = $75", R.priceFor(S, { kind: "sim", premier: false }, "none", "2026-11-13", 19 * 60, 60) === 7500);
check("non-member 1h Mon 11am on Premier = $50 + $15", R.priceFor(S, { kind: "sim", premier: true }, "none", "2026-11-09", 11 * 60, 60) === 6500);
check("Full member pays nothing", R.priceFor(S, { kind: "sim", premier: true }, "full", "2026-11-13", 19 * 60, 120) === 0);
check("Weekday member free Tue 2pm", R.priceFor(S, { kind: "sim", premier: false }, "weekday", "2026-11-10", 14 * 60, 60) === 0);
check("Weekday member pays from 6pm Tue (Standard)", R.priceFor(S, { kind: "sim", premier: false }, "weekday", "2026-11-10", 17 * 60 + 30, 60) === 3000);
check("Eastern time: 6pm in summer is 22:00Z", R.etToUtc("2026-07-10", 18 * 60).toISOString() === "2026-07-10T22:00:00.000Z");
check("Eastern time: 6pm in winter is 23:00Z", R.etToUtc("2026-12-10", 18 * 60).toISOString() === "2026-12-10T23:00:00.000Z");
check("partial settings keep the other rates", R.mergeSettings({ rates_cents: { prime: 8000 } }).rates_cents.offpeak === 5000);

// ---- fake Stripe ------------------------------------------------------------------
const stripeCalls = [];
http.createServer((req, res) => {
  let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => {
    const body = Object.fromEntries(new URLSearchParams(b));
    stripeCalls.push({ path: req.url, body });
    res.setHeader("content-type", "application/json");
    if (req.url === "/v1/customers") return res.end(JSON.stringify({ id: `cus_bk_${run}_${stripeCalls.length}`, object: "customer" }));
    if (req.url === "/v1/checkout/sessions") { const id = `cs_bk_${run}_${stripeCalls.length}`; return res.end(JSON.stringify({ id, object: "checkout.session", url: `https://checkout.example/${id}` })); }
    if (req.url.endsWith("/expire")) return res.end(JSON.stringify({ id: req.url.split("/")[4], object: "checkout.session", status: "expired" }));
    if (req.url === "/v1/refunds") return res.end(JSON.stringify({ id: `re_${stripeCalls.length}`, object: "refund", amount: Number(body.amount) }));
    res.statusCode = 404; res.end("{}");
  });
}).listen(3997);
http.createServer((req, res) => { req.resume(); req.on("end", () => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ id: "em_1" })); }); }).listen(3996);

const stripe = new Stripe("sk_test_fake");
async function webhook(type, object) {
  const payload = JSON.stringify({ id: `evt_bk_${run}_${Math.random().toString(36).slice(2)}`, object: "event", type, data: { object }, created: Math.floor(Date.now() / 1000) });
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret: "whsec_testsecret" });
  return (await fetch(`${base}/webhooks/stripe`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": header }, body: payload })).status;
}

function client() {
  let cookie = "";
  const call = async (method, path, body, headers = {}) => {
    const r = await fetch(base + path, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  return { get: (p, h) => call("GET", p, undefined, h), post: (p, b, h) => call("POST", p, b ?? {}, h), put: (p, b, h) => call("PUT", p, b, h) };
}
const staffH = { "X-OTG-Key": "k" };
const staff = client();

// ---- setup: open booking from today, and make the test day a holiday (Prime all day) ----
const today = R.todayEt();
const day = R.addDays(today, 3);
check("staff API refuses without the key", (await staff.get("/api/staff/day")).status === 401);
const anon = client();
check("booking page is served", (await fetch(base + "/book")).headers.get("content-type")?.includes("text/html"));
await staff.put("/api/staff/settings", { overrides: {} }, staffH);
check("closed until a first day is set", (await anon.get("/api/me")).body.open === false);
const bad = await staff.put("/api/staff/settings", { overrides: { hours: { mon: ["22:00", "10:00"] } } }, staffH);
check("settings reject backwards hours", bad.status === 400, bad.body.error);
await staff.put("/api/staff/settings", { overrides: { first_day: today, holidays: [day] } }, staffH);
const me0 = await anon.get("/api/me");
check("open once first_day is set, non-member sees 6 days", me0.body.open === true && me0.body.days.length === 6, JSON.stringify(me0.body.days));

// ---- sign in ----
const guest = client();
const phone = `+1555${String(Date.now()).slice(-7)}`;
const st = await guest.post("/api/auth/start", { phone });
check("code requested", st.status === 200 && /^\d{6}$/.test(st.body.test_code), JSON.stringify(st.body));
const wrong = await guest.post("/api/auth/verify", { phone, code: st.body.test_code === "000000" ? "111111" : "000000" });
check("wrong code refused", wrong.status === 400);
const ok = await guest.post("/api/auth/verify", { phone, code: st.body.test_code, name: "Gina Guest", sms_ok: true });
check("right code signs in", ok.status === 200);
const reuse = await client().post("/api/auth/verify", { phone, code: st.body.test_code });
check("a code works only once", reuse.status === 400);
const gme = await guest.get("/api/me");
check("guest is signed in as non-member", gme.body.signed_in && gme.body.plan === "none" && gme.body.name === "Gina Guest");

// ---- non-member books and pays ----
const avail = await guest.get(`/api/availability?date=${day}`);
const bay2 = avail.body.bays.find((b) => b.id === "bay2");
const premier = avail.body.bays.find((b) => b.id === "bay1");
check("holiday 6pm shows the Prime price for half an hour", bay2.slots.find((s) => s.t === "18:00")?.price === 3750);
check("Premier Bay shows members-only to a non-member", premier.slots.find((s) => s.t === "18:00")?.state === "members");
const prem = await guest.post("/api/bookings", { bay_id: "bay1", date: day, start: "18:00", minutes: 60 });
check("non-member can't book the Premier Bay at Prime", prem.status === 400, prem.body.error);
const short = await guest.post("/api/bookings", { bay_id: "bay2", date: day, start: "18:00", minutes: 30 });
check("sim bays need at least an hour", short.status === 400, short.body.error);
const far = await guest.post("/api/bookings", { bay_id: "bay2", date: R.addDays(today, 8), start: "18:00", minutes: 60 });
check("non-member can't book 8 days out", far.status === 400, far.body.error);
const bk = await guest.post("/api/bookings", { bay_id: "bay2", date: day, start: "18:00", minutes: 60, guests: 3 });
check("non-member gets sent to checkout", bk.status === 200 && bk.body.checkout_url?.startsWith("https://checkout.example/"), JSON.stringify(bk.body));
const cs = stripeCalls.find((c) => c.path === "/v1/checkout/sessions");
check("checkout charges $75", cs?.body["line_items[0][price_data][unit_amount]"] === "7500");

const other = client();
const ost = await other.post("/api/auth/start", { email: `other.${run}@example.com` });
await other.post("/api/auth/verify", { email: `other.${run}@example.com`, code: ost.body.test_code });
const clash = await other.post("/api/bookings", { bay_id: "bay2", date: day, start: "18:30", minutes: 60 });
check("an unpaid hold still blocks the slot", clash.status === 409, clash.body.error);

const sessId = (await q("select stripe_checkout_id from bookings where id = $1", [bk.body.booking_id]))[0].stripe_checkout_id;
const wh = await webhook("checkout.session.completed", { id: sessId, object: "checkout.session", mode: "payment", amount_total: 7500, payment_intent: `pi_${run}`, metadata: { product: "bay_booking", booking_id: bk.body.booking_id }, customer: null, customer_details: null });
const row = (await q("select * from bookings where id = $1", [bk.body.booking_id]))[0];
check("payment webhook confirms the booking", wh === 200 && row.status === "confirmed" && row.paid_cents === 7500 && row.stripe_payment_intent === `pi_${run}`);
check("purchase recorded", (await q("select 1 from purchases where stripe_checkout_session_id = $1", [sessId])).length === 1);
check("confirmation queued", (await q("select 1 from outbox where dedupe_key like $1", [`booking:${bk.body.booking_id}:%`])).length === 2);
const wh2 = await webhook("checkout.session.completed", { id: sessId, object: "checkout.session", mode: "payment", amount_total: 7500, payment_intent: `pi_${run}`, metadata: { booking_id: bk.body.booking_id } });
check("replayed webhook changes nothing", wh2 === 200 && (await q("select count(*)::int n from outbox where dedupe_key like $1", [`booking:${bk.body.booking_id}:%`]))[0].n === 2);
check("guest sees the booking", (await guest.get("/api/me")).body.bookings.some((b) => b.id === bk.body.booking_id));

// ---- limits, abandoned checkout ----
const b2 = await guest.post("/api/bookings", { bay_id: "bay3", date: day, start: "12:00", minutes: 60 });
check("second booking allowed", b2.status === 200);
const b3 = await guest.post("/api/bookings", { bay_id: "bay4", date: day, start: "12:00", minutes: 60 });
check("non-member holds at most 2 upcoming", b3.status === 400, b3.body.error);
const rel = await guest.post(`/api/bookings/${b2.body.booking_id}/release`);
check("coming back from checkout without paying frees the slot", rel.status === 200 && (await q("select status from bookings where id = $1", [b2.body.booking_id]))[0].status === "expired");
const b4 = await guest.post("/api/bookings", { bay_id: "bay4", date: day, start: "13:00", minutes: 60 });
await pool.query("update bookings set hold_until = now() - interval '1 minute' where id = $1", [b4.body.booking_id]);
await new Promise((r) => setTimeout(r, 200));
check("an expired hold no longer blocks", (await other.get(`/api/availability?date=${day}`)).body.bays.find((b) => b.id === "bay4").slots.find((s) => s.t === "13:00").state === "open");

// ---- member ----
const memEmail = `member.${run}@example.com`;
const pid = (await q("insert into players (name, email) values ('Mia Member', $1) returning id", [memEmail]))[0].id;
await pool.query("insert into memberships (player_id, stripe_subscription_id, tier, status) values ($1, $2, 'full', 'active')", [pid, `sub_bk_${run}`]);
const mem = client();
const mst = await mem.post("/api/auth/start", { email: memEmail });
await mem.post("/api/auth/verify", { email: memEmail, code: mst.body.test_code });
const mme = await mem.get("/api/me");
check("member recognized by email sign-in", mme.body.plan === "full" && mme.body.days.length === 15, `${mme.body.plan} ${mme.body.days?.length}`);
const mb = await mem.post("/api/bookings", { bay_id: "bay1", date: day, start: "19:00", minutes: 120 });
check("Full member books the Premier Bay at Prime, free", mb.status === 200 && mb.body.confirmed === true, JSON.stringify(mb.body));
const mlong = await mem.post("/api/bookings", { bay_id: "bay3", date: day, start: "19:00", minutes: 180 });
check("Full member max 2 hours", mlong.status === 400, mlong.body.error);

// ---- cancel + refund ----
const cx = await guest.post(`/api/bookings/${bk.body.booking_id}/cancel`);
const refundCall = stripeCalls.find((c) => c.path === "/v1/refunds");
check("cancel 3 days ahead refunds in full", cx.status === 200 && cx.body.refunded_cents === 7500 && refundCall?.body.payment_intent === `pi_${run}`, JSON.stringify(cx.body));
check("someone else can't cancel your booking", (await other.post(`/api/bookings/${mb.body.booking_id}/cancel`)).status === 404);

// ---- staff ----
const blk = await staff.post("/api/staff/block", { bay_id: "all", date: day, start: "10:00", minutes: 120, note: `League ${run}` }, staffH);
check("staff block across all bays", blk.status === 200);
const blocked = await mem.post("/api/bookings", { bay_id: "bay2", date: day, start: "10:30", minutes: 60 });
check("blocked time can't be booked", blocked.status === 409);
const blk2 = await staff.post("/api/staff/block", { bay_id: "bay1", date: day, start: "19:00", minutes: 60 }, staffH);
check("staff block refuses to sit on a booking", blk2.status === 409, blk2.body.error);
const walk = await staff.post("/api/staff/book", { bay_id: "bay3", date: day, start: "15:00", minutes: 60, name: "Walk In", phone: "(540) 555-0199" }, staffH);
check("staff phone booking", walk.status === 200);
const dv = await staff.get(`/api/staff/day?date=${day}`, staffH);
const w = dv.body.bookings?.find((b) => b.id === walk.body.booking_id);
check("staff day view shows it, priced and marked pay at desk", w && w.price_cents === 7500 && /Pay at desk/.test(w.note) && w.start === "15:00", JSON.stringify(w));

// ---- reminders ----
const soon = (await q(`insert into bookings (bay_id, player_id, starts_at, ends_at, status, created_at)
  values ('putt', $1, now() + interval '2 hours', now() + interval '3 hours', 'confirmed', now() - interval '1 day') returning id`, [pid]))[0].id;
await new Promise((r) => setTimeout(r, 65_000));
check("reminder queued about 3 hours before", (await q("select 1 from outbox where dedupe_key = $1", [`booking-reminder:${soon}:sms`])).length === 1);

await pool.query("update booking_settings set config = '{}' where id = 1");
await pool.end();
console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
