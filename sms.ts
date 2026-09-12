import crypto from "node:crypto";
import { pool, logEvent } from "./db.js";
import { normalizePhone } from "./stripeHandlers.js";

// Twilio is used as a primitive: one send function, one inbound handler. No SDK; plain REST.
// Dormant until TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_MESSAGING_SERVICE_SID are set.
const SID = process.env.TWILIO_ACCOUNT_SID;
const TOKEN = process.env.TWILIO_AUTH_TOKEN;
const MSG_SERVICE = process.env.TWILIO_MESSAGING_SERVICE_SID;

export const smsConfigured = Boolean(SID && TOKEN && MSG_SERVICE);

const STOP_WORDS = new Set(["stop", "stopall", "unsubscribe", "cancel", "end", "quit"]);
const START_WORDS = new Set(["start", "yes", "unstop"]);
const HELP_WORDS = new Set(["help", "info"]);

export const HELP_REPLY =
  "On The Green Indoor Golf: For help, email chase@otg.golf or call (540) 340-9067. Reply STOP to opt out.";
export const START_REPLY =
  "On The Green Indoor Golf: You're in! You'll get booking confirmations, member updates, and club news. Msg & data rates may apply. Msg frequency varies. Reply STOP to opt out, HELP for help.";

async function playerIdByPhone(phone: string): Promise<{ id: string; optOut: boolean } | null> {
  const q = await pool.query("select id, sms_opt_out from players where phone = $1", [phone]);
  return q.rowCount ? { id: q.rows[0].id, optOut: q.rows[0].sms_opt_out } : null;
}

export type SendResult = { ok: boolean; status: string; sid?: string; error?: string };

// Send one message. Refuses (and records why) if the player has opted out or Twilio isn't configured.
export async function sendSms(toRaw: string, body: string): Promise<SendResult> {
  const to = normalizePhone(toRaw);
  if (!to) return { ok: false, status: "failed", error: "invalid phone" };
  const player = await playerIdByPhone(to);

const record = async (status: string, sid: string | null, error: string | null) => {
  await pool.query(
    `insert into sms_messages (direction, phone, player_id, body, twilio_sid, status, error)
    values ('out', $1, $2, $3, $4, $5, $6)`,
    [to, player?.id ?? null, body, sid, status, error]
    );
  await logEvent(pool, `sms.${status}`, { to, player_id: player?.id ?? null, sid, error, chars: body.length });
};

if (player?.optOut) {
  await record("skipped", null, "opted out");
  return { ok: false, status: "skipped", error: "opted out" };
}
  if (!smsConfigured) {
    await record("skipped", null, "twilio not configured");
    return { ok: false, status: "skipped", error: "twilio not configured" };
  }

const params = new URLSearchParams({ To: to, MessagingServiceSid: MSG_SERVICE!, Body: body });
  try {
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(`${SID}:${TOKEN}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params,
    });
    const j = (await r.json()) as { sid?: string; status?: string; message?: string };
    if (!r.ok || !j.sid) {
      await record("failed", null, j.message ?? `http ${r.status}`);
      return { ok: false, status: "failed", error: j.message ?? `http ${r.status}` };
    }
    await record("sent", j.sid, null);
    return { ok: true, status: "sent", sid: j.sid };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await record("failed", null, msg);
    return { ok: false, status: "failed", error: msg };
  }
}

// Twilio signs webhooks with HMAC-SHA1 over the full URL plus the sorted POST params.
export function verifyTwilioSignature(url: string, params: Record<string, string>, signature: string | undefined): boolean {
  if (!TOKEN || !signature) return false;
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  const expected = crypto.createHmac("sha1", TOKEN).update(data).digest("base64");
  const a = Buffer.from(expected), b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Handle one inbound message. Returns the reply body to send back (or null for silence).
// Twilio's Messaging Service already enforces STOP/HELP at the carrier level; this keeps our own
// consent state in sync so sendSms() never messages someone who opted out.
export async function onInboundSms(p: { From: string; Body: string; MessageSid: string }): Promise<string | null> {
  const phone = normalizePhone(p.From);
  if (!phone) return null;
  const body = (p.Body ?? "").trim();
  const word = body.toLowerCase().replace(/[^a-z]/g, "");
  const player = await playerIdByPhone(phone);

await pool.query(
  `insert into sms_messages (direction, phone, player_id, body, twilio_sid, status)
  values ('in', $1, $2, $3, $4, 'received') on conflict (twilio_sid) do nothing`,
  [phone, player?.id ?? null, body, p.MessageSid]
  );

if (STOP_WORDS.has(word)) {
  if (player) await pool.query("update players set sms_opt_out = true, sms_opt_out_at = now() where id = $1", [player.id]);
  await logEvent(pool, "sms.opt_out", { phone, player_id: player?.id ?? null, word });
  return null; // Twilio sends the carrier-required opt-out confirmation itself.
}
  if (START_WORDS.has(word)) {
    if (player) await pool.query("update players set sms_opt_out = false, sms_opt_out_at = null where id = $1", [player.id]);
    await logEvent(pool, "sms.opt_in", { phone, player_id: player?.id ?? null, word });
    return START_REPLY;
  }
  if (HELP_WORDS.has(word)) {
    await logEvent(pool, "sms.help", { phone, player_id: player?.id ?? null });
    return HELP_REPLY;
  }
  await logEvent(pool, "sms.received", { phone, player_id: player?.id ?? null, chars: body.length });
  return null; // Free-text replies land in sms_messages for a human to read; no auto-reply.
}
