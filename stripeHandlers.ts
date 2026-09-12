import type Stripe from "stripe";
import type pg from "pg";
import { logEvent } from "./db.js";
import { applyPartner } from "./partners.js";

// ---- helpers -------------------------------------------------------------

export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (raw.trim().startsWith("+") && digits.length > 6) return `+${digits}`;
  return null;
}

export function normalizeEmail(raw: string | null | undefined): string | null {
  const e = raw?.trim().toLowerCase();
  return e && e.includes("@") ? e : null;
}

async function addTag(c: pg.PoolClient, playerId: string, tag: string, source = "stripe") {
  const r = await c.query(
    `insert into tags (player_id, tag, source) values ($1, $2, $3)
     on conflict do nothing returning tag`,
    [playerId, tag, source]
  );
  if (r.rowCount) await logEvent(c, "tag.added", { player_id: playerId, tag, source });
}

// Find-or-create a player. Matching order: stripe customer id, then phone, then email.
export async function upsertPlayer(
  c: pg.PoolClient,
  p: { stripe_customer_id?: string | null; name?: string | null; phone?: string | null; email?: string | null }
): Promise<string> {
  const phone = normalizePhone(p.phone);
  const email = normalizeEmail(p.email);
  const name = p.name?.trim() || null;
  const cid = p.stripe_customer_id || null;

  let row = cid ? (await c.query("select id from players where stripe_customer_id = $1", [cid])).rows[0] : undefined;
  if (!row && phone) row = (await c.query("select id from players where phone = $1", [phone])).rows[0];
  if (!row && email) row = (await c.query("select id from players where email = $1 order by created_at limit 1", [email])).rows[0];

  if (row) {
    // Fill blanks only; never overwrite a known value with null.
    const u = await c.query(
      `update players set
         stripe_customer_id = coalesce(stripe_customer_id, $2),
         name  = coalesce(nullif($3,''), name),
         phone = coalesce(phone, $4),
         email = coalesce(email, $5)
       where id = $1
       returning (xmax = 0) as inserted`,
      [row.id, cid, name, phone, email]
    );
    await logEvent(c, "player.updated", { player_id: row.id, stripe_customer_id: cid, phone, email });
    return row.id;
  }
  const ins = await c.query(
    `insert into players (stripe_customer_id, name, phone, email) values ($1,$2,$3,$4) returning id`,
    [cid, name, phone, email]
  );
  await logEvent(c, "player.created", { player_id: ins.rows[0].id, stripe_customer_id: cid, phone, email });
  return ins.rows[0].id;
}

// ---- event handlers ------------------------------------------------------

export async function onCustomer(c: pg.PoolClient, cust: Stripe.Customer) {
  await upsertPlayer(c, { stripe_customer_id: cust.id, name: cust.name, phone: cust.phone, email: cust.email });
}

export async function onSubscription(c: pg.PoolClient, sub: Stripe.Subscription) {
  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
  const playerId = await upsertPlayer(c, { stripe_customer_id: customerId });
  const price = sub.items.data[0]?.price;
  const priceId = price?.id;
  const productId = typeof price?.product === "string" ? price.product : price?.product?.id ?? null;
  const map = priceId ? (await c.query("select tier from price_map where stripe_price_id in ($1, $2)", [priceId, productId])).rows[0] : undefined;
  if (!map?.tier) {
    await logEvent(c, "membership.unmapped_price", { subscription: sub.id, price_id: priceId ?? null });
    return;
  }
  const ts = (n: number | null | undefined) => (n ? new Date(n * 1000) : null);
  // Stripe 2025+ moved current_period_end to the item level; fall back to the sub for older API versions.
  const item = sub.items.data[0] as unknown as { current_period_end?: number };
  const periodEnd = ts(item?.current_period_end ?? (sub as unknown as { current_period_end?: number }).current_period_end);
  await c.query(
    `insert into memberships (player_id, stripe_subscription_id, tier, status, current_period_end, trial_end, updated_at)
     values ($1,$2,$3,$4,$5,$6, now())
     on conflict (stripe_subscription_id) do update
       set player_id = excluded.player_id, tier = excluded.tier, status = excluded.status,
           current_period_end = excluded.current_period_end, trial_end = excluded.trial_end, updated_at = now()`,
    [playerId, sub.id, map.tier, sub.status, periodEnd, ts(sub.trial_end)]
  );
  await logEvent(c, "membership.upserted", { player_id: playerId, subscription: sub.id, tier: map.tier, status: sub.status });
  await addTag(c, playerId, "member");
  if (sub.metadata?.partner) await applyPartner(c, playerId, sub.metadata.partner, "subscription");
  if (map.tier === "founding") await addTag(c, playerId, "founder");
  if (map.tier === "corporate") await addTag(c, playerId, "corporate");
  if (sub.status === "canceled") await logEvent(c, "membership.canceled", { player_id: playerId, subscription: sub.id });
}

export async function onCheckoutCompleted(c: pg.PoolClient, s: Stripe.Checkout.Session, lineItemPriceId: string | null, lineItemProductId: string | null = null) {
  const customerId = typeof s.customer === "string" ? s.customer : s.customer?.id ?? null;
  const d = s.customer_details;
  const playerId = await upsertPlayer(c, {
    stripe_customer_id: customerId,
    name: d?.name ?? null,
    phone: d?.phone ?? null,
    email: d?.email ?? s.customer_email ?? null,
  });

  const meta = (s.metadata ?? {}) as Record<string, string>;
  if (meta.partner) await applyPartner(c, playerId, meta.partner, "checkout");
  let product: string | null = meta.product ?? null;
  let tag: string | null = null;
  if (lineItemPriceId || lineItemProductId) {
    const m = (await c.query("select product, tag, tier from price_map where stripe_price_id in ($1, $2)", [lineItemPriceId, lineItemProductId])).rows[0];
    if (m) { product = product ?? m.product ?? m.tier ?? null; tag = m.tag ?? null; }
  }
  if (product && !tag) {
    // Line items may be unavailable; resolve the tag from the product name instead.
    const m = (await c.query("select tag from price_map where product = $1 or tier = $1 limit 1", [product])).rows[0];
    tag = m?.tag ?? null;
  }
  if (!product) {
    await logEvent(c, "purchase.unmapped", { checkout: s.id, price_id: lineItemPriceId, metadata: meta });
    product = "unknown";
  }
  if (s.mode === "subscription") {
    // Subscription checkouts are recorded via the subscription events; only log here.
    await logEvent(c, "checkout.subscription", { checkout: s.id, player_id: playerId, product });
    return;
  }
  const r = await c.query(
    `insert into purchases (player_id, stripe_checkout_session_id, product, amount_cents, metadata)
     values ($1,$2,$3,$4,$5) on conflict (stripe_checkout_session_id) do nothing returning id`,
    [playerId, s.id, product, s.amount_total ?? 0, meta]
  );
  if (r.rowCount) await logEvent(c, "purchase.created", { player_id: playerId, checkout: s.id, product, amount_cents: s.amount_total ?? 0 });
  if (tag) await addTag(c, playerId, tag);
}

export async function onInvoicePaymentFailed(c: pg.PoolClient, inv: Stripe.Invoice) {
  const subField = (inv as unknown as { subscription?: string | { id: string } | null }).subscription
    ?? (inv as unknown as { parent?: { subscription_details?: { subscription?: string } } }).parent?.subscription_details?.subscription;
  const subId = typeof subField === "string" ? subField : subField?.id;
  if (!subId) return;
  const r = await c.query(
    `update memberships set status = 'past_due', updated_at = now() where stripe_subscription_id = $1 returning player_id`,
    [subId]
  );
  if (r.rowCount) await logEvent(c, "membership.payment_failed", { player_id: r.rows[0].player_id, subscription: subId, invoice: inv.id });
}

// ---- founding seat: card saved now, billed on opening day -----------------

export const FOUNDING_CAP_DEFAULT = 40;

export async function foundingSeatsTaken(c: pg.PoolClient | pg.Pool): Promise<{ taken: number; cap: number }> {
    const r = await c.query(
          `select (select count(*)::int from memberships where tier = 'founding' and status in ('trialing','active','past_due')) as taken,
                      coalesce((select seat_cap from price_map where tier = 'founding' limit 1), $1) as cap`,
          [FOUNDING_CAP_DEFAULT]
        );
    return { taken: r.rows[0].taken, cap: r.rows[0].cap };
}

// Narrow, test-friendly view of the Stripe client (the real Stripe instance satisfies it).
type StripeForSetup = {
    prices: { list: (p: { product: string; active: boolean; limit: number }) => Promise<{ data: { id: string; recurring: unknown }[] }> };
    customers: { update: (id: string, p: { invoice_settings: { default_payment_method: string } }) => Promise<unknown> };
    subscriptions: { create: (p: any) => Promise<{ id: string }> };
};

// Called for checkout.session.completed with mode = "setup". Creates the founding subscription
// ourselves so billing starts on a fixed date (OPENING_DAY) regardless of signup date.
export async function onSetupCompleted(c: pg.PoolClient, s: Stripe.Checkout.Session, stripe: StripeForSetup) {
    const customerId = typeof s.customer === "string" ? s.customer : s.customer?.id ?? null;
    const d = s.customer_details;
    const meta = (s.metadata ?? {}) as Record<string, string>;
    const playerId = await upsertPlayer(c, { stripe_customer_id: customerId, name: d?.name ?? meta.name ?? null, phone: d?.phone ?? meta.phone ?? null, email: d?.email ?? null });
    if (meta.partner) await applyPartner(c, playerId, meta.partner, "founding");
    if (meta.product !== "founding" || !customerId) {
          await logEvent(c, "setup.ignored", { checkout: s.id, player_id: playerId, metadata: meta });
          return;
    }
    const { taken, cap } = await foundingSeatsTaken(c);
    if (taken >= cap) {
          await c.query("insert into tags (player_id, tag, source) values ($1,'waitlist','stripe') on conflict do nothing", [playerId]);
          await logEvent(c, "founding.cap_reached", { checkout: s.id, player_id: playerId, taken, cap });
          return;
    }
    const productId = process.env.FOUNDING_PRODUCT_ID ?? (await c.query("select stripe_price_id from price_map where tier = 'founding' limit 1")).rows[0]?.stripe_price_id;
    if (!productId) throw new Error("founding product id not configured");
    const prices = await stripe.prices.list({ product: productId, active: true, limit: 10 });
    const price = prices.data.find((p) => p.recurring);
    if (!price) throw new Error(`no active recurring price for ${productId}`);

  const si = s.setup_intent as unknown as { payment_method?: string | { id: string } } | string | null;
    const pm = typeof si === "string" ? null : (typeof si?.payment_method === "string" ? si.payment_method : si?.payment_method?.id ?? null);
    if (pm) await stripe.customers.update(customerId, { invoice_settings: { default_payment_method: pm } });

  const opening = Math.floor(new Date(process.env.OPENING_DAY ?? "2026-11-09T14:00:00Z").getTime() / 1000);
    const now = Math.floor(Date.now() / 1000);
    const params: Record<string, unknown> = {
          customer: customerId,
          items: [{ price: price.id }],
          metadata: { product: "founding", checkout: s.id, ...(meta.partner ? { partner: meta.partner } : {}) },
          ...(pm ? { default_payment_method: pm } : {}),
          ...(opening > now + 60 ? { trial_end: opening } : {}),
    };
    const sub = await stripe.subscriptions.create(params);
    await logEvent(c, "founding.subscription_created", { player_id: playerId, subscription: sub.id, bills_on: opening > now ? new Date(opening * 1000).toISOString() : "now", seat: taken + 1, cap });
}
