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
// Local test database only: it clears the bookings table so each run starts from an empty schedule.
if (!/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL ?? "")) { console.error("booking_smoke.mjs runs against a local database only"); process.exit(2); }
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
await pool.query("delete from bookings");
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
const g1 = R.guestSplit(S, "full", 3, 5);
check("Full member with 1 pass left brings 3 guests: 1 pass + $20", g1.passes === 1 && g1.feeCents === 2000, JSON.stringify(g1));
check("Founding guests are free", R.guestSplit(S, "founding", 5, 99).feeCents === 0);
check("non-member groups pay no guest fee", R.guestSplit(S, "none", 5, 0).feeCents === 0);
const nowT = new Date();
const daysAgo = (n) => new Date(nowT.getTime() - n * 86400_000);
check("3 misses in 60 days pause Prime", R.primePausedUntil(S, [daysAgo(1), daysAgo(10), daysAgo(20)], nowT) !== null);
check("2 misses don't", R.primePausedUntil(S, [daysAgo(1), daysAgo(10)], nowT) === null);
check("distance: 0.001 deg latitude is about 111 m", Math.abs(R.metersBetween({ lat: 38.7, lng: -77.6 }, { lat: 38.701, lng: -77.6 }) - 111) < 2);
check("misses older than 60 days don't count", R.primePausedUntil(S, [daysAgo(1), daysAgo(10), daysAgo(70)], nowT) === null);

// ---- fake Stripe ------------------------------------------------------------------
const stripeCalls = [];
http.createServer((req, res) => {
  let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => {
    const body = Object.fromEntries(new URLSearchParams(b));
    stripeCalls.push({ path: req.url, method: req.method, body });
    res.setHeader("content-type", "application/json");
    if (req.url === "/v1/customers") return res.end(JSON.stringify({ id: `cus_bk_${run}_${stripeCalls.length}`, object: "customer" }));
    if (req.url === "/v1/checkout/sessions") { const id = `cs_bk_${run}_${stripeCalls.length}`; return res.end(JSON.stringify({ id, object: "checkout.session", url: `https://checkout.example/${id}` })); }
    if (req.url.endsWith("/expire")) return res.end(JSON.stringify({ id: req.url.split("/")[4], object: "checkout.session", status: "expired" }));
    if (req.url === "/v1/invoiceitems") return res.end(JSON.stringify({ id: `ii_${run}_${stripeCalls.length}`, object: "invoiceitem", amount: Number(body.amount) }));
    if (req.url.startsWith("/v1/invoiceitems/") && req.method === "DELETE") return res.end(JSON.stringify({ id: req.url.split("/")[3], object: "invoiceitem", deleted: true }));
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

// ---- part 2: guest passes, check-in, no-shows, strikes, early access ----
async function memberClient(tier, extra = {}) {
  const em = `${tier}.${Math.random().toString(36).slice(2, 8)}.${run}@example.com`;
  const id = (await q("insert into players (name, email, stripe_customer_id) values ($1, $2, $3) returning id", [`${tier} member`, em, extra.cus ?? null]))[0].id;
  await pool.query("insert into memberships (player_id, stripe_subscription_id, tier, status) values ($1, $2, $3, 'active')", [id, `sub_${tier}_${Math.random().toString(36).slice(2)}`, tier]);
  const cl = client();
  const c0 = await cl.post("/api/auth/start", { email: em });
  await cl.post("/api/auth/verify", { email: em, code: c0.body.test_code });
  return { cl, id };
}
const fullM = await memberClient("full");
const gA = await fullM.cl.post("/api/bookings", { bay_id: "bay4", date: day, start: "16:00", minutes: 60, guests: 4 });
check("Full member: 4 guests use 4 of 6 passes, free", gA.status === 200 && gA.body.confirmed, JSON.stringify(gA.body));
const gB = await fullM.cl.post("/api/bookings", { bay_id: "bay4", date: day, start: "17:00", minutes: 60, guests: 5 });
const gBrow = (await q("select guest_passes_used, guest_fee_cents, price_cents, status from bookings where id = $1", [gB.body.booking_id]))[0];
check("...then 5 more guests: 2 passes + 3 x $10, paid at checkout", gB.status === 200 && !!gB.body.checkout_url && gBrow.guest_passes_used === 2 && gBrow.guest_fee_cents === 3000 && gBrow.price_cents === 3000, JSON.stringify(gBrow));
check("passes left shows 0", (await fullM.cl.get("/api/me")).body.guest_passes_left === 0);
const fdM = await memberClient("founding");
const gC = await fdM.cl.post("/api/bookings", { bay_id: "bay3", date: day, start: "17:00", minutes: 60, guests: 5 });
check("Founding member: 5 guests free", gC.status === 200 && gC.body.confirmed);

// check-in by QR
const code = (await q("select checkin_code from booking_settings where id = 1"))[0].checkin_code;
check("a desk code exists (fallback)", typeof code === "string" && code.length >= 8);
const ciM = await memberClient("full");
const ciB = (await q(`insert into bookings (bay_id, player_id, starts_at, ends_at, status, plan)
  values ('putt', $1, now() + interval '10 minutes', now() + interval '70 minutes', 'confirmed', 'full') returning id`, [ciM.id]))[0].id;
check("wrong desk code refused", (await ciM.cl.post("/api/checkin", { code: "nope" })).status === 400);
const OTG = { lat: 38.7455, lng: -77.6738 };
const noVenue = await ciM.cl.post("/api/checkin", { ...OTG, accuracy: 20 });
check("location check-in refused until the venue is set", noVenue.status === 400 && /isn't set up/.test(noVenue.body.error), noVenue.body.error);
check("staff can't set the venue without the key", (await client().post("/api/staff/venue", OTG)).status === 401);
const sv = await staff.post("/api/staff/venue", OTG, staffH);
check("staff set the venue from their phone", sv.status === 200 && sv.body.venue.lat === OTG.lat && sv.body.venue.radius_m === 200);
const farAway = await ciM.cl.post("/api/checkin", { lat: 38.80, lng: -77.60, accuracy: 30 });
check("\"I'm here\" from 10 km away is refused", farAway.status === 400 && /not at On The Green/.test(farAway.body.error), farAway.body.error);
const ci = await ciM.cl.post("/api/checkin", { lat: OTG.lat + 0.0008, lng: OTG.lng, accuracy: 40 });
check("\"I'm here\" from inside the building (about 90 m off) works 10 minutes early", ci.status === 200 && (await q("select checked_in_by from bookings where id = $1", [ciB]))[0].checked_in_by === "location", JSON.stringify(ci.body));
const again = await ciM.cl.post("/api/checkin", { ...OTG, accuracy: 10 });
check("tapping again says already checked in", again.status === 200 && again.body.already === true);
const cfgNow = (await staff.get("/api/staff/settings", staffH)).body.overrides;
check("venue survives in the editable rules", cfgNow.venue?.lat === OTG.lat);

// no-show fixtures (the minute tick runs during the wait below)
await staff.put("/api/staff/settings", { overrides: { ...cfgNow, no_show_fees_on: true } }, staffH);
const nsM = await memberClient("full", { cus: `cus_ns_${run}` });
const nsB = (await q(`insert into bookings (bay_id, player_id, starts_at, ends_at, status, plan)
  values ('bay4', $1, now() - interval '20 minutes', now() + interval '40 minutes', 'confirmed', 'full') returning id`, [nsM.id]))[0].id;
const nsGuest = (await q(`insert into bookings (bay_id, player_id, starts_at, ends_at, status, plan)
  values ('bay3', $1, now() - interval '20 minutes', now() + interval '40 minutes', 'confirmed', 'none') returning id`, [pid]))[0].id;

// strikes
const stM = await memberClient("full");
for (const d of [2, 5, 9]) await pool.query(`insert into bookings (bay_id, player_id, starts_at, ends_at, status, plan, no_show_at)
  values ('putt', $1, now() - ($2 || ' days')::interval, now() - ($2 || ' days')::interval + interval '1 hour', 'no_show', 'full', now() - ($2 || ' days')::interval)`, [stM.id, String(d)]);
const stPrime = await stM.cl.post("/api/bookings", { bay_id: "bay2", date: day, start: "20:00", minutes: 60 });
check("3 misses: Prime booking paused", stPrime.status === 400 && /paused/.test(stPrime.body.error), stPrime.body.error);
const plainDay = (() => { for (let i = 1; i <= 7; i++) { const d = R.addDays(today, i); const w = new Date(d + "T12:00:00Z").getUTCDay(); if (w >= 1 && w <= 4 && d !== day) return d; } })();
const stOk = await stM.cl.post("/api/bookings", { bay_id: "bay2", date: plainDay, start: "11:00", minutes: 60 });
check("...but Off-peak still books", stOk.status === 200, JSON.stringify(stOk.body));

// early access (the test day is 3 days out, so the deadline the day before hasn't passed)
const openMin = R.hoursFor(R.mergeSettings({}), day)[0];
const earlyStart = R.fmtHm(openMin - 60);
const ea = await fdM.cl.post("/api/bookings", { bay_id: "bay2", date: day, start: earlyStart, minutes: 60 });
check("member asks for an early start", ea.status === 200 && ea.body.requested === true, JSON.stringify(ea.body));
check("owner gets an early-start alert", (await q("select 1 from outbox where dedupe_key like $1", [`booking-early-owner:${ea.body.booking_id}:%`])).length >= 1);
const eaView = (await fullM.cl.get(`/api/availability?date=${day}`)).body.bays;
check("other members see early slots, and this one as taken", eaView.find((b) => b.id === "bay3").slots.find((x) => x.t === earlyStart)?.state === "early" && eaView.find((b) => b.id === "bay2").slots.find((x) => x.t === earlyStart)?.state === "taken");
const eaGuest = await guest.post("/api/bookings", { bay_id: "bay3", date: day, start: earlyStart, minutes: 120 });
check("non-members can't ask for early starts", eaGuest.status === 400, eaGuest.body.error);
const ap = await staff.post(`/api/staff/bookings/${ea.body.booking_id}/early`, { approve: true }, staffH);
check("staff approve it", ap.status === 200 && (await q("select status from bookings where id = $1", [ea.body.booking_id]))[0].status === "confirmed");

// late cancel by a member counts as a strike
const lcM = await memberClient("full");
const lcB = (await q(`insert into bookings (bay_id, player_id, starts_at, ends_at, status, plan)
  values ('putt', $1, now() + interval '5 hours', now() + interval '6 hours', 'confirmed', 'full') returning id`, [lcM.id]))[0].id;
const lc = await lcM.cl.post(`/api/bookings/${lcB}/cancel`);
check("member cancelling 5 hours ahead is a late cancel", lc.status === 200 && lc.body.late_cancel === true);

// ---- reminders ----
const soon = (await q(`insert into bookings (bay_id, player_id, starts_at, ends_at, status, created_at)
  values ('putt', $1, now() + interval '2 hours', now() + interval '3 hours', 'confirmed', now() - interval '1 day') returning id`, [pid]))[0].id;
await new Promise((r) => setTimeout(r, 65_000));
check("reminder queued about 3 hours before", (await q("select 1 from outbox where dedupe_key = $1", [`booking-reminder:${soon}:sms`])).length === 1);
const ns = (await q("select status, no_show_fee_cents, no_show_invoice_item from bookings where id = $1", [nsB]))[0];
check("no check-in after 15 minutes: released as a no-show with a $20 fee", ns.status === "no_show" && ns.no_show_fee_cents === 2000 && !!ns.no_show_invoice_item, JSON.stringify(ns));
check("the fee went on their Stripe bill", stripeCalls.some((c) => c.path === "/v1/invoiceitems" && c.body.customer === `cus_ns_${run}` && c.body.amount === "2000"));
check("no-show message queued", (await q("select 1 from outbox where dedupe_key like $1", [`booking-noshow:${nsB}:%`])).length === 2);
const nsg = (await q("select status, no_show_fee_cents from bookings where id = $1", [nsGuest]))[0];
check("non-member no-show: released, no fee (they prepaid)", nsg.status === "no_show" && nsg.no_show_fee_cents === 0);
check("released bay is open again", (await other.get(`/api/availability?date=${today}`)).status === 200);
const late = await nsM.cl.post("/api/checkin", { ...OTG, accuracy: 25 });
const nsAfter = (await q("select status, no_show_waived, no_show_fee_cents, checked_in_at from bookings where id = $1", [nsB]))[0];
check("they turn up and scan: booking restored, fee dropped", late.status === 200 && nsAfter.status === "confirmed" && nsAfter.no_show_waived && nsAfter.no_show_fee_cents === 0 && nsAfter.checked_in_at, JSON.stringify(nsAfter));
check("fee removed from Stripe", stripeCalls.some((c) => c.method === "DELETE" && c.path.startsWith("/v1/invoiceitems/")));
check("checked-in booking was not marked no-show", (await q("select status from bookings where id = $1", [ciB]))[0].status === "confirmed");

await pool.query("update booking_settings set config = '{}' where id = 1");
await pool.end();
console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
