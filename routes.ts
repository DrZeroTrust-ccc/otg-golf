import express from "express";
import type { Express, Request, Response, NextFunction } from "express";
import Stripe from "stripe";
import { pool } from "./db.js";
import { foundingSeatsTaken } from "./stripeHandlers.js";

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
                    const stripe = new Stripe(key);
                    const opening = new Date(process.env.OPENING_DAY ?? "2026-11-09T14:00:00Z");
                    const openingText = opening.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "America/New_York" });
                    const session = await stripe.checkout.sessions.create({
                                mode: "setup",
                        currency: "usd",
                                customer_creation: "always",
                                ...(email ? { customer_email: email } : {}),
                                metadata: { product: "founding", name, phone },
                                custom_text: { submit: { message: `Your card is saved today and nothing is charged now. $249/month is billed starting opening day, ${openingText}, and your founding rate is locked for life.` } },
                                success_url: `${site}/founding-confirmed?session_id={CHECKOUT_SESSION_ID}`,
                                cancel_url: `${site}/`,
                    });
                    await pool.query("insert into events (kind, payload) values ($1,$2)", ["founding.checkout_started", { checkout: session.id, taken, cap }]);
                    return res.redirect(303, session.url as string);
          } catch (e) {
                    console.error("founding checkout failed:", (e as Error).message);
                    await pool.query("insert into events (kind, payload) values ($1,$2)", ["founding.checkout_failed", { error: (e as Error).message }]).catch(() => {});
                    return res.redirect(303, `${site}/?founding=error`);
          }
  };
      app.get("/checkout/founding", startFoundingCheckout);
      app.post("/checkout/founding", express.urlencoded({ extended: false }), startFoundingCheckout);
}
