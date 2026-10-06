import type pg from "pg";
import { pool, logEvent } from "./db.js";
import { sendEmail, emailConfigured } from "./email.js";
import { sendSms } from "./sms.js";
import type { Msg } from "./templates.js";

// The outbox: handlers queue messages inside their own transaction (so a rolled-back webhook
// queues nothing), and the dispatcher sends them after commit. dedupe_key means a replayed
// Stripe event can never send the same message twice.

type Db = pg.Pool | pg.PoolClient;
const MAX_ATTEMPTS = 5;

// Customer-facing messages stay held until CUSTOMER_MESSAGES=on. Owner alerts always send.
export const customerMessagesLive = () => (process.env.CUSTOMER_MESSAGES ?? "").trim().toLowerCase() === "on";

const list = (v: string | undefined, fallback: string) =>
  (v ?? fallback).split(",").map((s) => s.trim()).filter(Boolean);
export const ownerEmails = () => list(process.env.OWNER_ALERT_EMAILS, "chase@otg.golf");
export const eventsEmails = () => list(process.env.EVENTS_ALERT_EMAILS, "events@otg.golf");
export const ownerPhone = () => process.env.OWNER_ALERT_PHONE?.trim() || null;

async function queue(db: Db, r: {
  key: string; audience: "customer" | "owner"; channel: "email" | "sms"; playerId?: string | null;
  to?: string | null; subject?: string | null; body: string; replyTo?: string | null; delaySeconds?: number;
}) {
  await db.query(
    `insert into outbox (dedupe_key, audience, channel, player_id, to_addr, subject, body, reply_to, next_attempt_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8, now() + ($9 || ' seconds')::interval) on conflict (dedupe_key) do nothing`,
    [r.key, r.audience, r.channel, r.playerId ?? null, r.to ?? null, r.subject ?? null, r.body, r.replyTo ?? null, String(r.delaySeconds ?? 0)]
  );
}

// Queue a message to a player. The address is looked up at send time, because Stripe's
// customer event (which carries the email) can arrive after the event that triggers the message.
export async function notifyCustomer(db: Db, key: string, playerId: string, m: Msg, opts: { replyTo?: string; to?: string | null; delaySeconds?: number } = {}) {
  await queue(db, { key: `${key}:email`, audience: "customer", channel: "email", playerId, to: opts.to ?? null, subject: m.subject, body: m.text, replyTo: opts.replyTo ?? ownerEmails()[0], delaySeconds: opts.delaySeconds });
  if (m.sms) await queue(db, { key: `${key}:sms`, audience: "customer", channel: "sms", playerId, body: m.sms, delaySeconds: opts.delaySeconds });
}

export async function notifyOwner(db: Db, key: string, m: Msg, opts: { extraEmails?: string[]; replyTo?: string | null; playerId?: string | null; delaySeconds?: number } = {}) {
  const emails = [...new Set([...ownerEmails(), ...(opts.extraEmails ?? [])])];
  for (const to of emails) await queue(db, { key: `${key}:email:${to}`, audience: "owner", channel: "email", to, playerId: opts.playerId, subject: m.subject, body: m.text, replyTo: opts.replyTo ?? null, delaySeconds: opts.delaySeconds });
  const phone = ownerPhone();
  if (phone && m.sms) await queue(db, { key: `${key}:sms:owner`, audience: "owner", channel: "sms", to: phone, playerId: opts.playerId, body: m.sms, delaySeconds: opts.delaySeconds });
}

type Row = {
  id: number; dedupe_key: string; audience: "customer" | "owner"; channel: "email" | "sms"; player_id: string | null;
  to_addr: string | null; subject: string | null; body: string; reply_to: string | null; attempts: number;
};

async function finish(id: number, status: string, error: string | null) {
  await pool.query(
    `update outbox set status = $2, last_error = $3, sent_at = case when $2 = 'sent' then now() else sent_at end where id = $1`,
    [id, status, error]
  );
}
async function retryLater(r: Row, error: string, delayMinutes: number) {
  const attempts = r.attempts + 1;
  if (attempts >= MAX_ATTEMPTS) {
    await finish(r.id, "failed", error);
    await pool.query("update outbox set attempts = $2 where id = $1", [r.id, attempts]);
    console.error(`outbox ${r.id} ${r.dedupe_key} failed permanently: ${error}`);
    return;
  }
  await pool.query(
    `update outbox set status = 'pending', attempts = $2, last_error = $3, next_attempt_at = now() + ($4 || ' minutes')::interval where id = $1`,
    [r.id, attempts, error, String(delayMinutes)]
  );
}

async function sendOne(r: Row) {
  if (r.audience === "customer" && !customerMessagesLive()) return finish(r.id, "held", "CUSTOMER_MESSAGES is not on");

  let to = r.to_addr;
  let firstName = "there";
  let displayName = "new customer";
  let contact = "(no contact details on file yet)";
  if (r.player_id) {
    const p = (await pool.query("select name, email, phone, sms_consent_at, sms_opt_out from players where id = $1", [r.player_id])).rows[0];
    if (p?.name) firstName = String(p.name).trim().split(/\s+/)[0] || "there";
    displayName = p?.name || p?.email || displayName;
    const parts = [p?.name, p?.email, p?.phone].filter(Boolean);
    if (parts.length) contact = parts.join(" | ");
    if (!to && r.channel === "email") to = p?.email ?? null;
    if (!to && r.channel === "sms") {
      // Only text customers who ticked the SMS consent box on our own form.
      if (p?.phone && !p.sms_consent_at) return finish(r.id, "skipped", "no sms consent on file");
      to = p?.phone ?? null;
    }
  }
  if (!to) {
    // The address may still be on its way from Stripe; give it a few minutes before giving up.
    if (r.attempts + 1 >= 3) return finish(r.id, "skipped", `no ${r.channel === "email" ? "email address" : "phone number"} on file`);
    return retryLater(r, "no address yet", 2);
  }
  const fill = (s: string) => s.replaceAll("{{first_name}}", firstName).replaceAll("{{name}}", displayName).replaceAll("{{contact}}", contact);
  const body = fill(r.body);

  if (r.channel === "email") {
    if (!emailConfigured) return finish(r.id, "skipped", "email not configured");
    const res = await sendEmail({ to, subject: fill(r.subject ?? "On The Green Indoor Golf"), text: body, replyTo: r.reply_to, idempotencyKey: `otg-outbox-${r.id}`, outboxId: r.id });
    if (res.ok) { await finish(r.id, "sent", null); await logEvent(pool, "outbox.sent", { outbox_id: r.id, channel: "email", audience: r.audience, key: r.dedupe_key }); return; }
    return retryLater(r, res.error ?? "send failed", 5 * (r.attempts + 1));
  }
  const res = await sendSms(to, body);
  if (res.ok) { await finish(r.id, "sent", null); await logEvent(pool, "outbox.sent", { outbox_id: r.id, channel: "sms", audience: r.audience, key: r.dedupe_key }); return; }
  if (res.status === "skipped") return finish(r.id, "skipped", res.error ?? "skipped");
  return retryLater(r, res.error ?? "send failed", 5 * (r.attempts + 1));
}

let running = false;
// Send everything that is due. Safe to call often; each row is claimed before it is sent.
export async function dispatchOutbox(limit = 25): Promise<number> {
  if (running) return 0;
  running = true;
  let n = 0;
  try {
    // A row left in 'sending' means the process died mid-send; put it back after 15 minutes.
    await pool.query(`update outbox set status = 'pending' where status = 'sending' and next_attempt_at < now() - interval '15 minutes'`);
    const due = await pool.query(
      `update outbox set status = 'sending', next_attempt_at = now()
        where id in (select id from outbox where status = 'pending' and next_attempt_at <= now() order by id limit $1 for update skip locked)
        returning *`,
      [limit]
    );
    for (const r of (due.rows as Row[]).sort((a, b) => a.id - b.id)) {
      try { await sendOne(r); n++; }
      catch (e) { await retryLater(r, e instanceof Error ? e.message : String(e), 5).catch(() => {}); }
    }
  } catch (e) {
    console.error("dispatchOutbox failed:", e instanceof Error ? e.message : e);
  } finally {
    running = false;
  }
  return n;
}

// Fire-and-forget version for request handlers: never throws, never delays the response.
export function kickOutbox() { void dispatchOutbox().catch(() => {}); }
