import crypto from "node:crypto";
import type { Request, Response } from "express";
import { pool, logEvent } from "./db.js";
import { sendSms } from "./sms.js";
import { sendEmail } from "./email.js";
import { normalizePhone, normalizeEmail } from "./stripeHandlers.js";

// Sign-in for the booking app: no passwords. The person types their mobile number (or email),
// gets a 6-digit code, and types it back. Matching is on the verified address only, so nobody can
// sign in to someone else's account by typing their email.

const CODE_MINUTES = 10;
const MAX_SENDS_PER_HOUR = 5;
const MAX_ATTEMPTS = 5;
const SESSION_DAYS = 90;
export const COOKIE = "otg_session";

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
// For automated tests only: returns the code in the response. Never set this on Render.
const testCodes = () => (process.env.BOOKING_TEST_CODES ?? "").trim().toLowerCase() === "on";

type Address = { channel: "sms" | "email"; address: string };
function parseAddress(src: Record<string, unknown>): Address | null {
  const phone = typeof src.phone === "string" ? normalizePhone(src.phone) : null;
  if (phone) return { channel: "sms", address: phone };
  const email = typeof src.email === "string" ? normalizeEmail(src.email) : null;
  if (email) return { channel: "email", address: email };
  return null;
}

export async function startSignIn(req: Request, res: Response) {
  const a = parseAddress(req.body ?? {});
  if (!a) return res.status(400).json({ error: "Enter a mobile number or email address." });
  const recent = await pool.query("select count(*)::int n from login_codes where address = $1 and created_at > now() - interval '1 hour'", [a.address]);
  if (recent.rows[0].n >= MAX_SENDS_PER_HOUR) return res.status(429).json({ error: "Too many codes requested. Try again in an hour." });

  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  await pool.query(
    "insert into login_codes (channel, address, code_hash, expires_at) values ($1,$2,$3, now() + ($4 || ' minutes')::interval)",
    [a.channel, a.address, sha(`${a.address}:${code}`), String(CODE_MINUTES)]
  );
  const text = `Your On The Green sign-in code is ${code}. It expires in ${CODE_MINUTES} minutes.`;
  const sent = a.channel === "sms"
    ? await sendSms(a.address, text)
    : await sendEmail({ to: a.address, subject: `Your On The Green sign-in code: ${code}`, text: `${text}\n\nIf you didn't ask for this, you can ignore this email.` });
  await logEvent(pool, "auth.code_sent", { channel: a.channel, ok: sent.ok, error: sent.ok ? null : sent.error ?? null });
  if (!sent.ok && !testCodes()) {
    const why = sent.error === "opted out"
      ? "This number has opted out of our texts. Text START to (540) 340-9067, or sign in with your email instead."
      : "We couldn't send the code just now. Try again, or sign in with your email.";
    return res.status(502).json({ error: why });
  }
  res.json({ ok: true, channel: a.channel, ...(testCodes() ? { test_code: code } : {}) });
}

export async function verifySignIn(req: Request, res: Response) {
  const src = (req.body ?? {}) as Record<string, unknown>;
  const a = parseAddress(src);
  const code = typeof src.code === "string" ? src.code.replace(/\D/g, "") : "";
  if (!a || code.length !== 6) return res.status(400).json({ error: "Enter the 6-digit code." });

  const row = (await pool.query(
    `select id, code_hash, attempts from login_codes
      where address = $1 and used_at is null and expires_at > now() order by created_at desc limit 1`, [a.address])).rows[0];
  if (!row || row.attempts >= MAX_ATTEMPTS) return res.status(400).json({ error: "That code has expired. Ask for a new one." });
  const ok = crypto.timingSafeEqual(Buffer.from(row.code_hash), Buffer.from(sha(`${a.address}:${code}`)));
  if (!ok) {
    await pool.query("update login_codes set attempts = attempts + 1 where id = $1", [row.id]);
    return res.status(400).json({ error: "That code isn't right. Check it and try again." });
  }
  await pool.query("update login_codes set used_at = now() where id = $1", [row.id]);

  const name = typeof src.name === "string" ? src.name.trim().slice(0, 120) || null : null;
  const col = a.channel === "sms" ? "phone" : "email";
  let player = (await pool.query(`select id from players where ${col} = $1 order by created_at limit 1`, [a.address])).rows[0];
  if (!player) {
    player = (await pool.query(
      `insert into players (${col}, name) values ($1, $2) on conflict do nothing returning id`, [a.address, name])).rows[0]
      ?? (await pool.query(`select id from players where ${col} = $1 order by created_at limit 1`, [a.address])).rows[0];
    await logEvent(pool, "player.created", { player_id: player.id, via: "booking_sign_in", channel: a.channel });
  } else if (name) {
    await pool.query("update players set name = coalesce(name, $2) where id = $1", [player.id, name]);
  }
  // Signing in by text with the consent box ticked counts as consent for booking texts.
  if (a.channel === "sms" && src.sms_ok === true) {
    await pool.query("update players set sms_consent_at = coalesce(sms_consent_at, now()) where id = $1", [player.id]);
  }
  const token = crypto.randomBytes(32).toString("base64url");
  await pool.query("insert into sessions (token_hash, player_id, expires_at) values ($1,$2, now() + ($3 || ' days')::interval)",
    [sha(token), player.id, String(SESSION_DAYS)]);
  await logEvent(pool, "auth.signed_in", { player_id: player.id, channel: a.channel });
  res.setHeader("Set-Cookie", `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`);
  res.json({ ok: true });
}

function readCookie(req: Request, name: string): string | null {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

export async function currentPlayerId(req: Request): Promise<string | null> {
  const token = readCookie(req, COOKIE);
  if (!token) return null;
  const r = await pool.query("select player_id from sessions where token_hash = $1 and expires_at > now()", [sha(token)]);
  return r.rows[0]?.player_id ?? null;
}

export async function signOut(req: Request, res: Response) {
  const token = readCookie(req, COOKIE);
  if (token) await pool.query("delete from sessions where token_hash = $1", [sha(token)]);
  res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
  res.json({ ok: true });
}
