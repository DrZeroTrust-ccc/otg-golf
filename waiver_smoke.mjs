// Waiver smoke test. Start the server first, the same way as for booking_smoke.mjs:
//   DATABASE_URL=... STRIPE_SECRET_KEY=sk_test_fake STRIPE_WEBHOOK_SECRET=whsec_testsecret \
//   STRIPE_API_BASE=http://localhost:3997 BOOKING_TEST_CODES=on OTG_READ_KEY=k \
//   RESEND_API_KEY=re_test RESEND_API_URL=http://localhost:3996/emails PORT=3999 node dist/server.js
// then: DATABASE_URL=... node waiver_smoke.mjs
import http from "node:http";
import crypto from "node:crypto";
import pg from "pg";
import * as R from "./dist/booking_rules.js";
import { WAIVER_VERSION, WAIVER_TEXT } from "./dist/waiver.js";

const base = "http://localhost:3999";
if (!/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL ?? "")) { console.error("waiver_smoke.mjs runs against a local database only"); process.exit(2); }
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
await pool.query("delete from bookings");
const q = async (sql, a = []) => (await pool.query(sql, a)).rows;
let fails = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name} ${extra}`); if (!ok) fails++; };
const run = Date.now().toString(36);

// Fake Stripe and email, enough for a non-member checkout.
const stripeCalls = [];
http.createServer((req, res) => {
  let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => {
    stripeCalls.push({ path: req.url, method: req.method });
    res.setHeader("content-type", "application/json");
    if (req.url === "/v1/customers") return res.end(JSON.stringify({ id: `cus_wv_${run}_${stripeCalls.length}`, object: "customer" }));
    if (req.url === "/v1/checkout/sessions") { const id = `cs_wv_${run}_${stripeCalls.length}`; return res.end(JSON.stringify({ id, object: "checkout.session", url: `https://checkout.example/${id}` })); }
    res.statusCode = 404; res.end("{}");
  });
}).listen(3997);
http.createServer((req, res) => { req.resume(); req.on("end", () => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ id: "em_1" })); }); }).listen(3996);

function client() {
  let cookie = "";
  const call = async (method, path, body, headers = {}) => {
    const r = await fetch(base + path, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  return { get: (p, h) => call("GET", p, undefined, h), post: (p, b, h) => call("POST", p, b ?? {}, h), put: (p, b, h) => call("PUT", p, b, h) };
}
async function signedIn(name) {
  const cl = client();
  const phone = `+1555${String(Date.now()).slice(-7)}`;
  const st = await cl.post("/api/auth/start", { phone });
  await cl.post("/api/auth/verify", { phone, code: st.body.test_code, name });
  const id = (await q("select id from players where phone = $1", [phone]))[0].id;
  return { cl, id, phone };
}
const staffH = { "X-OTG-Key": "k" };
const staff = client();
const today = R.todayEt();
// A Mon-Thu day 2 to 5 days out, so 11am is plain Off-peak and inside the non-member window.
const day = (() => { for (let i = 2; i <= 5; i++) { const d = R.addDays(today, i); const w = new Date(d + "T12:00:00Z").getUTCDay(); if (w >= 1 && w <= 4) return d; } return R.addDays(today, 2); })();

// ---- waivers off (the default): nothing changes for players ----
await staff.put("/api/staff/settings", { overrides: { first_day: today } }, staffH);
const a = await signedIn("Wendy Waiverless");
const me0 = (await a.cl.get("/api/me")).body;
check("waivers off by default", me0.waiver && me0.waiver.required === false && me0.waiver.signed === false, JSON.stringify(me0.waiver));
const bk0 = await a.cl.post("/api/bookings", { bay_id: "bay2", date: day, start: "11:00", minutes: 60 });
check("with waivers off, booking goes to checkout unsigned", bk0.status === 200 && !!bk0.body.checkout_url, JSON.stringify(bk0.body));

// ---- waivers on ----
await staff.put("/api/staff/settings", { overrides: { first_day: today, waivers_on: true } }, staffH);
const b = await signedIn("Sam Signer");
const me1 = (await b.cl.get("/api/me")).body;
check("waivers on: me says required, not signed", me1.waiver.required === true && me1.waiver.signed === false);
const calls = stripeCalls.length;
const blocked = await b.cl.post("/api/bookings", { bay_id: "bay3", date: day, start: "11:00", minutes: 60 });
check("booking refused until signed", blocked.status === 403 && blocked.body.waiver_needed === true, JSON.stringify(blocked.body));
check("no Stripe call for a refused booking", stripeCalls.length === calls);

const w = (await b.cl.get("/api/waiver")).body;
check("waiver text and version served", w.version === WAIVER_VERSION && w.text === WAIVER_TEXT && w.required === true && w.signed === false);
check("signed-out player can read it too", (await client().get("/api/waiver")).status === 200);
check("signed-out player can't sign", (await client().post("/api/waiver", { name: "Nobody Here", agree: true, version: WAIVER_VERSION })).status === 401);
check("must tick agree", (await b.cl.post("/api/waiver", { name: "Sam Signer", agree: false, version: WAIVER_VERSION })).status === 400);
check("must type a name", (await b.cl.post("/api/waiver", { name: " S ", agree: true, version: WAIVER_VERSION })).status === 400);
const stale = await b.cl.post("/api/waiver", { name: "Sam Signer", agree: true, version: "old-version" });
check("an old version is refused", stale.status === 409 && stale.body.version === WAIVER_VERSION);
const sign = await b.cl.post("/api/waiver", { name: "Sam  Signer", agree: true, version: WAIVER_VERSION });
check("signing works", sign.status === 200 && !!sign.body.signed_at, JSON.stringify(sign.body));
check("signing twice is harmless", (await b.cl.post("/api/waiver", { name: "Sam Signer", agree: true, version: WAIVER_VERSION })).body.already === true);
const rows = await q("select * from waivers where player_id = $1", [b.id]);
const sha = crypto.createHash("sha256").update(WAIVER_TEXT).digest("hex");
check("one signature kept, with the wording's hash and the typed name", rows.length === 1 && rows[0].text_sha256 === sha && rows[0].signed_name === "Sam Signer" && rows[0].version === WAIVER_VERSION);
check("waiver.signed event logged", (await q("select 1 from events where kind = 'waiver.signed' and payload->>'player_id' = $1", [b.id])).length === 1);
const upd = await pool.query("update waivers set signed_name = 'x' where player_id = $1", [b.id]).then(() => "changed", (e) => e.message);
check("signatures can't be changed", /append-only/.test(upd), upd);
const del = await pool.query("delete from waivers where player_id = $1", [b.id]).then(() => "deleted", (e) => e.message);
check("signatures can't be deleted", /append-only/.test(del), del);

check("me now says signed", (await b.cl.get("/api/me")).body.waiver.signed === true);
const bk1 = await b.cl.post("/api/bookings", { bay_id: "bay3", date: day, start: "11:00", minutes: 60 });
check("signed player can book", bk1.status === 200 && !!bk1.body.checkout_url, JSON.stringify(bk1.body));

// ---- staff screen ----
const sb = await staff.post("/api/staff/book", { bay_id: "bay4", date: day, start: "13:00", minutes: 60, name: "Walk In", phone: `+1555${String(Date.now() + 7).slice(-7)}` }, staffH);
check("staff can still book someone who hasn't signed", sb.status === 200, JSON.stringify(sb.body));
const sd = (await staff.get(`/api/staff/day?date=${day}`, staffH)).body;
const find = (id) => sd.bookings.find((x) => x.id === id);
check("staff day says waivers are on", sd.waivers_on === true);
check("signed player shows as signed", find(bk1.body.booking_id)?.waiver_signed === true);
check("walk-in shows as not signed", find(sb.body.booking_id)?.waiver_signed === false);
check("earlier unsigned booking shows as not signed", find(bk0.body.booking_id)?.waiver_signed === false);

const staffPage = await (await fetch(base + "/staff")).text();
const bookPage = await (await fetch(base + "/book")).text();
check("pages carry the waiver UI", /NO WAIVER/.test(staffPage) && /id="waiver"/.test(bookPage));

await pool.query("update booking_settings set config = '{}' where id = 1");
await pool.end();
console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
