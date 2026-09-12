// Partner program smoke test: seeding, code lookup, Stripe offer creation (fake Stripe), attribution via
// each webhook path, and per-partner counts. Runs against DATABASE_URL.
import pg from "pg";
import { seedPartners, ensureStripeOffers, findPartner, applyPartner, partnerCounts, priceForPlan, couponForPlan, OFFERS } from "./dist/partners.js";
import { onSubscription, onCheckoutCompleted } from "./dist/stripeHandlers.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const c = await pool.connect();
let fails = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name} ${extra}`); if (!ok) fails++; };

// Fake Stripe with just enough surface, tracking what gets created.
const created = { coupons: [], prices: [], products: [] };
const fake = {
  coupons: { retrieve: async (id) => { if (created.coupons.includes(id)) return { id }; throw new Error("no such coupon"); }, create: async (p) => { created.coupons.push(p.id); return p; } },
  prices: {
    list: async ({ lookup_keys, product }) => {
      if (lookup_keys) return { data: created.prices.filter((p) => lookup_keys.includes(p.lookup_key)) };
      if (product === "prod_VEJV0A0R1kjMB3") return { data: [{ id: "price_full_month", recurring: { interval: "month" } }, ...created.prices.filter((p) => p.product === product)] };
      if (product === "prod_VEJVeqTYUur6X1") return { data: [{ id: "price_weekday_month", recurring: { interval: "month" } }] };
      return { data: [] };
    },
    create: async (p) => { const r = { id: `price_${p.lookup_key}`, ...p }; created.prices.push(r); return r; },
  },
  products: { create: async (p) => { const r = { id: `prod_${p.metadata.otg}`, ...p }; created.products.push(r); return r; } },
};

// Clean prior test state
await c.query("delete from tags where player_id in (select id from players where stripe_customer_id like 'cus_pt_%')");
await c.query("delete from memberships where player_id in (select id from players where stripe_customer_id like 'cus_pt_%')");
await c.query("delete from purchases where player_id in (select id from players where stripe_customer_id like 'cus_pt_%')");
await c.query("delete from players where stripe_customer_id like 'cus_pt_%'");

check("seed partners", (await seedPartners(pool)) === 9);
const p1 = await findPartner(pool, "GC-STONEWALL"); const p2 = await findPartner(pool, "stonewall"); const p3 = await findPartner(pool, " Gc-Stonewall ");
check("code / slug / sloppy code all resolve", p1?.slug === "stonewall" && p2?.slug === "stonewall" && p3?.slug === "stonewall");
check("unknown code rejected", (await findPartner(pool, "GC-NOPE")) === null && (await findPartner(pool, "")) === null);

const log1 = await ensureStripeOffers(fake, pool);
const log2 = await ensureStripeOffers(fake, pool);
check("offers created once", created.coupons.length === 3 && created.prices.length === 2 && created.products.length === 1, JSON.stringify(created.coupons));
check("second run is a no-op", log2.every((l) => l.includes("exists")), log2.join(" | "));
const coachMap = (await c.query("select product, tag from price_map where product = 'coaching_bay_hour'")).rows[0];
check("coaching product mapped in price_map", coachMap?.tag === "partner_pro");

check("plan prices resolve", (await priceForPlan(fake, pool, "full")) === "price_full_month" && (await priceForPlan(fake, pool, "weekday")) === "price_weekday_month" && (await priceForPlan(fake, pool, "full_annual")) === "price_full_annual");
check("coupons by plan", couponForPlan("full", p1) === OFFERS.partnerFullMonthly.coupon && couponForPlan("weekday", p1) === OFFERS.partnerWeekdayMonthly.coupon && couponForPlan("full_annual", p1) === OFFERS.partnerFullAnnual.coupon && couponForPlan("full", null) === null);

// Attribution via subscription webhook (member checkout path)
await onSubscription(c, { id: "sub_pt_1", customer: "cus_pt_1", status: "active", metadata: { product: "full", partner: "stonewall" }, trial_end: null,
  items: { data: [{ price: { id: "price_full_month", product: "prod_VEJV0A0R1kjMB3" }, current_period_end: 1800000000 }] } });
let row = (await c.query("select p.partner_slug, array_agg(t.tag order by t.tag) tags from players p join tags t on t.player_id = p.id where p.stripe_customer_id = 'cus_pt_1' group by p.partner_slug")).rows[0];
check("subscription attributes + tags", row?.partner_slug === "stonewall" && row.tags.includes("partner:stonewall") && row.tags.includes("member"), JSON.stringify(row));

// Attribution via coaching-hour checkout (payment mode)
await onCheckoutCompleted(c, { id: "cs_pt_2", mode: "payment", customer: "cus_pt_2", amount_total: 3000, customer_details: { name: "Pro Mark", phone: "5405550177", email: "mark@example.com" },
  metadata: { product: "coaching_bay_hour", partner: "GC-STONEWALL", hours: "1" } }, null, null);
row = (await c.query("select p.partner_slug, pu.product, array_agg(t.tag order by t.tag) tags from players p join purchases pu on pu.player_id = p.id join tags t on t.player_id = p.id where p.stripe_customer_id = 'cus_pt_2' group by 1,2")).rows[0];
check("coaching purchase attributes + partner_pro tag", row?.partner_slug === "stonewall" && row.product === "coaching_bay_hour" && row.tags.includes("partner_pro"), JSON.stringify(row));

// First partner wins; a second attribution doesn't overwrite
await applyPartner(c, (await c.query("select id from players where stripe_customer_id='cus_pt_1'")).rows[0].id, "evergreen", "test");
row = (await c.query("select partner_slug from players where stripe_customer_id='cus_pt_1'")).rows[0];
check("first partner wins", row.partner_slug === "stonewall");

const counts = await partnerCounts(pool);
const sw = counts.find((r) => r.slug === "stonewall");
check("stonewall counts", Number(sw.players) >= 2 && Number(sw.members) >= 1 && Number(sw.coaching_hours) >= 1, JSON.stringify(sw));

c.release(); await pool.end();
console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
process.exit(fails ? 1 : 0);
