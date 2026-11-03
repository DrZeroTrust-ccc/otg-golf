import express from "express";
import type { Express, Request, Response, NextFunction } from "express";
import Stripe from "stripe";
import type pg from "pg";
import { pool, logEvent } from "./db.js";
import { startSignIn, verifySignIn, signOut, currentPlayerId } from "./auth.js";
import { notifyCustomer, notifyOwner, kickOutbox } from "./notify.js";
import { normalizePhone, normalizeEmail } from "./stripeHandlers.js";
import { openingDay, formatMemberNumber, bookingConfirmed, bookingCancelled, bookingReminder, ownerBookingConflict } from "./templates.js";
import {
  mergeSettings, ruleProblem, priceFor, slotPrice, bandAt, hoursFor, firstDay, lastDay, todayEt, etToUtc, etParts,
  isDate, hm, fmtHm, addDays, describeSlot, type Settings, type Plan,
} from "./booking_rules.js";
import { bookPage, staffPage, manifest, icon } from "./booking_pages.js";

type Db = pg.Pool | pg.PoolClient;
type Bay = { id: string; name: string; kind: "sim" | "putt"; premier: boolean; sort: number };

const ACTIVE = `(b.status = 'confirmed' or (b.status = 'pending_payment' and b.hold_until > now()))`;
const baseUrl = () => process.env.PUBLIC_BASE_URL ?? "https://otg-ops.onrender.com";
// STRIPE_API_BASE is for the automated test only (points Stripe calls at a local fake). Never set it on Render.
const stripeClient = () => {
  const k = process.env.STRIPE_SECRET_KEY?.trim();
  if (!k) return null;
  const base = process.env.STRIPE_API_BASE ? new URL(process.env.STRIPE_API_BASE) : null;
  return new Stripe(k, base ? { host: base.hostname, port: Number(base.port), protocol: base.protocol.replace(":", "") as "http" | "https" } : {});
};

export async function loadSettings(db: Db = pool): Promise<Settings> {
  const r = await db.query("select config from booking_settings where id = 1");
  return mergeSettings(r.rows[0]?.config ?? {});
}
async function loadBays(db: Db = pool): Promise<Bay[]> {
  return (await db.query("select id, name, kind, premier, sort from bays where active order by sort")).rows;
}

// A player's plan: the best live membership they hold. Founding members are "trialing" until
// opening day, which still counts.
export async function planOf(db: Db, playerId: string | null): Promise<Plan> {
  if (!playerId) return "none";
  const tiers = (await db.query("select tier from memberships where player_id = $1 and status in ('trialing','active')", [playerId])).rows.map((r) => r.tier);
  for (const t of ["founding", "full", "weekday"] as const) if (tiers.includes(t)) return t;
  return "none";
}

const whenOf = (b: { starts_at: Date; ends_at: Date }) => {
  const s = etParts(new Date(b.starts_at));
  return describeSlot(s.date, s.minutes, Math.round((new Date(b.ends_at).getTime() - new Date(b.starts_at).getTime()) / 60000));
};

// ---- availability ----------------------------------------------------------------

async function dayView(date: string, playerId: string | null) {
  const s = await loadSettings();
  const bays = await loadBays();
  const plan = await planOf(pool, playerId);
  const hours = hoursFor(s, date);
  const taken = (await pool.query(
    `select b.id, b.bay_id, b.player_id, b.starts_at, b.ends_at from bookings b
      where ${ACTIVE} and b.starts_at < $2 and b.ends_at > $1`,
    [etToUtc(date, 0), etToUtc(addDays(date, 1), 0)])).rows;
  const now = Date.now();
  const out = bays.map((bay) => {
    const slots: { t: string; state: string; price: number; band: string }[] = [];
    if (hours) for (let m = hours[0]; m < hours[1]; m += s.slot_minutes) {
      const at = etToUtc(date, m).getTime();
      const hit = taken.find((t) => t.bay_id === bay.id && new Date(t.starts_at).getTime() <= at && new Date(t.ends_at).getTime() > at);
      let state = "open";
      if (hit) state = playerId && hit.player_id === playerId ? "mine" : "taken";
      else if (at <= now) state = "past";
      else if (bay.premier && plan === "none" && (bandAt(s, date, m) === "prime" || at - now > s.premier_nonmember_within_hours * 3600_000)) state = "members";
      slots.push({ t: fmtHm(m), state, price: slotPrice(s, bay, plan, date, m), band: bandAt(s, date, m) });
    }
    return { id: bay.id, name: bay.name, kind: bay.kind, premier: bay.premier, slots };
  });
  return { settings: s, plan, hours, bays: out };
}

async function myBookings(playerId: string) {
  return (await pool.query(
    `select b.id, b.starts_at, b.ends_at, b.status, b.price_cents, b.paid_cents, b.guests, bay.name as bay
       from bookings b join bays bay on bay.id = b.bay_id
      where b.player_id = $1 and b.kind = 'booking' and b.ends_at > now() and ${ACTIVE}
      order by b.starts_at`, [playerId])).rows.map((b) => ({ ...b, when: whenOf(b) }));
}

// ---- creating a booking ------------------------------------------------------------

type NewBooking = { bayId: string; date: string; start: number; minutes: number; guests: number; note?: string | null };

// Inside a transaction, under a per-bay lock: is the bay free for this time?
async function lockAndCheckFree(c: pg.PoolClient, bayId: string, from: Date, to: Date, exceptId: string | null = null): Promise<boolean> {
  await c.query("select pg_advisory_xact_lock(hashtext('bay:' || $1))", [bayId]);
  const r = await c.query(
    `select 1 from bookings b where b.bay_id = $1 and ${ACTIVE} and b.starts_at < $3 and b.ends_at > $2 and ($4::uuid is null or b.id <> $4) limit 1`,
    [bayId, from, to, exceptId]);
  return !r.rowCount;
}

async function ensureStripeCustomer(stripe: Stripe, playerId: string): Promise<string> {
  const p = (await pool.query("select stripe_customer_id, name, email, phone from players where id = $1", [playerId])).rows[0];
  if (p.stripe_customer_id) return p.stripe_customer_id;
  const cust = await stripe.customers.create({
    ...(p.name ? { name: p.name } : {}), ...(p.email ? { email: p.email } : {}), ...(p.phone ? { phone: p.phone } : {}),
    metadata: { player_id: playerId },
  });
  // The customer.created webhook may already have attached it; never steal an id another player holds.
  await pool.query(
    `update players set stripe_customer_id = $2 where id = $1 and stripe_customer_id is null
       and not exists (select 1 from players where stripe_customer_id = $2)`, [playerId, cust.id]);
  return cust.id;
}

async function createAppBooking(playerId: string, nb: NewBooking): Promise<{ status: number; body: Record<string, unknown> }> {
  const s = await loadSettings();
  const bay = (await loadBays()).find((b) => b.id === nb.bayId);
  if (!bay) return { status: 400, body: { error: "Pick a bay." } };
  const plan = await planOf(pool, playerId);
  const problem = ruleProblem(s, plan, { bay, date: nb.date, start: nb.start, minutes: nb.minutes, guests: nb.guests }, openingDay());
  if (problem) return { status: 400, body: { error: problem } };
  const price = priceFor(s, bay, plan, nb.date, nb.start, nb.minutes);
  const from = etToUtc(nb.date, nb.start), to = etToUtc(nb.date, nb.start + nb.minutes);
  const stripe = price ? stripeClient() : null;
  if (price && !stripe) return { status: 503, body: { error: "Online payment isn't available right now. Call us to book." } };

  const c = await pool.connect();
  let id: string;
  try {
    await c.query("begin");
    const upcoming = (await c.query(
      `select count(*)::int n from bookings b where b.player_id = $1 and b.kind = 'booking' and b.ends_at > now() and ${ACTIVE}`, [playerId])).rows[0].n;
    if (upcoming >= s.plans[plan].max_upcoming) {
      await c.query("rollback");
      return { status: 400, body: { error: `You can hold ${s.plans[plan].max_upcoming} upcoming bookings at a time.` } };
    }
    if (!(await lockAndCheckFree(c, bay.id, from, to))) {
      await c.query("rollback");
      return { status: 409, body: { error: "Someone just took that time. Pick another." } };
    }
    id = (await c.query(
      `insert into bookings (bay_id, player_id, starts_at, ends_at, status, plan, guests, price_cents, hold_until)
       values ($1,$2,$3,$4,$5,$6,$7,$8, case when $5 = 'pending_payment' then now() + interval '32 minutes' end) returning id`,
      [bay.id, playerId, from, to, price ? "pending_payment" : "confirmed", plan, nb.guests, price])).rows[0].id;
    await logEvent(c, "booking.created", { booking_id: id, player_id: playerId, bay: bay.id, starts_at: from, minutes: nb.minutes, plan, price_cents: price });
    if (!price) await notifyCustomer(c, `booking:${id}`, playerId, bookingConfirmed({ bay: bay.name, when: describeSlot(nb.date, nb.start, nb.minutes), priceCents: 0, guests: nb.guests }));
    await c.query("commit");
  } catch (e) {
    await c.query("rollback").catch(() => {});
    throw e;
  } finally { c.release(); }

  if (!price) { kickOutbox(); return { status: 200, body: { ok: true, booking_id: id, confirmed: true } }; }

  try {
    const customer = await ensureStripeCustomer(stripe!, playerId);
    const meta = { product: "bay_booking", booking_id: id };
    const session = await stripe!.checkout.sessions.create({
      mode: "payment",
      customer,
      line_items: [{ quantity: 1, price_data: { currency: "usd", unit_amount: price, product_data: { name: `${bay.name}, ${describeSlot(nb.date, nb.start, nb.minutes)}` } } }],
      metadata: meta,
      payment_intent_data: { metadata: meta },
      expires_at: Math.floor(Date.now() / 1000) + 31 * 60,
      success_url: `${baseUrl()}/book?paid=${id}`,
      cancel_url: `${baseUrl()}/book?release=${id}`,
    });
    await pool.query("update bookings set stripe_checkout_id = $2 where id = $1", [id, session.id]);
    return { status: 200, body: { ok: true, booking_id: id, checkout_url: session.url } };
  } catch (e) {
    await pool.query("update bookings set status = 'expired', hold_until = null where id = $1", [id]);
    await logEvent(pool, "booking.checkout_failed", { booking_id: id, error: (e as Error).message });
    return { status: 502, body: { error: "We couldn't start the payment. Try again in a minute." } };
  }
}

// ---- Stripe webhook handlers (called from server.ts inside its transaction) ---------

export async function onBookingCheckoutCompleted(c: pg.PoolClient, sess: Stripe.Checkout.Session) {
  const id = sess.metadata?.booking_id;
  const b = (await c.query(
    `select b.*, bay.name as bay_name from bookings b join bays bay on bay.id = b.bay_id where b.id = $1 for update of b`, [id])).rows[0];
  if (!b) { await logEvent(c, "booking.paid_unknown", { checkout: sess.id, booking_id: id ?? null }); return; }
  if (b.status === "confirmed" || b.status === "paid_conflict") return; // replayed event
  const pi = typeof sess.payment_intent === "string" ? sess.payment_intent : sess.payment_intent?.id ?? null;
  const amount = sess.amount_total ?? b.price_cents;
  const free = await lockAndCheckFree(c, b.bay_id, b.starts_at, b.ends_at, b.id);
  const status = free ? "confirmed" : "paid_conflict";
  await c.query(
    `update bookings set status = $2, stripe_payment_intent = $3, paid_cents = $4, hold_until = null, stripe_checkout_id = coalesce(stripe_checkout_id, $5) where id = $1`,
    [b.id, status, pi, amount, sess.id]);
  await c.query(
    `insert into purchases (player_id, stripe_checkout_session_id, product, amount_cents, metadata)
     values ($1,$2,'bay_booking',$3,$4) on conflict (stripe_checkout_session_id) do nothing`,
    [b.player_id, sess.id, amount, { booking_id: b.id, bay: b.bay_id }]);
  await logEvent(c, `booking.${status}`, { booking_id: b.id, player_id: b.player_id, checkout: sess.id, amount_cents: amount });
  const when = whenOf(b);
  if (free) await notifyCustomer(c, `booking:${b.id}`, b.player_id, bookingConfirmed({ bay: b.bay_name, when, priceCents: amount, guests: b.guests }));
  else await notifyOwner(c, `booking-conflict:${b.id}`, ownerBookingConflict({ bay: b.bay_name, when, checkout: sess.id }), { playerId: b.player_id });
}

export async function onBookingCheckoutExpired(c: pg.PoolClient, sess: Stripe.Checkout.Session) {
  const id = sess.metadata?.booking_id;
  if (!id) return;
  const r = await c.query("update bookings set status = 'expired', hold_until = null where id = $1 and status = 'pending_payment' returning id", [id]);
  if (r.rowCount) await logEvent(c, "booking.expired", { booking_id: id, checkout: sess.id });
}

// ---- cancelling ------------------------------------------------------------------

async function cancelBooking(id: string, by: { playerId?: string; staff?: boolean; refund?: boolean }): Promise<{ status: number; body: Record<string, unknown> }> {
  const s = await loadSettings();
  const b = (await pool.query(
    `select b.*, bay.name as bay_name from bookings b join bays bay on bay.id = b.bay_id where b.id = $1`, [id])).rows[0];
  if (!b || (by.playerId && b.player_id !== by.playerId)) return { status: 404, body: { error: "Booking not found." } };
  if (!["confirmed", "pending_payment", "paid_conflict"].includes(b.status)) return { status: 400, body: { error: "That booking is already cancelled." } };
  if (!by.staff && new Date(b.starts_at).getTime() <= Date.now()) return { status: 400, body: { error: "That booking has already started. Talk to the front desk." } };

  const refundable = b.paid_cents - b.refunded_cents;
  const hoursAhead = (new Date(b.starts_at).getTime() - Date.now()) / 3600_000;
  const refund = refundable > 0 && (by.staff ? by.refund !== false : hoursAhead >= s.refund_cutoff_hours) ? refundable : 0;
  if (refund) {
    const stripe = stripeClient();
    if (!stripe || !b.stripe_payment_intent) return { status: 502, body: { error: "We couldn't refund this automatically. Call us and we'll sort it." } };
    try {
      await stripe.refunds.create({ payment_intent: b.stripe_payment_intent, amount: refund, metadata: { booking_id: b.id } }, { idempotencyKey: `booking-refund-${b.id}-${refund}` });
    } catch (e) {
      await logEvent(pool, "booking.refund_failed", { booking_id: b.id, error: (e as Error).message });
      return { status: 502, body: { error: "The refund didn't go through, so the booking is still on. Call us and we'll sort it." } };
    }
  }
  if (b.status === "pending_payment" && b.stripe_checkout_id) {
    await stripeClient()?.checkout.sessions.expire(b.stripe_checkout_id).catch(() => {});
  }
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query(
      `update bookings set status = 'cancelled', hold_until = null, cancelled_at = now(), cancelled_by = $2, refunded_cents = refunded_cents + $3 where id = $1`,
      [b.id, by.staff ? "staff" : "player", refund]);
    await logEvent(c, "booking.cancelled", { booking_id: b.id, by: by.staff ? "staff" : "player", refund_cents: refund });
    if (b.status === "confirmed" && b.player_id && b.kind === "booking") {
      await notifyCustomer(c, `booking-cancel:${b.id}`, b.player_id, bookingCancelled({ bay: b.bay_name, when: whenOf(b), refundCents: refund, byStaff: !!by.staff }));
    }
    await c.query("commit");
  } catch (e) { await c.query("rollback").catch(() => {}); throw e; } finally { c.release(); }
  kickOutbox();
  return { status: 200, body: { ok: true, refunded_cents: refund } };
}

// ---- once a minute ---------------------------------------------------------------

export async function bookingTick() {
  await pool.query(`update bookings set status = 'expired', hold_until = null where status = 'pending_payment' and hold_until <= now()`);
  const s = await loadSettings();
  const due = (await pool.query(
    `update bookings b set reminded_at = now() from bays bay
      where bay.id = b.bay_id and b.kind = 'booking' and b.status = 'confirmed' and b.reminded_at is null and b.player_id is not null
        and b.starts_at > now() and b.starts_at <= now() + ($1 || ' hours')::interval
      returning b.id, b.player_id, b.starts_at, b.ends_at, b.created_at, bay.name as bay_name`, [String(s.reminder_hours)])).rows;
  for (const b of due) {
    // Someone who booked within the reminder window just got a confirmation; don't text them twice.
    if (new Date(b.starts_at).getTime() - new Date(b.created_at).getTime() < s.reminder_hours * 3600_000) continue;
    await notifyCustomer(pool, `booking-reminder:${b.id}`, b.player_id, bookingReminder({ bay: b.bay_name, when: whenOf(b) }), { smsOnly: true });
  }
}

// ---- routes ----------------------------------------------------------------------

function staffOnly(req: Request, res: Response, next: NextFunction) {
  const key = (process.env.OTG_STAFF_KEY ?? process.env.OTG_READ_KEY)?.trim();
  if (!key) return res.status(500).json({ error: "staff key not configured" });
  if (req.header("X-OTG-Key") !== key) return res.status(401).json({ error: "Wrong staff key." });
  next();
}

const parseNew = (src: Record<string, unknown>): NewBooking | null => {
  const date = src.date, start = src.start;
  if (!isDate(date) || typeof start !== "string" || !/^\d{1,2}:\d{2}$/.test(start)) return null;
  const minutes = Number(src.minutes), guests = Number(src.guests ?? 0);
  if (!Number.isInteger(minutes) || minutes <= 0 || minutes > 12 * 60) return null;
  return { bayId: String(src.bay_id ?? ""), date, start: hm(start), minutes, guests: Number.isInteger(guests) ? guests : -1, note: typeof src.note === "string" ? src.note.slice(0, 300) : null };
};

const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response) => {
  fn(req, res).catch((e) => {
    console.error(`${req.method} ${req.path} failed:`, (e as Error).message);
    if (!res.headersSent) res.status(500).json({ error: "Something went wrong. Try again." });
  });
};

export function mountBookings(app: Express) {
  const json = express.json({ limit: "64kb" });
  const html = (body: string) => (_req: Request, res: Response) => { res.set("Cache-Control", "no-cache"); res.type("html").send(body); };
  app.get("/book", html(bookPage));
  app.get("/staff", html(staffPage));
  app.get("/book/manifest.webmanifest", (_req, res) => { res.type("application/manifest+json").send(manifest); });
  app.get("/book/icon.svg", (_req, res) => { res.set("Cache-Control", "public, max-age=86400"); res.type("image/svg+xml").send(icon); });

  app.post("/api/auth/start", json, wrap(startSignIn));
  app.post("/api/auth/verify", json, wrap(verifySignIn));
  app.post("/api/auth/signout", wrap(signOut));

  app.get("/api/me", wrap(async (req, res) => {
    const pid = await currentPlayerId(req);
    const s = await loadSettings();
    const first = firstDay(s, openingDay());
    const plan = await planOf(pool, pid);
    const today = todayEt();
    const from = first && first > today ? first : today;
    const to = lastDay(s, plan);
    const days: string[] = [];
    if (first) for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
    if (!pid) return res.json({ signed_in: false, plan, open: !!first, days });
    const p = (await pool.query("select name, phone, email, member_number from players where id = $1", [pid])).rows[0];
    res.json({ signed_in: true, plan, open: !!first, days, name: p?.name ?? null, member_number: formatMemberNumber(p?.member_number), bookings: await myBookings(pid), refund_cutoff_hours: s.refund_cutoff_hours });
  }));

  app.get("/api/availability", wrap(async (req, res) => {
    const date = req.query.date;
    if (!isDate(date)) return res.status(400).json({ error: "Pick a date." });
    const pid = await currentPlayerId(req);
    const v = await dayView(date, pid);
    const s = v.settings;
    res.json({
      date, plan: v.plan, hours: v.hours && { open: fmtHm(v.hours[0]), close: fmtHm(v.hours[1]) }, slot_minutes: s.slot_minutes,
      min_minutes: { sim: s.min_minutes_sim, putt: s.min_minutes_putt }, max_minutes: s.plans[v.plan].max_minutes, max_guests: s.max_guests,
      bays: v.bays,
    });
  }));

  app.post("/api/bookings", json, wrap(async (req, res) => {
    const pid = await currentPlayerId(req);
    if (!pid) return res.status(401).json({ error: "Sign in first." });
    const nb = parseNew(req.body ?? {});
    if (!nb) return res.status(400).json({ error: "Pick a bay, a start time and how long." });
    const r = await createAppBooking(pid, nb);
    res.status(r.status).json(r.body);
  }));

  app.post("/api/bookings/:id/cancel", wrap(async (req, res) => {
    const pid = await currentPlayerId(req);
    if (!pid) return res.status(401).json({ error: "Sign in first." });
    const r = await cancelBooking(req.params.id, { playerId: pid });
    res.status(r.status).json(r.body);
  }));

  // Back from Stripe without paying: let the slot go straight away instead of after the hold.
  app.post("/api/bookings/:id/release", wrap(async (req, res) => {
    const pid = await currentPlayerId(req);
    if (!pid) return res.status(401).json({ error: "Sign in first." });
    const b = (await pool.query("select stripe_checkout_id from bookings where id = $1 and player_id = $2 and status = 'pending_payment'", [req.params.id, pid])).rows[0];
    if (b) {
      await stripeClient()?.checkout.sessions.expire(b.stripe_checkout_id).catch(() => {});
      await pool.query("update bookings set status = 'expired', hold_until = null where id = $1 and status = 'pending_payment'", [req.params.id]);
    }
    res.json({ ok: true });
  }));

  // ---- staff ----
  app.get("/api/staff/day", staffOnly, wrap(async (req, res) => {
    const date = isDate(req.query.date) ? req.query.date : todayEt();
    const s = await loadSettings();
    const rows = (await pool.query(
      `select b.id, b.kind, b.bay_id, b.starts_at, b.ends_at, b.status, b.source, b.plan, b.guests, b.price_cents, b.paid_cents, b.refunded_cents, b.note,
              p.name, p.phone, p.email, p.member_number
         from bookings b left join players p on p.id = b.player_id
        where b.starts_at < $2 and b.ends_at > $1 and b.status in ('confirmed','pending_payment','paid_conflict','cancelled')
        order by b.starts_at`, [etToUtc(date, 0), etToUtc(addDays(date, 1), 0)])).rows;
    res.json({
      date, hours: hoursFor(s, date)?.map(fmtHm) ?? null, bays: await loadBays(),
      bookings: rows.map((r) => ({ ...r, start: fmtHm(etParts(new Date(r.starts_at)).minutes), end: fmtHm(etParts(new Date(r.ends_at)).minutes), member_number: formatMemberNumber(r.member_number) })),
    });
  }));

  // Block a bay (league, lesson, event, maintenance). bay_id "all" blocks every bay.
  app.post("/api/staff/block", staffOnly, json, wrap(async (req, res) => {
    const nb = parseNew(req.body ?? {});
    if (!nb) return res.status(400).json({ error: "Pick a date, start time and length." });
    const bays = (await loadBays()).filter((b) => nb.bayId === "all" || b.id === nb.bayId);
    if (!bays.length) return res.status(400).json({ error: "Pick a bay." });
    const from = etToUtc(nb.date, nb.start), to = etToUtc(nb.date, nb.start + nb.minutes);
    const c = await pool.connect();
    try {
      await c.query("begin");
      const busy: string[] = [];
      for (const bay of bays) if (!(await lockAndCheckFree(c, bay.id, from, to))) busy.push(bay.name);
      if (busy.length) { await c.query("rollback"); return res.status(409).json({ error: `Already booked in that time: ${busy.join(", ")}. Cancel or move those first.` }); }
      for (const bay of bays) {
        await c.query(`insert into bookings (kind, bay_id, starts_at, ends_at, status, source, note) values ('block',$1,$2,$3,'confirmed','staff',$4)`, [bay.id, from, to, nb.note || "Blocked"]);
      }
      await logEvent(c, "booking.blocked", { bays: bays.map((b) => b.id), starts_at: from, ends_at: to, note: nb.note });
      await c.query("commit");
    } catch (e) { await c.query("rollback").catch(() => {}); throw e; } finally { c.release(); }
    res.json({ ok: true });
  }));

  // Phone or walk-in booking. Staff skip the plan rules (hours, windows, limits) but never double-book.
  app.post("/api/staff/book", staffOnly, json, wrap(async (req, res) => {
    const src = (req.body ?? {}) as Record<string, unknown>;
    const nb = parseNew(src);
    if (!nb) return res.status(400).json({ error: "Pick a bay, date, start time and length." });
    const bay = (await loadBays()).find((b) => b.id === nb.bayId);
    if (!bay) return res.status(400).json({ error: "Pick a bay." });
    const phone = normalizePhone(typeof src.phone === "string" ? src.phone : null);
    const email = normalizeEmail(typeof src.email === "string" ? src.email : null);
    const name = typeof src.name === "string" ? src.name.trim().slice(0, 120) : "";
    if (!phone && !name) return res.status(400).json({ error: "Add a name or mobile number." });
    const s = await loadSettings();
    const from = etToUtc(nb.date, nb.start), to = etToUtc(nb.date, nb.start + nb.minutes);
    const c = await pool.connect();
    let id: string;
    try {
      await c.query("begin");
      let pid: string | null = phone ? (await c.query("select id from players where phone = $1", [phone])).rows[0]?.id ?? null : null;
      if (!pid && phone) pid = (await c.query("insert into players (phone, name, email) values ($1,$2,$3) returning id", [phone, name || null, email])).rows[0].id;
      const plan = await planOf(c, pid);
      const price = priceFor(s, bay, plan, nb.date, nb.start, nb.minutes);
      if (!(await lockAndCheckFree(c, bay.id, from, to))) { await c.query("rollback"); return res.status(409).json({ error: "That bay is already booked then." }); }
      const note = [name && !pid ? name : null, price ? "Pay at desk" : null, nb.note].filter(Boolean).join(" | ") || null;
      id = (await c.query(
        `insert into bookings (bay_id, player_id, starts_at, ends_at, status, source, plan, guests, price_cents, note)
         values ($1,$2,$3,$4,'confirmed','staff',$5,$6,$7,$8) returning id`,
        [bay.id, pid, from, to, plan, Math.max(0, nb.guests), price, note])).rows[0].id;
      await logEvent(c, "booking.created", { booking_id: id, player_id: pid, bay: bay.id, starts_at: from, minutes: nb.minutes, plan, price_cents: price, source: "staff" });
      if (pid) await notifyCustomer(c, `booking:${id}`, pid, bookingConfirmed({ bay: bay.name, when: describeSlot(nb.date, nb.start, nb.minutes), priceCents: 0, guests: Math.max(0, nb.guests) }));
      await c.query("commit");
    } catch (e) { await c.query("rollback").catch(() => {}); throw e; } finally { c.release(); }
    kickOutbox();
    res.json({ ok: true, booking_id: id });
  }));

  app.post("/api/staff/bookings/:id/cancel", staffOnly, json, wrap(async (req, res) => {
    const r = await cancelBooking(req.params.id, { staff: true, refund: (req.body ?? {}).refund !== false });
    res.status(r.status).json(r.body);
  }));

  app.get("/api/staff/settings", staffOnly, wrap(async (_req, res) => {
    const r = await pool.query("select config, updated_at from booking_settings where id = 1");
    res.json({ overrides: r.rows[0]?.config ?? {}, effective: mergeSettings(r.rows[0]?.config ?? {}), updated_at: r.rows[0]?.updated_at });
  }));
  app.put("/api/staff/settings", staffOnly, json, wrap(async (req, res) => {
    const cfg = (req.body ?? {}).overrides;
    if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) return res.status(400).json({ error: "Settings must be a JSON object." });
    const merged = mergeSettings(cfg);
    // Spot-check the parts that would break the booking page if mistyped.
    for (const [day, h] of Object.entries(merged.hours)) {
      if (!Array.isArray(h) || (h.length && (h.length !== 2 || !h.every((x) => /^\d{2}:\d{2}$/.test(x)) || hm(h[0]) >= hm(h[1]))))
        return res.status(400).json({ error: `Hours for ${day} should look like ["10:00","22:00"], or [] for closed.` });
    }
    if (merged.first_day && !isDate(merged.first_day)) return res.status(400).json({ error: "first_day should look like 2026-12-05, or be blank." });
    await pool.query("update booking_settings set config = $1, updated_at = now() where id = 1", [cfg]);
    await logEvent(pool, "booking.settings_changed", { config: cfg });
    res.json({ ok: true, effective: merged });
  }));
}
