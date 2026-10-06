import crypto from "node:crypto";
import express from "express";
import type { Express, Request, Response, NextFunction } from "express";
import { pool, logEvent } from "./db.js";
import { upsertPlayer, normalizeEmail, normalizePhone } from "./stripeHandlers.js";
import { notifyCustomer, notifyOwner, eventsEmails, kickOutbox, customerMessagesLive } from "./notify.js";
import { inquiryReply, ownerInquiry, ownerInquiryNudge } from "./templates.js";

// Event inquiries: the site's Events form posts here (replacing Formspree). Each one is stored,
// answered automatically, and alerted to the owner. Unhandled ones are re-alerted after 24 hours.

const SITE = () => process.env.SITE_URL ?? "https://otg.golf";
const BASE = () => process.env.PUBLIC_BASE_URL ?? "https://otg-ops.onrender.com";
// The site's own origins are always allowed; SITE_ORIGIN adds to them rather than replacing them.
// Trimmed and without a trailing slash, since a browser's Origin header never has either.
const ALLOWED_ORIGINS = () => {
  const extra = process.env.SITE_ORIGIN?.trim().replace(/\/+$/, "");
  return new Set(["https://otg.golf", "https://www.otg.golf", ...(extra ? [extra] : [])]);
};

function cors(req: Request, res: Response) {
  const origin = req.header("Origin");
  if (origin && ALLOWED_ORIGINS().has(origin)) {
    res.set("Access-Control-Allow-Origin", origin);
    res.set("Vary", "Origin");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type, Accept");
  }
}

// Small in-memory limiter: 5 inquiries per 10 minutes per address.
const hits = new Map<string, number[]>();
function limited(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < 10 * 60_000);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.clear();
  return recent.length > 5;
}

// The handled-link token: an HMAC of the inquiry id, so the link in the alert email can't be guessed.
function token(id: string): string {
  const secret = process.env.OTG_READ_KEY ?? "";
  return crypto.createHmac("sha256", secret).update(`inquiry:${id}`).digest("hex").slice(0, 32);
}
const doneUrl = (id: string) => `${BASE()}/inquiries/${id}/done?t=${token(id)}`;

// Accept the field names a form builder is likely to use.
function pick(src: Record<string, unknown>, names: string[], max: number): string | null {
  for (const n of names) {
    const v = src[n];
    if (typeof v === "string" && v.trim()) return v.trim().slice(0, max);
    if (typeof v === "number") return String(v);
  }
  return null;
}

function requireKey(req: Request, res: Response, next: NextFunction) {
  const key = process.env.OTG_READ_KEY;
  if (!key) return res.status(500).json({ error: "OTG_READ_KEY not configured" });
  if (req.header("X-OTG-Key") !== key) return res.status(401).json({ error: "unauthorized" });
  next();
}

export function mountInquiries(app: Express) {
  app.options("/inquiries", (req, res) => { cors(req, res); res.status(204).end(); });

  app.post("/inquiries", express.json({ limit: "20kb" }), express.urlencoded({ extended: false, limit: "20kb" }), async (req, res) => {
    cors(req, res);
    const wantsJson = (req.header("Accept") ?? "").includes("json") || req.is("application/json");
    const ok = () => wantsJson ? res.json({ ok: true }) : res.redirect(303, `${SITE()}/events?sent=1`);
    const fail = (code: number, error: string) => wantsJson ? res.status(code).json({ ok: false, error }) : res.redirect(303, `${SITE()}/events?sent=error`);
    try {
      const src = (req.body ?? {}) as Record<string, unknown>;
      // Honeypot: a hidden field real people leave empty. Pretend success so bots learn nothing.
      if (typeof src.company_website === "string" && src.company_website.trim()) return ok();
      const ip = (req.header("x-forwarded-for") ?? req.ip ?? "unknown").split(",")[0].trim();
      if (limited(ip)) return fail(429, "Too many requests. Please try again in a few minutes.");

      const name = pick(src, ["name", "full_name", "fullName"], 120);
      const email = normalizeEmail(pick(src, ["email", "_replyto", "email_address"], 200));
      const phoneRaw = pick(src, ["phone", "phone_number", "tel"], 40);
      const pkg = pick(src, ["package", "event_type", "eventType", "type"], 120);
      const eventDate = pick(src, ["date", "event_date", "eventDate", "preferred_date", "preferredDate"], 80);
      const guests = pick(src, ["guests", "guest_count", "guestCount", "group_size", "groupSize", "headcount", "party_size"], 40);
      const message = pick(src, ["message", "details", "notes", "comments"], 4000);
      if (!email && !normalizePhone(phoneRaw)) return fail(400, "Please include an email address or phone number.");

      const client = await pool.connect();
      let id: string;
      try {
        await client.query("begin");
        const playerId = await upsertPlayer(client, { name, phone: phoneRaw, email });
        await client.query("insert into tags (player_id, tag, source) values ($1,'event_lead','site') on conflict do nothing", [playerId]);
        const raw = Object.fromEntries(Object.entries(src).filter(([, v]) => typeof v === "string" || typeof v === "number").map(([k, v]) => [k.slice(0, 60), String(v).slice(0, 4000)]));
        const ins = await client.query(
          `insert into inquiries (player_id, name, email, phone, package, event_date, guests, message, raw)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
          [playerId, name, email, phoneRaw, pkg, eventDate, guests, message, raw]
        );
        id = ins.rows[0].id;
        const i = { name, email, phone: phoneRaw, package: pkg, event_date: eventDate, guests, message };
        await logEvent(client, "inquiry.created", { inquiry_id: id, player_id: playerId, package: pkg, event_date: eventDate, guests });
        await notifyOwner(client, `inquiry:${id}`, ownerInquiry(i, doneUrl(id)), { extraEmails: eventsEmails(), replyTo: email });
        if (email) await notifyCustomer(client, `inquiry-reply:${id}`, playerId, { ...inquiryReply(), sms: undefined }, { to: email, replyTo: eventsEmails()[0] });
        await client.query("commit");
      } catch (e) {
        await client.query("rollback").catch(() => {});
        throw e;
      } finally {
        client.release();
      }
      kickOutbox();
      return ok();
    } catch (e) {
      console.error("inquiry failed:", (e as Error).message);
      return fail(500, "Something went wrong. Please email events@otg.golf.");
    }
  });

  // The link in the alert email. GET only shows a button, so mail scanners that open links
  // can't mark an inquiry handled by accident; the button POSTs.
  app.get("/inquiries/:id/done", async (req, res) => {
    const id = req.params.id;
    if (req.query.t !== token(id)) return res.status(403).send("This link is not valid.");
    const q = await pool.query("select name, email, status from inquiries where id = $1", [id]).catch(() => ({ rows: [] as any[] }));
    const i = q.rows[0];
    if (!i) return res.status(404).send("Inquiry not found.");
    const label = escapeHtml(i.name || i.email || "this inquiry");
    res.type("html").send(page(i.status === "handled"
      ? `<p>The inquiry from <b>${label}</b> is already marked handled.</p>`
      : `<p>Mark the inquiry from <b>${label}</b> as handled?</p><form method="post" action="/inquiries/${encodeURIComponent(id)}/done?t=${token(id)}"><button>Mark handled</button></form>`));
  });

  app.post("/inquiries/:id/done", async (req, res) => {
    const id = req.params.id;
    if (req.query.t !== token(id)) return res.status(403).send("This link is not valid.");
    const r = await pool.query("update inquiries set status = 'handled', handled_at = now() where id = $1 and status <> 'handled' returning id", [id]).catch(() => ({ rowCount: 0 }));
    if (r.rowCount) await logEvent(pool, "inquiry.handled", { inquiry_id: id });
    res.type("html").send(page("<p>Marked handled. You won't be reminded about this one.</p>"));
  });

  // Keyed reads: the inquiry list, and the log of every automatic message (including held ones).
  app.get("/inquiries", requireKey, async (_req, res) => {
    const q = await pool.query("select id, created_at, name, email, phone, package, event_date, guests, message, status, handled_at from inquiries order by created_at desc limit 200");
    res.json({ count: q.rowCount, inquiries: q.rows });
  });
  app.get("/outbox", requireKey, async (req, res) => {
    const status = typeof req.query.status === "string" ? req.query.status : null;
    const q = await pool.query(
      `select id, created_at, audience, channel, to_addr, player_id, subject, body, status, attempts, last_error, sent_at
         from outbox where $1::text is null or status = $1 order by id desc limit 200`, [status]);
    res.json({ customer_messages_live: customerMessagesLive(), count: q.rowCount, messages: q.rows });
  });
}

// Re-alert the owner about inquiries still marked new after 24 hours. Called by the ticker.
export async function nudgeStaleInquiries(): Promise<number> {
  const q = await pool.query(
    `update inquiries set nudged_at = now()
      where status = 'new' and nudged_at is null and created_at < now() - interval '24 hours'
      returning id, name, email, phone`
  );
  for (const i of q.rows) {
    await notifyOwner(pool, `inquiry-nudge:${i.id}`, ownerInquiryNudge(i, doneUrl(i.id)), { extraEmails: eventsEmails() });
    await logEvent(pool, "inquiry.nudged", { inquiry_id: i.id });
  }
  return q.rowCount ?? 0;
}

function escapeHtml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&#39;", '"': "&quot;" }[c] as string));
}
function page(inner: string): string {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>On The Green</title>
<body style="font-family:system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem;line-height:1.5">
<h3>On The Green Indoor Golf</h3>${inner}
<style>button{font:inherit;padding:.6rem 1.2rem;border-radius:.4rem;border:0;background:#14532d;color:#fff;cursor:pointer}</style></body>`;
}
