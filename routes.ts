import express from "express";
import type { Express, Request, Response, NextFunction } from "express";
import Stripe from "stripe";
import { pool } from "./db.js";
import { foundingSeatsTaken } from "./stripeHandlers.js";
import { sendSms, onInboundSms, verifyTwilioSignature, smsConfigured } from "./sms.js";
import { findPartner, partnerCounts, priceForPlan, couponForPlan, OFFERS, type Plan } from "./partners.js";

const SITE_ORIGIN = process.env.SITE_ORIGIN ?? "https://otg.golf";

function requireKey(req: Request, res: Response, next: NextFunction) {
    const key = process.env.OTG_READ_KEY;
    if (!key) return res.status(500).json({ error: "OTG_READ_KEY not configured" });
    if (req.header("X-OTG-Key") !== key) return res.status(401).json({ error: "unauthorized" });
    next();
}

export function mountRoutes(app: Express) {
    // Public, cacheable, CORS-limited to the site. Replaces the hand-edited site constants.
  app.get("/public/counters", async (_req, res) => {
        const q = await pool.query(`
              select
                      (select seat_cap from price_map where tier = 'founding' limit 1) as founding_cap,
                              (select count(*) from memberships where tier = 'founding' and status in ('trialing','active','past_due')) as founding_used,
                                      (select seat_cap from price_map where product = 'winter_league_s1' limit 1) as league_cap,
                                              (select count(*) from purchases where product = 'winter_league_s1') as league_used
                                                  `);
        const r = q.rows[0];
        const remaining = (cap: number | null, used: string) => cap == null ? null : Math.max(0, cap - Number(used));
        res.set("Cache-Control", "public, max-age=60");
        res.set("Access-Control-Allow-Origin", SITE_ORIGIN);
        res.json({
                founding_seats_remaining: remaining(r.founding_cap, r.founding_used),
                league_s1_spots_remaining: remaining(r.league_cap, r.league_used),
                as_of: new Date().toISOString(),
        });
  });

  // Keyed reads for Chase / the founders' update.
  app.get("/people", requireKey, async (req, res) => {
        const tag = typeof req.query.tag === "string" ? req.query.tag : null;
        const q = await pool.query(
                `select p.id, p.name, p.phone, p.email,
                              coalesce(array_agg(distinct t.tag) filter (where t.tag is not null), '{}') as tags,
                                            m.tier, m.status
                                                     from players p
                                                              left join tags t on t.player_id = p.id
                                                                       left join lateral (select tier, status from memberships where player_id = p.id order by updated_at desc limit 1) m on true
                                                                               where $1::text is null or exists (select 1 from tags x where x.player_id = p.id and x.tag = $1)
                                                                                       group by p.id, m.tier, m.status
                                                                                               order by p.created_at`,
                [tag]
              );
        res.json({ count: q.rowCount, people: q.rows });
  });

  app.get("/people/:id", requireKey, async (req, res) => {
        const id = req.params.id;
        const p = await pool.query("select * from players where id = $1", [id]).catch(() => ({ rows: [] }));
        if (!p.rows[0]) return res.status(404).json({ error: "not found" });
        const [m, pu, t, ev] = await Promise.all([
                pool.query("select stripe_subscription_id, tier, status, current_period_end, trial_end from memberships where player_id = $1", [id]),
                pool.query("select product, amount_cents, created_at from purchases where player_id = $1 order by created_at", [id]),
                pool.query("select tag, source, created_at from tags where player_id = $1 order by created_at", [id]),
                pool.query("select at, kind, payload from events where payload->>'player_id' = $1 order by at", [id]),
              ]);
        res.json({ ...p.rows[0], memberships: m.rows, purchases: pu.rows, tags: t.rows, events: ev.rows });
  });

  // Founding seat: Stripe Checkout in setup mode (card saved, nothing charged). The webhook creates
  // the subscription with billing anchored to OPENING_DAY. Cap enforced here and again in the webhook.
  const startFoundingCheckout = async (req: Request, res: Response) => {
          const site = process.env.SITE_URL ?? "https://otg.golf";
          try {
                    const key = process.env.STRIPE_SECRET_KEY;
                    if (!key) return res.status(500).send("stripe not configured");
                    const { taken, cap } = await foundingSeatsTaken(pool);
                    if (taken >= cap) return res.redirect(303, `${site}/?founding=full`);
                    const src = (req.method === "POST" ? req.body : req.query) as Record<string, unknown>;
                    const name = typeof src.name === "string" ? src.name.trim().slice(0, 120) : "";
                    const phone = typeof src.phone === "string" ? src.phone.trim().slice(0, 40) : "";
                    const email = typeof src.email === "string" ? src.email.trim().slice(0, 200) : "";
                    const partner = await findPartner(pool, src.partner);
                    const stripe = new Stripe(key);
                    const opening = new Date(process.env.OPENING_DAY ?? "2026-11-09T14:00:00Z");
                    const openingText = opening.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "America/New_York" });
                    const session = await stripe.checkout.sessions.create({
                                mode: "setup",
                        currency: "usd",
                                customer_creation: "always",
                                ...(email ? { customer_email: email } : {}),
                                metadata: { product: "founding", name, phone, ...(partner ? { partner: partner.slug } : {}) },
                                custom_text: { submit: { message: `Your card is saved today and nothing is charged now. $249/month is billed starting opening day, ${openingText}, and your founding rate is locked for life.` } },
                                success_url: `${site}/founding-confirmed?session_id={CHECKOUT_SESSION_ID}`,
                                cancel_url: `${site}/`,
                    });
                    await pool.query("insert into events (kind, payload) values ($1,$2)", ["founding.checkout_started", { checkout: session.id, taken, cap, partner: partner?.slug ?? null }]);
                    return res.redirect(303, session.url as string);
          } catch (e) {
                    console.error("founding checkout failed:", (e as Error).message);
                    await pool.query("insert into events (kind, payload) values ($1,$2)", ["founding.checkout_failed", { error: (e as Error).message }]).catch(() => {});
                    return res.redirect(303, `${site}/?founding=error`);
          }
  };
      app.get("/checkout/founding", startFoundingCheckout);
      app.post("/checkout/founding", express.urlencoded({ extended: false }), startFoundingCheckout);


  // --- Partner courses -------------------------------------------------------------
  // Landing link printed on cards / in emails: otg.golf-facing, carries the partner into the site.
  app.get("/p/:slug", async (req, res) => {
    const site = process.env.SITE_URL ?? "https://otg.golf";
    const p = await findPartner(pool, req.params.slug);
    if (!p) return res.redirect(302, `${site}/`);
    await pool.query("insert into events (kind, payload) values ($1,$2)", ["partner.visit", { partner: p.slug }]).catch(() => {});
    res.redirect(302, `${site}/?partner=${encodeURIComponent(p.slug)}`);
  });

  // Public counts per partner (for the site and for partner follow-up emails).
  app.get("/public/partners", async (_req, res) => {
    const rows = await partnerCounts(pool);
    res.set("Cache-Control", "public, max-age=60");
    res.set("Access-Control-Allow-Origin", SITE_ORIGIN);
    res.json({ partners: rows.map((r) => ({ slug: r.slug, code: r.code, course: r.course, players: Number(r.players), members: Number(r.members), coaching_hours: Number(r.coaching_hours) })), as_of: new Date().toISOString() });
  });

  // Validate a code as typed on the site: GET /public/partner?code=GC-STONEWALL
  app.get("/public/partner", async (req, res) => {
    const p = await findPartner(pool, req.query.code ?? req.query.partner);
    res.set("Access-Control-Allow-Origin", SITE_ORIGIN);
    if (!p) return res.status(404).json({ ok: false });
    res.json({ ok: true, slug: p.slug, course: p.course, offer: { full_monthly: "$99/mo for your first 3 months, then $149", weekday_monthly: "$79/mo for your first 3 months, then $99", full_annual: "$1,340 for the year (regular $1,490)" } });
  });

  // Membership checkout: plan = full | weekday | full_annual; optional partner. Subscription mode, coupon applied automatically.
  const startMemberCheckout = async (req: Request, res: Response) => {
    const site = process.env.SITE_URL ?? "https://otg.golf";
    try {
      const key = process.env.STRIPE_SECRET_KEY;
      if (!key) return res.status(500).send("stripe not configured");
      const src = (req.method === "POST" ? req.body : req.query) as Record<string, unknown>;
      const plan = (typeof src.plan === "string" && ["full", "weekday", "full_annual"].includes(src.plan) ? src.plan : "full") as Plan;
      const partner = await findPartner(pool, src.partner);
      const email = typeof src.email === "string" ? src.email.trim().slice(0, 200) : "";
      const stripe = new Stripe(key);
      const priceId = await priceForPlan(stripe, pool, plan);
      if (!priceId) return res.redirect(303, `${site}/memberships?checkout=error`);
      const coupon = couponForPlan(plan, partner);
      const meta = { product: plan, ...(partner ? { partner: partner.slug } : {}) };
      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        line_items: [{ price: priceId, quantity: 1 }],
        ...(coupon ? { discounts: [{ coupon }] } : { allow_promotion_codes: true }),
        ...(email ? { customer_email: email } : {}),
        metadata: meta,
        subscription_data: { metadata: meta },
        success_url: `${site}/member-confirmed?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${site}/memberships`,
      });
      await pool.query("insert into events (kind, payload) values ($1,$2)", ["member.checkout_started", { checkout: session.id, plan, partner: partner?.slug ?? null }]);
      return res.redirect(303, session.url as string);
    } catch (e) {
      console.error("member checkout failed:", (e as Error).message);
      await pool.query("insert into events (kind, payload) values ($1,$2)", ["member.checkout_failed", { error: (e as Error).message }]).catch(() => {});
      return res.redirect(303, `${site}/memberships?checkout=error`);
    }
  };
  app.get("/checkout/member", startMemberCheckout);
  app.post("/checkout/member", express.urlencoded({ extended: false }), startMemberCheckout);

  // Partner pro coaching hour: flat $30, requires a valid partner. Payment mode.
  app.get("/checkout/coaching", async (req, res) => {
    const site = process.env.SITE_URL ?? "https://otg.golf";
    try {
      const key = process.env.STRIPE_SECRET_KEY;
      if (!key) return res.status(500).send("stripe not configured");
      const partner = await findPartner(pool, req.query.partner);
      if (!partner) return res.redirect(303, `${site}/?coaching=invalid`);
      const stripe = new Stripe(key);
      const price = (await stripe.prices.list({ lookup_keys: [OFFERS.coachingHour.lookup_key], limit: 1 })).data[0];
      if (!price) return res.redirect(303, `${site}/?coaching=error`);
      const qtyRaw = Number(req.query.hours ?? 1);
      const quantity = Number.isInteger(qtyRaw) && qtyRaw >= 1 && qtyRaw <= 10 ? qtyRaw : 1;
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        line_items: [{ price: price.id, quantity }],
        metadata: { product: "coaching_bay_hour", partner: partner.slug, hours: String(quantity) },
        phone_number_collection: { enabled: true },
        success_url: `${site}/coaching-confirmed?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${site}/?partner=${encodeURIComponent(partner.slug)}`,
      });
      await pool.query("insert into events (kind, payload) values ($1,$2)", ["coaching.checkout_started", { checkout: session.id, partner: partner.slug, hours: quantity }]);
      return res.redirect(303, session.url as string);
    } catch (e) {
      console.error("coaching checkout failed:", (e as Error).message);
      return res.redirect(303, `${site}/?coaching=error`);
    }
  });

  // Keyed: full partner table with contacts and counts, for outreach follow-up.
  app.get("/partners", requireKey, async (_req, res) => {
    const rows = await pool.query("select * from partners order by course");
    const counts = await partnerCounts(pool);
    res.json({ partners: rows.rows.map((p) => ({ ...p, ...(counts.find((c) => c.slug === p.slug) ?? {}) })) });
  });

  // --- SMS primitive ---------------------------------------------------------------
  // Inbound messages from Twilio (set as the Messaging Service's inbound request URL).
  app.post("/webhooks/twilio", express.urlencoded({ extended: false }), async (req, res) => {
    const base = process.env.PUBLIC_BASE_URL ?? "https://otg-ops.onrender.com";
    const params = req.body as Record<string, string>;
    if (!verifyTwilioSignature(`${base}/webhooks/twilio`, params, req.header("X-Twilio-Signature"))) {
      return res.status(403).send("bad signature");
    }
    try {
      const reply = await onInboundSms({ From: params.From, Body: params.Body, MessageSid: params.MessageSid });
      res.type("text/xml");
      res.send(reply
        ? `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(reply)}</Message></Response>`
        : `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`);
    } catch (e) {
      console.error("twilio inbound failed:", (e as Error).message);
      res.status(500).send("error");
    }
  });

  // Manual/operator send. Body: { "phone": "...", "body": "..." }
  app.post("/sms/send", requireKey, express.json(), async (req, res) => {
    const { phone, body } = (req.body ?? {}) as { phone?: string; body?: string };
    if (!phone || !body) return res.status(400).json({ error: "phone and body are required" });
    if (body.length > 1000) return res.status(400).json({ error: "body too long" });
    const r = await sendSms(phone, body);
    res.status(r.ok ? 200 : 422).json({ ...r, configured: smsConfigured });
  });

  // Message log for one number (or the latest 100 overall).
  app.get("/sms/log", requireKey, async (req, res) => {
    const phone = typeof req.query.phone === "string" ? req.query.phone : null;
    const q = phone
      ? await pool.query("select * from sms_messages where phone = $1 order by at desc limit 200", [phone])
      : await pool.query("select * from sms_messages order by at desc limit 100");
    res.json({ configured: smsConfigured, messages: q.rows });
  });
}

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c] as string));
}
