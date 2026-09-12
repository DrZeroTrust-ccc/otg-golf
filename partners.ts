import { readFile } from "node:fs/promises";
import type pg from "pg";
import type Stripe from "stripe";
import { logEvent } from "./db.js";

// ---- Offer definitions (the only place these numbers live) -------------------------
export const OFFERS = {
  // Partner golfers: $50/mo off Full for 3 months ($99 instead of $149); $20/mo off Weekday for 3 months.
  partnerFullMonthly:    { coupon: "PARTNER-FULL-50X3",   amount_off: 5000,  duration: "repeating" as const, months: 3, name: "Partner: $50 off Full x3 months" },
  partnerWeekdayMonthly: { coupon: "PARTNER-WEEKDAY-20X3", amount_off: 2000,  duration: "repeating" as const, months: 3, name: "Partner: $20 off Weekday x3 months" },
  // Annual Full: $1,490/yr for everyone (two months free); partner code takes another $150 off.
  fullAnnual:            { lookup_key: "full_annual", unit_amount: 149000, interval: "year" as const },
  partnerFullAnnual:     { coupon: "PARTNER-ANNUAL-150", amount_off: 15000, duration: "once" as const, months: 0, name: "Partner: $150 off annual Full" },
  // Partner pros: coaching bay hour at a flat $30.
  coachingHour:          { lookup_key: "coaching_bay_hour", unit_amount: 3000, product_name: "Coaching Bay Hour (Partner Pro)", product_key: "coaching_bay_hour" },
};

export type Plan = "full" | "weekday" | "full_annual";

export interface Partner { slug: string; code: string; course: string; contact_name: string | null; contact_email: string | null; pro_name: string | null; active: boolean }

export function normalizeSlug(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase().replace(/^gc-/, "").replace(/[^a-z0-9]/g, "");
  return s.length ? s.slice(0, 40) : null;
}

// Accepts either the slug ('stonewall') or the printed code ('GC-STONEWALL').
export async function findPartner(db: pg.Pool | pg.PoolClient, raw: unknown): Promise<Partner | null> {
  const slug = normalizeSlug(raw);
  if (!slug) return null;
  const q = await db.query("select * from partners where active and (slug = $1 or lower(replace(code,'-','')) = $2)", [slug, `gc${slug}`]);
  return q.rows[0] ?? null;
}

// Record that a player came in through a partner. Idempotent; first partner wins.
export async function applyPartner(c: pg.PoolClient, playerId: string, slugRaw: unknown, via: string): Promise<void> {
  const p = await findPartner(c, slugRaw);
  if (!p) return;
  const r = await c.query("update players set partner_slug = $2 where id = $1 and partner_slug is null returning id", [playerId, p.slug]);
  await c.query("insert into tags (player_id, tag, source) values ($1, $2, 'stripe') on conflict do nothing", [playerId, `partner:${p.slug}`]);
  if (r.rowCount) await logEvent(c, "partner.attributed", { player_id: playerId, partner: p.slug, via });
}

export async function partnerCounts(db: pg.Pool | pg.PoolClient) {
  const q = await db.query(`
  select p.slug, p.code, p.course, p.pro_name,
  count(distinct pl.id) as players,
  count(distinct m.id) filter (where m.status in ('trialing','active','past_due')) as members,
  count(distinct pu.id) filter (where pu.product = 'coaching_bay_hour') as coaching_hours
  from partners p
  left join players pl on pl.partner_slug = p.slug
  left join memberships m on m.player_id = pl.id
  left join purchases pu on pu.player_id = pl.id
  where p.active
  group by p.slug, p.code, p.course, p.pro_name order by p.course`);
  return q.rows;
}

// Loads partners.csv. Safe to re-run: upserts by slug.
export async function seedPartners(db: pg.Pool): Promise<number> {
  const text = await readFile("partners.csv", "utf8").catch(() => "");
  if (!text) return 0;
  const [header, ...rows] = text.trim().split(/\r?\n/);
  if (header.trim() !== "slug,code,course,contact_name,contact_email,pro_name") throw new Error("partners.csv header mismatch");
  let n = 0;
  for (const line of rows) {
    if (!line.trim()) continue;
    const [slug, code, course, contact_name, contact_email, pro_name] = line.split(",").map((s) => s.trim());
    await db.query(
      `insert into partners (slug, code, course, contact_name, contact_email, pro_name)
      values ($1,$2,$3,nullif($4,''),nullif($5,''),nullif($6,''))
      on conflict (slug) do update set code = excluded.code, course = excluded.course,
      contact_name = excluded.contact_name, contact_email = excluded.contact_email, pro_name = excluded.pro_name`,
      [slug, code, course, contact_name, contact_email, pro_name]
      );
    n++;
  }
  return n;
}

// ---- Stripe objects the offers depend on, created once and found by fixed id/lookup_key ----
export async function ensureStripeOffers(stripe: Stripe, db: pg.Pool): Promise<string[]> {
  const log: string[] = [];
  const fullProduct = (await db.query("select stripe_price_id from price_map where tier = 'full' limit 1")).rows[0]?.stripe_price_id as string | undefined;

for (const o of [OFFERS.partnerFullMonthly, OFFERS.partnerWeekdayMonthly, OFFERS.partnerFullAnnual]) {
  const existing = await stripe.coupons.retrieve(o.coupon).catch(() => null);
  if (existing) { log.push(`coupon ${o.coupon}: exists`); continue; }
  await stripe.coupons.create({
    id: o.coupon, name: o.name, currency: "usd", amount_off: o.amount_off, duration: o.duration,
    ...(o.duration === "repeating" ? { duration_in_months: o.months } : {}),
  });
  log.push(`coupon ${o.coupon}: created`);
}

if (fullProduct) {
  const found = await stripe.prices.list({ lookup_keys: [OFFERS.fullAnnual.lookup_key], limit: 1 });
  if (found.data.length) log.push("price full_annual: exists");
  else {
    await stripe.prices.create({ product: fullProduct, currency: "usd", unit_amount: OFFERS.fullAnnual.unit_amount, recurring: { interval: "year" }, lookup_key: OFFERS.fullAnnual.lookup_key, nickname: "Full membership, annual" });
    log.push("price full_annual: created");
  }
} else log.push("price full_annual: skipped (no 'full' product in price_map)");

const coach = await stripe.prices.list({ lookup_keys: [OFFERS.coachingHour.lookup_key], limit: 1, expand: ["data.product"] });
  let coachProductId: string;
  if (coach.data.length) {
    const prod = coach.data[0].product;
    coachProductId = typeof prod === "string" ? prod : prod.id;
    log.push("price coaching_bay_hour: exists");
  } else {
    const prod = await stripe.products.create({ name: OFFERS.coachingHour.product_name, metadata: { otg: OFFERS.coachingHour.product_key } });
    await stripe.prices.create({ product: prod.id, currency: "usd", unit_amount: OFFERS.coachingHour.unit_amount, lookup_key: OFFERS.coachingHour.lookup_key, nickname: "Coaching bay hour (partner pro)" });
    coachProductId = prod.id;
    log.push("price coaching_bay_hour: created");
  }
  await db.query(
    `insert into price_map (stripe_price_id, product, tag) values ($1, 'coaching_bay_hour', 'partner_pro')
    on conflict (stripe_price_id) do update set product = excluded.product, tag = excluded.tag`,
    [coachProductId]
    );
  return log;
}

// Resolve the Stripe price for a plan. Monthly plans use the product's recurring monthly price.
export async function priceForPlan(stripe: Stripe, db: pg.Pool, plan: Plan): Promise<string | null> {
  if (plan === "full_annual") {
    const r = await stripe.prices.list({ lookup_keys: [OFFERS.fullAnnual.lookup_key], limit: 1 });
    return r.data[0]?.id ?? null;
  }
  const productId = (await db.query("select stripe_price_id from price_map where tier = $1 limit 1", [plan])).rows[0]?.stripe_price_id as string | undefined;
  if (!productId) return null;
  const prices = await stripe.prices.list({ product: productId, active: true, limit: 20 });
  return prices.data.find((p) => p.recurring?.interval === "month")?.id ?? null;
}

export function couponForPlan(plan: Plan, partner: Partner | null): string | null {
  if (!partner) return null;
  if (plan === "full") return OFFERS.partnerFullMonthly.coupon;
  if (plan === "weekday") return OFFERS.partnerWeekdayMonthly.coupon;
  return OFFERS.partnerFullAnnual.coupon;
}
